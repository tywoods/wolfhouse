'use strict';

// Transfers edit panel no longer collects guest refusal text.
// Luna phrases refusals from settings. Saved old text is ignored.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = fs.readFileSync(path.join(__dirname, 'browser/wolfhouse-admin-pricing-ui.js'), 'utf8');
const writes = require('./lib/wolfhouse-pricing-writes');
const { priceBookingTransfer, assertTransferGroupOverrideAllowed } = require('./lib/booking-transfers');
const { buildTransferSideQuestionReply } = require('./lib/luna-guest-service-transfer-explainer');
const { composeTransferGuestRefusal } = require('./lib/luna-transfer-refusal');

function check(name, fn) {
  fn();
  console.log('PASS', name);
}

check('edit panel has no guest message boxes', () => {
  assert.equal(ui.includes('Message when no package'), false);
  assert.equal(ui.includes('Message when group too small'), false);
  assert.equal(ui.includes('wh-price-transfer-msg-package'), false);
  assert.equal(ui.includes('wh-price-transfer-msg-group'), false);
  assert.equal(ui.includes('unavailable_no_package_message'), false);
  assert.equal(ui.includes('unavailable_below_min_group_message'), false);
  assert.match(ui, /Package required/);
  assert.match(ui, /Included with a package/);
  assert.match(ui, /Minimum group size/);
  assert.match(ui, /Max group size/);
  assert.match(ui, /Charged per/);
});

check('validator ignores submitted guest messages', () => {
  const parsed = writes.validateTransferRuleBody({
    airport_code: 'BIO',
    label: 'Bilbao',
    requires_package: true,
    included_when_package: false,
    min_guest_count: 4,
    max_guest_count: 8,
    unavailable_no_package_message: 'DO NOT SAY BUS',
    unavailable_below_min_group_message: 'DO NOT SAY OVERRIDE',
  });
  assert.equal(parsed.ok, true);
  assert.equal(Object.hasOwn(parsed.value, 'unavailable_no_package_message'), false);
  assert.equal(Object.hasOwn(parsed.value, 'unavailable_below_min_group_message'), false);
  assert.equal(parsed.value.requires_package, true);
  assert.equal(parsed.value.min_guest_count, 4);
  assert.equal(parsed.value.max_guest_count, 8);
});

const planted = {
  airport_code: 'BIO',
  label: 'Bilbao',
  requires_package: true,
  included_when_package: false,
  min_guest_count: 4,
  max_guest_count: 8,
  per_person_extra_cents: 2000,
  unavailable_no_package_message: 'DO NOT SAY BUS',
  unavailable_below_min_group_message: 'DO NOT SAY OVERRIDE',
};

check('refusal copy uses settings and ignores saved text', () => {
  const noPackage = composeTransferGuestRefusal(planted, 'no_package', 'en', 'Bilbao');
  assert.match(noPackage, /only available with a package/);
  assert.match(noPackage, /€20 per person/);
  assert.match(noPackage, /groups of 4 to 8/);
  assert.equal(noPackage.includes('DO NOT SAY BUS'), false);
  assert.equal(noPackage.includes('Exception Override'), false);

  const tooSmall = composeTransferGuestRefusal(planted, 'below_min', 'es', 'Bilbao');
  assert.match(tooSmall, /al menos 4/);
  assert.match(tooSmall, /€20 por persona/);
  assert.match(tooSmall, /paquete/);
  assert.equal(tooSmall.includes('DO NOT SAY'), false);
});

function quote(booking, airportCode) {
  return priceBookingTransfer({
    client_slug: 'wolfhouse-somo',
    booking,
    transfer: { airport_code: airportCode },
    resolvedConfig: {
      currency: 'EUR',
      airports: [{ code: 'BIO', label: 'Bilbao', iata: 'BIO', aliases: ['bilbao'] },
        { code: 'SDR', label: 'Santander', iata: 'SDR', aliases: ['santander'] }],
      rules: [planted, {
        airport_code: 'SDR',
        requires_package: false,
        included_when_package: true,
        min_guest_count: null,
        max_guest_count: null,
        flat_price_cents: 2500,
        unavailable_no_package_message: 'DO NOT SAY BUS',
        unavailable_below_min_group_message: 'DO NOT SAY OVERRIDE',
      }],
    },
  });
}

check('priced refusal ignores saved guest text', () => {
  const refused = quote({ guest_count: 2 }, 'BIO');
  assert.equal(refused.available, false);
  assert.equal(refused.error_code, 'bilbao_package_required');
  assert.match(refused.pricing_note, /only available with a package/);
  assert.match(refused.pricing_note, /€20 per person/);
  assert.equal(refused.pricing_note.includes('DO NOT SAY BUS'), false);

  const small = quote({ guest_count: 2, package_code: 'malibu' }, 'BIO');
  assert.equal(small.error_code, 'bilbao_min_group');
  assert.match(small.pricing_note, /at least 4 guests/);
  assert.match(small.pricing_note, /needs a package/);
  assert.equal(small.pricing_note.includes('DO NOT SAY OVERRIDE'), false);
});

check('included Santander note stays the static Luna sentence', () => {
  const included = priceBookingTransfer({
    client_slug: 'wolfhouse-somo',
    booking: { guest_count: 2, package_code: 'malibu' },
    transfer: { airport_code: 'SDR' },
  });
  assert.equal(included.pricing_note, 'Santander transfer included in package.');
});

check('staff min-group block does not quote saved guest text', () => {
  let thrown = null;
  try {
    assertTransferGroupOverrideAllowed({
      client_slug: 'wolfhouse-somo',
      booking: { guest_count: 2, package_code: 'malibu' },
      transferInput: { airport_code: 'BIO' },
      resolvedConfig: {
        currency: 'EUR',
        airports: [{ code: 'BIO', label: 'Bilbao', iata: 'BIO', aliases: ['bilbao'] }],
        rules: [planted],
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.equal(thrown && thrown.code, 'bilbao_min_group_override_required');
  assert.match(thrown.message, /Bilbao transfer needs at least 4 guests/);
  assert.match(thrown.message, /Exception Override/);
  assert.equal(thrown.message.includes('DO NOT SAY'), false);
});

check('Luna Bilbao refusal follows passed settings, not saved text', () => {
  const reply = buildTransferSideQuestionReply('en', 'Can you pick us up from Bilbao?', {
    packageInterest: 'no_package',
    guestCount: 2,
    transferRules: [Object.assign({}, planted, { label: 'Bilbao' })],
  });
  assert.match(reply, /only available with a package/);
  assert.match(reply, /€20 per person/);
  assert.match(reply, /groups of 4 to 8/);
  assert.equal(reply.includes('DO NOT SAY BUS'), false);
  assert.equal(reply.includes('We recommend the bus'), false);
});

check('staff amount €0 wins over a leftover €50', () => {
  const staffZero = {
    airport_code: 'SDR',
    label: 'Santander',
    requires_package: false,
    included_when_package: false,
    price: { amount_cents: 0, unit: 'flat', currency: 'EUR' },
    per_person_extra_cents: 5000,
    flat_price_cents: 5000,
    unavailable_no_package_message: 'Airport transfer is €50',
    unavailable_below_min_group_message: 'Pay €50',
  };
  const facts = composeTransferGuestRefusal(staffZero, 'other', 'en', 'Santander');
  assert.match(facts, /€0/);
  assert.equal(facts.includes('€50'), false);
  assert.equal(facts.includes('€25'), false);
  assert.equal(facts.includes('Pay €50'), false);
  const reply = buildTransferSideQuestionReply('en', 'Do you offer airport pickup?', {
    transferRules: [staffZero],
  });
  assert.match(reply, /€0/);
  assert.equal(reply.includes('€50'), false);
  assert.equal(reply.includes('€25'), false);
});

check('Sunset transfer reply stays empty', () => {
  assert.equal(buildTransferSideQuestionReply('en', 'Do you have airport transfer from Santander?', {
    client_slug: 'sunset',
  }), '');
});

async function proveStoredTextIgnored() {
  const { saveTransferRule } = require('./lib/wolfhouse-pricing-store');
  const calls = [];
  const pg = {
    query: async (sql, args) => {
      calls.push({ sql, args });
      if (/SELECT id FROM wh_pricing_transfer_rules/.test(sql)) {
        return { rows: args[1] === 'BIO' ? [{ id: 1 }] : [] };
      }
      return { rows: [{ airport_code: args[1] }] };
    },
  };
  await saveTransferRule(pg, 'wolfhouse-somo', {
    airport_code: 'BIO',
    label: 'Bilbao',
    aliases: ['bilbao'],
    requires_package: true,
    included_when_package: false,
    min_guest_count: 6,
    max_guest_count: 9,
    active: true,
    unavailable_no_package_message: 'NEW PACKAGE TEXT',
    unavailable_below_min_group_message: 'NEW GROUP TEXT',
  }, null);
  const update = calls.find((call) => /UPDATE wh_pricing_transfer_rules/.test(call.sql));
  assert.ok(update);
  assert.equal(update.sql.includes('unavailable_no_package_message'), false);
  assert.equal(update.sql.includes('unavailable_below_min_group_message'), false);
  assert.equal(update.args.includes('NEW PACKAGE TEXT'), false);
  assert.equal(update.args.includes('NEW GROUP TEXT'), false);
  assert.equal(update.args[6], 6);
  assert.equal(update.args[10], 9);

  await saveTransferRule(pg, 'wolfhouse-somo', {
    airport_code: 'MAD',
    label: 'Madrid',
    aliases: [],
    requires_package: true,
    included_when_package: false,
    min_guest_count: 2,
    active: true,
    unavailable_no_package_message: 'SHOULD NOT INSERT',
  }, null);
  const insert = calls.find((call) => /INSERT INTO wh_pricing_transfer_rules/.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /NULL, NULL/);
  assert.equal(insert.args.includes('SHOULD NOT INSERT'), false);
  console.log('PASS saved old text is ignored on update and not stored on insert');
}

proveStoredTextIgnored().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
