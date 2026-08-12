import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, listProviders, isPricingStale, pricingSyncedAt, loadSyncedPricing } from '../adapters/registry';

// These exercise the registry against the real, committed synced.json — an
// end-to-end check that the models.dev sync actually produced usable adapters,
// not just well-formed JSON.

test('loadSyncedPricing: real synced.json has deepseek pricing', () => {
  const synced = loadSyncedPricing();
  assert.ok(synced.providers.deepseek, 'expected a deepseek entry in synced.json');
  assert.ok(Object.keys(synced.providers.deepseek!.models).length > 0);
});

test('getAdapter: deepseek adapter resolves with real pricing data', () => {
  const adapter = getAdapter('deepseek', 'deepseek-v4-pro');
  assert.equal(adapter.id, 'deepseek');
  assert.equal(adapter.endpoint.host, 'api.deepseek.com');
  assert.equal(adapter.defaultModel, 'deepseek-v4-pro');
  assert.ok(adapter.models.includes('deepseek-v4-pro'));
});

test('getAdapter: falls back to first priced model when preferred model is unpriced', () => {
  const adapter = getAdapter('deepseek', 'not-a-real-model');
  assert.ok(adapter.models.includes(adapter.defaultModel));
});

test('getAdapter: anthropic resolves to the bespoke adapter with real pricing data', () => {
  const adapter = getAdapter('anthropic');
  assert.equal(adapter.id, 'anthropic');
  assert.equal(adapter.wireFormat, 'anthropic');
  assert.equal(adapter.endpoint.host, 'api.anthropic.com');
  assert.ok(adapter.models.length > 0);
});

test('getAdapter: google resolves to the bespoke adapter with real pricing data', () => {
  const adapter = getAdapter('google');
  assert.equal(adapter.id, 'google');
  assert.equal(adapter.wireFormat, 'google');
  assert.equal(adapter.endpoint.host, 'generativelanguage.googleapis.com');
  assert.ok(adapter.models.length > 0);
});

test('getAdapter: throws for a provider not in the registry at all', () => {
  assert.throws(() => getAdapter('totally-made-up-provider'), /Unknown or unsupported provider/);
});

test('listProviders: includes deepseek, anthropic, and google', () => {
  const providers = listProviders();
  assert.ok(providers.includes('deepseek'));
  assert.ok(providers.includes('anthropic'));
  assert.ok(providers.includes('google'));
});

test('pricingSyncedAt / isPricingStale: real data was synced recently, so not stale', () => {
  const syncedAt = pricingSyncedAt();
  assert.ok(syncedAt instanceof Date);
  assert.equal(isPricingStale(), false);
});

test('isPricingStale: true once older than the 14-day threshold', () => {
  const syncedAt = pricingSyncedAt()!;
  const fifteenDaysLater = syncedAt.getTime() + 15 * 24 * 3_600_000;
  assert.equal(isPricingStale(fifteenDaysLater), true);
});
