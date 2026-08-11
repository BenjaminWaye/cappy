import type { ProviderAdapter, PricingRow, CanonicalUsage, ParsedStreamChunk } from './types';

// One factory covers every provider that speaks the OpenAI chat-completions
// wire format: DeepSeek, OpenAI itself, Groq, Together, Mistral, OpenRouter,
// xAI, Azure OpenAI, local Ollama/vLLM in compat mode, and more. They share
// request/response/SSE shape (prompt_tokens/completion_tokens, `data: {...}`
// frames) — only base URL and pricing differ, which is pure config here, not
// a reason to hand-write a new adapter per provider.

export interface OpenAICompatibleConfig {
  id: string;
  host: string;
  path?: string;                       // default '/v1/chat/completions'
  authHeaderName?: string;             // default 'Authorization' → `Bearer ${apiKey}`
  pricing: Record<string, PricingRow>;
  defaultModel: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
}

interface OpenAIChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: OpenAIUsage;
}

function toCanonicalUsage(u: OpenAIUsage | undefined): CanonicalUsage {
  const inputTokens  = u?.prompt_tokens ?? 0;
  const cacheRead     = u?.prompt_cache_hit_tokens ?? 0;
  return {
    inputTokens,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
  };
}

export function openaiCompatibleAdapter(cfg: OpenAICompatibleConfig): ProviderAdapter {
  return {
    id: cfg.id,
    wireFormat: 'openai',
    endpoint: { host: cfg.host, path: cfg.path ?? '/v1/chat/completions' },
    models: Object.keys(cfg.pricing),
    defaultModel: cfg.defaultModel,

    authHeaders(apiKey: string): Record<string, string> {
      const headerName = cfg.authHeaderName ?? 'Authorization';
      return { [headerName]: `Bearer ${apiKey}` };
    },

    pricingFor(model: string): PricingRow | undefined {
      return cfg.pricing[model];
    },

    costMicrodollars(usage: CanonicalUsage, model: string): number {
      const p = cfg.pricing[model] ?? cfg.pricing[cfg.defaultModel];
      if (!p) return 0;
      const cacheRead = p.cacheRead ?? p.input;
      const cacheMiss = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
      const usd =
        usage.cacheReadTokens * cacheRead +
        cacheMiss * p.input +
        usage.outputTokens * p.output +
        usage.cacheWriteTokens * (p.cacheWrite ?? 0);
      return usd * 1_000_000;
    },

    parseUsage(body: unknown): CanonicalUsage {
      const b = body as { usage?: OpenAIUsage };
      return toCanonicalUsage(b?.usage);
    },

    parseStreamChunk(chunk: unknown): ParsedStreamChunk | null {
      const c = chunk as OpenAIChunk;
      if (!c || typeof c !== 'object') return null;
      const content = c.choices?.[0]?.delta?.content;
      const usage = c.usage ? toCanonicalUsage(c.usage) : undefined;
      if (content === undefined && usage === undefined) return null;
      return { content, usage };
    },

    rewriteModel<T extends Record<string, unknown>>(body: T, model: string): T {
      return { ...body, model };
    },
  };
}
