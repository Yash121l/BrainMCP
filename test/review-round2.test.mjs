import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIGMA_TOOLS, SECRET, O, bootstrap, consoleTool, fakeUpstream, rawTool, http } from './helpers/gateway-harness.mjs';

// Findings from round 2 of the independent review of PR #6, each pinned.

test('a credential nested deeper than the scrubber walks is removed, not returned', async () => {
  let nested = { message: SECRET };
  for (let i = 0; i < 24; i++) nested = { data: nested };
  const figma = fakeUpstream({ tools: FIGMA_TOOLS, onCall: () => ({ isError: true, content: [{ type: 'text', text: 'failed' }], structuredContent: nested }) });
  const { env, cookie, agent } = await bootstrap({ 'mcp.figma.test': figma.handler });
  await consoleTool(env, cookie, 'gw_connection_create', { service: 'figma', label: 'rtp', url: 'https://mcp.figma.test/mcp', auth: 'bearer', secret: SECRET });
  const r = await rawTool(env, agent, 'call_tool', { connection: 'figma_rtp', tool: 'get_screenshot', arguments: {} });
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('telemetry ingest drops credentials under any spelling of a secret key, whole objects and arrays included', async () => {
  const { env, agent } = await bootstrap();
  const res = await http(env, 'POST', '/ingest/tool-calls', { token: agent, body: { records: [{
    session: 's1', tool: 'login', args: {
      password: 'synthetic_password', authorization: { value: 'synthetic_object_password' }, api_key: ['synthetic_array_password'],
      'X.Api.Key': 'synthetic_dot_key', githubToken: 'synthetic_camel', max_tokens: 4096, author: 'kept',
    },
  }] } });
  assert.equal(res.status, 200);
  const payload = env.DB.sqlite.prepare('SELECT payload FROM tool_calls').get().payload;
  for (const s of ['synthetic_password', 'synthetic_object_password', 'synthetic_array_password', 'synthetic_dot_key', 'synthetic_camel']) assert.ok(!payload.includes(s), s);
  assert.match(payload, /"max_tokens":4096/);
  assert.match(payload, /"author":"kept"/);
});

test('device approval is one atomic decision: approve vs deny, and two approvals at once', async () => {
  const { env, cookie } = await bootstrap();
  const start = async () => (await http(env, 'POST', '/device/code', { body: { machine: 'box', agents: ['claude-code', 'codex'] } })).json();

  const a = await start();
  const [x, y] = await Promise.all([
    consoleTool(env, cookie, 'gw_device_approve', { user_code: a.user_code }),
    consoleTool(env, cookie, 'gw_device_deny', { user_code: a.user_code }),
  ]);
  assert.equal([x, y].filter((r) => r.ok).length, 1, JSON.stringify([x, y]));
  const token = await (await http(env, 'POST', '/device/token', { body: { device_code: a.device_code } })).json();
  if (x.ok) assert.deepEqual(Object.keys(token.keys), ['claude-code', 'codex']);
  else assert.equal(token.error, 'access_denied');

  const b = await start();
  const before = env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0 AND machine_id IS NOT NULL").get().n;
  const both = await Promise.all([1, 2].map(() => consoleTool(env, cookie, 'gw_device_approve', { user_code: b.user_code })));
  assert.equal(both.filter((r) => r.ok).length, 1, JSON.stringify(both));
  const after = env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0 AND machine_id IS NOT NULL").get().n;
  assert.equal(after - before, 2, 'one key per harness, once');
});

test('auto-detection never sends a request to an address the URL policy refuses', async () => {
  const { env, cookie } = await bootstrap();
  let touched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') touched++;
    return realFetch(input, init);
  };
  try {
    for (const url of ['http://127.0.0.1:8890/admin', 'https://localhost/mcp', 'https://10.0.0.5/mcp']) {
      const r = await consoleTool(env, cookie, 'gw_connect_app', { name: 'Evil', url });
      assert.ok(r.error, url);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(touched, 0);
});
