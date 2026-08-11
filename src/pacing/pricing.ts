// Provider-agnostic pacing helpers. Per-model $/token pricing itself lives with
// each ProviderAdapter (see ../adapters) — this module only holds math that
// doesn't depend on which provider or model is in play.

// Conservative estimate: 4 chars per token works well for mixed code/prose.
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimatedSessions(remainingMicrodollars: number, perSessionCostMicrodollars: number): number {
  if (perSessionCostMicrodollars <= 0) return 0;
  return Math.floor(remainingMicrodollars / perSessionCostMicrodollars);
}

export function formatMicrodollars(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(4)}`;
}

export function formatUsd(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}
