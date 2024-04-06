import { Issuer, generators } from "openid-client";
import express from "express";
import bodyParser from "body-parser";
import { loggerMain } from "./log/logger.js";

var app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.listen(process.env.AUTH_PORT, () => {
  loggerMain.info(
    `Started auth server on port ${process.env.AUTH_PORT} (${
      process.env.NODE_ENV === "production" ? "production" : "development"
    })`
  );
});

const myIssuer = await Issuer.discover(process.env.ISSUER);

const client = new myIssuer.Client({
  client_id: process.env.CLIENT_ID,
  client_secret: process.env.CLIENT_SECRET,
  redirect_uris: ["https://ntua-ridehailing.dslab.ece.ntua.gr/auth/cb"],
  response_types: ["code"],
});

const code_verifier = generators.codeVerifier();
const code_challenge = generators.codeChallenge(code_verifier);
const redirect =
  client.authorizationUrl({
    scope: "openid profile email",
    claims: { id_token: { "name#el": null, email: null } },
    code_challenge: code_challenge,
    code_challenge_method: "S256",
  }) + "&kc_idp_hint=saml";

let tokens = {};

app.get("/", (req, res) => {
  res.redirect(redirect);
});

app.get("/cb", async (req, res) => {
  const params = client.callbackParams(req);
  const tokenSet = await client.callback(
    "https://ntua-ridehailing.dslab.ece.ntua.gr/auth/cb",
    params,
    { code_verifier }
  );
  tokens[params.code] = tokenSet;
  res.send("Exiting...");
});

export function getToken(code) {
  if (!tokens[code] || tokens[code].expired()) return;
  try {
    return tokens[code].claims();
  } finally {
    delete tokens[code];
  }
}
