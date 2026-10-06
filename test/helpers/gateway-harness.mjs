// Shared harness for gateway tests: fake upstream MCP servers, a booted worker with a
// console session and an agent key, and HTTP/MCP helpers.
import { fakeEnv, fakeCtx, fakeDONamespace, stubFetch } from './fake-env.mjs';
import { fakeGitHub } from './index-repo.mjs';
import worker from '../../src/index.js';
import { ConnectionDO } from '../../src/gateway.js';
import { createKey } from '../../src/auth.js';

export const O = 'https://brain.test';
export const VAULT_KEK = Buffer.alloc(32, 9).toString('base64');
export const SECRET = 'figma-pat-SECRET-0123456789';

// ---------------------------------------------------------------- fake upstream MCP

export function fakeUpstream({ tools, onCall, auth = (h) => h.authorization === `Bearer ${SECRET}` }) {
  const state = { tools: tools.map((t) => ({ ...t })), sessions: 0, calls: [] };
  const json = (body, extra = {}) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...extra } });
  state.handler = async (req, rec) => {
    const u = new URL(req.url);
    if (u.pathname !== '/mcp') return new Response('nope', { status: 404 });
    if (!auth(rec.headers)) return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    const msg = JSON.parse(rec.body);
    if (msg.method === 'initialize') {
      state.sessions++;
      return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }, { 'Mcp-Session-Id': `s${state.sessions}` });
    }
    if (!msg.id) return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: state.tools } });
    if (msg.method === 'tools/call') {
      state.calls.push({ name: msg.params.name, args: msg.params.arguments, auth: rec.headers.authorization });
      const result = onCall ? onCall(msg.params) : { content: [{ type: 'text', text: `ran ${msg.params.name}` }] };
      // answer over SSE to exercise that path
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  };
  return state;
}

export const FIGMA_TOOLS = [
  { name: 'get_screenshot', description: 'Render a node as PNG', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'post_comment', description: 'Comment on a file', inputSchema: { type: 'object' } },
  { name: 'delete_file', description: 'Delete a file', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];
export const GMAIL_TOOLS = [
  { name: 'search_threads', description: 'Search email threads', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'send_message', description: 'Send an email', inputSchema: { type: 'object' } },
  { name: 'create_draft', description: 'Draft an email', inputSchema: { type: 'object' } },
];

// ---------------------------------------------------------------- harness

let net = stubFetch();

export function setup(routes = {}) {
  const env = fakeEnv({ VAULT_KEK });
  env.CONNECTIONS = fakeDONamespace(ConnectionDO, () => env);
  const gh = fakeGitHub(env, {});
  net.restore();
  net = stubFetch(async (req, rec) => {
    const host = new URL(req.url).host;
    if (routes[host]) return routes[host](req, rec);
    if (host === 'api.github.com') return gh.handler(req, rec);
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  return env;
}

export const http = async (env, method, path, { token, cookie, body, headers = {} } = {}) => {
  const ctx = fakeCtx();
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(O + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), env, ctx);
  await Promise.all(ctx.pending);
  return res;
};

export async function rpc(env, token, method, params) {
  const res = await http(env, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method, params } });
  return (await res.json()).result;
}
export async function tool(env, token, name, args = {}) {
  const r = await rpc(env, token, 'tools/call', { name, arguments: args });
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return r; }
}
export async function rawTool(env, token, name, args = {}) {
  return rpc(env, token, 'tools/call', { name, arguments: args });
}

export async function superUser(env) {
  await tool(env, env.BRAIN_TOKEN, 'whoami');
  return env.DB.sqlite.prepare('SELECT id FROM users WHERE is_super = 1').get().id;
}

export async function login(env, key) {
  const form = new FormData();
  form.set('access_key', key);
  const res = await worker.fetch(new Request(`${O}/app/login`, { method: 'POST', body: form }), env, fakeCtx());
  return res.headers.get('Set-Cookie').split(';')[0];
}
export async function consoleTool(env, cookie, name, args = {}) {
  const res = await http(env, 'POST', '/app/api/tool', { cookie, body: { name, args }, headers: { Origin: O } });
  return res.json();
}

export async function bootstrap(routes) {
  const env = setup(routes);
  const uid = await superUser(env);
  const admin = await createKey(env, { name: 'console', role: 'admin', user_id: uid });
  const cookie = await login(env, admin.key);
  const agent = await createKey(env, { name: 'codex', role: 'write', user_id: uid });
  return { env, uid, cookie, agent: agent.key, agentId: agent.id };
}

export const allText = (env) => JSON.stringify([
  env.DB.sqlite.prepare('SELECT * FROM audit_events').all(),
  env.DB.sqlite.prepare('SELECT * FROM connections').all(),
  env.DB.sqlite.prepare('SELECT * FROM approvals').all(),
]);


export { createKey, worker, fakeCtx };
