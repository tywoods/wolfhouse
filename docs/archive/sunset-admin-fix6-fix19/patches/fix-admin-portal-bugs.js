#!/usr/bin/env node
'use strict';
/**
 * Apply admin portal bug fixes to scripts/staff-query-api.js:
 * - time validation regex (\\d stripped in embedded UI bundle)
 * - pack form function name mismatch
 * - rental dropdown overflow
 * - lesson kind on save
 */
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'scripts', 'staff-query-api.js');
let api = fs.readFileSync(API, 'utf8');
const changed = [];

if (!api.includes('var ADMIN_TIME_HM_RE')) {
  const timeRe = /function adminParseTimeHm\(text\)\{[\s\S]*?return \{ ok: true, value: t \};\s*\}/;
  if (!timeRe.test(api)) throw new Error('adminParseTimeHm block not found');
  api = api.replace(timeRe, `var ADMIN_TIME_HM_RE = new RegExp('^([01]\\\\d|2[0-3]):[0-5]\\\\d$');
function adminParseTimeHm(text){
  var t = String(text || '').trim();
  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };
  return { ok: true, value: t };
}`);
  changed.push('adminParseTimeHm');
}

if (api.includes('renderAdminPackEditForm(')) {
  api = api.replace(/renderAdminPackEditForm\(/g, 'adminRenderPackEditForm(');
  changed.push('pack form calls');
}

api = api.replace(/text = text\.replace\(\/s\+\/g, ' '\)/g, "text = text.replace(/\\s+/g, ' ')");
api = api.replace(/\(d\+\) day pack surfer/g, '(\\d+) day pack surfer');

const kindOld = "        kind: 'lesson',\n        age_band: ageInput";
const kindNew = "        kind: (el('admin-time-kind') ? String(el('admin-time-kind').value || 'lesson') : 'lesson'),\n        age_band: ageInput";
if (api.includes(kindOld)) {
  api = api.replace(kindOld, kindNew);
  changed.push('save-time kind');
}

const newKindOld = "        kind: 'lesson',\n        age_band: newAgeInput";
const newKindNew = "        kind: newKindInput ? String(newKindInput.value || 'lesson') : 'lesson',\n        age_band: newAgeInput";
if (api.includes(newKindOld)) {
  api = api.replace(newKindOld, newKindNew);
  changed.push('save-new-time kind');
}

const cssNeedle = '.portal-admin-price-card-edit select,.portal-admin-price-card-edit input{width:100%;';
const cssFixed = '.portal-admin-price-card.is-editing{overflow:hidden;min-width:0}.portal-admin-price-card-edit select,.portal-admin-price-card-edit input{width:100%;max-width:100%;min-width:0;';
if (api.includes(cssNeedle) && !api.includes('max-width:100%;min-width:0')) {
  api = api.replace(cssNeedle, cssFixed);
  changed.push('dropdown CSS');
}

fs.writeFileSync(API, api, 'utf8');
console.log('OK', changed.join(', ') || 'no changes needed');
