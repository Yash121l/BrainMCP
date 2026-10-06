#!/usr/bin/env node
// Seed a local BrainMCP with a believable demo: brain notes and skills, a second user,
// apps (a real public one plus local fakes from fake-apps.mjs), devices and agents,
// access levels, real calls through the gateway, pending approvals, a changed tool
// waiting for review, and a shared app. Run against `wrangler dev` with
// DEV_ALLOW_LOCAL_UPSTREAMS=true. Usage: node scripts/demo/seed.mjs
//   env: BASE (http://localhost:8787), ROOT (root token), APPS (http://127.0.0.1:8790), PERSIST (wrangler state dir)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseNote } from '../../src/parse.js';

const BASE = process.env.BASE || 'http://localhost:8787';
const ROOT = process.env.ROOT || 'local-dev-root-token-0000000000000000';
const APPS = process.env.APPS || 'http://127.0.0.1:8790';
const PERSIST = process.env.PERSIST || '/tmp/claude/brain-local/state';

const log = (...a) => console.log('·', ...a);

// ------------------------------------------------------------------ brain notes (D1 index)

const today = new Date().toISOString().slice(0, 10);
const NOTES = {
  'vault/projects/brainmcp.md': `---\ntype: project\nproject: brainmcp\nstatus: active\nupdated: ${today}\nnext: "Ship the console redesign and the app directory"\n---\n# BrainMCP\n\nOne endpoint for every agent: memory, all my apps, rules and approvals.\n\n## Now\n- Console redesign: Home, Apps, Agents, Activity, Brain, Settings\n- One-click app directory backed by the MCP Registry\n\n## Links\n- [[topics/gateway-design]]\n- [[topics/approvals]]\n`,
  'vault/projects/acme-deal.md': `---\ntype: project\nproject: acme-deal\nstatus: active\nupdated: ${today}\nnext: "Send the revised term sheet by Thursday"\n---\n# Acme Series A\n\nLead: Priya. Round: $12M at $60M post.\n\n## Open questions\n- Liquidation preference: 1x non-participating?\n- Board seat composition\n\nSee [[topics/term-sheet-checklist]].\n`,
  'vault/projects/website.md': `---\ntype: project\nproject: website\nstatus: paused\nupdated: 2026-09-20\n---\n# Website refresh\n\nHero and pricing pages, design in Figma (Website hero).\n`,
  'vault/topics/gateway-design.md': `---\ntype: topic\ntitle: Gateway design\nupdated: ${today}\n---\nEach upstream account is a connection (figma_main, figma_rtp). Agents find tools with search_tools and run them with call_tool. Default deny; forbid wins; critical tools need approval.\n\nRelated: [[topics/approvals]]\n`,
  'vault/topics/approvals.md': `---\ntype: topic\ntitle: Approvals\nupdated: ${today}\n---\nCritical tools (send, merge, pay) always ask. Writes after reading untrusted and private data ask too. Approve from the console or the phone push.\n`,
  'vault/topics/term-sheet-checklist.md': `---\ntype: topic\ntitle: Term sheet checklist\nupdated: 2026-09-28\n---\n- Valuation and option pool\n- Liquidation preference\n- Board composition\n- Pro rata and information rights\n`,
  'vault/logs/decisions.md': `# Decisions\n\n### [2026-09-30] Keep Cloudflare as the platform\n- **Chosen:** Keep Cloudflare as the platform\n- **Why:** one Worker, no servers to run\n- **Project:** [[projects/brainmcp]]\n\n### [${today}] Agents get their own keys\n- **Chosen:** Agents get their own keys\n- **Why:** a console session must never approve its own agent's calls\n- **Project:** [[projects/brainmcp]]\n\n### [${today}] Offer 1x non-participating preference\n- **Chosen:** Offer 1x non-participating preference\n- **Why:** market standard at this stage\n- **Project:** [[projects/acme-deal]]\n`,
  [`vault/logs/sessions/${today}_101500_demo1.md`]: `---\ntype: session\nproject: "[[projects/brainmcp]]"\ndate: ${today}\nsummary: "Designed the app directory and access levels"\nagent: "claude-code"\nmachine: "macbook-pro"\n---\n# Session\n\n## What happened\nDesigned one-click connect and simple access levels.\n`,
  [`vault/logs/sessions/${today}_143000_demo2.md`]: `---\ntype: session\nproject: "[[projects/acme-deal]]"\ndate: ${today}\nsummary: "Read Priya's comments, drafted the reply"\nagent: "codex"\nmachine: "macbook-pro"\n---\n# Session\n\n## What happened\nPulled the thread from Gmail and drafted a reply.\n`,
  'vault/skills.md': '---\ntype: config\n---\n# Skills\n\ndefault: !unslop, prove-it\nacme-deal: default + memo-writing\n',
  'skills/unslop/SKILL.md': '---\nname: unslop\ndescription: Cut AI tells from any writing.\n---\nWrite plainly. No filler, no hype words, short sentences.\n',
  'skills/prove-it/SKILL.md': '---\nname: prove-it\ndescription: Verify every claim before calling work done.\n---\nRun the test, read the output, then say it works.\n',
  'skills/memo-writing/SKILL.md': '---\nname: memo-writing\ndescription: Draft an investment memo in the house structure.\n---\nSections: summary, team, market, product, traction, terms, risks, recommendation.\n',
};

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function seedNotes() {
  const lines = [];
  for (const [path, text] of Object.entries(NOTES)) {
    const n = parseNote(path, text);
    lines.push(`INSERT OR REPLACE INTO notes (path, title, type, project, status, tags, frontmatter, body, updated, indexed_at) VALUES (${[n.path, n.title, n.type, n.project, n.status, n.tags, n.frontmatter, n.body, n.updated].map(q).join(', ')}, datetime('now'));`);
    lines.push(`DELETE FROM links WHERE src = ${q(path)};`, `DELETE FROM fts WHERE path = ${q(path)};`);
    for (const dst of n.links) lines.push(`INSERT OR REPLACE INTO links (src, dst) VALUES (${q(path)}, ${q(dst)});`);
    for (const c of n.chunks) lines.push(`INSERT INTO fts (path, title, heading, text) VALUES (${q(path)}, ${q(n.title)}, ${q(c.heading)}, ${q(c.text)});`);
  }
  const file = '/tmp/claude/brain-demo-notes.sql';
  writeFileSync(file, lines.join('\n'));
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'brain-index', '--local', '--persist-to', PERSIST, `--file=${file}`], { stdio: 'ignore' });
  log(`${Object.keys(NOTES).length} brain notes and skills`);
}

function sql(command) {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'brain-index', '--local', '--persist-to', PERSIST, '--command', command], { stdio: 'ignore' });
}

// ------------------------------------------------------------------ HTTP helpers

async function login(key) {
  const form = new FormData();
  form.set('access_key', key);
  const res = await fetch(`${BASE}/app/login`, { method: 'POST', body: form, redirect: 'manual' });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('brain_session=')) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return cookie;
}
const consoleTool = async (cookie, name, args = {}) => {
  const res = await fetch(`${BASE}/app/api/tool`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ name, args }) });
  return res.json();
};
const mcp = async (token, name, args = {}) => {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await res.json();
  return j.result?.structuredContent ?? j.result ?? j;
};
const must = (r, what) => {
  if (r?.error) throw new Error(`${what}: ${r.error}`);
  return r;
};

async function deviceLogin(cookie, machine, agent, { machine_tags, agent_tags, role = 'write' } = {}) {
  const start = await (await fetch(`${BASE}/device/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine, agent }) })).json();
  must(await consoleTool(cookie, 'gw_device_approve', { user_code: start.user_code, role, agent_tags, machine_tags }), `approve ${agent}@${machine}`);
  const got = await (await fetch(`${BASE}/device/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: start.device_code }) })).json();
  return got.key;
}

// ------------------------------------------------------------------ seed

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) throw new Error(`no BrainMCP at ${BASE}; start wrangler dev first`);
if (!(await fetch(`${APPS}/figma`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' }).then((r) => r.ok).catch(() => false))) {
  throw new Error(`fake apps not running at ${APPS}; start node scripts/demo/fake-apps.mjs`);
}

seedNotes();
await mcp(ROOT, 'whoami');
const yash = await login(ROOT);

const alice = must(await mcp(ROOT, 'admin_create_user', { handle: 'alice', name: 'Alice Chen' }), 'create alice');
const invite = new URL(alice.invite_url).pathname;
await fetch(`${BASE}${invite}`);
const aliceKey = (await (await fetch(`${BASE}${invite}`, { method: 'POST' })).text()).match(/<pre>(bk_[A-Za-z0-9_-]+)<\/pre>/)?.[1];
const aliceCookie = await login(aliceKey);
log('user @alice');

const connect = async (args) => must(await consoleTool(yash, 'gw_connect_app', args), `connect ${args.app_id || args.name}`);
const deepwiki = await connect({ app_id: 'deepwiki' });
const fig1 = await connect({ name: 'Figma', service: 'figma', url: `${APPS}/figma`, auth: 'none', label: 'main', account: 'yash@personal.example', workspace: 'Personal' });
const fig2 = await connect({ name: 'Figma', service: 'figma', url: `${APPS}/figma`, auth: 'none', label: 'rtp', account: 'yash@rtp.vc', workspace: 'RTP Global' });
const gmail = await connect({ name: 'Gmail', service: 'gmail', url: `${APPS}/gmail`, auth: 'none', label: 'rtp', account: 'yash@rtp.vc' });
const slack = await connect({ name: 'Slack', service: 'slack', url: `${APPS}/slack`, auth: 'none', label: 'rtp', workspace: 'RTP Global' });
const linear = await connect({ name: 'Linear', service: 'linear', url: `${APPS}/linear`, auth: 'none', label: 'main', workspace: 'BrainMCP' });
const github = await connect({ name: 'GitHub', service: 'github', url: `${APPS}/github`, auth: 'token', secret: 'ghp_demo_token_not_real_0000000000000000', label: 'main', account: 'Yash121l' });
const granola = await connect({ name: 'Granola', service: 'granola', url: `${APPS}/granola`, auth: 'none', label: 'main', account: 'yash@rtp.vc' });
log('apps: deepwiki, figma x2, gmail, slack, linear, github, granola');

const mbpClaude = await deviceLogin(yash, 'macbook-pro', 'claude-code', { machine_tags: ['laptop', 'trusted'], agent_tags: ['coding'] });
const mbpCodex = await deviceLogin(yash, 'macbook-pro', 'codex', { agent_tags: ['coding'] });
const deskCursor = await deviceLogin(yash, 'work-desktop', 'cursor', { machine_tags: ['desktop'], agent_tags: ['coding'] });
const vpsMail = await deviceLogin(yash, 'vps-agents', 'mail-bot', { machine_tags: ['server', 'headless'], agent_tags: ['mail'] });
log('devices: macbook-pro (claude-code, codex), work-desktop (cursor), vps-agents (mail-bot)');

const machines = await consoleTool(yash, 'gw_machines');
const keyOf = (agent) => machines.machines.flatMap((m) => m.keys).find((k) => k.agent === agent)?.id;
await consoleTool(yash, 'gw_key_update', { id: keyOf('claude-code'), pinned: ['figma_rtp'] });

const access = async (conn, level, ask = false, key_id) => must(await consoleTool(yash, 'gw_set_app_access', { id: conn.id, level, ask, ...(key_id ? { key_id } : {}) }), `access ${conn.connection}`);
await access(gmail, 'read', true);
await access(gmail, 'write', true, keyOf('mail-bot'));
await access(slack, 'write');
await access(linear, 'full', true);
await access(github, 'write', false, keyOf('codex'));
await access(fig1, 'off', false, keyOf('mail-bot'));
log('access levels set');

const call = (key, connection, tool, args = {}) => mcp(key, 'call_tool', { connection, tool, arguments: args });
await call(mbpClaude, 'figma_rtp', 'search_files', { query: 'pitch' });
await call(mbpClaude, 'figma_rtp', 'get_design_context', { fileKey: 'XyZ789', nodeId: '1:2' });
await call(mbpClaude, 'figma_rtp', 'get_screenshot', { fileKey: 'XyZ789', nodeId: '1:2' });
await call(mbpCodex, 'linear_main', 'list_issues', { team: 'BRN' });
await call(mbpCodex, 'github_main', 'list_pull_requests', { repo: 'Yash121l/BrainMCP' });
await call(mbpCodex, 'github_main', 'create_issue', { repo: 'Yash121l/BrainMCP', title: 'Docs: app directory' });
await call(deskCursor, deepwiki.connection, 'read_wiki_structure', { repoName: 'cloudflare/workers-oauth-provider' });
await call(deskCursor, 'figma_main', 'post_comment', { fileKey: 'BrK001', message: 'Use the new blue' });
await call(vpsMail, 'gmail_rtp', 'search_threads', { query: 'term sheet' });
await call(vpsMail, 'gmail_rtp', 'get_thread', { threadId: 't_101' });
await call(vpsMail, 'gmail_rtp', 'get_thread', { threadId: 't_666' });
await call(vpsMail, 'gmail_rtp', 'create_draft', { to: 'priya@acme.example', subject: 'Re: Term sheet comments', body: 'Thursday 3pm works.' });
await call(vpsMail, 'gmail_rtp', 'send_message', { to: 'priya@acme.example', subject: 'Re: Term sheet comments', body: 'Thursday 3pm works.' });
await call(mbpCodex, 'linear_main', 'create_issue', { team: 'BRN', title: 'Phone approvals' });
await call(mbpClaude, 'slack_rtp', 'search_messages', { query: 'Acme' });
await call(vpsMail, 'figma_main', 'search_files', { query: 'brand' });
await call(mbpClaude, 'granola_main', 'list_meetings', { days: 7 });
log('calls made (reads, writes, a denied call, approvals, an injection-flagged email)');

const pending = await consoleTool(yash, 'gw_approvals', { status: 'pending' });
const linearAsk = pending.approvals.find((a) => a.tool === 'create_issue');
if (linearAsk) {
  await consoleTool(yash, 'gw_approval_decide', { id: linearAsk.id, decision: 'approve' });
  await mcp(mbpCodex, 'call_tool', { connection: 'linear_main', tool: 'create_issue', arguments: { team: 'BRN', title: 'Phone approvals' }, approval_id: linearAsk.id });
}
log(`approvals: ${pending.approvals.length} raised, 1 approved and used, the rest waiting for you`);

await fetch(`${APPS}/_change_figma`);
await consoleTool(yash, 'gw_connection_sync', { id: fig1.id });
log('figma_main: one tool changed upstream and waits for review');

await consoleTool(yash, 'gw_connection_share', { id: fig2.id, with: 'alice', tools: ['search_files', 'get_screenshot'] });
await consoleTool(aliceCookie, 'gw_connection_accept', { id: fig2.id });
log('figma_rtp shared with @alice (search_files, get_screenshot)');

sql(`UPDATE connections SET status = 'auth_required', last_error = 'the upstream rejected the stored credential' WHERE id = '${granola.id}'`);
log('granola_main: needs reconnecting (simulated expired sign-in)');

console.log(`\nDone. Open ${BASE} and sign in with: ${ROOT}`);
console.log(`Agent key for testing (claude-code @ macbook-pro): ${mbpClaude}`);
