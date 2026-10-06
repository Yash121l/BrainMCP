import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GMAIL_TOOLS, FIGMA_TOOLS, SECRET, O, bootstrap, consoleTool, fakeUpstream, rawTool, tool, createKey, http, login, allText } from './helpers/gateway-harness.mjs';
import { fakeCtx } from './helpers/fake-env.mjs';
import worker from '../src/index.js';

// Findings from the independent review of PR #6, each pinned.

test('a machine-bound agent key pasted into the session cookie opens nothing, and console keys keep their lineage', async () => {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const { env, cookie, uid } = await bootstrap({ 'gmail.test': gmail.handler });
  const c = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Gmail', service: 'gmail', url: 'https://gmail.test/mcp', auth: 'token', secret: SECRET, label: 'rtp' });
  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'full' });
  env.DB.sqlite.prepare("INSERT INTO machines (id, user_id, name, tags, created) VALUES ('m_x', ?, 'box', '[]', datetime('now'))").run(uid);
  const agentKey = await createKey(env, { name: 'agent', role: 'admin', user_id: uid, machine_id: 'm_x', agent: 'codex' });
  const ask = await tool(env, agentKey.key, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'x@y.z' } });
  assert.equal(ask.status, 'approval_required');
  const forged = `brain_session=${agentKey.key}`;
  const mint = await http(env, 'POST', '/app/api/keys', { cookie: forged, body: { name: 'escape', role: 'admin' }, headers: { Origin: O } });
  assert.equal(mint.status, 401);
  assert.equal((await consoleTool(env, forged, 'gw_approval_decide', { id: ask.approval_id, decision: 'approve' })).error, 'unauthorized');

  const made = await (await http(env, 'POST', '/app/api/keys', { cookie, body: { name: 'from console', role: 'write' }, headers: { Origin: O } })).json();
  const row = env.DB.sqlite.prepare('SELECT user_id, parent_key_id FROM api_keys WHERE id = ?').get(made.id);
  assert.equal(row.user_id, uid);
  assert.ok(row.parent_key_id, 'a console-minted key descends from the session key');
});

test('device approval keeps the approver\'s scopes and space limit, and mints one key per harness', async () => {
  const { env, uid } = await bootstrap();
  const scoped = await createKey(env, { name: 'scoped', role: 'write', user_id: uid, prefixes: ['vault/projects/limited/'] });
  const sCookie = await login(env, scoped.key);
  const start = await (await http(env, 'POST', '/device/code', { body: { machine: 'laptop', agents: ['claude-code', 'codex'] } })).json();
  const look = await consoleTool(env, sCookie, 'gw_device_lookup', { user_code: start.user_code });
  assert.deepEqual(look.agents, ['claude-code', 'codex']);
  assert.match((await consoleTool(env, sCookie, 'gw_device_approve', { user_code: start.user_code, role: 'admin' })).error, /cannot grant admin/);
  const ok = await consoleTool(env, sCookie, 'gw_device_approve', { user_code: start.user_code, role: 'write' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const got = await (await http(env, 'POST', '/device/token', { body: { device_code: start.device_code } })).json();
  assert.deepEqual(Object.keys(got.keys), ['claude-code', 'codex']);
  assert.notEqual(got.keys['claude-code'], got.keys.codex);
  for (const k of env.DB.sqlite.prepare("SELECT role, prefixes, agent FROM api_keys WHERE machine_id IS NOT NULL").all()) {
    assert.equal(k.role, 'write', 'a scoped session cannot grant admin');
    assert.deepEqual(JSON.parse(k.prefixes), ['vault/projects/limited/']);
  }
});

test('an upstream tool error that echoes the credential is scrubbed before it reaches the agent', async () => {
  const figma = fakeUpstream({ tools: FIGMA_TOOLS, onCall: () => ({ isError: true, content: [{ type: 'text', text: `auth failed for ${SECRET}` }], structuredContent: { token: SECRET } }) });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  const r = await rawTool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} });
  assert.equal(r.isError, true);
  assert.ok(!JSON.stringify(r).includes(SECRET), JSON.stringify(r));
});

test('an OAuth token endpoint that echoes the client secret never puts it in the page or the audit log', async () => {
  const authServer = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: 'https://auth.x.test', authorization_endpoint: 'https://auth.x.test/authorize', token_endpoint: 'https://auth.x.test/token' });
    if (u.pathname === '/token') return new Response('server exploded; client_secret=super-secret-client-value-123', { status: 500 });
    return new Response('no', { status: 404 });
  };
  const mcp = async (req) => (new URL(req.url).pathname.startsWith('/.well-known/oauth-protected-resource')
    ? Response.json({ resource: 'https://mcp.x.test/mcp', authorization_servers: ['https://auth.x.test'] }) : new Response('no', { status: 404 }));
  const { env, cookie } = await bootstrap({ 'auth.x.test': authServer, 'mcp.x.test': mcp });
  const c = await consoleTool(env, cookie, 'gw_connection_create', { service: 'xapp', label: 'a', url: 'https://mcp.x.test/mcp', auth: 'oauth', client_id: 'static-client', client_secret: 'super-secret-client-value-123' });
  assert.ok(c.authorize_url, JSON.stringify(c));
  const state = new URL(c.authorize_url).searchParams.get('state');
  const res = await http(env, 'GET', `/connect/callback?code=abc&state=${state}`, { cookie });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes('super-secret-client-value-123'));
  assert.ok(!allText(env).includes('super-secret-client-value-123'));
});

test('two access saves at once leave exactly one level, never both', async () => {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const { env, cookie } = await bootstrap({ 'gmail.test': gmail.handler });
  const c = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Gmail', service: 'gmail', url: 'https://gmail.test/mcp', auth: 'token', secret: SECRET, label: 'rtp' });
  await Promise.all([
    consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'write' }),
    consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'read' }),
    consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'full' }),
  ]);
  const permits = env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM rules WHERE note = 'managed:app:gmail_rtp:all:permit'").get().n;
  assert.equal(permits, 1);
});

test('approve and deny at the same moment: the first decision wins and the loser is told', async () => {
  const gmail = fakeUpstream({ tools: GMAIL_TOOLS });
  const { env, cookie, agent } = await bootstrap({ 'gmail.test': gmail.handler });
  const c = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Gmail', service: 'gmail', url: 'https://gmail.test/mcp', auth: 'token', secret: SECRET, label: 'rtp' });
  await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'full' });
  const ask = await tool(env, agent, 'call_tool', { connection: 'gmail_rtp', tool: 'send_message', arguments: { to: 'x@y.z' } });
  const [a, b] = await Promise.all([
    consoleTool(env, cookie, 'gw_approval_decide', { id: ask.approval_id, decision: 'deny' }),
    consoleTool(env, cookie, 'gw_approval_decide', { id: ask.approval_id, decision: 'approve' }),
  ]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, JSON.stringify([a, b]));
  const final = env.DB.sqlite.prepare('SELECT status FROM approvals WHERE id = ?').get(ask.approval_id).status;
  assert.equal(final, (a.ok ? a : b).status);
});

test('access works for the longest connection name the API allows', async () => {
  const up = fakeUpstream({ tools: GMAIL_TOOLS, auth: () => true });
  const { env, cookie } = await bootstrap({ 'long.test': up.handler });
  const c = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Long', service: 'abcdefghijklmnopqrstuvwx', url: 'https://long.test/mcp', auth: 'none', label: 'abcdefghijkl' });
  assert.equal(c.ok, true, JSON.stringify(c));
  const set = await consoleTool(env, cookie, 'gw_set_app_access', { id: c.id, level: 'write' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.access.level, 'write');
});
