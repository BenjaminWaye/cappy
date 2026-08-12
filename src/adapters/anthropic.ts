import type { ProviderAdapter, PricingRow, CanonicalUsage, ParsedStreamChunk } from './types';

// Anthropic's Messages API (/v1/messages) is genuinely different from the
// OpenAI wire format, not just a config variation:
//  - auth is an `x-api-key` header + `anthropic-version`, not `Authorization: Bearer`
//  - usage splits input/output across cache_creation/cache_read fields that are
//    NOT a subset of input_tokens (unlike OpenAI's prompt_cache_hit_tokens,
//    which IS a subset of prompt_tokens) — so cost math differs, not just field names
//  - streaming sends named event types (message_start/content_block_delta/
//    message_delta/message_stop) as separate JSON frames, and usage itself is
//    split: message_start carries input+cache tokens, message_delta carries the
//    final output token count. A single "final usage chunk" doesn't exist.

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicMessageBody {
  model?: string;
  usage?: AnthropicUsage;
}

interface AnthropicStreamEvent {
  type?: string;
  message?: { model?: string; usage?: AnthropicUsage };
  delta?: { text?: string; type?: string };
  usage?: AnthropicUsage; // present on message_delta (output_tokens only)
}

function toCanonicalUsage(u: AnthropicUsage | undefined): CanonicalUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export interface AnthropicAdapterConfig {
  host: string;
  pricing: Record<string, PricingRow>;
  defaultModel: string;
}

export function anthropicAdapter(cfg: AnthropicAdapterConfig): ProviderAdapter {
  return {
    id: 'anthropic',
    wireFormat: 'anthropic',
    endpoint: { host: cfg.host, path: '/v1/messages' },
    models: Object.keys(cfg.pricing),
    defaultModel: cfg.defaultModel,

    authHeaders(apiKey: string): Record<string, string> {
      return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    },

    pricingFor(model: string): PricingRow | undefined {
      return cfg.pricing[model];
    },

    costMicrodollars(usage: CanonicalUsage, model: string): number {
      const p = cfg.pricing[model] ?? cfg.pricing[cfg.defaultModel];
      if (!p) return 0;
      // Unlike OpenAI's cache-hit accounting, Anthropic's input_tokens/cache_read/
      // cache_creation are three disjoint counts, not overlapping subsets — no
      // "cache miss = input - cache hit" subtraction needed here.
      const usd =
        usage.inputTokens * p.input +
        usage.cacheReadTokens * (p.cacheRead ?? p.input) +
        usage.cacheWriteTokens * (p.cacheWrite ?? p.input) +
        usage.outputTokens * p.output;
      return usd * 1_000_000;
    },

    parseUsage(body: unknown): CanonicalUsage {
      return toCanonicalUsage((body as AnthropicMessageBody)?.usage);
    },

    parseStreamChunk(chunk: unknown): ParsedStreamChunk | null {
      const c = chunk as AnthropicStreamEvent;
      if (!c || typeof c !== 'object') return null;

      switch (c.type) {
        case 'message_start':
          // Carries input + cache token counts; output_tokens here is a small
          // placeholder (usually 1) that message_delta supersedes.
          return c.message?.usage ? { usage: toCanonicalUsage(c.message.usage) } : null;
        case 'content_block_delta':
          return c.delta?.type === 'text_delta' && c.delta.text ? { content: c.delta.text } : null;
        case 'message_delta':
          // Carries the final output_tokens only — input/cache fields are absent
          // here, not zero; callers must merge with message_start's usage rather
          // than overwrite it (see proxy/server.ts's finalUsage merge).
          return c.usage ? { usage: toCanonicalUsage(c.usage) } : null;
        default:
          return null; // ping, message_stop, content_block_start/stop — no usage/content
      }
    },

    rewriteModel<T extends Record<string, unknown>>(body: T, model: string): T {
      const b = body as Record<string, unknown>;
      if (b['type'] === 'message_start' && b['message']) {
        return { ...body, message: { ...(b['message'] as object), model } };
      }
      if (typeof b['type'] === 'string') {
        return body; // other stream event types carry no model field — leave as-is
      }
      return { ...body, model }; // non-streaming top-level response
    },
  };
}
