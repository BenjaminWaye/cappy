import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapModelsDevResponse } from '../scripts/sync-pricing';

const FIXTURE = {
  deepseek: {
    id: 'deepseek',
    api: 'https://api.deepseek.com', // models.dev returns a full URL, not a bare hostname
    models: {
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        cost: { input: 0.435, output: 0.87, cache_read: 0.003625 }, // USD per 1M tokens
      },
      'no-pricing-model': {
        id: 'no-pricing-model',
        // no cost field — should be skipped
      },
    },
  },
  anthropic: {
    id: 'anthropic',
    api: null,
    models: {
      'claude-sonnet': {
        id: 'claude-sonnet',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  'no-models-provider': {
    id: 'no-models-provider',
    api: 'x',
    models: {},
  },
};

test('mapModelsDevResponse: converts per-1M USD to per-token USD', () => {
  const out = mapModelsDevResponse(FIXTURE, '2026-08-11T00:00:00.000Z');
  const pro = out.providers.deepseek!.models['deepseek-v4-pro']!;
  assert.ok(Math.abs(pro.input - 0.435 / 1_000_000) < 1e-15);
  assert.ok(Math.abs(pro.output - 0.87 / 1_000_000) < 1e-15);
  assert.ok(Math.abs((pro.cacheRead ?? 0) - 0.003625 / 1_000_000) < 1e-15);
});

test('mapModelsDevResponse: skips models with no usable cost data', () => {
  const out = mapModelsDevResponse(FIXTURE);
  assert.equal(out.providers.deepseek!.models['no-pricing-model'], undefined);
});

test('mapModelsDevResponse: drops providers with zero priced models', () => {
  const out = mapModelsDevResponse(FIXTURE);
  assert.equal(out.providers['no-models-provider'], undefined);
});

test('mapModelsDevResponse: carries cache_write through when present', () => {
  const out = mapModelsDevResponse(FIXTURE);
  const sonnet = out.providers.anthropic!.models['claude-sonnet']!;
  assert.ok(Math.abs((sonnet.cacheWrite ?? 0) - 3.75 / 1_000_000) < 1e-15);
});

test('mapModelsDevResponse: preserves null host as-is', () => {
  const out = mapModelsDevResponse(FIXTURE);
  assert.equal(out.providers.anthropic!.host, null);
});

test('mapModelsDevResponse: strips scheme from a full URL host (models.dev returns "https://api.deepseek.com")', () => {
  const out = mapModelsDevResponse(FIXTURE);
  assert.equal(out.providers.deepseek!.host, 'api.deepseek.com');
});

test('mapModelsDevResponse: stamps syncedAt and source', () => {
  const out = mapModelsDevResponse(FIXTURE, '2026-08-11T00:00:00.000Z');
  assert.equal(out.syncedAt, '2026-08-11T00:00:00.000Z');
  assert.equal(out.source, 'models.dev');
});
