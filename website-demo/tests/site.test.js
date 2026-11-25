'use strict';
// Tests for the Lumière website (website-demo/site/index.html and its deploy/ copy):
// the menu matches salon-info.js, the chat posts to the demo webhook, no fake
// claims, every photo is credited, and all four languages are complete.
// Run: node website-demo/tests/site.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test, runTests } = require(path.resolve(__dirname, '..', '..', 'tests', 'lib', 't.js'));

const DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(DIR, '..');
const BUILD = require('../build-web-demo.js');
const SD = require('../site-data.js');
const SALON = require(path.join(ROOT, 'salon-info.js'));
const CFG = require(path.join(ROOT, 'engine', 'config.js'));
const ENV = require(path.join(ROOT, 'lumiere.config.js')).websiteDemo;
const LANGS = ['en', 'fr', 'es', 'ar'];

const PAGES = BUILD.SITE_FILES.map((f) => ({ file: f, html: fs.readFileSync(path.join(DIR, f), 'utf8') }));
const HTML = PAGES[0].html;
const SCRIPT = HTML.slice(HTML.lastIndexOf('<script>') + 8, HTML.lastIndexOf('</script>'));
const MARKUP = HTML.slice(0, HTML.lastIndexOf('<script>')).replace(/<style>[\s\S]*?<\/style>/, '');
const CREDITS = fs.readFileSync(path.join(DIR, 'PHOTO-CREDITS.md'), 'utf8');

// Pull a literal out of the page script (between two markers) and evaluate it.
function literal(start, end) {
  const a = SCRIPT.indexOf(start);
  const b = SCRIPT.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'page script: cannot find ' + start);
  return new Function('var FSI = "\\u2068", PDI = "\\u2069"; return ' + SCRIPT.slice(a + start.length, b).trim().replace(/;$/, ''))();
}
const I18N = literal('var I18N =', '/*I18N-END*/');
const CHAT_UI = literal('var CHAT_UI =', 'var CHAT_GREETING');
const GREETING = literal('var CHAT_GREETING =', 'var CHAT_CHIPS');
const CHIPS = literal('var CHAT_CHIPS =', 'var TASK_MSG');
const TASKS = literal('var TASK_MSG =', '/* ---------- "Things to try"');
const SCENARIOS = literal('var SCENARIOS =', 'var demoChat');
const CAT_KEYS = literal('var CAT_KEYS =', 'var D = SALON_DATA');
const keysIn = (attr) => [...new Set([...MARKUP.matchAll(new RegExp(attr + '="([^"]+)"', 'g'))].map((m) => m[1]))];
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('W1 the menu on the website is generated from salon-info.js and engine/config.js (services, prices, durations, hours)', () => {
  for (const p of PAGES) {
    const data = SD.readSalonData(p.html);
    assert.ok(data, p.file + ': SALON_DATA line missing');
    assert.deepStrictEqual(data, SD.siteData(), p.file + ': menu out of date - run node website-demo/build-web-demo.js');
  }
  const data = SD.readSalonData(HTML);
  assert.strictEqual(data.services.length, SALON.services.length);
  SALON.services.forEach((s, i) => {
    const w = data.services[i];
    for (const k of ['key', 'category', 'name', 'name_fr', 'name_es', 'name_ar', 'duration', 'price']) assert.strictEqual(w[k], s[k], s.key + '.' + k);
    assert.strictEqual(w.fromPrice, !!s.fromPrice, s.key + '.fromPrice');
  });
  assert.deepStrictEqual(data.hours, { start: CFG.WORK_START, end: CFG.WORK_END, closedWeekday: CFG.CLOSED_WEEKDAY });
  // No price, duration or service name is typed into the page by hand.
  for (const s of SALON.services) assert.ok(MARKUP.indexOf('>' + s.name + '<') < 0, 'hand-written menu item in the HTML: ' + s.name);
  // The build rewrites a stale menu line from salon-info.js.
  const stale = HTML.replace(/("key":"womens_cut"[^}]*?"price":)\d+/, '$1999');
  assert.notStrictEqual(stale, HTML, 'test setup: price not found');
  assert.strictEqual(SD.injectSalonData(stale), HTML, 'injection restores the salon-info.js price');
});

test('W2 both pages post to the Lumière demo webhook, are identical, and the build check is clean', () => {
  for (const p of PAGES) {
    const m = /const CHAT_WEBHOOK_URL = "([^"]*)";/.exec(p.html);
    assert.ok(m && m[1] === ENV.PUBLIC_WEBHOOK_URL, p.file + ' posts to ' + (m && m[1]));
    assert.ok(m[1].endsWith('/webhook/' + BUILD.WEBHOOK_PATH));
  }
  assert.strictEqual(PAGES[0].html, PAGES[1].html, 'site/ and deploy/ differ');
  const built = BUILD.siteFiles();
  for (const p of PAGES) assert.strictEqual(built[p.file], p.html, p.file + ' would change on build');
  // Request body format the workflow validates: { sessionId, message, lang, channel: "web" }.
  assert.ok(/JSON\.stringify\(\{ sessionId: chatSessionId\(\), message: text, lang: chatLang, channel: "web" \}\)/.test(SCRIPT));
  assert.ok(/crypto\.randomUUID\(\)/.test(SCRIPT), 'session ids stay in the format the webhook accepts');
});

test('W3 no fake claims: no ratings, reviews, client counts, founding year, offers, testimonials or stylist names', () => {
  const all = [text(MARKUP)].concat(LANGS.map((l) => Object.values(I18N[l] || {}).join(' '))).join(' \n ');
  const FAKE = [/★|☆|⭐/, /\b\d(?:[.,]\d)?\s*(?:\/\s*5|stars?|étoiles|estrellas)\b/i, /\b\d[\d,.\s]*\+?\s*(?:happy\s+)?(?:clients|customers|reviews|avis|clientes|reseñas|opiniones)\b/i,
    /\b(?:since|est\.?|established|depuis|desde)\s+(?:19|20)\d{2}\b/i, /\d+\s*%\s*(?:off|de réduction|de descuento)|\bdiscount\b|\bpromo(?:tion)?\b|first visit/i,
    /testimonial|témoignage|testimonio|what (?:our )?clients say/i, /\bour (?:senior )?stylists?\b|\bmeet the team\b/i, /award|winning|best salon|n[°o]\s*1\b/i];
  for (const re of FAKE) { const m = re.exec(all); assert.ok(!m, 'fake claim: ' + (m && all.slice(Math.max(0, m.index - 40), m.index + 40))); }
  // The old sales-page parts and the savings calculator are gone.
  for (const gone of ['id="cMsgs"', 'class="calc', 'wa-float', 'id="pricing"', 'id="faq"', 'class="pain']) assert.ok(HTML.indexOf(gone) < 0, 'leftover: ' + gone);
  // No emoji in the salon's voice: page text, translations, Yasmine's greeting and her replies in the demos.
  const EMOJI = /[\u{1F300}-\u{1FAFF}☀-➿]/u;
  assert.ok(!EMOJI.test(all), 'emoji in the page text');
  for (const l of LANGS) assert.ok(!EMOJI.test(GREETING[l]), 'emoji in the ' + l + ' greeting');
  for (const [k, s] of Object.entries(SCENARIOS)) for (const m of s.msgs) if (m.from === 'bot') assert.ok(!EMOJI.test(m.text), 'emoji in a demo reply (' + k + '): ' + m.text);
  // Voice notes are only understood in ONE configured language (Cohere has no language
  // detection): the page must never promise voice messages in all four languages.
  const VOICE_ALL = /(?:Spanish|espagnol|español|الإسبانية)[^.]{0,40}(?:Arabic|arabe|árabe|والعربية)[^.]{0,20}(?:voice|vocaux|voz|الصوتية)/i;
  const vm = VOICE_ALL.exec(all);
  assert.ok(!vm, 'voice messages promised in every language: ' + (vm && vm[0]));
  for (const l of LANGS) {
    const s = l === 'en' ? text(MARKUP) : Object.values(I18N[l] || {}).join(' ');
    assert.ok(/main language|langue principale|idioma principal|اللغة الرئيسية/.test(s), l + ": the page says voice messages work in the salon's main language");
  }
  // The page says plainly that the salon is a demo.
  assert.ok(/is a demo salon/.test(text(MARKUP)) && /fictional demo salon/.test(text(MARKUP)));
});

test('W4 every photo is a free Unsplash photo listed in PHOTO-CREDITS.md, credited in the footer, with a translated alt text', () => {
  const imgs = [...MARKUP.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.strictEqual(imgs.length, 3);
  const ids = new Set();
  for (const tag of imgs) {
    const urls = [...tag.matchAll(/https:\/\/[^\s"]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
    assert.ok(urls.length, 'img without a source: ' + tag);
    for (const u of urls) {
      const m = /^https:\/\/images\.unsplash\.com\/(photo-[0-9a-f-]+)\?/.exec(u);
      assert.ok(m, 'image not from the Unsplash CDN: ' + u);
      assert.ok(CREDITS.indexOf('https://images.unsplash.com/' + m[1]) >= 0, m[1] + ' is not in PHOTO-CREDITS.md');
      ids.add(m[1]);
    }
    assert.ok(/\balt="[^"]{8,}"/.test(tag), 'missing alt text: ' + tag.slice(0, 80));
    const key = /data-i18n-alt="([^"]+)"/.exec(tag);
    assert.ok(key, 'alt text not translated: ' + tag.slice(0, 80));
    for (const l of ['fr', 'es', 'ar']) assert.ok(I18N[l][key[1]], l + ' alt text missing: ' + key[1]);
  }
  assert.strictEqual(ids.size, 3);
  // Each credits row: photographer and photo page appear in the footer.
  const rows = CREDITS.split('\n').filter((r) => /^\| [^-|]/.test(r) && /images\.unsplash\.com/.test(r));
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    const [, , who, page] = r.split('|').map((c) => c.trim());
    assert.ok(MARKUP.indexOf(who) >= 0, 'photographer not credited on the page: ' + who);
    assert.ok(MARKUP.indexOf('href="' + page + '"') >= 0, 'photo page not linked: ' + page);
  }
  assert.ok(/Free to use under the Unsplash License/.test(CREDITS) && /unsplash\.com\/license/.test(MARKUP));
});

test('W5 all four languages are complete: page text, menu categories, chat, demo scenarios', () => {
  const pageKeys = keysIn('data-i18n').concat(keysIn('data-i18n-aria'), keysIn('data-i18n-alt'));
  assert.ok(pageKeys.length > 60, 'only ' + pageKeys.length + ' translated strings found');
  const scriptKeys = Object.keys(I18N.en);
  for (const l of ['fr', 'es', 'ar']) {
    const missing = pageKeys.concat(scriptKeys).filter((k) => typeof I18N[l][k] !== 'string' || !I18N[l][k].trim());
    assert.deepStrictEqual(missing, [], l + ' is missing ' + missing.join(', '));
  }
  // Script-only strings used by the page are all defined in English.
  for (const k of [...SCRIPT.matchAll(/\bt\("([a-z0-9.]+)"\)/g)].map((m) => m[1])) {
    assert.ok(I18N.en[k] != null || pageKeys.indexOf(k) >= 0, 'no English text for ' + k);
  }
  // Every salon-info.js category has a translated heading; every service a name in each language.
  for (const s of SALON.services) {
    assert.ok(CAT_KEYS[s.category], 'no heading key for category ' + s.category);
    for (const l of LANGS) assert.ok(I18N[l][CAT_KEYS[s.category]], l + ' heading for ' + s.category);
    for (const l of ['fr', 'es', 'ar']) assert.ok(s['name_' + l], s.key + ' has no ' + l + ' name');
  }
  // Chat: same fields in every language, greeting and starters for each.
  const uiKeys = Object.keys(CHAT_UI.en).sort();
  for (const l of LANGS) {
    assert.deepStrictEqual(Object.keys(CHAT_UI[l]).sort(), uiKeys, 'chat UI fields for ' + l);
    assert.ok(GREETING[l] && CHIPS[l] && CHIPS[l].length >= 3, 'chat greeting/starters for ' + l);
  }
  // Demo scenarios: language, result log and calendar chips in every language.
  for (const [k, s] of Object.entries(SCENARIOS)) {
    for (const l of LANGS) {
      assert.ok(s.lang[l] && s.log[l], k + ': ' + l);
      for (const c of s.chips) assert.ok(c.t[l] && c.l[l], k + ' chip: ' + l);
      if (s.transcript) assert.ok(s.transcript[l], k + ' transcript: ' + l);
      for (const m of s.msgs) if (m.from === 'system') assert.ok(m[l], k + ' system line: ' + l);
    }
  }
});

test('W6 Arabic and layout essentials: RTL switch, isolated salon name, mobile menu, "Ask Yasmine" bar, square buttons', () => {
  assert.ok(/root\.dir = next === "ar" \? "rtl" : "ltr"/.test(SCRIPT), 'Arabic switches the page to RTL');
  assert.ok(/function isolateName/.test(SCRIPT) && /bdi\.nm \{ white-space: nowrap; unicode-bidi: isolate; \}/.test(HTML), 'Latin salon name is isolated in Arabic text');
  assert.ok(GREETING.ar.indexOf('⁨Lumière Hair & Beauty Studio⁩') >= 0, 'Arabic greeting isolates the salon name');
  assert.ok(/id="mobileMenu"[^>]*hidden/.test(MARKUP) && /aria-controls="mobileMenu"/.test(MARKUP), 'mobile menu');
  assert.ok(/class="ask-bar js-book" id="askBar"/.test(MARKUP), '"Ask Yasmine" bar');
  assert.ok(/body \{ font-size: 16px; padding-bottom: 76px; \}/.test(HTML), 'the bar never covers the end of the page');
  assert.ok(!/border-radius:\s*999px[^}]*\}/.test(HTML.slice(HTML.indexOf('.btn {'), HTML.indexOf('.btn-sm'))), 'buttons are square');
  assert.ok(/Cormorant Garamond/.test(HTML) && /Instrument Sans/.test(HTML) && /Noto Naskh Arabic/.test(HTML) && /IBM Plex Sans Arabic/.test(HTML) && !/Readex Pro|Playfair/.test(HTML), 'typography');
  // The developer's number is only used for salon owners (WhatsApp/call), never as the salon's contact.
  const demo = MARKUP.slice(0, MARKUP.indexOf('id="owners"'));
  assert.ok(demo.indexOf('213777744607') < 0 && demo.indexOf('777 74 46 07') < 0, 'developer number before the salon-owner section');
  // Demo first: hero (chat), what Yasmine knows, WhatsApp/Messenger examples, salon owners + footer.
  // The fictional salon has no Visit / address / opening-hours section any more.
  assert.deepStrictEqual([...MARKUP.matchAll(/<section class="[^"]*" id="([^"]+)"|<section class="hero"/g)].map((m) => m[1] || 'hero'), ['hero', 'menu', 'whatsapp', 'owners']);
  for (const gone of ['id="studio"', 'class="visit', 'class="strip', 'hoursTable', 'visit.address']) assert.ok(HTML.indexOf(gone) < 0, 'leftover: ' + gone);
  assert.ok(/<footer class="site-footer">/.test(MARKUP) && /id="privacy"/.test(MARKUP));
});

test('W8 the live chat is the hero: input on the first screen, six real things to try, all sent to the webhook', () => {
  const hero = MARKUP.slice(MARKUP.indexOf('<section class="hero"'), MARKUP.indexOf('</section>'));
  assert.ok(/Meet your salon&#39;s new|Meet your salon's new/.test(hero), 'headline');
  for (const id of ['liveChat', 'chatLog', 'chatForm', 'chatInput', 'chatSend', 'tasks']) assert.ok(hero.indexOf('id="' + id + '"') >= 0, '#' + id + ' is not in the hero');
  assert.ok(/No sign-up/i.test(text(hero)) && /24\/7/.test(text(hero)), 'no account needed, answers 24/7');
  // Six steps: prices, free times, booking, moving, cancelling (with confirmation), another language.
  const btns = [...hero.matchAll(/<button type="button" class="task" data-task="(\d)">/g)].map((m) => +m[1]);
  assert.deepStrictEqual(btns, [0, 1, 2, 3, 4, 5]);
  const titles = text(hero);
  for (const w of ['price', 'free times', 'Book', 'Move', 'Cancel', 'confirm', 'another language']) assert.ok(titles.indexOf(w) >= 0, 'step missing: ' + w);
  for (const l of LANGS) {
    assert.strictEqual(TASKS[l].length, 6, l);
    for (const m of TASKS[l]) assert.ok(typeof m === 'string' && m.trim().length > 5, l + ' step message');
  }
  // Step 6 is written in a different language from the chat's.
  const ARABIC = /[؀-ۿ]/;
  assert.ok(/¿/.test(TASKS.en[5]) && ARABIC.test(TASKS.fr[5]) && /Bonjour/.test(TASKS.es[5]) && !ARABIC.test(TASKS.ar[5]));
  for (const l of ['en', 'fr', 'es']) assert.ok(TASKS[l].slice(0, 5).every((m) => !ARABIC.test(m)), l + ' steps 1-5 in ' + l);
  assert.ok(TASKS.ar.slice(0, 5).every((m) => ARABIC.test(m)));
  // Each step goes through the same send path as typed messages (the real webhook): no canned replies.
  assert.ok(/chatSendMessage\(taskMessage\(b\)\)/.test(SCRIPT), 'steps send through chatSendMessage');
  assert.ok(!/reply|chatAddMessage|addBot/i.test(SCRIPT.slice(SCRIPT.indexOf('var taskBtns'), SCRIPT.indexOf('var liveChat'))), 'a step answers by itself');
  // WhatsApp and Messenger are shown as recorded examples, never as something visitors can test here.
  const all = [text(MARKUP)].concat(LANGS.map((l) => Object.values(I18N[l] || {}).join(' '))).join(' ');
  assert.ok(!/(?:try|test) (?:it|Yasmine|her|the demo) (?:now )?on (?:WhatsApp|Messenger)/i.test(all), 'claims visitors can test WhatsApp/Messenger');
  // One call to action for salon owners.
  assert.strictEqual((MARKUP.match(/data-i18n="own\.cta"/g) || []).length, 2, 'owner CTA: section + mobile menu');
});

test('W7 the page script compiles and nothing is left unfilled', () => {
  new Function(SCRIPT); // eslint-disable-line no-new-func
  assert.ok(!/@@[A-Z_]+@@/.test(HTML), 'template placeholder left');
  assert.ok(/^<!DOCTYPE html>/.test(HTML) && /<\/html>\s*$/.test(HTML));
  const ids = [...MARKUP.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], 'duplicate ids');
  for (const id of [...SCRIPT.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1])) assert.ok(ids.indexOf(id) >= 0, 'script uses a missing element #' + id);
});

runTests('site').then((r) => process.exit(r.fail ? 1 : 0));
