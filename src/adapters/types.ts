// A ProviderAdapter tells Cappy how to talk to one upstream LLM provider:
// where to send requests, how to authenticate, and how to turn that
// provider's usage/pricing numbers into a canonical microdollar cost.
//
// Cappy's proxy is a metering pass-through, not a format translator: it
// forwards the client's request body to the provider almost unchanged and
// exposes that provider's own wire shape locally. So an adapter only needs
// to know its own format, never anyone else's.

export interface PricingRow {
  input: number;        // USD per token, base/cache-miss input
  output: number;       // USD per token, output
  cacheRead?: number;   // USD per token, cache-hit input (defaults to `input` if absent)
  cacheWrite?: number;  // USD per token, cache write (Anthropic-style prompt caching)
}

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ParsedStreamChunk {
  content?: string;              // extracted assistant text delta, for output-token fallback estimation
  usage?: CanonicalUsage;        // present once the provider reports final usage in-stream
}

export interface ProviderAdapter {
  id: string;                                  // adapter id, e.g. 'deepseek', 'openai', 'groq'
  wireFormat: 'openai' | 'anthropic' | 'google';
  endpoint: { host: string; path: string };     // upstream host + path Cappy forwards requests to
  models: string[];                             // known model ids for this provider
  defaultModel: string;

  authHeaders(apiKey: string): Record<string, string>;

  pricingFor(model: string): PricingRow | undefined;
  costMicrodollars(usage: CanonicalUsage, model: string): number;

  // Non-streaming response body → canonical usage.
  parseUsage(body: unknown): CanonicalUsage;

  // One already-JSON-parsed SSE data chunk → extracted content/usage, or null if irrelevant.
  parseStreamChunk(chunk: unknown): ParsedStreamChunk | null;

  // Rewrite the model field on an outgoing chunk/body before it's relayed to the client
  // (Cappy may route to a different concrete model than the client requested).
  rewriteModel<T extends Record<string, unknown>>(body: T, model: string): T;
}
