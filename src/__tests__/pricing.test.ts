import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatedSessions, estimateTokens, formatUsd } from '../pacing/pricing';

// ── Token estimation ─────────────────────────────────────────────────────────

test('estimateTokens: empty string', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens: null/undefined', () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens: 4 chars per token', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2); // ceil(5/4) = 2
  assert.equal(estimateTokens('a'.repeat(400)), 100);
});

// ── Sessions estimate ────────────────────────────────────────────────────────
// Per-model cost math now lives with each ProviderAdapter (see
// __tests__/openai-compatible.test.ts) — these helpers just do the
// provider-agnostic division/formatting on top of a precomputed session cost.

test('estimatedSessions: $10 budget, ~16,900 microdollars/session', () => {
  const sessions = estimatedSessions(10_000_000, 16_900);
  assert.ok(sessions > 500 && sessions < 700, `expected ~591, got ${sessions}`);
});

test('estimatedSessions: zero budget = zero sessions', () => {
  assert.equal(estimatedSessions(0, 16_900), 0);
});

test('estimatedSessions: zero or negative per-session cost = zero sessions', () => {
  assert.equal(estimatedSessions(10_000_000, 0), 0);
});

// ── Formatting ───────────────────────────────────────────────────────────────

test('formatUsd: converts microdollars to dollar string', () => {
  assert.equal(formatUsd(10_000_000), '$10.00');
  assert.equal(formatUsd(16_900), '$0.02');
  assert.equal(formatUsd(0), '$0.00');
});
