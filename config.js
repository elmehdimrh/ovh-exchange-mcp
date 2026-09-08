require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante: ${name}`);
  return value;
}

module.exports = {
  ewsUrl: required("EWS_URL"),
  username: required("EWS_USERNAME"),
  password: required("EWS_PASSWORD"),
  domain: process.env.EWS_DOMAIN || "",
};
