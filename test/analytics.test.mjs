import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackToolCall, trackInitialize, errorCategory, proxyPostHog } from '../src/analytics.js';

function capturing() {
  const sent = [];
  const waits = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  };
  return { sent, ctx: { waitUntil: (p) => waits.push(p) }, restore: () => { globalThis.fetch = orig; }, settle: () => Promise.all(waits) };
}

test('tool-call events carry name, timing and an error category, never arguments or messages', async () => {
  const c = capturing();
  try {
    const R = { env: { POSTHOG_KEY: 'phc_test' }, ctx: c.ctx, p: { via: 'key', user: { id: 'u_123', handle: 'alice' } } };
    trackToolCall(R, { name: 'read_note', category: 'brain', startedAt: Date.now() - 5, isError: true, error: 'forbidden: no access to vault/projects/secret.md' });
    await c.settle();
    assert.equal(c.sent.length, 1);
    assert.equal(c.sent[0].url, 'https://us.i.posthog.com/i/v0/e/');
    const body = JSON.parse(c.sent[0].init.body);
    assert.equal(body.event, '$mcp_tool_call');
    assert.equal(body.distinct_id, 'u_123');
    assert.equal(body.properties.app, 'brain-mcp');
    assert.equal(body.properties.$mcp_tool_name, 'read_note');
    assert.equal(body.properties.$mcp_is_error, true);
    assert.equal(body.properties.$mcp_error_type, 'forbidden');
    const raw = c.sent[0].init.body;
    assert.ok(!raw.includes('secret.md') && !raw.includes('alice'), 'no paths or handles in the payload');
    assert.ok(!('$mcp_parameters' in body.properties) && !('$mcp_response' in body.properties));
  } finally {
    c.restore();
  }
});

test('anonymous callers do not create person profiles; no key means no request', async () => {
  const c = capturing();
  try {
    trackInitialize({ env: { POSTHOG_KEY: 'phc_test' }, ctx: c.ctx, p: { via: 'root' } }, { clientInfo: { name: 'claude-code', version: '2.1' } }, '2025-11-25');
    trackToolCall({ env: {}, ctx: c.ctx, p: {} }, { name: 'search', category: 'brain', startedAt: Date.now(), isError: false });
    await c.settle();
    assert.equal(c.sent.length, 1);
    const body = JSON.parse(c.sent[0].init.body);
    assert.equal(body.event, '$mcp_initialize');
    assert.equal(body.properties.$process_person_profile, false);
    assert.equal(body.properties.$mcp_client_name, 'claude-code');
  } finally {
    c.restore();
  }
});

test('errorCategory keeps only a leading word category', () => {
  assert.equal(errorCategory('unknown tool: x'), 'unknown_tool');
  assert.equal(errorCategory('no access to @bob/x'), 'error');
  assert.equal(errorCategory('no skill named secret-thing that you can read'), 'error');
  assert.equal(errorCategory(undefined), 'error');
});

test('the /ingest proxy strips cookies and routes static assets to the assets host', async () => {
  const c = capturing();
  try {
    const req = new Request('https://brain.example/ingest/static/array.js?v=1', { headers: { cookie: 'brain_session=x' } });
    await proxyPostHog(req, new URL(req.url));
    assert.equal(c.sent[0].url, 'https://us-assets.i.posthog.com/static/array.js?v=1');
    assert.equal(new Headers(c.sent[0].init.headers).get('cookie'), null);
    const ev = new Request('https://brain.example/ingest/i/v0/e/', { method: 'POST', body: '{}' });
    await proxyPostHog(ev, new URL(ev.url));
    assert.equal(c.sent[1].url, 'https://us.i.posthog.com/i/v0/e/');
  } finally {
    c.restore();
  }
});
