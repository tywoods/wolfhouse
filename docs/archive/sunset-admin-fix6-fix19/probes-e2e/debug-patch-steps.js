'use strict';
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let s = fs.readFileSync(path, 'utf8');
console.log('start', s.split('\n').length);

const a = s.replace(
  "function adminParseTimeHm(text){\n  var t = String(text || '').trim();\n  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };\n  return { ok: true, value: t };\n}",
  "var ADMIN_TIME_HM_RE = new RegExp('^([01][0-9]|2[0-3]):[0-5][0-9]$');\nfunction adminParseTimeHm(text){\n  var t = String(text || '').trim();\n  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };\n  return { ok: true, value: t };\n}\n\nfunction adminMinutesFromHm(hm){\n  var parts = String(hm || '').split(':');\n  if (parts.length !== 2) return NaN;\n  var h = parseInt(parts[0], 10);\n  var m = parseInt(parts[1], 10);\n  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;\n  return h * 60 + m;\n}"
);
console.log('after parse', a.split('\n').length, a === s ? 'NO CHANGE' : 'changed');

const b = a.replace(
  /function adminReadPackSchedules\(prefix\)\{[\s\S]*?return \{ ok: true, value: key \? \[key\] : \[\] \};\n\}/,
  `function adminReadPackSchedules(prefix, root){
  var scope = root || document;
  var startInput = scope.querySelector('[id="' + prefix + '-schedule-start"]');
  var endInput = scope.querySelector('[id="' + prefix + '-schedule-end"]');
  var startParsed = adminParseTimeHm(startInput ? startInput.value : '');
  if (!startParsed.ok) return { ok: false, error: startParsed.error };
  var endParsed = adminParseTimeHm(endInput ? endInput.value : '');
  if (!endParsed.ok) return { ok: false, error: endParsed.error };
  var startMin = adminMinutesFromHm(startParsed.value);
  var endMin = adminMinutesFromHm(endParsed.value);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin){
    return { ok: false, error: portalT('admin.edit.endAfterStart') };
  }
  var key = adminScheduleKeyFromTimes(startParsed.value, endParsed.value);
  return { ok: true, value: key ? [key] : [] };
}`
);
console.log('after schedules', b.split('\n').length, b === a ? 'NO CHANGE' : 'changed');

const c = b.replace('var schedulesParsed = adminReadPackSchedules(prefix);', 'var schedulesParsed = adminReadPackSchedules(prefix, root);');
console.log('after payload', c.split('\n').length);

const d = c.replace(/renderAdminPackEditForm/g, 'adminRenderPackEditForm');
console.log('after rename', d.split('\n').length, 'renames', (c.match(/renderAdminPackEditForm/g)||[]).length);
