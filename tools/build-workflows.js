#!/usr/bin/env node
'use strict';
// Regenerates the concurrency engine nodes and wiring in all six workflow JSON
// files from engine/engine.js + engine/config.js. Idempotent: running it on its
// own output produces byte-identical files (verified by tests/graph.test.js).
//
// Usage: node tools/build-workflows.js [--check]   (--check: fail if files would change)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CFG = require(path.join(ROOT, 'engine', 'config.js'));
const SALON = require(path.join(ROOT, 'salon-info.js'));
const ENV = require(path.join(ROOT, 'lumiere.config.js'));
const FILES = {
  main: 'Lumiere WhatsApp AI Agent (Cohere Transcribe).json',
  book: 'Book Appointment - Deterministic (Lumiere).json',
  cancel: 'Cancel Appointment - Deterministic (Lumiere).json',
  reschedule: 'Reschedule Appointment - Deterministic (Lumiere).json',
  find: 'Find Customer Appointments - Deterministic (Lumiere).json',
  check: 'Check Availability - Deterministic (Lumiere).json',
};
const ERROR_WORKFLOW_FILE = 'Salon Error Alert (Lumiere).json';

// ------------------------------------------------------------------ salon environment (lumiere.config.js)
// The engine works with a fixed UTC offset, so a timezone with daylight saving
// time (or another offset) would silently shift every appointment: refuse it.
function tzOffsetMin(tz, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms) / 60000);
}
function checkTimezone(tz, offsetMin) {
  let jan, jul;
  try { jan = tzOffsetMin(tz, Date.UTC(2026, 0, 15, 12)); jul = tzOffsetMin(tz, Date.UTC(2026, 6, 15, 12)); } catch (e) { throw new Error('build: unknown TIMEZONE ' + tz); }
  if (jan !== jul) throw new Error('build: TIMEZONE ' + tz + ' has daylight saving time (UTC' + jan / 60 + ' / UTC' + jul / 60 + '); the booking engine only supports fixed-offset timezones');
  if (jan !== offsetMin) throw new Error('build: TZ_OFFSET_MIN ' + offsetMin + ' does not match TIMEZONE ' + tz + ' (offset ' + jan + ' min)');
}
// Cohere Transcribe needs ONE language per request (no auto-detection).
const VOICE_MODELS = { 'cohere-transcribe-03-2026': ['en', 'fr', 'es', 'ar'], 'cohere-transcribe-arabic-07-2026': ['ar'] };
const LANG_NAMES = { en: 'English', fr: 'French', es: 'Spanish', ar: 'Arabic' };
function checkVoice() {
  const langs = VOICE_MODELS[CFG.VOICE_MODEL];
  if (!langs) throw new Error('build: unsupported VOICE_MODEL ' + CFG.VOICE_MODEL + ' (allowed: ' + Object.keys(VOICE_MODELS).join(', ') + ')');
  if (langs.indexOf(CFG.VOICE_LANGUAGE) < 0) throw new Error('build: VOICE_LANGUAGE ' + CFG.VOICE_LANGUAGE + ' is not supported with ' + CFG.VOICE_MODEL + ' (allowed: ' + langs.join(', ') + ')');
}
checkTimezone(CFG.TIMEZONE, CFG.TZ_OFFSET_MIN);
checkVoice();
const VOICE_NOTE_TEXT = ' (voice note, auto-transcribed as ' + LANG_NAMES[CFG.VOICE_LANGUAGE] + ' - voice notes are ONLY supported in ' + LANG_NAMES[CFG.VOICE_LANGUAGE] + '. It may contain misheard words: interpret charitably from context. If the transcript is garbled, or the customer writes in another language, do not guess: reply in their language that voice notes can only be understood in ' + LANG_NAMES[CFG.VOICE_LANGUAGE] + ' for now and ask them to type their message)';

const CRED_FOR_TYPE = { googleCalendarOAuth2Api: 'googleCalendar', googleSheetsOAuth2Api: 'googleSheets', whatsAppTriggerApi: 'whatsAppTrigger', whatsAppApi: 'whatsApp', openRouterApi: 'openRouter' };
const SHEET_TAB_FOR_NODE = { 'Log Conversation': 'log', 'Get Clinic Info': 'salonInfo' }; // every other Sheets node uses the handoffs tab
const IANA = /[A-Z][A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/.source;
function walkStrings(o, fn) {
  if (Array.isArray(o)) return o.map((v) => walkStrings(v, fn));
  if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = walkStrings(o[k], fn); return o; }
  return typeof o === 'string' ? fn(o) : o;
}
// Points every node of a workflow at the salon's own resources.
function applyEnvironment(wf) {
  for (const n of wf.nodes) {
    for (const type of Object.keys(n.credentials || {})) {
      let key = CRED_FOR_TYPE[type];
      if (type === 'httpHeaderAuth' && n.name === 'Cohere Transcribe') key = 'cohere';
      if (!key) throw new Error('build: ' + wf.name + ' / ' + n.name + ' uses an unmapped credential type ' + type);
      n.credentials[type] = Object.assign({}, ENV.credentials[key]);
    }
    if (n.parameters && n.parameters.documentId) {
      n.parameters.documentId = { __rl: true, value: ENV.google.SHEET_ID, mode: 'id' };
      n.parameters.sheetName = { __rl: true, value: ENV.google.SHEET_TABS[SHEET_TAB_FOR_NODE[n.name] || 'handoffs'], mode: 'name' };
    }
    n.parameters = walkStrings(n.parameters, (s) => {
      for (const k of Object.keys(ENV.env)) s = s.split('CLINIC_' + k).join(ENV.env[k]);
      return s.replace(new RegExp("setZone\\('" + IANA + "'\\)", 'g'), "setZone('" + CFG.TIMEZONE + "')")
        .replace(new RegExp("zone: '" + IANA + "'", 'g'), "zone: '" + CFG.TIMEZONE + "'");
    });
  }
}

function engineSource() {
  const src = fs.readFileSync(path.join(ROOT, 'engine', 'engine.js'), 'utf8');
  const start = src.indexOf('function createEngine(');
  const end = src.indexOf("\nif (typeof module !== 'undefined'");
  if (start < 0 || end < 0) throw new Error('engine.js layout changed');
  return src.slice(start, end).trimEnd() + '\n';
}
// engine/confirm.js: the confirmation-gate classifier and server texts (same copy-in approach).
function confirmSource() {
  const src = fs.readFileSync(path.join(ROOT, 'engine', 'confirm.js'), 'utf8');
  const start = src.indexOf('function createConfirm(');
  const end = src.indexOf("\nif (typeof module !== 'undefined'");
  if (start < 0 || end < 0) throw new Error('confirm.js layout changed');
  return src.slice(start, end).trimEnd() + '\n';
}
// VOICE_* settings configure the Cohere node, not the engine.
const ENGINE_CFG_KEYS = Object.keys(CFG).filter((k) => typeof CFG[k] !== 'object' && !/^VOICE_/.test(k));
function cfgLiteral() {
  const o = {}; for (const k of ENGINE_CFG_KEYS) o[k] = CFG[k];
  return 'const CFG = ' + JSON.stringify(o, null, 2) + ';\n';
}
const BANNER = '// GENERATED by tools/build-workflows.js from engine/engine.js - do not edit here.\n';
const withEngine = (glue) => BANNER + cfgLiteral() + engineSource() + confirmSource() + '\n// ---- n8n glue ----\n' + glue;

function uuid(seed) {
  const h = crypto.createHash('md5').update(seed).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const dump = (o) => JSON.stringify(o, null, 2) + '\n';
const byName = (wf, n) => wf.nodes.find((x) => x.name === n);
function must(wf, n) { const x = byName(wf, n); if (!x) throw new Error(wf.name + ': missing node ' + n); return x; }

function upsert(wf, node) {
  const cur = byName(wf, node.name);
  const full = Object.assign({ id: cur ? cur.id : uuid(wf.name + '/' + node.name) }, node);
  if (cur) wf.nodes[wf.nodes.indexOf(cur)] = full; else wf.nodes.push(full);
  return full;
}
function remove(wf, name) {
  wf.nodes = wf.nodes.filter((n) => n.name !== name);
  delete wf.connections[name];
  for (const src of Object.keys(wf.connections)) {
    for (const type of Object.keys(wf.connections[src])) {
      wf.connections[src][type] = wf.connections[src][type].map((outs) => (outs || []).filter((c) => c.node !== name));
    }
  }
}
function conn(wf, from, outputs) {
  wf.connections[from] = Object.assign({}, wf.connections[from] || {}, {
    main: outputs.map((names) => names.map((n) => ({ node: n, type: 'main', index: 0 }))),
  });
}
function deepReplace(o, from, to) {
  let n = 0;
  const walk = (v) => {
    if (typeof v === 'string') { if (v.indexOf(from) >= 0) { n++; return v.split(from).join(to); } return v; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
    return v;
  };
  walk(o);
  return n;
}
// n8n resolves $('Node').first() / .last() / .all() WITHOUT an output index through
// the output of that node which leads to the current node. For a node with an
// error output that can be the (empty) error branch - e.g. Chat Lock Acquired ->
// error -> fallback reply -> Chat Lock: Release - and the lookup silently returns
// nothing. Every such lookup is pinned to the main output 0.
function pinOutputs(wf) {
  const errOut = wf.nodes.filter((n) => n.onError === 'continueErrorOutput').map((n) => n.name);
  for (const name of errOut) for (const m of ['first', 'last', 'all']) for (const n of wf.nodes) deepReplace(n.parameters, "$('" + name + "')." + m + '()', "$('" + name + "')." + m + '(0)');
  return wf;
}
function replaceOnce(str, from, to, label) {
  if (str.indexOf(to) >= 0) return str; // already applied
  const i = str.indexOf(from);
  if (i < 0) throw new Error('build: anchor not found for ' + label);
  if (str.indexOf(from, i + 1) >= 0) throw new Error('build: anchor not unique for ' + label);
  return str.slice(0, i) + to + str.slice(i + from.length);
}

// ------------------------------------------------------------------ engine nodes
const GCAL_CRED = { googleCalendarOAuth2Api: CFG.GOOGLE_CALENDAR_CREDENTIAL };
const DECIDE_GLUE = `const engine = createEngine(CFG, createConfirm());
const inp = $input.first().json;
const now = Date.now();
const store = $getWorkflowStaticData('global');
const key = 'eng:' + $execution.id;
let state, resp = null;
if (inp && inp.__engineStart) {
  for (const k of Object.keys(store)) if (k.indexOf('eng:') === 0 && store[k] && store[k].t < now - 3600000) delete store[k];
  state = engine.init(inp.__engineStart.op, inp.__engineStart.ctx, now, $execution.id, Math.random);
} else if (inp && inp.__engine && inp.__engine.state) {
  state = inp.__engine.state;
  resp = inp.__engine.resp || null;
} else {
  throw new Error('Engine: Decide received an unexpected item');
}
const out = engine.step(state, resp, now, Math.random);
if (out.action.type === 'done') delete store[key];
else store[key] = { t: now, step: out.state.step, state: out.state };
const json = { __engine: { state: out.state, action: out.action } };
if (out.action.type === 'done') json.result = out.action.result;
return [{ json }];
`;
// The HTTP node's output replaces the item, so the engine state is recovered
// from two independent channels: per-execution static data (written by Decide)
// and n8n item linking back to the Decide run that issued the request. Either
// alone is sufficient. The run that issued this request is always the NEWEST
// Decide run, so if the channels disagree the higher step is the correct one.
const COLLECT_CODE = BANNER + `const raw = $input.item.json || {};
const resp = typeof raw.statusCode === 'number'
  ? { statusCode: raw.statusCode, body: raw.body }
  : { statusCode: 0, error: String((raw.error && (raw.error.message || raw.error)) || 'transport error') };
const saved = $getWorkflowStaticData('global')['eng:' + $execution.id];
let linked = null;
try { linked = $('Engine: Decide').item.json.__engine; } catch (e) { linked = null; }
const a = saved && saved.state ? saved.state : null;
const b = linked && linked.state ? linked.state : null;
const state = a && b ? (b.step > a.step ? b : a) : (a || b);
if (!state) throw new Error('Engine: lost state after Calendar API call');
return { json: { __engine: { state, resp } } };
`;
function cond(id, left, right, type, op) {
  return { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id, leftValue: left, rightValue: right, operator: type === 'boolean' ? { type: 'boolean', operation: 'true', singleValue: true } : { type: 'string', operation: op || 'equals' } }], combinator: 'and' } };
}
function rule(id, left, right, key, type) { return Object.assign(cond(id, left, right, type), { renameOutput: true, outputKey: key }); }

// n8n decides which parameters are "visible" from the RAW value of toggles such
// as sendBody/sendHeaders. If a toggle is an expression, the parameters it
// reveals are treated as hidden and silently not sent. So every toggle here is
// a literal, and requests with and without a body use separate nodes.
function calendarApiNode(name, withBody, pos) {
  const p = {
    method: '={{ $json.__engine.action.req.method }}',
    url: '={{ $json.__engine.action.req.url }}',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'googleCalendarOAuth2Api',
    sendHeaders: true, specifyHeaders: 'json',
    jsonHeaders: '={{ JSON.stringify($json.__engine.action.req.headers || {}) }}',
    sendBody: withBody,
  };
  if (withBody) Object.assign(p, { contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.__engine.action.req.body) }}' });
  p.options = { timeout: CFG.HTTP_TIMEOUT_MS, response: { response: { fullResponse: true, neverError: true } } };
  return { parameters: p, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: GCAL_CRED, onError: 'continueRegularOutput' };
}
function engineNodes(wfName, at, doneLabel) {
  const [x, y] = at;
  return [
    { parameters: { jsCode: withEngine(DECIDE_GLUE) }, name: 'Engine: Decide', type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, y] },
    { parameters: { rules: { values: [
        rule('eng-http-body', "={{ $json.__engine.action.type === 'http' && !!$json.__engine.action.req.body }}", '', 'http + body', 'boolean'),
        rule('eng-http', '={{ $json.__engine.action.type }}', 'http', 'http'),
        rule('eng-sleep', '={{ $json.__engine.action.type }}', 'sleep', 'sleep'),
        rule('eng-done', '={{ $json.__engine.action.type }}', 'done', doneLabel || 'done'),
      ] }, options: {} }, name: 'Engine: Route', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [x + 220, y] },
    calendarApiNode('Engine: Calendar API (write)', true, [x + 440, y - 240]),
    calendarApiNode('Engine: Calendar API', false, [x + 440, y - 100]),
    { parameters: { mode: 'runOnceForEachItem', jsCode: COLLECT_CODE }, name: 'Engine: Collect', type: 'n8n-nodes-base.code', typeVersion: 2, position: [x + 660, y - 160] },
    { parameters: { resume: 'timeInterval', amount: '={{ Math.max(0.15, $json.__engine.action.ms / 1000) }}', unit: 'seconds' },
      name: 'Engine: Sleep', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [x + 440, y + 120], webhookId: uuid(wfName + '/Engine: Sleep/webhook') },
  ];
}
// failTarget: where a crash of an engine Code node goes (e.g. the n8n task
// runner disconnecting mid-execution). Without it the execution just dies.
function wireEngine(wf, doneTargets, failTarget) {
  for (const n of ['Engine: Decide', 'Engine: Collect']) must(wf, n).onError = 'continueErrorOutput';
  conn(wf, 'Engine: Decide', [['Engine: Route'], [failTarget]]);
  conn(wf, 'Engine: Route', [['Engine: Calendar API (write)'], ['Engine: Calendar API'], ['Engine: Sleep'], doneTargets]);
  conn(wf, 'Engine: Calendar API (write)', [['Engine: Collect']]);
  conn(wf, 'Engine: Calendar API', [['Engine: Collect']]);
  conn(wf, 'Engine: Collect', [['Engine: Decide'], [failTarget]]);
  conn(wf, 'Engine: Sleep', [['Engine: Decide']]);
}

// ------------------------------------------------------------------ calendar tool sub-workflows
const FORMAT_RESULT = BANNER + `const r = $input.first().json.result;
if (!r || !r.message) return [{ json: { result: 'ERROR: internal engine error - nothing was changed. Never tell the customer it succeeded; apologize and call Escalate_to_Staff.' } }];
return [{ json: { result: r.message } }];
`;
// A Set node (not Code) so it still answers when the Code task runner is down.
const TOOL_FAILED = 'Engine Failed - Result';
const TOOL_FAILED_MSG = 'ERROR_NEEDS_STAFF: The appointment system failed in the middle of this request, so it is NOT known whether anything was changed. Do NOT tell the customer it succeeded or failed. Apologize, tell them a team member will confirm, and call Escalate_to_Staff mentioning this.';
function buildToolWorkflow(wf, op, extraInputs) {
  const trig = must(wf, 'Execute Workflow Trigger');
  const names = trig.parameters.workflowInputs.values.map((v) => v.name);
  for (const n of extraInputs || []) if (names.indexOf(n) < 0) trig.parameters.workflowInputs.values.push({ name: n });
  for (const n of wf.nodes.map((x) => x.name)) if (n !== 'Execute Workflow Trigger') remove(wf, n);
  wf.connections = {};
  const [tx, ty] = trig.position;
  upsert(wf, { parameters: { jsCode: BANNER + `const t = $('Execute Workflow Trigger').first().json;\nreturn [{ json: { __engineStart: { op: '${op}', ctx: Object.assign({}, t) } } }];\n` },
    name: 'Engine: Start', type: 'n8n-nodes-base.code', typeVersion: 2, position: [tx + 220, ty] });
  for (const n of engineNodes(wf.name, [tx + 440, ty])) upsert(wf, n);
  upsert(wf, { parameters: { jsCode: FORMAT_RESULT }, name: 'Format Result', type: 'n8n-nodes-base.code', typeVersion: 2, position: [tx + 1100, ty + 240] });
  upsert(wf, { parameters: { assignments: { assignments: [{ id: 'engine-failed-result', name: 'result', value: TOOL_FAILED_MSG, type: 'string' }] }, options: {} },
    name: TOOL_FAILED, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [tx + 1100, ty + 460] });
  for (const n of ['Engine: Start', 'Format Result']) must(wf, n).onError = 'continueErrorOutput';
  conn(wf, 'Execute Workflow Trigger', [['Engine: Start']]);
  conn(wf, 'Engine: Start', [['Engine: Decide'], [TOOL_FAILED]]);
  conn(wf, 'Format Result', [[], [TOOL_FAILED]]);
  wireEngine(wf, ['Format Result'], TOOL_FAILED);
  wf.settings = Object.assign({}, wf.settings, { executionTimeout: CFG.TOOL_EXECUTION_TIMEOUT_S });
}

function setCalendar(node) {
  node.parameters.calendar = { __rl: true, value: CFG.CALENDAR_ID, mode: 'list', cachedResultName: CFG.CALENDAR_NAME };
  node.parameters.options = Object.assign({}, node.parameters.options, { singleEvents: true }); // expand recurring events into real instances
  node.credentials = GCAL_CRED;
}

// ------------------------------------------------------------------ read-only sub-workflows
const FIND_GLUE = `const E = createEngine(CFG)._t;
const t = $('Execute Workflow Trigger').first().json;
const events = $input.all().map((e) => e.json);
const idn = E.identity(t);
if (idn.error) return [{ json: { status: 'not_found', matches: [], result: idn.error.message } }];
const targetDate = String(t.appointment_date == null ? '' : t.appointment_date).trim();
const matches = [];
for (const ev of events) {
  if (!ev || ev.status === 'cancelled' || !ev.start || !ev.start.dateTime) continue;
  if (!E.phoneMatches(ev, idn)) continue;
  const s = Date.parse(ev.start.dateTime);
  if (targetDate && E.ymd(s) !== targetDate) continue;
  matches.push({ summary: String(ev.summary || '').replace(/^=+/, ''), date: E.ymd(s), time: E.hm(s) });
}
matches.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
let result;
if (!matches.length) {
  // Only this customer's own appointments are ever searched: never by a typed number or name.
  result = 'NOT_FOUND: No appointments of this customer found' + (targetDate ? ' on ' + targetDate : ' in the next 90 days') + '.' +
    ' If the customer says it was booked from a different phone number, another channel or by someone else, do not search for it and never ask for that number: call Escalate_to_Staff (NEED_STAFF).';
} else {
  result = 'FOUND: ' + matches.map((m, i) => (i + 1) + ') ' + m.summary + ' on ' + m.date + ' at ' + m.time).join('; ');
}
return [{ json: { status: matches.length ? 'found' : 'not_found', matches, result } }];
`;
const CHECK_GLUE = `const E = createEngine(CFG)._t;
const v = $('Validate Input').first().json;
const now = Date.now();
const busy = $input.all().map((e) => e.json)
  .filter((ev) => ev && ev.status !== 'cancelled' && ev.start && ev.start.dateTime)
  .map((ev) => { const s = Date.parse(ev.start.dateTime); const e = ev.end && ev.end.dateTime ? Date.parse(ev.end.dateTime) : s + CFG.APPT_DEFAULT_MIN * 60000; return { s, e }; })
  .sort((a, b) => a.s - b.s);
// Other customers' names/services are deliberately never returned (privacy).
const periods = busy.map((b) => E.hm(b.s) + '-' + E.hm(b.e)).join(', ');
const d = E.parseYmd(v.dateOnly);
const dayMs = E.localMs(d.y, d.mo, d.d);
const dayEnd = dayMs + 86400000;
const toMin = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
// Length of the requested service(s); the whole service must end by closing time.
const dur = v.durationMin || CFG.APPT_DEFAULT_MIN;
const closeMs = dayMs + toMin(CFG.WORK_END) * 60000;
const endNote = ' Every appointment must end by ' + CFG.WORK_END + ' (for a ' + dur + '-minute service the latest start is ' + E.hm(closeMs - dur * 60000) + ').';
// All-day events not marked Free (e.g. 'Salon closed') close the day. Titles are never returned.
const blocked = $input.all().map((e) => E.allDayBlock(e.json)).filter((b) => b && b.s < dayEnd && b.e > dayMs);
let result;
if (E.lp(dayMs).wd === CFG.CLOSED_WEEKDAY) {
  result = 'CLOSED_DAY: ' + v.dateOnly + ' falls on the salon\\'s weekly closing day. Tell the customer the salon is closed that day and ask them for a different day - never offer or confirm a time on this date.';
} else if (blocked.length) {
  result = 'CLOSED_DAY: ' + v.dateOnly + ' is marked as unavailable on the salon calendar (for example a holiday or the salon is closed). Tell the customer this day is not available and ask them for a different day - never offer or confirm a time on this date.';
} else if (dayEnd <= now) {
  result = 'PAST_DATE: ' + v.dateOnly + ' is already in the past. Ask the customer for a future date.';
} else if (v.hasRequestedTime) {
  const reqStart = v.requestedStartMs, reqEnd = v.requestedEndMs;
  const m = toMin(v.requestedTime);
  if (m < toMin(CFG.WORK_START) || m >= toMin(CFG.WORK_END)) {
    result = 'OUTSIDE_HOURS: ' + v.requestedTime + ' on ' + v.dateOnly + ' is outside salon opening hours (' + CFG.WORK_START + '-' + CFG.WORK_END + '). Tell the customer plainly and ask for a time within opening hours - never offer or confirm this time.';
  } else if (reqEnd > closeMs) {
    result = 'OUTSIDE_HOURS: a ' + dur + '-minute service starting at ' + v.requestedTime + ' on ' + v.dateOnly + ' would end after the salon closes (' + CFG.WORK_END + '). The latest start for this service is ' + E.hm(closeMs - dur * 60000) + '. Tell the customer plainly and offer an earlier time - never offer or confirm this time.';
  } else if (reqStart <= now) {
    result = 'PAST_TIME: ' + v.requestedTime + ' on ' + v.dateOnly + ' has already passed. Ask the customer for a later time - never offer or confirm this time.';
  } else {
    const c = busy.find((b) => b.s < reqEnd && b.e > reqStart);
    if (c) result = 'BUSY: ' + v.requestedTime + ' on ' + v.dateOnly + ' is not free for a ' + dur + '-minute service (another appointment ' + E.hm(c.s) + '-' + E.hm(c.e) + '). Do not offer or confirm this time to the customer - tell them plainly it is taken and ask for a different time.' + (busy.length > 1 ? ' Other busy periods that day: ' + periods + '.' : '');
    else result = 'FREE: ' + v.requestedTime + '-' + E.hm(reqEnd) + ' on ' + v.dateOnly + ' is available for the whole ' + dur + '-minute service - no conflicting appointment. You may offer/confirm this time.' + (busy.length ? ' (Other busy periods that day, not affecting this time: ' + periods + '.)' : '');
  }
} else {
  const today = dayMs <= now ? ' Times earlier than ' + E.hm(now) + ' today have already passed.' : '';
  if (!busy.length) result = 'EMPTY_DAY: ' + v.dateOnly + ' has zero booked appointments. The entire opening day (' + CFG.WORK_START + '-' + CFG.WORK_END + ') is free - tell the customer the day is wide open and ask what time suits them.' + endNote + today;
  else result = 'HAS_EVENTS: ' + v.dateOnly + ' has these busy periods: ' + periods + '. Every other time within opening hours (' + CFG.WORK_START + '-' + CFG.WORK_END + ') on this day is free. Only treat a time as unavailable if the service would overlap one of these exact busy periods - never assume the whole day is full just because it has some appointments.' + endNote + today;
}
return [{ json: { result } }];
`;

// ------------------------------------------------------------------ main workflow
const ACQUIRE_CODE = BANNER + `const d = $('Dedup & Filter Prep').first().json;
// The chat lock is keyed by the channel-aware customer key (wa: / fb: / ig:), never by bare digits.
return [{ json: { __engineStart: { op: 'chatAcquire', ctx: { chatId: d.customerKey || d.chatId, msgId: d.messageId, msgTs: d.msgTs || 0, token: 'e' + $execution.id } } } }];
`;
// Release under the token the lock was actually taken with. After n8n's
// "Retry" the execution id changes but the acquire state (and its token) is
// carried over, so 'e' + $execution.id alone would leave the lock held.
const RELEASE_CODE = BANNER + `const d = $('Dedup & Filter Prep').first().json;
let wasHolder = false, token = '';
try { const a = $('Chat Lock Acquired').first(); wasHolder = !!(a && a.json && a.json.acquired === true); token = (a && a.json && a.json.token) || ''; } catch (e) { wasHolder = false; }
if (!token) { try { const s = $('Engine: Decide').first().json.__engine.state; if (s.op === 'chatAcquire') token = s.token || ''; } catch (e) { token = ''; } }
// Confirmation gate bookkeeping for this message: drop/used pending request, system note, language.
let g = {};
try { if ($('Confirmation Output').isExecuted) g = $('Confirmation Output').first().json; else if ($('Confirmation Gate').isExecuted) g = $('Confirmation Gate').first().json; } catch (e) { g = {}; }
return [{ json: { __engineStart: { op: 'chatRelease', ctx: { chatId: d.customerKey || d.chatId, msgId: d.messageId, msgTs: d.msgTs || 0, token: token || 'e' + $execution.id, wasHolder,
  pcClear: g.pcClear || '', note: g.note || '', lang: g.detectedLang || '' } } } }];
`;
const ACQUIRED_CODE = BANNER + `const j = $input.first().json;
const r = j.result || {};
const token = (j.__engine && j.__engine.state && j.__engine.state.token) || '';
// pending / notes / lang come from this customer's lock object (confirmation gate);
// lastTs = timestamp of the customer's previous processed message (0 = first contact).
return [{ json: { acquired: true, token, outOfOrder: !!r.outOfOrder, recoveredStaleLock: !!r.recoveredStaleLock, pending: r.pending || null, notes: r.notes || [], lang: r.lang || '', lastTs: r.lastTs || 0 } }];
`;

// ------------------------------------------------------------------ confirmation gate (main workflows)
// Cancel / Reschedule only PROPOSE (engine). The customer's NEXT message decides,
// server-side, before the AI sees it: a clear yes runs the tool workflow in
// EXECUTE mode (which re-checks everything itself), a no / unclear answer is
// answered by the server, anything else drops the pending request.
const TOOL_KEYS = ['book', 'cancel', 'reschedule', 'find', 'check'];
// Channel-aware customer key (engine/engine.js customerOf): always set by the server from the
// verified sender (Dedup & Filter Prep), never by the AI. Legacy callers (website demo) send none.
const CUSTOMER_KEY_EXPR = "={{ $('Dedup & Filter Prep').first().json.customerKey || '' }}";
const KEY_TOOLS = ['Book_Appointment', 'Find_Patient_Appointments', 'Cancel_Appointment', 'Reschedule_Appointment'];
const CONFIRM_INPUTS = ['confirm_id', 'confirm_message', 'confirm_msg_id', 'confirm_event_id', 'confirm_new_start', 'confirm_via', 'chat_msg_id'];
const CBANNER = '// GENERATED by tools/build-workflows.js from engine/confirm.js - do not edit here.\n';
const GATE_CODE = () => CBANNER + confirmSource() + `
const C = createConfirm();
const OFF = ${CFG.TZ_OFFSET_MIN};
const d = $('Dedup & Filter Prep').first().json;
const lk = $('Chat Lock Acquired').first().json;
const userText = String($json.userText == null ? '' : $json.userText);
const now = Date.now();
const p = lk.pending && lk.pending.id ? lk.pending : null;
const detected = C.detectLang(userText);
const msgLang = { english: 'en', french: 'fr', spanish: 'es', arabic: 'ar' }[d.msgLang] || '';
const lang = detected || msgLang || lk.lang || d.lang || 'en';
const T = C.texts(lang);
// Did this message arrive as a voice note (transcribed)? Only typed messages can confirm.
let viaVoice = false;
try { viaVoice = $('Merge Voice Text').isExecuted === true; } catch (e) { viaVoice = false; } // the website has no voice path
let route = 'ai', reply = '', pcClear = '', note = '', aiNote = '', exec = null, ui = null;
if (p) {
  const verdict = C.classify(userText); // the customer's own words, never the AI
  const what = (p.act === 'cancel' ? 'cancelling' : 'moving') + ' "' + (p.sum || 'the appointment') + '"';
  if (!(now < p.exp)) {
    pcClear = p.id;
    if (verdict === 'yes') { route = 'reply'; reply = T.expired(p.act); ui = { type: 'expired', act: p.act }; note = 'the request to confirm ' + what + ' had expired - nothing changed'; }
    else aiNote = 'An earlier request to confirm ' + what + ' expired, so NOTHING was changed.';
  } else if (verdict === 'yes' && viaVoice) {
    // A transcription is not the customer's own typed words: it never authorizes a change.
    route = 'reply'; reply = T.voiceOnly + '\\n' + C.ask(p, lang, OFF); ui = { type: 'ask', act: p.act };
    note = 'a voice message said yes to ' + what + ' - not accepted, asked the customer to type Yes or No';
  } else if (verdict === 'yes') {
    route = p.act; // 'cancel' | 'reschedule'
    exec = { confirm_id: p.id, confirm_message: userText, confirm_msg_id: String(d.messageId || ''), confirm_event_id: p.ev, confirm_new_start: p.act === 'reschedule' ? String(p.ns) : '' };
  } else if (verdict === 'no') {
    route = 'reply'; pcClear = p.id; reply = T.kept(C.what(p), C.when(p.os, lang, OFF)); ui = { type: 'kept', act: p.act };
    note = 'the customer said no to ' + what + ' - nothing changed';
  } else if (verdict === 'unclear') {
    route = 'reply'; reply = T.unclear + '\\n' + C.ask(p, lang, OFF); ui = { type: 'ask', act: p.act };
  } else {
    pcClear = p.id; note = 'the customer did not answer the request to confirm ' + what + ' - dropped, nothing changed';
    aiNote = 'The customer did not answer the pending request to confirm ' + what + ', so it was dropped and NOTHING was changed. If they still want it, call the tool again.';
  }
}
const log = (lk.notes || []).filter((n) => n && n.at > now - 2 * 3600000).map((n) => n.t);
const lines = [];
if (log.length) lines.push('[System log - authoritative, newer than your memory: ' + log.join(' | ') + '.]');
if (aiNote) lines.push('[System note: ' + aiNote + ']');
return [{ json: { userText, route, reply, pcClear, note, lang, detectedLang: detected, exec, ui, pending: p ? C.pub(p) : null, aiNote: lines.join('\\n') } }];
`;
const OUTPUT_CODE = () => CBANNER + confirmSource() + `
const C = createConfirm();
const OFF = ${CFG.TZ_OFFSET_MIN};
const g = $('Confirmation Gate').first().json;
const j = $input.first().json || {};
const lang = g.lang || 'en';
const T = C.texts(lang);
let output = '', steps = [], ui = g.ui || null, note = g.note || '', pcClear = g.pcClear || '';
if (g.route === 'ai') {
  output = String(j.output == null ? '' : j.output);
  steps = Array.isArray(j.intermediateSteps) ? j.intermediateSteps : [];
  // A cancel / reschedule the AI just PROPOSED: the server asks the customer (never the AI's own words).
  let prop = null;
  for (const s of steps) {
    const tool = (s.action && s.action.tool) || s.tool || '';
    if (tool !== 'Cancel_Appointment' && tool !== 'Reschedule_Appointment') continue;
    const o = typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation || '');
    if (/CONFIRMATION_REQUIRED/.test(o)) { const m = C.unmark(o); if (m && m.id) prop = m; }
  }
  if (prop) { output = C.ask(prop, lang, OFF); ui = { type: 'ask', act: prop.act }; }
} else if (g.route === 'cancel' || g.route === 'reschedule') {
  const r = String((j && j.result) == null ? '' : j.result);
  const p = g.pending || {}; const act = g.route;
  const what = '"' + (p.sum || 'the appointment') + '"';
  pcClear = p.id || pcClear; // already used up by the execute call; clearing again is harmless
  if (/^SUCCESS/.test(r)) {
    output = act === 'cancel' ? T.doneCancel(C.what(p), C.when(p.os, lang, OFF)) : T.doneMove(C.what(p), C.when(p.os, lang, OFF), C.when(p.ns, lang, OFF));
    steps = [{ action: { tool: act === 'cancel' ? 'Cancel_Appointment' : 'Reschedule_Appointment' }, observation: r }]; // the tool really ran and returned SUCCESS
    ui = { type: 'done', act };
    note = 'the customer confirmed and the system ' + (act === 'cancel' ? 'CANCELLED ' + what : 'MOVED ' + what + ' to the new time') + ' - this is done';
  } else if (/^CONFIRMATION_INVALID/.test(r)) {
    const why = (/\\(([a-z_]+)\\)/.exec(r) || [])[1] || 'default';
    output = why === 'expired' ? T.expired(act) : T.invalid(T.why[why] || T.why.default);
    ui = { type: 'invalid', act }; note = 'the confirmed ' + act + ' of ' + what + ' was NOT applied (' + why + ') - nothing changed';
  } else {
    output = T.unknown; ui = { type: 'unknown', act }; note = 'the confirmed ' + act + ' of ' + what + ' gave an unclear result - check with Find_Patient_Appointments before saying anything about it';
  }
} else {
  output = String(g.reply || '');
}
if (ui) ui.chips = ui.type === 'ask' ? T.chips[ui.act] : (ui.type === 'done' && ui.act === 'cancel') ? T.chips.afterCancel : T.chips.after;
return [{ json: { output, intermediateSteps: steps, ui, note, pcClear, lang, detectedLang: g.detectedLang || '' } }];
`;
// Inputs of the Execute calls: only server-side values, never the AI.
function confirmExecNode(name, wfId, fields, pos) {
  const value = {};
  for (const f of fields) value[f] = '';
  value.phone_number = "={{ $('Dedup & Filter Prep').first().json.chatId.replace(/\\D/g, '') }}";
  value.customer_key = CUSTOMER_KEY_EXPR;
  for (const f of ['confirm_id', 'confirm_message', 'confirm_msg_id', 'confirm_event_id', 'confirm_new_start']) value[f] = '={{ $json.exec.' + f + ' }}';
  // How the confirming message arrived, computed here independently of the gate:
  // the execution workflow refuses anything but 'text' (a voice transcription never confirms).
  value.confirm_via = "={{ $('Merge Voice Text').isExecuted ? 'voice' : 'text' }}";
  return { parameters: { workflowId: { __rl: true, value: wfId, mode: 'list', cachedResultUrl: '/workflow/' + wfId },
      workflowInputs: { mappingMode: 'defineBelow', value, matchingColumns: [], schema: Object.keys(value).map(TOOL_FIELD), attemptToConvertTypes: false, convertFieldsToString: true }, options: {} },
    name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: pos, onError: 'continueRegularOutput', alwaysOutputData: true };
}
const CANCEL_FIELDS = ['appointment_date', 'appointment_time', 'phone_number', 'patient_name', 'booked_phone_number'].concat(CONFIRM_INPUTS, ['customer_key']);
const RESCHED_FIELDS = ['old_appointment_date', 'old_appointment_time', 'new_appointment_date', 'new_appointment_time', 'new_summary', 'new_description', 'phone_number', 'patient_name', 'booked_phone_number'].concat(CONFIRM_INPUTS, ['customer_key']);
const CONFIRM_TOOL_NOTE = ' CONFIRMATION (system-enforced): this tool never changes the appointment when you call it. It checks everything and returns CONFIRMATION_REQUIRED; the system itself then shows the customer the exact appointment and asks Yes/No, and makes the change only after their explicit yes. So call it as soon as the customer has clearly asked for this change of one specific appointment - do not ask "are you sure?" yourself first - and never say it is done.';
function addConfirmationGate(wf, ids) {
  const [mx, my] = must(wf, 'AI Agent').position;
  upsert(wf, { parameters: { jsCode: GATE_CODE() }, name: 'Confirmation Gate', type: 'n8n-nodes-base.code', typeVersion: 2, position: [mx - 660, my - 420], onError: 'continueErrorOutput' });
  upsert(wf, { parameters: { rules: { values: ['ai', 'cancel', 'reschedule', 'reply'].map((k) => rule('confirm-' + k, '={{ $json.route }}', k, k)) }, options: {} },
    name: 'Confirmation Route', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [mx - 440, my - 420] });
  upsert(wf, confirmExecNode('Run Confirmed Cancel', ids.cancel, CANCEL_FIELDS, [mx - 220, my - 620]));
  upsert(wf, confirmExecNode('Run Confirmed Reschedule', ids.reschedule, RESCHED_FIELDS, [mx - 220, my - 820]));
  upsert(wf, { parameters: { jsCode: OUTPUT_CODE() }, name: 'Confirmation Output', type: 'n8n-nodes-base.code', typeVersion: 2, position: [mx + 440, my - 420], onError: 'continueErrorOutput' });
  for (const t of ['Cancel_Appointment', 'Reschedule_Appointment']) {
    const tool = must(wf, t);
    for (const f of CONFIRM_INPUTS) addToolField(tool, f, f === 'chat_msg_id' ? "={{ $('Dedup & Filter Prep').first().json.messageId }}" : ''); // never filled by the AI
    if (tool.parameters.description.indexOf('CONFIRMATION (system-enforced)') < 0) tool.parameters.description += CONFIRM_TOOL_NOTE;
  }
  const agent = must(wf, 'AI Agent');
  if (agent.parameters.text.indexOf("$('Confirmation Gate')") < 0) agent.parameters.text += "{{ $('Confirmation Gate').first().json.aiNote ? '\\n' + $('Confirmation Gate').first().json.aiNote : '' }}";
}
function wireConfirmationGate(wf, fallback) {
  conn(wf, 'Merge Text Message', [['Confirmation Gate']]);
  if (byName(wf, 'Merge Voice Text')) conn(wf, 'Merge Voice Text', [['Confirmation Gate']]);
  conn(wf, 'Confirmation Gate', [['Confirmation Route'], [fallback]]);
  conn(wf, 'Confirmation Route', [['AI Agent'], ['Run Confirmed Cancel'], ['Run Confirmed Reschedule'], ['Confirmation Output']]);
  conn(wf, 'Run Confirmed Cancel', [['Confirmation Output']]);
  conn(wf, 'Run Confirmed Reschedule', [['Confirmation Output']]);
  conn(wf, 'AI Agent', [['Confirmation Output'], [fallback]]);
  conn(wf, 'Confirmation Output', [['Sanitize AI Output'], [fallback]]);
}
const CONFIRM_PROMPT_BLOCK = '## CONFIRMATION OF CANCELLATIONS AND RESCHEDULES IS DONE BY THE SYSTEM\n' +
  'This section replaces every older instruction in this prompt that tells you to ask the customer to confirm before calling Cancel_Appointment or Reschedule_Appointment.\n' +
  '- Cancel_Appointment and Reschedule_Appointment never change the calendar when you call them. They return CONFIRMATION_REQUIRED, and the system itself shows the customer the exact appointment (and the new time) and asks them to answer Yes or No.\n' +
  '- So: as soon as the customer has clearly asked to cancel or move ONE specific appointment (identified with Find_Patient_Appointments when needed, and for a move with Check_Availability saying the new time is free), CALL Cancel_Appointment or Reschedule_Appointment IN THIS SAME TURN. Do not ask "are you sure?", do not announce that you are going to cancel or move it, and do not mention any confirmation step - just call the tool. The system then replaces your reply with its own Yes/No question.\n' +
  '- After calling it, never say the appointment is cancelled or moved. The system tells the customer once they confirm. A "[System log]" line in the message tells you what was really done.\n' +
  '- If the tool returns something else (NOT_FOUND, AMBIGUOUS, CONFLICT, OUTSIDE_HOURS, ...), handle it as described in the other rules.\n\n';

const OOO_NOTE = `{{ $('Chat Lock Acquired').first().json.outOfOrder ? "\\n[System note: this message was sent BEFORE the customer's previous message but was delivered late - read it in that order.]" : "" }}`;

const TOOL_FIELD = (id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false });
// booked_phone_number stays in the sub-workflow contract but is FIXED EMPTY on every AI tool:
// a number the customer types is never proof of ownership (the engine refuses it: NEED_STAFF).
const BOOKED_PHONE_EXPR = '';
// The input keeps its technical name patient_name (sub-workflow contract); it holds the customer's name.
const PATIENT_NAME_EXPR = "={{ $fromAI('patient_name', 'Optional. The customer full name if they gave it. It is never used to find or change an appointment.', 'string', '') }}";
// A text that moved through several wordings: replaced by the last one, whichever earlier one is present.
function upgradeText(str, stages, label) {
  const target = stages[stages.length - 1];
  if (str.indexOf(target) >= 0) return str;
  for (let i = stages.length - 2; i >= 0; i--) if (str.indexOf(stages[i]) >= 0) return replaceOnce(str, stages[i], target, label);
  throw new Error('build: anchor not found for ' + label);
}
// Appointments booked from another number / channel / person: never searched, always staff.
const FIND_OWN_TEXT = 'leave appointment_date empty for a normal search. It only ever returns the appointments of this customer (this conversation). If the customer says an appointment was booked from a different phone number, on another channel or by someone else, do not search for it: a phone number or name typed by the customer is never proof that an appointment is theirs - call Escalate_to_Staff.';
const CHANGE_OWN_TEXT = 'It only ever finds the appointments of this customer (this conversation). If the customer says the appointment was booked from a different phone number, on another channel or by someone else, do not call this tool: a phone number or name typed by the customer is never proof of ownership - call Escalate_to_Staff (NEED_STAFF).';

// ------------------------------------------------------------------ salon info (prompt)
// Rendered from salon-info.js + engine/config.js into the "## SALON INFO" section of
// the prompt on every build, so prices/durations/hours have exactly one source.
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hmOf = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
const minOf = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
function salonInfoBlock() {
  const S = SALON;
  const closed = CFG.CLOSED_WEEKDAY >= 0 && CFG.CLOSED_WEEKDAY <= 6;
  const days = closed ? WEEK[(CFG.CLOSED_WEEKDAY + 1) % 7] + ' to ' + WEEK[(CFG.CLOSED_WEEKDAY + 6) % 7] + '. Closed every ' + WEEK[CFG.CLOSED_WEEKDAY] : 'every day, Monday to Sunday';
  const longest = S.services.reduce((a, s) => (s.duration > a.duration ? s : a), S.services[0]);
  const price = (s) => (s.fromPrice ? 'from ' : '') + S.currencySymbol + s.price;
  const cats = [];
  for (const s of S.services) if (cats.indexOf(s.category) < 0) cats.push(s.category);
  const menu = cats.map((c) => c + ':\n' + S.services.filter((s) => s.category === c)
    .map((s) => '- ' + s.name + ' (FR: ' + s.name_fr + ' | ES: ' + s.name_es + ' | AR: ' + s.name_ar + ') - ' + s.duration + ' min - ' + price(s)).join('\n')).join('\n');
  return '## SALON INFO\n' +
    '(generated from salon-info.js and engine/config.js - fictional demo data)\n' +
    '- Salon name: ' + S.name + ' (' + S.name_ar + ') - ' + S.description + '\n' +
    '- This is a DEMO salon: the address, phone, e-mail, prices, durations and policies below are fictional demo values. If a customer asks, say so honestly.\n' +
    '- Opening days: ' + days + ' (a specific date can also be blocked on the salon calendar, e.g. a holiday - Check_Availability reports this as CLOSED_DAY)\n' +
    '- Opening hours: ' + CFG.WORK_START + ' to ' + CFG.WORK_END + '. Every appointment must start at ' + CFG.WORK_START + ' or later and END by ' + CFG.WORK_END + ' (e.g. the ' + longest.duration + '-minute ' + longest.name + ' can start at ' + hmOf(minOf(CFG.WORK_END) - longest.duration) + ' at the latest).\n' +
    '- Address: ' + S.address + '\n' +
    '- Phone: ' + S.phone + '\n' +
    '- E-mail: ' + S.email + '\n' +
    '- Appointments are recommended - encourage the customer to book rather than just walk in.\n\n' +
    '### SERVICES & PRICES (demo price list - the ONLY services, prices and durations you may quote; prices in ' + S.currency + ')\n' + menu + '\n' +
    'Use the service name in the customer\'s language. Durations are the time blocked on the calendar; use them for duration_minutes and for the appointment end time.\n\n' +
    '### SALON POLICIES (demo)\n' + S.policies.map((p) => '- ' + p).join('\n') + '\n\n' +
    '### STYLISTS AND CAPACITY\n' +
    '- The salon calendar is ONE shared agenda: each time slot holds one appointment, and the booking system has no per-stylist schedule. Never offer, name or promise a specific stylist.\n' +
    '- If a customer asks for a particular stylist, say you can add the preference to the booking notes for the team, but you cannot check or guarantee that stylist\'s availability.\n\n';
}
function addToolField(tool, id, expr) {
  const w = tool.parameters.workflowInputs;
  w.value[id] = expr;
  if (!w.schema.some((f) => f.id === id)) w.schema.push(TOOL_FIELD(id));
}

const RESULT_CODES = ' Other possible results: OUTSIDE_HOURS / CLOSED_DAY / PAST_TIME (nothing done - ask for a valid time), BUSY_RETRY (system momentarily busy, nothing done - call this tool again ONCE with the same details), ERROR or ERROR_NEEDS_STAFF (nothing confirmed - never claim success; apologize and call Escalate_to_Staff).';

const LOCK_FAILED = 'Lock Step Failed - Before Release?';
function buildMain(wf) {
  // Dedup runs exactly once per execution, so .first() is unambiguous. .item
  // would have to resolve paired-item lineage back through the lock loop's
  // many runs, which is fragile.
  for (const n of wf.nodes) deepReplace(n.parameters, "$('Dedup & Filter Prep').item.json", "$('Dedup & Filter Prep').first().json");
  // Dedup: expose the WhatsApp timestamp (seconds) for ordering.
  const dedup = must(wf, 'Dedup & Filter Prep');
  if (dedup.parameters.jsCode.indexOf('msgTs:') < 0) {
    dedup.parameters.jsCode = replaceOnce(dedup.parameters.jsCode, '    messageId: msgId,\n', '    messageId: msgId,\n    msgTs: msgTimestamp ? Math.floor(msgTimestamp / 1000) : 0,\n', 'dedup msgTs');
  }

  // Dedup: the channel-aware customer key (wa:<number>) used for the chat lock and the tools.
  dedup.parameters.jsCode = replaceOnce(dedup.parameters.jsCode, '    chatId: from,\n', "    chatId: from,\n    customerKey: from ? 'wa:' + from : '',\n", 'dedup customerKey');
  for (const t of KEY_TOOLS) addToolField(must(wf, t), 'customer_key', CUSTOMER_KEY_EXPR);
  // Pause rows of the other channels (fb:..., ig:...) are never a WhatsApp number.
  const mp = must(wf, 'Match Pause Status');
  mp.parameters.jsCode = replaceOnce(mp.parameters.jsCode, "  const rowPhone = (row.json.Patient_ID || '').toString().replace(/\\D/g, '');\n",
    "  const rowRaw = (row.json.Patient_ID || '').toString().trim();\n  if (/^(fb|ig):/i.test(rowRaw)) continue; // a Messenger / Instagram row is never a WhatsApp number\n  const rowPhone = rowRaw.replace(/\\D/g, '');\n", 'pause rows of other channels');
  // Consecutive-error counter: one per channel-aware customer key.
  const sn = must(wf, 'Sanitize AI Output');
  sn.parameters.jsCode = replaceOnce(sn.parameters.jsCode, "const chatId = $('Dedup & Filter Prep').first().json.chatId;\n",
    "const chatId = $('Dedup & Filter Prep').first().json.customerKey || $('Dedup & Filter Prep').first().json.chatId;\n", 'sanitize counter key');

  const base = [-9104, 4400];
  upsert(wf, { parameters: { jsCode: ACQUIRE_CODE }, name: 'Chat Lock: Acquire', type: 'n8n-nodes-base.code', typeVersion: 2, position: base });
  upsert(wf, { parameters: { jsCode: RELEASE_CODE }, name: 'Chat Lock: Release', type: 'n8n-nodes-base.code', typeVersion: 2, position: [base[0], base[1] + 320] });
  for (const n of engineNodes(wf.name, [base[0] + 224, base[1] + 160], 'done')) upsert(wf, n);
  upsert(wf, { parameters: { rules: { values: [
      rule('lk-acq', "={{ $json.result.op === 'chatAcquire' && $json.result.status === 'ACQUIRED' }}", '', 'acquired', 'boolean'),
      rule('lk-dup', "={{ $json.result.op === 'chatAcquire' && ($json.result.status === 'DUPLICATE' || $json.result.status === 'OVERFLOW') }}", '', 'duplicate', 'boolean'),
      rule('lk-fail', "={{ $json.result.op === 'chatAcquire' && ['ACQUIRED', 'DUPLICATE', 'OVERFLOW'].indexOf($json.result.status) < 0 }}", '', 'lock failed', 'boolean'),
      rule('lk-rel', "={{ $json.result.op === 'chatRelease' }}", '', 'released', 'boolean'),
    ] }, options: {} }, name: 'Engine: Done Router', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [base[0] + 900, base[1] + 420] });
  upsert(wf, { parameters: { jsCode: ACQUIRED_CODE }, name: 'Chat Lock Acquired', type: 'n8n-nodes-base.code', typeVersion: 2, position: [base[0] + 1120, base[1] + 300] });
  upsert(wf, { parameters: {}, name: 'Duplicate Message - Stop', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [base[0] + 1120, base[1] + 440] });
  upsert(wf, { parameters: {}, name: 'Chat Lock Released', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [base[0] + 1120, base[1] + 580] });
  const staff = must(wf, 'Alert Staff - System Error');
  upsert(wf, { parameters: { operation: 'send', phoneNumberId: "={{ $('Dedup & Filter Prep').first().json.phoneNumberId }}", recipientPhoneNumber: "={{ $('Dedup & Filter Prep').first().json.staffChatId }}",
      textBody: "={{ '⚠️ Could not pause the bot for customer ' + $('Dedup & Filter Prep').first().json.chatId + ' after escalation - please reply manually and check the Active_Handoffs sheet.' }}", additionalFields: {} },
    name: 'Alert Staff - Pause Failed', type: 'n8n-nodes-base.whatsApp', typeVersion: 1.1, position: [-5584, 3920], webhookId: uuid(wf.name + '/Alert Staff - Pause Failed'), credentials: staff.credentials, onError: 'continueRegularOutput' });

  // Crash safety net (e.g. the task runner disconnects): a lock-step failure
  // BEFORE the release still answers the patient, alerts staff and releases.
  // A failure DURING the release only stops - the patient was already answered
  // and the lease frees the lock - so this path can never loop. Only non-Code
  // nodes are used here so it works even while the Code runner is down.
  upsert(wf, { parameters: Object.assign(cond('lock-failed-before-release', "={{ !$('Chat Lock: Release').isExecuted }}", '', 'boolean'), { options: {} }),
    name: LOCK_FAILED, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [base[0] + 224, base[1] + 640] });
  upsert(wf, { parameters: {}, name: 'Release Failed - Lease Expires', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [base[0] + 448, base[1] + 720] });
  for (const n of ['Chat Lock: Acquire', 'Chat Lock: Release']) must(wf, n).onError = 'continueErrorOutput';
  conn(wf, LOCK_FAILED, [['Send Fallback Reply'], ['Release Failed - Lease Expires']]);

  // Wiring: every patient-message path now runs inside the chat lock and ends in a release.
  conn(wf, 'Is Valid Staff Unmute?', [['Write Unmute Row'], ['Chat Lock: Acquire']]);
  conn(wf, 'Chat Lock: Acquire', [['Engine: Decide'], [LOCK_FAILED]]);
  conn(wf, 'Chat Lock: Release', [['Engine: Decide'], [LOCK_FAILED]]);
  wireEngine(wf, ['Engine: Done Router'], LOCK_FAILED);
  conn(wf, 'Engine: Done Router', [['Chat Lock Acquired'], ['Duplicate Message - Stop'], ['Send Fallback Reply'], ['Chat Lock Released']]);
  conn(wf, 'Chat Lock Acquired', [['Check Handoff Status'], ['Send Fallback Reply']]);
  conn(wf, 'Match Pause Status', [['Is Paused?'], ['Send Fallback Reply']]);
  conn(wf, 'Rename to .ogg', [['Cohere Transcribe'], ['Send Voice Failed Reply']]);
  conn(wf, 'Check Handoff Status', [['Match Pause Status'], ['Send Fallback Reply']]);
  conn(wf, 'Stay Silent', [['Chat Lock: Release']]);
  conn(wf, 'Send Unsupported Reply', [['Chat Lock: Release']]);
  conn(wf, 'Send Voice Failed Reply', [['Chat Lock: Release']]);
  conn(wf, 'AI Agent', [['Sanitize AI Output'], ['Send Fallback Reply']]);
  conn(wf, 'Send Fallback Reply', [['Alert Staff - System Error']]);
  conn(wf, 'Alert Staff - System Error', [['Chat Lock: Release']]);
  // Sequential tail (no canvas-position-dependent parallel branches): pause is
  // written BEFORE the reply and the lock is released only after both.
  conn(wf, 'Sanitize AI Output', [['Check For Escalation'], ['Send Fallback Reply']]);
  conn(wf, 'Check For Escalation', [['Needs Pause?'], ['Send Fallback Reply']]);
  conn(wf, 'Needs Pause?', [['Write Pause Row'], ['Send WhatsApp Reply']]);
  conn(wf, 'Write Pause Row', [['Send WhatsApp Reply'], ['Alert Staff - Pause Failed']]);
  conn(wf, 'Alert Staff - Pause Failed', [['Send WhatsApp Reply']]);
  conn(wf, 'Send WhatsApp Reply', [['Log Conversation'], ['Alert Staff - System Error']]);
  conn(wf, 'Log Conversation', [['Is Corrupted?']]);
  conn(wf, 'Is Corrupted?', [['Alert Staff - System Error'], ['Chat Lock: Release']]);

  // Confirmation gate: the customer's own next message confirms a cancel / reschedule (server-side).
  addConfirmationGate(wf, ENV.workflows);
  wireConfirmationGate(wf, 'Send Fallback Reply');

  for (const n of ['Send Unsupported Reply', 'Send Voice Failed Reply', 'Send Fallback Reply', 'Alert Staff - System Error', 'Log Conversation']) must(wf, n).onError = 'continueRegularOutput';
  must(wf, 'Send WhatsApp Reply').onError = 'continueErrorOutput';
  // An unexpected throw in these Code nodes must still reply and release the lock.
  for (const n of ['Chat Lock Acquired', 'Match Pause Status', 'Rename to .ogg', 'Sanitize AI Output', 'Check For Escalation']) must(wf, n).onError = 'continueErrorOutput';
  must(wf, 'Write Pause Row').onError = 'continueErrorOutput';
  // Found live (2026-11-24): Check Handoff Status has "Always Output Data" (an empty sheet must
  // still continue) AND an error output. When the Sheets read FAILS, n8n emits the error on the
  // error output (fallback reply, staff alert, lock release) AND an empty item on the main output,
  // so the message was ALSO answered normally - two replies and an early lock release.
  // The pause check stops in that case: the error branch already handles the message.
  const pause = must(wf, 'Match Pause Status');
  const GUARD = "// The Sheets read failed: its error branch answers and releases the lock - never continue here too.\nif ($('Check Handoff Status').all(1).length) return [];\n";
  if (pause.parameters.jsCode.indexOf(GUARD) < 0) pause.parameters.jsCode = GUARD + pause.parameters.jsCode;
  must(wf, 'Send WhatsApp Reply').parameters.textBody = "={{ $('Sanitize AI Output').first().json.output }}";
  must(wf, 'Is Corrupted?').parameters.conditions.conditions[0].leftValue = "={{ $('Sanitize AI Output').first().json.isCorrupted }}";

  const agent = must(wf, 'AI Agent');
  if (agent.parameters.text.indexOf('Chat Lock Acquired') < 0) agent.parameters.text += OOO_NOTE;
  agent.parameters.options.systemMessage = patchPrompt(agent.parameters.options.systemMessage);
  const model = must(wf, 'OpenRouter Chat Model');
  model.parameters.options = Object.assign({}, model.parameters.options, { timeout: 60000, maxRetries: 2 });
  // Voice notes: Cohere needs one fixed language per request (no auto-detection).
  const stt = must(wf, 'Cohere Transcribe').parameters.bodyParameters.parameters;
  const sttParam = (name) => { const x = stt.find((q) => q.name === name); if (!x) throw new Error('build: Cohere Transcribe has no ' + name + ' field'); return x; };
  sttParam('model').value = CFG.VOICE_MODEL;
  sttParam('language').value = CFG.VOICE_LANGUAGE;
  // ...and the AI is told which language voice notes are understood in.
  const voiceRe = /(messageType === 'voice' \? ')((?:[^'\\]|\\.)*)(' : '')/;
  if (!voiceRe.test(agent.parameters.text)) throw new Error('build: AI Agent text has no voice-note marker');
  agent.parameters.text = agent.parameters.text.replace(voiceRe, (m, a, b, c) => a + VOICE_NOTE_TEXT + c);

  // Tool links: always the Lumière tool workflows.
  for (const [tool, key] of [['Check_Availability', 'check'], ['Book_Appointment', 'book'], ['Find_Patient_Appointments', 'find'], ['Cancel_Appointment', 'cancel'], ['Reschedule_Appointment', 'reschedule']]) {
    const w = must(wf, tool).parameters.workflowId;
    w.value = ENV.workflows[key]; w.cachedResultUrl = '/workflow/' + ENV.workflows[key];
  }

  // Tools: the customer is ONLY the verified sender of this conversation. Neither a typed
  // phone number nor a name ever finds or changes an appointment (booked elsewhere -> staff).
  const find = must(wf, 'Find_Patient_Appointments');
  addToolField(find, 'booked_phone_number', BOOKED_PHONE_EXPR);
  find.parameters.workflowInputs.value.patient_name = PATIENT_NAME_EXPR;
  find.parameters.description = upgradeText(find.parameters.description, [
    'leave patient_name and appointment_date empty for a normal search. Only fill in patient_name (and appointment_date if known) when the patient has explicitly said this appointment was booked from a different phone number than the one they are texting from right now.',
    'leave booked_phone_number and appointment_date empty for a normal search. Only fill in booked_phone_number (and appointment_date if known) when the customer has explicitly said this appointment was booked from a different phone number than the one they are texting from right now - a customer name alone is never accepted.',
    FIND_OWN_TEXT], 'find description');
  const cancel = must(wf, 'Cancel_Appointment');
  addToolField(cancel, 'booked_phone_number', BOOKED_PHONE_EXPR);
  cancel.parameters.workflowInputs.value.patient_name = PATIENT_NAME_EXPR;
  cancel.parameters.description = upgradeText(cancel.parameters.description, [
    'If the appointment was booked from a different phone number than the one texting now, pass patient_name instead (leave it empty otherwise) - the tool will then match by name within that date instead of by phone.',
    'If the appointment was booked from a different phone number than the one texting now, pass that exact number as booked_phone_number (leave it empty otherwise) - a customer name alone is never accepted (NEED_BOOKED_PHONE).',
    CHANGE_OWN_TEXT], 'cancel description');
  if (cancel.parameters.description.indexOf('BUSY_RETRY') < 0) cancel.parameters.description += RESULT_CODES;
  const resched = must(wf, 'Reschedule_Appointment');
  addToolField(resched, 'booked_phone_number', BOOKED_PHONE_EXPR);
  resched.parameters.workflowInputs.value.patient_name = PATIENT_NAME_EXPR;
  resched.parameters.description = upgradeText(resched.parameters.description, [
    'If the appointment was booked from a different phone number than the one texting now, pass patient_name instead (leave it empty otherwise) - the tool will then match by name within that date instead of by phone, same as Cancel_Appointment.',
    'If the appointment was booked from a different phone number than the one texting now, pass that exact number as booked_phone_number (leave it empty otherwise) - a customer name alone is never accepted (NEED_BOOKED_PHONE).',
    CHANGE_OWN_TEXT], 'reschedule description');
  if (resched.parameters.description.indexOf('BUSY_RETRY') < 0) resched.parameters.description += RESULT_CODES;
  const book = must(wf, 'Book_Appointment');
  if (book.parameters.description.indexOf('BUSY_RETRY') < 0) book.parameters.description += RESULT_CODES + ' A repeated identical request is detected and never creates a second appointment.';

  const san = must(wf, 'Sanitize AI Output');
  const sc = san.parameters.jsCode;
  if (sc.indexOf('none of its calls returned SUCCESS') < 0) {
    const a = sc.indexOf('  const errorIndicators =');
    const b = sc.indexOf('// Catch claiming "not found"');
    if (a < 0 || b < 0) throw new Error('build: Sanitize anchors not found');
    san.parameters.jsCode = sc.slice(0, a) + `  // A claim is backed only if at least one call of that tool this turn
  // actually returned SUCCESS (a retry after BUSY_RETRY is legitimate).
  for (const check of successClaims) {
    if (check.patterns.some(p => p.test(rawOutput)) && calledTools.has(check.tool)) {
      const obs = steps.filter(s => (s.action?.tool || s.tool) === check.tool).map(s => typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation || ''));
      if (!obs.some(o => /SUCCESS/.test(o))) {
        isCorrupted = true;
        reason = \`claimed \${check.tool} succeeded but none of its calls returned SUCCESS: \${(obs[obs.length - 1] || '').slice(0, 150)}\`;
        break;
      }
    }
  }
}

` + sc.slice(b);
  }
  wf.settings = Object.assign({}, wf.settings, { executionTimeout: CFG.MAIN_EXECUTION_TIMEOUT_S, errorWorkflow: ENV.workflows.error });
  pinOutputs(wf);
}

// The salon prompt is maintained directly in the WhatsApp workflow JSON. The build
// (1) re-renders SALON INFO from salon-info.js + engine/config.js and (2) refuses to
// build if one of the rules the tools and the Messenger/web builds rely on is gone.
// Appointment ownership (2026-11-25): a phone number or name typed by the customer is never proof
// that an appointment is theirs. The old "booked from a different number" procedure (ask for the
// number, search with booked_phone_number) is replaced: never search, never reveal, call staff.
const OWN_ONLY_EXCEPTION = 'EXCEPTION: an appointment booked from a different phone number, on another channel or by someone else can never be found, shown or changed by you - see "If the customer says the appointment was booked from a DIFFERENT phone number" below (a team member handles it).';
const OWN_ONLY_PROCEDURE = 'A customer name or a phone number typed by the customer is NEVER accepted as proof that an appointment is theirs (privacy protection - anyone could type someone else\'s name or number). Only the verified identity of this conversation counts, and the tools only ever find this customer\'s own appointments.\n' +
  '1. Do not ask for the other phone number and do not try to search for the appointment. Never confirm or deny that an appointment exists under another number or name, and never repeat another person\'s details.\n' +
  '2. Tell the customer plainly that from here you can only see and change the appointments booked from this same conversation, and that they can also manage it from the number or conversation it was booked with.\n' +
  '3. Call Escalate_to_Staff (reason: the customer wants to manage an appointment booked elsewhere) so a team member can verify who they are and help.\n' +
  '4. A phone number the customer gives you may still be saved as contact information in the notes of a NEW booking - it never gives access to any appointment.\n';
const NEED_STAFF_RULE = 'NEED_STAFF means the request was about an appointment booked from another number, channel or person: nothing was searched - never ask for or search by another number; call Escalate_to_Staff.';
const PROMPT_OWNERSHIP_EDITS = [
  ['EXCEPTION: if the appointment was booked from a different phone number than the one texting now, phone-based lookup cannot work at all - see WHEN THE CUSTOMER DOESN\'T REMEMBER THE APPOINTMENT DATE/TIME below for the booked_phone_number procedure.', OWN_ONLY_EXCEPTION],
  ['A customer name alone is NEVER accepted to look up or change an appointment (privacy protection - anyone could type someone else\'s name).\n1. Ask for the exact phone number the appointment was booked with (and its date and/or time, if they know it).\n2. Call Find_Patient_Appointments (or Cancel_Appointment/Reschedule_Appointment directly, if you already have a specific confirmed date and time) with booked_phone_number set to that number - leave booked_phone_number empty in every normal case, and only fill it in for this specific situation.\n3. Present and confirm results exactly the same way as above - a numbered list if there are multiple matches, always confirming the specific appointment before acting.\n4. If the customer does not know that number, or nothing is found with it, tell the customer plainly and call Escalate_to_Staff rather than guessing further.\n', OWN_ONLY_PROCEDURE],
  ['NEED_BOOKED_PHONE means you must ask for the phone number the appointment was booked with.', NEED_STAFF_RULE],
];
const REQUIRED_PROMPT_RULES = [
  OWN_ONLY_EXCEPTION,
  OWN_ONLY_PROCEDURE,
  NEED_STAFF_RULE,
  '  - PAST_TIME / PAST_DATE: the requested time or date has already passed - tell the customer and ask for a future time.\n',
  '6. Book_Appointment, Reschedule_Appointment and Cancel_Appointment re-check the live calendar under a lock at the moment of writing',
  '7. PRIVACY: tool results never contain other customers\' names or details',
  'Always pass duration_minutes = the service duration from SERVICES & PRICES',
  'Reschedule_Appointment always keeps the ORIGINAL length of the appointment.',
];
// Older prompt rules told the AI to ask "can you confirm?" itself before calling Cancel /
// Reschedule. With the server-side confirmation gate that means asking twice, and in live
// tests the AI then only ANNOUNCED the change ("the system will ask you") instead of
// calling the tool. They now say: identify the appointment, then call the tool.
const PROMPT_CONFIRM_EDITS = [
  ['2. State the exact date and time of the specific appointment you are about to cancel, and explicitly ask the customer to confirm - e.g. "Voy a cancelar tu cita del [fecha] a las [hora]. ¿Me confirmas que es esa?" / "I\'ll cancel your appointment on [date] at [time] - can you confirm that\'s the right one?"\n3. Only call Cancel_Appointment after the customer explicitly confirms. If they have more than one appointment, list them and ask which one.',
    '2. Make sure you know WHICH appointment: if the customer has more than one, list them and ask which one.\n3. Then call Cancel_Appointment right away. The system itself reads the appointment back to the customer and deletes nothing until they answer Yes (see CONFIRMATION OF CANCELLATIONS AND RESCHEDULES IS DONE BY THE SYSTEM). Do not ask "can you confirm?" yourself and do not announce a confirmation step.'],
  ['Additionally, before calling Reschedule_Appointment, always state the full new date AND time back to the customer and wait for their explicit confirmation - the same way Cancel_Appointment already requires. A reschedule landing on the wrong slot is just as consequential as a wrongful cancellation.',
    'Once both are known and Check_Availability says the new time is free, call Reschedule_Appointment right away. The system itself states the old and the new date and time to the customer and moves nothing until they answer Yes. Do not ask for the confirmation yourself and do not announce it.'],
  ['- If it returns exactly one appointment: state its date, time, and service back to the customer and ask them to confirm before you act - do not silently proceed.',
    '- If it returns exactly one appointment: state its date, time and service. If the customer asked to cancel or move it, call Cancel_Appointment / Reschedule_Appointment for it right away (the system asks them for the final Yes).'],
];
function patchPrompt(p) {
  for (const [from, to] of PROMPT_CONFIRM_EDITS) p = replaceOnce(p, from, to, 'prompt confirmation rule');
  for (const [from, to] of PROMPT_OWNERSHIP_EDITS) p = replaceOnce(p, from, to, 'prompt ownership rule');
  for (const r of REQUIRED_PROMPT_RULES) if (p.indexOf(r) < 0) throw new Error('build: the AI prompt lost a required rule: ' + r.slice(0, 80));
  if (/booked_phone_number|NEED_BOOKED_PHONE/.test(p)) throw new Error('build: the AI prompt still describes searching by a customer-provided phone number');
  const a = p.indexOf('## SALON INFO\n');
  const b = p.indexOf('## IMPORTANT TOOL RULES:');
  if (a < 0 || b < a || p.indexOf('## SALON INFO\n', a + 1) >= 0) throw new Error('build: prompt needs exactly one "## SALON INFO" section before "## IMPORTANT TOOL RULES:"');
  return p.slice(0, a) + salonInfoBlock() + CONFIRM_PROMPT_BLOCK + p.slice(b);
}

// ------------------------------------------------------------------ run
function build() {
  const out = {};
  const main = load(FILES.main); buildMain(main); out.main = main;
  const book = load(FILES.book); buildToolWorkflow(book, 'book', ['customer_key']); out.book = book;
  const cancel = load(FILES.cancel); buildToolWorkflow(cancel, 'cancel', ['patient_name', 'booked_phone_number'].concat(CONFIRM_INPUTS, ['customer_key'])); out.cancel = cancel;
  const res = load(FILES.reschedule); buildToolWorkflow(res, 'reschedule', ['patient_name', 'booked_phone_number'].concat(CONFIRM_INPUTS, ['customer_key'])); out.reschedule = res;

  const find = load(FILES.find);
  const ft = must(find, 'Execute Workflow Trigger');
  for (const n of ['booked_phone_number', 'customer_key']) if (!ft.parameters.workflowInputs.values.some((v) => v.name === n)) ft.parameters.workflowInputs.values.push({ name: n });
  must(find, 'Match & Format').parameters.jsCode = withEngine(FIND_GLUE);
  setCalendar(must(find, 'Find Upcoming Events'));
  out.find = find;

  const check = load(FILES.check);
  must(check, 'Compute Availability').parameters.jsCode = withEngine(CHECK_GLUE);
  setCalendar(must(check, "Find That Day's Events"));
  out.check = check;

  // Error workflow (staff alert on crashes) - built here too so it uses the salon's credentials and env vars.
  out.error = load(ERROR_WORKFLOW_FILE);

  // Salon environment: own IDs, credentials, sheet, env vars and timezone everywhere.
  // Always exported INACTIVE: importing never switches anything on (you publish after setup).
  for (const k of Object.keys(out)) {
    const wf = out[k];
    wf.id = ENV.workflows[k]; wf.active = false; applyEnvironment(wf);
    // Fresh node and webhook ids (never the ids inherited from the clinic export).
    for (const n of wf.nodes) {
      n.id = uuid('lumiere/' + wf.id + '/' + n.name);
      if (n.webhookId) n.webhookId = uuid('lumiere/' + wf.id + '/' + n.name + '/webhook');
    }
  }
  // The 5 calendar tools must be published to be callable (n8n 2.x): only the salon's
  // WhatsApp, Messenger and Instagram parents may call them.
  for (const k of TOOL_KEYS) Object.assign(out[k].settings = out[k].settings || {}, { callerPolicy: 'workflowsFromAList', callerIds: [ENV.workflows.main, ENV.workflows.messenger, ENV.workflows.instagram].join(',') });
  return out;
}

// Every file this script writes (all inside this project folder).
const OUTPUT_FILES = Object.assign({}, FILES, { error: ERROR_WORKFLOW_FILE });
if (require.main === module) {
  const built = build();
  const checkOnly = process.argv.includes('--check');
  let changed = 0;
  for (const k of Object.keys(OUTPUT_FILES)) {
    const file = path.join(ROOT, OUTPUT_FILES[k]);
    const next = dump(built[k]);
    const prev = fs.readFileSync(file, 'utf8');
    if (prev !== next) { changed++; if (!checkOnly) fs.writeFileSync(file, next); console.log((checkOnly ? 'WOULD CHANGE: ' : 'updated: ') + OUTPUT_FILES[k]); }
  }
  console.log(changed ? changed + ' file(s) ' + (checkOnly ? 'out of date' : 'written') : 'all workflows up to date');
  if (checkOnly && changed) process.exit(1);
}
module.exports = { build, FILES, OUTPUT_FILES, ERROR_WORKFLOW_FILE, ROOT, engineSource, confirmSource, pinOutputs, CONFIRM_PROMPT_BLOCK, TOOL_KEYS, addConfirmationGate, wireConfirmationGate, CONFIRM_INPUTS, CUSTOMER_KEY_EXPR, KEY_TOOLS, replaceOnce, FIND_OWN_TEXT, CHANGE_OWN_TEXT, CFG, ENV, SALON, salonInfoBlock, LANG_NAMES, VOICE_MODELS, checkTimezone };
