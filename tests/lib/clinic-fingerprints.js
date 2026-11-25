'use strict';
// Identifiers of the CLINIC bots that must never appear in the Lumière files.
// 1. A fixed list (so the isolation tests work even on a machine without the
//    clinic folders), and 2. everything found by scanning the clinic folders
//    next to this project, when they exist (read-only).
const fs = require('fs');
const path = require('path');

const STATIC = {
  calendars: ['other-bot-calendar-1@group.calendar.google.com', 'other-bot-calendar-2@group.calendar.google.com'],
  sheets: ['OTHER_BOT_SHEET_ID'],
  credentials: ['rZX0lgyJh37EPtO6', '8cDyURx4XMYQvDrW', 'otherWf000000014', 'otherWf000000015', '3JRN7dwrwfWdcPVS', '2KXHYFXQUgXkYyRh', 'messengerPageToken', 'hDz7EcZEdPypZGV4', '1LzpxYC9KJuRY5cL'],
  workflows: ['otherWf000000001', 'otherWf000000002', 'otherWf000000003', 'otherWf000000004', 'otherWf000000005', 'otherWf000000006', 'otherWf000000013',
    'othWebDemoMain01', 'othWebDemoBook01', 'othWebDemoCanc01', 'othWebDemoResc01', 'othWebDemoFind01', 'othWebDemoChck01'],
  webhookPaths: ['other-bot-messenger', 'other-website-demo'],
  // phone numbers of the clinic and of the seller's own WhatsApp (never a salon notification target)
  numbers: ['213500000999', '0500000999', '213777744607'],
  lockPrefixes: ['otherbotlock', 'otherbotlockb', 'othdemolockcal01', 'othdemolockchat'],
  envPrefix: 'CLINIC_',
};

const CLINIC_DIRS = ['other-bot-whatsapp', 'other-bot-messenger', path.join('other-bot-messenger', 'website-demo'),
  'other-bot-backup', 'other-bot-template'];

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
const isClinicLock = (id) => /^(otherbotlock|otherbotlockb)/.test(id) || id === 'othdemolockcal01' || id === 'othdemolockchat';

module.exports = { STATIC, CLINIC_DIRS, SHAREABLE, sharedCredentials, collect, lockIdsIn, isClinicLock };
