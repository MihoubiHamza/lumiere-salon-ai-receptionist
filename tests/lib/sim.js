'use strict';
// Deterministic discrete-event scheduler with a virtual clock. All waiting in
// tests (HTTP latency, n8n Wait nodes, AI thinking time) goes through sleep(),
// so TTL expiry and race windows can be tested exactly and instantly.
class Sim {
  constructor(startMs, seed) {
    this.now = startMs;
    this.q = [];
    this.seq = 0;
    this.rng = mulberry32(seed == null ? 12345 : seed);
  }
  sleep(ms) {
    return new Promise((resolve) => this.q.push({ t: this.now + Math.max(0, ms || 0), s: this.seq++, resolve }));
  }
  rand(a, b) { return a + (b - a) * this.rng(); }
  async run(untilMs) {
    for (;;) {
      await flush();
      if (!this.q.length) return;
      this.q.sort((a, b) => a.t - b.t || a.s - b.s);
      if (untilMs != null && this.q[0].t > untilMs) return;
      const x = this.q.shift();
      this.now = x.t;
      x.resolve();
    }
  }
}
function flush() { return new Promise((r) => setImmediate(r)); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
module.exports = { Sim, mulberry32 };
