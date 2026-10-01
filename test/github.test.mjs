import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fakeEnv, stubFetch } from './helpers/fake-env.mjs';
import { fetchRepoTar } from '../src/github.js';

test('github.js:fetchRepoTar:unbounded-decompressed-tar-buffer: decompression stops at the byte cap', async () => {
  const env = fakeEnv();
  const gz = gzipSync(Buffer.alloc(4 * 1024 * 1024));
  const net = stubFetch(() => new Response(gz));
  try {
    await assert.rejects(fetchRepoTar(env, { maxBytes: 1024 * 1024 }), /over the 1048576-byte cap/);
    const ok = await fetchRepoTar(env, { maxBytes: 8 * 1024 * 1024 });
    assert.equal(ok.byteLength, 4 * 1024 * 1024);
  } finally {
    net.restore();
  }
});
