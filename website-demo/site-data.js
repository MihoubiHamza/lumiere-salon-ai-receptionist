'use strict';
// Website data generated from salon-info.js (services, prices, durations,
// contact) and engine/config.js (opening hours). It is written into the
// website as one line - `const SALON_DATA = {...};` - by
// website-demo/build-web-demo.js, so the menu on the site always matches what
// Yasmine quotes. Never edit that line in the HTML by hand.
const path = require('path');
const SALON = require(path.join(__dirname, '..', 'salon-info.js'));
const CFG = require(path.join(__dirname, '..', 'engine', 'config.js'));

const stripNote = (s) => String(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
function siteData() {
  return {
    name: SALON.name,
    currencySymbol: SALON.currencySymbol,
    address: stripNote(SALON.address),
    phone: stripNote(SALON.phone),
    email: stripNote(SALON.email),
    hours: { start: CFG.WORK_START, end: CFG.WORK_END, closedWeekday: CFG.CLOSED_WEEKDAY },
    services: SALON.services.map((s) => ({ key: s.key, category: s.category, name: s.name, name_fr: s.name_fr, name_es: s.name_es, name_ar: s.name_ar, duration: s.duration, price: s.price, fromPrice: !!s.fromPrice })),
  };
}

const LINE_RE = /const SALON_DATA = .*?; \/\/ generated[^\n]*/;
const line = () => 'const SALON_DATA = ' + JSON.stringify(siteData()) + '; // generated from salon-info.js + engine/config.js by website-demo/build-web-demo.js - do not edit by hand';
function injectSalonData(html, file) {
  if (!LINE_RE.test(html)) throw new Error('site-data: SALON_DATA line not found in ' + (file || 'site'));
  return html.replace(LINE_RE, () => line());
}
function readSalonData(html) {
  const m = /const SALON_DATA = (.*?); \/\/ generated/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}
module.exports = { siteData, injectSalonData, readSalonData };
