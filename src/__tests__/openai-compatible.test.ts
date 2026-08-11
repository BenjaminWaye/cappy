import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiCompatibleAdapter } from '../adapters/openai-compatible';

// Fixture pricing chosen for easy hand-verification, not real provider numbers:
// $1/1M base input, $2/1M output, $0.50/1M cache-read input.
const adapter = openaiCompatibleAdapter({
  id: 'fixture',
  host: 'api.fixture.test',
  pricing: {
    'fixture-model': { input: 1 / 1_000_000, output: 2 / 1_000_000, cacheRead: 0.5 / 1_000_000 },
  },
  defaultModel: 'fixture-model',
});

// ── endpoint / auth ──────────────────────────────────────────────────────────

test('endpoint: host/path set from config, defaults to /v1/chat/completions', () => {
  assert.equal(adapter.endpoint.host, 'api.fixture.test');
  assert.equal(adapter.endpoint.path, '/v1/chat/completions');
});

test('authHeaders: Bearer token by default', () => {
  assert.deepEqual(adapter.authHeaders('sk-abc'), { Authorization: 'Bearer sk-abc' });
});

test('authHeaders: custom header name', () => {
  const custom = openaiCompatibleAdapter({
    id: 'fixture2', host: 'x', authHeaderName: 'x-api-key',
    pricing: { m: { input: 0, output: 0 } }, defaultModel: 'm',
  });
  assert.deepEqual(custom.authHeaders('key'), { 'x-api-key': 'Bearer key' });
});

// ── cost calculation ─────────────────────────────────────────────────────────

test('costMicrodollars: zero usage = zero cost', () => {
  const cost = adapter.costMicrodollars({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'fixture-model');
  assert.equal(cost, 0);
});

test('costMicrodollars: 1M cache-miss input @ $1/1M = 1,000,000 microdollars', () => {
  const cost = adapter.costMicrodollars({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'fixture-model');
  assert.ok(Math.abs(cost - 1_000_000) < 1, `expected ~1000000, got ${cost}`);
});

test('costMicrodollars: 1M output @ $2/1M = 2,000,000 microdollars', () => {
  const cost = adapter.costMicrodollars({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'fixture-model');
  assert.ok(Math.abs(cost - 2_000_000) < 1, `expected ~2000000, got ${cost}`);
});

test('costMicrodollars: cache-read input is cheaper than cache-miss', () => {
  const hit  = adapter.costMicrodollars({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 0 }, 'fixture-model');
  const miss = adapter.costMicrodollars({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'fixture-model');
  assert.ok(hit < miss, 'cache-read should cost less than cache-miss');
  assert.ok(Math.abs(hit - 50_000) < 1, `expected ~50000, got ${hit}`); // 100k * $0.5/1M
  assert.ok(Math.abs(miss - 100_000) < 1, `expected ~100000, got ${miss}`); // 100k * $1/1M
});

test('costMicrodollars: unknown model falls back to defaultModel pricing', () => {
  const known   = adapter.costMicrodollars({ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'fixture-model');
  const unknown = adapter.costMicrodollars({ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'does-not-exist');
  assert.equal(known, unknown);
});

// ── usage parsing (non-streaming) ────────────────────────────────────────────

test('parseUsage: maps OpenAI-shaped usage to canonical usage', () => {
  const usage = adapter.parseUsage({
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 300 },
  });
  assert.deepEqual(usage, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 });
});

test('parseUsage: missing usage defaults to zeros', () => {
  const usage = adapter.parseUsage({});
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

// ── stream chunk parsing ──────────────────────────────────────────────────────

test('parseStreamChunk: extracts content delta', () => {
  const parsed = adapter.parseStreamChunk({ choices: [{ delta: { content: 'hello' } }] });
  assert.equal(parsed?.content, 'hello');
  assert.equal(parsed?.usage, undefined);
});

test('parseStreamChunk: extracts final usage when present', () => {
  const parsed = adapter.parseStreamChunk({
    choices: [{ delta: {} }],
    usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 5 },
  });
  assert.deepEqual(parsed?.usage, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 });
});

test('parseStreamChunk: null for chunk with neither content nor usage', () => {
  const parsed = adapter.parseStreamChunk({ choices: [{ delta: {} }] });
  assert.equal(parsed, null);
});

// ── model rewrite ─────────────────────────────────────────────────────────────

test('rewriteModel: overwrites model field, preserves rest of body', () => {
  const out = adapter.rewriteModel({ id: 'x', model: 'requested-model', foo: 'bar' }, 'fixture-model');
  assert.equal(out.model, 'fixture-model');
  assert.equal(out.id, 'x');
  assert.equal(out.foo, 'bar');
});
