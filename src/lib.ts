// Library entry point for consuming Cappy as a dependency (as opposed to
// running it as a standalone CLI via `cappy` / `npx cappy`). Side-effect free
// on import — unlike index.ts, nothing here starts a server or calls
// process.exit() just from being required.
export { startProxyServer, PROXY_PORT } from './proxy/server';
export { startDashboardServer, DASHBOARD_PORT } from './dashboard/server';
export { getDb, getConfig, setConfig } from './db/ledger';
export { getAdapter, listProviders, isPricingStale, pricingSyncedAt, loadSyncedPricing } from './adapters/registry';
export type { Config, WindowRow, RequestRow, Device, Message, ChatCompletionRequest } from './types';
export type { ProviderAdapter, PricingRow, CanonicalUsage, ParsedStreamChunk } from './adapters/types';
