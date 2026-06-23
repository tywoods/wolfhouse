'use strict';

/**
 * Pure Sunset Admin UI helpers + browser source generator for staff-query-api.js.
 *
 * Node exports are used by verify-sunset-admin-pure.js.
 * getSunsetAdminBrowserHelperSource() is injected into the portal IIFE at HTML build time.
 *
 * @module sunset-admin-ui-helpers
 */

const ADMIN_TIME_HM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function adminHumanizeText(value) {
  let text = String(value || '').trim();
  if (!text) return '—';
  text = text.replace(/^cfg:[^:]+:/, '');
  text = text.replace(/_/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/(\d+) day pack surfer/i, '$1 day pack');
  text = text.replace(/\b1 hour\b/i, '1 hour');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function adminSlotTimeStart(slotTime) {
  const raw = String(slotTime || '').trim();
  if (!raw) return '';
  return raw.split('-')[0].trim();
}

function adminSlotTimeEnd(slotTime) {
  const raw = String(slotTime || '').trim();
  if (!raw) return '';
  const parts = raw.split('-');
  if (parts.length < 2) return '';
  return parts[parts.length - 1].trim();
}

function adminSlotDurationLabel(slotTime) {
  const start = adminSlotTimeStart(slotTime);
  const end = adminSlotTimeEnd(slotTime);
  if (!start || !end) return '—';
  const sm = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
  const em = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
  if (!Number.isFinite(sm) || !Number.isFinite(em) || em <= sm) return '—';
  const mins = em - sm;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function adminParseTimeHm(text) {
  const t = String(text || '').trim();
  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: 'time_invalid' };
  return { ok: true, value: t };
}

function adminParseCapacity(text) {
  const n = parseInt(String(text || '').trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, error: 'capacity_invalid' };
  return { ok: true, value: n };
}

/**
 * Browser IIFE source for the six pure Admin helpers (portalT + RegExp escaping preserved).
 * Injected via buildUiHtml() — do not edit by hand in staff-query-api.js.
 */
function getSunsetAdminBrowserHelperSource() {
  return [
    'function adminParseCapacity(text){',
    "  var n = parseInt(String(text || '').trim(), 10);",
    "  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, error: portalT('admin.edit.capacityInvalid') };",
    '  return { ok: true, value: n };',
    '}',
    '',
    "var ADMIN_TIME_HM_RE = new RegExp('^([01][0-9]|2[0-3]):[0-5][0-9]$');",
    'function adminParseTimeHm(text){',
    "  var t = String(text || '').trim();",
    '  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: portalT(\'admin.edit.timeInvalid\') };',
    '  return { ok: true, value: t };',
    '}',
    '',
    'function adminSlotTimeStart(slotTime){',
    "  var raw = String(slotTime || '').trim();",
    "  if (!raw) return '';",
    "  return raw.split('-')[0].trim();",
    '}',
    '',
    'function adminSlotTimeEnd(slotTime){',
    "  var raw = String(slotTime || '').trim();",
    "  if (!raw) return '';",
    "  var parts = raw.split('-');",
    '  if (parts.length < 2) return \'\';',
    '  return parts[parts.length - 1].trim();',
    '}',
    '',
    'function adminHumanizeText(value){',
    "  var text = String(value || '').trim();",
    "  if (!text) return '—';",
    "  text = text.replace(/^cfg:[^:]+:/, '');",
    "  text = text.replace(/_/g, ' ');",
    '  text = text.replace(/\\s+/g, \' \').trim();',
    "  text = text.replace(/(\\d+) day pack surfer/i, '$1 day pack');",
    "  text = text.replace(new RegExp('\\\\b1 hour\\\\b', 'i'), '1 hour');",
    '  return text.charAt(0).toUpperCase() + text.slice(1);',
    '}',
    '',
    'function adminSlotDurationLabel(slotTime){',
    '  var start = adminSlotTimeStart(slotTime);',
    '  var end = adminSlotTimeEnd(slotTime);',
    "  if (!start || !end) return '—';",
    '  var sm = Number(start.slice(0,2)) * 60 + Number(start.slice(3,5));',
    '  var em = Number(end.slice(0,2)) * 60 + Number(end.slice(3,5));',
    "  if (!Number.isFinite(sm) || !Number.isFinite(em) || em <= sm) return '—';",
    '  var mins = em - sm;',
    '  if (mins % 60 === 0) return String(mins / 60) + \'h\';',
    "  return String(Math.floor(mins / 60)) + 'h ' + String(mins % 60) + 'm';",
    '}',
  ].join('\n');
}

module.exports = {
  ADMIN_TIME_HM_RE,
  adminHumanizeText,
  adminSlotTimeStart,
  adminSlotTimeEnd,
  adminSlotDurationLabel,
  adminParseTimeHm,
  adminParseCapacity,
  getSunsetAdminBrowserHelperSource,
};
