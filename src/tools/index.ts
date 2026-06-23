import { MCPServer, text, error } from "mcp-use/server";
import { z } from "zod";
import { config } from "../config.js";
import { IDENTITY } from "../agent/identity.js";
import { runAgent, getRecentRuns } from "../agent/runner.js";
import { getAllProviderStatuses, checkAllProviders } from "../providers/registry.js";
import { createSession, verifySession, listActiveSessions } from "../session/manager.js";
import { getDb } from "../db/index.js";
import { logToolCall, logSystem } from "../logger/index.js";

const McpServerDefSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

// Records (or refreshes) a row in mcp_clients using the OFFICIALLY DOCUMENTED
// ctx.client.info() + ctx.session.sessionId APIs. This intentionally avoids
// reading raw request bodies in HTTP middleware — doing so would consume the
// request stream before the MCP transport handler can read it, silently
// breaking every tool call. See README "Why no middleware" section.
function recordMcpClient(sessionId: string, clientName: string, clientVersion: string | undefined): void {
  const db = getDb();
  const existing = db.prepare(`SELECT session_id FROM mcp_clients WHERE session_id = ?`).get(sessionId);
  if (existing) {
    db.prepare(`UPDATE mcp_clients SET last_seen = unixepoch(), status = 'connected' WHERE session_id = ?`)
      .run(sessionId);
  } else {
    db.prepare(`
      INSERT INTO mcp_clients (session_id, client_name, client_version) VALUES (?, ?, ?)
    `).run(sessionId, clientName, clientVersion ?? null);
  }
}

/** Wraps a tool handler with automatic duration tracking + file logging. */
function withLogging<T>(
  toolName: string,
  fn: (params: T, ctx: any) => Promise<ReturnType<typeof text | typeof error>>,
) {
  return async (params: T, ctx: any): Promise<ReturnType<typeof text | typeof error>> => {
    const t0 = Date.now();
    const sessionId = ctx?.session?.sessionId ?? "unknown";
    try {
      const result = await fn(params, ctx);
      const durationMs = Date.now() - t0;
      const isError = typeof result === "object" && result !== null && "isError" in result;
      logToolCall({
        sessionId,
        toolName,
        args: params as Record<string, unknown>,
        success: !isError,
        resultPreview: String(result).slice(0, 200),
        durationMs,
        error: isError ? String(result) : undefined,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      logToolCall({
        sessionId,
        toolName,
        args: params as Record<string, unknown>,
        success: false,
        resultPreview: "",
        durationMs,
        error: msg,
      });
      throw err;
    }
  };
}

export function registerTools(server: MCPServer): void {

  // ── ping_agent ──────────────────────────────────────────────────────────
  server.tool(
    {
      name: "ping_agent",
      description: "Health check. Returns active provider, model, and server config. No network call.",
      schema: z.object({}),
    },
    withLogging("ping_agent", async (_params, ctx) => {
      const clientInfo = ctx.client.info();
      const sid = ctx?.session?.sessionId ?? "unknown";
      recordMcpClient(sid, clientInfo.name ?? "unknown", clientInfo.version);

      await ctx.log("info", "ping_agent");
      const p = config.providers.find((x) => x.id === config.activeProviderId);
      return text([
        `identity        : ${IDENTITY.system_identity.name} v${IDENTITY.system_identity.version}`,
        `owner           : ${IDENTITY.system_identity.branding.owner}`,
        `active_provider : ${p?.name ?? "not configured"} → ${p?.baseUrl ?? "-"}`,
        `model           : ${config.agentModel}`,
        `max_steps       : ${config.agentMaxSteps}`,
        `temperature     : ${config.agentTemperature}`,
        `providers       : ${config.providers.length} configured`,
        `mcp_session     : ${ctx?.session?.sessionId ?? "unknown"}`,
        `client          : ${clientInfo.name ?? "unknown"} ${clientInfo.version ?? ""}`,
      ].join("\n"));
    })
  );

  // ── create_session (24h browser/dashboard session) ───────────────────────
  server.tool(
    {
      name: "create_session",
      description: "Create a new 24-hour application session for dashboard/browser use. Returns session_id.",
      schema: z.object({
        provider_id: z.string().optional(),
        directory:   z.string().optional(),
        client_info: z.record(z.string(), z.string()).optional(),
      }),
    },
    withLogging("create_session", async ({ provider_id, directory, client_info }, ctx) => {
      await ctx.log("info", "create_session");
      const s = createSession({
        providerId: provider_id ?? config.activeProviderId,
        directory,
        clientInfo: client_info ?? {},
      });
      return text([
        `session_id : ${s.id}`,
        `expires_at : ${new Date(s.expiresAt * 1000).toISOString()}`,
        `provider   : ${s.providerId}`,
        `ttl_hours  : 24`,
      ].join("\n"));
    })
  );

  // ── verify_session ────────────────────────────────────────────────────────
  server.tool(
    {
      name: "verify_session",
      description: "Verify an application session is valid and not expired.",
      schema: z.object({ session_id: z.string() }),
    },
    withLogging("verify_session", async ({ session_id }, ctx) => {
      await ctx.log("info", `verify_session: ${session_id}`);
      const r = verifySession(session_id);
      if (!r.valid) return error(`Session invalid: ${r.reason}`);
      const s = r.session!;
      return text([
        `valid          : true`,
        `id             : ${s.id}`,
        `provider       : ${s.providerId ?? "default"}`,
        `directory      : ${s.directory ?? "not set"}`,
        `expires_in_h   : ${Math.round((s.expiresAt - Date.now() / 1000) / 3600)}`,
        `last_heartbeat : ${new Date(s.lastHeartbeat * 1000).toISOString()}`,
      ].join("\n"));
    })
  );

  // ── run_agent ──────────────────────────────────────────────────────────────
  server.tool(
    {
      name: "run_agent",
      description:
        "Execute the ZombieCoder AI agent against a prompt. Streams step-by-step progress " +
        "as MCP log messages. Persists full audit trail to SQLite.",
      schema: z.object({
        prompt:        z.string(),
        provider_id:   z.string().optional(),
        model:         z.string().optional(),
        temperature:   z.number().min(0).max(2).optional(),
        max_steps:     z.number().int().positive().optional(),
        streaming:     z.boolean().optional(),
        session_id:    z.string().optional(),
        system_prompt: z.string().optional(),
        servers:       z.record(z.string(), McpServerDefSchema).optional(),
      }),
    },
    withLogging("run_agent", async (
      { prompt, provider_id, model, temperature, max_steps, streaming, session_id, system_prompt, servers },
      ctx
    ) => {
      const clientInfo = ctx.client.info();
      const sid = ctx?.session?.sessionId ?? "unknown";
      recordMcpClient(sid, clientInfo.name ?? "unknown", clientInfo.version);

      await ctx.log("info", `run_agent: provider=${provider_id ?? config.activeProviderId}`);

      let result;
      try {
        result = await runAgent({
          prompt,
          providerId: provider_id,
          model,
          temperature,
          maxSteps: max_steps,
          streaming: streaming ?? true,
          servers,
          appSessionId: session_id,
          mcpSessionId: ctx.session.sessionId,
          systemPromptOverride: system_prompt,
          onStep: async (tool, input) => {
            await ctx.log("info", `tool_call → ${tool}: ${JSON.stringify(input)}`);
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.log("error", `run_agent setup failed: ${msg}`);
        return error(`Agent failed before execution: ${msg}`);
      }

      if (!result.success) {
        await ctx.log("error", `run_agent failed: ${result.error}`);
        return error(`Agent failed: ${result.error}`);
      }

      await ctx.log("info", `run_agent done — ${result.steps} steps, ${result.durationMs}ms`);
      return text(
        `${result.output}\n\n---\n` +
        `run_id: ${result.runId} | provider: ${result.providerId} | ` +
        `model: ${result.model} | steps: ${result.steps} | ${result.durationMs}ms`
      );
    })
  );

  // ── list_providers ───────────────────────────────────────────────────────
  server.tool(
    {
      name: "list_providers",
      description: "All configured OpenAI-compatible providers with health status and model list.",
      schema: z.object({
        refresh: z
          .union([z.boolean(), z.enum(["true", "false"])])
          .optional(),
      }),
    },
    withLogging("list_providers", async ({ refresh }, ctx) => {
      const shouldRefresh = refresh === true || refresh === "true";
      if (shouldRefresh) {
        await ctx.log("info", "Refreshing provider statuses...");
        await checkAllProviders();
      }
      const providers = getAllProviderStatuses();
      return text(
        `Providers (${providers.length}):\n\n` +
        providers.map((p) =>
          `[${p.status === "online" ? "✓" : p.status === "offline" ? "✗" : "?"}] ` +
          `${p.name} (${p.id})\n  url: ${p.baseUrl}\n  models: ${p.models.slice(0, 5).join(", ") || "none"}`
        ).join("\n\n")
      );
    })
  );

  // ── list_clients ──────────────────────────────────────────────────────────
  server.tool(
    {
      name: "list_clients",
      description: "Active MCP clients (from this server's live session map), app sessions, and recent runs.",
      schema: z.object({}),
    },
    withLogging("list_clients", async (_params, ctx) => {
      await ctx.log("info", "list_clients");

      // Live, in-memory MCP transport sessions — the source of truth.
      const liveSessions = Array.from(server.sessions.entries()).map(([sid, data]) => ({
        sessionId: sid,
        clientName: data.clientInfo?.name ?? "unknown",
        clientVersion: data.clientInfo?.version ?? "",
        protocolVersion: data.protocolVersion ?? "",
        lastAccessedAt: data.lastAccessedAt,
      }));

      const appSessions = listActiveSessions();
      const runs = getRecentRuns(5);

      return text([
        `── Live MCP Sessions (${liveSessions.length}) ─────────────────────`,
        ...liveSessions.map((s) =>
          `  ${s.sessionId.slice(0, 8)}… | ${s.clientName} ${s.clientVersion} | ` +
          `protocol ${s.protocolVersion} | last seen ${new Date(s.lastAccessedAt).toISOString()}`
        ),
        "",
        `── App Sessions (${appSessions.length} active, 24h TTL) ─────────`,
        ...appSessions.map((s) =>
          `  ${s.id.slice(0, 8)}… | ${s.providerId ?? "default"} | ` +
          `${Math.round((s.expiresAt - Date.now() / 1000) / 3600)}h left | ${s.directory ?? "?"}`
        ),
        "",
        `── Recent Runs ────────────────────────────────────────────────`,
        ...runs.map((r) =>
          `  [${r.status}] ${String(r.id).slice(0, 8)}… | ${r.provider_id} | ${r.model} | ${r.prompt_preview}…`
        ),
      ].join("\n"));
    })
  );

  // ── get_run_details ───────────────────────────────────────────────────────
  server.tool(
    {
      name: "get_run_details",
      description: "Full details of a specific agent run by run_id.",
      schema: z.object({ run_id: z.string() }),
    },
    withLogging("get_run_details", async ({ run_id }, ctx) => {
      await ctx.log("info", `get_run_details: ${run_id}`);
      const run = getDb().prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(run_id);
      if (!run) return error(`No run found: ${run_id}`);
      return text(JSON.stringify(run, null, 2));
    })
  );

  logSystem(`Registered 7 tools with response logging`);
}
