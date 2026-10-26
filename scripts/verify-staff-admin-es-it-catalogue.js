#!/usr/bin/env node
'use strict';

/**
 * Fail if Luna Staff / Admin error and empty-state keys are missing from ES/IT,
 * equal the English pack, or still painted as raw English in those screens.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.STAFF_PORTAL_LOCALES = 'en,es,it';
process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
delete process.env.LUNA_DEPLOYMENT;

const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n.js');

const KEYS = [
  'lunaStaff.intelligence.loadFailed',
  'lunaStaff.intelligence.saveFailed',
  'lunaStaff.intelligence.loading',
  'lunaStaff.intelligence.saving',
  'lunaStaff.intelligence.saved',
  'lunaStaff.pause.loadFailed',
  'lunaStaff.pause.pausing',
  'lunaStaff.pause.resuming',
  'lunaStaff.pause.actionFailed',
  'lunaStaff.location.loadFailed',
  'lunaStaff.location.saveFailed',
  'lunaStaff.bookingSettings.saveFailed',
  'lunaStaff.fields.loadFailed',
  'lunaStaff.fields.saveFailed',
  'lunaStaff.fields.saving',
  'lunaStaff.fields.saved',
  'lunaStaff.reconcileFailed',
  'admin.wh.services.loadFailed',
  'admin.wh.services.empty',
  'admin.wh.services.noRooms',
  'admin.wh.services.nameRequired',
  'admin.wh.services.datesRequiredForBlock',
  'admin.wh.services.roomsRequiredForBlock',
  'admin.wh.services.roomBlockConflict',
  'admin.wh.services.genericError',
  'admin.wh.pricing.loadFailed',
  'admin.wh.pricing.saveFailed',
  'common.loading',
  'common.saving',
  'common.saved',
  'admin.finance.wh.partialTotal',
  'admin.finance.wh.unavailableTotal',
  'admin.finance.wh.total',
  'admin.finance.wh.detailPartialGuidance',
  'admin.finance.wh.detailUnavailableGuidance',
];

const ALLOW_SAME = new Set([
  'admin.finance.wh.total',
]);

const FILES = [
  'scripts/staff-query-api.js',
  'scripts/browser/wolfhouse-admin-pricing-ui.js',
  'scripts/browser/wolfhouse-location-booking-settings-ui.js',
  'scripts/browser/wolfhouse-staff-portal-fields-ui.js',
  'scripts/browser/wolfhouse-services-admin.js',
];

const RAW = [
  'Could not load Luna Intelligence',
  'Could not save Luna Intelligence',
  'Could not load global pause state',
  'Could not load settings. Editing remains disabled.',
  'Could not save location.',
  'Could not save booking settings.',
  'Could not reconcile the save.',
  'Could not load camps and services.',
  'Name is required.',
  'Room block conflict',
  'Nothing yet. Click',
  'Global pause action failed',
  'Pausing Luna globally',
  'Resuming Luna globally',
];

let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log('PASS', name);
  else {
    failed += 1;
    console.log('FAIL', name, extra || '');
  }
}

for (const key of KEYS) {
  const en = STAFF_PORTAL_STRINGS.en[key];
  const es = STAFF_PORTAL_STRINGS.es[key];
  const it = STAFF_PORTAL_STRINGS.it[key];
  check(key + ' EN', !!en);
  check(key + ' ES present' + (ALLOW_SAME.has(key) ? '' : ' and not EN'), !!es && (ALLOW_SAME.has(key) ? true : es !== en), es);
  check(key + ' IT present and not EN', !!it && it !== en, it);
}

const helper = /(?:\bt\(|whT\(|whStaffT\(|whStaffFieldsT\(|svcT\(|portalT\(|emailUiT\(|staffWhatsappNumbersI18n\()/;
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const needle of RAW) {
    let from = 0;
    while (true) {
      const i = src.indexOf(needle, from);
      if (i < 0) break;
      const lineStart = src.lastIndexOf('\n', i) + 1;
      const lineEnd = src.indexOf('\n', i);
      const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
      const ok = helper.test(line);
      check(rel + ' no raw ' + JSON.stringify(needle), ok, ok ? '' : line.trim().slice(0, 180));
      from = i + needle.length;
    }
  }
}

const { chromium } = require('playwright');
const Module = require('module');
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'dotenv') return { config() { return {}; } };
  return orig(request, parent, isMain);
};
const api = require('./staff-query-api.js');
Module._load = orig;
const html = api.buildUiHtmlForOfflineTest({ clientSlug: 'wolfhouse-somo' });

(async function () {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const lang of ['es', 'it']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript((locale) => {
        localStorage.setItem('staff_portal_client', 'wolfhouse-somo');
        localStorage.setItem('wh_staff_portal_locale', locale);
      }, lang);
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/staff/ui') {
          return route.fulfill({ contentType: 'text/html', body: html });
        }
        if (url.pathname === '/staff/luna-intelligence') {
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false }) });
        }
        if (url.pathname.startsWith('/staff/')) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, rows: [], notes: '', paused: false }) });
        }
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto('http://staff.test/staff/ui', { waitUntil: 'domcontentloaded' });
      await page.locator('button.tab-btn[data-tab="admin"]').click();
      await page.locator('#wh-admin-tab-luna-staff').click();
      await page.waitForFunction(() => {
        const el = document.getElementById('staff-luna-intelligence-status');
        return !!(el && el.textContent && el.textContent.trim());
      }, null, { timeout: 8000 });
      const text = (await page.locator('#staff-luna-intelligence-status').textContent() || '').trim();
      const expected = STAFF_PORTAL_STRINGS[lang]['lunaStaff.intelligence.loadFailed'];
      const en = STAFF_PORTAL_STRINGS.en['lunaStaff.intelligence.loadFailed'];
      check(lang + ' intelligence error uses catalogue', text === expected, text);
      check(lang + ' intelligence error is not English', text !== en && !/Could not load Luna Intelligence/.test(text), text);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (failed) {
    console.error('FAILED', failed);
    process.exit(1);
  }
  console.log('OK verify-staff-admin-es-it-catalogue');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
