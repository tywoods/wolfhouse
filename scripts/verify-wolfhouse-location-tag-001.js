'use strict';

/**
 * LAB-LOCATION-ID-WOLFHOUSE-TAG-001
 *
 * Wolfhouse lab guests show location id wolfhouse-somo in guest, profile, and
 * schedule chrome. A Sunset school id must not cover that tag. Sunset guests
 * keep sunset-somo / sunset-sardinero.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { staffChromeLocationTag } = require('./lib/staff-wolfhouse-location-tag');

const ROOT = path.join(__dirname, '..');
const WH = 'wolfhouse-somo';
const SUNSET = 'sunset-somo';
const SARDI = 'sunset-sardinero';

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return '';
  let brace = 0;
  let started = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      brace += 1;
      started = true;
    } else if (ch === '}') {
      brace -= 1;
      if (started && brace === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

function loadBrowser() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-columns.js'), 'utf8');
  const names = [
    'staffChromeKeepLocationId',
    'staffChromeCollectLocationIds',
    'staffChromeLocationTag',
    'staffChromeLocationTagHtml',
  ];
  const body = names.map((n) => extractFunction(src, n)).join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(body + '\nthis.staffChromeLocationTag = staffChromeLocationTag;\nthis.staffChromeLocationTagHtml = staffChromeLocationTagHtml;', ctx);
  return ctx;
}

function loadScheduleLabel() {
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const fn = extractFunction(api, 'scheduleResolveDrawerSchoolLabel');
  const ctx = {
    getClient: () => WH,
    getSunsetLocation: () => SUNSET,
    getSunsetLocationLabel: (loc) => (loc === SARDI ? 'elSardi' : 'Sunset'),
    staffChromeLocationTag,
  };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.scheduleResolveDrawerSchoolLabel = scheduleResolveDrawerSchoolLabel;', ctx);
  return ctx;
}

function main() {
  const browser = loadBrowser();
  const bled = { location_id: SUNSET, client_slug: 'sunset' };
  const booking = { location_id: WH, metadata: { location_id: SUNSET } };

  assert.equal(staffChromeLocationTag(WH, bled), WH, 'Wolfhouse portal ignores a Sunset default');
  assert.equal(browser.staffChromeLocationTag(WH, bled), WH, 'browser helper agrees');
  assert.equal(staffChromeLocationTag(WH, bled), browser.staffChromeLocationTag(WH, bled));
  assert.equal(staffChromeLocationTag('sunset', booking), WH, 'Wolfhouse booking is not painted as Sunset');
  assert.equal(browser.staffChromeLocationTag('sunset', booking), WH);
  assert.equal(staffChromeLocationTag('sunset', { location_id: SARDI }), SARDI, 'elSardi stays elSardi');
  assert.equal(browser.staffChromeLocationTag('sunset', { location_id: SARDI }), SARDI);
  assert.equal(staffChromeLocationTag('sunset', { location_id: SUNSET }), SUNSET, 'Sunset guest unchanged');
  assert.equal(staffChromeLocationTag('sunset', {}), '', 'empty Sunset row does not invent Wolfhouse');
  assert.equal(browser.staffChromeLocationTagHtml(WH, bled), '<span class="staff-location-id-tag" data-location-id="wolfhouse-somo">wolfhouse-somo</span>');
  assert.equal(browser.staffChromeLocationTagHtml('sunset', { location_id: SUNSET }), '', 'Sunset guests do not get the Wolfhouse chip');

  const schedule = loadScheduleLabel();
  assert.equal(
    schedule.scheduleResolveDrawerSchoolLabel({ location_id: SUNSET }, { location_id: SUNSET }),
    WH,
    'schedule chrome on Wolfhouse does not say Sunset',
  );
  schedule.getClient = () => 'sunset';
  assert.equal(
    schedule.scheduleResolveDrawerSchoolLabel({ location_id: SARDI }, null),
    'elSardi',
    'Sunset schedule label unchanged',
  );
  assert.equal(
    schedule.scheduleResolveDrawerSchoolLabel({ location_id: WH }, { location_id: SUNSET }),
    WH,
    'a Wolfhouse booking on the schedule drawer keeps wolfhouse-somo',
  );

  const context = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-context.js'), 'utf8');
  const profile = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-customers-profile.js'), 'utf8');
  const drawer = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  assert.equal(context.includes('inboxCustomerLocationTagHtml'), true, 'guest card paints the location tag');
  assert.equal(profile.includes('staffChromeLocationTagHtml'), true, 'profile paints the location tag');
  assert.equal(drawer.includes('staffChromeLocationTagHtml'), true, 'schedule drawer paints the location tag');
  assert.equal(api.includes('data-location-id="wolfhouse-somo"') || api.includes('staffChromeLocationTagHtml'), true, 'booking drawer paints the tag');
  assert.equal(api.includes('.staff-location-id-tag{'), true, 'tag is visible chrome');
  assert.equal(/font-weight:\s*800/.test(api.slice(api.indexOf('.staff-location-id-tag{'), api.indexOf('.staff-location-id-tag{') + 400)), false, 'tag weight stays at most 700');
  assert.equal(api.includes("@media(max-width:768px){.staff-location-id-tag{margin:4px 0 0}}"), true, 'phone tag does not keep the desktop left margin');

  console.log('PASS verify-wolfhouse-location-tag-001');
}

main();
