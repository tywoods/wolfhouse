'use strict';

/**
 * Admin Pricing/Finance/Luna Staff/Email cards share Pricing's rhythm:
 *   .portal-admin-section { padding:16px 18px } + 14px gap
 * Email has no page title (subtab is enough).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const EMAIL_UI = path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}

function main() {
  console.log('verify-sunset-admin-card-rhythm');
  const api = fs.readFileSync(API, 'utf8');
  const emailUi = fs.readFileSync(EMAIL_UI, 'utf8');

  ok('generic section padding is 16px 18px',
    /\.portal-admin-section\{[^}]*padding:16px 18px/.test(api));
  ok('generic sections gap is 14px',
    /\.portal-admin-sections\{[^}]*gap:14px/.test(api));
  ok('effective Sunset Pricing #admin-panel-pricing padding is 16px 18px',
    /#admin-panel-pricing \.portal-admin-section\{padding:16px 18px\}/.test(api));
  ok('effective Sunset Pricing #admin-panel-pricing gap is 14px',
    /#admin-panel-pricing \.portal-admin-sections\{gap:14px\}/.test(api));
  ok('effective WH Pricing #wh-admin-pricing-body padding is 16px 18px (not 14px 16px)',
    /#wh-admin-pricing-body \.portal-admin-section\{padding:16px 18px\}/.test(api)
    && !/#wh-admin-pricing-body \.portal-admin-section\{padding:14px 16px\}/.test(api));
  ok('effective WH Pricing #wh-admin-pricing-body gap is 14px (not 18px)',
    /#wh-admin-pricing-body \.portal-admin-sections\{gap:14px\}/.test(api)
    && !/#wh-admin-pricing-body \.portal-admin-sections\{gap:18px\}/.test(api));

  ok('Email page is full wrap width (not 1100px)',
    /\.portal-admin-email-page\{max-width:100%\}/.test(api)
    && !/\.portal-admin-email-page\{max-width:1100px\}/.test(api));
  ok('Email card padding matches Pricing 16px 18px',
    /\.portal-admin-email-card\{[^}]*padding:16px 18px/.test(api));
  ok('Email cards gap is 14px',
    /\.portal-admin-email-cards\{[^}]*gap:14px/.test(api));
  ok('Email settings UI has no page-title hero',
    !emailUi.includes('portal-admin-email-hero')
    && !/admin\.email\.title/.test(emailUi));

  ok('Finance B shell gap is 14px',
    /\.portal-admin-finance--b\{gap:14px\}/.test(api));
  ok('Finance hero gap is 14px',
    /\.pfb-hero\{[^}]*gap:14px/.test(api));
  ok('Finance two-col gap is 14px',
    /\.pfb-two\{[^}]*gap:14px/.test(api));
  ok('Finance card padding matches Pricing 16px 18px',
    /\.pfb-card\{[^}]*padding:16px 18px/.test(api));
  ok('Finance cards keep --surface (not --surface-soft fill)',
    /\.pfb-card\{[^}]*background:var\(--surface\)/.test(api)
    && /\.portal-admin-finance-shell\{[^}]*background:transparent/.test(api));

  ok('Admin-hosted Luna Staff wrap has no second pad',
    /#tab-admin #al-wrap\{[^}]*padding:0!important/.test(api));
  ok('Admin-hosted Luna Staff cards padding matches Pricing 16px 18px',
    /#tab-admin \.staff-style-card\.luna-header-mode-card\{[^}]*padding:16px 18px/.test(api)
    || /#tab-admin #tab-ask-luna \.card,[\s\S]{0,80}padding:16px 18px/.test(api));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
