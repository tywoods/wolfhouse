'use strict';

/**
 * Shared Staff portal Bookings tab layout redesign gates.
 *
 * Asserts lean summary (Bookings | Refund | Unpaid), footer scope note,
 * search+Clear row, Dates/Status/Type/Export filter row, and mobile/desktop CSS.
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

// ── Summary strip ────────────────────────────────────────────────────────────
ok('summary renders Bookings + Refund + Unpaid metrics',
  /metric\('admin\.bookings\.metric\.bookings'/.test(ui)
  && /metric\('admin\.bookings\.metric\.refund'/.test(ui)
  && /metric\('admin\.bookings\.metric\.unpaid'/.test(ui));
ok('summary does not render Collected / Net / Outstanding tiles',
  !/metric\('admin\.bookings\.metric\.collected'/.test(ui)
  && !/metric\('admin\.bookings\.metric\.net'/.test(ui)
  && !/metric\('admin\.bookings\.metric\.outstanding'/.test(ui)
  && !/metric\('admin\.bookings\.metric\.refunded'/.test(ui));
ok('Refund metric binds refunded_cents',
  /metric\('admin\.bookings\.metric\.refund',\s*adminBookingsFormatEur\(s\.refunded_cents\)/.test(ui));
ok('Unpaid metric binds outstanding_cents',
  /metric\('admin\.bookings\.metric\.unpaid',\s*adminBookingsFormatEur\(s\.outstanding_cents\)/.test(ui));
ok('CSS summary strip is 3 columns',
  /\.portal-admin-bookings-summary-strip\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(api));

// ── Explainer footer ─────────────────────────────────────────────────────────
ok('scope note lives in page footer after table wrap',
  /admin-bookings-table-wrap[\s\S]*admin-bookings-footer-note/.test(ui)
  && /data-bookings-kpi-scope="1"/.test(ui)
  && /portal-admin-bookings-footer-note/.test(ui));
ok('scope note is not under summary strip',
  !/portal-admin-bookings-summary-note/.test(ui)
  && !/portal-admin-bookings-summary-strip[\s\S]{0,400}summaryScopeNote/.test(ui));
ok('footer note CSS class present',
  /\.portal-admin-bookings-footer-note\{/.test(api));

// ── Filters toolbar ──────────────────────────────────────────────────────────
ok('search row wraps Clear beside search',
  /portal-admin-bookings-toolbar-search/.test(ui)
  && /id="admin-bookings-clear"/.test(ui)
  && /portal-admin-bookings-clear-btn/.test(ui));
ok('filters row has Dates Status Type Export',
  /portal-admin-bookings-toolbar-filters/.test(ui)
  && /id="admin-bookings-date-range"/.test(ui)
  && /id="admin-bookings-status"/.test(ui)
  && /id="admin-bookings-type"/.test(ui)
  && /id="admin-bookings-export"/.test(ui));
ok('Export button uses short Export label key',
  /admin\.bookings\.export/.test(ui)
  && /'admin\.bookings\.export':\s*'Export'/.test(i18n)
  && /'admin\.bookings\.export':\s*'Exportar'/.test(i18nEs));
ok('CSS search row is flex with Clear',
  /\.portal-admin-bookings-toolbar-search\{[^}]*display:flex/.test(api)
  && /\.portal-admin-bookings-clear-btn\{/.test(api));
ok('CSS filter row is 4-col grid (desktop)',
  /\.portal-admin-bookings-toolbar-filters\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/.test(api));
ok('CSS filter row collapses to 2-col under 900px',
  /@media\(max-width:900px\)\{[\s\S]*?\.portal-admin-bookings-toolbar-filters\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(api));

// ── Booking cards ────────────────────────────────────────────────────────────
ok('rows expose pay-tone for unpaid/paid emphasis',
  /is-pay-/.test(ui)
  && /adminBookingsRowPayTone/.test(ui)
  && /data-bookings-pay-tone/.test(ui)
  && /portal-admin-bookings-td-total/.test(ui)
  && /portal-admin-bookings-td-paid/.test(ui));
ok('mobile card hierarchy: guest+status first',
  /@media\(max-width:520px\)\{[\s\S]*?grid-template-areas:[\s\S]*?"guest status"[\s\S]*?"total paid"[\s\S]*?"code code"/.test(api));
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
