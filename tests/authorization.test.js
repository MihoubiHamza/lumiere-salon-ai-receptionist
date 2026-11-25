'use strict';
// Appointment authorization (2026-11-25): an appointment is found, shown, cancelled or
// moved ONLY for the verified sender of the conversation it was booked from
// (wa:<number> / fb:<page>:<psid> / ig:<account>:<igsid>). A phone number or a name the
// customer TYPES is never proof of ownership: such requests are refused before any
// calendar read (NEED_STAFF -> a team member), and nothing about the other customer is
// ever revealed. Phone numbers stay usable as contact information in new bookings.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { CFG, makeEnv, callTool, callConfirmed, runAll, deliver, waMessage, CONF, ROOT } = H;
const WB = require(path.join(ROOT, 'tools', 'build-workflows.js'));
const MB = require(path.join(ROOT, 'tools', 'build-messenger.js'));
const IB = require(path.join(ROOT, 'tools', 'build-instagram.js'));

const CAL = CFG.CALENDAR_ID;
const DAY = '2026-10-06'; // Tuesday
// Customers. SARA is a WhatsApp customer; the attackers know her number and name.
const SARA = '213555000001', WA_OTHER = '213555000009';
const IGA = '17841400000000001', IGB = '17841499999999999', PAGE = '102030405060708';
const SID = '5512345678901234', SID2 = '5598765432109876';
const IG = (sid, acct) => 'ig:' + (acct || IGA) + ':' + sid;
const FB = (sid) => 'fb:' + PAGE + ':' + sid;
const readWf = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

function seed(env, id, owner, time, summary, notes) {
  const s = Date.parse(DAY + 'T' + time + ':00+01:00');
  const description = (/^(ig|fb):/.test(owner) ? 'Customer: ' + owner : owner ? 'Phone: ' + owner : '') + (owner ? '. Notes: ' : '') + (notes || 'seeded');
  return env.cal.seed(CAL, { id, summary, description, start: { dateTime: DAY + 'T' + time + ':00+01:00', timeZone: 'Africa/Algiers' }, end: { dateTime: new Date(s + 30 * 60000 + 3600000).toISOString().slice(0, 19) + '+01:00', timeZone: 'Africa/Algiers' } });
}
const state = (env, id) => { const e = env.cal.store(CAL).get(id).cur; return e.status === 'cancelled' ? 'cancelled' : e.start.dateTime.slice(11, 16); };
// The identity each channel's workflow really sends (server-set, see AZ1).
const who = {
  wa: (n) => ({ phone_number: n, customer_key: 'wa:' + n }),
  ig: (sid, acct) => ({ phone_number: '', customer_key: IG(sid, acct) }),
  fb: (sid) => ({ phone_number: '', customer_key: FB(sid) }),
};
const findIn = (id, extra) => Object.assign({ patient_name: '', appointment_date: '', booked_phone_number: '' }, id, extra);
const cnIn = (id, time, extra) => Object.assign({ appointment_date: DAY, appointment_time: time, patient_name: '', booked_phone_number: '', chat_msg_id: 'm-propose' }, id, extra);
const rsIn = (id, ot, nt, extra) => Object.assign({ old_appointment_date: DAY, old_appointment_time: ot, new_appointment_date: DAY, new_appointment_time: nt, new_summary: '', new_description: '', patient_name: '', booked_phone_number: '', chat_msg_id: 'm-propose' }, id, extra);
const st = (r) => String(r.result || '').split(':')[0].split(' (')[0];
const one = async (env, f) => (await runAll(env, [f]))[0];
// Every way an attacker can ask about Sara's 10:00 appointment, with her number and name.
async function attack(env, id) {
  const out = [];
  for (const extra of [{}, { booked_phone_number: SARA }, { booked_phone_number: '0555000001' }, { booked_phone_number: '+213 555 00 00 01' }, { patient_name: 'Sara Benali' }, { patient_name: 'Sara Benali', booked_phone_number: SARA }]) {
    out.push(['find', extra, await one(env, () => callTool(env, 'find', findIn(id, extra)))]);
    out.push(['find day', extra, await one(env, () => callTool(env, 'find', findIn(id, Object.assign({ appointment_date: DAY }, extra))))]);
    out.push(['cancel', extra, await one(env, () => callConfirmed(env, 'cancel', cnIn(id, '10:00', extra)))]);
    out.push(['reschedule', extra, await one(env, () => callConfirmed(env, 'reschedule', rsIn(id, '10:00', '15:00', extra)))]);
  }
  return out;
}
function assertDenied(env, results, label) {
  for (const [op, extra, r] of results) {
    const tag = label + ' ' + op + ' ' + JSON.stringify(extra) + ': ' + r.result;
    assert.ok(['NOT_FOUND', 'NEED_STAFF'].indexOf(st(r)) >= 0, tag);
    if (extra.booked_phone_number) assert.strictEqual(st(r), 'NEED_STAFF', 'a typed number is refused before any search - ' + tag);
    assert.ok(!r.proposal, 'no confirmation may be created - ' + tag);
    // (the date / time the attacker typed may be echoed; the other customer's appointment never is)
    assert.ok(!/Sara|Benali|Manicure|FOUND: 1\)/.test(r.result), 'nothing about the other appointment is revealed - ' + tag);
  }
  assert.strictEqual(state(env, 'sara1'), '10:00', label + ': Sara\'s appointment is untouched');
}

// ------------------------------------------------------------------ the workflows themselves
test('AZ1 no channel lets the AI choose the customer: identity fields are server-set, booked_phone_number is fixed empty, prompts never ask for another number', () => {
  const files = { whatsapp: WB.FILES.main, messenger: MB.OUT_FILE, instagram: IB.OUT_FILE, website: path.join('website-demo', 'Lumiere Salon - Website Demo.json') };
  for (const [ch, f] of Object.entries(files)) {
    const wf = readWf(f);
    let tools = 0;
    for (const n of wf.nodes) {
      const v = n.parameters && n.parameters.workflowInputs && n.parameters.workflowInputs.value;
      if (!v || !('phone_number' in v || 'customer_key' in v || 'booked_phone_number' in v)) continue;
      tools++;
      for (const k of ['phone_number', 'customer_key', 'booked_phone_number']) if (k in v) assert.ok(String(v[k]).indexOf('$fromAI') < 0, ch + ' / ' + n.name + ': the AI controls ' + k);
      if ('booked_phone_number' in v) assert.strictEqual(v.booked_phone_number, '', ch + ' / ' + n.name + ': booked_phone_number must be fixed empty');
    }
    assert.ok(tools >= 5, ch + ': tool nodes checked (' + tools + ')');
    if (ch === 'website') continue;
    const agent = wf.nodes.find((n) => n.name === 'AI Agent').parameters.options.systemMessage;
    assert.ok(!/booked_phone_number|NEED_BOOKED_PHONE|ask for the exact phone number/.test(agent), ch + ': prompt still has the booked-number procedure');
    assert.ok(/never (accepted as )?proof that an appointment is theirs/i.test(agent) && /NEED_STAFF means/.test(agent) && /Escalate_to_Staff/.test(agent), ch + ': ownership rule missing');
    for (const t of ['Find_Patient_Appointments', 'Cancel_Appointment', 'Reschedule_Appointment']) {
      const d = wf.nodes.find((n) => n.name === t).parameters.description;
      assert.ok(!/pass that exact number|booked_phone_number/.test(d) && /never proof/.test(d), ch + ' / ' + t + ': ' + d.slice(0, 120));
    }
  }
});

test('AZ2 Instagram customer typing another person\'s phone number (and name): refused, staff only, nothing revealed or changed', async () => {
  const env = makeEnv({ seed: 801 });
  seed(env, 'sara1', SARA, '10:00', 'Sara Benali - Manicure');
  assertDenied(env, await attack(env, who.ig(SID)), 'instagram');
});

test('AZ3 Messenger customer typing another person\'s phone number (and name): refused, staff only, nothing revealed or changed', async () => {
  const env = makeEnv({ seed: 802 });
  seed(env, 'sara1', SARA, '10:00', 'Sara Benali - Manicure');
  assertDenied(env, await attack(env, who.fb(SID)), 'messenger');
});

test('AZ4 WhatsApp customer trying to reach another person\'s booking: by date/time, number, name - and with a fully hostile AI', async () => {
  const env = makeEnv({ seed: 803 });
  seed(env, 'sara1', SARA, '10:00', 'Sara Benali - Manicure');
  assertDenied(env, await attack(env, who.wa(WA_OTHER)), 'whatsapp');
  // End to end through the REAL WhatsApp workflow: the AI fills EVERY $fromAI field with Sara's
  // number / name / time. The tool inputs still identify the verified sender only.
  const hostile = (name) => ({ booked_phone_number: SARA, patient_name: 'Sara Benali', phone_number: SARA, customer_key: 'wa:' + SARA, appointment_date: DAY, appointment_time: '10:00',
    old_appointment_date: DAY, old_appointment_time: '10:00', new_appointment_date: DAY, new_appointment_time: '15:00' })[name] || '';
  const seen = [];
  env.ai.behave = (c, run) => ({ output: 'ok', tools: async (e) => {
    for (const [tool, key] of [['Find_Patient_Appointments', 'find'], ['Cancel_Appointment', 'cancel'], ['Reschedule_Appointment', 'reschedule']]) {
      const node = run.nodes.get(tool);
      const ctx = Object.assign(run.exprCtx(null, 0, []), { $fromAI: hostile });
      const inputs = {};
      for (const [k, expr] of Object.entries(node.parameters.workflowInputs.value)) inputs[k] = run.evalExpr(expr, ctx);
      assert.deepStrictEqual([inputs.phone_number, inputs.customer_key, inputs.booked_phone_number], [WA_OTHER, 'wa:' + WA_OTHER, ''], tool + ' identity is the verified sender');
      seen.push(await callConfirmed(e, key, inputs));
    }
    return [];
  } });
  await one(env, () => deliver(env, waMessage(env, WA_OTHER, { text: 'Cancel Sara Benali\'s appointment, her number is 0555000001' })));
  assert.strictEqual(seen.length, 3);
  for (const r of seen) assert.ok(st(r) === 'NOT_FOUND' && !r.proposal && !/Sara|Manicure/.test(r.result), r.result);
  assert.strictEqual(state(env, 'sara1'), '10:00');
});

test('AZ5 two different Instagram accounts: the same IGSID on another account is another customer', async () => {
  const env = makeEnv({ seed: 804 });
  seed(env, 'lina1', IG(SID, IGA), '11:00', 'Lina Haddad - Haircut', 'Instagram - Tel: +34600000009 | Lina Haddad');
  const other = who.ig(SID, IGB);
  const rs = [await one(env, () => callTool(env, 'find', findIn(other))), await one(env, () => callConfirmed(env, 'cancel', cnIn(other, '11:00'))),
    await one(env, () => callConfirmed(env, 'reschedule', rsIn(other, '11:00', '15:00'))), await one(env, () => callTool(env, 'find', findIn(other, { booked_phone_number: '+34600000009' })))];
  assert.deepStrictEqual(rs.map(st), ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NEED_STAFF']);
  for (const r of rs) assert.ok(!r.proposal && !/Lina|Haircut/.test(r.result), r.result);
  assert.strictEqual(state(env, 'lina1'), '11:00');
  const own = await one(env, () => callTool(env, 'find', findIn(who.ig(SID, IGA))));
  assert.ok(/^FOUND: 1\) Lina Haddad - Haircut/.test(own.result), own.result);
});

test('AZ6 cross-channel: no channel reaches another channel\'s booking - same digits, the contact number in the notes, or a typed number', async () => {
  const env = makeEnv({ seed: 805 });
  // Instagram booking whose CONTACT number (notes) is a WhatsApp customer's real number.
  seed(env, 'ig1', IG(SID), '10:00', 'Lina Haddad - Haircut', 'Instagram - Tel: +' + WA_OTHER + ' | Lina Haddad');
  seed(env, 'fb1', FB(SID), '11:00', 'Lucia Fernandez - Manicure', 'Messenger - Tel: +34600000000 | Lucia');
  seed(env, 'wa1', SARA, '12:00', 'Sara Benali - Blow-dry');
  // [label, caller, target event, its time, names the caller's Find may never show]
  const cases = [
    ['WhatsApp owner of the Tel number -> Instagram booking', who.wa(WA_OTHER), 'ig1', '10:00', /Lina|Lucia|Sara/],
    ['Messenger, same digits -> Instagram booking', who.fb(SID), 'ig1', '10:00', /Lina|Sara/],
    ['Instagram, same digits -> Messenger booking', who.ig(SID), 'fb1', '11:00', /Lucia|Sara/],
    ['Instagram -> WhatsApp booking', who.ig(SID), 'wa1', '12:00', /Lucia|Sara/],
    ['Messenger -> WhatsApp booking', who.fb(SID), 'wa1', '12:00', /Lina|Sara/],
    ['digits-only caller = the IGSID -> Instagram booking', { phone_number: SID }, 'ig1', '10:00', /Lina|Lucia|Sara/],
  ];
  for (const [label, id, ev, t, forbidden] of cases) {
    for (const extra of [{}, { booked_phone_number: SARA }, { booked_phone_number: WA_OTHER }]) {
      const rs = [await one(env, () => callConfirmed(env, 'cancel', cnIn(id, t, extra))), await one(env, () => callConfirmed(env, 'reschedule', rsIn(id, t, '16:00', extra)))];
      for (const r of rs) assert.ok(['NOT_FOUND', 'NEED_STAFF'].indexOf(st(r)) >= 0 && !r.proposal, label + ' ' + JSON.stringify(extra) + ': ' + r.result);
    }
    const f = await one(env, () => callTool(env, 'find', findIn(id)));
    assert.ok(!forbidden.test(f.result), label + ' find reveals: ' + f.result);
  }
  assert.deepStrictEqual(['ig1', 'fb1', 'wa1'].map((id) => state(env, id)), ['10:00', '11:00', '12:00']);
});

test('AZ7 legitimate access: each verified customer finds, cancels and moves its own appointments (WhatsApp incl. legacy and staff-made events)', async () => {
  const env = makeEnv({ seed: 806 });
  seed(env, 'wa1', SARA, '10:00', 'Sara Benali - Manicure'); // "Phone: <number>" (bot-written, also before customer keys)
  env.cal.seed(CAL, { id: 'staff1', summary: 'Sara (phone booking)', description: 'call 0555 00 00 01', start: { dateTime: DAY + 'T13:00:00+01:00' }, end: { dateTime: DAY + 'T13:30:00+01:00' } }); // staff-made, verified number in the text
  seed(env, 'ig1', IG(SID), '11:00', 'Lina Haddad - Haircut', 'Instagram - Tel: +34600000009 | Lina Haddad');
  seed(env, 'fb1', FB(SID), '12:00', 'Lucia Fernandez - Manicure', 'Messenger - Tel: +34600000000 | Lucia');
  const f = { wa: await one(env, () => callTool(env, 'find', findIn(who.wa(SARA)))), ig: await one(env, () => callTool(env, 'find', findIn(who.ig(SID)))), fb: await one(env, () => callTool(env, 'find', findIn(who.fb(SID)))) };
  assert.ok(/^FOUND: 1\) Sara Benali - Manicure .* 2\) Sara \(phone booking\)/.test(f.wa.result) && !/Lina|Lucia/.test(f.wa.result), f.wa.result);
  assert.ok(/^FOUND: 1\) Lina Haddad/.test(f.ig.result) && !/Sara|Lucia/.test(f.ig.result), f.ig.result);
  assert.ok(/^FOUND: 1\) Lucia Fernandez/.test(f.fb.result) && !/Sara|Lina/.test(f.fb.result), f.fb.result);
  const done = [
    await one(env, () => callConfirmed(env, 'reschedule', rsIn(who.wa(SARA), '10:00', '15:00'))),
    await one(env, () => callConfirmed(env, 'cancel', cnIn(who.wa(SARA), '13:00'))),
    await one(env, () => callConfirmed(env, 'reschedule', rsIn(who.ig(SID), '11:00', '16:00'))),
    await one(env, () => callConfirmed(env, 'cancel', cnIn(who.fb(SID), '12:00'))),
  ];
  for (const r of done) assert.ok(/^SUCCESS/.test(r.result) && r.proposal, r.result);
  assert.deepStrictEqual(['wa1', 'staff1', 'ig1', 'fb1'].map((id) => state(env, id)), ['15:00', 'cancelled', '16:00', 'cancelled']);
  // A moved Instagram appointment keeps its owner field.
  assert.ok(env.cal.store(CAL).get('ig1').cur.description.indexOf('Customer: ' + IG(SID) + '.') === 0);
});

test('AZ8 cancellation and rescheduling authorization: confirmations are created only by the owner and used only by the owner', async () => {
  const env = makeEnv({ seed: 807 });
  seed(env, 'ig1', IG(SID), '10:00', 'Lina Haddad - Haircut');
  seed(env, 'wa1', SARA, '11:00', 'Sara Benali - Manicure');
  // The owner proposes (nothing changes yet)...
  const pc = await one(env, () => callTool(env, 'cancel', cnIn(who.ig(SID), '10:00')));
  const pr = await one(env, () => callTool(env, 'reschedule', rsIn(who.wa(SARA), '11:00', '15:00')));
  const mc = CONF.unmark(pc.result), mr = CONF.unmark(pr.result);
  assert.ok(mc && mr, pc.result + ' / ' + pr.result);
  // ...nobody else can use those confirmations, even with the one-time id, the right time and a typed number.
  const exec = (key, inputs, m, extra) => one(env, () => callTool(env, key, Object.assign({}, inputs, { confirm_id: m.id, confirm_message: 'yes', confirm_msg_id: 'm-yes-' + Math.random(), confirm_via: 'text' }, extra)));
  const thieves = [who.ig(SID, IGB), who.fb(SID), who.wa(WA_OTHER), { phone_number: SID }];
  for (const t of thieves) {
    const a = await exec('cancel', cnIn(t, '10:00'), mc);
    const b = await exec('reschedule', rsIn(t, '11:00', '15:00'), mr);
    const c = await exec('cancel', cnIn(t, '10:00', { booked_phone_number: SARA }), mc);
    for (const r of [a, b, c]) assert.strictEqual(st(r), 'CONFIRMATION_INVALID', JSON.stringify(t) + ': ' + r.result);
  }
  assert.deepStrictEqual([state(env, 'ig1'), state(env, 'wa1')], ['10:00', '11:00']);
  // Nobody else can create a proposal for them either.
  for (const t of thieves) for (const extra of [{}, { booked_phone_number: SARA }]) {
    for (const p of [await one(env, () => callTool(env, 'cancel', cnIn(t, '10:00', extra))), await one(env, () => callTool(env, 'reschedule', rsIn(t, '11:00', '16:00', extra)))]) {
      assert.ok(!/CONFIRMATION_REQUIRED/.test(p.result) && !/Lina|Sara/.test(p.result), JSON.stringify(t) + ': ' + p.result);
    }
  }
  // The owners' own confirmations still work.
  assert.ok(/^SUCCESS/.test((await exec('cancel', cnIn(who.ig(SID), '10:00'), mc)).result));
  assert.ok(/^SUCCESS/.test((await exec('reschedule', rsIn(who.wa(SARA), '11:00', '15:00'), mr)).result));
  assert.deepStrictEqual([state(env, 'ig1'), state(env, 'wa1')], ['cancelled', '15:00']);
});

test('AZ9 phone numbers stay contact information: Messenger / Instagram bookings keep "Tel:" in the notes, without any phone identity', async () => {
  const env = makeEnv({ seed: 808 });
  const slot = (id, t, notes) => Object.assign({ start_datetime: DAY + 'T' + t + ':00', service_keys: 'mens_cut', summary: 'Lina Haddad - Haircut', notes }, id);
  const rs = [await one(env, () => callTool(env, 'book', slot(who.ig(SID), '10:00', 'Instagram - Tel: +34600000009 | Lina Haddad'))),
    await one(env, () => callTool(env, 'book', slot(who.fb(SID2), '11:00', 'Messenger - Tel: +34600000008 | Lucia')))];
  for (const r of rs) assert.ok(/^SUCCESS/.test(r.result), r.result);
  const d = env.cal.events(CAL).map((e) => e.description).sort();
  assert.deepStrictEqual(d, ['Customer: ' + FB(SID2) + '. Service: Men\'s haircut | Keys: mens_cut | Duration: 30 min. Notes: Messenger - Tel: +34600000008 | Lucia', 'Customer: ' + IG(SID) + '. Service: Men\'s haircut | Keys: mens_cut | Duration: 30 min. Notes: Instagram - Tel: +34600000009 | Lina Haddad']);
  // The contact number in the notes grants nothing to the WhatsApp user who owns it.
  const f = await one(env, () => callTool(env, 'find', findIn(who.wa('34600000009'))));
  assert.ok(/^NOT_FOUND/.test(f.result) && !/Lina/.test(f.result), f.result);
});

if (require.main === module) runTests('authorization').then((r) => process.exit(r.fail ? 1 : 0));
