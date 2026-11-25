'use strict';
// Regression tests for defects found in the independent (hostile) audit of the
// concurrency work. Each was written to FAIL against the pre-fix code.
const assert = require('assert');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { CFG, callTool, runAll, makeEnv, deliver, waMessage } = H;
const CAL = CFG.CALENDAR_ID;
const DAY = '2026-10-06';
const book = (phone, time, summary) => ({ start_datetime: DAY + 'T' + time + ':00', end_datetime: DAY + 'T' + time.replace(/:00$/, ':30') + ':00', summary, notes: '', phone_number: phone });
const cancel = (phone, time, extra) => Object.assign({ appointment_date: DAY, appointment_time: time, phone_number: phone, patient_name: '', booked_phone_number: '' }, extra);
const events = (env) => env.cal.events(CAL);

test('X1 numbers differing only in the operator digit (0555.. vs 0655..) are different customers', async () => {
  const env = makeEnv({ seed: 301 });
  await runAll(env, [() => callTool(env, 'book', book('213555112233', '10:00', 'Sara - x'))]);
  const rs = await runAll(env, [
    () => H.callConfirmed(env, 'cancel', cancel('213655112233', '10:00')),
    () => callTool(env, 'find', { phone_number: '213755112233', patient_name: '', appointment_date: '', booked_phone_number: '' }),
    () => H.callConfirmed(env, 'cancel', cancel('213999999999', '10:00', { booked_phone_number: '0655112233' })),
  ]);
  assert.ok(/^NOT_FOUND/.test(rs[0].result), 'other patient cancelled it: ' + rs[0].result);
  assert.ok(/^NOT_FOUND/.test(rs[1].result), 'other patient saw it: ' + rs[1].result);
  assert.ok(/^NEED_STAFF/.test(rs[2].result), rs[2].result);
  assert.strictEqual(events(env).length, 1);
  // Even the exact right number, typed from another chat, is never proof of ownership (was: SUCCESS).
  const [typed] = await runAll(env, [() => H.callConfirmed(env, 'cancel', cancel('213999999999', '10:00', { booked_phone_number: '0555112233' }))]);
  assert.ok(/^NEED_STAFF/.test(typed.result), typed.result);
  assert.strictEqual(events(env).filter((e) => e.status !== 'cancelled').length, 1);
  // The real owner (the verified sender 213555112233) still can.
  const [own] = await runAll(env, [() => H.callConfirmed(env, 'cancel', cancel('213555112233', '10:00'))]);
  assert.ok(/^SUCCESS/.test(own.result), own.result);
});

test('X2 "already booked" is never claimed for an appointment that staff deleted meanwhile', async () => {
  const env = makeEnv({ seed: 302 });
  const req = book('213555000001', '10:00', 'Sara - x');
  const [a] = await runAll(env, [() => callTool(env, 'book', req)]);
  const id = events(env)[0].id;
  env.cal.apply({ method: 'DELETE', url: 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(CAL) + '/events/' + id, headers: {} });
  const [b] = await runAll(env, [() => callTool(env, 'book', req)]);
  assert.ok(/^SUCCESS/.test(a.result));
  assert.ok(/^SUCCESS: Booked/.test(b.result), 'must really re-book, got: ' + b.result);
  assert.strictEqual(events(env).length, 1);
});

test('X3 cancel immediately after booking works even while events.list lags', async () => {
  const env = makeEnv({ seed: 303, cal: { listLagMs: 8000 } });
  await runAll(env, [() => callTool(env, 'book', book('213555000001', '10:00', 'Sara - x'))]);
  const [c] = await runAll(env, [() => H.callConfirmed(env, 'cancel', cancel('213555000001', '10:00'))]);
  assert.ok(/^SUCCESS/.test(c.result), c.result);
  assert.strictEqual(events(env).length, 0);
});

test('X4 an all-day event marked Busy blocks booking that day; a Free all-day note does not', async () => {
  const env = makeEnv({ seed: 304 });
  env.cal.seed(CAL, { id: 'allday0001', summary: 'Salon closed - training day', start: { date: DAY }, end: { date: '2026-10-07' } });
  env.cal.seed(CAL, { id: 'allday0002', summary: 'Pay day', transparency: 'transparent', start: { date: '2026-10-07' }, end: { date: '2026-10-08' } });
  const rs = await runAll(env, [
    () => callTool(env, 'book', book('213555000001', '10:00', 'A - x')),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00' }),
    () => callTool(env, 'book', Object.assign(book('213555000002', '10:00', 'B - x'), { start_datetime: '2026-10-07T10:00:00', end_datetime: '2026-10-07T10:30:00' })),
  ]);
  assert.ok(/^CLOSED_DAY/.test(rs[0].result), rs[0].result);
  assert.ok(/^CLOSED_DAY/.test(rs[1].result), rs[1].result);
  assert.ok(/^SUCCESS/.test(rs[2].result), rs[2].result);
  assert.ok(rs[0].result.indexOf('training day') < 0, 'must not leak the event title');
});

test('X5 no phone numbers stored in lock objects (ids or state)', async () => {
  const env = makeEnv({ seed: 305, ai: { behave: () => ({ output: 'مرحبا' }) } });
  await runAll(env, [() => callTool(env, 'book', book('213555000001', '10:00', 'Sara - x')), () => deliver(env, waMessage(env, '213555000002', { text: 'hi' }))]);
  for (const [id, e] of env.cal.store(CFG.LOCK_CALENDAR_ID)) {
    if (id.indexOf(CFG.CAL_LOCK_ID) !== 0 && id.indexOf(CFG.CHAT_LOCK_PREFIX) !== 0) continue;
    const blob = id + ' ' + e.cur.summary + ' ' + e.cur.description;
    assert.ok(!/555000001|555000002/.test(blob), 'phone number stored in lock object: ' + blob.slice(0, 200));
  }
});

test('X6 an unexpected error in a Code node of the main flow still replies (fallback) and releases the lock', async () => {
  for (const victim of ['Sanitize AI Output', 'Check For Escalation', 'Match Pause Status']) {
    const env = makeEnv({ seed: 306, ai: { behave: () => ({ output: 'مرحبا' }) } });
    const orig = require('./lib/harness');
    const m1 = waMessage(env, '213555000001', { text: 'one' });
    const m2 = waMessage(env, '213555000001', { text: 'two', ts: Number(m1._ts) + 1 });
    // make the victim node throw on the first message only
    let thrown = false;
    const hooks = { onNode: async (name) => { if (name === victim && !thrown) { thrown = true; throw new Error('unexpected ' + victim + ' failure'); } } };
    const run = async (m) => { const r = new (require('./lib/runner').Runner)(orig.wf('main'), { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks: Object.assign(mainHooksFor(env), hooks) }); return r.run('WhatsApp Trigger', [{ json: m.json }]); };
    const [r1] = await runAll(env, [() => run(m1), H.at(env, 500, () => run(m2))]);
    assert.ok(!r1.error, victim + ': execution crashed instead of failing safe: ' + (r1.error && r1.error.message));
    assert.ok(env.rec.sends.some((s) => s.node === 'Send Fallback Reply'), victim + ': no fallback reply');
    const st = env.cal.lockState(CFG.LOCK_CALENDAR_ID, lockIdFor('213555000001'));
    assert.ok(!st.h || st.hx <= env.sim.now, victim + ': lock left held');
    assert.ok(env.rec.ai.some((c) => c.text === 'two') || victim === 'Match Pause Status', victim + ': next message blocked');
  }
});
// helpers that depend on harness internals
function mainHooksFor(env) { return require('./lib/harness')._mainHooks(env); }
function lockIdFor(chat) { const { createEngine } = require(require('path').join(H.ROOT, 'engine', 'engine.js')); return createEngine(CFG)._t.chatLockId(chat); }

if (require.main === module) runTests('regression.cycle2').then((r) => process.exit(r.fail ? 1 : 0));
