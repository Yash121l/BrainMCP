// PostHog: the /ingest proxy for the web console, and server-side MCP tool-call events.
//
// Privacy contract: brain notes are private. MCP events carry the tool name, timing,
// success, an error category and the internal user id. Never tool arguments, results,
// note paths or contents, search queries, or error message text (messages can echo
// arguments). Event and property names follow PostHog's MCP analytics conventions
// ($mcp_tool_call, $mcp_*), minus $mcp_parameters / $mcp_response.

const INGEST_HOST = 'us.i.posthog.com';
const ASSETS_HOST = 'us-assets.i.posthog.com';
const APP = 'brain-mcp';
const SERVER = { $mcp_server_name: 'brain-mcp', $mcp_server_version: '2.0.0' };

/** Forward /ingest/* to PostHog so ad blockers don't drop console events. */
export function proxyPostHog(req, url) {
  const rest = url.pathname.slice('/ingest'.length) || '/';
  const host = rest.startsWith('/static/') ? ASSETS_HOST : INGEST_HOST;
  const headers = new Headers(req.headers);
  headers.delete('cookie');
  headers.set('host', host);
  const ip = req.headers.get('CF-Connecting-IP');
  if (ip) headers.set('X-Forwarded-For', ip);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return fetch(`https://${host}${rest}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: 'manual',
  });
}

/** Fire-and-forget capture inside waitUntil; a no-op without POSTHOG_KEY (tests, local dev). */
export function capture(env, ctx, event, distinctId, properties = {}) {
  if (!env?.POSTHOG_KEY) return;
  const send = fetch(`https://${INGEST_HOST}/i/v0/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.POSTHOG_KEY,
      event,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: { app: APP, ...properties },
    }),
  }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(send);
}

/** The person behind a call: the internal user id, or an anonymous server id. */
function who(p) {
  const id = p?.user?.id;
  return id ? { distinctId: String(id), props: { via: p.via ?? null } } : { distinctId: 'brain-mcp-server', props: { via: p?.via ?? null, $process_person_profile: false } };
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,96}$/;
const safeToolName = (name) => (TOOL_NAME.test(String(name ?? '')) ? String(name) : 'invalid');

/** "forbidden: no access to vault/x.md" -> "forbidden". Only a "category:" prefix of up to three words; anything else is "error". */
export function errorCategory(message) {
  const m = /^([A-Za-z][A-Za-z_-]*(?: [A-Za-z_-]+){0,2}):/.exec(String(message ?? ''));
  return m && m[1].length <= 40 ? m[1].toLowerCase().replace(/\s+/g, '_') : 'error';
}

const clientUa = (req) => req?.headers?.get('User-Agent')?.slice(0, 120) || null;

/** One $mcp_tool_call per tools/call request. */
export function trackToolCall(R, { name, category, startedAt, isError, error }) {
  const { distinctId, props } = who(R.p);
  capture(R.env, R.ctx, '$mcp_tool_call', distinctId, {
    ...SERVER,
    ...props,
    $mcp_tool_name: safeToolName(name),
    $mcp_tool_category: category,
    $mcp_duration_ms: Date.now() - startedAt,
    $mcp_is_error: !!isError,
    ...(isError ? { $mcp_error_type: errorCategory(error) } : {}),
    $mcp_client_user_agent: clientUa(R.req),
  });
}

/** One $mcp_initialize per handshake: which clients connect, on which protocol. */
export function trackInitialize(R, params, protocolVersion) {
  const { distinctId, props } = who(R.p);
  const info = params?.clientInfo || {};
  const clip = (v) => (v == null ? null : String(v).slice(0, 80));
  capture(R.env, R.ctx, '$mcp_initialize', distinctId, {
    ...SERVER,
    ...props,
    $mcp_client_name: clip(info.name),
    $mcp_client_version: clip(info.version),
    $mcp_protocol_version: protocolVersion,
    $mcp_client_user_agent: clientUa(R.req),
  });
}
