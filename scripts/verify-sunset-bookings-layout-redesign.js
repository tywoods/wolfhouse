'use strict';

/**
 * Shared Staff portal Bookings tab layout redesign gates.
 *
 * Ty split (2026-09-23):
 *  - Desktop + mobile: remove money summary tiles only (Collected/Refunded/Net/Outstanding).
 *  - Mobile only: Bookings|Refund|Unpaid strip, footer scope note, Search+Clear /
 *    Dates|Status|Type|Export toolbar, phone card hierarchy.
 *  - Desktop: keep today's toolbar, rows, and under-summary explainer.
 *
 * Run: node scripts/verify-sunset-bookings-layout-redesign.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const i18nEs = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`);
  }
}

console.log('\nverify:sunset-bookings-layout-redesign\n');

// ── Shared: money tiles gone ─────────────────────────────────────────────────
ok('summary does not render Collected / Net / Outstanding / Refunded tiles',
  !/metric\('admin\.bookings\.metric\.collected'/.test(ui)
  && !/metric\('admin\.bookings\.metric\.net'/.test(ui)
  && !/metric\('admin\.bookings\.metric\.outstanding'/.test(ui)
  && !/metric\('admin\.bookings\.metric\.refunded'/.test(ui));
ok('summary always renders Bookings count',
  /metric\('admin\.bookings\.metric\.bookings'/.test(ui));

// ── Desktop: Bookings-only strip + under-summary note + classic toolbar ──────
ok('desktop summary strip is single Bookings column by default',
  /\.portal-admin-bookings-summary-strip\{[^}]*grid-template-columns:minmax\(140px,220px\)/.test(api));
ok('Refund/Unpaid metrics marked mobile-only and hidden on desktop',
  /portal-admin-bookings-metric--mobile-kpi/.test(ui)
  && /\.portal-admin-bookings-metric--mobile-kpi\{display:none\}/.test(api));
ok('desktop keeps scope note under summary',
  /portal-admin-bookings-summary-note/.test(ui)
  && /data-bookings-kpi-scope="1"/.test(ui)
  && /\.portal-admin-bookings-summary-note\{/.test(api));
ok('desktop toolbar is classic flex wrap (not mobile column/grid by default)',
  /\.portal-admin-bookings-toolbar\{display:flex;flex-wrap:wrap;align-items:flex-end/.test(api)
  && /\.portal-admin-bookings-actions\{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-left:auto\}/.test(api));
ok('desktop Export label stays Export CSV (full span)',
  /portal-admin-bookings-export-full/.test(ui)
  && /admin\.bookings\.exportCsv/.test(ui)
  && /\.portal-admin-bookings-export-short\{display:none\}/.test(api));
ok('desktop does not force mobile card grid outside 520px',
  !/\.portal-admin-bookings-tr\{[^}]*grid-template-areas:\s*"guest status"/.test(api.split('@media(max-width:520px)')[0]));

// ── Mobile: lean KPIs, footer note, toolbar, cards ───────────────────────────
ok('mobile shows Refund + Unpaid KPIs (refunded_cents / outstanding_cents)',
  /metric\('admin\.bookings\.metric\.refund',\s*adminBookingsFormatEur\(s\.refunded_cents\)/.test(ui)
  && /metric\('admin\.bookings\.metric\.unpaid',\s*adminBookingsFormatEur\(s\.outstanding_cents\)/.test(ui)
  && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-metric--mobile-kpi\{display:block\}/.test(api)
  && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-summary-strip\{[^}]*repeat\(3,minmax\(0,1fr\)\)/.test(api));
ok('mobile moves scope note to footer (hides under-summary note)',
  /admin-bookings-footer-note/.test(ui)
  && /portal-admin-bookings-footer-note/.test(ui)
  && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-summary-note\{display:none\}/.test(api)
  && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-footer-note\{display:block\}/.test(api));
ok('mobile toolbar: Search+Clear then Dates/Status/Type/Export',
  /@media\(max-width:768px\)\{[\s\S]*?grid-template-areas:[\s\S]*?"search clear"[\s\S]*?"dates status"[\s\S]*?"type export"/.test(api)
  && /id="admin-bookings-clear"/.test(ui)
  && /id="admin-bookings-export"/.test(ui)
  && /\.portal-admin-bookings-actions\{display:contents/.test(api));
ok('mobile Export short label',
  /portal-admin-bookings-export-short/.test(ui)
  && /'admin\.bookings\.export':\s*'Export'/.test(i18n)
  && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-export-full\{display:none\}/.test(api)
  && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-export-short\{display:inline\}/.test(api));
ok('mobile card hierarchy: guest+status first',
  /@media\(max-width:520px\)\{[\s\S]*?grid-template-areas:[\s\S]*?"guest status"[\s\S]*?"total paid"[\s\S]*?"code code"/.test(api));
ok('rows expose pay-tone for mobile unpaid/paid emphasis',
  /is-pay-/.test(ui)
  && /adminBookingsRowPayTone/.test(ui)
  && /data-bookings-pay-tone/.test(ui)
  && /portal-admin-bookings-td-total/.test(ui)
  && /portal-admin-bookings-td-paid/.test(ui));
ok('mobile keeps Booking ::before label on code cell',
  /\.portal-admin-bookings-td-code::before\{content:'Booking'/.test(api));
ok('deep-link + export + clear ids preserved',
  /data-bookings-open-schedule/.test(ui)
  && /admin-bookings-export/.test(ui)
  && /admin-bookings-clear/.test(ui)
  && /\/staff\/admin\/bookings\/export\.csv/.test(ui));

// ── i18n lean labels ─────────────────────────────────────────────────────────
ok('EN/ES Refund + Unpaid metric keys',
  /'admin\.bookings\.metric\.refund':\s*'Refund'/.test(i18n)
  && /'admin\.bookings\.metric\.unpaid':\s*'Unpaid'/.test(i18n)
  && /'admin\.bookings\.metric\.refund':\s*'Reembolso'/.test(i18nEs)
  && /'admin\.bookings\.metric\.unpaid':\s*'Impagado'/.test(i18nEs));

console.log(`\nverify:sunset-bookings-layout-redesign  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
