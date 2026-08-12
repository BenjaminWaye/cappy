# Cappy

A local, budget-paced LLM proxy — for any provider, not just one. Cappy is
Whalecap's idea (spread a prepaid API budget safely across the month, with a
local usage ledger) generalized past its original DeepSeek-only scope.

## How it works

Cappy runs a small local proxy + dashboard that:
- Exposes each provider's own wire format locally (`/v1/chat/completions` for
  OpenAI-style providers, `/v1/messages` for Anthropic, the native Gemini
  `generateContent` API for Google) — a client just points its existing
  provider config at Cappy's local URL instead of the provider directly.
- Paces spend against a monthly budget using time-windowed rate limiting, so
  one long session can't blow through the whole month.
- Logs every request to a local SQLite ledger (`~/.cappy/ledger.db`) and
  shows it on a phone-friendly spend dashboard.
- Forwards requests to the real provider almost unchanged — it meters and
  paces, it doesn't translate between wire formats.

## Providers

- **OpenAI-compatible** (one generic adapter, `src/adapters/openai-compatible.ts`):
  DeepSeek, OpenAI, Groq, xAI, Mistral, and more — they share request/response/SSE
  shape, differing only in base URL and pricing.
- **Anthropic** (`src/adapters/anthropic.ts`): bespoke — `x-api-key` auth,
  disjoint input/cache-read/cache-write token accounting, and streaming usage
  split across `message_start`/`message_delta` events rather than one final chunk.
- **Google** (`src/adapters/google.ts`): bespoke — native Gemini REST API,
  where the model and streaming choice are encoded in the URL path itself,
  `usageMetadata` usage fields, and cache tokens that behave like OpenAI's
  cache-hit accounting (a subset of the prompt count, not disjoint).

Compression (`src/proxy/compression.ts`) trims long conversations before
forwarding for OpenAI-wire adapters; Anthropic/Google requests currently pass
through uncompressed, still metered and paced.

## Keeping pricing current

Per-model pricing is synced from [models.dev](https://models.dev)'s public
model catalog rather than hand-maintained:

```
npm run sync-pricing
```

writes `src/adapters/pricing/synced.json`, tagged with a `syncedAt`
timestamp. A weekly GitHub Action (`.github/workflows/sync-pricing.yml`)
runs this automatically and commits any changes. If pricing is more than 14
days stale, Cappy logs a warning at startup and the dashboard shows a banner,
rather than silently billing against outdated numbers. For providers/models
models.dev doesn't cover, add a manual entry to
`src/adapters/pricing/overrides.json` — it always wins over synced data.

## Setup

```
npx cappy setup
```

Walks through: pick a provider → paste its API key → how much budget you
loaded → optionally install opencode as a coding agent pointed at Cappy's
local proxy. If [remote-runner](../remote-runner) happens to be installed,
setup registers Cappy's proxy + dashboard ports with it automatically so a
phone can reach them over Tailscale — Cappy has no hard dependency on it
either way.

## Status

Implemented: config/ledger/pacing core, OpenAI-compatible + Anthropic +
Google adapters, the metering proxy, the pricing sync pipeline, the setup
wizard, and the spend dashboard. Not yet implemented: multi-profile support
(pacing more than one provider/budget at once). See the project plan for
milestones.

## Development

```
npm install
npm test              # unit tests
npm run dev            # run the proxy against ~/.cappy/ledger.db config
npm run setup           # interactive setup wizard
npm run sync-pricing     # refresh pricing from models.dev
```
