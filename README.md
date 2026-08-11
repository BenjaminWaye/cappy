# Cappy

A local, budget-paced LLM proxy — for any provider, not just one. Cappy is
Whalecap's idea (spread a prepaid API budget safely across the month, with a
local usage ledger) generalized past its original DeepSeek-only scope.

## How it works

Cappy runs a small local proxy that:
- Exposes an OpenAI-compatible `/v1/chat/completions` endpoint your coding
  tool (opencode, Cline, Cursor, Aider, ...) points at instead of the
  provider directly.
- Paces spend against a monthly budget using time-windowed rate limiting, so
  one long session can't blow through the whole month.
- Logs every request to a local SQLite ledger (`~/.cappy/ledger.db`).
- Forwards requests to the real provider almost unchanged — it meters and
  paces, it doesn't translate between wire formats. A client just points its
  existing OpenAI-compatible provider config at Cappy's local URL.

## Providers

Today: any provider that speaks the OpenAI chat-completions wire format —
DeepSeek, OpenAI, Groq, xAI, Mistral, and more via one generic adapter
(`src/adapters/openai-compatible.ts`). Anthropic and Google Gemini use
different wire formats and need bespoke adapters — not implemented yet.

## Keeping pricing current

Per-model pricing is synced from [models.dev](https://models.dev)'s public
model catalog rather than hand-maintained:

```
npm run sync-pricing
```

writes `src/adapters/pricing/synced.json`, tagged with a `syncedAt`
timestamp. A weekly GitHub Action (`.github/workflows/sync-pricing.yml`)
runs this automatically and commits any changes. If pricing is more than 14
days stale, Cappy logs a warning at startup rather than silently billing
against outdated numbers. For providers/models models.dev doesn't cover,
add a manual entry to `src/adapters/pricing/overrides.json` — it always
wins over synced data.

## Status

Early scaffold. Implemented: config/ledger/pacing core, the OpenAI-compatible
adapter + DeepSeek/OpenAI/Groq/xAI/Mistral wiring, the metering proxy, and
the pricing sync pipeline. Not yet implemented: setup wizard/installer,
spend dashboard, Anthropic/Google adapters, multi-profile support. See the
project plan for milestones.

## Development

```
npm install
npm test            # unit tests
npm run dev          # run the proxy against ~/.cappy/ledger.db config
npm run sync-pricing  # refresh pricing from models.dev
```
