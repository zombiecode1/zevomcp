import { MCPServer } from "mcp-use/server";
import { config } from "../config.js";
import { getAllProviderStatuses } from "../providers/registry.js";
import { listActiveSessions, createSession, heartbeatSession } from "../session/manager.js";
import { getRecentRuns } from "../agent/runner.js";
import { getDb } from "../db/index.js";
import { IDENTITY } from "../agent/identity.js";

export function registerStatusRoutes(server: MCPServer): void {
  const app = server.app;
  const port = config.serverPort;

  app.get("/status", (c) => {
    const db = getDb();

    const liveMcpSessions = Array.from(server.sessions.entries()).map(([sid, data]) => ({
      session_id: sid,
      client_name: data.clientInfo?.name ?? "unknown",
      client_version: data.clientInfo?.version ?? "",
      protocol_version: data.protocolVersion ?? "",
      last_accessed_at: data.lastAccessedAt,
    }));

    return c.json({
      agent: {
        identity: IDENTITY.system_identity.name,
        version: IDENTITY.system_identity.version,
        owner: IDENTITY.system_identity.branding.owner,
        active_provider: config.activeProviderId,
        model: config.agentModel,
        max_steps: config.agentMaxSteps,
      },
      providers: getAllProviderStatuses().map((p) => ({
        id: p.id,
        name: p.name,
        url: p.baseUrl,
        status: p.status,
        models: p.models.length,
        last_checked: p.lastCheckedAt ? new Date(p.lastCheckedAt * 1000).toISOString() : null,
      })),
      app_sessions: {
        active: listActiveSessions().length,
        list: listActiveSessions().map((s) => ({
          id: s.id,
          provider: s.providerId,
          directory: s.directory,
          expires_in: Math.round((s.expiresAt - Date.now() / 1000) / 60) + "m",
        })),
      },
      mcp_clients: {
        live_connected: liveMcpSessions.length,
        live: liveMcpSessions,
        historical: db.prepare(`SELECT * FROM mcp_clients ORDER BY connected_at DESC LIMIT 50`).all(),
      },
      run_stats: db.prepare(`
        SELECT status, COUNT(*) AS count, AVG(completed_at - started_at) AS avg_s
        FROM agent_runs GROUP BY status
      `).all(),
      recent_runs: getRecentRuns(10),
      endpoints: {
        mcp: `http://localhost:${port}/mcp`,
        sse: `http://localhost:${port}/sse`,
        proxy_v1: `http://localhost:${port}/v1`,
        status: `http://localhost:${port}/status`,
        metrics: `http://localhost:${port}/metrics`,
        dashboard: `http://localhost:${port}/dashboard`,
        inspector: `http://localhost:${port}/inspector`,
      },
      server_time: new Date().toISOString(),
    });
  });

  app.get("/metrics", (c) => {
    const rows = getDb().prepare(`
      SELECT name, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS samples
      FROM metrics WHERE recorded_at > unixepoch() - 3600 GROUP BY name
    `).all();
    return c.json({ window: "last_1h", metrics: rows, ts: new Date().toISOString() });
  });

  app.get("/clients", (c) => {
    const liveMcpSessions = Array.from(server.sessions.entries()).map(([sid, data]) => ({
      session_id: sid,
      client_name: data.clientInfo?.name ?? "unknown",
      client_version: data.clientInfo?.version ?? "",
    }));
    return c.json({
      mcp_clients: liveMcpSessions,
      app_sessions: listActiveSessions(),
      ts: new Date().toISOString(),
    });
  });

  app.get("/runs", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    return c.json({ runs: getRecentRuns(limit), ts: new Date().toISOString() });
  });

  app.post("/session/create", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      provider_id?: string;
      directory?: string;
      client_info?: Record<string, unknown>;
    };
    const session = createSession({
      providerId: body.provider_id ?? config.activeProviderId,
      directory: body.directory,
      clientInfo: body.client_info ?? {},
      ip: c.req.header("x-forwarded-for") ?? undefined,
    });
    return c.json({
      session_id: session.id,
      expires_at: new Date(session.expiresAt * 1000).toISOString(),
      provider: session.providerId,
      ttl_hours: 24,
    });
  });

  app.post("/session/heartbeat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { session_id?: string };
    if (!body.session_id) return c.json({ error: "session_id required" }, 400);
    return c.json({ ok: heartbeatSession(body.session_id), ts: new Date().toISOString() });
  });

  app.get("/dashboard", (c) => c.html(dashboardHtml(port)));
}

function dashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZombieCoder MCP</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--sf:#161b22;--bd:#30363d;--gr:#3fb950;--rd:#f85149;--yw:#d29922;--bl:#58a6ff;--tx:#c9d1d9;--dm:#8b949e;--fn:'JetBrains Mono','Fira Code',monospace}
body{background:var(--bg);color:var(--tx);font-family:var(--fn);font-size:13px}
header{background:var(--sf);border-bottom:1px solid var(--bd);padding:12px 20px;display:flex;align-items:center;gap:12px}
header h1{font-size:15px;color:var(--gr);letter-spacing:1px}
.badge{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}
.bg{background:#1a4731;color:var(--gr)}.bb{background:#1a2d4a;color:var(--bl)}
#sse-dot{margin-left:auto;font-size:11px;color:var(--dm)}
main{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px}
section{background:var(--sf);border:1px solid var(--bd);border-radius:8px;overflow:hidden}
section h2{padding:9px 14px;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--bd);color:var(--bl)}
.c{padding:12px 14px}
.r{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d}
.r:last-child{border:none}.lb{color:var(--dm)}
.pv{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #21262d}
.pv:last-child{border:none}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dg{background:var(--gr)}.dr{background:var(--rd)}.dy{background:var(--dm)}
.run{padding:5px 0;border-bottom:1px solid #21262d;font-size:12px}.run:last-child{border:none}
.rsuccess{color:var(--gr)}.rerror{color:var(--rd)}.rrunning{color:var(--yw)}
.si{background:#1a2d4a;border:1px solid #1f4068;border-radius:6px;padding:9px;margin:10px 14px;font-size:12px}
footer{text-align:center;padding:10px;color:var(--dm);font-size:11px}
@media(max-width:680px){main{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>⚡ ZombieCoder MCP</h1>
  <span class="badge bg">LIVE</span>
  <span class="badge bb">:${port}</span>
  <span id="sse-dot">● connecting…</span>
</header>
<main>
  <section><h2>Agent Identity</h2><div id="agent" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section>
    <h2>Dashboard Session</h2>
    <div id="si" class="si">Initialising…</div>
    <div id="sd" class="c"></div>
  </section>
  <section><h2>Providers</h2><div id="pv" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section><h2>MCP Clients &amp; Sessions</h2><div id="cl" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section style="grid-column:1/-1"><h2>Recent Agent Runs</h2><div id="runs" class="c"><p style="color:var(--dm)">loading…</p></div></section>
</main>
<footer>ZombieCoder MCP — Sahon Srabon / Developer Zone / Dhaka, Bangladesh | http://localhost:${port}/v1</footer>
<script>
const B='http://localhost:${port}';
const SK='zc_dashboard_session';
let sid=null;

function stored(){try{const d=JSON.parse(localStorage.getItem(SK)||'null');return d&&Date.now()<d.e?d:null}catch{return null}}
function store(id,e){localStorage.setItem(SK,JSON.stringify({id,e}))}

async function ensureSession(){
  const d=stored();
  if(d){sid=d.id;return}
  const r=await fetch(B+'/session/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_info:{src:'dashboard',ua:navigator.userAgent}})});
  const j=await r.json();
  sid=j.session_id;
  store(sid,Date.now()+86400000);
}

// Heartbeat to keep the 24h dashboard session alive. A real server-push SSE
// stream was tried here first, but mcp-use's global request logger reads
// every response body to completion before allowing it to reach the client —
// for an indefinitely-open stream that never closes, that means the data
// would never arrive at all. A short interval POST achieves the same
// outcome (session stays alive, no expiry) without depending on a stream
// type this server version cannot actually deliver in real time.
function startHeartbeat(){
  if(!sid)return;
  const beat=()=>{
    fetch(B+'/session/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sid})})
      .then(()=>{document.getElementById('sse-dot').textContent='● '+new Date().toLocaleTimeString()})
      .catch(()=>{document.getElementById('sse-dot').textContent='○ heartbeat failed'});
  };
  beat();
  setInterval(beat,25000);
}

async function refresh(){
  try{
    const d=await(await fetch(B+'/status')).json();
    document.getElementById('agent').innerHTML=
      row('Name',d.agent.identity)+row('Owner',d.agent.owner)+
      row('Provider',d.agent.active_provider)+row('Model',d.agent.model)+row('Steps',d.agent.max_steps);
    document.getElementById('si').innerHTML=sid
      ?'<span style="color:var(--gr)">✓ Active</span> — '+sid.slice(0,8)+'…'
      :'<span style="color:var(--rd)">✗ None</span>';
    document.getElementById('pv').innerHTML=d.providers.map(p=>
      '<div class="pv"><span class="dot '+(p.status==='online'?'dg':p.status==='offline'?'dr':'dy')+'"></span>'+
      '<div><div>'+p.name+' <span style="color:var(--dm)">('+p.id+')</span></div>'+
      '<div style="color:var(--dm);font-size:11px">'+p.url+' — '+p.models+' models</div></div></div>'
    ).join('');
    const cl=document.getElementById('cl');
    cl.innerHTML='<div style="color:var(--dm);margin-bottom:6px">MCP live: '+d.mcp_clients.live_connected+' | App sessions: '+d.app_sessions.active+'</div>'+
      d.app_sessions.list.map(s=>'<div class="run"><span style="color:var(--bl)">'+s.id.slice(0,8)+'…</span> '+
      (s.provider||'default')+' | '+(s.directory||'?')+' | '+s.expires_in+'</div>').join('');
    document.getElementById('runs').innerHTML=d.recent_runs.map(r=>
      '<div class="run"><span class="r'+r.status+'">['+r.status+']</span> '+
      String(r.id).slice(0,8)+'… — <span style="color:var(--bl)">'+r.provider_id+'</span>/'+r.model+' — '+r.prompt_preview+'…</div>'
    ).join('')||'<p style="color:var(--dm)">No runs yet</p>';
  }catch(e){document.getElementById('agent').innerHTML='<p style="color:var(--rd)">Server unreachable</p>'}
}

function row(l,v){return'<div class="r"><span class="lb">'+l+'</span><span>'+v+'</span></div>'}

(async()=>{await ensureSession();startHeartbeat();await refresh();setInterval(refresh,15000)})();
</script>
</body></html>`;
}
