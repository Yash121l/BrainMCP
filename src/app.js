// Browser UI for the brain: login -> browse/search notes + interactive link graph.
// Served straight from the Worker at /app. Read-only (writes go through git/MCP).

import { validOauthToken } from './oauth.js';

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const rand = (n = 32) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function sessionOk(req, env) {
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(/brain_session=([^;]+)/);
  if (!m) return false;
  return validOauthToken(env, m[1]);
}

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>brain — login</title>
<style>body{font-family:-apple-system,sans-serif;max-width:24rem;margin:18vh auto;padding:0 1rem;color:#e8e6e3;background:#191919}
input{width:100%;padding:.65rem;font-size:1rem;border-radius:8px;border:1px solid #3a3a3a;background:#222;color:#e8e6e3;box-sizing:border-box}
button{margin-top:.8rem;padding:.65rem 1.5rem;font-size:1rem;border-radius:8px;border:0;background:#7c5cff;color:#fff;cursor:pointer;width:100%}</style></head>
<body><h2>🧠 brain</h2><form method="POST" action="/app/login">
<input type="password" name="access_key" placeholder="access key (BRAIN_TOKEN)" autofocus required>
<button>Enter</button></form></body></html>`;

const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>🧠 brain</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/force-graph@1"></script>
<style>
:root{--bg:#191919;--panel:#202020;--line:#333;--fg:#e8e6e3;--dim:#9a9a9a;--acc:#7c5cff}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,sans-serif;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{display:flex;gap:.8rem;align-items:center;padding:.5rem .9rem;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:1rem;margin:0}header input{flex:1;max-width:26rem;padding:.45rem .7rem;border-radius:8px;border:1px solid var(--line);background:#161616;color:var(--fg)}
header .tab{cursor:pointer;color:var(--dim);padding:.3rem .6rem;border-radius:6px}header .tab.on{color:var(--fg);background:#2c2c2c}
main{flex:1;display:flex;min-height:0}
#side{width:270px;overflow-y:auto;border-right:1px solid var(--line);padding:.5rem;font-size:.85rem;flex-shrink:0}
#side .dir{color:var(--dim);margin:.6rem 0 .15rem;font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
#side a{display:block;color:var(--fg);text-decoration:none;padding:.14rem .4rem;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#side a:hover,#side a.on{background:#2c2c2c}
#content{flex:1;min-width:0;position:relative}
#note{height:100%;overflow-y:auto;padding:1.2rem 2rem;display:none;max-width:52rem}
#note.on{display:block}
#graph{height:100%;display:none}#graph.on{display:block}
#note h1,#note h2,#note h3{border-bottom:1px solid var(--line);padding-bottom:.2rem}
#note a{color:var(--acc)}#note code{background:#2a2a2a;padding:.1rem .3rem;border-radius:4px}
#note pre{background:#141414;padding:.8rem;border-radius:8px;overflow-x:auto}
#note blockquote{border-left:3px solid var(--acc);margin-left:0;padding-left:1rem;color:var(--dim)}
#note table{border-collapse:collapse}#note td,#note th{border:1px solid var(--line);padding:.3rem .6rem}
.wiki{color:var(--acc);cursor:pointer;text-decoration:underline dotted}
#results{position:absolute;top:0;left:0;right:0;background:var(--panel);border-bottom:1px solid var(--line);max-height:50%;overflow-y:auto;z-index:5;display:none}
#results div{padding:.5rem .9rem;cursor:pointer;border-bottom:1px solid #262626}#results div:hover{background:#2c2c2c}
#results .p{color:var(--acc);font-size:.8rem}#results .s{color:var(--dim);font-size:.82rem}
.fm{color:var(--dim);font-size:.8rem;background:#141414;border-radius:8px;padding:.6rem .9rem;margin-bottom:1rem;white-space:pre-wrap}
</style></head><body>
<header><h1>🧠 brain</h1>
<span class="tab on" id="tabNotes">Notes</span><span class="tab" id="tabGraph">Graph</span>
<input id="q" placeholder="search the brain…  (enter)">
</header>
<main><div id="side"></div><div id="content"><div id="results"></div><div id="note" class="on"></div><div id="graph"></div></div></main>
<script>
let NOTES=[], byBase={}, byNoExt={}, graphInited=false, Graph;
const $=s=>document.querySelector(s);
async function api(p){const r=await fetch('/app/api/'+p);if(r.status===401){location.href='/app';return null}return r.json()}
function resolve(t){t=t.trim();return byNoExt[t]||byNoExt['vault/'+t]||byBase[t.split('/').pop()]||null}
function renderSide(){
  const groups={};
  for(const n of NOTES){const d=n.path.split('/').slice(0,-1).join('/')||'(root)';(groups[d]=groups[d]||[]).push(n)}
  $('#side').innerHTML=Object.keys(groups).sort().map(d=>'<div class="dir">'+d+'</div>'+groups[d].map(n=>'<a href="#" data-p="'+n.path+'">'+(n.title||n.path.split('/').pop())+'</a>').join('')).join('');
  $('#side').onclick=e=>{const p=e.target.dataset&&e.target.dataset.p;if(p){e.preventDefault();openNote(p)}};
}
async function openNote(path){
  showTab('notes');
  const n=await api('note?path='+encodeURIComponent(path));if(!n)return;
  document.querySelectorAll('#side a').forEach(a=>a.classList.toggle('on',a.dataset.p===path));
  let body=n.content.replace(/^---\\n[\\s\\S]*?\\n---\\n/,'');
  body=body.replace(/\\[\\[([^\\]|#\\n]+)(?:#[^\\]|\\n]*)?(?:\\|([^\\]\\n]*))?\\]\\]/g,(m,t,alias)=>'<span class="wiki" data-w="'+t.trim()+'">'+(alias||t.trim())+'</span>');
  const fm=Object.entries(n.frontmatter||{}).map(([k,v])=>k+': '+(typeof v==='string'?v:JSON.stringify(v))).join('\\n');
  $('#note').innerHTML=(fm?'<div class="fm">'+fm+'</div>':'')+marked.parse(body);
  $('#note').scrollTop=0;
  $('#note').querySelectorAll('.wiki').forEach(el=>el.onclick=()=>{const p=resolve(el.dataset.w);if(p)openNote(p)});
}
function showTab(t){
  $('#tabNotes').classList.toggle('on',t==='notes');$('#tabGraph').classList.toggle('on',t==='graph');
  $('#note').classList.toggle('on',t==='notes');$('#graph').classList.toggle('on',t==='graph');
  if(t==='graph'&&!graphInited)initGraph();
}
async function initGraph(){
  graphInited=true;
  const g=await api('graph');if(!g)return;
  Graph=ForceGraph()(document.getElementById('graph'))
    .graphData(g).nodeId('id').nodeLabel(n=>n.title+' ('+n.id+')')
    .nodeAutoColorBy('type').nodeRelSize(4)
    .linkColor(()=>'#3a3a3a').backgroundColor('#191919')
    .onNodeClick(n=>openNote(n.id));
}
$('#tabNotes').onclick=()=>showTab('notes');$('#tabGraph').onclick=()=>showTab('graph');
$('#q').addEventListener('keydown',async e=>{
  if(e.key!=='Enter')return;
  const r=await api('search?q='+encodeURIComponent(e.target.value));if(!r)return;
  $('#results').style.display='block';
  $('#results').innerHTML=r.results.map(x=>'<div data-p="'+x.path+'"><span class="p">'+x.path+'</span><br><span class="s">'+x.snippet+'</span></div>').join('')||'<div>no hits</div>';
  $('#results').onclick=ev=>{const p=ev.target.closest('[data-p]');if(p){$('#results').style.display='none';openNote(p.dataset.p)}};
});
document.addEventListener('click',e=>{if(!e.target.closest('#results')&&!e.target.closest('#q'))$('#results').style.display='none'});
(async()=>{
  const d=await api('notes');if(!d)return;
  NOTES=d.notes;
  for(const n of NOTES){const ne=n.path.replace(/\\.md$/,'');byNoExt[ne]=n.path;byBase[ne.split('/').pop()]=n.path}
  renderSide();
  const brain=NOTES.find(n=>n.path==='vault/BRAIN.md');if(brain)openNote(brain.path);
})();
</script></body></html>`;

export async function handleApp(req, env, url) {
  if (!url.pathname.startsWith('/app')) return null;

  if (url.pathname === '/app/login' && req.method === 'POST') {
    const form = await req.formData();
    if ((form.get('access_key') || '') !== env.BRAIN_TOKEN) return new Response('wrong key', { status: 403 });
    const tok = rand(32);
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, exp) VALUES (?, 'access', 'webapp', datetime('now', '+30 days'))"
    ).bind(await sha256hex(tok)).run();
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/app',
        'Set-Cookie': `brain_session=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=2592000`,
      },
    });
  }

  const ok = await sessionOk(req, env);

  if (url.pathname === '/app') {
    return new Response(ok ? APP_HTML : LOGIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (url.pathname.startsWith('/app/api/')) {
    if (!ok) return Response.json({ error: 'unauthorized' }, { status: 401 });

    if (url.pathname === '/app/api/notes') {
      const r = await env.DB.prepare('SELECT path, title, type FROM notes ORDER BY path').all();
      return Response.json({ notes: r.results });
    }
    if (url.pathname === '/app/api/note') {
      const r = await env.DB.prepare('SELECT path, body, frontmatter FROM notes WHERE path = ?').bind(url.searchParams.get('path') || '').first();
      if (!r) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ path: r.path, content: r.body, frontmatter: JSON.parse(r.frontmatter || '{}') });
    }
    if (url.pathname === '/app/api/search') {
      const q = (url.searchParams.get('q') || '').split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      if (!q) return Response.json({ results: [] });
      const r = await env.DB.prepare(
        "SELECT DISTINCT f.path, snippet(fts, 3, '<b>', '</b>', ' … ', 20) AS snippet FROM fts f WHERE fts MATCH ? ORDER BY rank LIMIT 20"
      ).bind(q).all().catch(() => ({ results: [] }));
      return Response.json({ results: r.results });
    }
    if (url.pathname === '/app/api/graph') {
      const notes = (await env.DB.prepare('SELECT path, title, type FROM notes').all()).results;
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
        const t = byNoExt.get(l.dst) || byNoExt.get(`vault/${l.dst}`) || byBase.get(l.dst.split('/').pop());
        if (t && t !== l.src) edges.push({ source: l.src, target: t });
      }
      return Response.json({ nodes: notes.map((n) => ({ id: n.path, title: n.title, type: n.type || 'note' })), links: edges });
    }
    return Response.json({ error: 'unknown api' }, { status: 404 });
  }

  return new Response('not found', { status: 404 });
}
