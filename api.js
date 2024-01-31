import { WebSocketServer } from "ws";
import {
  getAllUsers,
  getUser,
  getUserCar,
  createUser,
  createUserCar,
  removeUser,
  removeUserCar,
  updateUserCar,
  updateUserPicture,
  updateUserRating,
} from "./database.js";
import sampleSize from "lodash.samplesize";
import removeWhere from "lodash.remove";
import findWhere from "lodash.find";
import { loggerMain, loggerTraffic } from "./logger/logger.js";
import dotenv from "dotenv";

if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: "./.env.production" });
} else {
  dotenv.config({ path: "./.env.development" });
}

const typeOfMessage = Object.freeze({
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
  removeCar: "!REMOVECAR",
  getDriver: "!GETDRIVER",
  getPassengers: "!GETPASSENGERS",
  pingPassengers: "!PINGPASSENGERS",
  pingDriver: "!PINGDRIVER",
  badRequest: "!BADREQUEST",
  message: "!MESSAGE",
  signout: "!SIGNOUT",
});

const wss = new WebSocketServer({ port: process.env.API_PORT });
loggerMain.info(
  `Started main server on port ${process.env.API_PORT} (${
    process.env.NODE_ENV === "production" ? "production" : "development"
  })`
);

const usersMap = await getAllUsers();
var driverMap = {};
var passengerMap = {};
var wsToID = {};
var sockets = {};

function msgToJSON(type, data) {
  return JSON.stringify({ type: type, data: data });
}

function notifyBadRequest(ws, wsIP, decoded, type) {
  loggerMain.warn(
    `Bad request from ${wsIP} (${wsToID[wsIP]}): ${JSON.stringify(
      decoded,
      null,
      2
    )}`
  );
  ws.send(msgToJSON(typeOfMessage.badRequest, type));
}

wss.on("connection", (ws, req) => {
  const wsIP = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  loggerMain.info(`Connected client ${wsIP}`);
  ws.on("error", (error) => {
    loggerMain.error(error);
  });
  ws.on("close", () => {
    if (!wsToID[wsIP]) {
      loggerMain.info(`Disconnected client ${wsIP}`);
      return;
    }
    if (driverMap[wsToID[wsIP]]) {
      driverMap[wsToID[wsIP]].passengers.forEach((passenger) => {
        if (sockets[passenger.id]) {
          sockets[passenger.id].send(msgToJSON(typeOfMessage.getDriver, null));
        }
        if (passengerMap[passenger.id]) {
          delete passengerMap[passenger.id].driver_id;
        }
      });
    }
    if (
      passengerMap[wsToID[wsIP]] &&
      passengerMap[wsToID[wsIP]].driver_id &&
      driverMap[passengerMap[wsToID[wsIP]].driver_id]
    ) {
      if (sockets[passengerMap[wsToID[wsIP]].driver_id]) {
        sockets[passengerMap[wsToID[wsIP]].driver_id].send(
          msgToJSON(typeOfMessage.updatePassenger, { cancelled: wsToID[wsIP] })
        );
      }
      removeWhere(
        driverMap[passengerMap[wsToID[wsIP]].driver_id].passengers,
        (item) => item.id == wsToID[wsIP]
      );
    }
    delete passengerMap[wsToID[wsIP]];
    delete driverMap[wsToID[wsIP]];
    delete sockets[wsToID[wsIP]];
    loggerMain.info(`Disconnected client ${wsToID[wsIP]} (${wsIP})`);
    delete wsToID[wsIP];
  });

  ws.on("message", async (msg) => {
    let decoded;
    try {
      decoded = JSON.parse(msg);
    } catch (error) {
      loggerMain.warn(`Error parsing request from ${wsIP}: ${error}`);
      return;
    }
    const type = decoded["type"];
    const data = decoded["data"];
    loggerTraffic.info(
      `Received from ${wsIP}: ${type} data: ${JSON.stringify(data, null, 2)}`
    );
    if (type != typeOfMessage.login && !wsToID[wsIP]) {
      loggerTraffic.info(
        `Client ${wsIP} tried to send message without being logged in`
      );
      return;
    }
    switch (type) {
      case typeOfMessage.login:
        if (!data["id"]) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.login);
          break;
        }
        if (wsToID[wsIP]) {
          loggerMain.info(
            `Client ${wsIP} tried to log in while already logged in`
          );
          ws.send(msgToJSON(typeOfMessage.login, "occupied"));
          break;
        }
        const id = data["id"];
        let result = await getUser(id);
        if (result == undefined) {
          loggerMain.info(`ID ${id} not found. Creating...`);
          const name = data["name"];
          const token = data["token"];
          result = await createUser(id, name, token);
          usersMap[id] = result;
        }
        result.mapUrl = process.env.MAP_URL;
        ws.send(msgToJSON(typeOfMessage.login, result));
        wsToID[wsIP] = id;
        sockets[id] = ws;
        break;
      case typeOfMessage.newDriver:
        if (!data["coords"] || !data["car"]) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.newDriver);
          break;
        }
        driverMap[wsToID[wsIP]] = {
          id: usersMap[wsToID[wsIP]].id,
          name: usersMap[wsToID[wsIP]].name,
          picture: usersMap[wsToID[wsIP]].picture,
          ratings_count: usersMap[wsToID[wsIP]].ratings_count,
          ratings_sum: usersMap[wsToID[wsIP]].ratings_sum,
          coords: data["coords"],
          car: data["car"],
          passengers: [],
        };
        ws.send(msgToJSON(typeOfMessage.newDriver, {}));
        loggerMain.info(
          `New driver: ${JSON.stringify(
            {
              id: driverMap[wsToID[wsIP]].id,
              name: driverMap[wsToID[wsIP]].name,
              car: driverMap[wsToID[wsIP]].car,
              coords: driverMap[wsToID[wsIP]].coords,
            },
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.newPassenger:
        if (!data["coords"] || !data["timestamp"]) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.newPassenger);
          break;
        }
        passengerMap[wsToID[wsIP]] = {
          id: usersMap[wsToID[wsIP]].id,
          name: usersMap[wsToID[wsIP]].name,
          picture: usersMap[wsToID[wsIP]].picture,
          ratings_count: usersMap[wsToID[wsIP]].ratings_count,
          ratings_sum: usersMap[wsToID[wsIP]].ratings_sum,
          coords: data["coords"],
          timestamp: data["timestamp"],
        };
        loggerMain.info(
          `New passenger: ${JSON.stringify(
            {
              id: passengerMap[wsToID[wsIP]].id,
              name: passengerMap[wsToID[wsIP]].name,
              coords: passengerMap[wsToID[wsIP]].coords,
            },
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.updateDriver:
        if (!driverMap[wsToID[wsIP]]) break;
        if (!data["coords"]) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.updateDriver);
          break;
        }
        driverMap[wsToID[wsIP]].coords = data["coords"];
        driverMap[wsToID[wsIP]].passengers.forEach((passenger) => {
          if (sockets[passenger.id]) {
            sockets[passenger.id].send(
              msgToJSON(typeOfMessage.getDriver, driverMap[wsToID[wsIP]])
            );
          }
        });
        loggerMain.info(
          `Driver update: ${JSON.stringify(
            {
              id: driverMap[wsToID[wsIP]].id,
              coords: driverMap[wsToID[wsIP]].coords,
            },
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.updatePassenger:
        if (!passengerMap[wsToID[wsIP]]) break;
        if (!data["coords"]) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.updatePassenger);
          break;
        }
        passengerMap[wsToID[wsIP]].coords = data["coords"];
        if (
          passengerMap[wsToID[wsIP]].driver_id &&
          driverMap[passengerMap[wsToID[wsIP]].driver_id] &&
          sockets[passengerMap[wsToID[wsIP]].driver_id]
        ) {
          sockets[passengerMap[wsToID[wsIP]].driver_id].send(
            msgToJSON(typeOfMessage.updatePassenger, passengerMap[wsToID[wsIP]])
          );
        }
        loggerMain.info(
          `Passenger update: ${JSON.stringify(
            {
              id: passengerMap[wsToID[wsIP]].id,
              coords: passengerMap[wsToID[wsIP]].coords,
            },
            null,
            2
          )}`
        );

        break;
      case typeOfMessage.pingPassengers:
        let passengerIDArray = Object.keys(passengerMap).filter(
          (id) => !passengerMap[id].driver_id
        ); //(promote passengers that have a driver to a new array?)
        const randomPassengers = sampleSize(
          passengerIDArray,
          Math.min(passengerIDArray.length + 2, 5)
        );
        randomPassengers.forEach((id) => {
          if (!passengerMap[id]) return;
          passengerMap[id].driver_id = wsToID[wsIP];
          if (sockets[id]) {
            sockets[id].send(
              msgToJSON(typeOfMessage.pingPassengers, wsToID[wsIP])
            );
          }
        });
        break;
      case typeOfMessage.pingDriver:
        if (
          !passengerMap[wsToID[wsIP]] ||
          !passengerMap[wsToID[wsIP]].driver_id
        ) {
          break;
        }
        if (data == undefined) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.pingDriver);
          break;
        }
        if (!data) {
          loggerMain.info(
            `Passenger ${wsToID[wsIP]} refused driver ${
              passengerMap[wsToID[wsIP]].driver_id
            }`
          );
          delete passengerMap[wsToID[wsIP]].driver_id;
          break;
        }
        if (
          !driverMap[passengerMap[wsToID[wsIP]].driver_id] ||
          driverMap[passengerMap[wsToID[wsIP]].driver_id].passengers.length >=
            driverMap[passengerMap[wsToID[wsIP]].driver_id].car.seats
        ) {
          ws.send(msgToJSON(typeOfMessage.pingDriver, null));
          delete passengerMap[wsToID[wsIP]].driver_id;
        } else {
          driverMap[passengerMap[wsToID[wsIP]].driver_id].passengers.push(
            passengerMap[wsToID[wsIP]]
          );
          ws.send(
            msgToJSON(
              typeOfMessage.pingDriver,
              driverMap[passengerMap[wsToID[wsIP]].driver_id]
            )
          );
          sockets[passengerMap[wsToID[wsIP]].driver_id].send(
            msgToJSON(typeOfMessage.updatePassenger, passengerMap[wsToID[wsIP]])
          );
        }
        break;
      case typeOfMessage.stopDriver:
        if (!driverMap[wsToID[wsIP]]) break;
        driverMap[wsToID[wsIP]].passengers.forEach((passenger) => {
          if (sockets[passenger.id]) {
            sockets[passenger.id].send(
              msgToJSON(typeOfMessage.getDriver, null)
            );
          }
          if (passengerMap[passenger.id]) {
            delete passengerMap[passenger.id].driver_id;
          }
        });
        delete driverMap[wsToID[wsIP]];
        loggerMain.info(`Stopped driver ${wsToID[wsIP]}`);
        break;
      case typeOfMessage.stopPassenger:
        if (
          !passengerMap[wsToID[wsIP]] ||
          !passengerMap[wsToID[wsIP]].driver_id ||
          !driverMap[passengerMap[wsToID[wsIP]].driver_id]
        ) {
          break;
        }
        if (sockets[passengerMap[wsToID[wsIP]].driver_id]) {
          sockets[passengerMap[wsToID[wsIP]].driver_id].send(
            msgToJSON(typeOfMessage.updatePassenger, {
              cancelled: wsToID[wsIP],
            })
          );
        }
        removeWhere(
          driverMap[passengerMap[wsToID[wsIP]].driver_id].passengers,
          (passenger) => passenger.id == wsToID[wsIP]
        );
        loggerMain.info(`Stopped passenger ${wsToID[wsIP]}`);
        delete passengerMap[wsToID[wsIP]];
        break;
      case typeOfMessage.outOfRange:
        if (
          !passengerMap[wsToID[wsIP]] ||
          !passengerMap[wsToID[wsIP]].driver_id ||
          !driverMap[passengerMap[wsToID[wsIP]].driver_id]
        ) {
          break;
        }
        if (sockets[passengerMap[wsToID[wsIP]].driver_id]) {
          sockets[passengerMap[wsToID[wsIP]].driver_id].send(
            msgToJSON(typeOfMessage.updatePassenger, {
              cancelled: wsToID[wsIP],
            })
          );
        }
        removeWhere(
          driverMap[passengerMap[wsToID[wsIP]].driver_id].passengers,
          (passenger) => passenger.id == wsToID[wsIP]
        );
        loggerMain.info(
          `Passenger ${wsToID[wsIP]} moved out of range of ${
            passengerMap[wsToID[wsIP]].driver_id
          }`
        );
        delete passengerMap[wsToID[wsIP]].driver_id;
        break;
      case typeOfMessage.arrivedDestination:
        if (!driverMap[wsToID[wsIP]]) break;
        driverMap[wsToID[wsIP]].passengers.forEach((passenger) => {
          sockets[passenger.id].send(
            msgToJSON(typeOfMessage.arrivedDestination, {})
          );
        });
        loggerMain.info(
          `Driver ${
            wsToID[wsIP]
          } arrived at destination with passengers ${JSON.stringify(
            driverMap[wsToID[wsIP]].passengers
          )}`
        );
        break;
      case typeOfMessage.sendRatings:
        if (
          !data["users"] ||
          !data["ratings"] ||
          data["users"].length != data["ratings"].length
        ) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.sendRatings);
          break;
        }
        for (let i = 0; i < data["users"].length; i++) {
          if (data["ratings"][i] == 0) continue;
          if (data["ratings"][i] < 0 || data["ratings"][i] > 5) {
            notifyBadRequest(ws, wsIP, decoded, typeOfMessage.sendRatings);
            break;
          }
          if (
            driverMap[wsToID[wsIP]] &&
            !findWhere(
              driverMap[wsToID[wsIP]].passengers,
              (passenger) => passenger.id == data["users"][i]
            ) &&
            false
          ) {
            notifyBadRequest(ws, wsIP, decoded, typeOfMessage.sendRatings);
            break;
          } else if (
            passengerMap[wsToID[wsIP]] &&
            !passengerMap[wsToID[wsIP]].driver_id == data["users"][i] &&
            false
          ) {
            notifyBadRequest(ws, wsIP, decoded, typeOfMessage.sendRatings);
            break;
          }
          usersMap[data["users"][i]]["ratings_sum"] += data["ratings"][i];
          ++usersMap[data["users"][i]]["ratings_count"];
          updateUserRating(
            data["users"][i],
            usersMap[data["users"][i]]["ratings_sum"],
            usersMap[data["users"][i]]["ratings_count"]
          );
          loggerMain.info(
            `User ${wsToID[wsIP]} rated user ${data["users"][i]} with ${data["ratings"][i]} stars`
          );
        }
        break;
      case typeOfMessage.addCar:
        if (!data["model"] || !data["license"] || !data["seats"]) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.addCar);
          break;
        }
        const car = await createUserCar(wsToID[wsIP], data);
        let user = usersMap[wsToID[wsIP]];
        user.cars[car.car_id] = car;
        ws.send(msgToJSON(typeOfMessage.addCar, car));
        loggerMain.info(
          `Added car to user ${user.id}: ${JSON.stringify(
            user.cars[car.car_id],
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.updateCar:
        if (
          !data["car_id"] ||
          !data["model"] ||
          !data["license"] ||
          !data["seats"] ||
          !usersMap[wsToID[wsIP]].cars[data["car_id"]]
        ) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.updateCar);
          break;
        }
        const newCar = await updateUserCar(wsToID[wsIP], data);
        usersMap[wsToID[wsIP]].cars[newCar.car_id] = newCar;
        ws.send(msgToJSON(typeOfMessage.addCar, newCar));
        loggerMain.info(
          `Updated car of ${wsToID[wsIP]}: ${JSON.stringify(newCar, null, 2)}`
        );
        break;
      case typeOfMessage.updateUserPicture:
        if (!data) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.updateUserPicture);
          break;
        }
        let picture = (await updateUserPicture(wsToID[wsIP], data))["picture"];
        usersMap[wsToID[wsIP]].picture = picture;
        if (passengerMap[wsToID[wsIP]]) {
          passengerMap[wsToID[wsIP]].picture = picture;
        }
        if (driverMap[wsToID[wsIP]]) {
          driverMap[wsToID[wsIP]].picture = picture;
        }
        ws.send(msgToJSON(typeOfMessage.updateUserPicture, picture));
        loggerMain.info(
          `Updated picture of ${wsToID[wsIP]} from ${data} to ${picture}`
        );
        break;
      case typeOfMessage.deletePicture: //FIX !!!
        if (
          data["car_id"] &&
          usersMap[wsToID[wsIP]].cars[data["car_id"]] &&
          usersMap[wsToID[wsIP]].cars[data["car_id"]]["picture"] ==
            data["picture"]
        ) {
          fetch(
            `http://${process.env.MEDIA_HOST}:${process.env.MEDIA_PORT}/images/cars/${data["picture"]}`,
            { method: "DELETE" }
          )
            .then((response) => {
              if (!response.ok) {
                loggerMain.warn(
                  `FAILED to delete image at /images/cars/${data["picture"]}`
                );
              } else {
                loggerMain.info(
                  `Deleted image at /images/cars/${data["picture"]}`
                );
              }
            })
            .catch((error) => {
              loggerMain.error(`Failed to connect to media server: ${error}`);
            });
        } else if (usersMap[wsToID[wsIP]]["picture"] == data["picture"]) {
          fetch(
            `http://${process.env.MEDIA_HOST}:${process.env.MEDIA_PORT}/images/users/${data["picture"]}`,
            { method: "DELETE" }
          )
            .then((response) => {
              if (!response.ok) {
                loggerMain.warn(
                  `FAILED to delete image at /images/users/${data["picture"]}`
                );
              } else {
                loggerMain.info(
                  `Deleted image at /images/users/${data["picture"]}`
                );
              }
            })
            .catch((error) => {
              loggerMain.error(`Failed to connect to media server: ${error}`);
            });
        }
        break;
      case typeOfMessage.removeCar:
        if (!data) {
          notifyBadRequest(ws, wsIP, decoded, typeOfMessage.removeCar);
          break;
        }
        if (!usersMap[wsToID[wsIP]].cars[data]) break;
        removeUserCar(wsToID[wsIP], data);
        loggerMain.info(
          `Removed car from ${wsToID[wsIP]}: ${JSON.stringify(
            usersMap[wsToID[wsIP]].cars[data],
            null,
            2
          )}`
        );
        delete usersMap[wsToID[wsIP]].cars[data];
        ws.send(msgToJSON(typeOfMessage.removeCar, data));
        break;
      case typeOfMessage.getPassengers:
        if (findWhere(passengerMap, (passenger) => !passenger.driver_id)) {
          ws.send(msgToJSON(typeOfMessage.getPassengers, {}));
        }
        break;
      case typeOfMessage.signout:
        if (driverMap[wsToID[wsIP]]) {
          driverMap[wsToID[wsIP]].passengers.forEach((passenger) => {
            if (sockets[passenger.id]) {
              sockets[passenger.id].send(
                msgToJSON(typeOfMessage.getDriver, null)
              );
            }
            if (passengerMap[passenger.id]) {
              delete passengerMap[passenger.id].driver_id;
            }
          });
        }
        if (
          passengerMap[wsToID[wsIP]] &&
          passengerMap[wsToID[wsIP]].driver_id &&
          driverMap[passengerMap[wsToID[wsIP]].driver_id]
        ) {
          if (sockets[passengerMap[wsToID[wsIP]].driver_id]) {
            sockets[passengerMap[wsToID[wsIP]].driver_id].send(
              msgToJSON(typeOfMessage.updatePassenger, {
                cancelled: wsToID[wsIP],
              })
            );
          }
          removeWhere(
            driverMap[passengerMap[wsToID[wsIP]].driver_id].passengers,
            (item) => item.id == wsToID[wsIP]
          );
        }
        delete passengerMap[wsToID[wsIP]];
        delete driverMap[wsToID[wsIP]];
        delete sockets[wsToID[wsIP]];
        delete wsToID[wsIP];
        loggerMain.info(`Signed out ${wsToID[wsIP]}`);
        break;
      case typeOfMessage.message:
        ws.send(
          msgToJSON(typeOfMessage.message, `[SERVER] echo (${wsIP}) : ${data}`)
        );
        break;
      default:
        break;
    }
  });
});
