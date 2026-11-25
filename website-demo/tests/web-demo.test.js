'use strict';
// Executable tests for the "Lumière Salon - Website Demo" workflows. They run
// the REAL generated JSON with the project's n8n emulator (tests/lib) against a
// fake Google Calendar and a scripted AI agent.
// Run: node website-demo/tests/web-demo.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const LIB = path.resolve(__dirname, '..', '..', 'tests', 'lib');
const { Runner } = require(path.join(LIB, 'runner.js'));
const { Sim } = require(path.join(LIB, 'sim.js'));
const { FakeCalendar } = require(path.join(LIB, 'fake-calendar.js'));
const { test, runTests } = require(path.join(LIB, 't.js'));
const BUILD = require('../build-web-demo.js');
const DEMO = require('../demo-config.js');
const WB = require('../../tools/build-workflows.js');
// The website demo may only use its own credentials (lumiere.config.js websiteDemo.credentials).
const DEMO_CRED_KEYS = new Set(Object.values(require('../../lumiere.config.js').websiteDemo.credentials).map((c) => c.id + '|' + c.name));

const DIR = path.resolve(__dirname, '..');
const CAL = 'demo-cal@group.calendar.google.com';
const ORIGIN = 'https://hamzamihoubi.com';
const START = Date.UTC(2026, 9, 5, 7, 0, 0); // Monday 2026-10-05 08:00 salon time (UTC+1)
const TOOL_NODE = { check: 'Check_Availability', book: 'Book_Appointment', find: 'Find_Patient_Appointments', cancel: 'Cancel_Appointment', reschedule: 'Reschedule_Appointment' };

const raw = {};
for (const k of Object.keys(BUILD.WF)) raw[k] = fs.readFileSync(path.join(DIR, BUILD.WF[k].file), 'utf8');
// Tests use their own fake calendar id instead of the one in demo-config.js.
const PASTE = 'PASTE_LUMIERE_DEMO_CALENDAR_ID@group.calendar.google.com';
const withCal = (text, cal) => text.split(DEMO.tool.CALENDAR_ID).join(cal).split(PASTE).join(cal);
const WFS = {}; for (const k of Object.keys(raw)) WFS[k] = JSON.parse(withCal(raw[k], CAL));
const UNCONFIGURED_MAIN = JSON.parse(withCal(raw.main, PASTE));
// Same demo, with an optional break configured in DEMO CONFIG (the default demo has none).
const BREAK_MAIN = JSON.parse(withCal(raw.main, CAL));
{
  const n = BREAK_MAIN.nodes.find((x) => x.name === 'DEMO CONFIG');
  const before = n.parameters.jsCode;
  n.parameters.jsCode = before.replace('"LUNCH_START": ""', '"LUNCH_START": "13:00"').replace('"LUNCH_END": ""', '"LUNCH_END": "14:00"');
  assert.notStrictEqual(n.parameters.jsCode, before, 'test setup: break fields not found in DEMO CONFIG');
}

function makeEnv(o) {
  o = o || {};
  const sim = new Sim(o.start || START, o.seed);
  return { sim, cal: new FakeCalendar(sim, o.cal), persisted: new Map(), envVars: {}, opts: { staticBroken: false, itemLinkBroken: false, enforceTimeout: false },
    responses: [], aiCalls: [], toolCalls: [], ai: o.ai || {}, main: o.main || WFS.main };
}

// ---- tool sub-workflows
// The tool schema n8n builds from the $fromAI() calls of a tool node: a field WITHOUT a
// default value (4th argument) is REQUIRED, and n8n rejects the whole tool call when the
// AI leaves a required field out (the AI Agent then fails -> the visitor gets the fallback).
function fromAiSchema(node) {
  const fields = {};
  for (const [field, expr] of Object.entries(node.parameters.workflowInputs.value)) {
    if (typeof expr !== 'string' || expr.indexOf('$fromAI(') < 0) continue;
    const body = expr.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    new Function('$fromAI', 'return (' + body + ');')(function (name, desc, type, def) {
      fields[field] = { name, required: arguments.length < 4, def: arguments.length < 4 ? undefined : def };
      return '';
    });
  }
  return fields;
}
async function runTool(env, agentRun, key, aiArgs) {
  const node = agentRun.wf.nodes.find((n) => n.name === TOOL_NODE[key]);
  const ctx = agentRun.exprCtx({ json: {} }, 0, [{ json: {} }]);
  const schema = fromAiSchema(node);
  for (const [field, f] of Object.entries(schema)) {
    if (f.required && aiArgs[field] == null) throw new Error('Received tool input did not match expected schema\n\n✖ Required\n  → at ' + f.name);
  }
  const inputs = {};
  for (const [field, expr] of Object.entries(node.parameters.workflowInputs.value)) {
    inputs[field] = schema[field] ? (aiArgs[field] != null ? aiArgs[field] : schema[field].def) : agentRun.evalExpr(expr, ctx);
  }
  const wfId = node.parameters.workflowId.value;
  const subKey = Object.keys(BUILD.WF).find((k) => BUILD.WF[k].id === wfId);
  assert.ok(subKey, 'tool ' + TOOL_NODE[key] + ' points at an unknown workflow ' + wfId);
  const r = new Runner(WFS[subKey], { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks: {
    http: (req) => env.cal.request(req), nodes: {},
    types: { 'n8n-nodes-base.googleCalendar': (items, run, n) => googleCalendarNode(env, run, n, items) },
  } });
  const res = await r.run('Execute Workflow Trigger', [{ json: inputs }]);
  if (res.error) throw res.error;
  const result = res.output && res.output[0] && res.output[0].json.result;
  env.toolCalls.push({ key, inputs, result });
  return { action: { tool: TOOL_NODE[key] }, observation: result };
}
async function googleCalendarNode(env, run, node, items) {
  const p = node.parameters;
  const ctx = run.exprCtx(items[0], 0, items);
  const cal = run.evalExpr(p.calendar.value, ctx);
  const tMin = run.evalExpr(p.options.timeMin, ctx), tMax = run.evalExpr(p.options.timeMax, ctx);
  run.evalExpr(p.options.timeZone.value, ctx);
  const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal) + '/events?timeMin=' + encodeURIComponent(new Date(tMin).toISOString()) + '&timeMax=' + encodeURIComponent(new Date(tMax).toISOString()) + '&maxResults=2500';
  const r = await env.cal.request({ method: 'GET', url, timeout: 10000 });
  if (r.statusCode !== 200) throw new Error('calendar ' + r.statusCode);
  const evs = r.body.items || [];
  return evs.length ? evs.map((e) => ({ json: e })) : (node.alwaysOutputData ? [{ json: {} }] : []);
}

// ---- main workflow
function mainHooks(env) {
  return {
    http: (req) => { if (req.url.indexOf('googleapis.com/calendar') >= 0) return env.cal.request(req); throw new Error('unexpected http ' + req.url); },
    nodes: {},
    types: {
      // Execute Workflow (confirmation gate): runs the demo tool sub-workflow with the node's mapped inputs.
      'n8n-nodes-base.executeWorkflow': async (items, run, node) => {
        const ctx = run.exprCtx(items[0], 0, items);
        const inputs = {};
        for (const [field, expr] of Object.entries(node.parameters.workflowInputs.value)) inputs[field] = run.evalExpr(expr, ctx);
        const subKey = Object.keys(BUILD.WF).find((k) => BUILD.WF[k].id === node.parameters.workflowId.value);
        assert.ok(subKey, node.name + ' points at an unknown workflow ' + node.parameters.workflowId.value);
        const r = new Runner(WFS[subKey], { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks: {
          http: (req) => env.cal.request(req), nodes: {}, types: { 'n8n-nodes-base.googleCalendar': (its, rr, n) => googleCalendarNode(env, rr, n, its) } } });
        const res = await r.run('Execute Workflow Trigger', [{ json: inputs }]);
        if (res.error) throw res.error;
        const result = res.output && res.output[0] && res.output[0].json.result;
        env.toolCalls.push({ key: subKey, inputs, result, exec: true });
        return [[{ json: (res.output && res.output[0] && res.output[0].json) || {} }]];
      },
      'n8n-nodes-base.webhook': (items) => [items],
      'n8n-nodes-base.scheduleTrigger': (items) => [items],
      'n8n-nodes-base.respondToWebhook': (items, run, node) => {
        const ctx = run.exprCtx(items[0], 0, items);
        const code = Number(run.evalExpr(node.parameters.options.responseCode, ctx));
        const body = JSON.parse(run.evalExpr(node.parameters.responseBody, ctx));
        env.responses.push({ exec: run.execId, node: node.name, code, body });
        return [items];
      },
      '@n8n/n8n-nodes-langchain.agent': async (items, run, node) => {
        const ctx = run.exprCtx(items[0], 0, items);
        const prompt = run.evalExpr(node.parameters.text, ctx);
        const system = run.evalExpr(node.parameters.options.systemMessage, ctx);
        const memKey = run.evalExpr(run.wf.nodes.find((n) => n.name === 'Simple Memory').parameters.sessionKey, ctx);
        const call = { text: items[0].json.userText, prompt, system, memKey, exec: run.execId };
        env.aiCalls.push(call);
        const behave = (env.ai.behave && env.ai.behave(call, run)) || {};
        await env.sim.sleep(behave.thinkMs != null ? behave.thinkMs : 3000);
        if (behave.fail) throw new Error('LLM provider error');
        const steps = [];
        for (const t of behave.tools || []) steps.push(await runTool(env, run, t[0], t[1]));
        return [{ json: { output: typeof behave.output === 'function' ? behave.output(steps) : (behave.output || 'OK'), intermediateSteps: steps } }];
      },
    },
  };
}
function webItem(body, o) {
  o = o || {};
  return { json: { headers: Object.assign({ origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': o.ip || '203.0.113.7' }, o.headers || {}), params: {}, query: {}, body } };
}
let SEQ = 0;
const sid = () => 'session-' + (++SEQ) + '-abcdef12';
async function send(env, body, o) {
  const r = new Runner(env.main, { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks: mainHooks(env) });
  const p = r.run('Website Webhook', [webItem(body, o)]);
  await env.sim.run();
  const res = await p;
  if (res.error) throw res.error;
  const mine = env.responses.filter((x) => x.exec === r.execId);
  assert.strictEqual(mine.length, 1, 'every website request gets exactly one response, got ' + mine.length + ' (' + mine.map((m) => m.node).join(', ') + ')');
  return Object.assign({ runner: r }, mine[0]);
}
const msg = (sessionId, message, lang) => ({ sessionId, message, lang: lang || 'en', channel: 'web' });
const events = (env) => [...env.cal.store(CAL).values()].map((e) => e.cur).filter((e) => e.status !== 'cancelled' && !/^lumdemo(lock|rl)/.test(e.id)); // appointments only (no lock / rate-limit counter objects)
const lockHeld = (env) => [...env.cal.store(CAL).values()].map((e) => e.cur).filter((e) => /^lumdemolockchat/.test(e.id)).some((e) => { try { return !!JSON.parse(e.description).h && JSON.parse(e.description).hx > env.sim.now; } catch (x) { return false; } });
const T = DEMO.texts;
// The length is never sent: the engine computes it from service_keys (a key or the catalogue name). `end` documents the expected end.
const bookArgs = (date, start, end, summary, service) => ({ start_datetime: date + 'T' + start + ':00', summary, service_keys: service });

// ================================================================= static
test('S1 six workflows: names, fixed demo ids, inactive, no execution data saved', () => {
  const realIds = ['otherWf000000001', 'otherWf000000002', 'otherWf000000003', 'otherWf000000004', 'otherWf000000005', 'otherWf000000006', 'otherWf000000007', 'otherWf000000008', 'otherWf000000009', 'otherWf000000010', 'otherWf000000011', 'otherWf000000012', 'otherWf000000013',
    'othWebDemoMain01', 'othWebDemoBook01', 'othWebDemoCanc01', 'othWebDemoResc01', 'othWebDemoFind01', 'othWebDemoChck01',
    'lumWhatsAppMain1', 'lumBookAppoint01', 'lumCancelAppt001', 'lumReschedAppt01', 'lumFindAppts0001', 'lumCheckAvail001', 'lumMessengerMain'];
  for (const k of Object.keys(BUILD.WF)) {
    const wf = JSON.parse(raw[k]);
    assert.strictEqual(wf.name, BUILD.WF[k].name);
    assert.strictEqual(wf.id, BUILD.WF[k].id);
    assert.ok(realIds.indexOf(wf.id) < 0, 'id collides with a WhatsApp/Messenger workflow');
    assert.strictEqual(wf.active, false);
    assert.strictEqual(wf.settings.saveDataSuccessExecution, 'none');
    assert.strictEqual(wf.settings.saveDataErrorExecution, 'none');
    assert.strictEqual(wf.settings.saveManualExecutions, false);
    assert.ok(!wf.settings.errorWorkflow, 'no error workflow (the WhatsApp one alerts staff on WhatsApp)');
    assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote'), k + ' has sticky notes');
  }
});
test('S2 graph: every connection, $() reference and tool link resolves; Code nodes compile; toggles are literal', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const k of Object.keys(BUILD.WF)) {
    const wf = JSON.parse(raw[k]);
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.strictEqual(names.size, wf.nodes.length, 'unique node names in ' + k);
    assert.strictEqual(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length, 'unique node ids in ' + k);
    if (k !== 'main') {
      // Tools are published so the parent can call them: only the demo parent may, and nothing else can start them.
      assert.deepStrictEqual([wf.settings.callerPolicy, wf.settings.callerIds], ['workflowsFromAList', BUILD.WF.main.id], k + ' caller restriction');
      assert.deepStrictEqual(wf.nodes.filter((n) => /trigger|webhook|schedule/i.test(n.type)).map((n) => n.type), ['n8n-nodes-base.executeWorkflowTrigger'], k + ' triggers');
    }
    for (const [src, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(src), k + ': connection from unknown node ' + src);
      for (const outs of Object.values(c)) for (const o of outs) for (const x of o || []) assert.ok(names.has(x.node), k + ': connection to unknown node ' + x.node);
    }
    const text = JSON.stringify(wf.nodes.map((n) => n.parameters));
    for (const m of text.matchAll(/\$\('([^']+)'\)/g)) assert.ok(names.has(m[1]), k + ': reference to unknown node ' + m[1]);
    for (const n of wf.nodes) {
      if (n.type === 'n8n-nodes-base.code') new AsyncFunction('$input', '$', '$json', '$getWorkflowStaticData', '$execution', 'DateTime', '$now', n.parameters.jsCode);
      if (n.type === 'n8n-nodes-base.httpRequest') for (const t of ['sendBody', 'sendHeaders']) if (t in n.parameters) assert.strictEqual(typeof n.parameters[t], 'boolean', k + '/' + n.name + ' ' + t + ' must be literal');
      for (const c of Object.values(n.credentials || {})) assert.ok(DEMO_CRED_KEYS.has(c.id + '|' + c.name), k + '/' + n.name + ' uses a non-demo credential ' + c.name);
    }
  }
  const main = JSON.parse(raw.main);
  for (const key of Object.keys(TOOL_NODE)) {
    const t = main.nodes.find((n) => n.name === TOOL_NODE[key]);
    assert.strictEqual(t.parameters.workflowId.value, BUILD.WF[key].id, TOOL_NODE[key] + ' links to the demo tool');
    assert.ok('demo_config' in t.parameters.workflowInputs.value);
    if ('booked_phone_number' in t.parameters.workflowInputs.value) assert.strictEqual(t.parameters.workflowInputs.value.booked_phone_number, '');
  }
  assert.ok('service_keys' in main.nodes.find((n) => n.name === 'Check_Availability').parameters.workflowInputs.value, 'Check_Availability takes the service keys');
  assert.ok(!('duration_minutes' in main.nodes.find((n) => n.name === 'Check_Availability').parameters.workflowInputs.value), 'the AI never sends a duration');
  const hook = main.nodes.find((n) => n.name === 'Website Webhook');
  assert.strictEqual(hook.parameters.httpMethod, 'POST');
  assert.strictEqual(hook.parameters.path, BUILD.WEBHOOK_PATH, 'webhook path from lumiere.config.js');
  assert.notStrictEqual(hook.parameters.path, 'other-website-demo', 'must not share the clinic website demo webhook');
  assert.strictEqual(hook.parameters.responseMode, 'responseNode');
  assert.strictEqual(hook.parameters.options.allowedOrigins, ORIGIN);
  for (const gone of ['WhatsApp Trigger', 'Send WhatsApp Reply', 'Escalate to Staff', 'Log Conversation', 'Get Clinic Info', 'Cohere Transcribe']) assert.ok(!main.nodes.some((n) => n.name === gone), gone + ' removed');
});
test('S3 build is reproducible and the audit finds no clinic data', () => {
  const files = BUILD.build();
  for (const k of Object.keys(BUILD.WF)) assert.strictEqual(files[BUILD.WF[k].file], raw[k], BUILD.WF[k].file + ' is up to date');
});
test('S4 salon values live only in DEMO CONFIG (engine literal has none)', () => {
  for (const k of ['CALENDAR_ID', 'WORK_START', 'WORK_END', 'CLOSED_WEEKDAY', 'TIMEZONE', 'APPT_DEFAULT_MIN']) assert.ok(!(k in BUILD.ENGINE_LITERAL), k + ' must not be hardcoded in the engine nodes');
  for (const k of Object.keys(BUILD.WF)) {
    const wf = JSON.parse(raw[k]);
    for (const n of wf.nodes) {
      if (n.name === 'DEMO CONFIG' || n.type === 'n8n-nodes-base.stickyNote') continue;
      const s = JSON.stringify(n.parameters);
      for (const v of ['Avenue de la Lumière', '+00 000 000 000', '€140', 'lumiere-salon.example', '"19:00"', '"09:00"']) assert.ok(s.indexOf(v) < 0, k + '/' + n.name + ' hardcodes ' + v);
    }
  }
});

test('S5 language and style rules are the WhatsApp prompt\'s, word for word', () => {
  const realPrompt = JSON.parse(fs.readFileSync(path.join(DIR, '..', WB.FILES.main), 'utf8'))
    .nodes.find((n) => n.name === 'AI Agent').parameters.options.systemMessage;
  const demoPrompt = JSON.parse(raw.main).nodes.find((n) => n.name === 'AI Agent').parameters.options.systemMessage;
  const section = (p, from, to) => { const a = p.indexOf(from), b = p.indexOf(to, a); assert.ok(a >= 0 && b > a, 'section ' + from); return p.slice(a, b); };
  for (const [from, to] of [['## PERSONALITY', '##CRITICAL RULES'], ['## LANGUAGE CONSTRAINTS', '##CRITICAL NAME COLLECTION RULE'],
    ['## NAME SPELLING CONSISTENCY', '## GENDER-NEUTRAL WORDING'], ['## GENDER-NEUTRAL WORDING (CRITICAL)', '##CORRECTION CONFIRMATION RULE'],
    ['## CALENDAR CHEAT SHEET', '## STRICT CALENDAR DAY CALCULATION'], ['## NO INTERIM', '## VOICE TRANSCRIPTION FAILURE'], ['## STOP CONDITIONS', '## WHEN TO ESCALATE']]) {
    const real = section(realPrompt, from, to).replace(/setZone\('[^']+'\)/g, () => 'setZone(' + "$('DEMO CONFIG').first().json" + '.tool.TIMEZONE)');
    assert.strictEqual(section(demoPrompt, from, to), real, from + ' differs from the WhatsApp prompt');
  }
  assert.ok(/English -> English/.test(demoPrompt) && /Spanish -> Spanish/.test(demoPrompt) && /Arabic -> Modern Standard Arabic/.test(demoPrompt), 'demo language rule present');
  assert.ok(!/darija/i.test(demoPrompt) && !/الدارجة/.test(demoPrompt), 'no Darija rules left');
});

test('S6 the visitor\'s language is detected from each message (English, French, Spanish, Arabic)', async () => {
  const cases = {
    "Hi! I'd like to book a haircut for tomorrow.": 'English - reply in English',
    'How much does balayage cost?': 'English - reply in English',
    'Do you have any availability this Saturday?': 'English - reply in English',
    "I'd like to reschedule my appointment.": 'English - reply in English',
    'Can you tell me about your hair treatments?': 'English - reply in English',
    'Hola, ¿tenéis disponibilidad para un corte de pelo mañana?': 'Spanish - reply in natural, standard Spanish',
    'hola q tal, cuanto cuesta un tinte': 'Spanish - reply in natural, standard Spanish',
    'Bonjour, je voudrais prendre rendez-vous pour une coloration.': 'French - reply in French',
    'slt vous êtes ouverts samedi ?': 'French - reply in French',
    'أريد حجز موعد لقص الشعر': 'Arabic letters',
    'ok': 'no clear language',
  };
  for (const [m, want] of Object.entries(cases)) {
    const env = makeEnv({ ai: { behave: () => ({ thinkMs: 10, output: 'OK' }) } });
    await send(env, msg(sid(), m, 'fr'));
    assert.ok(env.aiCalls[0].prompt.indexOf(want) >= 0, m + ' -> ' + env.aiCalls[0].prompt.split('\n')[1]);
  }
});

// ================================================================= validation, limits, safety
test('V1 bad requests are rejected before any AI call', async () => {
  const env = makeEnv();
  const s = sid();
  const cases = [
    [msg(s, 'Hello'), { headers: { origin: 'https://evil.example' } }, 403],
    [{ message: 'x', lang: 'en', channel: 'web' }, null, 400],
    [msg(s, 'Hello', 'darija'), null, 400],
    [msg(s, 'Hello', 'de'), null, 400],
    [Object.assign(msg(s, 'Hello'), { channel: 'whatsapp' }), null, 400],
    [msg(s, '   '), null, 400],
    [msg(s, 'x'.repeat(501)), null, 413],
    [Object.assign(msg(s, 'Hello'), { pad: 'y'.repeat(5000) }), null, 413],
    ['not json', null, 400],
    [msg('bad id with spaces', 'Hello'), null, 400],
  ];
  for (const [body, o, code] of cases) {
    const r = await send(env, body, o);
    assert.strictEqual(r.code, code, JSON.stringify(body).slice(0, 60) + ' -> ' + r.code);
    assert.strictEqual(r.node, 'Respond: Rejected');
  }
  assert.strictEqual(env.aiCalls.length, 0);
  for (const lang of ['en', 'fr', 'es', 'ar']) assert.strictEqual((await send(env, msg(sid(), 'x'.repeat(500), lang), null)).code, 200, lang + ': 500 characters are accepted');
});
test('V2 the workflow refuses to run while the demo calendar is not set (503)', async () => {
  const env = makeEnv({ main: UNCONFIGURED_MAIN });
  const r = await send(env, msg(sid(), 'Hello'));
  assert.strictEqual(r.code, 503);
  assert.strictEqual(env.aiCalls.length, 0);
});
test('V3 rate limits: 30 messages per session per hour, 60 per IP per hour', async () => {
  const env = makeEnv({ ai: { behave: () => ({ thinkMs: 10, output: 'OK' }) } });
  const a = sid();
  for (let i = 0; i < 30; i++) assert.strictEqual((await send(env, msg(a, 'm' + i))).node, 'Respond: Reply');
  const lim = await send(env, msg(a, 'one more'));
  assert.strictEqual(lim.node, 'Respond: Notice');
  assert.strictEqual(lim.body.reply, T.en.rateLimited);
  assert.strictEqual((await send(env, msg(sid(), 'other session'), { ip: '198.51.100.9' })).node, 'Respond: Reply', 'other sessions unaffected');
  const env2 = makeEnv({ ai: { behave: () => ({ thinkMs: 10, output: 'OK' }) } });
  let last;
  for (let i = 0; i < 61; i++) last = await send(env2, msg(sid(), 'hi'), { ip: '192.0.2.1' });
  assert.strictEqual(last.node, 'Respond: Notice', '61st message from one IP is limited');
  env2.sim.now += 3600001;
  assert.strictEqual((await send(env2, msg(sid(), 'hi'), { ip: '192.0.2.1' })).node, 'Respond: Reply', 'limit resets after an hour');
});
test('V4 health questions and "talk to a human" get the scripted text, without the AI', async () => {
  const env = makeEnv();
  const cases = [
    ['I had an allergic reaction after my colour, what medication should I take?', 'en', T.en.medical],
    ['¿Qué medicamento tomo para una quemadura del tinte?', 'es', T.es.medical],
    ['Quel médicament prendre pour une brûlure au cuir chevelu ?', 'fr', T.fr.medical],
    ['ما هو الدواء المناسب لحساسية الجلد؟', 'ar', T.ar.medical],
    ['I want to talk to a real person', 'en', T.en.human],
    ['Quiero hablar con una persona', 'es', T.es.human],
    ['Je veux parler à un humain', 'fr', T.fr.human],
  ];
  for (const [text, lang, want] of cases) {
    const r = await send(env, msg(sid(), text, lang));
    assert.strictEqual(r.node, 'Respond: Notice', text);
    assert.strictEqual(r.body.reply, want);
  }
  assert.strictEqual(env.aiCalls.length, 0);
  const env2 = makeEnv({ ai: { behave: () => ({ thinkMs: 10, output: 'Which day suits you?' }) } });
  const r = await send(env2, msg(sid(), "I'd like to book an appointment, my scalp has a small rash"));
  assert.strictEqual(r.node, 'Respond: Reply', 'a booking request that mentions a health word goes to the AI');
  for (const harmless of ['Can you tell me about your hair treatments?', 'How much does balayage cost?', '¿Tenéis tratamientos de keratina?']) {
    const r3 = await send(env2, msg(sid(), harmless));
    assert.strictEqual(r3.node, 'Respond: Reply', 'service question must reach the AI: ' + harmless);
  }
});
test('V5 nothing personal is stored: static data has no message, sessionId or IP', async () => {
  const env = makeEnv({ ai: { behave: () => ({ thinkMs: 10, output: 'OK' }) } });
  const s = 'secret-session-123456';
  await send(env, msg(s, 'My real name is Zorglub Secret'), { ip: '203.0.113.250' });
  const dumpStatic = JSON.stringify([...env.persisted.values()]);
  for (const bad of ['Zorglub', s, '203.0.113.250']) assert.ok(dumpStatic.indexOf(bad) < 0, 'static data contains ' + bad);
});

// ----------------------------------------------------------------- public-demo safety
// Same demo with a tiny overall budget, to test the global caps quickly.
const GLOBAL_MAIN = JSON.parse(withCal(raw.main, CAL));
{
  const n = GLOBAL_MAIN.nodes.find((x) => x.name === 'DEMO CONFIG');
  const before = n.parameters.jsCode;
  n.parameters.jsCode = before.replace(/"GLOBAL_MSGS_PER_HOUR": \d+/, '"GLOBAL_MSGS_PER_HOUR": 5').replace(/"GLOBAL_MSGS_PER_DAY": \d+/, '"GLOBAL_MSGS_PER_DAY": 8');
  assert.notStrictEqual(n.parameters.jsCode, before, 'test setup: global caps not found in DEMO CONFIG');
}
test('V6 faked IP headers and new session ids do not get around the per-IP limit', async () => {
  const env = makeEnv({ ai: { behave: () => ({ thinkMs: 10, output: 'OK' }) } });
  // The proxy in front of n8n (ngrok / a tunnel) APPENDS the real client IP to X-Forwarded-For;
  // everything before it, and cf-connecting-ip / x-real-ip, can be written by the client itself.
  const spoof = (i) => ({ headers: { 'x-forwarded-for': '10.9.' + (i % 250) + '.1, 192.0.2.77', 'cf-connecting-ip': '10.8.' + (i % 250) + '.1', 'x-real-ip': '10.7.' + (i % 250) + '.1' } });
  let last;
  for (let i = 0; i < 61; i++) last = await send(env, msg(sid(), 'hi'), spoof(i));
  assert.strictEqual(last.node, 'Respond: Notice', 'the 61st message from the same real IP is limited');
  assert.strictEqual(last.body.reply, T.en.rateLimited);
  assert.strictEqual(env.aiCalls.length, 60);
  assert.strictEqual((await send(env, msg(sid(), 'hi'), { ip: '192.0.2.78' })).node, 'Respond: Reply', 'another real IP is unaffected');
});
test('V7 overall budget: an hourly and a daily cap on AI replies across all visitors', async () => {
  const env = makeEnv({ main: GLOBAL_MAIN, ai: { behave: () => ({ thinkMs: 10, output: 'OK' }) } });
  const fresh = (i) => ({ ip: '198.51.100.' + i });
  for (let i = 1; i <= 5; i++) assert.strictEqual((await send(env, msg(sid(), 'hi'), fresh(i))).node, 'Respond: Reply', 'message ' + i);
  const busy = await send(env, msg(sid(), 'hi', 'fr'), fresh(6));
  assert.strictEqual(busy.node, 'Respond: Notice');
  assert.strictEqual(busy.body.reply, T.fr.busy, 'a polite "busy" notice in the visitor language');
  assert.strictEqual(env.aiCalls.length, 5, 'no AI call once the hourly budget is used');
  env.sim.now += 3600001;
  for (let i = 7; i <= 9; i++) assert.strictEqual((await send(env, msg(sid(), 'hi'), fresh(i))).node, 'Respond: Reply', 'new hour: message ' + i);
  assert.strictEqual((await send(env, msg(sid(), 'hi'), fresh(10))).body.reply, T.en.busy, 'daily budget (8) used');
  env.sim.now += 24 * 3600001;
  assert.strictEqual((await send(env, msg(sid(), 'hi'), fresh(11))).node, 'Respond: Reply', 'next day');
  assert.strictEqual(env.aiCalls.length, 9);
});
test('V8 a pending cancellation belongs to its own session: another visitor\'s "yes" changes nothing', async () => {
  const env = makeEnv();
  const a = sid(), b = sid();
  env.ai.behave = () => ({ tools: [['book', bookArgs('2026-10-07', '09:30', '10:15', 'Lina Demo', 'Manicure')]], output: 'OK' });
  await send(env, msg(a, 'book'));
  env.ai.behave = () => ({ tools: [['cancel', { appointment_date: '2026-10-07', appointment_time: '09:30' }]], output: 'OK' });
  await send(env, msg(a, 'cancel it'));
  assert.ok(/^CONFIRMATION_REQUIRED/.test(env.toolCalls[env.toolCalls.length - 1].result));
  env.ai.behave = () => ({ output: 'How can I help?' });
  const other = await send(env, msg(b, 'Yes'));
  assert.strictEqual(other.body.reply.indexOf('cancel'), -1, 'session B is not asked or told anything about A: ' + other.body.reply);
  assert.ok(!env.toolCalls.some((t) => t.exec), 'no confirmed change ran for session B');
  assert.strictEqual(events(env).length, 1, 'A\'s appointment is untouched');
  env.ai.behave = () => { throw new Error('the AI must not decide a confirmation'); };
  await send(env, msg(a, 'Yes'));
  assert.strictEqual(events(env).length, 0, 'A\'s own yes still works');
});
test('V9 replies never expose internal data (tool results, ids, calendar, session)', async () => {
  const env = makeEnv();
  const s = sid();
  const bodies = [];
  const keep = async (body, o) => { const r = await send(env, body, o); bodies.push(r.body); return r; };
  await keep(msg(s, 'Hello'), { headers: { origin: 'https://evil.example' } });
  env.ai.behave = () => ({ tools: [['check', { requested_date: '2026-10-07', requested_time: '11:00' }], ['book', bookArgs('2026-10-07', '11:00', '11:45', 'Zed Demo', 'Manicure')]], output: 'Booked!' });
  await keep(msg(s, 'book a manicure'));
  env.ai.behave = () => ({ tools: [['cancel', { appointment_date: '2026-10-07', appointment_time: '11:00' }]], output: 'Your appointment has been cancelled (internal: CONFIRMATION_REQUIRED)' });
  await keep(msg(s, 'cancel it'));
  await keep(msg(s, 'yes'));
  env.ai.behave = () => ({ fail: true });
  await keep(msg(s, 'and now?'));
  await keep(msg(s, 'I had an allergic reaction after my colour, what medication should I take?'));
  for (const b of bodies) {
    const keys = Object.keys(b).sort().join(',');
    assert.ok(keys === 'quickReplies,reply' || keys === 'error', 'only the reply (or an error code) leaves the workflow: ' + keys);
    const t = JSON.stringify(b);
    for (const bad of [/CONFIRM/, /\[\[/, /lumdemo/, /demo-cal@/, /googleapis/, /\bcf[a-z0-9]{20}\b/, /"9\d{14}"|\b9\d{14}\b/, /nb[a-z0-9]{24}/]) assert.ok(!bad.test(t), 'reply leaks ' + bad + ': ' + t.slice(0, 200));
    assert.ok(t.indexOf(s) < 0, 'reply contains the session id');
  }
});

// ================================================================= conversations
test('C1 first reply: fake-name notice, starters, salon prompt and memory per session, lock released', async () => {
  const env = makeEnv({ ai: { behave: () => ({ output: 'Hi! How can I help you today?' }) } });
  const s = sid();
  const r = await send(env, msg(s, 'Hello'));
  assert.strictEqual(r.code, 200);
  assert.ok(r.body.reply.indexOf(T.en.firstNotice) === 0, 'first reply starts with the fake-name notice');
  assert.deepStrictEqual(r.body.quickReplies, T.en.starters.slice(0, 4));
  const c = env.aiCalls[0];
  assert.strictEqual(c.text, 'Hello', 'the AI receives the visitor message');
  assert.ok(/Visitor message: Hello/.test(c.prompt), c.prompt);
  assert.ok(/Visitor language \(detected from this message\): English - reply in English\. Website language button: English\./.test(c.prompt), c.prompt);
  assert.ok(c.system.indexOf('Lumière Hair & Beauty Studio') >= 0 && c.system.indexOf('FICTIONAL salon') >= 0);
  assert.ok(c.system.indexOf('Closed every Sunday') >= 0 && c.system.indexOf('END by 19:00') >= 0 && c.system.indexOf('Balayage (FR: Balayage | ES: Balayage | AR: بالياج) - 180 min - from €140') >= 0, 'salon info, durations and prices in the prompt');
  assert.ok(c.system.indexOf('### SALON POLICIES (demo)') >= 0 && c.system.indexOf('### STYLISTS AND CAPACITY') >= 0);
  assert.ok(c.system.indexOf(T.en.medical) >= 0, 'health script in the prompt');
  assert.ok(!/undefined|\[object Object\]/.test(c.system), 'prompt expressions all resolve');
  // Allowed: internal tool/field names, and "patient" as a personality trait in the tone list.
  const wording = c.system.replace(/Find_Patient_Appointments|Find Patient Appointments|Get_Clinic_Info|patient_name/g, '').replace('\n- patient\n', '\n');
  assert.ok(!/clinic|patient|doctor absent/i.test(wording), 'no clinic wording in the demo prompt');
  assert.ok(/^web_9\d{14}_lumiere_demo_v1$/.test(c.memKey), 'memory key per session: ' + c.memKey);
  assert.ok(!lockHeld(env), 'chat lock released');
  const r2 = await send(env, msg(s, 'Thanks'));
  assert.ok(r2.body.reply.indexOf(T.en.firstNotice) < 0, 'notice only on the first reply');
});
test('C2 booking in Spanish: free start times as chips, then "DEMO - <name>" event with the service, nothing else', async () => {
  const env = makeEnv();
  const s = sid();
  env.ai.behave = (call) => {
    if (/martes/.test(call.text)) return { tools: [['check', { requested_date: '2026-10-06', requested_time: '', service_keys: 'womens_cut' }]], output: 'El martes tengo libre a las 09:00, 09:30, 10:00 o 10:30. ¿Qué hora prefieres?' };
    return { tools: [['check', { requested_date: '2026-10-06', requested_time: '10:00', service_keys: 'womens_cut' }], ['book', Object.assign(bookArgs('2026-10-06', '10:00', '11:00', 'Lucía Demo', "Women's haircut & styling"), { notes: 'IGNORED free text' })]],
      output: (steps) => (/SUCCESS/.test(steps[1].observation) ? '¡Listo! Tu cita es el martes a las 10:00, Lucía Demo.' : 'Problema: ' + steps[1].observation) };
  };
  const r1 = await send(env, msg(s, 'Quiero una cita para un corte el martes', 'es'));
  assert.ok(/FREE_SLOTS: 09:00, 09:30, 10:00, 10:30/.test(env.toolCalls[0].result), env.toolCalls[0].result);
  assert.ok(/18:00 \(free start times for a 60-minute service\)\.$/.test(env.toolCalls[0].result), 'last start leaves time to finish by 19:00: ' + env.toolCalls[0].result);
  assert.deepStrictEqual(r1.body.quickReplies, ['09:00', '09:30', '10:00', '10:30']);
  assert.ok(r1.body.reply.indexOf(T.es.firstNotice) === 0, 'Spanish notice');
  const r2 = await send(env, msg(s, '10:00, Lucía Demo, corte de mujer', 'es'));
  assert.strictEqual(env.toolCalls.length, 3);
  assert.ok(/^FREE: 10:00-11:00 .*60-minute appointment.*Women's haircut & styling \(60 min\) = 60 minutes in total.*starting price from €45/.test(env.toolCalls[1].result), env.toolCalls[1].result);
  assert.ok(/^SUCCESS/.test(env.toolCalls[2].result), env.toolCalls[2].result);
  assert.deepStrictEqual(r2.body.quickReplies, T.es.afterBooking);
  const ev = events(env);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].summary, 'DEMO - Lucía Demo');
  assert.ok(/T11:00/.test(ev[0].end.dateTime), 'the appointment lasts the whole service: ' + ev[0].end.dateTime);
  // The service line is written by the engine from the catalogue (the name the AI used was resolved to its key).
  assert.ok(/^Phone: 9\d{14}\. Service: Women's haircut & styling \| Keys: womens_cut \| Duration: 60 min\. Notes: Website demo$/.test(ev[0].description), ev[0].description);
  assert.ok(!lockHeld(env));
});
test('C3 service length: a 180-minute balayage only gets start times that fit before closing and around other bookings', async () => {
  const env = makeEnv();
  const s = sid();
  env.ai.behave = () => ({ tools: [
    ['book', bookArgs('2026-10-06', '10:00', '11:00', 'Ana Demo', "Women's haircut & styling")],
    ['check', { requested_date: '2026-10-06', requested_time: '', service_keys: 'balayage' }],
    ['check', { requested_date: '2026-10-06', requested_time: '09:00', service_keys: 'balayage' }],
    ['check', { requested_date: '2026-10-06', requested_time: '16:30', service_keys: 'balayage' }],
    ['check', { requested_date: '2026-10-06', requested_time: '16:00', service_keys: 'balayage' }],
    ['book', bookArgs('2026-10-06', '16:30', '19:30', 'Bea Demo', 'Balayage')]], output: 'OK' });
  await send(env, msg(s, 'balayage on tuesday?'));
  const res = env.toolCalls.map((t) => t.result);
  assert.ok(/^SUCCESS/.test(res[0]), res[0]);
  assert.ok(/FREE_SLOTS: 11:00, 11:30, .*16:00 \(free start times for a 180-minute service\)\.$/.test(res[1]) && !/09:00|09:30|16:30/.test(res[1].split('FREE_SLOTS:')[1]), res[1]);
  assert.ok(/^BUSY: 09:00-12:00 .*180-minute appointment \(Balayage/.test(res[2]), res[2]);
  assert.ok(/^OUTSIDE_HOURS: .*would end at 19:30, after the salon closes \(19:00\)\. The latest start for these services is 16:00/.test(res[3]), res[3]);
  assert.ok(/^FREE: 16:00-19:00/.test(res[4]), res[4]);
  assert.ok(/^OUTSIDE_HOURS: .*would end at 19:30, after the salon closes.*Nothing was booked/.test(res[5]), 'the engine refuses a booking that ends after closing: ' + res[5]);
  assert.strictEqual(events(env).length, 1);
});
test('C3b optional break (when configured in DEMO CONFIG): refused during the break, slots skip it', async () => {
  const env = makeEnv({ main: BREAK_MAIN });
  env.ai.behave = () => ({ tools: [
    ['check', { requested_date: '2026-10-06', requested_time: '13:00', service_keys: 'mens_cut' }], ['check', { requested_date: '2026-10-06', requested_time: '12:30', service_keys: 'womens_cut' }],
    ['check', { requested_date: '2026-10-06', requested_time: '12:30', service_keys: 'mens_cut' }], ['check', { requested_date: '2026-10-06', requested_time: '14:00', service_keys: 'mens_cut' }],
    ['book', bookArgs('2026-10-06', '13:30', '14:00', 'Ali Demo', "Men's haircut")],
    ['check', { requested_date: '2026-10-06', requested_time: '', service_keys: 'mens_cut' }]], output: 'OK' });
  await send(env, msg(sid(), 'lunchtime?'));
  const res = env.toolCalls.map((t) => t.result);
  assert.ok(/^OUTSIDE_HOURS: .*13:00 .*break/.test(res[0]), res[0]);
  assert.ok(/^OUTSIDE_HOURS: .*12:30 .*break/.test(res[1]), 'a 60-minute service at 12:30 runs into the break: ' + res[1]);
  assert.ok(/^FREE: 12:30/.test(res[2]), res[2]);
  assert.ok(/^FREE: 14:00/.test(res[3]), res[3]);
  assert.ok(/^OUTSIDE_HOURS: 13:30 .*break.*Nothing was booked/.test(res[4]), 'the engine refuses a booking in the break: ' + res[4]);
  assert.ok(/FREE_SLOTS: .*12:30, 14:00/.test(res[5]) && !/13:00|13:30/.test(res[5].split('FREE_SLOTS:')[1]), res[5]);
  assert.ok(/The salon is OPEN this day/.test(res[5]), 'an open day is never described as closed');
  assert.strictEqual(events(env).length, 0);
});
test('C4 closed day (Sunday) and outside opening hours', async () => {
  const env = makeEnv();
  env.ai.behave = () => ({ tools: [['check', { requested_date: '2026-10-11', requested_time: '' }], ['book', bookArgs('2026-10-11', '10:00', '10:30', 'Ali Demo', "Men's haircut")],
    ['check', { requested_date: '2026-10-10', requested_time: '19:00' }], ['check', { requested_date: '2026-10-10', requested_time: '08:30' }]], output: 'OK' });
  await send(env, msg(sid(), 'الأحد؟', 'ar'));
  const res = env.toolCalls.map((t) => t.result);
  assert.ok(/^CLOSED_DAY: 2026-10-11 falls on the salon's weekly closing day/.test(res[0]), res[0]);
  assert.ok(/^CLOSED_DAY/.test(res[1]), res[1]);
  assert.ok(/^OUTSIDE_HOURS: 19:00/.test(res[2]), res[2]);
  assert.ok(/^OUTSIDE_HOURS: 08:30/.test(res[3]), res[3]);
  assert.strictEqual(events(env).length, 0);
});
test('C5 max 2 bookings per session; other sessions unaffected', async () => {
  const env = makeEnv();
  const a = sid(), b = sid();
  const r = [];
  for (const t of ['09:00', '10:00', '11:00']) { env.ai.behave = () => ({ tools: [['book', bookArgs('2026-10-06', t, t.slice(0, 3) + '30', 'Sara Demo', "Men's haircut")]], output: 'OK' }); await send(env, msg(a, 'book ' + t)); r.push(env.toolCalls[env.toolCalls.length - 1].result); }
  assert.ok(/^SUCCESS/.test(r[0]) && /^SUCCESS/.test(r[1]), r.join(' | '));
  assert.ok(/^LIMIT_REACHED: This chat session already has 2 demo appointments/.test(r[2]), r[2]);
  env.ai.behave = () => ({ tools: [['book', bookArgs('2026-10-06', '14:00', '14:45', 'Ali Demo', 'Manicure')]], output: 'OK' });
  await send(env, msg(b, 'book'));
  assert.ok(/^SUCCESS/.test(env.toolCalls[env.toolCalls.length - 1].result));
  assert.strictEqual(events(env).length, 3);
});
test('C6 cancel and find: own appointments only', async () => {
  const env = makeEnv();
  const a = sid(), b = sid();
  env.ai.behave = () => ({ tools: [['book', bookArgs('2026-10-07', '09:30', '10:15', 'Lina Demo', 'Manicure')]], output: 'OK' });
  await send(env, msg(a, 'reservar', 'es'));
  env.ai.behave = () => ({ tools: [['find', {}], ['cancel', { appointment_date: '2026-10-07', appointment_time: '09:30' }]], output: 'OK' });
  await send(env, msg(b, 'cancelar', 'es'));
  const [findB, cancelB] = env.toolCalls.slice(-2).map((t) => t.result);
  assert.ok(/^NOT_FOUND/.test(findB), 'another session cannot see it: ' + findB);
  assert.ok(!/^SUCCESS/.test(cancelB), 'another session cannot cancel it: ' + cancelB);
  assert.strictEqual(events(env).length, 1);
  const ask = await send(env, msg(a, 'cancelar', 'es'));
  const [findA, cancelA] = env.toolCalls.slice(-2).map((t) => t.result);
  assert.ok(/^FOUND: 1\) DEMO - Lina Demo on 2026-10-07 at 09:30/.test(findA), findA);
  assert.ok(/^CONFIRMATION_REQUIRED/.test(cancelA), 'the AI only proposes: ' + cancelA);
  assert.strictEqual(events(env).length, 1, 'nothing cancelled before the visitor confirms');
  assert.ok(/¿quieres cancelar tu cita “Manicure” del miércoles 7 de octubre a las 09:30\? Responde Sí o No\./.test(ask.body.reply), ask.body.reply);
  assert.deepStrictEqual(ask.body.quickReplies, ['Sí, cancelar', 'No, mantener']);
  env.ai.behave = () => { throw new Error('the AI must not run for the confirmation'); };
  const done = await send(env, msg(a, 'Sí, cancelar', 'es'));
  assert.ok(/^SUCCESS/.test(env.toolCalls[env.toolCalls.length - 1].result), env.toolCalls[env.toolCalls.length - 1].result);
  assert.strictEqual(events(env).length, 0);
  assert.ok(/ha sido cancelada/.test(done.body.reply), done.body.reply);
  assert.ok(done.body.quickReplies.indexOf('Sí, cancelar') < 0 && done.body.quickReplies.indexOf(T.es.confirm[1]) < 0, 'no obsolete Confirm / Cancel chips: ' + done.body.quickReplies);
});
test('C7 reschedule keeps the DEMO title and the service length, and never takes new free text', async () => {
  const env = makeEnv();
  const a = sid();
  env.ai.behave = () => ({ tools: [['book', bookArgs('2026-10-08', '09:00', '10:30', 'Omar Demo', 'Root colour touch-up')]], output: 'OK' });
  await send(env, msg(a, 'book'));
  env.ai.behave = () => ({ tools: [['reschedule', { old_appointment_date: '2026-10-08', old_appointment_time: '09:00', new_appointment_date: '2026-10-08', new_appointment_time: '13:30', new_summary: 'REAL NAME', new_description: 'my real phone 0555' }]], output: 'OK' });
  const ask = await send(env, msg(a, "I'd like to reschedule my appointment."));
  assert.ok(/^CONFIRMATION_REQUIRED/.test(env.toolCalls[env.toolCalls.length - 1].result), env.toolCalls[env.toolCalls.length - 1].result);
  assert.ok(/T09:00/.test(events(env)[0].start.dateTime), 'not moved before the visitor confirms');
  assert.ok(/move your appointment “Root colour touch-up” from Thursday 8 October at 09:00 to Thursday 8 October at 13:30\?/.test(ask.body.reply), ask.body.reply);
  assert.deepStrictEqual(ask.body.quickReplies, ['Yes, move it', 'No, keep it']);
  const done = await send(env, msg(a, 'Yes, move it'));
  assert.ok(/^SUCCESS/.test(env.toolCalls[env.toolCalls.length - 1].result), env.toolCalls[env.toolCalls.length - 1].result);
  assert.ok(/is now on Thursday 8 October at 13:30 \(instead of Thursday 8 October at 09:00\)/.test(done.body.reply), 'the reply shows the updated appointment: ' + done.body.reply);
  const ev = events(env);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].summary, 'DEMO - Omar Demo');
  assert.ok(/T13:30/.test(ev[0].start.dateTime) && /T15:00/.test(ev[0].end.dateTime), 'same 90-minute length: ' + ev[0].start.dateTime + ' - ' + ev[0].end.dateTime);
  assert.ok(ev[0].description.indexOf('0555') < 0);
  env.ai.behave = () => ({ tools: [['reschedule', { old_appointment_date: '2026-10-08', old_appointment_time: '13:30', new_appointment_date: '2026-10-08', new_appointment_time: '18:00' }]], output: 'OK' });
  await send(env, msg(a, 'move it to 18:00'));
  assert.ok(/^OUTSIDE_HOURS: .*would end at 19:30/.test(env.toolCalls[env.toolCalls.length - 1].result), env.toolCalls[env.toolCalls.length - 1].result);
});
test('C7b service change on the website (Spanish): one confirmed update, backend length, DEMO title kept, "change" chips', async () => {
  const env = makeEnv();
  const a = sid();
  env.ai.behave = () => ({ tools: [['book', bookArgs('2026-10-08', '10:00', '10:30', 'Omar Demo', 'blow_dry')]], output: 'OK' });
  await send(env, msg(a, 'book', 'es'));
  const id = events(env)[0].id;
  env.ai.behave = () => ({ tools: [
    ['check', { requested_date: '2026-10-08', requested_time: '10:00', service_keys: 'mechas, corte de mujer', exclude_appointment_time: '10:00' }],
    ['reschedule', { old_appointment_date: '2026-10-08', old_appointment_time: '10:00', new_appointment_date: '2026-10-08', new_appointment_time: '10:00', new_service_keys: 'mechas, corte de mujer', new_summary: 'REAL NAME', new_description: 'free text' }]], output: 'Hecho, ya lo he cambiado.' });
  const ask = await send(env, msg(a, 'Quiero añadir mechas y un corte a mi cita', 'es'));
  assert.ok(/^FREE: 10:00-14:00/.test(env.toolCalls[env.toolCalls.length - 2].result), env.toolCalls[env.toolCalls.length - 2].result);
  assert.ok(/^Para confirmar: ¿quieres cambiar tu cita “Secado y peinado \(brushing\)” del jueves 8 de octubre a las 10:00 a: Balayage \+ Corte de mujer y peinado - 240 minutos en total, el jueves 8 de octubre a las 10:00 \(hasta las 14:00\)\?/.test(ask.body.reply), ask.body.reply);
  assert.deepStrictEqual(ask.body.quickReplies, ['Sí, cambiar', 'No, mantener']);
  assert.ok(/T10:30/.test(events(env)[0].end.dateTime), 'nothing changed before the yes');
  const done = await send(env, msg(a, 'Sí, cambiar', 'es'));
  assert.ok(/^Hecho: tu cita es ahora Balayage \+ Corte de mujer y peinado el jueves 8 de octubre a las 10:00 \(hasta las 14:00\)/.test(done.body.reply), done.body.reply);
  const ev = events(env);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].id, id, 'the same appointment, updated (never cancelled and re-booked)');
  assert.strictEqual(ev[0].summary, 'DEMO - Omar Demo');
  assert.ok(/T14:00/.test(ev[0].end.dateTime), ev[0].end.dateTime);
  assert.ok(/^Phone: 9\d{14}\. Service: Balayage \+ Women's haircut & styling \| Keys: balayage,womens_cut \| Duration: 240 min\. Notes: Website demo$/.test(ev[0].description), ev[0].description);
});
test('C8 quick replies follow the visitor\'s language: Confirm / Cancel chips, fake-name reminder when asking the name', async () => {
  const env = makeEnv();
  const s = sid();
  env.ai.behave = () => ({ output: 'Hi! Could I have your first and last name for the booking?' });
  const r1 = await send(env, msg(s, 'Hi'));
  assert.ok(r1.body.reply.indexOf(T.en.nameNotice) > 0, 'fake-name reminder when asking the name');
  assert.deepStrictEqual(r1.body.quickReplies, [], 'no starter chips while the name is asked');
  env.ai.behave = () => ({ tools: [['check', { requested_date: '2026-10-06', requested_time: '10:00' }]], output: 'Tuesday at 10:00 is free. Shall I book it for you?' });
  const r2 = await send(env, msg(s, 'tuesday 10am please'));
  assert.deepStrictEqual(r2.body.quickReplies, T.en.confirm);
  env.ai.behave = () => ({ tools: [['check', { requested_date: '2026-10-06', requested_time: '10:00' }]], output: 'El martes a las 10:00 está libre. ¿Te lo reservo?' });
  const r3 = await send(env, msg(sid(), 'el martes a las 10', 'es'));
  assert.deepStrictEqual(r3.body.quickReplies, T.es.confirm);
  assert.ok(r3.body.reply.indexOf(T.es.firstNotice) === 0);
  // Website set to English, visitor writes in Spanish -> Spanish reply, Spanish chips and notice.
  env.ai.behave = () => ({ tools: [['check', { requested_date: '2026-10-06', requested_time: '10:00' }]], output: 'A las 10:00 está libre. ¿Te lo reservo?' });
  const rx = await send(env, msg(sid(), 'hola, ¿hay hueco a las 10?', 'en'));
  assert.deepStrictEqual(rx.body.quickReplies, T.es.confirm, 'chips follow the visitor language');
  assert.ok(rx.body.reply.indexOf(T.es.firstNotice) === 0, 'notice follows the visitor language');
  // A cancellation question written by the AI itself never gets the booking Confirm / Cancel chips:
  // cancellations are confirmed only through the confirmation gate (Oui/Non chips, tested in G-tests).
  env.ai.behave = () => ({ output: 'Votre rendez-vous est le mardi 20 octobre à 10h00. Est-ce bien celui-là que vous souhaitez annuler ?' });
  const rc = await send(env, msg(sid(), 'je veux annuler mon rendez-vous', 'fr'));
  assert.notDeepStrictEqual(rc.body.quickReplies, T.fr.confirm, 'no Confirmer / Annuler chips on an AI-written cancellation question');
  // An Arabic name request without a question mark.
  env.ai.behave = () => ({ output: 'أهلاً بك! يرجى تزويدي بالاسم الكامل (الاسم واللقب) ونوع الخدمة المطلوبة.' });
  const r4 = await send(env, msg(sid(), 'أريد حجز موعد', 'ar'));
  assert.ok(r4.body.reply.indexOf(T.ar.nameNotice) > 0, 'fake-name reminder in Arabic: ' + r4.body.reply);
  assert.deepStrictEqual(r4.body.quickReplies, [], 'no starter chips while the name is asked');
  env.ai.behave = () => ({ output: 'أهلاً بك! لحجز موعد، أحتاج إلى اسمك الكامل ونوع الخدمة.' });
  const r5 = await send(env, msg(sid(), 'أريد حجز موعد', 'ar'));
  assert.ok(r5.body.reply.indexOf(T.ar.nameNotice) > 0, 'reminder also for "أحتاج إلى اسمك": ' + r5.body.reply);
  env.ai.behave = () => ({ output: '¡Hola! ¿Me dices tu nombre y apellido para la reserva?' });
  const r6 = await send(env, msg(sid(), 'Hola, quiero una cita', 'es'));
  assert.ok(r6.body.reply.indexOf(T.es.nameNotice) > 0, 'reminder in Spanish: ' + r6.body.reply);
});
test('C9 failures: AI error and corrupted output give the friendly fallback, lock released', async () => {
  const env = makeEnv();
  env.ai.behave = () => ({ fail: true });
  const r1 = await send(env, msg(sid(), 'مرحبا', 'ar'));
  assert.strictEqual(r1.node, 'Respond: Fallback');
  assert.strictEqual(r1.body.reply, T.ar.fallback);
  assert.ok(!lockHeld(env));
  env.ai.behave = () => ({ output: '{"name": "Book_Appointment"}' });
  const r2 = await send(env, msg(sid(), 'Hello'));
  assert.ok(r2.body.reply.indexOf(T.en.fallback) >= 0, r2.body.reply);
  assert.deepStrictEqual(r2.body.quickReplies, []);
  for (const claim of ["You're all booked for Tuesday!", '¡Tu cita queda reservada!', 'Rendez-vous confirmé !']) {
    env.ai.behave = () => ({ output: claim }); // claims a booking without calling the tool
    const r3 = await send(env, msg(sid(), 'ok'));
    assert.ok(r3.body.reply.indexOf(T.en.fallback) >= 0, 'Sanitize still catches false success claims: ' + claim);
  }
});
test('C10 a tool called without DEMO CONFIG fails closed (nothing written)', async () => {
  const env = makeEnv();
  const r = new Runner(WFS.book, { sim: env.sim, persisted: env.persisted, envVars: {}, opts: env.opts, hooks: { http: (req) => env.cal.request(req), nodes: {}, types: {} } });
  const p = r.run('Execute Workflow Trigger', [{ json: { start_datetime: '2026-10-06T10:00:00', summary: 'X Demo', service_keys: 'mens_cut', phone_number: '912345678901234' } }]);
  await env.sim.run();
  const res = await p;
  assert.ok(/^ERROR_NEEDS_STAFF/.test(res.output[0].json.result), res.output[0].json.result);
  assert.strictEqual(env.cal.log.length, 0, 'no calendar call at all');
});

test('C12 services on the website: resolved by the engine from the catalogue; an unknown or ambiguous service is refused, never replaced by a default', async () => {
  const env = makeEnv();
  env.ai.behave = () => ({ tools: [
    ['book', bookArgs('2026-10-06', '10:00', '14:00', 'Inès Demo', 'balayage, Coupe femme & coiffage, brushing')],
    ['book', bookArgs('2026-10-07', '10:00', '-', 'Max Demo', 'Massage')],
    ['book', bookArgs('2026-10-07', '11:00', '-', 'Max Demo', 'haircut')],
    ['check', { requested_date: '2026-10-07', requested_time: '', service_keys: 'mechas' }]], output: 'OK' });
  await send(env, msg(sid(), 'réserver', 'fr'));
  const res = env.toolCalls.map((t) => t.result);
  assert.ok(/^SUCCESS: Booked "DEMO - Inès Demo" on 2026-10-06 10:00-14:00\./.test(res[0]) && /= 240 minutes in total/.test(res[0]), res[0]);
  assert.ok(/^SERVICE_UNKNOWN: "Massage"/.test(res[1]), 'the former guard silently booked the first service instead: ' + res[1]);
  assert.ok(/^SERVICE_AMBIGUOUS: "haircut" could mean/.test(res[2]), res[2]);
  assert.ok(/FREE_SLOTS: 09:00, .*16:00 \(free start times for a 180-minute service\)\.$/.test(res[3]), res[3]);
  const ev = events(env);
  assert.strictEqual(ev.length, 1, 'nothing booked for an unknown or ambiguous service');
  assert.ok(/T14:00/.test(ev[0].end.dateTime), ev[0].end.dateTime);
  assert.ok(/\| Keys: balayage,womens_cut,blow_dry \| Duration: 240 min\. Notes: Website demo$/.test(ev[0].description), ev[0].description);
});

test('C11 two visitors book the same slot at the same moment: exactly one wins; a booking answers well under 45 s', async () => {
  const env = makeEnv({ ai: { behave: () => ({ thinkMs: 2500, tools: [['check', { requested_date: '2026-10-06', requested_time: '11:00', service_keys: 'manicure' }], ['book', bookArgs('2026-10-06', '11:00', '11:45', 'Race Demo', 'Manicure')]], output: 'OK' }) } });
  const runOne = (s) => { const r = new Runner(env.main, { sim: env.sim, persisted: env.persisted, envVars: {}, opts: env.opts, hooks: mainHooks(env) }); return r.run('Website Webhook', [webItem(msg(s, 'book 11am'))]); };
  const t0 = env.sim.now;
  const ps = [runOne(sid()), runOne(sid())];
  await env.sim.run();
  await Promise.all(ps);
  const books = env.toolCalls.filter((t) => t.key === 'book').map((t) => t.result);
  assert.strictEqual(books.filter((r) => /^SUCCESS/.test(r)).length, 1, books.join(' | '));
  assert.ok(/^CONFLICT/.test(books.find((r) => !/^SUCCESS/.test(r))), books.join(' | '));
  assert.strictEqual(events(env).length, 1);
  assert.strictEqual(env.responses.length, 2);
  const took = (env.sim.now - t0) / 1000;
  console.log('       (simulated time for both booking messages: ' + took.toFixed(1) + ' s, with 2.5 s of AI thinking each)');
  assert.ok(took < 45, 'answers before the website gives up: ' + took + ' s');
});

// ================================================================= cleanup
test('K1 daily cleanup deletes only DEMO events created more than 24 h ago', async () => {
  const env = makeEnv();
  const iso = (ms) => new Date(ms).toISOString();
  const mk = (id, summary, createdAgoH, startIso) => env.cal.seed(CAL, { id, summary, created: iso(env.sim.now - createdAgoH * 3600000), start: { dateTime: startIso }, end: { dateTime: startIso.replace(':00+01:00', ':30+01:00') } });
  mk('old1demo', 'DEMO - Old Visitor', 25, '2026-10-06T09:00:00+01:00');
  mk('old2demo', 'DEMO - Old Past', 30, '2026-10-04T09:00:00+01:00');
  mk('newdemo1', 'DEMO - New Visitor', 2, '2026-10-06T10:00:00+01:00');
  mk('manual01', 'Staff note', 48, '2026-10-06T11:00:00+01:00');
  env.cal.seed(CAL, { id: 'lumdemolockchatabc', summary: '[SYSTEM LOCK - customer chat queue] do not edit or delete', created: iso(env.sim.now - 72 * 3600000), start: { dateTime: '2000-01-01T00:00:00Z' }, end: { dateTime: '2000-01-01T00:01:00Z' } });
  const r = new Runner(WFS.main, { sim: env.sim, persisted: env.persisted, envVars: {}, opts: env.opts, hooks: mainHooks(env) });
  const p = r.run('Daily Cleanup (03:00)', [{ json: {} }]);
  await env.sim.run();
  const res = await p;
  assert.ok(!res.error, res.error && res.error.message);
  const st = (id) => env.cal.store(CAL).get(id).cur.status;
  assert.strictEqual(st('old1demo'), 'cancelled');
  assert.strictEqual(st('old2demo'), 'cancelled');
  assert.strictEqual(st('newdemo1'), 'confirmed');
  assert.strictEqual(st('manual01'), 'confirmed');
  assert.strictEqual(st('lumdemolockchatabc'), 'confirmed');
  assert.strictEqual(env.responses.length, 0, 'the cleanup run never answers a webhook');
});

// ---------------------------------------------------------------- availability (2026-11-25)
// Found live: "Do you have any availability this Saturday?" -> the AI called Check_Availability
// with a date but no time, n8n rejected the call (requested_time was REQUIRED in the tool
// schema) and the visitor got the fallback. requested_time is now optional on the website demo.
const TUE = '2026-10-06'; // the Tuesday after START
const seedBusy = (env, id, from, to) => env.cal.seed(CAL, { id, summary: 'DEMO - Seeded ' + id, description: 'Phone: 900000000000001. Notes: Website demo', start: { dateTime: TUE + 'T' + from + ':00+01:00', timeZone: 'Africa/Algiers' }, end: { dateTime: TUE + 'T' + to + ':00+01:00', timeZone: 'Africa/Algiers' } });
async function checkVia(env, args, message) {
  env.ai.behave = () => ({ tools: [['check', args]], output: (steps) => 'Here is what I found.' + (steps.length ? '' : '') });
  const before = env.toolCalls.length;
  const r = await send(env, msg(sid(), message || 'Any availability on Tuesday?'));
  return { r, call: env.toolCalls[before] };
}

test('A1 tool schema: requested_date required; requested_time and service_keys optional (the website demo only)', () => {
  const s = fromAiSchema(WFS.main.nodes.find((n) => n.name === 'Check_Availability'));
  assert.deepStrictEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.required])), { requested_date: true, requested_time: false, service_keys: false, exclude_appointment_time: false });
  assert.strictEqual(s.requested_time.def, '', 'a missing time becomes "" (whole day)');
  // The WhatsApp workflow (and so Messenger / Instagram) is NOT changed by this fix.
  const wa = JSON.parse(fs.readFileSync(path.join(DIR, '..', WB.FILES.main), 'utf8'));
  assert.strictEqual(fromAiSchema(wa.nodes.find((n) => n.name === 'Check_Availability')).requested_time.required, true, 'WhatsApp untouched');
});

test('A2 date only (time left out or empty): the real calendar for the whole day, free start times for the service, no fallback', async () => {
  for (const args of [{ requested_date: TUE, service_keys: 'mens_cut' }, { requested_date: TUE, requested_time: '', service_keys: 'mens_cut' }, { requested_date: TUE, requested_time: '   ', service_keys: "Men's haircut" }]) {
    const env = makeEnv();
    seedBusy(env, 'busy1200', '12:00', '13:00');
    const { r, call } = await checkVia(env, args);
    assert.strictEqual(r.body.reply.indexOf(T.en.fallback), -1, JSON.stringify(args) + ' -> fallback: ' + r.body.reply);
    assert.ok(/^HAS_EVENTS: 2026-10-06 has these busy periods: 12:00-13:00\./.test(call.result), call.result);
    const slots = call.result.split('FREE_SLOTS: ')[1];
    assert.ok(/^09:00, 09:30, .*11:30, 13:00, .*18:30 \(free start times for a 30-minute service\)\.$/.test(slots), slots);
    assert.ok(!/\b12:00\b|\b12:30\b/.test(slots), 'a busy time is never offered: ' + slots);
  }
  // A day with nothing booked yet is reported as such (still read from the calendar).
  const empty = makeEnv();
  const { call } = await checkVia(empty, { requested_date: TUE, service_keys: 'mens_cut' });
  assert.ok(/^EMPTY_DAY: 2026-10-06 has zero booked appointments\..*FREE_SLOTS: 09:00, /.test(call.result), call.result);
  // No service yet: the real busy periods, but no start-time list for an invented length (never a default service).
  const nosvc = (await checkVia(makeEnv(), { requested_date: TUE })).call.result;
  assert.ok(/^EMPTY_DAY: 2026-10-06/.test(nosvc) && nosvc.indexOf('FREE_SLOTS') < 0 && /service_keys/.test(nosvc), nosvc);
});

test('A3 date + specific time: the existing FREE / BUSY verdict is unchanged', async () => {
  const env = makeEnv();
  seedBusy(env, 'busy1000', '10:00', '11:00');
  const free = (await checkVia(env, { requested_date: TUE, requested_time: '14:00', service_keys: 'mens_cut' })).call.result;
  const busy = (await checkVia(env, { requested_date: TUE, requested_time: '10:30', service_keys: 'mens_cut' })).call.result;
  assert.ok(/^FREE: 14:00-14:30 on 2026-10-06 is available/.test(free), free);
  assert.ok(/^BUSY: 10:30-11:00 on 2026-10-06 is not free .*another appointment 10:00-11:00/.test(busy), busy);
});

test('A4 service duration: date only + 180 minutes -> only starts that fit before closing and around bookings', async () => {
  const env = makeEnv();
  seedBusy(env, 'busy1300', '13:00', '14:00');
  const { call } = await checkVia(env, { requested_date: TUE, service_keys: 'balayage' });
  const slots = call.result.split('FREE_SLOTS: ')[1];
  assert.ok(/latest start is 16:00/.test(call.result), call.result);
  // 180 min must end by 13:00 (busy) -> 09:00-10:00, or start after 14:00 and end by 19:00 -> 14:00-16:00.
  assert.strictEqual(slots, '09:00, 09:30, 10:00, 14:00, 14:30, 15:00, 15:30, 16:00 (free start times for a 180-minute service).');
  for (const t of ['10:30', '11:00', '12:00', '13:00', '13:30', '16:30', '17:00']) assert.ok(slots.indexOf(t) < 0, t + ' would overlap 13:00-14:00 or end after 19:00: ' + slots);
  const late = (await checkVia(env, { requested_date: TUE, requested_time: '16:30', service_keys: 'balayage' })).call.result;
  assert.ok(/^OUTSIDE_HOURS: .*would end at 19:30, after the salon closes \(19:00\)/.test(late), late);
});

test('A5 invalid date or time: INVALID_INPUT, nothing invented, no fallback', async () => {
  for (const args of [{ requested_date: '2026-13-45' }, { requested_date: 'next saturday' }, { requested_date: '' }, { requested_date: TUE, requested_time: '25:00' }, { requested_date: TUE, requested_time: '10h' }]) {
    const env = makeEnv();
    const { r, call } = await checkVia(env, args);
    assert.ok(/^INVALID_INPUT: The requested_(date|time) is (missing or )?malformed/.test(call.result), JSON.stringify(args) + ': ' + call.result);
    assert.ok(!/FREE|FREE_SLOTS/.test(call.result), 'no availability invented: ' + call.result);
    assert.strictEqual(r.body.reply.indexOf(T.en.fallback), -1);
  }
  // A required field the AI leaves out is still refused by n8n's schema (the date).
  const env = makeEnv();
  const { r } = await checkVia(env, { requested_time: '10:00' });
  assert.ok(r.body.reply.indexOf(T.en.fallback) >= 0, 'missing date -> n8n rejects the call');
});

test('A6 fully booked day: date only -> no free start time; a specific time -> BUSY', async () => {
  const env = makeEnv();
  seedBusy(env, 'busyam', '09:00', '14:00');
  seedBusy(env, 'busypm', '14:00', '19:00');
  const day = (await checkVia(env, { requested_date: TUE, service_keys: 'mens_cut' })).call.result;
  assert.ok(/^HAS_EVENTS: 2026-10-06 has these busy periods: 09:00-14:00, 14:00-19:00\./.test(day), day);
  assert.ok(/FREE_SLOTS: none left on this day for a 30-minute service\.$/.test(day), day);
  const t = (await checkVia(env, { requested_date: TUE, requested_time: '15:00', service_keys: 'mens_cut' })).call.result;
  assert.ok(/^BUSY: 15:00-15:30 on 2026-10-06 is not free/.test(t), t);
});

test('A7 regression: with requested_time REQUIRED (the previous build) a date-only question gave the fallback', async () => {
  const old = JSON.parse(JSON.stringify(WFS.main));
  const node = old.nodes.find((n) => n.name === 'Check_Availability');
  node.parameters.workflowInputs.value.requested_time = node.parameters.workflowInputs.value.requested_time.replace(", 'string', '') }}", ", 'string') }}");
  const env = makeEnv({ main: old });
  const { r, call } = await checkVia(env, { requested_date: TUE }, 'Do you have any availability this Saturday?');
  assert.strictEqual(call, undefined, 'n8n never ran the tool');
  assert.ok(r.body.reply.indexOf(T.en.fallback) >= 0, 'old build -> fallback: ' + r.body.reply);
});

// ---------------------------------------------------------------- 2026-11-25: confirmed actions (issue 1)
// Found live: after the server cancelled / moved an appointment, the NEXT AI turn truthfully
// repeated "your appointment has been cancelled" (from its [System log]); Sanitize AI Output
// saw no Cancel tool call in that turn and replaced the reply with the technical fallback.
const CONFIRMX = require('../../engine/confirm.js').createConfirm();
const TX = CONFIRMX.texts('en');
// Book one appointment for session s and leave a pending cancel / reschedule proposal.
async function bookAndPropose(env, s, act) {
  env.ai.behave = () => ({ tools: [['book', bookArgs('2026-10-07', '09:30', '10:15', 'Lina Demo', 'Manicure')]], output: 'Booked!' });
  await send(env, msg(s, 'book a manicure'));
  env.ai.behave = () => ({ tools: [act === 'cancel' ? ['cancel', { appointment_date: '2026-10-07', appointment_time: '09:30' }] : ['reschedule', { old_appointment_date: '2026-10-07', old_appointment_time: '09:30', new_appointment_date: '2026-10-07', new_appointment_time: '15:00' }]], output: 'OK' });
  const ask = await send(env, msg(s, act === 'cancel' ? 'cancel it' : 'move it to 15:00'));
  assert.ok(/Just to confirm/.test(ask.body.reply), ask.body.reply);
}
// What the real model does after a confirmed change: it repeats the system log in its own words.
const truthfulAi = (env, text) => { env.ai.behave = () => ({ output: text }); };
const execCount = (env) => env.toolCalls.filter((t) => t.exec).length;
const apptState = (env) => events(env).map((e) => e.start.dateTime.slice(11, 16));
const isFallback = (r) => r.body.reply.indexOf(T.en.fallback) >= 0;

test('F1 cancellation: one success reply; a late "Yes" is answered by the server (already done), never the fallback, never re-executed', async () => {
  const env = makeEnv(); const s = sid();
  await bookAndPropose(env, s, 'cancel');
  const done = await send(env, msg(s, 'Yes'));
  assert.ok(/has been cancelled/.test(done.body.reply) && !isFallback(done), done.body.reply);
  assert.deepStrictEqual([execCount(env), apptState(env)], [1, []]);
  truthfulAi(env, 'Your appointment has been cancelled.');
  const late = await send(env, msg(s, 'Yes'));
  assert.ok(!isFallback(late), 'late yes -> fallback: ' + late.body.reply);
  assert.ok(/already/i.test(late.body.reply) && /cancelled/.test(late.body.reply), late.body.reply);
  assert.strictEqual(execCount(env), 1, 'a late yes never executes again');
});

test('F2 rescheduling: one success reply; a late "Yes" and a truthful AI recap are answered from the server record, never the fallback', async () => {
  const env = makeEnv(); const s = sid();
  await bookAndPropose(env, s, 'reschedule');
  const done = await send(env, msg(s, 'yes please'));
  assert.ok(/is now on/.test(done.body.reply), done.body.reply);
  assert.deepStrictEqual(apptState(env), ['15:00']);
  truthfulAi(env, 'Great, your appointment has been rescheduled to 15:00.');
  const late = await send(env, msg(s, 'ok'));
  assert.ok(!isFallback(late) && /already/i.test(late.body.reply) && /15:00/.test(late.body.reply), late.body.reply);
  const recap = await send(env, msg(s, 'thanks!'));
  assert.ok(!isFallback(recap), 'truthful recap after a confirmed move -> fallback: ' + recap.body.reply);
  assert.ok(recap.body.reply.indexOf('Great, your appointment has been rescheduled') < 0, 'the AI claim itself is never passed through: ' + recap.body.reply);
  assert.deepStrictEqual([execCount(env), apptState(env)], [1, ['15:00']]);
});

test('F3 duplicate confirmations: two simultaneous "Yes" -> exactly one change, one success reply, one "already done", no fallback', async () => {
  const env = makeEnv(); const s = sid();
  await bookAndPropose(env, s, 'cancel');
  truthfulAi(env, 'Your appointment has been cancelled.');
  const rs = await sendMany(env, [msg(s, 'Yes'), msg(s, 'Yes')]);
  const replies = rs.map((r) => r.body.reply);
  assert.strictEqual(replies.filter((x) => /^Done: .*has been cancelled/.test(x)).length, 1, replies.join(' || '));
  assert.strictEqual(replies.filter((x) => /already/i.test(x)).length, 1, replies.join(' || '));
  assert.ok(!rs.some(isFallback), replies.join(' || '));
  assert.deepStrictEqual([execCount(env), apptState(env)], [1, []]);
});

test('F4 failed operation: no success is reported and nothing is "already done" afterwards', async () => {
  const env = makeEnv(); const s = sid();
  await bookAndPropose(env, s, 'cancel');
  env.cal.opts.fault = (req) => (req.method === 'DELETE' ? { kind: '500' } : null);
  const r = await send(env, msg(s, 'Yes'));
  env.cal.opts.fault = null;
  assert.ok(!/^Done/.test(r.body.reply) && !/has been cancelled/.test(r.body.reply), 'success reported for a failed write: ' + r.body.reply);
  truthfulAi(env, 'Your appointment has been cancelled.');
  const late = await send(env, msg(s, 'Yes'));
  assert.ok(!/already/i.test(late.body.reply), 'a failed operation is never "already done": ' + late.body.reply);
  assert.ok(isFallback(late), 'an unbacked AI claim is still rejected: ' + late.body.reply);
});

test('F5 declined confirmation: "No" keeps it; a later "Yes" executes nothing and is never "already done"; AI claims stay rejected', async () => {
  const env = makeEnv(); const s = sid();
  await bookAndPropose(env, s, 'cancel');
  const no = await send(env, msg(s, 'No'));
  assert.ok(/nothing was changed/.test(no.body.reply), no.body.reply);
  truthfulAi(env, 'Your appointment has been cancelled.');
  const late = await send(env, msg(s, 'Yes'));
  assert.ok(!/already/i.test(late.body.reply) && isFallback(late), late.body.reply);
  assert.deepStrictEqual([execCount(env), apptState(env)], [0, ['09:30']]);
});

test('F6 the server record is bound to its session and expires: another session, or the same one after 2 h, gets no "already done"', async () => {
  const env = makeEnv(); const s = sid(), other = sid();
  await bookAndPropose(env, s, 'cancel');
  await send(env, msg(s, 'Yes'));
  truthfulAi(env, 'Your appointment has been cancelled.');
  const b = await send(env, msg(other, 'Yes'));
  assert.ok(!/already/i.test(b.body.reply) && isFallback(b), 'another session: ' + b.body.reply);
  env.sim.now += 2 * 3600000 + 1000;
  const stale = await send(env, msg(s, 'Yes'));
  assert.ok(!/already/i.test(stale.body.reply) && isFallback(stale), 'stale record must not be used: ' + stale.body.reply);
  assert.strictEqual(execCount(env), 1);
});

// ---------------------------------------------------------------- 2026-11-25: atomic rate limits (issue 2)
// Found live: the counters lived in n8n workflow static data, which every execution loads at its
// start and writes back at its end - overlapping executions overwrote each other's increments.
// Several INDEPENDENT executions started at the same instant (like simultaneous webhook calls).
async function sendMany(env, bodies, opts) {
  const runs = bodies.map((b, i) => {
    const r = new Runner(env.main, { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks: mainHooks(env) });
    return { r, p: r.run('Website Webhook', [webItem(b, (opts && opts[i]) || {})]) };
  });
  await env.sim.run();
  const out = [];
  for (const { r, p } of runs) {
    const res = await p;
    if (res.error) throw res.error;
    const mine = env.responses.filter((x) => x.exec === r.execId);
    assert.strictEqual(mine.length, 1, 'one response per request');
    out.push(mine[0]);
  }
  return out;
}
// Small limits so the boundaries are reached quickly (session 3, IP 5, global 6/h and 9/day).
const TINY_MAIN = JSON.parse(withCal(raw.main, CAL));
{
  const n = TINY_MAIN.nodes.find((x) => x.name === 'DEMO CONFIG');
  const before = n.parameters.jsCode;
  n.parameters.jsCode = before.replace(/"SESSION_MSGS_PER_HOUR": \d+/, '"SESSION_MSGS_PER_HOUR": 3').replace(/"IP_MSGS_PER_HOUR": \d+/, '"IP_MSGS_PER_HOUR": 5')
    .replace(/"GLOBAL_MSGS_PER_HOUR": \d+/, '"GLOBAL_MSGS_PER_HOUR": 6').replace(/"GLOBAL_MSGS_PER_DAY": \d+/, '"GLOBAL_MSGS_PER_DAY": 9');
  assert.ok(/"SESSION_MSGS_PER_HOUR": 3/.test(n.parameters.jsCode) && /"GLOBAL_MSGS_PER_DAY": 9/.test(n.parameters.jsCode), 'test setup: limits not found in DEMO CONFIG');
}
const HUMAN = 'I want to talk to a real person'; // scripted reply: counted, but no AI call
const tally = (rs) => ({ ok: rs.filter((r) => r.body.reply === T.en.human).length, limited: rs.filter((r) => r.body.reply === T.en.rateLimited).length, busy: rs.filter((r) => r.body.reply === T.en.busy).length });
const eqTally = (rs, want, label) => { const got = tally(rs); assert.deepStrictEqual(got, want, (label ? label + ": " : "") + "got " + JSON.stringify(got) + ", expected " + JSON.stringify(want)); };
const ipOf = (i) => ({ ip: '198.51.' + Math.floor(i / 200) + '.' + (i % 200 + 1) });

test('RL1 session limit under concurrency: 8 simultaneous requests of one session (limit 3) -> exactly 3 allowed', async () => {
  const env = makeEnv({ main: TINY_MAIN }); const s = sid();
  const rs = await sendMany(env, Array.from({ length: 8 }, () => msg(s, HUMAN)), Array.from({ length: 8 }, (_, i) => ipOf(i)));
  eqTally(rs, { ok: 3, limited: 5, busy: 0 });
  // The executions really collided: some conditional writes were refused (412) and retried - none was lost.
  const casLost = env.cal.log.filter((x) => x.method === 'PUT' && /lumdemorls/.test(x.url) && x.status === 412).length;
  assert.ok(casLost > 0, 'the test must exercise contention (412 on the session counter), got ' + casLost);
  const sc = [...env.cal.store(CAL).values()].map((e) => e.cur).find((e) => /^lumdemorls/.test(e.id));
  assert.strictEqual(JSON.parse(sc.description).c.n, 8, 'all 8 requests were counted - no increment lost');
});

test('RL2 IP limit under concurrency: 9 simultaneous sessions from one IP (limit 5) -> exactly 5 allowed', async () => {
  const env = makeEnv({ main: TINY_MAIN });
  const rs = await sendMany(env, Array.from({ length: 9 }, () => msg(sid(), HUMAN)), Array.from({ length: 9 }, () => ({ ip: '192.0.2.50' })));
  eqTally(rs, { ok: 5, limited: 4, busy: 0 });
});

test('RL3 overall hourly cap under concurrency: 10 simultaneous visitors (cap 6) -> exactly 6 allowed, 4 "busy"', async () => {
  const env = makeEnv({ main: TINY_MAIN });
  const rs = await sendMany(env, Array.from({ length: 10 }, () => msg(sid(), HUMAN)), Array.from({ length: 10 }, (_, i) => ipOf(i)));
  eqTally(rs, { ok: 6, limited: 0, busy: 4 });
  const g = JSON.parse([...env.cal.store(CAL).values()].map((e) => e.cur).find((e) => e.id === 'lumdemorlg01').description);
  assert.deepStrictEqual([g.h.n, g.d.n], [6, 6], 'the overall counter holds exactly the 6 allowed requests');
  assert.ok(env.cal.log.some((x) => x.method === 'PUT' && x.url.indexOf('lumdemorlg01') >= 0 && x.status === 412), 'contention on the overall counter was exercised');
});

test('RL8 heavy burst: 40 simultaneous requests of one session, from one IP -> exactly the limits, every increment kept', async () => {
  const env = makeEnv({ main: TINY_MAIN }); const s = sid();
  const rs = await sendMany(env, Array.from({ length: 40 }, () => msg(s, HUMAN)), Array.from({ length: 40 }, () => ({ ip: '192.0.2.99' })));
  const t = tally(rs);
  // A request is allowed only if BOTH its own committed session count (<= 3) and IP count (<= 5) are
  // within the limits; the two counters commit in different orders, so 1 to 3 requests qualify - never more.
  // Contention may make some requests give up waiting: they are REFUSED ("busy"), never let through.
  assert.ok(t.ok >= 1 && t.ok <= 3, 'never more than the session limit: ' + JSON.stringify(t));
  assert.strictEqual(t.ok + t.limited + t.busy, 40, JSON.stringify(t));
  const objs = [...env.cal.store(CAL).values()].map((e) => e.cur);
  const sc = JSON.parse(objs.find((e) => /^lumdemorls/.test(e.id)).description).c.n, ic = JSON.parse(objs.find((e) => /^lumdemorli/.test(e.id)).description).c.n;
  // No lost increment: every request that got past the counters was committed on both of them.
  assert.ok(sc >= t.ok + t.limited && ic >= t.ok + t.limited, 'every committed request was counted: session ' + sc + ', ip ' + ic + ', ' + JSON.stringify(t));
  if (t.busy === 0) assert.deepStrictEqual([sc, ic], [40, 40], 'all 40 increments kept');
  const g = JSON.parse(objs.find((e) => e.id === 'lumdemorlg01').description);
  assert.strictEqual(g.h.n, t.ok, 'only allowed requests used the overall budget');
});

test('RL4 overall daily cap and window resets: the hour resets, the day (cap 9) does not, the next day does', async () => {
  const env = makeEnv({ main: TINY_MAIN });
  let n = 0; const burst = async (k) => sendMany(env, Array.from({ length: k }, () => msg(sid(), HUMAN)), Array.from({ length: k }, () => ipOf(n++)));
  eqTally(await burst(6), { ok: 6, limited: 0, busy: 0 });
  env.sim.now += 3600001;
  eqTally(await burst(6), { ok: 3, limited: 0, busy: 3 }, 'new hour, but only 3 left today');
  env.sim.now += 24 * 3600001;
  eqTally(await burst(2), { ok: 2, limited: 0, busy: 0 }, 'next day');
});

test('RL5 a limited request never consumes the overall budget; boundary requests at the exact limit are allowed', async () => {
  const env = makeEnv({ main: TINY_MAIN }); const s = sid();
  const first = await sendMany(env, Array.from({ length: 5 }, () => msg(s, HUMAN)), Array.from({ length: 5 }, (_, i) => ipOf(i)));
  assert.deepStrictEqual(tally(first), { ok: 3, limited: 2, busy: 0 }, 'the 3rd (= limit) is allowed, the 4th and 5th are not');
  const rest = await sendMany(env, Array.from({ length: 4 }, () => msg(sid(), HUMAN)), Array.from({ length: 4 }, (_, i) => ipOf(50 + i)));
  eqTally(rest, { ok: 3, limited: 0, busy: 1 }, 'only the 3 allowed requests used the cap of 6');
});

test('RL6 counter storage failure fails closed: "busy" notice, no AI call, nothing stored', async () => {
  const env = makeEnv({ main: TINY_MAIN, ai: { behave: () => ({ thinkMs: 10, output: 'OK' }) } });
  env.cal.opts.fault = (req) => (/lumdemorl/.test(req.url || '') ? { kind: '503' } : null);
  const r = await send(env, msg(sid(), 'Hello'));
  assert.strictEqual(r.body.reply, T.en.busy, r.body.reply);
  assert.strictEqual(env.aiCalls.length, 0);
});

test('RL7 counters hold only hashed keys and counts: no session id, IP or message in the stored objects', async () => {
  const env = makeEnv({ main: TINY_MAIN }); const s = 'secret-session-zorglub-1';
  await sendMany(env, [msg(s, HUMAN + ' Zorglub')], [{ ip: '203.0.113.250' }]);
  const rl = [...env.cal.store(CAL).values()].map((e) => e.cur).filter((e) => /^lumdemorl/.test(e.id));
  assert.strictEqual(rl.length, 3, 'one counter object for the session, the IP and the overall budget');
  const dump = JSON.stringify(rl);
  for (const bad of ['zorglub', 'Zorglub', '203.0.113.250', s]) assert.ok(dump.indexOf(bad) < 0, 'counter objects contain ' + bad);
  for (const e of rl) assert.ok(/^[0-9a-v]+$/.test(e.id) && e.transparency === 'transparent' && e.start.dateTime.indexOf('2000-01-01') === 0, e.id);
});

runTests('web-demo').then((r) => process.exit(r.fail ? 1 : 0));
