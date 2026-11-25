'use strict';
// In-memory Google Calendar v3 events API, modelling the documented semantics
// the engine relies on:
//  - update/delete honour If-Match; a stale etag -> 412 Precondition Failed
//  - GET always returns cancelled (deleted) events; list hides them
//  - custom ids must be base32hex, 5-1024 chars
//  - duplicate ids: 409 by default, or silently undetected ('overwrite') since
//    Google explicitly does not guarantee collision detection
//  - optional events.list read lag (eventual consistency)
//  - latency, 5xx/429, and timeouts where the server may still apply the write
// It also asserts the lock mutual-exclusion invariant on every lock write.
const LOCK_CFG = require('../../engine/config.js');
// Lock events are the calendar mutex and the per-chat locks configured in engine/config.js.
const isLockId = (id) => String(id).indexOf(LOCK_CFG.CAL_LOCK_ID) === 0 || String(id).indexOf(LOCK_CFG.CHAT_LOCK_PREFIX) === 0;
class FakeCalendar {
  constructor(sim, opts) {
    this.sim = sim;
    this.opts = Object.assign({ latency: [15, 90], listLagMs: 0, idCollision: 'detect', fault: null, lockIds: null }, opts || {});
    this.cals = new Map();
    this.etag = 0;
    this.log = [];
    this.violations = [];
    this.lockEvents = [];
  }
  store(cal) { if (!this.cals.has(cal)) this.cals.set(cal, new Map()); return this.cals.get(cal); }
  newEtag() { return '"' + (++this.etag) + '"'; }

  async request(req) {
    const { sim } = this;
    const timeout = req.timeout || 10000;
    const fault = this.opts.fault ? this.opts.fault(req, this) : null;
    const [a, b] = this.opts.latency;
    const d1 = fault && fault.applyDelay != null ? fault.applyDelay : sim.rand(a, b);
    const d2 = sim.rand(a, b);
    const entry = { t: sim.now, method: req.method, url: req.url, fault: fault && fault.kind };
    this.log.push(entry);
    const kind = fault && fault.kind;
    if (kind === 'dropBefore') { await sim.sleep(Math.min(timeout, d1 + d2)); throw transport('socket hang up'); }
    if (kind === '500' || kind === '503' || kind === '429') {
      await sim.sleep(d1 + d2);
      return { statusCode: Number(kind), body: { error: { code: Number(kind), message: 'injected ' + kind } }, headers: {} };
    }
    // server side processing happens at t0 + d1, independently of the client
    const server = (async () => { await sim.sleep(d1); return this.apply(req); })();
    if (kind === 'dropAfter' || d1 + d2 > timeout) {
      server.catch(() => {});
      await sim.sleep(timeout);
      throw transport('ETIMEDOUT');
    }
    const resp = await server;
    await sim.sleep(d2);
    entry.status = resp.statusCode;
    return JSON.parse(JSON.stringify(resp));
  }

  apply(req) {
    const u = new URL(req.url);
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return err(404, 'bad path');
    const cal = decodeURIComponent(m[1]);
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    const st = this.store(cal);
    const now = this.sim.now;
    const ifMatch = header(req.headers, 'if-match');
    if (req.method === 'GET' && !id) return this.list(st, u.searchParams);
    if (req.method === 'GET') { const e = st.get(id); return e ? ok(e.cur) : err(404, 'Not Found'); }
    if (req.method === 'POST' && !id) {
      const body = req.body || {};
      let nid = body.id;
      if (nid != null) {
        if (!/^[0-9a-v]{5,1024}$/.test(nid)) return err(400, 'Invalid resource id value.');
        if (st.has(nid) && this.opts.idCollision === 'detect') return err(409, 'The requested identifier already exists.');
      } else nid = 'auto' + (++this.etag);
      if (!body.start || !body.end) return err(400, 'Missing time');
      const res = Object.assign({}, body, { id: nid, kind: 'calendar#event', etag: this.newEtag(), status: body.status || 'confirmed', created: iso(now), updated: iso(now) });
      this.checkLockWrite(cal, nid, null, res, now);
      this.put(st, nid, res, now);
      return ok(res);
    }
    if (req.method === 'PUT' && id) {
      const e = st.get(id);
      if (!e) return err(404, 'Not Found');
      if (ifMatch && ifMatch !== e.cur.etag) return err(412, 'Precondition Failed');
      const res = Object.assign({}, req.body || {}, { id, kind: 'calendar#event', etag: this.newEtag(), status: (req.body && req.body.status) || 'confirmed', created: e.cur.created, updated: iso(now) });
      this.checkLockWrite(cal, id, e.cur, res, now);
      this.put(st, id, res, now);
      return ok(res);
    }
    if (req.method === 'DELETE' && id) {
      const e = st.get(id);
      if (!e) return err(404, 'Not Found');
      if (e.cur.status === 'cancelled') return err(410, 'Resource has been deleted');
      if (ifMatch && ifMatch !== e.cur.etag) return err(412, 'Precondition Failed');
      const res = Object.assign({}, e.cur, { status: 'cancelled', etag: this.newEtag(), updated: iso(now) });
      this.put(st, id, res, now);
      return { statusCode: 204, body: '', headers: {} };
    }
    return err(400, 'unsupported');
  }
  put(st, id, res, now) {
    const e = st.get(id) || { hist: [] };
    e.cur = JSON.parse(JSON.stringify(res));
    e.hist.push({ t: now, res: e.cur });
    st.set(id, e);
  }
  list(st, q) {
    const tMin = Date.parse(q.get('timeMin')), tMax = Date.parse(q.get('timeMax'));
    const max = Number(q.get('maxResults') || 250);
    const off = Number(q.get('pageToken') || 0);
    const asOf = this.sim.now - this.opts.listLagMs;
    const out = [];
    for (const e of st.values()) {
      let res = null;
      for (const h of e.hist) if (h.t <= asOf) res = h.res;
      if (!res || res.status === 'cancelled' || !res.start) continue;
      const allDay = !res.start.dateTime && res.start.date;
      if (!res.start.dateTime && !allDay) continue;
      // all-day dates are interpreted in the calendar's timezone (UTC+1)
      const s = allDay ? Date.parse(res.start.date + 'T00:00:00+01:00') : Date.parse(res.start.dateTime);
      const en = allDay ? Date.parse(res.end.date + 'T00:00:00+01:00') : Date.parse(res.end.dateTime);
      if (en > tMin && s < tMax) out.push(res);
    }
    const key = (r) => Date.parse(r.start.dateTime || (r.start.date + 'T00:00:00+01:00'));
    out.sort((a, b) => key(a) - key(b));
    const page = out.slice(off, off + max);
    const body = { kind: 'calendar#events', items: page };
    if (off + max < out.length) body.nextPageToken = String(off + max);
    return ok(body);
  }
  // Invariant: a successful write that makes X the holder is only legal if the
  // lock was free, already X's, or the previous holder's lease had expired.
  checkLockWrite(cal, id, prev, next, now) {
    if (!isLockId(id)) return;
    const ps = parse(prev), ns = parse(next);
    if (ns.h && ns.h !== ps.h) {
      if (ps.h && ps.hx > now) this.violations.push({ id, now, prevHolder: ps.h, prevExpiry: ps.hx, newHolder: ns.h });
      this.lockEvents.push({ id, t: now, holder: ns.h, prev: ps.h || null, prevExpired: !!ps.h });
    }
  }
  // helpers for assertions
  events(cal) {
    return [...this.store(cal).values()].map((e) => e.cur).filter((r) => r.status !== 'cancelled' && !isLockId(r.id));
  }
  lockState(cal, id) { const e = this.store(cal).get(id); return e ? parse(e.cur) : null; }
  seed(cal, res) { const r = Object.assign({ status: 'confirmed', etag: this.newEtag() }, res); this.put(this.store(cal), r.id, r, this.sim.now - 3600000); return r; }
}
function parse(ev) { try { return JSON.parse((ev && ev.description) || '{}') || {}; } catch (e) { return {}; } }
function header(h, name) { if (!h) return null; for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k]; return null; }
const ok = (b) => ({ statusCode: 200, body: b, headers: {} });
const err = (c, m) => ({ statusCode: c, body: { error: { code: c, message: m } }, headers: {} });
const iso = (ms) => new Date(ms).toISOString();
function transport(msg) { const e = new Error(msg); e.transport = true; return e; }
module.exports = { FakeCalendar };
