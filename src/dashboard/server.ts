import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import path from 'path';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';
import { getConfig, getRecentRequests, getTotalSpent, getDevices, saveDevice, revokeDevice } from '../db/ledger';
import { getCurrentWindow, getCurrentWeek, formatDuration } from '../pacing/windows';
import { estimatedSessions, formatUsd } from '../pacing/pricing';
import { getAdapter, isPricingStale, pricingSyncedAt } from '../adapters/registry';
import { networkInterfaces } from 'os';

export const DASHBOARD_PORT = 3080;

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

export async function startDashboardServer(): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(staticPlugin, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
  });

  // ── API: current status ────────────────────────────────────────────────────
  app.get('/api/status', async () => {
    const config = getConfig();
    if (!config) return { configured: false };

    const adapter = getAdapter(config.provider, config.default_model);
    const ws  = getCurrentWindow();
    const wk  = getCurrentWeek(config);
    const totalSpent = getTotalSpent();
    const totalBudget = config.monthly_budget_microdollars;
    const remainingTotal = Math.max(0, totalBudget - totalSpent);

    const perSessionCost = adapter.costMicrodollars(
      { inputTokens: config.session_input_tokens, outputTokens: config.session_output_tokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      config.default_model || adapter.defaultModel,
    );
    const sessions = estimatedSessions(remainingTotal, perSessionCost);

    return {
      configured: true,
      provider: adapter.id,
      model: config.default_model || adapter.defaultModel,
      pricing_stale: isPricingStale(),
      pricing_synced_at: pricingSyncedAt()?.toISOString() ?? null,
      balance: {
        total_budget:       totalBudget,
        total_spent:        totalSpent,
        remaining:          remainingTotal,
        remaining_usd:      formatUsd(remainingTotal),
        estimated_sessions: sessions,
      },
      week: wk ? {
        week_index:    wk.week_index,
        budget:        wk.budget,
        budget_usd:    formatUsd(wk.budget),
        used:          wk.used,
        used_usd:      formatUsd(wk.used),
        available:     wk.available,
        available_usd: formatUsd(wk.available),
        resets_at:     wk.weekEnd,
        status:        wk.available > wk.budget * 0.2 ? 'healthy' : wk.available > 0 ? 'low' : 'exhausted',
      } : null,
      window: ws ? {
        window_index:      ws.window.window_index,
        available:         ws.available,
        available_usd:     formatUsd(ws.available),
        allocation:        ws.window.allocation_microdollars,
        allocation_usd:    formatUsd(ws.window.allocation_microdollars),
        rollover:          ws.window.rollover_before,
        rollover_usd:      formatUsd(ws.window.rollover_before),
        used:              ws.window.used_microdollars,
        used_usd:          formatUsd(ws.window.used_microdollars),
        next_refill_at:    ws.nextRefillAt,
        next_refill_in_ms: Math.max(0, ws.nextRefillAt - Date.now()),
        status:            ws.available > ws.window.allocation_microdollars * 0.2 ? 'healthy' : ws.available > 0 ? 'low' : 'exhausted',
      } : null,
      session_definition: {
        input_tokens:  config.session_input_tokens,
        output_tokens: config.session_output_tokens,
      },
    };
  });

  // ── API: recent requests ───────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: string } }>('/api/requests', async (req) => {
    const limit = Math.min(100, parseInt(req.query.limit ?? '20', 10));
    return { requests: getRecentRequests(limit) };
  });

  // ── API: spend broken down by provider (Cappy can pace multiple providers'
  // usage in one ledger once multi-profile support lands; the breakdown is
  // useful even with a single active provider, to show where spend is going).
  app.get('/api/providers', async () => {
    const requests = getRecentRequests(500);
    const byProvider = new Map<string, { requests: number; spent: number }>();
    for (const r of requests) {
      const key = r.provider || 'unknown';
      const entry = byProvider.get(key) ?? { requests: 0, spent: 0 };
      entry.requests += 1;
      entry.spent += r.actual_cost;
      byProvider.set(key, entry);
    }
    return {
      providers: [...byProvider.entries()].map(([provider, v]) => ({
        provider, requests: v.requests, spent: v.spent, spent_usd: formatUsd(v.spent),
      })),
    };
  });

  // ── API: devices ───────────────────────────────────────────────────────────
  app.get('/api/devices', async () => ({ devices: getDevices() }));

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req, reply) => {
    revokeDevice(parseInt(req.params.id, 10));
    return reply.code(204).send();
  });

  // ── API: pair phone ────────────────────────────────────────────────────────
  // Returns a QR code that encodes the dashboard URL and a one-time token
  // the phone app can use to authenticate future API requests.
  app.post<{ Body: { device_name?: string } }>('/api/pair', async (req) => {
    const config = getConfig();
    if (!config) return { error: 'Not configured' };

    const token = nanoid(32);
    const hash  = crypto.createHash('sha256').update(token).digest('hex');
    const name  = req.body?.device_name ?? `Phone ${new Date().toLocaleDateString()}`;

    saveDevice({ name, token_hash: hash, created_at: Date.now(), last_seen_at: Date.now(), revoked_at: null });

    const localIp = getLocalIp();
    const url = `http://${localIp}:${DASHBOARD_PORT}`;
    const pairingPayload = JSON.stringify({ runtime_url: url, device_name: name });
    const qrDataUrl = await QRCode.toDataURL(pairingPayload, { width: 256, margin: 2 });

    return { qr: qrDataUrl, url, device_name: name, token };
  });

  // ── API: local connection info ─────────────────────────────────────────────
  app.get('/api/connect', async () => {
    const config = getConfig();
    const ip = getLocalIp();
    return {
      dashboard_local: `http://localhost:${DASHBOARD_PORT}`,
      dashboard_wifi:  `http://${ip}:${DASHBOARD_PORT}`,
      proxy_local:     `http://localhost:4000/v1`,
      provider:        config?.provider ?? null,
      model:           config?.default_model ?? null,
    };
  });

  await app.listen({ port: DASHBOARD_PORT, host: '0.0.0.0' });
  const localIp = getLocalIp();
  console.log(`  Dashboard          →  http://localhost:${DASHBOARD_PORT}`);
  console.log(`  Phone (same WiFi)  →  http://${localIp}:${DASHBOARD_PORT}`);
}
