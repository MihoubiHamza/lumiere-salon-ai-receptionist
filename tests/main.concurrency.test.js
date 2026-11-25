'use strict';
// Executes the REAL main WhatsApp workflow JSON with stubbed WhatsApp / Sheets /
// transcription / AI Agent and the fake Google Calendar backing the chat locks.
const assert = require('assert');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');
const { CFG, makeEnv, deliver, waMessage, runAll, at, callTool, STAFF } = H;
const LOCKCAL = CFG.LOCK_CALENDAR_ID;
const chatLock = require(require('path').join(H.ROOT, 'engine', 'engine.js')).createEngine(CFG)._t.chatLockId;
const P1 = '213555000001', P2 = '213555000002', P3 = '213555000003';
const REPLY = 'مرحبا، كيفاش نقدر نعاونك؟';

const aiFor = (env, chat) => env.rec.ai.filter((a) => a.chat === chat).sort((a, b) => a.t0 - b.t0);
const sendsTo = (env, chat) => env.rec.sends.filter((s) => s.to === chat);
function assertSerialized(env, chat) {
  const calls = aiFor(env, chat);
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i - 1].t1 != null && calls[i - 1].t1 <= calls[i].t0, 'AI calls for ' + chat + ' overlapped: ' + calls[i - 1].text + ' / ' + calls[i].text);
  }
}
function assertChatLockFree(env, chat) {
  const st = env.cal.lockState(LOCKCAL, chatLock(chat));
  assert.ok(st, 'no chat lock object for ' + chat);
  assert.ok(!st.h || st.hx <= env.sim.now, 'chat lock for ' + chat + ' still held at end');
  assert.deepStrictEqual(st.w || [], [], 'waiters left behind for ' + chat);
  assert.deepStrictEqual(env.cal.violations, [], 'mutual exclusion violated');
}
const noExecErrors = (env) => { for (const r of env.rec.execs || []) assert.ok(!r.error, 'execution failed: ' + (r.error && (r.error.node + ': ' + r.error.message))); };
const base = (o) => makeEnv(Object.assign({ ai: { behave: () => ({ output: REPLY }) } }, o));

test('P1 two messages within 1 second are processed one at a time, in order', async () => {
  const env = base({ seed: 101 });
  const a = waMessage(env, P1, { text: 'first' }), b = waMessage(env, P1, { text: 'second', ts: Number(a._ts) + 1 });
  await runAll(env, [at(env, 0, () => deliver(env, a)), at(env, 400, () => deliver(env, b))]);
  noExecErrors(env);
  assert.deepStrictEqual(aiFor(env, P1).map((c) => c.text), ['first', 'second']);
  assertSerialized(env, P1);
  assert.strictEqual(sendsTo(env, P1).length, 2);
  assertChatLockFree(env, P1);
});

test('P2 five messages within 1 second -> five serialized AI turns in timestamp order', async () => {
  for (const seed of [102, 103, 104]) {
    const env = base({ seed });
    const t0 = Math.floor(env.sim.now / 1000);
    const msgs = [0, 1, 2, 3, 4].map((i) => waMessage(env, P1, { text: 'm' + i, ts: t0 + i }));
    // delivered in a scrambled order inside one second
    const order = [2, 0, 4, 1, 3];
    await runAll(env, order.map((i, k) => at(env, k * 180, () => deliver(env, msgs[i]))));
    noExecErrors(env);
    assert.deepStrictEqual(aiFor(env, P1).map((c) => c.text), ['m0', 'm1', 'm2', 'm3', 'm4'], 'seed ' + seed);
    assertSerialized(env, P1);
    assert.strictEqual(sendsTo(env, P1).length, 5);
    assertChatLockFree(env, P1);
  }
});

test('P3 voice note + text almost simultaneously -> both processed, serialized, in order', async () => {
  const env = base({ seed: 105 });
  env.voiceText = 'نحب نحجز';
  const v = waMessage(env, P1, { type: 'audio' }), t = waMessage(env, P1, { text: 'ghodwa', ts: Number(v._ts) + 1 });
  await runAll(env, [at(env, 0, () => deliver(env, v)), at(env, 300, () => deliver(env, t))]);
  noExecErrors(env);
  assert.deepStrictEqual(aiFor(env, P1).map((c) => c.text), ['VOICE:نحب نحجز', 'ghodwa']);
  assertSerialized(env, P1);
  assertChatLockFree(env, P1);
});

test('P4 duplicate webhook deliveries (concurrent and late) are processed exactly once', async () => {
  const env = base({ seed: 106 });
  const m = waMessage(env, P1, { text: 'book me' });
  await runAll(env, [at(env, 0, () => deliver(env, m)), at(env, 15, () => deliver(env, m)), at(env, 900, () => deliver(env, m)), at(env, 20000, () => deliver(env, m))]);
  noExecErrors(env);
  assert.strictEqual(aiFor(env, P1).length, 1);
  assert.strictEqual(sendsTo(env, P1).length, 1);
  assertChatLockFree(env, P1);
});

test('P5 out-of-order delivery within the settle window is re-ordered by WhatsApp timestamp', async () => {
  const env = base({ seed: 107 });
  const first = waMessage(env, P1, { text: 'first' });
  const second = waMessage(env, P1, { text: 'second', ts: Number(first._ts) + 2 });
  await runAll(env, [at(env, 0, () => deliver(env, second)), at(env, 700, () => deliver(env, first))]);
  noExecErrors(env);
  assert.deepStrictEqual(aiFor(env, P1).map((c) => c.text), ['first', 'second']);
  assert.ok(aiFor(env, P1).every((c) => c.prompt.indexOf('System note') < 0));
});

test('P5b a message that arrives after a newer one was already answered is flagged to the AI', async () => {
  const env = base({ seed: 108 });
  const newer = waMessage(env, P1, { text: 'newer' });
  const older = waMessage(env, P1, { text: 'older', ts: Number(newer._ts) - 5 });
  await runAll(env, [at(env, 0, () => deliver(env, newer)), at(env, 10000, () => deliver(env, older))]);
  noExecErrors(env);
  const calls = aiFor(env, P1);
  assert.deepStrictEqual(calls.map((c) => c.text), ['newer', 'older']);
  assert.ok(calls[1].prompt.indexOf('sent BEFORE the customer') >= 0, 'late message must carry the out-of-order note');
  assert.ok(calls[0].prompt.indexOf('System note') < 0);
});

test('P6 execution crashes mid-processing -> next message waits for the lease, then proceeds; no permanent block', async () => {
  const env = base({ seed: 109, ai: { behave: (c) => (c.text === 'crash' ? { kill: true } : { output: REPLY }) } });
  const a = waMessage(env, P1, { text: 'crash' }), b = waMessage(env, P1, { text: 'after', ts: Number(a._ts) + 2 });
  await runAll(env, [at(env, 0, () => deliver(env, a)), at(env, 2000, () => deliver(env, b))]);
  const calls = aiFor(env, P1);
  assert.deepStrictEqual(calls.map((c) => c.text), ['crash', 'after']);
  assert.ok(calls[1].t0 - calls[0].t0 >= CFG.CHAT_LOCK_TTL_MS - 5000, 'must not start before the crashed lease expired');
  assert.strictEqual(sendsTo(env, P1).filter((s) => s.node === 'Send WhatsApp Reply').length, 1);
  assertChatLockFree(env, P1);
});

test('P7 AI Agent failure -> fallback reply + staff alert + lock released immediately', async () => {
  const env = base({ seed: 110, ai: { behave: (c) => (c.text === 'boom' ? { fail: true } : { output: REPLY }) } });
  const a = waMessage(env, P1, { text: 'boom' }), b = waMessage(env, P1, { text: 'next', ts: Number(a._ts) + 1 });
  await runAll(env, [at(env, 0, () => deliver(env, a)), at(env, 500, () => deliver(env, b))]);
  noExecErrors(env);
  const nodes = env.rec.sends.map((s) => s.node);
  assert.ok(nodes.indexOf('Send Fallback Reply') >= 0 && nodes.indexOf('Alert Staff - System Error') >= 0, nodes.join(','));
  const calls = aiFor(env, P1);
  assert.ok(calls[1].t0 - calls[0].t0 < 30000, 'lock must be released by the error path, not by TTL');
  assertChatLockFree(env, P1);
});

test('P8 WhatsApp send failure -> staff alerted, lock released, next message still processed', async () => {
  const env = base({ seed: 111 });
  let failed = 0;
  env.faults.whatsapp = (node, to) => node === 'Send WhatsApp Reply' && to === P1 && failed++ < 3; // exhaust retries once
  const a = waMessage(env, P1, { text: 'one' }), b = waMessage(env, P1, { text: 'two', ts: Number(a._ts) + 1 });
  await runAll(env, [at(env, 0, () => deliver(env, a)), at(env, 500, () => deliver(env, b))]);
  noExecErrors(env);
  assert.ok(env.rec.sends.some((s) => s.node === 'Alert Staff - System Error' && s.to === STAFF));
  assert.strictEqual(aiFor(env, P1).length, 2);
  assert.ok(aiFor(env, P1)[1].t0 - aiFor(env, P1)[0].t0 < 60000);
  assertChatLockFree(env, P1);
});

test('P9 Google Sheets failure on the pause check -> fallback + alert + release (no silent drop)', async () => {
  const env = base({ seed: 112 });
  env.faults.sheetsRead = true;
  await runAll(env, [() => deliver(env, waMessage(env, P1, { text: 'hi' }))]);
  noExecErrors(env);
  assert.strictEqual(aiFor(env, P1).length, 0);
  assert.ok(env.rec.sends.some((s) => s.node === 'Send Fallback Reply' && s.to === P1));
  assert.ok(env.rec.sends.some((s) => s.node === 'Alert Staff - System Error'));
  assertChatLockFree(env, P1);
});

test('P10 transcription failure -> voice-failed reply + release', async () => {
  const env = base({ seed: 113 });
  env.faults.transcribe = true;
  await runAll(env, [() => deliver(env, waMessage(env, P1, { type: 'audio' }))]);
  noExecErrors(env);
  assert.ok(env.rec.sends.some((s) => s.node === 'Send Voice Failed Reply' && s.to === P1));
  assert.strictEqual(aiFor(env, P1).length, 0);
  assertChatLockFree(env, P1);
});

test('P11 paused (escalated) patient -> silence, no AI, lock released', async () => {
  const env = base({ seed: 114 });
  env.sheet.handoffs.push({ Patient_ID: P1, Status: 'paused' });
  await runAll(env, [() => deliver(env, waMessage(env, P1, { text: 'hello?' }))]);
  noExecErrors(env);
  assert.strictEqual(aiFor(env, P1).length, 0);
  assert.strictEqual(sendsTo(env, P1).length, 0);
  assertChatLockFree(env, P1);
});

test('P12 escalation: pause row is written before release, so a message sent meanwhile is NOT answered by the bot', async () => {
  const env = base({ seed: 115, ai: { behave: (c) => (c.text === 'I am bleeding'
    ? { output: 'اتصل بالاستعجالات فورا، فريق العيادة غادي يتواصل معاك.', tools: async () => [{ action: { tool: 'Escalate_to_Staff' }, observation: 'sent' }] }
    : { output: REPLY }) } });
  const a = waMessage(env, P1, { text: 'I am bleeding' }), b = waMessage(env, P1, { text: 'hello??', ts: Number(a._ts) + 1 });
  await runAll(env, [at(env, 0, () => deliver(env, a)), at(env, 1000, () => deliver(env, b))]);
  noExecErrors(env);
  assert.deepStrictEqual(aiFor(env, P1).map((c) => c.text), ['I am bleeding']);
  const pauseAt = env.rec.sheetsWrites.find((w) => w.status === 'paused').t;
  const replyAt = env.rec.sends.find((s) => s.node === 'Send WhatsApp Reply').t;
  assert.ok(pauseAt <= replyAt, 'pause must be persisted before the reply/lock release');
  assertChatLockFree(env, P1);
});

test('P12b pause write fails -> staff get a specific alert, patient still gets the reply', async () => {
  const env = base({ seed: 116, ai: { behave: () => ({ output: 'فريق العيادة غادي يتواصل معاك.', tools: async () => [{ action: { tool: 'Escalate_to_Staff' }, observation: 'sent' }] }) } });
  env.faults.pauseWrite = true;
  await runAll(env, [() => deliver(env, waMessage(env, P1, { text: 'angry' }))]);
  noExecErrors(env);
  assert.ok(env.rec.sends.some((s) => s.node === 'Alert Staff - Pause Failed' && s.to === STAFF));
  assert.ok(env.rec.sends.some((s) => s.node === 'Send WhatsApp Reply' && s.to === P1));
  assertChatLockFree(env, P1);
});

test('P13 lock store (Calendar) unavailable -> no unserialized processing: fallback reply + staff alert', async () => {
  const env = base({ seed: 117, cal: { fault: () => ({ kind: '503' }) } });
  await runAll(env, [() => deliver(env, waMessage(env, P1, { text: 'hi' }))]);
  noExecErrors(env);
  assert.strictEqual(aiFor(env, P1).length, 0);
  assert.ok(env.rec.sends.some((s) => s.node === 'Send Fallback Reply' && s.to === P1));
  assert.ok(env.rec.sends.some((s) => s.node === 'Alert Staff - System Error'));
});

test('P14 staff !unmute command bypasses the patient lock and works', async () => {
  const env = base({ seed: 118 });
  env.sheet.handoffs.push({ Patient_ID: P1, Status: 'paused' });
  await runAll(env, [() => deliver(env, waMessage(env, STAFF, { text: '!unmute 0555000001' }))]);
  noExecErrors(env);
  assert.strictEqual(env.sheet.handoffs[0].Status, 'unmuted');
  assert.ok(env.rec.sends.some((s) => s.node === 'Confirm Unmute to Staff' && s.to === STAFF));
  assert.strictEqual(env.cal.log.length, 0, 'staff command must not touch patient locks');
});

test('P15 unsupported message type -> polite reply + release', async () => {
  const env = base({ seed: 119 });
  await runAll(env, [() => deliver(env, waMessage(env, P1, { type: 'image' }))]);
  noExecErrors(env);
  assert.ok(env.rec.sends.some((s) => s.node === 'Send Unsupported Reply' && s.to === P1));
  assertChatLockFree(env, P1);
});

test('P16 different patients are NOT serialized against each other (no global bottleneck)', async () => {
  const env = base({ seed: 120 });
  await runAll(env, [at(env, 0, () => deliver(env, waMessage(env, P1, { text: 'a' }))), at(env, 10, () => deliver(env, waMessage(env, P2, { text: 'b' }))), at(env, 20, () => deliver(env, waMessage(env, P3, { text: 'c' })))]);
  noExecErrors(env);
  const all = env.rec.ai.slice().sort((x, y) => x.t0 - y.t0);
  assert.strictEqual(all.length, 3);
  assert.ok(all[1].t0 < all[0].t1 && all[2].t0 < all[0].t1, 'different chats should run concurrently');
});

test('P17 two patients\' AI turns book the same slot at the same moment -> one SUCCESS; false claim is caught', async () => {
  const req = (phone, name) => ({ start_datetime: '2026-10-06T10:00:00', service_keys: 'mens_cut', summary: name + ' - Kashf', notes: '', phone_number: phone });
  const env = base({ seed: 121, ai: { thinkMs: 500, behave: (c) => ({
    thinkMs: 500,
    tools: async (env2) => { const r = await callTool(env2, 'book', req(c.chat, c.chat === P1 ? 'Sara' : 'Amine')); c.bookResult = r.result; return [{ action: { tool: 'Book_Appointment' }, observation: JSON.stringify([{ result: r.result }]) }]; },
    output: 'تم حجز موعدك يوم الثلاثاء', // the LLM (wrongly) claims success in both chats
  }) } });
  await runAll(env, [at(env, 0, () => deliver(env, waMessage(env, P1, { text: 'book' }))), at(env, 5, () => deliver(env, waMessage(env, P2, { text: 'book' })))]);
  noExecErrors(env);
  const results = env.rec.ai.map((c) => c.bookResult.split(':')[0]).sort();
  assert.deepStrictEqual(results, ['CONFLICT', 'SUCCESS']);
  assert.strictEqual(env.cal.events(CFG.CALENDAR_ID).length, 1);
  const loser = env.rec.ai.find((c) => /^CONFLICT/.test(c.bookResult)).chat;
  const loserReply = env.rec.sends.find((s) => s.to === loser && s.node === 'Send WhatsApp Reply');
  assert.ok(loserReply && loserReply.text.indexOf('تم حجز') < 0, 'the patient whose booking failed must NOT receive the false success claim');
});

test('P18 randomized storm: 3 patients x 4 messages, 5% calendar faults, one crash -> ordered, no stuck locks', async () => {
  for (const seed of [122, 123]) {
    let crashed = false;
    const env = base({ seed, ai: { thinkMs: 2500, behave: (c) => (!crashed && c.text === 'P2-m1' ? (crashed = true, { kill: true }) : { output: REPLY }) } });
    env.cal.opts.fault = () => (env.sim.rng() < 0.05 ? { kind: env.sim.rng() < 0.5 ? '503' : 'dropAfter' } : null);
    const tasks = [];
    const sent = {};
    for (const p of [P1, P2, P3]) {
      const t0 = Math.floor(env.sim.now / 1000);
      sent[p] = [0, 1, 2, 3].map((i) => waMessage(env, p, { text: (p === P2 ? 'P2' : p.slice(-1)) + '-m' + i, ts: t0 + i }));
      sent[p].forEach((m, i) => tasks.push(at(env, Math.floor(env.sim.rng() * 1500) + i, () => deliver(env, m))));
    }
    await runAll(env, tasks);
    env.cal.opts.fault = null;
    // follow-up messages queued behind the crashed holder must be processed after
    // its lease expires, not bounced with a fallback (regression for MAX_WAIT <= TTL)
    const p2 = aiFor(env, P2);
    const crash = p2.find((c) => c.crashed);
    assert.ok(crash, 'storm should include the crash');
    const after = p2.filter((c) => c.t0 > crash.t0).map((c) => c.text);
    assert.ok(after.length >= 1 && after.every((t) => t > crash.text), 'P2 messages queued behind the crash were not processed: ' + p2.map((c) => c.text));
    for (const c of p2.filter((x) => x.t0 > crash.t0)) assert.ok(c.t0 - crash.t0 >= CFG.CHAT_LOCK_TTL_MS - 5000, 'started before the crashed lease expired');
    for (const p of [P1, P2, P3]) {
      assertSerialized(env, p);
      const texts = aiFor(env, p).map((c) => c.text);
      const sorted = texts.slice().sort();
      assert.deepStrictEqual(texts, sorted, 'order broken for ' + p + ': ' + texts);
      // every message got either an AI turn or an explicit fallback reply (nothing silently lost)
      const handled = texts.length + env.rec.sends.filter((s) => s.to === p && s.node === 'Send Fallback Reply').length;
      assert.ok(handled >= 3, 'messages silently lost for ' + p + ': ' + handled);
      const st = env.cal.lockState(LOCKCAL, chatLock(p));
      assert.ok(!st.h || st.hx <= env.sim.now, 'lock stuck for ' + p);
    }
    assert.deepStrictEqual(env.cal.violations, []);
  }
});

if (require.main === module) runTests('main.concurrency').then((r) => process.exit(r.fail ? 1 : 0));
