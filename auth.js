const crypto = require("node:crypto");
const { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } = require("@modelcontextprotocol/sdk/server/auth/errors.js");
const config = require("./config");
const store = require("./store");
const { createEwsClient } = require("./ews-client");

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const PENDING_TTL_MS = 10 * 60 * 1000;

// Demandes d'autorisation en attente de connexion, indexées par request_id.
const pending = new Map();

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&#39;",
    '"': "&quot;",
  }[c]));
}

function loginPage(res, { requestId, clientName, email = "", error = "" }) {
  res
    .status(error ? 400 : 200)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    })
    .send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connexion Exchange</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --fg: #1f1f1f; --muted: #666; --border: #ddd; --accent: #c4633f; --err: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1b1a; --card: #262625; --fg: #eee; --muted: #aaa; --border: #3a3a38; --err: #f2b8b5; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  form { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { margin: 0 0 20px; color: var(--muted); font-size: .9rem; }
  label { display: block; font-size: .875rem; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; }
  button { width: 100%; margin-top: 20px; padding: 12px; font-size: 1rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  .error { color: var(--err); margin: 12px 0 0; font-size: .9rem; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Connexion à votre boîte Exchange</h1>
  <p>${escapeHtml(clientName || "Claude")} demande l'accès à vos emails.</p>
  <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
  <label for="email">Adresse email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
  <label for="password">Mot de passe</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <button type="submit">Autoriser</button>
</form>
</body>
</html>`);
}

function issueTokens(clientId, email) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  store.saveToken(accessToken, "access", { clientId, email }, ACCESS_TTL);
  store.saveToken(refreshToken, "refresh", { clientId, email }, REFRESH_TTL);
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refreshToken,
  };
}

const provider = {
  clientsStore: {
    getClient: async (clientId) => store.getClient(clientId),
    registerClient: async (client) => {
      const rejected = client.redirect_uris.filter((uri) => !config.allowedRedirectUris.includes(String(uri)));
      if (rejected.length) throw new InvalidClientMetadataError(`redirect_uri non autorisée: ${rejected.join(", ")}`);
      return store.saveClient(client);
    },
  },

  async authorize(client, params, res) {
    const requestId = randomToken();
    pending.set(requestId, { clientId: client.client_id, clientName: client.client_name, params, expiresAt: Date.now() + PENDING_TTL_MS });
    loginPage(res, { requestId, clientName: client.client_name });
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const row = store.getCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Code d'autorisation invalide");
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
    const row = store.consumeCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Code d'autorisation invalide");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri ne correspond pas");
    return issueTokens(client.client_id, row.email);
  },

  async exchangeRefreshToken(client, refreshToken) {
    const row = store.getToken(refreshToken, "refresh");
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Refresh token invalide");
    store.deleteToken(refreshToken);
    return issueTokens(client.client_id, row.email);
  },

  async verifyAccessToken(token) {
    const row = store.getToken(token, "access");
    if (!row) throw new InvalidTokenError("Token invalide ou expiré");
    return { token, clientId: row.client_id, scopes: [], expiresAt: row.expires_at, extra: { email: row.email } };
  },

  async revokeToken(_client, { token }) {
    store.deleteToken(token);
  },
};

// POST /login: vérifie les identifiants auprès d'EWS puis redirige vers Claude avec un code.
async function handleLogin(req, res) {
  const { request_id: requestId, password } = req.body ?? {};
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const request = pending.get(requestId);
  if (!request || request.expiresAt < Date.now()) {
    pending.delete(requestId);
    return res.status(400).type("text/plain").send("Demande expirée. Relancez la connexion depuis Claude.");
  }

  const retry = (error) => loginPage(res, { requestId, clientName: request.clientName, email, error });

  const domain = email.split("@")[1];
  if (!domain || !config.allowedDomains.includes(domain)) {
    return retry("Cette adresse n'est pas autorisée sur ce serveur.");
  }
  if (!password) return retry("Mot de passe requis.");

  try {
    await createEwsClient({ ewsUrl: config.ewsUrl, username: email, password, domain: config.domain }).verifyCredentials();
  } catch (err) {
    return retry(err.message === "Identifiants invalides" ? "Email ou mot de passe incorrect." : "Impossible de joindre le serveur Exchange.");
  }

  pending.delete(requestId);
  store.saveUser(email, password);

  const { params, clientId } = request;
  const code = randomToken();
  store.saveCode(code, { clientId, email, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri }, CODE_TTL);

  const target = new URL(params.redirectUri);
  target.searchParams.set("code", code);
  if (params.state !== undefined) target.searchParams.set("state", params.state);
  res.redirect(302, target.href);
}

setInterval(() => {
  const t = Date.now();
  for (const [id, request] of pending) if (request.expiresAt < t) pending.delete(id);
}, 60 * 1000).unref();

module.exports = { provider, handleLogin };
