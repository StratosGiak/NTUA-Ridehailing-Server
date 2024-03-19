import { WebSocketServer } from "ws";
import {
  getAllUsers,
  getUser,
  getCar,
  createUser,
  createCar,
  removeUser,
  removeUserCar,
  updateUserCar,
  updateUserPicture,
  updateUserRating,
} from "./database.js";
import sampleSize from "lodash.samplesize";
import removeWhere from "lodash.remove";
import findWhere from "lodash.find";
import { loggerMain, loggerTraffic } from "./log/logger.js";
import dotenv from "dotenv";
import { isNSFW } from "./ml.js";

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
});

const wss = new WebSocketServer({
  port: process.env.API_PORT,
  maxPayload: 2e3,
});
loggerMain.info(
  `Started main server on port ${process.env.API_PORT} (${
    process.env.NODE_ENV === "production" ? "production" : "development"
  })`
);

var driverMap = {};
var passengerMap = {};
var uuidToID = {};
var sockets = {};

function msgToJSON(type, data) {
  return JSON.stringify({ type: type, data: data });
}

function notifyBadRequest(ws, uuid, decoded, type) {
  loggerMain.warn(
    `Bad request from ${uuid} (${user.id}): ${JSON.stringify(decoded, null, 2)}`
  );
  ws.send(msgToJSON(typeOfMessage.badRequest, type));
}

function stopDriver(id) {
  if (!driverMap[id]) return;
  driverMap[id].passengers.forEach((passenger) => {
    if (passengerMap[passenger.id]) {
      delete passengerMap[passenger.id].driver_id;
    }
    if (sockets[passenger.id]) {
      sockets[passenger.id].send(msgToJSON(typeOfMessage.getDriver, {}));
    }
  });
  delete driverMap[id];
}

function stopPassenger(id, deletePassenger) {
  if (
    !passengerMap[id] ||
    !passengerMap[id].driver_id ||
    !driverMap[passengerMap[id].driver_id]
  )
    return;
  if (sockets[passengerMap[id].driver_id]) {
    sockets[passengerMap[id].driver_id].send(
      msgToJSON(typeOfMessage.updatePassenger, {
        cancelled: id,
      })
    );
  }
  removeWhere(
    driverMap[passengerMap[id].driver_id].passengers,
    (passenger) => passenger.id == id
  );
  if (deletePassenger == undefined || deletePassenger) delete passengerMap[id];
}

function deletePicture(pictureURL) {
  fetch(
    `http://${process.env.MEDIA_HOST}:${process.env.MEDIA_PORT}/images/${pictureURL}`,
    { method: "DELETE" }
  )
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

wss.on("connection", (ws, req) => {
  const uuid = crypto.randomUUID();
  let user;
  loggerMain.info(`Connected client ${uuid}`);
  ws.on("error", (error) => {
    loggerMain.error(error);
  });
  ws.on("close", () => {
    if (!user) {
      loggerMain.info(`Disconnected client ${uuid}`);
      return;
    }
    stopDriver(user.id);
    stopPassenger(user.id);
    delete sockets[user.id];
    loggerMain.info(`Disconnected client ${user.id} (${uuid})`);
  });

  ws.on("message", async (msg) => {
    let decoded;
    try {
      decoded = JSON.parse(msg);
    } catch (error) {
      loggerMain.warn(`Error parsing request from ${uuid}: ${error}`);
      return;
    }
    const type = decoded.type;
    const data = decoded.data;
    loggerTraffic.info(
      `Received from ${uuid}: ${type} data: ${JSON.stringify(data, null, 2)}`
    );
    if (!user && type != typeOfMessage.login) {
      loggerTraffic.info(
        `Client ${uuid} tried to send message without being logged in`
      );
      return;
    }
    switch (type) {
      case typeOfMessage.login:
        if (!data.id) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.login);
          break;
        }
        if (sockets[data.id]) {
          loggerMain.info(
            `Client ${uuid} tried to log in while already logged in`
          );
          ws.send(msgToJSON(typeOfMessage.login, "occupied"));
          break;
        }
        user = await getUser(data.id);
        if (user == undefined) {
          loggerMain.info(`ID ${data.id} not found. Creating...`);
          user = await createUser(data.id, data.name);
        }
        ws.send(msgToJSON(typeOfMessage.login, user));
        sockets[user.id] = ws;
        loggerMain.info(`Client logged in: ${JSON.stringify(user, null, 2)}`);
        break;
      case typeOfMessage.newDriver:
        if (!data.coords || !data.car) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.newDriver);
          break;
        }
        driverMap[user.id] = {
          id: user.id,
          name: user.name,
          picture: user.picture,
          ratings_count: user.ratings_count,
          ratings_sum: user.ratings_sum,
          coords: data.coords,
          car: data.car,
          passengers: [],
        };
        ws.send(msgToJSON(typeOfMessage.newDriver, {}));
        loggerMain.info(
          `New driver: ${JSON.stringify(
            {
              id: driverMap[user.id].id,
              name: driverMap[user.id].name,
              car: driverMap[user.id].car,
              coords: driverMap[user.id].coords,
            },
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.newPassenger:
        if (!data.coords || !data.timestamp) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.newPassenger);
          break;
        }
        passengerMap[user.id] = {
          id: user.id,
          name: user.name,
          picture: user.picture,
          ratings_count: user.ratings_count,
          ratings_sum: user.ratings_sum,
          coords: data.coords,
          timestamp: data.timestamp,
        };
        loggerMain.info(
          `New passenger: ${JSON.stringify(
            {
              id: user.id,
              name: user.name,
              coords: passengerMap[user.id].coords,
            },
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.updateDriver:
        if (!driverMap[user.id]) break;
        if (!data.coords) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.updateDriver);
          break;
        }
        driverMap[user.id].picture = user.picture;
        driverMap[user.id].coords = data.coords;
        driverMap[user.id].passengers.forEach((passenger) => {
          if (sockets[passenger.id]) {
            sockets[passenger.id].send(
              msgToJSON(typeOfMessage.getDriver, driverMap[user.id])
            );
          }
        });
        loggerMain.info(
          `Driver update: ${JSON.stringify(
            {
              id: user.id,
              name: user.name,
              coords: driverMap[user.id].coords,
            },
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.updatePassenger:
        if (!passengerMap[user.id]) break;
        if (!data.coords) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.updatePassenger);
          break;
        }
        passengerMap[user.id].picture = user.picture;
        passengerMap[user.id].coords = data.coords;
        if (
          passengerMap[user.id].driver_id &&
          driverMap[passengerMap[user.id].driver_id] &&
          sockets[passengerMap[user.id].driver_id]
        ) {
          sockets[passengerMap[user.id].driver_id].send(
            msgToJSON(typeOfMessage.updatePassenger, passengerMap[user.id])
          );
        }
        loggerMain.info(
          `Passenger update: ${JSON.stringify(
            {
              id: user.id,
              name: user.name,
              coords: passengerMap[user.id].coords,
            },
            null,
            2
          )}`
        );
        break;
      case typeOfMessage.pingPassengers:
        if (!driverMap[user.id]) break;
        const passengerIDArray = Object.keys(passengerMap).filter(
          (id) => !passengerMap[id].driver_id
        ); //(promote passengers that have a driver to a new array?)
        const randomPassengers = sampleSize(
          passengerIDArray,
          Math.min(driverMap[user.id].car.seats + 2, 5)
        );
        randomPassengers.forEach((id) => {
          passengerMap[id].driver_id = user.id;
          if (sockets[id]) {
            sockets[id].send(msgToJSON(typeOfMessage.pingPassengers, user.id));
          }
        });
        break;
      case typeOfMessage.pingDriver:
        if (!passengerMap[user.id] || !passengerMap[user.id].driver_id) break;
        if (data == undefined) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.pingDriver);
          break;
        }
        const driver_id = passengerMap[user.id].driver_id;
        if (!data) {
          delete passengerMap[user.id].driver_id;
          loggerMain.info(`Passenger ${user.id} refused driver ${driver_id}`);
          break;
        }
        if (
          !driverMap[driver_id] ||
          driverMap[driver_id].passengers.length >=
            driverMap[driver_id].car.seats
        ) {
          ws.send(msgToJSON(typeOfMessage.pingDriver, {}));
          delete passengerMap[user.id].driver_id;
          break;
        }
        driverMap[driver_id].passengers.push(passengerMap[user.id]);
        ws.send(msgToJSON(typeOfMessage.pingDriver, driverMap[driver_id]));
        sockets[driver_id].send(
          msgToJSON(typeOfMessage.updatePassenger, passengerMap[user.id])
        );
        break;
      case typeOfMessage.stopDriver:
        stopDriver(user.id);
        loggerMain.info(`Stopped driver ${user.id}`);
        break;
      case typeOfMessage.stopPassenger:
        stopPassenger(user.id);
        loggerMain.info(`Stopped passenger ${user.id}`);
        break;
      case typeOfMessage.outOfRange:
        stopPassenger(user.id, false);
        loggerMain.info(
          `Passenger ${user.id} moved out of range of ${
            passengerMap[user.id].driver_id
          }`
        );
        delete passengerMap[user.id].driver_id;
        break;
      case typeOfMessage.arrivedDestination:
        if (!driverMap[user.id]) break;
        driverMap[user.id].passengers.forEach((passenger) => {
          sockets[passenger.id].send(
            msgToJSON(typeOfMessage.arrivedDestination, {})
          );
        });
        loggerMain.info(
          `Driver ${
            user.id
          } arrived at destination with passengers ${JSON.stringify(
            driverMap[user.id].passengers
          )}`
        );
        break;
      case typeOfMessage.sendRatings:
        if (
          !data.users ||
          !data.ratings ||
          data.users.length != data.ratings.length
        ) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.sendRatings);
          break;
        }
        for (let i = 0; i < data.users.length; i++) {
          if (data.ratings[i] == 0) continue;
          if (data.ratings[i] < 0 || data.ratings[i] > 5) {
            notifyBadRequest(ws, uuid, decoded, typeOfMessage.sendRatings);
            break;
          }
          if (
            driverMap[user.id] &&
            !findWhere(
              driverMap[user.id].passengers,
              (passenger) => passenger.id == data.users[i]
            ) &&
            false
          ) {
            notifyBadRequest(ws, uuid, decoded, typeOfMessage.sendRatings);
            break;
          } else if (
            passengerMap[user.id] &&
            !passengerMap[user.id].driver_id == data.users[i] &&
            false
          ) {
            notifyBadRequest(ws, uuid, decoded, typeOfMessage.sendRatings);
            break;
          }
          const targetUser = await getUser(data.users[i]);
          updateUserRating(
            targetUser.id,
            targetUser.ratings_sum + data.ratings[i],
            targetUser.ratings_count + 1
          );
          loggerMain.info(
            `User ${user.id} rated user ${data.users[i]} with ${data.ratings[i]} stars`
          );
        }
        break;
      case typeOfMessage.addCar:
        if (!data.model || !data.license || !data.seats) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.addCar);
          break;
        }
        const car = await createCar(user.id, data);
        user.cars[car.car_id] = car;
        ws.send(msgToJSON(typeOfMessage.addCar, car));
        loggerMain.info(
          `Added car to user ${user.id}: ${JSON.stringify(
            user.cars[car.car_id],
            null,
            2
          )}`
        );
        //TODO: Tidy up NSFW handling
        if (!car.picture) break;
        {
          let picture = car.picture;
          let car_id = car.car_id;
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
      case typeOfMessage.updateCar:
        if (
          !data.car_id ||
          !data.model ||
          !data.license ||
          !data.seats ||
          !user.cars[data.car_id]
        ) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.updateCar);
          break;
        }
        const newCar = await updateUserCar(user.id, data);
        if (
          user.cars[data.car_id].picture &&
          data.picture != user.cars[data.car_id].picture
        ) {
          deletePicture("cars/" + user.cars[data.car_id].picture);
        }
        user.cars[newCar.car_id] = newCar;
        ws.send(msgToJSON(typeOfMessage.addCar, newCar));
        loggerMain.info(
          `Updated car of ${user.id}: ${JSON.stringify(newCar, null, 2)}`
        );
        //TODO: Tidy up NSFW handling
        if (!newCar.picture) break;
        {
          let picture = newCar.picture;
          let car_id = newCar.car_id;
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
      case typeOfMessage.updateUserPicture:
        if (!data) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.updateUserPicture);
          break;
        }
        let newPicture = (await updateUserPicture(user.id, data)).picture;
        if (!newPicture) break;
        loggerMain.info(
          `Updated picture of ${user.id} from ${user.picture} to ${newPicture}`
        );
        if (user.picture) {
          deletePicture("users/" + user.picture);
        }
        user.picture = newPicture;
        ws.send(msgToJSON(typeOfMessage.updateUserPicture, newPicture));
        //TODO: Tidy up NSFW handling
        isNSFW(`public/images/users/${newPicture}`).then((isNSFW) => {
          if (!isNSFW) return;
          loggerMain.warn(`NSFW image detected at images/users/${newPicture}}`);
          deletePicture("users/" + newPicture);
          if (user.picture != newPicture) return;
          user.picture = null;
          updateUserPicture(user.id, null);
          if (sockets[user.id]) {
            sockets[user.id].send(
              msgToJSON(typeOfMessage.deleteUserPicture, {})
            );
          }
        });
        break;
      case typeOfMessage.deleteUserPicture:
        deletePicture("users/" + user.picture);
        break;
      case typeOfMessage.deleteCarPicture:
        if (!data || !user.cars[data]) break;
        deletePicture("cars/" + data);
        break;
      case typeOfMessage.removeCar:
        if (!data) {
          notifyBadRequest(ws, uuid, decoded, typeOfMessage.removeCar);
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
      case typeOfMessage.getPassengers:
        if (findWhere(passengerMap, (passenger) => !passenger.driver_id)) {
          ws.send(msgToJSON(typeOfMessage.getPassengers, {}));
        }
        break;
      case typeOfMessage.signout:
        stopDriver(user.id);
        stopPassenger(user.id);
        delete sockets[user.id];
        loggerMain.info(`Signed out ${user.id}`);
        break;
      default:
        ws.send(
          msgToJSON(typeOfMessage.message, `[SERVER] echo (${uuid}) : ${data}`)
        );
        break;
    }
  });
});
