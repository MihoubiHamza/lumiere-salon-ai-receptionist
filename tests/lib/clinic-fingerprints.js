'use strict';
// Identifiers of the OTHER bots on the same n8n instance, which must never appear
// in the Lumière files.
// The real values (calendars, sheet, credential/workflow ids, webhook paths, lock ids,
// phone numbers, folder names, name patterns) belong to another client. They live in
// the git-ignored clinic-fingerprints.local.json next to this file, never in the repo.
// Without that file the checks still run: on the generic rules, on the salon's own
// resources and on everything found by scanning the folders it lists (read-only).
const fs = require('fs');
const path = require('path');

const LOCAL = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'clinic-fingerprints.local.json'), 'utf8')); } catch (e) { return {}; }
})();
const S = LOCAL.static || {};

const STATIC = {
  calendars: S.calendars || [],
  sheets: S.sheets || [],
  credentials: ['messengerPageToken'].concat(S.credentials || []),
  workflows: S.workflows || [],
  // every workflow id of the other projects (tests: no Lumière id may collide with one)
  otherWorkflowIds: LOCAL.otherWorkflowIds || S.workflows || [],
  webhookPaths: S.webhookPaths || [],
  // the seller's own WhatsApp (never a salon notification target) and the other clients' numbers
  numbers: ['213777744607'].concat(S.numbers || []),
  lockPrefixes: LOCAL.lockPrefixes || [],
  lockIds: LOCAL.lockIds || [],
  envPrefix: 'CLINIC_',
  local: !!LOCAL.static,
};

const CLINIC_DIRS = LOCAL.dirs || [];
// Extra "must never appear" patterns for the website demo build: names, addresses, numbers.
const PATTERNS = (LOCAL.patterns || []).map(([src, flags]) => new RegExp(src, flags));

function jsonFiles(dir) { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)); } catch (e) { return []; } }

// Credentials that lumiere.config.js may share with the clinic bots on purpose
// (SHARED_CREDENTIALS). Account-level services only: a shared WhatsApp, WhatsApp
// trigger or Facebook Page credential would answer on the clinic's number/page.
const SHAREABLE = ['googleCalendar', 'googleSheets', 'openRouter', 'cohere'];
// Returns [{ scope, key, id, name }] for the shared credentials; throws on a key that may not be shared.
function sharedCredentials(env) {
  const out = [];
  for (const [scope, creds, list] of [['salon', env.credentials, env.SHARED_CREDENTIALS], ['websiteDemo', env.websiteDemo.credentials, env.websiteDemo.SHARED_CREDENTIALS]]) {
    for (const key of list || []) {
      if (!SHAREABLE.includes(key)) throw new Error(scope + ' credential "' + key + '" may not be shared with the clinic bots (only ' + SHAREABLE.join(', ') + ')');
      if (!creds[key]) throw new Error(scope + ' SHARED_CREDENTIALS names an unknown credential "' + key + '"');
      out.push(Object.assign({ scope, key }, creds[key]));
    }
  }
  return out;
}

// Returns { ids:Set, paths:Set, webhookIds:Set, calendars:Set, sheets:Set, scannedDirs:[] }
function collect(projectRoot) {
  const out = { ids: new Set(STATIC.workflows.concat(STATIC.credentials)), paths: new Set(STATIC.webhookPaths), webhookIds: new Set(),
    calendars: new Set(STATIC.calendars), sheets: new Set(STATIC.sheets), scannedDirs: [] };
  for (const d of CLINIC_DIRS) {
    const dir = path.resolve(projectRoot, '..', d);
    const files = jsonFiles(dir);
    if (!files.length) continue;
    out.scannedDirs.push(dir);
    for (const f of files) {
      let text, wf;
      try { text = fs.readFileSync(f, 'utf8'); wf = JSON.parse(text); } catch (e) { continue; }
      if (!wf || !Array.isArray(wf.nodes)) continue;
      if (wf.id) out.ids.add(wf.id);
      for (const n of wf.nodes) {
        if (n.webhookId) out.webhookIds.add(n.webhookId);
        if (n.id) out.ids.add(n.id);
        for (const c of Object.values(n.credentials || {})) if (c && c.id) out.ids.add(c.id);
        if (n.type === 'n8n-nodes-base.webhook' && n.parameters && n.parameters.path) out.paths.add(n.parameters.path);
        if (n.parameters && n.parameters.documentId && n.parameters.documentId.value) out.sheets.add(String(n.parameters.documentId.value));
      }
      for (const m of text.matchAll(/[0-9a-f]{40,}@group\.calendar\.google\.com/g)) out.calendars.add(m[0]);
    }
  }
  return out;
}

// Lock object ids live in the engine config literal of each workflow; compare them exactly
// (a substring test would flag "lumdemolockcal01" because it ends like another bot's lock id).
function lockIdsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/\\?"(?:CAL_LOCK_ID|CHAT_LOCK_PREFIX)\\?": \\?"([a-v0-9]+)\\?"/g)) out.add(m[1]);
  return out;
}
const isClinicLock = (id) => STATIC.lockPrefixes.some((p) => id.startsWith(p)) || STATIC.lockIds.includes(id);

module.exports = { STATIC, CLINIC_DIRS, PATTERNS, SHAREABLE, sharedCredentials, collect, lockIdsIn, isClinicLock };
