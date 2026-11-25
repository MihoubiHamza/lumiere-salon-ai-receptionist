'use strict';
// Cycle 3 (final hostile audit) regressions.
const assert = require('assert');
const H = require('./lib/harness');
const { test, runTests } = require('./lib/t');

// Execute the exact embedded "Engine: Collect" code with controlled state channels.
async function runCollect(key, { saved, linked, http }) {
  const code = H.wf(key).nodes.find((n) => n.name === 'Engine: Collect').parameters.jsCode;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('$input', '$', '$getWorkflowStaticData', '$execution', code);
  const store = saved ? { 'eng:77': saved } : {};
  const $ = () => ({ get item() { if (!linked) throw new Error('Paired item data unavailable'); return { json: { __engine: linked } }; } });
  return fn({ item: { json: http || { statusCode: 200, body: {} } } }, $, () => store, { id: '77' });
}
const st = (step, tag) => ({ step, phase: 'L.getR', tag });

test('Y1 Collect picks the newest engine state when one channel is stale (never a false hard failure)', async () => {
  for (const key of ['book', 'cancel', 'reschedule', 'main']) {
    const a = await runCollect(key, { saved: { step: 9, state: st(9, 'static') }, linked: { state: st(7, 'linked') } });
    assert.strictEqual(a.json.__engine.state.tag, 'static', key);
    const b = await runCollect(key, { saved: { step: 7, state: st(7, 'static') }, linked: { state: st(9, 'linked') } });
    assert.strictEqual(b.json.__engine.state.tag, 'linked', key);
    const c = await runCollect(key, { saved: null, linked: { state: st(4, 'linked') } });
    assert.strictEqual(c.json.__engine.state.tag, 'linked', key);
    const d = await runCollect(key, { saved: { step: 4, state: st(4, 'static') }, linked: null });
    assert.strictEqual(d.json.__engine.state.tag, 'static', key);
    await assert.rejects(() => runCollect(key, { saved: null, linked: null }), /lost state/, key + ': must fail loudly when no state at all');
  }
});

test('Y2 Collect normalizes transport errors into an ambiguous response (statusCode 0)', async () => {
  const r = await runCollect('book', { saved: { step: 1, state: st(1) }, linked: null, http: { error: { message: 'ETIMEDOUT' } } });
  assert.strictEqual(r.json.__engine.resp.statusCode, 0);
  assert.ok(/ETIMEDOUT/.test(r.json.__engine.resp.error));
});

// A stopped/crashed execution leaves its queue entry behind; without recovery
// every later message from that patient waited CHAT_WAITER_TTL_MS (5 min).
const chatLock = require(require('path').join(H.ROOT, 'engine', 'engine.js')).createEngine(H.CFG)._t.chatLockId;
const aiEnv = (seed) => H.makeEnv({ seed, ai: { behave: () => ({ output: 'مرحبا' }) } });
function seedDeadWaiters(env, chat, n) {
  const ts = Math.floor(env.sim.now / 1000) - 5;
  const w = Array.from({ length: n }, (_, i) => ({ t: 'dead' + i, id: 'wamid.dead' + i, ts, r: env.sim.now - 1000 }));
  env.cal.seed(H.CFG.LOCK_CALENDAR_ID, { id: chatLock(chat), summary: 'lock', description: JSON.stringify({ v: 1, w }), start: { dateTime: '2000-01-01T00:00:00Z' }, end: { dateTime: '2000-01-01T00:01:00Z' } });
}
test('Y3 a dead queue entry (execution stopped while waiting) is skipped in seconds, not after 5 minutes', async () => {
  for (const n of [1, 2]) {
    const env = aiEnv(310 + n);
    seedDeadWaiters(env, '213555000001', n);
    const t0 = env.sim.now;
    await H.runAll(env, [() => H.deliver(env, H.waMessage(env, '213555000001', { text: 'salam' }))]);
    const ai = env.rec.ai.filter((a) => a.chat === '213555000001');
    assert.strictEqual(ai.length, 1, n + ' dead waiter(s): message was never processed');
    assert.ok(ai[0].t0 - t0 < H.CFG.CHAT_DEAD_WAITER_MS * n + 10000, n + ' dead waiter(s): AI started only after ' + (ai[0].t0 - t0) + 'ms');
    const lk = env.cal.lockState(H.CFG.LOCK_CALENDAR_ID, chatLock('213555000001'));
    assert.deepStrictEqual(lk.w || [], [], 'dead waiters must be removed');
    assert.ok(!lk.h, 'lock must be released at the end');
    assert.deepStrictEqual(env.cal.violations, []);
  }
});

test('Y4 live messages queued behind a dead entry are still processed in timestamp order', async () => {
  const env = aiEnv(320);
  seedDeadWaiters(env, '213555000001', 1);
  const a = H.waMessage(env, '213555000001', { text: 'first' });
  const b = H.waMessage(env, '213555000001', { text: 'second', ts: Number(a._ts) + 1 });
  await H.runAll(env, [H.at(env, 0, () => H.deliver(env, a)), H.at(env, 400, () => H.deliver(env, b))]);
  const ai = env.rec.ai.filter((x) => x.chat === '213555000001').sort((x, y) => x.t0 - y.t0);
  assert.deepStrictEqual(ai.map((x) => x.text), ['first', 'second']);
  assert.ok(ai[0].t1 <= ai[1].t0, 'AI turns overlapped');
  assert.deepStrictEqual(env.cal.violations, []);
});

if (require.main === module) runTests('regression.cycle3').then((r) => process.exit(r.fail ? 1 : 0));
