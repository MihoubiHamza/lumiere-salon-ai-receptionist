// Lumière Hair & Beauty Studio booking + concurrency engine.
// SOURCE OF TRUTH. tools/build-workflows.js copies this function verbatim
// into every "Engine: Decide" node, so it must stay self-contained (no
// require, no globals besides Date/Math/JSON).
//
// The engine is a resumable state machine. n8n drives it in a loop:
//   Decide -> (http | sleep | done) -> Calendar API / Wait -> Decide ...
// Every call to step() returns the next action; all state is plain JSON.
function createEngine(CFG, CONF) {
  'use strict';
  // CONF = createConfirm() (engine/confirm.js). Without it no confirmed change can run (fail closed).
  const OFF = CFG.TZ_OFFSET_MIN * 60000;
  const API = 'https://www.googleapis.com/calendar/v3/calendars/';
  const B32 = '0123456789abcdefghijklmnopqrstuv';
  const DAY = 86400000;

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const OFFSTR = (CFG.TZ_OFFSET_MIN >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(CFG.TZ_OFFSET_MIN) / 60)) + ':' + pad(Math.abs(CFG.TZ_OFFSET_MIN) % 60);
  const toMin = (t) => { const p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); };
  const WORK_START_MIN = toMin(CFG.WORK_START);
  const WORK_END_MIN = toMin(CFG.WORK_END);

  // ---------------------------------------------------------------- time
  function lp(ms) {
    const d = new Date(ms + OFF);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() };
  }
  const ymd = (ms) => { const p = lp(ms); return p.y + '-' + pad(p.mo) + '-' + pad(p.d); };
  const hm = (ms) => { const p = lp(ms); return pad(p.h) + ':' + pad(p.mi); };
  const fmtLocal = (ms) => ymd(ms) + ' ' + hm(ms);
  const isoLocal = (ms) => ymd(ms) + 'T' + hm(ms) + ':' + pad(lp(ms).s) + OFFSTR;
  const localMs = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0) - OFF;
  const dayStart = (ms) => { const p = lp(ms); return localMs(p.y, p.mo, p.d); };

  function parseYmd(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const c = new Date(Date.UTC(y, mo - 1, d));
    if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) return null;
    return { y, mo, d, text: m[1] + '-' + m[2] + '-' + m[3] };
  }
  function parseHm(v) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(v == null ? '' : v).trim());
    return m ? { h: +m[1], mi: +m[2], text: pad(+m[1]) + ':' + m[2] } : null;
  }
  // Local wall-clock 'YYYY-MM-DDTHH:mm[:ss]' (salon timezone). An explicit
  // offset/Z is honoured if the caller supplies one anyway.
  function parseDateTime(v) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(String(v == null ? '' : v).trim());
    if (!m) return NaN;
    const dt = parseYmd(m[1]); const t = parseHm(m[2]);
    const sec = m[3] ? +m[3] : 0;
    if (!dt || !t || sec > 59) return NaN;
    if (m[4]) {
      let off = 0;
      if (m[4].toUpperCase() !== 'Z') { const o = /^([+-])(\d{2}):?(\d{2})$/.exec(m[4]); off = (o[1] === '-' ? -1 : 1) * (+o[2] * 60 + +o[3]); }
      return Date.UTC(dt.y, dt.mo - 1, dt.d, t.h, t.mi, sec) - off * 60000;
    }
    return localMs(dt.y, dt.mo, dt.d, t.h, t.mi, sec);
  }

  // ---------------------------------------------------------------- misc
  const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  // Canonical international form. A national number written with a leading 0
  // (10 digits) is read with the default country code 213 inherited from the
  // original deployment (WhatsApp and Messenger ids are already international).
  // Numbers that differ only in one digit are different people, so identity
  // always compares the WHOLE number.
  function normPhone(v) {
    let d = digits(v);
    if (d.indexOf('00') === 0) d = d.slice(2);
    if (d.length === 10 && d[0] === '0') d = '213' + d.slice(1);
    else if (d.length === 9 && /^[567]/.test(d)) d = '213' + d;
    return d;
  }
  const tail9 = (d) => (d.length >= 9 ? d.slice(-9) : d);
  const normName = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  const cleanSummary = (s) => String(s == null ? '' : s).replace(/^=+/, '').trim();
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  // 64-bit non-reversible key: lock objects never store raw phone numbers.
  const kHash = (s) => fnv(s) + fnv('lumiere|' + s);
  const chatLockIdFor = (chatId) => CFG.CHAT_LOCK_PREFIX + kHash('chat:' + normPhone(chatId));
  function randId(rnd, prefix, n) {
    let s = prefix || '';
    for (let i = 0; i < (n || 24); i++) s += B32[Math.floor(rnd() * 32) % 32];
    return s;
  }
  const backoff = (a, rnd) => Math.round(Math.min(CFG.BACKOFF_CAP_MS, CFG.BACKOFF_BASE_MS * Math.pow(2, a)) * (0.7 + 0.6 * rnd()));
  const pollDelay = (n, rnd) => Math.round(Math.min(CFG.POLL_MAX_MS, CFG.POLL_MIN_MS * Math.pow(1.35, n)) * (0.75 + 0.5 * rnd()));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------------------------------------------------------------- http
  // ok | notfound | gone | conflict | precondition | ratelimit (never applied)
  // | ambiguous (5xx / transport: the write MAY have been applied) | error
  function cls(r) {
    if (!r || typeof r.statusCode !== 'number' || r.statusCode === 0) return 'ambiguous';
    const c = r.statusCode;
    if (c >= 200 && c < 300) return 'ok';
    if (c === 404) return 'notfound';
    if (c === 410) return 'gone';
    if (c === 409) return 'conflict';
    if (c === 412) return 'precondition';
    if (c === 429) return 'ratelimit';
    if (c === 403) {
      const t = JSON.stringify(r.body || '').toLowerCase();
      if (t.indexOf('ratelimit') >= 0 || t.indexOf('rate limit') >= 0 || t.indexOf('quota') >= 0) return 'ratelimit';
    }
    if (c >= 500) return 'ambiguous';
    return 'error';
  }
  function body(r) {
    if (!r) return {};
    if (r.body && typeof r.body === 'object') return r.body;
    if (typeof r.body === 'string' && r.body) { try { return JSON.parse(r.body); } catch (e) { return {}; } }
    return {};
  }
  const retryable = (c) => c === 'ambiguous' || c === 'ratelimit';
  const calUrl = (cal) => API + encodeURIComponent(cal) + '/events';
  const evUrl = (cal, id) => calUrl(cal) + '/' + encodeURIComponent(id);
  function listUrl(tMin, tMax, pageToken) {
    const q = [
      'timeMin=' + encodeURIComponent(new Date(tMin).toISOString()),
      'timeMax=' + encodeURIComponent(new Date(tMax).toISOString()),
      'singleEvents=true', 'orderBy=startTime', 'maxResults=250',
      'timeZone=' + encodeURIComponent(CFG.TIMEZONE),
    ];
    if (pageToken) q.push('pageToken=' + encodeURIComponent(pageToken));
    return calUrl(CFG.CALENDAR_ID) + '?' + q.join('&');
  }

  // ---------------------------------------------------------------- events
  const evStart = (ev) => (ev && ev.start && ev.start.dateTime ? Date.parse(ev.start.dateTime) : NaN);
  function evEnd(ev) { const s = evStart(ev); return ev && ev.end && ev.end.dateTime ? Date.parse(ev.end.dateTime) : s + CFG.APPT_DEFAULT_MIN * 60000; }
  function rawTime(ev) { const dt = (ev && ev.start && ev.start.dateTime) || ''; return dt.indexOf('T') >= 0 ? dt.split('T')[1].slice(0, 5) : ''; }
  // Trust ONLY the structured "Phone: <digits>" field (written by the bot) and
  // compare the full normalized number. Events without that field (created by
  // staff by hand) fall back to finding the 9-digit national number in the text.
  function phoneMatches(ev, idn) {
    if (!ev || !idn || !idn.phone) return false;
    const m = /Phone:\s*\+?(\d+)/i.exec(ev.description || '');
    if (m) return normPhone(m[1]) === idn.phone;
    const blob = digits((ev.description || '') + ' ' + (ev.summary || ''));
    return idn.tail.length >= 9 && blob.indexOf(idn.tail) >= 0;
  }
  const overlaps = (s1, e1, s2, e2) => s1 < e2 && e1 > s2;
  function slim(ev) {
    return { id: ev.id, etag: ev.etag, status: ev.status, summary: ev.summary, description: ev.description, start: ev.start, end: ev.end, transparency: ev.transparency };
  }
  const isTimed = (ev) => ev && ev.status !== 'cancelled' && Number.isFinite(evStart(ev));

  // An all-day event that is not marked "Free" (e.g. "Salon closed") blocks the whole day(s).
  function allDayBlock(ev) {
    if (!ev || ev.status === 'cancelled' || !ev.start || ev.start.dateTime || !ev.start.date || ev.transparency === 'transparent') return null;
    const a = parseYmd(ev.start.date), b = parseYmd(ev.end && ev.end.date);
    if (!a) return null;
    const s = localMs(a.y, a.mo, a.d);
    return { id: ev.id, s, e: b ? localMs(b.y, b.mo, b.d) : s + DAY, allDay: true };
  }
  const latestJournal = (journal) => { const l = {}; for (const x of (journal || []).slice().sort((a, b) => a.at - b.at)) l[x.i] = x; return l; };
  // Conservative busy view: every listed event PLUS every interval the bot
  // itself wrote recently (journal). Protects against events.list read lag.
  function busyView(items, journal) {
    const out = [];
    for (const ev of items || []) {
      if (isTimed(ev)) out.push({ id: ev.id, s: evStart(ev), e: evEnd(ev) });
      else { const b = allDayBlock(ev); if (b) out.push(b); }
    }
    const latest = latestJournal(journal);
    for (const id of Object.keys(latest)) { const x = latest[id]; if (x.o === 'c' || x.o === 'u') out.push({ id: x.i, s: x.s, e: x.e, j: true }); }
    return out;
  }
  // Matching view: listed events with the bot's own recent writes applied on top,
  // plus journal-only appointments the lagging list does not show yet (matched by
  // identity key). Every candidate is re-validated with a strong GET before any write.
  function matchView(items, journal) {
    const latest = latestJournal(journal);
    const out = [];
    const listed = {};
    for (const ev of items || []) {
      if (!isTimed(ev)) continue;
      listed[ev.id] = true;
      let s = evStart(ev), e = evEnd(ev);
      const x = latest[ev.id];
      if (x) { if (x.o === 'd') continue; s = x.s; e = x.e; }
      out.push({ id: ev.id, s, e, ev });
    }
    for (const id of Object.keys(latest)) {
      const x = latest[id];
      if (!listed[id] && (x.o === 'c' || x.o === 'u') && Number.isFinite(x.s)) out.push({ id, s: x.s, e: x.e, ev: null, k: x.k });
    }
    return out;
  }
  const idMatch = (m, idn) => (m.ev ? phoneMatches(m.ev, idn) : !!m.k && m.k === idn.k);
  const timeOk = (m, t) => !t || hm(m.s) === t || (!!m.ev && m.s === evStart(m.ev) && rawTime(m.ev) === t);
  const labelOf = (m) => (m.ev ? cleanSummary(m.ev.summary) : 'appointment');

  // ---------------------------------------------------------------- identity
  const idnOf = (phone, via, nameGiven) => ({ phone, tail: tail9(phone), k: kHash('p:' + phone), via, nameGiven });
  function identity(c) {
    const chat = normPhone(c.phone_number);
    const bookedRaw = String(c.booked_phone_number == null ? '' : c.booked_phone_number).trim();
    const name = String(c.patient_name == null ? '' : c.patient_name).trim();
    if (bookedRaw) {
      const b = normPhone(bookedRaw);
      if (b.length < 11 || b.length > 15) {
        return { error: R('INVALID_INPUT', 'INVALID_INPUT: booked_phone_number does not look like a valid phone number. Ask the customer to resend the exact number the appointment was booked with, including the country code.') };
      }
      return idnOf(b, 'booked', name.length >= 3);
    }
    if (chat.length >= 9) return idnOf(chat, 'chat', name.length >= 3);
    return { error: R('NOT_FOUND', 'NOT_FOUND: No usable phone number to identify the customer - nothing was changed.') };
  }
  const NEED_BOOKED_PHONE = 'NEED_BOOKED_PHONE: No appointment is registered under the current WhatsApp number for that date/time, and a customer name alone can never be used to find or change an appointment (privacy protection). If the customer says it was booked from a different phone number, ask for that exact number and call this tool again with booked_phone_number filled in. If they do not know it, call Escalate_to_Staff.';

  // ---------------------------------------------------------------- results
  function R(status, message, extra) { return Object.assign({ status, message }, extra || {}); }
  const VERB = { book: 'booked', reschedule: 'changed', cancel: 'cancelled' };
  function resBusy(s) {
    const tool = s.op === 'book' ? 'Book_Appointment' : s.op === 'reschedule' ? 'Reschedule_Appointment' : 'Cancel_Appointment';
    return R('BUSY_RETRY', 'BUSY_RETRY: The appointment system was busy with another request, so NOTHING was ' + VERB[s.op] + '. Call ' + tool + ' again once with the same details. If it returns BUSY_RETRY again, apologize to the customer and call Escalate_to_Staff.');
  }
  function resError(s, where) {
    return R('ERROR', 'ERROR: The calendar could not be read or updated (' + where + '), so NOTHING was ' + VERB[s.op] + '. Never tell the customer it succeeded. Apologize briefly and call Escalate_to_Staff.');
  }
  function resUnknown(s, where) {
    return R('ERROR_NEEDS_STAFF', 'ERROR_NEEDS_STAFF: The calendar gave an unclear result (' + where + ') and the appointment state could not be confirmed. Do NOT tell the customer it succeeded or failed. Tell them a team member will confirm, and call Escalate_to_Staff mentioning this.');
  }
  function slotRule(ms, now, verb) {
    const p = lp(ms); const date = ymd(ms), time = hm(ms);
    if (p.wd === CFG.CLOSED_WEEKDAY) return R('CLOSED_DAY', 'CLOSED_DAY: ' + date + ' falls on the salon\'s weekly closing day. Nothing was ' + verb + '. Tell the customer the salon is closed that day and ask for a different day.');
    const m = p.h * 60 + p.mi;
    if (m < WORK_START_MIN || m >= WORK_END_MIN) return R('OUTSIDE_HOURS', 'OUTSIDE_HOURS: ' + time + ' on ' + date + ' is outside salon opening hours (' + CFG.WORK_START + '-' + CFG.WORK_END + '). Nothing was ' + verb + '. Ask the customer for a time within opening hours.');
    if (ms <= now) return R('PAST_TIME', 'PAST_TIME: ' + date + ' ' + time + ' is already in the past. Nothing was ' + verb + '. Ask the customer for a future date and time.');
    return null;
  }
  // Salon services have different lengths: the WHOLE appointment must end by closing time.
  function endRule(st, en, verb) {
    if (en <= dayStart(st) + WORK_END_MIN * 60000) return null;
    return R('OUTSIDE_HOURS', 'OUTSIDE_HOURS: an appointment of ' + Math.round((en - st) / 60000) + ' minutes starting at ' + hm(st) + ' on ' + ymd(st) + ' would end at ' + hm(en) + ', after the salon closes (' + CFG.WORK_END + '). Nothing was ' + verb + '. Offer an earlier start time so the service ends by ' + CFG.WORK_END + '.');
  }

  // ---------------------------------------------------------------- actions
  function act(s, phase, a) { s.phase = phase; s.step++; return a; }
  const HTTP = (s, phase, req) => act(s, phase, { type: 'http', req });
  const SLEEP = (s, phase, ms) => act(s, phase, { type: 'sleep', ms: Math.max(CFG.MIN_SLEEP_MS, Math.round(ms)) });
  function DONE(s, result) { s.phase = 'done'; s.step++; s.result = result; return { type: 'done', result: Object.assign({ op: s.op }, result) }; }
  const GOTO = (s, phase) => { s.phase = phase; return null; };
  function retryOr(s, key, phase, now, rnd) {
    const n = (s.rt[key] = (s.rt[key] || 0) + 1);
    if (n > CFG.HTTP_MAX_RETRIES || now > s.deadline) return null;
    return SLEEP(s, phase, backoff(n - 1, rnd));
  }
  const H = {};

  // ================================================================ lock objects
  function lockBody(id, label, st) {
    return {
      id, status: 'confirmed',
      summary: '[SYSTEM LOCK - ' + label + '] do not edit or delete',
      description: JSON.stringify(st),
      start: { dateTime: '2000-01-01T00:00:00Z' }, end: { dateTime: '2000-01-01T00:01:00Z' },
      transparency: 'transparent', visibility: 'private', reminders: { useDefault: false },
    };
  }
  function parseLock(ev) {
    let st = null;
    try { st = JSON.parse((ev && ev.description) || '{}'); } catch (e) { st = null; }
    if (!st || typeof st !== 'object' || st.v !== 1) st = { v: 1 };
    return st;
  }
  const pruneJournal = (j, now) => (j || []).filter((x) => x && x.at >= now - CFG.JOURNAL_KEEP_MS).slice(-CFG.JOURNAL_MAX);
  function capState(st) {
    let str = JSON.stringify(st);
    while (str.length > CFG.LOCK_STATE_MAX_CHARS && ((st.j && st.j.length) || (st.p && st.p.length > 10))) {
      if (st.j && st.j.length) st.j.shift(); else st.p.shift();
      str = JSON.stringify(st);
    }
    return st;
  }
  const lockReq = (method, id, extra) => Object.assign({ method, url: evUrl(CFG.LOCK_CALENDAR_ID, id) }, extra || {});

  // ================================================================ calendar mutex
  function lockStart(s, after, now) {
    s.L = { id: CFG.CAL_LOCK_ID, label: 'calendar write mutex', after, since: now, polls: 0, boots: 0 };
    return GOTO(s, 'L.get');
  }
  function lockFail(s, busy) { return finish(s, busy ? resBusy(s) : resError(s, 'lock')); }
  const leaseOk = (s, now) => !!(s.L && s.L.held && s.L.held.hx - now >= CFG.LEASE_MARGIN_MS);

  H['L.get'] = (s) => HTTP(s, 'L.getR', lockReq('GET', s.L.id));
  H['L.getR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      s.rt.L = 0;
      const ev = body(r); const st = parseLock(ev);
      if (st.h === s.token) { s.L.held = { etag: ev.etag, st, hx: st.hx }; return GOTO(s, s.L.after); }
      if (!st.h || !(st.hx > now)) {
        const nst = Object.assign({}, st, { v: 1, h: s.token, ha: now, hx: now + CFG.CAL_LOCK_TTL_MS, j: pruneJournal(st.j, now) });
        s.L.pending = nst;
        s.L.recovered = !!st.h;
        return HTTP(s, 'L.putR', lockReq('PUT', s.L.id, { headers: { 'If-Match': ev.etag }, body: lockBody(s.L.id, s.L.label, capState(nst)) }));
      }
      if (now - s.L.since > CFG.CAL_LOCK_MAX_WAIT_MS) return lockFail(s, true);
      return SLEEP(s, 'L.get', pollDelay(s.L.polls++, rnd));
    }
    if (c === 'notfound') {
      if (s.L.boots++ >= 3) return lockFail(s, false);
      return HTTP(s, 'L.bootR', { method: 'POST', url: calUrl(CFG.LOCK_CALENDAR_ID), body: lockBody(s.L.id, s.L.label, { v: 1 }) });
    }
    if (retryable(c)) return retryOr(s, 'L', 'L.get', now, rnd) || lockFail(s, false);
    return lockFail(s, false);
  };
  // Bootstrap is only ever a create-in-FREE-state, so a racing (even an
  // undetected-collision) double insert is harmless: acquisition is always CAS.
  H['L.bootR'] = (s, r, now, rnd) => (retryable(cls(r)) ? SLEEP(s, 'L.get', backoff(0, rnd)) : GOTO(s, 'L.get'));
  H['L.putR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') { s.L.held = { etag: body(r).etag, st: s.L.pending, hx: s.L.pending.hx }; s.L.pending = null; return GOTO(s, s.L.after); }
    if (c === 'precondition') return SLEEP(s, 'L.get', 60 + rnd() * 240);
    // ambiguous: re-read; if the write landed we will see ourselves as holder
    if (retryable(c)) return retryOr(s, 'L', 'L.get', now, rnd) || lockFail(s, false);
    return lockFail(s, false);
  };

  function finish(s, result) {
    s.final = result;
    if (s.L && s.L.held && !s.L.released) return GOTO(s, 'R.put');
    return DONE(s, result);
  }
  function releasedState(st, s, now) {
    return capState(Object.assign({}, st, { v: 1, h: null, ha: null, hx: null, j: pruneJournal((st.j || []).concat(s.jadd || []), now) }));
  }
  H['R.put'] = (s, r, now) => HTTP(s, 'R.putR', lockReq('PUT', s.L.id, { headers: { 'If-Match': s.L.held.etag }, body: lockBody(s.L.id, s.L.label, releasedState(s.L.held.st, s, now)) }));
  H['R.putR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') { s.L.released = true; return DONE(s, s.final); }
    s.L.rel = (s.L.rel || 0) + 1;
    if (s.L.rel > 6) { s.L.released = 'abandoned'; return DONE(s, s.final); } // lease TTL frees it
    if (c === 'precondition') return GOTO(s, 'R.get');
    if (retryable(c)) return SLEEP(s, 'R.get', backoff(s.L.rel - 1, rnd));
    s.L.released = 'abandoned';
    return DONE(s, s.final);
  };
  H['R.get'] = (s) => HTTP(s, 'R.getR', lockReq('GET', s.L.id));
  H['R.getR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      const ev = body(r); const st = parseLock(ev);
      if (st.h !== s.token) { s.L.released = 'lost'; return DONE(s, s.final); }
      s.L.held.etag = ev.etag; s.L.held.st = st;
      return GOTO(s, 'R.put');
    }
    s.L.rel = (s.L.rel || 0) + 1;
    if (retryable(c) && s.L.rel <= 6) return SLEEP(s, 'R.get', backoff(s.L.rel - 1, rnd));
    s.L.released = 'abandoned';
    return DONE(s, s.final);
  };

  // ================================================================ list helper
  function listStart(s, key, tMin, tMax, after, onFail) {
    s.LS = { key, tMin, tMax, token: null, items: [], after, onFail: onFail || null };
    return GOTO(s, 'LS.req');
  }
  H['LS.req'] = (s) => HTTP(s, 'LS.resp', { method: 'GET', url: listUrl(s.LS.tMin, s.LS.tMax, s.LS.token) });
  H['LS.resp'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      s.rt.LS = 0;
      const b = body(r);
      for (const ev of b.items || []) s.LS.items.push(slim(ev));
      if (b.nextPageToken && s.LS.items.length < 2500) { s.LS.token = b.nextPageToken; return GOTO(s, 'LS.req'); }
      s.lists[s.LS.key] = s.LS.items;
      const after = s.LS.after; s.LS = null;
      return GOTO(s, after);
    }
    if (retryable(c)) { const a = retryOr(s, 'LS', 'LS.req', now, rnd); if (a) return a; }
    if (s.LS.onFail) { const f = s.LS.onFail; s.LS = null; return GOTO(s, f); }
    return finish(s, resError(s, 'list'));
  };

  // ================================================================ BOOK
  H['B.start'] = (s, r, now) => {
    const c = s.ctx;
    const st = parseDateTime(c.start_datetime), en = parseDateTime(c.end_datetime);
    if (!Number.isFinite(st) || !Number.isFinite(en) || en <= st) {
      return DONE(s, R('INVALID_INPUT', 'INVALID_INPUT: The appointment start and/or end time is missing or invalid. Ask the customer to confirm the exact date and time, then call this tool again.'));
    }
    if (en - st > CFG.APPT_MAX_MIN * 60000) return DONE(s, R('INVALID_INPUT', 'INVALID_INPUT: The appointment is longer than ' + CFG.APPT_MAX_MIN + ' minutes, which is not allowed. Use the service duration from the salon information.'));
    const summary = cleanSummary(c.summary);
    const phone = normPhone(c.phone_number);
    if (!summary) return DONE(s, R('INVALID_INPUT', 'INVALID_INPUT: The appointment title (customer name + service) is missing. Collect it and call this tool again.'));
    if (phone.length < 9) return DONE(s, R('INVALID_INPUT', 'INVALID_INPUT: No valid contact phone number for this booking - nothing was booked.'));
    const rule = slotRule(st, now, 'booked') || endRule(st, en, 'booked');
    if (rule) return DONE(s, rule);
    const idn = idnOf(phone, 'chat', false);
    s.b = { s: st, e: en, summary, phone, notes: String(c.notes == null ? '' : c.notes), idn, k: idn.k, sh: fnv(normName(summary)), ins: 0, chk: 0, rb: 0, gone: [] };
    return lockStart(s, 'B.list', now);
  };
  H['B.list'] = (s) => { const a = dayStart(s.b.s); return listStart(s, 'day', a, a + DAY, 'B.decide'); };
  H['B.decide'] = (s) => {
    const b = s.b; const j = s.L.held.st.j || [];
    const latest = latestJournal(j);
    const same = (ev) => evStart(ev) === b.s && evEnd(ev) === b.e && phoneMatches(ev, b.idn) && fnv(normName(cleanSummary(ev.summary))) === b.sh;
    const dupL = (s.lists.day || []).find((ev) => isTimed(ev) && same(ev) && b.gone.indexOf(ev.id) < 0 && !(latest[ev.id] && latest[ev.id].o === 'd'));
    const dupJ = Object.keys(latest).map((k) => latest[k]).find((x) => x.o === 'c' && x.s === b.s && x.e === b.e && x.k === b.k && x.sh === b.sh && b.gone.indexOf(x.i) < 0);
    const dup = dupL ? dupL.id : dupJ ? dupJ.i : null;
    // Claim "already booked" only after a strong read proves it still exists.
    if (dup) { b.dup = dup; return GOTO(s, 'B.dup'); }
    return GOTO(s, 'B.cf');
  };
  H['B.dup'] = (s) => HTTP(s, 'B.dupR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.b.dup) });
  H['B.dupR'] = (s, r, now, rnd) => {
    const c = cls(r); const b = s.b;
    if (c === 'ok') {
      const ev = body(r);
      if (ev.status !== 'cancelled' && evStart(ev) === b.s && evEnd(ev) === b.e && phoneMatches(ev, b.idn)) {
        return finish(s, R('SUCCESS', 'SUCCESS: "' + b.summary + '" is already booked on ' + fmtLocal(b.s) + ' (duplicate request - no second appointment was created).', { idempotent: true }));
      }
      b.gone.push(b.dup); return GOTO(s, 'B.decide');
    }
    if (c === 'notfound' || c === 'gone') { b.gone.push(b.dup); return GOTO(s, 'B.decide'); }
    if (retryable(c)) return retryOr(s, 'BD', 'B.dup', now, rnd) || finish(s, resError(s, 'read'));
    return finish(s, resError(s, 'read'));
  };
  H['B.cf'] = (s, r, now, rnd) => {
    const b = s.b;
    const hit = busyView(s.lists.day, s.L.held.st.j).filter((x) => b.gone.indexOf(x.id) < 0).find((x) => overlaps(b.s, b.e, x.s, x.e));
    if (hit && hit.allDay) return finish(s, R('CLOSED_DAY', 'CLOSED_DAY: ' + ymd(b.s) + ' is marked as unavailable on the salon calendar (for example a holiday or the salon is closed). Nothing was booked. Tell the customer this day is not available and ask for a different day.'));
    if (hit) return finish(s, R('CONFLICT', 'CONFLICT: That time is already booked (another appointment at ' + hm(hit.s) + '). This can happen when booking two people back-to-back in the same conversation, or when a long service overlaps the next appointment. Tell the customer the real conflicting time and ask them to choose a different time for this appointment - never silently pick a different time yourself - then call Book_Appointment again with their new choice.'));
    if (!leaseOk(s, now)) return finish(s, resBusy(s));
    b.id = randId(rnd, 'nb', 24);
    return GOTO(s, 'B.ins');
  };
  function bookBody(b) {
    return {
      id: b.id, summary: b.summary,
      description: 'Phone: ' + b.phone + '. Notes: ' + b.notes,
      start: { dateTime: isoLocal(b.s), timeZone: CFG.TIMEZONE },
      end: { dateTime: isoLocal(b.e), timeZone: CFG.TIMEZONE },
    };
  }
  H['B.ins'] = (s) => { s.b.ins++; return HTTP(s, 'B.insR', { method: 'POST', url: calUrl(CFG.CALENDAR_ID), body: bookBody(s.b) }); };
  H['B.insR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') return GOTO(s, 'B.v0');
    if (c === 'conflict') { // id collision (astronomically unlikely with 120-bit random ids)
      if (s.b.ins >= 3 || !leaseOk(s, now)) return finish(s, resError(s, 'insert'));
      s.b.id = randId(rnd, 'nb', 24);
      return GOTO(s, 'B.ins');
    }
    if (c === 'ratelimit') { // rejected before processing: safe to resend
      if (s.b.ins >= 4 || !leaseOk(s, now)) return finish(s, resBusy(s));
      return SLEEP(s, 'B.ins', backoff(s.b.ins - 1, rnd));
    }
    // POST is not idempotent: never blindly resend after an unclear outcome.
    if (c === 'ambiguous') return SLEEP(s, 'B.chk', 1000);
    return finish(s, resError(s, 'insert'));
  };
  H['B.chk'] = (s) => { s.b.chk++; return HTTP(s, 'B.chkR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.b.id) }); };
  H['B.chkR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      if (body(r).status !== 'cancelled') return GOTO(s, 'B.v0');
      return finish(s, resError(s, 'insert'));
    }
    if (c === 'notfound' && s.b.chk < 3) return SLEEP(s, 'B.chk', 1000 * Math.pow(2, s.b.chk));
    if (c === 'notfound') return finish(s, R('ERROR', 'ERROR: The calendar did not confirm the booking, so treat it as NOT booked. Never tell the customer it succeeded. Call Book_Appointment again once with the same details (a duplicate is detected automatically); if that fails too, apologize and call Escalate_to_Staff.'));
    if (retryable(c) && s.b.chk < 5) return SLEEP(s, 'B.chk', backoff(s.b.chk, rnd));
    return finish(s, resUnknown(s, 'booking confirmation'));
  };
  H['B.v0'] = (s) => listStart(s, 'verify', s.b.s, s.b.e, 'B.verify', 'B.ok');
  H['B.verify'] = (s) => {
    const others = (s.lists.verify || []).filter((ev) => ev.id !== s.b.id && isTimed(ev) && overlaps(s.b.s, s.b.e, evStart(ev), evEnd(ev)));
    return GOTO(s, others.length ? 'B.rb' : 'B.ok');
  };
  H['B.ok'] = (s, r, now) => {
    s.jadd = [{ o: 'c', i: s.b.id, s: s.b.s, e: s.b.e, k: s.b.k, sh: s.b.sh, at: now }];
    return finish(s, R('SUCCESS', 'SUCCESS: Booked "' + s.b.summary + '" on ' + fmtLocal(s.b.s) + '.', { eventId: s.b.id }));
  };
  // Defense in depth: something outside the mutex (a manual staff edit) took
  // the slot concurrently. Undo our own insert rather than double-book.
  H['B.rb'] = (s) => { s.b.rb++; return HTTP(s, 'B.rbR', { method: 'DELETE', url: evUrl(CFG.CALENDAR_ID, s.b.id) }); };
  H['B.rbR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok' || c === 'gone' || c === 'notfound') return finish(s, R('CONFLICT', 'CONFLICT: That exact time was taken by another booking at the same moment - the appointment was NOT created. Tell the customer plainly that slot just got taken and ask them to choose a different time, then call Book_Appointment again with their new choice.'));
    if (s.b.rb < 4) return SLEEP(s, 'B.rb', backoff(s.b.rb, rnd));
    return finish(s, resUnknown(s, 'double-booking rollback'));
  };

  // ================================================================ RESCHEDULE
  const RS_NOT_FOUND = 'NOT_FOUND: No appointment found matching that phone number and old date/time - cannot reschedule.';
  H['S.start'] = (s, r, now) => {
    const c = s.ctx;
    const od = parseYmd(c.old_appointment_date);
    const otRaw = String(c.old_appointment_time == null ? '' : c.old_appointment_time).trim();
    const ot = otRaw ? parseHm(otRaw) : null;
    if (!od || (otRaw && !ot)) return DONE(s, R('INVALID_INPUT', 'INVALID_INPUT: The CURRENT appointment date/time is missing or invalid (date YYYY-MM-DD, time HH:mm). Call Find_Patient_Appointments to get the exact current appointment, then call this tool again.'));
    const nd = parseYmd(c.new_appointment_date), nt = parseHm(c.new_appointment_time);
    if (!nd || !nt) return DONE(s, R('INVALID_INPUT', 'INVALID_INPUT: The new appointment date and/or time is missing or invalid. Ask the customer to state both an exact new date and an exact new time, then call this tool again.'));
    const idn = identity(c);
    if (idn.error) return DONE(s, idn.error);
    const newS = localMs(nd.y, nd.mo, nd.d, nt.h, nt.mi);
    const rule = slotRule(newS, now, 'changed');
    if (rule) return DONE(s, rule);
    s.x = { odate: od.text, ot: ot ? ot.text : '', newS, idn, newSummary: cleanSummary(c.new_summary), newDesc: String(c.new_description == null ? '' : c.new_description).trim(), phone: digits(c.phone_number), relist: 0, put: 0, rb: 0 };
    return lockStart(s, 'S.list', now);
  };
  H['S.list'] = (s) => { const d = parseYmd(s.x.odate); const a = localMs(d.y, d.mo, d.d); return listStart(s, 'old', a, a + DAY, 'S.list2'); };
  H['S.list2'] = (s) => { const a = dayStart(s.x.newS); return listStart(s, 'new', a, a + DAY, 'S.decide'); };
  H['S.decide'] = (s) => {
    const x = s.x; const j = s.L.held.st.j || [];
    const cands = matchView(s.lists.old, j).filter((m) => ymd(m.s) === x.odate && timeOk(m, x.ot) && idMatch(m, x.idn));
    if (cands.length === 0) {
      const done = j.find((e) => e.o === 'u' && e.k === x.idn.k && e.s === x.newS && ymd(e.os) === x.odate && (!x.ot || hm(e.os) === x.ot));
      if (done) { x.dup = done.i; return GOTO(s, 'S.dup'); }
      return GOTO(s, 'S.none');
    }
    if (cands.length > 1) {
      return finish(s, R('AMBIGUOUS', 'AMBIGUOUS: Multiple appointments found - ask the customer to confirm the exact original date/time before rescheduling: ' + cands.map((m, i) => (i + 1) + ') ' + labelOf(m) + ' at ' + fmtLocal(m.s)).join('; ')));
    }
    x.id = cands[0].id;
    return GOTO(s, 'S.fresh');
  };
  H['S.none'] = (s) => finish(s, s.x.idn.via === 'chat' && s.x.idn.nameGiven ? R('NEED_BOOKED_PHONE', NEED_BOOKED_PHONE) : R('NOT_FOUND', RS_NOT_FOUND));
  // Duplicate of a reschedule we already did: confirm with a strong read first.
  H['S.dup'] = (s) => HTTP(s, 'S.dupR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.x.dup) });
  H['S.dupR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      const ev = body(r);
      if (ev.status !== 'cancelled' && evStart(ev) === s.x.newS && phoneMatches(ev, s.x.idn)) return finish(s, R('SUCCESS', 'SUCCESS: The appointment is already rescheduled to ' + fmtLocal(s.x.newS) + ' (duplicate request - nothing else was changed).', { idempotent: true }));
      return GOTO(s, 'S.none');
    }
    if (c === 'notfound' || c === 'gone') return GOTO(s, 'S.none');
    if (retryable(c)) return retryOr(s, 'SD', 'S.dup', now, rnd) || finish(s, resError(s, 'read'));
    return finish(s, resError(s, 'read'));
  };
  // Strong single-resource read: fresh etag + real current times (lists can lag).
  H['S.fresh'] = (s) => HTTP(s, 'S.freshR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.x.id) });
  H['S.freshR'] = (s, r, now, rnd) => {
    const c = cls(r); const x = s.x;
    if (c === 'ok') {
      const ev = body(r);
      if (ev.status === 'cancelled') return finish(s, R('NOT_FOUND', RS_NOT_FOUND));
      const st = evStart(ev);
      const still = Number.isFinite(st) && ymd(st) === x.odate && timeOk({ s: st, ev }, x.ot) && phoneMatches(ev, x.idn);
      if (!still) { if (x.relist++ < 2) return GOTO(s, 'S.list'); return finish(s, R('NOT_FOUND', RS_NOT_FOUND)); }
      x.full = ev;
      if (!x.orig) x.orig = { summary: ev.summary, description: ev.description, start: ev.start, end: ev.end, s: st, e: evEnd(ev) };
      const dur = x.orig.e - x.orig.s > 0 ? x.orig.e - x.orig.s : CFG.APPT_DEFAULT_MIN * 60000;
      x.newE = x.newS + dur;
      const late = endRule(x.newS, x.newE, 'changed');
      if (late) return finish(s, late);
      const hit = busyView(s.lists.new, s.L.held.st.j).filter((b) => b.id !== ev.id).find((b) => overlaps(x.newS, x.newE, b.s, b.e));
      if (hit && hit.allDay) return finish(s, R('CLOSED_DAY', 'CLOSED_DAY: ' + ymd(x.newS) + ' is marked as unavailable on the salon calendar (for example a holiday or the salon is closed). Nothing was changed. Ask the customer for a different day.'));
      if (hit) return finish(s, R('CONFLICT', 'CONFLICT: The new time slot is already booked (another appointment at ' + hm(hit.s) + '). Ask the customer to choose a different time, then call Reschedule_Appointment again with the new choice.'));
      // Never move it yet: record what the customer must confirm (confirmation gate).
      return proposeStart(s, { act: 'reschedule', ev: ev.id, os: x.orig.s, oe: x.orig.e, fp: fpOf(ev), ns: x.newS, ne: x.newE, nsum: x.newSummary, ndesc: x.newDesc, k: x.idn.k, sum: cleanSummary(ev.summary), svc: svcOf(ev) }, now, rnd);
    }
    if (c === 'notfound' || c === 'gone') return finish(s, R('NOT_FOUND', RS_NOT_FOUND));
    if (retryable(c)) return retryOr(s, 'SF', 'S.fresh', now, rnd) || finish(s, resError(s, 'read'));
    return finish(s, resError(s, 'read'));
  };
  const RO = { kind: 1, etag: 1, htmlLink: 1, created: 1, updated: 1, creator: 1, organizer: 1, iCalUID: 1, sequence: 1, hangoutLink: 1 };
  function eventBody(ev, start, end, summary, description) {
    const b = {};
    for (const k of Object.keys(ev)) if (!RO[k]) b[k] = ev[k];
    b.start = start; b.end = end; b.summary = summary; b.description = description; b.status = 'confirmed';
    return b;
  }
  function newBody(s) {
    const x = s.x;
    return eventBody(x.full,
      { dateTime: isoLocal(x.newS), timeZone: CFG.TIMEZONE }, { dateTime: isoLocal(x.newE), timeZone: CFG.TIMEZONE },
      x.newSummary || x.full.summary,
      x.newDesc ? 'Phone: ' + x.phone + '. Notes: ' + x.newDesc : x.full.description);
  }
  H['S.put'] = (s) => { s.x.put++; return HTTP(s, 'S.putR', { method: 'PUT', url: evUrl(CFG.CALENDAR_ID, s.x.id), headers: { 'If-Match': s.x.full.etag }, body: newBody(s) }); };
  H['S.putR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') { s.x.updated = body(r); return GOTO(s, 'S.v0'); }
    if (c === 'notfound' || c === 'gone') return finish(s, R('NOT_FOUND', RS_NOT_FOUND));
    // 412 / unclear: find out what the event looks like now.
    if (c === 'precondition' || retryable(c)) return SLEEP(s, 'S.chk', c === 'precondition' ? CFG.MIN_SLEEP_MS : backoff(0, rnd));
    return finish(s, resError(s, 'update'));
  };
  H['S.chk'] = (s) => HTTP(s, 'S.chkR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.x.id) });
  H['S.chkR'] = (s, r, now, rnd) => {
    const c = cls(r); const x = s.x;
    if (c === 'ok') {
      const ev = body(r);
      if (ev.status === 'cancelled') return finish(s, R('NOT_FOUND', RS_NOT_FOUND));
      const st = evStart(ev), en = evEnd(ev);
      if (st === x.newS && en === x.newE) { x.updated = ev; return GOTO(s, 'S.v0'); } // our write landed
      if (st === x.orig.s && en === x.orig.e && x.put < 3 && leaseOk(s, now)) { x.full = ev; return GOTO(s, 'S.put'); } // not applied
      return finish(s, R('ERROR', 'ERROR: The appointment was changed by someone else while rescheduling, so this request changed NOTHING. Call Find_Patient_Appointments to re-check the current appointment before trying again.'));
    }
    if (c === 'notfound' || c === 'gone') return finish(s, R('NOT_FOUND', RS_NOT_FOUND));
    if (retryable(c)) return retryOr(s, 'SC', 'S.chk', now, rnd) || finish(s, resUnknown(s, 'reschedule confirmation'));
    return finish(s, resUnknown(s, 'reschedule confirmation'));
  };
  H['S.v0'] = (s) => listStart(s, 'verify', s.x.newS, s.x.newE, 'S.verify', 'S.ok');
  H['S.verify'] = (s) => {
    const others = (s.lists.verify || []).filter((ev) => ev.id !== s.x.id && isTimed(ev) && overlaps(s.x.newS, s.x.newE, evStart(ev), evEnd(ev)));
    return GOTO(s, others.length ? 'S.rb' : 'S.ok');
  };
  H['S.ok'] = (s, r, now) => {
    const x = s.x;
    s.jadd = [{ o: 'u', i: x.id, s: x.newS, e: x.newE, os: x.orig.s, oe: x.orig.e, k: x.idn.k, at: now }];
    return finish(s, R('SUCCESS', 'SUCCESS: Rescheduled appointment "' + cleanSummary(x.orig.summary) + '" from ' + fmtLocal(x.orig.s) + ' to ' + fmtLocal(x.newS)));
  };
  H['S.rb'] = (s) => {
    const x = s.x; x.rb++;
    return HTTP(s, 'S.rbR', { method: 'PUT', url: evUrl(CFG.CALENDAR_ID, x.id), headers: { 'If-Match': x.updated.etag }, body: eventBody(x.updated, x.orig.start, x.orig.end, x.orig.summary, x.orig.description) });
  };
  H['S.rbR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') return finish(s, R('CONFLICT', 'CONFLICT: The new time slot was taken by another booking at the same moment, so the appointment was left at its ORIGINAL time (' + fmtLocal(s.x.orig.s) + '). Ask the customer to choose a different time.'));
    if (s.x.rb < 4) return SLEEP(s, 'S.rbChk', backoff(s.x.rb - 1, rnd));
    return finish(s, resUnknown(s, 'reschedule rollback'));
  };
  H['S.rbChk'] = (s) => HTTP(s, 'S.rbChkR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.x.id) });
  H['S.rbChkR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      const ev = body(r);
      if (evStart(ev) === s.x.orig.s && evEnd(ev) === s.x.orig.e) return finish(s, R('CONFLICT', 'CONFLICT: The new time slot was taken by another booking at the same moment, so the appointment was left at its ORIGINAL time (' + fmtLocal(s.x.orig.s) + '). Ask the customer to choose a different time.'));
      s.x.updated = ev;
      return GOTO(s, 'S.rb');
    }
    if (s.x.rb < 4) return SLEEP(s, 'S.rbChk', backoff(s.x.rb, rnd));
    return finish(s, resUnknown(s, 'reschedule rollback'));
  };

  // ================================================================ CANCEL
  const CN_NOT_FOUND = 'NOT_FOUND: No appointment found matching that phone number and date/time.';
  H['C.start'] = (s, r, now) => {
    const c = s.ctx;
    const d = parseYmd(c.appointment_date);
    const tRaw = String(c.appointment_time == null ? '' : c.appointment_time).trim();
    const t = tRaw ? parseHm(tRaw) : null;
    if (!d || (tRaw && !t)) return DONE(s, R('INVALID_INPUT', 'INVALID_INPUT: The appointment date (YYYY-MM-DD) and/or time (HH:mm) is missing or invalid. Call Find_Patient_Appointments to get the exact appointment, confirm it with the customer, then call this tool again.'));
    const idn = identity(c);
    if (idn.error) return DONE(s, idn.error);
    s.c = { date: d.text, t: t ? t.text : '', idn, relist: 0, del: 0 };
    return lockStart(s, 'C.list', now);
  };
  H['C.list'] = (s) => { const d = parseYmd(s.c.date); const a = localMs(d.y, d.mo, d.d); return listStart(s, 'day', a, a + DAY, 'C.decide'); };
  H['C.decide'] = (s) => {
    const x = s.c; const j = s.L.held.st.j || [];
    const cands = matchView(s.lists.day, j).filter((m) => ymd(m.s) === x.date && timeOk(m, x.t) && idMatch(m, x.idn));
    if (cands.length === 0) {
      const done = j.find((e) => e.o === 'd' && e.k === x.idn.k && ymd(e.s) === x.date && (!x.t || hm(e.s) === x.t));
      if (done) { x.dup = done; return GOTO(s, 'C.dup'); }
      return GOTO(s, 'C.none');
    }
    if (cands.length > 1) return finish(s, R('AMBIGUOUS', 'AMBIGUOUS: Multiple appointments found - ask the customer to confirm the exact time: ' + cands.map((m, i) => (i + 1) + ') ' + labelOf(m) + ' at ' + fmtLocal(m.s)).join('; ')));
    x.id = cands[0].id;
    return GOTO(s, 'C.fresh');
  };
  H['C.none'] = (s) => finish(s, s.c.idn.via === 'chat' && s.c.idn.nameGiven ? R('NEED_BOOKED_PHONE', NEED_BOOKED_PHONE) : R('NOT_FOUND', CN_NOT_FOUND));
  // Duplicate of a cancellation we already did: confirm it is really gone first.
  H['C.dup'] = (s) => HTTP(s, 'C.dupR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.c.dup.i) });
  H['C.dupR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'notfound' || c === 'gone' || (c === 'ok' && body(r).status === 'cancelled')) {
      return finish(s, R('SUCCESS', 'SUCCESS: That appointment (' + fmtLocal(s.c.dup.s) + ') is already cancelled (duplicate request).', { idempotent: true }));
    }
    if (c === 'ok') return GOTO(s, 'C.none');
    if (retryable(c)) return retryOr(s, 'CD', 'C.dup', now, rnd) || finish(s, resError(s, 'read'));
    return finish(s, resError(s, 'read'));
  };
  H['C.fresh'] = (s) => HTTP(s, 'C.freshR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.c.id) });
  H['C.freshR'] = (s, r, now, rnd) => {
    const c = cls(r); const x = s.c;
    if (c === 'ok') {
      const ev = body(r);
      if (ev.status === 'cancelled') { x.ev = ev; return GOTO(s, 'C.ok'); }
      const st = evStart(ev);
      if (!(Number.isFinite(st) && ymd(st) === x.date && timeOk({ s: st, ev }, x.t) && phoneMatches(ev, x.idn))) {
        if (x.relist++ < 2) return GOTO(s, 'C.list');
        return finish(s, R('NOT_FOUND', CN_NOT_FOUND));
      }
      x.ev = ev;
      // Never delete it yet: record what the customer must confirm (confirmation gate).
      return proposeStart(s, { act: 'cancel', ev: ev.id, os: st, oe: evEnd(ev), fp: fpOf(ev), k: x.idn.k, sum: cleanSummary(ev.summary), svc: svcOf(ev) }, now, rnd);
    }
    if (c === 'notfound' || c === 'gone') return finish(s, R('NOT_FOUND', CN_NOT_FOUND));
    if (retryable(c)) return retryOr(s, 'CF', 'C.fresh', now, rnd) || finish(s, resError(s, 'read'));
    return finish(s, resError(s, 'read'));
  };
  // Conditional delete: can only remove exactly the version we validated.
  H['C.del'] = (s) => { s.c.del++; return HTTP(s, 'C.delR', { method: 'DELETE', url: evUrl(CFG.CALENDAR_ID, s.c.id), headers: { 'If-Match': s.c.ev.etag } }); };
  H['C.delR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok' || c === 'gone') return GOTO(s, 'C.ok');
    if (c === 'notfound') return finish(s, R('NOT_FOUND', CN_NOT_FOUND));
    if (c === 'precondition') return finish(s, invalid('appointment_changed')); // edited since it was confirmed
    if (c === 'ratelimit') { if (s.c.del < 4 && leaseOk(s, now)) return SLEEP(s, 'C.del', backoff(s.c.del - 1, rnd)); return finish(s, resBusy(s)); }
    if (c === 'ambiguous') return SLEEP(s, 'C.chk', backoff(0, rnd));
    return finish(s, resError(s, 'delete'));
  };
  H['C.chk'] = (s) => HTTP(s, 'C.chkR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.c.id) });
  H['C.chkR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      const ev = body(r);
      if (ev.status === 'cancelled') return GOTO(s, 'C.ok');
      if (s.c.del < 3 && leaseOk(s, now)) { s.c.ev = ev; return GOTO(s, 'C.del'); }
      return finish(s, resUnknown(s, 'cancellation confirmation'));
    }
    if (c === 'notfound' || c === 'gone') return GOTO(s, 'C.ok');
    if (retryable(c)) return retryOr(s, 'CC', 'C.chk', now, rnd) || finish(s, resUnknown(s, 'cancellation confirmation'));
    return finish(s, resUnknown(s, 'cancellation confirmation'));
  };
  H['C.ok'] = (s, r, now) => {
    const ev = s.c.ev || {}; const st = evStart(ev);
    s.jadd = Number.isFinite(st) ? [{ o: 'd', i: s.c.id, s: st, e: evEnd(ev), k: s.c.idn.k, at: now }] : [];
    return finish(s, R('SUCCESS', 'SUCCESS: Cancelled appointment "' + cleanSummary(ev.summary) + '" on ' + (Number.isFinite(st) ? fmtLocal(st) : s.c.date)));
  };

  // ================================================================ CONFIRMATION GATE
  // Cancel / Reschedule never change the calendar when the AI calls them. They
  // PROPOSE: verify the appointment (and the new slot), then store ONE pending
  // record in the customer's own chat lock object ("pc") and stop. Only an
  // EXECUTE call - made by the main workflow's Confirmation Gate with the
  // customer's raw next message - can apply it, and only if every check below
  // passes. The record is used up (CAS) BEFORE the calendar write, so it can
  // never be replayed. One record per customer: a new proposal replaces it.
  const chatLock = (s) => chatLockIdFor(s.ctx.phone_number);
  const fpOf = (ev) => fnv(JSON.stringify([String((ev && ev.summary) || ''), String((ev && ev.description) || '')]));
  function svcOf(ev) { const m = /Service:\s*([^|\n]+)/i.exec((ev && ev.description) || ''); return m ? m[1].replace(/[.\s]+$/, '').trim().slice(0, 80) : ''; }
  const notesAdd = (n, now, t) => (n || []).concat([{ at: now, t: String(t).slice(0, 300) }]).slice(-(CFG.CONFIRM_NOTES_MAX || 4));
  const usedAdd = (pu, id) => (pu || []).concat([id]).slice(-(CFG.CONFIRM_USED_MAX || 20));
  function describe(rec) {
    return rec.act === 'cancel' ? 'cancelling "' + rec.sum + '" on ' + fmtLocal(rec.os) : 'moving "' + rec.sum + '" from ' + fmtLocal(rec.os) + ' to ' + fmtLocal(rec.ns);
  }
  function invalid(reason, extra) {
    return R('CONFIRMATION_INVALID', 'CONFIRMATION_INVALID (' + reason + '): the change was NOT made - nothing was changed.', Object.assign({ reason }, extra || {}));
  }
  function chatPut(s, ev, nst) {
    return lockReq('PUT', chatLock(s), { headers: { 'If-Match': ev.etag }, body: lockBody(chatLock(s), 'customer chat queue', capState(nst)) });
  }

  // ---- propose
  function confirmRequired(rec) {
    return R('CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED: NOTHING has been changed yet. The system itself now asks the customer to confirm ' + describe(rec) +
      ' and makes the change only after their explicit yes in their next message. Never say it is done, and do not ask for the confirmation yourself.' + (CONF ? ' ' + CONF.mark(CONF.pub(rec)) : ''), { confirm: CONF ? CONF.pub(rec) : { id: rec.id, act: rec.act } });
  }
  function proposeStart(s, rec, now, rnd) {
    if (normPhone(s.ctx.phone_number).length < 6) return finish(s, resError(s, 'no customer chat for the confirmation'));
    s.P = { rec: Object.assign(rec, { id: randId(rnd, 'cf', 20), at: now, exp: now + (CFG.CONFIRM_TTL_MS || 600000), pm: String(s.ctx.chat_msg_id == null ? '' : s.ctx.chat_msg_id) }), boots: 0, n: 0 };
    return GOTO(s, 'P.get');
  }
  H['P.get'] = (s) => HTTP(s, 'P.getR', lockReq('GET', chatLock(s)));
  H['P.getR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'notfound') {
      if (s.P.boots++ >= 3) return finish(s, resError(s, 'confirmation store'));
      return HTTP(s, 'P.bootR', { method: 'POST', url: calUrl(CFG.LOCK_CALENDAR_ID), body: lockBody(chatLock(s), 'customer chat queue', { v: 1 }) });
    }
    if (c !== 'ok') { if (retryable(c)) { const a = retryOr(s, 'P', 'P.get', now, rnd); if (a) return a; } return finish(s, resError(s, 'confirmation store')); }
    const ev = body(r); const st = parseLock(ev); let rec = s.P.rec;
    // The identical request is already waiting (e.g. the AI called the tool twice): keep that record and its id.
    const cur = st.pc;
    if (cur && cur.id && cur.act === rec.act && cur.ev === rec.ev && cur.os === rec.os && cur.oe === rec.oe && cur.fp === rec.fp && (cur.ns || null) === (rec.ns || null) && (cur.ne || null) === (rec.ne || null) &&
      (cur.nsum || '') === (rec.nsum || '') && (cur.ndesc || '') === (rec.ndesc || '') && cur.k === rec.k && now < cur.exp && (st.pu || []).indexOf(cur.id) < 0) {
      s.P.rec = cur;
      return finish(s, confirmRequired(cur));
    }
    const nst = Object.assign({}, st, { v: 1, pc: rec, n: notesAdd(st.n, now, 'asked the customer to confirm ' + describe(rec) + ' - nothing changed yet') });
    return HTTP(s, 'P.putR', chatPut(s, ev, nst));
  };
  H['P.bootR'] = (s, r, now, rnd) => (retryable(cls(r)) ? SLEEP(s, 'P.get', backoff(0, rnd)) : GOTO(s, 'P.get'));
  H['P.putR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') return finish(s, confirmRequired(s.P.rec));
    if (c === 'precondition') { if (s.P.n++ < 8) return SLEEP(s, 'P.get', 50 + rnd() * 250); return finish(s, resBusy(s)); }
    if (retryable(c)) { const a = retryOr(s, 'P', 'P.get', now, rnd); if (a) return a; } // re-read, then write the same record again
    return finish(s, resError(s, 'confirmation store'));
  };

  // ---- execute
  H['X.start'] = (s) => {
    s.exec = true;
    if (!CONF) return DONE(s, invalid('no_classifier'));
    if (normPhone(s.ctx.phone_number).length < 6) return DONE(s, invalid('no_customer'));
    s.X = { n: 0 };
    return GOTO(s, 'X.get');
  };
  H['X.get'] = (s) => HTTP(s, 'X.getR', lockReq('GET', chatLock(s)));
  H['X.getR'] = (s, r, now, rnd) => {
    const c = cls(r); const ctx = s.ctx; const cid = String(ctx.confirm_id);
    if (c === 'notfound') return DONE(s, invalid('missing'));
    if (c !== 'ok') { if (retryable(c)) { const a = retryOr(s, 'X', 'X.get', now, rnd); if (a) return a; } return DONE(s, resError(s, 'confirmation store')); }
    const ev = body(r); const st = parseLock(ev); const rec = st.pc;
    let why = null;
    if ((st.pu || []).indexOf(cid) >= 0) why = 'used';
    else if (!rec || !rec.id) why = 'missing';
    else if (rec.id !== cid) why = 'mismatch';
    else if (rec.act !== s.op) why = 'wrong_action';
    else if (!(now < rec.exp)) why = 'expired';
    else if (!ctx.confirm_msg_id || String(ctx.confirm_msg_id) === String(rec.pm || '')) why = 'stale_message';
    else if (String(ctx.confirm_via == null ? '' : ctx.confirm_via) !== 'text') why = 'not_typed'; // a voice transcription never confirms
    else if (CONF.classify(ctx.confirm_message) !== 'yes') why = 'not_yes';
    else if (ctx.confirm_event_id != null && ctx.confirm_event_id !== '' && String(ctx.confirm_event_id) !== rec.ev) why = 'wrong_appointment';
    else if (s.op === 'reschedule' && ctx.confirm_new_start != null && ctx.confirm_new_start !== '' && Number(ctx.confirm_new_start) !== rec.ns) why = 'wrong_time';
    // A failed check on THE current record uses it up too (it can never be retried);
    // an unknown/old id leaves the customer's current record alone.
    if (why && !(rec && rec.id === cid && why !== 'used')) return DONE(s, invalid(why));
    s.X.rec = rec; s.X.why = why;
    return HTTP(s, 'X.useR', chatPut(s, ev, Object.assign({}, st, { v: 1, pc: null, pu: usedAdd(st.pu, rec.id) })));
  };
  H['X.useR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      if (s.X.why) return DONE(s, invalid(s.X.why));
      return lockStart(s, 'X.fresh', now);
    }
    // Someone else changed the record meanwhile: re-read and re-check everything
    // (if our own write landed after all, the id is now "used" and nothing is changed).
    if (c === 'precondition' && s.X.n++ < 8) return SLEEP(s, 'X.get', 50 + rnd() * 250);
    if (retryable(c)) { const a = retryOr(s, 'XU', 'X.get', now, rnd); if (a) return a; }
    return DONE(s, resError(s, 'confirmation store'));
  };
  H['X.fresh'] = (s) => HTTP(s, 'X.freshR', { method: 'GET', url: evUrl(CFG.CALENDAR_ID, s.X.rec.ev) });
  H['X.freshR'] = (s, r, now, rnd) => {
    const c = cls(r); const rec = s.X.rec;
    if (c === 'notfound' || c === 'gone') return finish(s, invalid('appointment_changed'));
    if (c !== 'ok') { if (retryable(c)) return retryOr(s, 'XF', 'X.fresh', now, rnd) || finish(s, resError(s, 'read')); return finish(s, resError(s, 'read')); }
    const ev = body(r);
    // The exact appointment that was confirmed, unchanged since: same id, times and content.
    if (ev.status === 'cancelled' || evStart(ev) !== rec.os || evEnd(ev) !== rec.oe || fpOf(ev) !== rec.fp) return finish(s, invalid('appointment_changed'));
    if (s.op === 'cancel') {
      s.c = { id: rec.ev, ev, idn: { k: rec.k }, date: ymd(rec.os), t: hm(rec.os), relist: 9, del: 0 };
      if (!leaseOk(s, now)) return finish(s, resBusy(s));
      return GOTO(s, 'C.del');
    }
    s.x = { id: rec.ev, full: ev, orig: { summary: ev.summary, description: ev.description, start: ev.start, end: ev.end, s: rec.os, e: rec.oe },
      newS: rec.ns, newE: rec.ne, idn: { k: rec.k }, newSummary: rec.nsum || '', newDesc: rec.ndesc || '', phone: digits(s.ctx.phone_number), odate: ymd(rec.os), ot: hm(rec.os), relist: 9, put: 0, rb: 0 };
    const a = dayStart(rec.ns);
    return listStart(s, 'new', a, a + DAY, 'X.slot');
  };
  // The confirmed new time must still be valid and free at the moment of writing.
  H['X.slot'] = (s, r, now) => {
    const x = s.x;
    const rule = slotRule(x.newS, now, 'changed') || endRule(x.newS, x.newE, 'changed');
    if (rule) return finish(s, invalid('conflict', { detail: rule.status }));
    const hit = busyView(s.lists.new, s.L.held.st.j).filter((b) => b.id !== x.id).find((b) => overlaps(x.newS, x.newE, b.s, b.e));
    if (hit) return finish(s, invalid('conflict'));
    if (!leaseOk(s, now)) return finish(s, resBusy(s));
    return GOTO(s, 'S.put');
  };

  // ================================================================ CHAT LOCK
  // One lock event per customer chat. State: h (holder token), hx (lease expiry),
  // hm/hts (message being processed), w (waiting queue), p (processed ids),
  // lp (timestamp of the newest processed message).
  const chatLockId = (s) => chatLockIdFor(s.ctx.chatId);
  // What the main workflow needs from this customer's lock object at the start of
  // a message: the pending confirmation (if any), recent system notes and language.
  const convo = (st) => ({ pending: st.pc || null, notes: st.n || [], lang: st.lg || '' });
  const qKey = (w) => [w.ts || 0, w.r || 0, w.t];
  function qCmp(a, b) { const x = qKey(a), y = qKey(b); for (let i = 0; i < 3; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; } return 0; }

  H['CA.start'] = (s) => {
    if (digits(s.ctx.chatId).length < 6 || !s.ctx.msgId) return DONE(s, R('ERROR', 'chat lock: missing chatId or msgId'));
    s.q = { polls: 0, boots: 0 };
    return GOTO(s, 'CA.get');
  };
  H['CA.get'] = (s) => HTTP(s, 'CA.getR', lockReq('GET', chatLockId(s)));
  H['CA.getR'] = (s, r, now, rnd) => {
    const c = cls(r); const ctx = s.ctx;
    if (c === 'notfound') {
      if (s.q.boots++ >= 3) return DONE(s, R('ERROR', 'chat lock: could not create lock object'));
      return HTTP(s, 'CA.bootR', { method: 'POST', url: calUrl(CFG.LOCK_CALENDAR_ID), body: lockBody(chatLockId(s), 'customer chat queue', { v: 1 }) });
    }
    if (c !== 'ok') {
      if (retryable(c)) { const a = retryOr(s, 'CA', 'CA.get', now, rnd); if (a) return a; }
      return DONE(s, R('ERROR', 'chat lock: lock store unavailable (' + (r && r.statusCode) + ')'));
    }
    s.rt.CA = 0;
    const ev = body(r); const st = parseLock(ev);
    const w = (st.w || []).filter((x) => x && x.r >= now - CFG.CHAT_WAITER_TTL_MS);
    if (st.h === s.token) return DONE(s, R('ACQUIRED', 'acquired', Object.assign({ outOfOrder: (st.lp || 0) > (ctx.msgTs || 0), recoveredStaleLock: !!s.q.recovered }, convo(st))));
    const holderLive = !!st.h && st.hx > now;
    if ((st.p || []).indexOf(ctx.msgId) >= 0 || (holderLive && st.hm === ctx.msgId) || w.some((x) => x.id === ctx.msgId && x.t !== s.token)) {
      return DONE(s, R('DUPLICATE', 'duplicate delivery of an already received message'));
    }
    const me = w.find((x) => x.t === s.token);
    if (!me) {
      if (now > s.deadline) return DONE(s, R('TIMEOUT', 'chat lock: gave up waiting'));
      if (w.length >= CFG.CHAT_MAX_WAITERS) return DONE(s, R('OVERFLOW', 'chat lock: too many queued messages for this chat'));
      const nst = Object.assign({}, st, { v: 1, w: w.concat([{ t: s.token, id: ctx.msgId, ts: ctx.msgTs || 0, r: s.q.reg || now }]) });
      s.q.reg = s.q.reg || now; s.q.intent = 'reg';
      return HTTP(s, 'CA.putR', lockReq('PUT', chatLockId(s), { headers: { 'If-Match': ev.etag }, body: lockBody(chatLockId(s), 'customer chat queue', capState(nst)) }));
    }
    const first = w.slice().sort(qCmp)[0].t === s.token;
    const settled = now - me.r >= CFG.CHAT_SETTLE_MS;
    if (!holderLive && first && settled) {
      const nst = Object.assign({}, st, { v: 1, h: s.token, ha: now, hx: now + CFG.CHAT_LOCK_TTL_MS, hm: ctx.msgId, hts: ctx.msgTs || 0, w: w.filter((x) => x.t !== s.token) });
      s.q.intent = 'take'; s.q.recovered = !!st.h; s.q.lp = st.lp || 0; s.q.st = nst;
      return HTTP(s, 'CA.putR', lockReq('PUT', chatLockId(s), { headers: { 'If-Match': ev.etag }, body: lockBody(chatLockId(s), 'customer chat queue', capState(nst)) }));
    }
    // A waiter whose execution died (crashed, or stopped by hand) stays in the
    // queue until its TTL and blocks everyone behind it. A live first waiter
    // takes a free lock within one poll, so if the lock stays free AND untouched
    // (same etag) for CHAT_DEAD_WAITER_MS per waiter ahead of me, those waiters
    // are dead: drop them and take the lock (CAS). Scaling by position keeps the
    // order among live waiters - the one directly behind the dead one goes first.
    if (!holderLive && !first && settled) {
      const ahead = w.filter((x) => qCmp(x, me) < 0);
      if (s.q.idleTag !== ev.etag) { s.q.idleTag = ev.etag; s.q.idleSince = now; }
      else if (now - s.q.idleSince >= CFG.CHAT_DEAD_WAITER_MS * ahead.length) {
        const nst = Object.assign({}, st, { v: 1, h: s.token, ha: now, hx: now + CFG.CHAT_LOCK_TTL_MS, hm: ctx.msgId, hts: ctx.msgTs || 0, w: w.filter((x) => qCmp(x, me) > 0) });
        s.q.intent = 'take'; s.q.recovered = true; s.q.lp = st.lp || 0; s.q.st = nst;
        return HTTP(s, 'CA.putR', lockReq('PUT', chatLockId(s), { headers: { 'If-Match': ev.etag }, body: lockBody(chatLockId(s), 'customer chat queue', capState(nst)) }));
      }
    } else s.q.idleTag = null;
    if (now > s.deadline) return DONE(s, R('TIMEOUT', 'chat lock: gave up waiting'));
    return SLEEP(s, 'CA.get', settled ? pollDelay(s.q.polls++, rnd) : CFG.CHAT_SETTLE_MS - (now - me.r) + 50);
  };
  H['CA.bootR'] = (s, r, now, rnd) => (retryable(cls(r)) ? SLEEP(s, 'CA.get', backoff(0, rnd)) : GOTO(s, 'CA.get'));
  H['CA.putR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') {
      if (s.q.intent === 'take') return DONE(s, R('ACQUIRED', 'acquired', Object.assign({ outOfOrder: (s.q.lp || 0) > (s.ctx.msgTs || 0), recoveredStaleLock: !!s.q.recovered }, convo(s.q.st || {}))));
      return SLEEP(s, 'CA.get', CFG.CHAT_SETTLE_MS + 50);
    }
    if (c === 'precondition') return SLEEP(s, 'CA.get', 50 + rnd() * 250);
    if (retryable(c)) { const a = retryOr(s, 'CA', 'CA.get', now, rnd); if (a) return a; }
    return DONE(s, R('ERROR', 'chat lock: could not update lock (' + (r && r.statusCode) + ')'));
  };

  H['CR.get'] = (s) => HTTP(s, 'CR.getR', lockReq('GET', chatLockId(s)));
  H['CR.getR'] = (s, r, now, rnd) => {
    const c = cls(r); const ctx = s.ctx;
    if (c === 'notfound') return DONE(s, R('RELEASED', 'no lock object'));
    if (c !== 'ok') {
      s.rel = (s.rel || 0) + 1;
      if (retryable(c) && s.rel <= 8) return SLEEP(s, 'CR.get', backoff(s.rel - 1, rnd));
      return DONE(s, R('RELEASE_FAILED', 'lease will expire on its own'));
    }
    const ev = body(r); const st = parseLock(ev);
    const nst = clone(st); let changed = false;
    if (st.h === s.token) { nst.h = null; nst.ha = null; nst.hx = null; nst.hm = null; nst.hts = null; changed = true; }
    const w = st.w || [];
    if (w.some((x) => x.t === s.token)) { nst.w = w.filter((x) => x.t !== s.token); changed = true; }
    if (ctx.wasHolder) {
      const p = st.p || [];
      if (p.indexOf(ctx.msgId) < 0) { nst.p = p.concat([ctx.msgId]).slice(-CFG.PROCESSED_MAX); changed = true; }
      if ((ctx.msgTs || 0) > (st.lp || 0)) { nst.lp = ctx.msgTs; changed = true; }
      // Confirmation gate bookkeeping decided while handling this message.
      if (ctx.pcClear && st.pc && st.pc.id === ctx.pcClear) { nst.pc = null; nst.pu = usedAdd(st.pu, ctx.pcClear); changed = true; }
      if (ctx.note) { nst.n = notesAdd(st.n, now, ctx.note); changed = true; }
      if (ctx.lang && ctx.lang !== st.lg) { nst.lg = ctx.lang; changed = true; }
    }
    if (!changed) return DONE(s, R('RELEASED', 'nothing to release'));
    nst.v = 1;
    return HTTP(s, 'CR.putR', lockReq('PUT', chatLockId(s), { headers: { 'If-Match': ev.etag }, body: lockBody(chatLockId(s), 'customer chat queue', capState(nst)) }));
  };
  H['CR.putR'] = (s, r, now, rnd) => {
    const c = cls(r);
    if (c === 'ok') return DONE(s, R('RELEASED', 'released'));
    s.rel = (s.rel || 0) + 1;
    if (s.rel > 10) return DONE(s, R('RELEASE_FAILED', 'lease will expire on its own'));
    if (c === 'precondition') return SLEEP(s, 'CR.get', 50 + rnd() * 250);
    if (retryable(c)) return SLEEP(s, 'CR.get', backoff(Math.min(s.rel - 1, 4), rnd));
    return DONE(s, R('RELEASE_FAILED', 'lease will expire on its own'));
  };

  // ================================================================ driver
  const START = { book: 'B.start', reschedule: 'S.start', cancel: 'C.start', chatAcquire: 'CA.start', chatRelease: 'CR.get' };
  function init(op, ctx, now, execId, rnd) {
    if (!START[op]) throw new Error('engine: unknown op ' + op);
    const c = ctx || {};
    const chat = op === 'chatAcquire' || op === 'chatRelease';
    return {
      // A cancel/reschedule call carrying a confirmation id is an EXECUTE call (confirmation gate).
      v: 1, op, ctx: c, phase: (op === 'cancel' || op === 'reschedule') && c.confirm_id ? 'X.start' : START[op], step: 0, rt: {}, lists: {},
      t0: now, deadline: now + (chat ? CFG.CHAT_MAX_WAIT_MS : CFG.OP_DEADLINE_MS),
      token: c.token || ('e' + String(execId == null ? '' : execId) + '_' + randId(rnd, '', 8)),
    };
  }
  function step(s, resp, now, rnd) {
    if (s.phase === 'done') throw new Error('engine: step() after done');
    let r = resp;
    if (s.step > CFG.MAX_STEPS && !s.overrun) {
      s.overrun = true;
      let a;
      if (/^R\./.test(s.phase)) a = DONE(s, s.final); // outcome already decided; lease TTL frees the lock
      else if (/^(B|S|C|L|LS|P|X)\./.test(s.phase)) a = finish(s, resUnknown(s, 'step limit'));
      else a = DONE(s, R(s.op === 'chatRelease' ? 'RELEASE_FAILED' : 'ERROR', 'engine step limit'));
      if (a) return { state: s, action: a };
      r = null;
    }
    for (let i = 0; i < 60; i++) {
      const h = H[s.phase];
      if (!h) throw new Error('engine: unknown phase ' + s.phase);
      const a = h(s, r, now, rnd);
      if (a) return { state: s, action: a };
      r = null;
    }
    throw new Error('engine: no progress in phase ' + s.phase);
  }
  return {
    init, step,
    _t: { parseDateTime, parseYmd, parseHm, fmtLocal, isoLocal, localMs, ymd, hm, slotRule, endRule, identity, busyView, matchView, phoneMatches, allDayBlock, normPhone, chatLockId: chatLockIdFor, cls, lp },
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createEngine };
