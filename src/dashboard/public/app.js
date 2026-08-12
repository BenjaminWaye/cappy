// ── Tab navigation ──────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('view' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'Activity') loadRequests();
  if (name === 'Connect')  loadConnect();
}

// ── Toast ───────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Formatting helpers ──────────────────────────────────────────────────────
function fmtUsd(micro) {
  return '$' + (micro / 1_000_000).toFixed(2);
}

function fmtCost(micro) {
  const usd = micro / 1_000_000;
  if (usd >= 0.01) return '$' + usd.toFixed(2);
  if (usd >= 0.001) return '$' + usd.toFixed(4);
  return '$' + usd.toFixed(5);
}

function fmtClock(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today    = new Date().toDateString();
  const tomorrow = new Date(Date.now() + 86_400_000).toDateString();
  if (d.toDateString() === today)    return `today at ${time}`;
  if (d.toDateString() === tomorrow) return `tomorrow at ${time}`;
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ` at ${time}`;
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60_000)   return 'just now';
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3600_000)}h ago`;
}

// ── Status polling ──────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const data = await r.json();
    renderStatus(data);
  } catch {
    document.getElementById('balanceSub').textContent = 'Unable to connect to runtime';
  }
}

function renderWindowCard(win, idPrefix, resetLabel) {
  if (!win) return;

  const idx = win.window_index ?? win.week_index;
  document.getElementById(idPrefix + 'Tag').textContent =
    idx !== undefined && idx !== null
      ? (idPrefix === 'window' ? `Window #${idx + 1}` : `Week #${idx + 1}`)
      : (idPrefix === 'window' ? 'Window #—' : 'Week #—');

  const badge = document.getElementById(idPrefix + 'Badge');
  badge.textContent = { healthy: 'Healthy', low: 'Low', exhausted: 'Exhausted' }[win.status] ?? win.status;
  badge.className = `status-badge ${win.status}`;

  const total = (win.allocation ?? win.budget ?? 0) + (win.rollover ?? 0);
  const avail = win.available ?? 0;
  const pct   = total > 0 ? Math.round(Math.max(0, avail) / total * 100) : 0;

  const pctEl = document.getElementById(idPrefix + 'PctNumber');
  pctEl.textContent = pct;
  pctEl.className   = 'pct-number' +
    (win.status === 'low' ? ' warn' : win.status === 'exhausted' ? ' error' : '');

  const fill = document.getElementById(idPrefix + 'Progress');
  fill.style.width = pct + '%';
  fill.className   = 'progress-fill' +
    (win.status === 'low' ? ' warn' : win.status === 'exhausted' ? ' error' : '');

  const refillAt  = win.next_refill_at ?? win.resets_at;
  const clockStr  = fmtClock(refillAt);
  const clockCap  = clockStr.charAt(0).toUpperCase() + clockStr.slice(1);

  const refillRowId  = idPrefix === 'window' ? 'refillRow'     : 'weekRefillRow';
  const refillTimeId = idPrefix === 'window' ? 'refillTime'    : 'weekResetTime';
  const boxId        = idPrefix === 'window' ? 'refillBox'     : 'weekRefillBox';
  const boxTimeId    = idPrefix === 'window' ? 'refillBoxTime' : 'weekRefillBoxTime';

  document.getElementById(refillTimeId).textContent = clockStr;
  document.getElementById(boxTimeId).textContent    = clockCap;

  const box     = document.getElementById(boxId);
  const rowEl   = document.getElementById(refillRowId);
  const rowText = idPrefix === 'window' ? 'Refills' : 'Resets';

  if (win.status === 'exhausted') {
    box.classList.add('show');
    rowEl.style.display = 'none';
  } else {
    box.classList.remove('show');
    rowEl.style.display = '';
    rowEl.innerHTML = `${rowText} <strong>${clockStr}</strong>`;
  }
}

function renderStatus(data) {
  const dot = document.getElementById('statusDot');

  if (!data.configured) {
    document.getElementById('balanceAmount').textContent = '—';
    document.getElementById('balanceSub').textContent = 'Run: cappy setup';
    dot.className = 'dot error';
    return;
  }

  document.getElementById('providerTag').textContent = data.provider ?? '';

  const banner = document.getElementById('staleBanner');
  banner.classList.toggle('show', !!data.pricing_stale);

  const { balance, week, window: win } = data;

  // ── Balance card ──────────────────────────────────────────────────────────
  document.getElementById('balanceAmount').textContent = balance.remaining_usd;
  document.getElementById('balanceSub').textContent =
    `${fmtUsd(balance.total_spent)} spent of ${fmtUsd(balance.total_budget)} budget`;
  document.getElementById('balanceSessions').textContent =
    `~${balance.estimated_sessions} sessions left`;

  // ── Window + Weekly cards ─────────────────────────────────────────────────
  renderWindowCard(win,  'window', 'Refills');
  renderWindowCard(week, 'week',   'Resets');

  // Header dot — red if either tier exhausted, yellow if either low
  const worstStatus = [win?.status, week?.status].includes('exhausted') ? 'exhausted'
    : [win?.status, week?.status].includes('low') ? 'low' : 'healthy';
  dot.className = 'dot' +
    (worstStatus === 'low' ? ' warn' : worstStatus === 'exhausted' ? ' error' : '');

  loadProviders();
}

// ── Provider breakdown ────────────────────────────────────────────────────────
async function loadProviders() {
  try {
    const r = await fetch('/api/providers');
    const { providers } = await r.json();
    const card = document.getElementById('providersCard');
    if (!providers || providers.length <= 1) { card.style.display = 'none'; return; }
    card.style.display = '';
    document.getElementById('providersList').innerHTML = providers
      .sort((a, b) => b.spent - a.spent)
      .map(p => `
        <div class="provider-row">
          <div><span class="provider-name">${p.provider}</span><span class="provider-count">${p.requests} req</span></div>
          <div class="provider-spent">${p.spent_usd}</div>
        </div>
      `).join('');
  } catch { /* non-fatal */ }
}

// ── Activity ─────────────────────────────────────────────────────────────────
async function loadRequests() {
  try {
    const r = await fetch('/api/requests?limit=30');
    const { requests } = await r.json();
    renderRequests(requests);
  } catch {
    document.getElementById('reqList').innerHTML =
      '<div class="empty-state">Could not load requests</div>';
  }
}

function renderRequests(requests) {
  const list = document.getElementById('reqList');
  if (!requests || requests.length === 0) {
    list.innerHTML = '<div class="empty-state">No requests yet</div>';
    return;
  }
  // Requests arrive newest-first; accumulate oldest-first then reverse back
  const reversed = [...requests].reverse();
  let running = 0;
  const withAccum = reversed.map(r => { running += r.actual_cost; return { ...r, accum: running }; });
  const ordered = withAccum.reverse();

  list.innerHTML = ordered.map(r => `
    <div class="req-item">
      <div class="req-item-left">
        <div class="req-item-model">${r.model} ${r.provider ? `<span class="req-item-provider">${r.provider}</span>` : ''}</div>
        <div class="req-item-tokens">${r.input_tokens.toLocaleString()} in · ${r.output_tokens.toLocaleString()} out · ${timeAgo(r.timestamp)}</div>
        ${r.compression_applied ? '<div class="req-item-cap">⚡ compressed</div>' : ''}
        ${r.catastrophic_cap_triggered ? '<div class="req-item-cap">⚠ cap triggered</div>' : ''}
      </div>
      <div style="text-align:right">
        <div class="req-item-cost">${fmtCost(r.actual_cost)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:1px">Σ ${fmtCost(r.accum)}</div>
      </div>
    </div>
  `).join('');
}

// ── Connect ──────────────────────────────────────────────────────────────────
async function loadConnect() {
  try {
    const r = await fetch('/api/connect');
    const data = await r.json();
    document.getElementById('connectProxy').textContent = data.proxy_local;
    document.getElementById('connectWifi').textContent  = data.dashboard_wifi;
    document.getElementById('connectModel').textContent = data.model ?? '—';
  } catch {}
  document.getElementById('connectApiKey').textContent = '(see terminal output after setup)';
}

// ── QR Pairing ────────────────────────────────────────────────────────────────
document.getElementById('pairBtn').addEventListener('click', async () => {
  const btn = document.getElementById('pairBtn');
  btn.textContent = 'Generating…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: 'My Phone' }),
    });
    const data = await r.json();
    document.getElementById('qrImg').src = data.qr;
    document.getElementById('qrSection').style.display = 'block';
    btn.textContent = 'Regenerate QR';
    toast('QR ready — scan with your phone');
  } catch {
    toast('Could not generate QR code');
    btn.textContent = 'Pair Phone (QR)';
  }
  btn.disabled = false;
});

// ── Auto-refresh every 30s ────────────────────────────────────────────────────
loadStatus();
setInterval(loadStatus, 30_000);
