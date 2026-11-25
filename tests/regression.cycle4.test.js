'use strict';
// Cycle 4: n8n task-runner crashes ("Node execution failed" in Engine: Decide,
// execution #961) and n8n's Retry of such an execution.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const { Runner } = require('./lib/runner');
const { test, runTests } = require('./lib/t');
const { CFG, STAFF } = H;
const chatLock = require(path.join(H.ROOT, 'engine', 'engine.js')).createEngine(CFG)._t.chatLockId;
const P1 = '213555000001';
const DAY = '2026-10-06';

const aiEnv = (seed) => H.makeEnv({ seed, ai: { behave: () => ({ output: 'مرحبا' }) } });
// Deliver through the real main workflow; `crash(name, run)` returning true
// makes that node fail the way n8n reports a disconnected task runner.
async function deliverWith(env, item, crash, wfOverride) {
  const hooks = Object.assign(H._mainHooks(env), {
    onNode: (name, run) => { if (crash && crash(name, run)) throw new Error('Node execution failed'); },
  });
  const r = new Runner(wfOverride || H.wf('main'), { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks });
  return r.run('WhatsApp Trigger', [{ json: item.json }]);
}
const runsOf = (run, name) => (run.runData[name] || []).length;
const sends = (env, node, to) => env.rec.sends.filter((s) => s.node === node && (!to || s.to === to));
const lock = (env) => env.cal.lockState(CFG.LOCK_CALENDAR_ID, chatLock(P1));
function assertLockFree(env, label) {
  const st = lock(env);
  if (!st) return; // never created - nothing held
  assert.ok(!st.h || st.hx <= env.sim.now, label + ': chat lock still held');
  assert.deepStrictEqual(st.w || [], [], label + ': waiter left behind');
}
async function nextMessageIsFast(env, label) {
  const t0 = env.sim.now;
  await H.runAll(env, [() => H.deliver(env, H.waMessage(env, P1, { text: 'again' }))]);
  const ai = env.rec.ai.filter((a) => a.text === 'again');
  assert.strictEqual(ai.length, 1, label + ': next message not processed');
  assert.ok(ai[0].t0 - t0 < 10000, label + ': next message waited ' + (ai[0].t0 - t0) + 'ms');
}

test('Z1 a Retry-ed execution (new execution id, old lock token) still releases the chat lock', async () => {
  // Simulate n8n Retry: the lock is taken under a token that is NOT 'e' + this execution id.
  const retried = H.mutate('main', "token: 'e' + $execution.id }", "token: 'e961' }");
  const env = aiEnv(401);
  const [r] = await H.runAll(env, [() => deliverWith(env, H.waMessage(env, P1, { text: 'slm' }), null, retried)]);
  assert.ok(!r.error, r.error && r.error.message);
  assertLockFree(env, 'after retry');
  await nextMessageIsFast(env, 'after retry');

  // Load-bearing: the old release (always 'e' + execution id) leaves the lock held.
  const oldRelease = JSON.parse(JSON.stringify(retried));
  const rel = oldRelease.nodes.find((n) => n.name === 'Chat Lock: Release');
  rel.parameters.jsCode = rel.parameters.jsCode.replace("token: token || 'e' + $execution.id", "token: 'e' + $execution.id");
  const env2 = aiEnv(402);
  await H.runAll(env2, [() => deliverWith(env2, H.waMessage(env2, P1, { text: 'slm' }), null, oldRelease)]);
  const st = env2.cal.lockState(CFG.LOCK_CALENDAR_ID, chatLock(P1));
  assert.ok(st.h === 'e961' && st.hx > env2.sim.now, 'mutation check: old release should have left the lock held');
});

test('Z2 runner crash in the lock loop BEFORE the AI -> patient gets the fallback, staff alerted, lock released', async () => {
  for (const k of [1, 2, 3, 4, 5]) { // crash on the k-th Engine: Decide run (different acquire phases)
    const env = aiEnv(410 + k);
    let done = false;
    const crash = (name, run) => { if (!done && name === 'Engine: Decide' && runsOf(run, name) === k) return (done = true); return false; };
    const [r] = await H.runAll(env, [() => deliverWith(env, H.waMessage(env, P1, { text: 'slm' }), crash)]);
    assert.ok(done, 'crash was injected');
    assert.ok(!r.error, 'k=' + k + ': execution must not die: ' + (r.error && r.error.message));
    assert.strictEqual(env.rec.ai.length, 0, 'k=' + k);
    assert.strictEqual(sends(env, 'Send Fallback Reply', P1).length, 1, 'k=' + k + ': patient must get the fallback');
    assert.strictEqual(sends(env, 'Alert Staff - System Error', STAFF).length, 1, 'k=' + k + ': staff must be alerted');
    assertLockFree(env, 'k=' + k);
    assert.deepStrictEqual(env.cal.violations, []);
    await nextMessageIsFast(env, 'k=' + k);
  }
});

test('Z3 Code runner completely down after Dedup -> fallback + staff alert, and the execution ends (no loop)', async () => {
  const env = aiEnv(420);
  const crash = (name, run) => run.nodes.get(name).type === 'n8n-nodes-base.code' && name !== 'Dedup & Filter Prep';
  const [r] = await H.runAll(env, [() => deliverWith(env, H.waMessage(env, P1, { text: 'slm' }), crash)]);
  assert.ok(!r.error && !r.killed, 'execution must end cleanly');
  assert.strictEqual(sends(env, 'Send Fallback Reply', P1).length, 1);
  assert.strictEqual(sends(env, 'Alert Staff - System Error', STAFF).length, 1);
  assert.ok(r.runner.trace.some((t) => t.node === 'Release Failed - Lease Expires'), 'release crash must end at the lease-expiry stop');
  assert.ok(r.runner.trace.length < 40, 'no retry loop: ' + r.runner.trace.length + ' node runs');
});

test('Z4 runner crash DURING the release -> one normal reply, no fallback, no loop; the lease frees the patient', async () => {
  const env = aiEnv(430);
  let done = false;
  const crash = (name, run) => { if (!done && name === 'Engine: Decide' && runsOf(run, 'Chat Lock: Release') > 0) return (done = true); return false; };
  const [r] = await H.runAll(env, [() => deliverWith(env, H.waMessage(env, P1, { text: 'slm' }), crash)]);
  assert.ok(done && !r.error);
  assert.strictEqual(sends(env, 'Send WhatsApp Reply', P1).length, 1);
  assert.strictEqual(sends(env, 'Send Fallback Reply').length, 0, 'patient was already answered - no fallback');
  assert.ok(r.runner.trace.some((t) => t.node === 'Release Failed - Lease Expires'));
  // the next message waits for the lease but is still answered (not dropped)
  await H.runAll(env, [() => H.deliver(env, H.waMessage(env, P1, { text: 'again' }))]);
  assert.strictEqual(env.rec.ai.filter((a) => a.text === 'again').length, 1);
});

test('Z5 runner crash inside Book_Appointment -> ERROR_NEEDS_STAFF (never a success), calendar recovers', async () => {
  const env = H.makeEnv({ seed: 440 });
  const bk = (phone, time, summary) => ({ start_datetime: DAY + 'T' + time + ':00', end_datetime: DAY + 'T' + time.slice(0, 3) + '30:00', summary, notes: 'Patient: ' + summary, phone_number: phone });
  for (const k of [1, 3, 5]) {
    let done = false;
    const onNode = (name, run) => { if (!done && name === 'Engine: Decide' && runsOf(run, name) === k) { done = true; throw new Error('Node execution failed'); } };
    const [r] = await H.runAll(env, [() => H.callTool(env, 'book', bk('21355500010' + k, '1' + k + ':00', 'K' + k + ' - x'), { onNode })]);
    assert.ok(done, 'crash injected');
    assert.ok(/^ERROR_NEEDS_STAFF/.test(r.result), 'k=' + k + ': ' + r.result);
  }
  // a crashed holder's calendar lease expires; the next booking succeeds
  const [ok] = await H.runAll(env, [H.at(env, CFG.CAL_LOCK_TTL_MS + 1000, () => H.callTool(env, 'book', bk('213555000200', '16:00', 'Next - x')))]);
  assert.ok(/^SUCCESS/.test(ok.result), ok.result);
  assert.deepStrictEqual(env.cal.violations, []);
});

test('Z6 error workflow alerts staff on WhatsApp with the failed execution details', async () => {
  const file = path.join(H.ROOT, require(path.join(H.ROOT, 'tools', 'build-workflows.js')).ERROR_WORKFLOW_FILE);
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger'));
  const env = aiEnv(450);
  const r = new Runner(wf, { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks: H._mainHooks(env) });
  const payload = { execution: { id: '961', url: 'https://n8n.example/execution/961', lastNodeExecuted: 'Engine: Decide', error: { message: 'Node execution failed' } }, workflow: { id: 'x', name: 'Lumière WhatsApp AI Agent (Cohere Transcribe)' } };
  const p = r.run('Error Trigger', [{ json: payload }]);
  await env.sim.run();
  const res = await p;
  assert.ok(!res.error, res.error && res.error.message);
  const s = env.rec.sends.filter((x) => x.to === STAFF);
  assert.strictEqual(s.length, 1);
  for (const part of ['961', 'Engine: Decide', 'Node execution failed', 'https://n8n.example/execution/961']) assert.ok(s[0].text.indexOf(part) >= 0, 'alert is missing ' + part);
});

if (require.main === module) runTests('regression.cycle4').then((r) => process.exit(r.fail ? 1 : 0));
