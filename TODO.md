# 🧟 ZevO MCP — TODO & Current State

---

## ✅ সম্পন্ন (Done)

### Phase 1: Foundation
- [x] Multi-provider MCP server with 6 AI providers
- [x] 7 MCP tools (ping_agent, create_session, verify_session, run_agent, list_providers, list_clients, get_run_details)
- [x] OpenAI-compatible proxy (`/v1/*`)
- [x] SQLite-backed session management with TTL/heartbeat
- [x] Live dashboard with auto-refresh
- [x] Database audit trail (5 tables: providers, app_sessions, mcp_clients, agent_runs, metrics)

### Phase 2: Structure & Build
- [x] TypeScript file structure fix (root → `src/` subdirectories)
- [x] Import path consistency resolved
- [x] `tsconfig.json` — `rootDir: ./src`, `mnt/` excluded
- [x] `npm run build` → zero errors
- [x] Old/duplicate files moved to `~/Desktop/File/zombiemcp-old/`

### Phase 3: Resilience
- [x] `list_providers` boolean/string union fix (MCP error -32602)
- [x] Runtime response logger (`src/logger/`) — auto JSON logging per tool call
- [x] Systemd service — auto-start on boot
- [x] Apache reverse proxy — `m.zombiecoder.my.id:80` → `localhost:5500`

### Phase 4: Documentation
- [x] Digital Ethics Primer
- [x] Governance Framework
- [x] Brand Strategy
- [x] 5-Step Resolution Process
- [x] Learning journal (2026-06-23)

---

## 🔴 এখনই করা দরকার (High Priority)

### Security
- [ ] **Authentication middleware** — API key validation for all endpoints (currently open to anyone)
- [ ] **Rate limiting** — token bucket or sliding window to prevent abuse
- [ ] **API key encryption at rest** — `.env` keys are currently plain text
- [ ] **CORS restrict** — change `origin: "*"` to specific allowed origins

---

## 🟡 শীঘ্রই করা উচিত (Medium Priority)

### Streaming & Performance
- [ ] **Proxy SSE real-time streaming** — currently buffers full response; should stream token-by-token
- [ ] **Dashboard SSE upgrade** — replace 25s polling with live SSE/WebSocket

### DevOps
- [ ] **CI/CD** — GitHub Actions for build + test
- [ ] **Dockerfile** — containerized deployment
- [ ] **Health check endpoint** — `/health` for monitoring services
- [ ] **Prometheus metrics** — expose `/metrics` in Prometheus format

### Code Quality
- [ ] **Unit tests** — Vitest for tools, runner, session manager
- [ ] **Integration tests** — full MCP protocol flow
- [ ] **TypeScript strict mode audit** — remove `@ts-ignore` / `any` types

---

## 🟢 ভবিষ্যতে (Low Priority / Nice to Have)

- [ ] **.env.example** template ✅ (done)
- [ ] **SSE → WebSocket** upgrade for dashboard
- [ ] **Admin CLI** — `zevomcp status`, `zevomcp logs`, `zevomcp providers`
- [ ] **Plugin system** — dynamic tool loading
- [ ] **Multi-user support** — isolated session spaces
- [ ] **Model fallback chain** — if primary provider fails, try next
- [ ] **Webhook notifications** — on agent run completion

---

## 📊 Current State (2026-06-23)

```
Source files:    11 .ts files (1,264 lines)
Output files:    33 dist files (.js + .d.ts + .map)
Build:           tsc → zero errors ✅
Runtime:         systemd → active (enabled) ✅
Proxy:           Apache → m.zombiecoder.my.id:80 ✅
Logger:          JSON log files → logs/{date}/{type}/ ✅
Providers:       6 configured, 4 online, 2 offline
Agent:           LangChain MCPAgent + ChatOpenAI with streaming
Sessions:        SQLite-backed, 24h TTL, heartbeat
```

---

## 🔗 Quick Reference

```
Local MCP:      http://localhost:5500/mcp
Local SSE:      http://localhost:5500/sse
Local Proxy:    http://localhost:5500/v1
Local Dashboard: http://localhost:5500/dashboard
Remote:         https://m.zombiecoder.my.id/ (Apache proxy)
Status:         http://localhost:5500/status
Metrics:        http://localhost:5500/metrics
Logs:           ./logs/YYYY-MM-DD/{success,failed,system}/
Database:       ./zombiecoder.db (SQLite)
```

---

## 🧪 How to Test

```bash
# Health check
curl http://localhost:5500/status

# List providers
curl -X POST http://localhost:5500/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_providers","arguments":{"refresh":"true"}}}'

# Run agent
curl -X POST http://localhost:5500/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_agent","arguments":{"prompt":"Hello, what can you do?","streaming":false}}}'

# Check logs
ls -la logs/$(date +%Y-%m-%d)/success/
ls -la logs/$(date +%Y-%m-%d)/failed/
```

---

> *"যেখানে কোড ও কথা বলে, সমস্যাগুলো নিজের কাঁধে তোলে।"*  
> — **ZombieCoder Dev Agent, Developer Zone, Dhaka, Bangladesh**
