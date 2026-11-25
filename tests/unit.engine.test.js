'use strict';
const assert = require('assert');
const path = require('path');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { createEngine } = require(path.join(H.ROOT, 'engine', 'engine.js'));
const CFG = H.CFG;
const E = createEngine(CFG)._t;
const NOW = H.START; // Mon 2026-10-05 08:00 local

test('U1 local date-time parsing (Africa/Algiers, UTC+1, no DST)', () => {
  assert.strictEqual(E.parseDateTime('2026-10-06T10:00:00'), Date.parse('2026-10-06T09:00:00Z'));
  assert.strictEqual(E.parseDateTime('2026-10-06T10:00'), Date.parse('2026-10-06T09:00:00Z'));
  assert.strictEqual(E.parseDateTime('2026-10-06 9:30'), Date.parse('2026-10-06T08:30:00Z'));
  assert.strictEqual(E.parseDateTime('2026-10-06T10:00:00Z'), Date.parse('2026-10-06T10:00:00Z'));
  assert.strictEqual(E.parseDateTime('2026-10-06T10:00:00+02:00'), Date.parse('2026-10-06T08:00:00Z'));
  for (const bad of ['2026-02-30T10:00', '2026-10-06T24:00', '2026-10-06T10:60', '06/10/2026 10:00', '', null, undefined, 'tomorrow 10h']) assert.ok(Number.isNaN(E.parseDateTime(bad)), String(bad));
  // Europe's DST switch weekends do not move Algerian wall-clock times
  for (const d of ['2026-03-29', '2026-10-25']) assert.strictEqual(E.isoLocal(E.parseDateTime(d + 'T10:00')), d + 'T10:00:00+01:00');
});

test('U2 business rules identical to Check_Availability (salon hours Mon-Sat, closed Sunday, closing time, past)', () => {
  const r = (s) => { const x = E.slotRule(E.parseDateTime(s), NOW, 'booked'); return x ? x.status : 'OK'; };
  assert.strictEqual(r('2026-10-06T08:59'), 'OUTSIDE_HOURS');
  assert.strictEqual(r('2026-10-06T09:00'), 'OK');
  assert.strictEqual(r('2026-10-06T18:30'), 'OK');
  assert.strictEqual(r('2026-10-06T19:00'), 'OUTSIDE_HOURS');
  assert.strictEqual(r('2026-10-09T10:00'), 'OK'); // Friday is a working day
  assert.strictEqual(r('2026-10-10T10:00'), 'OK'); // Saturday is a working day
  assert.strictEqual(r('2026-10-11T10:00'), 'CLOSED_DAY'); // Sunday is the weekly closing day
  assert.strictEqual(r('2026-10-02T10:00'), 'PAST_TIME');
  assert.strictEqual(r('2026-10-01T10:00'), 'PAST_TIME');
  // The whole service must end by closing time (salon services have different lengths).
  const end = (s, min) => { const st = E.parseDateTime(s); const x = E.endRule(st, st + min * 60000, 'booked'); return x ? x.status : 'OK'; };
  assert.strictEqual(end('2026-10-06T16:00', 180), 'OK'); // balayage ends exactly at 19:00
  assert.strictEqual(end('2026-10-06T16:30', 180), 'OUTSIDE_HOURS');
  assert.strictEqual(end('2026-10-06T18:30', 30), 'OK');
  assert.strictEqual(end('2026-10-06T18:30', 45), 'OUTSIDE_HOURS');
  // The weekly-closing-day branch also works for another day, or open every day.
  const Ec = createEngine(Object.assign({}, CFG, { CLOSED_WEEKDAY: 5 }))._t;
  const rc = (s) => { const x = Ec.slotRule(Ec.parseDateTime(s), NOW, 'booked'); return x ? x.status : 'OK'; };
  assert.strictEqual(rc('2026-10-09T10:00'), 'CLOSED_DAY');
  assert.strictEqual(rc('2026-10-11T10:00'), 'OK');
  const Eo = createEngine(Object.assign({}, CFG, { CLOSED_WEEKDAY: -1 }))._t;
  assert.strictEqual(Eo.slotRule(Eo.parseDateTime('2026-10-11T10:00'), NOW, 'booked'), null);
});

test('U3 customer identity: the verified sender only; a typed booking number (any format) is never an identity (NEED_STAFF); bare name ignored', () => {
  assert.strictEqual(E.identity({ phone_number: '213555000001' }).phone, '213555000001');
  // Before 2026-11-25 these switched the identity to the typed number. Now every one is refused.
  for (const typed of ['0555 11 22 33', '+213 555-11-22-33', '00213555112233', '555112233', '123', '213555000001']) {
    for (const who of [{ phone_number: '213555000001' }, { customer_key: 'wa:213555000001', phone_number: '213555000001' }, { customer_key: 'ig:17841400000000001:5512345678901234' }, { customer_key: 'fb:102030405060708:5512345678901234' }]) {
      assert.strictEqual(E.identity(Object.assign({ booked_phone_number: typed }, who)).error.status, 'NEED_STAFF', JSON.stringify(who) + ' + ' + typed);
    }
  }
  const n = E.identity({ phone_number: '213555000001', patient_name: 'Sara Benali' });
  assert.strictEqual(n.via, 'chat'); assert.strictEqual(n.nameGiven, true);
  assert.ok(/^[0-9a-f]{16}$/.test(n.k), 'identity key must be a hash, not the number');
  assert.strictEqual(E.identity({ phone_number: '' }).error.status, 'NOT_FOUND');
});

test('U4 phone matching: structured field only, whole number (operator digit matters)', () => {
  const ev = (d, s) => ({ description: d, summary: s || '' });
  const me = E.identity({ phone_number: '213555112233' });
  assert.ok(E.phoneMatches(ev('Phone: 213555112233. Notes: x'), me));
  assert.ok(!E.phoneMatches(ev('Phone: 213655112233. Notes: x'), me), '0655.. is a different subscriber');
  assert.ok(!E.phoneMatches(ev('Phone: 213600111222. Notes: alt 213555112233'), me));
  assert.ok(E.phoneMatches(ev('walk-in, tel 0555112233'), me)); // manual event fallback
  assert.ok(!E.phoneMatches(ev('walk-in, tel 0655112233'), me));
  assert.ok(!E.phoneMatches(ev('Phone: 213555112233.'), { phone: '', tail: '' }));
});

test('U5 journal views: busy view is conservative, match view applies the bot\'s own recent writes', () => {
  const ev = (id, s) => ({ id, status: 'confirmed', start: { dateTime: s }, end: { dateTime: new Date(Date.parse(s) + 1800000).toISOString() } });
  const list = [ev('a', '2026-10-06T09:00:00Z'), ev('b', '2026-10-06T10:00:00Z')];
  const j = [
    { o: 'u', i: 'a', s: Date.parse('2026-10-06T13:00:00Z'), e: Date.parse('2026-10-06T13:30:00Z'), at: 1 },
    { o: 'd', i: 'b', s: Date.parse('2026-10-06T10:00:00Z'), e: Date.parse('2026-10-06T10:30:00Z'), at: 2 },
    { o: 'c', i: 'c', s: Date.parse('2026-10-06T14:00:00Z'), e: Date.parse('2026-10-06T14:30:00Z'), at: 3 },
  ];
  const busy = E.busyView(list, j).map((x) => x.id + '@' + new Date(x.s).toISOString().slice(11, 16)).sort();
  assert.deepStrictEqual(busy, ['a@09:00', 'a@13:00', 'b@10:00', 'c@14:00']);
  // 'b' was deleted by the bot (excluded); 'c' is known only from the journal
  // (list lag) and is still matchable by identity key.
  const match = E.matchView(list, j).map((x) => x.id + '@' + new Date(x.s).toISOString().slice(11, 16) + (x.ev ? '' : '(journal)'));
  assert.deepStrictEqual(match, ['a@13:00', 'c@14:00(journal)']);
});

test('U6 engine refuses to continue after done and on unknown phases', () => {
  const eng = createEngine(CFG);
  const s = eng.init('book', { start_datetime: '2026-10-09T23:00', service_keys: 'mens_cut', summary: 'x', phone_number: '213555000001' }, NOW, '1', Math.random);
  const out = eng.step(s, null, NOW, Math.random);
  assert.strictEqual(out.action.type, 'done');
  assert.throws(() => eng.step(out.state, null, NOW, Math.random), /after done/);
  assert.throws(() => eng.init('drop_tables', {}, NOW, '1', Math.random), /unknown op/);
});

test('U7 corrupted lock-object state is treated as free and self-heals', async () => {
  const env = H.makeEnv({ seed: 201 });
  env.cal.seed(CFG.LOCK_CALENDAR_ID, { id: CFG.CAL_LOCK_ID, summary: 'lock', description: '{{{ not json', start: { dateTime: '2000-01-01T00:00:00Z' }, end: { dateTime: '2000-01-01T00:01:00Z' } });
  const [r] = await H.runAll(env, [() => H.callTool(env, 'book', { start_datetime: '2026-10-06T10:00:00', service_keys: 'mens_cut', summary: 'A - x', notes: '', phone_number: '213555000001' })]);
  assert.ok(/^SUCCESS/.test(r.result), r.result);
  assert.strictEqual(env.cal.lockState(CFG.LOCK_CALENDAR_ID, CFG.CAL_LOCK_ID).v, 1);
});

test('U8 lock event deleted by a human is resurrected via CAS, not bypassed', async () => {
  const env = H.makeEnv({ seed: 202 });
  env.cal.seed(CFG.LOCK_CALENDAR_ID, { id: CFG.CAL_LOCK_ID, status: 'cancelled', summary: 'lock', description: '{"v":1}', start: { dateTime: '2000-01-01T00:00:00Z' }, end: { dateTime: '2000-01-01T00:01:00Z' } });
  const [r] = await H.runAll(env, [() => H.callTool(env, 'book', { start_datetime: '2026-10-06T10:00:00', service_keys: 'mens_cut', summary: 'A - x', notes: '', phone_number: '213555000001' })]);
  assert.ok(/^SUCCESS/.test(r.result), r.result);
  assert.strictEqual(env.cal.store(CFG.LOCK_CALENDAR_ID).get(CFG.CAL_LOCK_ID).cur.status, 'confirmed');
});

test('U9 oversized lock state is capped, never exceeding the size budget', async () => {
  const env = H.makeEnv({ seed: 203 });
  const j = Array.from({ length: 500 }, (_, i) => ({ o: 'c', i: 'x' + i, s: 1, e: 2, k: 'p:1', sh: 'aa', at: H.START - 1000 + i }));
  env.cal.seed(CFG.LOCK_CALENDAR_ID, { id: CFG.CAL_LOCK_ID, summary: 'lock', description: JSON.stringify({ v: 1, j }), start: { dateTime: '2000-01-01T00:00:00Z' }, end: { dateTime: '2000-01-01T00:01:00Z' } });
  const [r] = await H.runAll(env, [() => H.callTool(env, 'book', { start_datetime: '2026-10-06T10:00:00', service_keys: 'mens_cut', summary: 'A - x', notes: '', phone_number: '213555000001' })]);
  assert.ok(/^SUCCESS/.test(r.result), r.result);
  const desc = env.cal.store(CFG.LOCK_CALENDAR_ID).get(CFG.CAL_LOCK_ID).cur.description;
  assert.ok(desc.length <= CFG.LOCK_STATE_MAX_CHARS, 'lock state ' + desc.length + ' chars');
});

// ---------------------------------------------------------------- channel-aware customer keys
const IGK = 'ig:17841400000000001:5512345678901234', FBK = 'fb:102030405060708:5512345678901234';
const ev = (description) => ({ description });

test('U10 customer keys: parsing, fail-closed validation, and the wa: key is byte-compatible with the legacy digits identity', () => {
  assert.deepStrictEqual(E.customerOf('wa:213555123456'), { ch: 'wa', key: 'wa:213555123456', phone: '213555123456', seed: '213555123456' });
  assert.deepStrictEqual(E.customerOf(IGK), { ch: 'ig', key: IGK, acct: '17841400000000001', sid: '5512345678901234', phone: '', seed: IGK });
  assert.strictEqual(E.customerOf(FBK).ch, 'fb');
  assert.strictEqual(E.customerOf('213555123456').ch, 'legacy');
  for (const bad of ['ig:1:2', 'ig:17841400000000001', 'ig:abc:5512345678901234', 'xx:12345:12345', 'IG:12345:12345', 'ig:12345:12345:9', 'fb:12345:', 'wa:12', 'wa:abc', ' :1', '']) {
    assert.strictEqual(E.customerOf(bad), null, 'must be refused: ' + JSON.stringify(bad));
  }
  // Migration: a WhatsApp customer keeps the SAME lock object and identity hash (in-flight state survives).
  assert.strictEqual(E.chatLockId('wa:213555123456'), E.chatLockId('213555123456'));
  // ...also for very short international numbers (e.g. +290 / +683, 7-8 digits): same lock as before, same tool identity outcome.
  for (const short of ['2901234', '68312345']) {
    assert.ok(E.chatLockId('wa:' + short) && E.chatLockId('wa:' + short) === E.chatLockId(short), short);
    assert.deepStrictEqual(E.identity({ customer_key: 'wa:' + short, phone_number: short }), E.identity({ phone_number: short }), short);
  }
  assert.deepStrictEqual(E.identity({ customer_key: 'wa:213555123456', phone_number: '213555123456' }), E.identity({ phone_number: '213555123456' }));
  assert.deepStrictEqual(E.identity({ customer_key: 'wa:213555123456', phone_number: '213555123456', patient_name: 'Sara B' }),
    E.identity({ phone_number: '213555123456', patient_name: 'Sara B' }));
  // Keys of different channels / accounts never share a lock object, even with identical digits.
  const locks = [IGK, FBK, 'ig:17841499999999999:5512345678901234', '5512345678901234', 'wa:213555123456'].map(E.chatLockId);
  assert.strictEqual(new Set(locks).size, locks.length);
  // A present but invalid key never falls back to the phone number.
  for (const c of [{ customer_key: 'ig:1:2', phone_number: '213555123456' }, { customer_key: '213555123456' }, { customer_key: 'wa:213555123456', phone_number: '213555999999' }]) {
    assert.strictEqual(E.identity(c).error.status, 'ERROR', JSON.stringify(c));
  }
  assert.strictEqual(E.chatLockId('ig:1:2'), null);
});

test('U11 appointment ownership: "Customer: <key>" belongs to that key only; legacy "Phone:" events keep WhatsApp ownership; notes can never claim an owner', () => {
  const ig = E.identity({ customer_key: IGK }), fb = E.identity({ customer_key: FBK }), wa = E.identity({ customer_key: 'wa:213555123456', phone_number: '213555123456' });
  const igOther = E.identity({ customer_key: 'ig:17841499999999999:5512345678901234' });
  const igEvent = ev('Customer: ' + IGK + '. Notes: Instagram - Tel: +213555123456 | Phone: 213555123456 | Lina');
  assert.deepStrictEqual([E.phoneMatches(igEvent, ig), E.phoneMatches(igEvent, fb), E.phoneMatches(igEvent, igOther), E.phoneMatches(igEvent, wa)], [true, false, false, false]);
  // A typed booking number never yields an identity at all (NEED_STAFF), so it can never match anything.
  assert.strictEqual(E.identity({ customer_key: FBK, booked_phone_number: '+213555123456' }).error.status, 'NEED_STAFF');
  // Legacy WhatsApp events (written before keys existed) are still owned by that WhatsApp number - and only it.
  const legacy = ev('Phone: 213555123456. Notes: Sara');
  assert.deepStrictEqual([E.phoneMatches(legacy, wa), E.phoneMatches(legacy, E.identity({ phone_number: '213555123456' })), E.phoneMatches(legacy, ig), E.phoneMatches(legacy, fb)], [true, true, false, false]);
  // A staff-made event (no structured field) still matches by the national number, for phone identities only.
  const staff = ev('call 0555 12 34 56 - Sara');
  assert.deepStrictEqual([E.phoneMatches(staff, wa), E.phoneMatches(staff, ig)], [true, false]);
  // Pre-key Messenger events ("Phone: <PSID>. Notes: Messenger - ...") are owned by no key and no WhatsApp number: staff handle them.
  const oldFb = ev('Phone: 5512345678901234. Notes: Messenger - Tel: +34600000000 | Lucia');
  assert.deepStrictEqual([E.phoneMatches(oldFb, fb), E.phoneMatches(oldFb, ig), E.phoneMatches(oldFb, wa)], [false, false, false]);
  assert.ok(E.identity({ customer_key: 'wa:5512345678901234' }).error, 'a 16-digit id is never a WhatsApp number (E.164 max 15)');
  // The owner field must be at the very start: text in the notes never counts.
  for (const d of ['Phone: 213555123456. Notes: Customer: ' + IGK, 'Notes: Customer: ' + IGK, ' x Customer: ' + IGK + '.']) assert.strictEqual(E.ownerKeyOf(ev(d)), '', d);
  assert.strictEqual(E.phoneMatches(ev('Phone: 213555123456. Notes: Customer: ' + IGK), ig), false);
});

test('U12 Book writes the owner field per channel: WhatsApp unchanged ("Phone:"), Messenger / Instagram "Customer: <key>", no phone needed', async () => {
  const env = H.makeEnv({ seed: 77 });
  const slot = (t, extra) => Object.assign({ start_datetime: '2026-10-06T' + t + ':00', service_keys: 'mens_cut', summary: 'Lina - Haircut', notes: 'Lina' }, extra);
  const r = await H.runAll(env, [async () => [
    await H.callTool(env, 'book', slot('10:00', { phone_number: '213555123456', customer_key: 'wa:213555123456' })),
    await H.callTool(env, 'book', slot('11:00', { phone_number: '', customer_key: IGK })),
    await H.callTool(env, 'book', slot('12:00', { phone_number: '213555123456', customer_key: 'ig:1:2' })),
    await H.callTool(env, 'book', slot('13:00', { phone_number: '213555123456' })),
  ]]);
  const [wa, ig, bad, legacy] = r[0];
  assert.ok(/^SUCCESS/.test(wa.result) && /^SUCCESS/.test(ig.result) && /^SUCCESS/.test(legacy.result), wa.result + ' / ' + ig.result + ' / ' + legacy.result);
  assert.ok(/^ERROR/.test(bad.result), 'invalid key fails closed: ' + bad.result);
  const d = env.cal.events(CFG.CALENDAR_ID).map((x) => x.description).sort();
  // Owner field first (unchanged), then the service line written by the engine from the catalogue.
  const SV = '. Service: Men\'s haircut | Keys: mens_cut | Duration: 30 min. Notes: Lina';
  assert.deepStrictEqual(d, ['Customer: ' + IGK + SV, 'Phone: 213555123456' + SV, 'Phone: 213555123456' + SV]);
});

// ---------------------------------------------------------------- 2026-11-25: atomic counters, completed-action record
// Drives the real engine against the fake Google Calendar, like the Engine nodes do in n8n.
async function drive(env, op, ctx, execId) {
  const eng = createEngine(CFG);
  const rnd = () => env.sim.rand(0, 1);
  let s = eng.init(op, ctx, env.sim.now, execId, rnd), resp = null;
  for (let i = 0; i < 5000; i++) {
    const { state, action } = eng.step(s, resp, env.sim.now, rnd); s = state; resp = null;
    if (action.type === 'done') return action.result;
    if (action.type === 'http') resp = await env.cal.request(action.req);
    else if (action.type === 'sleep') await env.sim.sleep(action.ms);
  }
  throw new Error('engine did not finish');
}
const RLK = (n, extra) => Object.assign({ id: 'lumtestrls' + n, kind: 'k', max: 5, win: 3600000 }, extra);
const RLG = (h, d) => ({ id: 'lumtestrlg01', kind: 'g', maxH: h, maxD: d });

test('U13 rateHit: 12 independent simultaneous runs on one counter (limit 5) -> exactly 5 ALLOWED, all 12 increments kept', async () => {
  const env = H.makeEnv({ seed: 911 });
  const rs = await H.runAll(env, Array.from({ length: 12 }, (_, i) => () => drive(env, 'rateHit', { counters: [RLK('a'), RLG(100, 1000)] }, 'x' + i)));
  assert.deepStrictEqual([rs.filter((r) => r.status === 'ALLOWED').length, rs.filter((r) => r.status === 'LIMITED').length], [5, 7]);
  assert.strictEqual(env.cal.lockState(CFG.LOCK_CALENDAR_ID, 'lumtestrlsa').c.n, 12, 'no lost increment');
  assert.strictEqual(env.cal.lockState(CFG.LOCK_CALENDAR_ID, 'lumtestrlg01').h.n, 5, 'only allowed requests used the overall budget');
  assert.ok(env.cal.log.some((x) => x.method === 'PUT' && x.status === 412), 'conditional writes collided and were retried');
  assert.deepStrictEqual(env.cal.violations, []);
});

test('U14 rateHit: overall hour/day caps at the boundary, window reset, bad input and store failure fail closed', async () => {
  const env = H.makeEnv({ seed: 912 });
  const g = await H.runAll(env, Array.from({ length: 7 }, (_, i) => () => drive(env, 'rateHit', { counters: [RLK('u' + i), RLG(4, 6)] }, 'g' + i)));
  assert.deepStrictEqual([g.filter((r) => r.status === 'ALLOWED').length, g.filter((r) => r.status === 'BUSY').length], [4, 3], 'hour cap 4');
  env.sim.now += 3600001;
  const g2 = await H.runAll(env, Array.from({ length: 4 }, (_, i) => () => drive(env, 'rateHit', { counters: [RLK('v' + i), RLG(4, 6)] }, 'h' + i)));
  assert.strictEqual(g2.filter((r) => r.status === 'ALLOWED').length, 2, 'new hour, but the day cap 6 leaves 2');
  for (const bad of [[], [{ id: 'BAD ID', kind: 'k', max: 1, win: 1 }], [RLG(1, 1), RLK('z')], [RLK('y', { max: 0 })]]) {
    const [r] = await H.runAll(env, [() => drive(env, 'rateHit', { counters: bad }, 'bad')]);
    assert.strictEqual(r.status, 'ERROR', JSON.stringify(bad));
  }
  const f = H.makeEnv({ seed: 913, cal: { fault: (req) => (/lumtestrl/.test(req.url || '') ? { kind: '503' } : null) } });
  const [e] = await H.runAll(f, [() => drive(f, 'rateHit', { counters: [RLK('q'), RLG(9, 9)] }, 'f')]);
  assert.strictEqual(e.status, 'ERROR', 'store failure -> ERROR (the caller refuses the request)');
});

test('U15 completed-action record: written only by the lock holder, only for a SUCCESS record, read back on the next acquire', async () => {
  const env = H.makeEnv({ seed: 914 });
  const chat = 'ig:17841400000000001:5512345678901234', lockId = E.chatLockId(chat);
  const la = { id: 'cfabc', act: 'cancel', ev: 'ev1', os: Date.parse('2026-10-06T09:00:00Z'), ns: null, sum: 'Lina - Manicure', svc: 'Manicure', res: 'SUCCESS' };
  const turn = async (msgId, extra) => {
    const [a] = await H.runAll(env, [() => drive(env, 'chatAcquire', { chatId: chat, msgId, msgTs: env.sim.now, token: 't' + msgId }, msgId)]);
    await H.runAll(env, [() => drive(env, 'chatRelease', Object.assign({ chatId: chat, msgId, msgTs: env.sim.now, token: 't' + msgId, wasHolder: true }, extra), msgId)]);
    return a;
  };
  await turn('m1', { la: Object.assign({}, la, { res: 'FAILED' }) });
  assert.ok(!env.cal.lockState(CFG.LOCK_CALENDAR_ID, lockId).la, 'a failed result is never recorded');
  await turn('m2', { wasHolder: false, la });
  assert.ok(!env.cal.lockState(CFG.LOCK_CALENDAR_ID, lockId).la, 'only the lock holder records it');
  await turn('m3', { la: Object.assign({ evil: 'x' }, la) });
  const st = env.cal.lockState(CFG.LOCK_CALENDAR_ID, lockId).la;
  assert.deepStrictEqual(Object.keys(st).sort(), ['act', 'at', 'ev', 'id', 'ns', 'os', 'res', 'sum', 'svc'], 'only the known fields are stored');
  assert.ok(Number.isFinite(st.at) && st.at <= env.sim.now && st.at > env.sim.now - 600000, 'stamped with the server time of the release');
  const next = await turn('m4', {});
  assert.deepStrictEqual(Object.assign({}, next.lastAction, { at: 0 }), Object.assign({}, st, { at: 0 }), 'the next acquire returns the record');
  // Another customer's lock object never holds it.
  assert.strictEqual(env.cal.lockState(CFG.LOCK_CALENDAR_ID, E.chatLockId('ig:17841499999999999:5512345678901234')), null);
});

if (require.main === module) runTests('unit.engine').then((r) => process.exit(r.fail ? 1 : 0));
