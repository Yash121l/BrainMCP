// Pure parsing helpers shared by the Worker and the local seed script.
// No dependencies, no runtime APIs — safe in Workers and Node.

/** Minimal YAML frontmatter parser (flat keys, inline arrays, block lists, quoted strings). */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, body: text };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const fm = {};
  let lastKey = null;
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && lastKey) {
      if (!Array.isArray(fm[lastKey])) fm[lastKey] = fm[lastKey] ? [fm[lastKey]] : [];
      fm[lastKey].push(unquote(listItem[1]));
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    lastKey = m[1];
    let v = m[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[lastKey] = v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      fm[lastKey] = unquote(v);
    }
  }
  return { fm, body };
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Extract [[wikilink]] targets (alias and heading stripped), deduped. */
export function extractLinks(body) {
  const out = new Set();
  for (const m of body.matchAll(/\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g)) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

/** Normalize a project frontmatter value ("[[projects/pulse]]", "pulse") to a slug. */
export function normalizeProject(v) {
  if (!v || typeof v !== 'string') return '';
  return v.replace(/^\[\[/, '').replace(/\]\]$/, '').replace(/^projects\//, '').trim();
}

/** Split a note body into FTS chunks by heading, size-capped (~2400 chars). */
export function chunkBody(body) {
  const chunks = [];
  const parts = body.split(/^(?=#{1,6}\s)/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const headingMatch = part.match(/^(#{1,6})\s+(.+)/);
    const heading = headingMatch ? headingMatch[2].trim() : '';
    if (part.length <= 2400) {
      chunks.push({ heading, text: part.trim() });
    } else {
      // split oversized sections on blank lines into ~2000-char pieces
      let buf = '';
      for (const para of part.split(/\n\n+/)) {
        if (buf.length + para.length > 2000 && buf) {
          chunks.push({ heading, text: buf.trim() });
          buf = '';
        }
        // hard-split single paragraphs bigger than the cap (e.g. giant frontmatter-ish blobs)
        if (para.length > 2400) {
          for (let i = 0; i < para.length; i += 2000) {
            chunks.push({ heading, text: para.slice(i, i + 2000).trim() });
          }
        } else {
          buf += para + '\n\n';
        }
      }
      if (buf.trim()) chunks.push({ heading, text: buf.trim() });
    }
  }
  return chunks.filter((c) => c.text);
}

// Index columns are TEXT: a list value (`title: [a, b]`) must not reach a D1 bind as an array.
const text1 = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

/** Parse one vault note into its index row + links + chunks. */
export function parseNote(path, text) {
  const { fm, body } = parseFrontmatter(text);
  const title = text1(fm.title) || path.split('/').pop().replace(/\.md$/, '');
  return {
    path,
    title,
    type: text1(fm.type),
    project: normalizeProject(fm.project || ''),
    status: text1(fm.status),
    tags: JSON.stringify(Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : []),
    frontmatter: JSON.stringify(fm),
    body: text,
    updated: String(fm.updated || fm.date || ''),
    links: extractLinks(body),
    chunks: chunkBody(body),
  };
}

/** Should this repo path be indexed? */
export function isIndexable(path) {
  if (!path.endsWith('.md')) return false;
  if (path.startsWith('.obsidian/') || path.startsWith('.trash/')) return false;
  if (path.includes('node_modules/')) return false;
  return true;
}
