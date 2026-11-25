'use strict';
// Facebook Messenger workflow: static checks + execution of the REAL Messenger
// JSON (and, for cross-channel tests, the unchanged WhatsApp JSON) against the
// fake Google Calendar, with stubbed Graph API / Sheets / AI Agent.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/harness');
const { Runner } = require('./lib/runner');
const { test, runTests } = require('./lib/t');
const { CFG, makeEnv, runAll, at, callTool, deliver, waMessage, STAFF, ROOT } = H;
const MB = require(path.join(ROOT, 'tools', 'build-messenger.js'));
const WB = require(path.join(ROOT, 'tools', 'build-workflows.js'));
const chatLock = require(path.join(ROOT, 'engine', 'engine.js')).createEngine(CFG)._t.chatLockId;
const LOCKCAL = CFG.LOCK_CALENDAR_ID;

const readWf = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const MSG = readWf(MB.OUT_FILE);
const WA = H.wf('main');
const GRAPH_SEND = 'https://graph.facebook.com/v25.0/me/messages';
const SECRET = 'test-app-secret-0123456789abcdef';
const VERIFY = 'verify-me-token';
const PAGE = '102030405060708';
// Page-Scoped IDs (16-17 digits, like real ones) and a WhatsApp patient number.
const A = '24906340422315839', B = '7612345678901234', WAP = '213555000001';
// Channel-aware customer key of a Messenger user on the salon Page.
const FK = (psid, page) => 'fb:' + (page || PAGE) + ':' + psid;
const REPLY = 'مرحبا، كيفاش نقدر نعاونك؟';
const byNode = (w, n) => w.nodes.find((x) => x.name === n);

// ------------------------------------------------------------------ harness
function env(o) {
  const e = makeEnv(Object.assign({ ai: { behave: () => ({ output: REPLY }) } }, o));
  Object.assign(e.envVars, { LUMIERE_MESSENGER_APP_SECRET: SECRET, LUMIERE_MESSENGER_VERIFY_TOKEN: VERIFY });
  Object.assign(e.rec, { responses: [], cdn: [], transcribed: [], fbReqs: [], execs: [] });
  e.pending = [];
  return e;
}
function hooks(e) {
  const h = H._mainHooks(e);
  const baseHttp = h.http;
  h.http = async (req, run, item) => {
    if (req.url === GRAPH_SEND) {
      await e.sim.sleep(60);
      const to = req.body.recipient.id, text = req.body.message.text;
      if (e.faults.messenger && e.faults.messenger(req.node, to)) return { statusCode: 500, body: { error: { message: 'Graph 500' } } };
      e.rec.fbReqs.push(req);
      e.rec.sends.push({ t: e.sim.now, node: req.node, to, text, exec: run.execId, channel: 'messenger' });
      return { statusCode: 200, body: { recipient_id: to, message_id: 'mid.out' } };
    }
    if (/^https:\/\/graph\.facebook\.com\/v25\.0\/\d+\?fields=first_name,last_name$/.test(req.url)) {
      await e.sim.sleep(40);
      if (e.faults.profile) return { statusCode: 400, body: { error: { message: 'no permission' } } };
      return { statusCode: 200, body: { first_name: 'Sara', last_name: 'Benali', id: req.url.split('/').pop().split('?')[0] } };
    }
    if (req.url.indexOf('https://cdn.fbsbx.example/') === 0) {
      e.rec.cdn.push(req);
      await e.sim.sleep(60);
      if (e.faults.cdn) throw new Error('CDN 404');
      return { statusCode: 200, binary: { data: { fileName: 'audioclip-1700000000000-123.mp4', mimeType: e.voiceMime || 'video/mp4' } } };
    }
    if (req.url.indexOf('cohere.com') >= 0) e.rec.transcribed.push(item.binary && item.binary.data && item.binary.data.fileName);
    return baseHttp(req, run);
  };
  Object.assign(h.types, {
    'n8n-nodes-base.webhook': async (items) => [items],
    'n8n-nodes-base.respondToWebhook': async (items, run, node) => {
      const ctx = run.exprCtx(items[0], 0, items);
      e.rec.responses.push({ node: node.name, code: node.parameters.options.responseCode, body: run.evalExpr(node.parameters.responseBody, ctx) });
      return [items];
    },
    // Fire-and-forget sub-execution of this same workflow per item (n8n: mode "each", don't wait).
    'n8n-nodes-base.executeWorkflow': async (items, run, node) => {
      assert.strictEqual(node.parameters.workflowId.value, '={{ $workflow.id }}');
      assert.strictEqual(node.parameters.mode, 'each');
      assert.strictEqual(node.parameters.options.waitForSubWorkflow, false);
      for (const it of items) e.pending.push(runMessenger(e, 'Messenger Event', [{ json: JSON.parse(JSON.stringify(it.json)) }]));
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
async function runMessenger(e, entry, items, wf) {
  const r = new Runner(wf || MSG, { sim: e.sim, persisted: e.persisted, envVars: e.envVars, opts: e.opts, hooks: hooks(e) });
  const res = await r.run(entry, items);
  e.rec.execs.push(res);
  return res;
}
// Meta serializes with non-ASCII as lowercase \uXXXX and '/' escaped, and signs those bytes.
const metaJson = (o) => JSON.stringify(o).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).replace(/\//g, '\\/');
const sign = (raw, secret) => 'sha256=' + crypto.createHmac('sha256', secret || SECRET).update(raw).digest('hex');
function post(e, events, o) {
  o = o || {};
  const entry = { id: o.page !== undefined ? o.page : PAGE, time: e.sim.now, messaging: events };
  if (entry.id === null) delete entry.id;
  const raw = o.raw || metaJson({ object: 'page', entry: [entry] });
  const headers = { 'content-type': 'application/json' };
  if (o.sig !== null) headers['x-hub-signature-256'] = o.sig || sign(o.signedRaw || raw, o.secret);
  const item = { json: { headers, params: {}, query: {}, body: JSON.parse(raw) } };
  if (!o.noRaw) item.binary = { data: { data: Buffer.from(raw, 'utf8').toString('base64'), mimeType: 'application/json' } };
  return runMessenger(e, 'Messenger Webhook', [item]);
}
let SEQ = 1;
function ev(e, psid, o) {
  o = o || {};
  const base = { sender: { id: psid }, recipient: { id: PAGE }, timestamp: o.ts != null ? o.ts : e.sim.now };
  if (o.postback) return Object.assign(base, { postback: { mid: 'm_pb' + SEQ++, title: o.postback, payload: 'GET_STARTED' } });
  const message = { mid: o.mid || 'm_' + SEQ++ };
  if (o.audio) message.attachments = [{ type: 'audio', payload: { url: 'https://cdn.fbsbx.example/v/audioclip-' + SEQ + '.mp4?_nc=1' } }];
  else if (o.image) message.attachments = [{ type: 'image', payload: { url: 'https://scontent.example/img.jpg' } }];
  else if (o.like) Object.assign(message, { sticker_id: 369239263222822, attachments: [{ type: 'image', payload: { url: 'https://scontent.example/like.png', sticker_id: 369239263222822 } }] });
  else message.text = o.text != null ? o.text : 'salam';
  if (o.echo) message.is_echo = true;
  return Object.assign(base, { message });
}
async function all(e, tasks) {
  await runAll(e, tasks);
  await Promise.all(e.pending);
}
const aiFor = (e, chat) => e.rec.ai.filter((a) => a.chat === chat).sort((x, y) => x.t0 - y.t0);
const fbTo = (e, psid) => e.rec.sends.filter((s) => s.channel === 'messenger' && s.to === psid);
const staffAlerts = (e) => e.rec.sends.filter((s) => s.to === STAFF);
function lockFree(e, chat) {
  const st = e.cal.lockState(LOCKCAL, chatLock(/^\d{16,}$/.test(chat) ? FK(chat) : chat));
  assert.ok(st, 'no chat lock object for ' + chat);
  assert.ok(!st.h || st.hx <= e.sim.now, 'chat lock for ' + chat + ' still held at end');
  assert.deepStrictEqual(st.w || [], [], 'waiters left behind for ' + chat);
  assert.deepStrictEqual(e.cal.violations, [], 'mutual exclusion violated');
}
const noErrors = (e) => { for (const r of e.rec.execs) assert.ok(!r.error, 'execution failed: ' + (r.error && (r.error.node + ': ' + r.error.message))); };
function* strings(o, p) {
  if (typeof o === 'string') { yield [p, o]; return; }
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) yield* strings(o[i], p + '[' + i + ']'); return; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) yield* strings(o[k], p + '.' + k);
}

// ------------------------------------------------------------------ static checks
test('MG1 Messenger JSON is exactly what tools/build-messenger.js produces (idempotent)', () => {
  const a = JSON.stringify(MB.build(), null, 2) + '\n';
  assert.strictEqual(a, JSON.stringify(MB.build(), null, 2) + '\n', 'build is not deterministic');
  assert.strictEqual(a, fs.readFileSync(path.join(ROOT, MB.OUT_FILE), 'utf8'), 'Messenger workflow is stale - run node tools/build-messenger.js');
});

test('MG2 building Messenger never changes WhatsApp files; ids, webhooks and paths never collide', () => {
  const files = Object.values(WB.FILES).concat([WB.ERROR_WORKFLOW_FILE]);
  const before = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  MB.build();
  files.forEach((f, i) => assert.strictEqual(fs.readFileSync(path.join(ROOT, f), 'utf8'), before[i], f + ' was modified'));
  const built = WB.build();
  for (const k of Object.keys(WB.FILES)) assert.strictEqual(JSON.stringify(built[k], null, 2) + '\n', fs.readFileSync(path.join(ROOT, WB.FILES[k]), 'utf8'), k + ' is not what build-workflows produces');
  const ids = Object.values(WB.FILES).map((f) => readWf(f).id);
  assert.ok(ids.indexOf(MSG.id) < 0, 'Messenger workflow id must not equal an existing workflow id (import would overwrite it)');
  assert.strictEqual(MSG.active, false, 'import inactive; activate after setup');
  const hooksOf = (w) => w.nodes.filter((n) => n.webhookId).map((n) => n.webhookId);
  const waHooks = new Set(Object.values(WB.FILES).flatMap((f) => hooksOf(readWf(f))));
  for (const h of hooksOf(MSG)) assert.ok(!waHooks.has(h), 'webhookId reused from a WhatsApp workflow: ' + h);
  assert.strictEqual(new Set(hooksOf(MSG)).size, hooksOf(MSG).length, 'duplicate webhookIds');
  const hooks = MSG.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  assert.deepStrictEqual(hooks.map((n) => n.parameters.httpMethod).sort(), ['GET', 'POST']);
  for (const n of hooks) assert.strictEqual(n.parameters.path, MB.WEBHOOK_PATH);
  assert.ok(!MSG.nodes.some((n) => n.type === 'n8n-nodes-base.whatsAppTrigger'), 'must not register a second WhatsApp webhook');
});

test('MG3 graph integrity: unique names/ids, valid connections, references, no orphans, code compiles, no toggle expressions', () => {
  const w = MSG;
  const names = w.nodes.map((n) => n.name), ids = w.nodes.map((n) => n.id);
  assert.strictEqual(new Set(names).size, names.length, 'duplicate node names');
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate node ids');
  const set = new Set(names);
  const seen = new Set();
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
    assert.ok(s.indexOf("$('Dedup & Filter Prep').item") < 0, p + ' uses fragile .item');
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const n of w.nodes) if (n.type === 'n8n-nodes-base.code') {
    try { new AsyncFunction('$input', '$', '$json', '$env', '$execution', '$runIndex', '$getWorkflowStaticData', 'DateTime', n.parameters.jsCode); }
    catch (e) { assert.fail(n.name + ' does not compile: ' + e.message); }
  }
  const toggles = ['sendBody', 'sendHeaders', 'sendQuery', 'specifyBody', 'specifyHeaders', 'specifyQuery', 'contentType', 'authentication', 'nodeCredentialType', 'genericAuthType', 'resume', 'mode', 'operation', 'resource', 'httpMethod', 'responseMode', 'respondWith', 'inputSource'];
  for (const n of w.nodes) for (const t of toggles) {
    const v = n.parameters && n.parameters[t];
    assert.ok(!(typeof v === 'string' && v.charAt(0) === '='), n.name + ': ' + t + ' is an expression');
  }
  const src = WB.engineSource();
  const eng = w.nodes.filter((n) => n.parameters && typeof n.parameters.jsCode === 'string' && n.parameters.jsCode.indexOf('function createEngine(') >= 0);
  assert.strictEqual(eng.length, 1);
  assert.ok(eng[0].parameters.jsCode.indexOf(src) >= 0, 'stale engine copy');
  assert.deepStrictEqual(w.settings, WA.settings, 'same execution settings as WhatsApp');
});

test('MG4 every patient path releases the chat lock; crash safety net intact (same guarantees as WhatsApp G15/G17)', () => {
  const w = MSG;
  const next = (n) => { const c = w.connections[n]; return c && c.main ? c.main.flat().filter(Boolean).map((x) => x.node) : []; };
  const allowed = new Set(['Chat Lock Released', 'Duplicate Message - Stop', 'Release Failed - Lease Expires']);
  const seen = new Set(), stack = ['Chat Lock Acquired'];
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue; seen.add(n);
    const nx = next(n);
    if (!nx.length) assert.ok(allowed.has(n), 'path ends at ' + n + ' without releasing the chat lock');
    for (const x of nx) stack.push(x);
  }
  for (const n of ['Send Messenger Reply', 'Send Messenger Reply (part 2)', 'Get Messenger Profile', 'Download Voice Binary', 'Name Voice File']) assert.ok(seen.has(n), n + ' not on a lock-protected path');
  const IF = 'Lock Step Failed - Before Release?';
  for (const n of ['Chat Lock: Acquire', 'Chat Lock: Release', 'Engine: Decide', 'Engine: Collect']) {
    assert.strictEqual(byNode(w, n).onError, 'continueErrorOutput', n);
    assert.deepStrictEqual(w.connections[n].main[1].map((c) => c.node), [IF], n);
  }
  assert.deepStrictEqual(w.connections['Dedup & Filter Prep'].main, [[{ node: 'Chat Lock: Acquire', type: 'main', index: 0 }]]);
});

test('MG5 tools: same sub-workflows as WhatsApp, identity from the verified sender (never the LLM), Messenger wording', () => {
  for (const tool of ['Book_Appointment', 'Cancel_Appointment', 'Reschedule_Appointment', 'Find_Patient_Appointments', 'Check_Availability']) {
    const m = byNode(MSG, tool), wa = byNode(WA, tool);
    assert.strictEqual(m.parameters.workflowId.value, wa.parameters.workflowId.value, tool + ' must call the same sub-workflow');
    assert.deepStrictEqual(Object.keys(m.parameters.workflowInputs.value).sort(), Object.keys(wa.parameters.workflowInputs.value).sort(), tool);
    assert.deepStrictEqual(m.parameters.workflowInputs.schema, wa.parameters.workflowInputs.schema, tool);
    const v = m.parameters.workflowInputs.value;
    if ('phone_number' in v) assert.strictEqual(v.phone_number, '', tool + ': Messenger has no phone identity - the customer key is the identity');
    if (tool !== 'Check_Availability') assert.strictEqual(v.customer_key, WB.CUSTOMER_KEY_EXPR, tool + ': customer_key must be the verified sender key (never the AI)');
    for (const [p, s] of strings(m.parameters, tool)) assert.ok(!/current WhatsApp number|than the one (they are )?texting/.test(s), p + ' still talks about the WhatsApp number');
  }
  assert.ok(/Messenger - Tel:/.test(byNode(MSG, 'Book_Appointment').parameters.workflowInputs.value.notes));
  const prompt = byNode(MSG, 'AI Agent').parameters.options.systemMessage;
  assert.ok(prompt.indexOf('## FACEBOOK MESSENGER CHANNEL') > 0 && prompt.indexOf('AI Facebook Messenger receptionist') > 0);
  const rest = prompt.slice(0, prompt.indexOf('## FACEBOOK MESSENGER CHANNEL')) + prompt.slice(prompt.indexOf('## PERSONALITY'));
  // WhatsApp may only appear as another place a booking was made ("booked on WhatsApp").
  assert.ok(!/WhatsApp/.test(rest.split('booked on WhatsApp').join('')), 'prompt outside the Messenger section still treats the patient as a WhatsApp number');
  assert.ok(byNode(MSG, 'AI Agent').parameters.text.indexOf('Facebook Messenger') > 0);
  // Every other prompt rule is carried over verbatim from WhatsApp.
  const waPrompt = byNode(WA, 'AI Agent').parameters.options.systemMessage;
  for (const h of waPrompt.match(/^##.*$/gm)) assert.ok(prompt.indexOf(h.replace('WHATSAPP', 'MESSENGER')) >= 0, 'lost prompt section ' + h);
  assert.strictEqual(byNode(MSG, 'OpenRouter Chat Model').parameters.model, byNode(WA, 'OpenRouter Chat Model').parameters.model);
});

test('MG6 patients only ever receive Messenger messages; WhatsApp is used only for staff; no token in item data', () => {
  for (const n of MSG.nodes.filter((x) => x.type === 'n8n-nodes-base.whatsApp')) {
    assert.ok(/^Alert Staff/.test(n.name), n.name + ' would WhatsApp the patient');
    assert.strictEqual(n.parameters.recipientPhoneNumber, "={{ $('Dedup & Filter Prep').first().json.staffChatId }}");
  }
  for (const n of ['Send Messenger Reply', 'Send Messenger Reply (part 2)', 'Send Fallback Reply', 'Send Unsupported Reply', 'Send Voice Failed Reply']) {
    const p = byNode(MSG, n).parameters;
    assert.strictEqual(p.url, GRAPH_SEND, n);
    assert.ok(/recipient: \{ id: \$\('Dedup & Filter Prep'\)\.first\(\)\.json\.chatId \}/.test(p.jsonBody), n);
    assert.ok(/messaging_type: 'RESPONSE'/.test(p.jsonBody), n);
    assert.deepStrictEqual(byNode(MSG, n).credentials, { httpHeaderAuth: require('../lumiere.config.js').credentials.facebookPage });
  }
  const dl = byNode(MSG, 'Download Voice Binary');
  assert.ok(!dl.credentials && !dl.parameters.sendHeaders && !dl.parameters.authentication, 'no token may be sent to the voice CDN');
  const dedup = byNode(MSG, 'Dedup & Filter Prep').parameters.jsCode;
  assert.ok(!/\$env\.\w*TOKEN|accessToken/.test(dedup), 'Dedup must not copy tokens into execution data');
  assert.ok(JSON.stringify(byNode(MSG, 'Escalate to Staff').parameters).indexOf('$env.LUMIERE_WHATSAPP_ACCESS_TOKEN') >= 0);
});

test('MG7 signature check: the embedded HMAC-SHA256 equals Node crypto (random keys/messages, multi-block, long keys, UTF-8)', () => {
  const code = byNode(MSG, 'Verify Signature & Split').parameters.jsCode;
  const lib = code.slice(code.indexOf('const K = '), code.indexOf('async function rawBody'));
  const { hmacHex, sha256, utf8 } = new Function(lib + '\nreturn { hmacHex, sha256, utf8 };')();
  const rnd = require('./lib/sim').mulberry32(7);
  const str = (n) => Array.from({ length: n }, () => String.fromCharCode(rnd() < 0.2 ? 0x0600 + Math.floor(rnd() * 200) : 32 + Math.floor(rnd() * 90))).join('');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const m = str(n);
    assert.strictEqual(Buffer.from(sha256(utf8(m))).toString('hex'), crypto.createHash('sha256').update(m, 'utf8').digest('hex'), 'sha256 len ' + n);
  }
  for (let i = 0; i < 200; i++) {
    const key = str(Math.floor(rnd() * 150)), msg = str(Math.floor(rnd() * 600));
    assert.strictEqual(hmacHex(key, utf8(msg)), crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex'), 'hmac #' + i);
  }
});

// ------------------------------------------------------------------ webhook behaviour
test('M1 verification handshake: correct token echoes the challenge; wrong or unset token -> 403', async () => {
  const e = env();
  const get = (q) => runMessenger(e, 'Messenger Webhook (verify)', [{ json: { headers: {}, params: {}, body: {}, query: q } }]);
  await all(e, [() => get({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1158201444' })]);
  assert.deepStrictEqual(e.rec.responses.pop(), { node: 'Respond: Challenge', code: 200, body: '1158201444' });
  await all(e, [() => get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': 'x' })]);
  assert.strictEqual(e.rec.responses.pop().code, 403);
  e.envVars.LUMIERE_MESSENGER_VERIFY_TOKEN = '';
  await all(e, [() => get({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'x' })]);
  assert.strictEqual(e.rec.responses.pop().code, 403, 'an unset verify token must never verify');
});

test('M2 signed text message -> one AI turn, reply on Messenger to that PSID, lock released, logged', async () => {
  const e = env({ seed: 201 });
  await all(e, [() => post(e, [ev(e, A, { text: 'سلام، نحب نحجز موعد' })])]);
  noErrors(e);
  assert.deepStrictEqual(aiFor(e, A).map((c) => c.text), ['سلام، نحب نحجز موعد']);
  assert.ok(aiFor(e, A)[0].prompt.indexOf('Channel: Facebook Messenger') >= 0 && aiFor(e, A)[0].prompt.indexOf(A) < 0, 'the PSID is never shown to the AI');
  assert.deepStrictEqual(fbTo(e, A).map((s) => [s.node, s.text]), [['Send Messenger Reply', REPLY]]);
  assert.strictEqual(staffAlerts(e).length, 0);
  assert.deepStrictEqual(e.rec.logs.map((l) => l.phone), [FK(A) + ' (Sara Benali)']);
  lockFree(e, A);
});

test('M3 forged, tampered, unsigned or unconfigured requests are rejected before any processing', async () => {
  const cases = [
    { name: 'wrong secret', o: { secret: 'not-the-secret' } },
    { name: 'tampered body', o: { signedRaw: metaJson({ object: 'page', entry: [] }) } },
    { name: 'no signature', o: { sig: null } },
    { name: 'malformed signature', o: { sig: 'sha1=abc' } },
    { name: 'app secret unset', o: {}, unset: true },
  ];
  for (const c of cases) {
    const e = env({ seed: 202 });
    if (c.unset) e.envVars.LUMIERE_MESSENGER_APP_SECRET = '';
    await all(e, [() => post(e, [ev(e, A, { text: 'book me' })], c.o)]);
    noErrors(e);
    assert.strictEqual(e.pending.length, 0, c.name + ': no message may be processed');
    assert.strictEqual(e.rec.ai.length + e.rec.sends.length, 0, c.name);
    assert.ok(e.rec.execs[0].runner.runData['Rejected - Bad Signature'], c.name + ' must end at Rejected - Bad Signature');
  }
});

test('M4 raw body unavailable -> signature still verified from the escaped re-serialization (Arabic, emoji, URLs)', async () => {
  const e = env({ seed: 203 });
  e.voiceText = 'نحب موعد غدوة';
  await all(e, [() => post(e, [ev(e, A, { text: 'صباح الخير 😊 https://maps.example/x' })], { noRaw: true })]);
  noErrors(e);
  assert.strictEqual(aiFor(e, A).length, 1);
  const e2 = env({ seed: 204 });
  await all(e2, [() => post(e2, [ev(e2, A, { text: 'صباح الخير' })], { noRaw: true, secret: 'wrong' })]);
  assert.strictEqual(e2.pending.length, 0, 'fallback path must still reject a bad signature');
});

test('M5 batched webhook: two patients + echo/read/delivery events -> exactly two separate executions', async () => {
  const e = env({ seed: 205 });
  const events = [
    ev(e, A, { text: 'from A' }),
    ev(e, PAGE, { text: 'page echo', echo: true }),
    { sender: { id: B }, recipient: { id: PAGE }, timestamp: e.sim.now, read: { watermark: e.sim.now } },
    { sender: { id: B }, recipient: { id: PAGE }, timestamp: e.sim.now, delivery: { mids: ['m_x'], watermark: e.sim.now } },
    ev(e, B, { text: 'from B' }),
  ];
  await all(e, [() => post(e, events)]);
  noErrors(e);
  assert.strictEqual(e.pending.length, 2);
  assert.deepStrictEqual(e.rec.ai.map((c) => c.text).sort(), ['from A', 'from B']);
  assert.strictEqual(fbTo(e, A).length, 1);
  assert.strictEqual(fbTo(e, B).length, 1);
  assert.strictEqual(fbTo(e, PAGE).length, 0, 'the page echo must never be answered');
  lockFree(e, A); lockFree(e, B);
});

test('M6 five rapid messages from one patient (scrambled delivery) -> serialized, in Messenger timestamp order', async () => {
  const e = env({ seed: 206 });
  const t0 = e.sim.now;
  const msgs = [0, 1, 2, 3, 4].map((i) => ev(e, A, { text: 'm' + i, ts: t0 + i * 150 }));
  await all(e, [2, 0, 4, 1, 3].map((i, k) => at(e, k * 120, () => post(e, [msgs[i]]))));
  noErrors(e);
  const calls = aiFor(e, A);
  assert.deepStrictEqual(calls.map((c) => c.text), ['m0', 'm1', 'm2', 'm3', 'm4']);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i - 1].t1 <= calls[i].t0, 'AI turns overlapped');
  assert.strictEqual(fbTo(e, A).length, 5);
  lockFree(e, A);
});

test('M7 duplicate webhook deliveries (Meta retries) are processed exactly once; stale messages are dropped', async () => {
  const e = env({ seed: 207 });
  const m = ev(e, A, { text: 'once' });
  await all(e, [at(e, 0, () => post(e, [m])), at(e, 20, () => post(e, [m])), at(e, 30000, () => post(e, [m]))]);
  noErrors(e);
  assert.strictEqual(aiFor(e, A).length, 1);
  assert.strictEqual(fbTo(e, A).length, 1);
  const stale = env({ seed: 208 });
  await all(stale, [() => post(stale, [ev(stale, A, { text: 'old', ts: stale.sim.now - 4 * 60000 })])]);
  assert.strictEqual(stale.rec.ai.length + stale.rec.sends.length, 0);
});

test('M8 voice note: downloaded from the CDN without a token, named by type, transcribed, answered', async () => {
  const e = env({ seed: 209 });
  e.voiceText = 'نحب نحجز';
  await all(e, [() => post(e, [ev(e, A, { audio: true })])]);
  noErrors(e);
  assert.deepStrictEqual(aiFor(e, A).map((c) => c.text), ['VOICE:نحب نحجز']);
  assert.ok(aiFor(e, A)[0].prompt.indexOf('auto-transcribed') >= 0);
  assert.strictEqual(e.rec.cdn.length, 1);
  assert.deepStrictEqual(e.rec.cdn[0].headers, {}, 'no Authorization header to the CDN');
  assert.deepStrictEqual(e.rec.transcribed, ['voice.mp4']);
  for (const [mime, name] of [['audio/aac', 'voice.aac'], ['audio/mpeg', 'voice.mp3'], ['application/octet-stream', 'voice.mp4']]) {
    const x = env({ seed: 210 }); x.voiceMime = mime;
    await all(x, [() => post(x, [ev(x, A, { audio: true })])]);
    assert.deepStrictEqual(x.rec.transcribed, [name], mime);
  }
  for (const fault of ['cdn', 'transcribe']) {
    const f = env({ seed: 211 }); f.faults[fault] = true;
    await all(f, [() => post(f, [ev(f, A, { audio: true })])]);
    noErrors(f);
    assert.strictEqual(f.rec.ai.length, 0, fault);
    assert.deepStrictEqual(fbTo(f, A).map((s) => s.node), ['Send Voice Failed Reply'], fault);
    lockFree(f, A);
  }
});

test('M9 image -> polite unsupported reply; like sticker -> "👍"; Get Started button -> greeting turn', async () => {
  const e = env({ seed: 212 });
  await all(e, [() => post(e, [ev(e, A, { image: true })])]);
  assert.deepStrictEqual(fbTo(e, A).map((s) => s.node), ['Send Unsupported Reply']);
  assert.strictEqual(e.rec.ai.length, 0);
  lockFree(e, A);
  await all(e, [() => post(e, [ev(e, B, { like: true })])]);
  await all(e, [() => post(e, [ev(e, A, { postback: 'Get Started' })])]);
  noErrors(e);
  assert.deepStrictEqual(e.rec.ai.map((c) => c.text), ['👍', 'Get Started']);
});

test('M10 escalation: "fb:<page>:<PSID>" pause row written before the reply; bot silent until staff unmute in the sheet', async () => {
  let alert = null;
  const e = env({ seed: 213, ai: { behave: (c, run) => (c.text === 'عندي نزيف'
    ? { output: 'روح للاستعجالات فورا، فريق العيادة غادي يتواصل معاك.', tools: async () => {
      const node = run.nodes.get('Escalate to Staff');
      const ctx = Object.assign(run.exprCtx(null, 0, []), { $fromAI: () => 'possible medical emergency' });
      alert = JSON.parse(run.evalExpr(node.parameters.jsonBody, ctx));
      return [{ action: { tool: 'Escalate_to_Staff' }, observation: 'sent' }];
    } }
    : { output: REPLY }) } });
  const a = ev(e, A, { text: 'عندي نزيف' }), b = ev(e, A, { text: 'allo?', ts: a.timestamp + 1000 });
  await all(e, [at(e, 0, () => post(e, [a])), at(e, 1000, () => post(e, [b]))]);
  noErrors(e);
  assert.deepStrictEqual(aiFor(e, A).map((c) => c.text), ['عندي نزيف'], 'second message must not reach the AI');
  assert.deepStrictEqual(e.sheet.handoffs, [{ Patient_ID: FK(A), Status: 'paused' }]);
  const pauseAt = e.rec.sheetsWrites[0].t, replyAt = fbTo(e, A)[0].t;
  assert.ok(pauseAt <= replyAt, 'pause persisted before the reply');
  assert.strictEqual(fbTo(e, A).length, 1);
  assert.strictEqual(alert.to, STAFF);
  assert.ok(/^⚠️ \[Messenger\] possible medical emergency/.test(alert.text.body), alert.text.body);
  assert.ok(alert.text.body.indexOf('Sara Benali') > 0 && alert.text.body.indexOf('row ' + FK(A) + ' ->') > 0 && /Status = unmuted/.test(alert.text.body), alert.text.body);
  lockFree(e, A);
  e.sheet.handoffs[0].Status = 'unmuted'; // staff re-enable the bot
  await all(e, [() => post(e, [ev(e, A, { text: 'شكرا' })])]);
  assert.deepStrictEqual(aiFor(e, A).map((c) => c.text), ['عندي نزيف', 'شكرا']);
});

test('M11 pause rows never cross channels (Messenger rows vs WhatsApp numbers, bare digits vs fb: prefix)', async () => {
  const e = env({ seed: 214 });
  e.sheet.handoffs.push({ Patient_ID: FK(A), Status: 'paused' }, { Patient_ID: B, Status: 'paused' }, { Patient_ID: WAP, Status: 'paused' });
  await all(e, [() => post(e, [ev(e, A, { text: 'a' })]), () => post(e, [ev(e, B, { text: 'b' })]), () => deliver(e, waMessage(e, '213555000002', { text: 'wa' }))]);
  noErrors(e);
  assert.deepStrictEqual(e.rec.ai.map((c) => c.text).sort(), ['b', 'wa'], 'only fb:A is paused on Messenger; the WhatsApp patient is unaffected');
});

test('M11b migration: a pause row written before customer keys ("fb:<PSID>") still pauses; other Pages and Instagram rows never do', async () => {
  const e = env({ seed: 233 });
  e.sheet.handoffs.push({ Patient_ID: 'fb:' + A, Status: 'paused' }, { Patient_ID: FK(B, '999888777666555'), Status: 'paused' }, { Patient_ID: 'ig:17841400000000001:' + B, Status: 'paused' });
  await all(e, [() => post(e, [ev(e, A, { text: 'a' })]), () => post(e, [ev(e, B, { text: 'b' })])]);
  noErrors(e);
  assert.deepStrictEqual(e.rec.ai.map((c) => c.text), ['b'], 'legacy fb:<PSID> row keeps A paused; B is paused only on another Page / on Instagram');
  // A WhatsApp customer is never paused by a Messenger or Instagram row, even when the digits would match.
  const w = env({ seed: 234 });
  w.sheet.handoffs.push({ Patient_ID: 'fb:' + WAP, Status: 'paused' }, { Patient_ID: 'ig:' + WAP, Status: 'paused' });
  await all(w, [() => deliver(w, waMessage(w, WAP, { text: 'wa' }))]);
  noErrors(w);
  assert.deepStrictEqual(w.rec.ai.map((c) => c.text), ['wa']);
});

test('M12 replies longer than 2000 characters are split into two Messenger messages, in order, nothing lost', async () => {
  const line = 'حمزة ميهوبي - كشف، الأحد 27 سبتمبر الساعة 12:00 ';
  const long = Array.from({ length: 45 }, (_, i) => (i + 1) + ') ' + line).join('\n');
  assert.ok(long.length > 2000 && long.length <= 2800, 'fixture length ' + long.length);
  const e = env({ seed: 215, ai: { behave: () => ({ output: long }) } });
  await all(e, [() => post(e, [ev(e, A, { text: 'mawa3idi?' })])]);
  noErrors(e);
  const parts = fbTo(e, A);
  assert.deepStrictEqual(parts.map((s) => s.node), ['Send Messenger Reply', 'Send Messenger Reply (part 2)']);
  for (const p of parts) assert.ok(p.text.length <= MB.MESSENGER_MAX_CHARS, 'part too long: ' + p.text.length);
  assert.strictEqual((parts[0].text + '\n' + parts[1].text).replace(/\s+/g, ' ').trim(), long.replace(/\s+/g, ' ').trim());
  assert.ok(parts[0].text.indexOf('1) ') === 0 && parts[1].text.indexOf('45) ') >= 0);
  assert.strictEqual(e.rec.logs.length, 1, 'logged once');
  lockFree(e, A);
});

test('M13 Messenger send failure -> staff alerted on WhatsApp (with patient name), lock released, next message processed', async () => {
  const e = env({ seed: 216 });
  let fails = 0;
  e.faults.messenger = (node, to) => node === 'Send Messenger Reply' && to === A && fails++ < 3;
  const a = ev(e, A, { text: 'one' }), b = ev(e, A, { text: 'two', ts: a.timestamp + 1000 });
  await all(e, [at(e, 0, () => post(e, [a])), at(e, 500, () => post(e, [b]))]);
  noErrors(e);
  const alert = staffAlerts(e).find((s) => s.node === 'Alert Staff - System Error');
  assert.ok(alert && alert.text.indexOf('[Messenger]') >= 0 && alert.text.indexOf('Sara Benali') >= 0 && alert.text.indexOf(FK(A)) >= 0, alert && alert.text);
  assert.strictEqual(aiFor(e, A).length, 2);
  lockFree(e, A);
});

test('M14 AI failure / lock store down / profile lookup down -> patient still answered on Messenger, staff alerted', async () => {
  const e = env({ seed: 217, ai: { behave: () => ({ fail: true }) } });
  await all(e, [() => post(e, [ev(e, A, { text: 'boom' })])]);
  noErrors(e);
  assert.deepStrictEqual(fbTo(e, A).map((s) => s.node), ['Send Fallback Reply']);
  assert.ok(staffAlerts(e).some((s) => s.node === 'Alert Staff - System Error'));
  lockFree(e, A);
  const d = env({ seed: 218, cal: { fault: () => ({ kind: '503' }) } });
  await all(d, [() => post(d, [ev(d, A, { text: 'hi' })])]);
  noErrors(d);
  assert.strictEqual(d.rec.ai.length, 0, 'never process unserialized');
  assert.deepStrictEqual(fbTo(d, A).map((s) => s.node), ['Send Fallback Reply']);
  const alert = staffAlerts(d).find((s) => s.node === 'Alert Staff - System Error');
  assert.ok(alert && alert.text.indexOf(FK(A)) >= 0, 'alert works before the profile was fetched');
  const p = env({ seed: 219 }); p.faults.profile = true;
  await all(p, [() => post(p, [ev(p, A, { text: 'hi' })])]);
  noErrors(p);
  assert.deepStrictEqual(fbTo(p, A).map((s) => s.node), ['Send Messenger Reply']);
  assert.deepStrictEqual(p.rec.logs.map((l) => l.phone), [FK(A)]);
});

// ------------------------------------------------------------------ appointments across channels
// The identity a tool node really sends (server-set phone_number + customer_key).
function toolIdent(run, tool) {
  const v = run.nodes.get(tool).parameters.workflowInputs.value, ctx = run.exprCtx(null, 0, []);
  return { phone_number: run.evalExpr(v.phone_number, ctx), customer_key: run.evalExpr(v.customer_key, ctx) };
}
const slot = (ident, name) => Object.assign({ start_datetime: '2026-10-06T10:00:00', service_keys: 'mens_cut', summary: name + ' - Kashf', notes: 'Messenger - Tel: 0555000009 | ' + name },
  typeof ident === 'string' ? { phone_number: ident } : ident);

test('M15 a Messenger booking belongs to that Messenger conversation: found from it, invisible to others', async () => {
  const found = {};
  const e = env({ seed: 220, ai: { behave: (c, run) => ({
    output: REPLY,
    tools: async (env2) => {
      if (c.text === 'book') { const r = await callTool(env2, 'book', slot(toolIdent(run, 'Book_Appointment'), 'Sara Benali')); c.res = r.result; }
      else { const r = await callTool(env2, 'find', Object.assign({ patient_name: '', appointment_date: '', booked_phone_number: '' }, toolIdent(run, 'Find_Patient_Appointments'))); found[c.chat] = r.result; }
      return [];
    },
  }) } });
  await all(e, [() => post(e, [ev(e, A, { text: 'book' })])]);
  assert.ok(/^SUCCESS/.test(e.rec.ai[0].res), e.rec.ai[0].res);
  const evs = e.cal.events(CFG.CALENDAR_ID);
  assert.strictEqual(evs.length, 1);
  assert.ok(evs[0].description.indexOf('Customer: ' + FK(A) + '. Service: Men\'s haircut | Keys: mens_cut | Duration: 30 min. Notes: Messenger - Tel: 0555000009') === 0, evs[0].description);
  await all(e, [() => post(e, [ev(e, A, { text: 'find' })]), () => post(e, [ev(e, B, { text: 'find' })]), () => deliver(e, waMessage(e, WAP, { text: 'find' }))]);
  noErrors(e);
  assert.ok(/^FOUND: 1\) Sara Benali - Kashf on 2026-10-06 at 10:00/.test(found[A]), found[A]);
  assert.ok(/^NOT_FOUND/.test(found[B]), 'another Messenger user must not see it');
  assert.ok(/^NOT_FOUND/.test(found[WAP]), 'a WhatsApp number must not see it');
});

test('M16 a WhatsApp patient and a Messenger patient booking the same slot at the same moment -> exactly one appointment', async () => {
  for (const seed of [221, 222, 223]) {
    const e = env({ seed, ai: { thinkMs: 500, behave: (c, run) => ({
      thinkMs: 500, output: REPLY,
      tools: async (env2) => { const r = await callTool(env2, 'book', slot(toolIdent(run, 'Book_Appointment'), c.chat === A ? 'Sara Benali' : 'Amine Kaci')); c.res = r.result; return []; },
    }) } });
    await all(e, [at(e, 0, () => post(e, [ev(e, A, { text: 'book' })])), at(e, 5, () => deliver(e, waMessage(e, WAP, { text: 'book' })))]);
    noErrors(e);
    assert.deepStrictEqual(e.rec.ai.map((c) => c.res.split(':')[0]).sort(), ['CONFLICT', 'SUCCESS'], 'seed ' + seed);
    assert.strictEqual(e.cal.events(CFG.CALENDAR_ID).length, 1, 'seed ' + seed);
    assert.deepStrictEqual(e.cal.violations, []);
  }
});

test('M17 a Messenger customer can NOT manage a WhatsApp/phone booking by typing its number (staff only, nothing revealed)', async () => {
  const e = env({ seed: 224 });
  const find = (booked) => callTool(e, 'find', { phone_number: '', customer_key: FK(A), patient_name: '', appointment_date: '', booked_phone_number: booked });
  const r = {};
  await all(e, [async () => { await callTool(e, 'book', slot(WAP, 'Amine Kaci')); r.psid = await find(''); r.num = await find('0555000001'); }]);
  assert.ok(/^NOT_FOUND/.test(r.psid.result), r.psid.result);
  // Before 2026-11-25 this returned "FOUND: 1) Amine Kaci ...".
  assert.ok(/^NEED_STAFF/.test(r.num.result) && r.num.result.indexOf('Amine') < 0, r.num.result);
});

test('M18 the same PSID on another Page, on Instagram or as a phone number is a different customer (lock, appointments)', async () => {
  const P2 = '909090909090909';
  const e = env({ seed: 235 });
  const find = (ident) => callTool(e, 'find', Object.assign({ phone_number: '', patient_name: '', appointment_date: '', booked_phone_number: '' }, ident));
  const r = {};
  await all(e, [async () => {
    r.book = await callTool(e, 'book', slot({ phone_number: '', customer_key: FK(A) }, 'Sara Benali'));
    r.own = await find({ customer_key: FK(A) });
    r.page2 = await find({ customer_key: FK(A, P2) });
    r.ig = await find({ customer_key: 'ig:' + PAGE + ':' + A });
    r.digits = await find({ phone_number: A });
    r.booked = await find({ customer_key: FK(B), booked_phone_number: '+' + A.slice(0, 15) });
  }]);
  assert.ok(/^SUCCESS/.test(r.book.result), r.book.result);
  assert.ok(/^FOUND: 1\) Sara Benali/.test(r.own.result), r.own.result);
  for (const k of ['page2', 'ig', 'digits', 'booked']) assert.ok(!/^FOUND/.test(r[k].result), k + ' must not see the Messenger booking: ' + r[k].result);
  assert.notStrictEqual(chatLock(FK(A)), chatLock(FK(A, P2)));
  assert.notStrictEqual(chatLock(FK(A)), chatLock('ig:' + PAGE + ':' + A));
  assert.notStrictEqual(chatLock(FK(A)), chatLock(A));
  // Same PSID delivered by two Pages -> two customers, two lock objects, both answered.
  const w = env({ seed: 236 });
  await all(w, [() => post(w, [ev(w, A, { text: 'p1' })]), () => post(w, [ev(w, A, { text: 'p2' })], { page: P2 })]);
  noErrors(w);
  assert.deepStrictEqual(w.rec.ai.map((c) => c.text).sort(), ['p1', 'p2']);
  lockFree(w, FK(A)); lockFree(w, FK(A, P2));
});

test('M19 malformed events (no Page id, non-numeric ids) are dropped before any processing', async () => {
  const e = env({ seed: 237 });
  await all(e, [
    () => post(e, [ev(e, A, { text: 'no page' })], { page: null }),
    () => post(e, [ev(e, A, { text: 'bad page' })], { page: 'abc' }),
    () => post(e, [ev(e, 'not-a-psid', { text: 'bad sender' })]),
  ]);
  noErrors(e);
  assert.strictEqual(e.rec.ai.length + e.rec.sends.length, 0);
});

test('MX mutations prove the checks are load-bearing: without them a forged request is processed / a bare PSID row pauses', async () => {
  const mutate = (node, from, to) => { const w = JSON.parse(JSON.stringify(MSG)); const n = byNode(w, node); assert.ok(n.parameters.jsCode.indexOf(from) >= 0, 'mutation anchor'); n.parameters.jsCode = n.parameters.jsCode.split(from).join(to); return w; };
  const noSig = mutate('Verify Signature & Split', 'if (reason) return', 'if (false) return');
  const e = env({ seed: 230 });
  await all(e, [() => runMessenger(e, 'Messenger Webhook', [{ json: { headers: {}, params: {}, query: {}, body: { object: 'page', entry: [{ id: PAGE, messaging: [ev(e, A, { text: 'forged' })] }] } } }], noSig)]);
  assert.strictEqual(e.rec.ai.length, 1, 'mutation should have let the forged message through');
  const digits = mutate('Match Pause Status', "const keys = [d.customerKey, 'fb:' + d.chatId];", "const keys = [d.customerKey, 'fb:' + d.chatId, d.chatId];");
  const d = env({ seed: 231 });
  d.sheet.handoffs.push({ Patient_ID: A, Status: 'paused' });
  await all(d, [() => post(d, [ev(d, A, { text: 'x' })])]);
  assert.strictEqual(d.rec.ai.length, 1, 'real workflow: a bare-digit row must not pause Messenger');
  const m = env({ seed: 232 });
  m.sheet.handoffs.push({ Patient_ID: A, Status: 'paused' });
  await all(m, [() => runMessenger(m, 'Messenger Event', [{ json: { event: ev(m, A, { text: 'x' }), pageId: PAGE } }], digits)]);
  assert.strictEqual(m.rec.ai.length, 0, 'mutant: the bare row now pauses - so M11 guards the fb: prefix');
});

if (require.main === module) runTests('messenger').then((r) => process.exit(r.fail ? 1 : 0));
