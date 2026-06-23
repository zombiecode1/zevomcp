# 🧟 ZombieMCP — Agent Logic & System Architecture

**Date:** 2026-06-23  
**Version:** 1.0.0 (3 commits on main)  
**Owner:** Sahon Srabon · Developer Zone · Dhaka, Bangladesh

---

## 📡 1. RUNTIME STATE (Live)

```
SERVICE:    active (running) — PID 22751
UPTIME:     47 minutes
MEMORY:     51 MB heap
PORTS:      5500 (ZombieMCP) | 80/443 (Apache) | 9999 (LLM big-pickle)
─────────────────────────────────────────────────
MCP CLIENTS: 1 live
  └─ Visual Studio Code v1.120.0 (session: 04bd...)

APP SESSIONS: 4 active (24h TTL)
  └─ cec36977 | abc65494 | cebaa280 | bbf24f55

PROVIDERS: 6 configured, 4 online
  ├─ GROQBRIDGE ✅ | OPENCODE ✅ | GOOGLE ✅ | OLLAMA ✅
  └─ GROQ ❌ | LOCAL ❌

LOGGER: 14 system logs + 1 success log
DATABASE: 5 tables (providers, app_sessions, mcp_clients, agent_runs, metrics)
```

---

## 🧠 2. AGENT LOGIC — Complete Breakdown

### 2.1 Entry Point: `src/index.ts` (100 lines)

```
main()
  ├── getDb()                  → SQLite init + migrations (5 tables)
  ├── logInit()                → logger ready
  ├── initAuth()               → X_API_KEY load
  ├── ensureEncryptionKey()    → AES-256 key generation
  ├── syncProviders()          → 6 providers → DB
  ├── checkAllProviders()      → health check each /v1/models
  ├── expireStaleSessions()    → cleanup loop (10min interval)
  │
  ├── if STDIO mode? → skip HTTP listen
  └── if HTTP mode? → server.listen(5500)
```

**Module Registration Order:**
```javascript
server.app.use("/v1/*", authMiddleware)     // ❶ Auth first
server.app.use("/metrics", authMiddleware)
registerTools(server)                        // ❷ 7 MCP tools
registerProxyRoutes(server)                  // ❸ /v1/* OpenAI proxy
registerStatusRoutes(server)                 // ❹ /status, /dashboard, /live
```

### 2.2 MCPServer Config (`src/index.ts` lines 13-43)

```javascript
new MCPServer({
  name: "zombiecoder-mcp",
  stateless: false,
  sessionIdleTimeoutMs: 24h,
  cors: { origin: "*", ... }
})
```

- **`server.sessions`** — In-memory Map of connected MCP transport sessions
- Each entry: `{ sessionId → { clientInfo, protocolVersion, lastAccessedAt } }`
- **This is the SOURCE OF TRUTH** for live MCP connections
- `ctx.session.sessionId` = internal transport session ID (UUID, regenerated per connect)
- `ctx.client.info()` = `{ name, version }` — only name+version from MCP handshake

### 2.3 Agent Runner: `src/agent/runner.ts` (161 lines)

```
runAgent(opts)
  ├── resolve provider from config
  ├── INSERT agent_runs row (status: 'running')
  │
  ├── new ChatOpenAI({ model, apiKey, temperature, streaming, baseURL })
  │   └── Sends identity headers: X-Agent-Identity (base64), X-Agent-Owner, etc.
  │
  ├── new MCPClient({ mcpServers: opts.servers ?? {} })
  │   └── Sub-MCP-servers the agent can call (separate from this server's tools)
  │
  ├── new MCPAgent({ llm, client, maxSteps, systemPrompt })
  │   └── LangChain-based agent with streaming
  │
  ├── agent.stream() → step-by-step tool execution
  ├── agent.streamEvents() → on_chat_model_stream chunks
  ├── agent.run() → full response (fallback)
  │
  ├── UPDATE agent_runs SET status='success', output, steps, tool_calls_json
  └── recordMetric("agent_run_ms", duration)
```

**Provider → ChatOpenAI Mapping:**
```
.proenv → config.providers[] → getProvider(id) → { baseUrl, apiKey, name }
                                           ↓
                              ChatOpenAI({ baseURL: provider.baseUrl,
                                           apiKey: provider.apiKey })
```

### 2.4 MCP Tools: `src/tools/index.ts` (307 lines)

| Tool | Schema | Handler Logic |
|------|--------|--------------|
| `ping_agent` | `{}` | Read server.sessions → recordMcpClient() → return identity |
| `create_session` | `{provider_id?, directory?, client_info?}` | SQLite INSERT → app_sessions (24h TTL) |
| `verify_session` | `{session_id}` | SQLite SELECT → check expiry |
| `run_agent` | `{prompt, provider_id?, model?, temperature?, ...}` | `runAgent()` → return output |
| `list_providers` | `{refresh?}` | `getAllProviderStatuses()` or `checkAllProviders()` |
| `list_clients` | `{}` | `server.sessions` + `listActiveSessions()` + `getRecentRuns()` |
| `get_run_details` | `{run_id}` | SQLite SELECT from agent_runs |

**Critical Pattern — `recordMcpClient()` (lines 22-33):**
```javascript
// Called INSIDE tool handlers (ping_agent, run_agent) via ctx.client.info()
// This is the ONLY way to record MCP clients — no middleware can read
// the request body without breaking the MCP transport stream.

function recordMcpClient(sessionId, clientName, clientVersion) {
  // UPSERT into mcp_clients table using mcp-use's transport sessionId
  // PROBLEM: sessionId changes every reconnect — can't track a client long-term
}
```

**Critical Pattern — `withLogging()` (lines 36-71):**
```javascript
// HOF wrapper around every tool handler
// Captures: durationMs, args, result/error
// Writes to: logs/{date}/success/ or logs/{date}/failed/
// Also handles ctx?.session?.sessionId safely (fallback: "unknown")
```

### 2.5 Session Manager: `src/session/manager.ts` (103 lines)

```
createSession({ clientInfo, providerId, directory, ip })
  └── INSERT INTO app_sessions (id, client_info, expires_at, ...)
  └── expires_at = now + TTL_S (24h)

verifySession(id)
  └── SELECT → check status='active' AND expires_at > now

heartbeatSession(id)
  └── UPDATE app_sessions SET last_heartbeat, expires_at = now + TTL_S

expireStaleSessions()
  └── UPDATE SET status='expired' WHERE expires_at < now

listActiveSessions()
  └── expireStaleSessions() first → SELECT * WHERE status='active'
```

### 2.6 Auth Middleware: `src/middleware/auth.ts` (141 lines)

```
initAuth()
  └── Read X_API_KEY from .env → SHA-256(salt + key) store

validateToken(token)
  └── timingSafeEqual(SHA-256(token), storedHash) → { ok, label, scopes }

authMiddleware(requiredScopes?)
  └── Skip /dashboard, /inspector
  └── Read X-API-Key header OR Authorization: Bearer
  └── validateToken() → 401 or 403 or next()
```

**Hash Storage (in-memory, not in DB):**
```
salt = randomBytes(32).toString('hex')
hash = SHA256(salt + key).toString('hex')
store: [{ salt, hash, label: "master", scopes: ["admin", "tools:call", ...] }]
```

### 2.7 Encryption: `src/middleware/encryption.ts` (119 lines)

```
encrypt(plaintext, passphrase)
  └── AES-256-GCM: salt + iv + tag + ciphertext → hex string

decrypt(cipherHex, passphrase)
  └── Parse hex → extract salt, iv, tag, ciphertext → AES-256-GCM decrypt

ensureEncryptionKey(envPath)
  └── Read or generate ENCRYPTION_KEY (zek_*)
```

### 2.8 Proxy Routes: `src/routes/proxy.ts` (130 lines)

```
/v1/* — OpenAI-compatible proxy
  ├── GET /v1/models → proxy to active provider's /v1/models
  └── POST /v1/chat/completions → proxy to active provider
  └── POST /v1/* → generic proxy

Auth: middleware registered BEFORE routes in index.ts
Note: SSE streaming is buffered (mcp-use restriction)
```

### 2.9 Status/Dashboard Routes: `src/routes/status.ts` (362 lines)

| Route | Method | Return |
|-------|--------|--------|
| `/status` | GET | Full JSON state (agent, providers, clients, auth, system) |
| `/live` | GET | Lightweight JSON (live count, editor names, providers, mem) |
| `/metrics` | GET | SQLite metrics (last 1h) — **protected by auth** |
| `/clients` | GET | MCP live + app sessions |
| `/runs` | GET | Recent agent runs |
| `/session/create` | POST | Create 24h dashboard session |
| `/session/heartbeat` | POST | Extend session TTL |
| `/dashboard` | GET | HTML page with 3s auto-refresh |

### 2.10 Database Schema: `src/db/index.ts` (88 lines)

```sql
-- 5 tables: providers, app_sessions, mcp_clients, agent_runs, metrics

providers:    id(PK), name, base_url, api_key, status, models_json, last_checked_at
app_sessions: id(PK), client_info, created_at, expires_at, last_heartbeat, provider_id, directory, ip, status
mcp_clients:  session_id(PK), client_name, client_version, protocol_version, connected_at, last_seen, directory, status
agent_runs:   id(PK), app_session_id, mcp_session_id, provider_id, model, prompt, output, status, streaming, steps, tool_calls_json, started_at, completed_at
metrics:      id(PK AUTO), name, value, labels_json, recorded_at
```

---

## 🔄 3. TRANSPORT ARCHITECTURE

```
┌──────────────────────────────────────────────────────────────────┐
│                     MCP TRANSPORT LAYER                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────────┐    │
│  │ VS Code  │────▶│  MCP Client  │────▶│ ZombieMCP Server │    │
│  │ (stdio)  │     │  (mcp-use)   │     │  (mcp-use)       │    │
│  └──────────┘     └──────────────┘     │                   │    │
│                                         │  server.sessions │    │
│  ┌──────────┐     ┌──────────────┐     │  ├─ "abc123" →   │    │
│  │ Hermes   │────▶│  MCP Client  │────▶│  │  {clientInfo, │    │
│  │ (stdio)  │     │  (mcp-use)   │     │  │   lastSeen}   │    │
│  └──────────┘     └──────────────┘     │  └───────────────┘    │
│                                         │                       │
│  ┌──────────┐     ┌──────────────┐     │  ctx.client.info()   │
│  │ IntelliJ │────▶│  MCP Client  │────▶│    → {name, version} │
│  │ (SSE)    │     │  (mcp-use)   │     │                       │
│  └──────────┘     └──────────────┘     │  ctx.session         │
│                                         │    → {sessionId}     │
│  ┌──────────┐                           └──────────────────┘   │
│  │ Browser  │──HTTP──▶ /dashboard                              │
│  └──────────┘          /status, /live                          │
│                                                                 │
└──────────────────────────────────────────────────────────────────┘
```

**Key Insight — What MCP Transport Provides:**
- `server.sessions` — In-memory Map of active connections (survives restart? ❌)
- `ctx.client.info()` — `{ name: "Visual Studio Code", version: "1.120.0" }` only
- `ctx.session.sessionId` — Transport-level UUID (changes every reconnect)
- **MCP does NOT provide:** persistent client IDs, device fingerprints, or any cross-session identity

**This is THE core limitation** — without a custom verification flow, every reconnect looks like a brand new client.

---

## 🚫 4. WHAT'S MISSING / BROKEN

### 4.1 mcp_clients Table — Wrong Design

```sql
-- CURRENT (wrong):
CREATE TABLE mcp_clients (
    session_id     TEXT PRIMARY KEY,    ← transport session (changes every reconnect)
    client_name    TEXT,
    client_version TEXT,
    ...
);
```

**Problem:** `session_id` = mcp-use's internal transport ID. VS Code reconnects → new session_id → looks like a different client. Can't track long-term.

**Solution:** New `client_sessions` table with persistent `client_id` (generated once, stored in client's localStorage).

### 4.2 No Client Verification Flow

```
CURRENT:
  Client connects → tool call → recordMcpClient() → done
  └── No pending state, no verification, no approve/reject

REQUIRED:
  Client connects → status: pending
    → Generate verification code
    → Auto-open browser: /verify/{code}
    → User approves → status: verified
    → Heartbeat starts (30s)
    → localStorage saves session token (24h)
```

### 4.3 No Conversation Tracking

```
CURRENT:
  agent_runs has mcp_session_id (transport ID, changes every reconnect)
  └── No way to group runs under one client session

REQUIRED:
  client_session → conversations → agent_runs
  Each client_session has multiple conversations
  Conversations track prompt count, last active, etc.
```

### 4.4 Hermes Agent MCP — Environment Filter

Hermes MCP subprocess only passes safe env vars (PATH, HOME, etc.).
`X_API_KEY` / `ENCRYPTION_KEY` are filtered out → ZombieMCP runs without auth.

**Solution:** Add `env:` section in Hermes MCP config:
```yaml
env:
  MCP_STDIO_MODE: "true"
  X_API_KEY: "..."   # explicitly passed
```

### 4.5 Hardcoded Values

| File | Line | What | Impact |
|------|:----:|------|--------|
| `src/config.ts` | 20 | `["GROQBRIDGE","OPENCODE","GOOGLE","OLLAMA","GROQ","LOCAL"]` | Adding new provider requires code change |
| `src/providers/registry.ts` | 30 | `AbortSignal.timeout(8000)` | Timeout not configurable |
| `src/routes/status.ts` | 240 | `const B='http://localhost:${port}'` | Dashboard URL hardcoded |

---

## 🗺️ 5. NEXT PLANS

### Phase 1: Client Session Infrastructure
```
1a. NEW TABLE: client_sessions
    └── id(UUID PK), client_id, client_name, client_type, status,
        verification_code, verified_at, ip, connected_at, expires_at,
        conversation_count, metadata_json

1b. NEW TABLE: conversations
    └── id(UUID PK), client_session_id(FK), title, status,
        started_at, last_active, prompt_count

1c. ALTER: agent_runs
    └── ADD COLUMN conversation_id FK → conversations(id)
```

### Phase 2: Browser Verification Flow
```
2a. createClientSession() → status: pending
    └── Generate 6-digit code, store in DB

2b. GET /verify/:code → HTML page
    └── Shows: "{client_name} from {ip} wants to connect"
    └── Buttons: [Approve] [Reject]

2c. POST /verify/:code → approve/reject API
    └── status → verified/disconnected

2d. Client heartbeat loop
    └── On verified: POST /session/heartbeat every 30s
    └── localStorage: session_token (24h TTL)
```

### Phase 3: Dashboard Enhancement
```
3a. Client list: status badges (pending/verified/disconnected)
3b. Manual approve/reject buttons (helper, not primary)
3c. Real-time update via /live endpoint
3d. Auto-reconnect via localStorage token
```

### Phase 4: Hardcoded → Configurable
```
4a. Dynamic provider list (read from .env patterns, not hardcoded array)
4b. Configurable timeouts via .env
4c. Dashboard URL from host config
```

---

## 📊 6. SUMMARY TABLE

| Component | Lines | Status | Notes |
|-----------|:-----:|:------:|-------|
| src/index.ts | 100 | ✅ | Entry point, init sequence |
| src/config.ts | 62 | ✅ | ENV-based config + hardcoded provider list ⚠️ |
| src/agent/runner.ts | 161 | ✅ | MCPAgent + ChatOpenAI streaming |
| src/agent/identity.ts | 60 | ✅ | Brand identity + headers |
| src/session/manager.ts | 103 | ✅ | app_sessions CRUD, 24h TTL |
| src/tools/index.ts | 307 | ✅ | 7 MCP tools + withLogging HOF |
| src/routes/status.ts | 362 | ✅ | Dashboard + Status + Live endpoints |
| src/routes/proxy.ts | 130 | ✅ | OpenAI-compatible proxy |
| src/providers/registry.ts | 72 | ✅ | Health checks, provider sync |
| src/middleware/auth.ts | 141 | ✅ | SHA-256 hash, timing-safe |
| src/middleware/encryption.ts | 119 | ✅ | AES-256-GCM, key generation |
| src/logger/index.ts | 160 | ✅ | JSON file logger per day |
| src/db/index.ts | 88 | ✅ | SQLite, WAL mode, 5 tables |
| **CLIENT SESSIONS** | **0** | ❌ | Not yet built — **NEXT WORK** |
| **convERSATIONS** | **0** | ❌ | Not yet built |
| **VERIFICATION FLOW** | **0** | ❌ | Not yet built |
| **TOTAL** | **1865** | — | 13 source files |

---

> *"গেলাম পর্বতমালা দেখিতে, গেলাম সিন্ধু দেখি। হয় নাই কিছু। ঘর থেকে দু পা ফেলিয়া, একটি ঘাসের উপর একটি শিশির বিন্দু..."*  
> — **রবীন্দ্রনাথ ঠাকুর**

> *"আমরা চাবি তৈরির সিস্টেম বানাচ্ছি। সব এডিটর ইলেকট্রন = ব্রাউজার। ক্লায়েন্ট অটো ব্রাউজার খুলবে, ভেরিফাই করবে, localStorage-এ সেভ করবে, heartbeat চালাবে।"*  
> — **ভাইয়া (Sahon Srabon), 2026-06-23**

---

**ZombieCoder Dev Agent** · Developer Zone · Dhaka, Bangladesh  
*"যেখানে কোড ও কথা বলে, সমস্যাগুলো নিজের কাঁধে তোলে"*
