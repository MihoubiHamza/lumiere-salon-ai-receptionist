#!/usr/bin/env node
'use strict';
// Builds the Instagram Direct version of Yasmine. It is derived from the
// Messenger build (tools/build-messenger.js), which is itself generated from the
// WhatsApp main workflow, so prompt rules, tools, the confirmation gate, the
// chat-lock engine and the safety checks stay identical on every channel. This
// script only READS other files; it writes one file: OUT_FILE.
// Re-run it after every change to the WhatsApp or Messenger build
// (tests/instagram.test.js fails while the Instagram file is out of date).
//
// Usage: node tools/build-instagram.js [--check]   (--check: fail if the file would change)
//
// Instagram messaging uses the Messenger Platform ("Instagram API with Facebook
// Login"): an Instagram professional account linked to the salon's Facebook
// Page, a Page access token with instagram_manage_messages, Send API POST
// /me/messages on graph.facebook.com, and webhooks of object "instagram".
// What is Instagram-specific here:
//   - its OWN webhook path (the Messenger webhook and subscriptions are untouched),
//     its own verify token, App Secret variable and token credential;
//   - only events for the salon's own Instagram account (LUMIERE_INSTAGRAM_ACCOUNT_ID);
//   - customer key "ig:<instagram_account_id>:<igsid>" (never shared with WhatsApp,
//     Messenger, another account or the website demo);
//   - TEXT ONLY: voice messages and every attachment get a friendly reply, the
//     voice pipeline is not part of this workflow;
//   - replies split to Instagram's text limit (bytes, see IG_MAX_BYTES);
//   - Meta's 24-hour standard messaging window is enforced before every send;
//   - automated-assistant disclosure on the first reply of a conversation window.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV = require(path.join(ROOT, 'lumiere.config.js'));
const MB = require('./build-messenger.js');
const WB = require('./build-workflows.js');
const { uuid, load, dump, byName, must, replaceOnce, walkStrings, remove, rename, conn, put, boolIf } = MB.helpers;

const OUT_FILE = 'Lumiere Instagram AI Agent.json';
const NAME = 'Lumière Instagram AI Agent';
const WF_ID = ENV.workflows.instagram;
const WEBHOOK_PATH = ENV.INSTAGRAM_WEBHOOK_PATH;
const GRAPH = MB.GRAPH;
const SEND_URL = GRAPH + '/me/messages';
const IG_CRED = { httpHeaderAuth: ENV.credentials.instagram };
// Meta's Instagram Send API page states BOTH "less than 1,000 characters" and
// "1,000 bytes or less" (UTF-8). Both are enforced with a margin: every part is at
// most 990 UTF-8 bytes (so also fewer than 1,000 characters).
const IG_MAX_BYTES = 990;
const IG_MAX_PARTS = 8; // the AI output is capped at 2800 characters (Sanitize); 8 x 990 bytes covers it in Arabic
// Standard messaging window: a reply may only be sent within 24 h of the customer's
// message. 5 minutes of margin for clock skew between Meta and n8n.
const WINDOW_MS = 24 * 3600000 - 5 * 60000;
const D = MB.D;

// ------------------------------------------------------------------ texts
const SALON = WB.SALON;
const TAG = '🤖 ' + SALON.name + ' - automated assistant';
// First reply of a conversation window: who is answering, and that a person is available.
const DISCLOSURE = {
  en: "🤖 Hi, I'm Yasmine, the automated AI assistant of " + SALON.name + '. I can answer questions and manage appointments. Ask for "a person" at any time to reach the salon team.',
  fr: "🤖 Bonjour, je suis Yasmine, l'assistante automatique (IA) de " + SALON.name + ". Je réponds à vos questions et je gère vos rendez-vous. Demandez « une personne » à tout moment pour joindre l'équipe du salon.",
  es: '🤖 Hola, soy Yasmine, la asistente automática (IA) de ' + SALON.name + '. Respondo a tus preguntas y gestiono tus citas. Pide hablar con «una persona» cuando quieras para contactar con el equipo del salón.',
  ar: '🤖 مرحباً، أنا ياسمين، المساعدة الآلية (ذكاء اصطناعي) لـ' + SALON.name_ar + '. أجيب عن أسئلتك وأدير مواعيدك. اطلب التحدث إلى «شخص» في أي وقت للتواصل مع فريق الصالون.',
};
const UNSUPPORTED_TEXT = TAG + '\n' +
  'Sorry 🙏 on Instagram I can only read typed text messages for now - please write your message.\n' +
  'Lo siento 🙏 en Instagram por ahora solo puedo leer mensajes de texto: escríbeme tu mensaje.\n' +
  "Désolée 🙏 sur Instagram je ne lis pour l'instant que les messages écrits : écrivez-moi votre message.\n" +
  'عذراً 🙏 على إنستغرام يمكنني حالياً قراءة الرسائل النصية فقط، يرجى كتابة رسالتك.';

// ------------------------------------------------------------------ Code nodes
// Signature check: the HMAC-SHA256 / SHA-256 implementation is copied verbatim from
// the Messenger build (tested against Node crypto there and in tests/instagram.test.js).
const LIB = (() => {
  const a = MB.VERIFY_CODE.indexOf('const K = ['), b = MB.VERIFY_CODE.indexOf("const sig = String(headers['x-hub-signature-256']");
  if (a < 0 || b < a) throw new Error('build-instagram: Messenger signature code changed; update tools/build-instagram.js');
  return MB.VERIFY_CODE.slice(a, b);
})();
const VERIFY_CODE = `// Verifies Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the App
// Secret) and splits an Instagram webhook into one item per customer message
// (Meta may batch several events into one request).
// Env: LUMIERE_INSTAGRAM_APP_SECRET (required), LUMIERE_INSTAGRAM_ACCOUNT_ID (required:
// only events for the salon's own Instagram professional account are processed).
const APP_SECRET = String($env.LUMIERE_INSTAGRAM_APP_SECRET || '');
const ACCOUNT_ID = String($env.LUMIERE_INSTAGRAM_ACCOUNT_ID || '');
const item = $input.first();
const req = (item && item.json) || {};
const headers = req.headers || {};
const body = req.body && typeof req.body === 'object' ? req.body : {};

` + LIB + `const sig = String(headers['x-hub-signature-256'] || '').trim().toLowerCase();
let reason = '';
if (!APP_SECRET) reason = 'LUMIERE_INSTAGRAM_APP_SECRET is not set - every request is rejected until it is';
else if (!/^\\d{5,25}$/.test(ACCOUNT_ID)) reason = 'LUMIERE_INSTAGRAM_ACCOUNT_ID is not set - every request is rejected until it is';
else if (!/^sha256=[0-9a-f]{64}$/.test(sig)) reason = 'missing or malformed X-Hub-Signature-256 header';
else {
  const want = sig.slice(7);
  const ok = candidates(await rawBody.call(this)).some((bytes) => sameHex(hmacHex(APP_SECRET, bytes), want));
  if (!ok) reason = 'signature does not match (wrong App Secret, or the request did not come from Meta)';
}
if (reason) return [{ json: { rejected: true, reason } }];

// Only customer messages and postbacks for the salon's own account. Echoes (the
// account's own replies, including what staff send from the Instagram inbox), read
// receipts, reactions, referrals, standby events and malformed entries are ignored.
const out = [];
if (body.object === 'instagram' && Array.isArray(body.entry)) {
  for (const entry of body.entry) {
    if (!entry || typeof entry !== 'object' || String(entry.id == null ? '' : entry.id) !== ACCOUNT_ID) continue;
    for (const ev of Array.isArray(entry.messaging) ? entry.messaging : []) {
      if (!ev || typeof ev !== 'object' || !ev.sender || typeof ev.sender !== 'object' || ev.sender.id == null) continue;
      if (String(ev.sender.id) === ACCOUNT_ID) continue;
      if (ev.message != null && (typeof ev.message !== 'object' || ev.message.is_echo)) continue;
      if (!ev.message && !ev.postback) continue;
      out.push({ json: { event: ev, accountId: ACCOUNT_ID } });
    }
  }
}
return out;
`;

const DEDUP_CODE = `// Instagram intake: same output shape as the WhatsApp / Messenger versions so every
// later node works unchanged. chatId is the sender's Instagram-scoped ID (IGSID),
// used to reply. customerKey = "ig:<instagram_account_id>:<igsid>" is the verified,
// channel-aware customer identity (chat lock, confirmations, memory, pause row,
// appointment owner): it can never equal a WhatsApp number, a Messenger user, the
// same IGSID on another account, or a website demo session.
// TEXT ONLY for now: voice messages and attachments get the "unsupported" reply.
// Staff alerts go to staff on WhatsApp:
//   LUMIERE_WHATSAPP_PHONE_NUMBER_ID, LUMIERE_WHATSAPP_ACCESS_TOKEN, LUMIERE_STAFF_CHAT_ID
const CONFIG = {
  phoneNumberId: $env.LUMIERE_WHATSAPP_PHONE_NUMBER_ID || '',
  staffChatId:   $env.LUMIERE_STAFF_CHAT_ID || '',
};

const staticData = $getWorkflowStaticData('node');
if (!staticData.processedIds) staticData.processedIds = [];

const j = $input.first().json || {};
const ev = j.event && typeof j.event === 'object' ? j.event : null;
if (!ev || !ev.sender || typeof ev.sender !== 'object') return [];
const igsid = String(ev.sender.id == null ? '' : ev.sender.id);
const accountId = String(j.accountId == null ? '' : j.accountId);
// Malformed ids, the account's own messages, or a message addressed to another account: drop.
if (!/^\\d{5,25}$/.test(igsid) || !/^\\d{5,25}$/.test(accountId) || igsid === accountId) return [];
if (ev.recipient && ev.recipient.id != null && String(ev.recipient.id) !== accountId) return [];
const customerKey = 'ig:' + accountId + ':' + igsid;
const msg = ev.message && typeof ev.message === 'object' ? ev.message : null;
const postback = ev.postback && typeof ev.postback === 'object' ? ev.postback : null;
if (!msg && !postback) return [];
if (msg && (msg.is_echo || msg.is_deleted)) return [];

const msgId = String((msg && msg.mid) || (postback && postback.mid) || '');
// Instagram timestamps are in milliseconds. A message without id or time is malformed.
const msgTimestamp = Number(ev.timestamp);
if (!msgId || !Number.isFinite(msgTimestamp) || msgTimestamp <= 0) return [];

const atts = (msg && Array.isArray(msg.attachments)) ? msg.attachments.filter((a) => a && typeof a === 'object') : [];
// Someone mentioning the salon in their story is not a message to answer.
if (msg && !(typeof msg.text === 'string' && msg.text.trim()) && atts.some((a) => a.type === 'story_mention')) return [];

let shouldProcess = true;
let reason = 'ok';

if (staticData.processedIds.includes(msgId)) {
  shouldProcess = false;
  reason = 'duplicate delivery - already processed';
}

// Staleness check: drop messages delivered very late (queued webhook retry)
const ageMs = Date.now() - msgTimestamp;
const STALE_THRESHOLD_MS = 3 * 60 * 1000;
if (shouldProcess && ageMs > STALE_THRESHOLD_MS) {
  shouldProcess = false;
  reason = \`message is stale (\${Math.round(ageMs / 1000)}s old) - likely a delayed webhook retry, skipping\`;
}

if (shouldProcess) {
  staticData.processedIds.push(msgId);
  if (staticData.processedIds.length > 300) staticData.processedIds.shift();
}

if (!shouldProcess) {
  return [];
}

// Typed text (also a story reply or a quick-reply tap) and postback buttons are read.
// Everything else - audio / voice, image, video, file, share, reel, ephemeral,
// is_unsupported - gets the polite "text only" reply.
let messageType = 'unsupported';
let textBody = '';
if (msg && typeof msg.text === 'string' && msg.text.trim()) {
  messageType = 'text';
  textBody = msg.text.slice(0, 2000);
} else if (postback) {
  messageType = 'text';
  textBody = String(postback.title || postback.payload || '').trim().slice(0, 200) || 'Hello';
}

return [{
  json: {
    ...CONFIG,
    channel: 'instagram',
    shouldProcess,
    reason,
    isUnmuteCommand: false,
    unmuteTargetPhone: '',
    chatId: igsid,
    igsid,
    accountId,
    customerKey,
    senderName: '',
    messageType,
    textBody,
    hasMedia: atts.length > 0,
    mediaId: '',
    mediaUrl: '',
    messageId: msgId,
    msgTs: msgTimestamp,
  }
}];
`;

const MATCH_PAUSE_CODE = `// Instagram pause rows are written as the customer key "ig:<account_id>:<IGSID>"
// (text, so Google Sheets never rounds it). Only that exact key pauses this
// customer: never a WhatsApp number, a Messenger row or another account's row.
// Staff re-enable the bot by setting Status to anything other than "paused"
// (e.g. "unmuted") or deleting the row.
// The Sheets read failed: its error branch answers and releases the lock - never continue here too
// (Check Handoff Status has "Always Output Data", so n8n also sends an empty item here; see build-workflows.js).
if ($('Check Handoff Status').all(1).length) return [];
const key = $('Dedup & Filter Prep').first().json.customerKey;
let isPaused = false;

for (const row of $input.all()) {
  if (String(row.json.Patient_ID || '').trim() === key && String(row.json.Status || '').trim() === 'paused') {
    isPaused = true;
    break;
  }
}

return [{ json: { ...$('Dedup & Filter Prep').first().json, isPaused } }];
`;

// Replaces the Messenger 2-part split in Sanitize AI Output.
const SPLIT_CODE = `// Instagram: (1) on the first reply of a conversation window (no message from this
// customer in the last 24 h) the reply starts with a short disclosure that this is
// an automated assistant and that a person can be asked for; (2) Instagram rejects
// text over its limit, so the reply is sent in parts of at most ${IG_MAX_BYTES} UTF-8 bytes
// (fewer than 1,000 characters too), split at a line break or space, never inside
// a character or emoji, in order, nothing lost.
const IG_DISCLOSURE = ${JSON.stringify(DISCLOSURE)};
let igLang = 'en';
try { igLang = $('Confirmation Output').first().json.lang || 'en'; } catch (e) { igLang = 'en'; }
const igLastTs = Number((($('Chat Lock Acquired').first() || {}).json || {}).lastTs || 0);
const igThisTs = Number($('Dedup & Filter Prep').first().json.msgTs || 0);
const igDisclosure = (!igLastTs || igThisTs - igLastTs > 24 * 3600000) ? (IG_DISCLOSURE[igLang] || IG_DISCLOSURE.en) : '';
const IG_MAX_BYTES = ${IG_MAX_BYTES}, IG_MAX_PARTS = ${IG_MAX_PARTS};
const igBytes = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
function igSplit(text) {
  const parts = [];
  let rest = String(text).trim();
  while (rest) {
    const cps = Array.from(rest);
    let b = 0, n = 0;
    while (n < cps.length && b + igBytes(cps[n].codePointAt(0)) <= IG_MAX_BYTES) { b += igBytes(cps[n].codePointAt(0)); n++; }
    if (n >= cps.length) { parts.push(rest); break; }
    let head = cps.slice(0, n).join('');
    let cut = head.lastIndexOf('\\n');
    if (cut < head.length / 2) cut = head.lastIndexOf(' ');
    if (cut >= head.length / 2) head = head.slice(0, cut);
    parts.push(head.trimEnd());
    rest = rest.slice(head.length).trim();
  }
  return parts.filter(Boolean);
}
let replyParts = igSplit(igDisclosure ? igDisclosure + '\\n\\n' + finalOutput : finalOutput);
if (replyParts.length > IG_MAX_PARTS) replyParts = igSplit((igDisclosure ? igDisclosure + '\\n\\n' : '') + technicalFallback);

`;

// ------------------------------------------------------------------ prompt
const IG_RULES = `

## INSTAGRAM DIRECT CHANNEL (READ FIRST - OVERRIDES ANY CONFLICTING RULE BELOW)
- You are chatting with the customer through the salon's Instagram professional account (Instagram Direct messages). Instagram does NOT reveal the customer's phone number.
- YOU ARE AN AUTOMATED AI ASSISTANT: never claim or imply that you are a human. If the customer asks, say plainly that you are the salon's automated assistant. Whenever the customer asks for a real person, a human or the team, call Escalate_to_Staff.
- WHO OWNS AN APPOINTMENT: every appointment you book here is automatically linked to THIS Instagram conversation by the system - you never pass, mention or ask for any ID. Find_Patient_Appointments, Cancel_Appointment and Reschedule_Appointment automatically find the appointments booked from this same Instagram conversation. Wherever the rules below or a tool result say "the current WhatsApp number", "this WhatsApp number" or "the number you are texting from", read it as "this Instagram conversation".
- CONTACT MOBILE NUMBER IS REQUIRED FOR EVERY INSTAGRAM BOOKING: before calling Book_Appointment you must also have the customer's mobile number, stated by the customer in this conversation (a real mobile number: 9 to 15 digits, ideally with the country code). Ask for it together with the other missing details, and only once - if they already gave it, never ask again. Put it in the notes exactly as the Book_Appointment notes field describes. The salon uses it to contact the customer.
- APPOINTMENTS BOOKED ELSEWHERE: appointments booked on WhatsApp, on Facebook Messenger, by phone call, at the salon, from another Instagram account or by someone else can NEVER be found, shown or changed from here, and a phone number or name the customer types is never proof that an appointment is theirs. Never ask for that number and never search for it. Tell the customer plainly that you can only manage the appointments booked from this conversation (they can also manage it from where it was booked), and call Escalate_to_Staff so a team member can help.
- TEXT ONLY: on Instagram you can only read typed text messages. Voice messages, photos, videos, stickers, reels and shared posts are not read (the system answers those itself). Never offer, mention or ask for voice notes on Instagram.
- Instagram shows plain text only: never use markdown such as *bold*, _italic_ or # headings.`;

// Messenger -> Instagram wording in every non-code string of the workflow.
function tx(s) {
  return s
    .split('Facebook Page inbox (Meta Business Suite)').join('Instagram inbox (Meta Business Suite)')
    .split('Facebook Page inbox').join('Instagram inbox (Meta Business Suite)')
    .split('Facebook Messenger').join('Instagram')
    .split('FACEBOOK MESSENGER').join('INSTAGRAM DIRECT')
    .split('Facebook account').join('Instagram account')
    .split('Messenger').join('Instagram');
}
// The voice-note marker of the AI Agent input (Instagram has no voice path).
const VOICE_MARKER = /\{\{ \$\('Dedup & Filter Prep'\)\.first\(\)\.json\.messageType === 'voice' \? '(?:[^'\\]|\\.)*' : '' \}\}/;

function igSend(name, pos, textExpr, extra) {
  return Object.assign({ parameters: {
    method: 'POST', url: SEND_URL,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ recipient: { id: " + D + ".chatId }, message: { text: " + textExpr + " } }) }}",
    options: { timeout: 15000 },
  }, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: IG_CRED }, extra || {});
}
const incoming = (wf, target) => {
  const out = [];
  for (const src of Object.keys(wf.connections)) for (const type of Object.keys(wf.connections[src])) (wf.connections[src][type] || []).forEach((outs, i) => (outs || []).forEach((c) => { if (c.node === target) out.push({ src, type, i, c }); }));
  return out;
};
const WINDOW_EXPR = "={{ Number(" + D + ".msgTs) > 0 && Date.now() - Number(" + D + ".msgTs) < " + WINDOW_MS + " }}";
// Every message to the customer passes a 24-hour-window guard first. When the window
// is closed nothing is sent; the run continues where a sent message would have
// continued (staff alert / log / lock release), so the lock is always released.
function guardWindow(wf, sendName, closedTargets) {
  const g = '24h Window Open? (' + sendName + ')', skip = 'Not Sent - 24h Window Closed (' + sendName + ')';
  const pos = must(wf, sendName).position;
  for (const x of incoming(wf, sendName)) x.c.node = g;
  put(wf, boolIf(g, 'ig-window-' + uuid(sendName).slice(0, 8), WINDOW_EXPR, [pos[0] - 120, pos[1] + 140]));
  put(wf, { parameters: {}, name: skip, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [pos[0] + 100, pos[1] + 220] });
  conn(wf, g, [[sendName], [skip]]);
  conn(wf, skip, [closedTargets]);
}

// ------------------------------------------------------------------ build
function build() {
  const wf = MB.build();
  wf.name = NAME;
  wf.id = WF_ID;
  wf.active = false; // activate only after the Meta webhook and env vars are set up
  wf.pinData = {};
  wf.tags = [];

  // ---- Instagram has no voice path: remove it (and the Messenger split nodes, rebuilt below).
  for (const n of ['Download Voice Binary', 'Name Voice File', 'Cohere Transcribe', 'Merge Voice Text', 'Send Voice Failed Reply', 'Has Second Part?', 'Send Messenger Reply (part 2)']) remove(wf, n);
  rename(wf, 'Messenger Webhook (verify)', 'Instagram Webhook (verify)');
  rename(wf, 'Messenger Webhook', 'Instagram Webhook');
  rename(wf, 'Messenger Event', 'Instagram Event');
  rename(wf, 'Send Messenger Reply', 'Send Instagram Reply');
  rename(wf, 'Get Messenger Profile', 'Get Instagram Profile');
  const at = (n) => must(wf, n).position;

  // ---- receiver: own path, own verify token / secret / account
  for (const n of ['Instagram Webhook (verify)', 'Instagram Webhook']) must(wf, n).parameters.path = WEBHOOK_PATH;
  const vt = must(wf, 'Verify Token OK?').parameters.conditions.conditions[0];
  vt.leftValue = replaceOnce(replaceOnce(vt.leftValue, '!!$env.LUMIERE_MESSENGER_VERIFY_TOKEN', '!!$env.LUMIERE_INSTAGRAM_VERIFY_TOKEN', 'verify token 1'),
    "=== $env.LUMIERE_MESSENGER_VERIFY_TOKEN", "=== $env.LUMIERE_INSTAGRAM_VERIFY_TOKEN", 'verify token 2');
  must(wf, 'Verify Signature & Split').parameters.jsCode = VERIFY_CODE;
  must(wf, 'Setup Note').parameters.content = '## ' + SALON.name + ' - Yasmine on Instagram Direct\nSetup: see INSTAGRAM-SETUP.md.\n\nWebhook URL for Meta (object "instagram", field "messages"): `<n8n>/webhook/' + WEBHOOK_PATH + '`\nEnv: LUMIERE_INSTAGRAM_VERIFY_TOKEN, LUMIERE_INSTAGRAM_APP_SECRET, LUMIERE_INSTAGRAM_ACCOUNT_ID (+ LUMIERE_WHATSAPP_* / LUMIERE_STAFF_CHAT_ID for staff alerts).\nCredential: Header Auth "' + ENV.credentials.instagram.name + '" (Page token with instagram_manage_messages).\n\nText only. Replies only inside the 24-hour window. Every message is processed in its own execution starting at **Instagram Event**.\nGenerated by tools/build-instagram.js - do not edit by hand.';

  // ---- intake
  must(wf, 'Dedup & Filter Prep').parameters.jsCode = DEDUP_CODE;
  must(wf, 'Match Pause Status').parameters.jsCode = MATCH_PAUSE_CODE;
  const prof = must(wf, 'Get Instagram Profile');
  prof.parameters.url = '=' + GRAPH + "/{{ " + D + ".chatId }}?fields=name,username";
  prof.credentials = IG_CRED;
  conn(wf, 'Message Type Router', [['Merge Text Message'], ['Send Unsupported Reply'], ['Send Unsupported Reply']]);
  // Only typed text reaches the confirmation gate (no voice path on Instagram).
  const gate = must(wf, 'Confirmation Gate');
  gate.parameters.jsCode = replaceOnce(gate.parameters.jsCode, "try { viaVoice = $('Merge Voice Text').isExecuted === true; } catch (e) { viaVoice = false; } // the website has no voice path",
    '// Instagram is text only (no voice path): viaVoice stays false', 'gate voice check');
  for (const n of ['Run Confirmed Cancel', 'Run Confirmed Reschedule']) must(wf, n).parameters.workflowInputs.value.confirm_via = 'text';

  // ---- profile name: Instagram gives name and username
  const PN_IG = "($('Get Instagram Profile').isExecuted ? String($('Get Instagram Profile').first().json.name || ($('Get Instagram Profile').first().json.username ? '@' + $('Get Instagram Profile').first().json.username : '')) : '')";
  const PN_OLD = MB.PROFILE_NAME.split("$('Get Messenger Profile')").join("$('Get Instagram Profile')");
  for (const n of wf.nodes) n.parameters = walkStrings(n.parameters, (s) => s.split(PN_OLD).join(PN_IG));

  // ---- Messenger -> Instagram wording (all non-code strings; code nodes are replaced or channel-neutral)
  const IS_CODE = (n) => n.type === 'n8n-nodes-base.code';
  const agent = must(wf, 'AI Agent');
  agent.parameters.options.systemMessage = replaceOnce(agent.parameters.options.systemMessage, MB.MESSENGER_RULES, IG_RULES, 'instagram rules');
  for (const n of wf.nodes) if (!IS_CODE(n)) n.parameters = walkStrings(n.parameters, tx);
  if (!VOICE_MARKER.test(agent.parameters.text)) throw new Error('build-instagram: AI Agent text has no voice-note marker');
  agent.parameters.text = agent.parameters.text.replace(VOICE_MARKER, '');
  agent.parameters.text = replaceOnce(agent.parameters.text, "Channel: Instagram (the customer's phone number is not visible on this channel)",
    "Channel: Instagram Direct, text only (the customer's phone number is not visible on this channel)", 'agent channel');
  must(wf, 'Simple Memory').parameters.sessionKey = "={{ " + D + ".customerKey }}_v1_lumiere_salon"; // ig:<account>:<igsid>_v1_...
  const esc = must(wf, 'Escalate to Staff');
  esc.parameters.jsonBody = replaceOnce(esc.parameters.jsonBody, "Reply from the Instagram inbox (Meta Business Suite).", "Reply from the Instagram inbox (Meta Business Suite) within 24 h of the customer\\'s last message.", 'escalate 24h');

  // ---- replies: own credential, no Messenger-only fields, literal texts for Instagram
  const lit = (t) => JSON.stringify(t);
  const waFallback = must(load(MB.WA_FILE), 'Send Fallback Reply').parameters.textBody;
  put(wf, igSend('Send Unsupported Reply', at('Send Unsupported Reply'), lit(UNSUPPORTED_TEXT), { onError: 'continueRegularOutput' }));
  put(wf, igSend('Send Fallback Reply', at('Send Fallback Reply'), lit(TAG + '\n' + waFallback), { onError: 'continueRegularOutput' }));
  put(wf, igSend('Send Instagram Reply', at('Send Instagram Reply'), "$('Sanitize AI Output').first().json.replyParts[0]", { retryOnFail: true, waitBetweenTries: 1000, onError: 'continueErrorOutput' }));
  const san = must(wf, 'Sanitize AI Output');
  san.parameters.jsCode = replaceOnce(san.parameters.jsCode, MB.SPLIT_SNIPPET, SPLIT_CODE, 'instagram split');
  san.parameters.jsCode = replaceOnce(san.parameters.jsCode, '    replyPart1,\n    replyPart2,\n', '    replyParts,\n    disclosed: !!igDisclosure,\n', 'instagram split fields');

  // ---- part chain: Send Instagram Reply -> Has Part 2? -> part 2 -> ... -> Log Conversation
  const r0 = at('Send Instagram Reply');
  const partNode = (k) => (k === 1 ? 'Send Instagram Reply' : 'Send Instagram Reply (part ' + k + ')');
  for (let k = 2; k <= IG_MAX_PARTS; k++) {
    put(wf, boolIf('Has Part ' + k + '?', 'ig-part' + k, "={{ !!($('Sanitize AI Output').first().json.replyParts || [])[" + (k - 1) + "] }}", [r0[0] + 220 * (k - 1) - 110, r0[1] - 180]));
    put(wf, igSend(partNode(k), [r0[0] + 220 * (k - 1), r0[1] - 260], "$('Sanitize AI Output').first().json.replyParts[" + (k - 1) + ']', { retryOnFail: true, waitBetweenTries: 1000, onError: 'continueErrorOutput' }));
  }
  for (let k = 1; k <= IG_MAX_PARTS; k++) {
    conn(wf, partNode(k), [[k < IG_MAX_PARTS ? 'Has Part ' + (k + 1) + '?' : 'Log Conversation'], ['Alert Staff - System Error']]);
    if (k >= 2) conn(wf, 'Has Part ' + k + '?', [[partNode(k)], ['Log Conversation']]);
  }

  // ---- 24-hour standard messaging window, before every message to the customer
  guardWindow(wf, 'Send Instagram Reply', ['Log Conversation']);
  guardWindow(wf, 'Send Fallback Reply', ['Alert Staff - System Error']);
  guardWindow(wf, 'Send Unsupported Reply', ['Chat Lock: Release']);

  // ---- wiring of the receiver
  conn(wf, 'Instagram Webhook (verify)', [['Verify Token OK?']]);
  conn(wf, 'Instagram Webhook', [['Verify Signature & Split']]);
  conn(wf, 'Instagram Event', [['Dedup & Filter Prep']]);

  // ---- nothing Messenger / Facebook-specific may be left
  const leftovers = [];
  for (const n of wf.nodes) {
    if (/Messenger|messenger/.test(n.name)) leftovers.push(n.name);
    // Non-code strings: no Messenger / Facebook wording at all. Code nodes: no Messenger identifiers.
    const text = JSON.stringify(n.parameters).split('on Facebook Messenger').join('');
    for (const s of text.match(IS_CODE(n) ? /LUMIERE_MESSENGER|'fb:'|\bfb_|first_name|object === 'page'/g : /Messenger|Facebook|LUMIERE_MESSENGER|\bfb[:_]/g) || []) leftovers.push(n.name + ': ' + s);
    for (const c of Object.values(n.credentials || {})) if (c.id === ENV.credentials.facebookPage.id) leftovers.push(n.name + ': Facebook Page credential');
  }
  if (leftovers.length) throw new Error('build-instagram: Messenger leftovers: ' + leftovers.join(', '));

  // Fresh, deterministic node ids and webhook ids (n8n webhook ids must be unique across the instance).
  for (const n of wf.nodes) {
    n.id = uuid(NAME + '/' + n.name);
    const hook = ['n8n-nodes-base.webhook', 'n8n-nodes-base.wait', 'n8n-nodes-base.whatsApp'].indexOf(n.type) >= 0;
    if (hook) n.webhookId = uuid(NAME + '/' + n.name + '/webhook'); else delete n.webhookId;
  }
  return WB.pinOutputs(wf);
}

if (require.main === module) {
  const next = dump(build());
  const file = path.join(ROOT, OUT_FILE);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (process.argv.includes('--check')) {
    console.log(prev === next ? 'instagram workflow up to date' : 'WOULD CHANGE: ' + OUT_FILE);
    if (prev !== next) process.exit(1);
  } else if (prev !== next) { fs.writeFileSync(file, next); console.log('updated: ' + OUT_FILE); } else console.log('instagram workflow up to date');
}
module.exports = { build, OUT_FILE, NAME, WF_ID, WEBHOOK_PATH, IG_MAX_BYTES, IG_MAX_PARTS, WINDOW_MS, SEND_URL, DISCLOSURE, UNSUPPORTED_TEXT, TAG };
