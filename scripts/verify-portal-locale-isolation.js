'use strict';

/**
 * verify-portal-locale-isolation.js
 *
 * Pins the per-tenant portal language design so one tenant's language set can
 * NEVER silently change another's (the regression where a Sunset commit dropped
 * Italian from Wolfhouse, because the switcher was hardcoded in shared source).
 *
 * The contract:
 *   - The language switcher + locale gates are DRIVEN BY the deployment env
 *     (STAFF_PORTAL_LOCALES), not a hardcoded locale set in shared code.
 *   - The i18n bootstrap injects STAFF_ENABLED_LOCALES and gates getStaffLocale /
 *     setStaffLocale on it.
 *   - Different enabled-locale lists produce different switchers (es,en,it vs es,en).
 *
 * If a future change re-hardcodes the switcher (the daeacf2 pattern), this fails.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const { getStaffPortalI18nBootstrapScript } = require('./lib/staff-portal-i18n');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-portal-locale-isolation.js\n');

section('A. Switcher is env-driven, not hardcoded');
{
  check('A1', /process\.env\.STAFF_PORTAL_LOCALES/.test(apiSrc),
    'STAFF_PORTAL_LOCALES is read from the deployment env');
  check('A2', /function renderStaffLangSwitchButtons/.test(apiSrc),
    'switcher buttons are rendered by renderStaffLangSwitchButtons()');
  check('A3', /\$\{renderStaffLangSwitchButtons\(false\)\}/.test(apiSrc)
    && /\$\{renderStaffLangSwitchButtons\(true\)\}/.test(apiSrc),
    'both main + login switchers use the dynamic renderer');
  // No hardcoded locale buttons anywhere (the daeacf2 anti-pattern).
  const hardcoded = apiSrc.match(/data-lang="(es|en|it|de|fr)"/g) || [];
  check('A4', hardcoded.length === 0,
    `no hardcoded data-lang="xx" buttons in source (found ${hardcoded.length})`);
}

section('B. i18n bootstrap injects + gates on STAFF_ENABLED_LOCALES');
{
  const boot3 = getStaffPortalI18nBootstrapScript(['es', 'en', 'it']);
  const boot2 = getStaffPortalI18nBootstrapScript(['es', 'en']);
  check('B1', /var STAFF_ENABLED_LOCALES =/.test(boot3),
    'bootstrap injects STAFF_ENABLED_LOCALES');
  check('B2', /STAFF_ENABLED_LOCALES\.indexOf\(s\) !== -1/.test(boot3),
    'getStaffLocale gates stored locale on the enabled set');
  check('B3', /STAFF_ENABLED_LOCALES\.indexOf\(loc\) === -1/.test(boot3),
    'setStaffLocale gates on the enabled set (not a hardcoded en/es/it list)');
  check('B4', !/loc !== 'en' && loc !== 'es'/.test(boot3),
    'no leftover hardcoded en/es-only gate');
  // Different inputs → different enabled sets (real isolation).
  check('B5', /\["es","en","it"\]/.test(boot3.replace(/\s/g, '')),
    'es,en,it tenant gets it in the enabled set');
  check('B6', /STAFF_ENABLED_LOCALES=\["es","en"\]/.test(boot2.replace(/\s/g, '')),
    'es,en tenant does NOT get it in the enabled set');
  const def3 = /var STAFF_DEFAULT_LOCALE = "es"/.test(boot3);
  check('B7', def3, 'default locale resolves to es when present');
}

section('C. Tenant config lives in deployment env (documented)');
{
  check('C1', /STAFF_PORTAL_LOCALES env/.test(apiSrc) || /deployment's STAFF_PORTAL_LOCALES/.test(apiSrc),
    'code documents that the locale set is per-deployment config, not shared source');
}

console.log(`\n── verify-portal-locale-isolation ${failures === 0 ? 'PASSED' : 'FAILED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures === 0 ? 0 : 1);
