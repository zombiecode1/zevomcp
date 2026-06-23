import { config, ProviderDef } from "../config.js";
import { getDb, recordMetric } from "../db/index.js";
import { buildAgentHeaders } from "../agent/identity.js";

export interface ProviderStatus {
  id: string;
  name: string;
  baseUrl: string;
  status: "online" | "offline" | "unknown";
  models: string[];
  lastCheckedAt: number | null;
}

export function syncProviders(): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO providers (id, name, base_url, api_key)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key
  `);
  for (const p of config.providers) upsert.run(p.id, p.name, p.baseUrl, p.apiKey);
}

async function checkOne(p: ProviderDef): Promise<{ status: "online" | "offline"; models: string[] }> {
  try {
    const url = `${p.baseUrl.replace(/\/v1$/, "")}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${p.apiKey}`, ...buildAgentHeaders() },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: "offline", models: [] };
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return { status: "online", models: (data.data ?? []).map((m) => m.id).slice(0, 30) };
  } catch {
    return { status: "offline", models: [] };
  }
}

export async function checkAllProviders(): Promise<void> {
  const db = getDb();
  const update = db.prepare(`
    UPDATE providers SET status = ?, models_json = ?, last_checked_at = unixepoch() WHERE id = ?
  `);
  await Promise.all(
    config.providers.map(async (p) => {
      const r = await checkOne(p);
      update.run(r.status, JSON.stringify(r.models), p.id);
      recordMetric("provider_online", r.status === "online" ? 1 : 0, { provider: p.id });
    })
  );
}

export function getAllProviderStatuses(): ProviderStatus[] {
  const rows = getDb().prepare(`SELECT * FROM providers ORDER BY id`).all() as Array<{
    id: string;
    name: string;
    base_url: string;
    status: string;
    models_json: string;
    last_checked_at: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    status: r.status as "online" | "offline" | "unknown",
    models: JSON.parse(r.models_json ?? "[]") as string[],
    lastCheckedAt: r.last_checked_at,
  }));
}
