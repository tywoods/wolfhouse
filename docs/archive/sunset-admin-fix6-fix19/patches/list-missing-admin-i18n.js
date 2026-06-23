'use strict';
const fs = require('fs');
const api = fs.readFileSync('G:/Luna/Sunset/scripts/staff-query-api.js', 'utf8');
const en = fs.readFileSync('G:/Luna/Sunset/scripts/lib/staff-portal-i18n.js', 'utf8');
const es = fs.readFileSync('G:/Luna/Sunset/scripts/lib/staff-portal-i18n-es-sunset.js', 'utf8');
const keys = new Set();
const re = /portalT\('([^']+)'\)/g;
let m;
while ((m = re.exec(api))) {
  if (m[1].startsWith('admin.')) keys.add(m[1]);
}
const missingEn = [];
const missingEs = [];
for (const k of [...keys].sort()) {
  if (!en.includes(`'${k}'`)) missingEn.push(k);
  if (!es.includes(`'${k}'`)) missingEs.push(k);
}
console.log('missing EN', missingEn.length);
console.log(missingEn.join('\n'));
console.log('---');
console.log('missing ES', missingEs.length);
console.log(missingEs.join('\n'));
