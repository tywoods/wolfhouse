#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'scripts', 'staff-query-api.js');
let api = fs.readFileSync(API, 'utf8');

// Fix truncated ADMIN_TIME_HM_RE + restore adminParseTimeHm
const broken = "var ADMIN_TIME_HM_RE = new RegExp('^([01]\\\\d|2[0-3]):[0-5]\\\\d\n\nfunction adminSlotTimeStart";
const fixed = `var ADMIN_TIME_HM_RE = new RegExp('^([01]\\\\d|2[0-3]):[0-5]\\\\d$');
function adminParseTimeHm(text){
  var t = String(text || '').trim();
  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };
  return { ok: true, value: t };
}

function adminSlotTimeStart`;
if (api.includes(broken)) {
  api = api.replace(broken, fixed);
  console.log('OK fixed truncated ADMIN_TIME_HM_RE');
} else if (!api.includes('function adminParseTimeHm(text)')) {
  throw new Error('Could not locate broken ADMIN_TIME_HM_RE block');
}

// Remove duplicate admin tail (stray ); through second wireAdminTab)
const dupStart = api.indexOf('\n);\nfunction adminParseTimeHm(text){');
const customersIdx = api.indexOf('\nvar customersCache = []');
if (dupStart > 0 && customersIdx > dupStart) {
  api = api.slice(0, dupStart) + api.slice(customersIdx);
  console.log('OK removed duplicate admin block', customersIdx - dupStart, 'chars');
}

// Fix adminHumanizeText regex corruption if present
api = api.replace(
  "text = text.replace(/s+/g, ' ').trim();",
  "text = text.replace(/\\s+/g, ' ').trim();",
);
api = api.replace(
  "text = text.replace(/(d+) day pack surfer/i, '$1 day pack');",
  "text = text.replace(/(\\d+) day pack surfer/i, '$1 day pack');",
);

// Rental dropdown CSS
const cssAnchor = '.portal-admin-price-card-edit select,.portal-admin-price-card-edit input{width:100%;';
const cssNew = '.portal-admin-price-card,.portal-admin-price-card.is-editing{overflow:hidden;min-width:0}.portal-admin-price-card-edit select,.portal-admin-price-card-edit input{width:100%;max-width:100%;min-width:0;';
if (api.includes(cssAnchor) && !api.includes('portal-admin-price-card.is-editing{overflow:hidden')) {
  api = api.replace(cssAnchor, cssNew);
  console.log('OK rental dropdown CSS');
}

api = api.replace(
  'grid-template-columns:repeat(auto-fill,minmax(148px,1fr))',
  'grid-template-columns:repeat(auto-fill,minmax(132px,1fr))',
);

const cardOld = "html += '<article class=\"portal-admin-price-card\" data-admin-price-card=\"' + escHtml(pid) + '\">';";
const cardNew = "html += '<article class=\"portal-admin-price-card' + (groupEditing && pid ? ' is-editing' : '') + '\" data-admin-price-card=\"' + escHtml(pid) + '\">';";
if (api.includes(cardOld)) {
  api = api.replace(cardOld, cardNew);
  console.log('OK price card is-editing class');
}

// Sanity checks
const checks = [
  ['one adminConfigCache', (api.match(/var adminConfigCache = null;/g) || []).length === 1],
  ['one wireAdminTab', (api.match(/function wireAdminTab\(\)/g) || []).length === 1],
  ['adminParseTimeHm', api.includes('function adminParseTimeHm(text)')],
  ['ADMIN_TIME_HM_RE complete', api.includes("new RegExp('^([01]\\\\d|2[0-3]):[0-5]\\\\d$')")],
  ['adminRenderPackEditForm calls', api.includes('adminRenderPackEditForm(') && !api.includes('renderAdminPackEditForm(')],
  ['no stray ); before customers', !api.includes('\n);\nfunction adminParseTimeHm')],
];
checks.forEach(([name, ok]) => { if (!ok) throw new Error('Check failed: ' + name); });
console.log('All checks passed');

fs.writeFileSync(API, api, 'utf8');
console.log('Wrote', API);
