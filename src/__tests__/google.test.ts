import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleAdapter } from '../adapters/google';

// Fixture pricing: $1/1M base input, $2/1M output, $0.50/1M cache-read.
const adapter = googleAdapter({
  host: 'generativelanguage.googleapis.com',
  pricing: {
    'fixture-model': { input: 1 / 1_000_000, output: 2 / 1_000_000, cacheRead: 0.5 / 1_000_000 },
  },
  defaultModel: 'fixture-model',
});

// ── endpoint / auth ──────────────────────────────────────────────────────────

test('endpoint: path is a function of model + streaming, not a fixed string', () => {
  assert.equal(typeof adapter.endpoint.path, 'function');
  const resolve = adapter.endpoint.path as (ctx: { model: string; streaming: boolean }) => string;
  assert.equal(resolve({ model: 'fixture-model', streaming: false }), '/v1beta/models/fixture-model:generateContent');
  assert.equal(resolve({ model: 'fixture-model', streaming: true }), '/v1beta/models/fixture-model:streamGenerateContent?alt=sse');
});

test('authHeaders: x-goog-api-key, not Bearer', () => {
  assert.deepEqual(adapter.authHeaders('AIza-abc'), { 'x-goog-api-key': 'AIza-abc' });
});

// ── cost calculation ─────────────────────────────────────────────────────────

test('costMicrodollars: cachedContentTokenCount is a subset of promptTokenCount, like OpenAI', () => {
  // 100k input tokens, 40k of which are cached — cache-read rate applies to the
  // 40k, base rate to the remaining 60k (not billed as 100k + 40k separately).
  const cost = adapter.costMicrodollars({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 40_000, cacheWriteTokens: 0 }, 'fixture-model');
  // 40k*$0.5/1M + 60k*$1/1M = 20000 + 60000
  assert.ok(Math.abs(cost - 80_000) < 1, `expected ~80000, got ${cost}`);
});

test('costMicrodollars: no cache = full input charged at base rate', () => {
  const cost = adapter.costMicrodollars({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'fixture-model');
  assert.ok(Math.abs(cost - 100_000) < 1, `expected ~100000, got ${cost}`);
});

// ── usage parsing (non-streaming) ────────────────────────────────────────────

test('parseUsage: maps Gemini usageMetadata to canonical usage', () => {
  const usage = adapter.parseUsage({
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, cachedContentTokenCount: 300, totalTokenCount: 1200 },
  });
  assert.deepEqual(usage, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 });
});

test('parseUsage: missing usageMetadata defaults to zeros', () => {
  assert.deepEqual(adapter.parseUsage({}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

// ── stream chunk parsing ──────────────────────────────────────────────────────

test('parseStreamChunk: extracts text from candidates[0].content.parts and running usage totals', () => {
  const parsed = adapter.parseStreamChunk({
    candidates: [{ content: { parts: [{ text: 'hel' }, { text: 'lo' }] } }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2 },
  });
  assert.equal(parsed?.content, 'hello');
  assert.deepEqual(parsed?.usage, { inputTokens: 50, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('parseStreamChunk: null when neither content nor usage present', () => {
  assert.equal(adapter.parseStreamChunk({ candidates: [{ content: { parts: [] } }] }), null);
});

// ── model rewrite ─────────────────────────────────────────────────────────────

test('rewriteModel: sets modelVersion when present', () => {
  const out = adapter.rewriteModel({ modelVersion: 'requested', candidates: [] }, 'fixture-model');
  assert.equal(out.modelVersion, 'fixture-model');
});

test('rewriteModel: leaves body untouched when modelVersion absent', () => {
  const input = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
  assert.deepEqual(adapter.rewriteModel(input, 'fixture-model'), input);
});
