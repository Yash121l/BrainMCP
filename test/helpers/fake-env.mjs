// In-memory Worker bindings for node:test. No network, no wrangler.
//
//   fakeEnv(overrides)  -> { DB, LOGS, BRAIN_TOKEN, REPO, BRANCH, GITHUB_TOKEN, WEBHOOK_SECRET, ...overrides }
//   fakeD1()            -> D1-like DB (prepare/bind/first/all/run/raw, batch, exec) on node:sqlite + schema.sql.
//                          The raw DatabaseSync is on `.sqlite` for seeding and assertions.
//   fakeR2()            -> R2-like bucket (get/put/head/delete/list) over a Map, exposed as `.objects`.
//   fakeCtx()           -> ExecutionContext; awaited waitUntil promises collect on `.pending`.
//   stubFetch(handler)  -> replaces globalThis.fetch; records { method, url, headers, body } on `.calls`.
//                          With no handler every request throws. Call `.restore()` when done.
//   advanceClock(env, days) -> moves "now" forward by shifting stored api_keys/oauth timestamps back.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SpaceDO } from '../../src/store.js';
import { AuditDO } from '../../src/audit.js';

const SCHEMA = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

function bindable(v) {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
const plain = (row) => (row ? { ...row } : null);

// D1 rejects LIKE/GLOB patterns longer than 50 bytes; node:sqlite has no such limit.
const D1_PATTERN_MAX = 50;

export function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);

  const statement = (sql, args = []) => {
    if (/\b(LIKE|GLOB)\b/i.test(sql)) {
      for (const a of args) {
        if (typeof a === 'string' && Buffer.byteLength(a) > D1_PATTERN_MAX) throw new Error('D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR');
      }
    }
    const exec = () => {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    };
    return {
      bind: (...a) => statement(sql, a.map(bindable)),
      async first(col) {
        const row = plain(sqlite.prepare(sql).get(...args));
        return col ? (row ? row[col] ?? null : null) : row;
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...args).map(plain), meta: {} };
      },
      async raw() {
        return sqlite.prepare(sql).all(...args).map((r) => Object.values(r));
      },
      async run() { return exec(); },
      _exec: exec,
    };
  };

  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { sqlite.exec(sql); return { count: 1 }; },
  };
}

export function fakeR2() {
  const objects = new Map();
  const obj = (key, v) => ({ key, size: v.body.length, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata,
    text: async () => v.body, json: async () => JSON.parse(v.body), arrayBuffer: async () => new TextEncoder().encode(v.body).buffer });
  return {
    objects,
    async get(key) { return objects.has(key) ? obj(key, objects.get(key)) : null; },
    async head(key) { return objects.has(key) ? obj(key, objects.get(key)) : null; },
    async put(key, value, opts = {}) {
      const body = typeof value === 'string' ? value : new TextDecoder().decode(value);
      objects.set(key, { body, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
      return obj(key, objects.get(key));
    },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async list({ prefix = '' } = {}) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => obj(k, objects.get(k))), truncated: false };
    },
  };
}

export function fakeDOState() {
  let db = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      exec(sql, ...args) {
        const stmt = db.prepare(sql);
        const reads = /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
        let rows = [];
        let changes = 0;
        if (reads) rows = stmt.all(...args.map(bindable)).map(plain);
        else changes = Number(stmt.run(...args.map(bindable)).changes);
        return { toArray: () => rows, one: () => rows[0], rowsWritten: changes };
      },
    },
    transactionSync(fn) {
      db.exec('SAVEPOINT tx');
      try {
        const out = fn();
        db.exec('RELEASE tx');
        return out;
      } catch (e) {
        db.exec('ROLLBACK TO tx');
        db.exec('RELEASE tx');
        throw e;
      }
    },
    async deleteAll() { db.close(); db = new DatabaseSync(':memory:'); },
  };
  return { storage, blockConcurrencyWhile: async (fn) => fn(), get sqlite() { return db; } };
}

export function fakeDONamespace(Cls, getEnv) {
  const instances = new Map();
  return {
    instances,
    idFromName: (name) => ({ name, toString: () => name }),
    get(id) {
      return {
        async fetch(url, init) {
          if (!instances.has(id.name)) instances.set(id.name, new Cls(fakeDOState(), getEnv()));
          return instances.get(id.name).fetch(new Request(url, init));
        },
      };
    },
  };
}

export const TEST_KEK = Buffer.alloc(32, 7).toString('base64');

export function fakeEnv(overrides = {}) {
  const env = {
    DB: fakeD1(),
    LOGS: fakeR2(),
    BRAIN_TOKEN: 'test-root-token-0000000000000000',
    REPO: 'test-owner/test-brain',
    BRANCH: 'main',
    GITHUB_TOKEN: 'test-github-token',
    WEBHOOK_SECRET: 'test-webhook-secret',
    BRAIN_KEK: TEST_KEK,
    ...overrides,
  };
  if (!('SPACES' in overrides)) env.SPACES = fakeDONamespace(SpaceDO, () => env);
  if (!('AUDIT' in overrides)) env.AUDIT = fakeDONamespace(AuditDO, () => env);
  return env;
}

export function fakeCtx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
}

export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const body = req.body ? await req.clone().text() : null;
    calls.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers), body });
    if (!handler) throw new Error(`network disabled in tests: ${req.method} ${req.url}`);
    return handler(req, calls.at(-1));
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

export function advanceClock(env, days) {
  const d = `'-${Number(days)} days'`;
  env.DB.sqlite.exec(`
    UPDATE api_keys SET expires = datetime(expires, ${d}) WHERE expires IS NOT NULL AND expires != '';
    UPDATE api_keys SET created = datetime(created, ${d});
    UPDATE oauth_tokens SET exp = datetime(exp, ${d});
    UPDATE oauth_codes SET exp = datetime(exp, ${d});`);
}
