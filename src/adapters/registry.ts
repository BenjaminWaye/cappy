import fs from 'fs';
import path from 'path';
import type { ProviderAdapter, PricingRow } from './types';
import { openaiCompatibleAdapter } from './openai-compatible';
import { anthropicAdapter } from './anthropic';
import { googleAdapter } from './google';

interface SyncedPricingFile {
  syncedAt: string;
  source: string;
  providers: Record<string, { host: string | null; models: Record<string, PricingRow> }>;
}

interface OverridesFile {
  providers?: Record<string, Record<string, PricingRow>>;
}

// Read from disk (not `import ... from './pricing/x.json'`) so a `cappy sync-pricing`
// run can refresh dist/adapters/pricing/synced.json in place without a rebuild.
const PRICING_DIR = path.join(__dirname, 'pricing');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(PRICING_DIR, file), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// Hosts for providers, used when models.dev doesn't publish a direct REST `api`
// URL for a provider (it's often aimed at SDK-level integration instead).
const KNOWN_HOSTS: Record<string, string> = {
  deepseek: 'api.deepseek.com',
  openai: 'api.openai.com',
  groq: 'api.groq.com',
  xai: 'api.x.ai',
  mistral: 'api.mistral.ai',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
};

// Providers using the generic OpenAI chat-completions wire format — the shared
// factory covers all of them via config (host + pricing) alone.
const OPENAI_COMPATIBLE_PROVIDERS = new Set(['deepseek', 'openai', 'groq', 'xai', 'mistral']);

// Providers with genuinely different wire formats get their own adapter factory.
const BESPOKE_ADAPTERS: Record<string, (cfg: { host: string; pricing: Record<string, PricingRow>; defaultModel: string }) => ProviderAdapter> = {
  anthropic: anthropicAdapter,
  google: googleAdapter,
};

export function loadSyncedPricing(): SyncedPricingFile {
  return readJson<SyncedPricingFile>('synced.json', { syncedAt: '', source: 'models.dev', providers: {} });
}

function mergedPricing(providerId: string): { host: string | null; pricing: Record<string, PricingRow> } {
  const synced = loadSyncedPricing();
  const overrides = readJson<OverridesFile>('overrides.json', {});
  const base = synced.providers[providerId];
  const overrideModels = overrides.providers?.[providerId] ?? {};
  return {
    host: base?.host ?? KNOWN_HOSTS[providerId] ?? null,
    // Overrides win on a per-model basis — the only place hand-entered pricing
    // takes precedence over the models.dev sync.
    pricing: { ...(base?.models ?? {}), ...overrideModels },
  };
}

export function getAdapter(providerId: string, preferredDefaultModel?: string): ProviderAdapter {
  const isOpenAiCompatible = OPENAI_COMPATIBLE_PROVIDERS.has(providerId);
  const bespokeFactory = BESPOKE_ADAPTERS[providerId];
  if (!isOpenAiCompatible && !bespokeFactory) {
    throw new Error(
      `Unknown or unsupported provider "${providerId}". Supported: ${listProviders().join(', ')}`,
    );
  }
  const { host, pricing } = mergedPricing(providerId);
  if (!host) {
    throw new Error(`No API host known for provider "${providerId}" — run "cappy sync-pricing" or add an override`);
  }
  const modelIds = Object.keys(pricing);
  if (modelIds.length === 0) {
    throw new Error(`No pricing data for provider "${providerId}" — run "cappy sync-pricing" first`);
  }
  const defaultModel = preferredDefaultModel && pricing[preferredDefaultModel] ? preferredDefaultModel : modelIds[0]!;
  return bespokeFactory
    ? bespokeFactory({ host, pricing, defaultModel })
    : openaiCompatibleAdapter({ id: providerId, host, pricing, defaultModel });
}

export function listProviders(): string[] {
  return [...OPENAI_COMPATIBLE_PROVIDERS, ...Object.keys(BESPOKE_ADAPTERS)];
}

// ── Pricing freshness ────────────────────────────────────────────────────────
// Whalecap hand-maintained pricing via a dated comment that silently rotted.
// Cappy syncs from models.dev instead (see scripts/sync-pricing.ts) and checks
// staleness at runtime rather than assuming the data is current.

const STALE_AFTER_MS = 14 * 24 * 3_600_000; // 14 days

export function pricingSyncedAt(): Date | null {
  const { syncedAt } = loadSyncedPricing();
  return syncedAt ? new Date(syncedAt) : null;
}

export function isPricingStale(now = Date.now()): boolean {
  const syncedAt = pricingSyncedAt();
  if (!syncedAt) return true;
  return now - syncedAt.getTime() > STALE_AFTER_MS;
}
