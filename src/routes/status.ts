import { MCPServer } from "mcp-use/server";
import { config } from "../config.js";
import { getAllProviderStatuses } from "../providers/registry.js";
import { listActiveSessions, createSession, heartbeatSession } from "../session/manager.js";
import {
  findClientSessionByCode,
  approveClientSession,
  rejectClientSession,
  listClientSessions,
  expireStaleClientSessions,
} from "../session/client-session.js";
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
      last_accessed_ms: data.lastAccessedAt,
      last_accessed: new Date(data.lastAccessedAt).toISOString(),
    }));

    // Auth key info (safe — never exposes the actual key)
    const authKeys = [];
    const hasMaster = !!process.env["X_API_KEY"];
    authKeys.push({ label: "master", loaded: hasMaster, scopes: ["admin", "tools:call", "proxy:read", "proxy:write"] });
    for (let i = 1; i <= 10; i++) {
      const raw = process.env[`X_API_KEY_${i}`];
      if (raw) {
        const label = raw.split(":")[0];
        authKeys.push({ label, loaded: true, scopes: ["tools:call"] });
      }
    }

    // Editor detection from client names
    const editors = {
      vscode: liveMcpSessions.filter(s => /vscode|code/i.test(s.client_name)).length,
      intellij: liveMcpSessions.filter(s => /intellij|idea|jetbrains/i.test(s.client_name)).length,
      hermes: liveMcpSessions.filter(s => /hermes/i.test(s.client_name)).length,
      opencode: liveMcpSessions.filter(s => /opencode/i.test(s.client_name)).length,
      other: liveMcpSessions.filter(s => !/vscode|code|intellij|idea|jetbrains|hermes|opencode/i.test(s.client_name)).length,
    };

    return c.json({
      agent: {
        identity: IDENTITY.system_identity.name,
        version: IDENTITY.system_identity.version,
        owner: IDENTITY.system_identity.branding.owner,
        active_provider: config.activeProviderId,
        model: config.agentModel,
        max_steps: config.agentMaxSteps,
      },
      auth: {
        enabled: hasMaster,
        key_count: authKeys.length,
        keys: authKeys,
        encryption: !!process.env["ENCRYPTION_KEY"],
      },
      providers: getAllProviderStatuses().map((p) => ({
        id: p.id,
        name: p.name,
        url: p.baseUrl,
        status: p.status,
        models: p.models.length,
        model_list: Array.isArray(p.models) ? p.models.slice(0, 5) : [],
        last_checked: p.lastCheckedAt ? new Date(p.lastCheckedAt * 1000).toISOString() : null,
      })),
      app_sessions: {
        active: listActiveSessions().length,
        list: listActiveSessions().map((s) => ({
          id: s.id,
          provider: s.providerId,
          directory: s.directory,
          created: s.createdAt ? new Date(s.createdAt * 1000).toISOString() : null,
          expires_in: Math.round((s.expiresAt - Date.now() / 1000) / 60) + "m",
          expired: Date.now() / 1000 > s.expiresAt,
        })),
      },
      mcp_clients: {
        live_connected: liveMcpSessions.length,
        live: liveMcpSessions,
        editors,
        historical: db.prepare(`SELECT * FROM mcp_clients ORDER BY connected_at DESC LIMIT 50`).all(),
      },
      run_stats: db.prepare(`
        SELECT status, COUNT(*) AS count, ROUND(AVG(completed_at - started_at), 1) AS avg_s
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
      system: {
        uptime_sec: Math.round(process.uptime()),
        node: process.version,
        platform: process.platform,
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      server_time: new Date().toISOString(),
    });
  });

  // ── Fast poll endpoint (simpler than SSE through mcp-use's proxy) ─────
  app.get("/live", (c) => {
    const liveMcpSessions = Array.from(server.sessions.entries()).map(([sid, data]) => ({
      session_id: sid,
      client_name: data.clientInfo?.name ?? "unknown",
    }));
    return c.json({
      ts: new Date().toISOString(),
      mcp_clients: liveMcpSessions.length,
      app_sessions: listActiveSessions().length,
      editor_names: [...new Set(liveMcpSessions.map(s => s.client_name))],
      providers: getAllProviderStatuses().map(p => ({ id: p.id, status: p.status })),
      run_stats: getDb().prepare(`SELECT status, COUNT(*) AS count FROM agent_runs GROUP BY status`).all(),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      uptime_sec: Math.round(process.uptime()),
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

  // ── /verify/:code — Browser verification page ──────────────────────────
  app.get("/verify/:code", (c) => {
    const code = c.req.param("code")?.toUpperCase();
    if (!code) return c.text("Missing verification code.", 400);

    const session = findClientSessionByCode(code);
    if (!session) {
      return c.html(`<!DOCTYPE html>
<html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZombieCoder — Verification</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:90%;text-align:center}
.ic{font-size:48px;margin-bottom:16px}
h1{font-size:20px;margin-bottom:8px}
p{color:#8b949e;line-height:1.5}
.btn{display:inline-block;margin-top:16px;padding:10px 24px;border-radius:6px;border:none;cursor:pointer;font-size:14px}
.btn-warn{background:#d29922;color:#fff;text-decoration:none}
</style></head>
<body><div class="card"><div class="ic">⚠️</div>
<h1>Code Expired or Invalid</h1>
<p>This verification code is invalid, expired, or already used.<br>Please reconnect your editor to get a new code.</p>
<a href="/dashboard" class="btn btn-warn">Go to Dashboard</a>
</div></body></html>`);
    }

    const clientName = session.clientName;
    const verifiedAt = session.verifiedAt;
    const isVerified = session.status === "verified";
    const isExpired = session.expiresAt < Math.floor(Date.now() / 1000);

    return c.html(verifyPageHtml(code, clientName, session.clientVersion ?? "", isVerified, isExpired));
  });

  // Approve API
  app.post("/verify/:code/approve", (c) => {
    const code = c.req.param("code")?.toUpperCase();
    if (!code) return c.json({ error: "Missing code" }, 400);

    const session = findClientSessionByCode(code);
    if (!session) return c.json({ error: "Invalid or expired code" }, 404);
    if (session.expiresAt < Math.floor(Date.now() / 1000)) {
      return c.json({ error: "Code expired" }, 410);
    }

    const ok = approveClientSession(session.id);
    return c.json({
      ok,
      client: session.clientName,
      client_id: session.clientId,
      status: "verified",
      ts: new Date().toISOString(),
    });
  });

  // Reject API
  app.post("/verify/:code/reject", (c) => {
    const code = c.req.param("code")?.toUpperCase();
    if (!code) return c.json({ error: "Missing code" }, 400);

    const session = findClientSessionByCode(code);
    if (!session) return c.json({ error: "Invalid code" }, 404);

    const ok = rejectClientSession(session.id);
    return c.json({
      ok,
      client: session.clientName,
      status: "disconnected",
      ts: new Date().toISOString(),
    });
  });

  // ── /verify — list all pending verifications ───────────────────────────
  app.get("/verify", (c) => {
    const all = listClientSessions();
    return c.json({
      pending: all.filter(s => s.status === "pending").length,
      verified: all.filter(s => s.status === "verified").length,
      disconnected: all.filter(s => s.status === "disconnected").length,
      sessions: all.map(s => ({
        id: s.id.slice(0, 8) + "…",
        client: s.clientName,
        version: s.clientVersion,
        status: s.status,
        code: s.verificationCode,
        connected: new Date(s.connectedAt * 1000).toISOString(),
        expires: new Date(s.expiresAt * 1000).toISOString(),
      })),
      ts: new Date().toISOString(),
    });
  });
}

function dashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZombieCoder MCP — Live Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--sf:#161b22;--bd:#30363d;--gr:#3fb950;--rd:#f85149;--yw:#d29922;--bl:#58a6ff;--tx:#c9d1d9;--dm:#8b949e;--fn:'JetBrains Mono','Fira Code',monospace}
body{background:var(--bg);color:var(--tx);font-family:var(--fn);font-size:13px}
header{background:var(--sf);border-bottom:1px solid var(--bd);padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:15px;color:var(--gr);letter-spacing:1px}
.badge{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}
.bg{background:#1a4731;color:var(--gr)}.bb{background:#1a2d4a;color:var(--bl)}.br{background:#4a1a1a;color:var(--rd)}
#sse-dot{margin-left:auto;font-size:11px;color:var(--dm);min-width:120px;text-align:right}
main{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;padding:14px}
@media(max-width:960px){main{grid-template-columns:1fr 1fr}}
@media(max-width:640px){main{grid-template-columns:1fr}}
section{background:var(--sf);border:1px solid var(--bd);border-radius:8px;overflow:hidden}
section h2{padding:9px 14px;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--bd);color:var(--bl);display:flex;justify-content:space-between;align-items:center}
.c{padding:12px 14px}
.r{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d}
.r:last-child{border:none}.lb{color:var(--dm)}
.pv{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #21262d}
.pv:last-child{border:none}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dg{background:var(--gr)}.dr{background:var(--rd)}.dy{background:var(--dm)}.db{background:var(--bl)}
.run{padding:5px 0;border-bottom:1px solid #21262d;font-size:12px}.run:last-child{border:none}
.rsuccess{color:var(--gr)}.rerror{color:var(--rd)}.rrunning{color:var(--yw)}
.si{background:#1a2d4a;border:1px solid #1f4068;border-radius:6px;padding:9px;margin:10px 14px;font-size:12px}.si span{font-weight:700}
.cl-box{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.cl-editor{padding:4px 10px;border-radius:12px;font-size:11px;background:#1a2d4a;border:1px solid #1f4068}
.cl-count{font-weight:700;color:var(--bl)}
footer{text-align:center;padding:10px;color:var(--dm);font-size:11px}
.warn{color:var(--rd);font-weight:700}
.ok{color:var(--gr)}
</style>
</head>
<body>
<header>
  <h1>⚡ ZombieCoder MCP</h1>
  <span class="badge bg" id="live-badge">LIVE</span>
  <span class="badge bb">:${port}</span>
  <span id="conn-count" class="badge br">0 clients</span>
  <span id="sse-dot">● connecting…</span>
</header>
<main>
  <section><h2>Agent Identity</h2><div id="agent" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section><h2>Dashboard Session</h2><div id="si" class="si">Initialising…</div><div id="sd" class="c"></div></section>
  <section><h2>🔐 Authentication</h2><div id="auth" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section style="grid-column:1/-1"><h2>Providers &amp; Models <span id="prov-count" style="color:var(--dm);font-size:11px">0 online</span></h2><div id="pv" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section><h2>MCP Clients <span id="mcp-count" style="color:var(--dm);font-size:11px">0</span></h2><div id="cl" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section><h2>System <span style="color:var(--dm);font-size:11px">node ${process.version}</span></h2><div id="sys" class="c"><p style="color:var(--dm)">loading…</p></div></section>
  <section style="grid-column:1/-1"><h2>Recent Agent Runs</h2><div id="runs" class="c"><p style="color:var(--dm)">loading…</p></div></section>
</main>
<footer>ZombieCoder MCP — Sahon Srabon / Developer Zone / Dhaka, Bangladesh | <span id="uptime"></span></footer>
<script>
const B='http://localhost:${port}';
const SK='zc_dashboard_session';
let sid=null;
let liveSource=null;

function stored(){try{const d=JSON.parse(localStorage.getItem(SK)||'null');return d&&Date.now()<d.e?d:null}catch{return null}}
function store(id,e){localStorage.setItem(SK,JSON.stringify({id,e}))}

async function ensureSession(){
  const d=stored();
  if(d){sid=d.id;document.getElementById('si').innerHTML='<span class="ok">✓ Session restored</span> — '+sid.slice(0,8)+'…';return}
  try{
    const r=await fetch(B+'/session/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_info:{src:'dashboard',ua:navigator.userAgent}})});
    const j=await r.json();
    sid=j.session_id;
    store(sid,Date.now()+86400000);
    document.getElementById('si').innerHTML='<span class="ok">✓ New session</span> — '+sid.slice(0,8)+'…';
  }catch(e){
    document.getElementById('si').innerHTML='<span class="warn">✗ Session failed</span>';
  }
}

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

function row(l,v){return'<div class="r"><span class="lb">'+l+'</span><span>'+v+'</span></div>'}

async function refresh(){
  try{
    const d=await(await fetch(B+'/status')).json();

    // Agent
    document.getElementById('agent').innerHTML=
      row('Identity',d.agent.identity+' v'+d.agent.version)+
      row('Owner',d.agent.owner)+
      row('Active Provider',d.agent.active_provider)+
      row('Model',d.agent.model)+
      row('Max Steps',d.agent.max_steps);

    // Auth
    const authHtml=d.auth.enabled
      ? '<div class="ok" style="margin-bottom:6px">✓ Auth enabled — '+d.auth.key_count+' key(s) loaded</div>'+
        d.auth.keys.map(k=>'<div class="run"><span class="ok">●</span> '+k.label+' <span style="color:var(--dm)">['+k.scopes.join(', ')+']</span></div>').join('')+
        '<div class="r" style="margin-top:6px"><span class="lb">Encryption</span><span>'+(d.auth.encryption?'<span class="ok">✓ AES-256-GCM</span>':'<span class="warn">✗ Not configured</span>')+'</span></div>'
      : '<div class="warn">✗ Auth DISABLED — server is OPEN. Set X_API_KEY in .env</div>';
    document.getElementById('auth').innerHTML=authHtml;

    // Providers
    const online=d.providers.filter(p=>p.status==='online').length;
    document.getElementById('prov-count').textContent=online+'/'+d.providers.length+' online';
    document.getElementById('pv').innerHTML=d.providers.map(p=>
      '<div class="pv"><span class="dot '+(p.status==='online'?'dg':p.status==='offline'?'dr':'dy')+'"></span>'+
      '<div style="flex:1"><div>'+p.name+' <span style="color:var(--dm)">('+p.id+')</span></div>'+
      '<div style="color:var(--dm);font-size:11px">'+p.url+'<br>Models: '+
      (p.model_list.length?p.model_list.join(', ')+(p.models>5?' <span style="color:var(--bl)">+'+ (p.models-5) +' more</span>':''):'<span style="color:var(--rd)">none</span>')+
      '</div></div><div style="font-size:11px;color:var(--dm);text-align:right">'+(p.last_checked?new Date(p.last_checked).toLocaleTimeString()+'':'')+'</div></div>'
    ).join('');

    // MCP Clients
    document.getElementById('mcp-count').textContent=d.mcp_clients.live_connected+' live';
    const cl=d.mcp_clients;
    document.getElementById('conn-count').textContent=cl.live_connected+' clients';
    const editors=d.mcp_clients.editors||{};
    let editorHtml='<div class="cl-box">'+
      (editors.vscode?'<div class="cl-editor"><span class="cl-count">'+editors.vscode+'</span> VS Code</div>':'')+
      (editors.intellij?'<div class="cl-editor"><span class="cl-count">'+editors.intellij+'</span> IntelliJ</div>':'')+
      (editors.hermes?'<div class="cl-editor"><span class="cl-count">'+editors.hermes+'</span> Hermes</div>':'')+
      (editors.opencode?'<div class="cl-editor"><span class="cl-count">'+editors.opencode+'</span> OpenCode</div>':'')+
      (editors.other?'<div class="cl-editor"><span class="cl-count">'+editors.other+'</span> Other</div>':'')+
    '</div>';
    document.getElementById('cl').innerHTML=editorHtml+
      (cl.live.length?cl.live.map(s=>
        '<div class="run"><span class="ok">●</span> '+
        (s.client_name!=='unknown'?'<span style="color:var(--bl)">'+s.client_name+' '+s.client_version+'</span> ':'<span style="color:var(--dm)">unknown</span> ')+
        '<span style="color:var(--dm);font-size:11px">'+s.session_id.slice(0,8)+'…</span>'+
        '</div>'
      ).join('')+'<div style="color:var(--dm);font-size:11px;margin-top:6px">App sessions: '+d.app_sessions.active+'</div>':'<p style="color:var(--dm)">No live clients</p>')+
      d.app_sessions.list.slice(0,5).map(s=>'<div class="run" style="font-size:11px"><span style="color:var(--bl)">'+s.id.slice(0,8)+'…</span> '+
      (s.provider||'default')+' | '+(s.directory||'?')+' | '+s.expires_in+(s.expired?' <span class="warn">expired</span>':'')+'</div>').join('');

    // System
    document.getElementById('sys').innerHTML=
      row('Uptime',Math.floor(d.system.uptime_sec/60)+'m '+d.system.uptime_sec%60+'s')+
      row('Node.js',d.system.node)+
      row('Platform',d.system.platform)+
      row('Heap Used',d.system.memory_mb+' MB')+
      row('Server Time',new Date(d.server_time).toLocaleString());
    document.getElementById('uptime').textContent='Uptime: '+Math.floor(d.system.uptime_sec/60)+'m';

    // Runs
    document.getElementById('runs').innerHTML=d.recent_runs.length?
      d.recent_runs.map(r=>
        '<div class="run"><span class="r'+r.status+'">['+r.status+']</span> '+
        String(r.id).slice(0,8)+'… — <span style="color:var(--bl)">'+r.provider_id+'</span>/'+r.model+' — '+r.prompt_preview+'…</div>'
      ).join('')
      :'<p style="color:var(--dm)">No runs yet</p>';

    // Live badge
    document.getElementById('live-badge').textContent='LIVE';
  }catch(e){
    document.getElementById('agent').innerHTML='<p style="color:var(--rd)">⚠ Server unreachable — check if port '+${port}+' is running</p>';
    document.getElementById('live-badge').textContent='OFFLINE';
  }
}

(async()=>{
  await ensureSession();
  startHeartbeat();
  await refresh();
  // Fast refresh for real-time feel (every 3s instead of 15s)
  setInterval(refresh,3000);
})();
</script>
</body></html>`;
}

function verifyPageHtml(
  code: string,
  clientName: string,
  clientVersion: string,
  isVerified: boolean,
  isExpired: boolean,
): string {
  if (isVerified) {
    return `<!DOCTYPE html>
<html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>✓ Verified — ZombieCoder</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:90%;text-align:center}
.ic{font-size:48px;margin-bottom:16px}
h1{font-size:20px;margin-bottom:8px;color:#3fb950}
p{color:#8b949e;line-height:1.5;margin-bottom:8px}
.detail{color:#58a6ff;font-weight:700}
.btn{display:inline-block;margin-top:16px;padding:10px 24px;border-radius:6px;border:none;cursor:pointer;font-size:14px;text-decoration:none}
.btn-primary{background:#238636;color:#fff}
</style></head>
<body><div class="card"><div class="ic">✅</div>
<h1>Client Verified!</h1>
<p><span class="detail">${escHtml(clientName)} ${escHtml(clientVersion)}</span> is now connected and verified.</p>
<p>You can close this tab and return to your editor.</p>
<a href="/dashboard" class="btn btn-primary">Go to Dashboard</a>
</div></body></html>`;
  }

  if (isExpired) {
    return `<!DOCTYPE html>
<html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Expired — ZombieCoder</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:90%;text-align:center}
.ic{font-size:48px;margin-bottom:16px}
h1{font-size:20px;margin-bottom:8px;color:#d29922}
p{color:#8b949e;line-height:1.5}
.btn{display:inline-block;margin-top:16px;padding:10px 24px;border-radius:6px;border:none;cursor:pointer;font-size:14px;text-decoration:none}
.btn-warn{background:#d29922;color:#fff}
</style></head>
<body><div class="card"><div class="ic">⏰</div>
<h1>Verification Expired</h1>
<p>This verification code has expired. Please reconnect your editor to generate a new one.</p>
<a href="/dashboard" class="btn btn-warn">Dashboard</a>
</div></body></html>`;
  }

  // Pending — show approve/reject
  return `<!DOCTYPE html>
<html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve Client — ZombieCoder</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:90%;text-align:center}
.ic{font-size:48px;margin-bottom:16px}
h1{font-size:20px;margin-bottom:4px}
.code{font-size:32px;letter-spacing:6px;color:#58a6ff;font-weight:700;margin:12px 0;font-family:'Courier New',monospace}
p{color:#8b949e;line-height:1.5;margin-bottom:4px}
.client-name{color:#c9d1d9;font-weight:700}
.btn-group{display:flex;gap:12px;justify-content:center;margin-top:20px}
.btn{padding:12px 32px;border-radius:8px;border:none;cursor:pointer;font-size:15px;font-weight:600;transition:opacity .2s}
.btn:hover{opacity:.9}
.btn-approve{background:#238636;color:#fff}
.btn-reject{background:#da3633;color:#fff}
.status{padding:8px 16px;border-radius:6px;margin-top:16px;font-size:13px;display:none}
.status-ok{background:#1a4731;color:#3fb950;border:1px solid #238636}
.status-err{background:#4a1a1a;color:#f85149;border:1px solid #da3633}
</style></head>
<body>
<div class="card">
  <div class="ic">🔌</div>
  <h1>Approve Client Connection</h1>
  <p>A client wants to connect to <span style="color:#3fb950">ZombieCoder MCP</span>:</p>
  <div class="code">${escHtml(code)}</div>
  <p class="client-name">${escHtml(clientName)} ${escHtml(clientVersion)}</p>
  <p style="font-size:13px;color:#8b949e">Only approve if you recognise this client and initiated this connection.</p>

  <div class="btn-group">
    <button class="btn btn-approve" onclick="approve('${escHtml(code)}')">✓ Approve</button>
    <button class="btn btn-reject" onclick="reject('${escHtml(code)}')">✗ Reject</button>
  </div>

  <div id="status" class="status"></div>
</div>

<script>
async function approve(code) {
  const btn = document.querySelector('.btn-approve');
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    const r = await fetch('/verify/' + code + '/approve', { method: 'POST' });
    const j = await r.json();
    if (j.ok) {
      showStatus('✓ Verified! You can close this tab.', 'ok');
      btn.textContent = '✓ Approved';
    } else {
      showStatus('✗ ' + (j.error || 'Approval failed'), 'err');
      btn.disabled = false; btn.textContent = '✓ Approve';
    }
  } catch(e) {
    showStatus('✗ Network error: ' + e.message, 'err');
    btn.disabled = false; btn.textContent = '✓ Approve';
  }
}
async function reject(code) {
  const btn = document.querySelector('.btn-reject');
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    const r = await fetch('/verify/' + code + '/reject', { method: 'POST' });
    const j = await r.json();
    if (j.ok) {
      showStatus('✗ Disconnected. Client rejected.', 'err');
      btn.textContent = '✗ Rejected';
    } else {
      showStatus('✗ ' + (j.error || 'Rejection failed'), 'err');
      btn.disabled = false; btn.textContent = '✗ Reject';
    }
  } catch(e) {
    showStatus('✗ Network error: ' + e.message, 'err');
    btn.disabled = false; btn.textContent = '✗ Reject';
  }
}
function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status status-' + type;
  el.style.display = 'block';
}
</script>
</body></html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
