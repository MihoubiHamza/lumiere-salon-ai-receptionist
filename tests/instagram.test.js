'use strict';
// Instagram Direct workflow: static checks + execution of the REAL Instagram JSON
// (and, for cross-channel tests, the WhatsApp and Messenger JSON) against the fake
// Google Calendar, with stubbed Graph API / Sheets / AI Agent. Nothing is sent to Meta.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/harness');
const { Runner } = require('./lib/runner');
const { test, runTests } = require('./lib/t');
const { CFG, makeEnv, runAll, at, callTool, deliver, waMessage, STAFF, ROOT, CONF } = H;
const IB = require(path.join(ROOT, 'tools', 'build-instagram.js'));
const MB = require(path.join(ROOT, 'tools', 'build-messenger.js'));
const WB = require(path.join(ROOT, 'tools', 'build-workflows.js'));
const ENV = require(path.join(ROOT, 'lumiere.config.js'));
const chatLock = require(path.join(ROOT, 'engine', 'engine.js')).createEngine(CFG)._t.chatLockId;
const LOCKCAL = CFG.LOCK_CALENDAR_ID;

const readWf = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const IG = readWf(IB.OUT_FILE);
const MSG = readWf(MB.OUT_FILE);
const WA = H.wf('main');
const SEND = IB.SEND_URL;
const SECRET = 'test-app-secret-0123456789abcdef';
const VERIFY = 'ig-verify-me-token';
const ACCT = '17841400000000001', OTHER = '17841499999999999', PAGE = '102030405060708';
// Instagram-scoped ids (like real ones) and a WhatsApp customer number.
const A = '5512345678901234', B = '5598765432109876', WAP = '213555000001';
const IK = (igsid, acct) => 'ig:' + (acct || ACCT) + ':' + igsid;
const FK = (psid) => 'fb:' + PAGE + ':' + psid;
const REPLY = 'Hello! How can I help you today?';
const byNode = (w, n) => w.nodes.find((x) => x.name === n);
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const NOT_SENT = (n) => 'Not Sent - 24h Window Closed (' + n + ')';

// ------------------------------------------------------------------ harness
function env(o) {
  const e = makeEnv(Object.assign({ ai: { behave: () => ({ output: REPLY }) } }, o));
  Object.assign(e.envVars, { LUMIERE_INSTAGRAM_APP_SECRET: SECRET, LUMIERE_INSTAGRAM_VERIFY_TOKEN: VERIFY, LUMIERE_INSTAGRAM_ACCOUNT_ID: ACCT,
    LUMIERE_MESSENGER_APP_SECRET: SECRET, LUMIERE_MESSENGER_VERIFY_TOKEN: 'messenger-token' });
  Object.assign(e.rec, { responses: [], igReqs: [], execs: [], downloads: [], stt: [] });
  e.pending = [];
  e.voice = { bytes: AUDIO.m4a, mime: 'audio/mp4', result: STT.en };
  return e;
}
// ---- voice fixtures (MOCKED provider). Audio bytes start with each format's real signature.
const padTo = (head, n) => Buffer.concat([head, Buffer.alloc(Math.max(0, n - head.length), 7)]);
const AUDIO = {
  m4a: padTo(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypM4A \0\0\0\0isomM4A mp42', 'latin1')]), 6000),
  ogg: padTo(Buffer.from('OggS\0\x02\0\0', 'latin1'), 5000),
  aac: padTo(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc]), 5000),
  webm: padTo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]), 5000),
  wav: padTo(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'), 5000),
  mp3: padTo(Buffer.from('ID3\x04\0\0\0\0', 'latin1'), 5000),
  pdf: padTo(Buffer.from('%PDF-1.7\n', 'latin1'), 5000), // not audio
  tiny: Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypM4A ', 'latin1')]),
};
const STT = {
  en: { text: "Hi, I'd like to book a women's haircut tomorrow at 10 am.", language: 'english', duration: 3.9 },
  fr: { text: "Bonjour, je voudrais réserver une coupe femme demain à 10 heures, s'il vous plaît.", language: 'french', duration: 4.4 },
  es: { text: 'Hola, quiero reservar un corte de mujer mañana a las diez, por favor.', language: 'spanish', duration: 4.1 },
  ar: { text: 'مرحبا، أريد حجز قص شعر نسائي غدا الساعة العاشرة من فضلك.', language: 'arabic', duration: 4.6 },
};
const CDN = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=';
function hooks(e, wf) {
  const channel = wf === MSG ? 'messenger' : 'instagram';
  const h = H._mainHooks(e);
  const baseHttp = h.http;
  h.http = async (req, run) => {
    // Meta media CDN (voice download) - MOCKED.
    if (typeof req.url === 'string' && req.url.indexOf(CDN) === 0) {
      await e.sim.sleep(80);
      e.rec.downloads.push({ url: req.url, headers: req.headers, credentials: req.credentials, method: req.method });
      if (e.faults.voiceDownload) throw new Error('Request failed with status code 403');
      return { statusCode: 200, binary: { data: { fileName: 'audioclip-1.mp4', mimeType: e.voice.mime, data: e.voice.bytes.toString('base64') } } };
    }
    // OpenRouter speech-to-text - MOCKED.
    if (req.url === IB.VOICE.url) {
      await e.sim.sleep(e.faults.sttMs || 1200);
      e.rec.stt.push({ method: req.method, form: req.form, credentials: req.credentials, chat: run.accessor()('Dedup & Filter Prep').first().json.customerKey });
      if (e.faults.stt) throw new Error('Request failed with status code 502');
      return { statusCode: 200, body: typeof e.voice.result === 'function' ? e.voice.result(req, run) : e.voice.result };
    }
    if (req.url === SEND) {
      await e.sim.sleep(60);
      const to = req.body.recipient.id, text = req.body.message.text;
      if (e.faults.send && e.faults.send(req.node, to)) return { statusCode: 500, body: { error: { message: 'Graph 500' } } };
      e.rec.igReqs.push(req);
      e.rec.sends.push({ t: e.sim.now, node: req.node, to, text, exec: run.execId, channel, body: req.body, cred: req.credentials });
      return { statusCode: 200, body: { recipient_id: to, message_id: 'mid.out' } };
    }
    if (/^https:\/\/graph\.facebook\.com\/v25\.0\/\d+\?fields=name,username$/.test(req.url)) {
      await e.sim.sleep(40);
      if (e.faults.profile) return { statusCode: 400, body: { error: { message: 'no consent' } } };
      return { statusCode: 200, body: { name: 'Lina Haddad', username: 'lina.h', id: req.url.split('/').pop().split('?')[0] } };
    }
    if (/^https:\/\/graph\.facebook\.com\/v25\.0\/\d+\?fields=first_name,last_name$/.test(req.url)) return { statusCode: 200, body: { first_name: 'Sara', last_name: 'Benali' } };
    return baseHttp(req, run);
  };
  Object.assign(h.types, {
    'n8n-nodes-base.webhook': async (items) => [items],
    'n8n-nodes-base.respondToWebhook': async (items, run, node) => {
      const ctx = run.exprCtx(items[0], 0, items);
      e.rec.responses.push({ node: node.name, code: node.parameters.options.responseCode, body: run.evalExpr(node.parameters.responseBody, ctx) });
      return [items];
    },
    'n8n-nodes-base.executeWorkflow': async (items, run, node) => {
      if (node.parameters.workflowId.value !== '={{ $workflow.id }}') return H._mainHooks(e).types['n8n-nodes-base.executeWorkflow'](items, run, node);
      assert.strictEqual(node.parameters.mode, 'each');
      assert.strictEqual(node.parameters.options.waitForSubWorkflow, false);
      for (const it of items) e.pending.push(runWf(e, wf, wf === MSG ? 'Messenger Event' : 'Instagram Event', [{ json: JSON.parse(JSON.stringify(it.json)) }]));
      return [items];
    },
  });
  Object.assign(h.nodes, {
    'Write Pause Row': async (items, run, node) => {
      await e.sim.sleep(80);
      if (e.faults.pauseWrite) throw new Error('Google Sheets 503');
      const id = run.evalExpr(node.parameters.columns.value.Patient_ID, run.exprCtx(items[0], 0, items));
      const row = e.sheet.handoffs.find((r) => String(r.Patient_ID) === id);
      if (row) row.Status = 'paused'; else e.sheet.handoffs.push({ Patient_ID: id, Status: 'paused' });
      e.rec.sheetsWrites.push({ t: e.sim.now, id, status: 'paused' });
      return items;
    },
    'Log Conversation': async (items, run, node) => {
      await e.sim.sleep(50);
      const ctx = run.exprCtx(items[0], 0, items);
      e.rec.logs.push({ t: e.sim.now, phone: run.evalExpr(node.parameters.columns.value.Phone, ctx), reply: run.evalExpr(node.parameters.columns.value.BotReply, ctx) });
      return items;
    },
  });
  return h;
}
async function runWf(e, wf, entry, items) {
  const r = new Runner(wf, { sim: e.sim, persisted: e.persisted, envVars: e.envVars, opts: e.opts, hooks: hooks(e, wf === MSG ? MSG : IG) });
  const res = await r.run(entry, items);
  e.rec.execs.push(res);
  return res;
}
const metaJson = (o) => JSON.stringify(o).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).replace(/\//g, '\\/');
const sign = (raw, secret) => 'sha256=' + crypto.createHmac('sha256', secret || SECRET).update(raw).digest('hex');
function webhookItem(body, o) {
  o = o || {};
  const raw = o.raw || metaJson(body);
  const headers = { 'content-type': 'application/json' };
  if (o.sig !== null) headers['x-hub-signature-256'] = o.sig || sign(o.signedRaw || raw, o.secret);
  const item = { json: { headers, params: {}, query: {}, body: JSON.parse(raw) } };
  if (!o.noRaw) item.binary = { data: { data: Buffer.from(raw, 'utf8').toString('base64'), mimeType: 'application/json' } };
  return item;
}
function post(e, events, o, wf) {
  o = o || {};
  const entry = { id: o.acct !== undefined ? o.acct : ACCT, time: e.sim.now, messaging: events };
  if (entry.id === null) delete entry.id;
  return runWf(e, wf || IG, 'Instagram Webhook', [webhookItem({ object: o.object || 'instagram', entry: [entry] }, o)]);
}
function postMessenger(e, psid, text) {
  const event = { sender: { id: psid }, recipient: { id: PAGE }, timestamp: e.sim.now, message: { mid: 'm_fb' + SEQ++, text } };
  return runWf(e, MSG, 'Messenger Webhook', [webhookItem({ object: 'page', entry: [{ id: PAGE, time: e.sim.now, messaging: [event] }] })]);
}
let SEQ = 1;
function ev(e, igsid, o) {
  o = o || {};
  const base = { sender: { id: igsid }, recipient: { id: o.to || ACCT }, timestamp: o.ts != null ? o.ts : e.sim.now };
  if (o.postback) return Object.assign(base, { postback: { mid: 'ig_pb' + SEQ++, title: o.postback, payload: 'ICEBREAKER_1' } });
  if (o.reaction) return Object.assign(base, { reaction: { mid: 'ig_x', action: 'react', reaction: 'love', emoji: '❤️' } });
  if (o.read) return Object.assign(base, { read: { mid: 'ig_x' } });
  const message = { mid: o.mid || 'ig_' + SEQ++ };
  const att = (type, extra) => [Object.assign({ type, payload: { url: 'https://lookaside.example/ig/' + type } }, extra || {})];
  if (o.attach) message.attachments = o.attach === 'ephemeral' ? [{ type: 'ephemeral' }] : att(o.attach);
  else if (o.unsupported) message.is_unsupported = true;
  else message.text = o.text != null ? o.text : 'hello';
  if (o.storyReply) message.reply_to = { story: { url: 'https://lookaside.example/story', id: '1789' } };
  if (o.echo) message.is_echo = true;
  if (o.deleted) message.is_deleted = true;
  return Object.assign(base, { message });
}
async function all(e, tasks) {
  await runAll(e, tasks);
  while (e.pending.length) { const p = e.pending.splice(0); await Promise.all(p); }
}
const aiFor = (e, chat) => e.rec.ai.filter((a) => a.chat === chat).sort((x, y) => x.t0 - y.t0);
const igTo = (e, id) => e.rec.sends.filter((s) => s.channel === 'instagram' && s.to === id);
const staffAlerts = (e) => e.rec.sends.filter((s) => s.to === STAFF);
function lockFree(e, key) {
  const st = e.cal.lockState(LOCKCAL, chatLock(key));
  assert.ok(st, 'no chat lock object for ' + key);
  assert.ok(!st.h || st.hx <= e.sim.now, 'chat lock for ' + key + ' still held at end');
  assert.deepStrictEqual(st.w || [], [], 'waiters left behind for ' + key);
  assert.deepStrictEqual(e.cal.violations, [], 'mutual exclusion violated');
}
const noErrors = (e) => { for (const r of e.rec.execs) assert.ok(!r.error, 'execution failed: ' + (r.error && (r.error.node + ': ' + r.error.message))); };
const ran = (e, node) => e.rec.execs.some((r) => r.runner && r.runner.runData && r.runner.runData[node]);
function* strings(o, p) {
  if (typeof o === 'string') { yield [p, o]; return; }
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) yield* strings(o[i], p + '[' + i + ']'); return; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) yield* strings(o[k], p + '.' + k);
}
const mutate = (node, from, to, field) => {
  const w = JSON.parse(JSON.stringify(IG)); const n = byNode(w, node);
  const get = () => (field ? field(n) : n.parameters.jsCode);
  assert.ok(get().indexOf(from) >= 0, 'mutation anchor ' + from);
  if (field) field(n, get().split(from).join(to)); else n.parameters.jsCode = get().split(from).join(to);
  return w;
};
// Runs a (mutated) copy of the workflow; its self-calls run that same copy.
async function postWith(e, wf, events, o) {
  const item = webhookItem({ object: 'instagram', entry: [{ id: ACCT, time: e.sim.now, messaging: events }] }, o);
  const make = () => {
    const h = hooks(e, IG);
    h.types['n8n-nodes-base.executeWorkflow'] = async (items) => {
      for (const it of items) e.pending.push(new Runner(wf, { sim: e.sim, persisted: e.persisted, envVars: e.envVars, opts: e.opts, hooks: make() })
        .run('Instagram Event', [{ json: JSON.parse(JSON.stringify(it.json)) }]).then((res) => { e.rec.execs.push(res); return res; }));
      return [items];
    };
    return h;
  };
  const res = await new Runner(wf, { sim: e.sim, persisted: e.persisted, envVars: e.envVars, opts: e.opts, hooks: make() }).run('Instagram Webhook', [item]);
  e.rec.execs.push(res);
  return res;
}

// ------------------------------------------------------------------ static checks
test('IG1 Instagram JSON is exactly what tools/build-instagram.js produces (idempotent)', () => {
  const a = JSON.stringify(IB.build(), null, 2) + '\n';
  assert.strictEqual(a, JSON.stringify(IB.build(), null, 2) + '\n', 'build is not deterministic');
  assert.strictEqual(a, fs.readFileSync(path.join(ROOT, IB.OUT_FILE), 'utf8'), 'Instagram workflow is stale - run node tools/build-instagram.js');
});

test('IG2 building Instagram never changes other files; own id, webhook path and webhook ids; Messenger webhook untouched', () => {
  const files = Object.values(WB.FILES).concat([WB.ERROR_WORKFLOW_FILE, MB.OUT_FILE]);
  const before = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  IB.build();
  files.forEach((f, i) => assert.strictEqual(fs.readFileSync(path.join(ROOT, f), 'utf8'), before[i], f + ' was modified'));
  assert.strictEqual(IG.id, ENV.workflows.instagram);
  const ids = files.map((f) => readWf(f).id);
  assert.ok(ids.indexOf(IG.id) < 0, 'Instagram workflow id must be new (import would overwrite)');
  assert.strictEqual(IG.active, false, 'import inactive; activate after setup');
  const hooksOf = (w) => w.nodes.filter((n) => n.webhookId).map((n) => n.webhookId);
  const others = new Set(files.flatMap((f) => hooksOf(readWf(f))));
  for (const h of hooksOf(IG)) assert.ok(!others.has(h), 'webhookId reused: ' + h);
  const hooks = IG.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  assert.deepStrictEqual(hooks.map((n) => n.parameters.httpMethod).sort(), ['GET', 'POST']);
  for (const n of hooks) assert.strictEqual(n.parameters.path, ENV.INSTAGRAM_WEBHOOK_PATH);
  assert.notStrictEqual(ENV.INSTAGRAM_WEBHOOK_PATH, ENV.MESSENGER_WEBHOOK_PATH);
  for (const n of MSG.nodes.filter((x) => x.type === 'n8n-nodes-base.webhook')) assert.strictEqual(n.parameters.path, ENV.MESSENGER_WEBHOOK_PATH, 'Messenger webhook path unchanged');
  assert.ok(!IG.nodes.some((n) => n.type === 'n8n-nodes-base.whatsAppTrigger'), 'must not register a WhatsApp webhook');
  assert.strictEqual(IG.settings.errorWorkflow, ENV.workflows.error);
});

test('IG3 graph integrity: unique names/ids, valid connections, references, no orphans, code compiles, current engine copy', () => {
  const w = IG;
  const names = w.nodes.map((n) => n.name), ids = w.nodes.map((n) => n.id);
  assert.strictEqual(new Set(names).size, names.length, 'duplicate node names');
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate node ids');
  const set = new Set(names), seen = new Set();
  for (const src of Object.keys(w.connections)) {
    assert.ok(set.has(src), 'connection from missing node ' + src);
    seen.add(src);
    const node = byNode(w, src);
    for (const type of Object.keys(w.connections[src])) {
      const outs = w.connections[src][type];
      if (type === 'main') {
        let max = node.type === 'n8n-nodes-base.if' ? 2 : node.type === 'n8n-nodes-base.switch' ? node.parameters.rules.values.length : 1;
        if (node.onError === 'continueErrorOutput') max += 1;
        assert.ok(outs.length <= max, src + ' wires ' + outs.length + ' outputs, only ' + max + ' exist');
      }
      for (const o of outs) for (const c of o || []) { assert.ok(set.has(c.node), src + ' -> missing ' + c.node); seen.add(c.node); }
    }
  }
  assert.deepStrictEqual(w.nodes.filter((n) => !seen.has(n.name) && n.type !== 'n8n-nodes-base.stickyNote').map((n) => n.name), [], 'orphans');
  for (const n of w.nodes) for (const [p, s] of strings(n.parameters, n.name)) {
    for (const m of s.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) assert.ok(set.has(m[1]), p + ' references missing node ' + m[1]);
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const n of w.nodes) if (n.type === 'n8n-nodes-base.code') {
    try { new AsyncFunction('$input', '$', '$json', '$env', '$execution', '$runIndex', '$getWorkflowStaticData', 'DateTime', n.parameters.jsCode); }
    catch (e) { assert.fail(n.name + ' does not compile: ' + e.message); }
  }
  const eng = w.nodes.filter((n) => n.parameters && typeof n.parameters.jsCode === 'string' && n.parameters.jsCode.indexOf('function createEngine(') >= 0);
  assert.strictEqual(eng.length, 1);
  assert.ok(eng[0].parameters.jsCode.indexOf(WB.engineSource()) >= 0, 'stale engine copy');
  assert.deepStrictEqual(w.settings, WA.settings, 'same execution settings as WhatsApp');
});

test('IG4 every customer path releases the chat lock; every message to the customer passes the 24-hour window guard', () => {
  const w = IG;
  const next = (n) => { const c = w.connections[n]; return c && c.main ? c.main.flat().filter(Boolean).map((x) => x.node) : []; };
  const allowed = new Set(['Chat Lock Released', 'Duplicate Message - Stop', 'Release Failed - Lease Expires']);
  const seen = new Set(), stack = ['Chat Lock Acquired'];
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue; seen.add(n);
    const nx = next(n);
    if (!nx.length) assert.ok(allowed.has(n), 'path ends at ' + n + ' without releasing the chat lock');
    for (const x of nx) stack.push(x);
  }
  const sends = w.nodes.filter((n) => n.parameters && n.parameters.url === SEND);
  assert.strictEqual(sends.length, 3 + IB.IG_MAX_PARTS, 'unsupported, voice failed, fallback and the reply parts');
  const parents = (t) => Object.keys(w.connections).filter((s) => next(s).indexOf(t) >= 0);
  for (const s of sends) {
    assert.ok(seen.has(s.name), s.name + ' not on a lock-protected path');
    for (const p of parents(s.name)) {
      assert.ok(/^24h Window Open\? \(/.test(p) || /^Has Part \d+\?$/.test(p), s.name + ' is reached from ' + p + ' without the window guard');
    }
  }
  const guards = w.nodes.filter((n) => /^24h Window Open\? \(/.test(n.name));
  assert.deepStrictEqual(guards.map((n) => n.name.slice('24h Window Open? ('.length, -1)).sort(), ['Send Fallback Reply', 'Send Instagram Reply', 'Send Unsupported Reply', 'Send Voice Failed Reply']);
  for (const g of guards) assert.strictEqual(g.parameters.conditions.conditions[0].leftValue, "={{ Number($('Dedup & Filter Prep').first().json.msgTs) > 0 && Date.now() - Number($('Dedup & Filter Prep').first().json.msgTs) < " + IB.WINDOW_MS + ' }}');
  assert.ok(IB.WINDOW_MS < 24 * 3600000);
  assert.deepStrictEqual(w.connections['Dedup & Filter Prep'].main, [[{ node: 'Chat Lock: Acquire', type: 'main', index: 0 }]]);
});

test('IG5 tools: same sub-workflows, identity = verified ig: key (never the AI), text + voice in / text out, automated-assistant rules in the prompt', () => {
  for (const tool of ['Book_Appointment', 'Cancel_Appointment', 'Reschedule_Appointment', 'Find_Patient_Appointments', 'Check_Availability']) {
    const m = byNode(IG, tool), wa = byNode(WA, tool);
    assert.strictEqual(m.parameters.workflowId.value, wa.parameters.workflowId.value, tool + ' must call the same sub-workflow');
    assert.deepStrictEqual(Object.keys(m.parameters.workflowInputs.value).sort(), Object.keys(wa.parameters.workflowInputs.value).sort(), tool);
    const v = m.parameters.workflowInputs.value;
    if ('phone_number' in v) assert.strictEqual(v.phone_number, '', tool + ': no phone identity on Instagram');
    if (tool !== 'Check_Availability') assert.strictEqual(v.customer_key, WB.CUSTOMER_KEY_EXPR, tool);
    for (const [p, s] of strings(m.parameters, tool)) assert.ok(!/current WhatsApp number|than the one (they are )?texting|Messenger/.test(s), p + ' still talks about WhatsApp numbers or Messenger');
  }
  for (const n of ['Run Confirmed Cancel', 'Run Confirmed Reschedule']) {
    const v = byNode(IG, n).parameters.workflowInputs.value;
    assert.strictEqual(v.customer_key, WB.CUSTOMER_KEY_EXPR); assert.strictEqual(v.phone_number, '');
    assert.strictEqual(v.confirm_via, "={{ $('Merge Voice Text').isExecuted ? 'voice' : 'text' }}", n + ': a transcribed message is reported as voice (never a typed confirmation)');
  }
  assert.ok(/Instagram - Tel:/.test(byNode(IG, 'Book_Appointment').parameters.workflowInputs.value.notes));
  for (const n of ['Cohere Transcribe', 'Name Voice File']) assert.ok(!byNode(IG, n), n + ': the single-language Cohere path is not used on Instagram');
  for (const n of ['Download Voice Binary', 'Check Voice File', 'Transcribe Voice', 'Read Transcript', 'Voice Usable?', 'Merge Voice Text', 'Send Voice Failed Reply']) assert.ok(byNode(IG, n), n + ' is part of the Instagram voice path');
  const prompt = byNode(IG, 'AI Agent').parameters.options.systemMessage;
  assert.ok(prompt.indexOf('## INSTAGRAM DIRECT CHANNEL') > 0 && prompt.indexOf('AI Instagram receptionist') > 0);
  assert.ok(/MESSAGES: on Instagram you read typed text AND voice messages/.test(prompt) && /You ALWAYS reply in text \(never audio\)/.test(prompt), 'voice in, text out');
  assert.ok(/A VOICE MESSAGE NEVER CONFIRMS/.test(prompt) && /they must TYPE their answer/.test(prompt));
  assert.ok(!/TEXT ONLY: on Instagram/.test(prompt));
  assert.ok(/YOU ARE AN AUTOMATED AI ASSISTANT: never claim or imply that you are a human/.test(prompt) && /real person, a human or the team, call Escalate_to_Staff/.test(prompt));
  assert.ok(!/Messenger|Facebook account|Facebook Page/.test(prompt.split('on Facebook Messenger').join('')), 'prompt still describes Messenger');
  const waPrompt = byNode(WA, 'AI Agent').parameters.options.systemMessage;
  for (const h of waPrompt.match(/^##.*$/gm)) assert.ok(prompt.indexOf(h.replace('WHATSAPP', 'INSTAGRAM')) >= 0, 'lost prompt section ' + h);
  const text = byNode(IG, 'AI Agent').parameters.text;
  assert.ok(text.indexOf('Channel: Instagram Direct, text and voice messages, replies in text') > 0, text);
  assert.ok(text.indexOf("detected language: ' + $('Read Transcript').first(0).json.voiceLangName") > 0 && !/ONLY supported in|auto-transcribed as /.test(text), 'multilingual voice marker, no single-language wording');
  assert.strictEqual(byNode(IG, 'Simple Memory').parameters.sessionKey, "={{ $('Dedup & Filter Prep').first().json.customerKey }}_v1_lumiere_salon");
});

test('IG6 customers only ever receive Instagram messages (own credential, no Messenger-only fields); WhatsApp only for staff; no token in item data', () => {
  for (const n of IG.nodes.filter((x) => x.type === 'n8n-nodes-base.whatsApp')) {
    assert.ok(/^Alert Staff/.test(n.name), n.name + ' would WhatsApp the customer');
    assert.strictEqual(n.parameters.recipientPhoneNumber, "={{ $('Dedup & Filter Prep').first().json.staffChatId }}");
  }
  const http = IG.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' && !/^Engine/.test(x.name));
  for (const n of http) {
    // The voice download sends NO credential (pre-signed Meta CDN link); speech-to-text uses its own salon-only credential.
    if (n.name === 'Download Voice Binary') { assert.ok(!n.credentials, n.name + ' must never send a token'); continue; }
    if (n.name === 'Transcribe Voice') { assert.deepStrictEqual(n.credentials, { httpHeaderAuth: ENV.credentials.transcription }); continue; }
    assert.deepStrictEqual(n.credentials, { httpHeaderAuth: ENV.credentials.instagram }, n.name + ' must use the Instagram credential');
    if (n.parameters.url === SEND) {
      assert.ok(/recipient: \{ id: \$\('Dedup & Filter Prep'\)\.first\(\)\.json\.chatId \}/.test(n.parameters.jsonBody), n.name);
      assert.ok(!/messaging_type/.test(n.parameters.jsonBody), n.name + ': messaging_type is a Messenger field, not documented for Instagram');
    }
  }
  assert.notStrictEqual(ENV.credentials.instagram.id, ENV.credentials.facebookPage.id);
  const dedup = byNode(IG, 'Dedup & Filter Prep').parameters.jsCode;
  assert.ok(!/\$env\.\w*TOKEN|accessToken/.test(dedup), 'Dedup must not copy tokens into execution data');
  assert.ok(JSON.stringify(byNode(IG, 'Escalate to Staff').parameters).indexOf('$env.LUMIERE_WHATSAPP_ACCESS_TOKEN') >= 0);
  for (const n of IG.nodes) for (const [p, s] of strings(n.parameters, n.name)) assert.ok(!/LUMIERE_MESSENGER_/.test(s), p + ' reads a Messenger variable');
});

test('IG7 signature check: the embedded HMAC-SHA256 equals Node crypto (same code as Messenger)', () => {
  const code = byNode(IG, 'Verify Signature & Split').parameters.jsCode;
  const lib = code.slice(code.indexOf('const K = '), code.indexOf('async function rawBody'));
  assert.ok(byNode(MSG, 'Verify Signature & Split').parameters.jsCode.indexOf(lib) >= 0, 'same HMAC implementation as Messenger');
  const { hmacHex, utf8 } = new Function(lib + '\nreturn { hmacHex, sha256, utf8 };')();
  const rnd = require('./lib/sim').mulberry32(11);
  const str = (n) => Array.from({ length: n }, () => String.fromCharCode(rnd() < 0.2 ? 0x0600 + Math.floor(rnd() * 200) : 32 + Math.floor(rnd() * 90))).join('');
  for (let i = 0; i < 100; i++) {
    const key = str(Math.floor(rnd() * 150)), msg = str(Math.floor(rnd() * 600));
    assert.strictEqual(hmacHex(key, utf8(msg)), crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex'), 'hmac #' + i);
  }
});

test('IG8 fixed texts fit Instagram: at most 990 UTF-8 bytes, fewer than 1,000 characters, automated tag; voice notes offered in four languages', () => {
  const texts = [IB.UNSUPPORTED_TEXT, IB.VOICE_FAILED_TEXT].concat(Object.values(IB.DISCLOSURE));
  const fallback = JSON.parse(byNode(IG, 'Send Fallback Reply').parameters.jsonBody.match(/text: ("(?:[^"\\]|\\.)*")/)[1]);
  texts.push(fallback);
  for (const t of texts) { assert.ok(bytes(t) <= IB.IG_MAX_BYTES && t.length < 1000, t.slice(0, 40) + ': ' + bytes(t) + ' bytes'); }
  for (const t of [IB.UNSUPPORTED_TEXT, IB.VOICE_FAILED_TEXT, fallback]) assert.ok(t.indexOf(IB.TAG) === 0, 'fixed replies say they are automated');
  for (const re of [/voice messages/, /mensajes de texto y de voz/, /écrits et vocaux/, /النصية والصوتية/]) assert.ok(re.test(IB.UNSUPPORTED_TEXT), 'the unsupported reply says text AND voice are read: ' + re);
  for (const re of [/voice message/, /mensaje de voz/, /message vocal/, /الرسالة الصوتية/]) assert.ok(re.test(IB.VOICE_FAILED_TEXT), re);
  assert.ok(!/https?:|error|token|openrouter|whisper|cdn/i.test(IB.VOICE_FAILED_TEXT + IB.UNSUPPORTED_TEXT), 'nothing technical in customer texts');
  for (const t of Object.values(IB.DISCLOSURE)) assert.ok(/^🤖 /.test(t));
  assert.ok(/automated AI assistant/.test(IB.DISCLOSURE.en) && /a person/.test(IB.DISCLOSURE.en));
});

// ------------------------------------------------------------------ webhook behaviour
test('I1 verification handshake: own verify token echoes the challenge; the Messenger token, a wrong or unset token -> 403', async () => {
  const e = env();
  const get = (q) => runWf(e, IG, 'Instagram Webhook (verify)', [{ json: { headers: {}, params: {}, body: {}, query: q } }]);
  await all(e, [() => get({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '4242' })]);
  assert.deepStrictEqual(e.rec.responses.pop(), { node: 'Respond: Challenge', code: 200, body: '4242' });
  for (const tok of ['messenger-token', 'guess']) {
    await all(e, [() => get({ 'hub.mode': 'subscribe', 'hub.verify_token': tok, 'hub.challenge': 'x' })]);
    assert.strictEqual(e.rec.responses.pop().code, 403, tok);
  }
  e.envVars.LUMIERE_INSTAGRAM_VERIFY_TOKEN = '';
  await all(e, [() => get({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'x' })]);
  assert.strictEqual(e.rec.responses.pop().code, 403, 'an unset verify token must never verify');
});

test('I2 signed text message -> one AI turn, disclosure + reply to that IGSID, ig: lock released, logged', async () => {
  const e = env({ seed: 301 });
  await all(e, [() => post(e, [ev(e, A, { text: 'Hi, how much is a haircut?' })])]);
  noErrors(e);
  assert.deepStrictEqual(aiFor(e, A).map((c) => c.text), ['Hi, how much is a haircut?']);
  assert.ok(aiFor(e, A)[0].prompt.indexOf('Channel: Instagram Direct, text and voice messages, replies in text') >= 0 && aiFor(e, A)[0].prompt.indexOf('voice note') < 0 && aiFor(e, A)[0].prompt.indexOf(A) < 0, 'the IGSID is never shown to the AI');
  assert.deepStrictEqual(igTo(e, A).map((s) => [s.node, s.text]), [['Send Instagram Reply', IB.DISCLOSURE.en + '\n\n' + REPLY]]);
  assert.deepStrictEqual(Object.keys(igTo(e, A)[0].body).sort(), ['message', 'recipient']);
  assert.strictEqual(staffAlerts(e).length, 0);
  assert.deepStrictEqual(e.rec.logs.map((l) => l.phone), [IK(A) + ' (Lina Haddad)']);
  lockFree(e, IK(A));
});

test('I3 forged, tampered, unsigned, misconfigured or wrong-object requests are rejected before any processing', async () => {
  const cases = [
    { name: 'wrong secret', o: { secret: 'not-the-secret' } },
    { name: 'tampered body', o: { signedRaw: metaJson({ object: 'instagram', entry: [] }) } },
    { name: 'no signature', o: { sig: null } },
    { name: 'malformed signature', o: { sig: 'sha1=abc' } },
    { name: 'app secret unset', o: {}, unset: 'LUMIERE_INSTAGRAM_APP_SECRET' },
    { name: 'account id unset', o: {}, unset: 'LUMIERE_INSTAGRAM_ACCOUNT_ID' },
  ];
  for (const c of cases) {
    const e = env({ seed: 302 });
    if (c.unset) e.envVars[c.unset] = '';
    await all(e, [() => post(e, [ev(e, A, { text: 'book me' })], c.o)]);
    noErrors(e);
    assert.strictEqual(e.rec.ai.length + e.rec.sends.length, 0, c.name);
    assert.ok(ran(e, 'Rejected - Bad Signature'), c.name + ' must end at Rejected - Bad Signature');
  }
  // Correctly signed, but a Page (Messenger) payload or another Instagram account: nothing is processed.
  for (const o of [{ object: 'page' }, { acct: OTHER }, { acct: null }]) {
    const e = env({ seed: 303 });
    await all(e, [() => post(e, [ev(e, A, { text: 'x', to: o.acct || ACCT })], o)]);
    noErrors(e);
    assert.strictEqual(e.rec.ai.length + e.rec.sends.length, 0, JSON.stringify(o));
  }
  // The raw body may be unavailable: the escaped re-serialization is verified instead.
  const r = env({ seed: 304 });
  await all(r, [() => post(r, [ev(r, A, { text: 'صباح الخير 😊 https://maps.example/x' })], { noRaw: true })]);
  noErrors(r);
  assert.strictEqual(r.rec.ai.length, 1);
});

test('I4 batched webhook: two customers + echo, staff inbox reply, read, reaction, deleted message -> exactly two executions', async () => {
  const e = env({ seed: 305 });
  const events = [
    ev(e, A, { text: 'from A' }),
    ev(e, ACCT, { text: 'account echo', echo: true, to: A }),
    Object.assign(ev(e, ACCT, { text: 'staff reply from the inbox', to: B }), {}),
    ev(e, B, { read: true }),
    ev(e, B, { reaction: true }),
    ev(e, B, { text: 'gone', deleted: true }),
    ev(e, B, { text: 'from B' }),
  ];
  await all(e, [() => post(e, events)]);
  noErrors(e);
  assert.deepStrictEqual(e.rec.ai.map((c) => c.text).sort(), ['from A', 'from B']);
  assert.strictEqual(igTo(e, A).length, 1);
  assert.strictEqual(igTo(e, B).length, 1);
  assert.strictEqual(igTo(e, ACCT).length, 0, 'the account itself is never answered');
  lockFree(e, IK(A)); lockFree(e, IK(B));
});

test('I5 duplicates are processed once; stale and malformed events (no id, no time, bad ids, other recipient) are dropped', async () => {
  const e = env({ seed: 306 });
  const m = ev(e, A, { text: 'once' });
  await all(e, [at(e, 0, () => post(e, [m])), at(e, 20, () => post(e, [m])), at(e, 30000, () => post(e, [m]))]);
  noErrors(e);
  assert.strictEqual(aiFor(e, A).length, 1);
  assert.strictEqual(igTo(e, A).length, 1);
  const bad = env({ seed: 307 });
  const noMid = ev(bad, A, { text: 'no mid' }); delete noMid.message.mid;
  const noTs = ev(bad, A, { text: 'no time' }); delete noTs.timestamp;
  await all(bad, [() => post(bad, [
    ev(bad, A, { text: 'old', ts: bad.sim.now - 4 * 60000 }),
    noMid, noTs,
    ev(bad, 'abc', { text: 'bad sender' }),
    ev(bad, A, { text: 'to someone else', to: OTHER }),
    { sender: { id: A }, recipient: { id: ACCT }, timestamp: bad.sim.now, message: 'not an object' },
    null, 42,
  ])]);
  noErrors(bad);
  assert.strictEqual(bad.rec.ai.length + bad.rec.sends.length, 0);
});

test('I6 every non-voice attachment -> friendly "text or voice" reply (no AI); story mention ignored; story reply, postback read as text', async () => {
  for (const kind of ['image', 'video', 'file', 'share', 'ig_reel', 'reel', 'ephemeral', 'unsupported']) {
    const e = env({ seed: 308 });
    await all(e, [() => post(e, [ev(e, A, kind === 'unsupported' ? { unsupported: true } : { attach: kind })])]);
    noErrors(e);
    assert.deepStrictEqual(igTo(e, A).map((s) => [s.node, s.text]), [['Send Unsupported Reply', IB.UNSUPPORTED_TEXT]], kind);
    assert.strictEqual(e.rec.ai.length, 0, kind);
    lockFree(e, IK(A));
  }
  const s = env({ seed: 309 });
  await all(s, [() => post(s, [ev(s, A, { attach: 'story_mention' })])]);
  assert.strictEqual(s.rec.ai.length + s.rec.sends.length, 0, 'a story mention is not answered');
  const t = env({ seed: 310 });
  await all(t, [() => post(t, [ev(t, A, { text: 'Love this! Price?', storyReply: true })]), () => post(t, [ev(t, B, { postback: 'Book an appointment' })])]);
  noErrors(t);
  assert.deepStrictEqual(t.rec.ai.map((c) => c.text).sort(), ['Book an appointment', 'Love this! Price?']);
});

test('I7 long replies are split to Instagram\'s limit: every part <= 990 bytes and < 1000 characters, in order, nothing lost', async () => {
  const line = 'مرحبا - تسريحة شعر يوم الثلاثاء 6 أكتوبر الساعة 12:00 💇‍♀️';
  const long = Array.from({ length: 42 }, (_, i) => (i + 1) + ') ' + line).join('\n');
  assert.ok(long.length <= 2800 && bytes(long) > 4 * IB.IG_MAX_BYTES, 'fixture ' + long.length + ' chars / ' + bytes(long) + ' bytes');
  const e = env({ seed: 311, ai: { behave: () => ({ output: long }) } });
  await all(e, [() => post(e, [ev(e, A, { text: 'مواعيدي؟' })])]);
  noErrors(e);
  const parts = igTo(e, A);
  assert.ok(parts.length >= 5 && parts.length <= IB.IG_MAX_PARTS, parts.length + ' parts');
  assert.deepStrictEqual(parts.map((p) => p.node), parts.map((p, i) => (i === 0 ? 'Send Instagram Reply' : 'Send Instagram Reply (part ' + (i + 1) + ')')));
  for (const p of parts) {
    assert.ok(bytes(p.text) <= IB.IG_MAX_BYTES && p.text.length < 1000, 'part too long: ' + bytes(p.text) + ' bytes');
    assert.ok(!/[\ud800-\udbff]$/.test(p.text) && !/^[\udc00-\udfff]/.test(p.text), 'an emoji was split');
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.strictEqual(norm(parts.map((p) => p.text).join('\n')), norm(IB.DISCLOSURE.ar + '\n\n' + long));
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i - 1].t < parts[i].t, 'parts out of order');
  assert.strictEqual(e.rec.logs.length, 1, 'logged once');
  lockFree(e, IK(A));
});

test('I8 the 24-hour window: a reply is never sent for a message older than 24 h (guard is load-bearing)', async () => {
  // The 3-minute staleness filter normally stops old messages first; switch it off to reach the guard.
  const noStale = mutate('Dedup & Filter Prep', 'const STALE_THRESHOLD_MS = 3 * 60 * 1000;', 'const STALE_THRESHOLD_MS = 400 * 86400000;');
  const e = env({ seed: 312 });
  await all(e, [() => postWith(e, noStale, [ev(e, A, { text: 'old one', ts: e.sim.now - 25 * 3600000 })]),
    () => postWith(e, noStale, [ev(e, B, { text: 'recent one', ts: e.sim.now - 23 * 3600000 })])]);
  noErrors(e);
  assert.strictEqual(igTo(e, A).length, 0, 'outside the window: nothing is sent');
  assert.ok(ran(e, NOT_SENT('Send Instagram Reply')));
  assert.strictEqual(e.rec.logs.filter((l) => l.phone.indexOf(IK(A)) === 0).length, 1, 'still logged');
  assert.strictEqual(igTo(e, B).length, 1, 'inside the window: answered');
  lockFree(e, IK(A)); lockFree(e, IK(B));
  // Unsupported and fallback replies are guarded too.
  const u = env({ seed: 313 });
  await all(u, [() => postWith(u, noStale, [ev(u, A, { attach: 'image', ts: u.sim.now - 25 * 3600000 })])]);
  assert.strictEqual(u.rec.sends.length, 0); assert.ok(ran(u, NOT_SENT('Send Unsupported Reply')));
  const f = env({ seed: 314, ai: { behave: () => ({ fail: true }) } });
  await all(f, [() => postWith(f, noStale, [ev(f, A, { text: 'x', ts: f.sim.now - 25 * 3600000 })])]);
  assert.strictEqual(igTo(f, A).length, 0); assert.ok(ran(f, NOT_SENT('Send Fallback Reply')));
  assert.ok(staffAlerts(f).some((s) => s.node === 'Alert Staff - System Error'), 'staff still alerted');
  lockFree(f, IK(A));
  // Mutant without the guard: the 25-hour-old message IS answered, so the guard is what stops it.
  const unguarded = JSON.parse(JSON.stringify(noStale));
  byNode(unguarded, '24h Window Open? (Send Instagram Reply)').parameters.conditions.conditions[0].leftValue = '={{ true }}';
  const m = env({ seed: 315 });
  await all(m, [() => postWith(m, unguarded, [ev(m, A, { text: 'old one', ts: m.sim.now - 25 * 3600000 })])]);
  assert.strictEqual(igTo(m, A).length, 1, 'mutant sends - the guard is load-bearing');
});

test('I9 automated-assistant disclosure: on the first reply of a conversation window, in the customer\'s language, once', async () => {
  const e = env({ seed: 316 });
  await all(e, [
    at(e, 0, () => post(e, [ev(e, A, { text: 'Bonjour, je voudrais un rendez-vous' })])),
    at(e, 60000, () => post(e, [ev(e, A, { text: 'merci' })])),
    at(e, 25 * 3600000, () => post(e, [ev(e, A, { text: 'Hello again' })])),
    at(e, 0, () => post(e, [ev(e, B, { text: 'مرحبا، أريد حجز موعد' })])),
  ]);
  noErrors(e);
  const a = igTo(e, A).map((s) => s.text);
  assert.strictEqual(a.length, 3);
  assert.strictEqual(a[0], IB.DISCLOSURE.fr + '\n\n' + REPLY);
  assert.strictEqual(a[1], REPLY, 'not repeated inside the same window');
  assert.ok(a[2].indexOf(IB.DISCLOSURE.en) === 0, 'a new conversation window gets it again: ' + a[2].slice(0, 30));
  assert.ok(igTo(e, B)[0].text.indexOf(IB.DISCLOSURE.ar) === 0);
});

test('I10 human handoff: escalation writes the ig: pause row before the reply, alerts staff on WhatsApp, bot silent until unmuted', async () => {
  let alert = null;
  const e = env({ seed: 317, ai: { behave: (c, run) => (c.text === 'I want to talk to a real person'
    ? { output: 'Of course - a member of the team will reply to you here shortly.', tools: async () => {
      const node = run.nodes.get('Escalate to Staff');
      const ctx = Object.assign(run.exprCtx(null, 0, []), { $fromAI: () => 'customer requested a human' });
      alert = JSON.parse(run.evalExpr(node.parameters.jsonBody, ctx));
      return [{ action: { tool: 'Escalate_to_Staff' }, observation: 'sent' }];
    } }
    : { output: REPLY }) } });
  const a = ev(e, A, { text: 'I want to talk to a real person' }), b = ev(e, A, { text: 'hello?', ts: a.timestamp + 1000 });
  await all(e, [at(e, 0, () => post(e, [a])), at(e, 1000, () => post(e, [b]))]);
  noErrors(e);
  assert.deepStrictEqual(aiFor(e, A).map((c) => c.text), ['I want to talk to a real person'], 'the next message must not reach the AI');
  assert.deepStrictEqual(e.sheet.handoffs, [{ Patient_ID: IK(A), Status: 'paused' }]);
  assert.ok(e.rec.sheetsWrites[0].t <= igTo(e, A)[0].t, 'pause persisted before the reply');
  assert.strictEqual(igTo(e, A).length, 1);
  assert.strictEqual(alert.to, STAFF);
  const t = alert.text.body;
  assert.ok(/^⚠️ \[Instagram\] customer requested a human/.test(t), t);
  assert.ok(t.indexOf('Lina Haddad') > 0 && t.indexOf('row ' + IK(A) + ' -> Status = unmuted') > 0 && /Instagram inbox \(Meta Business Suite\) within 24 h/.test(t), t);
  assert.ok(!/Messenger|Facebook|!unmute/.test(t), t);
  lockFree(e, IK(A));
  e.sheet.handoffs[0].Status = 'unmuted'; // staff give the conversation back to Yasmine
  await all(e, [() => post(e, [ev(e, A, { text: 'thanks' })])]);
  assert.deepStrictEqual(aiFor(e, A).map((c) => c.text), ['I want to talk to a real person', 'thanks']);
});

test('I11 pause rows never cross channels or accounts (ig: key only; fb:, WhatsApp digits, other accounts never match)', async () => {
  const e = env({ seed: 318 });
  e.sheet.handoffs.push({ Patient_ID: IK(A), Status: 'paused' }, { Patient_ID: IK(B, OTHER), Status: 'paused' }, { Patient_ID: 'fb:' + B, Status: 'paused' },
    { Patient_ID: FK(B), Status: 'paused' }, { Patient_ID: B, Status: 'paused' }, { Patient_ID: 'ig:' + B, Status: 'paused' });
  await all(e, [() => post(e, [ev(e, A, { text: 'a' })]), () => post(e, [ev(e, B, { text: 'b' })])]);
  noErrors(e);
  assert.deepStrictEqual(e.rec.ai.map((c) => c.text), ['b'], 'only the exact ig: key pauses');
  // An Instagram row never pauses WhatsApp or Messenger.
  const w = env({ seed: 319 });
  w.sheet.handoffs.push({ Patient_ID: IK(WAP), Status: 'paused' }, { Patient_ID: IK(A, PAGE), Status: 'paused' });
  await all(w, [() => deliver(w, waMessage(w, WAP, { text: 'wa' })), () => postMessenger(w, A, 'fb')]);
  noErrors(w);
  assert.deepStrictEqual(w.rec.ai.map((c) => c.text).sort(), ['fb', 'wa']);
});

// ------------------------------------------------------------------ appointments across channels
function toolIdent(run, tool) {
  const v = run.nodes.get(tool).parameters.workflowInputs.value, ctx = run.exprCtx(null, 0, []);
  return { phone_number: run.evalExpr(v.phone_number, ctx), customer_key: run.evalExpr(v.customer_key, ctx) };
}
const slot = (ident, name, time) => Object.assign({ start_datetime: '2026-10-06T' + (time || '10:00') + ':00', service_keys: 'mens_cut', summary: name + ' - Haircut', notes: 'Instagram - Tel: +34600000009 | ' + name }, ident);
const findIn = (ident) => Object.assign({ phone_number: '', patient_name: '', appointment_date: '', booked_phone_number: '' }, ident);

test('I12 an Instagram booking belongs to that Instagram conversation only (not Messenger, WhatsApp, another account, bare digits)', async () => {
  const found = {};
  const e = env({ seed: 320, ai: { behave: (c, run) => ({
    output: REPLY,
    tools: async (env2) => {
      if (c.text === 'book') { const r = await callTool(env2, 'book', slot(toolIdent(run, 'Book_Appointment'), 'Lina Haddad')); c.res = r.result; }
      else { const r = await callTool(env2, 'find', findIn(toolIdent(run, 'Find_Patient_Appointments'))); found[c.chat] = r.result; }
      return [];
    },
  }) } });
  await all(e, [() => post(e, [ev(e, A, { text: 'book' })])]);
  assert.ok(/^SUCCESS/.test(e.rec.ai[0].res), e.rec.ai[0].res);
  const evs = e.cal.events(CFG.CALENDAR_ID);
  assert.strictEqual(evs.length, 1);
  assert.ok(evs[0].description.indexOf('Customer: ' + IK(A) + '. Service: Men\'s haircut | Keys: mens_cut | Duration: 30 min. Notes: Instagram - Tel: +34600000009') === 0, evs[0].description);
  await all(e, [() => post(e, [ev(e, A, { text: 'find' })]), () => post(e, [ev(e, B, { text: 'find' })]), () => deliver(e, waMessage(e, WAP, { text: 'find' }))]);
  noErrors(e);
  assert.ok(/^FOUND: 1\) Lina Haddad - Haircut on 2026-10-06 at 10:00/.test(found[A]), found[A]);
  assert.ok(/^NOT_FOUND/.test(found[B]), 'another Instagram user must not see it');
  assert.ok(/^NOT_FOUND/.test(found[WAP]), 'a WhatsApp number must not see it');
  const r = {};
  await all(e, [async () => {
    r.fb = await callTool(e, 'find', findIn({ customer_key: 'fb:' + ACCT + ':' + A }));
    r.other = await callTool(e, 'find', findIn({ customer_key: IK(A, OTHER) }));
    r.digits = await callTool(e, 'find', findIn({ phone_number: A }));
    r.claim = await callTool(e, 'find', findIn({ customer_key: IK(B), booked_phone_number: '+34600000009' }));
    r.cancel = await callTool(e, 'cancel', Object.assign(findIn({ customer_key: FK(A) }), { appointment_date: '2026-10-06', appointment_time: '10:00' }));
  }]);
  for (const k of ['fb', 'other', 'digits', 'claim']) assert.ok(!/^FOUND/.test(r[k].result), k + ': ' + r[k].result);
  assert.ok(!/^CONFIRMATION_REQUIRED/.test(r.cancel.result), 'a Messenger customer can never propose cancelling it: ' + r.cancel.result);
  assert.strictEqual(e.cal.events(CFG.CALENDAR_ID).filter((x) => x.status !== 'cancelled').length, 1);
});

test('I13 WhatsApp, Messenger and Instagram customers booking the same slot at the same moment -> exactly one appointment', async () => {
  for (const seed of [321, 322, 323]) {
    const e = env({ seed, ai: { thinkMs: 500, behave: (c, run) => ({
      thinkMs: 500, output: REPLY,
      tools: async (env2) => { const r = await callTool(env2, 'book', slot(toolIdent(run, 'Book_Appointment'), 'Customer ' + c.chat.slice(-4))); c.res = r.result; return []; },
    }) } });
    await all(e, [at(e, 0, () => post(e, [ev(e, A, { text: 'book' })])), at(e, 5, () => deliver(e, waMessage(e, WAP, { text: 'book' }))), at(e, 9, () => postMessenger(e, B, 'book'))]);
    noErrors(e);
    assert.deepStrictEqual(e.rec.ai.map((c) => c.res.split(':')[0]).sort(), ['CONFLICT', 'CONFLICT', 'SUCCESS'], 'seed ' + seed);
    assert.strictEqual(e.cal.events(CFG.CALENDAR_ID).length, 1, 'seed ' + seed);
    assert.deepStrictEqual(e.cal.violations, []);
  }
});

test('I14 confirmation gate on Instagram: server question, typed yes cancels without the AI; another customer\'s yes never confirms', async () => {
  const e = env({ seed: 324 });
  const s = Date.parse('2026-10-06T10:00:00+01:00');
  e.cal.seed(CFG.CALENDAR_ID, { id: 'igappt01', summary: 'Lina - Manicure', description: 'Customer: ' + IK(A) + '. Notes: Instagram - Tel: +34600000009 | Lina', start: { dateTime: '2026-10-06T10:00:00+01:00', timeZone: 'Africa/Algiers' }, end: { dateTime: new Date(s + 30 * 60000 + 3600000).toISOString().slice(0, 19) + '+01:00', timeZone: 'Africa/Algiers' } });
  const state = () => { const x = e.cal.store(CFG.CALENDAR_ID).get('igappt01').cur; return x.status === 'cancelled' ? 'cancelled' : 'kept'; };
  e.ai.behave = (c, run) => ({ output: 'Your appointment has been cancelled.', tools: async (env2) => {
    const r = await callTool(env2, 'cancel', Object.assign(findIn(toolIdent(run, 'Cancel_Appointment')), { appointment_date: '2026-10-06', appointment_time: '10:00', chat_msg_id: run.accessor()('Dedup & Filter Prep').first().json.messageId }));
    return [{ action: { tool: 'Cancel_Appointment' }, observation: r.result }];
  } });
  await all(e, [() => post(e, [ev(e, A, { text: 'Please cancel my appointment on Tuesday at 10:00' })])]);
  assert.strictEqual(state(), 'kept');
  const ask = igTo(e, A).slice(-1)[0].text;
  assert.ok(/Just to confirm: do you want to cancel your appointment “Lina - Manicure” on Tuesday 6 October at 10:00\? Please reply Yes or No\.$/.test(ask), ask);
  const aiCalls = e.rec.ai.length;
  e.ai.behave = () => ({ output: REPLY });
  // B (another Instagram customer) and a WhatsApp number with the same digits say yes: nothing happens.
  await all(e, [() => post(e, [ev(e, B, { text: 'yes' })]), () => deliver(e, waMessage(e, '34' + A.slice(-10), { text: 'yes' }))]);
  assert.strictEqual(state(), 'kept', 'another customer can never confirm');
  e.ai.behave = () => { throw new Error('the AI must not decide a confirmation'); };
  await all(e, [() => post(e, [ev(e, A, { text: 'نعم' })])]);
  assert.strictEqual(e.rec.ai.length, aiCalls + 2, 'only B and the WhatsApp customer reached the AI');
  assert.strictEqual(state(), 'cancelled');
  assert.ok(/أُلغي موعدك/.test(igTo(e, A).slice(-1)[0].text), igTo(e, A).slice(-1)[0].text);
  // The pending record lived only in A's Instagram lock object.
  for (const k of [IK(B), FK(A), A]) { const st = e.cal.lockState(LOCKCAL, chatLock(k)); assert.ok(!st || !st.pc, k + ' never held the confirmation'); }
  lockFree(e, IK(A));
});

test('I15 send failure / AI failure / lock store down -> staff alerted on WhatsApp, customer gets the tagged fallback, lock released', async () => {
  const e = env({ seed: 325 });
  let fails = 0;
  e.faults.send = (node, to) => node === 'Send Instagram Reply' && to === A && fails++ < 3;
  const a = ev(e, A, { text: 'one' }), b = ev(e, A, { text: 'two', ts: a.timestamp + 1000 });
  await all(e, [at(e, 0, () => post(e, [a])), at(e, 500, () => post(e, [b]))]);
  noErrors(e);
  const alert = staffAlerts(e).find((s) => s.node === 'Alert Staff - System Error');
  assert.ok(alert && alert.text.indexOf('[Instagram]') >= 0 && alert.text.indexOf('Lina Haddad') >= 0 && alert.text.indexOf(IK(A)) >= 0, alert && alert.text);
  assert.strictEqual(aiFor(e, A).length, 2);
  lockFree(e, IK(A));
  const f = env({ seed: 326, ai: { behave: () => ({ fail: true }) } });
  await all(f, [() => post(f, [ev(f, A, { text: 'boom' })])]);
  noErrors(f);
  assert.deepStrictEqual(igTo(f, A).map((s) => s.node), ['Send Fallback Reply']);
  assert.ok(igTo(f, A)[0].text.indexOf(IB.TAG) === 0);
  lockFree(f, IK(A));
  const d = env({ seed: 327, cal: { fault: () => ({ kind: '503' }) } });
  await all(d, [() => post(d, [ev(d, A, { text: 'hi' })])]);
  noErrors(d);
  assert.strictEqual(d.rec.ai.length, 0, 'never processed unserialized');
  assert.deepStrictEqual(igTo(d, A).map((s) => s.node), ['Send Fallback Reply']);
  assert.ok(staffAlerts(d).some((s) => s.text.indexOf(IK(A)) >= 0), 'alert names the customer key');
});

test('IX mutations prove the checks are load-bearing: signature, account filter, echo filter', async () => {
  const noSig = mutate('Verify Signature & Split', 'if (reason) return', 'if (false) return');
  const e = env({ seed: 330 });
  await all(e, [() => postWith(e, noSig, [ev(e, A, { text: 'forged' })], { sig: null })]);
  assert.strictEqual(e.rec.ai.length, 1, 'mutation should have let the forged message through');
  const anyAcct = mutate('Verify Signature & Split', "String(entry.id == null ? '' : entry.id) !== ACCOUNT_ID", 'false');
  const o = env({ seed: 331 });
  const other = { sender: { id: A }, recipient: { id: ACCT }, timestamp: o.sim.now, message: { mid: 'ig_other', text: 'for another account' } };
  const item = webhookItem({ object: 'instagram', entry: [{ id: OTHER, time: o.sim.now, messaging: [other] }] });
  await all(o, [() => runWf(o, IG, 'Instagram Webhook', [JSON.parse(JSON.stringify(item))])]);
  assert.strictEqual(o.rec.ai.length, 0, 'real workflow: another account is ignored');
  const o2 = env({ seed: 332 });
  await all(o2, [async () => { const r = new Runner(anyAcct, { sim: o2.sim, persisted: o2.persisted, envVars: o2.envVars, opts: o2.opts, hooks: hooks(o2, IG) }); await r.run('Instagram Webhook', [JSON.parse(JSON.stringify(item))]); }]);
  assert.strictEqual(o2.rec.ai.length, 1, 'mutant accepts another account - the filter is load-bearing');
  const noEcho = mutate('Verify Signature & Split', "if (String(ev.sender.id) === ACCOUNT_ID) continue;", '');
  const x = env({ seed: 333 });
  await all(x, [() => postWith(x, noEcho, [{ sender: { id: ACCT }, recipient: { id: A }, timestamp: x.sim.now, message: { mid: 'ig_staff', text: 'staff reply' } }])]);
  // Dedup still drops the account's own message (second line of defense) - nothing is answered.
  assert.strictEqual(x.rec.ai.length + x.rec.sends.length, 0);
});

// ------------------------------------------------------------------ voice messages
// All IV tests run the REAL Instagram workflow JSON in the emulator; the Meta CDN download and
// the OpenRouter speech-to-text response are MOCKED (see AUDIO / STT above). The real provider
// is exercised separately by tests/integration/instagram-voice-real.js.
const voiceEv = (e, igsid, o) => {
  const x = ev(e, igsid, Object.assign({}, o, { attach: 'audio' }));
  x.message.attachments[0].payload.url = (o && o.url) || CDN + (SEQ++) + '&signature=abc123';
  return x;
};
const stt = (e) => e.rec.stt;
const lastIg = (e, id) => (igTo(e, id).slice(-1)[0] || {}).text || '';

test('IV1 MOCKED voice path: Meta CDN only, real-format check, OpenRouter auto-detect (no fixed language), own credential, every failure -> friendly reply', () => {
  const C = IG.connections;
  const next = (n, i) => ((C[n] && C[n].main && C[n].main[i || 0]) || []).map((x) => x.node);
  assert.deepStrictEqual(next('Message Type Router', 1), ['Download Voice Binary']);
  for (const [a, b] of [['Download Voice Binary', 'Check Voice File'], ['Check Voice File', 'Transcribe Voice'], ['Transcribe Voice', 'Read Transcript'], ['Read Transcript', 'Voice Usable?'], ['Voice Usable?', 'Merge Voice Text'], ['Merge Voice Text', 'Confirmation Gate']]) assert.deepStrictEqual(next(a, 0), [b], a);
  for (const n of ['Download Voice Binary', 'Check Voice File', 'Transcribe Voice', 'Read Transcript', 'Voice Usable?']) assert.deepStrictEqual(next(n, 1), ['24h Window Open? (Send Voice Failed Reply)'], n + ': failure -> friendly reply');
  const dl = byNode(IG, 'Download Voice Binary');
  assert.ok(!dl.credentials && !dl.parameters.authentication && !dl.parameters.sendHeaders, 'no token is ever sent to the media link');
  assert.ok(dl.parameters.options.timeout <= 20000);
  const tr = byNode(IG, 'Transcribe Voice');
  assert.strictEqual(tr.parameters.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
  const fields = Object.fromEntries(tr.parameters.bodyParameters.parameters.map((p) => [p.name, p.value || p.inputDataFieldName]));
  assert.deepStrictEqual(fields, { model: 'openai/whisper-large-v3', response_format: 'verbose_json', temperature: '0', file: 'data' });
  assert.ok(!('language' in fields), 'no fixed language: the provider detects it');
  assert.deepStrictEqual(tr.credentials, { httpHeaderAuth: ENV.credentials.transcription });
  assert.ok(ENV.SHARED_CREDENTIALS.indexOf('transcription') < 0 && ENV.credentials.transcription.id !== ENV.credentials.cohere.id && ENV.credentials.transcription.id !== ENV.credentials.openRouter.id, 'a salon-only credential, never the clinic one');
  for (const w of [WA, MSG]) assert.ok(!JSON.stringify(w).includes(ENV.credentials.transcription.id), 'WhatsApp / Messenger do not use it');
  assert.ok(!JSON.stringify(IG).includes('VOICE_LANGUAGE') && !JSON.stringify(IG).includes('cohere.com'), 'no single-language Cohere settings on Instagram');
  const gate = byNode(IG, 'Confirmation Gate').parameters.jsCode;
  assert.ok(gate.indexOf("viaVoice = $('Merge Voice Text').isExecuted === true") >= 0, 'the gate still recognises voice');
  // Only Meta's media CDN, over HTTPS, is accepted as a voice link.
  const re = new RegExp(IB.MEDIA_HOST_RE, 'i');
  for (const u of [CDN + '1&signature=x', 'https://scontent.cdninstagram.com/a.mp4', 'https://video.xx.fbcdn.net/v/a.mp4']) assert.ok(re.test(u), u);
  for (const u of ['http://lookaside.fbsbx.com/x', 'https://evil.example/lookaside.fbsbx.com/x', 'https://fbsbx.com.evil.example/x', 'https://lookaside.example/ig/audio', 'file:///etc/passwd']) assert.ok(!re.test(u), u);
});

test('IV2 MOCKED English, French, Spanish and Arabic voice notes -> transcript (Arabic script kept) reaches the AI with the detected language; reply in text', async () => {
  let seed = 900;
  for (const lang of ['en', 'fr', 'es', 'ar']) {
    const e = env({ seed: seed++ });
    e.voice.result = STT[lang];
    await all(e, [() => post(e, [voiceEv(e, A)])]);
    noErrors(e);
    assert.strictEqual(e.rec.downloads.length, 1, lang + ': downloaded once');
    assert.strictEqual(stt(e).length, 1, lang + ': transcribed once');
    const form = stt(e)[0].form;
    const file = form.find((f) => f.name === 'file').file;
    assert.strictEqual(file.fileName, 'voice.m4a'); assert.strictEqual(file.mimeType, 'audio/mp4');
    assert.ok(file.bytes.equals(AUDIO.m4a), 'the exact downloaded audio is sent');
    assert.ok(!form.some((f) => f.name === 'language'), 'no language forced');
    const calls = aiFor(e, A);
    assert.strictEqual(calls.length, 1, lang);
    assert.strictEqual(calls[0].text, STT[lang].text, lang + ': the transcript is the customer text');
    if (lang === 'ar') assert.ok(/[؀-ۿ]/.test(calls[0].text), 'Arabic stays in Arabic script');
    const name = { en: 'English', fr: 'French', es: 'Spanish', ar: 'Arabic' }[lang];
    assert.ok(calls[0].prompt.indexOf('(voice note, auto-transcribed - detected language: ' + name + '. ') >= 0, lang + ': ' + calls[0].prompt.slice(0, 300));
    assert.ok(/Reply in text, in the detected language/.test(calls[0].prompt));
    const out = igTo(e, A);
    assert.ok(out.length >= 1 && out.every((s) => s.body.message.text && !s.body.message.attachment), lang + ': text replies only');
    assert.ok(out.some((s) => s.text.indexOf(REPLY) >= 0));
    lockFree(e, IK(A));
  }
  // ISO codes are accepted as well as language names.
  const f = env({ seed: 910 });
  f.voice.result = Object.assign({}, STT.fr, { language: 'fr' });
  await all(f, [() => post(f, [voiceEv(f, A)])]);
  assert.ok(aiFor(f, A)[0].prompt.indexOf('detected language: French. ') >= 0);
});

test('IV3 MOCKED automatic language detection: audio and text disagree -> UNCERTAIN; no audio language -> from the text; other languages -> please type', async () => {
  const run1 = async (seed, result) => { const e = env({ seed }); e.voice.result = result; await all(e, [() => post(e, [voiceEv(e, A)])]); noErrors(e); return e; };
  const mix = await run1(911, { text: 'Bonjour, je voudrais annuler mon rendez-vous de demain, merci.', language: 'english' });
  assert.ok(/detected language: English, UNCERTAIN\. /.test(aiFor(mix, A)[0].prompt), aiFor(mix, A)[0].prompt.slice(0, 200));
  assert.ok(/if the language is marked UNCERTAIN, reply in the language the transcript is written in, and if the transcript does not make sense, ask the customer to type/.test(aiFor(mix, A)[0].prompt));
  const noLang = await run1(912, { text: 'أريد تغيير موعدي من فضلك' });
  assert.ok(/detected language: Arabic, UNCERTAIN\. /.test(aiFor(noLang, A)[0].prompt));
  for (const [seed, r] of [[913, { text: 'Guten Tag, ich möchte einen Termin buchen.', language: 'german' }], [914, { text: 'Buongiorno, vorrei prenotare un taglio.', language: 'italian' }]]) {
    const e = await run1(seed, r);
    assert.strictEqual(e.rec.ai.length, 0, r.language + ' is not one of the four languages');
    assert.deepStrictEqual(igTo(e, A).map((s) => s.text), [IB.VOICE_FAILED_TEXT]);
    lockFree(e, IK(A));
  }
  // A misdetected language label with a clearly supported transcript is still used (marked uncertain).
  const mis = await run1(915, { text: '¿Tienen cita libre el sábado por la mañana?', language: 'portuguese' });
  assert.ok(/detected language: Spanish, UNCERTAIN\. /.test(aiFor(mis, A)[0].prompt));
});

test('IV4 MOCKED response language: the server confirmation question follows the language of the voice note (Spanish, Arabic)', async () => {
  for (const [seed, lang, said, re] of [[916, 'es', 'Quiero cancelar mi cita del martes a las 10.', /(^|\n)Para confirmar: ¿quieres cancelar tu cita “Lina - Manicure” del martes 6 de octubre a las 10:00\? Responde Sí o No\.$/],
    [917, 'ar', 'أريد إلغاء موعدي يوم الثلاثاء الساعة العاشرة.', /(^|\n)للتأكيد: هل تريد إلغاء موعدك “Lina - Manicure” يوم الثلاثاء 6 أكتوبر الساعة 10:00؟/]]) {
    const e = env({ seed });
    seedIgAppt(e);
    e.voice.result = { text: said, language: { es: 'spanish', ar: 'arabic' }[lang] };
    e.ai.behave = aiCancels;
    await all(e, [() => post(e, [voiceEv(e, A)])]);
    noErrors(e);
    assert.ok(re.test(lastIg(e, A)), lang + ': ' + lastIg(e, A));
    assert.strictEqual(apptState(e), 'kept', 'a voice request only proposes');
    lockFree(e, IK(A));
  }
});

test('IV5 MOCKED download failure or a non-Meta link -> friendly reply only; nothing fetched elsewhere, nothing transcribed, nothing technical shown', async () => {
  const e = env({ seed: 918 });
  e.faults.voiceDownload = true;
  await all(e, [() => post(e, [voiceEv(e, A)])]);
  noErrors(e);
  assert.strictEqual(stt(e).length, 0); assert.strictEqual(e.rec.ai.length, 0);
  assert.deepStrictEqual(igTo(e, A).map((s) => s.text), [IB.VOICE_FAILED_TEXT]);
  assert.ok(!/fbsbx|403|status|error/i.test(lastIg(e, A)));
  lockFree(e, IK(A));
  const x = env({ seed: 919 });
  await all(x, [() => post(x, [voiceEv(x, A, { url: 'https://attacker.example/steal?to=fbsbx.com' })])]);
  noErrors(x);
  assert.ok(!x.rec.downloads.some((d) => /attacker/.test(d.url)), 'a foreign link is never requested');
  assert.strictEqual(stt(x).length, 0);
  assert.deepStrictEqual(igTo(x, A).map((s) => s.text), [IB.VOICE_FAILED_TEXT]);
  lockFree(x, IK(A));
});

test('IV6 MOCKED audio formats: m4a, aac, ogg, webm, wav and mp3 are named by their real bytes; non-audio, too short and too large files -> friendly reply', async () => {
  let seed = 920;
  for (const [fmt, mime] of [['m4a', 'audio/mp4'], ['aac', 'audio/aac'], ['ogg', 'audio/ogg'], ['webm', 'audio/webm'], ['wav', 'audio/wav'], ['mp3', 'audio/mpeg']]) {
    const e = env({ seed: seed++ });
    Object.assign(e.voice, { bytes: AUDIO[fmt], mime: 'application/octet-stream' }); // the CDN content type is not trusted
    await all(e, [() => post(e, [voiceEv(e, A)])]);
    noErrors(e);
    const file = stt(e)[0].form.find((f) => f.name === 'file').file;
    assert.deepStrictEqual([file.fileName, file.mimeType], ['voice.' + fmt, mime], fmt);
    assert.strictEqual(aiFor(e, A).length, 1, fmt);
  }
  for (const [name, bytes] of [['pdf', AUDIO.pdf], ['tiny', AUDIO.tiny], ['too large', padTo(AUDIO.m4a.slice(0, 32), IB.VOICE.maxBytes + 1)]]) {
    const e = env({ seed: seed++ });
    Object.assign(e.voice, { bytes, mime: 'audio/mp4' });
    await all(e, [() => post(e, [voiceEv(e, A)])]);
    noErrors(e);
    assert.strictEqual(stt(e).length, 0, name + ': never sent for transcription');
    assert.strictEqual(e.rec.ai.length, 0, name);
    assert.deepStrictEqual(igTo(e, A).map((s) => s.text), [IB.VOICE_FAILED_TEXT], name);
    lockFree(e, IK(A));
  }
});

test('IV7 MOCKED empty or unintelligible transcription, or the provider failing -> friendly reply, no AI', async () => {
  let seed = 930;
  for (const result of [{ text: '', language: 'english' }, { text: ' ... ', language: 'english' }, { text: 'Thanks for watching!', language: 'english' },
    { text: "Sous-titres réalisés par la communauté d'Amara.org", language: 'french' }, { text: 'ترجمة نانسي قنقر', language: 'arabic' },
    { text: 'Hello hello', language: 'english', segments: [{ no_speech_prob: 0.95 }, { no_speech_prob: 0.97 }] }, {}, null]) {
    const e = env({ seed: seed++ });
    e.voice.result = result;
    await all(e, [() => post(e, [voiceEv(e, A)])]);
    noErrors(e);
    assert.strictEqual(e.rec.ai.length, 0, JSON.stringify(result));
    assert.deepStrictEqual(igTo(e, A).map((s) => s.text), [IB.VOICE_FAILED_TEXT], JSON.stringify(result));
    lockFree(e, IK(A));
  }
  const e = env({ seed: seed++ });
  e.faults.stt = true;
  await all(e, [() => post(e, [voiceEv(e, A)])]);
  noErrors(e);
  assert.strictEqual(e.rec.ai.length, 0);
  assert.deepStrictEqual(igTo(e, A).map((s) => s.text), [IB.VOICE_FAILED_TEXT]);
  assert.ok(!/502|openrouter|status/i.test(lastIg(e, A)));
  // A genuine short answer is NOT treated as silence.
  const ok = env({ seed: seed++ });
  ok.voice.result = { text: 'Merci beaucoup !', language: 'french' };
  await all(ok, [() => post(ok, [voiceEv(ok, A)])]);
  assert.strictEqual(aiFor(ok, A).length, 1);
});

test('IV8 MOCKED duplicate webhook delivery of a voice note -> downloaded, transcribed and answered once', async () => {
  const e = env({ seed: 940 });
  const v = voiceEv(e, A, { mid: 'ig_voice_dup_1' });
  await all(e, [() => post(e, [v]), () => post(e, [JSON.parse(JSON.stringify(v))])]);
  await all(e, [() => post(e, [JSON.parse(JSON.stringify(v))])]);
  noErrors(e);
  assert.strictEqual(e.rec.downloads.length, 1); assert.strictEqual(stt(e).length, 1); assert.strictEqual(aiFor(e, A).length, 1);
  lockFree(e, IK(A));
});

test('IV9 MOCKED two customers send voice notes at the same moment -> each transcript stays in its own conversation', async () => {
  const e = env({ seed: 941 });
  e.voice.result = (req, run) => (run.accessor()('Dedup & Filter Prep').first().json.chatId === A ? STT.fr : STT.ar);
  await all(e, [() => post(e, [voiceEv(e, A)]), () => post(e, [voiceEv(e, B)])]);
  noErrors(e);
  assert.strictEqual(aiFor(e, A)[0].text, STT.fr.text); assert.strictEqual(aiFor(e, B)[0].text, STT.ar.text);
  assert.ok(/detected language: French/.test(aiFor(e, A)[0].prompt) && /detected language: Arabic/.test(aiFor(e, B)[0].prompt));
  assert.deepStrictEqual(stt(e).map((s) => s.chat).sort(), [IK(A), IK(B)].sort());
  assert.ok(igTo(e, A).length >= 1 && igTo(e, B).length >= 1);
  lockFree(e, IK(A)); lockFree(e, IK(B));
});

test('IV10 MOCKED a spoken "yes" (English, Spanish, Arabic) never confirms; the customer is asked to TYPE; a typed yes then cancels', async () => {
  let seed = 950;
  for (const [said, lang, re] of [['Yes, please cancel it.', 'english', /(^|\n)For your security, a voice message cannot confirm this change\. Please type Yes or No\./],
    ['Sí, cancélala.', 'spanish', /(^|\n)Por tu seguridad, una nota de voz no puede confirmar este cambio\. Escribe Sí o No\./],
    ['نعم، ألغِ الموعد.', 'arabic', /(^|\n)لأمانك، لا يمكن لرسالة صوتية تأكيد هذا التغيير/]]) {
    const e = env({ seed: seed++ });
    seedIgAppt(e);
    e.ai.behave = aiCancels;
    await all(e, [() => post(e, [ev(e, A, { text: 'Please cancel my appointment on Tuesday at 10:00' })])]);
    assert.ok(/(^|\n)Just to confirm: do you want to cancel/.test(lastIg(e, A)));
    e.ai.behave = () => { throw new Error('the AI must not decide a confirmation'); };
    e.voice.result = { text: said, language: lang };
    await all(e, [() => post(e, [voiceEv(e, A)])]);
    noErrors(e);
    assert.strictEqual(apptState(e), 'kept', lang + ': a spoken yes changes nothing');
    assert.ok(re.test(lastIg(e, A)), lang + ': ' + lastIg(e, A));
    assert.ok(!ran(e, 'Run Confirmed Cancel'), 'no confirmed change was attempted');
    // IV11: typed yes still follows the normal confirmation process.
    await all(e, [() => post(e, [ev(e, A, { text: 'yes' })])]);
    noErrors(e);
    assert.strictEqual(apptState(e), 'cancelled', lang + ': the typed yes confirms');
    lockFree(e, IK(A));
  }
});

test('IV11 MOCKED the engine itself refuses a confirmation reported as voice (defence in depth)', async () => {
  const e = env({ seed: 960 });
  seedIgAppt(e);
  const ident = { customer_key: IK(A), phone_number: '' };
  const base = Object.assign(findIn(ident), { appointment_date: '2026-10-06', appointment_time: '10:00', chat_msg_id: 'm-propose' });
  const [p] = await runAll(e, [() => callTool(e, 'cancel', base)]);
  const m = CONF.unmark(p.result);
  assert.ok(m && m.id, p.result);
  const [x] = await runAll(e, [() => callTool(e, 'cancel', Object.assign({}, base, { confirm_id: m.id, confirm_message: 'yes', confirm_msg_id: 'm-yes', confirm_via: 'voice', confirm_event_id: m.ev }))]);
  assert.ok(/^CONFIRMATION_INVALID \(not_typed\)/.test(x.result), x.result);
  assert.strictEqual(apptState(e), 'kept');
});

function seedIgAppt(e) {
  const s = Date.parse('2026-10-06T10:00:00+01:00');
  e.cal.seed(CFG.CALENDAR_ID, { id: 'igappt01', summary: 'Lina - Manicure', description: 'Customer: ' + IK(A) + '. Notes: Instagram - Tel: +34600000009 | Lina', start: { dateTime: '2026-10-06T10:00:00+01:00', timeZone: 'Africa/Algiers' }, end: { dateTime: new Date(s + 30 * 60000 + 3600000).toISOString().slice(0, 19) + '+01:00', timeZone: 'Africa/Algiers' } });
}
const apptState = (e) => (e.cal.store(CFG.CALENDAR_ID).get('igappt01').cur.status === 'cancelled' ? 'cancelled' : 'kept');
const aiCancels = (c, run) => ({ output: 'OK', tools: async (env2) => {
  const r = await callTool(env2, 'cancel', Object.assign(findIn(toolIdent(run, 'Cancel_Appointment')), { appointment_date: '2026-10-06', appointment_time: '10:00', chat_msg_id: run.accessor()('Dedup & Filter Prep').first().json.messageId }));
  return [{ action: { tool: 'Cancel_Appointment' }, observation: r.result }];
} });

// Reused by tests/integration/instagram-voice-real.js (real audio / real provider).
module.exports = { env, post, voiceEv, all, aiFor, igTo, lockFree, noErrors, ran, IG, IB, A, B, IK, CDN, STT };

if (require.main === module) runTests('instagram').then((r) => process.exit(r.fail ? 1 : 0));
