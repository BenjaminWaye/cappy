import chalk from 'chalk';
import { startProxyServer, PROXY_PORT } from './proxy/server';
import { getConfig } from './db/ledger';
import { isPricingStale, pricingSyncedAt } from './adapters/registry';

async function main(): Promise<void> {
  console.log(chalk.bold('\n  Cappy'));
  console.log(chalk.dim('  Budget-paced LLM proxy for any provider\n'));

  const config = getConfig();
  if (!config) {
    console.log(chalk.yellow('  Not configured. Run setup first:'));
    console.log(chalk.cyan('  npx cappy setup\n'));
    process.exit(1);
  }

  if (isPricingStale()) {
    const syncedAt = pricingSyncedAt();
    console.log(chalk.yellow(
      `  Pricing data ${syncedAt ? `last synced ${syncedAt.toISOString()}` : 'has never been synced'} — ` +
      `run ${chalk.cyan('npm run sync-pricing')} to refresh.`,
    ));
  }

  await startProxyServer();

  console.log(chalk.green('  ✓ Running\n'));
  console.log(`  Provider : ${chalk.bold(config.provider)}`);
  console.log(`  Budget   : ${chalk.bold(`$${(config.monthly_budget_microdollars / 1_000_000).toFixed(2)}/month`)}`);
  console.log('');
  console.log(chalk.bold('  For opencode / Cline / Cursor / Aider (any OpenAI-compatible tool):'));
  console.log(`  Base URL : ${chalk.cyan(`http://localhost:${PROXY_PORT}/v1`)}`);
  console.log(`  API Key  : ${chalk.cyan(config.local_api_key)}`);
  console.log(`  Model    : ${chalk.cyan(config.default_model)}`);
  console.log('');
  console.log(chalk.dim('  Press Ctrl+C to stop.\n'));
}

main().catch(err => {
  console.error(chalk.red('Fatal error:'), err.message);
  process.exit(1);
});
