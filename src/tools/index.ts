import { MCPServer, text, error } from "mcp-use/server";
import { z } from "zod";
import { config } from "../config.js";
import { IDENTITY } from "../agent/identity.js";
import { runAgent, getRecentRuns } from "../agent/runner.js";
import { getAllProviderStatuses, checkAllProviders } from "../providers/registry.js";
import { createSession, verifySession, listActiveSessions } from "../session/manager.js";
import {
  createClientSession,
  findClientSessionByClientId,
  heartbeatClientSession,
  createConversation,
  listClientSessions,
  listConversations,
} from "../session/client-session.js";
import { getDb } from "../db/index.js";
import { logToolCall, logSystem } from "../logger/index.js";

const McpServerDefSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

// ── Client type detection ─────────────────────────────────────────────────────

function detectClientType(name: string): string {
  const n = name.toLowerCase();
  if (/vscode|code/i.test(n)) return "vs-code";
  if (/intellij|idea|jetbrains/i.test(n)) return "intellij";
  if (/hermes/i.test(n)) return "hermes";
  if (/opencode/i.test(n)) return "opencode";
  if (/cursor/i.test(n)) return "cursor";
  if (/windsurf/i.test(n)) return "windsurf";
  return "unknown";
}

// ── Client Session Integration ────────────────────────────────────────────────

/**
 * resolveOrCreateClientSession — core function that handles the client
 * verification lifecycle.
 *
 * On first connect (no client_id):
 *   → Creates a pending client_session with verification_code
 *   → Returns { session, needsVerification: true, verifyUrl }
 *
 * On reconnect (with client_id):
 *   → Finds existing session
 *   → If verified: heartbeats it, returns { session, needsVerification: false }
 *   → If still pending: returns verifyUrl again
 */
function resolveOrCreateClientSession(opts: {
  clientName: string;
  clientVersion: string | undefined;
  clientId?: string;
  ip?: string;
  directory?: string;
}): {
  session: ReturnType<typeof createClientSession>;
  needsVerification: boolean;
  verifyUrl: string;
} {
  const port = config.serverPort;
  const host = config.serverHost;

  // If client_id provided, try to find existing session
  if (opts.clientId) {
    const existing = findClientSessionByClientId(opts.clientId);
    if (existing) {
      heartbeatClientSession(existing.id);
      if (existing.status === "verified") {
        return {
          session: existing as any,
          needsVerification: false,
          verifyUrl: "",
        };
      }
      // Still pending — return verify URL
      return {
        session: existing as any,
        needsVerification: true,
        verifyUrl: `http://${host}:${port}/verify/${existing.verificationCode}`,
      };
    }
  }

  // New client — create pending session
  const session = createClientSession({
    clientName: opts.clientName,
    clientVersion: opts.clientVersion,
    clientType: detectClientType(opts.clientName),
    ip: opts.ip,
    directory: opts.directory,
  });

  return {
    session: session as any,
    needsVerification: true,
    verifyUrl: `http://${host}:${port}/verify/${session.verificationCode}`,
  };
}

// Also update legacy mcp_clients table for backward compat
function recordMcpClientFallback(
  sessionId: string,
  clientName: string,
  clientVersion: string | undefined,
): void {
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

// ── Logging Wrapper ───────────────────────────────────────────────────────────

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

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerTools(server: MCPServer): void {

  // ── ping_agent ──────────────────────────────────────────────────────────
  server.tool(
    {
      name: "ping_agent",
      description:
        "Health check. Optionally send client_id to restore a previous session. " +
        "Returns server identity, active provider, and verification status.",
      schema: z.object({
        client_id: z.string().optional().describe(
          "Persistent client ID from a previous session (store in localStorage). " +
          "Omit on first connect — a new pending session + verification URL is returned."
        ),
      }),
    },
    withLogging("ping_agent", async ({ client_id }, ctx) => {
      const clientInfo = ctx.client.info();
      const clientName = clientInfo.name ?? "unknown";
      const clientVersion = clientInfo.version;
      const sid = ctx?.session?.sessionId ?? "unknown";

      // Legacy fallback
      recordMcpClientFallback(sid, clientName, clientVersion);

      // New client session resolution
      const cs = resolveOrCreateClientSession({
        clientName,
        clientVersion,
        clientId: client_id,
      });

      await ctx.log("info", `ping_agent — client=${clientName}, status=${cs.session.status}`);

      const p = config.providers.find((x) => x.id === config.activeProviderId);
      const lines = [
        `identity        : ${IDENTITY.system_identity.name} v${IDENTITY.system_identity.version}`,
        `owner           : ${IDENTITY.system_identity.branding.owner}`,
        `active_provider : ${p?.name ?? "not configured"} → ${p?.baseUrl ?? "-"}`,
        `model           : ${config.agentModel}`,
        `max_steps       : ${config.agentMaxSteps}`,
        `temperature     : ${config.agentTemperature}`,
        `providers       : ${config.providers.length} configured`,
        `client          : ${clientName} ${clientVersion ?? ""}`,
        ``,
        `── Client Session ─────────────────────────`,
        `client_id       : ${cs.session.clientId}`,
        `status          : ${cs.session.status}`,
      ];

      if (cs.needsVerification) {
        lines.push(
          `verify_url      : ${cs.verifyUrl}`,
          `verification    : PENDING — open the verify_url in your browser to approve this client.`,
          `                  (Editors: this will auto-open in your default browser)`,
        );
      } else {
        lines.push(`conversations   : ${cs.session.conversationCount}`);
      }

      return text(lines.join("\n"));
    })
  );

  // ── create_session (24h browser/dashboard session) ───────────────────────
  server.tool(
    {
      name: "create_session",
      description:
        "Create a new 24-hour application session for dashboard/browser use. " +
        "Returns session_id that can be stored in localStorage for reconnection.",
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
        "as MCP log messages. Persists full audit trail to SQLite. " +
        "Accepts an optional client_id for verified session tracking.",
      schema: z.object({
        prompt:        z.string(),
        provider_id:   z.string().optional(),
        model:         z.string().optional(),
        temperature:   z.number().min(0).max(2).optional(),
        max_steps:     z.number().int().positive().optional(),
        streaming:     z.boolean().optional(),
        session_id:    z.string().optional(),
        client_id:     z.string().optional().describe(
          "Persistent client ID for session tracking. " +
          "First-time clients receive this from ping_agent."
        ),
        conversation_id: z.string().optional().describe(
          "Continue an existing conversation (omit to auto-create a new one)."
        ),
        system_prompt: z.string().optional(),
        servers:       z.record(z.string(), McpServerDefSchema).optional(),
      }),
    },
    withLogging("run_agent", async (
      { prompt, provider_id, model, temperature, max_steps, streaming,
        session_id, client_id, conversation_id, system_prompt, servers },
      ctx
    ) => {
      const clientInfo = ctx.client.info();
      const clientName = clientInfo.name ?? "unknown";
      const clientVersion = clientInfo.version;
      const sid = ctx?.session?.sessionId ?? "unknown";

      // Legacy fallback
      recordMcpClientFallback(sid, clientName, clientVersion);

      // Resolve client session (or create pending)
      const cs = resolveOrCreateClientSession({
        clientName,
        clientVersion,
        clientId: client_id,
      });

      // If session is still pending, reject the run
      if (cs.needsVerification) {
        await ctx.log("warn", `run_agent blocked — client ${cs.session.clientName} pending verification`);
        return error(
          `Client "${cs.session.clientName}" is not yet verified.\n` +
          `Open this URL in your browser to approve: ${cs.verifyUrl}\n` +
          `After approval, re-send this request with client_id="${cs.session.clientId}"`
        );
      }

      await ctx.log("info", `run_agent: client=${clientName}, provider=${provider_id ?? config.activeProviderId}`);

      // Auto-create or reuse conversation
      let convId = conversation_id;
      if (!convId) {
        const conv = createConversation(cs.session.id, `run: ${prompt.slice(0, 60)}`);
        convId = conv.id;
      }

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
          conversationId: convId,
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
        `run_id: ${result.runId} | conversation: ${convId} | ` +
        `provider: ${result.providerId} | model: ${result.model} | ` +
        `steps: ${result.steps} | ${result.durationMs}ms`
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
      description:
        "Active MCP clients, verified client sessions, conversations, and recent runs.",
      schema: z.object({}),
    },
    withLogging("list_clients", async (_params, ctx) => {
      await ctx.log("info", "list_clients");

      // Live, in-memory MCP transport sessions
      const liveSessions = Array.from(server.sessions.entries()).map(([sid, data]) => ({
        sessionId: sid,
        clientName: data.clientInfo?.name ?? "unknown",
        clientVersion: data.clientInfo?.version ?? "",
        protocolVersion: data.protocolVersion ?? "",
        lastAccessedAt: data.lastAccessedAt,
      }));

      const appSessions = listActiveSessions();
      const clientSessions = listClientSessions();
      const allConversations = listConversations();
      const runs = getRecentRuns(5);

      return text([
        `── Live MCP Sessions (${liveSessions.length}) ─────────────────────`,
        ...liveSessions.map((s) =>
          `  ${s.sessionId.slice(0, 8)}… | ${s.clientName} ${s.clientVersion} | ` +
          `protocol ${s.protocolVersion} | last seen ${new Date(s.lastAccessedAt).toISOString()}`
        ),
        "",
        `── Client Sessions (${clientSessions.length}) ─────────────────────`,
        ...clientSessions.map((s) => {
          const icon = s.status === "verified" ? "✓" : s.status === "pending" ? "⏳" : "✗";
          return `  [${icon}] ${s.clientName} ${s.clientVersion ?? ""}` +
            ` | status: ${s.status}` +
            ` | id: ${s.clientId.slice(0, 8)}…` +
            (s.status === "pending" ? ` | code: ${s.verificationCode}` : "") +
            ` | convs: ${s.conversationCount}`;
        }),
        "",
        `── Conversations (${allConversations.length}) ─────────────────────`,
        ...allConversations.slice(0, 10).map((c) =>
          `  ${c.id.slice(0, 8)}… | ${c.title ?? "untitled"} | ` +
          `${c.promptCount} prompts | ${c.status}`
        ),
        "",
        `── App Sessions (${appSessions.length} active, 24h TTL) ─────────`,
        ...appSessions.map((s) =>
          `  ${s.id.slice(0, 8)}… | ${s.providerId ?? "default"} | ` +
          `${Math.round((s.expiresAt - Date.now() / 1000) / 3600)}h left | ${s.directory ?? "?"}`
        ),
        "",
        `── Recent Runs ────────────────────────────────────────────────────`,
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

  logSystem(`Registered 7 tools with client verification flow`);
}
