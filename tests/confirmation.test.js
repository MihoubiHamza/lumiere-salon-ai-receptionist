'use strict';
// Confirmation gate: a cancellation or reschedule is NEVER applied on the AI's say-so.
// The tool workflows only PROPOSE (CONFIRMATION_REQUIRED); the change runs only in an
// EXECUTE call that carries a valid, unexpired, one-time confirmation for THIS
// customer, THIS appointment, THIS action (and THIS new time), plus the customer's
// own "yes" from a later message. These tests run the real execution workflows
// (Cancel / Reschedule) and the real WhatsApp main workflow in the emulator.
const assert = require('assert');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { CFG, makeEnv, callTool, callConfirmed, runAll, deliver, waMessage, CONF } = H;

const CAL = CFG.CALENDAR_ID;
const DAY = '2026-10-06'; // Tuesday
const A = '213555000001', B = '213555000002';
function seedAppt(env, id, phone, date, time, summary, dur) {
  const s = Date.parse(date + 'T' + time + ':00+01:00');
  return env.cal.seed(CAL, { id, summary, description: 'Phone: ' + phone + '. Notes: seeded', start: { dateTime: date + 'T' + time + ':00+01:00', timeZone: 'Africa/Algiers' }, end: { dateTime: new Date(s + (dur || 30) * 60000 + 3600000).toISOString().slice(0, 19) + '+01:00', timeZone: 'Africa/Algiers' } });
}
const apptTime = (env, id) => { const e = env.cal.store(CAL).get(id).cur; return e.status === 'cancelled' ? 'cancelled' : e.start.dateTime.slice(0, 16); };
const cn = (phone, time, extra) => Object.assign({ appointment_date: DAY, appointment_time: time, phone_number: phone, patient_name: '', booked_phone_number: '', chat_msg_id: 'msg-propose' }, extra);
const rs = (phone, ot, nt, extra) => Object.assign({ old_appointment_date: DAY, old_appointment_time: ot, new_appointment_date: DAY, new_appointment_time: nt, new_summary: '', new_description: '', phone_number: phone, patient_name: '', booked_phone_number: '', chat_msg_id: 'msg-propose' }, extra);
const one = async (env, f) => (await runAll(env, [f]))[0];
const propose = async (env, key, inputs) => {
  const p = await one(env, () => callTool(env, key, inputs));
  assert.ok(/^CONFIRMATION_REQUIRED/.test(p.result), p.result);
  const m = CONF.unmark(p.result);
  assert.ok(m && m.id, 'the proposal carries its one-time id');
  return m;
};
const execute = (env, key, inputs, m, extra) => one(env, () => callTool(env, key, Object.assign({}, inputs, { confirm_id: m.id, confirm_message: 'yes', confirm_msg_id: 'msg-yes-' + Math.random(), confirm_via: 'text' }, extra)));
const reasonOf = (r) => (/^CONFIRMATION_INVALID \(([a-z_]+)\)/.exec(String(r.result)) || [])[1] || String(r.result);

// ============================================================ the execution workflows themselves
test('K1 cancellation without confirmation: the tool only proposes; a made-up id is refused', async () => {
  const env = makeEnv({ seed: 501 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  const m = await propose(env, 'cancel', cn(A, '10:00'));
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00', 'nothing cancelled by the proposal');
  assert.strictEqual(m.act, 'cancel'); assert.strictEqual(m.ev, 'apptone1');
  const forged = await one(env, () => callTool(env, 'cancel', Object.assign(cn(A, '10:00'), { confirm_id: 'cfforgedforgedforged00', confirm_message: 'yes', confirm_msg_id: 'm2', confirm_via: 'text' })));
  assert.strictEqual(reasonOf(forged), 'mismatch', forged.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
});

test('K2 rescheduling without confirmation: the tool checks the slot and proposes, the calendar is untouched', async () => {
  const env = makeEnv({ seed: 502 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  const m = await propose(env, 'reschedule', rs(A, '10:00', '15:00'));
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00', 'not moved by the proposal');
  assert.strictEqual(m.ns, Date.parse(DAY + 'T15:00:00+01:00'), 'the exact proposed new time is recorded');
  const none = await one(env, () => callTool(env, 'reschedule', Object.assign(rs(A, '10:00', '15:00'), { confirm_id: 'cfnotarealconfirmation', confirm_message: 'yes', confirm_msg_id: 'm2', confirm_via: 'text' })));
  assert.strictEqual(status(none), 'CONFIRMATION_INVALID', none.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
  // a busy target slot is refused at proposal time already
  seedAppt(env, 'appttwo2', B, DAY, '16:00', 'Amine - Haircut');
  const busy = await one(env, () => callTool(env, 'reschedule', rs(A, '10:00', '16:00')));
  assert.ok(/^CONFLICT/.test(busy.result), busy.result);
});

test('K3 explicit confirmation (EN, FR, ES, AR) applies exactly the confirmed change', async () => {
  const yes = ['yes', 'Oui, je confirme', 'Sí, cancelar', 'نعم، ألغِ الموعد'];
  for (let i = 0; i < yes.length; i++) {
    const env = makeEnv({ seed: 510 + i });
    seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
    const r = await one(env, () => callConfirmed(env, 'cancel', cn(A, '10:00'), null, { message: yes[i] }));
    assert.ok(/^SUCCESS/.test(r.result), yes[i] + ': ' + r.result);
    assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled');
  }
  const env = makeEnv({ seed: 515 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure', 45);
  const r = await one(env, () => callConfirmed(env, 'reschedule', rs(A, '10:00', '15:00'), null, { message: 'Sí' }));
  assert.ok(/^SUCCESS/.test(r.result), r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T15:00');
  const ev = env.cal.store(CAL).get('apptone1').cur;
  assert.strictEqual(Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime), 45 * 60000, 'same length');
});

test('K4 negative and ambiguous answers never apply the change (checked again inside the execution workflow)', async () => {
  for (const [i, msg] of ['no', 'non merci', 'maybe', 'hmm', '👍', 'yes no', 'yes but at 16:00', 'what are your prices?'].entries()) {
    const env = makeEnv({ seed: 520 + i });
    seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
    const m = await propose(env, 'cancel', cn(A, '10:00'));
    const r = await execute(env, 'cancel', cn(A, '10:00'), m, { confirm_message: msg });
    assert.strictEqual(reasonOf(r), 'not_yes', msg + ': ' + r.result);
    assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00', msg + ': untouched');
    // the refused record is used up: even a correct yes cannot reuse it afterwards
    const again = await execute(env, 'cancel', cn(A, '10:00'), m);
    assert.strictEqual(reasonOf(again), 'used', again.result);
    assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
  }
});

test('K5 an expired confirmation is refused', async () => {
  const env = makeEnv({ seed: 530 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  const m = await propose(env, 'cancel', cn(A, '10:00'));
  const r = await one(env, async () => { await env.sim.sleep(CFG.CONFIRM_TTL_MS + 1000); return callTool(env, 'cancel', Object.assign(cn(A, '10:00'), { confirm_id: m.id, confirm_message: 'yes', confirm_msg_id: 'late', confirm_via: 'text' })); });
  assert.strictEqual(reasonOf(r), 'expired', r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
});

test('K6 a confirmation never authorizes another appointment, and a changed appointment is refused', async () => {
  const env = makeEnv({ seed: 540 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  seedAppt(env, 'appttwo2', A, DAY, '12:00', 'Sara - Pedicure');
  const m = await propose(env, 'cancel', cn(A, '10:00'));
  const wrong = await execute(env, 'cancel', cn(A, '12:00'), m, { confirm_event_id: 'appttwo2' });
  assert.strictEqual(reasonOf(wrong), 'wrong_appointment', wrong.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00'); assert.strictEqual(apptTime(env, 'appttwo2'), DAY + 'T12:00');
  // the confirmed id is bound to its own event even if the request names another time
  const m2 = await propose(env, 'cancel', cn(A, '10:00'));
  const ok = await execute(env, 'cancel', cn(A, '12:00'), m2);
  assert.ok(/^SUCCESS/.test(ok.result), ok.result);
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled'); assert.strictEqual(apptTime(env, 'appttwo2'), DAY + 'T12:00', 'the other appointment is untouched');
  // the appointment changes between the question and the yes (staff edit) -> refused
  const m3 = await propose(env, 'cancel', cn(A, '12:00'));
  const ev = env.cal.store(CAL).get('appttwo2').cur;
  env.cal.seed(CAL, Object.assign({}, ev, { description: ev.description + ' (edited by staff)' }));
  const changed = await execute(env, 'cancel', cn(A, '12:00'), m3);
  assert.strictEqual(reasonOf(changed), 'appointment_changed', changed.result);
  assert.strictEqual(apptTime(env, 'appttwo2'), DAY + 'T12:00');
});

test('K7 wrong customer / session: another chat can never use a confirmation', async () => {
  const env = makeEnv({ seed: 550 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  const m = await propose(env, 'cancel', cn(A, '10:00'));
  const other = await execute(env, 'cancel', cn(B, '10:00'), m);
  assert.strictEqual(status(other), 'CONFIRMATION_INVALID', other.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
  // ...and A's own confirmation still works afterwards
  const own = await execute(env, 'cancel', cn(A, '10:00'), m);
  assert.ok(/^SUCCESS/.test(own.result), own.result);
});

test('K8 a replayed confirmation is refused (one-time id)', async () => {
  const env = makeEnv({ seed: 560 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure', 60);
  const m = await propose(env, 'reschedule', rs(A, '10:00', '15:00'));
  const first = await execute(env, 'reschedule', rs(A, '10:00', '15:00'), m);
  assert.ok(/^SUCCESS/.test(first.result), first.result);
  const replay = await execute(env, 'reschedule', rs(A, '10:00', '15:00'), m);
  assert.strictEqual(reasonOf(replay), 'used', replay.result);
  // the same yes message cannot confirm its own proposal either (stale message)
  const m2 = await propose(env, 'cancel', cn(A, '15:00', { chat_msg_id: 'msg-77' }));
  const stale = await execute(env, 'cancel', cn(A, '15:00'), m2, { confirm_msg_id: 'msg-77' });
  assert.strictEqual(reasonOf(stale), 'stale_message', stale.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T15:00');
});

test('K9 a changed rescheduling time or action invalidates the earlier confirmation', async () => {
  const env = makeEnv({ seed: 570 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  const m15 = await propose(env, 'reschedule', rs(A, '10:00', '15:00'));
  const m16 = await propose(env, 'reschedule', rs(A, '10:00', '16:00'));
  assert.notStrictEqual(m15.id, m16.id);
  const old = await execute(env, 'reschedule', rs(A, '10:00', '15:00'), m15);
  assert.strictEqual(reasonOf(old), 'mismatch', old.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
  const wrongTime = await execute(env, 'reschedule', rs(A, '10:00', '16:00'), m16, { confirm_new_start: String(m15.ns) });
  assert.strictEqual(reasonOf(wrongTime), 'wrong_time', wrongTime.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
  // the customer changes the action: a cancel proposal replaces the reschedule one
  const mr = await propose(env, 'reschedule', rs(A, '10:00', '17:00'));
  const mc = await propose(env, 'cancel', cn(A, '10:00'));
  const r1 = await execute(env, 'reschedule', rs(A, '10:00', '17:00'), mr);
  assert.strictEqual(reasonOf(r1), 'mismatch', r1.result);
  const r2 = await execute(env, 'reschedule', rs(A, '10:00', '17:00'), mc);
  assert.strictEqual(reasonOf(r2), 'wrong_action', 'a cancel confirmation never moves anything: ' + r2.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
});

test('K10 the confirmed new time is re-checked when the change runs (slot taken meanwhile)', async () => {
  const env = makeEnv({ seed: 580 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  const m = await propose(env, 'reschedule', rs(A, '10:00', '15:00'));
  seedAppt(env, 'apptbusy', B, DAY, '15:00', 'Amine - Haircut');
  const r = await execute(env, 'reschedule', rs(A, '10:00', '15:00'), m);
  assert.strictEqual(reasonOf(r), 'conflict', r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
});

test('K11 successful cancellation and rescheduling (journal, lock released, nothing else touched)', async () => {
  const env = makeEnv({ seed: 590 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  seedAppt(env, 'appttwo2', B, DAY, '11:00', 'Amine - Haircut');
  const c = await one(env, () => callConfirmed(env, 'cancel', cn(A, '10:00')));
  assert.ok(/^SUCCESS: Cancelled appointment "Sara - Manicure" on 2026-10-06 10:00/.test(c.result), c.result);
  const r = await one(env, () => callConfirmed(env, 'reschedule', rs(B, '11:00', '14:00')));
  assert.ok(/^SUCCESS: Rescheduled appointment "Amine - Haircut" from 2026-10-06 11:00 to 2026-10-06 14:00/.test(r.result), r.result);
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled'); assert.strictEqual(apptTime(env, 'appttwo2'), DAY + 'T14:00');
  const st = env.cal.lockState(CFG.LOCK_CALENDAR_ID, CFG.CAL_LOCK_ID);
  assert.ok(!st.h, 'calendar mutex released');
  assert.deepStrictEqual(env.cal.violations, []);
});

// ============================================================ the WhatsApp main workflow end to end
const msgIdOf = (run) => run.accessor()('Dedup & Filter Prep').first().json.messageId;
const sendsTo = (env, chat) => env.rec.sends.filter((s) => s.to === chat).map((s) => s.text);
async function chat(env, text) { return one(env, () => deliver(env, waMessage(env, A, { text }))); }
function aiProposesCancel(env, output) {
  env.ai.behave = () => ({ output, tools: async (e, run) => {
    const r = await callTool(e, 'cancel', Object.assign(cn(A, '10:00'), { chat_msg_id: msgIdOf(run) }));
    return [{ action: { tool: 'Cancel_Appointment' }, observation: r.result }];
  } });
}

test('M1 WhatsApp: the AI saying "cancelled" is replaced by the server question; the customer\'s yes cancels, without the AI', async () => {
  const env = makeEnv({ seed: 600 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  aiProposesCancel(env, 'Your appointment has been cancelled.'); // the AI lies; the server must not repeat it
  await chat(env, 'Please cancel my appointment on Tuesday at 10:00');
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
  const ask = sendsTo(env, A).slice(-1)[0];
  assert.ok(/^Just to confirm: do you want to cancel your appointment “Sara - Manicure” on Tuesday 6 October at 10:00\? Please reply Yes or No\.$/.test(ask), ask);
  const aiCalls = env.rec.ai.length;
  env.ai.behave = () => { throw new Error('the AI must not decide a confirmation'); };
  await chat(env, 'Yes');
  assert.strictEqual(env.rec.ai.length, aiCalls, 'the AI was not involved');
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled');
  assert.ok(/has been cancelled/.test(sendsTo(env, A).slice(-1)[0]), sendsTo(env, A).slice(-1)[0]);
  // the next AI turn is told what really happened
  env.ai.behave = () => ({ output: 'Anything else?' });
  await chat(env, 'thanks');
  assert.ok(/System log - authoritative.*CANCELLED "Sara - Manicure"/.test(env.rec.ai.slice(-1)[0].prompt), env.rec.ai.slice(-1)[0].prompt);
});

test('M2 WhatsApp: "no" keeps the appointment; a later "yes" confirms nothing', async () => {
  const env = makeEnv({ seed: 610 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  aiProposesCancel(env, 'OK');
  await chat(env, 'Quiero cancelar mi cita del martes a las 10:00');
  assert.ok(/¿quieres cancelar tu cita/.test(sendsTo(env, A).slice(-1)[0]), 'question in the customer language: ' + sendsTo(env, A).slice(-1)[0]);
  env.ai.behave = () => { throw new Error('no AI for a clear no'); };
  await chat(env, 'No, mantener');
  assert.ok(/se mantiene/.test(sendsTo(env, A).slice(-1)[0]), sendsTo(env, A).slice(-1)[0]);
  env.ai.behave = () => ({ output: '¿En qué más puedo ayudarte?' });
  await chat(env, 'sí');
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00', 'the declined request is gone');
  assert.ok(!env.rec.toolResults.some((t) => /^SUCCESS/.test(String(t.result))), 'no cancellation ran');
});

test('M3 WhatsApp: an ambiguous answer asks again; a new request drops the pending confirmation', async () => {
  const env = makeEnv({ seed: 620 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  aiProposesCancel(env, 'OK');
  await chat(env, 'cancel my 10:00 appointment');
  env.ai.behave = () => { throw new Error('no AI for an unclear answer'); };
  await chat(env, 'hmm maybe');
  const again = sendsTo(env, A).slice(-1)[0];
  assert.ok(/^Sorry, I need a clear answer before I change anything\.\nJust to confirm: do you want to cancel/.test(again), again);
  await chat(env, 'yes'); // still valid after the clarification
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled');

  const env2 = makeEnv({ seed: 621 });
  seedAppt(env2, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  aiProposesCancel(env2, 'OK');
  await chat(env2, 'cancel my 10:00 appointment');
  env2.ai.behave = () => ({ output: 'A manicure costs 25 euros.' });
  await chat(env2, 'how much is a manicure?');
  assert.ok(/did not answer the pending request to confirm cancelling "Sara - Manicure"/.test(env2.rec.ai.slice(-1)[0].prompt), 'the AI is told the request was dropped');
  env2.ai.behave = () => ({ output: 'Great!' });
  await chat(env2, 'yes');
  assert.strictEqual(apptTime(env2, 'apptone1'), DAY + 'T10:00', 'a later yes no longer cancels anything');
});

test('V1 a voice confirmation never authorizes a change: the execution workflow refuses anything but typed text', async () => {
  for (const via of ['voice', '', undefined, 'button']) {
    const env = makeEnv({ seed: 640 });
    seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
    const m = await propose(env, 'cancel', cn(A, '10:00'));
    const r = await execute(env, 'cancel', cn(A, '10:00'), m, { confirm_via: via });
    assert.strictEqual(reasonOf(r), 'not_typed', String(via) + ': ' + r.result);
    assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00');
  }
});

test('V2 WhatsApp: a voice note saying "Sí" is not accepted; the customer is asked to type, then a typed yes cancels', async () => {
  const env = makeEnv({ seed: 650 });
  seedAppt(env, 'apptone1', A, DAY, '10:00', 'Sara - Manicure');
  aiProposesCancel(env, 'OK');
  await chat(env, 'Quiero cancelar mi cita del martes a las 10:00');
  env.ai.behave = () => { throw new Error('the AI must not decide a confirmation'); };
  env.voiceRaw = 'Sí, cancélala';
  await one(env, () => deliver(env, waMessage(env, A, { type: 'audio' })));
  const reply = sendsTo(env, A).slice(-1)[0];
  assert.ok(/^Por tu seguridad, una nota de voz no puede confirmar este cambio\. Escribe Sí o No\.\nPara confirmar: ¿quieres cancelar tu cita/.test(reply), reply);
  assert.strictEqual(apptTime(env, 'apptone1'), DAY + 'T10:00', 'nothing cancelled by a voice yes');
  assert.ok(!env.rec.toolResults.some((t) => t.inputs && t.inputs.confirm_id), 'no execute call was even attempted');
  await chat(env, 'Sí');
  assert.strictEqual(apptTime(env, 'apptone1'), 'cancelled', 'the typed yes still works afterwards');
  const ex = env.rec.toolResults.find((t) => t.inputs && t.inputs.confirm_id);
  assert.strictEqual(ex.inputs.confirm_via, 'text');
});

test('P2 the 5 salon tools can only be called by the salon WhatsApp and Messenger workflows', () => {
  const fs = require('fs'), path = require('path');
  const ENV = require(path.join(H.ROOT, 'lumiere.config.js'));
  for (const k of ['book', 'cancel', 'reschedule', 'find', 'check']) {
    const w = JSON.parse(fs.readFileSync(path.join(H.ROOT, H.FILES[k]), 'utf8'));
    assert.deepStrictEqual([w.settings.callerPolicy, w.settings.callerIds], ['workflowsFromAList', ENV.workflows.main + ',' + ENV.workflows.messenger], k);
    assert.deepStrictEqual(w.nodes.filter((n) => /trigger|webhook|schedule/i.test(n.type)).map((n) => n.type), ['n8n-nodes-base.executeWorkflowTrigger'], k + ' triggers');
  }
});

test('P1 every main workflow (WhatsApp, Messenger, website) tells the AI that the system does the confirmation', () => {
  const fs = require('fs'), path = require('path');
  for (const f of [H.FILES.main, 'Lumiere Messenger AI Agent.json', path.join('website-demo', 'Lumiere Salon - Website Demo.json')]) {
    const w = JSON.parse(fs.readFileSync(path.join(H.ROOT, f), 'utf8'));
    const sys = w.nodes.find((n) => n.name === 'AI Agent').parameters.options.systemMessage;
    assert.ok(sys.indexOf('## CONFIRMATION OF CANCELLATIONS AND RESCHEDULES IS DONE BY THE SYSTEM') >= 0 && sys.indexOf('IN THIS SAME TURN') >= 0, f + ' lacks the confirmation section');
    for (const t of ['Cancel_Appointment', 'Reschedule_Appointment']) {
      const tool = w.nodes.find((n) => n.name === t);
      assert.ok(/CONFIRMATION \(system-enforced\)/.test(tool.parameters.description), f + ' / ' + t + ' description');
      for (const k of ['confirm_id', 'confirm_message', 'confirm_msg_id', 'confirm_event_id', 'confirm_new_start']) assert.strictEqual(tool.parameters.workflowInputs.value[k], '', f + ' / ' + t + ': ' + k + ' must never come from the AI');
    }
  }
});

runTests('confirmation');

function status(r) { return String(r.result || '').split(':')[0].split(' (')[0]; }
