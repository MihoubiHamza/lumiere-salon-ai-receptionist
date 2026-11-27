'use strict';
// Resource isolation: the Lumière files may only use the salon's own resources
// (lumiere.config.js) and can never overwrite, trigger or reuse anything of the
// clinic bots. Run: node tests/isolation.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, runTests } = require('./lib/t');
const FP = require('./lib/clinic-fingerprints');

const ROOT = path.resolve(__dirname, '..');
const ENV = require(path.join(ROOT, 'lumiere.config.js'));
const CFG = require(path.join(ROOT, 'engine', 'config.js'));
const WB = require(path.join(ROOT, 'tools', 'build-workflows.js'));
const MB = require(path.join(ROOT, 'tools', 'build-messenger.js'));
const IB = require(path.join(ROOT, 'tools', 'build-instagram.js'));
const DB = require(path.join(ROOT, 'website-demo', 'build-web-demo.js'));
const DEMO = require(path.join(ROOT, 'website-demo', 'demo-config.js'));
const CLINIC = FP.collect(ROOT);
// Account-level credentials shared with the clinic bots on purpose (lumiere.config.js SHARED_CREDENTIALS).
const SHARED = FP.sharedCredentials(ENV);
const SHARED_IDS = new Set(SHARED.map((c) => c.id));

// Every Lumière workflow file, tagged with the environment it belongs to.
const SALON_FILES = Object.values(WB.OUTPUT_FILES).concat([MB.OUT_FILE, IB.OUT_FILE]).map((f) => ({ file: f, kind: 'salon' }));
const DEMO_FILES = Object.values(DB.WF).map((w) => ({ file: path.join('website-demo', w.file), kind: 'demo' }));
const ALL = SALON_FILES.concat(DEMO_FILES).map((x) => Object.assign(x, { text: fs.readFileSync(path.join(ROOT, x.file), 'utf8') }, { wf: JSON.parse(fs.readFileSync(path.join(ROOT, x.file), 'utf8')) }));
const SITE = DB.SITE_FILES.map((f) => ({ file: f, text: fs.readFileSync(path.join(ROOT, 'website-demo', f), 'utf8') }));
const CONFIG_TEXTS = ['lumiere.config.js', path.join('engine', 'config.js'), path.join('website-demo', 'demo-config.js'), 'salon-info.js'].map((f) => ({ file: f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
const strings = (o, out) => { out = out || []; if (typeof o === 'string') out.push(o); else if (o && typeof o === 'object') for (const v of Object.values(o)) strings(v, out); return out; };

test('I1 no clinic resource ID, calendar, sheet, lock prefix or notification number in any Lumière workflow, config or site', () => {
  console.log('       (clinic folders scanned read-only: ' + (CLINIC.scannedDirs.length ? CLINIC.scannedDirs.map((d) => path.basename(d)).join(', ') : 'none found - fixed list only') + ')');
  const needles = [...CLINIC.ids, ...CLINIC.calendars, ...CLINIC.sheets, ...CLINIC.webhookIds].filter((x) => String(x).length >= 8 && !SHARED_IDS.has(x));
  for (const x of ALL.concat(CONFIG_TEXTS)) for (const n of needles) assert.ok(x.text.indexOf(n) < 0, x.file + ' reuses clinic identifier ' + n);
  // Lock objects: exact ids and prefixes of the other bots (from the local fingerprint file).
  let locks = 0;
  for (const x of ALL) for (const id of FP.lockIdsIn(x.text)) { locks++; assert.ok(!FP.isClinicLock(id), x.file + ' uses the clinic lock id ' + id); }
  assert.ok(locks >= 10, 'lock ids were checked (' + locks + ')');
  for (const x of SITE) for (const n of needles) assert.ok(x.text.indexOf(n) < 0, x.file + ' reuses clinic identifier ' + n);
  // Notification numbers: no fixed phone number at all in the workflows (staff number comes from LUMIERE_STAFF_CHAT_ID).
  for (const x of ALL.concat(CONFIG_TEXTS)) for (const n of FP.STATIC.numbers) assert.ok(x.text.indexOf(n) < 0, x.file + ' contains the clinic/seller number ' + n);
});

test('I2 every credential comes from lumiere.config.js: LUMIERE ones, or an account-level one listed in SHARED_CREDENTIALS (salon vs. website demo kept apart)', () => {
  const salon = Object.values(ENV.credentials), demo = Object.values(ENV.websiteDemo.credentials);
  const key = (c) => c.id + '|' + c.name;
  const salonKeys = new Set(salon.map(key)), demoKeys = new Set(demo.map(key));
  for (const c of salon.concat(demo)) {
    if (SHARED_IDS.has(c.id)) continue;
    assert.ok(/^LUMIERE /.test(c.name), 'credential name must start with LUMIERE: ' + c.name);
    assert.ok(!CLINIC.ids.has(c.id), 'credential id reused from the clinic without being listed in SHARED_CREDENTIALS: ' + c.id);
  }
  // WhatsApp, the WhatsApp trigger, the Facebook Page token and the Instagram token are always the salon's own.
  for (const k of ['whatsApp', 'whatsAppTrigger', 'facebookPage', 'instagram']) {
    assert.ok(/^LUMIERE /.test(ENV.credentials[k].name) && !CLINIC.ids.has(ENV.credentials[k].id), k + ' must be a LUMIERE credential');
    const bad = JSON.parse(JSON.stringify(ENV));
    bad.SHARED_CREDENTIALS = [k];
    assert.throws(() => FP.sharedCredentials(bad), /may not be shared/, k + ' must be refused in SHARED_CREDENTIALS');
  }
  assert.strictEqual(new Set(salon.concat(demo).map((c) => c.id)).size, salon.length + demo.length, 'credential ids must be unique');
  let count = 0;
  for (const x of ALL) for (const n of x.wf.nodes) for (const c of Object.values(n.credentials || {})) {
    count++;
    assert.ok((x.kind === 'salon' ? salonKeys : demoKeys).has(key(c)), x.file + ' / ' + n.name + ' uses ' + c.name + ' (' + c.id + '), not a ' + x.kind + ' credential from lumiere.config.js');
  }
  assert.ok(count > 20, 'credentials were checked (' + count + ')');
});

test('I3 environment variables: only the LUMIERE_* names from lumiere.config.js, never CLINIC_*', () => {
  const allowed = new Set(Object.values(ENV.env));
  for (const v of allowed) assert.ok(/^LUMIERE_[A-Z_]+$/.test(v), 'env name ' + v);
  const used = new Set();
  for (const x of ALL) {
    assert.ok(x.text.indexOf('CLINIC_') < 0, x.file + ' still mentions a CLINIC_ variable');
    for (const m of x.text.matchAll(/\$env\.([A-Za-z_]+)/g)) { used.add(m[1]); assert.ok(allowed.has(m[1]), x.file + ' reads $env.' + m[1] + ', which is not in lumiere.config.js'); }
  }
  for (const v of ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'STAFF_CHAT_ID', 'MESSENGER_APP_SECRET', 'MESSENGER_VERIFY_TOKEN', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_VERIFY_TOKEN', 'INSTAGRAM_ACCOUNT_ID']) assert.ok(used.has(ENV.env[v]), ENV.env[v] + ' is used');
  // Messenger and Instagram never read each other's variables.
  const ig = ALL.find((x) => x.file === IB.OUT_FILE).text, fb = ALL.find((x) => x.file === MB.OUT_FILE).text;
  assert.ok(ig.indexOf('LUMIERE_MESSENGER_') < 0 && fb.indexOf('LUMIERE_INSTAGRAM_') < 0, 'Messenger / Instagram variables are kept apart');
  // The website demo never touches WhatsApp or env secrets.
  for (const x of ALL.filter((y) => y.kind === 'demo')) assert.ok(x.text.indexOf('$env.') < 0, x.file + ' reads an environment variable');
});

test('I4 workflow IDs come from lumiere.config.js, are unique, never a clinic ID, and every link stays inside Lumière', () => {
  const ids = ALL.map((x) => x.wf.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate workflow ids: ' + ids.join(', '));
  const expected = Object.values(ENV.workflows).concat(Object.values(ENV.websiteDemo.workflows));
  assert.deepStrictEqual(ids.slice().sort(), expected.slice().sort(), 'workflow ids = lumiere.config.js');
  for (const id of ids) assert.ok(!CLINIC.ids.has(id), 'workflow id ' + id + ' exists in a clinic project: importing would overwrite it');
  for (const x of ALL) {
    assert.strictEqual(x.wf.active, false, x.file + ' must be exported inactive');
    const own = x.kind === 'salon' ? Object.values(ENV.workflows) : Object.values(ENV.websiteDemo.workflows);
    for (const n of x.wf.nodes) {
      const w = n.parameters && n.parameters.workflowId;
      if (w && typeof w.value === 'string' && w.value.indexOf('$workflow') < 0) assert.ok(own.indexOf(w.value) >= 0, x.file + ' / ' + n.name + ' calls workflow ' + w.value + ' outside its environment');
    }
    if (x.wf.settings && x.wf.settings.errorWorkflow) assert.strictEqual(x.wf.settings.errorWorkflow, ENV.workflows.error, x.file + ' error workflow');
  }
  for (const f of [WB.FILES.main, MB.OUT_FILE, IB.OUT_FILE]) assert.strictEqual(ALL.find((x) => x.file === f).wf.settings.errorWorkflow, ENV.workflows.error, f + ' is linked to the Lumière error workflow');
});

test('I5 webhooks: own paths and webhook ids, never shared with the clinic; the website posts to the Lumière demo webhook', () => {
  const paths = [], hookIds = [];
  for (const x of ALL) for (const n of x.wf.nodes) {
    if (n.webhookId) hookIds.push(n.webhookId);
    if (n.type === 'n8n-nodes-base.webhook') paths.push(n.parameters.path);
  }
  for (const p of paths) assert.ok(!CLINIC.paths.has(p), 'webhook path ' + p + ' is used by a clinic workflow');
  assert.deepStrictEqual([...new Set(paths)].sort(), [ENV.MESSENGER_WEBHOOK_PATH, ENV.INSTAGRAM_WEBHOOK_PATH, ENV.websiteDemo.WEBHOOK_PATH].sort());
  assert.strictEqual(new Set(hookIds).size, hookIds.length, 'duplicate webhookIds');
  for (const h of hookIds) assert.ok(!CLINIC.webhookIds.has(h), 'webhookId ' + h + ' is used by a clinic workflow');
  assert.ok(ENV.websiteDemo.PUBLIC_WEBHOOK_URL.endsWith('/webhook/' + ENV.websiteDemo.WEBHOOK_PATH));
  for (const s of SITE) {
    const m = /const CHAT_WEBHOOK_URL = "([^"]*)";/.exec(s.text);
    assert.ok(m && m[1] === ENV.websiteDemo.PUBLIC_WEBHOOK_URL, s.file + ' posts to ' + (m && m[1]));
  }
});

test('I6 Google resources: one salon sheet (tabs by name), the salon calendar, and a separate demo calendar', () => {
  let sheetNodes = 0;
  for (const x of ALL) for (const n of x.wf.nodes) {
    if (n.parameters && n.parameters.documentId) {
      sheetNodes++;
      assert.strictEqual(x.kind, 'salon', 'the website demo must not use Google Sheets');
      assert.deepStrictEqual(n.parameters.documentId, { __rl: true, value: ENV.google.SHEET_ID, mode: 'id' }, n.name);
      assert.strictEqual(n.parameters.sheetName.mode, 'name', n.name + ' must reference its tab by name (tab ids differ between spreadsheets)');
      assert.ok(Object.values(ENV.google.SHEET_TABS).indexOf(n.parameters.sheetName.value) >= 0, n.name + ' tab ' + n.parameters.sheetName.value);
    }
    if (n.parameters && n.parameters.calendar && x.kind === 'salon') assert.strictEqual(n.parameters.calendar.value, CFG.CALENDAR_ID, n.name);
  }
  assert.strictEqual(sheetNodes, 13, 'the 13 Sheets nodes of WhatsApp (5) + Messenger (4) + Instagram (4)');
  assert.strictEqual(ALL.find((x) => x.file === WB.FILES.main).wf.nodes.find((n) => n.name === 'Get Clinic Info').parameters.sheetName.value, ENV.google.SHEET_TABS.salonInfo);
  assert.strictEqual(CFG.CALENDAR_ID, ENV.google.CALENDAR_ID);
  assert.strictEqual(CFG.LOCK_CALENDAR_ID, ENV.google.LOCK_CALENDAR_ID || ENV.google.CALENDAR_ID);
  for (const x of ALL.filter((y) => y.kind === 'salon')) for (const s of strings(x.wf)) {
    for (const m of s.matchAll(/"(?:CALENDAR_ID|LOCK_CALENDAR_ID)": "([^"]*)"/g)) assert.ok(m[1] === CFG.CALENDAR_ID || m[1] === CFG.LOCK_CALENDAR_ID, x.file + ' engine calendar ' + m[1]);
  }
  assert.strictEqual(DEMO.tool.CALENDAR_ID, ENV.websiteDemo.CALENDAR_ID);
  assert.notStrictEqual(ENV.websiteDemo.CALENDAR_ID, ENV.google.CALENDAR_ID, 'the public website demo must not write into the salon calendar');
  // The demo's calendar lives only in DEMO CONFIG, never in the salon files.
  for (const x of ALL.filter((y) => y.kind === 'salon')) assert.ok(x.text.indexOf(ENV.websiteDemo.CALENDAR_ID) < 0, x.file + ' uses the demo calendar');
});

test('I7 timezone: every zone in every workflow is the salon TIMEZONE, and DST timezones are refused', () => {
  const zones = new Set();
  for (const x of ALL) for (const m of x.text.matchAll(/\b(?:Africa|America|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/g)) zones.add(m[0]);
  assert.deepStrictEqual([...zones], [ENV.TIMEZONE], 'zones found: ' + [...zones].join(', '));
  WB.checkTimezone(ENV.TIMEZONE, ENV.TZ_OFFSET_MIN);
  assert.throws(() => WB.checkTimezone('Europe/Madrid', 60), /daylight saving/);
  assert.throws(() => WB.checkTimezone('Africa/Algiers', 120), /does not match/);
  assert.throws(() => WB.checkTimezone('Not/AZone', 60), /unknown TIMEZONE/);
});

test('I8 voice notes: one configured language, told to the AI; unsupported model/language combinations are refused', () => {
  assert.deepStrictEqual(WB.VOICE_MODELS, { 'cohere-transcribe-03-2026': ['en', 'fr', 'es', 'ar'], 'cohere-transcribe-arabic-07-2026': ['ar'] });
  assert.ok(WB.VOICE_MODELS[CFG.VOICE_MODEL].indexOf(CFG.VOICE_LANGUAGE) >= 0);
  for (const f of [WB.FILES.main, MB.OUT_FILE]) {
    const wf = ALL.find((x) => x.file === f).wf;
    const stt = wf.nodes.find((n) => n.name === 'Cohere Transcribe').parameters.bodyParameters.parameters;
    assert.strictEqual(stt.find((p) => p.name === 'model').value, CFG.VOICE_MODEL, f);
    assert.strictEqual(stt.find((p) => p.name === 'language').value, CFG.VOICE_LANGUAGE, f);
    const text = wf.nodes.find((n) => n.name === 'AI Agent').parameters.text;
    assert.ok(text.indexOf('voice notes are ONLY supported in ' + WB.LANG_NAMES[CFG.VOICE_LANGUAGE]) >= 0, f + ': the AI is told the voice language');
  }
  // The build refuses an unsupported setting (run in a child process with an overridden config).
  const { spawnSync } = require('child_process');
  const probe = (model, lang) => spawnSync(process.execPath, ['-e', `const p=require('path');const c=require(p.join(${JSON.stringify(ROOT)},'engine','config.js'));c.VOICE_MODEL=${JSON.stringify(model)};c.VOICE_LANGUAGE=${JSON.stringify(lang)};require(p.join(${JSON.stringify(ROOT)},'tools','build-workflows.js'));`], { encoding: 'utf8' });
  assert.notStrictEqual(probe('cohere-transcribe-arabic-07-2026', 'es').status, 0, 'Arabic model + Spanish must be refused');
  assert.notStrictEqual(probe('cohere-transcribe-03-2026', 'de').status, 0, 'unsupported language must be refused');
  assert.notStrictEqual(probe('some-other-model', 'en').status, 0, 'unknown model must be refused');
  assert.strictEqual(probe('cohere-transcribe-03-2026', 'fr').status, 0, 'a supported setting builds');
});

test('I9 the builds never read-modify or write the clinic folders, and only write inside this project', () => {
  const hashDir = (dir) => { const h = crypto.createHash('sha256'); for (const f of fs.readdirSync(dir).sort()) { const p = path.join(dir, f); if (fs.statSync(p).isFile()) h.update(f + '\0' + fs.readFileSync(p)); } return h.digest('hex'); };
  const before = CLINIC.scannedDirs.map(hashDir);
  WB.build(); MB.build(); IB.build(); DB.build(); DB.siteFiles();
  assert.deepStrictEqual(CLINIC.scannedDirs.map(hashDir), before, 'a clinic folder changed during the builds');
  const outputs = Object.values(WB.OUTPUT_FILES).concat([MB.OUT_FILE, IB.OUT_FILE]).map((f) => path.resolve(ROOT, f))
    .concat(Object.values(DB.WF).map((w) => path.resolve(DB.OUT_DIR, w.file))).concat(DB.SITE_FILES.map((f) => path.resolve(DB.OUT_DIR, f)));
  for (const o of outputs) assert.ok(o.indexOf(ROOT + path.sep) === 0, 'build output outside the project: ' + o);
});

test('I10 preflight reports every placeholder and refuses to call the environment ready while one is left', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'preflight.js')], { encoding: 'utf8' });
  const placeholders = JSON.stringify(ENV).match(/PASTE_[A-Z_]+/g) || [];
  if (placeholders.length) {
    assert.notStrictEqual(r.status, 0, 'preflight must fail while placeholders are left');
    for (const p of new Set(placeholders)) assert.ok(r.stdout.indexOf(p) >= 0, 'preflight names ' + p);
  }
  assert.ok(/clinic identifiers: none found/i.test(r.stdout), r.stdout);
  assert.ok(/builds up to date/i.test(r.stdout), r.stdout);
});

if (require.main === module) runTests('isolation').then((r) => process.exit(r.fail ? 1 : 0));
