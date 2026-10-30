const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "mcp.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    enc_password TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    email TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

function now() {
  return Math.floor(Date.now() / 1000);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// AES-256-GCM: iv(12) + tag(16) + ciphertext, encodé en base64.
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decrypt(encoded) {
  const raw = Buffer.from(encoded, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.encryptionKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// --- users ---
function saveUser(email, password) {
  const t = now();
  db.prepare(`
    INSERT INTO users (email, enc_password, created_at, last_login) VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET enc_password = excluded.enc_password, last_login = excluded.last_login
  `).run(email, encrypt(password), t, t);
}

function getUserPassword(email) {
  const row = db.prepare("SELECT enc_password FROM users WHERE email = ?").get(email);
  return row ? decrypt(row.enc_password) : null;
}

// --- clients OAuth (enregistrement dynamique) ---
function getClient(clientId) {
  const row = db.prepare("SELECT json FROM clients WHERE client_id = ?").get(clientId);
  return row ? JSON.parse(row.json) : undefined;
}

function saveClient(client) {
  db.prepare("INSERT OR REPLACE INTO clients (client_id, json) VALUES (?, ?)").run(client.client_id, JSON.stringify(client));
  return client;
}

// --- codes d'autorisation ---
function saveCode(code, { clientId, email, codeChallenge, redirectUri }, ttlSeconds) {
  db.prepare("INSERT INTO codes VALUES (?, ?, ?, ?, ?, ?)").run(hash(code), clientId, email, codeChallenge, redirectUri, now() + ttlSeconds);
}

function getCode(code) {
  const row = db.prepare("SELECT * FROM codes WHERE code_hash = ? AND expires_at > ?").get(hash(code), now());
  return row || null;
}

// Usage unique: retourne la ligne et la supprime.
function consumeCode(code) {
  const row = getCode(code);
  db.prepare("DELETE FROM codes WHERE code_hash = ?").run(hash(code));
  return row;
}

// --- tokens ---
function saveToken(token, kind, { clientId, email }, ttlSeconds) {
  db.prepare("INSERT INTO tokens VALUES (?, ?, ?, ?, ?)").run(hash(token), kind, clientId, email, now() + ttlSeconds);
}

function getToken(token, kind) {
  return db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?").get(hash(token), kind, now()) || null;
}

function deleteToken(token) {
  db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(hash(token));
}

function purgeExpired() {
  const t = now();
  db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(t);
  db.prepare("DELETE FROM tokens WHERE expires_at <= ?").run(t);
}

purgeExpired();
setInterval(purgeExpired, 60 * 60 * 1000).unref();

module.exports = {
  saveUser,
  getUserPassword,
  getClient,
  saveClient,
  saveCode,
  getCode,
  consumeCode,
  saveToken,
  getToken,
  deleteToken,
};
