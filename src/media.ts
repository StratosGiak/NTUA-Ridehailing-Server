import express from "express";
import multer from "multer";
import fs from "fs/promises";
import { loggerMedia } from "./logger.js";
import { cleanEnv, num, str } from "envalid";

const env = cleanEnv(process.env, {
  MEDIA_PORT: str(),
  CRON_PING_URL: str(),
  CRON_INTERVAL_MS: num(),
  NODE_ENV: str({ choices: ["production", "development"] }),
});

var app = express();
app.use(express.static("public"));

const uploadCar = multer({
  dest: "./public/images/cars",
  fileFilter: (req, file, callback) => {
    if (file.mimetype == "image/jpeg" || file.mimetype == "image/png") {
      return callback(null, true);
    }
    return callback(new Error(`File type is not image: ${file.mimetype}`));
  },
});
const uploadUser = multer({
  dest: "./public/images/users",
  fileFilter: (req, file, callback) => {
    if (file.mimetype == "image/jpeg" || file.mimetype == "image/png") {
      return callback(null, true);
    }
    return callback(new Error(`File type is not image: ${file.mimetype}`));
  },
});

app.post("/images/cars", (req, res) => {
  uploadCar.single("file")(req, res, (err) => {
    if (err || !req.file) {
      loggerMedia.error(err);
      res.status(500).send();
    } else {
      res.send(req.file.filename);
    }
  });
});

app.post("/images/users", (req, res) => {
  uploadUser.single("file")(req, res, (err) => {
    if (err || !req.file) {
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

app.listen(env.MEDIA_PORT, () => {
  loggerMedia.info(
    `Started media server on port ${env.MEDIA_PORT} (${
      env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});

if (env.CRON_PING_URL && env.CRON_INTERVAL_MS) {
  fetch(`${env.CRON_PING_URL}/ridehailing-media`);
  setInterval(
    () => fetch(`${env.CRON_PING_URL}/ridehailing-media`),
    env.CRON_INTERVAL_MS
  );
}
