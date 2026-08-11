// GitHub API helpers. All writes go through here; git stays the source of truth.

const API = 'https://api.github.com';

function headers(env, extra = {}) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'brain-mcp-worker',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function gh(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: headers(env, init.headers) });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

/** Fetch a file's raw content + sha. Returns null if missing. */
export async function getFile(env, path) {
  const res = await gh(env, `/repos/${env.REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${env.BRANCH}`);
  if (res.status === 404) return null;
  const j = await res.json();
  const content = decodeBase64(j.content || '');
  return { content, sha: j.sha };
}

/** Create or update a single file. Pass sha when updating. Returns new content sha. */
export async function putFile(env, path, content, message, sha) {
  const body = {
    message,
    content: encodeBase64(content),
    branch: env.BRANCH,
    committer: { name: 'BrainMCP', email: 'brainmcp@users.noreply.github.com' },
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${API}/repos/${env.REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'PUT',
    headers: headers(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    const e = new Error(`GitHub PUT ${path} -> ${res.status}: ${t.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return (await res.json()).content.sha;
}

/** Append to a (possibly missing) file with one conflict retry. */
export async function appendFile(env, path, appendText, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getFile(env, path);
    const next = existing ? existing.content.replace(/\n*$/, '\n') + appendText : appendText;
    try {
      await putFile(env, path, next, message, existing?.sha);
      return next;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt === 0) continue; // stale sha — refetch once
      throw e;
    }
  }
}

/** Atomic multi-file commit via the Git Data API. files: [{path, content}]. */
export async function multiCommit(env, files, message) {
  const refRes = await gh(env, `/repos/${env.REPO}/git/ref/heads/${env.BRANCH}`);
  if (refRes.status === 404) throw new Error(`branch ${env.BRANCH} not found`);
  const headSha = (await refRes.json()).object.sha;
  const baseCommit = await (await gh(env, `/repos/${env.REPO}/git/commits/${headSha}`)).json();

  const treeRes = await fetch(`${API}/repos/${env.REPO}/git/trees`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    }),
  });
  if (!treeRes.ok) throw new Error(`tree create -> ${treeRes.status}: ${(await treeRes.text()).slice(0, 300)}`);
  const tree = await treeRes.json();

  const commitRes = await fetch(`${API}/repos/${env.REPO}/git/commits`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [headSha],
      author: { name: 'BrainMCP', email: 'brainmcp@users.noreply.github.com' },
    }),
  });
  if (!commitRes.ok) throw new Error(`commit create -> ${commitRes.status}`);
  const commit = await commitRes.json();

  const updRes = await fetch(`${API}/repos/${env.REPO}/git/refs/heads/${env.BRANCH}`, {
    method: 'PATCH',
    headers: headers(env),
    body: JSON.stringify({ sha: commit.sha }),
  });
  if (!updRes.ok) throw new Error(`ref update -> ${updRes.status}: ${(await updRes.text()).slice(0, 300)}`);
  return commit.sha;
}

/** Fetch the repo tarball (for full reindex). Returns ArrayBuffer of the .tar after gunzip. */
export async function fetchRepoTar(env) {
  const res = await fetch(`${API}/repos/${env.REPO}/tarball/${env.BRANCH}`, {
    headers: headers(env),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`tarball -> ${res.status}`);
  const gunzip = res.body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(gunzip).arrayBuffer();
}

/** Minimal tar reader: yields {path, text} for .md entries (strips the top-level dir). */
export function* tarEntries(buf) {
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= u8.length) {
    const name = dec.decode(u8.subarray(off, off + 100)).replace(/\0.*$/, '');
    if (!name) break;
    const sizeOctal = dec.decode(u8.subarray(off + 124, off + 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const typeflag = String.fromCharCode(u8[off + 156]);
    const dataStart = off + 512;
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const path = name.split('/').slice(1).join('/'); // strip "owner-repo-sha/" prefix
      if (path) yield { path, text: () => dec.decode(u8.subarray(dataStart, dataStart + size)) };
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
}

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
