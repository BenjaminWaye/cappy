import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicAdapter } from '../adapters/anthropic';

// Fixture pricing: $1/1M base input, $2/1M output, $0.50/1M cache-read, $1.25/1M cache-write.
const adapter = anthropicAdapter({
  host: 'api.fixture.test',
  pricing: {
    'fixture-model': { input: 1 / 1_000_000, output: 2 / 1_000_000, cacheRead: 0.5 / 1_000_000, cacheWrite: 1.25 / 1_000_000 },
  },
  defaultModel: 'fixture-model',
});

// ── endpoint / auth ──────────────────────────────────────────────────────────

test('endpoint: fixed /v1/messages path, not a function like Google', () => {
  assert.equal(adapter.endpoint.host, 'api.fixture.test');
  assert.equal(adapter.endpoint.path, '/v1/messages');
});

test('authHeaders: x-api-key + anthropic-version, not Bearer', () => {
  assert.deepEqual(adapter.authHeaders('sk-ant-abc'), {
    'x-api-key': 'sk-ant-abc',
    'anthropic-version': '2023-06-01',
  });
});

// ── cost calculation ─────────────────────────────────────────────────────────

test('costMicrodollars: input, cache-read, and cache-write are disjoint (not subtractive)', () => {
  // Unlike OpenAI, Anthropic's input_tokens is NOT reduced by cache reads —
  // all three counters are billed independently.
  const cost = adapter.costMicrodollars(
    { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 100_000 },
    'fixture-model',
  );
  // 100k*$1/1M + 100k*$0.5/1M + 100k*$1.25/1M = 100000 + 50000 + 125000
  assert.ok(Math.abs(cost - 275_000) < 1, `expected ~275000, got ${cost}`);
});

test('costMicrodollars: cache-read cheaper than base input, cache-write pricier', () => {
  const base  = adapter.costMicrodollars({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'fixture-model');
  const read  = adapter.costMicrodollars({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 0 }, 'fixture-model');
  const write = adapter.costMicrodollars({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100_000 }, 'fixture-model');
  assert.ok(read < base, 'cache-read should be cheaper than base input');
  assert.ok(write > base, 'cache-write should be pricier than base input');
});

// ── usage parsing (non-streaming) ────────────────────────────────────────────

test('parseUsage: maps Anthropic-shaped usage to canonical usage', () => {
  const usage = adapter.parseUsage({
    usage: { input_tokens: 500, output_tokens: 150, cache_creation_input_tokens: 20, cache_read_input_tokens: 80 },
  });
  assert.deepEqual(usage, { inputTokens: 500, outputTokens: 150, cacheReadTokens: 80, cacheWriteTokens: 20 });
});

// ── stream chunk parsing ──────────────────────────────────────────────────────

test('parseStreamChunk: message_start carries input/cache usage, no content', () => {
  const parsed = adapter.parseStreamChunk({
    type: 'message_start',
    message: { model: 'fixture-model', usage: { input_tokens: 500, output_tokens: 1, cache_read_input_tokens: 80 } },
  });
  assert.equal(parsed?.content, undefined);
  assert.deepEqual(parsed?.usage, { inputTokens: 500, outputTokens: 1, cacheReadTokens: 80, cacheWriteTokens: 0 });
});

test('parseStreamChunk: content_block_delta extracts text', () => {
  const parsed = adapter.parseStreamChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } });
  assert.equal(parsed?.content, 'hi');
  assert.equal(parsed?.usage, undefined);
});

test('parseStreamChunk: message_delta carries only output_tokens (input/cache absent, not zero)', () => {
  const parsed = adapter.parseStreamChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 150 } });
  assert.deepEqual(parsed?.usage, { inputTokens: 0, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('parseStreamChunk: ping/message_stop produce null (no content, no usage)', () => {
  assert.equal(adapter.parseStreamChunk({ type: 'ping' }), null);
  assert.equal(adapter.parseStreamChunk({ type: 'message_stop' }), null);
});

// ── model rewrite ─────────────────────────────────────────────────────────────

test('rewriteModel: message_start rewrites nested message.model', () => {
  const out = adapter.rewriteModel({ type: 'message_start', message: { model: 'requested', id: 'x' } }, 'fixture-model');
  assert.equal((out.message as { model: string }).model, 'fixture-model');
  assert.equal((out.message as { id: string }).id, 'x');
});

test('rewriteModel: other stream event types are left untouched', () => {
  const input = { type: 'content_block_delta', delta: { text: 'hi' } };
  const out = adapter.rewriteModel(input, 'fixture-model');
  assert.deepEqual(out, input);
});

test('rewriteModel: non-streaming top-level response gets model set directly', () => {
  const out = adapter.rewriteModel({ id: 'msg_1', role: 'assistant', model: 'requested' }, 'fixture-model');
  assert.equal(out.model, 'fixture-model');
});
