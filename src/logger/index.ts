import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const LOG_ROOT = path.resolve(config.logDir);

interface LogEntry {
  timestamp: string;
  type: "success" | "failed" | "system" | "warning";
  sessionId?: string;
  toolName?: string;
  providerId?: string;
  summary: string;
  detail: Record<string, unknown>;
  durationMs?: number;
}

function ensureDir(dayDir: string): void {
  for (const sub of ["success", "failed", "system"]) {
    const d = path.join(dayDir, sub);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function todayDir(): string {
  const date = new Date().toISOString().slice(0, 10); // 2026-06-23
  return path.join(LOG_ROOT, date);
}

function nextSeq(dayDir: string, type: string): number {
  const dir = path.join(dayDir, type);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.length + 1;
}

function write(entry: LogEntry): void {
  const dayDir = todayDir();
  ensureDir(dayDir);

  const type = entry.type;
  const seq = String(nextSeq(dayDir, type)).padStart(4, "0");
  const toolPart = entry.toolName ? `-${entry.toolName}` : "";
  const filename = `${type}${toolPart}-${seq}.json`;

  const filePath = path.join(dayDir, type, filename);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + "\n");
}

// ── Public API ──────────────────────────────────────────────────────────────

export function logSuccess(opts: {
  sessionId?: string;
  toolName?: string;
  summary: string;
  detail?: Record<string, unknown>;
  durationMs?: number;
}): void {
  write({
    timestamp: new Date().toISOString(),
    type: "success",
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    summary: opts.summary,
    detail: opts.detail ?? {},
    durationMs: opts.durationMs,
  });
}

export function logFailed(opts: {
  sessionId?: string;
  toolName?: string;
  providerId?: string;
  summary: string;
  detail?: Record<string, unknown>;
  durationMs?: number;
}): void {
  write({
    timestamp: new Date().toISOString(),
    type: "failed",
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    providerId: opts.providerId,
    summary: opts.summary,
    detail: opts.detail ?? {},
    durationMs: opts.durationMs,
  });
}

export function logSystem(systemMsg: string, level: "system" | "warning" = "system"): void {
  write({
    timestamp: new Date().toISOString(),
    type: level === "warning" ? "warning" : "system",
    summary: systemMsg,
    detail: {},
  });
}

export function logToolCall(opts: {
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  resultPreview: string;
  durationMs: number;
  error?: string;
}): void {
  if (opts.success) {
    logSuccess({
      sessionId: opts.sessionId,
      toolName: opts.toolName,
      summary: `Tool ${opts.toolName} succeeded in ${opts.durationMs}ms`,
      detail: { args: opts.args, result: opts.resultPreview },
      durationMs: opts.durationMs,
    });
  } else {
    logFailed({
      sessionId: opts.sessionId,
      toolName: opts.toolName,
      summary: `Tool ${opts.toolName} failed in ${opts.durationMs}ms: ${opts.error ?? "unknown error"}`,
      detail: { args: opts.args, error: opts.error, result: opts.resultPreview },
      durationMs: opts.durationMs,
    });
  }
}

export function logAgentRun(opts: {
  sessionId: string;
  providerId: string;
  model: string;
  prompt: string;
  success: boolean;
  durationMs: number;
  outputPreview?: string;
  error?: string;
}): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    type: opts.success ? "success" : "failed",
    sessionId: opts.sessionId,
    providerId: opts.providerId,
    summary: `Agent run (${opts.model}) ${opts.success ? "succeeded" : "failed"} in ${opts.durationMs}ms`,
    detail: {
      model: opts.model,
      promptLength: opts.prompt.length,
      outputPreview: opts.outputPreview ?? "",
      error: opts.error,
    },
    durationMs: opts.durationMs,
  };
  write(entry);
}

export function getLogDir(): string {
  return LOG_ROOT;
}

export function logInit(): void {
  logSystem("Server started");
  console.log(`✓ Response logger ready → ${LOG_ROOT}/{date}/{success,failed,system}/`);
}
