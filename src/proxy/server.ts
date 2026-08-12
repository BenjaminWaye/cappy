import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import https from 'https';
import type { IncomingMessage } from 'http';
import { getConfig, saveRequest } from '../db/ledger';
import { getCurrentWindow, getCurrentWeek, deductUsage, catastrophicCap, formatDuration } from '../pacing/windows';
import { compress } from './compression';
import { CHARS_PER_TOKEN } from '../pacing/pricing';
import { passthroughRouter } from './router';
import { getAdapter, isPricingStale } from '../adapters/registry';
import type { ProviderAdapter, CanonicalUsage } from '../adapters/types';
import type { ChatCompletionRequest } from '../types';

export const PROXY_PORT = 4000;

// ── Provider HTTP helper ─────────────────────────────────────────────────────

function resolvePath(adapter: ProviderAdapter, model: string, streaming: boolean): string {
  return typeof adapter.endpoint.path === 'function'
    ? adapter.endpoint.path({ model, streaming })
    : adapter.endpoint.path;
}

function providerPost(adapter: ProviderAdapter, body: object, apiKey: string, model: string, streaming: boolean): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: adapter.endpoint.host,
        path: resolvePath(adapter, model, streaming),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...adapter.authHeaders(apiKey),
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function extractBearer(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) return '';
  return authorization.slice(7).trim();
}

// ── Main server ──────────────────────────────────────────────────────────────

export async function startProxyServer(): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // Auth guard — skip /health
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    const config = getConfig();
    if (!config) {
      return void reply.code(503).send({ error: { message: 'Cappy not configured. Run setup first.', type: 'server_error' } });
    }
    const token = extractBearer(req.headers.authorization as string | undefined);
    if (token !== config.local_api_key) {
      return void reply.code(401).send({ error: { message: 'Unauthorized', type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
  });

  app.get('/health', async () => ({ status: 'ok', service: 'cappy' }));

  app.get('/v1/models', async () => {
    const config = getConfig();
    const adapter = config ? getAdapter(config.provider, config.default_model) : null;
    return {
      object: 'list',
      data: (adapter?.models ?? []).map(id => ({
        id,
        object: 'model',
        created: 1_700_000_000,
        owned_by: adapter?.id ?? 'unknown',
      })),
    };
  });

  // Reply with a budget-limit message that looks like a normal assistant turn.
  // Returning 429 causes some clients (e.g. opencode) to silently hang the turn in_progress.
  function replyBudgetError(reply: FastifyReply, message: string, model: string, streaming: boolean): void {
    const id = `chatcmpl-cap-${Date.now()}`;
    if (streaming) {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const delta = { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: `⚠️ ${message}` }, finish_reason: 'stop' }] };
      res.write(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
      res.end();
    } else {
      reply.send({ id, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: `⚠️ ${message}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    }
  }

  app.post<{ Body: ChatCompletionRequest }>('/v1/chat/completions', async (req, reply) => {
    const config = getConfig()!; // auth hook ensures config exists
    const adapter = getAdapter(config.provider, config.default_model);

    if (isPricingStale()) {
      console.warn(`[cappy] pricing for "${adapter.id}" may be stale — run "cappy sync-pricing"`);
    }

    const windowState = getCurrentWindow();
    if (!windowState) {
      return reply.code(503).send({ error: { message: 'Window state unavailable', type: 'server_error' } });
    }

    const { window: win, available, nextRefillAt } = windowState;
    const streaming = req.body.stream === true;
    const requestedModel = req.body.model || config.default_model || adapter.defaultModel;

    // Weekly budget check
    const weekState = getCurrentWeek(config);
    if (weekState && weekState.available <= 0) {
      return replyBudgetError(reply, `Weekly budget exhausted. Resets in ${formatDuration(weekState.weekEnd - Date.now())}.`, requestedModel, streaming);
    }

    // Per-window quota check
    if (available <= 0) {
      return replyBudgetError(reply, `Window limit reached. Next refill in ${formatDuration(nextRefillAt - Date.now())}.`, requestedModel, streaming);
    }

    const messages = req.body.messages ?? [];

    // Compression
    const cr = compress(messages);
    const inputTokenEst = cr.finalTokens;

    // Route (off by default — see proxy/router.ts)
    const model = passthroughRouter(cr.messages, requestedModel);

    // Cost reservation (conservative: no cache hit assumed, 2k output reserve)
    const OUTPUT_RESERVE = 2_000;
    const estimatedCost = adapter.costMicrodollars(
      { inputTokens: inputTokenEst, outputTokens: OUTPUT_RESERVE, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model,
    );
    const cap = catastrophicCap(win);
    const balanceBefore = available;

    const requestedStream = req.body.stream === true;

    const upstreamBody = adapter.rewriteModel(
      { ...req.body, messages: cr.messages, stream: requestedStream, stream_options: requestedStream ? { include_usage: true } : undefined },
      model,
    );

    // ── Non-streaming ──────────────────────────────────────────────────────
    if (!requestedStream) {
      const upstream = await providerPost(adapter, upstreamBody, config.api_key, model, false);
      const chunks: Buffer[] = [];
      for await (const chunk of upstream) chunks.push(chunk as Buffer);
      const data = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const rewritten = adapter.rewriteModel(data, model);

      const usage = adapter.parseUsage(rewritten);
      const actual = adapter.costMicrodollars(usage, model);

      deductUsage(win.id, actual);
      saveRequest({
        timestamp: Date.now(), provider: adapter.id, model,
        estimated_cost: estimatedCost, actual_cost: actual,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        cache_hit_tokens: usage.cacheReadTokens, cache_miss_tokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens),
        compression_applied: cr.applied ? 1 : 0,
        compression_ratio: cr.originalTokens > 0 ? cr.finalTokens / cr.originalTokens : 1,
        window_id: win.id, balance_before: balanceBefore, balance_after: balanceBefore - actual,
        catastrophic_cap_triggered: 0,
      });
      return reply.send(rewritten);
    }

    // ── Streaming ──────────────────────────────────────────────────────────
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let outputChars = 0;
    let capTriggered = false;
    let finalUsage: CanonicalUsage | null = null;
    let buffer = '';

    try {
      const upstream = await providerPost(adapter, upstreamBody, config.api_key, model, true);

      for await (const raw of upstream) {
        buffer += (raw as Buffer).toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          // Anthropic frames SSE as paired "event: <type>\ndata: {...}\n\n" lines;
          // OpenAI-wire providers only ever send "data: {...}\n\n". Relay any
          // event: line through untouched so Anthropic-aware clients still see
          // the frame type — this is a no-op for adapters that never emit one.
          if (line.startsWith('event: ')) {
            res.write(line + '\n');
            continue;
          }
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();

          if (payload === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }

          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(payload); }
          catch { continue; }

          const parsed = adapter.parseStreamChunk(chunk);
          if (parsed?.usage) {
            // Merge rather than overwrite: some adapters (Anthropic) split usage
            // across multiple stream events — message_start carries input/cache
            // tokens, message_delta carries the final output tokens — so a later
            // event must not blank out fields an earlier one already reported.
            const prev: CanonicalUsage = finalUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
            const next = parsed.usage;
            finalUsage = {
              inputTokens: next.inputTokens || prev.inputTokens,
              outputTokens: next.outputTokens || prev.outputTokens,
              cacheReadTokens: next.cacheReadTokens || prev.cacheReadTokens,
              cacheWriteTokens: next.cacheWriteTokens || prev.cacheWriteTokens,
            };
          }
          if (parsed?.content) outputChars += parsed.content.length;

          // Per-chunk catastrophic cap check
          const runningCost = adapter.costMicrodollars(
            { inputTokens: inputTokenEst, outputTokens: Math.ceil(outputChars / CHARS_PER_TOKEN), cacheReadTokens: 0, cacheWriteTokens: 0 },
            model,
          );
          if (!capTriggered && runningCost > cap) {
            capTriggered = true;
            // [DONE] is an OpenAI-wire sentinel; other formats end a stream by
            // closing the connection (res.end() below), so sending it there
            // would just be a stray, meaningless frame.
            if (adapter.wireFormat === 'openai') res.write('data: [DONE]\n\n');
            break;
          }

          const outChunk = adapter.rewriteModel(chunk, model);
          res.write(`data: ${JSON.stringify(outChunk)}\n\n`);
        }

        if (capTriggered) break;
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: { message: String(err) } })}\n\n`);
    } finally {
      res.end();

      // Reconcile ledger
      const usage = finalUsage ?? {
        inputTokens: inputTokenEst,
        outputTokens: Math.ceil(outputChars / CHARS_PER_TOKEN),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const actual = adapter.costMicrodollars(usage, model);

      deductUsage(win.id, actual);
      saveRequest({
        timestamp: Date.now(), provider: adapter.id, model,
        estimated_cost: estimatedCost, actual_cost: actual,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        cache_hit_tokens: usage.cacheReadTokens, cache_miss_tokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens),
        compression_applied: cr.applied ? 1 : 0,
        compression_ratio: cr.originalTokens > 0 ? cr.finalTokens / cr.originalTokens : 1,
        window_id: win.id, balance_before: balanceBefore, balance_after: balanceBefore - actual,
        catastrophic_cap_triggered: capTriggered ? 1 : 0,
      });

      // Cooldown after catastrophic cap (non-blocking)
      if (capTriggered) {
        setTimeout(() => {/* cooldown expires naturally */}, 60_000);
      }
    }
  });

  await app.listen({ port: PROXY_PORT, host: '127.0.0.1' });
  console.log(`\n  Cappy proxy  →  http://localhost:${PROXY_PORT}/v1`);
}
