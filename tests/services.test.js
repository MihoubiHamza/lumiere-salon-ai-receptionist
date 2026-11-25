'use strict';
// C1 - backend service resolution. The service catalogue (salon-info.js) is the ONLY
// source of an appointment's length: tools receive canonical service keys, the engine
// resolves them (aliases in EN/FR/ES/AR, inclusions), computes the total length and the
// end time, enforces the 4-hour maximum and refuses unknown or ambiguous services.
// The AI is never authoritative for a duration.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { CFG, callTool, runAll, makeEnv, ROOT } = H;
const SALON = require(path.join(ROOT, 'salon-info.js'));
const E = require(path.join(ROOT, 'engine', 'engine.js')).createEngine(CFG)._t;
const CAL = CFG.CALENDAR_ID;
const DAY = '2026-10-06'; // Tuesday (START is Monday 2026-10-05 08:00)

const status = (r) => String(r.result || (r.res && r.res.error ? 'EXEC_ERROR ' + r.res.error.message : 'NONE')).split(':')[0];
const events = (env) => env.cal.events(CAL).filter((e) => e.status !== 'cancelled');
const writes = (env) => env.cal.log.filter((l) => l.method !== 'GET' && String(l.url || '').indexOf(encodeURIComponent(CAL) + '/events') >= 0 && !/lumierelock/.test(String(l.url) + JSON.stringify(l.body || '')));
const hmOf = (iso) => iso.slice(11, 16);
const book = (keys, time, extra) => Object.assign({ start_datetime: DAY + 'T' + time + ':00', service_keys: keys, summary: 'Lucía Fernández - Services', notes: 'Lucía Fernández', phone_number: '213555000101' }, extra || {});
const resolve = (v) => E.resolveServices(v);
const minutes = (v) => { const r = resolve(v); if (r.error) throw new Error(r.error.message); return r.minutes; };
const code = (v) => { const r = resolve(v); return r.error ? r.error.status : 'OK'; };
function seedAppt(env, id, time, dur) {
  const s = Date.parse(DAY + 'T' + time + ':00+01:00');
  return env.cal.seed(CAL, { id, summary: 'Other - x', description: 'Phone: 213555999999. Notes: seeded', start: { dateTime: DAY + 'T' + time + ':00+01:00', timeZone: 'Africa/Algiers' }, end: { dateTime: new Date(s + dur * 60000 + 3600000).toISOString().slice(0, 19) + '+01:00', timeZone: 'Africa/Algiers' } });
}

// ================================================================= catalogue
test('SV1 catalogue: stable unique keys, valid inclusions (no cycles), every name and alias resolves to its own service', () => {
  const keys = SALON.services.map((s) => s.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'unique keys');
  for (const s of SALON.services) {
    assert.ok(/^[a-z][a-z0-9_]*$/.test(s.key), 'canonical key ' + s.key);
    assert.ok(s.duration > 0 && s.duration <= CFG.APPT_MAX_MIN, s.key + ' duration');
    for (const i of s.includes) assert.ok(keys.indexOf(i) >= 0 && i !== s.key, s.key + ' includes an unknown key ' + i);
    assert.ok(s.aliases.length >= 5, s.key + ' has alternative names');
    // The key and the four official names always identify exactly this service.
    for (const n of [s.key, s.name, s.name_fr, s.name_es, s.name_ar]) assert.deepStrictEqual(resolve(n).keys, [s.key], s.key + ': "' + n + '" -> ' + JSON.stringify(resolve(n)));
    // An alias names this service - alone, or (ambiguous on purpose) together with others.
    for (const a of s.aliases) {
      const r = resolve(a);
      if (r.error) { assert.strictEqual(r.error.status, 'SERVICE_AMBIGUOUS', a); assert.ok(r.error.message.indexOf('[' + s.key + ']') >= 0, a + ' lists ' + s.key); }
      else assert.deepStrictEqual(r.keys, [s.key], s.key + ' alias "' + a + '"');
    }
  }
  // Inclusion graph has no cycle (a service can never be counted as included in itself).
  const inc = Object.fromEntries(SALON.services.map((s) => [s.key, s.includes]));
  const walk = (k, seen) => { for (const i of inc[k]) { assert.ok(seen.indexOf(i) < 0, 'cycle via ' + k); walk(i, seen.concat(i)); } };
  for (const k of keys) walk(k, [k]);
  // The engine copy of the catalogue is the salon-info.js one (no second source of durations).
  assert.deepStrictEqual(CFG.SERVICE_CATALOG.map((s) => [s.key, s.duration, s.includes]), SALON.services.map((s) => [s.key, s.duration, s.includes]));
  // No invented 45-minute "cut and blow-dry" service.
  assert.ok(!SALON.services.some((s) => /cut.*blow|blow.*cut/i.test(s.name) && s.duration === 45), 'no 45-minute cut & blow-dry service exists');
});

test('SV2 combined and included services: the backend total, never a plain sum', () => {
  assert.strictEqual(minutes('balayage,womens_cut'), 240, 'balayage 180 + women\'s cut 60 (the cut includes the blow-dry) = 240, not 270');
  assert.strictEqual(minutes('balayage,womens_cut,blow_dry'), 240, 'the blow-dry is part of the women\'s cut: not added');
  assert.strictEqual(minutes(['womens_cut', 'blow_dry']), 60);
  assert.strictEqual(minutes('treatment, blow_dry'), 45, 'the treatment includes a blow-dry');
  assert.strictEqual(minutes('full_colour,root_colour'), 120, 'a full colour covers the roots');
  assert.strictEqual(minutes('["gel_manicure","manicure","pedicure"]'), 120, 'JSON array input; the gel manicure includes the manicure');
  assert.strictEqual(minutes('womens_cut, womens_cut'), 60, 'a repeated key is one service');
  assert.strictEqual(minutes('mens_cut + brows'), 60);
  const r = resolve('balayage,womens_cut,blow_dry');
  assert.deepStrictEqual(r.keys, ['balayage', 'womens_cut', 'blow_dry']);
  assert.deepStrictEqual(r.counted, ['balayage', 'womens_cut']);
  assert.deepStrictEqual(r.included, [{ key: 'blow_dry', by: 'womens_cut' }]);
  assert.strictEqual(r.label, "Balayage + Women's haircut & styling");
  assert.strictEqual(r.priceText, 'from €185');
  assert.ok(/= 240 minutes in total/.test(r.text) && /already includes Blow-dry & styling/.test(r.text) && /starting price from €185/.test(r.text), r.text);
  assert.strictEqual(resolve('manicure,pedicure').priceText, '€60', 'fixed prices are not "from"');
});

test('SV3 alternative names and common expressions in English, French, Spanish and Arabic', () => {
  const T = {
    en: [['balayage', 'balayage'], ['highlights', 'balayage'], ["women's haircut", 'womens_cut'], ['cut and blow-dry', 'womens_cut'], ["Men's haircut", 'mens_cut'], ['blow dry', 'blow_dry'], ['keratin treatment', 'keratin'], ['root touch-up', 'root_colour'], ['gel nails', 'gel_manicure'], ['eyebrows', 'brows'], ['FACIAL', 'facial']],
    fr: [['Coupe femme & coiffage', 'womens_cut'], ['coupe brushing', 'womens_cut'], ['coupe homme', 'mens_cut'], ['brushing', 'blow_dry'], ['mèches', 'balayage'], ['Lissage à la kératine', 'keratin'], ['racines', 'root_colour'], ['coloration complète', 'full_colour'], ['manucure', 'manicure'], ['vernis semi-permanent', 'gel_manicure'], ['pédicure', 'pedicure'], ['soin du visage', 'facial'], ['sourcils', 'brows']],
    es: [['Corte de mujer y peinado', 'womens_cut'], ['corte de caballero', 'mens_cut'], ['secado', 'blow_dry'], ['mechas', 'balayage'], ['alisado de keratina', 'keratin'], ['tinte de raíces', 'root_colour'], ['tinte completo', 'full_colour'], ['manicura', 'manicure'], ['uñas de gel', 'gel_manicure'], ['pedicura', 'pedicure'], ['limpieza facial', 'facial'], ['cejas', 'brows'], ['mascarilla', 'treatment']],
    ar: [['قص شعر نسائي', 'womens_cut'], ['قص وتصفيف شعر للنساء', 'womens_cut'], ['قص شعر رجالي', 'mens_cut'], ['سشوار', 'blow_dry'], ['بالياج', 'balayage'], ['كيراتين', 'keratin'], ['صبغة الجذور', 'root_colour'], ['صبغة كاملة', 'full_colour'], ['مانيكير', 'manicure'], ['مانيكير جل', 'gel_manicure'], ['باديكير', 'pedicure'], ['تنظيف البشرة', 'facial'], ['حواجب', 'brows'],
      ['أظافر', 'AMBIGUOUS'], ['اظافر', 'AMBIGUOUS'], ['الحَواجِب'.replace('ال', ''), 'brows']], // hamza / diacritics are normalised
  };
  for (const lang of Object.keys(T)) {
    for (const [term, key] of T[lang]) {
      const r = resolve(term);
      if (key === 'AMBIGUOUS') assert.strictEqual(r.error && r.error.status, 'SERVICE_AMBIGUOUS', lang + ' "' + term + '"');
      else assert.deepStrictEqual(r.keys, [key], lang + ' "' + term + '" -> ' + JSON.stringify(r.error || r.keys));
    }
  }
  // A combination written in each language gives the same backend total.
  for (const combo of ['balayage, coupe femme', 'mechas, corte de mujer', 'بالياج, قص شعر نسائي', 'Balayage, Women\'s haircut & styling']) assert.strictEqual(minutes(combo), 240, combo);
});

test('SV4 unknown, ambiguous and missing services are refused - never a silent default', () => {
  for (const t of ['haircut', 'cut', 'colour', 'color', 'nails', 'coupe', 'corte', 'coloration', 'tinte', 'قص', 'صبغة', 'ongles', 'uñas']) {
    const r = resolve(t);
    assert.strictEqual(r.error && r.error.status, 'SERVICE_AMBIGUOUS', t + ' is ambiguous: ' + JSON.stringify(r));
    assert.ok(/Ask the customer which one they mean \(never guess\)/.test(r.error.message), r.error.message);
  }
  for (const t of ['45-min cut and blow-dry', 'cut_and_blowdry', 'massage', 'hair extensions', 'balayag', 'womens_cut_45']) {
    const r = resolve(t);
    assert.strictEqual(r.error && r.error.status, 'SERVICE_UNKNOWN', t + ': ' + JSON.stringify(r));
    assert.ok(/Never invent a service, price or duration/.test(r.error.message));
  }
  // One bad key in a list refuses the whole request (nothing partially resolved).
  assert.strictEqual(code('balayage, massage'), 'SERVICE_UNKNOWN');
  assert.strictEqual(code('balayage, haircut'), 'SERVICE_AMBIGUOUS');
  for (const v of ['', '   ', [], '[]', null, undefined, ' , ; ']) assert.strictEqual(code(v), 'SERVICE_REQUIRED', JSON.stringify(v));
  assert.strictEqual(code('brows,mens_cut,manicure,pedicure,facial,blow_dry,treatment'), 'INVALID_INPUT', 'at most 6 services per request');
  // Without a catalogue the engine fails closed.
  const bare = require(path.join(ROOT, 'engine', 'engine.js')).createEngine(Object.assign({}, CFG, { SERVICE_CATALOG: [] }))._t;
  assert.strictEqual(bare.resolveServices('balayage').error.status, 'ERROR');
});

test('SV5 the 4-hour maximum is enforced by the backend on the computed total', () => {
  assert.strictEqual(minutes('balayage,womens_cut'), 240, 'exactly 240 is allowed');
  for (const v of ['keratin,full_colour', 'balayage,womens_cut,manicure', 'balayage,keratin', 'keratin,root_colour,brows']) {
    const r = resolve(v);
    assert.strictEqual(r.error && r.error.status, 'TOO_LONG', v);
    assert.ok(/more than the maximum of 240 minutes/.test(r.error.message) && /two separate appointments/.test(r.error.message), r.error.message);
  }
  // The included service is not counted, so this stays within the limit.
  assert.strictEqual(minutes('keratin,blow_dry,brows'), 210);
});

// ================================================================= real tool workflows
test('SV6 Book: length and end time come from the catalogue; an AI-supplied end time / duration is ignored', async () => {
  const env = makeEnv({ seed: 61 });
  const [r] = await runAll(env, [() => callTool(env, 'book', book('balayage,womens_cut,blow_dry', '10:00', { end_datetime: DAY + 'T10:30:00', duration_minutes: '30' }))]);
  assert.strictEqual(status(r), 'SUCCESS', r.result);
  const [ev] = events(env);
  assert.strictEqual(hmOf(ev.start.dateTime) + '-' + hmOf(ev.end.dateTime), '10:00-14:00', 'balayage + women\'s cut (blow-dry included) = 240 min');
  assert.strictEqual(ev.description, "Phone: 213555000101. Service: Balayage + Women's haircut & styling | Keys: balayage,womens_cut,blow_dry | Duration: 240 min. Notes: Lucía Fernández");
  assert.ok(/on 2026-10-06 10:00-14:00\./.test(r.result) && /= 240 minutes in total/.test(r.result) && /starting price from €185/.test(r.result), r.result);
  // An end time 30 minutes long is never used, so the next 30 minutes are still blocked.
  const [r2] = await runAll(env, [() => callTool(env, 'book', book('mens_cut', '10:30', { phone_number: '213555000102', summary: 'Other - Cut', end_datetime: DAY + 'T11:00:00' }))]);
  assert.strictEqual(status(r2), 'CONFLICT', r2.result);
  // A wrong AI duration in the other direction (too long) is ignored as well.
  const [r3] = await runAll(env, [() => callTool(env, 'book', book('brows', '15:00', { phone_number: '213555000103', summary: 'Brows - x', end_datetime: DAY + 'T19:00:00' }))]);
  assert.strictEqual(status(r3), 'SUCCESS', r3.result);
  assert.strictEqual(hmOf(events(env).find((e) => e.summary === 'Brows - x').end.dateTime), '15:30');
});

test('SV7 Book: unknown, ambiguous, missing or too-long services write nothing to the calendar', async () => {
  const env = makeEnv({ seed: 62 });
  const cases = [['massage', 'SERVICE_UNKNOWN'], ['haircut', 'SERVICE_AMBIGUOUS'], ['', 'SERVICE_REQUIRED'], ['keratin,full_colour', 'TOO_LONG'], ['balayage, 45-min cut and blow-dry', 'SERVICE_UNKNOWN']];
  const rs = await runAll(env, cases.map(([k], i) => () => callTool(env, 'book', book(k, '10:00', { phone_number: '21355500020' + i }))));
  assert.deepStrictEqual(rs.map(status), cases.map((c) => c[1]));
  // The old shape (start + end, no service) is refused too - the end time alone never books anything.
  const [old] = await runAll(env, [() => callTool(env, 'book', { start_datetime: DAY + 'T11:00:00', end_datetime: DAY + 'T11:30:00', summary: 'Old - x', notes: '', phone_number: '213555000299' })]);
  assert.strictEqual(status(old), 'SERVICE_REQUIRED', old.result);
  assert.strictEqual(events(env).length, 0);
  assert.strictEqual(writes(env).length, 0, 'no calendar write at all: ' + JSON.stringify(writes(env).map((w) => w.method)));
});

test('SV8 closing time: the computed total must end by closing; Check_Availability agrees with Book_Appointment', async () => {
  const env = makeEnv({ seed: 63 });
  const late = await runAll(env, [
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '15:30', service_keys: 'balayage,womens_cut' }),
    () => callTool(env, 'book', book('balayage,womens_cut', '15:30')),
  ]);
  assert.deepStrictEqual(late.map(status), ['OUTSIDE_HOURS', 'OUTSIDE_HOURS']);
  assert.ok(/would end at 19:30/.test(late[0].result) && /latest start for these services is 15:00/.test(late[0].result), late[0].result);
  assert.ok(/would end at 19:30/.test(late[1].result) && /Nothing was booked/.test(late[1].result), late[1].result);
  const ok = await runAll(env, [() => callTool(env, 'check', { requested_date: DAY, requested_time: '15:00', service_keys: 'balayage,womens_cut' })]);
  assert.strictEqual(status(ok[0]), 'FREE', ok[0].result);
  assert.ok(/^FREE: 15:00-19:00 .*240-minute appointment/.test(ok[0].result) && /starting price from €185/.test(ok[0].result), ok[0].result);
  const [b] = await runAll(env, [() => callTool(env, 'book', book('balayage,womens_cut', '15:00'))]);
  assert.strictEqual(status(b), 'SUCCESS', b.result);
  assert.strictEqual(hmOf(events(env)[0].end.dateTime), '19:00');
  // Date-only: the latest start reported is for the real total.
  const [day] = await runAll(env, [() => callTool(env, 'check', { requested_date: '2026-10-07', requested_time: '', service_keys: 'keratin,brows' })]);
  assert.ok(/latest start is 16:00/.test(day.result) && /= 180 minutes in total/.test(day.result), day.result);
});

test('SV9 the whole computed length is checked against other appointments (Check and Book)', async () => {
  const env = makeEnv({ seed: 64 });
  seedAppt(env, 'other1300', '13:00', 60);
  const rs = await runAll(env, [
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'balayage,womens_cut' }), // 10:00-14:00 overlaps 13:00
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'balayage' }), // 10:00-13:00 fits
    () => callTool(env, 'book', book('balayage,womens_cut', '10:00')),
  ]);
  assert.deepStrictEqual(rs.map(status), ['BUSY', 'FREE', 'CONFLICT']);
  assert.ok(/^BUSY: 10:00-14:00 .*240-minute appointment/.test(rs[0].result) && /another appointment 13:00-14:00/.test(rs[0].result), rs[0].result);
  assert.ok(rs[0].result.indexOf('Other') < 0, 'privacy: another customer is never named');
  assert.strictEqual(events(env).length, 1, 'nothing booked over the other appointment');
});

test('SV10 Check_Availability: service refusals, and a specific time needs the services (no default length)', async () => {
  const env = makeEnv({ seed: 65 });
  const rs = await runAll(env, [
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'massage' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'colour' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'keratin,full_colour' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '20:00' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '', service_keys: '' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'mechas, corte de mujer' }),
    () => callTool(env, 'check', { requested_date: DAY, requested_time: '10:00', service_keys: 'womens_cut', duration_minutes: '10' }),
  ]);
  assert.deepStrictEqual(rs.map(status), ['SERVICE_UNKNOWN', 'SERVICE_AMBIGUOUS', 'TOO_LONG', 'SERVICE_REQUIRED', 'OUTSIDE_HOURS', 'EMPTY_DAY', 'FREE', 'FREE']);
  assert.ok(/Root colour touch-up \[root_colour\] or Full hair colour \[full_colour\]/.test(rs[1].result), rs[1].result);
  assert.ok(/^FREE: 10:00-14:00/.test(rs[6].result), 'Spanish names resolved, 240 min: ' + rs[6].result);
  assert.ok(/^FREE: 10:00-11:00 .*60-minute/.test(rs[7].result), 'an AI duration_minutes is ignored: ' + rs[7].result);
});

test('SV11 tool contracts: the AI sends service keys, never a duration or an end time (WhatsApp, Messenger, Instagram)', () => {
  const B = require(path.join(ROOT, 'tools', 'build-workflows.js'));
  const files = { whatsapp: B.FILES.main, messenger: 'Lumiere Messenger AI Agent.json', instagram: 'Lumiere Instagram AI Agent.json' };
  for (const ch of Object.keys(files)) {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, files[ch]), 'utf8'));
    const tool = (n) => w.nodes.find((x) => x.name === n).parameters.workflowInputs;
    for (const n of ['Book_Appointment', 'Check_Availability']) {
      const t = tool(n);
      assert.ok(/\$fromAI\('service_keys', .*, 'string', ''\)/.test(t.value.service_keys), ch + ' ' + n + ' takes optional service_keys (the backend refuses it when missing)');
      assert.ok(t.schema.some((f) => f.id === 'service_keys'), ch + ' ' + n + ' schema');
      assert.ok(!('end_datetime' in t.value) && !('duration_minutes' in t.value) && !t.schema.some((f) => /end_datetime|duration_minutes/.test(f.id)), ch + ' ' + n + ' never takes a duration / end time from the AI');
    }
    const prompt = w.nodes.find((x) => x.name === 'AI Agent').parameters.options.systemMessage;
    assert.ok(!/duration_minutes|end_datetime/.test(prompt), ch + ' prompt never asks the AI for a duration');
    for (const s of SALON.services) assert.ok(prompt.indexOf('- [' + s.key + '] ' + s.name + ' (') >= 0, ch + ' menu shows the key of ' + s.key);
    assert.ok(/\[womens_cut\] Women's haircut & styling .* - already includes Blow-dry & styling/.test(prompt), ch + ' menu shows inclusions');
  }
  for (const [key, gone, added] of [['book', 'end_datetime', 'service_keys'], ['check', 'duration_minutes', 'service_keys']]) {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, B.FILES[key]), 'utf8'));
    const names = w.nodes.find((n) => n.name === 'Execute Workflow Trigger').parameters.workflowInputs.values.map((v) => v.name);
    assert.ok(names.indexOf(added) >= 0 && names.indexOf(gone) < 0, key + ' sub-workflow inputs: ' + names.join(','));
  }
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, B.FILES.check), 'utf8')).nodes.find((n) => n.name === 'Validate Input').parameters.jsCode;
  assert.ok(!/durationMin|duration_minutes|requestedEndMs/.test(v), 'Validate Input no longer reads an AI duration');
});

test('SV12 prompt (WhatsApp, Messenger, Instagram, website): read-back, re-check, checked alternatives, honest limits; no cancel + re-book', () => {
  const B = require(path.join(ROOT, 'tools', 'build-workflows.js'));
  const files = [B.FILES.main, 'Lumiere Messenger AI Agent.json', 'Lumiere Instagram AI Agent.json', path.join('website-demo', 'Lumiere Salon - Website Demo.json')];
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).nodes.find((x) => x.name === 'AI Agent').parameters.options.systemMessage;
    const sec = (h) => { const a = p.indexOf('## ' + h); assert.ok(a >= 0, f + ' has ' + h); return p.slice(a, p.indexOf('\n\n## ', a + 1)); };
    const rb = sec('SERVICES, TOTAL LENGTH AND PRICE - READ BACK BEFORE YOU BOOK OR CHANGE');
    for (const re of [/already includes.*do not add it/, /read the complete selection back.*total length and the starting price exactly as the tool result states/, /Never add up durations or prices yourself/,
      /Whenever the selection changes.*call Check_Availability AGAIN with the new service_keys/, /only propose times or days that a Check_Availability result has shown to be free for the WHOLE selection/,
      /at most 4 hours \(TOO_LONG\)/, /never invent a service, a shorter version, a duration or a price/, /what was NOT done/]) assert.ok(re.test(rb), f + ': ' + re);
    const ch = sec('CHANGING THE SERVICES OF AN APPOINTMENT');
    assert.ok(/new_service_keys/.test(ch) && /exclude_appointment_time/.test(ch) && /Never cancel an appointment and book a new one to change its services/.test(ch), f);
    assert.ok(p.indexOf('SERVICE CHANGE WITH A DIFFERENT DURATION') < 0 && !/cancel the current appointment and book/.test(p), f + ' still has the cancel + re-book procedure');
  }
  // The website prompt receives its SERVICES & PRICES menu from DEMO CONFIG at runtime: same [key] + inclusion format.
  const web = JSON.parse(fs.readFileSync(path.join(ROOT, files[3]), 'utf8'));
  const cfgCode = web.nodes.find((n) => n.name === 'DEMO CONFIG').parameters.jsCode;
  assert.ok(cfgCode.indexOf("'- [' + s.key + '] ' + s.name") >= 0 && cfgCode.indexOf('already includes') >= 0 && cfgCode.indexOf('SERVICE_CATALOG') >= 0, 'website menu with keys and inclusions');
});

test('SV13 Find_Patient_Appointments shows the customer\'s OWN services, keys and end time (never another customer\'s)', async () => {
  const env = makeEnv({ seed: 66 });
  await runAll(env, [() => callTool(env, 'book', book('balayage,womens_cut,blow_dry', '10:00'))]);
  await runAll(env, [() => callTool(env, 'book', book('manicure', '15:00', { phone_number: '213555000102', summary: 'Other Person - Manicure' }))]);
  const [mine] = await runAll(env, [() => callTool(env, 'find', { appointment_date: '', phone_number: '213555000101', patient_name: '', booked_phone_number: '' })]);
  assert.strictEqual(mine.result, "FOUND: 1) Lucía Fernández - Services on 2026-10-06 at 10:00 (until 14:00; services: Balayage + Women's haircut & styling [keys: balayage,womens_cut,blow_dry; 240 min])");
  assert.ok(!/Other Person|Manicure|15:00/.test(mine.result), 'privacy');
  // An appointment without a service line (made by hand / before C1) still shows its end time.
  seedAppt(env, 'legacy01', '16:00', 45);
  env.cal.store(CAL).get('legacy01').cur.description = 'Phone: 213555000101. Notes: made by staff';
  const [both] = await runAll(env, [() => callTool(env, 'find', { appointment_date: DAY, phone_number: '213555000101', patient_name: '', booked_phone_number: '' })]);
  assert.ok(/2\) Other - x on 2026-10-06 at 16:00 \(until 16:45\)$/.test(both.result), both.result);
});

if (require.main === module) runTests('services').then((r) => process.exit(r.fail ? 1 : 0));
