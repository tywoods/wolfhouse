'use strict';

process.env.NODE_ENV = 'test';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.WHATSAPP_DRY_RUN = 'true';

const vm = require('vm');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

let passed = 0;
let failed = 0;

function check(id, ok, msg) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL ${id}: ${msg}`);
}

function t(key, vars) {
  let text = STAFF_PORTAL_STRINGS.en[key] || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      text = String(text).split(`{${k}}`).join(String(vars[k]));
    });
  }
  return text;
}

// Quote math: 2 guests, 7 nights, double room → €70 flat supplement (€10/night × 7)
{
  const shared = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-06-01',
    check_out: '2026-06-08',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
  });
  const priv = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-06-01',
    check_out: '2026-06-08',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'double',
    payment_choice: 'deposit',
    add_ons: [],
  });
  check('Q1', shared.success && priv.success, 'malibu 7n quotes succeed');
  const supp = (priv.line_items || []).find((i) => i.code === 'room_supplement');
  check('Q2', !!supp, 'double quote has room_supplement line');
  check('Q3', supp && supp.total_cents === 7000, `supplement €70 (got ${supp && supp.total_cents})`);
  check('Q4', priv.total_cents - shared.total_cents === 7000, 'toggle delta is €70');
  const sharedNoSupp = (shared.line_items || []).some((i) => i.code === 'room_supplement' && i.total_cents > 0);
  check('Q5', !sharedNoSupp, 'shared quote has no supplement');
}

// Payments line i18n template
{
  const line = t('drawer.invoice.privateRoomSupplementLine', {
    perNight: '€10.00',
    nights: '7',
    total: '€70.00',
  });
  check('I1', /Private room supplement/.test(line), 'en supplement line label');
  check('I2', /€10\.00/.test(line) && /€70\.00/.test(line), 'en supplement line amounts');
  check('I3', /7/.test(line), 'en supplement line nights');
}

// Portal source wiring (static checks)
{
  const src = readStaffPortalUiSource();
  check('S1', src.includes("edit_type: 'private_room'"), 'edit_type private_room in portal JS');
  check('S2', src.includes('bc-private-room-switch') && src.includes('bc-field-private-room-switch'), 'private room grey switch in edit UI');
  check('S3', src.includes('bcRenderPrivateRoomSupplementLineHtml') && !src.includes('id="bc-inv-private-room"'), 'supplement under accommodation');
  check('S4', src.includes('handleBookingEditWritePrivateRoom'), 'private room write handler');
  check('S5', src.includes('EDIT_WRITE_PRIVATE_ROOM_UPDATE_SQL'), 'private room update SQL');
  check('S6', src.includes('bcQuoteRoomSupplementLine'), 'supplement line helper');
  check('S7', /bcBookingPrivateRoomEnabled[\s\S]{0,400}new RegExp\('\\\\\\\\b/.test(src), 'private room pref uses RegExp in UI');
  check('S8', src.includes('bc-field-private-room-read-kv') && !src.includes("bcRenderFieldEditPencilBtn('private_room'"), 'private room in guests row with single edit pencil');
  check('S9', src.includes('editWriteSyncPrivateRoomBedBlocks') && src.includes('private_room_room_not_empty'), 'private room companion bed blocking with room-not-empty error');
  check('S10', src.includes('editWritePrivateRoomBedBlockUserMessage'), 'private room bed block user message helper');
  check('S11', src.includes('private_room_parent_booking_id') && src.includes("assignment_type = 'staff_block'"), 'private room companion beds use staff-style block bookings');
}

// Portal UI bundle syntax (rendered through the production /staff/ui builder)
{
  const api = require('./staff-query-api');
  check('UI0', typeof api.buildUiHtmlForOfflineTest === 'function', 'production UI builder seam is exposed');
  const html = typeof api.buildUiHtmlForOfflineTest === 'function'
    ? api.buildUiHtmlForOfflineTest(3036, 'wolfhouse-somo')
    : '';
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const main = scripts.find((s) => s.includes('bcOnBedCalendarTabOpen'));
  check('UI1', !!main, 'main portal script present');
  if (main) {
    try {
      new vm.Script(`(function(){\n${main}\n})();`, { filename: 'portal-ui.js' });
      check('UI2', true, 'portal script syntax valid');
    } catch (e) {
      check('UI2', false, `portal script syntax: ${e.message}`);
    }
  }
  check('UI3', html.includes('window.doLogout = function doLogout'), 'doLogout in HTML');
  check('UI4', !html.includes('return /\x08'), 'no backspace-corrupted regex');
}

console.log(`\nverify-staff-portal-private-room-ui: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
