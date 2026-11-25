#!/usr/bin/env node
'use strict';
// Builds the Facebook Messenger version of Yasmine from the WhatsApp main
// workflow. The WhatsApp workflow JSON is only READ - this script never writes
// any WhatsApp file. Re-run it after every change to the WhatsApp workflow
// (tests/messenger.test.js fails while the Messenger file is out of date).
//
// Usage: node tools/build-messenger.js [--check]   (--check: fail if the file would change)
//
// What is shared with WhatsApp (unchanged): the AI prompt rules, the tool
// sub-workflows (Book / Cancel / Reschedule / Find / Check - same calendar and
// same calendar write mutex, so the two channels can never double-book), the
// chat-lock engine, Sanitize AI Output, the escalation/pause logic.
// What is Messenger-specific: intake (webhook + signature check), identity
// (the sender's Page-Scoped ID instead of a phone number), sending replies,
// voice download, customer key and pause rows ("fb:<page_id>:<PSID>"), staff
// alert texts, prompt wording.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WA_FILE = require('./build-workflows.js').FILES.main;
const { KEY_TOOLS, CUSTOMER_KEY_EXPR } = require('./build-workflows.js');
const ENV = require(path.join(ROOT, 'lumiere.config.js'));
const OUT_FILE = 'Lumiere Messenger AI Agent.json';
const NAME = 'Lumière Messenger AI Agent';
// Must differ from the WhatsApp workflow id: importing a file whose id already
// exists would overwrite that workflow.
const WF_ID = ENV.workflows.messenger;
const WEBHOOK_PATH = ENV.MESSENGER_WEBHOOK_PATH;
const GRAPH = 'https://graph.facebook.com/v25.0';
// Header Auth credential: Name "Authorization", Value "Bearer <Page access token>".
const PAGE_CRED = { httpHeaderAuth: ENV.credentials.facebookPage };
const MESSENGER_MAX_CHARS = 2000;

const D = "$('Dedup & Filter Prep').first().json";
const PROFILE_NAME = "($('Get Messenger Profile').isExecuted ? [$('Get Messenger Profile').first().json.first_name, $('Get Messenger Profile').first().json.last_name].filter(Boolean).join(' ') : '')";

function uuid(seed) {
  const h = crypto.createHash('md5').update(seed).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const dump = (o) => JSON.stringify(o, null, 2) + '\n';
const byName = (wf, n) => wf.nodes.find((x) => x.name === n);
function must(wf, n) { const x = byName(wf, n); if (!x) throw new Error('build-messenger: WhatsApp workflow has no node ' + n); return x; }
function replaceOnce(str, from, to, label) {
  const i = str.indexOf(from);
  if (i < 0) throw new Error('build-messenger: anchor not found for ' + label + ' - the WhatsApp workflow changed; update tools/build-messenger.js');
  if (str.indexOf(from, i + 1) >= 0) throw new Error('build-messenger: anchor not unique for ' + label);
  return str.slice(0, i) + to + str.slice(i + from.length);
}
function walkStrings(o, fn) {
  if (Array.isArray(o)) return o.map((v) => walkStrings(v, fn));
  if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = walkStrings(o[k], fn); return o; }
  return typeof o === 'string' ? fn(o) : o;
}
function remove(wf, name) {
  must(wf, name);
  wf.nodes = wf.nodes.filter((n) => n.name !== name);
  delete wf.connections[name];
  for (const src of Object.keys(wf.connections)) {
    for (const type of Object.keys(wf.connections[src])) {
      wf.connections[src][type] = wf.connections[src][type].map((outs) => (outs || []).filter((c) => c.node !== name));
    }
  }
}
function rename(wf, from, to) {
  must(wf, from).name = to;
  if (wf.connections[from]) { wf.connections[to] = wf.connections[from]; delete wf.connections[from]; }
  for (const src of Object.keys(wf.connections)) for (const type of Object.keys(wf.connections[src])) for (const outs of wf.connections[src][type]) for (const c of outs || []) if (c.node === from) c.node = to;
  for (const n of wf.nodes) n.parameters = walkStrings(n.parameters, (s) => s.split("$('" + from + "')").join("$('" + to + "')"));
}
function conn(wf, from, outputs) {
  wf.connections[from] = Object.assign({}, wf.connections[from] || {}, {
    main: outputs.map((names) => names.map((n) => ({ node: n, type: 'main', index: 0 }))),
  });
}
function put(wf, node) {
  const cur = byName(wf, node.name);
  if (cur) wf.nodes[wf.nodes.indexOf(cur)] = node; else wf.nodes.push(node);
  return node;
}
function boolIf(name, id, expr, pos) {
  return { parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id, leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
  name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos };
}
// One Messenger text message to the customer. textExpr is a JS expression.
function messengerSend(name, pos, textExpr, extra) {
  return Object.assign({ parameters: {
    method: 'POST', url: GRAPH + '/me/messages',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ recipient: { id: " + D + ".chatId }, messaging_type: 'RESPONSE', message: { text: " + textExpr + " } }) }}",
    options: { timeout: 15000 },
  }, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: PAGE_CRED }, extra || {});
}

// ------------------------------------------------------------------ Code nodes
// Meta signs every POST with the App Secret (X-Hub-Signature-256). Without this
// check anyone who learns the webhook URL could make the bot book appointments.
// SHA-256/HMAC are implemented here (no require('crypto'), which n8n blocks by
// default). The signature is computed by Meta over the exact bytes it sent; if
// this n8n version does not expose the raw body, the parsed body is
// re-serialized the way Meta does (non-ASCII as lowercase \uXXXX, '/' as '\/').
const VERIFY_CODE = `// Verifies Meta's X-Hub-Signature-256 and splits the webhook into one item per
// customer message (Meta may batch several events into one request).
// Env: LUMIERE_MESSENGER_APP_SECRET (required), LUMIERE_MESSENGER_PAGE_ID (optional filter).
const APP_SECRET = String($env.LUMIERE_MESSENGER_APP_SECRET || '');
const PAGE_ID = String($env.LUMIERE_MESSENGER_PAGE_ID || '');
const item = $input.first();
const req = item.json || {};
const headers = req.headers || {};
const body = req.body || {};

const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function sha256(bytes) {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = bytes.length;
  const n = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n);
  m.set(bytes); m[len] = 0x80;
  const hi = Math.floor(len / 0x20000000), lo = (len * 8) >>> 0;
  for (let i = 0; i < 4; i++) { m[n - 8 + i] = (hi >>> (24 - 8 * i)) & 255; m[n - 4 + i] = (lo >>> (24 - 8 * i)) & 255; }
  const W = new Array(64);
  const rotr = (x, r) => (x >>> r) | (x << (32 - r));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = ((m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) out[4 * i + j] = (H[i] >>> (24 - 8 * j)) & 255;
  return out;
}
function utf8(s) {
  const e = encodeURIComponent(s), out = [];
  for (let i = 0; i < e.length; i++) { if (e[i] === '%') { out.push(parseInt(e.substr(i + 1, 2), 16)); i += 2; } else out.push(e.charCodeAt(i)); }
  return Uint8Array.from(out);
}
function hmacHex(keyStr, msg) {
  let key = utf8(keyStr);
  if (key.length > 64) key = sha256(key);
  const ipad = new Uint8Array(64 + msg.length), opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { const k = key[i] || 0; ipad[i] = k ^ 0x36; opad[i] = k ^ 0x5c; }
  ipad.set(msg, 64);
  opad.set(sha256(ipad), 64);
  return Array.from(sha256(opad)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function rawBody() {
  try { if (this && this.helpers && this.helpers.getBinaryDataBuffer) { const b = await this.helpers.getBinaryDataBuffer(0, 'data'); if (b && b.length) return Uint8Array.from(b); } } catch (e) { /* not available */ }
  try { const d = item.binary && item.binary.data && item.binary.data.data; if (d && /^[A-Za-z0-9+/=]+$/.test(d)) return Uint8Array.from(Buffer.from(d, 'base64')); } catch (e) { /* not available */ }
  return null;
}
function candidates(raw) {
  if (raw) return [raw];
  const plain = JSON.stringify(body);
  const uni = plain.replace(/[\\u0080-\\uffff]/g, (ch) => '\\\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  return [uni.replace(/\\//g, '\\\\/'), uni, plain, plain.replace(/\\//g, '\\\\/')].map(utf8);
}

const sig = String(headers['x-hub-signature-256'] || '').trim().toLowerCase();
let reason = '';
if (!APP_SECRET) reason = 'LUMIERE_MESSENGER_APP_SECRET is not set - every request is rejected until it is';
else if (!/^sha256=[0-9a-f]{64}$/.test(sig)) reason = 'missing or malformed X-Hub-Signature-256 header';
else {
  const want = sig.slice(7);
  const ok = candidates(await rawBody.call(this)).some((bytes) => sameHex(hmacHex(APP_SECRET, bytes), want));
  if (!ok) reason = 'signature does not match (wrong App Secret, or the request did not come from Meta)';
}
if (reason) return [{ json: { rejected: true, reason } }];

// Only real customer messages and button taps. Echoes (the page's own replies),
// delivery/read receipts, reactions and standby events are ignored.
const out = [];
if (body.object === 'page') {
  for (const entry of body.entry || []) {
    if (PAGE_ID && String(entry.id) !== PAGE_ID) continue;
    for (const ev of entry.messaging || []) {
      if (!ev || !ev.sender || !ev.sender.id) continue;
      if (ev.message && ev.message.is_echo) continue;
      if (!ev.message && !ev.postback) continue;
      out.push({ json: { event: ev, pageId: String(entry.id || '') } });
    }
  }
}
return out;
`;

const DEDUP_CODE = `// Messenger intake: same output shape as the WhatsApp version so every later
// node works unchanged. chatId is the sender's Page-Scoped ID (PSID), used to
// reply. customerKey = "fb:<page_id>:<psid>" is the verified, channel-aware
// customer identity (chat lock, confirmations, memory, pause row, appointment
// owner): it can never equal a WhatsApp number, an Instagram user or the same
// PSID on another Page. Staff alerts still go to staff on WhatsApp:
//   LUMIERE_WHATSAPP_PHONE_NUMBER_ID, LUMIERE_WHATSAPP_ACCESS_TOKEN, LUMIERE_STAFF_CHAT_ID
const CONFIG = {
  phoneNumberId: $env.LUMIERE_WHATSAPP_PHONE_NUMBER_ID || '',
  staffChatId:   $env.LUMIERE_STAFF_CHAT_ID || '',
};

const staticData = $getWorkflowStaticData('node');
if (!staticData.processedIds) staticData.processedIds = [];

const ev = ($input.first().json || {}).event || null;
if (!ev || !ev.sender || !ev.sender.id) return [];
const psid = String(ev.sender.id).replace(/\\D/g, '');
if (!psid) return [];
// The Page that received the message (entry.id). Without it there is no customer key: drop.
const pageId = String(($input.first().json || {}).pageId || '');
if (!/^\\d{5,25}$/.test(pageId) || !/^\\d{5,25}$/.test(psid)) return [];
const customerKey = 'fb:' + pageId + ':' + psid;
const msg = ev.message || null;
const postback = ev.postback || null;
if (!msg && !postback) return [];
if (msg && msg.is_echo) return [];

const msgId = (msg && msg.mid) || (postback && postback.mid) || ('pb.' + psid + '.' + (ev.timestamp || ''));
// Messenger timestamps are in milliseconds (WhatsApp: seconds). They are only
// compared with other messages of the same chat, so ms simply orders better.
const msgTimestamp = ev.timestamp ? Number(ev.timestamp) : null;

let shouldProcess = true;
let reason = 'ok';

if (msgId && staticData.processedIds.includes(msgId)) {
  shouldProcess = false;
  reason = 'duplicate delivery - already processed';
}

// Staleness check: drop messages delivered very late (queued webhook retry)
const ageMs = msgTimestamp ? (Date.now() - msgTimestamp) : 0;
const STALE_THRESHOLD_MS = 3 * 60 * 1000;
if (shouldProcess && msgTimestamp && ageMs > STALE_THRESHOLD_MS) {
  shouldProcess = false;
  reason = \`message is stale (\${Math.round(ageMs / 1000)}s old) - likely a delayed webhook retry, skipping\`;
}

if (shouldProcess && msgId) {
  staticData.processedIds.push(msgId);
  if (staticData.processedIds.length > 300) staticData.processedIds.shift();
}

if (!shouldProcess) {
  return [];
}

// Messenger's thumbs-up "like" sticker usually means "OK / yes".
const LIKE_STICKERS = ['369239263222822', '369239343222814', '369239383222810'];
const atts = (msg && Array.isArray(msg.attachments)) ? msg.attachments : [];
const audio = atts.find((a) => a && a.type === 'audio' && a.payload && a.payload.url);
let messageType = 'unsupported';
let textBody = '';
let mediaUrl = '';
if (msg && typeof msg.text === 'string' && msg.text.trim()) {
  messageType = 'text';
  textBody = msg.text;
} else if (audio) {
  messageType = 'voice';
  mediaUrl = audio.payload.url;
} else if (msg && msg.sticker_id && LIKE_STICKERS.includes(String(msg.sticker_id))) {
  messageType = 'text';
  textBody = '👍';
} else if (postback) {
  // e.g. the "Get Started" button on a first contact
  messageType = 'text';
  textBody = String(postback.title || postback.payload || '').trim() || 'Hello';
}

return [{
  json: {
    ...CONFIG,
    channel: 'messenger',
    shouldProcess,
    reason,
    isUnmuteCommand: false,
    unmuteTargetPhone: '',
    chatId: psid,
    psid,
    pageId,
    customerKey,
    senderName: '',
    messageType,
    textBody,
    hasMedia: atts.length > 0,
    mediaId: '',
    mediaUrl,
    messageId: msgId,
    msgTs: msgTimestamp || 0,
  }
}];
`;

const MATCH_PAUSE_CODE = `// Messenger pause rows are written as the customer key "fb:<page_id>:<PSID>"
// (text). A bare 16-17 digit PSID would be stored by Google Sheets as a rounded
// number and never match again. The prefix also keeps Messenger rows from ever
// matching a WhatsApp number or an Instagram customer (and vice versa).
// Rows written before customer keys existed ("fb:<PSID>", same salon Page) still
// pause the customer: a pause is never lost by the upgrade.
// Staff re-enable the bot by setting Status to anything other than "paused"
// (e.g. "unmuted") or deleting the row.
// The Sheets read failed: its error branch answers and releases the lock - never continue here too
// (Check Handoff Status has "Always Output Data", so n8n also sends an empty item here; see build-workflows.js).
if ($('Check Handoff Status').all(1).length) return [];
const d = $('Dedup & Filter Prep').first().json;
const keys = [d.customerKey, 'fb:' + d.chatId];
let isPaused = false;

for (const row of $input.all()) {
  if (keys.indexOf(String(row.json.Patient_ID || '').trim()) >= 0 && String(row.json.Status || '').trim() === 'paused') {
    isPaused = true;
    break;
  }
}

return [{ json: { ...$('Dedup & Filter Prep').first().json, isPaused } }];
`;

const NAME_VOICE_CODE = `// Messenger voice clips are usually AAC audio in an MP4 container. Name the
// file after its real type so the transcription API recognizes the format.
const EXT = { 'audio/mp4': 'mp4', 'video/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm' };
for (const item of $input.all()) {
  const b = item.binary && item.binary.data;
  if (!b) throw new Error('voice download returned no file');
  const mime = String(b.mimeType || '').split(';')[0].trim().toLowerCase();
  const fromName = (/\\.([a-z0-9]{2,4})$/i.exec(String(b.fileName || '').split('?')[0]) || [])[1];
  b.fileName = 'voice.' + (EXT[mime] || (fromName ? fromName.toLowerCase() : 'mp4'));
}
return $input.all();
`;

const SPLIT_SNIPPET = `// Messenger rejects text messages longer than ${MESSENGER_MAX_CHARS} characters, so a long (but
// valid, <= 2800 chars) reply is sent as two messages, split at a line break or space.
const MESSENGER_MAX = ${MESSENGER_MAX_CHARS};
let replyPart1 = finalOutput, replyPart2 = '';
if (finalOutput.length > MESSENGER_MAX) {
  let cut = finalOutput.lastIndexOf('\\n', MESSENGER_MAX);
  if (cut < MESSENGER_MAX / 2) cut = finalOutput.lastIndexOf(' ', MESSENGER_MAX);
  if (cut < MESSENGER_MAX / 2) cut = MESSENGER_MAX;
  const cc = finalOutput.charCodeAt(cut - 1);
  if (cc >= 0xd800 && cc <= 0xdbff) cut--; // never split an emoji
  replyPart1 = finalOutput.slice(0, cut).trimEnd();
  replyPart2 = finalOutput.slice(cut).trim();
}

`;

// ------------------------------------------------------------------ prompt
const MESSENGER_RULES = `

## FACEBOOK MESSENGER CHANNEL (READ FIRST - OVERRIDES ANY CONFLICTING RULE BELOW)
- You are chatting with the customer through the salon's Facebook Page on Messenger. Messenger does NOT reveal the customer's phone number.
- WHO OWNS AN APPOINTMENT: every appointment you book here is automatically linked to THIS Messenger conversation by the system - you never pass, mention or ask for any ID. Find_Patient_Appointments, Cancel_Appointment and Reschedule_Appointment automatically find the appointments booked from this same Messenger conversation. Wherever the rules below or a tool result say "the current WhatsApp number", "this WhatsApp number" or "the number you are texting from", read it as "this Messenger conversation".
- CONTACT MOBILE NUMBER IS REQUIRED FOR EVERY MESSENGER BOOKING: before calling Book_Appointment you must also have the customer's mobile number, stated by the customer in this conversation (a real mobile number: 9 to 15 digits, ideally with the country code). Ask for it together with the other missing details, and only once - if they already gave it, never ask again. Put it in the notes exactly as the Book_Appointment notes field describes. The salon uses it to contact the customer.
- APPOINTMENTS BOOKED ELSEWHERE: appointments booked on WhatsApp, by phone call, at the salon, from another Facebook account or by someone else can NEVER be found, shown or changed from here, and a phone number or name the customer types is never proof that an appointment is theirs. Never ask for that number and never search for it. Tell the customer plainly that you can only manage the appointments booked from this conversation (they can also manage it from where it was booked), and call Escalate_to_Staff so a team member can help.
- Messenger shows plain text only: never use markdown such as *bold*, _italic_ or # headings.`;

function patchPrompt(p) {
  p = replaceOnce(p, 'You are Yasmine, the AI WhatsApp receptionist for', 'You are Yasmine, the AI Facebook Messenger receptionist for', 'identity');
  p = replaceOnce(p, 'listed in SALON INFO and SERVICES & PRICES below.\n', 'listed in SALON INFO and SERVICES & PRICES below.' + MESSENGER_RULES + '\n', 'messenger rules');
  p = replaceOnce(p, 'Keep replies short, natural and conversational for WhatsApp.', 'Keep replies short, natural and conversational for Messenger.', 'short replies');
  p = replaceOnce(p, 'professional receptionist texting on WhatsApp', 'professional receptionist chatting on Messenger', 'texting');
  p = replaceOnce(p, 'and the current WhatsApp number is their appointment', 'and this Messenger conversation is their appointment', 'default patient');
  p = replaceOnce(p, '  - and the contact phone number (use the current WhatsApp number unless the customer explicitly provides a different one).',
    '  - and the customer\'s contact mobile number (on Messenger it is never detected automatically - you must ask the customer for it).', 'permission list');
  p = replaceOnce(p,
    '- For the contact number:\n  - Unless the customer says otherwise, assume the current WhatsApp number is the contact number and use it when booking.\n  - Only ask for another phone number if the customer explicitly says this WhatsApp number should not be used.\n  - If the customer provides another number, validate it before using it.\n- If they give you a different number,',
    '- For the contact number:\n  - On Messenger there is no automatic number: ask the customer for their mobile number before booking (once per conversation).\n  - Validate it before using it.\n- When they give you a number,', 'contact number');
  p = replaceOnce(p,
    'every appointment you book, cancel, or reschedule is always looked up by the WhatsApp number you\'re currently texting from - never by the customer\'s own name or number alone. If you are booking for a third party (a friend, partner, child), tell the booking person plainly, once, that this WhatsApp number is what will be used to manage that appointment later too (e.g. "Podrás gestionar esta cita desde este mismo número de WhatsApp." - said simply, not as a warning)',
    'every appointment you book, cancel, or reschedule is always linked to THIS Messenger conversation - never to the customer\'s name alone. If you are booking for a third party (a friend, partner, child), tell the booking person plainly, once, that this same Messenger conversation is what will be used to manage that appointment later too (e.g. "Podrás gestionar esta cita desde esta misma conversación." - said simply, not as a warning)', 'whose number');
  p = replaceOnce(p, '(phone number only - it returns ALL of that customer\'s appointments in the next 90 days for the current WhatsApp number)',
    '(no details needed - it returns ALL appointments booked from this Messenger conversation in the next 90 days)', 'find all');
  p = replaceOnce(p, 'silently call Find_Patient_Appointments (phone number only - no date needed)', 'silently call Find_Patient_Appointments (no date needed)', 'find no date');
  p = replaceOnce(p, 'tell the customer plainly there are no appointments registered under this WhatsApp number (e.g. "No encuentro ninguna cita registrada con este número.")',
    'tell the customer plainly there are no appointments registered from this Messenger conversation (e.g. "No encuentro ninguna cita reservada desde esta conversación.")', 'not found');
  p = replaceOnce(p, 'unless the customer then tells you it was booked from a different number (see below)',
    'unless the customer then tells you it was booked on WhatsApp, by phone, or from a different number or account (see below)', 'not found other');
  p = replaceOnce(p, 'booked using a different WhatsApp/phone number than the one you\'re texting on right now - not just that they don\'t remember the date - searching by the current WhatsApp number will not find it.',
    'booked on WhatsApp, by phone call, at the salon, or from a different Facebook account - not from this Messenger conversation, and not just that they don\'t remember the date - the automatic search will not find it.', 'different number');
  p = replaceOnce(p, 'Keep every reply short. This is WhatsApp, not an email.', 'Keep every reply short. This is Messenger, not an email.', 'short');
  p = replaceOnce(p,
    'The appointment can only ever be found and managed later through the WhatsApp number the customer is CURRENTLY texting from - fixed by the system, cannot change, no matter what other number the customer provides.\nIf the customer gives an alternate number:\n- Validate it (9 to 15 digits, ideally with the country code).\n- Save it in the notes as additional reference info.',
    'On Messenger the appointment is found and managed later through THIS Messenger conversation - fixed by the system, cannot change. The mobile number the customer gives is the contact number the salon will use.\nWhen the customer gives their mobile number:\n- Validate it (9 to 15 digits, ideally with the country code).\n- Save it in the notes exactly as the Book_Appointment notes field describes.', 'phone wording');
  p = replaceOnce(p, '- If relevant, mention that cancelling/rescheduling later must be done from THIS WhatsApp number specifically.',
    '- If relevant, mention that cancelling/rescheduling later is done from this same Messenger conversation.', 'manage later');
  p = replaceOnce(p, 'state plainly in the customer\'s language, e.g. "No encuentro ninguna cita registrada con este número." / "I couldn\'t find any appointment under this number."', 'state plainly in the customer\'s language, e.g. "No encuentro ninguna cita reservada desde esta conversación." / "I couldn\'t find any appointment booked from this conversation."', 'grounding not found');
  if (/(current|this|same) WhatsApp|WhatsApp number/i.test(p.replace(MESSENGER_RULES, ''))) throw new Error('build-messenger: prompt still describes the customer as a WhatsApp number');
  return p;
}

const NOTES_EXPR = "={{ $fromAI('notes', 'REQUIRED FORMAT on Messenger: start with \"Messenger - Tel: <the customer mobile number exactly as the customer gave it in this conversation, ideally with the country code>\" - never invent or guess the number; if you do not have it, ask the customer before booking. Then \" | \" and the REAL customer full name exactly as stated in this conversation - NEVER write placeholder text. If the customer asked for a particular stylist or mentioned a useful detail for the team, add it after another \" | \". For a normal self-booking a separate caller name is NOT required - write only the customer full name. ONLY if this is a genuine third-party booking (an explicit relationship cue such as my daughter / mi hija / ma fille / my mother / mi madre, or an explicit statement the appointment is for someone else - NOT merely naming the customer) do you also include the real caller full name, formatted as: Messenger - Tel: <number> | Customer: <name> (<relationship>) | Contact: <caller name> (<relationship>)', 'string') }}";
const NEW_DESC_EXPR = "={{ $fromAI('new_description', 'Only if name/phone/reason is ALSO changing. Leave empty to keep the existing description. If you fill it, use the same format as Book_Appointment notes: Messenger - Tel: <mobile> | <customer full name> ...', 'string') }}";

// ------------------------------------------------------------------ build
function build() {
  const wa = load(WA_FILE);
  const wf = JSON.parse(JSON.stringify(wa));
  wf.name = NAME;
  wf.id = WF_ID;
  wf.active = false; // activate only after the Meta webhook and env vars are set up
  delete wf.versionId;
  wf.pinData = {};
  wf.tags = [];

  // WhatsApp-only intake, staff !unmute command and media lookup.
  for (const n of ['WhatsApp Trigger', 'Is Valid Staff Unmute?', 'Write Unmute Row', 'Confirm Unmute to Staff', 'Get Media URL', 'Groq HTTP Request (fallback, disabled)']) remove(wf, n);
  rename(wf, 'Send WhatsApp Reply', 'Send Messenger Reply');
  rename(wf, 'Rename to .ogg', 'Name Voice File');

  const at = (n) => must(wf, n).position;
  const [tx, ty] = [-9824, 3616]; // where the WhatsApp Trigger was

  // ---- receiver: verification handshake (GET) and signed events (POST)
  put(wf, { parameters: { httpMethod: 'GET', path: WEBHOOK_PATH, responseMode: 'responseNode', options: {} },
    name: 'Messenger Webhook (verify)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [tx - 1100, ty - 480] });
  put(wf, boolIf('Verify Token OK?', 'fb-verify-token',
    "={{ $json.query['hub.mode'] === 'subscribe' && !!$env.LUMIERE_MESSENGER_VERIFY_TOKEN && $json.query['hub.verify_token'] === $env.LUMIERE_MESSENGER_VERIFY_TOKEN }}", [tx - 880, ty - 480]));
  put(wf, { parameters: { respondWith: 'text', responseBody: "={{ $json.query['hub.challenge'] }}", options: { responseCode: 200 } },
    name: 'Respond: Challenge', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [tx - 660, ty - 560] });
  put(wf, { parameters: { respondWith: 'text', responseBody: 'Forbidden', options: { responseCode: 403 } },
    name: 'Respond: Forbidden', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [tx - 660, ty - 400] });
  put(wf, { parameters: { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'onReceived', options: { rawBody: true } },
    name: 'Messenger Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [tx - 1100, ty - 160] });
  put(wf, { parameters: { jsCode: VERIFY_CODE }, name: 'Verify Signature & Split', type: 'n8n-nodes-base.code', typeVersion: 2, position: [tx - 880, ty - 160] });
  put(wf, boolIf('Signed by Meta?', 'fb-signed', '={{ $json.rejected !== true }}', [tx - 660, ty - 160]));
  put(wf, { parameters: {}, name: 'Rejected - Bad Signature', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [tx - 440, ty - 60] });
  // Each patient message runs as its own execution of THIS workflow (entering
  // at "Messenger Event"), exactly like one WhatsApp webhook = one execution.
  put(wf, { parameters: { workflowId: { __rl: true, value: '={{ $workflow.id }}', mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: false } },
    name: 'Process Each Message', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [tx - 440, ty - 240] });
  put(wf, { parameters: { inputSource: 'passthrough' }, name: 'Messenger Event', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [tx, ty] });
  put(wf, { parameters: { content: '## Lumière Hair & Beauty Studio - Yasmine on Facebook Messenger\nSetup: see MESSENGER-SETUP.md.\n\nWebhook URL for Meta: `<n8n>/webhook/' + WEBHOOK_PATH + '`\nEnv: LUMIERE_MESSENGER_VERIFY_TOKEN, LUMIERE_MESSENGER_APP_SECRET (+ the existing LUMIERE_WHATSAPP_* / LUMIERE_STAFF_CHAT_ID for staff alerts).\nCredential: Header Auth "' + ENV.credentials.facebookPage.name + '".\n\nThe top row receives Meta webhooks; every message is then processed in its own execution starting at **Messenger Event**.\nGenerated by tools/build-messenger.js - do not edit by hand.', height: 300, width: 620 },
    name: 'Setup Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [tx - 1120, ty - 860] });

  // ---- intake
  must(wf, 'Dedup & Filter Prep').parameters.jsCode = DEDUP_CODE;
  must(wf, 'Match Pause Status').parameters.jsCode = MATCH_PAUSE_CODE;
  put(wf, { parameters: { url: '=' + GRAPH + "/{{ " + D + ".chatId }}?fields=first_name,last_name", authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: { timeout: 8000 } },
    name: 'Get Messenger Profile', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [at('Check Handoff Status')[0] - 40, at('Check Handoff Status')[1] + 200], credentials: PAGE_CRED, onError: 'continueRegularOutput' });

  // ---- voice: Messenger gives a direct CDN link (no token must be sent to it)
  put(wf, { parameters: { url: '={{ ' + D + '.mediaUrl }}', options: { timeout: 30000, response: { response: { responseFormat: 'file' } } } },
    name: 'Download Voice Binary', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: at('Download Voice Binary'), retryOnFail: true, onError: 'continueErrorOutput' });
  must(wf, 'Name Voice File').parameters.jsCode = NAME_VOICE_CODE;

  // ---- replies to the customer go out on Messenger
  const same = (n, text, extra) => put(wf, messengerSend(n, at(n), text, Object.assign({ onError: must(wf, n).onError }, extra || {})));
  const lit = (n) => JSON.stringify(must(wf, n).parameters.textBody);
  same('Send Voice Failed Reply', lit('Send Voice Failed Reply'));
  same('Send Unsupported Reply', lit('Send Unsupported Reply'));
  same('Send Fallback Reply', lit('Send Fallback Reply'));
  same('Send Messenger Reply', "$('Sanitize AI Output').first().json.replyPart1", { retryOnFail: true, waitBetweenTries: 1000 });
  const reply = at('Send Messenger Reply');
  put(wf, boolIf('Has Second Part?', 'fb-part2', "={{ !!$('Sanitize AI Output').first().json.replyPart2 }}", [reply[0] + 110, reply[1] - 180]));
  put(wf, messengerSend('Send Messenger Reply (part 2)', [reply[0] + 330, reply[1] - 260], "$('Sanitize AI Output').first().json.replyPart2", { retryOnFail: true, waitBetweenTries: 1000, onError: 'continueErrorOutput' }));

  const san = must(wf, 'Sanitize AI Output');
  san.parameters.jsCode = replaceOnce(san.parameters.jsCode, 'return [{\n  json: {\n    ...item,', SPLIT_SNIPPET + 'return [{\n  json: {\n    ...item,', 'sanitize return');
  san.parameters.jsCode = replaceOnce(san.parameters.jsCode, '    forcePause,\n  }\n}];', '    forcePause,\n    replyPart1,\n    replyPart2,\n  }\n}];', 'sanitize fields');

  // ---- staff alerts stay on WhatsApp (same staff number and credential)
  must(wf, 'Alert Staff - System Error').parameters.textBody = "={{ '⚠️ [Messenger] Technical problem - the bot could not reply to a customer on Facebook Messenger' + (" + PROFILE_NAME + " ? ' (' + " + PROFILE_NAME + " + ')' : '') + '. Their message: ' + (" + D + ".textBody || '(voice message)') + '. Messenger customer ' + " + D + ".customerKey + ' - please reply manually from the Facebook Page inbox.' }}";
  must(wf, 'Alert Staff - Pause Failed').parameters.textBody = "={{ '⚠️ [Messenger] Could not pause the bot for Messenger customer' + (" + PROFILE_NAME + " ? ' ' + " + PROFILE_NAME + " : '') + ' (' + " + D + ".customerKey + ') after escalation - please reply manually from the Facebook Page inbox and check the Active_Handoffs sheet.' }}";

  const esc = must(wf, 'Escalate to Staff');
  esc.parameters.toolDescription = replaceOnce(esc.parameters.toolDescription,
    "Note: calling this automatically pauses the bot for this customer until staff replies with '!unmute <customer phone number>'.",
    'Note: calling this automatically pauses the bot for this customer until staff re-enable it.', 'escalate description');
  esc.parameters.parametersHeaders.values.find((h) => h.name === 'Authorization').value = '=Bearer {{ $env.LUMIERE_WHATSAPP_ACCESS_TOKEN }}';
  esc.parameters.jsonBody = replaceOnce(esc.parameters.jsonBody,
    "'⚠️ ' + ($fromAI(", "'⚠️ [Messenger] ' + ($fromAI(", 'escalate prefix');
  esc.parameters.jsonBody = replaceOnce(esc.parameters.jsonBody,
    "'\\n\\nCustomer: ' + " + D + ".chatId + '\\n\\nTo re-enable the bot: !unmute ' + " + D + ".chatId",
    "'\\n\\nCustomer (Facebook Messenger): ' + (" + PROFILE_NAME + " || 'name unknown') + ' - ' + " + D + ".customerKey + '\\nLast message: ' + String(" + D + ".textBody || '(voice message)').slice(0, 300) + '\\n\\nReply from the Facebook Page inbox (Meta Business Suite).\\nTo re-enable the bot: Active_Handoffs sheet, row ' + " + D + ".customerKey + ' -> Status = unmuted'", 'escalate body');

  // ---- pause / log / memory keyed by the customer key fb:<page_id>:<PSID>
  must(wf, 'Write Pause Row').parameters.columns.value.Patient_ID = "={{ " + D + ".customerKey }}";
  const log = must(wf, 'Log Conversation').parameters.columns.value;
  log.Phone = "={{ " + D + ".customerKey + (" + PROFILE_NAME + " ? ' (' + " + PROFILE_NAME + " + ')' : '') }}";
  must(wf, 'Simple Memory').parameters.sessionKey = replaceOnce(must(wf, 'Simple Memory').parameters.sessionKey, '.first().json.chatId }}', '.first().json.customerKey }}', 'memory key');
  // ---- tools: the customer is the key only (Messenger reveals no phone number)
  for (const t of KEY_TOOLS.concat(['Run Confirmed Cancel', 'Run Confirmed Reschedule'])) {
    const v = must(wf, t).parameters.workflowInputs.value;
    if (v.customer_key !== CUSTOMER_KEY_EXPR) throw new Error('build-messenger: ' + t + ' has no server-set customer_key');
    v.phone_number = '';
  }

  // ---- AI Agent input, prompt and tool wording
  const agent = must(wf, 'AI Agent');
  agent.parameters.text = replaceOnce(agent.parameters.text, 'Customer WhatsApp number: {{ ' + D + '.chatId }}',
    'Channel: Facebook Messenger (the customer\'s phone number is not visible on this channel)', 'agent text');
  agent.parameters.options.systemMessage = patchPrompt(agent.parameters.options.systemMessage);
  const book = must(wf, 'Book_Appointment');
  book.parameters.description = replaceOnce(book.parameters.description, 'Always include their phone number in the description.',
    'On Messenger the customer\'s mobile number is never detected automatically: ask for it and always start the notes with it (see the notes field).', 'book description');
  book.parameters.workflowInputs.value.notes = NOTES_EXPR;
  must(wf, 'Reschedule_Appointment').parameters.workflowInputs.value.new_description = NEW_DESC_EXPR;
  const find = must(wf, 'Find_Patient_Appointments');
  find.parameters.description = replaceOnce(find.parameters.description, 'By default this searches automatically using the current WhatsApp number',
    'By default this searches automatically for appointments booked from this Messenger conversation', 'find description');
  find.parameters.description = replaceOnce(find.parameters.description, 'If the customer says an appointment was booked from a different phone number, on another channel or by someone else,',
    'If the customer says an appointment was booked on WhatsApp, by phone, from another account or by someone else (not from this Messenger conversation),', 'find description 2');
  const cancel = must(wf, 'Cancel_Appointment');
  cancel.parameters.description = replaceOnce(cancel.parameters.description, 'The current WhatsApp number is detected and used automatically for a normal cancellation.',
    'This Messenger conversation is detected and used automatically for a normal cancellation.', 'cancel description');
  // booked_phone_number is fixed empty on every AI tool (a typed number is never proof of ownership).
  for (const t of ['Find_Patient_Appointments', 'Cancel_Appointment', 'Reschedule_Appointment']) {
    if (must(wf, t).parameters.workflowInputs.value.booked_phone_number !== '') throw new Error('build-messenger: ' + t + ' lets the AI set booked_phone_number');
  }
  for (const t of ['Cancel_Appointment', 'Reschedule_Appointment']) {
    const d = must(wf, t).parameters;
    d.description = replaceOnce(d.description, 'If the customer says the appointment was booked from a different phone number, on another channel or by someone else,',
      'If the customer says the appointment was not booked from this Messenger conversation (WhatsApp, phone call, another account, someone else),', t + ' description');
  }
  must(wf, 'Reschedule_Appointment').parameters.description = replaceOnce(must(wf, 'Reschedule_Appointment').parameters.description,
    'Phone number detected automatically.', 'This Messenger conversation is detected automatically.', 'reschedule phone');

  // ---- wiring
  conn(wf, 'Messenger Webhook (verify)', [['Verify Token OK?']]);
  conn(wf, 'Verify Token OK?', [['Respond: Challenge'], ['Respond: Forbidden']]);
  conn(wf, 'Messenger Webhook', [['Verify Signature & Split']]);
  conn(wf, 'Verify Signature & Split', [['Signed by Meta?']]);
  conn(wf, 'Signed by Meta?', [['Process Each Message'], ['Rejected - Bad Signature']]);
  conn(wf, 'Messenger Event', [['Dedup & Filter Prep']]);
  conn(wf, 'Dedup & Filter Prep', [['Chat Lock: Acquire']]);
  conn(wf, 'Chat Lock Acquired', [['Get Messenger Profile'], ['Send Fallback Reply']]);
  conn(wf, 'Get Messenger Profile', [['Check Handoff Status']]);
  conn(wf, 'Message Type Router', [['Merge Text Message'], ['Download Voice Binary'], ['Send Unsupported Reply']]);
  conn(wf, 'Download Voice Binary', [['Name Voice File'], ['Send Voice Failed Reply']]);
  conn(wf, 'Send Messenger Reply', [['Has Second Part?'], ['Alert Staff - System Error']]);
  conn(wf, 'Has Second Part?', [['Send Messenger Reply (part 2)'], ['Log Conversation']]);
  conn(wf, 'Send Messenger Reply (part 2)', [['Log Conversation'], ['Alert Staff - System Error']]);

  // Fresh, deterministic node ids and webhook ids (n8n webhook ids must be
  // unique across the instance - never reuse the WhatsApp workflow's).
  for (const n of wf.nodes) {
    n.id = uuid(NAME + '/' + n.name);
    const hook = ['n8n-nodes-base.webhook', 'n8n-nodes-base.wait', 'n8n-nodes-base.whatsApp'].indexOf(n.type) >= 0;
    if (hook) n.webhookId = uuid(NAME + '/' + n.name + '/webhook'); else delete n.webhookId;
  }
  return require('./build-workflows.js').pinOutputs(wf); // node lookups pinned to output 0 (see build-workflows.js)
}

if (require.main === module) {
  const next = dump(build());
  const file = path.join(ROOT, OUT_FILE);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (process.argv.includes('--check')) {
    console.log(prev === next ? 'messenger workflow up to date' : 'WOULD CHANGE: ' + OUT_FILE);
    if (prev !== next) process.exit(1);
  } else if (prev !== next) { fs.writeFileSync(file, next); console.log('updated: ' + OUT_FILE); } else console.log('messenger workflow up to date');
}
// The Instagram build (tools/build-instagram.js) derives from this one and reuses these pieces.
module.exports = { build, OUT_FILE, NAME, WF_ID, WEBHOOK_PATH, WA_FILE, MESSENGER_MAX_CHARS, GRAPH, D, PROFILE_NAME, VERIFY_CODE, SPLIT_SNIPPET, MESSENGER_RULES,
  helpers: { uuid, load, dump, byName, must, replaceOnce, walkStrings, remove, rename, conn, put, boolIf } };
