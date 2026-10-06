// run_code: the agent sends a short JavaScript body; BrainMCP runs it in a fresh
// Dynamic Worker with no network (globalOutbound: null). The only thing the code can
// reach is the TOOLS binding, a ToolBridge stub whose props name the calling key; the
// sandbox never sees them. Every upstream call goes through invokeTool, so policy,
// approvals, taint and audit apply exactly as for call_tool.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { principalForKey } from './auth.js';
import { resolveConnection, invokeTool } from './gateway.js';

const CODE_MAX = 20000;
const OUTPUT_MAX = 24000;
const LIMITS = { cpuMs: 2000, subRequests: 100 };
const BRAIN_READS = new Set(['search', 'read_note', 'list_notes', 'backlinks', 'links', 'list_connections', 'search_tools', 'describe_tools']);

let brainCaller = null;
/** index.js hands over its callTool here, so this module needs no import cycle. */
export function setBrainCaller(fn) {
  brainCaller = fn;
}

export const codeModeReady = (env, ctx) => !!(env.LOADER && ctx?.exports?.ToolBridge);

/** What a sandboxed tool call returns to the code: structured content first, else the text. */
function compact(result) {
  if (result?.error || result?.status === 'approval_required') {
    const { content, structuredContent, ...rest } = result;
    return rest;
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return result?.isError ? { error: text || 'upstream error' } : text;
}

export class ToolBridge extends WorkerEntrypoint {
  async rebuild() {
    const { keyId, origin } = this.ctx.props || {};
    const p = await principalForKey(this.env, keyId);
    if (!p) throw new Error('the key behind this run is no longer valid');
    return { env: this.env, p, ctx: this.ctx, url: new URL(origin) };
  }

  async call(connection, tool, args) {
    const R = await this.rebuild();
    const r = await resolveConnection(R.env, R.p, { connection: String(connection) });
    if (r.error) return r;
    return compact(await invokeTool(R, { conn: r.conn, toolName: String(tool), args: args && typeof args === 'object' ? args : {} }));
  }

  async brain(name, args) {
    if (!BRAIN_READS.has(name)) return { error: `brain.${name} is not available inside run_code` };
    const R = await this.rebuild();
    return brainCaller(R, name, args && typeof args === 'object' ? args : {});
  }
}

/** The sandbox module: wraps the agent's code with tools.*, brain.* and a captured console. */
function sandboxModule(code) {
  return `import { WorkerEntrypoint } from 'cloudflare:workers';
export class Run extends WorkerEntrypoint {
  async run() {
    const logs = [];
    const push = (level) => (...a) => { if (logs.length < 200) logs.push((level === 'log' ? '' : level + ': ') + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };
    const console = { log: push('log'), info: push('info'), warn: push('warn'), error: push('error') };
    const TOOLS = this.env.TOOLS;
    let calls = 0;
    const tools = new Proxy({}, { get: (_, connection) => new Proxy({}, { get: (_, tool) => (args) => { calls++; return TOOLS.call(String(connection), String(tool), args ?? {}); } }) });
    const brain = new Proxy({}, { get: (_, name) => (args) => { calls++; return TOOLS.brain(String(name), args ?? {}); } });
    try {
      const result = await (async () => {
${code}
      })();
      return { result: result === undefined ? null : result, logs, calls };
    } catch (e) {
      return { error: String(e && e.message || e), logs, calls };
    }
  }
}
`;
}

export async function runCode(R, { code }) {
  const { env, ctx, p } = R;
  if (!codeModeReady(env, ctx)) return { error: 'run_code is not enabled on this server (needs the LOADER binding and the enable_ctx_exports flag)' };
  const src = String(code || '');
  if (!src.trim()) return { error: 'code is required' };
  if (src.length > CODE_MAX) return { error: `code is over ${CODE_MAX} characters` };
  const worker = env.LOADER.load({
    compatibilityDate: '2026-08-01',
    mainModule: 'run.js',
    modules: { 'run.js': sandboxModule(src) },
    env: { TOOLS: ctx.exports.ToolBridge({ props: { keyId: p.keyId, origin: R.url.origin } }) },
    globalOutbound: null,
    limits: LIMITS,
  });
  let out;
  try {
    out = await worker.getEntrypoint('Run').run();
  } catch (e) {
    return { error: `the sandbox stopped: ${e.message}` };
  }
  const text = JSON.stringify(out);
  if (text.length <= OUTPUT_MAX) return out;
  return { truncated: true, output: `${text.slice(0, OUTPUT_MAX)} …[truncated by BrainMCP: return less data, or summarize inside the code]` };
}

export const RUN_CODE_TOOL = {
  name: 'run_code',
  description: `Run a short JavaScript async function body in a sandbox with no network. Use it for loops, joins and any job that needs three or more dependent tool calls; return only what you need.
Available inside:
  await tools.<connection>.<tool>(args)   // e.g. await tools.figma_rtp.get_screenshot({ nodeId: '1:2' }); same policy and approvals as call_tool
  await brain.search({ q }) · brain.read_note({ path }) · brain.list_notes({...}) · brain.search_tools({ query }) · brain.describe_tools({ tools })
  console.log(...)                        // captured into logs
A call that needs approval returns { status: 'approval_required', approval_id }; stop and tell the user. The value you return is the result (keep it small).`,
  inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'the body of an async function; use await and return' } }, required: ['code'] },
  annotations: { openWorldHint: true },
};
