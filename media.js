import express from "express";
import multer from "multer";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { loggerMain, loggerTraffic } from "./logger/logger.js";
import dotenv from "dotenv";

if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: "./.env.production" });
} else {
  dotenv.config({ path: "./.env.development" });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

var app = express();
const maxImageSize = 5e6;

app.use(express.static("public"));
app.listen(process.env.MEDIA_PORT, function () {
  loggerMain.info(
    `Started media server on port ${process.env.MEDIA_PORT} (${
      process.env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});

const uploadCar = multer({
  dest: __dirname + "/images/cars",
  limits: { fileSize: maxImageSize },
});
const uploadUser = multer({
  dest: __dirname + "/images/users",
  limits: { fileSize: maxImageSize },
});

app.post("/images/cars", uploadCar.single("file"), (req, res) => {
  var file = __dirname + "/public/images/cars/" + req.file.filename;
  fs.rename(req.file.path, file, (err) => {
    if (err) {
      loggerMain.error(err);
      res.status(500).send();
    } else {
      res.send(req.file.filename);
    }
  });
});

app.post("/images/users", uploadUser.single("file"), (req, res) => {
  var file = __dirname + "/public/images/users/" + req.file.filename;
  fs.rename(req.file.path, file, (err) => {
    if (err) {
      loggerMain.error(err);
      res.status(500).send();
    } else {
      res.send(req.file.filename);
    }
  });
});

app.delete("/images/users/:filename", (req, res) => {
  if (
    (req.socket.localAddress == "127.0.0.1" ||
      req.socket.localAddress == "::ffff:127.0.0.1" ||
      req.socket.localAddress == "::1") &&
    req.params.filename
  ) {
    fs.rm(
      __dirname + `/public/images/users/${req.params.filename}`,
      function (err) {
        if (err) {
          res.sendStatus(404);
          return loggerMain.warn(
            `Failed to delete file at /images/users/${req.params.filename}`
          );
        }
        loggerMain.info(`Deleted file at /images/users/${req.params.filename}`);
        res.sendStatus(204);
      }
    );
  }
});

app.delete("/images/cars/:filename", (req, res) => {
  if (
    (req.socket.localAddress == "127.0.0.1" ||
      req.socket.localAddress == "::ffff:127.0.0.1" ||
      req.socket.localAddress == "::1") &&
    req.params.filename
  ) {
    fs.rm(
      __dirname + `/public/images/cars/${req.params.filename}`,
      function (err) {
        if (err) {
          res.sendStatus(404);
          return loggerMain.warn(
            `Failed to delete file at /images/cars/${req.params.filename}`
          );
        }
        loggerMain.info(`Deleted file at /images/cars/${req.params.filename}`);
        res.sendStatus(204);
      }
    );
  }
});
