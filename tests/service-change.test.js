'use strict';
// C2 - safe service changes. Reschedule_Appointment can change the services of an existing
// appointment (new_service_keys). The backend recalculates the length from the catalogue,
// checks the WHOLE new window, records the exact change for the customer's confirmation, and
// applies it as ONE conditional update of the same calendar event - never a cancellation
// followed by an independent booking. Declines, failures, duplicates and stale confirmations
// leave the original appointment exactly as it was.
const assert = require('assert');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { CFG, makeEnv, callTool, runAll, deliver, waMessage, CONF } = H;

const CAL = CFG.CALENDAR_ID;
const CHAT_LOCK = require(require('path').join(H.ROOT, 'engine', 'engine.js')).createEngine(CFG)._t.chatLockId;
const DAY = '2026-10-06'; // Tuesday (START is Monday 2026-10-05 08:00)
const A = '213555000001', B = '213555000002';
const one = async (env, f) => (await runAll(env, [f]))[0];
const status = (r) => String(r.result || '').split(':')[0].split(' (')[0];
const reasonOf = (r) => (/^CONFIRMATION_INVALID \(([a-z_]+)\)/.exec(String(r.result)) || [])[1] || String(r.result);
const ms = (d, t) => Date.parse(d + 'T' + t + ':00+01:00');
const appts = (env) => env.cal.events(CAL).filter((e) => e.status !== 'cancelled' && !/^lumierelock/.test(e.id));
const span = (e) => e.start.dateTime.slice(0, 16) + '-' + e.end.dateTime.slice(11, 16);
const snap = (env, id) => JSON.stringify((({ summary, description, start, end, status: st }) => ({ summary, description, start, end, st }))(env.cal.store(CAL).get(id).cur));
// Every calendar write on appointments (lock objects excluded).
// Updates / deletions of appointment events (lock objects excluded; a new booking would show in appts()).
const apptWrites = (env) => env.cal.log.filter((l) => (l.method === 'PUT' || l.method === 'DELETE' || l.method === 'PATCH') && !/lumierelock/.test(l.url) && /\/events\//.test(l.url));
const bookArgs = (phone, time, keys, name) => ({ start_datetime: DAY + 'T' + time + ':00', service_keys: keys, summary: (name || 'Lucía Fernández') + ' - Blow-dry', notes: (name || 'Lucía Fernández') + ' | first visit', phone_number: phone });
async function booked(env, phone, time, keys, name) {
  const r = await one(env, () => callTool(env, 'book', bookArgs(phone, time, keys, name)));
  assert.ok(/^SUCCESS/.test(r.result), r.result);
  return appts(env).find((e) => e.start.dateTime.slice(11, 16) === time && e.description.indexOf('Phone: ' + phone) === 0).id;
}
const rs = (phone, ot, nd, nt, keys, extra) => Object.assign({ old_appointment_date: DAY, old_appointment_time: ot, new_appointment_date: nd, new_appointment_time: nt, new_summary: '', new_description: '', new_service_keys: keys, phone_number: phone, patient_name: '', booked_phone_number: '', chat_msg_id: 'msg-propose' }, extra);
async function propose(env, inputs) {
  const p = await one(env, () => callTool(env, 'reschedule', inputs));
  assert.ok(/^CONFIRMATION_REQUIRED/.test(p.result), p.result);
  return CONF.unmark(p.result);
}
const execute = (env, inputs, m, extra) => one(env, () => callTool(env, 'reschedule', Object.assign({}, inputs, { confirm_id: m.id, confirm_message: 'yes', confirm_msg_id: 'msg-yes-' + Math.random(), confirm_via: 'text', confirm_event_id: m.ev, confirm_new_start: String(m.ns) }, extra)));

// ================================================================= tool level
test('CH1 service change at the same time: proposed with the backend length, applied as ONE update of the same event', async () => {
  const env = makeEnv({ seed: 701 });
  const id = await booked(env, A, '10:00', 'blow_dry');
  const before = snap(env, id);
  const w0 = apptWrites(env).length;
  const m = await propose(env, rs(A, '10:00', DAY, '10:00', 'balayage,womens_cut,blow_dry', { end_datetime: DAY + 'T10:30:00', duration_minutes: '30' }));
  assert.strictEqual(snap(env, id), before, 'the proposal changes nothing');
  assert.strictEqual(apptWrites(env).length, w0, 'no calendar write before the yes');
  assert.strictEqual(m.ev, id);
  assert.strictEqual(m.nm, 240, 'balayage + women\'s cut (blow-dry included) = 240 minutes, computed by the backend');
  assert.strictEqual(m.ne, ms(DAY, '14:00'));
  assert.deepStrictEqual(Object.keys(m.nl), ['en', 'fr', 'es', 'ar']);
  assert.strictEqual(m.nl.fr, 'Balayage + Coupe femme & coiffage');
  assert.strictEqual(m.ol.en, 'Blow-dry & styling', 'the current services are read back too');
  const r = await execute(env, rs(A, '10:00', DAY, '10:00', ''), m);
  assert.ok(/^SUCCESS: Rescheduled appointment .*; services changed to Balayage \+ Women's haircut & styling \(240 minutes, 10:00-14:00\)/.test(r.result), r.result);
  const ev = env.cal.store(CAL).get(id).cur;
  assert.strictEqual(span(ev), DAY + 'T10:00-14:00');
  assert.strictEqual(ev.description, "Phone: " + A + ". Service: Balayage + Women's haircut & styling | Keys: balayage,womens_cut,blow_dry | Duration: 240 min. Notes: Lucía Fernández | first visit", 'owner first, new service line, notes kept');
  assert.strictEqual(appts(env).length, 1, 'still ONE appointment');
  const writes = apptWrites(env).slice(w0);
  assert.deepStrictEqual(writes.map((w) => w.method), ['PUT'], 'one update, no DELETE, no new booking: ' + JSON.stringify(writes.map((w) => w.method + ' ' + w.url.split('/events')[1])));
  assert.ok(writes[0].url.endsWith('/events/' + id), 'the same calendar event');
  assert.deepStrictEqual(env.cal.violations, []);
});

test('CH2 service change with a new time: the WHOLE new length must be free and end by closing time', async () => {
  const env = makeEnv({ seed: 702 });
  const id = await booked(env, A, '10:00', 'blow_dry');
  await booked(env, B, '15:00', 'mens_cut', 'Other Person'); // 15:00-15:30, another customer
  const before = snap(env, id);
  const conflict = await one(env, () => callTool(env, 'reschedule', rs(A, '10:00', DAY, '12:00', 'balayage,womens_cut'))); // 12:00-16:00 overlaps 15:00
  assert.strictEqual(status(conflict), 'CONFLICT', conflict.result);
  assert.ok(/for the whole new length of 240 minutes \(12:00-16:00\)/.test(conflict.result) && /current appointment stays exactly as it is/.test(conflict.result), conflict.result);
  assert.ok(conflict.result.indexOf('Other Person') < 0, 'privacy');
  const late = await one(env, () => callTool(env, 'reschedule', rs(A, '10:00', '2026-10-07', '15:30', 'balayage,womens_cut'))); // ends 19:30
  assert.strictEqual(status(late), 'OUTSIDE_HOURS', late.result);
  // The appointment's own current slot never blocks its extension.
  const ok = await one(env, () => callTool(env, 'reschedule', rs(A, '10:00', DAY, '10:00', 'keratin')));
  assert.strictEqual(status(ok), 'CONFIRMATION_REQUIRED', ok.result);
  assert.strictEqual(snap(env, id), before, 'nothing changed by refused or pending requests');
});

test('CH3 unknown, ambiguous, missing-but-invalid and too-long new services are refused before any proposal', async () => {
  const env = makeEnv({ seed: 703 });
  const id = await booked(env, A, '10:00', 'blow_dry');
  const before = snap(env, id);
  const rsx = await runAll(env, [['massage', 'SERVICE_UNKNOWN'], ['colour', 'SERVICE_AMBIGUOUS'], ['keratin,full_colour', 'TOO_LONG'], ['corte', 'SERVICE_AMBIGUOUS']].map(([k]) => () => callTool(env, 'reschedule', rs(A, '10:00', DAY, '11:00', k))));
  assert.deepStrictEqual(rsx.map(status), ['SERVICE_UNKNOWN', 'SERVICE_AMBIGUOUS', 'TOO_LONG', 'SERVICE_AMBIGUOUS']);
  for (const r of rsx) assert.ok(/othing was checked or changed/.test(r.result) && !/othing was checked or booked/.test(r.result), r.result);
  const lk = env.cal.lockState(CFG.LOCK_CALENDAR_ID, CHAT_LOCK(A));
  assert.ok(!lk || !lk.pc, 'no pending confirmation was recorded');
  assert.strictEqual(snap(env, id), before);
  // Without new_service_keys the appointment keeps its services and length (unchanged behaviour).
  const m = await propose(env, rs(A, '10:00', DAY, '16:00', ''));
  assert.ok(!m.nl && m.ne === ms(DAY, '16:30'), 'a plain move keeps 30 minutes: ' + JSON.stringify(m));
  // The same services as booked are a plain move as well.
  const same = await propose(env, rs(A, '10:00', DAY, '16:00', 'brushing'));
  assert.ok(!same.nl && same.ne === ms(DAY, '16:30'), JSON.stringify(same));
});

test('CH4 the new window is taken between the proposal and the yes: refused at execution, the original is kept', async () => {
  const env = makeEnv({ seed: 704 });
  const id = await booked(env, A, '10:00', 'blow_dry');
  const before = snap(env, id);
  const m = await propose(env, rs(A, '10:00', DAY, '10:00', 'balayage'));
  await booked(env, B, '12:00', 'mens_cut', 'Late Booker'); // inside the new 10:00-13:00 window, not the old 10:00-10:30
  const r = await execute(env, rs(A, '10:00', DAY, '10:00', ''), m);
  assert.strictEqual(reasonOf(r), 'conflict', r.result);
  assert.strictEqual(snap(env, id), before, 'original appointment untouched');
  const again = await execute(env, rs(A, '10:00', DAY, '10:00', ''), m);
  assert.ok(['used', 'missing'].indexOf(reasonOf(again)) >= 0, 'the used confirmation can never run again: ' + again.result);
  assert.strictEqual(snap(env, id), before);
});

test('CH5 duplicate confirmations: two simultaneous yes -> exactly one change, applied once', async () => {
  for (const seed of [705, 706, 707]) {
    const env = makeEnv({ seed });
    const id = await booked(env, A, '10:00', 'blow_dry');
    const m = await propose(env, rs(A, '10:00', DAY, '10:00', 'balayage,womens_cut'));
    const w0 = apptWrites(env).length;
    const ex = (n) => () => callTool(env, 'reschedule', Object.assign(rs(A, '10:00', DAY, '10:00', ''), { confirm_id: m.id, confirm_message: 'yes', confirm_msg_id: 'msg-yes-' + n, confirm_via: 'text', confirm_event_id: m.ev, confirm_new_start: String(m.ns) }));
    const rsx = await runAll(env, [ex(1), ex(2)]);
    assert.deepStrictEqual(rsx.map(status).sort(), ['CONFIRMATION_INVALID', 'SUCCESS'], 'seed ' + seed + ': ' + rsx.map((r) => r.result).join(' | '));
    assert.strictEqual(apptWrites(env).slice(w0).filter((w) => w.method === 'PUT').length, 1, 'one update');
    assert.strictEqual(span(env.cal.store(CAL).get(id).cur), DAY + 'T10:00-14:00');
    assert.strictEqual(appts(env).length, 1);
  }
});

test('CH6 stale confirmations: a staff edit after the proposal, or a newer proposal, invalidates the old yes', async () => {
  const env = makeEnv({ seed: 708 });
  const id = await booked(env, A, '10:00', 'blow_dry');
  const m = await propose(env, rs(A, '10:00', DAY, '10:00', 'balayage'));
  const cur = env.cal.store(CAL).get(id).cur;
  env.cal.apply({ method: 'PUT', url: 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(CAL) + '/events/' + id, headers: {}, body: Object.assign({}, cur, { description: cur.description + ' (staff: allergy noted)' }) });
  const edited = snap(env, id);
  const r = await execute(env, rs(A, '10:00', DAY, '10:00', ''), m);
  assert.strictEqual(reasonOf(r), 'appointment_changed', r.result);
  assert.strictEqual(snap(env, id), edited, 'the staff edit is kept, nothing else changed');
  // A newer proposal replaces the older one: the older id can no longer be confirmed.
  const m1 = await propose(env, rs(A, '10:00', DAY, '10:00', 'balayage'));
  const m2 = await propose(env, rs(A, '10:00', DAY, '10:00', 'keratin'));
  assert.notStrictEqual(m1.id, m2.id);
  const old = await execute(env, rs(A, '10:00', DAY, '10:00', ''), m1);
  assert.strictEqual(reasonOf(old), 'mismatch', old.result);
  assert.strictEqual(snap(env, id), edited);
  // The identical request asked twice keeps one record (same id).
  const m3 = await propose(env, rs(A, '10:00', DAY, '10:00', 'keratin'));
  assert.strictEqual(m3.id, m2.id);
});

test('CH7 the calendar update fails: no success, the original appointment is preserved', async () => {
  const env = makeEnv({ seed: 709 });
  const id = await booked(env, A, '10:00', 'blow_dry');
  const before = snap(env, id);
  const m = await propose(env, rs(A, '10:00', DAY, '11:00', 'balayage,womens_cut'));
  env.cal.opts.fault = (req) => (req.method === 'PUT' && req.url.endsWith('/events/' + id) ? { kind: '500' } : null);
  const r = await execute(env, rs(A, '10:00', DAY, '11:00', ''), m);
  assert.ok(!/^SUCCESS/.test(r.result), r.result);
  assert.strictEqual(snap(env, id), before, 'original kept');
  env.cal.opts.fault = null;
  // A write that landed although its response was lost is recognised (not applied twice, not reported as failed).
  const env2 = makeEnv({ seed: 710 });
  const id2 = await booked(env2, A, '10:00', 'blow_dry');
  const m2 = await propose(env2, rs(A, '10:00', DAY, '10:00', 'womens_cut'));
  let n = 0;
  env2.cal.opts.fault = (req) => (req.method === 'PUT' && req.url.endsWith('/events/' + id2) && n++ === 0 ? { kind: 'dropAfter' } : null);
  const r2 = await execute(env2, rs(A, '10:00', DAY, '10:00', ''), m2);
  assert.strictEqual(status(r2), 'SUCCESS', r2.result);
  assert.strictEqual(span(env2.cal.store(CAL).get(id2).cur), DAY + 'T10:00-11:00');
  // Same times, other content (e.g. a facial instead of a women's cut, both 60 min): a lost response is
  // never mistaken for "not applied" or "applied" on the times alone.
  const env3 = makeEnv({ seed: 711 });
  const id3 = await booked(env3, A, '10:00', 'womens_cut');
  const m3 = await propose(env3, rs(A, '10:00', DAY, '10:00', 'facial'));
  let k = 0;
  env3.cal.opts.fault = (req) => (req.method === 'PUT' && req.url.endsWith('/events/' + id3) && k++ === 0 ? { kind: 'dropAfter' } : null);
  const r3 = await execute(env3, rs(A, '10:00', DAY, '10:00', ''), m3);
  assert.strictEqual(status(r3), 'SUCCESS', r3.result);
  assert.ok(/\| Keys: facial \| Duration: 60 min\./.test(env3.cal.store(CAL).get(id3).cur.description));
  // ...and a PUT refused every time leaves the same-times appointment exactly as it was.
  const env4 = makeEnv({ seed: 712 });
  const id4 = await booked(env4, A, '10:00', 'womens_cut');
  const before4 = snap(env4, id4);
  const m4 = await propose(env4, rs(A, '10:00', DAY, '10:00', 'facial'));
  env4.cal.opts.fault = (req) => (req.method === 'PUT' && req.url.endsWith('/events/' + id4) ? { kind: '500' } : null);
  const r4 = await execute(env4, rs(A, '10:00', DAY, '10:00', ''), m4);
  assert.ok(!/^SUCCESS/.test(r4.result), r4.result);
  assert.strictEqual(snap(env4, id4), before4);
});

test('CH11 Check_Availability leaves out ONLY the caller\'s own appointment that is being changed', async () => {
  const env = makeEnv({ seed: 713 });
  await booked(env, A, '10:00', 'blow_dry'); // A's own 10:00-10:30
  await booked(env, B, '14:00', 'mens_cut', 'Other Person'); // B's 14:00-14:30
  const chk = (phone, t, keys, ex, key) => one(env, () => callTool(env, 'check', { requested_date: DAY, requested_time: t, service_keys: keys, exclude_appointment_time: ex, phone_number: phone, customer_key: key || '' }));
  const plain = await chk(A, '10:00', 'balayage', '');
  assert.ok(/^BUSY: 10:00-13:00 .*another appointment 10:00-10:30/.test(plain.result), 'without the exclusion the own appointment counts: ' + plain.result);
  const own = await chk(A, '10:00', 'balayage', '10:00');
  assert.ok(/^FREE: 10:00-13:00/.test(own.result) && /own current appointment at 10:00 is not counted/.test(own.result), own.result);
  const long = await chk(A, '10:00', 'balayage,womens_cut', '10:00');
  assert.ok(/^BUSY: 10:00-14:00/.test(long.result) === false && /^FREE: 10:00-14:00/.test(long.result), 'ends exactly when B starts: ' + long.result);
  const over = await chk(A, '11:00', 'balayage,womens_cut', '10:00');
  assert.ok(/^BUSY: 11:00-15:00 .*another appointment 14:00-14:30/.test(over.result), 'another customer always counts: ' + over.result);
  // Somebody else's appointment can never be left out - not by time, not by a typed number.
  const notMine = await chk(A, '14:00', 'mens_cut', '14:00');
  assert.ok(/^BUSY: 14:00-14:30/.test(notMine.result) && /No appointment of this customer at 14:00/.test(notMine.result), notMine.result);
  const forged = await chk(B, '10:00', 'balayage', '10:00');
  assert.ok(/^BUSY/.test(forged.result), 'B cannot free A\'s slot: ' + forged.result);
  const noId = await chk('', '10:00', 'balayage', '10:00');
  assert.ok(/^BUSY/.test(noId.result), 'no verified caller -> nothing left out: ' + noId.result);
  const badKey = await chk('', '10:00', 'balayage', '10:00', 'ig:123:456');
  assert.ok(/^BUSY/.test(badKey.result), badKey.result);
});

// ================================================================= WhatsApp end to end, four languages
const msgIdOf = (run) => run.accessor()('Dedup & Filter Prep').first().json.messageId;
const sendsTo = (env, chat) => env.rec.sends.filter((s) => s.to === chat).map((s) => s.text);
const chat = (env, text) => one(env, () => deliver(env, waMessage(env, A, { text })));
function aiProposesChange(env, nt, keys, output) {
  env.ai.behave = () => ({ output: output || 'OK', tools: async (e, run) => {
    const c = await callTool(e, 'check', { requested_date: DAY, requested_time: nt, service_keys: keys, exclude_appointment_time: '10:00', phone_number: A });
    assert.ok(/^FREE/.test(c.result) || /^BUSY/.test(c.result), c.result);
    const r = await callTool(e, 'reschedule', rs(A, '10:00', DAY, nt, keys, { chat_msg_id: msgIdOf(run) }));
    return [{ action: { tool: 'Check_Availability' }, observation: c.result }, { action: { tool: 'Reschedule_Appointment' }, observation: r.result }];
  } });
}
const LANGS = {
  en: { ask: 'Can I add a balayage to my blow-dry?', yes: 'Yes', no: 'No', q: /^Just to confirm: do you want to change your appointment “Blow-dry & styling” on Tuesday 6 October at 10:00 to: Balayage \+ Women's haircut & styling - 240 minutes in total, on Tuesday 6 October at 10:00 \(until 14:00\)\? Please reply Yes or No\.$/, done: /^Done: your appointment is now Balayage \+ Women's haircut & styling on Tuesday 6 October at 10:00 \(until 14:00\)/, already: /^That is already done: your appointment is Balayage \+ Women's haircut & styling .*\(until 14:00\)/, kept: /^No problem, nothing was changed/ },
  fr: { ask: 'Je voudrais ajouter un balayage et une coupe à mon brushing', yes: 'Oui', no: 'Non', q: /^Pour confirmer : voulez-vous modifier votre rendez-vous “Brushing” du mardi 6 octobre à 10:00 en : Balayage \+ Coupe femme & coiffage - 240 minutes au total, le mardi 6 octobre à 10:00 \(jusqu'à 14:00\) \? Répondez Oui ou Non\.$/, done: /^C'est fait : votre rendez-vous est maintenant Balayage \+ Coupe femme & coiffage/, already: /^C'est déjà fait : votre rendez-vous est Balayage \+ Coupe femme & coiffage/, kept: /^Très bien, rien n'a changé/ },
  es: { ask: 'Quiero añadir unas mechas y un corte a mi cita', yes: 'Sí', no: 'No', q: /^Para confirmar: ¿quieres cambiar tu cita “Secado y peinado \(brushing\)” del martes 6 de octubre a las 10:00 a: Balayage \+ Corte de mujer y peinado - 240 minutos en total, el martes 6 de octubre a las 10:00 \(hasta las 14:00\)\? Responde Sí o No\.$/, done: /^Hecho: tu cita es ahora Balayage \+ Corte de mujer y peinado/, already: /^Ya está hecho: tu cita es Balayage \+ Corte de mujer y peinado/, kept: /^Sin problema, no se ha tocado nada/ },
  ar: { ask: 'أريد إضافة بالياج وقص شعر إلى موعدي', yes: 'نعم', no: 'لا', q: /^للتأكيد: هل تريد تغيير موعدك “تجفيف وتصفيف \(براشينغ\)” يوم الثلاثاء 6 أكتوبر الساعة 10:00 إلى: بالياج \+ قص وتصفيف شعر للنساء - 240 دقيقة في المجموع، يوم الثلاثاء 6 أكتوبر الساعة 10:00 \(حتى 14:00\)؟ يرجى الرد بنعم أو لا\.$/, done: /^تم: أصبح موعدك بالياج \+ قص وتصفيف شعر للنساء/, already: /^تم ذلك بالفعل: موعدك أصبح بالياج/, kept: /^حسنًا، لم يتغير شيء/ },
};
test('CH8 WhatsApp, four languages: the server asks for the exact service change, a typed yes applies it once, a late yes is "already done"', async () => {
  let seed = 720;
  for (const lang of Object.keys(LANGS)) {
    const L = LANGS[lang];
    const env = makeEnv({ seed: seed++ });
    const id = await booked(env, A, '10:00', 'blow_dry');
    aiProposesChange(env, '10:00', 'balayage,womens_cut', 'Done, I changed it!'); // the AI's own claim is never sent
    await chat(env, L.ask);
    const q = sendsTo(env, A).slice(-1)[0];
    assert.ok(L.q.test(q), lang + ' question: ' + q);
    assert.strictEqual(span(env.cal.store(CAL).get(id).cur), DAY + 'T10:00-10:30', lang + ': nothing changed before the yes');
    const ai = env.rec.ai.length;
    env.ai.behave = () => { throw new Error('the AI must not decide a confirmation'); };
    await chat(env, L.yes);
    assert.strictEqual(env.rec.ai.length, ai, 'the AI was not involved');
    assert.ok(L.done.test(sendsTo(env, A).slice(-1)[0]), lang + ' done: ' + sendsTo(env, A).slice(-1)[0]);
    assert.strictEqual(span(env.cal.store(CAL).get(id).cur), DAY + 'T10:00-14:00');
    const execs = env.rec.toolResults.filter((t) => t.inputs && t.inputs.confirm_id).length;
    await chat(env, L.yes);
    assert.ok(L.already.test(sendsTo(env, A).slice(-1)[0]), lang + ' late yes: ' + sendsTo(env, A).slice(-1)[0]);
    assert.strictEqual(env.rec.toolResults.filter((t) => t.inputs && t.inputs.confirm_id).length, execs, 'nothing executed again');
    assert.strictEqual(appts(env).length, 1);
    // The next AI turn is told what really happened.
    env.ai.behave = () => ({ output: 'OK' });
    await chat(env, 'thanks'); // ("ok" would count as a yes and be answered by the server)
    assert.ok(/System log - authoritative.*CHANGED .* to Balayage \+ Women's haircut & styling \(240 minutes/.test(env.rec.ai.slice(-1)[0].prompt), lang + ': ' + env.rec.ai.slice(-1)[0].prompt.slice(0, 400));
  }
});

test('CH9 WhatsApp, four languages: a declined service change keeps the original; a later yes changes nothing', async () => {
  let seed = 740;
  for (const lang of Object.keys(LANGS)) {
    const L = LANGS[lang];
    const env = makeEnv({ seed: seed++ });
    const id = await booked(env, A, '10:00', 'blow_dry');
    const before = snap(env, id);
    aiProposesChange(env, '10:00', 'balayage,womens_cut');
    await chat(env, L.ask);
    env.ai.behave = () => ({ output: 'OK' });
    await chat(env, L.no);
    assert.ok(L.kept.test(sendsTo(env, A).slice(-1)[0]), lang + ' kept: ' + sendsTo(env, A).slice(-1)[0]);
    assert.strictEqual(snap(env, id), before);
    const execs = env.rec.toolResults.filter((t) => t.inputs && t.inputs.confirm_id).length;
    await chat(env, L.yes);
    assert.strictEqual(env.rec.toolResults.filter((t) => t.inputs && t.inputs.confirm_id).length, execs, lang + ': a yes after the no executes nothing');
    assert.ok(!L.already.test(sendsTo(env, A).slice(-1)[0]) && !L.done.test(sendsTo(env, A).slice(-1)[0]), lang + ': ' + sendsTo(env, A).slice(-1)[0]);
    assert.strictEqual(snap(env, id), before);
  }
});

test('CH10 WhatsApp: the extended window became busy before the yes -> "no longer free", original kept, nothing "already done"', async () => {
  const env = makeEnv({ seed: 760 });
  const id = await booked(env, A, '10:00', 'blow_dry');
  const before = snap(env, id);
  aiProposesChange(env, '10:00', 'balayage,womens_cut');
  await chat(env, LANGS.en.ask);
  await booked(env, B, '13:00', 'mens_cut', 'Someone Else');
  env.ai.behave = () => { throw new Error('the AI must not decide a confirmation'); };
  await chat(env, 'Yes');
  assert.ok(/^I could not complete that change, so nothing was changed \(that new time is no longer free\)/.test(sendsTo(env, A).slice(-1)[0]), sendsTo(env, A).slice(-1)[0]);
  assert.strictEqual(snap(env, id), before);
  env.ai.behave = () => ({ output: 'OK' });
  await chat(env, 'Yes');
  assert.ok(!/already done/.test(sendsTo(env, A).slice(-1)[0]), sendsTo(env, A).slice(-1)[0]);
  assert.strictEqual(snap(env, id), before);
});

if (require.main === module) runTests('service-change').then((r) => process.exit(r.fail ? 1 : 0));
