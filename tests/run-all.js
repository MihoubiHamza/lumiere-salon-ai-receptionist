'use strict';
// Runs every suite in its own process; exits non-zero if anything fails.
const { spawnSync } = require('child_process');
const path = require('path');
const suites = ['graph.test.js', 'unit.engine.test.js', 'tools.concurrency.test.js', 'confirmation.test.js', 'main.concurrency.test.js', 'regression.cycle2.test.js', 'regression.cycle3.test.js', 'regression.cycle4.test.js', 'messenger.test.js', 'isolation.test.js', path.join('..', 'website-demo', 'tests', 'web-demo.test.js'), path.join('..', 'website-demo', 'tests', 'site.test.js')];
let failed = 0;
for (const s of suites) {
  console.log('\n=== ' + s + ' ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log('\n' + (failed ? failed + ' suite(s) FAILED' : 'ALL SUITES PASSED'));
process.exit(failed ? 1 : 0);
