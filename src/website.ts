import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import ejs from "ejs";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import { getUser, removeUser } from "./database.ts";
import { loggerWebsite } from "./logger.ts";
import { cleanEnv, num, str } from "envalid";
import { generators, Issuer } from "openid-client";

declare module "express-session" {
  export interface SessionData {
    codeVerifier: string;
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
  WEB_REDIRECT_URI: str(),
  WEB_LOGOUT_REDIRECT_URI: str(),
  SESSION_SECRET: str(),
  CRON_PING_URL: str(),
  CRON_INTERVAL_MS: num(),
  NODE_ENV: str({ choices: ["production", "development"] }),
});

let redisClient = createClient();
redisClient.connect().catch(loggerWebsite.error);
let redisStore = new RedisStore({ client: redisClient, prefix: "ridehailing" });

const app = express();

app.set("trust proxy", "127.0.0.1");
app.use(
  session({
    store: redisStore,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, httpOnly: true, sameSite: "lax" },
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
  redirect_uris: [env.WEB_REDIRECT_URI],
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
    const tokenSet = await client.callback(env.WEB_REDIRECT_URI, params, {
      code_verifier: req.session.codeVerifier,
    });
    if (!tokenSet.claims().email || !tokenSet.claims().name) {
      res.status(401).send();
      return;
    }
    req.session.regenerate((err) => {
      if (err) loggerWebsite.warn(err);

      req.session.idToken = tokenSet.id_token;
      req.session.user = {
        id: tokenSet.claims().email!.split("@")[0],
        name: tokenSet.claims().name!,
      };

      req.session.save((err) => {
        if (err) loggerWebsite.warn(err);
        res.redirect("/profile");
      });
    });
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
    res.status(500).send();
    return;
  }
  user.full_name = req.session.user.name;

  res.render("profile", {
    id: user.id,
    name: user.full_name,
    cars: user.cars,
    ratings_count: user.ratings_count,
    ratings_sum: user.ratings_sum,
    picture: user.picture,
  });
});

app.post("/profile/logout", (req, res) => {
  const logoutUrl = client.endSessionUrl({
    post_logout_redirect_uri: env.WEB_LOGOUT_REDIRECT_URI,
    id_token_hint: req.session.idToken,
  });
  req.session.destroy((err) => {
    if (err) loggerWebsite.error(err);
    res.redirect(logoutUrl);
  });
});

app.post("/profile/delete", async (req, res) => {
  if (!req.session.user) {
    res.status(401).send();
    return;
  }
  //await removeUser(req.session.user.id);
  loggerWebsite.info(`Deleted user ${req.session.user.id}`);
  const logoutUrl = client.endSessionUrl({
    post_logout_redirect_uri: env.WEB_LOGOUT_REDIRECT_URI,
    id_token_hint: req.session.idToken,
  });
  req.session.destroy((err) => {
    if (err) loggerWebsite.error(err);
    res.redirect(logoutUrl);
  });
});

app.listen(env.WEB_PORT, () => {
  loggerWebsite.info(
    `Started website server on port ${env.WEB_PORT} (${
      process.env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});
