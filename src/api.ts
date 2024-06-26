import { WebSocket, WebSocketServer } from "ws";
import { IncomingMessage, createServer } from "http";
import {
  getUser,
  createUser,
  createCar,
  removeUserCar,
  updateUserCar,
  updateUserPicture,
  updateUserRating,
} from "./database.js";
import sampleSize from "lodash.samplesize";
import removeWhere from "lodash.remove";
import findWhere from "lodash.find";
import { loggerMain, loggerTraffic } from "./logger.js";
import { isNSFW } from "./ml.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { cleanEnv, str, num } from "envalid";
import type { Car, Credentials, Driver, Passenger } from "./types/types.js";

const env = cleanEnv(process.env, {
  API_PORT: str(),
  MEDIA_HOST: str(),
  MEDIA_PORT: str(),
  JWKS: str(),
  CRON_PING_URL: str(),
  CRON_INTERVAL_MS: num(),
  NODE_ENV: str({ choices: ["production", "development"] }),
});

const JWKS = createRemoteJWKSet(new URL(env.JWKS));

const typeOfMessage = {
  login: "!LOGIN",
  updateDriver: "!UPDATEDRIVER",
  updatePassenger: "!UPDATEPASSENGER",
  newDriver: "!NEWDRIVER",
  newPassenger: "!NEWPASSENGER",
  stopDriver: "!STOPDRIVER",
  stopPassenger: "!STOPPASSENGER",
  outOfRange: "!OUTOFRANGE",
  arrivedDestination: "!ARRIVEDDESTINATION",
  sendRatings: "!SENDRATINGS",
  addCar: "!ADDCAR",
  updateCar: "!UPDATECAR",
  updateUserPicture: "!UPDATEUSERPICTURE",
  deletePicture: "!DELETEPICTURE",
  deleteUserPicture: "!DELETEUSERPICTURE",
  deleteCarPicture: "!DELETECARPICTURE",
  removeCar: "!REMOVECAR",
  getDriver: "!GETDRIVER",
  getPassengers: "!GETPASSENGERS",
  pingPassengers: "!PINGPASSENGERS",
  pingDriver: "!PINGDRIVER",
  badRequest: "!BADREQUEST",
  message: "!MESSAGE",
  signout: "!SIGNOUT",
} as const;

var driverMap: { [id: string]: Driver } = {};
var passengerMap: { [id: string]: Passenger } = {};
var sockets: { [id: string]: WebSocket } = {};
var pendingRatings: { [id: string]: string[] } = {};

function msgToJSON(type: string, data: any) {
  return JSON.stringify({ type: type, data: data });
}

function notifyBadRequest(
  ws: WebSocket,
  id: string,
  decoded: any,
  type: string
) {
  loggerMain.warn(
    `Bad request from ${id}: ${JSON.stringify(decoded, null, 2)}`
  );
  ws.send(msgToJSON(typeOfMessage.badRequest, type));
}

function stopDriver(id: string) {
  if (!driverMap[id]) return;
  driverMap[id].passengers.forEach((passenger) => {
    if (passengerMap[passenger]) {
      delete passengerMap[passenger].driver_id;
    }
    if (sockets[passenger]) {
      sockets[passenger].send(msgToJSON(typeOfMessage.getDriver, null));
    }
  });
  delete driverMap[id];
}

function stopPassenger(id: string, deletePassenger?: boolean) {
  if (
    !passengerMap[id] ||
    !passengerMap[id].driver_id ||
    !driverMap[passengerMap[id].driver_id!]
  )
    return;
  if (sockets[passengerMap[id].driver_id!]) {
    sockets[passengerMap[id].driver_id!].send(
      msgToJSON(typeOfMessage.updatePassenger, {
        cancelled: id,
      })
    );
  }
  removeWhere(
    driverMap[passengerMap[id].driver_id!].passengers,
    (passenger) => passenger == id
  );
  if (deletePassenger == undefined || deletePassenger) delete passengerMap[id];
}

function deletePicture(pictureURL: string) {
  fetch(`http://${env.MEDIA_HOST}:${env.MEDIA_PORT}/images/${pictureURL}`, {
    method: "DELETE",
  })
    .then((response) => {
      if (!response.ok) {
        loggerMain.warn(`FAILED to delete image at /images/${pictureURL}`);
      } else {
        loggerMain.info(`Deleted image at /images/${pictureURL}`);
      }
    })
    .catch((error) => {
      loggerMain.error(`Failed to connect to media server: ${error}`);
    });
}

async function authenticate(req: IncomingMessage) {
  let idToken = req.headers["sec-websocket-protocol"];
  loggerTraffic.info(
    `Connection attempted` // + `with token: ${JSON.stringify(idToken, null, 2)}`
  );
  if (!idToken) return;
  let decodedToken;
  try {
    decodedToken = (await jwtVerify(idToken, JWKS)).payload;
  } catch (error) {
    loggerMain.warn(error);
    return;
  }
  if (!decodedToken || !decodedToken.name || !decodedToken.email) {
    loggerMain.warn(
      `Client tried to connect with invalid info: ` +
        JSON.stringify(decodedToken, null, 2)
    );
    return;
  }
  return {
    id: (decodedToken.email as string).split("@")[0],
    full_name: decodedToken.name as string,
    given_name: decodedToken.given_name as string,
  };
}

const server = createServer();
const wss = new WebSocketServer({
  maxPayload: 2e3,
  noServer: true,
});

server.on("upgrade", async (req, socket, head) => {
  socket.on("error", (err) => {
    loggerMain.error(err);
  });

  let credentials = await authenticate(req);
  if (!credentials) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    loggerMain.warn(
      `Error authenticating: ${req.headers["sec-websocket-protocol"]}`
    );
    socket.destroy();
    return;
  }

  socket.removeAllListeners("error");
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, credentials);
  });
});

wss.on(
  "connection",
  async (ws: WebSocket, req: IncomingMessage, credentials: Credentials) => {
    if (!credentials || !credentials.id || !credentials.full_name) {
      ws.close(4002, "faulty credentials");
      return;
    }
    if (sockets[credentials.id]) {
      loggerMain.warn(
        `Client ${credentials.id} tried to connect while already connected`
      );
      ws.close(4001, "user already connected");
      return;
    }
    let user = await getUser(credentials.id);
    if (!user) {
      loggerMain.info(`ID ${credentials.id} not found. Creating new user...`);
      user = await createUser(credentials.id);
      if (!user) {
        loggerMain.warn(
          `Cannot create new user ${credentials.id}. Disconnecting...`
        );
        ws.close(4002, "cannot create user");
        return;
      }
    }
    user.full_name = credentials.full_name;
    user.given_name = credentials.given_name;
    ws.send(msgToJSON(typeOfMessage.login, user));
    sockets[user.id] = ws;
    loggerMain.info(`Client logged in: ${JSON.stringify(user, null, 2)}`);

    ws.on("error", (error) => {
      loggerMain.error(error);
    });

    ws.on("close", () => {
      stopDriver(user.id);
      stopPassenger(user.id);
      delete sockets[user.id];
      loggerMain.info(`Disconnected client ${user.id}`);
    });

    ws.on("message", async (msg: string) => {
      let decoded;
      try {
        decoded = JSON.parse(msg);
      } catch (error) {
        loggerMain.warn(`Error parsing request from ${user.id}: ${error}`);
        return;
      }
      const type = decoded.type;
      const data = decoded.data;
      loggerTraffic.info(
        `Received from ${user.id}: ${type} data: ${JSON.stringify(
          data,
          null,
          2
        )}`
      );
      switch (type) {
        case typeOfMessage.newDriver: {
          if (!data.coords || !data.car) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.newDriver
            );
            break;
          }
          driverMap[user.id] = {
            ...user,
            coords: data.coords,
            car: data.car,
            passengers: [],
          };
          stopPassenger(user.id);
          ws.send(msgToJSON(typeOfMessage.newDriver, null));
          loggerMain.info(
            `New driver: ${JSON.stringify(
              {
                id: driverMap[user.id].id,
                full_name: driverMap[user.id].full_name,
                car: driverMap[user.id].car,
                coords: driverMap[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.newPassenger: {
          if (!data.coords) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.newPassenger
            );
            break;
          }
          stopDriver(user.id);
          passengerMap[user.id] = {
            ...user,
            coords: data.coords,
            cars: {},
          };
          delete driverMap[user.id];
          loggerMain.info(
            `New passenger: ${JSON.stringify(
              {
                id: user.id,
                full_name: user.full_name,
                coords: passengerMap[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.updateDriver: {
          if (!driverMap[user.id]) break;
          if (!data.coords) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.updateDriver
            );
            break;
          }
          driverMap[user.id].picture = user.picture;
          driverMap[user.id].coords = data.coords;
          driverMap[user.id].passengers.forEach((passenger) => {
            if (sockets[passenger]) {
              sockets[passenger].send(
                msgToJSON(typeOfMessage.getDriver, driverMap[user.id])
              );
            }
          });
          loggerMain.info(
            `Driver update: ${JSON.stringify(
              {
                id: user.id,
                full_name: user.full_name,
                coords: driverMap[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.updatePassenger: {
          if (!passengerMap[user.id]) break;
          if (!data.coords) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.updatePassenger
            );
            break;
          }
          passengerMap[user.id].picture = user.picture;
          passengerMap[user.id].coords = data.coords;
          if (
            passengerMap[user.id].driver_id &&
            driverMap[passengerMap[user.id].driver_id!] &&
            sockets[passengerMap[user.id].driver_id!]
          ) {
            sockets[passengerMap[user.id].driver_id!].send(
              msgToJSON(typeOfMessage.updatePassenger, passengerMap[user.id])
            );
          }
          loggerMain.info(
            `Passenger update: ${JSON.stringify(
              {
                id: user.id,
                full_name: user.full_name,
                coords: passengerMap[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.pingPassengers: {
          if (!driverMap[user.id]) break;
          const passengerIDArray = Object.keys(passengerMap).filter(
            (id) => !passengerMap[id].driver_id
          );
          const randomPassengers = sampleSize(
            passengerIDArray,
            Math.min(driverMap[user.id].car.seats + 2, 5)
          );
          randomPassengers.forEach((id) => {
            passengerMap[id].driver_id = user.id;
            if (sockets[id]) {
              sockets[id].send(
                msgToJSON(typeOfMessage.pingPassengers, user.id)
              );
            }
          });
          break;
        }
        case typeOfMessage.pingDriver: {
          if (!passengerMap[user.id] || !passengerMap[user.id].driver_id) break;
          if (data == undefined) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.pingDriver
            );
            break;
          }
          const driver_id = passengerMap[user.id].driver_id;
          if (!data) {
            delete passengerMap[user.id].driver_id;
            loggerMain.info(`Passenger ${user.id} refused driver ${driver_id}`);
            break;
          }
          if (
            !driverMap[driver_id!] ||
            driverMap[driver_id!].passengers.length >=
              driverMap[driver_id!].car.seats
          ) {
            ws.send(msgToJSON(typeOfMessage.pingDriver, null));
            delete passengerMap[user.id].driver_id;
            break;
          }
          driverMap[driver_id!].passengers.push(user.id);
          ws.send(msgToJSON(typeOfMessage.pingDriver, driverMap[driver_id!]));
          sockets[driver_id!].send(
            msgToJSON(typeOfMessage.updatePassenger, passengerMap[user.id])
          );
          break;
        }
        case typeOfMessage.stopDriver: {
          stopDriver(user.id);
          loggerMain.info(`Stopped driver ${user.id}`);
          break;
        }
        case typeOfMessage.stopPassenger: {
          stopPassenger(user.id);
          loggerMain.info(`Stopped passenger ${user.id}`);
          break;
        }
        case typeOfMessage.outOfRange: {
          stopPassenger(user.id, false);
          loggerMain.info(
            `Passenger ${user.id} moved out of range of ${
              passengerMap[user.id].driver_id
            }`
          );
          delete passengerMap[user.id].driver_id;
          break;
        }
        case typeOfMessage.arrivedDestination: {
          if (!driverMap[user.id]) break;
          driverMap[user.id].passengers.forEach((passenger) => {
            sockets[passenger].send(
              msgToJSON(typeOfMessage.arrivedDestination, null)
            );
            pendingRatings[passenger] = [user.id];
          });
          pendingRatings[user.id] = driverMap[user.id].passengers;
          loggerMain.info(
            `Driver ${user.id} arrived at destination with passengers ${
              driverMap[user.id].passengers
            }`
          );
          break;
        }
        case typeOfMessage.sendRatings: {
          if (
            !data.ids ||
            !data.ratings ||
            !Array.isArray(data.ids) ||
            !Array.isArray(data.ratings) ||
            data.ids.length != data.ratings.length
          ) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.sendRatings
            );
            break;
          }
          for (let i = 0; i < data.ids.length; i++) {
            if (
              typeof data.ids[i] != "string" ||
              typeof data.ratings[i] != "number" ||
              data.ratings[i] < 0 ||
              data.ratings[i] > 5 ||
              removeWhere(pendingRatings[user.id], (e) => e).length == 0
            ) {
              notifyBadRequest(
                ws,

                user.id,
                decoded,
                typeOfMessage.sendRatings
              );
              continue;
            }
            if (data.ratings[i] == 0) continue;
            const targetUser = await getUser(data.ids[i]);
            if (!targetUser) {
              loggerMain.warn(
                `User ${user.id} tried to rate user ${data.ids[i]} but failed`
              );
              continue;
            }
            updateUserRating(
              targetUser.id,
              targetUser.ratings_sum + data.ratings[i],
              targetUser.ratings_count + 1
            );
            loggerMain.info(
              `User ${user.id} rated user ${data.ids[i]} with ${data.ratings[i]} stars`
            );
          }
          break;
        }
        case typeOfMessage.addCar: {
          if (!data.model || !data.license || !data.seats) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.addCar);
            break;
          }
          const car = await createCar(user.id, data);
          if (!car) {
            return;
          }
          user.cars[car.id] = car;
          ws.send(msgToJSON(typeOfMessage.addCar, car));
          loggerMain.info(
            `Added car to user ${user.id}: ${JSON.stringify(
              user.cars[car.id],
              null,
              2
            )}`
          );
          if (car.picture) {
            let picture = car.picture;
            let car_id = car.id;
            isNSFW(`public/images/cars/${picture}`).then((isNSFW) => {
              if (!isNSFW) return;
              loggerMain.warn(`NSFW image detected at images/cars/${picture}}`);
              deletePicture("cars/" + picture);
              if (!user.cars[car_id] || user.cars[car_id].picture != picture)
                return;
              user.cars[car_id].picture = null;
              if (
                driverMap[user.id] &&
                driverMap[user.id].car.picture == picture
              ) {
                driverMap[user.id].car.picture = null;
              }
              updateUserCar(user.id, user.cars[car_id]);
              if (sockets[user.id]) {
                sockets[user.id].send(
                  msgToJSON(typeOfMessage.deleteCarPicture, car_id)
                );
              }
            });
          }
          break;
        }
        case typeOfMessage.updateCar: {
          if (
            !data.id ||
            !data.model ||
            !data.license ||
            !data.seats ||
            !user.cars[data.id]
          ) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.updateCar
            );
            break;
          }
          const oldPicture = user.cars[data.id].picture;
          const newCar = await updateUserCar(user.id, data as Car);
          if (!newCar) {
            loggerMain.warn(
              `Failed to update car ${JSON.stringify(newCar, null, 2)}`
            );
            return;
          }
          if (oldPicture && newCar.picture != oldPicture) {
            deletePicture("cars/" + oldPicture);
          }
          user.cars[newCar.id] = newCar;
          ws.send(msgToJSON(typeOfMessage.addCar, newCar));
          loggerMain.info(
            `Updated car of ${user.id} to: ${JSON.stringify(newCar, null, 2)}`
          );
          if (newCar.picture && newCar.picture != oldPicture) {
            let picture = newCar.picture;
            let car_id = newCar.id;
            isNSFW(`public/images/cars/${picture}`).then((isNSFW) => {
              if (!isNSFW) return;
              loggerMain.warn(`NSFW image detected at images/cars/${picture}}`);
              deletePicture("cars/" + picture);
              if (!user.cars[car_id] || user.cars[car_id].picture != picture)
                return;
              user.cars[car_id].picture = null;
              updateUserCar(user.id, user.cars[car_id]);
              if (sockets[user.id]) {
                sockets[user.id].send(
                  msgToJSON(typeOfMessage.deleteCarPicture, car_id)
                );
              }
            });
          }
          break;
        }
        case typeOfMessage.updateUserPicture: {
          if (!data) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.updateUserPicture
            );
            break;
          }
          let newUser = await updateUserPicture(user.id, data);
          if (!newUser) {
            loggerMain.warn(
              `Failed to update user ${user.id} picture ${JSON.stringify(
                data,
                null,
                2
              )}`
            );
            return;
          }
          let newPicture = newUser.picture;
          loggerMain.info(
            `Updated picture of ${user.id} from ${user.picture} to ${newPicture}`
          );
          if (!newPicture) break;
          if (user.picture) {
            deletePicture("users/" + user.picture);
          }
          user.picture = newPicture;
          ws.send(msgToJSON(typeOfMessage.updateUserPicture, newPicture));
          isNSFW(`public/images/users/${newPicture}`).then((isNSFW) => {
            if (!isNSFW) return;
            loggerMain.warn(
              `NSFW image detected at images/users/${newPicture}}`
            );
            deletePicture("users/" + newPicture);
            if (user.picture != newPicture) return;
            user.picture = null;
            updateUserPicture(user.id, null);
            if (sockets[user.id]) {
              sockets[user.id].send(
                msgToJSON(typeOfMessage.deleteUserPicture, null)
              );
            }
          });
          break;
        }
        case typeOfMessage.deleteUserPicture: {
          deletePicture("users/" + user.picture);
          break;
        }
        case typeOfMessage.deleteCarPicture: {
          if (!data || !user.cars[data]) break;
          deletePicture("cars/" + data);
          break;
        }
        case typeOfMessage.removeCar: {
          if (!data) {
            notifyBadRequest(
              ws,

              user.id,
              decoded,
              typeOfMessage.removeCar
            );
            break;
          }
          if (!user.cars[data]) break;
          if (user.cars[data].picture)
            deletePicture("cars/" + user.cars[data].picture);
          removeUserCar(user.id, data);
          loggerMain.info(
            `Removed car from ${user.id}: ${JSON.stringify(
              user.cars[data],
              null,
              2
            )}`
          );
          delete user.cars[data];
          ws.send(msgToJSON(typeOfMessage.removeCar, data));
          break;
        }
        case typeOfMessage.getPassengers: {
          if (findWhere(passengerMap, (passenger) => !passenger.driver_id)) {
            ws.send(msgToJSON(typeOfMessage.getPassengers, null));
          }
          break;
        }
        case typeOfMessage.signout: {
          stopDriver(user.id);
          stopPassenger(user.id);
          delete sockets[user.id];
          loggerMain.info(`Signed out ${user.id}`);
          ws.close(1000, "user requested signout");
          break;
        }
      }
    });
  }
);

server.listen(env.API_PORT, () => {
  loggerMain.info(
    `Started main server on port ${env.API_PORT} (${
      env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});

if (env.CRON_PING_URL && env.CRON_INTERVAL_MS) {
  fetch(`${env.CRON_PING_URL}/ridehailing-api`);
  setInterval(
    () => fetch(`${env.CRON_PING_URL}/ridehailing-api`),
    env.CRON_INTERVAL_MS
  );
}
