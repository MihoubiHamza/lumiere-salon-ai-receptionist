#!/usr/bin/env node
'use strict';
// Pre-import check for the Lumière salon environment. Read-only: it never
// contacts Google, Meta or n8n and never writes a file.
// Usage: node tools/preflight.js      (exit code 0 = ready to import)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FP = require(path.join(ROOT, 'tests', 'lib', 'clinic-fingerprints.js'));
const problems = [];
const ok = (msg) => console.log('  [x] ' + msg);
const bad = (msg) => { console.log('  [ ] ' + msg); problems.push(msg); };

let ENV;
try { ENV = require(path.join(ROOT, 'lumiere.config.js')); } catch (e) { console.error('lumiere.config.js cannot be loaded: ' + e.message); process.exit(1); }

console.log('\nLumière pre-import check (offline, read-only)\n');

// 1. placeholders
console.log('1. lumiere.config.js values');
const WHERE = {
  PASTE_LUMIERE_CALENDAR_ID: 'google.CALENDAR_ID - the salon Google Calendar ID (SETUP.md step 1)',
  PASTE_LUMIERE_SHEET_ID: 'google.SHEET_ID - the salon Google Sheet ID (SETUP.md step 2)',
  PASTE_LUMIERE_DEMO_CALENDAR_ID: 'websiteDemo.CALENDAR_ID - the separate website-demo calendar ID (SETUP.md step 1)',
};
const placeholders = [...new Set(JSON.stringify(ENV).match(/PASTE_[A-Z_]+/g) || [])];
if (!placeholders.length) ok('no placeholders left');
for (const p of placeholders) bad(p + ' -> set ' + (WHERE[p] || 'this value'));
if (ENV.websiteDemo.CALENDAR_ID === ENV.google.CALENDAR_ID) bad('websiteDemo.CALENDAR_ID must differ from google.CALENDAR_ID (public demo bookings must not land in the salon calendar)');
else ok('website demo uses its own calendar');
if (!ENV.websiteDemo.PUBLIC_WEBHOOK_URL.endsWith('/webhook/' + ENV.websiteDemo.WEBHOOK_PATH)) bad('websiteDemo.PUBLIC_WEBHOOK_URL must end with /webhook/' + ENV.websiteDemo.WEBHOOK_PATH);
else ok('website chat URL ends with /webhook/' + ENV.websiteDemo.WEBHOOK_PATH);

// 2. clinic isolation
console.log('\n2. Isolation from the clinic bots');
const clinic = FP.collect(ROOT);
let shared = [];
try { shared = FP.sharedCredentials(ENV); } catch (e) { bad(e.message); }
const sharedIds = new Set(shared.map((c) => c.id));
const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.json')).map((f) => path.join(ROOT, f))
  .concat(fs.readdirSync(path.join(ROOT, 'website-demo')).filter((f) => f.endsWith('.json')).map((f) => path.join(ROOT, 'website-demo', f)))
  .concat(['lumiere.config.js', 'engine/config.js', 'website-demo/demo-config.js', 'website-demo/site/index.html'].map((f) => path.join(ROOT, f)));
const needles = [...clinic.ids, ...clinic.calendars, ...clinic.sheets, ...clinic.webhookIds, ...clinic.paths].filter((x) => String(x).length >= 8 && !sharedIds.has(x));
const hits = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const n of needles) if (t.indexOf(n) >= 0) hits.push(path.relative(ROOT, f) + ': ' + n);
  for (const id of FP.lockIdsIn(t)) if (FP.isClinicLock(id)) hits.push(path.relative(ROOT, f) + ': lock id ' + id);
  if (/\$env\.CLINIC_/.test(t)) hits.push(path.relative(ROOT, f) + ': $env.CLINIC_*');
}
if (hits.length) for (const h of hits) bad('clinic identifier in ' + h);
else ok('clinic identifiers: none found (' + (clinic.scannedDirs.length ? 'clinic folders scanned read-only: ' + clinic.scannedDirs.length : 'fixed list only - clinic folders not found next to this project') + ')');
if (shared.length) ok('shared on purpose (SHARED_CREDENTIALS, account-level only): ' + shared.map((c) => (c.scope === 'websiteDemo' ? 'demo ' : '') + c.key + ' = "' + c.name + '"').join(', '));

// 3. builds
console.log('\n3. Generated workflows');
const checks = [['tools/build-workflows.js'], ['tools/build-messenger.js'], ['website-demo/build-web-demo.js']];
let buildsOk = true;
for (const [script] of checks) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), '--check'], { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) { buildsOk = false; bad(script + ' --check failed: ' + (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ')); }
}
if (buildsOk) ok('builds up to date (WhatsApp + tools + error workflow, Messenger, website demo + site URL)');

// 4. what only you can do
console.log('\n4. Manual steps (cannot be checked offline - tick them yourself, see SETUP.md)');
const env = Object.values(ENV.env);
for (const m of [
  'Google Calendars "' + ENV.google.CALENDAR_NAME + '" and "' + ENV.websiteDemo.CALENDAR_NAME + '" created and shared with the Google account of the n8n credentials',
  'Google Sheet created with tabs ' + Object.values(ENV.google.SHEET_TABS).join(', ') + ' (headers per SETUP.md) and Salon_Info filled from salon-info-sheet.csv',
  'n8n credentials filled in (they exist with these exact ids and names): ' + Object.values(ENV.credentials).concat(Object.values(ENV.websiteDemo.credentials)).filter((c) => !sharedIds.has(c.id)).map((c) => c.name).join(', ') +
    (shared.length ? ' - the shared ones (' + shared.map((c) => c.name).join(', ') + ') already work for the clinic bots' : ''),
  'n8n environment variables set (salon values, NOT the clinic ones): ' + env.join(', '),
  'Salon WhatsApp Business number on its own Meta app (not the clinic number); webhook not shared with the clinic',
  'Error workflow, tool workflows, then main workflows imported - all arrive inactive; no clinic workflow selected or edited',
]) console.log('  [ ] ' + m);

console.log('\n' + (problems.length ? 'NOT READY: ' + problems.length + ' problem(s) above.' : 'Offline checks passed. Finish the manual steps above, then import (SETUP.md).') + '\n');
process.exit(problems.length ? 1 : 0);
