'use strict';
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let s = fs.readFileSync(path, 'utf8');

const parseOld = "function adminParseTimeHm(text){\n  var t = String(text || '').trim();\n  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };\n  return { ok: true, value: t };\n}";
const parseNew = "var ADMIN_TIME_HM_RE = new RegExp('^([01][0-9]|2[0-3]):[0-5][0-9]$');\nfunction adminParseTimeHm(text){\n  var t = String(text || '').trim();\n  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };\n  return { ok: true, value: t };\n}\n\nfunction adminMinutesFromHm(hm){\n  var parts = String(hm || '').split(':');\n  if (parts.length !== 2) return NaN;\n  var h = parseInt(parts[0], 10);\n  var m = parseInt(parts[1], 10);\n  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;\n  return h * 60 + m;\n}";

if (!s.includes(parseOld)) throw new Error('parse block not found');
s = s.replace(parseOld, () => parseNew);

s = s.replace(
  /function adminReadPackSchedules\(prefix\)\{[\s\S]*?return \{ ok: true, value: key \? \[key\] : \[\] \};\n\}/,
  () => `function adminReadPackSchedules(prefix, root){
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

s = s.replace('var schedulesParsed = adminReadPackSchedules(prefix);', 'var schedulesParsed = adminReadPackSchedules(prefix, root);');
s = s.replace(/renderAdminPackEditForm/g, 'adminRenderPackEditForm');

if (!s.includes('ADMIN_TIME_HM_RE')) throw new Error('parse patch failed');
if (!s.includes('adminReadPackSchedules(prefix, root)')) throw new Error('schedules patch failed');
if (s.includes('renderAdminPackEditForm')) throw new Error('pack form rename failed');
if (s.split('\n').length > 41000) throw new Error('file bloated: ' + s.split('\n').length);

fs.writeFileSync(path, s, 'utf8');
console.log('patched ok lines', s.split('\n').length);
