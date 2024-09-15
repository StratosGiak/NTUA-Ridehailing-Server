import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import ejs from "ejs";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import { getUser, removeUser } from "./database.js";
import { loggerMain } from "./logger.js";
import { cleanEnv, num, str } from "envalid";
import { generators, Issuer } from "openid-client";
import Tokens from "csrf";

declare module "express-session" {
  export interface SessionData {
    codeVerifier: string;
    csrfSecret: string;
    idToken: string;
    user: { id: string; name: string };
  }
}

const env = cleanEnv(process.env, {
  WEB_HOST: str(),
  WEB_PORT: str(),
  ISSUER: str(),
  WEB_CLIENT_ID: str(),
  WEB_CLIENT_SECRET: str(),
  WEB_CLIENT_REDIRECT_URI: str(),
  WEB_CLIENT_LOGOUT_REDIRECT_URI: str(),
  SESSION_SECRET: str(),
  CRON_PING_URL: str(),
  CRON_INTERVAL_MS: num(),
  NODE_ENV: str({ choices: ["production", "development"] }),
});

let redisClient = createClient();
redisClient.connect().catch(loggerMain.error);
let redisStore = new RedisStore({ client: redisClient, prefix: "ridehailing" });

const CSRF = new Tokens();

const app = express();

app.set("trust proxy", "127.0.0.1");
app.use(
  session({
    store: redisStore,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: true, httpOnly: true, sameSite: "strict" },
  })
);
app.use(bodyParser.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.engine("html", ejs.renderFile);
app.set("views", "./views");

const myIssuer = await Issuer.discover(env.ISSUER);

const client = new myIssuer.Client({
  client_id: env.WEB_CLIENT_ID,
  client_secret: env.WEB_CLIENT_SECRET,
  redirect_uris: [env.WEB_CLIENT_REDIRECT_URI],
  response_types: ["code"],
});

app.get("/auth", (req, res) => {
  req.session.codeVerifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(req.session.codeVerifier);
  const authUrl =
    client.authorizationUrl({
      scope: "openid profile",
      claims: { id_token: { name: null, email: null } },
      code_challenge: code_challenge,
      code_challenge_method: "S256",
    }) + "&kc_idp_hint=saml";
  res.redirect(authUrl);
});

app.get("/auth/cb", async (req, res) => {
  const params = client.callbackParams(req);
  try {
    const tokenSet = await client.callback(
      env.WEB_CLIENT_REDIRECT_URI,
      params,
      {
        code_verifier: req.session.codeVerifier,
      }
    );
    if (!tokenSet.claims().email || !tokenSet.claims().name) {
      res.status(401).redirect("/");
      return;
    }
    req.session.idToken = tokenSet.id_token;
    req.session.user = {
      id: tokenSet.claims().email!.split("@")[0],
      name: tokenSet.claims().name!,
    };
    res.redirect("/profile");
  } catch (error) {
    res.redirect("/");
  }
});

app.get("/profile", async (req, res) => {
  if (!req.session.user) {
    res.redirect("/auth");
    return;
  }
  let user = await getUser(req.session.user.id);
  if (!user) {
    res.status(500).redirect("/");
    return;
  }
  user.full_name = req.session.user.name;

  const csrfSecret = await CSRF.secret();
  const csrfToken = CSRF.create(csrfSecret);
  req.session.csrfSecret = csrfSecret;

  res.render("profile", {
    id: user.id,
    name: user.full_name,
    cars: user.cars,
    ratings_count: user.ratings_count,
    ratings_sum: user.ratings_sum,
    picture: user.picture,
    csrfToken: csrfToken,
  });
});

app.post("/profile/logout", (req, res) => {
  const logoutUrl = client.endSessionUrl({
    post_logout_redirect_uri: env.WEB_CLIENT_LOGOUT_REDIRECT_URI,
    id_token_hint: req.session.idToken,
  });
  res.redirect(logoutUrl);
  req.session.destroy((err) => {
    if (err) loggerMain.error(err);
  });
});

app.post("/profile/delete", async (req, res) => {
  if (
    !req.session.csrfSecret ||
    !CSRF.verify(req.session.csrfSecret, req.body.csrf)
  ) {
    res.status(403).send();
    return;
  }
  if (!req.session.user) {
    res.status(401).send();
    return;
  }
  //await removeUser(req.session.user.id);
  res.redirect("/profile/logout");
});

app.listen(env.WEB_PORT, () => {
  loggerMain.info(
    `Started website server on port ${env.WEB_PORT} (${
      process.env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});
