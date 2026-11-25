'use strict';
const fs = require('fs');
const path = require('path');
const { Sim } = require('./sim');
const { FakeCalendar } = require('./fake-calendar');
const { Runner, KillSignal } = require('./runner');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG = require(path.join(ROOT, 'engine', 'config.js'));
const FILES = require(path.join(ROOT, 'tools', 'build-workflows.js')).FILES;
const WF_IDS = require(path.join(ROOT, 'lumiere.config.js')).workflows; // key -> n8n workflow id
const cache = {};
function wf(key) { if (!cache[key]) cache[key] = JSON.parse(fs.readFileSync(path.join(ROOT, FILES[key]), 'utf8')); return cache[key]; }

// Monday 2026-10-05 08:00 Africa/Algiers
const START = Date.UTC(2026, 9, 5, 7, 0, 0);
const STAFF = '213555778740';

function makeEnv(o) {
  o = o || {};
  const sim = new Sim(o.start || START, o.seed);
  const cal = new FakeCalendar(sim, o.cal);
  return {
    sim, cal, persisted: new Map(),
    envVars: { LUMIERE_WHATSAPP_PHONE_NUMBER_ID: '1179558585244913', LUMIERE_WHATSAPP_ACCESS_TOKEN: 'test-token', LUMIERE_STAFF_CHAT_ID: STAFF },
    opts: Object.assign({ staticBroken: false, itemLinkBroken: false, enforceTimeout: false }, o.opts || {}),
    rec: { ai: [], sends: [], sheetsWrites: [], logs: [], toolResults: [] },
    sheet: { handoffs: [] },
    faults: o.faults || {},
    ai: o.ai || {},
  };
}
function runner(env, key, hooks) {
  const w = (env.wfOverrides && env.wfOverrides[key]) || wf(key);
  return new Runner(w, { sim: env.sim, persisted: env.persisted, envVars: env.envVars, opts: env.opts, hooks });
}
// Copy of a workflow with a textual change applied to every engine Decide node
// (used for mutation tests that prove a safety mechanism is load-bearing).
function mutate(key, from, to) {
  const w = JSON.parse(JSON.stringify(wf(key)));
  let n = 0;
  for (const node of w.nodes) if (node.parameters && typeof node.parameters.jsCode === 'string' && node.parameters.jsCode.indexOf(from) >= 0) { node.parameters.jsCode = node.parameters.jsCode.split(from).join(to); n++; }
  if (!n) throw new Error('mutate: pattern not found: ' + from);
  return w;
}

// ---- calendar tool sub-workflows (Book / Cancel / Reschedule / Find / Check)
async function callTool(env, key, inputs, extraHooks) {
  const r = runner(env, key, Object.assign({
    http: (req) => env.cal.request(req),
    nodes: {},
    types: {
      'n8n-nodes-base.googleCalendar': async (items, run, node) => googleCalendarNode(env, run, node, items),
    },
  }, extraHooks || {}));
  const res = await r.run('Execute Workflow Trigger', [{ json: inputs }]);
  const out = res.output && res.output[0] && res.output[0].json;
  const result = out ? out.result : undefined;
  const rec = { key, inputs, result, res };
  env.rec.toolResults.push(rec);
  return rec;
}
// Confirmation gate: Cancel / Reschedule first PROPOSE (CONFIRMATION_REQUIRED, nothing changed);
// the change runs only in a second, EXECUTE call carrying the one-time id and the customer's yes
// from a later message. This helper performs both steps exactly like the main workflow does.
const { createConfirm } = require(path.join(ROOT, 'engine', 'confirm.js'));
const CONF = createConfirm();
let CONFIRM_SEQ = 1;
async function callConfirmed(env, key, inputs, extraHooks, o) {
  o = o || {};
  const p = await callTool(env, key, inputs, extraHooks);
  const m = /CONFIRMATION_REQUIRED/.test(String(p.result)) ? CONF.unmark(p.result) : null;
  if (!m) return Object.assign(p, { proposal: null }); // refused before any confirmation (NOT_FOUND, CONFLICT, ...)
  if (o.beforeConfirm) await o.beforeConfirm(m);
  const ex = Object.assign({}, inputs, { confirm_id: m.id, confirm_message: o.message || 'yes', confirm_msg_id: o.msgId || 'confirm-msg-' + (CONFIRM_SEQ++), confirm_via: 'text' }, o.exec || {});
  const rec = await callTool(env, key, ex, extraHooks);
  return Object.assign(rec, { proposal: p, confirm: m });
}
// n8n googleCalendar node (getAll) used by the read-only tools, served by the fake calendar.
async function googleCalendarNode(env, run, node, items) {
  const p = node.parameters;
  const ctx = run.exprCtx(items[0], 0, items);
  const tMin = run.evalExpr(p.options.timeMin, ctx), tMax = run.evalExpr(p.options.timeMax, ctx);
  const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(p.calendar.value) + '/events?timeMin=' + encodeURIComponent(new Date(tMin).toISOString()) + '&timeMax=' + encodeURIComponent(new Date(tMax).toISOString()) + '&maxResults=2500';
  const r = await env.cal.request({ method: 'GET', url, timeout: 10000 });
  if (r.statusCode !== 200) throw new Error('calendar ' + r.statusCode);
  const evs = r.body.items || [];
  return evs.length ? evs.map((e) => ({ json: e })) : (node.alwaysOutputData ? [{ json: {} }] : []);
}

// ---- main WhatsApp workflow
function mainHooks(env) {
  return {
    http: async (req, run) => {
      if (req.url.indexOf('googleapis.com/calendar') >= 0) return env.cal.request(req);
      if (req.url.indexOf('graph.facebook.com') >= 0) {
        await env.sim.sleep(40);
        if (env.faults.media) throw new Error('media lookup failed');
        return { statusCode: 200, body: { url: 'https://media.example/' + req.url.split('/').pop() } };
      }
      if (req.url.indexOf('media.example') >= 0) { await env.sim.sleep(60); return { statusCode: 200, binary: { data: { fileName: 'voice.oga', mimeType: 'audio/ogg' } } }; }
      if (req.url.indexOf('cohere.com') >= 0) {
        await env.sim.sleep(env.faults.transcribeMs || 1500);
        if (env.faults.transcribe) throw new Error('cohere 500');
        return { statusCode: 200, body: { text: env.voiceRaw != null ? env.voiceRaw : 'VOICE:' + (env.voiceText || 'voice note') } };
      }
      throw new Error('unexpected http ' + req.url);
    },
    nodes: {
      'Check Handoff Status': async () => {
        await env.sim.sleep(80);
        if (env.faults.sheetsRead) throw new Error('Google Sheets 503');
        return env.sheet.handoffs.length ? env.sheet.handoffs.map((r) => ({ json: Object.assign({}, r) })) : [{ json: {} }];
      },
      'Write Pause Row': async (items, run) => {
        await env.sim.sleep(80);
        if (env.faults.pauseWrite) throw new Error('Google Sheets 503');
        const id = String(run.accessor()('Dedup & Filter Prep').first().json.chatId).replace(/\D/g, '');
        upsertRow(env, id, 'paused');
        env.rec.sheetsWrites.push({ t: env.sim.now, id, status: 'paused' });
        return items;
      },
      'Write Unmute Row': async (items) => {
        await env.sim.sleep(80);
        upsertRow(env, items[0].json.unmuteTargetPhone, 'unmuted');
        return items;
      },
      'Log Conversation': async (items, run) => {
        await env.sim.sleep(50);
        if (env.faults.log) throw new Error('Sheets log failed');
        env.rec.logs.push({ t: env.sim.now, chat: run.accessor()('Dedup & Filter Prep').first().json.chatId });
        return items;
      },
    },
    types: {
      // Execute Workflow (confirmation gate): runs the tool sub-workflow with the node's mapped inputs.
      'n8n-nodes-base.executeWorkflow': async (items, run, node) => {
        const ctx = run.exprCtx(items[0], 0, items);
        const inputs = {};
        for (const [field, expr] of Object.entries(node.parameters.workflowInputs.value)) inputs[field] = run.evalExpr(expr, ctx);
        const id = node.parameters.workflowId.value;
        const key = Object.keys(WF_IDS).find((k) => WF_IDS[k] === id);
        if (!key) throw new Error(node.name + ' points at an unknown workflow ' + id);
        const rec = await callTool(env, key, inputs);
        rec.exec = true;
        return [[{ json: (rec.res.output && rec.res.output[0] && rec.res.output[0].json) || {} }]];
      },
      'n8n-nodes-base.whatsApp': async (items, run, node) => {
        const ctx = run.exprCtx(items[0], 0, items);
        const to = run.evalExpr(node.parameters.recipientPhoneNumber, ctx);
        const text = run.evalExpr(node.parameters.textBody, ctx);
        await env.sim.sleep(60);
        if (env.faults.whatsapp && env.faults.whatsapp(node.name, to)) throw new Error('WhatsApp API 500');
        env.rec.sends.push({ t: env.sim.now, node: node.name, to, text, exec: run.execId });
        return items;
      },
      '@n8n/n8n-nodes-langchain.agent': async (items, run, node) => {
        const d = run.accessor()('Dedup & Filter Prep').first().json;
        const ctx = run.exprCtx(items[0], 0, items);
        const prompt = run.evalExpr(node.parameters.text, ctx);
        const call = { chat: d.chatId, msgId: d.messageId, msgTs: d.msgTs, text: items[0].json.userText, prompt, t0: env.sim.now, t1: null, exec: run.execId };
        env.rec.ai.push(call);
        const behave = (env.ai.behave && env.ai.behave(call, run)) || {};
        await env.sim.sleep(behave.thinkMs != null ? behave.thinkMs : env.ai.thinkMs || 4000);
        if (behave.kill) { call.t1 = env.sim.now; call.crashed = true; throw new KillSignal('n8n worker crashed during AI Agent'); }
        if (behave.fail) { call.t1 = env.sim.now; call.failed = true; throw new Error('LLM provider error'); }
        let steps = [];
        if (behave.tools) steps = await behave.tools(env, run);
        call.t1 = env.sim.now;
        return [{ json: { output: behave.output || ('تمام، وصلتني رسالتك: ' + call.text), intermediateSteps: steps } }];
      },
    },
  };
}
function upsertRow(env, id, status) {
  const row = env.sheet.handoffs.find((r) => String(r.Patient_ID) === String(id));
  if (row) row.Status = status; else env.sheet.handoffs.push({ Patient_ID: id, Status: status, Timestamp: new Date(env.sim.now).toISOString() });
}
let MSG = 1;
function waMessage(env, from, o) {
  o = o || {};
  const id = o.id || 'wamid.' + (MSG++);
  const ts = o.ts != null ? o.ts : Math.floor(env.sim.now / 1000);
  const m = { from, id, timestamp: String(ts), type: o.type || 'text' };
  if (m.type === 'text') m.text = { body: o.text || 'hello' };
  if (m.type === 'audio') m.audio = { id: 'media-' + id };
  if (m.type === 'image') m.image = { id: 'img-' + id };
  return { json: { messages: [m], contacts: [{ profile: { name: 'Patient' } }] }, _id: id, _ts: ts };
}
async function deliver(env, item) {
  const r = runner(env, 'main', mainHooks(env));
  const res = await r.run('WhatsApp Trigger', [{ json: item.json }]);
  (env.rec.execs = env.rec.execs || []).push(res);
  return res;
}
async function runAll(env, tasks) {
  const ps = tasks.map((f) => f());
  await env.sim.run();
  return Promise.all(ps);
}
const at = (env, ms, fn) => async () => { await env.sim.sleep(ms); return fn(); };

// A catalogue service (salon-info.js) of a given length in minutes, for tests that only care about the length.
const SVC_FOR = { 30: 'mens_cut', 45: 'manicure', 60: 'womens_cut', 90: 'root_colour', 120: 'full_colour', 150: 'keratin', 180: 'balayage', 240: 'balayage,womens_cut' };
const svcFor = (min) => { if (!SVC_FOR[min]) throw new Error('no catalogue service of ' + min + ' min'); return SVC_FOR[min]; };
module.exports = { svcFor, makeEnv, callTool, callConfirmed, CONF, deliver, waMessage, runAll, at, wf, mutate, CFG, START, STAFF, ROOT, FILES, KillSignal, _mainHooks: mainHooks };
