import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'ui/public/cli/brain.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cli-test-'));
const REAL_HOME = process.env.HOME;
let homeN = 0;
const freshHome = () => {
  const h = path.join(TMP, `home${homeN++}`);
  fs.mkdirSync(h, { recursive: true });
  process.env.HOME = h;
  return h;
};
process.env.HOME = path.join(TMP, 'never-used');
process.env.BRAIN_CRED_STORE = 'file';
delete process.env.BRAIN_KEY;
delete process.env.BRAIN_URL;
delete process.env.BRAIN_SPOOL;

const cli = await import(CLI);

before(() => assert.notEqual(process.env.HOME, REAL_HOME));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SERVER = 'https://brain.test';
const quietFx = (dryRun = false) => cli.makeFx({ dryRun, log: () => {} });

// ---------------------------------------------------------------- managed blocks

test('managed block upsert/remove round-trips TOML and keeps user content', () => {
  const user = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
  const once = cli.upsertCodexConfig(user, SERVER);
  assert.ok(once.startsWith(user));
  assert.match(once, /# >>> brain \(managed\)\n\[mcp_servers\.brain\]\nurl = "https:\/\/brain\.test\/mcp"\nbearer_token_env_var = "BRAIN_KEY_CODEX"\n# <<< brain \(managed\)\n$/);
  assert.equal(cli.upsertCodexConfig(once, SERVER), once, 'idempotent');
  const moved = cli.upsertCodexConfig(once, 'https://other.test');
  assert.equal(moved.match(/# >>> brain/g).length, 1, 'replaced, not duplicated');
  assert.match(moved, /other\.test\/mcp/);
  assert.equal(cli.removeBlock(once), user);
  assert.equal(cli.removeBlock(user), user);
  assert.equal(cli.upsertBlock('', 'x'), `${cli.BLOCK_START}\nx\n${cli.BLOCK_END}\n`);
});

test('managed block in the middle of a file is replaced in place', () => {
  const text = `a = 1\n${cli.BLOCK_START}\nold\n${cli.BLOCK_END}\n[tail]\nb = 2\n`;
  assert.equal(cli.upsertBlock(text, 'new'), `a = 1\n${cli.BLOCK_START}\nnew\n${cli.BLOCK_END}\n[tail]\nb = 2\n`);
  assert.equal(cli.removeBlock(text), 'a = 1\n[tail]\nb = 2\n');
});

test('codex refuses to add a second [mcp_servers.brain] table', () => {
  assert.throws(() => cli.upsertCodexConfig('[mcp_servers.brain]\nurl = "x"\n', SERVER), /unmanaged \[mcp_servers\.brain\]/);
  assert.throws(() => cli.upsertBlock(`${cli.BLOCK_START}\nno end\n`, 'x'), /closing line/);
});

test('shell rc block exports one BRAIN_KEY_<AGENT> per agent and is idempotent', () => {
  const rc = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -l"';
  const body = cli.shellBlock('/home/me/.local/bin/brain', ['codex', 'cursor']);
  assert.equal(body, [
    'export BRAIN_KEY_CODEX="$(/home/me/.local/bin/brain auth token --agent codex 2>/dev/null)"',
    'export BRAIN_KEY_CURSOR="$(/home/me/.local/bin/brain auth token --agent cursor 2>/dev/null)"',
  ].join('\n'));
  assert.equal(cli.envVarFor('claude-code'), 'BRAIN_KEY_CLAUDE_CODE');
  const once = cli.upsertBlock(rc, body);
  assert.equal(cli.upsertBlock(once, body), once);
  assert.equal(cli.removeBlock(once), `${rc}\n`);
});

// ---------------------------------------------------------------- JSON configs

test('cursor/gemini/opencode entries merge without touching other servers', () => {
  const t = cli.harnessJsonTargets(SERVER);
  const cursor = { mcpServers: { github: { url: 'https://gh' } }, other: true };
  const c1 = cli.setJsonKey(cursor, t.cursor.key, t.cursor.value);
  assert.deepEqual(c1.mcpServers.github, { url: 'https://gh' });
  assert.equal(c1.other, true);
  assert.deepEqual(c1.mcpServers.brain, { url: `${SERVER}/mcp`, headers: { Authorization: 'Bearer ${env:BRAIN_KEY_CURSOR}' } });
  assert.deepEqual(cli.setJsonKey(c1, t.cursor.key, t.cursor.value), c1, 'idempotent');
  assert.deepEqual(cursor, { mcpServers: { github: { url: 'https://gh' } }, other: true }, 'input not mutated');
  assert.deepEqual(cli.deleteJsonKey(c1, t.cursor.key), cursor);

  const g = cli.setJsonKey({ theme: 'dark' }, t.gemini.key, t.gemini.value);
  assert.deepEqual(g, { theme: 'dark', mcpServers: { brain: { httpUrl: `${SERVER}/mcp`, headers: { Authorization: 'Bearer $BRAIN_KEY_GEMINI' } } } });

  const o = cli.setJsonKey(t.opencode.init, t.opencode.key, t.opencode.value);
  assert.deepEqual(o.mcp.brain, { type: 'remote', url: `${SERVER}/mcp`, headers: { Authorization: 'Bearer {env:BRAIN_KEY_OPENCODE}' }, enabled: true });
  assert.equal(o.$schema, 'https://opencode.ai/config.json');
});

test('claude settings hook merge preserves other hooks and replaces old brain hooks', () => {
  const settings = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/brain-telemetry.sh' }, { type: 'command', command: 'fmt.sh' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: "'/old path/brain' hook post-tool" }] },
      ],
    },
  };
  const cmd = '/Users/me/.local/bin/brain hook post-tool';
  const once = cli.withClaudeHook(settings, cmd);
  assert.equal(once.model, 'opus');
  assert.deepEqual(once.hooks.PreToolUse, settings.hooks.PreToolUse);
  assert.deepEqual(once.hooks.PostToolUse, [
    { matcher: '*', hooks: [{ type: 'command', command: 'fmt.sh' }] },
    { matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10 }] },
  ]);
  assert.deepEqual(cli.withClaudeHook(once, cmd), once, 'idempotent');
  const removed = cli.withoutClaudeHook(once);
  assert.deepEqual(removed.hooks.PostToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: 'fmt.sh' }] }]);
  assert.deepEqual(cli.withoutClaudeHook(cli.withClaudeHook({}, cmd)), {});
  assert.equal(cli.isBrainHookCommand('my-hook post-tool'), false);
});

// ---------------------------------------------------------------- skills

test('skill paths: rejects traversal, absolute and dot segments', () => {
  assert.deepEqual(cli.safeSkillPath('unslop/SKILL.md'), ['unslop', 'SKILL.md']);
  assert.deepEqual(cli.safeSkillPath('a/scripts/run.sh'), ['a', 'scripts', 'run.sh']);
  for (const bad of ['../x/SKILL.md', 'a/../../etc/passwd', '/etc/passwd', 'a/./b', './a/b', 'a//b', 'SKILL.md', 'a\\b', 'C:/x/y', 'a/b/..', '', null, 'a/\0b']) {
    assert.equal(cli.safeSkillPath(bad), null, String(bad));
  }
});

test('skill sync writes, prunes removed skills, and never touches unmanaged folders', () => {
  const h = freshHome();
  const base = path.join(h, '.claude', 'skills');
  fs.mkdirSync(path.join(base, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(base, 'mine', 'SKILL.md'), 'my own');
  const bundle = {
    files: [
      { path: 'unslop/SKILL.md', content: 'u1' },
      { path: 'tdd/SKILL.md', content: 't1' },
      { path: 'tdd/scripts/run.sh', content: 'echo hi' },
      { path: 'mine/SKILL.md', content: 'server copy' },
      { path: '../escape/SKILL.md', content: 'x' },
    ],
  };
  const fx = quietFx();
  const r1 = cli.applySkills(base, bundle, {}, fx);
  assert.deepEqual(Object.keys(r1.managed).sort(), ['tdd', 'unslop']);
  assert.deepEqual(r1.skipped, ['mine']);
  assert.equal(r1.unsafe.length, 1);
  assert.equal(fs.readFileSync(path.join(base, 'mine', 'SKILL.md'), 'utf8'), 'my own');
  assert.equal(fs.readFileSync(path.join(base, 'tdd', 'SKILL.md'), 'utf8'), 't1');
  assert.ok(fs.statSync(path.join(base, 'tdd', 'scripts', 'run.sh')).mode & 0o100);
  assert.ok(!fs.existsSync(path.join(h, '.claude', 'escape')));

  const r2 = cli.applySkills(base, bundle, r1.managed, quietFx());
  assert.equal(r2.wrote, 0, 'second sync is a no-op');

  const r3 = cli.applySkills(base, { files: [{ path: 'unslop/SKILL.md', content: 'u2' }] }, r2.managed, quietFx());
  assert.equal(r3.removed, 2);
  assert.ok(!fs.existsSync(path.join(base, 'tdd')), 'removed skill folder pruned');
  assert.equal(fs.readFileSync(path.join(base, 'unslop', 'SKILL.md'), 'utf8'), 'u2');
  assert.ok(fs.existsSync(path.join(base, 'mine', 'SKILL.md')));

  const adopt = cli.planSkills(bundle, {}, (n) => n === 'mine', { adopt: true });
  assert.ok(adopt.managed.mine);
  const forged = cli.planSkills({ files: [] }, { unslop: ['unslop/SKILL.md', '../../.ssh/id_rsa', 'other/x.md'] });
  assert.deepEqual(forged.remove, ['unslop/SKILL.md'], 'manifest entries outside their own skill are ignored');
});

const outsideDir = (tag) => {
  const d = path.join(TMP, `outside-${tag}-${homeN}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), 'external');
  fs.writeFileSync(path.join(d, 'run.sh'), 'external script');
  return d;
};

test('skill writes never follow a nested directory symlink out of the skills folder', () => {
  const h = freshHome();
  const base = path.join(h, '.claude', 'skills');
  const outside = outsideDir('nested');
  fs.mkdirSync(path.join(base, 'tdd'), { recursive: true });
  fs.symlinkSync(outside, path.join(base, 'tdd', 'scripts'));
  const bundle = { files: [{ path: 'tdd/SKILL.md', content: 't1' }, { path: 'tdd/scripts/run.sh', content: 'pwned' }] };
  const r = cli.applySkills(base, bundle, { tdd: ['tdd/SKILL.md', 'tdd/scripts/run.sh'] }, quietFx());
  assert.equal(fs.readFileSync(path.join(outside, 'run.sh'), 'utf8'), 'external script', 'external file untouched');
  assert.equal(fs.readFileSync(path.join(base, 'tdd', 'SKILL.md'), 'utf8'), 't1');
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0], /tdd\/scripts\/run\.sh \(tdd\/scripts is a symlink\)/);
  assert.deepEqual(r.managed, { tdd: ['tdd/SKILL.md'] }, 'refused file is not recorded as managed');

  // Removal through the same symlinked directory is refused as well.
  const r2 = cli.applySkills(base, { files: [] }, { tdd: ['tdd/SKILL.md', 'tdd/scripts/run.sh'] }, quietFx());
  assert.equal(r2.removed, 1);
  assert.ok(fs.existsSync(path.join(outside, 'run.sh')));
  assert.ok(fs.existsSync(path.join(outside, 'SKILL.md')));

  // A symlink at the final path is replaced, never written through.
  fs.mkdirSync(path.join(base, 'solo'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(base, 'solo', 'SKILL.md'));
  cli.applySkills(base, { files: [{ path: 'solo/SKILL.md', content: 'mine now' }] }, { solo: ['solo/SKILL.md'] }, quietFx());
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'external');
  assert.ok(!fs.lstatSync(path.join(base, 'solo', 'SKILL.md')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(base, 'solo', 'SKILL.md'), 'utf8'), 'mine now');

  // A symlinked managed file is not deleted (neither the link nor its target).
  fs.rmSync(path.join(base, 'solo', 'SKILL.md'));
  fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(base, 'solo', 'SKILL.md'));
  const r3 = cli.applySkills(base, { files: [] }, { solo: ['solo/SKILL.md'] }, quietFx());
  assert.equal(r3.removed, 0);
  assert.match(r3.refused[0], /is a symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'external');
});

test('a managed skill folder swapped for a symlink survives apply with an empty bundle and uninstall', async () => {
  const h = freshHome();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  const outside = outsideDir('swap');
  const deps = (bundle) => ({ home: h, creds: { server: SERVER, key: 'k', keys: { cli: 'k', 'claude-code': 'k2' } }, which: () => null, selfCommand: '/opt/brain', bundle, fx: quietFx() });
  await cli.runApply({ only: 'claude' }, deps({ files: [{ path: 'unslop/SKILL.md', content: 'u' }] }));
  const base = path.join(h, '.claude', 'skills');
  assert.equal(fs.readFileSync(path.join(base, 'unslop', 'SKILL.md'), 'utf8'), 'u');
  fs.rmSync(path.join(base, 'unslop'), { recursive: true });
  fs.symlinkSync(outside, path.join(base, 'unslop'));
  const manifestBefore = cli.loadManifest();

  const r = await cli.runApply({ only: 'claude' }, deps({ files: [] }));
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'external', 'apply did not delete through the symlink');
  assert.ok(r.report.claude.some((l) => /refused 1 path/.test(l)), r.report.claude.join('\n'));

  // Uninstall with the manifest as it was right after install (skill still listed).
  const summary = await cli.runUninstall({ home: h, which: () => null, fx: quietFx(), manifest: manifestBefore });
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'external', 'uninstall did not delete through the symlink');
  assert.ok(fs.existsSync(path.join(outside, 'run.sh')));
  assert.ok(summary.some((l) => /left 1 path/.test(l)), summary.join('\n'));
  assert.ok(fs.lstatSync(path.join(base, 'unslop')).isSymbolicLink(), 'the user symlink itself is left alone');
});

test('skillTarget refuses a symlinked base, files that are directories, and missing parents on removal', () => {
  const h = freshHome();
  const real = path.join(h, 'real');
  fs.mkdirSync(path.join(real, 'a'), { recursive: true });
  fs.symlinkSync(real, path.join(h, 'linked'));
  assert.match(cli.skillTarget(path.join(h, 'linked'), 'a/SKILL.md').error, /not a real directory/);
  assert.throws(() => cli.applySkills(path.join(h, 'linked'), { files: [] }, {}, quietFx()), /symlink/);
  assert.deepEqual(cli.skillTarget(real, 'b/SKILL.md'), { missing: true });
  assert.equal(cli.skillTarget(real, '../x/y').error, 'unsafe path');
  fs.mkdirSync(path.join(real, 'a', 'SKILL.md'));
  const r = cli.applySkills(real, { files: [{ path: 'a/SKILL.md', content: 'x' }] }, { a: ['a/SKILL.md'] }, quietFx());
  assert.match(r.refused[0], /not a regular file/);
});

// ---------------------------------------------------------------- redaction parity with src/hook.js

const hookSrc = fs.readFileSync(path.join(ROOT, 'src/hook.js'), 'utf8');
const pyBlock = (name) => {
  const m = new RegExp(`const ${name} = String\\.raw\`([\\s\\S]*?)\`;`).exec(hookSrc);
  assert.ok(m, `${name} not found in src/hook.js`);
  return m[1];
};
const hasPython = spawnSync('python3', ['--version']).status === 0;

const SAMPLES = [
  'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x',
  'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
  'git push https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x',
  'token=supersecretvalue123 password: "hunter2hunter2" api-key=abc',
  'mysql --password=hunter22 --token abc123456 -u root',
  'aws AKIAABCDEFGHIJKLMNOP s3 ls; slack xoxb-1234567890-abcdef',
  'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  `cat <<EOF\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nEOF`,
  `sha ${'a1'.repeat(30)} and short ${'ab'.repeat(10)}`,
  'naïvesk-abcdefghijklmnop éAKIAABCDEFGHIJKLMNOP',
  'MY_SECRET\x1c=\x1cabcdefghijkl and bearer\u00a0abcdefghijklmnop',
  'ſecret=abcdefghijk Kelvin_TOKEN=abcdefghijk',
  'nothing to see here: ls -la /tmp',
];

test('redact() matches the python hook pattern-for-pattern', { skip: !hasPython && 'python3 not installed' }, () => {
  const py = pyBlock('PY_APPEND');
  const patterns = py.slice(py.indexOf('PATTERNS = ['), py.indexOf('\n\ndef detect_slug'));
  const script = `import json, re, sys\n${patterns}\nprint(json.dumps([redact(s) for s in json.loads(sys.stdin.read())]))`;
  const r = spawnSync('python3', ['-c', script], { input: JSON.stringify(SAMPLES), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const expected = JSON.parse(r.stdout);
  SAMPLES.forEach((s, i) => assert.equal(cli.redact(s), expected[i], `sample ${i}: ${JSON.stringify(s)}`));
  assert.ok(!cli.redact(SAMPLES[1]).includes('sk-proj'));
});

test('buildRecord() produces the same record as the python hook', { skip: !hasPython && 'python3 not installed' }, () => {
  const h = freshHome();
  const repo = path.join(h, 'code', 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const wt = path.join(h, 'wt', 'feature');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'feature'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feature')}\n`);
  const py = pyBlock('PY_APPEND').replace('${PY_SPOOL.trim()}', pyBlock('PY_SPOOL').trim());
  const payloads = [
    { session_id: 'abc-123', tool_name: 'Bash', cwd: path.join(repo, 'src'), tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" x' } },
    { session_id: 'abc/../123', tool_name: 'Edit', cwd: wt, tool_input: { file_path: '/x/y.js', old_string: 'a' } },
    { session_id: 's1', tool_name: 'WebFetch', cwd: h, tool_input: { url: 'https://x.test/?token=abcdefghijk', prompt: 'summarize' } },
    { session_id: 's2', tool_name: 'mcp__brain__search', cwd: '/', tool_input: { query: 'x', limit: 5, deep: { a: 1 }, long: 'z'.repeat(130) } },
    { session_id: 's3', tool_name: 'Grep', cwd: repo, tool_input: { pattern: 'password=abcdefghij', n: true } },
    { session_id: 's4', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n.ipynb' } },
    { session_id: 's5', tool_name: 'Bash', cwd: repo, tool_input: { command: 'é'.repeat(600) } },
    { tool_name: 'Bash', tool_input: { command: 'no session' } },
  ];
  for (const [i, p] of payloads.entries()) {
    const spool = fs.mkdtempSync(path.join(TMP, 'spool-'));
    fs.chmodSync(spool, 0o700);
    const r = spawnSync('python3', ['-c', py], {
      encoding: 'utf8',
      cwd: repo,
      env: { ...process.env, HOME: h, BRAIN_INPUT: JSON.stringify(p), BRAIN_SPOOL: spool, BRAIN_SURFACE: 'claude-code', BRAIN_FALLBACK_CWD: repo },
    });
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(spool);
    const mine = cli.buildRecord(p, { surface: 'claude-code', fallbackCwd: repo, homeDir: h });
    if (!files.length) { assert.equal(mine, null, `payload ${i}`); continue; }
    const theirs = JSON.parse(fs.readFileSync(path.join(spool, files[0]), 'utf8').trim());
    assert.match(mine.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}$/);
    delete theirs.ts;
    const { ts, ...rest } = mine;
    assert.deepEqual(rest, theirs, `payload ${i}`);
  }
});

test('redact() drops credentials by key name, recursively, whatever the value looks like', () => {
  const input = {
    password: 'hunter2',
    githubToken: 'opaque',
    'X-Api-Key': 'k',
    api_key: 'k',
    apikey: 'k',
    client_secret: 'c',
    nested: { deeper: [{ Authorization: 'Basic abc' }, { refresh_token: 'r', access_token: 'a', note: 'keep me' }], Cookie: 'sid=1' },
    auth: { user: 'me', pass: 'p' },
    privateKey: ['x'],
    credentials: 'c',
    sessionId: 's',
    passwd: 'p',
    author: 'Ada',
    max_tokens: 4096,
    deleteSession: true,
    token: null,
    command: 'echo hi',
  };
  const out = cli.redact(input);
  for (const k of ['password', 'githubToken', 'X-Api-Key', 'api_key', 'apikey', 'client_secret', 'auth', 'privateKey', 'credentials', 'sessionId', 'passwd']) {
    assert.equal(out[k], '<REDACTED>', k);
  }
  assert.equal(out.nested.deeper[0].Authorization, '<REDACTED>');
  assert.equal(out.nested.deeper[1].refresh_token, '<REDACTED>');
  assert.equal(out.nested.deeper[1].access_token, '<REDACTED>');
  assert.equal(out.nested.deeper[1].note, 'keep me');
  assert.equal(out.nested.Cookie, '<REDACTED>');
  assert.equal(out.author, 'Ada', 'author is not "auth"');
  assert.equal(out.max_tokens, 4096);
  assert.equal(out.deleteSession, true);
  assert.equal(out.token, null);
  assert.equal(out.command, 'echo hi');
  assert.ok(!JSON.stringify(out).includes('hunter2'));
  assert.ok(!JSON.stringify(out).includes('opaque'));

  const rec = cli.buildRecord({ session_id: 's', tool_name: 'mcp__db__connect', tool_input: { host: 'db', password: 'hunter2', apiKey: 'zz', dbSecret: 'x', limit: 3 } }, { homeDir: TMP });
  assert.deepEqual(rec.args, { host: 'db', password: '<REDACTED>', apiKey: '<REDACTED>', dbSecret: '<REDACTED>', limit: 3 });
  const other = cli.buildRecord({ session_id: 's', tool_name: 'Custom', tool_input: { 'x-auth-token': 'opaque1', user: 'me' } }, { homeDir: TMP });
  assert.deepEqual(other.args, { 'x-auth-token': '<REDACTED>', user: 'me' });
});

test('Cursor and Codex hook payloads are normalized', () => {
  const cursor = cli.buildRecord({ hook_event_name: 'afterShellExecution', conversation_id: 'c-1', command: 'npm test --token=abcdef', cwd: '/' }, { surface: 'cursor', homeDir: TMP });
  assert.equal(cursor.tool, 'Bash');
  assert.equal(cursor.session, 'c-1');
  assert.equal(cursor.command, 'npm test --token=<REDACTED>');
  const mcp = cli.buildRecord({ conversation_id: 'c-2', tool_name: 'mcp__gh__get_issue', tool_input: '{"number":7}' }, { homeDir: TMP });
  assert.deepEqual(mcp.args, { number: 7 });
  assert.equal(mcp.mcp_server, 'gh');
});

test('spoolRecord appends privately and asks for a flush at 25 records', () => {
  const dir = path.join(TMP, 'spool-append');
  const rec = { session: 'sess', tool: 'Bash' };
  let flush = false;
  for (let i = 0; i < 25; i++) flush = cli.spoolRecord({ ...rec, i }, dir);
  assert.equal(flush, true);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'sess.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, 'sess.jsonl'), 'utf8').trim().split('\n').length, 25);
  const dir2 = path.join(TMP, 'spool-one');
  assert.equal(cli.spoolRecord(rec, dir2), false);
});

test('flushSpool posts batches and deletes them only on success', async () => {
  const dir = path.join(TMP, 'spool-flush');
  for (let i = 0; i < 3; i++) cli.spoolRecord({ session: 'a', i }, dir);
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 503 }); };
    assert.equal((await cli.flushSpool({ server: SERVER, key: 'bk_test' }, dir)).sent, 0);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.batch')).length, 1, 'kept for retry');
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true }); };
    assert.equal((await cli.flushSpool({ server: SERVER, key: 'bk_test' }, dir)).sent, 3);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { globalThis.fetch = realFetch; }
  const last = calls.at(-1);
  assert.equal(last.url, `${SERVER}/ingest/tool-calls`);
  assert.equal(last.init.headers.Authorization, 'Bearer bk_test');
  assert.equal(JSON.parse(last.init.body).records.length, 3);
});

// ---------------------------------------------------------------- bridge

const ECHO_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
let inits = 0;
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') inits++;
  if (m.method === 'crash') process.exit(3);
  if (!('id' in m)) return;
  const reply = (r) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }) + '\\n');
  if (m.method === 'slow') setTimeout(() => reply({ slow: true }), 50);
  else reply({ method: m.method, params: m.params ?? null, inits, pid: process.pid });
});
`;

test('bridge routes frames to a stdio child, remaps ids, caches initialize, restarts after a crash', async () => {
  const logs = [];
  const servers = new Map([['echo', new cli.LocalServer('echo', { command: process.execPath, args: ['-e', ECHO_SERVER] }, { log: (s) => logs.push(s) })]]);
  const sent = [];
  const send = (r) => sent.push(r);
  try {
    await cli.routeFrame({ rid: 'r1', server: 'echo', message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'x' } } }, servers, send);
    assert.deepEqual(sent[0].message.result.method, 'initialize');
    assert.equal(sent[0].rid, 'r1');
    assert.equal(sent[0].message.id, 1);
    const pid = sent[0].message.result.pid;

    await cli.routeFrame({ server: 'echo', message: { jsonrpc: '2.0', method: 'notifications/initialized' } }, servers, send);
    assert.equal(sent.length, 1, 'notifications get no reply');

    await cli.routeFrame({ rid: 'r2', server: 'echo', message: { jsonrpc: '2.0', id: 'again', method: 'initialize', params: {} } }, servers, send);
    assert.equal(sent[1].message.id, 'again');
    assert.equal(sent[1].message.result.inits, 1, 'second initialize answered from cache');

    await Promise.all([
      cli.routeFrame({ rid: 'a', server: 'echo', message: { jsonrpc: '2.0', id: 7, method: 'slow' } }, servers, send),
      cli.routeFrame({ rid: 'b', server: 'echo', message: { jsonrpc: '2.0', id: 7, method: 'tools/list' } }, servers, send),
    ]);
    const byRid = Object.fromEntries(sent.slice(2).map((r) => [r.rid, r.message]));
    assert.deepEqual(byRid.a.result, { slow: true });
    assert.equal(byRid.b.result.method, 'tools/list');
    assert.equal(byRid.a.id, 7);
    assert.equal(byRid.b.id, 7);

    await cli.routeFrame({ rid: 'x', server: 'nope', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, servers, send);
    assert.match(sent.at(-1).error, /no local server named "nope"/);

    await cli.routeFrame({ server: 'echo', message: { jsonrpc: '2.0', method: 'crash' } }, servers, send);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(logs.some((l) => /exited/.test(l)));

    await cli.routeFrame({ rid: 'r3', server: 'echo', message: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 't' } } }, servers, send);
    const res = sent.at(-1).message.result;
    assert.notEqual(res.pid, pid, 'restarted');
    assert.equal(res.inits, 1, 'handshake replayed on the new child');
    assert.deepEqual(res.params, { name: 't' });
  } finally {
    for (const s of servers.values()) s.stop();
  }
});

test('bridge reports a missing command as an error reply', async () => {
  const servers = new Map([['bad', new cli.LocalServer('bad', { command: path.join(TMP, 'does-not-exist') }, { log: () => {} })]]);
  const sent = [];
  await cli.routeFrame({ rid: 'r', server: 'bad', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, servers, (r) => sent.push(r));
  assert.match(sent[0].error, /failed to start|not running/);
});

const STRICT_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const seen = [];
let ready = false;
rl.on('line', (l) => {
  const m = JSON.parse(l);
  seen.push(m.method);
  if (m.method === 'notifications/initialized') ready = true;
  if (!('id' in m)) return;
  const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n');
  if (m.method === 'initialize') return setTimeout(() => send({ result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 's' } } }), 30);
  if (!ready) return send({ error: { code: -32002, message: 'server not initialized' } });
  send({ result: { seen, params: m.params ?? null } });
});
`;

test('bridge does the handshake itself when the hub skips initialize (restarted bridge, warm hub session)', async () => {
  const servers = new Map([['s', new cli.LocalServer('s', { command: process.execPath, args: ['-e', STRICT_SERVER] }, { log: () => {} })]]);
  const sent = [];
  try {
    await Promise.all([1, 2, 3].map((id) => cli.routeFrame({ rid: `r${id}`, server: 's', message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', n: id } } }, servers, (r) => sent.push(r))));
    assert.equal(sent.length, 3);
    for (const r of sent) {
      assert.ok(!r.error && !r.message.error, JSON.stringify(r));
      assert.equal(r.message.id, Number(r.rid.slice(1)), 'hub ids preserved');
      assert.equal(r.message.result.params.n, r.message.id);
    }
    const seen = sent.at(-1).message.result.seen;
    assert.deepEqual(seen.slice(0, 2), ['initialize', 'notifications/initialized'], 'exactly one handshake, before any call');
    assert.equal(seen.filter((m) => m === 'initialize').length, 1);
    // a later hub initialize is answered from the cached result, not forwarded
    await cli.routeFrame({ rid: 'i', server: 's', message: { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 'x' } } }, servers, (r) => sent.push(r));
    assert.equal(sent.at(-1).message.id, 'init');
    assert.ok(sent.at(-1).message.result.serverInfo);
  } finally {
    for (const s of servers.values()) s.stop();
  }
});

const runCliAsync = (args, { home, env = {}, killAfter } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, BRAIN_CRED_STORE: 'file', ...env } });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  const t = killAfter ? setTimeout(() => p.kill('SIGTERM'), killAfter) : null;
  p.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, stdout, stderr }); });
});

const bridgeHome = (server) => {
  const h = freshHome();
  const dir = path.join(h, '.config', 'brain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server, machine: 'm', store: 'file' }));
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ server, key: 'bk_test' }));
  fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ servers: { s: { command: process.execPath, args: ['-e', ECHO_SERVER] } } }));
  return h;
};
const noWs = typeof globalThis.WebSocket !== 'function' && 'needs Node 22 (global WebSocket)';

test('bridge exits with a clear message when the server rejects the key (handshake 401)', { skip: noWs }, async () => {
  const srv = http.createServer((q, r) => { r.writeHead(404); r.end(); });
  srv.on('upgrade', (req, socket) => {
    assert.match(req.headers['sec-websocket-protocol'], /^brain\.v1, bk_test$/);
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\nConnection: close\r\n\r\nunauthorized');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const h = bridgeHome(`http://127.0.0.1:${srv.address().port}`);
    const r = await runCliAsync(['bridge'], { home: h, killAfter: 10000 });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /rejected this key/);
    assert.ok(!/retrying/.test(r.stderr));
  } finally {
    srv.close();
  }
});

test('bridge keeps retrying when the server is unreachable instead of exiting silently', { skip: noWs }, async () => {
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const port = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const h = bridgeHome(`http://127.0.0.1:${port}`);
  const r = await runCliAsync(['bridge'], { home: h, killAfter: 2500 });
  assert.equal(r.signal ?? 'SIGTERM', 'SIGTERM');
  assert.match(r.stderr, /bridge disconnected \(cannot reach [^)]*\); retrying in 1s/);
  assert.match(r.stderr, /retrying in 2s/);
});

test('bridge config validation', () => {
  const f = path.join(TMP, 'bridge.json');
  fs.writeFileSync(f, JSON.stringify({ servers: { 'bad name': { command: 'x' } } }));
  assert.throws(() => cli.loadBridgeConfig(f), /may only use/);
  fs.writeFileSync(f, JSON.stringify({ servers: { ok: { command: 'npx', args: ['-y', 'x'] } } }));
  assert.ok(cli.loadBridgeConfig(f).servers.ok);
  assert.throws(() => cli.loadBridgeConfig(path.join(TMP, 'missing.json')), /no bridge config/);
});

// ---------------------------------------------------------------- apply / uninstall end to end (temp HOME)

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('apply configures every detected harness idempotently and uninstall removes only brain entries', async () => {
  const h = freshHome();
  for (const d of ['.claude', '.codex', '.cursor', '.gemini', '.config/opencode']) fs.mkdirSync(path.join(h, d), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'fmt.sh' }] }] } }));
  fs.writeFileSync(path.join(h, '.codex', 'config.toml'), 'model = "o3"\n');
  fs.writeFileSync(path.join(h, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { url: 'https://gh' } } }));
  fs.writeFileSync(path.join(h, '.zshrc'), 'alias ll="ls -l"\n');
  const deps = () => ({
    home: h,
    creds: { server: SERVER, key: 'bk_secret_never_written', keys: Object.fromEntries(['cli', 'claude-code', 'codex', 'cursor', 'gemini', 'opencode'].map((a) => [a, `bk_secret_never_written_${a}`])) },
    which: () => null,
    selfCommand: '/opt/brain',
    bundle: { files: [{ path: 'unslop/SKILL.md', content: 'u' }] },
    fx: quietFx(),
  });

  const dry = await cli.runApply({ 'dry-run': true, shell: true }, { ...deps(), fx: quietFx(true) });
  assert.ok(dry.changed.length > 0);
  assert.equal(fs.readFileSync(path.join(h, '.codex', 'config.toml'), 'utf8'), 'model = "o3"\n', 'dry run writes nothing');
  assert.ok(!fs.existsSync(path.join(h, '.config', 'brain', 'manifest.json')));

  const r1 = await cli.runApply({ shell: true }, deps());
  assert.deepEqual(r1.found, ['claude', 'codex', 'cursor', 'gemini', 'opencode']);
  const settings = JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.PostToolUse.map((e) => e.hooks[0].command), ['fmt.sh', '/opt/brain hook post-tool --agent claude-code']);
  assert.match(fs.readFileSync(path.join(h, '.codex', 'config.toml'), 'utf8'), /bearer_token_env_var = "BRAIN_KEY_CODEX"/);
  assert.equal(r1.report.missing, undefined, 'every harness has its own key');
  const cursor = JSON.parse(fs.readFileSync(path.join(h, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(cursor.mcpServers), ['github', 'brain']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8')).mcpServers.brain.httpUrl, `${SERVER}/mcp`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp.brain.type, 'remote');
  assert.equal(fs.readFileSync(path.join(h, '.claude', 'skills', 'unslop', 'SKILL.md'), 'utf8'), 'u');
  assert.equal(fs.readFileSync(path.join(h, '.agents', 'skills', 'unslop', 'SKILL.md'), 'utf8'), 'u');
  const zshrc = fs.readFileSync(path.join(h, '.zshrc'), 'utf8');
  for (const a of ['codex', 'cursor', 'gemini', 'opencode']) {
    assert.ok(zshrc.includes(`export BRAIN_KEY_${a.toUpperCase()}="$(/opt/brain auth token --agent ${a} 2>/dev/null)"`), zshrc);
  }
  assert.ok(!/export BRAIN_KEY=/.test(zshrc), 'no shared key export');
  for (const f of ['.claude/settings.json', '.codex/config.toml', '.cursor/mcp.json', '.zshrc']) {
    assert.ok(fs.existsSync(path.join(h, `${f}.brain-backup`)), `backup of ${f}`);
  }
  assert.ok(!fs.existsSync(path.join(h, '.gemini', 'settings.json.brain-backup')), 'no backup for a file brain created');
  assert.equal(fs.readFileSync(path.join(h, '.codex', 'config.toml.brain-backup'), 'utf8'), 'model = "o3"\n');

  const r2 = await cli.runApply({ shell: true }, deps());
  assert.deepEqual(r2.changed, [], 'second apply changes nothing');

  for (const f of walk(h)) assert.ok(!fs.readFileSync(f, 'utf8').includes('bk_secret_never_written'), `key leaked into ${f}`);

  const summary = await cli.runUninstall({ home: h, which: () => null, fx: quietFx() });
  assert.ok(summary.length >= 6, summary.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8')), { model: 'opus', hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'fmt.sh' }] }] } });
  assert.equal(fs.readFileSync(path.join(h, '.codex', 'config.toml'), 'utf8'), 'model = "o3"\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, '.cursor', 'mcp.json'), 'utf8')), { mcpServers: { github: { url: 'https://gh' } } });
  assert.equal(fs.readFileSync(path.join(h, '.zshrc'), 'utf8'), 'alias ll="ls -l"\n');
  assert.ok(!fs.existsSync(path.join(h, '.claude', 'skills', 'unslop')));
  assert.ok(!fs.existsSync(path.join(h, '.gemini', 'settings.json')), 'file brain created is removed, not left as {}');
  assert.ok(!fs.existsSync(path.join(h, '.config', 'opencode', 'opencode.json')), 'file brain created is removed, not left as { $schema }');
  assert.ok(fs.existsSync(path.join(h, '.config', 'brain', 'last-uninstall.json')));
});

test('apply --only limits targets and claude registration shells out when the CLI exists', async () => {
  const h = freshHome();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(h, '.cursor'), { recursive: true });
  const lines = [];
  const fx = cli.makeFx({ dryRun: true, log: (s) => lines.push(s) });
  const r = await cli.runApply({ only: 'claude' }, { home: h, creds: { server: SERVER, key: 'k' }, which: (b) => (b === 'claude' ? '/usr/bin/claude' : null), selfCommand: 'brain', bundle: null, fx });
  assert.deepEqual(r.found, ['claude']);
  assert.ok(lines.some((l) => l.includes(`would run claude mcp add-json -s user brain '{"type":"http","url":"${SERVER}/mcp","headersHelper":"brain auth header --agent claude-code"}'`)), lines.join('\n'));
  await assert.rejects(cli.runApply({ only: 'vim' }, { home: h, creds: { server: SERVER, key: 'k' }, which: () => null, fx }), /unknown harness/);
});

// ---------------------------------------------------------------- CLI process

const runCli = (args, { home, input, env = {} } = {}) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', input, env: { ...process.env, HOME: home, BRAIN_CRED_STORE: 'file', ...env },
});

test('login asks for one key per agent in a single approval; auth --agent prints each, other commands do not', async () => {
  const h = freshHome();
  const realFetch = globalThis.fetch;
  let polls = 0;
  const writes = [];
  const issued = { cli: 'bk_cli_once', 'claude-code': 'bk_claude_once', codex: 'bk_codex_once' };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (url.endsWith('/device/code')) {
      assert.deepEqual(body, { machine: 'lap-top', agents: ['cli', 'claude-code', 'codex'] });
      return Response.json({ device_code: 'dc', user_code: 'ABCD-EFGH', interval: 0.01, expires_in: 60 });
    }
    if (url.endsWith('/device/token')) {
      polls++;
      if (polls < 2) return Response.json({ error: 'authorization_pending' }, { status: 400 });
      return Response.json({ key: issued.cli, keys: issued, machine: 'lap-top', agent: 'cli', agents: Object.keys(issued), mcp_url: `${SERVER}/mcp` });
    }
    throw new Error(`unexpected ${url}`);
  };
  cli.setOutput((s) => writes.push(String(s)));
  try {
    await cli.main(['login', '--server', `${SERVER}/`, '--machine', 'Lap Top', '--agents', 'cli,Claude-Code,codex,cli']);
  } finally {
    globalThis.fetch = realFetch;
    cli.setOutput(null);
  }
  const printed = writes.join('');
  globalThis.fetch = async () => new Response('<!doctype html><title>spa</title>', { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    await assert.rejects(cli.main(['login', '--server', 'https://not-brain.test', '--agent', 'cli']), /did not answer like a BrainMCP server \(HTTP 200, not JSON\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(printed, /https:\/\/brain\.test\/#device\?code=ABCD-EFGH/);
  assert.match(printed, /one key per agent: cli, claude-code, codex/);
  for (const k of Object.values(issued)) assert.ok(!printed.includes(k), 'login output never shows a key');
  const cred = path.join(h, '.config', 'brain', 'credentials.json');
  assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(cred, 'utf8')), { server: SERVER, keys: issued });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, '.config', 'brain', 'config.json'), 'utf8')), { server: SERVER, machine: 'lap-top', agents: ['cli', 'claude-code', 'codex'], store: 'file' });

  assert.deepEqual(JSON.parse(runCli(['auth', 'header'], { home: h }).stdout), { Authorization: 'Bearer bk_cli_once' }, 'default agent is cli');
  assert.equal(runCli(['auth', 'token'], { home: h }).stdout.trim(), 'bk_cli_once');
  assert.deepEqual(JSON.parse(runCli(['auth', 'header', '--agent', 'claude-code'], { home: h }).stdout), { Authorization: 'Bearer bk_claude_once' });
  assert.equal(runCli(['auth', 'token', '--agent=codex'], { home: h }).stdout.trim(), 'bk_codex_once');
  const none = runCli(['auth', 'token', '--agent', 'cursor'], { home: h, env: { BRAIN_KEY: 'bk_shared' } });
  assert.equal(none.status, 1, 'no silent fallback to another key');
  assert.match(none.stderr, /no key for agent "cursor".*brain login --agents cursor/);
  assert.equal(runCli(['auth', 'token', '--agent', 'cursor'], { home: h, env: { BRAIN_KEY_CURSOR: 'bk_env_cursor' } }).stdout.trim(), 'bk_env_cursor', 'explicit per-agent env fallback');
  assert.equal(runCli(['auth', 'token', '--agent', '../x'], { home: h }).status, 1);

  const status = runCli(['status'], { home: h, env: { PATH: '' } });
  assert.equal(status.status, 0, status.stderr);
  for (const k of Object.values(issued)) assert.ok(!status.stdout.includes(k));
  assert.match(status.stdout, /lap-top/);
  assert.match(status.stdout, /key: +claude-code +stored \(file\)/);

  // A second login for one agent keeps the other agents' keys.
  polls = 5;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (url.endsWith('/device/code')) {
      assert.deepEqual(body, { machine: 'lap-top', agents: ['cursor'] });
      return Response.json({ device_code: 'dc2', user_code: 'WXYZ-1234', interval: 0.01, expires_in: 60 });
    }
    return Response.json({ key: 'bk_cursor_once', keys: { cursor: 'bk_cursor_once' }, machine: 'lap-top', agent: 'cursor', agents: ['cursor'] });
  };
  cli.setOutput(() => {});
  try {
    await cli.main(['login', '--machine', 'lap-top', '--agent', 'cursor']);
  } finally {
    globalThis.fetch = realFetch;
    cli.setOutput(null);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(cred, 'utf8')).keys, { ...issued, cursor: 'bk_cursor_once' });
  assert.equal(runCli(['auth', 'token', '--agent', 'claude-code'], { home: h }).stdout.trim(), 'bk_claude_once');

  const out = runCli(['logout'], { home: h });
  assert.equal(out.status, 0);
  assert.ok(!fs.existsSync(cred));
  const after = runCli(['auth', 'header'], { home: h });
  assert.equal(after.status, 1);
  assert.match(after.stderr, /not logged in/);
});

test('loginAgents: cli plus detected harnesses by default, --agents / --agent override, at most 8', () => {
  const h = freshHome();
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(h, '.config', 'opencode'), { recursive: true });
  const whichFn = (b) => (b === 'claude' ? '/usr/bin/claude' : null);
  assert.deepEqual(cli.loginAgents({}, h, whichFn), ['cli', 'claude-code', 'codex', 'opencode']);
  assert.deepEqual(cli.loginAgents({ agents: 'codex, cursor' }, h, whichFn), ['codex', 'cursor']);
  assert.deepEqual(cli.loginAgents({ agent: 'Gemini' }, h, whichFn), ['gemini']);
  assert.throws(() => cli.loginAgents({ agents: 'a,b,c,d,e,f,g,h,i' }, h, whichFn), /at most 8/);
  assert.throws(() => cli.loginAgents({ agents: 'ok,../bad' }, h, whichFn), /must be 1-40 lowercase/);
  assert.throws(() => cli.loginAgents({ agents: ' , ' }, h, whichFn), /at least one/);
  assert.deepEqual(cli.issuedKeys({ key: 'k1', agent: 'cli' }, ['cli', 'codex']), { cli: 'k1' }, 'older server: one key');
  assert.deepEqual(cli.issuedKeys({ key: 'k1', keys: { cli: 'k1', codex: 'k2', 'BAD/x': 'k3', gemini: '' } }, ['cli']), { cli: 'k1', codex: 'k2' });
});

test('a legacy single-key login migrates to agent "cli" and nothing else inherits it', () => {
  const h = freshHome();
  const dir = path.join(h, '.config', 'brain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: SERVER, machine: 'm', agent: 'cli', store: 'file' }));
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ server: SERVER, key: 'bk_legacy' }));
  const creds = cli.loadCreds();
  assert.equal(creds.key, 'bk_legacy');
  assert.equal(creds.agent, 'cli');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')), { server: SERVER, keys: { cli: 'bk_legacy' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { server: SERVER, machine: 'm', store: 'file', agents: ['cli'] });
  assert.equal(cli.loadCreds({ agent: 'codex', required: false }), null, 'codex does not get the cli key');
  assert.throws(() => cli.loadCreds({ agent: 'codex' }), /no key for agent "codex"/);
  assert.equal(cli.loadCreds({ agent: 'codex', fallbackCli: true }).agent, 'cli', 'telemetry-only fallback');
  assert.equal(cli.loadCreds().key, 'bk_legacy', 'second read after migration');
  assert.equal(runCli(['auth', 'token'], { home: h }).stdout.trim(), 'bk_legacy');
});

test('apply wires each harness to its own identity and names the ones without a key', async () => {
  const h = freshHome();
  for (const d of ['.claude', '.codex', '.cursor', '.gemini', '.config/opencode']) fs.mkdirSync(path.join(h, d), { recursive: true });
  const lines = [];
  const fx = cli.makeFx({ log: (s) => lines.push(s) });
  const r = await cli.runApply({ shell: true }, {
    home: h,
    creds: { server: SERVER, key: 'bk_cli', keys: { cli: 'bk_cli', 'claude-code': 'bk_cc', cursor: 'bk_cur' } },
    which: (b) => (b === 'claude' ? '/usr/bin/claude' : null),
    selfCommand: '/abs/brain',
    bundle: null,
    fx: { ...fx, run: (cmd, args) => { lines.push(`run ${cmd} ${args.join(' ')}`); return { status: 0, stdout: '', stderr: '' }; } },
  });
  const add = lines.find((l) => l.startsWith('run claude mcp add-json'));
  assert.equal(JSON.parse(add.slice(add.indexOf('{'))).headersHelper, '/abs/brain auth header --agent claude-code');
  const hook = JSON.parse(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUse[0].hooks[0].command;
  assert.equal(hook, '/abs/brain hook post-tool --agent claude-code');
  assert.ok(cli.isBrainHookCommand(hook) && cli.isBrainHookCommand('/abs/brain hook post-tool'));
  assert.match(fs.readFileSync(path.join(h, '.codex', 'config.toml'), 'utf8'), /bearer_token_env_var = "BRAIN_KEY_CODEX"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.cursor', 'mcp.json'), 'utf8')).mcpServers.brain.headers.Authorization, 'Bearer ${env:BRAIN_KEY_CURSOR}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8')).mcpServers.brain.headers.Authorization, 'Bearer $BRAIN_KEY_GEMINI');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp.brain.headers.Authorization, 'Bearer {env:BRAIN_KEY_OPENCODE}');
  assert.deepEqual(r.report.missing, ['codex', 'gemini', 'opencode']);
  assert.ok(lines.some((l) => l.includes('brain login --agents codex,gemini,opencode')), lines.join('\n'));
  assert.ok(r.report.claude.some((l) => /agent "claude-code" \(its own key\)/.test(l)));
  assert.ok(r.report.codex.some((l) => /no key for agent "codex"/.test(l)));
  assert.equal(r.manifest.targets.cursor.agent, 'cursor');
  for (const f of walk(h)) assert.ok(!/bk_(cli|cc|cur)/.test(fs.readFileSync(f, 'utf8')), `key leaked into ${f}`);
});

test('hook post-tool never fails, even on garbage or when logged out', () => {
  const h = freshHome();
  for (const input of ['', 'not json', '{"session_id":"s","tool_name":"Bash","tool_input":{"command":"ls"}}']) {
    const r = runCli(['hook', 'post-tool'], { home: h, input });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.ok(!fs.existsSync(path.join(h, '.cache', 'brain', 'spool')), 'logged out: nothing spooled');
  fs.mkdirSync(path.join(h, '.config', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(h, '.config', 'brain', 'config.json'), JSON.stringify({ server: 'https://127.0.0.1:1', store: 'file' }));
  const r = runCli(['hook', 'post-tool'], { home: h, input: JSON.stringify({ session_id: 's9', tool_name: 'Bash', cwd: h, tool_input: { command: 'echo token=abcdefghijk' } }) });
  assert.equal(r.status, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(h, '.cache', 'brain', 'spool', 'cli', 's9.jsonl'), 'utf8'));
  assert.equal(rec.command, 'echo token=<REDACTED>');
});

test('hook post-tool --agent spools per agent and flushes with that agent\'s key', async () => {
  const h = freshHome();
  const dir = path.join(h, '.config', 'brain');
  fs.mkdirSync(dir, { recursive: true });
  const seen = [];
  const srv = http.createServer((q, r) => {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => { seen.push({ auth: q.headers.authorization, n: JSON.parse(body).records.length }); r.writeHead(200, { 'content-type': 'application/json' }); r.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const server = `http://127.0.0.1:${srv.address().port}`;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server, machine: 'm', agents: ['cli', 'claude-code'], store: 'file' }));
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ server, keys: { cli: 'bk_cli', 'claude-code': 'bk_claude' } }));
    const input = JSON.stringify({ session_id: 'sx', tool_name: 'Bash', cwd: h, tool_input: { command: 'ls' } });
    for (const agent of ['claude-code', 'codex']) {
      const r = runCli(['hook', 'post-tool', '--agent', agent], { home: h, input });
      assert.equal(r.status, 0);
      assert.ok(fs.existsSync(path.join(h, '.cache', 'brain', 'spool', agent, 'sx.jsonl')), agent);
    }
    assert.equal((await runCliAsync(['hook', 'flush', '--agent', 'claude-code'], { home: h })).code, 0);
    assert.deepEqual(seen, [{ auth: 'Bearer bk_claude', n: 1 }]);
    assert.equal((await runCliAsync(['hook', 'flush', '--agent', 'codex'], { home: h })).code, 0);
    assert.deepEqual(seen.at(-1), { auth: 'Bearer bk_cli', n: 1 }, 'an agent without its own key falls back to cli for telemetry');
    assert.equal(runCli(['hook', 'post-tool', '--agent', '../../etc'], { home: h, input }).status, 0);
    assert.ok(fs.existsSync(path.join(h, '.cache', 'brain', 'spool', 'cli', 'sx.jsonl')), 'a malformed agent spools as cli');
    assert.equal(cli.hookAgent({ agent: 'Claude-Code' }), 'claude-code');
  } finally {
    srv.close();
  }
});

test('uninstall drops the parent object it emptied but keeps the file the user had', async () => {
  const h = freshHome();
  fs.mkdirSync(path.join(h, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(h, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  await cli.runApply({ only: 'gemini' }, { home: h, creds: { server: SERVER, key: 'k' }, which: () => null, selfCommand: 'brain', bundle: null, fx: quietFx() });
  assert.ok(JSON.parse(fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8')).mcpServers.brain);
  await cli.runUninstall({ home: h, which: () => null, fx: quietFx() });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8')), { theme: 'dark' });
  assert.deepEqual(cli.deleteJsonKeyPruned({ a: { b: { c: 1 } }, d: 1 }, ['a', 'b', 'c']), { d: 1 });
  assert.deepEqual(cli.deleteJsonKeyPruned({ a: { b: { c: 1, e: 2 } } }, ['a', 'b', 'c']), { a: { b: { e: 2 } } });
});

test('misc helpers', () => {
  assert.equal(cli.defaultMachine('Yash-MacBook-Pro.local'), 'yash-macbook-pro');
  assert.equal(cli.defaultMachine('__'), 'machine');
  assert.equal(cli.normalizeServer('https://x.test///'), 'https://x.test');
  assert.throws(() => cli.normalizeServer('x.test'), /https:\/\/host/);
  assert.deepEqual(cli.parseArgs(['apply', '--only=claude,codex', '--dry-run', '--server', 'u']), { pos: ['apply'], opts: { only: 'claude,codex', 'dry-run': true, server: 'u' } });
  assert.equal(cli.shq("it's"), `'it'\\''s'`);
  const r = runCli(['--version'], { home: TMP });
  assert.equal(r.stdout.trim(), cli.VERSION);
});
