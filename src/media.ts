import express from "express";
import multer from "multer";
import fs from "fs/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loggerMedia } from "./logger.ts";
import { cleanEnv, num, str } from "envalid";

const env = cleanEnv(process.env, {
  MEDIA_PORT: str(),
  JWKS: str(),
  CRON_PING_URL: str(),
  CRON_INTERVAL_MS: num(),
  NODE_ENV: str({ choices: ["production", "development"] }),
});

const JWKS = createRemoteJWKSet(new URL(env.JWKS));

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

function upload(
  req: express.Request,
  res: express.Response,
  uploadHandler: express.RequestHandler
) {
  uploadHandler(req, res, (err) => {
    if (err || !req.file) {
      loggerMedia.error(err);
      res.status(500).send();
    } else {
      loggerMedia.info(
        `User ${res.locals.id} succesfully uploaded image ${req.file.filename}`
      );
      res.send(req.file.filename);
    }
  });
}

app.post("*", async (req, res, next) => {
  let token;
  try {
    token = (await jwtVerify(req.headers.authorization!, JWKS)).payload;
  } catch (error) {
    res.status(401).send();
    return;
  }
  const id = (token.email as string).split("@")[0];
  loggerMedia.info(`User ${id} issued POST request`);
  res.locals.id = id;
  next();
});

app.post("/images/cars", (req, res) => {
  upload(req, res, uploadCar.single("file"));
});

app.post("/images/users", (req, res) => {
  upload(req, res, uploadUser.single("file"));
});

async function handleDeleteRequest(
  req: express.Request,
  res: express.Response,
  target: "cars" | "users"
) {
  if (
    (req.socket.localAddress != "127.0.0.1" &&
      req.socket.localAddress != "::ffff:127.0.0.1" &&
      req.socket.localAddress != "::1") ||
    !req.params.filename
  )
    return;
  try {
    await fs.rm(`./public/images/${target}/${req.params.filename}`);
    loggerMedia.info(
      `Deleted file at public/images/${target}/${req.params.filename}`
    );
    res.sendStatus(204);
  } catch (err) {
    loggerMedia.warn(
      `Failed to delete file at public/images/${target}/${req.params.filename}.\n${err}`
    );
    res.sendStatus(404);
  }
}

app.delete("/images/users/:filename", (req, res) => {
  handleDeleteRequest(req, res, "users");
});

app.delete("/images/cars/:filename", async (req, res) => {
  handleDeleteRequest(req, res, "cars");
});

app.listen(env.MEDIA_PORT, () => {
  loggerMedia.info(
    `Started media server on port ${env.MEDIA_PORT} (${
      env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});

if (env.CRON_PING_URL && env.CRON_INTERVAL_MS) {
  const url = `${env.CRON_PING_URL}/ridehailing-media`;
  fetch(url);
  setInterval(
    () =>
      fetch(url).catch((error) =>
        loggerMedia.error("Failed to connect to heartbeat server." + error)
      ),
    env.CRON_INTERVAL_MS
  );
}
