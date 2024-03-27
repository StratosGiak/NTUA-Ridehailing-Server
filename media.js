import express from "express";
import multer from "multer";
import fs from "fs/promises";
import { loggerMedia } from "./log/logger.js";
import dotenv from "dotenv";

if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: "./.env.production" });
} else {
  dotenv.config({ path: "./.env.development" });
}

var app = express();
app.use(express.static("public"));
app.listen(process.env.MEDIA_PORT, () => {
  loggerMedia.info(
    `Started media server on port ${process.env.MEDIA_PORT} (${
      process.env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});

if (process.env.CRON_PING_KEY && process.env.CRON_INTERVAL_MS) {
  fetch(`https://hc-ping.com/${process.env.CRON_PING_KEY}/ridehailing-media`);
  setInterval(
    () =>
      fetch(
        `https://hc-ping.com/${process.env.CRON_PING_KEY}/ridehailing-media`
      ),
    process.env.CRON_INTERVAL_MS
  );
}

const maxImageSize = process.env.MAX_IMAGE_SIZE;

const uploadCar = multer({
  dest: "./public/images/cars",
  fileFilter: (req, file, callback) => {
    if (file.mimetype == "image/jpeg" || file.mimetype == "image/png") {
      return callback(null, true);
    }
    return callback(
      new Error(`File type is not image: ${file.mimetype}`),
      false
    );
  },
});
const uploadUser = multer({
  dest: "./public/images/users",
  fileFilter: (req, file, callback) => {
    if (file.mimetype == "image/jpeg" || file.mimetype == "image/png") {
      return callback(null, true);
    }
    return callback(
      new Error(`File type is not image: ${file.mimetype}`),
      false
    );
  },
});

app.post("/images/cars", (req, res) => {
  uploadCar.single("file")(req, res, (err) => {
    if (err) {
      loggerMedia.error(err);
      res.status(500).send();
    } else {
      res.send(req.file.filename);
    }
  });
});

app.post("/images/users", (req, res) => {
  uploadUser.single("file")(req, res, (err) => {
    if (err) {
      loggerMedia.error(err);
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
    fs.rm(`./public/images/users/${req.params.filename}`)
      .then(() => {
        loggerMedia.info(
          `Deleted file at /images/users/${req.params.filename}`
        );
        res.sendStatus(204);
      })
      .catch((err) => {
        loggerMedia.warn(
          `Failed to delete file at /images/users/${req.params.filename}.\n${err}`
        );
        res.sendStatus(404);
      });
  }
});

app.delete("/images/cars/:filename", (req, res) => {
  if (
    (req.socket.localAddress == "127.0.0.1" ||
      req.socket.localAddress == "::ffff:127.0.0.1" ||
      req.socket.localAddress == "::1") &&
    req.params.filename
  ) {
    fs.rm(`./public/images/cars/${req.params.filename}`)
      .then((_) => {
        loggerMedia.info(`Deleted file at /images/cars/${req.params.filename}`);
        res.sendStatus(204);
      })
      .catch((err) => {
        loggerMedia.warn(
          `Failed to delete file at /images/cars/${req.params.filename}.\n${err}`
        );
        res.sendStatus(404);
      });
  }
});
