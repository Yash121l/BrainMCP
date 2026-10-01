// In-memory GitHub for the Worker's index/install paths. Use with stubFetch:
//
//   const gh = fakeGitHub(env, { 'vault/a.md': '...' });
//   const net = stubFetch(gh.handler);
//
// Serves Contents GET/PUT, the Git Data calls multiCommit makes, and the branch
// tarball (gzipped ustar, pax headers for long names). gh.files is the repo Map;
// gh.commits records each write as [kind, ...paths]. gh.failTarball = status makes
// the tarball request fail. tarGz(files) builds a tarball on its own.

import { gzipSync } from 'node:zlib';

function header(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);

export function tarGz(files, top = 'test-owner-test-brain-abc123') {
  const parts = [];
  for (const [path, text] of files) {
    const full = `${top}/${path}`;
    const body = Buffer.from(text, 'utf8');
    if (Buffer.byteLength(full) > 99) {
      let rec = ` path=${full}\n`;
      let len = Buffer.byteLength(rec) + 2;
      len = Buffer.byteLength(`${len}${rec}`);
      const pax = Buffer.from(`${len}${rec}`, 'utf8');
      parts.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    parts.push(header(full, body.length, '0'), pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export function fakeGitHub(env, initial = {}) {
  const files = new Map(Object.entries(initial));
  const commits = [];
  let pending = null;
  const gh = { files, commits, failTarball: 0 };
  const repo = `/repos/${env.REPO}`;
  const j = (o, status = 200) => Response.json(o, { status });
  gh.handler = async (req, call) => {
    const u = new URL(req.url);
    const path = u.pathname;
    let m;
    if (path === `${repo}/tarball/${env.BRANCH}`) {
      if (gh.failTarball) return new Response('nope', { status: gh.failTarball });
      return new Response(tarGz(files), { headers: { 'content-type': 'application/x-gzip' } });
    }
    if ((m = path.match(new RegExp(`^${repo}/contents/(.+)$`)))) {
      const p = m[1].split('/').map(decodeURIComponent).join('/');
      if (req.method === 'GET') {
        return files.has(p) ? j({ content: Buffer.from(files.get(p)).toString('base64'), sha: `sha-${p.length}` }) : j({ message: 'Not Found' }, 404);
      }
      if (req.method === 'PUT') {
        files.set(p, Buffer.from(JSON.parse(call.body).content, 'base64').toString('utf8'));
        commits.push(['contents', p]);
        return j({ content: { sha: 'new' } });
      }
    }
    if (path === `${repo}/git/ref/heads/${env.BRANCH}`) return j({ object: { sha: 'head0' } });
    if (path.startsWith(`${repo}/git/commits/`)) return j({ tree: { sha: 'tree0' } });
    if (path === `${repo}/git/trees` && req.method === 'POST') { pending = JSON.parse(call.body).tree; return j({ sha: 'tree1' }); }
    if (path === `${repo}/git/commits` && req.method === 'POST') return j({ sha: 'commit1' });
    if (path === `${repo}/git/refs/heads/${env.BRANCH}` && req.method === 'PATCH') {
      for (const f of pending) files.set(f.path, f.content);
      commits.push(['git-data', ...pending.map((f) => f.path)]);
      pending = null;
      return j({ ok: true });
    }
    return j({ message: `unhandled ${req.method} ${path}` }, 500);
  };
  return gh;
}
