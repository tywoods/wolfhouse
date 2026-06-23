'use strict';
const fs = require('fs');
const s = fs.readFileSync('G:/Luna/Sunset/scripts/staff-query-api.js', 'utf8');
const old = "function adminParseTimeHm(text){\n  var t = String(text || '').trim();\n  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };\n  return { ok: true, value: t };\n}";
console.log('found', s.includes(old));
console.log('index', s.indexOf(old));
const i = s.indexOf('function adminParseTimeHm');
console.log('snippet', JSON.stringify(s.slice(i, i + 200)));
