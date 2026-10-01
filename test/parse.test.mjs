import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, parseNote } from '../src/parse.js';

const time = (f) => { const t = performance.now(); f(); return performance.now() - t; };

test('src/parse.js:extractLinks:quadratic-unclosed-wikilink-regex: unclosed wikilink runs parse in linear time', () => {
  for (const body of ['['.repeat(64_000), '[[a#'.repeat(16_000), '[[a|'.repeat(16_000), '[[a#b|'.repeat(10_000)]) {
    const ms = time(() => extractLinks(body));
    assert.ok(ms < 50, `${JSON.stringify(body.slice(0, 6))}... took ${ms.toFixed(1)} ms`);
  }
  const note = '---\ntitle: x\n---\n' + '['.repeat(64_000) + '\n';
  assert.ok(time(() => parseNote('vault/topics/x.md', note)) < 100);
});

test('src/parse.js:extractLinks:quadratic-unclosed-wikilink-regex: ordinary wikilinks resolve as before', () => {
  assert.deepEqual(
    extractLinks('see [[a]] and [[b#h|alias]] and [[c|x]] [[ d ]] [[e#]] [[f|g#h]] [[a]]\n[[multi\nline]] [[]]'),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
  assert.deepEqual(extractLinks('[[[nested]]] [[x[y]]]'), ['nested']);
});

test('src/parse.js:extractLinks:quadratic-unclosed-wikilink-regex: list-valued title/type/status are coerced to text', () => {
  const n = parseNote('scratch/q3.md', '---\ntitle: [Q3 plan]\ntype: [topic, plan]\nstatus: [a]\n---\nbody\n');
  assert.deepEqual([n.title, n.type, n.status], ['Q3 plan', 'topic, plan', 'a']);
  for (const v of [n.title, n.type, n.status, n.project, n.updated]) assert.equal(typeof v, 'string');
  const empty = parseNote('vault/x/empty-title.md', '---\ntitle: []\n---\n');
  assert.equal(empty.title, 'empty-title');
  const plain = parseNote('vault/p.md', '---\ntitle: "Plain"\ntype: project\n---\n');
  assert.deepEqual([plain.title, plain.type, plain.status], ['Plain', 'project', '']);
});
