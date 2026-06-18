'use strict';

const fs = require('fs');
const path = require('path');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

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
  const apiPath = path.join(__dirname, 'staff-query-api.js');
  const src = fs.readFileSync(apiPath, 'utf8');
  check('S1', src.includes("edit_type: 'private_room'"), 'edit_type private_room in portal JS');
  check('S2', src.includes('bc-field-private-room'), 'private room checkbox id');
  check('S3', src.includes('bc-inv-private-room'), 'payments supplement section id');
  check('S4', src.includes('handleBookingEditWritePrivateRoom'), 'private room write handler');
  check('S5', src.includes('EDIT_WRITE_PRIVATE_ROOM_UPDATE_SQL'), 'private room update SQL');
  check('S6', src.includes('bcQuoteRoomSupplementLine'), 'supplement line helper');
}

console.log(`\nverify-staff-portal-private-room-ui: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
