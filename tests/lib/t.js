'use strict';
// Tiny sequential test runner.
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runTests(label) {
  let pass = 0, fail = 0;
  const failures = [];
  for (const t of tests.splice(0)) {
    try { await t.fn(); pass++; console.log('  PASS ' + t.name); }
    catch (e) { fail++; failures.push(t.name); console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
  }
  console.log(label + ': ' + pass + ' passed, ' + fail + ' failed');
  return { pass, fail, failures };
}
module.exports = { test, runTests };
