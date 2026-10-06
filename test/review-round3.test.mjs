import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, consoleTool, http } from './helpers/gateway-harness.mjs';

// Findings from round 3 of the independent review of PR #6, each pinned.

test('telemetry drops numeric credentials but keeps token counters', async () => {
  const { env, agent } = await bootstrap();
  await http(env, 'POST', '/ingest/tool-calls', { token: agent, body: { records: [{ session: 's', tool: 'login', args: { password: 271828, api_key: 31415926, pin: 1234, token: 99887766, max_tokens: 4096, input_tokens: 12 } }] } });
  const payload = env.DB.sqlite.prepare('SELECT payload FROM tool_calls').get().payload;
  for (const v of ['271828', '31415926', '99887766', '1234']) assert.ok(!payload.includes(v), v);
  assert.match(payload, /"max_tokens":4096/);
  assert.match(payload, /"input_tokens":12/);
});

const keyCount = (env) => env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0 AND machine_id IS NOT NULL').get().n;
const start = async (env) => (await http(env, 'POST', '/device/code', { body: { machine: 'box', agents: ['claude-code', 'codex'] } })).json();

test('a failure inside the grant transaction leaves no keys and the request decidable', async () => {
  const { env, cookie } = await bootstrap();
  const s = await start(env);
  const db = env.DB;
  env.DB = { ...db, sqlite: db.sqlite, prepare: db.prepare, batch: async () => { throw new Error('D1_ERROR: storage reset'); } };
  const r = await consoleTool(env, cookie, 'gw_device_approve', { user_code: s.user_code });
  env.DB = db;
  assert.match(r.error, /nothing was granted/);
  assert.equal(keyCount(env), 0);
  assert.equal(env.DB.sqlite.prepare('SELECT status FROM device_codes').get().status, 'pending');
  assert.equal((await consoleTool(env, cookie, 'gw_device_approve', { user_code: s.user_code })).ok, true, 'a retry works');
  assert.equal(keyCount(env), 2);
});

test('an approval that crosses the expiry mints nothing', async () => {
  const { env, cookie } = await bootstrap();
  const s = await start(env);
  const db = env.DB;
  env.DB = { ...db, sqlite: db.sqlite, prepare: db.prepare, batch: async (stmts) => { db.sqlite.prepare("UPDATE device_codes SET exp = datetime('now', '-1 minute')").run(); return db.batch(stmts); } };
  const r = await consoleTool(env, cookie, 'gw_device_approve', { user_code: s.user_code });
  env.DB = db;
  assert.match(r.error, /expired or changed/);
  assert.equal(keyCount(env), 0);
});

test('a claim abandoned mid-way grants nothing and can be taken over after two minutes', async () => {
  const { env, cookie } = await bootstrap();
  const s = await start(env);
  env.DB.sqlite.prepare("UPDATE device_codes SET status = 'approving', claimed = datetime('now'), claim_id = 'dead-run'").run();
  assert.match((await consoleTool(env, cookie, 'gw_device_approve', { user_code: s.user_code })).error, /unknown or expired|already decided/);
  env.DB.sqlite.prepare("UPDATE device_codes SET claimed = datetime('now', '-3 minutes')").run();
  assert.equal((await consoleTool(env, cookie, 'gw_device_approve', { user_code: s.user_code })).ok, true);
  assert.equal(keyCount(env), 2);
  const got = await (await http(env, 'POST', '/device/token', { body: { device_code: s.device_code } })).json();
  assert.deepEqual(Object.keys(got.keys), ['claude-code', 'codex']);
});
