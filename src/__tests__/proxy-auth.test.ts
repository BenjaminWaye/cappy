import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from '../proxy/server';

// safeEqual guards the proxy's bearer-token check — it exists so a valid
// local_api_key can't be brute-forced via response-timing differences the
// way a plain `!==` string compare would leak (mismatches fail fast at the
// first differing byte). These tests only check correctness, not timing.

test('safeEqual: identical strings match', () => {
  assert.equal(safeEqual('sk-ag-abc123', 'sk-ag-abc123'), true);
});

test('safeEqual: different strings of the same length do not match', () => {
  assert.equal(safeEqual('sk-ag-abc123', 'sk-ag-abc124'), false);
});

test('safeEqual: different lengths do not match (and do not throw)', () => {
  assert.equal(safeEqual('short', 'a-much-longer-string'), false);
});

test('safeEqual: empty strings match only against each other', () => {
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('', 'nonempty'), false);
});
