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
import remove from "lodash.remove";
import { loggerMain, loggerTraffic } from "./logger.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { cleanEnv, str, num } from "envalid";
import type { Car, Credentials, Driver, Passenger } from "./types/types.js";

const env = cleanEnv(process.env, {
  API_PORT: str(),
  MEDIA_HOST: str(),
  MEDIA_PORT: num(),
  ML_HOST: str(),
  ML_PORT: num(),
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
  deleteUserPicture: "!DELETEUSERPICTURE",
  deleteCarPicture: "!DELETECARPICTURE",
  removeCar: "!REMOVECAR",
  getPassengers: "!GETPASSENGERS",
  pingPassengers: "!PINGPASSENGERS",
  pingDriver: "!PINGDRIVER",
  badRequest: "!BADREQUEST",
  message: "!MESSAGE",
  signout: "!SIGNOUT",
} as const;

let driverArray: { [id: string]: Driver } = {};
let passengerArray: { [id: string]: Passenger } = {};
let socketArray: { [id: string]: WebSocket } = {};
let pendingRatings: { [id: string]: string[] } = {};

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

function isValidCar(car: any) {
  return (
    car != null &&
    typeof car.model == "string" &&
    typeof car.license == "string" &&
    typeof car.seats == "number" &&
    (typeof car.color == "number" || car.color == null) &&
    (typeof car.picture == "string" || car.picture == null)
  );
}

function isValidCoordinates(coords: any) {
  return (
    coords != null &&
    typeof coords.latitude == "number" &&
    typeof coords.longitude == "number"
  );
}

function stopDriver(id: string, deleteDriver: boolean = true) {
  if (!driverArray[id]) return;
  driverArray[id].passengers.forEach((passenger) => {
    if (passengerArray[passenger]) {
      delete passengerArray[passenger].driver_id;
    }
    if (socketArray[passenger]) {
      socketArray[passenger].send(msgToJSON(typeOfMessage.updateDriver, null));
    }
  });
  if (deleteDriver) delete driverArray[id];
}

function stopPassenger(id: string, deletePassenger: boolean = true) {
  if (!passengerArray[id]) return;
  if (
    passengerArray[id].driver_id &&
    driverArray[passengerArray[id].driver_id!]
  ) {
    if (socketArray[passengerArray[id].driver_id!]) {
      socketArray[passengerArray[id].driver_id!].send(
        msgToJSON(typeOfMessage.updatePassenger, {
          cancelled: id,
        })
      );
    }
    remove(
      driverArray[passengerArray[id].driver_id!].passengers,
      (passenger) => passenger == id
    );
    remove(
      driverArray[passengerArray[id].driver_id!].candidates,
      (passenger) => passenger == id
    );
  }
  if (deletePassenger) delete passengerArray[id];
}

async function isNSFW(path: string) {
  const response = await fetch(
    `https://ntua-ridehailing.dslab.ece.ntua.gr/ml/${path}`
  );
  return response.json() as Promise<boolean>;
}

async function deletePicture(pictureURL: string) {
  try {
    const response = await fetch(
      `https://${env.MEDIA_HOST}:${env.MEDIA_PORT}/post/images/${pictureURL}`,
      {
        method: "DELETE",
      }
    );
    if (!response.ok) {
      loggerMain.warn(`FAILED to delete image at ${pictureURL}`);
    } else {
      loggerMain.info(`Deleted image at ${pictureURL}`);
    }
  } catch (error) {
    loggerMain.error(`Failed to connect to media server: ${error}`);
  }
}

async function authenticate(req: IncomingMessage) {
  let idToken = req.headers["sec-websocket-protocol"];
  loggerTraffic.info(`Connection attempted`);
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
  } as Credentials;
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
    if (socketArray[credentials.id]) {
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
    socketArray[user.id] = ws;
    loggerMain.info(`Client logged in: ${JSON.stringify(user, null, 2)}`);

    ws.on("error", (error) => {
      loggerMain.error(error);
    });

    ws.on("close", () => {
      if (!user) return;
      stopDriver(user.id);
      stopPassenger(user.id);
      delete socketArray[user.id];
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
          if (
            !data ||
            !isValidCar(data.car) ||
            !isValidCoordinates(data.coords)
          ) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.newDriver);
            break;
          }
          stopPassenger(user.id);
          driverArray[user.id] = {
            ...user,
            coords: data.coords,
            car: data.car,
            candidates: [],
            passengers: [],
          };
          ws.send(msgToJSON(typeOfMessage.newDriver, null));
          loggerMain.info(
            `New driver: ${JSON.stringify(
              {
                id: driverArray[user.id].id,
                full_name: driverArray[user.id].full_name,
                car: driverArray[user.id].car,
                coords: driverArray[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.newPassenger: {
          if (!data || !isValidCoordinates(data.coords)) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.newPassenger);
            break;
          }
          stopDriver(user.id);
          passengerArray[user.id] = {
            ...user,
            coords: data.coords,
          };
          loggerMain.info(
            `New passenger: ${JSON.stringify(
              {
                id: user.id,
                full_name: user.full_name,
                coords: passengerArray[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.updateDriver: {
          if (!driverArray[user.id]) break;
          if (!data || !isValidCoordinates(data.coords)) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.updateDriver);
            break;
          }
          driverArray[user.id].picture = user.picture;
          driverArray[user.id].coords = data.coords;
          driverArray[user.id].passengers.forEach((passenger) => {
            if (!socketArray[passenger]) return;
            socketArray[passenger].send(
              msgToJSON(typeOfMessage.updateDriver, driverArray[user.id])
            );
          });
          loggerMain.info(
            `Driver update: ${JSON.stringify(
              {
                id: user.id,
                full_name: user.full_name,
                coords: driverArray[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.updatePassenger: {
          if (!passengerArray[user.id]) break;
          if (!data || !isValidCoordinates(data.coords)) {
            notifyBadRequest(
              ws,
              user.id,
              decoded,
              typeOfMessage.updatePassenger
            );
            break;
          }
          passengerArray[user.id].picture = user.picture;
          passengerArray[user.id].coords = data.coords;
          if (
            passengerArray[user.id].driver_id &&
            driverArray[passengerArray[user.id].driver_id!] &&
            driverArray[passengerArray[user.id].driver_id!].passengers.find(
              (passenger) => passenger == user.id
            ) &&
            socketArray[passengerArray[user.id].driver_id!]
          ) {
            socketArray[passengerArray[user.id].driver_id!].send(
              msgToJSON(typeOfMessage.updatePassenger, passengerArray[user.id])
            );
          }
          loggerMain.info(
            `Passenger update: ${JSON.stringify(
              {
                id: user.id,
                full_name: user.full_name,
                coords: passengerArray[user.id].coords,
              },
              null,
              2
            )}`
          );
          break;
        }
        case typeOfMessage.pingPassengers: {
          if (!driverArray[user.id]) break;
          const passengerIDArray = Object.keys(passengerArray).filter(
            (id) => !passengerArray[id].driver_id
          );
          driverArray[user.id].candidates = sampleSize(
            passengerIDArray,
            Math.min(driverArray[user.id].car.seats + 2, 5)
          );
          driverArray[user.id].candidates.forEach((id) => {
            passengerArray[id].driver_id = user.id;
            if (!socketArray[id]) return;
            socketArray[id].send(
              msgToJSON(typeOfMessage.pingPassengers, user.id)
            );
          });
          break;
        }
        case typeOfMessage.pingDriver: {
          if (!passengerArray[user.id] || !passengerArray[user.id].driver_id)
            break;
          if (
            !driverArray[passengerArray[user.id].driver_id!] ||
            !driverArray[passengerArray[user.id].driver_id!].candidates.find(
              (passenger) => passenger == user.id
            )
          ) {
            ws.send(msgToJSON(typeOfMessage.pingDriver, null));
            delete passengerArray[user.id].driver_id;
            break;
          }
          if (
            driverArray[passengerArray[user.id].driver_id!].passengers.find(
              (passenger) => passenger == user.id
            )
          )
            break;
          const driver_id = passengerArray[user.id].driver_id!;
          if (!data) {
            delete passengerArray[user.id].driver_id;
            loggerMain.info(`Passenger ${user.id} refused driver ${driver_id}`);
            break;
          }
          if (
            driverArray[driver_id].passengers.length >=
            driverArray[driver_id].car.seats
          ) {
            ws.send(msgToJSON(typeOfMessage.pingDriver, null));
            delete passengerArray[user.id].driver_id;
            break;
          }
          driverArray[driver_id].passengers.push(user.id);
          remove(
            driverArray[driver_id].candidates,
            (passenger) => passenger == user.id
          );
          ws.send(msgToJSON(typeOfMessage.pingDriver, driverArray[driver_id]));
          if (socketArray[driver_id]) {
            socketArray[driver_id].send(
              msgToJSON(typeOfMessage.updatePassenger, passengerArray[user.id])
            );
          }
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
              passengerArray[user.id].driver_id
            }`
          );
          delete passengerArray[user.id].driver_id;
          break;
        }
        case typeOfMessage.arrivedDestination: {
          if (!driverArray[user.id]) break;
          driverArray[user.id].passengers.forEach((passenger) => {
            if (!socketArray[passenger]) return;
            socketArray[passenger].send(
              msgToJSON(typeOfMessage.arrivedDestination, null)
            );
            pendingRatings[passenger] = [user.id];
          });
          pendingRatings[user.id] = driverArray[user.id].passengers;
          loggerMain.info(
            `Driver ${user.id} arrived at destination with passengers ${
              driverArray[user.id].passengers
            }`
          );
          break;
        }
        case typeOfMessage.sendRatings: {
          if (
            !data ||
            !data.ids ||
            !data.ratings ||
            !Array.isArray(data.ids) ||
            !Array.isArray(data.ratings) ||
            data.ids.length != data.ratings.length
          ) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.sendRatings);
            break;
          }
          for (let i = 0; i < data.ids.length; i++) {
            if (
              typeof data.ids[i] != "string" ||
              typeof data.ratings[i] != "number" ||
              data.ratings[i] < 0 ||
              data.ratings[i] > 5 ||
              remove(
                pendingRatings[user.id],
                (userIDs) => userIDs == data.ids[i]
              ).length == 0
            ) {
              notifyBadRequest(ws, user.id, decoded, typeOfMessage.sendRatings);
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
          if (!data || !isValidCar(data)) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.addCar);
            break;
          }
          const car = await createCar(user.id, data);
          if (!car) {
            loggerMain.warn(
              `Failed to create car ${JSON.stringify(data, null, 2)}`
            );
            break;
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
            const resultNSFW = await isNSFW(`cars/${picture}`);
            if (!resultNSFW) return;
            loggerMain.warn(`NSFW image detected at cars/${picture}`);
            deletePicture("cars/" + picture);
            if (!user.cars[car_id] || user.cars[car_id].picture != picture)
              return;
            user.cars[car_id].picture = null;
            if (
              driverArray[user.id] &&
              driverArray[user.id].car.picture == picture
            ) {
              driverArray[user.id].car.picture = null;
            }
            updateUserCar(user.id, user.cars[car_id]);
            if (socketArray[user.id]) {
              socketArray[user.id].send(
                msgToJSON(typeOfMessage.deleteCarPicture, car_id)
              );
            }
          }
          break;
        }
        case typeOfMessage.updateCar: {
          if (
            !data ||
            !data.id ||
            typeof data.id != "string" ||
            !user.cars[data.id] ||
            !isValidCar(data)
          ) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.updateCar);
            break;
          }
          const oldPicture = user.cars[data.id].picture;
          const newCar = await updateUserCar(user.id, data as Car);
          if (!newCar) {
            loggerMain.warn(
              `Failed to update car ${JSON.stringify(newCar, null, 2)}`
            );
            break;
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
            const resultNSFW = await isNSFW(`cars/${picture}`);
            if (!resultNSFW) return;
            loggerMain.warn(`NSFW image detected at cars/${picture}`);
            deletePicture("cars/" + picture);
            if (!user.cars[car_id] || user.cars[car_id].picture != picture)
              return;
            user.cars[car_id].picture = null;
            updateUserCar(user.id, user.cars[car_id]);
            if (socketArray[user.id]) {
              socketArray[user.id].send(
                msgToJSON(typeOfMessage.deleteCarPicture, car_id)
              );
            }
          }
          break;
        }
        case typeOfMessage.updateUserPicture: {
          if (!data || typeof data != "string") {
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
          const resultNSFW = await isNSFW(`users/${newPicture}`);
          if (!resultNSFW) return;
          loggerMain.warn(`NSFW image detected at users/${newPicture}`);
          deletePicture("users/" + newPicture);
          if (user.picture != newPicture) return;
          user.picture = null;
          updateUserPicture(user.id, null);
          if (socketArray[user.id]) {
            socketArray[user.id].send(
              msgToJSON(typeOfMessage.deleteUserPicture, null)
            );
          }
          break;
        }
        case typeOfMessage.deleteUserPicture: {
          deletePicture("users/" + user.picture);
          break;
        }
        case typeOfMessage.deleteCarPicture: {
          if (!data || typeof data != "string" || !user.cars[data]) break;
          deletePicture("cars/" + data);
          break;
        }
        case typeOfMessage.removeCar: {
          if (!data || typeof data != "string" || !user.cars[data]) {
            notifyBadRequest(ws, user.id, decoded, typeOfMessage.removeCar);
            break;
          }
          if (user.cars[data].picture)
            deletePicture("cars/" + user.cars[data].picture);
          removeUserCar(user.id, parseInt(data));
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
          if (
            Object.keys(passengerArray).find(
              (id) => !passengerArray[id].driver_id
            )
          ) {
            ws.send(msgToJSON(typeOfMessage.getPassengers, null));
          }
          break;
        }
        case typeOfMessage.signout: {
          stopDriver(user.id);
          stopPassenger(user.id);
          delete socketArray[user.id];
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
  const url = `${env.CRON_PING_URL}/ridehailing-api`;
  fetch(url);
  setInterval(
    () =>
      fetch(url).catch((error) =>
        loggerMain.error("Failed to connect to heartbeat server." + error)
      ),
    env.CRON_INTERVAL_MS
  );
}
