import "dotenv/config";

export interface ProviderDef {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

function opt(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function buildProviders(): ProviderDef[] {
  const ids = ["GROQBRIDGE", "OPENCODE", "GOOGLE", "OLLAMA", "GROQ", "LOCAL"];
  return ids
    .map((id) => {
      const url = opt(`PROVIDER_${id}_URL`);
      if (!url) return null;
      return {
        id,
        name: opt(`PROVIDER_${id}_NAME`, id),
        baseUrl: normaliseUrl(url),
        apiKey: opt(`PROVIDER_${id}_KEY`, "proxy-no-auth"),
      };
    })
    .filter((p): p is ProviderDef => p !== null);
}

export const config = {
  activeProviderId: opt("ACTIVE_PROVIDER", "GROQBRIDGE"),
  agentModel:       opt("AGENT_MODEL", "auto"),
  agentMaxSteps:    parseInt(opt("AGENT_MAX_STEPS", "10"), 10),
  agentTemperature: parseFloat(opt("AGENT_TEMPERATURE", "0")),
  serverPort:       parseInt(opt("MCP_SERVER_PORT", "5500"), 10),
  serverHost:       opt("MCP_SERVER_HOST", "localhost"),
  dbPath:           opt("DB_PATH", "./zombiecoder.db"),
  logDir:           opt("LOG_DIR", "./logs"),

  // Auth & encryption (from .env)
  apiKey:           opt("X_API_KEY", ""),
  encryptionKey:    opt("ENCRYPTION_KEY", ""),

  // Providers are built from env (no hardcoded list)
  providers: buildProviders(),
};

export function getProvider(id?: string): ProviderDef | undefined {
  const target = (id ?? config.activeProviderId).toUpperCase();
  return config.providers.find((p) => p.id === target);
}

export function getActiveProvider(): ProviderDef {
  const p = getProvider();
  if (!p) throw new Error(`Provider '${config.activeProviderId}' is not configured. Check your .env.`);
  return p;
}
