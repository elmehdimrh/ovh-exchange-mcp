const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const config = require("./config");
const store = require("./store");
const { provider, handleLogin } = require("./auth");
const { createEwsClient } = require("./ews-client");
const { registerTools } = require("./tools");

const mcpUrl = new URL(`${config.publicUrl}/mcp`);

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.publicUrl),
    resourceServerUrl: mcpUrl,
    resourceName: "Exchange OVH",
  })
);

app.post(
  "/login",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false }),
  express.urlencoded({ extended: false, limit: "10kb" }),
  handleLogin
);

app.get("/health", (_req, res) => res.json({ ok: true }));

const bearerAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

// Sans session, pas de flux SSE (GET) ni de fermeture de session (DELETE).
app.get("/mcp", bearerAuth, (_req, res) => res.set("Allow", "POST").status(405).end());
app.delete("/mcp", bearerAuth, (_req, res) => res.set("Allow", "POST").status(405).end());

app.post(
  "/mcp",
  bearerAuth,
  express.json({ limit: "25mb" }),
  async (req, res) => {
    const email = req.auth.extra.email;
    const password = store.getUserPassword(email);
    if (!password) return res.status(401).json({ error: "invalid_token", error_description: "Utilisateur inconnu" });

    const ews = createEwsClient({ ewsUrl: config.ewsUrl, username: email, password, domain: config.domain });
    const server = new McpServer({ name: "ovh-exchange-mcp", version: "2.0.0" });
    registerTools(server, ews);

    // Mode sans état: un serveur et un transport par requête.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Erreur MCP:", err);
      if (!res.headersSent) res.status(500).json({ error: "Erreur interne" });
    }
  }
);

app.listen(config.port, () => {
  console.error(`ovh-exchange-mcp en écoute sur le port ${config.port} (${mcpUrl.href})`);
});
