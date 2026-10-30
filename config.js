require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante: ${name}`);
  return value;
}

const encryptionKey = Buffer.from(required("ENCRYPTION_KEY"), "base64");
if (encryptionKey.length !== 32) {
  throw new Error("ENCRYPTION_KEY doit faire 32 octets encodés en base64 (openssl rand -base64 32)");
}

const allowedDomains = required("ALLOWED_DOMAINS")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Seuls ces callbacks OAuth peuvent s'enregistrer, pour empêcher un tiers de récupérer les codes.
const allowedRedirectUris = (process.env.ALLOWED_REDIRECT_URIS || "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

module.exports = {
  publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),
  port: Number(process.env.PORT) || 3000,
  ewsUrl: required("EWS_URL"),
  domain: process.env.EWS_DOMAIN || "",
  allowedDomains,
  allowedRedirectUris,
  encryptionKey,
  dataDir: process.env.DATA_DIR || "./data",
};
