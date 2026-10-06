import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIGMA_TOOLS, GMAIL_TOOLS, SECRET, bootstrap, consoleTool, fakeUpstream, rawTool, tool, createKey, allText } from './helpers/gateway-harness.mjs';
import { FEATURED } from '../src/catalog.js';

const REGISTRY = (servers) => async (req) => {
  const u = new URL(req.url);
  if (u.pathname !== '/v0/servers') return new Response('no', { status: 404 });
  return Response.json({ servers: servers.map((server) => ({ server })), metadata: {} });
};

test('catalog: every featured app is https, unique, and says how it signs in', () => {
  const ids = new Set();
  for (const a of FEATURED) {
    assert.match(a.url, /^https:\/\//, a.id);
    assert.ok(['oauth', 'token', 'app', 'none', 'restricted'].includes(a.auth), a.id);
    if (a.auth === 'restricted') assert.ok(a.note, `${a.id} explains why it is restricted`);
    assert.ok(!ids.has(a.id), `duplicate ${a.id}`);
    ids.add(a.id);
    if (a.auth === 'token' || a.auth === 'app') assert.ok(a.token_help && a.token_url, `${a.id} needs setup help`);
  }
});

test('gw_catalog marks connected apps and searches the MCP Registry for remote servers only', async () => {
  const deepwiki = fakeUpstream({ tools: [{ name: 'read_wiki_structure', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], auth: () => true });
  const { env, cookie } = await bootstrap({
    'mcp.deepwiki.com': deepwiki.handler,
    'registry.modelcontextprotocol.io': REGISTRY([
      { name: 'io.example/notes', description: 'Notes app', remotes: [{ type: 'streamable-http', url: 'https://mcp.notes.example/mcp' }] },
      { name: 'io.example/local', description: 'stdio only', packages: [{ registryType: 'npm' }] },
      { name: 'io.example/keyed', description: 'API key app', remotes: [{ type: 'streamable-http', url: 'https://mcp.keyed.example/mcp', headers: [{ name: 'X-Api-Key', isSecret: true }] }] },
      { name: 'io.example/templated', remotes: [{ type: 'streamable-http', url: 'https://{tenant}.example/mcp' }] },
    ]),
  });
  const before = await consoleTool(env, cookie, 'gw_catalog');
  assert.ok(before.featured.length >= 30);
  assert.deepEqual(before.registry, []);
  const r = await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'deepwiki' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.connection, 'deepwiki_main');
  const after = await consoleTool(env, cookie, 'gw_catalog', { query: 'notes' });
  assert.deepEqual(after.featured.find((a) => a.id === 'deepwiki').connected.map((c) => c.connection), ['deepwiki_main']);
  assert.deepEqual(after.registry.map((x) => [x.name, x.auth, x.header_name]), [['notes', 'detect', null], ['keyed', 'token', 'X-Api-Key']]);
  assert.match(after.redirect_uri, /\/connect\/callback$/);
});

test('one-click connect: none is instant, token asks for the token, app asks for an OAuth client, labels auto-number', async () => {
  const deepwiki = fakeUpstream({ tools: [{ name: 'read_wiki_structure', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], auth: () => true });
  const gh = fakeUpstream({ tools: FIGMA_TOOLS });
  const { env, cookie, agent } = await bootstrap({ 'mcp.deepwiki.com': deepwiki.handler, 'api.githubcopilot.com': (req, rec) => gh.handler(new Request(req.url.replace('/mcp/', '/mcp'), req), rec) });
  assert.equal((await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'deepwiki' })).connection, 'deepwiki_main');
  assert.equal((await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'deepwiki' })).connection, 'deepwiki_main2');
  assert.equal((await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'deepwiki', label: 'work' })).connection, 'deepwiki_work');

  const needToken = await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'github' });
  assert.equal(needToken.needs, 'token');
  assert.match(needToken.token_url, /github\.com/);
  const needApp = await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'slack' });
  assert.equal(needApp.needs, 'app');
  assert.match(needApp.redirect_uri, /\/connect\/callback$/);

  const r = await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'github', secret: SECRET });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!allText(env).includes(SECRET));
  const list = await tool(env, agent, 'list_connections');
  assert.ok(list.connections.some((c) => c.connection === 'github_main'));
  const shot = await rawTool(env, agent, 'call_tool', { connection: 'github_main', tool: 'get_screenshot', arguments: {} });
  assert.equal(shot.isError, false, 'the default access lets agents read');
  assert.equal(gh.calls[0].auth, `Bearer ${SECRET}`);
});

test('access levels: Off / Read / Read & change / Everything, ask-first, and per-agent overrides drive the policy', async () => {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const { env, cookie, agent, uid } = await bootstrap({ 'gmail.test': gmail.handler });
  const c = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Gmail', service: 'gmail', url: 'https://gmail.test/mcp', auth: 'token', secret: SECRET, label: 'rtp' });
  assert.equal(c.ok, true, JSON.stringify(c));
  const call = (key, t) => tool(env, key, 'call_tool', { connection: 'gmail_rtp', tool: t, arguments: { to: 'a@b.c' } });
  const outcome = (r) => (r.status === 'approval_required' ? 'ask' : r.error ? 'deny' : 'allow');

  let access = await consoleTool(env, cookie, 'gw_app_access', { id: c.id });
  assert.equal(access.level, 'read');
  assert.equal(outcome(await call(agent, 'create_draft')), 'deny');

  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'write' });
  assert.equal(outcome(await call(agent, 'create_draft')), 'allow');
  assert.equal(outcome(await call(agent, 'send_message')), 'deny', 'sends need Everything');

  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'full' });
  assert.equal(outcome(await call(agent, 'send_message')), 'ask', 'critical tools still ask');

  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'write', ask: true });
  access = await consoleTool(env, cookie, 'gw_app_access', { id: c.id });
  assert.deepEqual([access.level, access.ask], ['write', true]);
  const fresh = (await createKey(env, { name: 'fresh', role: 'write', user_id: uid })).key;
  assert.equal(outcome(await call(fresh, 'create_draft')), 'ask', 'ask-first gates changes');

  const agentId = access.agents.find((a) => a.name === 'codex').key_id;
  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, key_id: agentId, level: 'off' });
  assert.equal(outcome(await call(agent, 'search_threads')), 'deny', 'per-agent Off blocks everything');
  access = await consoleTool(env, cookie, 'gw_app_access', { id: c.id });
  assert.equal(access.agents.find((a) => a.key_id === agentId).level, 'off');
  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, key_id: agentId, level: 'inherit' });
  assert.equal(outcome(await call(agent, 'search_threads')), 'allow');

  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'off' });
  assert.equal(outcome(await call(agent, 'search_threads')), 'deny');
  const rules = await consoleTool(env, cookie, 'gw_rules');
  assert.ok(rules.rules.every((r) => !r.note || r.note.startsWith('managed:') || !r.resource.connections?.includes('gmail_rtp')));
  assert.match((await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'inherit' })).error, /level must be/);
});

test('gw_home summarizes what needs the user and the getting-started checklist', async () => {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const { env, cookie, agent } = await bootstrap({ 'gmail.test': gmail.handler });
  let home = await consoleTool(env, cookie, 'gw_home');
  assert.deepEqual(home.checklist, { connect_app: false, add_agent: false, first_call: false, notifications: false });
  const c = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Gmail', service: 'gmail', url: 'https://gmail.test/mcp', auth: 'token', secret: SECRET, label: 'rtp' });
  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'full' });
  await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'x@y.z' } });
  home = await consoleTool(env, cookie, 'gw_home');
  assert.equal(home.counts.apps, 1);
  assert.equal(home.pending.length, 1);
  assert.equal(home.pending[0].tool, 'send_message');
  assert.equal(home.checklist.connect_app, true);
  assert.equal(home.checklist.first_call, true);
  assert.ok(home.recent.some((e) => e.action === 'gw.call'));
  assert.match((await tool(env, agent, 'gw_home')).error, /web console/);
});

test('a per-agent level is a ceiling below everyone\'s level; renaming an account keeps its access and pins', async () => {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const { env, cookie, agent, uid } = await bootstrap({ 'gmail.test': gmail.handler });
  const c = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Gmail', service: 'gmail', url: 'https://gmail.test/mcp', auth: 'token', secret: SECRET });
  assert.equal(c.connection, 'gmail_main');
  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'write' });
  const access = await consoleTool(env, cookie, 'gw_app_access', { id: c.id });
  const codex = access.agents.find((a) => a.name === 'codex').key_id;
  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, key_id: codex, level: 'read' });
  assert.match((await tool(env, agent, 'call_tool', { connection: 'gmail_main', tool: 'create_draft', arguments: {} })).error || '', /forbid/);
  const other = (await createKey(env, { name: 'other', role: 'write', user_id: uid })).key;
  assert.equal((await rawTool(env, other, 'call_tool', { connection: 'gmail_main', tool: 'create_draft', arguments: {} })).isError, false);
  assert.equal((await consoleTool(env, cookie, 'gw_app_access', { id: c.id })).agents.find((a) => a.key_id === codex).level, 'read');

  await consoleTool(env, cookie, 'gw_key_update', { id: codex, pinned: ['gmail_main'] });
  const renamed = await consoleTool(env, cookie, 'gw_connection_update', { id: c.id, label: 'work' });
  assert.equal(renamed.connection.connection, 'gmail_work', JSON.stringify(renamed));
  const after = await consoleTool(env, cookie, 'gw_app_access', { id: c.id });
  assert.deepEqual([after.connection, after.level, after.agents.find((a) => a.key_id === codex).level], ['gmail_work', 'write', 'read']);
  assert.equal((await rawTool(env, other, 'call_tool', { connection: 'gmail_work', tool: 'create_draft', arguments: {} })).isError, false);
  const pinned = env.DB.sqlite.prepare('SELECT pinned FROM api_keys WHERE id = ?').get(codex).pinned;
  assert.equal(pinned, '["gmail_work"]');
});

test('restricted apps explain themselves instead of starting a doomed sign-in', async () => {
  const { env, cookie } = await bootstrap();
  const r = await consoleTool(env, cookie, 'gw_connect_app', { app_id: 'canva' });
  assert.equal(r.needs, 'restricted');
  assert.match(r.error, /approved apps/);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 0);
});

test('a provider that refuses BrainMCP at its sign-in page is reported before the redirect', async () => {
  const as = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: 'https://auth.p.test', authorization_endpoint: 'https://auth.p.test/authorize', token_endpoint: 'https://auth.p.test/token', registration_endpoint: 'https://auth.p.test/register' });
    if (u.pathname === '/register') return Response.json({ client_id: 'c1' }, { status: 201 });
    if (u.pathname === '/authorize') return new Response('Invalid redirect URI.', { status: 400 });
    return new Response('no', { status: 404 });
  };
  const mcp = async (req) => (new URL(req.url).pathname.startsWith('/.well-known/oauth-protected-resource')
    ? Response.json({ resource: 'https://mcp.p.test/mcp', authorization_servers: ['https://auth.p.test'] }) : new Response('no', { status: 404 }));
  const { env, cookie } = await bootstrap({ 'auth.p.test': as, 'mcp.p.test': mcp });
  const r = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Picky', service: 'picky', url: 'https://mcp.p.test/mcp', auth: 'oauth' });
  assert.match(r.error, /refused BrainMCP/);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 0, 'nothing was saved');
});
