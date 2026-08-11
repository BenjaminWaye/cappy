const cmd = process.argv[2];

if (cmd === 'sync-pricing') {
  require('./scripts/sync-pricing');
} else if (cmd === 'setup') {
  console.log('Setup wizard is not built yet — see the project plan for the installer milestone.');
  console.log('For now, configure via the "config" table in ~/.cappy/ledger.db directly, e.g.:');
  console.log('  provider, api_key, monthly_budget_microdollars, window_size_hours,');
  console.log('  default_model, session_input_tokens, session_output_tokens, local_api_key, install_epoch');
  process.exit(1);
} else {
  require('./index');
}
