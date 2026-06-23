import { MCPAgent, MCPClient } from "mcp-use";
import { ChatOpenAI } from "@langchain/openai";
import { v4 as uuidv4 } from "uuid";
import { config, getProvider } from "../config.js";
import { getDb, recordMetric } from "../db/index.js";
import { SYSTEM_PROMPT, buildAgentHeaders } from "./identity.js";

export interface McpServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RunAgentOptions {
  prompt: string;
  providerId?: string;
  model?: string;
  temperature?: number;
  maxSteps?: number;
  streaming?: boolean;
  servers?: Record<string, McpServerDef>;
  appSessionId?: string;
  mcpSessionId?: string;
  systemPromptOverride?: string;
  onStep?: (tool: string, input: unknown) => void;
}

export interface RunAgentResult {
  runId: string;
  output: string;
  success: boolean;
  steps: number;
  toolCalls: Array<{ tool: string; input: unknown }>;
  providerId: string;
  model: string;
  durationMs: number;
  error?: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const provider = getProvider(opts.providerId);
  if (!provider) {
    throw new Error(`Provider '${opts.providerId ?? config.activeProviderId}' is not configured.`);
  }

  const model       = opts.model       ?? config.agentModel;
  const temperature = opts.temperature ?? config.agentTemperature;
  const maxSteps    = opts.maxSteps    ?? config.agentMaxSteps;
  const streaming   = opts.streaming   ?? true;
  const runId       = uuidv4();
  const toolCalls: Array<{ tool: string; input: unknown }> = [];
  const startedAt = Date.now();

  const db = getDb();
  db.prepare(`
    INSERT INTO agent_runs
      (id, app_session_id, mcp_session_id, provider_id, model, prompt, streaming)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    opts.appSessionId ?? null,
    opts.mcpSessionId ?? null,
    provider.id,
    model,
    opts.prompt,
    streaming ? 1 : 0
  );

  const llm = new ChatOpenAI({
    model,
    apiKey: provider.apiKey,
    temperature,
    streaming,
    configuration: {
      baseURL: provider.baseUrl,
      defaultHeaders: buildAgentHeaders(),
    },
  });

  // Sub-MCP-servers the agent itself can call as tools (separate from this
  // server's own tools). Empty object is valid — the agent then behaves as a
  // plain chat completion with no extra tool access.
  const client = new MCPClient({ mcpServers: opts.servers ?? {} });
  let output = "";
  let steps  = 0;

  try {
    await client.createAllSessions();

    const agent = new MCPAgent({
      llm,
      client,
      maxSteps,
      autoInitialize: true,
      memoryEnabled: false,
      systemPrompt: opts.systemPromptOverride ?? SYSTEM_PROMPT,
    });

    if (streaming) {
      for await (const step of agent.stream({ prompt: opts.prompt, maxSteps })) {
        steps++;
        const call = { tool: step.action.tool, input: step.action.toolInput };
        toolCalls.push(call);
        if (opts.onStep) opts.onStep(call.tool, call.input);
      }

      const chunks: string[] = [];
      for await (const event of agent.streamEvents({ prompt: opts.prompt, maxSteps })) {
        if (event.event === "on_chat_model_stream") {
          const chunkContent = (event.data?.chunk as { text?: string; content?: unknown })?.text
            ?? (event.data?.chunk as { content?: unknown })?.content;
          if (typeof chunkContent === "string" && chunkContent) chunks.push(chunkContent);
        }
      }
      output = chunks.join("").trim();

      if (!output) {
        // Fallback: some providers don't emit on_chat_model_stream events in the
        // expected shape. run() gives a guaranteed final answer either way.
        output = await agent.run({ prompt: opts.prompt, maxSteps });
      }
    } else {
      output = await agent.run({ prompt: opts.prompt, maxSteps });
    }

    const durationMs = Date.now() - startedAt;
    db.prepare(`
      UPDATE agent_runs
      SET output = ?, status = 'success', steps = ?, tool_calls_json = ?, completed_at = unixepoch()
      WHERE id = ?
    `).run(output, steps, JSON.stringify(toolCalls), runId);
    recordMetric("agent_run_ms", durationMs, { provider: provider.id, status: "success" });

    return { runId, output, success: true, steps, toolCalls, providerId: provider.id, model, durationMs };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;

    db.prepare(`
      UPDATE agent_runs SET status = 'error', output = ?, completed_at = unixepoch() WHERE id = ?
    `).run(message, runId);
    recordMetric("agent_run_ms", durationMs, { provider: provider.id, status: "error" });

    return {
      runId, output: "", success: false, steps, toolCalls,
      providerId: provider.id, model, durationMs, error: message,
    };

  } finally {
    await client.closeAllSessions();
  }
}

export function getRecentRuns(limit = 20): Array<Record<string, unknown>> {
  return getDb().prepare(`
    SELECT id, provider_id, model, status, streaming, steps, started_at, completed_at,
           substr(prompt, 1, 80) AS prompt_preview
    FROM agent_runs ORDER BY started_at DESC LIMIT ?
  `).all(limit);
}
