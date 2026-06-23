# 🧟 ZevO MCP — ZombieCoder Multi-Provider AI Agent Server

**Owner:** Sahon Srabon · **Organization:** Developer Zone · **Location:** Dhaka, Bangladesh  
**Website:** [https://zombiecoder.my.id](https://zombiecoder.my.id)

> *"যেখানে কোড ও কথা বলে, সমস্যাগুলো নিজের কাঁধে তোলে"*

---

## 📦 Overview

ZevO MCP is a **local-first**, **multi-provider** MCP (Model Context Protocol) server that:

- Runs an **AI Agent** (LangChain MCPAgent + ChatOpenAI) with step-by-step streaming
- Manages **6 AI providers** (GroqBridge, OpenCode/Zen, Google Gemini, Ollama, Groq, Local)
- Provides an **OpenAI-compatible proxy** (`/v1/*`) — any OpenAI SDK can connect
- Maintains **SQLite-backed sessions** with TTL/heartbeat
- Exposes a **Live Dashboard** with real-time monitoring
- Logs every tool call to structured **JSON log files** for debugging
- Supports **remote access** via Apache reverse proxy (`m.zombiecoder.my.id`)

---

## 🚀 Quick Start

```bash
# 1. Clone & install
git clone https://github.com/zombiecode1/zevomcp.git
cd zevomcp
cp .env.example .env   # configure your API keys
npm install

# 2. Build
npm run build

# 3. Run
npm start
# → http://localhost:5500/dashboard
# → http://localhost:5500/mcp
# → http://localhost:5500/v1  (OpenAI-compatible)
```

---

## 🔧 Architecture

```
zevomcp/
├── src/
│   ├── index.ts              ← Entry point (MCPServer config, init)
│   ├── config.ts             ← .env → Provider configuration
│   ├── agent/
│   │   ├── identity.ts       ← ZombieCoder brand identity
│   │   └── runner.ts         ← MCPAgent + ChatOpenAI execution
│   ├── session/
│   │   └── manager.ts        ← SQLite session CRUD + TTL
│   ├── providers/
│   │   └── registry.ts       ← Provider sync + health checks
│   ├── routes/
│   │   ├── proxy.ts          ← OpenAI-compatible proxy (/v1/*)
│   │   └── status.ts         ← Status/Metrics/Dashboard routes
│   ├── db/
│   │   └── index.ts          ← SQLite schema (5 tables)
│   ├── tools/
│   │   └── index.ts          ← 7 MCP tools + logging wrapper
│   └── logger/
│       └── index.ts          ← JSON file logger (success/failed/system)
├── doc/                      ← Documentation (ethics, governance, brand)
├── logs/                     ← Runtime log files (gitignored)
├── dist/                     ← Built output (gitignored)
├── .env                      ← Secrets (gitignored)
└── package.json
```

---

## 🛠️ MCP Tools

| Tool | Description |
|------|-------------|
| `ping_agent` | Health check — returns identity, active provider, config |
| `create_session` | Create 24h app session (browser/dashboard) |
| `verify_session` | Check session validity |
| `run_agent` | ⭐ Execute ZombieCoder AI agent with streaming |
| `list_providers` | List all providers + health status (+ refresh) |
| `list_clients` | Live MCP clients + app sessions + recent runs |
| `get_run_details` | Full agent run audit trail |

---

## 🌐 Endpoints

| Endpoint | Description |
|----------|-------------|
| `http://localhost:5500/mcp` | MCP protocol endpoint |
| `http://localhost:5500/sse` | Server-Sent Events |
| `http://localhost:5500/v1/*` | OpenAI-compatible proxy |
| `http://localhost:5500/dashboard` | Live monitoring UI |
| `http://localhost:5500/status` | JSON status |
| `http://localhost:5500/metrics` | JSON metrics |
| `https://m.zombiecoder.my.id/*` | Remote access (Apache proxy) |

---

## 🔌 Providers

| ID | Name | Status |
|----|------|--------|
| GROQBRIDGE | Groq Bridge Proxy | ✅ Online |
| OPENCODE | OpenCode Zen | ✅ Online |
| GOOGLE | Google Gemini | ✅ Online |
| OLLAMA | Ollama Local | ✅ Online |
| GROQ | Groq Direct | ❌ Offline (config pending) |
| LOCAL | Local Server | ❌ Offline (config pending) |

Configure via `.env`:
```env
ACTIVE_PROVIDER=GROQBRIDGE
PROVIDER_GROQBRIDGE_URL=https://your-proxy.example.com/v1
PROVIDER_GROQBRIDGE_KEY=your-key
```

---

## 📊 Runtime Logging

Every tool call is automatically logged to structured JSON files:

```
logs/
└── 2026-06-23/
    ├── success/
    │   ├── ping_agent-0001.json
    │   └── list_providers-0002.json
    ├── failed/
    │   └── run_agent-0001.json
    └── system/
        ├── system-0001.json
        └── system-0002.json
```

Log format:
```json
{
  "timestamp": "2026-06-23T12:23:03.615Z",
  "type": "success",
  "sessionId": "abc-123",
  "toolName": "ping_agent",
  "summary": "Tool ping_agent succeeded in 12ms",
  "detail": { "args": {}, "result": "identity: ZombieCoder..." },
  "durationMs": 12
}
```

---

## 📋 License

Proprietary — Local Freedom Protocol  
© 2026 Sahon Srabon, Developer Zone, Dhaka, Bangladesh.
