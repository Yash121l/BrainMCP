#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
const DEFAULT_SERVER = 'https://brain.yashlunawat.com';
const SERVICE = 'brainmcp';
export const BLOCK_START = '# >>> brain (managed)';
export const BLOCK_END = '# <<< brain (managed)';
const FLUSH_AT = 25;
const MAX_SPOOL_LINES = 5000;
const MAX_BATCH_AGE_MS = 7 * 86400 * 1000;
const CHUNK = 400;
const REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_PROTOCOL = '2025-06-18';
const SELF = fileURLToPath(import.meta.url);

export class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };
let sink = (s) => process.stdout.write(s);
const out = (s = '') => sink(`${s}\n`);
export const setOutput = (fn) => { sink = fn || ((s) => process.stdout.write(s)); };
const err = (s = '') => process.stderr.write(`${s}\n`);

// ------------------------------------------------------------------ paths and files

export const home = () => process.env.HOME || os.homedir();

export function paths(h = home()) {
  const config = path.join(h, '.config', 'brain');
  return {
    config,
    configFile: path.join(config, 'config.json'),
    credFile: path.join(config, 'credentials.json'),
    manifest: path.join(config, 'manifest.json'),
    bridge: path.join(config, 'bridge.json'),
    uninstallLog: path.join(config, 'last-uninstall.json'),
    spool: process.env.BRAIN_SPOOL || path.join(h, '.cache', 'brain', 'spool'),
  };
}

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

export function readJson(p, fallback = null) {
  const t = readText(p);
  if (t === null) return fallback;
  if (!t.trim()) return fallback;
  try { return JSON.parse(t); } catch { fail(`${p} is not valid JSON; fix or move it, then retry`); }
}

function writeAtomic(p, content, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const prev = (() => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } })();
  const tmp = `${p}.brain-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: mode ?? prev ?? 0o644 });
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, p);
}

export const shq = (s) => (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

export function which(bin, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return null;
}

/** Changes go through here so --dry-run, backups and idempotency live in one place. */
export function makeFx({ dryRun = false, log = out } = {}) {
  const changed = [];
  return {
    dryRun,
    changed,
    log,
    write(file, content, { mode, backup = true } = {}) {
      const prev = readText(file);
      if (prev === content) return false;
      changed.push(file);
      if (dryRun) { log(`  would write ${file}`); return true; }
      if (backup && prev !== null && !exists(`${file}.brain-backup`)) fs.writeFileSync(`${file}.brain-backup`, prev, { mode: 0o600 });
      writeAtomic(file, content, mode);
      return true;
    },
    remove(file) {
      if (!exists(file)) return false;
      changed.push(file);
      if (dryRun) { log(`  would remove ${file}`); return true; }
      fs.rmSync(file, { force: true });
      return true;
    },
    run(cmd, args, { quietFail = false, display } = {}) {
      const shown = display || [cmd, ...args].map(shq).join(' ');
      if (dryRun) { log(`  would run ${shown}`); return { status: 0, stdout: '', stderr: '' }; }
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      if (r.error && !quietFail) fail(`could not run ${cmd}: ${r.error.message}`);
      return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
  };
}

// ------------------------------------------------------------------ config and secrets

export function normalizeServer(s) {
  const v = String(s || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(v)) fail(`server must look like https://host (got "${s}")`);
  return v;
}

export function defaultMachine(host = os.hostname()) {
  const short = String(host).split('.')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40);
  return short || 'machine';
}

const loadConfig = () => readJson(paths().configFile, null);
const saveConfig = (cfg) => writeAtomic(paths().configFile, `${JSON.stringify(cfg, null, 2)}\n`, 0o600);

function pickStore() {
  const forced = process.env.BRAIN_CRED_STORE;
  if (forced) return forced;
  if (process.platform === 'darwin' && which('security')) return 'keychain';
  if (process.platform === 'linux' && which('secret-tool')) return 'secret-tool';
  return 'file';
}

const keychainArgs = () => (process.env.BRAIN_KEYCHAIN ? [process.env.BRAIN_KEYCHAIN] : []);

function storeSecret(store, server, key) {
  if (store === 'keychain') {
    const kc = keychainArgs().join(' ');
    if (/[\s"'\\]/.test(key + server + kc)) return false;
    // `security -i` reads the command from stdin so the key never appears in the process list.
    const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${server} -l BrainMCP -w ${key} ${kc}\n`, encoding: 'utf8' });
    return r.status === 0 && !/error/i.test(r.stderr || '') && readSecret(store, server) === key;
  }
  if (store === 'secret-tool') {
    const r = spawnSync('secret-tool', ['store', '--label=BrainMCP', 'service', SERVICE, 'account', server], { input: key, encoding: 'utf8' });
    return r.status === 0;
  }
  const p = paths();
  fs.mkdirSync(p.config, { recursive: true, mode: 0o700 });
  writeAtomic(p.credFile, `${JSON.stringify({ server, key }, null, 2)}\n`, 0o600);
  return true;
}

function readSecret(store, server) {
  if (store === 'keychain') {
    const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', server, '-w', ...keychainArgs()], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() || null : null;
  }
  if (store === 'secret-tool') {
    const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', server], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() || null : null;
  }
  const c = readJson(paths().credFile, null);
  return c && c.server === server ? c.key || null : null;
}

function deleteSecret(store, server) {
  if (store === 'keychain') spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', server, ...keychainArgs()], { encoding: 'utf8' });
  else if (store === 'secret-tool') spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', server], { encoding: 'utf8' });
  fs.rmSync(paths().credFile, { force: true });
}

/** Stored login first; BRAIN_KEY (+ BRAIN_URL) from the environment as a fallback for headless boxes. */
export function loadCreds({ required = true } = {}) {
  const cfg = loadConfig();
  if (cfg?.server) {
    const key = readSecret(cfg.store || 'file', cfg.server);
    if (key) return { ...cfg, key };
  }
  if (process.env.BRAIN_KEY) {
    return { server: normalizeServer(process.env.BRAIN_URL || cfg?.server || DEFAULT_SERVER), key: process.env.BRAIN_KEY, machine: cfg?.machine || null, agent: cfg?.agent || null, store: 'env' };
  }
  if (required) fail(cfg?.server ? `no key found in the ${cfg.store || 'file'} store; run \`brain login\` again` : 'not logged in; run `brain login`');
  return null;
}

// ------------------------------------------------------------------ HTTP

export async function api(server, pathname, { method = 'GET', body, key, timeout = 15000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(server + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    fail(`cannot reach ${server}: ${e.cause?.code || e.cause?.message || e.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

export async function mcpCall(creds, tool, args = {}) {
  const r = await api(creds.server, '/mcp', { method: 'POST', key: creds.key, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } } });
  if (r.status === 401) fail('the server rejected this key (revoked or expired?); run `brain login`');
  if (!r.json) fail(`unexpected reply from ${creds.server}/mcp (HTTP ${r.status})`);
  if (r.json.error) fail(`MCP error: ${r.json.error.message}`);
  const text = (r.json.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.json.result?.isError) fail(text || `${tool} failed`);
  return text;
}

// ------------------------------------------------------------------ managed blocks (TOML, shell rc)

const START_RE = /^# >>> brain \(managed\)[ \t]*$/m;
const END_RE = /^# <<< brain \(managed\)[ \t]*$/m;

function findBlock(text) {
  const s = START_RE.exec(text);
  if (!s) return null;
  const rest = text.slice(s.index);
  const e = END_RE.exec(rest);
  if (!e) fail('found "# >>> brain (managed)" without its closing line; fix the file by hand');
  let end = s.index + e.index + e[0].length;
  if (text[end] === '\n') end++;
  return { start: s.index, end };
}

export function upsertBlock(text, body) {
  const src = text || '';
  const block = `${BLOCK_START}\n${body.replace(/\n+$/, '')}\n${BLOCK_END}\n`;
  const b = findBlock(src);
  if (b) return src.slice(0, b.start) + block + src.slice(b.end);
  if (!src) return block;
  return `${src.endsWith('\n') ? src : `${src}\n`}\n${block}`;
}

export function removeBlock(text) {
  const src = text || '';
  const b = findBlock(src);
  if (!b) return src;
  let before = src.slice(0, b.start);
  if (before.endsWith('\n\n')) before = before.slice(0, -1);
  return before + src.slice(b.end);
}

export const hasBlock = (text) => START_RE.test(text || '');

export function codexBlock(server) {
  return `[mcp_servers.brain]\nurl = ${JSON.stringify(`${server}/mcp`)}\nbearer_token_env_var = "BRAIN_KEY"`;
}

export function upsertCodexConfig(text, server) {
  if (/^\s*\[\s*mcp_servers\.(?:brain|"brain")\s*\]/m.test(removeBlock(text))) {
    fail('~/.codex/config.toml already has an unmanaged [mcp_servers.brain] table; remove it, then rerun');
  }
  return upsertBlock(text, codexBlock(server));
}

export function shellBlock(cmd) {
  return `export BRAIN_KEY="$(${cmd} auth token 2>/dev/null)"`;
}

// ------------------------------------------------------------------ JSON configs

export function harnessJsonTargets(server) {
  const url = `${server}/mcp`;
  return {
    cursor: { file: ['.cursor', 'mcp.json'], key: ['mcpServers', 'brain'], value: { url, headers: { Authorization: 'Bearer ${env:BRAIN_KEY}' } } },
    gemini: { file: ['.gemini', 'settings.json'], key: ['mcpServers', 'brain'], value: { httpUrl: url, headers: { Authorization: 'Bearer $BRAIN_KEY' } } },
    opencode: {
      file: ['.config', 'opencode', 'opencode.json'],
      key: ['mcp', 'brain'],
      value: { type: 'remote', url, headers: { Authorization: 'Bearer {env:BRAIN_KEY}' }, enabled: true },
      init: { $schema: 'https://opencode.ai/config.json' },
    },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function setJsonKey(obj, keys, value) {
  const root = isObj(obj) ? structuredClone(obj) : {};
  let cur = root;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

export function deleteJsonKey(obj, keys) {
  if (!isObj(obj)) return obj;
  const root = structuredClone(obj);
  let cur = root;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) return root;
    cur = cur[k];
  }
  delete cur[keys[keys.length - 1]];
  return root;
}

/** deleteJsonKey, then drop parents the deletion left empty ({ mcpServers: {} } -> {}). */
export function deleteJsonKeyPruned(obj, keys) {
  let root = deleteJsonKey(obj, keys);
  for (let n = keys.length - 1; n > 0; n--) {
    const parent = getJsonKey(root, keys.slice(0, n));
    if (!isObj(parent) || Object.keys(parent).length) break;
    root = deleteJsonKey(root, keys.slice(0, n));
  }
  return root;
}

export const getJsonKey = (obj, keys) => keys.reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);

export const isBrainHookCommand = (cmd) => {
  const c = String(cmd || '').trim();
  return (c.includes('brain') && c.endsWith('hook post-tool')) || c.includes('brain-telemetry.sh');
};

export function withoutClaudeHook(settings) {
  if (!isObj(settings) || !isObj(settings.hooks) || !Array.isArray(settings.hooks.PostToolUse)) return settings;
  const s = structuredClone(settings);
  const before = JSON.stringify(s.hooks.PostToolUse);
  s.hooks.PostToolUse = s.hooks.PostToolUse
    .map((e) => (isObj(e) && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !isBrainHookCommand(h?.command)) } : e))
    .filter((e) => !isObj(e) || !Array.isArray(e.hooks) || e.hooks.length);
  if (JSON.stringify(s.hooks.PostToolUse) === before) return settings;
  if (!s.hooks.PostToolUse.length) delete s.hooks.PostToolUse;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

export function withClaudeHook(settings, command) {
  const s = structuredClone(withoutClaudeHook(isObj(settings) ? settings : {}));
  if (!isObj(s.hooks)) s.hooks = {};
  if (!Array.isArray(s.hooks.PostToolUse)) s.hooks.PostToolUse = [];
  s.hooks.PostToolUse.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] });
  return s;
}

const jsonText = (o) => `${JSON.stringify(o, null, 2)}\n`;

// ------------------------------------------------------------------ skills

/** Returns the path's segments if it is safe to place under a skills dir, else null. */
export function safeSkillPath(p) {
  if (typeof p !== 'string' || !p || p.length > 400) return null;
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.split('/');
  if (segs.length < 2) return null;
  if (segs.some((s) => !s || s === '.' || s === '..')) return null;
  return segs;
}

/**
 * Decide what a skills sync does. `prev` is the manifest's {skill: [files]} for this dir;
 * `dirExists(name)` says whether a skill folder is already on disk.
 */
export function planSkills(bundle, prev = {}, dirExists = () => false, { adopt = false } = {}) {
  const files = new Map();
  const unsafe = [];
  for (const f of bundle?.files || []) {
    const segs = safeSkillPath(f?.path);
    if (!segs || typeof f.content !== 'string') { unsafe.push(String(f?.path)); continue; }
    if (!files.has(segs[0])) files.set(segs[0], []);
    files.get(segs[0]).push({ rel: segs.join('/'), content: f.content });
  }
  const write = [];
  const skipped = [];
  const managed = {};
  for (const [name, list] of files) {
    if (!prev[name] && dirExists(name) && !adopt) { skipped.push(name); continue; }
    managed[name] = list.map((f) => f.rel).sort();
    write.push(...list);
  }
  const keep = new Set(write.map((f) => f.rel));
  const remove = [];
  for (const [name, rels] of Object.entries(prev)) {
    for (const rel of rels || []) if (safeSkillPath(rel)?.[0] === name && !keep.has(rel)) remove.push(rel);
  }
  return { write, remove, skipped, unsafe, managed };
}

function pruneEmptyDirs(base, rel) {
  let dir = path.dirname(path.join(base, rel));
  while (dir.startsWith(base + path.sep) && dir !== base) {
    try { fs.rmdirSync(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

export function applySkills(base, bundle, prev, fx, opts = {}) {
  if (isLink(base)) fail(`${base} is a symlink; refusing to write skills through it`);
  const plan = planSkills(bundle, prev, (name) => exists(path.join(base, name)) || isLink(path.join(base, name)), opts);
  const linked = new Set(Object.keys(plan.managed).filter((n) => isLink(path.join(base, n))));
  for (const n of linked) { delete plan.managed[n]; plan.skipped.push(n); }
  let wrote = 0;
  for (const f of plan.write) {
    if (linked.has(f.rel.split('/')[0])) continue;
    const dest = path.join(base, ...f.rel.split('/'));
    if (fx.write(dest, f.content, { backup: false, mode: f.rel.endsWith('.sh') ? 0o755 : undefined })) wrote++;
  }
  let removed = 0;
  for (const rel of plan.remove) {
    if (fx.remove(path.join(base, ...rel.split('/')))) removed++;
    if (!fx.dryRun) pruneEmptyDirs(base, rel);
  }
  return { ...plan, wrote, removed };
}

// ------------------------------------------------------------------ telemetry hook (parity with src/hook.js)

// Python's \w and str.isspace(), so the JS patterns match exactly what the python hook matched.
const W = '[\\p{L}\\p{N}_]';
const SP = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const S = `[${SP}]`;
const NS = `[^${SP}]`;
const B0 = `(?<!${W})`;
const B1 = `(?!${W})`;
const re = (src, flags = 'gu') => new RegExp(src, flags);

export const PATTERNS = [
  [re('-----BEGIN [A-Z ]*PRIVATE KEY-----[^]*?-----END [A-Z ]*PRIVATE KEY-----'), '<REDACTED>'],
  [re(`${B0}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`), '<REDACTED>'],
  [re(`${B0}(authorization${S}*:${S}*(?:bearer|token|basic))${S}+${NS}+`, 'giu'), '$1 <REDACTED>'],
  [re(`${B0}bearer${S}+[A-Za-z0-9._~+/=-]{12,}`, 'giu'), 'bearer <REDACTED>'],
  [re(`${B0}(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}`), '<REDACTED>'],
  [re(`${B0}gh[pousr]_[A-Za-z0-9]{16,}`), '<REDACTED>'],
  [re(`${B0}xox[abprse]-[A-Za-z0-9-]{10,}`), '<REDACTED>'],
  [re(`${B0}AKIA[0-9A-Z]{16}${B1}`), '<REDACTED>'],
  [re(`(--(?:password|token|secret|api-key|apikey)[= ])${NS}+`, 'giu'), '$1<REDACTED>'],
  [re(`${B0}([A-Za-z0-9_]*(?:secret|token|passwd|password|api[_-]?key|apikey|access[_-]?key)[A-Za-z0-9_]*)(${S}*[:=]${S}*)["']?[^${SP}"'&;|]{8,}`, 'giu'), '$1$2<REDACTED>'],
  [re(`${B0}[0-9a-fA-F]{48,}${B1}`), '<REDACTED>'],
];

export function redact(v) {
  if (typeof v === 'string') {
    for (const [pat, rep] of PATTERNS) v = v.replace(pat, rep);
    return v;
  }
  if (Array.isArray(v)) return v.map(redact);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v;
}

const realpathOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function detectSlug(cwd, homeDir = home()) {
  const h = realpathOr(homeDir);
  const start = realpathOr(cwd);
  if (!start || start === h) return '';
  let d = start;
  for (;;) {
    const g = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch { /* none */ }
    if (st?.isDirectory()) return path.basename(d);
    if (st?.isFile()) {
      const text = readText(g);
      if (text === null) return path.basename(d);
      const line = text.trim();
      if (line.startsWith('gitdir:')) {
        let gd = line.split(':').slice(1).join(':').trim();
        if (!path.isAbsolute(gd)) gd = path.join(d, gd);
        gd = realpathOr(gd);
        const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
        if (gd.includes(marker)) return path.basename(gd.split(marker)[0]);
      }
      return path.basename(d);
    }
    const parent = path.dirname(d);
    if (parent === d || d === h) return '';
    d = parent;
  }
}

const pad = (n) => String(n).padStart(2, '0');
export function localStamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}

const cut = (s, n) => [...String(s)].slice(0, n).join('');
const scalarArgs = (ti) => Object.fromEntries(Object.entries(ti).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v).length < 120));

/** Coerce Codex and Cursor hook payloads into the Claude Code PostToolUse shape. */
export function normalizePayload(data) {
  if (!isObj(data)) return {};
  let ti = data.tool_input ?? data.toolInput ?? data.input;
  if (typeof ti === 'string') { try { ti = JSON.parse(ti); } catch { ti = { input: ti }; } }
  if (!isObj(ti)) ti = {};
  let tool = data.tool_name || data.tool || data.toolName;
  if (!tool && typeof data.command === 'string') { tool = 'Bash'; ti = { command: data.command, ...ti }; }
  if (!tool && typeof data.file_path === 'string') { tool = data.hook_event_name === 'afterFileEdit' ? 'Edit' : 'Read'; ti = { file_path: data.file_path, ...ti }; }
  return {
    session_id: data.session_id || data.sessionId || data.conversation_id || data.thread_id || '',
    tool_name: tool || 'unknown',
    tool_input: ti,
    cwd: data.cwd || (Array.isArray(data.workspace_roots) ? data.workspace_roots[0] : ''),
  };
}

export function buildRecord(raw, { surface = 'claude-code', fallbackCwd = '', now = new Date(), homeDir = home() } = {}) {
  const data = normalizePayload(raw);
  const sid = cut([...String(data.session_id || '')].filter((c) => /[\p{L}\p{N}_-]/u.test(c)).join(''), 40);
  if (!sid) return null;
  const tool = data.tool_name;
  const ti = data.tool_input;
  const summary = {};
  if (tool === 'Bash') summary.command = cut(ti.command || '', 500);
  else if (['Edit', 'Write', 'Read', 'NotebookEdit'].includes(tool)) summary.path = ti.file_path || (ti.notebook_path ?? null);
  else if (['WebFetch', 'WebSearch'].includes(tool)) {
    summary.url = ti.url ?? null;
    summary.query = ti.query || (ti.prompt ?? null);
  } else if (String(tool).startsWith('mcp__')) {
    const parts = String(tool).split('__');
    summary.mcp_server = parts[1] ?? '';
    summary.mcp_action = parts[2] ?? '';
    summary.args = scalarArgs(ti);
  } else summary.args = scalarArgs(ti);
  const cwd = String(data.cwd || fallbackCwd || '');
  return {
    ts: localStamp(now),
    session: sid,
    surface,
    cwd: cut(cwd, 300),
    project: detectSlug(cwd, homeDir),
    tool,
    ...redact(summary),
  };
}

function privateDir(d) {
  try {
    const st = fs.lstatSync(d);
    if (!st.isDirectory()) return false;
    return typeof process.getuid !== 'function' || (st.uid === process.getuid() && !(st.mode & 0o077));
  } catch { return false; }
}

function ensureSpool(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return privateDir(dir);
}

function openOwn(p, flags) {
  const fd = fs.openSync(p, flags | (fs.constants.O_NOFOLLOW || 0), 0o600);
  const st = fs.fstatSync(fd);
  if (!st.isFile() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    fs.closeSync(fd);
    throw new Error(`not a private spool file: ${p}`);
  }
  return fd;
}

/** Append one record; returns true when the spool should be flushed. */
export function spoolRecord(rec, dir = paths().spool) {
  if (!ensureSpool(dir)) return false;
  const file = path.join(dir, `${rec.session}.jsonl`);
  const { O_RDWR, O_APPEND, O_CREAT } = fs.constants;
  const fd = openOwn(file, O_RDWR | O_APPEND | O_CREAT);
  let lines;
  try {
    fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
    const buf = Buffer.alloc(fs.fstatSync(fd).size);
    fs.readSync(fd, buf, 0, buf.length, 0);
    lines = buf.toString('utf8').split('\n').filter(Boolean).length;
  } finally { fs.closeSync(fd); }
  if (lines > MAX_SPOOL_LINES) {
    try { fs.renameSync(file, path.join(dir, `${rec.session}.${Math.floor(Date.now() / 1000)}.batch`)); } catch { /* raced */ }
    return true;
  }
  return lines >= FLUSH_AT || fs.readdirSync(dir).some((f) => f.endsWith('.batch'));
}

export async function flushSpool(creds, dir = paths().spool) {
  if (!privateDir(dir)) return { sent: 0 };
  const lock = path.join(dir, '.flush.lock');
  try { fs.mkdirSync(lock); } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 120000) return { sent: 0, locked: true }; } catch { /* gone */ }
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.mkdirSync(lock); } catch { return { sent: 0, locked: true }; }
  }
  let sent = 0;
  try {
    const stamp = Math.floor(Date.now() / 1000);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      try { fs.renameSync(path.join(dir, f), path.join(dir, `${f.slice(0, -6)}.${stamp}.batch`)); } catch { /* raced */ }
    }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.batch')).sort()) {
      const p = path.join(dir, f);
      let records;
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > MAX_BATCH_AGE_MS) { fs.rmSync(p, { force: true }); continue; }
        const fd = openOwn(p, fs.constants.O_RDONLY);
        try { records = fs.readFileSync(fd, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } finally { fs.closeSync(fd); }
      } catch { fs.rmSync(p, { force: true }); continue; }
      let ok = true;
      for (let i = 0; i < records.length && ok; i += CHUNK) {
        try {
          const r = await fetch(`${creds.server}/ingest/tool-calls`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.key}` },
            body: JSON.stringify({ records: records.slice(i, i + CHUNK) }),
            signal: AbortSignal.timeout(15000),
          });
          ok = r.ok;
        } catch { ok = false; }
      }
      if (!ok) break;
      fs.rmSync(p, { force: true });
      sent += records.length;
    }
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  return { sent };
}

async function readStdin(limitMs = 3000) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let buf = '';
    const done = () => { clearTimeout(t); resolve(buf); };
    const t = setTimeout(() => { process.stdin.destroy(); resolve(buf); }, limitMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function cmdHook(sub, opts) {
  try {
    if (sub === 'flush') {
      const creds = loadCreds({ required: false });
      if (creds) await flushSpool(creds);
      return;
    }
    if (sub !== 'post-tool') return;
    const input = await readStdin();
    if (!input.trim() || (!loadConfig()?.server && !process.env.BRAIN_KEY)) return;
    let data;
    try { data = JSON.parse(input); } catch { return; }
    const surface = opts.surface || process.env.BRAIN_SURFACE || (data?.hook_event_name?.startsWith?.('after') ? 'cursor' : 'claude-code');
    const rec = buildRecord(data, { surface, fallbackCwd: process.cwd() });
    if (!rec) return;
    if (spoolRecord(rec)) {
      const child = spawn(process.execPath, [SELF, 'hook', 'flush'], { detached: true, stdio: 'ignore', env: process.env });
      child.on('error', () => {});
      child.unref();
    }
  } catch { /* the hook must never fail a tool call */ }
}

// ------------------------------------------------------------------ bridge

export class LocalServer {
  constructor(name, spec, { log = err } = {}) {
    this.name = name;
    this.spec = spec;
    this.log = log;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.initParams = null;
    this.initResult = null;
    this.initializedSent = false;
    this.starting = null;
    this.selfInit = null;
  }

  async ensure() {
    if (this.proc) return this.starting;
    const { command, args = [], env = {}, cwd } = this.spec;
    if (!command) throw new Error(`server "${this.name}" has no command in bridge.json`);
    const proc = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.initResult = null;
    this.initializedSent = false;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) this.log(`[${this.name}] ${l}`); });
    proc.stdin.on('error', () => {});
    const gone = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.starting = null;
      for (const [, w] of this.pending) { clearTimeout(w.timer); w.reject(new Error(`local server "${this.name}" ${why}`)); }
      this.pending.clear();
    };
    proc.on('error', (e) => gone(`failed to start: ${e.message}`));
    proc.on('exit', (code, sig) => { this.log(`[${this.name}] exited (${sig || code}); it restarts on the next call`); gone(`exited (${sig || code})`); });
    // A restarted child has lost its MCP session: replay the handshake the hub already did.
    this.starting = this.initParams ? this.replayInit() : Promise.resolve();
    return this.starting;
  }

  async replayInit() {
    try {
      const res = await this.rpc({ jsonrpc: '2.0', method: 'initialize', params: this.initParams });
      if (res.result) this.initResult = res.result;
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.initializedSent = true;
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  write(msg) {
    if (!this.proc) throw new Error(`local server "${this.name}" is not running`);
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  rpc(message) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`local server "${this.name}" did not answer in time`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...message, id }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!isObj(m)) return;
    if (m.method && 'id' in m) {
      const reply = m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported over the brain bridge' } };
      try { this.write(reply); } catch { /* child gone */ }
      return;
    }
    const w = 'id' in m ? this.pending.get(m.id) : null;
    if (!w) return;
    clearTimeout(w.timer);
    this.pending.delete(m.id);
    w.resolve(m);
  }

  /** Forward one hub message. Returns the child's response with the hub's id, or null for notifications. */
  async handle(message) {
    if (!isObj(message) || typeof message.method !== 'string') throw new Error('expected a JSON-RPC message');
    const isRequest = 'id' in message;
    await this.ensure();
    // The hub opens a fresh MCP session per call path; the child keeps one, so repeat handshakes are answered here.
    if (message.method === 'initialize' && isRequest && this.initResult) return { jsonrpc: '2.0', id: message.id, result: this.initResult };
    if (message.method === 'notifications/initialized') {
      if (this.initializedSent) return null;
      this.initializedSent = true;
    }
    // A restarted bridge meets a hub whose session is already initialized, so the first message
    // may be tools/call to a child that never saw initialize. Do the handshake on the hub's behalf.
    if (message.method !== 'initialize' && !this.initResult) {
      if (!this.selfInit) {
        this.initParams = { protocolVersion: DEFAULT_PROTOCOL, capabilities: {}, clientInfo: { name: 'brain-bridge', version: VERSION } };
        this.selfInit = this.replayInit().finally(() => { this.selfInit = null; });
      }
      await this.selfInit;
      if (message.method === 'notifications/initialized') return null;
    }
    if (!isRequest) { this.write(message); return null; }
    const res = await this.rpc(message);
    if (message.method === 'initialize' && res.result) {
      this.initParams = message.params ?? {};
      this.initResult = res.result;
    }
    return { ...res, id: message.id };
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } }
  }
}

export async function routeFrame(frame, servers, send) {
  if (!isObj(frame) || frame.type) return;
  const { rid, server, message } = frame;
  const target = servers.get(server);
  if (!target) {
    if (rid) send({ rid, error: `no local server named "${server}" in bridge.json` });
    return;
  }
  try {
    const res = await target.handle(message);
    if (rid) send(res ? { rid, message: res } : { rid, error: 'the local server sent no response' });
  } catch (e) {
    if (rid) send({ rid, error: e.message });
  }
}

export function loadBridgeConfig(file) {
  const cfg = readJson(file, null);
  if (!cfg) fail(`no bridge config at ${file}. Create it like:\n${JSON.stringify({ servers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', home()], env: {} } } }, null, 2)}`);
  if (!isObj(cfg.servers) || !Object.keys(cfg.servers).length) fail(`${file} needs a "servers" object with at least one entry`);
  for (const [name, s] of Object.entries(cfg.servers)) {
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(name)) fail(`bridge server name "${name}" may only use letters, digits, . _ -`);
    if (!isObj(s) || typeof s.command !== 'string') fail(`bridge server "${name}" needs a "command" string`);
    if (s.args !== undefined && !Array.isArray(s.args)) fail(`bridge server "${name}": "args" must be an array`);
  }
  return cfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expandHome = (p) => (p.startsWith('~/') ? path.join(home(), p.slice(2)) : p);

async function frameText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return data.text();
  return String(data);
}

async function cmdBridge(opts) {
  if (typeof globalThis.WebSocket !== 'function') fail(`brain bridge needs Node 22 or newer (global WebSocket); this is Node ${process.versions.node}`);
  const file = expandHome(opts.config || paths().bridge);
  const cfg = loadBridgeConfig(file);
  const creds = loadCreds();
  const servers = new Map(Object.entries(cfg.servers).map(([n, s]) => [n, new LocalServer(n, s)]));
  const machine = creds.machine || '<machine>';
  out(`Exposing ${servers.size} local server(s) from ${file}:`);
  for (const n of servers.keys()) out(`  ${n}  ->  bridge://${machine}/${n}`);
  out(`Add each one in the console (${creds.server}/#connections) with the bridge:// URL above.`);
  out('Servers start on their first call and restart on the next call if they crash. Ctrl-C to stop.');
  const stop = () => { for (const s of servers.values()) s.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const url = `${creds.server.replace(/^http/, 'ws')}/bridge/connect`;
  let delay = 1000;
  for (;;) {
    const result = await new Promise((resolve) => {
      let ws;
      let opened = false;
      const done = (r) => { resolve({ opened, ...r }); };
      try { ws = new WebSocket(url, ['brain.v1', creds.key]); } catch (e) { done({ code: 0, reason: e.message }); return; }
      ws.onopen = () => {
        opened = true;
        delay = 1000;
        ws.send(JSON.stringify({ type: 'hello', servers: [...servers.keys()] }));
        out(`connected to ${creds.server}`);
      };
      ws.onmessage = async (ev) => {
        let frame;
        try { frame = JSON.parse(await frameText(ev.data)); } catch { return; }
        routeFrame(frame, servers, (reply) => { if (ws.readyState === 1) ws.send(JSON.stringify(reply)); });
      };
      // Node's WebSocket fires only "error" (never "close") when the handshake fails, so both settle.
      ws.onerror = () => { if (!opened) done({ code: 0, reason: '' }); };
      ws.onclose = (ev) => done({ code: ev.code, reason: ev.reason });
    });
    if (result.code === 4000) { err('Another `brain bridge` for this machine took over; exiting.'); stop(); }
    let why = result.reason || (result.code ? `close code ${result.code}` : '');
    if (!result.opened) {
      const probe = await probeUpgrade(url, creds.key);
      if (probe.status === 401) { err('brain: the server rejected this key (revoked or expired?); run `brain login`'); stopWith(servers, 1); }
      if (probe.status === 403 || probe.status === 404 || probe.status === 426 || probe.status === 501) { err(`brain: the server refused the bridge (HTTP ${probe.status}${probe.body ? `: ${probe.body}` : ''})`); stopWith(servers, 1); }
      why = probe.status ? `HTTP ${probe.status}` : `cannot reach ${creds.server}${probe.body ? `: ${probe.body}` : ''}`;
    }
    err(`bridge disconnected${why ? ` (${why})` : ''}; retrying in ${delay / 1000}s`);
    await sleep(delay);
    delay = Math.min(delay * 2, 30000);
  }
}

function stopWith(servers, code) {
  for (const s of servers.values()) s.stop();
  process.exit(code);
}

/** Repeat the upgrade by hand to learn why it failed: Node's WebSocket hides the HTTP status. */
export async function probeUpgrade(wsUrl, key, timeout = 10000) {
  const u = new URL(wsUrl.replace(/^ws/, 'http'));
  const mod = u.protocol === 'https:' ? await import('node:https') : await import('node:http');
  const { randomBytes } = await import('node:crypto');
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = mod.request(u, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': `brain.v1, ${key}` },
      timeout,
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); settle({ status: 101 }); });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 2000) body += c; });
      res.on('end', () => settle({ status: res.statusCode, body: body.trim().slice(0, 300) }));
      res.on('error', () => settle({ status: res.statusCode, body: '' }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => settle({ status: 0, body: e.code || e.message }));
    req.end();
  });
}

// ------------------------------------------------------------------ apply / uninstall

export const HARNESSES = ['claude', 'codex', 'cursor', 'gemini', 'opencode'];
const HARNESS_HOME = { claude: ['.claude'], codex: ['.codex'], cursor: ['.cursor'], gemini: ['.gemini'], opencode: ['.config', 'opencode'] };

export function detectHarnesses(h = home(), whichFn = which) {
  return HARNESSES.filter((n) => whichFn(n) || isDir(path.join(h, ...HARNESS_HOME[n])));
}

/** The command harnesses run to reach this CLI: an absolute path, so GUI apps without ~/.local/bin on PATH still work. */
export function selfCommand(whichFn = which) {
  const onPath = whichFn('brain');
  if (onPath) return shq(onPath);
  try { fs.accessSync(SELF, fs.constants.X_OK); return shq(SELF); } catch { return `${shq(process.execPath)} ${shq(SELF)}`; }
}

export const loadManifest = () => readJson(paths().manifest, null) || { version: 1, targets: {}, skills: {}, shell: [] };

function configureJson(file, target, fx) {
  const cur = readJson(file, null);
  const base = cur ?? target.init ?? {};
  const next = setJsonKey(base, target.key, target.value);
  return fx.write(file, jsonText(next));
}

export async function runApply(opts, deps = {}) {
  const fx = deps.fx || makeFx({ dryRun: !!opts['dry-run'] });
  const log = fx.log;
  const h = deps.home || home();
  const creds = deps.creds || loadCreds();
  const whichFn = deps.which || which;
  const cmd = deps.selfCommand || selfCommand(whichFn);
  const manifest = deps.manifest || loadManifest();
  const only = opts.only ? String(opts.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (only) for (const n of only) if (!HARNESSES.includes(n)) fail(`unknown harness "${n}"; pick from ${HARNESSES.join(', ')}`);
  const found = detectHarnesses(h, whichFn).filter((n) => !only || only.includes(n));
  if (!found.length) { log(only ? `None of ${only.join(', ')} is installed here.` : 'No supported harness found (claude, codex, cursor, gemini, opencode).'); }
  const jsonTargets = harnessJsonTargets(creds.server);
  const report = {};
  manifest.server = creds.server;
  manifest.targets ||= {};
  manifest.skills ||= {};

  let bundle = deps.bundle;
  const wantsSkills = found.includes('claude') || found.includes('codex');
  if (wantsSkills && bundle === undefined) {
    try {
      const r = await api(creds.server, '/skills/bundle.json', { key: creds.key, timeout: 30000 });
      bundle = r.ok && r.json && !r.json.error ? r.json : null;
      if (!bundle) report.skills = `skills not synced: ${r.json?.error || `HTTP ${r.status}`}`;
    } catch (e) { bundle = null; report.skills = `skills not synced: ${e.message}`; }
  }
  const syncSkills = (base) => {
    if (!bundle) return 'skills skipped';
    const r = applySkills(base, bundle, manifest.skills[base] || {}, fx, { adopt: !!opts.adopt });
    if (Object.keys(r.managed).length) manifest.skills[base] = r.managed;
    else delete manifest.skills[base];
    const bits = [`${Object.keys(r.managed).length} skills (${r.wrote} files written, ${r.removed} removed)`];
    if (r.skipped.length) bits.push(`skipped existing unmanaged: ${r.skipped.join(', ')} (rerun with --adopt to manage them)`);
    if (r.unsafe.length) bits.push(`rejected ${r.unsafe.length} unsafe path(s)`);
    return bits.join('; ');
  };

  for (const name of found) {
    log(`${name}:`);
    const done = [];
    try {
      if (name === 'claude') {
        if (whichFn('claude')) {
          const spec = JSON.stringify({ type: 'http', url: `${creds.server}/mcp`, headersHelper: `${cmd} auth header` });
          fx.run('claude', ['mcp', 'remove', '-s', 'user', 'brain'], { quietFail: true });
          const r = fx.run('claude', ['mcp', 'add-json', '-s', 'user', 'brain', spec]);
          if (r.status !== 0) fail(`claude mcp add-json failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
          done.push('MCP server registered (user scope)');
        } else done.push('`claude` not on PATH, MCP server not registered (rerun after installing Claude Code)');
        const file = path.join(h, '.claude', 'settings.json');
        fx.write(file, jsonText(withClaudeHook(readJson(file, {}), `${cmd} hook post-tool`)));
        done.push('PostToolUse telemetry hook set');
        done.push(syncSkills(path.join(h, '.claude', 'skills')));
      } else if (name === 'codex') {
        const file = path.join(h, '.codex', 'config.toml');
        fx.write(file, upsertCodexConfig(readText(file) ?? '', creds.server));
        done.push('MCP server set in config.toml');
        done.push(syncSkills(path.join(h, '.agents', 'skills')));
      } else {
        const t = jsonTargets[name];
        configureJson(path.join(h, ...t.file), t, fx);
        done.push(`MCP server set in ${path.join('~', ...t.file)}`);
      }
      manifest.targets[name] = { at: new Date().toISOString() };
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      done.push(`FAILED: ${e.message}`);
    }
    for (const d of done) log(`  ${d}`);
    report[name] = done;
  }

  if (opts.shell) {
    const rcs = ['.zshrc', '.bashrc'].map((f) => path.join(h, f));
    let targets = rcs.filter(exists);
    if (!targets.length) targets = [path.join(h, (process.env.SHELL || '').endsWith('bash') ? '.bashrc' : '.zshrc')];
    for (const rc of targets) fx.write(rc, upsertBlock(readText(rc) ?? '', shellBlock(cmd)));
    manifest.shell = [...new Set([...(manifest.shell || []), ...targets])];
    log(`shell: BRAIN_KEY exported from ${targets.map((t) => path.basename(t)).join(', ')} (open a new shell)`);
  } else if (found.some((n) => n !== 'claude')) {
    log('note: Codex, Cursor, Gemini and OpenCode read BRAIN_KEY from the environment; run `brain apply --shell` or export BRAIN_KEY="$(brain auth token)".');
  }
  if (report.skills) log(report.skills);
  if (!fx.dryRun) writeAtomic(paths(h).manifest, jsonText(manifest), 0o600);
  else log(`dry run: ${fx.changed.length} change(s) not applied`);
  return { found, report, manifest, changed: fx.changed };
}

export async function runUninstall(deps = {}) {
  const fx = deps.fx || makeFx({});
  const h = deps.home || home();
  const whichFn = deps.which || which;
  const manifest = deps.manifest || loadManifest();
  const summary = [];
  const note = (s) => { summary.push(s); fx.log(`  ${s}`); };

  if (whichFn('claude')) {
    const r = fx.run('claude', ['mcp', 'remove', '-s', 'user', 'brain'], { quietFail: true });
    if (r.status === 0) note('claude: MCP server removed');
  }
  // A file brain created (no backup) and that holds nothing else afterwards is removed, not left as {}.
  const writeOrDrop = (file, next, init = {}) => {
    if (!exists(`${file}.brain-backup`) && JSON.stringify(next) === JSON.stringify(init)) return fx.remove(file);
    return fx.write(file, jsonText(next));
  };
  const claudeSettings = path.join(h, '.claude', 'settings.json');
  const cs = readJson(claudeSettings, null);
  if (cs && JSON.stringify(withoutClaudeHook(cs)) !== JSON.stringify(cs) && writeOrDrop(claudeSettings, withoutClaudeHook(cs))) note('claude: telemetry hook removed');

  const codex = path.join(h, '.codex', 'config.toml');
  const ct = readText(codex);
  if (ct !== null && hasBlock(ct) && fx.write(codex, removeBlock(ct))) note('codex: managed block removed');

  for (const [name, t] of Object.entries(harnessJsonTargets(manifest.server || DEFAULT_SERVER))) {
    const file = path.join(h, ...t.file);
    const cur = readJson(file, null);
    const entry = getJsonKey(cur, t.key);
    const ours = manifest.targets?.[name] || (isObj(entry) && String(entry.url || entry.httpUrl || '').endsWith('/mcp') && JSON.stringify(entry).includes('BRAIN_KEY'));
    if (entry !== undefined && ours && writeOrDrop(file, deleteJsonKeyPruned(cur, t.key), t.init)) note(`${name}: MCP entry removed`);
  }

  for (const rc of new Set([...(manifest.shell || []), path.join(h, '.zshrc'), path.join(h, '.bashrc')])) {
    const t = readText(rc);
    if (t !== null && hasBlock(t) && fx.write(rc, removeBlock(t))) note(`shell: block removed from ${rc}`);
  }

  for (const [base, skills] of Object.entries(manifest.skills || {})) {
    const r = applySkills(base, { files: [] }, skills, fx);
    if (r.removed) note(`skills: ${Object.keys(skills).length} removed from ${base}`);
  }

  if (!fx.dryRun) {
    fs.rmSync(paths(h).manifest, { force: true });
    writeAtomic(paths(h).uninstallLog, jsonText({ at: new Date().toISOString(), removed: summary }), 0o600);
  }
  return summary;
}

// ------------------------------------------------------------------ commands

async function cmdLogin(opts) {
  const server = normalizeServer(opts.server || process.env.BRAIN_URL || loadConfig()?.server || DEFAULT_SERVER);
  const machine = defaultMachine(opts.machine || os.hostname());
  const agent = String(opts.agent || 'cli').toLowerCase().slice(0, 40);
  const start = await api(server, '/device/code', { method: 'POST', body: { machine, agent } });
  if (start.ok && !start.json) fail(`${server} did not answer like a BrainMCP server (HTTP ${start.status}, not JSON); check --server`);
  if (!start.ok || !start.json?.device_code) fail(`login could not start: ${start.json?.error_description || start.json?.error || `HTTP ${start.status}`}`);
  const { device_code: deviceCode, user_code: code, expires_in: expiresIn = 900 } = start.json;
  let interval = Math.max(1, Number(start.json.interval) || 5);
  out(`To approve this machine (${machine}), open:\n\n  ${server}/#device?code=${code}\n\nand confirm the code  ${code}\n`);
  out('Waiting for approval...');
  const deadline = Date.now() + expiresIn * 1000;
  let got = null;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await api(server, '/device/token', { method: 'POST', body: { device_code: deviceCode } }).catch((e) => ({ json: { error: 'network' }, status: 0, msg: e.message }));
    if (r.ok && r.json?.key) { got = r.json; break; }
    const e = r.json?.error;
    if (e === 'authorization_pending' || e === 'network') continue;
    if (e === 'slow_down' || r.status === 429) { interval += 5; continue; }
    if (e === 'access_denied') fail('login was denied in the console');
    if (e === 'expired_token') fail('the code expired; run `brain login` again');
    fail(`login failed: ${e || `HTTP ${r.status}`}`);
  }
  if (!got) fail('the code expired; run `brain login` again');
  const old = loadConfig();
  if (old?.server) deleteSecret(old.store || 'file', old.server);
  let store = pickStore();
  if (!storeSecret(store, server, got.key)) {
    err(`could not save the key to the ${store}; using ${paths().credFile} (mode 600) instead`);
    store = 'file';
    storeSecret(store, server, got.key);
  }
  saveConfig({ server, machine: got.machine || machine, agent: got.agent || agent, store });
  out(`Logged in as machine "${got.machine || machine}" on ${server} (key stored in ${store === 'file' ? paths().credFile : store}).`);
  out('Next: `brain apply` to wire up your coding agents.');
}

function cmdLogout() {
  const cfg = loadConfig();
  if (!cfg?.server) { out('Not logged in.'); return; }
  deleteSecret(cfg.store || 'file', cfg.server);
  fs.rmSync(paths().configFile, { force: true });
  out(`Logged out of ${cfg.server}. The key still exists on the server; revoke it in the console (${cfg.server}/#keys) if this machine is gone for good.`);
}

async function cmdWhoami() {
  const creds = loadCreds();
  const text = await mcpCall(creds, 'whoami');
  try { out(JSON.stringify(JSON.parse(text), null, 2)); } catch { out(text); }
}

function cmdStatus() {
  const cfg = loadConfig();
  const creds = loadCreds({ required: false });
  const m = loadManifest();
  out(`server:      ${creds?.server || cfg?.server || '(not logged in)'}`);
  out(`machine:     ${cfg?.machine || '-'}  agent: ${cfg?.agent || '-'}`);
  out(`credentials: ${creds ? `stored (${creds.store})` : 'none'}`);
  out(`configured:  ${Object.keys(m.targets || {}).join(', ') || 'nothing yet (run `brain apply`)'}`);
  for (const [base, skills] of Object.entries(m.skills || {})) out(`skills:      ${Object.keys(skills).length} in ${base}`);
  if (m.shell?.length) out(`shell:       ${m.shell.join(', ')}`);
  const spool = paths().spool;
  const pending = isDir(spool) ? fs.readdirSync(spool).filter((f) => /\.(jsonl|batch)$/.test(f)).length : 0;
  out(`telemetry:   ${pending} spool file(s) waiting`);
}

function cmdAuth(sub) {
  const creds = loadCreds();
  if (sub === 'header') out(JSON.stringify({ Authorization: `Bearer ${creds.key}` }));
  else if (sub === 'token') out(creds.key);
  else fail('usage: brain auth header|token');
}

async function cmdDoctor() {
  let bad = 0;
  const line = (ok, label, detail = '') => { if (ok === false) bad++; out(`${ok === true ? ' ok ' : ok === false ? 'FAIL' : 'warn'}  ${label}${detail ? `: ${detail}` : ''}`); };
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20, 'node', `${process.versions.node}${major < 22 ? ' (brain bridge needs 22+)' : ''}`);
  const creds = loadCreds({ required: false });
  line(!!creds, 'credentials', creds ? `${creds.store} for ${creds.server}` : 'run `brain login`');
  if (creds) {
    try {
      const r = await api(creds.server, '/health', { timeout: 10000 });
      line(r.ok, 'server', `${creds.server}/health -> HTTP ${r.status}`);
    } catch (e) { line(false, 'server', e.message); }
    try {
      const who = JSON.parse(await mcpCall(creds, 'whoami'));
      line(true, 'whoami', `${who.user || '?'} (key role ${who.key?.role || '?'})`);
    } catch (e) { line(false, 'whoami', e.message); }
  }
  const h = home();
  const m = loadManifest();
  const jt = harnessJsonTargets(creds?.server || m.server || DEFAULT_SERVER);
  for (const n of detectHarnesses()) {
    let ok;
    try {
      if (n === 'claude') ok = JSON.stringify(readJson(path.join(h, '.claude', 'settings.json'), {}) || {}).includes('hook post-tool');
      else if (n === 'codex') ok = hasBlock(readText(path.join(h, '.codex', 'config.toml')));
      else ok = getJsonKey(readJson(path.join(h, ...jt[n].file), {}), jt[n].key) !== undefined;
    } catch { ok = false; }
    line(ok ? true : null, n, ok ? 'configured' : 'not configured (run `brain apply`)');
  }
  const envKey = process.env.BRAIN_KEY;
  line(envKey ? (creds && envKey !== creds.key ? null : true) : null, 'BRAIN_KEY env', envKey ? (creds && envKey !== creds.key ? 'set but differs from the stored key (open a new shell)' : 'set') : 'not set (Codex/Cursor/Gemini/OpenCode need it; `brain apply --shell`)');
  if (bad) process.exitCode = 1;
}

async function cmdUninstall(opts) {
  out('Removing brain-managed configuration:');
  const summary = await runUninstall({ fx: makeFx({ dryRun: !!opts['dry-run'] }) });
  if (!summary.length) out('  nothing to remove');
  out(`Credentials are kept; run \`brain logout\` to remove them.${opts['dry-run'] ? '' : ` Summary saved to ${paths().uninstallLog}.`}`);
}

const HELP = `brain ${VERSION}: connect this machine's coding agents to BrainMCP

Usage: brain <command> [options]

  login [--server URL] [--machine NAME] [--agent NAME]
                       approve this machine in the browser and store its key
  logout               forget the stored key
  whoami               show the account behind the key
  status               show login, configured agents, skills
  apply [--dry-run] [--only claude,codex,cursor,gemini,opencode] [--shell] [--adopt]
                       register BrainMCP in every installed agent and sync skills
  uninstall [--dry-run]
                       remove everything apply added
  bridge [--config FILE]
                       expose local stdio MCP servers (default ~/.config/brain/bridge.json)
  doctor               check node, credentials, server, agents, BRAIN_KEY
  auth header|token    print the auth header JSON or the bare key (for agents)
  hook post-tool       telemetry hook (reads the PostToolUse JSON on stdin)
  help, --version
`;

const BOOL = new Set(['dry-run', 'shell', 'adopt', 'help', 'version']);
export function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { opts.help = true; continue; }
    if (a === '-v') { opts.version = true; continue; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) opts[k] = v;
    else if (BOOL.has(k)) opts[k] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
    else fail(`--${k} needs a value`);
  }
  return { pos, opts };
}

export async function main(argv = process.argv.slice(2)) {
  const [first, sub] = argv;
  if (first === 'hook') return cmdHook(sub, parseArgs(argv.slice(2)).opts);
  const { pos, opts } = parseArgs(argv);
  if (opts.version) return out(VERSION);
  const cmd = pos[0] || 'help';
  if (opts.help || cmd === 'help') return out(HELP);
  switch (cmd) {
    case 'login': return cmdLogin(opts);
    case 'logout': return cmdLogout();
    case 'whoami': return cmdWhoami();
    case 'status': return cmdStatus();
    case 'auth': return cmdAuth(pos[1]);
    case 'apply': return void (await runApply(opts));
    case 'uninstall': return cmdUninstall(opts);
    case 'bridge': return cmdBridge(opts);
    case 'doctor': return cmdDoctor();
    default: fail(`unknown command "${cmd}"; see \`brain help\``);
  }
}

const isEntry = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();

if (isEntry) {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    err(`brain needs Node 20 or newer; this is ${process.versions.node}`);
    process.exit(1);
  }
  main().catch((e) => {
    if (process.argv[2] === 'hook') process.exit(0);
    err(e instanceof CliError ? `brain: ${e.message}` : `brain: unexpected error: ${e.stack || e.message}`);
    process.exit(1);
  });
}
