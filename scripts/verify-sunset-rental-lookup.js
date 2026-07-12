'use strict';

/**
 * verify:sunset-rental-lookup
 *
 * Offline assertions for sunset-rental-price-lookup.js.
 * No API key, no DB, no network required.
 *
 * Run:
 *   node scripts/verify-sunset-rental-lookup.js
 *   npm run verify:sunset-rental-lookup
 */

const { lookupSunsetRentalPrice } = require('./lib/sunset-rental-price-lookup');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function assertOk(label, result, expected) {
  if (!result.ok) {
    console.error(`  FAIL  ${label} — got ok=false reason=${result.reason}`);
    fail++;
    return;
  }
  let detail = null;
  if (expected.amount_eur !== undefined && result.amount_eur !== expected.amount_eur) {
    detail = `amount_eur expected ${expected.amount_eur}, got ${result.amount_eur}`;
  }
  if (expected.item !== undefined && result.item !== expected.item) {
    detail = `item expected "${expected.item}", got "${result.item}"`;
  }
  if (detail) {
    console.error(`  FAIL  ${label} — ${detail}`);
    fail++;
  } else {
    console.log(`  PASS  ${label}`);
    pass++;
  }
}

function assertBlocked(label, result, expectedReason) {
  if (result.ok) {
    console.error(`  FAIL  ${label} — expected ok=false (${expectedReason}) but got ok=true amount_eur=${result.amount_eur}`);
    fail++;
    return;
  }
  if (expectedReason && result.reason !== expectedReason) {
    console.error(`  FAIL  ${label} — expected reason="${expectedReason}", got "${result.reason}"`);
    fail++;
    return;
  }
  console.log(`  PASS  ${label}`);
  pass++;
}

// ─── Section 1: tenant isolation ────────────────────────────────────────────
console.log('\n[1] Tenant isolation');

assertBlocked(
  'wolfhouse slug → tenant_mismatch',
  lookupSunsetRentalPrice({ client_slug: 'wolfhouse-somo', item: 'board', duration: '1_day' }),
  'tenant_mismatch',
);

assertBlocked(
  'empty slug → tenant_mismatch',
  lookupSunsetRentalPrice({ client_slug: '', item: 'board', duration: '1_day' }),
  'tenant_mismatch',
);

assertBlocked(
  'unknown slug → tenant_mismatch',
  lookupSunsetRentalPrice({ client_slug: 'other-client', item: 'board', duration: '1_day' }),
  'tenant_mismatch',
);

// ─── Section 2: owner-managed rental prices are confirmed for live quotes ────
console.log('\n[2] Live mode uses owner-managed confirmed rental prices');

assertOk('board 1_day live = 15 EUR', lookupSunsetRentalPrice({ item: 'board', duration: '1_day' }), { amount_eur: 15, pricing_status: 'confirmed' });
assertOk('wetsuit 7_days live = 45 EUR', lookupSunsetRentalPrice({ item: 'wetsuit', duration: '7_days' }), { amount_eur: 45, pricing_status: 'confirmed' });
assertOk('board+suit 5_days live = 65 EUR', lookupSunsetRentalPrice({ item: 'board_suit', duration: '5_days' }), { amount_eur: 65, pricing_status: 'confirmed' });
assertOk('SUP 1_day live = 30 EUR', lookupSunsetRentalPrice({ item: 'sup', duration: '1_day' }), { amount_eur: 30, pricing_status: 'confirmed' });

// ─── Section 3: dry-run mode (require_confirmed=false) returns seed prices ──
console.log('\n[3] Dry-run / preview mode (require_confirmed=false)');

assertOk(
  'board_rental 1_day = 15 EUR',
  lookupSunsetRentalPrice({ item: 'board', duration: '1_day', require_confirmed: false }),
  { amount_eur: 15, item: 'board_rental' },
);

assertOk(
  'natural tool args board + 1 day normalize to configured keys',
  lookupSunsetRentalPrice({ item: 'board', duration: '1 day', require_confirmed: false }),
  { amount_eur: 15, item: 'board_rental', duration: '1_day' },
);

assertOk(
  'natural tool args board+wetsuit + half day normalize to configured keys',
  lookupSunsetRentalPrice({ item: 'board+wetsuit', duration: 'half day', require_confirmed: false }),
  { amount_eur: 15, item: 'board_and_suit_rental', duration: 'half_day' },
);

assertOk(
  'board_rental half_day = 10 EUR',
  lookupSunsetRentalPrice({ item: 'board', duration: 'half_day', require_confirmed: false }),
  { amount_eur: 10 },
);

assertOk(
  'board_rental 7_days = 70 EUR',
  lookupSunsetRentalPrice({ item: 'board_rental', duration: '7_days', require_confirmed: false }),
  { amount_eur: 70 },
);

assertOk(
  'wetsuit_rental 7_days = 45 EUR',
  lookupSunsetRentalPrice({ item: 'wetsuit', duration: '7_days', require_confirmed: false }),
  { amount_eur: 45 },
);

assertOk(
  'wetsuit_rental half_day = 8 EUR',
  lookupSunsetRentalPrice({ item: 'wetsuit_rental', duration: 'half_day', require_confirmed: false }),
  { amount_eur: 8 },
);

assertOk(
  'board_and_suit_rental 5_days = 65 EUR (canonical key)',
  lookupSunsetRentalPrice({ item: 'board_and_suit_rental', duration: '5_days', require_confirmed: false }),
  { amount_eur: 65 },
);

assertOk(
  'board_suit 5_days = 65 EUR (alias)',
  lookupSunsetRentalPrice({ item: 'board_suit', duration: '5_days', require_confirmed: false }),
  { amount_eur: 65 },
);

assertOk(
  'bundle 1_day = 20 EUR (alias)',
  lookupSunsetRentalPrice({ item: 'bundle', duration: '1_day', require_confirmed: false }),
  { amount_eur: 20 },
);

assertOk(
  'sup_rental 1_day = 30 EUR',
  lookupSunsetRentalPrice({ item: 'sup', duration: '1_day', require_confirmed: false }),
  { amount_eur: 30 },
);

assertOk(
  'sup_rental 1_hour = 10 EUR',
  lookupSunsetRentalPrice({ item: 'sup_rental', duration: '1_hour', require_confirmed: false }),
  { amount_eur: 10 },
);

// ─── Section 4: missing / null prices — price_not_configured ────────────────
console.log('\n[4] Missing / unconfigured prices → price_not_configured');

assertBlocked(
  'sup 5_days (not on public site) → price_not_configured',
  lookupSunsetRentalPrice({ item: 'sup', duration: '5_days', require_confirmed: false }),
  'price_not_configured',
);

assertBlocked(
  'sup 2_days (not on public site) → price_not_configured',
  lookupSunsetRentalPrice({ item: 'sup', duration: '2_days', require_confirmed: false }),
  'price_not_configured',
);

assertBlocked(
  'sup 7_days (not on public site) → price_not_configured',
  lookupSunsetRentalPrice({ item: 'sup', duration: '7_days', require_confirmed: false }),
  'price_not_configured',
);

// ─── Section 5: unknown item / unknown window ────────────────────────────────
console.log('\n[5] Unknown item or window');

assertBlocked(
  'unknown item "kayak" → unknown_item',
  lookupSunsetRentalPrice({ item: 'kayak', duration: '1_day', require_confirmed: false }),
  'unknown_item',
);

assertBlocked(
  'unknown item "" → unknown_item',
  lookupSunsetRentalPrice({ item: '', duration: '1_day', require_confirmed: false }),
  'unknown_item',
);

assertBlocked(
  'board with unknown window "3_days" → price_not_configured',
  lookupSunsetRentalPrice({ item: 'board', duration: '3_days', require_confirmed: false }),
  'price_not_configured',
);

assertBlocked(
  'board with empty duration → price_not_configured',
  lookupSunsetRentalPrice({ item: 'board', duration: '', require_confirmed: false }),
  'price_not_configured',
);

// ─── Section 6: result metadata ─────────────────────────────────────────────
console.log('\n[6] Result metadata');

{
  const r = lookupSunsetRentalPrice({ item: 'board', duration: '1_day', require_confirmed: false });
  assert('result has client_slug=sunset',  r.client_slug === 'sunset');
  assert('result has tenant_id=sunset',    r.tenant_id === 'sunset');
  assert('result has currency=EUR',         r.currency === 'EUR');
  assert('result has pricing_status',       typeof r.pricing_status === 'string');
  assert('result has source (public_site)', r.source === 'public_site');
  assert('result has source_url',           typeof r.source_url === 'string' && r.source_url.startsWith('http'));
  assert('result live_quote_allowed=true (owner-managed confirmed)', r.live_quote_allowed === true);
}

// ─── Section 7: explicit client_slug=sunset accepted ────────────────────────
console.log('\n[7] Explicit client_slug=sunset');

assertOk(
  'explicit client_slug=sunset + board 1_day (dry-run)',
  lookupSunsetRentalPrice({ client_slug: 'sunset', item: 'board', duration: '1_day', require_confirmed: false }),
  { amount_eur: 15 },
);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nverify:sunset-rental-lookup — ${pass + fail} tests: ${pass} PASS, ${fail} FAIL`);
if (fail > 0) {
  console.error(`\nFAILED (${fail} failure${fail !== 1 ? 's' : ''})`);
  process.exit(1);
} else {
  console.log('\nPASSED — no API key required');
}
