// Browser UI for the brain: login -> browse/search notes + interactive link graph
// + key management (admin). Served from the Worker at /app. Notes are read-only
// here (writes go through git/MCP); keys are managed here.

import { resolvePrincipal, allowed, isAdmin, createKey, listKeys, revokeKey, sha256hex, randToken } from './auth.js';

async function sessionPrincipal(req, env) {
  const m = (req.headers.get('Cookie') || '').match(/brain_session=([^;]+)/);
  if (!m) return null;
  return resolvePrincipal(env, m[1]);
}

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>brain — login</title>
<style>body{font-family:-apple-system,sans-serif;max-width:24rem;margin:18vh auto;padding:0 1rem;color:#e8e6e3;background:#191919}
input{width:100%;padding:.65rem;font-size:1rem;border-radius:8px;border:1px solid #3a3a3a;background:#222;color:#e8e6e3;box-sizing:border-box}
button{margin-top:.8rem;padding:.65rem 1.5rem;font-size:1rem;border-radius:8px;border:0;background:#7c5cff;color:#fff;cursor:pointer;width:100%}
p{color:#9a9a9a;font-size:.85rem}</style></head>
<body><h2>🧠 brain</h2><form method="POST" action="/app/login">
<input type="password" name="access_key" placeholder="access key" autofocus required>
<button>Enter</button></form>
<p>Any active key works; what you see is what your key is scoped to.</p></body></html>`;

const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>🧠 brain</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/force-graph@1"></script>
<style>
:root{--bg:#191919;--panel:#1f1f1f;--line:#2e2e2e;--fg:#e8e6e3;--dim:#9a9a9a;--acc:#7c5cff;--acc2:#4fb3ff}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{display:flex;gap:.4rem;align-items:center;padding:.5rem .9rem;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:1rem;margin:0 .6rem 0 0;font-weight:700}
header .tab{cursor:pointer;color:var(--dim);padding:.32rem .7rem;border-radius:7px;font-size:.9rem}
header .tab.on{color:var(--fg);background:#2d2d2d}
#q{flex:1;max-width:28rem;margin-left:.5rem;padding:.45rem .8rem;border-radius:8px;border:1px solid var(--line);background:#161616;color:var(--fg);font-size:.9rem}
#who{margin-left:auto;color:var(--dim);font-size:.78rem}
main{flex:1;display:flex;min-height:0}
#side{width:280px;overflow-y:auto;border-right:1px solid var(--line);padding:.5rem .4rem;font-size:.85rem;flex-shrink:0;background:#1c1c1c}
#side details{margin:.1rem 0}
#side summary{color:var(--dim);cursor:pointer;padding:.22rem .5rem;border-radius:6px;font-weight:600;font-size:.76rem;text-transform:uppercase;letter-spacing:.04em;user-select:none;list-style:none;display:flex;justify-content:space-between}
#side summary::-webkit-details-marker{display:none}
#side summary:hover{background:#262626}
#side summary .n{color:#555;font-weight:400}
#side a{display:block;color:var(--fg);text-decoration:none;padding:.16rem .5rem .16rem 1rem;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.84rem}
#side a:hover{background:#282828}#side a.on{background:#31294d;color:#cabfff}
#content{flex:1;min-width:0;position:relative;display:flex;flex-direction:column}
.pane{flex:1;min-height:0;display:none}.pane.on{display:flex;flex-direction:column}
#noteScroll{flex:1;overflow-y:auto;padding:1.3rem 2.2rem}
#noteInner{max-width:52rem}
#crumb{color:var(--dim);font-size:.78rem;margin-bottom:.6rem;font-family:ui-monospace,monospace}
#note h1,#note h2,#note h3{border-bottom:1px solid var(--line);padding-bottom:.25rem}
#note a{color:var(--acc2)}#note code{background:#2a2a2a;padding:.08rem .32rem;border-radius:4px;font-size:.86em}
#note pre{background:#141414;padding:.8rem 1rem;border-radius:10px;overflow-x:auto;border:1px solid var(--line)}
#note pre code{background:none;padding:0}
#note blockquote{border-left:3px solid var(--acc);margin-left:0;padding-left:1rem;color:var(--dim)}
#note table{border-collapse:collapse;display:block;overflow-x:auto}#note td,#note th{border:1px solid var(--line);padding:.32rem .65rem}
#note img{max-width:100%}
.wiki{color:var(--acc);cursor:pointer;border-bottom:1px dotted var(--acc)}
.wiki.dead{color:#777;border-bottom:1px dotted #555;cursor:default}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:1rem}
.chip{background:#252233;border:1px solid #3a3455;color:#bcaFF0;color:#bcaff0;border-radius:20px;padding:.14rem .65rem;font-size:.74rem;max-width:26rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#back{border-top:1px solid var(--line);margin-top:2rem;padding-top:.8rem}
#back h4{color:var(--dim);font-size:.76rem;text-transform:uppercase;letter-spacing:.04em;margin:.2rem 0 .5rem}
#back a{display:inline-block;color:var(--acc2);text-decoration:none;background:#20262e;border-radius:6px;padding:.18rem .55rem;margin:.15rem .25rem .15rem 0;font-size:.8rem}
#graphWrap{position:relative}
#graph{position:absolute;inset:0}
#legend{position:absolute;top:.8rem;right:.9rem;background:rgba(26,26,26,.92);border:1px solid var(--line);border-radius:10px;padding:.6rem .8rem;font-size:.76rem;z-index:4}
#legend div{display:flex;align-items:center;gap:.45rem;margin:.18rem 0;color:var(--dim)}
#legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
#results{position:absolute;top:0;left:0;right:0;background:var(--panel);border-bottom:1px solid var(--line);max-height:55%;overflow-y:auto;z-index:6;display:none;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#results div{padding:.5rem 1rem;cursor:pointer;border-bottom:1px solid #262626}#results div:hover{background:#2c2c2c}
#results .p{color:var(--acc);font-size:.78rem;font-family:ui-monospace,monospace}#results .s{color:var(--dim);font-size:.82rem}
#results b{color:var(--fg)}
/* keys tab */
#keysPane{overflow-y:auto;padding:1.3rem 2.2rem}
#keysPane .wrap{max-width:56rem}
#keysPane table{border-collapse:collapse;width:100%;font-size:.85rem;margin-top:1rem}
#keysPane th{text-align:left;color:var(--dim);font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
#keysPane td,#keysPane th{border-bottom:1px solid var(--line);padding:.45rem .6rem}
#keysPane .rev{color:#777;text-decoration:line-through}
#keysPane .role{border-radius:5px;padding:.1rem .45rem;font-size:.72rem}
.role.admin{background:#442733;color:#ff9db0}.role.write{background:#3c3320;color:#ffd47f}.role.read{background:#1f3230;color:#7fdec9}
#keysPane form{display:grid;grid-template-columns:1.2fr .6fr 2fr .6fr auto;gap:.5rem;align-items:center;background:#1e1e1e;border:1px solid var(--line);border-radius:10px;padding:.8rem}
#keysPane input,#keysPane select{padding:.45rem .6rem;border-radius:7px;border:1px solid var(--line);background:#161616;color:var(--fg);font-size:.85rem}
#keysPane button{padding:.45rem .9rem;border-radius:7px;border:0;background:var(--acc);color:#fff;cursor:pointer}
#keysPane .revoke{background:#3a2626;color:#ff9d9d;border:0;border-radius:6px;padding:.25rem .6rem;cursor:pointer;font-size:.76rem}
#newKey{display:none;margin-top:.9rem;background:#20301f;border:1px solid #2f4b2e;border-radius:10px;padding:.8rem 1rem}
#newKey code{user-select:all;word-break:break-all;color:#a6e3a1}
#keysPane .hint{color:var(--dim);font-size:.8rem;margin-top:.4rem}
</style></head><body>
<header><h1>🧠 brain</h1>
<span class="tab on" data-t="notes">Notes</span><span class="tab" data-t="graph">Graph</span><span class="tab" data-t="keys" id="keysTab" style="display:none">Keys</span>
<input id="q" placeholder="search the brain…  (enter)"><span id="who"></span>
</header>
<main><div id="side"></div><div id="content"><div id="results"></div>
<div class="pane on" id="notesPane"><div id="noteScroll"><div id="noteInner"><div id="crumb"></div><div class="chips" id="chips"></div><div id="note"></div><div id="back"></div></div></div></div>
<div class="pane" id="graphPane"><div id="graphWrap" style="flex:1"><div id="graph"></div><div id="legend"></div></div></div>
<div class="pane" id="keysPane"><div class="wrap">
<h2>Access keys</h2>
<p class="hint">Each key has a role (read / write / admin) and optional path prefixes. Empty prefixes = the whole brain. A project key usually wants: <code>vault/projects/&lt;slug&gt;.md, vault/rules/&lt;slug&gt;.md, vault/topics/, vault/logs/</code>. Keys work everywhere: web login, MCP bearer, claude.ai connector consent.</p>
<form id="keyForm">
<input name="name" placeholder="name (who / why)" required>
<select name="role"><option>read</option><option>write</option><option>admin</option></select>
<input name="prefixes" placeholder="prefixes, comma-sep (empty = all)">
<input name="expires_days" type="number" placeholder="days" min="1">
<button>Create</button>
</form>
<div id="newKey"><b>Key created — copy it now, it is never shown again:</b><br><code id="newKeyVal"></code></div>
<table><thead><tr><th>Name</th><th>Role</th><th>Scope</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody id="keyRows"></tbody></table>
</div></div>
</div></main>
<script>
let NOTES=[],byBase={},byNoExt={},graphInited=false,ME={role:'read'};
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
async function api(p,opt){const r=await fetch('/app/api/'+p,opt);if(r.status===401){location.reload();return null}return r.json()}
function resolve(t){t=t.trim();return byNoExt[t]||byNoExt['vault/'+t]||byBase[t.split('/').pop()]||null}

function renderSide(){
  const groups={};
  for(const n of NOTES){const d=n.path.split('/').slice(0,-1).join('/')||'(root)';(groups[d]=groups[d]||[]).push(n)}
  const open=new Set(['vault/projects','vault/rules','skills']);
  $('#side').innerHTML=Object.keys(groups).sort().map(d=>
    '<details'+(open.has(d)?' open':'')+'><summary><span>'+esc(d)+'</span><span class="n">'+groups[d].length+'</span></summary>'+
    groups[d].map(n=>'<a href="#" data-p="'+esc(n.path)+'">'+esc(n.title||n.path.split('/').pop())+'</a>').join('')+'</details>').join('');
  $('#side').onclick=e=>{const p=e.target.dataset&&e.target.dataset.p;if(p){e.preventDefault();openNote(p)}};
}

async function openNote(path){
  showTab('notes');
  const n=await api('note?path='+encodeURIComponent(path));if(!n||n.error)return;
  document.querySelectorAll('#side a').forEach(a=>a.classList.toggle('on',a.dataset.p===path));
  $('#crumb').textContent=path;
  const fm=n.frontmatter||{};
  $('#chips').innerHTML=Object.entries(fm).filter(([k,v])=>v&&k!=='title').slice(0,8)
    .map(([k,v])=>'<span class="chip">'+esc(k)+': '+esc(typeof v==='string'?v.slice(0,120):JSON.stringify(v))+'</span>').join('');
  let body=n.content.replace(/^---\\n[\\s\\S]*?\\n---\\n/,'');
  body=body.replace(/\\[\\[([^\\]|#\\n]+)(?:#[^\\]|\\n]*)?(?:\\|([^\\]\\n]*))?\\]\\]/g,(m,t,alias)=>{
    const target=resolve(t);const cls=target?'wiki':'wiki dead';
    return '<span class="'+cls+'" data-w="'+esc(t.trim())+'">'+esc(alias||t.trim())+'</span>'});
  $('#note').innerHTML=marked.parse(body);
  $('#note').querySelectorAll('.wiki:not(.dead)').forEach(el=>el.onclick=()=>{const p=resolve(el.dataset.w);if(p)openNote(p)});
  $('#noteScroll').scrollTop=0;
  const bl=await api('backlinks?path='+encodeURIComponent(path));
  $('#back').innerHTML=(bl&&bl.backlinks&&bl.backlinks.length)?'<h4>'+bl.backlinks.length+' backlinks</h4>'+
    bl.backlinks.map(s=>'<a href="#" data-p="'+esc(s)+'">'+esc((NOTES.find(x=>x.path===s)||{}).title||s)+'</a>').join(''):'';
  $('#back').onclick=e=>{const p=e.target.dataset&&e.target.dataset.p;if(p){e.preventDefault();openNote(p)}};
}

function showTab(t){
  document.querySelectorAll('header .tab').forEach(x=>x.classList.toggle('on',x.dataset.t===t));
  $('#notesPane').classList.toggle('on',t==='notes');
  $('#graphPane').classList.toggle('on',t==='graph');
  $('#keysPane').classList.toggle('on',t==='keys');
  if(t==='graph'&&!graphInited)initGraph();
  if(t==='keys')loadKeys();
}

const PALETTE={project:'#7c5cff',topic:'#4fb3ff',session:'#5a5a5a',rules:'#ff6b6b','decision-log':'#ffb84d',reference:'#4dd0a1',index:'#fff176',activity:'#8d8d8d',plan:'#e879f9',note:'#9e9e9e'};
async function initGraph(){
  graphInited=true;
  const g=await api('graph');if(!g)return;
  const deg={};for(const l of g.links){deg[l.source]=(deg[l.source]||0)+1;deg[l.target]=(deg[l.target]||0)+1}
  const adj={};for(const l of g.links){(adj[l.source]=adj[l.source]||new Set()).add(l.target);(adj[l.target]=adj[l.target]||new Set()).add(l.source)}
  const types=[...new Set(g.nodes.map(n=>n.type||'note'))];
  $('#legend').innerHTML=types.map(t=>'<div><i style="background:'+(PALETTE[t]||'#9e9e9e')+'"></i>'+t+'</div>').join('');
  let hover=null;
  const G=ForceGraph()(document.getElementById('graph'))
    .graphData(g).nodeId('id')
    .nodeLabel(n=>n.title+'  ·  '+n.id)
    .nodeVal(n=>1+Math.sqrt(deg[n.id]||0)*1.6)
    .nodeColor(n=>{
      const c=PALETTE[n.type||'note']||'#9e9e9e';
      if(!hover)return c;
      return (n.id===hover.id||(adj[hover.id]&&adj[hover.id].has(n.id)))?c:'#333'})
    .linkColor(l=>hover&&(l.source.id===hover.id||l.target.id===hover.id)?'#8a7ce0':'#2c2c2c')
    .linkWidth(l=>hover&&(l.source.id===hover.id||l.target.id===hover.id)?1.6:.6)
    .onNodeHover(n=>{hover=n||null})
    .backgroundColor('#191919')
    .onNodeClick(n=>openNote(n.id));
  G.d3Force('charge').strength(-42);
}

async function loadKeys(){
  const d=await api('keys');if(!d||d.error)return;
  $('#keyRows').innerHTML=d.keys.map(k=>{
    const scope=k.prefixes.length?k.prefixes.map(esc).join('<br>'):'<i style="color:#666">everything</i>';
    return '<tr class="'+(k.revoked?'rev':'')+'"><td>'+esc(k.name)+'</td><td><span class="role '+k.role+'">'+k.role+'</span></td><td style="font-family:ui-monospace,monospace;font-size:.76rem">'+scope+'</td><td>'+(k.created||'').slice(0,10)+'</td><td>'+(k.expires?k.expires.slice(0,10):'—')+'</td><td>'+(k.last_used?k.last_used.slice(0,16):'never')+'</td><td>'+(k.revoked?'revoked':'<button class="revoke" data-id="'+k.id+'">revoke</button>')+'</td></tr>'}).join('');
  document.querySelectorAll('.revoke').forEach(b=>b.onclick=async()=>{
    if(!confirm('Revoke this key (and every session/connector minted from it)?'))return;
    await api('keys/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.id})});loadKeys()});
}
$('#keyForm').onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const prefixes=(f.get('prefixes')||'').split(',').map(s=>s.trim()).filter(Boolean);
  const r=await api('keys',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:f.get('name'),role:f.get('role'),prefixes,expires_days:f.get('expires_days')||null})});
  if(r&&r.key){$('#newKey').style.display='block';$('#newKeyVal').textContent=r.key;e.target.reset();loadKeys()}
};

document.querySelectorAll('header .tab').forEach(t=>t.onclick=()=>showTab(t.dataset.t));
$('#q').addEventListener('keydown',async e=>{
  if(e.key!=='Enter')return;
  const r=await api('search?q='+encodeURIComponent(e.target.value));if(!r)return;
  $('#results').style.display='block';
  $('#results').innerHTML=r.results.map(x=>'<div data-p="'+esc(x.path)+'"><span class="p">'+esc(x.path)+'</span><br><span class="s">'+x.snippet+'</span></div>').join('')||'<div>no hits</div>';
  $('#results').onclick=ev=>{const p=ev.target.closest('[data-p]');if(p){$('#results').style.display='none';openNote(p.dataset.p)}};
});
document.addEventListener('click',e=>{if(!e.target.closest('#results')&&!e.target.closest('#q'))$('#results').style.display='none'});
(async()=>{
  const me=await api('me');if(me){ME=me;$('#who').textContent=me.name+' · '+me.role;if(me.role==='admin')$('#keysTab').style.display=''}
  const d=await api('notes');if(!d)return;
  NOTES=d.notes;
  for(const n of NOTES){const ne=n.path.replace(/\\.md$/,'');byNoExt[ne]=n.path;byBase[ne.split('/').pop()]=n.path}
  renderSide();
  const start=NOTES.find(n=>n.path==='vault/BRAIN.md')||NOTES[0];if(start)openNote(start.path);
})();
</script></body></html>`;

export async function handleApp(req, env, url) {
  if (!url.pathname.startsWith('/app')) return null;

  if (url.pathname === '/app/login' && req.method === 'POST') {
    const form = await req.formData();
    const principal = await resolvePrincipal(env, form.get('access_key') || '');
    if (!principal) return new Response('invalid or revoked key', { status: 403 });
    const tok = randToken(32);
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, exp, role, prefixes, key_id) VALUES (?, 'access', 'webapp', datetime('now', '+30 days'), ?, ?, ?)"
    ).bind(await sha256hex(tok), principal.role, JSON.stringify(principal.prefixes), principal.keyId || null).run();
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/app',
        'Set-Cookie': `brain_session=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=2592000`,
      },
    });
  }

  const p = await sessionPrincipal(req, env);

  if (url.pathname === '/app') {
    return new Response(p ? APP_HTML : LOGIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (url.pathname.startsWith('/app/api/')) {
    if (!p) return Response.json({ error: 'unauthorized' }, { status: 401 });

    if (url.pathname === '/app/api/me') {
      return Response.json({ role: p.role, name: p.name, prefixes: p.prefixes });
    }
    if (url.pathname === '/app/api/notes') {
      const r = await env.DB.prepare('SELECT path, title, type FROM notes ORDER BY path').all();
      return Response.json({ notes: r.results.filter((n) => allowed(p, n.path)) });
    }
    if (url.pathname === '/app/api/note') {
      const path = url.searchParams.get('path') || '';
      if (!allowed(p, path)) return Response.json({ error: 'forbidden' }, { status: 403 });
      const r = await env.DB.prepare('SELECT path, body, frontmatter FROM notes WHERE path = ?').bind(path).first();
      if (!r) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ path: r.path, content: r.body, frontmatter: JSON.parse(r.frontmatter || '{}') });
    }
    if (url.pathname === '/app/api/backlinks') {
      const path = url.searchParams.get('path') || '';
      if (!allowed(p, path)) return Response.json({ backlinks: [] });
      const noExt = path.replace(/\.md$/, '');
      const noVault = noExt.replace(/^vault\//, '');
      const base = noExt.split('/').pop();
      const r = await env.DB.prepare('SELECT DISTINCT src FROM links WHERE dst IN (?, ?, ?)').bind(noExt, noVault, base).all();
      return Response.json({ backlinks: r.results.map((x) => x.src).filter((s) => allowed(p, s)) });
    }
    if (url.pathname === '/app/api/search') {
      const q = (url.searchParams.get('q') || '').split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      if (!q) return Response.json({ results: [] });
      const r = await env.DB.prepare(
        "SELECT DISTINCT f.path, snippet(fts, 3, '<b>', '</b>', ' … ', 20) AS snippet FROM fts f WHERE fts MATCH ? ORDER BY rank LIMIT 60"
      ).bind(q).all().catch(() => ({ results: [] }));
      return Response.json({ results: r.results.filter((x) => allowed(p, x.path)).slice(0, 20) });
    }
    if (url.pathname === '/app/api/graph') {
      const notes = (await env.DB.prepare('SELECT path, title, type FROM notes').all()).results.filter((n) => allowed(p, n.path));
      const visible = new Set(notes.map((n) => n.path));
      const links = (await env.DB.prepare('SELECT src, dst FROM links').all()).results;
      const byNoExt = new Map(); const byBase = new Map();
      for (const n of notes) {
        const ne = n.path.replace(/\.md$/, '');
        byNoExt.set(ne, n.path);
        const b = ne.split('/').pop();
        if (!byBase.has(b)) byBase.set(b, n.path);
      }
      const edges = [];
      for (const l of links) {
        if (!visible.has(l.src)) continue;
        const t = byNoExt.get(l.dst) || byNoExt.get(`vault/${l.dst}`) || byBase.get(l.dst.split('/').pop());
        if (t && t !== l.src && visible.has(t)) edges.push({ source: l.src, target: t });
      }
      return Response.json({ nodes: notes.map((n) => ({ id: n.path, title: n.title, type: n.type || 'note' })), links: edges });
    }

    // ---- key management (admin only)
    if (url.pathname === '/app/api/keys' && req.method === 'GET') {
      if (!isAdmin(p)) return Response.json({ error: 'admin only' }, { status: 403 });
      return Response.json({ keys: await listKeys(env) });
    }
    if (url.pathname === '/app/api/keys' && req.method === 'POST') {
      if (!isAdmin(p)) return Response.json({ error: 'admin only' }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      try {
        const created = await createKey(env, body);
        return Response.json(created, { status: 201 });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }
    if (url.pathname === '/app/api/keys/revoke' && req.method === 'POST') {
      if (!isAdmin(p)) return Response.json({ error: 'admin only' }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      if (!body.id) return Response.json({ error: 'id required' }, { status: 400 });
      await revokeKey(env, body.id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'unknown api' }, { status: 404 });
  }

  return new Response('not found', { status: 404 });
}
