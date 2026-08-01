'use strict';

/**
 * verify:luna-tenant-catalog-s1
 * Sunset Luna tenant/catalog-driven Slice 1 contracts.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  listConfiguredRentalOfferings,
  matchRentalFromMessage,
  buildRentalAvailabilitySummary,
  lookupSunsetRentalPrice,
  isConfiguredRentalItem,
} = require('./lib/sunset-rental-price-lookup');
const { resolveSunsetAdminConfigForLuna } = require('./lib/sunset-luna-school-context');
const { runSunsetGuestSchoolTurnDryRun } = require('./lib/luna-guest-sunset-school-turn');
const { resolvePackageExplainerIntent, buildPackageExplainerReply } = require('./lib/luna-guest-package-explainer');
const { buildTransferSideQuestionReply } = require('./lib/luna-guest-service-transfer-explainer');
const { buildCheckinDayMessageBody } = require('./lib/luna-guest-checkin-day-message');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

const soul = fs.readFileSync(path.join(__dirname, '../docker/hermes-sunset/SOUL.md'), 'utf8');
const plugin = fs.readFileSync(
  path.join(__dirname, '../docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
  'utf8',
);

console.log('SOUL commercial hardcodes removed');
check('no €10 literal', () => assert.ok(!/€10/.test(soul)));
check('no fixed six-duration menu in tool docs', () => {
  assert.ok(!/1 hour, half day, 1 day, 2 days, 5 days, 7 days/.test(soul));
});
check('no fixed item list board/wetsuit/bundle/SUP in tool docs', () => {
  assert.ok(!/board \/ wetsuit \/ board\+suit bundle \/ SUP/.test(soul));
});
check('no wrong weekday example Tuesday 2 August 2026', () => {
  assert.ok(!/Tuesday 2 August 2026/.test(soul));
});
check('instructs catalog tools for rental menu', () => {
  assert.ok(/get_sunset_rental_price/.test(soul));
  assert.ok(/live catalog|admin config|get_sunset_admin_config_snapshot/i.test(soul));
});
check('school binding not deployment-assumed Somo-only', () => {
  assert.ok(/verified inbound/i.test(soul));
  assert.ok(!/For the current Somo number, treat `sunset-somo` as known/.test(soul));
});
check('inclusions not stated as unconditional fact', () => {
  assert.ok(!/Board, wetsuit and wax are included with lessons/.test(soul));
});

console.log('Catalog-driven rental helpers');
const adminCfg = resolveSunsetAdminConfigForLuna('sunset', 'sunset-somo');
check('admin config loads', () => assert.ok(adminCfg && Array.isArray(adminCfg.prices)));
const offerings = listConfiguredRentalOfferings(adminCfg);
check('lists configured rental offerings from prices', () => {
  assert.ok(offerings.length >= 2);
  assert.ok(offerings.every((o) => o.offering_key && Array.isArray(o.durations)));
});
check('match board half day from message', () => {
  const m = matchRentalFromMessage('how much to rent a board half day?', adminCfg);
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.item, 'board_rental');
  assert.strictEqual(m.duration, 'half_day');
});
check('match only configured items — synthetic kayak not offered if absent', () => {
  const keys = new Set(offerings.map((o) => o.offering_key));
  if (keys.has('kayak_rental')) return; // skip if someday configured
  const m = matchRentalFromMessage('I want a kayak rental for 1 day', adminCfg);
  assert.ok(!m.ok || m.item !== 'kayak_rental');
});
check('availability summary only uses catalog labels', () => {
  const text = buildRentalAvailabilitySummary('en', 'Sunset Somo', adminCfg);
  assert.ok(/currently rent/i.test(text));
  for (const o of offerings) {
    assert.ok(text.includes(o.label) || text.includes(o.offering_key), `missing ${o.offering_key}`);
  }
  assert.ok(!/kayak/i.test(text));
});
check('new configured item is recognized when injected', () => {
  const cfg = {
    prices: [
      ...(adminCfg.prices || []),
      {
        category: 'rental',
        offering_key: 'foil_board_rental',
        label: 'Foil board',
        unit: '1_day',
        amount: 40,
        active: true,
        pricing_status: 'confirmed',
      },
    ],
  };
  assert.ok(isConfiguredRentalItem(cfg, 'foil_board_rental'));
  const m = matchRentalFromMessage('rent a foil board for 1 day', cfg);
  assert.strictEqual(m.item, 'foil_board_rental');
  assert.strictEqual(m.duration, '1_day');
  const summary = buildRentalAvailabilitySummary('en', 'Sunset', cfg);
  assert.ok(/Foil board/.test(summary));
});
check('removed rental not offered', () => {
  const cfg = {
    prices: (adminCfg.prices || []).filter((p) => p.offering_key !== 'sup_rental'),
  };
  const m = matchRentalFromMessage('SUP rental half day', cfg);
  assert.ok(!m.ok || m.item !== 'sup_rental');
  const summary = buildRentalAvailabilitySummary('en', 'Sunset', cfg);
  assert.ok(!/\bSUP\b/i.test(summary) || !listConfiguredRentalOfferings(cfg).some((o) => o.offering_key === 'sup_rental'));
});
check('lookup accepts configured non-alias item', () => {
  // board_rental still works
  const r = lookupSunsetRentalPrice({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board_rental',
    duration: '1_day',
    require_confirmed: false,
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

console.log('Sunset school turn catalog replies');
async function schoolTurnChecks() {
  const outMenu = await runSunsetGuestSchoolTurnDryRun({
    message_text: "what's available to rent?",
    client_slug: 'sunset',
    conversation_metadata: { location_id: 'sunset-somo' },
  }, {}, { gate_status: 'allowed_dry_run' });
  check('available menu reply is catalog-grounded', () => {
    const reply = outMenu.proposed_luna_reply || '';
    assert.ok(/currently rent/i.test(reply));
    assert.ok(!/€10\/person/.test(reply));
  });

  const outPrice = await runSunsetGuestSchoolTurnDryRun({
    message_text: 'how much is a board rental for half day?',
    client_slug: 'sunset',
    conversation_metadata: { location_id: 'sunset-somo' },
  }, {}, { gate_status: 'allowed_dry_run' });
  check('rental price path uses catalog item', () => {
    const payloads = outPrice.result && outPrice.result.sunset_tool_payloads;
    assert.ok(Array.isArray(payloads));
    const hit = payloads.find((p) => p.kind === 'get_sunset_rental_price');
    assert.ok(hit, 'expected rental price tool payload');
    assert.strictEqual(hit.item, 'board_rental');
    assert.strictEqual(hit.duration, 'half_day');
  });
}

console.log('Anti-Wolfhouse leak tenant gates');
check('package explainer null for sunset client', () => {
  const reply = buildPackageExplainerReply('en', 'overview', { client_slug: 'sunset' });
  assert.strictEqual(reply, null);
});
check('transfer explainer empty for sunset client', () => {
  const reply = buildTransferSideQuestionReply('en', 'Do you have airport transfer from Santander?', {
    client_slug: 'sunset',
  });
  assert.strictEqual(reply, '');
});
check('checkin day refuses sunset tenant', () => {
  let threw = false;
  try {
    buildCheckinDayMessageBody({ client_slug: 'sunset', language: 'en' }, {});
  } catch (e) {
    threw = /tenant_not_accommodation/.test(String(e.message || e));
  }
  assert.ok(threw);
});
check('composer does not enter explain_packages for sunset', () => {
  const out = composeLunaGuestReply({
    client_slug: 'sunset',
    message_text: 'what packages do you have? Malibu vs Waimea?',
    payload: {
      result: {
        message_lane: 'new_booking_inquiry',
        detected_language: 'en',
        extracted_fields: { check_in: '2026-08-10', check_out: '2026-08-17', guest_count: 2 },
      },
      quote: {},
      availability: {},
      payment_choice: {},
    },
    prior_guest_context: { client_slug: 'sunset' },
  });
  assert.ok(out.composer_state !== 'explain_packages', `state=${out.composer_state}`);
  if (out.reply) {
    assert.ok(!/Malibu|Uluwatu|Waimea|Wolfhouse/i.test(out.reply));
  }
});
check('wolfhouse package explainer still works', () => {
  const intent = resolvePackageExplainerIntent('what packages do you offer?');
  assert.ok(intent);
  const reply = buildPackageExplainerReply('en', intent || 'overview', { client_slug: 'wolfhouse-somo' });
  assert.ok(reply && /package|Malibu|stay/i.test(reply));
});

console.log('Equipment structured-field guard');
check('create_sunset_booking rejects notes-only equipment (catalog/quote-driven)', () => {
  assert.ok(plugin.includes('equipment_must_use_structured_fields'));
  assert.ok(plugin.includes('_sunset_quote_or_payload_equipment_intent'));
  assert.ok(plugin.includes('_sunset_has_structured_rental_or_equipment'));
  // Must NOT rely solely on a fixed item-label whitelist.
  assert.ok(!/"board rental",\s*\n\s*"sup rental"/.test(plugin));
  assert.ok(plugin.includes('_SUNSET_SERVICE_COMPONENT_KEYS'));
  assert.ok(plugin.includes('foil_board_rental') || plugin.includes('newly catalogued'));
});

Promise.resolve()
  .then(() => schoolTurnChecks())
  .then(() => {
    console.log(`\nResults: ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
