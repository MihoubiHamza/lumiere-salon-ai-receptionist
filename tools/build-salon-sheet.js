#!/usr/bin/env node
'use strict';
// Writes salon-info-sheet.csv (rows for the "Get Clinic Info" Google Sheet tab)
// from salon-info.js + engine/config.js, so the sheet never drifts from the
// prompt. Usage: node tools/build-salon-sheet.js
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'salon-info.js'));
const C = require(path.join(ROOT, 'engine', 'config.js'));
const W = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const closed = C.CLOSED_WEEKDAY >= 0 && C.CLOSED_WEEKDAY <= 6;
const q = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
const rows = [
  ['Field', 'Value'],
  ['Salon name', S.name],
  ['Salon name (Arabic)', S.name_ar],
  ['Description', S.description],
  ['Demo data', 'All values in this sheet are fictional demo values'],
  ['Address', S.address],
  ['Phone', S.phone],
  ['Email', S.email],
  ['Opening days', closed ? W[(C.CLOSED_WEEKDAY + 1) % 7] + ' to ' + W[(C.CLOSED_WEEKDAY + 6) % 7] : 'Monday to Sunday'],
  ['Weekly closing day', closed ? W[C.CLOSED_WEEKDAY] : 'None'],
  ['Opening hours', C.WORK_START + ' - ' + C.WORK_END + ' (appointments must end by ' + C.WORK_END + ')'],
  ['Currency', S.currency],
];
for (const s of S.services) rows.push(['Service: ' + s.name, s.duration + ' min - ' + (s.fromPrice ? 'from ' : '') + S.currencySymbol + s.price + ' | FR: ' + s.name_fr + ' | ES: ' + s.name_es + ' | AR: ' + s.name_ar]);
S.policies.forEach((p, i) => rows.push(['Policy ' + (i + 1), p]));
fs.writeFileSync(path.join(ROOT, 'salon-info-sheet.csv'), rows.map((r) => r.map(q).join(',')).join('\n') + '\n');
console.log('salon-info-sheet.csv: ' + (rows.length - 1) + ' rows');
