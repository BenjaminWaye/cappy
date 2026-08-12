const cmd = process.argv[2];

if (cmd === 'sync-pricing') {
  require('./scripts/sync-pricing');
} else if (cmd === 'setup') {
  require('./installer/index');
} else {
  require('./index');
}
