import type { ProviderAdapter, PricingRow, CanonicalUsage, ParsedStreamChunk } from './types';

// Google's native Gemini REST API is different from OpenAI/Anthropic in a way
// that goes beyond field names: the model AND the streaming/non-streaming
// choice are both encoded in the URL path itself
// (`/v1beta/models/{model}:generateContent` vs `:streamGenerateContent?alt=sse`),
// not in the JSON body — hence ProviderAdapter.endpoint.path supporting a
// per-request resolver function (see adapters/types.ts). Usage is reported as
// `usageMetadata` with Gemini-specific field names, and — like OpenAI, unlike
// Anthropic — its cached-token count IS a subset of the prompt token count,
// so the cost math needs its own cache-miss subtraction.
//
// Cappy's shared compression pass (proxy/compression.ts) operates on OpenAI/
// Anthropic-shaped `messages` arrays; Gemini's native request body uses
// `contents`/`parts` instead. Per the project plan, Google (like Anthropic)
// ships without compression in this milestone — a client's request passes
// through unmodified, still metered and paced, just not trimmed.

const API_VERSION = 'v1beta';

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiPart { text?: string }
interface GeminiCandidate { content?: { parts?: GeminiPart[] } }

interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

function toCanonicalUsage(u: GeminiUsageMetadata | undefined): CanonicalUsage {
  return {
    inputTokens: u?.promptTokenCount ?? 0,
    outputTokens: u?.candidatesTokenCount ?? 0,
    cacheReadTokens: u?.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0, // Gemini has no separate cache-write charge (unlike Anthropic prompt caching)
  };
}

function extractText(body: GeminiResponseBody): string | undefined {
  const parts = body.candidates?.[0]?.content?.parts;
  if (!parts) return undefined;
  const text = parts.map(p => p.text ?? '').join('');
  return text || undefined;
}

export interface GoogleAdapterConfig {
  host: string;
  pricing: Record<string, PricingRow>;
  defaultModel: string;
}

export function googleAdapter(cfg: GoogleAdapterConfig): ProviderAdapter {
  return {
    id: 'google',
    wireFormat: 'google',
    endpoint: {
      host: cfg.host,
      path: ({ model, streaming }) =>
        `/${API_VERSION}/models/${model}:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    },
    models: Object.keys(cfg.pricing),
    defaultModel: cfg.defaultModel,

    authHeaders(apiKey: string): Record<string, string> {
      return { 'x-goog-api-key': apiKey };
    },

    pricingFor(model: string): PricingRow | undefined {
      return cfg.pricing[model];
    },

    costMicrodollars(usage: CanonicalUsage, model: string): number {
      const p = cfg.pricing[model] ?? cfg.pricing[cfg.defaultModel];
      if (!p) return 0;
      // Unlike Anthropic's disjoint cache counters, Gemini's cachedContentTokenCount
      // is already included in promptTokenCount — same cache-miss subtraction
      // shape as the OpenAI-compatible adapter, just a different provider.
      const cacheRead = p.cacheRead ?? p.input;
      const cacheMiss = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
      const usd =
        usage.cacheReadTokens * cacheRead +
        cacheMiss * p.input +
        usage.outputTokens * p.output;
      return usd * 1_000_000;
    },

    parseUsage(body: unknown): CanonicalUsage {
      return toCanonicalUsage((body as GeminiResponseBody)?.usageMetadata);
    },

    parseStreamChunk(chunk: unknown): ParsedStreamChunk | null {
      const c = chunk as GeminiResponseBody;
      if (!c || typeof c !== 'object') return null;
      const content = extractText(c);
      // Every streamed chunk repeats usageMetadata as a running total (not a
      // delta), so the latest chunk's numbers are always the authoritative ones.
      const usage = c.usageMetadata ? toCanonicalUsage(c.usageMetadata) : undefined;
      if (content === undefined && usage === undefined) return null;
      return { content, usage };
    },

    rewriteModel<T extends Record<string, unknown>>(body: T, model: string): T {
      const b = body as Record<string, unknown>;
      if ('modelVersion' in b) return { ...body, modelVersion: model };
      return body;
    },
  };
}
