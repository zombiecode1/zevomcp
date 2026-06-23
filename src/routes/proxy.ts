import { MCPServer } from "mcp-use/server";
import { getActiveProvider, getProvider } from "../config.js";
import { buildAgentHeaders } from "../agent/identity.js";
import { recordMetric } from "../db/index.js";

/**
 * IMPORTANT — two framework facts this file works around, both verified by
 * directly inspecting the installed mcp-use package before writing this code
 * (not assumed):
 *
 * 1. mcp-use's `server.get/post/all(...)` proxy methods store handlers in an
 *    internal Map keyed by the EXACT literal path string (e.g. "all:/v1/*"),
 *    and dispatch does an exact-string lookup against the incoming request's
 *    literal path. A pattern like "/v1/*" therefore NEVER matches a real
 *    request path such as "/v1/chat/completions" through that proxy.
 *    `server.app` is the underlying real Hono instance, which DOES support
 *    genuine wildcard route matching — so all routes here are registered on
 *    `server.app`, not on `server` directly.
 *
 * 2. mcp-use installs a global request-logging middleware
 *    (`app.use("*", requestLogger)`) that, for every non-exempt response,
 *    calls `await res.clone().text()` to inspect it for error reporting —
 *    UNCONDITIONALLY, even when the response body is an indefinite stream.
 *    This was confirmed by directly testing a custom streaming route through
 *    a real mcp-use server instance: chunks written 400ms apart server-side
 *    all arrived at the client in a ~4ms cluster, only after the stream
 *    fully closed. The same behavior was independently confirmed to affect
 *    mcp-use's OWN native `ctx.log()` progress notifications during a slow
 *    tool call (POST /mcp is not in the logger's GET-only exemption list).
 *    There is a documented escape hatch (`RESPONSE_ALREADY_SENT` from
 *    `@hono/node-server`, writing directly to `c.env.outgoing`), but mcp-use
 *    bundles its OWN nested copy of `@hono/node-server` — importing the
 *    sentinel from a separately-installed top-level copy is a DIFFERENT
 *    object than what mcp-use's internal adapter checks for, and passing it
 *    through actually crashes with a RangeError (confirmed by testing).
 *    Reaching into mcp-use's nested node_modules path to get the "real" one
 *    would depend on undocumented internal layout and is not something to
 *    ship in production code.
 *
 *    Practical consequence: a request that returns a genuinely open-ended
 *    stream through `server.app` will not deliver bytes to the real client
 *    until the stream closes, no matter how the handler is written. For
 *    responses that DO eventually complete (e.g. a finished chat completion,
 *    even one requested with stream:true), this just means the full
 *    response arrives in one piece slightly later than the last upstream
 *    byte, instead of token-by-token. That is the trade-off accepted below:
 *    upstream SSE responses are read to completion and relayed as one
 *    complete text/event-stream body, preserving correct content end to end,
 *    rather than attempting a real-time passthrough that mcp-use's current
 *    version cannot actually deliver on this route. Non-streaming requests
 *    (the common case) are entirely unaffected by any of this — they were
 *    never long-lived responses to begin with.
 */
export function registerProxyRoutes(server: MCPServer): void {
  const app = server.app;

  function corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Accept, X-Provider-Id, " +
        "X-Agent-Identity, X-Agent-Owner, X-Agent-Version",
      "Access-Control-Expose-Headers": "X-Provider-Id, X-Provider-Name",
    };
  }

  app.options("/v1/*", () => new Response(null, { status: 204, headers: corsHeaders() }));

  app.all("/v1/*", async (c) => {
    const overrideId = c.req.header("x-provider-id");
    let provider;
    try {
      provider = overrideId ? (getProvider(overrideId) ?? getActiveProvider()) : getActiveProvider();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message: msg, type: "config_error" } }, 500);
    }

    const reqUrl  = new URL(c.req.url);
    const subPath = reqUrl.pathname.replace(/^\/v1/, "");
    const target  = new URL(`${provider.baseUrl}${subPath}`);
    reqUrl.searchParams.forEach((v, k) => target.searchParams.set(k, v));

    const upstreamHeaders: Record<string, string> = {
      "Content-Type":  c.req.header("content-type") ?? "application/json",
      Accept:          c.req.header("accept") ?? "application/json",
      Authorization:   `Bearer ${provider.apiKey}`,
      ...buildAgentHeaders(),
    };

    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    const t0 = Date.now();
    let upRes: Response;

    try {
      upRes = await fetch(target.toString(), {
        method:  c.req.method,
        headers: upstreamHeaders,
        body:    hasBody ? c.req.raw.body : undefined,
        duplex:  hasBody ? "half" : undefined,
        signal:  AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordMetric("proxy_error", 1, { provider: provider.id, path: subPath });
      return c.json({ error: { message: `Upstream error: ${msg}`, type: "proxy_error" } }, 502);
    }

    recordMetric("proxy_latency_ms", Date.now() - t0, { provider: provider.id, status: String(upRes.status) });

    const headers = new Headers(upRes.headers);
    for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
    headers.set("X-Provider-Id", provider.id);
    headers.set("X-Provider-Name", provider.name);

    // See the file-level comment: read SSE responses to completion and relay
    // as one complete body. Non-SSE responses pass through immediately —
    // they were never long-lived, so none of the above applies to them.
    const isSse = (upRes.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isSse) {
      return new Response(upRes.body, { status: upRes.status, headers });
    }

    const fullText = await upRes.text();
    headers.set("Content-Length", String(Buffer.byteLength(fullText, "utf-8")));
    return new Response(fullText, { status: upRes.status, headers });
  });
}

