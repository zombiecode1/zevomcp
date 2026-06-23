import { MCPServer } from "mcp-use/server";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { syncProviders, checkAllProviders } from "./providers/registry.js";
import { expireStaleSessions } from "./session/manager.js";
import { registerTools } from "./tools/index.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { logInit, logSystem } from "./logger/index.js";
import { authMiddleware, initAuth } from "./middleware/auth.js";
import { ensureEncryptionKey } from "./middleware/encryption.js";

const server = new MCPServer({
  name: "zombiecoder-mcp",
  title: "ZombieCoder MCP Server",
  version: "1.0.0",
  description:
    "ZombieCoder — local-first AI agent server by Sahon Srabon / Developer Zone / Dhaka, Bangladesh. " +
    "Multi-provider, OpenAI-compatible proxy, SQLite-backed sessions, SSE keepalive, live dashboard.",
  websiteUrl: "https://zombiecoder.my.id/",

  // host controls which interface the HTTP server binds to (and the URLs
  // mcp-use generates for widgets/OAuth). Read from .env so it actually
  // takes effect — passing it here, not just logging it, is what matters.
  host: config.serverHost,

  stateless: false,
  // MCP protocol session idle timeout. mcp-use defaults to 24h already;
  // set explicitly so the intent is visible in code.
  sessionIdleTimeoutMs: 24 * 60 * 60 * 1000,

  cors: {
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type", "Accept", "Authorization",
      "mcp-protocol-version", "mcp-session-id",
      "X-Agent-Identity", "X-Agent-Owner", "X-Agent-Version",
      "X-Provider-Id",
    ],
    exposeHeaders: ["mcp-session-id", "X-Provider-Id", "X-Provider-Name"],
  },
});

// NOTE: there is intentionally no custom middleware here reading the raw
// request body to inspect MCP client info. That approach (used in an earlier
// version of this server) consumes the request stream before the native MCP
// transport handler can read it, silently breaking every tool call made over
// HTTP POST. Client name/version is instead read inside tool callbacks via
// the documented `ctx.client.info()` API (see src/tools/index.ts), and the
// full live session list is available any time via `server.sessions`.

// 🔐 Auth middleware — protect proxy & metrics routes
server.app.use("/v1/*", authMiddleware(["proxy:read", "proxy:write"]));
server.app.use("/metrics", authMiddleware());

registerTools(server);
registerProxyRoutes(server);  // /v1/*               — OpenAI-compatible proxy (real Hono wildcard route)
registerStatusRoutes(server); // /status /metrics ... — dashboard + JSON status endpoints

async function main(): Promise<void> {
  getDb();
  logInit();

  // 🔐 Initialize auth system — reads X_API_KEY / X_API_KEY_{1..10} from env
  initAuth();

  // 🔑 Ensure encryption key exists for storing provider secrets
  const encKey = ensureEncryptionKey(config.dbPath.replace(/[^/]+$/, ".env"));
  if (encKey) console.log("✓ Encryption key ready");

  syncProviders();
  console.log(`✓ ${config.providers.length} providers synced`);

  checkAllProviders()
    .then(() => console.log("✓ Provider health checks done"))
    .catch((e: unknown) => console.warn("⚠ Health check error:", e));

  const expired = expireStaleSessions();
  if (expired > 0) console.log(`✓ Cleared ${expired} stale dashboard session(s)`);

  setInterval(() => {
    expireStaleSessions();
  }, 10 * 60 * 1000);

  const isStdio = process.env["MCP_STDIO_MODE"] === "true";

  if (!isStdio) {
    await server.listen(config.serverPort);
    const base = `http://${config.serverHost}:${config.serverPort}`;
    console.log(`\n╔══════════════════════════════════════════════════════════════╗\n║  ZombieCoder MCP  |  Sahon Srabon / Developer Zone           ║\n║  Dhaka, Bangladesh — https://zombiecoder.my.id/              ║\n╠══════════════════════════════════════════════════════════════╣\n║  MCP endpoint   →  ${base}/mcp\n║  MCP SSE        →  ${base}/sse\n║  OpenAI proxy   →  ${base}/v1\n║  Dashboard      →  ${base}/dashboard\n║  Status         →  ${base}/status\n║  Inspector      →  ${base}/inspector\n║  Active provider: ${config.activeProviderId}\n╚══════════════════════════════════════════════════════════════╝`);
  } else {
    logSystem("MCP_STDIO_MODE=true — running in stdio-only mode (no HTTP)");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
