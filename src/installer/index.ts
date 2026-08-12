import * as p from '@clack/prompts';
import chalk from 'chalk';
import { nanoid } from 'nanoid';
import { networkInterfaces, homedir } from 'os';
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDb, setConfig, getConfig } from '../db/ledger';
import { startProxyServer, PROXY_PORT } from '../proxy/server';
import { startDashboardServer, DASHBOARD_PORT } from '../dashboard/server';
import { getAdapter, listProviders } from '../adapters/registry';

const OPENCODE_DIR = path.join(homedir(), '.config', 'opencode');

// ── Network helpers ──────────────────────────────────────────────────────────

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

function brewAvailable(): boolean {
  try { execSync('which brew', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// ── opencode ─────────────────────────────────────────────────────────────────

function opencodeDesktopInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync('/Applications/OpenCode.app');
  }
  return false;
}

function opencodeAvailable(): boolean {
  try { execSync('opencode --version', { stdio: 'pipe' }); return true; }
  catch { return opencodeDesktopInstalled(); }
}

const OPENCODE_WEB_PORT = 7878;

function startOpencodeWeb(): void {
  const child = spawn('opencode', ['web', '--hostname', '0.0.0.0', '--port', String(OPENCODE_WEB_PORT)], {
    stdio: 'ignore',
    detached: false,
  });
  child.on('error', () => { /* opencode not in PATH — desktop app may still be running */ });
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 401 || res.status === 302 || res.status === 404) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function installOpencode(): Promise<boolean> {
  const platform = process.platform;
  console.log('');
  console.log('  ' + chalk.bold('Installing opencode desktop'));

  if (platform === 'darwin') {
    if (opencodeDesktopInstalled()) {
      console.log(chalk.dim('  Already installed at /Applications/OpenCode.app\n'));
      return true;
    }
    if (!brewAvailable()) {
      console.log(chalk.yellow('  Homebrew is required to install the opencode desktop app.'));
      console.log(chalk.dim('  Install Homebrew first: https://brew.sh'));
      console.log(chalk.dim('  Then run: brew install --cask opencode-desktop\n'));
      return false;
    }
    console.log(chalk.dim('  brew install --cask opencode-desktop\n'));
    try {
      execSync('brew install --cask opencode-desktop', { stdio: 'inherit' });
      return true;
    } catch {
      // Homebrew refuses to reinstall if the app already exists outside its own
      // management (e.g. installed manually). Treat that as success, not failure.
      if (opencodeDesktopInstalled()) {
        console.log(chalk.dim('  App already present — continuing.\n'));
        return true;
      }
      console.log('\n' + chalk.red('  Homebrew install failed.'));
      console.log(chalk.dim('  Try manually: brew install --cask opencode-desktop\n'));
      return false;
    }
  }

  if (platform === 'win32') {
    console.log(chalk.yellow('  Automatic install not supported on Windows.'));
    console.log(chalk.dim('  Download the installer from: https://opencode.ai/download'));
    console.log(chalk.dim('  Or via Scoop: scoop install opencode-desktop\n'));
    return false;
  }

  // Linux — fall back to npm CLI since no universal package manager
  console.log(chalk.dim('  npm install -g opencode-ai  (terminal version — desktop app: https://opencode.ai/download)\n'));
  try {
    execSync('npm install -g opencode-ai', { stdio: 'inherit' });
    return true;
  } catch {
    console.log('\n' + chalk.red('  npm install failed.'));
    console.log(chalk.dim('  Download the desktop AppImage from: https://opencode.ai/download\n'));
    return false;
  }
}

// Writes an opencode provider entry pointed at Cappy's local proxy. The npm
// connector opencode loads depends on the upstream provider's wire format —
// Cappy exposes each provider's own shape rather than translating it, so the
// client config has to match (see adapters/types.ts: ProviderAdapter.wireFormat).
function writeOpencodeConfig(providerId: string, wireFormat: string, model: string, localApiKey: string): void {
  fs.mkdirSync(OPENCODE_DIR, { recursive: true });
  const configPath = path.join(OPENCODE_DIR, 'opencode.json');

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch { /* fresh install */ }

  const connectorNpm = wireFormat === 'anthropic' ? '@ai-sdk/anthropic'
    : wireFormat === 'google' ? '@ai-sdk/google'
    : '@ai-sdk/openai-compatible';

  const provider = (existing['provider'] as Record<string, unknown>) ?? {};
  const config = {
    ...existing,
    $schema: 'https://opencode.ai/config.json',
    provider: {
      ...provider,
      'cappy': {
        npm: connectorNpm,
        name: `Cappy (${providerId})`,
        options: {
          baseURL: `http://localhost:${PROXY_PORT}/v1`,
          apiKey: localApiKey,
        },
        models: {
          [model]: { name: model },
        },
      },
    },
    model: `cappy/${model}`,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

// ── remote-runner (optional composition) ─────────────────────────────────────
// Cappy has zero hard dependency on remote-runner — they're independent
// products. If remote-runner's CLI happens to be installed, Cappy registers
// its proxy + dashboard ports with it so a phone can reach them over
// Tailscale; if it's not installed, this is a silent no-op. This replaces
// Whalecap's inline Tailscale block with an optional integration.

function remoteRunnerAvailable(): boolean {
  try { execSync('remote-runner', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function registerWithRemoteRunner(): boolean {
  if (!remoteRunnerAvailable()) return false;
  try {
    execSync(`remote-runner add cappy-proxy --port ${PROXY_PORT} --health /health --description "Cappy metering proxy"`, { stdio: 'pipe' });
    execSync(`remote-runner add cappy-dashboard --port ${DASHBOARD_PORT} --description "Cappy spend dashboard"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false; // best-effort — setup should never fail because of this
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.clear();
  p.intro(chalk.bold('  Cappy'));
  console.log(chalk.dim('  Buy LLM API credits once. Code safely all month.\n'));

  const existing = getConfig();

  if (existing) {
    const proceed = await p.confirm({
      message: 'Cappy is already configured. Reconfigure?',
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      if (existing.local_api_key) {
        try {
          const adapter = getAdapter(existing.provider, existing.default_model);
          writeOpencodeConfig(adapter.id, adapter.wireFormat, existing.default_model || adapter.defaultModel, existing.local_api_key);
        } catch { /* best-effort */ }
      }
      p.outro(chalk.dim('Settings refreshed. No budget changes made.'));
      process.exit(0);
    }
  }

  // ── Question 1: Provider ────────────────────────────────────────────────────
  const providers = listProviders();
  const providerId = await p.select({
    message: 'Which LLM provider are you paying for?',
    options: providers.map(id => ({ value: id, label: id })),
    initialValue: existing?.provider ?? providers[0],
  });
  if (p.isCancel(providerId)) { p.cancel('Cancelled'); process.exit(0); }

  const adapter = getAdapter(providerId as string);

  // ── Question 2: API key ─────────────────────────────────────────────────────
  const apiKey = await p.text({
    message: `Your ${providerId} API key`,
    placeholder: 'sk-...',
    validate: v => (!v || v.trim().length < 10) ? 'Paste your full API key' : undefined,
  });
  if (p.isCancel(apiKey)) { p.cancel('Cancelled'); process.exit(0); }

  // ── Question 3: Monthly budget ─────────────────────────────────────────────
  const budgetStr = await p.text({
    message: `How much did you load on ${providerId}? (USD) — Cappy spreads it safely across the month`,
    placeholder: '10',
    initialValue: '10',
    validate: v => {
      const n = parseFloat(v ?? '');
      if (isNaN(n) || n <= 0) return 'Enter a number, e.g. 10';
    },
  });
  if (p.isCancel(budgetStr)) { p.cancel('Cancelled'); process.exit(0); }
  const budgetUsd = parseFloat(budgetStr as string);

  // ── Question 4: Coding agent ───────────────────────────────────────────────
  const wantChat = await p.confirm({
    message: 'Install coding agent? (opencode — desktop/terminal AI coding agent)',
    initialValue: true,
  });
  if (p.isCancel(wantChat)) { p.cancel('Cancelled'); process.exit(0); }

  // ── Install opencode ──────────────────────────────────────────────────────
  let chatInstalled = false;
  if (wantChat) {
    chatInstalled = await installOpencode();
  }

  // ── Save config ────────────────────────────────────────────────────────────
  const localApiKey  = existing?.local_api_key ?? `sk-ag-${nanoid(32)}`;
  const installEpoch = existing?.install_epoch ?? Date.now();

  const saveSpinner = p.spinner();
  saveSpinner.start('Saving configuration');
  getDb();
  setConfig('provider',                    providerId as string);
  setConfig('api_key',                     apiKey as string);
  setConfig('monthly_budget_microdollars', budgetUsd * 1_000_000);
  setConfig('window_size_hours',           '5');
  setConfig('default_model',              adapter.defaultModel);
  setConfig('session_input_tokens',        30_000);
  setConfig('session_output_tokens',       8_000);
  setConfig('local_api_key',              localApiKey);
  setConfig('install_epoch',              installEpoch);
  saveSpinner.stop('Configuration saved');

  // ── Write opencode config ─────────────────────────────────────────────────
  if (chatInstalled) {
    try { writeOpencodeConfig(adapter.id, adapter.wireFormat, adapter.defaultModel, localApiKey); } catch { /* non-fatal */ }
  }

  // ── Start Cappy runtime ───────────────────────────────────────────────────
  // Gracefully handle the case where the runtime is already running (e.g. npm start
  // was left open in another terminal). EADDRINUSE is not fatal during setup.
  const startSpinner = p.spinner();
  startSpinner.start('Starting Cappy runtime');
  try {
    await Promise.all([startProxyServer(), startDashboardServer()]);
    startSpinner.stop('Runtime started');
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      startSpinner.stop('Runtime already running — using existing process');
    } else {
      throw err;
    }
  }

  // ── Optional: register with remote-runner, if installed ──────────────────
  const remoteRegistered = registerWithRemoteRunner();

  const agentUp   = wantChat && chatInstalled;
  const localIp   = getLocalIp();
  const opencodeLocalUrl = `http://localhost:${OPENCODE_WEB_PORT}`;
  const opencodeWifiUrl  = `http://${localIp}:${OPENCODE_WEB_PORT}`;

  // ── Start opencode web + open browser ─────────────────────────────────────
  if (agentUp) {
    startOpencodeWeb();
    const pingSpinner = p.spinner();
    pingSpinner.start('Starting opencode web');
    const ready = await waitForHttp(opencodeLocalUrl);
    pingSpinner.stop(ready ? `opencode web ready` : chalk.yellow('opencode web still starting — check the URL in a moment'));
    openBrowser(opencodeLocalUrl);
  } else {
    openBrowser(`http://localhost:${DASHBOARD_PORT}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.green('  ✓ Cappy is running\n'));
  console.log(`  Provider  : ${chalk.bold(providerId as string)}`);
  console.log(`  Budget    : ${chalk.bold(`$${budgetUsd.toFixed(2)}/month`)}`);
  if (agentUp) {
    console.log(`  opencode  : ${chalk.cyan(opencodeLocalUrl)}  ← opening now`);
    console.log(`              ${chalk.cyan(opencodeWifiUrl)}  (same Wi-Fi)`);
    console.log(chalk.dim(`              Config: ~/.config/opencode/opencode.json`));
  }
  console.log(`  Monitor   : ${chalk.cyan(`http://localhost:${DASHBOARD_PORT}`)}`);
  console.log('');
  console.log(chalk.bold('  For Cline / Cursor / Aider (any OpenAI-compatible tool):'));
  console.log(`  Base URL  : ${chalk.cyan(`http://localhost:${PROXY_PORT}/v1`)}`);
  console.log(`  API Key   : ${chalk.cyan(localApiKey)}`);
  console.log(`  Model     : ${chalk.cyan(adapter.defaultModel)}`);
  console.log('');
  if (remoteRegistered) {
    console.log(chalk.dim('  remote-runner detected — proxy + dashboard registered for phone access.'));
    console.log(chalk.dim('  Run: remote-runner up\n'));
  } else {
    console.log(chalk.dim('  Away from home: install remote-runner (a separate tool) for phone access,'));
    console.log(chalk.dim('  then re-run this setup: npm install -g remote-runner\n'));
  }

  console.log(chalk.dim('  Cappy is running. Press Ctrl+C to stop.\n'));
}

run().catch(err => {
  console.error(chalk.red('\nSetup failed:'), err.message);
  process.exit(1);
});
