// Refreshes src/adapters/pricing/synced.json from models.dev's public model
// catalog (https://models.dev/api.json) — an actively-maintained, open dataset
// of per-model pricing across 300+ models/providers, run by the same team (SST)
// behind opencode. This replaces hand-maintained pricing tables (Whalecap's
// old approach: a dated comment saying "update this when pricing changes").
//
// Run manually via `npm run sync-pricing`, or on the weekly schedule in
// .github/workflows/sync-pricing.yml.
import fs from 'fs';
import path from 'path';
import type { PricingRow } from '../adapters/types';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const OUTPUT_PATH = path.join(__dirname, '..', 'adapters', 'pricing', 'synced.json');

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

interface ModelsDevModel {
  id: string;
  cost?: ModelsDevCost;
}

interface ModelsDevProvider {
  id: string;
  api?: string | null;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

export interface SyncedProviderPricing {
  host: string | null;
  models: Record<string, PricingRow>;
}

export interface SyncedPricingFile {
  syncedAt: string;
  source: string;
  providers: Record<string, SyncedProviderPricing>;
}

// models.dev prices are USD per 1,000,000 tokens; Cappy's adapters price per token.
function perToken(usdPerMillion: number | undefined): number | undefined {
  if (usdPerMillion === undefined) return undefined;
  return usdPerMillion / 1_000_000;
}

// models.dev's `api` field is a full URL (e.g. "https://api.deepseek.com"), but
// Cappy's adapters need a bare hostname for Node's https.request({ hostname }).
function normalizeHost(api: string | null | undefined): string | null {
  if (!api) return null;
  try {
    return new URL(api).host;
  } catch {
    return api; // already looked like a bare hostname
  }
}

export function mapModelsDevResponse(raw: ModelsDevResponse, syncedAt = new Date().toISOString()): SyncedPricingFile {
  const providers: Record<string, SyncedProviderPricing> = {};

  for (const [providerId, provider] of Object.entries(raw)) {
    const models: Record<string, PricingRow> = {};
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const cost = model.cost;
      if (!cost || cost.input === undefined || cost.output === undefined) continue; // skip models w/o usable pricing
      const row: PricingRow = { input: perToken(cost.input)!, output: perToken(cost.output)! };
      const cacheRead = perToken(cost.cache_read);
      const cacheWrite = perToken(cost.cache_write);
      if (cacheRead !== undefined) row.cacheRead = cacheRead;
      if (cacheWrite !== undefined) row.cacheWrite = cacheWrite;
      models[modelId] = row;
    }
    if (Object.keys(models).length === 0) continue;
    providers[providerId] = { host: normalizeHost(provider.api), models };
  }

  return { syncedAt, source: 'models.dev', providers };
}

async function main(): Promise<void> {
  console.log(`Fetching ${MODELS_DEV_URL} ...`);
  const res = await fetch(MODELS_DEV_URL);
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status} ${res.statusText}`);
  const raw = (await res.json()) as ModelsDevResponse;

  const synced = mapModelsDevResponse(raw);
  const providerCount = Object.keys(synced.providers).length;
  const modelCount = Object.values(synced.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(synced, null, 2) + '\n');

  console.log(`Synced ${modelCount} models across ${providerCount} providers → ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('sync-pricing failed:', err.message);
    process.exit(1);
  });
}
