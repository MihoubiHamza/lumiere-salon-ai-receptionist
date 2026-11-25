'use strict';
// Executes the REAL Book / Reschedule / Cancel / Find / Check workflow JSON
// against a fake Google Calendar under concurrency and injected failures.
const assert = require('assert');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { CFG, callTool, runAll, at, makeEnv, KillSignal, svcFor } = H;
const CAL = CFG.CALENDAR_ID, LOCKCAL = CFG.LOCK_CALENDAR_ID;

const DAY = '2026-10-06'; // Tuesday
const bk = (phone, time, summary, o) => Object.assign({
  start_datetime: (o && o.date || DAY) + 'T' + time + ':00',
  service_keys: svcFor((o && o.dur) || 30),
  summary, notes: 'Patient: ' + summary, phone_number: phone,
}, o && o.extra);
function addMin(t, m) { const [h, mi] = t.split(':').map(Number); const x = h * 60 + mi + m; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); }
const status = (r) => String(r.result || (r.res && r.res.error ? 'EXEC_ERROR ' + r.res.error.message : r.res && r.res.killed ? 'KILLED' : 'NONE')).split(':')[0];
const count = (rs, s) => rs.filter((r) => status(r) === s).length;
function events(env) { return env.cal.events(CAL).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime)); }
function assertNoOverlap(env) {
  const ev = events(env);
  for (let i = 1; i < ev.length; i++) {
    assert.ok(Date.parse(ev[i].start.dateTime) >= Date.parse(ev[i - 1].end.dateTime), 'DOUBLE BOOKING: ' + ev[i - 1].summary + ' overlaps ' + ev[i].summary);
  }
}
function assertInvariants(env) {
  assert.deepStrictEqual(env.cal.violations, [], 'lock mutual exclusion violated');
  assertNoOverlap(env);
  const st = env.cal.lockState(LOCKCAL, CFG.CAL_LOCK_ID);
  if (st && st.h) assert.ok(st.hx <= env.sim.now, 'calendar lock still held at end of test');
}
// every SUCCESS (non-idempotent) booking has exactly its event; no event without a SUCCESS
function assertBookingsConsistent(env, results) {
  const ev = events(env);
  const ok = results.filter((r) => status(r) === 'SUCCESS');
  for (const r of ok) assert.ok(ev.some((e) => e.summary === r.inputs.summary && e.start.dateTime.slice(0, 16) === r.inputs.start_datetime.slice(0, 16)), 'SUCCESS without event: ' + r.inputs.summary);
  for (const e of ev) assert.ok(ok.some((r) => r.inputs.summary === e.summary), 'event without SUCCESS: ' + e.summary);
  const perSummary = {};
  for (const e of ev) perSummary[e.summary] = (perSummary[e.summary] || 0) + 1;
  for (const k of Object.keys(perSummary)) assert.strictEqual(perSummary[k], 1, 'duplicate appointment for ' + k);
}
function seedAppt(env, id, phone, date, time, summary, dur) {
  const s = Date.parse(date + 'T' + time + ':00+01:00');
  return env.cal.seed(CAL, { id, summary, description: 'Phone: ' + phone + '. Notes: seeded', start: { dateTime: date + 'T' + time + ':00+01:00', timeZone: 'Africa/Algiers' }, end: { dateTime: new Date(s + (dur || 30) * 60000 + 3600000).toISOString().slice(0, 19) + '+01:00', timeZone: 'Africa/Algiers' } });
}
const apptTime = (env, id) => { const e = env.cal.store(CAL).get(id).cur; return e.status === 'cancelled' ? 'cancelled' : e.start.dateTime.slice(0, 16); };

// ============================================================ BOOKING
test('B1 two patients book the same slot simultaneously -> exactly one SUCCESS', async () => {
  const env = makeEnv({ seed: 1 });
  const rs = await runAll(env, [
    at(env, 0, () => callTool(env, 'book', bk('213555000001', '10:00', 'Sara Benali - Detartrage'))),
    at(env, 3, () => callTool(env, 'book', bk('213555000002', '10:00', 'Amine Kaci - Extraction'))),
  ]);
  assert.strictEqual(count(rs, 'SUCCESS'), 1, rs.map((r) => r.result).join(' | '));
  assert.strictEqual(count(rs, 'CONFLICT'), 1);
  assert.strictEqual(events(env).length, 1);
  assertInvariants(env); assertBookingsConsistent(env, rs);
});

test('B2 five patients book the same slot within 50ms -> exactly one SUCCESS', async () => {
  for (const seed of [2, 3, 4, 5, 6]) {
    const env = makeEnv({ seed });
    const rs = await runAll(env, [0, 7, 12, 30, 50].map((d, i) => at(env, d, () => callTool(env, 'book', bk('21355500001' + i, '10:00', 'Patient' + i + ' X - Kashf')))));
    assert.strictEqual(count(rs, 'SUCCESS'), 1, 'seed ' + seed + ': ' + rs.map((r) => r.result).join(' | '));
    assert.strictEqual(count(rs, 'CONFLICT'), 4);
    assertInvariants(env); assertBookingsConsistent(env, rs);
  }
});

test('B3 twenty bookers with overlapping (different) start times never double-book', async () => {
  for (const seed of [7, 8, 9]) {
    const env = makeEnv({ seed });
    const times = ['10:00', '10:10', '10:15', '10:20', '10:30', '10:45', '11:00', '10:05'];
    const rs = await runAll(env, Array.from({ length: 20 }, (_, i) => at(env, Math.floor(env.sim.rng() * 200), () => callTool(env, 'book', bk('2135550100' + String(i).padStart(2, '0'), times[i % times.length], 'P' + i + ' Y - Kashf')))));
    assert.ok(count(rs, 'SUCCESS') >= 2, 'expected at least two non-overlapping successes');
    assert.strictEqual(count(rs, 'SUCCESS') + count(rs, 'CONFLICT'), 20, rs.map((r) => r.result).join(' | '));
    assertInvariants(env); assertBookingsConsistent(env, rs);
  }
});

test('B4 different slots booked concurrently all succeed', async () => {
  const env = makeEnv({ seed: 10 });
  const rs = await runAll(env, ['09:00', '10:00', '11:00', '14:00', '16:30'].map((t, i) => at(env, i, () => callTool(env, 'book', bk('21355502000' + i, t, 'Q' + i + ' Z - Kashf')))));
  assert.strictEqual(count(rs, 'SUCCESS'), 5, rs.map((r) => r.result).join(' | '));
  assertInvariants(env); assertBookingsConsistent(env, rs);
});

test('B5 duplicate identical booking requests create ONE appointment, both report SUCCESS', async () => {
  const env = makeEnv({ seed: 11 });
  const req = bk('213555000001', '10:00', 'Sara Benali - Detartrage');
  const rs = await runAll(env, [at(env, 0, () => callTool(env, 'book', req)), at(env, 2, () => callTool(env, 'book', req))]);
  assert.strictEqual(count(rs, 'SUCCESS'), 2, rs.map((r) => r.result).join(' | '));
  assert.ok(rs.some((r) => /already booked/.test(r.result)));
  assert.strictEqual(events(env).length, 1);
  // and a later retry (e.g. AI Agent retry) is still idempotent
  const [r3] = await runAll(env, [() => callTool(env, 'book', req)]);
  assert.ok(/already booked/.test(r3.result));
  assert.strictEqual(events(env).length, 1);
  assertInvariants(env);
});

test('B6a insert applied but response lost (timeout) -> SUCCESS, no duplicate', async () => {
  let hit = 0;
  const env = makeEnv({ seed: 12, cal: { fault: (req) => (req.method === 'POST' && /\/events$/.test(req.url.split('?')[0]) && req.body && /^nb/.test(req.body.id) && hit++ === 0 ? { kind: 'dropAfter' } : null) } });
  const [r] = await runAll(env, [() => callTool(env, 'book', bk('213555000001', '10:00', 'Sara Benali - Detartrage'))]);
  assert.strictEqual(status(r), 'SUCCESS', r.result);
  assert.strictEqual(events(env).length, 1);
  assertInvariants(env);
});

test('B6b insert never reached server (dropped) -> ERROR not SUCCESS; retry books exactly once', async () => {
  let hit = 0;
  const env = makeEnv({ seed: 13, cal: { fault: (req) => (req.method === 'POST' && req.body && /^nb/.test(req.body.id) && hit++ === 0 ? { kind: 'dropBefore' } : null) } });
  const req = bk('213555000001', '10:00', 'Sara Benali - Detartrage');
  const [r] = await runAll(env, [() => callTool(env, 'book', req)]);
  assert.strictEqual(status(r), 'ERROR', r.result);
  assert.strictEqual(events(env).length, 0);
  const [r2] = await runAll(env, [() => callTool(env, 'book', req)]);
  assert.strictEqual(status(r2), 'SUCCESS', r2.result);
  assert.strictEqual(events(env).length, 1);
  assertInvariants(env);
});

test('B6c server applies the insert AFTER the client timed out -> confirmed via GET, no duplicate', async () => {
  let hit = 0;
  const env = makeEnv({ seed: 14, cal: { fault: (req) => (req.method === 'POST' && req.body && /^nb/.test(req.body.id) && hit++ === 0 ? { applyDelay: 11500 } : null) } });
  const [r] = await runAll(env, [() => callTool(env, 'book', bk('213555000001', '10:00', 'Sara Benali - Detartrage'))]);
  assert.strictEqual(status(r), 'SUCCESS', r.result);
  assert.strictEqual(events(env).length, 1);
  assertInvariants(env);
});

test('B7 events.list read-lag: journal prevents a double booking (and the mutation test proves it is needed)', async () => {
  const scenario = async (env) => runAll(env, [
    at(env, 0, () => callTool(env, 'book', bk('213555000001', '10:00', 'Sara Benali - Detartrage'))),
    at(env, 400, () => callTool(env, 'book', bk('213555000002', '10:15', 'Amine Kaci - Extraction'))),
  ]);
  const env = makeEnv({ seed: 15, cal: { listLagMs: 5000 } });
  const rs = await scenario(env);
  assert.strictEqual(count(rs, 'SUCCESS'), 1, rs.map((r) => r.result).join(' | '));
  assertInvariants(env);
  // Mutation: disable the journal -> the same scenario must double-book.
  const env2 = makeEnv({ seed: 15, cal: { listLagMs: 5000 } });
  env2.wfOverrides = { book: H.mutate('book', '"JOURNAL_KEEP_MS": 600000', '"JOURNAL_KEEP_MS": 0') };
  await scenario(env2);
  assert.throws(() => assertNoOverlap(env2), /DOUBLE BOOKING/, 'mutation test: without the journal the lag scenario should double-book');
});

test('B7b mutation: without the calendar mutex, simultaneous bookings double-book (proves the lock is load-bearing)', async () => {
  const env = makeEnv({ seed: 16 });
  env.wfOverrides = { book: H.mutate('book', "return lockStart(s, 'B.list', now);", "s.L = { held: { st: { j: [] }, hx: now + 999999 }, released: true }; return GOTO(s, 'B.list');") };
  // also neutralise the post-write verification so only the mutex is under test
  env.wfOverrides.book = JSON.parse(JSON.stringify(env.wfOverrides.book).split("GOTO(s, others.length ? 'B.rb' : 'B.ok')").join("GOTO(s, 'B.ok')"));
  await runAll(env, [0, 1, 2, 3, 4].map((d, i) => at(env, d, () => callTool(env, 'book', bk('21355500001' + i, '10:00', 'M' + i + ' - Kashf')))));
  assert.throws(() => assertNoOverlap(env), /DOUBLE BOOKING/);
});

test('B8 outside hours / past / malformed input rejected without touching the calendar', async () => {
  const env = makeEnv({ seed: 17 });
  const rs = await runAll(env, [
    () => callTool(env, 'book', bk('213555000001', '23:00', 'A - x', { date: '2026-10-09' })),
    () => callTool(env, 'book', bk('213555000001', '19:00', 'A - x')),
    () => callTool(env, 'book', bk('213555000001', '08:30', 'A - x')),
    () => callTool(env, 'book', bk('213555000001', '10:00', 'A - x', { date: '2026-10-01' })),
    () => callTool(env, 'book', { start_datetime: '2026-10-06T25:00:00', service_keys: 'mens_cut', summary: 'A', phone_number: '213555000001' }),
    () => callTool(env, 'book', bk('213555000001', '10:00', '')),
    () => callTool(env, 'book', bk('213555000001', '17:00', 'Long - Balayage', { dur: 180 })), // would end 20:00, after closing
    () => callTool(env, 'book', bk('213555000001', '10:00', 'Sun - x', { date: '2026-10-11' })), // Sunday: salon closed
  ]);
  assert.deepStrictEqual(rs.map(status), ['OUTSIDE_HOURS', 'OUTSIDE_HOURS', 'OUTSIDE_HOURS', 'PAST_TIME', 'INVALID_INPUT', 'INVALID_INPUT', 'OUTSIDE_HOURS', 'CLOSED_DAY']);
  assert.strictEqual(env.cal.log.length, 0);
});

test('B9 execution crashes while HOLDING the lock -> next booker waits for lease expiry and succeeds; no permanent lock', async () => {
  const env = makeEnv({ seed: 18 });
  let victim = null;
  const crashAtList = { http: async (req, run) => {
    if (victim === null) victim = run.execId;
    if (run.execId === victim && req.url.indexOf('singleEvents') >= 0) throw new KillSignal('worker crashed');
    return env.cal.request(req);
  } };
  const rs = await runAll(env, [
    at(env, 0, () => callTool(env, 'book', bk('213555000001', '10:00', 'Victim - x'), crashAtList)),
    at(env, 1000, () => callTool(env, 'book', bk('213555000002', '10:00', 'Amine Kaci - Extraction'))),
  ]);
  assert.ok(rs[0].res.killed);
  assert.strictEqual(status(rs[1]), 'SUCCESS', rs[1].result);
  const takeover = env.cal.lockEvents.find((e) => e.id === CFG.CAL_LOCK_ID && e.prevExpired);
  assert.ok(takeover && takeover.t >= CFG.CAL_LOCK_TTL_MS, 'stale lock must only be taken over after its lease expired');
  assertInvariants(env);
});

test('B10 Google Calendar down (every request 500) -> ERROR, never SUCCESS, no event, no lock held', async () => {
  const env = makeEnv({ seed: 19, cal: { fault: () => ({ kind: '500' }) } });
  const [r] = await runAll(env, [() => callTool(env, 'book', bk('213555000001', '10:00', 'Sara Benali - Detartrage'))]);
  assert.strictEqual(status(r), 'ERROR', r.result);
  assert.strictEqual(events(env).length, 0);
  assertInvariants(env);
});

test('B11 rate limited (429) insert is retried safely -> SUCCESS, one event', async () => {
  let hit = 0;
  const env = makeEnv({ seed: 20, cal: { fault: (req) => (req.method === 'POST' && req.body && /^nb/.test(req.body.id) && hit++ < 2 ? { kind: '429' } : null) } });
  const [r] = await runAll(env, [() => callTool(env, 'book', bk('213555000001', '10:00', 'Sara Benali - Detartrage'))]);
  assert.strictEqual(status(r), 'SUCCESS', r.result);
  assert.strictEqual(events(env).length, 1);
  assertInvariants(env);
});

test('B12 lock-object bootstrap race with UNDETECTED id collisions still yields one SUCCESS', async () => {
  for (const seed of [21, 22, 23]) {
    const env = makeEnv({ seed, cal: { idCollision: 'overwrite' } });
    const rs = await runAll(env, [0, 1, 2].map((d, i) => at(env, d, () => callTool(env, 'book', bk('21355500003' + i, '10:00', 'R' + i + ' - Kashf')))));
    assert.strictEqual(count(rs, 'SUCCESS'), 1, rs.map((r) => r.result).join(' | '));
    assertInvariants(env);
  }
});

test('B13 randomized fault storm (timeouts, drops, 500s) - invariants hold, no false SUCCESS', async () => {
  for (const seed of [24, 25, 26, 27]) {
    const env = makeEnv({ seed });
    env.cal.opts.fault = (req) => { const x = env.sim.rng(); if (x < 0.05) return { kind: 'dropBefore' }; if (x < 0.10) return { kind: 'dropAfter' }; if (x < 0.15) return { kind: '500' }; return null; };
    const times = ['10:00', '10:00', '10:15', '11:00', '11:00', '14:00'];
    const rs = await runAll(env, times.map((t, i) => at(env, Math.floor(env.sim.rng() * 300), () => callTool(env, 'book', bk('2135550300' + i, t, 'S' + i + ' - Kashf')))));
    for (const r of rs) assert.ok(['SUCCESS', 'CONFLICT', 'ERROR', 'BUSY_RETRY', 'ERROR_NEEDS_STAFF'].indexOf(status(r)) >= 0, r.result);
    assertInvariants(env);
    const ev = events(env);
    for (const r of rs.filter((x) => status(x) === 'SUCCESS')) assert.ok(ev.some((e) => e.summary === r.inputs.summary), 'false SUCCESS ' + r.inputs.summary);
    for (const e of ev) {
      const r = rs.find((x) => x.inputs.summary === e.summary);
      assert.ok(['SUCCESS', 'ERROR_NEEDS_STAFF'].indexOf(status(r)) >= 0, 'orphan event created by a request that reported ' + status(r));
    }
    // system recovers: a fresh booking works afterwards
    env.cal.opts.fault = null;
    const [after] = await runAll(env, [() => callTool(env, 'book', bk('213555039999', '16:00', 'After - Kashf'))]);
    assert.strictEqual(status(after), 'SUCCESS', after.result);
  }
});

test('B14 lease expires during a stalled execution -> stalled booker aborts (BUSY_RETRY), no double booking', async () => {
  const env = makeEnv({ seed: 28 });
  let victim = null, stalled = false;
  const stall = { onNode: async (name, run, items) => {
    if (victim === null) victim = run.execId;
    const st = items[0] && items[0].json && items[0].json.__engine && items[0].json.__engine.state;
    if (!stalled && run.execId === victim && name === 'Engine: Decide' && st && st.L && st.L.held && st.phase === 'LS.resp') { stalled = true; await env.sim.sleep(60000); }
  } };
  const rs = await runAll(env, [
    at(env, 0, () => callTool(env, 'book', bk('213555000001', '10:00', 'Stalled - x'), stall)),
    at(env, 2000, () => callTool(env, 'book', bk('213555000002', '10:00', 'Amine Kaci - Extraction'))),
  ]);
  assert.strictEqual(status(rs[0]), 'BUSY_RETRY', rs[0].result);
  assert.strictEqual(status(rs[1]), 'SUCCESS', rs[1].result);
  assert.strictEqual(events(env).length, 1);
  assertInvariants(env);
});

test('B15 engine state channels: works with static data unavailable OR item-linking unavailable; fails safe if both', async () => {
  for (const opts of [{ staticBroken: true }, { itemLinkBroken: true }]) {
    const env = makeEnv({ seed: 29, opts });
    const rs = await runAll(env, [0, 5].map((d, i) => at(env, d, () => callTool(env, 'book', bk('21355500004' + i, '10:00', 'C' + i + ' - Kashf')))));
    assert.strictEqual(count(rs, 'SUCCESS'), 1, JSON.stringify(opts) + ' ' + rs.map((r) => r.result).join(' | '));
    assertInvariants(env);
  }
  const env = makeEnv({ seed: 30, opts: { staticBroken: true, itemLinkBroken: true } });
  const [r] = await runAll(env, [() => callTool(env, 'book', bk('213555000001', '10:00', 'D - Kashf'))]);
  // lost state is caught by the crash safety net: never a success, nothing written
  assert.ok(!r.res.error && /^ERROR_NEEDS_STAFF/.test(r.result), 'must fail safe, got ' + (r.result || (r.res.error && r.res.error.message)));
  assert.ok(r.res.runner.trace.some((t) => t.node === 'Engine Failed - Result'), 'must come from the crash path');
  assert.strictEqual(events(env).length, 0);
});

// ============================================================ RESCHEDULE
const rs_ = (phone, od, ot, nd, nt, extra) => Object.assign({ old_appointment_date: od, old_appointment_time: ot, new_appointment_date: nd, new_appointment_time: nt, new_summary: '', new_description: '', phone_number: phone, patient_name: '', booked_phone_number: '' }, extra);

test('R1 two simultaneous reschedules of the SAME appointment -> exactly one wins, no inconsistent SUCCESS', async () => {
  for (const seed of [31, 32, 33]) {
    const env = makeEnv({ seed });
    seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara Benali - Detartrage');
    const rs = await runAll(env, [
      at(env, 0, () => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '11:00'))),
      at(env, 2, () => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '12:00'))),
    ]);
    assert.strictEqual(count(rs, 'SUCCESS'), 1, rs.map((r) => r.result).join(' | '));
    // Confirmation gate: the loser either finds nothing any more, or its confirmation was
    // replaced by the newer request of the same customer - in both cases nothing changed.
    assert.strictEqual(rs.filter((r) => /^(NOT_FOUND|CONFIRMATION_INVALID)\b/.test(String(r.result))).length, 1, rs.map((r) => r.result).join(' | '));
    const winner = rs.find((r) => status(r) === 'SUCCESS');
    assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T' + winner.inputs.new_appointment_time);
    assert.strictEqual(events(env).length, 1);
    assertInvariants(env);
  }
});

test('R2 two patients reschedule into the same destination slot -> one SUCCESS, one CONFLICT', async () => {
  const env = makeEnv({ seed: 34 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  seedAppt(env, 'appttwo2', '213555000002', DAY, '10:30', 'Amine - x');
  const rs = await runAll(env, [
    at(env, 0, () => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '14:00'))),
    at(env, 1, () => H.callConfirmed(env, 'reschedule', rs_('213555000002', DAY, '10:30', DAY, '14:15'))),
  ]);
  assert.strictEqual(count(rs, 'SUCCESS'), 1, rs.map((r) => r.result).join(' | '));
  // The slot is re-checked at the moment the confirmed change runs: the second one is refused.
  const loser = rs.find((r) => status(r) !== 'SUCCESS');
  assert.ok(status(loser) === 'CONFLICT' || /^CONFIRMATION_INVALID \(conflict\)/.test(loser.result), loser.result);
  assertInvariants(env);
});

test('R3 reschedule PUT applied but response lost -> SUCCESS confirmed by re-read', async () => {
  let hit = 0;
  const env = makeEnv({ seed: 35, cal: { fault: (req) => (req.method === 'PUT' && /apptone1$/.test(req.url) && hit++ === 0 ? { kind: 'dropAfter' } : null) } });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  const [r] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '15:00'))]);
  assert.strictEqual(status(r), 'SUCCESS', r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T15:00');
  assertInvariants(env);
});

test('R4 retry after partial success: identical reschedule sent again -> idempotent SUCCESS, nothing else changes', async () => {
  const env = makeEnv({ seed: 36 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  const req = rs_('213555000001', DAY, '10:00', DAY, '15:00');
  const [a] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', req)]);
  const [b] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', req)]);
  assert.strictEqual(status(a), 'SUCCESS');
  assert.strictEqual(status(b), 'SUCCESS', b.result);
  assert.ok(/already rescheduled/.test(b.result));
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T15:00');
  assert.strictEqual(events(env).length, 1);
});

test('R5 staff edits the appointment mid-reschedule -> no lost update (CAS), staff edit preserved', async () => {
  let hit = 0;
  const env = makeEnv({ seed: 37 });
  env.cal.opts.fault = (req, cal) => {
    if (req.method === 'PUT' && /apptone1$/.test(req.url) && hit++ === 0) {
      const cur = cal.store(CAL).get('apptone1').cur;
      cal.apply({ method: 'PUT', url: req.url, headers: {}, body: Object.assign({}, cur, { summary: 'Sara - x (staff note)' }) });
    }
    return null;
  };
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  const [r] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '15:00'))]);
  assert.strictEqual(status(r), 'SUCCESS', r.result);
  const cur = env.cal.store(CAL).get('apptone1').cur;
  assert.strictEqual(cur.summary, 'Sara - x (staff note)', 'staff edit was overwritten');
  assert.strictEqual(cur.start.dateTime.slice(0, 16), DAY + 'T15:00');
});

test('R6 reschedule outside hours / into the past is rejected, appointment untouched', async () => {
  const env = makeEnv({ seed: 38 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  const rs = await runAll(env, [
    () => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', '2026-10-09', '07:30')),
    () => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '19:00')),
    () => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', '2026-10-01', '10:30')),
  ]);
  assert.deepStrictEqual(rs.map(status), ['OUTSIDE_HOURS', 'OUTSIDE_HOURS', 'PAST_TIME']);
  // The appointment keeps its length: a 120-minute colour cannot be moved to 17:30 (it would end 19:30).
  seedAppt(env, 'apptlong1', '213555000002', DAY, '11:00', 'Long - Colour', 120);
  const [late] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', rs_('213555000002', DAY, '11:00', DAY, '17:30'))]);
  assert.strictEqual(status(late), 'OUTSIDE_HOURS', late.result);
  const [fits] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', rs_('213555000002', DAY, '11:00', DAY, '17:00'))]);
  assert.strictEqual(status(fits), 'SUCCESS', fits.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
});

test('R7 another patient cannot reschedule or cancel someone else\'s appointment', async () => {
  const env = makeEnv({ seed: 39 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara Benali - x');
  const rs = await runAll(env, [
    () => H.callConfirmed(env, 'reschedule', rs_('213666000009', DAY, '10:00', DAY, '15:00')),
    () => H.callConfirmed(env, 'cancel', { appointment_date: DAY, appointment_time: '10:00', phone_number: '213666000009', patient_name: '', booked_phone_number: '' }),
    () => H.callConfirmed(env, 'cancel', { appointment_date: DAY, appointment_time: '10:00', phone_number: '213666000009', patient_name: 'Sara Benali', booked_phone_number: '' }),
  ]);
  assert.deepStrictEqual(rs.map(status), ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
  for (const r of rs) assert.ok(r.result.indexOf('Sara') < 0, 'no details of the other customer: ' + r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
});

test('R8 a different booking number or a bare name never gives access (staff only, nothing revealed)', async () => {
  const env = makeEnv({ seed: 40 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara Benali - x');
  const [byName] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', rs_('213777000000', DAY, '10:00', DAY, '15:00', { patient_name: 'Sara Benali' }))]);
  assert.strictEqual(status(byName), 'NOT_FOUND', byName.result);
  // Before 2026-11-25 this typed number moved Sara's appointment. Now it is refused before any calendar read.
  const [byPhone] = await runAll(env, [() => H.callConfirmed(env, 'reschedule', rs_('213777000000', DAY, '10:00', DAY, '15:00', { booked_phone_number: '0555000001' }))]);
  assert.strictEqual(status(byPhone), 'NEED_STAFF', byPhone.result);
  for (const r of [byName, byPhone]) assert.ok(r.result.indexOf('Sara') < 0 && !byPhone.proposal, 'nothing revealed or proposed: ' + r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
});

// ============================================================ CANCEL
const cn = (phone, date, time, extra) => Object.assign({ appointment_date: date, appointment_time: time, phone_number: phone, patient_name: '', booked_phone_number: '' }, extra);

test('C1 duplicate simultaneous cancels -> cancelled once, both report SUCCESS', async () => {
  const env = makeEnv({ seed: 41 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  const rs = await runAll(env, [at(env, 0, () => H.callConfirmed(env, 'cancel', cn('213555000001', DAY, '10:00'))), at(env, 3, () => H.callConfirmed(env, 'cancel', cn('213555000001', DAY, '10:00')))]);
  assert.strictEqual(count(rs, 'SUCCESS'), 2, rs.map((r) => r.result).join(' | '));
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled');
  assert.strictEqual(env.cal.log.filter((l) => l.method === 'DELETE').length, 1);
});

test('C2 cancel racing reschedule of the same appointment -> one consistent outcome', async () => {
  for (const seed of [42, 43, 44, 45]) {
    const env = makeEnv({ seed });
    seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
    const rs = await runAll(env, [
      at(env, 0, () => H.callConfirmed(env, 'cancel', cn('213555000001', DAY, '10:00'))),
      at(env, Math.floor(env.sim.rng() * 5), () => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '15:00'))),
    ]);
    const [c, r] = rs.map(status);
    // Exactly one wins; the other changed nothing (gone already, or its confirmation was replaced/invalidated).
    const refused = (x) => /^(NOT_FOUND|CONFIRMATION_INVALID)\b/.test(x);
    if (c === 'SUCCESS') { assert.ok(refused(r), rs[1].result); assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled'); }
    else { assert.strictEqual(r, 'SUCCESS', rs.map((x) => x.result).join(' | ')); assert.ok(refused(c), rs[0].result); assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T15:00'); }
  }
});

test('C3 DELETE response lost -> SUCCESS confirmed by re-read, not double-applied', async () => {
  let hit = 0;
  const env = makeEnv({ seed: 46, cal: { fault: (req) => (req.method === 'DELETE' && hit++ === 0 ? { kind: 'dropAfter' } : null) } });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  const [r] = await runAll(env, [() => H.callConfirmed(env, 'cancel', cn('213555000001', DAY, '10:00'))]);
  assert.strictEqual(status(r), 'SUCCESS', r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled');
});

test('C4 list lag after a reschedule: cancel by the OLD time finds nothing, by the NEW time works', async () => {
  const env = makeEnv({ seed: 47, cal: { listLagMs: 5000 } });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  await runAll(env, [() => H.callConfirmed(env, 'reschedule', rs_('213555000001', DAY, '10:00', DAY, '15:00'))]);
  const [old] = await runAll(env, [() => H.callConfirmed(env, 'cancel', cn('213555000001', DAY, '10:00'))]);
  assert.strictEqual(status(old), 'NOT_FOUND', old.result);
  const [nw] = await runAll(env, [() => H.callConfirmed(env, 'cancel', cn('213555000001', DAY, '15:00'))]);
  assert.strictEqual(status(nw), 'SUCCESS', nw.result);
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled');
});

test('C5 cancel then immediately rebook the freed slot (another patient) works', async () => {
  const env = makeEnv({ seed: 48 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara - x');
  await runAll(env, [() => H.callConfirmed(env, 'cancel', cn('213555000001', DAY, '10:00'))]);
  const [b] = await runAll(env, [() => callTool(env, 'book', bk('213555000002', '10:00', 'Amine - x'))]);
  assert.strictEqual(status(b), 'SUCCESS', b.result);
});

// ============================================================ READ-ONLY TOOLS
test('F1 Find: own appointments only; bare name and typed booking number refused, nothing revealed', async () => {
  const env = makeEnv({ seed: 49 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara Benali - x');
  seedAppt(env, 'appttwo2', '213555000002', DAY, '11:00', 'Amine Kaci - y');
  const rs = await runAll(env, [
    () => callTool(env, 'find', { phone_number: '213555000001', patient_name: '', appointment_date: '', booked_phone_number: '' }),
    () => callTool(env, 'find', { phone_number: '213999999999', patient_name: 'Amine Kaci', appointment_date: '', booked_phone_number: '' }),
    () => callTool(env, 'find', { phone_number: '213999999999', patient_name: '', appointment_date: '', booked_phone_number: '0555000002' }),
  ]);
  assert.ok(/^FOUND: 1\) Sara Benali/.test(rs[0].result) && rs[0].result.indexOf('Amine') < 0, rs[0].result);
  assert.ok(/^NOT_FOUND/.test(rs[1].result) && /Escalate_to_Staff/.test(rs[1].result) && rs[1].result.indexOf('Amine') < 0, rs[1].result);
  assert.ok(/^NEED_STAFF/.test(rs[2].result) && rs[2].result.indexOf('Amine') < 0 && rs[2].result.indexOf('11:00') < 0, 'a typed number never finds another customer: ' + rs[2].result);
});

test('F2 Check_Availability never leaks other customers\' names; knows past times, Sunday closing and service length', async () => {
  const env = makeEnv({ seed: 50 });
  seedAppt(env, 'apptone1', '213555000001', DAY, '10:00', 'Sara Benali - Keratin');
  const rs = await runAll(env, [
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'mens_cut' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '11:00', service_keys: 'mens_cut' }),
    () => callTool(env, 'check', { requested_date: '2026-10-05', requested_time: '08:30', service_keys: 'mens_cut' }),
    () => callTool(env, 'check', { requested_date: '2026-10-09', requested_time: '10:00', service_keys: 'mens_cut' }),
    () => callTool(env, 'check', { requested_date: '2026-10-01', requested_time: '' }),
    () => callTool(env, 'check', { requested_date: '2026-10-11', requested_time: '10:00', service_keys: 'mens_cut' }), // Sunday
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '09:00', service_keys: 'root_colour' }), // overlaps 10:00
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '16:30', service_keys: 'balayage' }), // ends 19:30
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '16:00', service_keys: 'balayage' }), // ends 19:00
  ]);
  assert.deepStrictEqual(rs.map(status), ['BUSY', 'HAS_EVENTS', 'FREE', 'OUTSIDE_HOURS', 'FREE', 'PAST_DATE', 'CLOSED_DAY', 'BUSY', 'OUTSIDE_HOURS', 'FREE']);
  for (const r of rs) assert.ok(r.result.indexOf('Sara') < 0 && r.result.indexOf('Keratin') < 0, 'privacy leak: ' + r.result);
  assert.ok(/latest start for these services is 16:00/.test(rs[8].result), rs[8].result);
  const [past] = await runAll(env, [() => callTool(env, 'check', { requested_date: '2026-10-05', requested_time: '09:30', service_keys: 'mens_cut' })]);
  env.sim.now; // start is 08:00 local, so 09:30 today is still in the future
  assert.strictEqual(status(past), 'FREE', past.result);
});

test('F3 Check_Availability agrees with Book_Appointment on every hour boundary and service length', async () => {
  const env = makeEnv({ seed: 51 });
  for (const [t, dur] of [['08:59', 30], ['09:00', 30], ['12:30', 30], ['18:30', 30], ['18:45', 30], ['19:00', 30], ['16:00', 180], ['16:30', 180], ['18:00', 60], ['18:15', 60]]) {
    const [c] = await runAll(env, [() => callTool(env, 'check', { requested_date: '2026-10-07', requested_time: t, service_keys: svcFor(dur) })]);
    const [b] = await runAll(env, [() => callTool(env, 'book', bk('2135551' + t.replace(':', '') + dur, t, 'H' + t + ' - x', { date: '2026-10-07', dur }))]);
    const cOk = status(c) === 'FREE', bOk = status(b) === 'SUCCESS';
    assert.strictEqual(cOk, bOk, t + '/' + dur + ': check=' + c.result + ' book=' + b.result);
    if (bOk) await runAll(env, [() => H.callConfirmed(env, 'cancel', { appointment_date: '2026-10-07', appointment_time: t, phone_number: '2135551' + t.replace(':', '') + dur, patient_name: '', booked_phone_number: '' })]);
  }
});

if (require.main === module) runTests('tools.concurrency').then((r) => process.exit(r.fail ? 1 : 0));
module.exports = { runTests };
