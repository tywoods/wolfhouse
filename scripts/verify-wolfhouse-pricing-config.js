'use strict';
/**
 * verify-wolfhouse-pricing-config.js
 * Stage 8.4.2 — Static verifier for config/clients/wolfhouse-somo.pricing.json
 *
 * Checks:
 *  A. File exists and is valid JSON.
 *  B. Top-level metadata fields.
 *  C. All 3 packages exist with correct seasonal prices.
 *  D. Season/month mapping and August priority.
 *  E. Room supplement = 1000 cents.
 *  F. Deposits = 20000 / 10000 cents; scope confirmed.
 *  G. Hold = 60 minutes.
 *  H. Payment options include deposit, full, pay_on_arrival.
 *  I. Balance methods include cash, bank_transfer, stripe_on_arrival.
 *  J. All add-on prices match known values.
 *  K. REQUIRED_FROM_STAFF markers present for unresolved items.
 *  L. No invented/unknown prices.
 *  M. No secrets (Stripe key, WhatsApp token, n8n token).
 *
 * Usage:
 *   node scripts/verify-wolfhouse-pricing-config.js
 *   node --check scripts/verify-wolfhouse-pricing-config.js
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

let passed = 0;
let failed = 0;

function check(id, description, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log(`  PASS [${id}] ${description}`);
      passed++;
    } else {
      console.error(`  FAIL [${id}] ${description}`);
      if (typeof result === 'string') console.error(`       → ${result}`);
      failed++;
    }
  } catch (err) {
    console.error(`  FAIL [${id}] ${description}`);
    console.error(`       → ${err.message}`);
    failed++;
  }
}

// ─── Load config ────────────────────────────────────────────────────────────

let cfg;

check('A1', 'Config file exists at config/clients/wolfhouse-somo.pricing.json', () => {
  if (!fs.existsSync(CONFIG_PATH)) return 'File not found: ' + CONFIG_PATH;
});

check('A2', 'Config file is valid JSON', () => {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  cfg = JSON.parse(raw); // throws on invalid JSON
});

if (!cfg) {
  console.error('\n  Cannot continue — config file is missing or invalid JSON.\n');
  process.exit(1);
}

// ─── B. Top-level metadata ───────────────────────────────────────────────────

check('B1', 'client_slug = wolfhouse-somo', () => {
  if (cfg.client_slug !== 'wolfhouse-somo') return `got: ${cfg.client_slug}`;
});

check('B2', 'config_version is present and non-empty', () => {
  if (!cfg.config_version || typeof cfg.config_version !== 'string' || cfg.config_version.length === 0) {
    return `got: ${cfg.config_version}`;
  }
});

check('B3', 'currency = EUR', () => {
  if (cfg.currency !== 'EUR') return `got: ${cfg.currency}`;
});

// ─── C. Packages ─────────────────────────────────────────────────────────────

check('C1', 'packages array contains exactly 3 entries', () => {
  if (!Array.isArray(cfg.packages) || cfg.packages.length !== 3) {
    return `got ${Array.isArray(cfg.packages) ? cfg.packages.length : 'non-array'}`;
  }
});

const PKG_CODES = ['malibu', 'uluwatu', 'waimea'];
PKG_CODES.forEach(code => {
  check(`C2_${code}`, `package "${code}" exists`, () => {
    const p = (cfg.packages || []).find(p => p.code === code);
    if (!p) return `package "${code}" not found`;
  });
});

// Known weekly prices in cents (per person, shared room)
const EXPECTED_PRICES = {
  malibu:  { spring_autumn: 24900, summer: 29900, august: 34900 },
  uluwatu: { spring_autumn: 34900, summer: 39900, august: 44900 },
  waimea:  { spring_autumn: 49900, summer: 54900, august: 59900 },
};

PKG_CODES.forEach(code => {
  ['spring_autumn', 'summer', 'august'].forEach(season => {
    check(`C3_${code}_${season}`, `${code} ${season} weekly_per_person_cents = ${EXPECTED_PRICES[code][season]}`, () => {
      const pkg = (cfg.packages || []).find(p => p.code === code);
      if (!pkg) return `package "${code}" not found`;
      const sp = pkg.seasonal_prices && pkg.seasonal_prices[season];
      if (!sp) return `seasonal_prices.${season} missing`;
      if (sp.weekly_per_person_cents !== EXPECTED_PRICES[code][season]) {
        return `got: ${sp.weekly_per_person_cents}, expected: ${EXPECTED_PRICES[code][season]}`;
      }
    });
  });
});

check('C4', 'All packages have price_scope = per_person_per_week', () => {
  const bad = (cfg.packages || []).filter(p => p.price_scope !== 'per_person_per_week');
  if (bad.length) return `packages without per_person_per_week: ${bad.map(p => p.code).join(', ')}`;
});

// ─── D. Seasons ──────────────────────────────────────────────────────────────

check('D1', 'seasons array is present and non-empty', () => {
  if (!Array.isArray(cfg.seasons) || cfg.seasons.length === 0) return 'missing or empty';
});

check('D2', 'spring_autumn season contains months 4, 5, 6, 10', () => {
  const s = (cfg.seasons || []).find(s => s.code === 'spring_autumn');
  if (!s) return 'spring_autumn season not found';
  const missing = [4, 5, 6, 10].filter(m => !s.month_numbers.includes(m));
  if (missing.length) return `months missing: ${missing.join(', ')}`;
});

check('D3', 'summer season contains months 7 and 9', () => {
  const s = (cfg.seasons || []).find(s => s.code === 'summer');
  if (!s) return 'summer season not found';
  const missing = [7, 9].filter(m => !s.month_numbers.includes(m));
  if (missing.length) return `months missing: ${missing.join(', ')}`;
});

check('D4', 'august season contains month 8', () => {
  const s = (cfg.seasons || []).find(s => s.code === 'august');
  if (!s) return 'august season not found';
  if (!s.month_numbers.includes(8)) return 'month 8 not in august season';
});

check('D5', 'august season has priority >= 10', () => {
  const s = (cfg.seasons || []).find(s => s.code === 'august');
  if (!s) return 'august season not found';
  if (typeof s.priority !== 'number' || s.priority < 10) {
    return `priority = ${s.priority}, expected >= 10`;
  }
});

check('D6', 'closed season contains months 1, 2, 12 and bookable = false', () => {
  const s = (cfg.seasons || []).find(s => s.code === 'closed');
  if (!s) return 'closed season not found';
  const missing = [1, 2, 12].filter(m => !s.month_numbers.includes(m));
  if (missing.length) return `months missing: ${missing.join(', ')}`;
  if (s.bookable !== false) return `bookable = ${s.bookable}, expected false`;
});

// ─── E. Room supplements ─────────────────────────────────────────────────────

check('E1', 'room_supplements.double.per_person_per_night_cents = 1000', () => {
  const supp = cfg.room_supplements && cfg.room_supplements.double;
  if (!supp) return 'room_supplements.double missing';
  if (supp.per_person_per_night_cents !== 1000) {
    return `got: ${supp.per_person_per_night_cents}`;
  }
});

check('E2', 'room_supplements.private.per_person_per_night_cents = 1000', () => {
  const supp = cfg.room_supplements && cfg.room_supplements.private;
  if (!supp) return 'room_supplements.private missing';
  if (supp.per_person_per_night_cents !== 1000) {
    return `got: ${supp.per_person_per_night_cents}`;
  }
});

check('E3', 'room_supplements.shared.per_person_per_night_cents = 0', () => {
  const supp = cfg.room_supplements && cfg.room_supplements.shared;
  if (!supp) return 'room_supplements.shared missing';
  if (supp.per_person_per_night_cents !== 0) {
    return `got: ${supp.per_person_per_night_cents}`;
  }
});

// ─── F. Deposits ──────────────────────────────────────────────────────────────

check('F1', 'deposits.tiers.standard_package.amount_cents = 20000', () => {
  const tier = cfg.deposits && cfg.deposits.tiers && cfg.deposits.tiers.standard_package;
  if (!tier) return 'deposits.tiers.standard_package missing';
  if (tier.amount_cents !== 20000) return `got: ${tier.amount_cents}`;
});

check('F2', 'deposits.tiers.custom_or_short_stay.amount_cents = 10000', () => {
  const tier = cfg.deposits && cfg.deposits.tiers && cfg.deposits.tiers.custom_or_short_stay;
  if (!tier) return 'deposits.tiers.custom_or_short_stay missing';
  if (tier.amount_cents !== 10000) return `got: ${tier.amount_cents}`;
});

check('F3', 'deposits.scope = per_booking and scope_status = confirmed', () => {
  if (!cfg.deposits) return 'deposits block missing';
  if (cfg.deposits.scope !== 'per_booking') return `scope = ${cfg.deposits.scope}`;
  if (cfg.deposits.scope_status !== 'confirmed') return `scope_status = ${cfg.deposits.scope_status}`;
});

check('F4', 'deposits.rule_type is present', () => {
  if (!cfg.deposits || !cfg.deposits.rule_type) return 'deposits.rule_type missing';
});

// ─── G. Hold ─────────────────────────────────────────────────────────────────

check('G1', 'hold.expiry_minutes = 60', () => {
  if (!cfg.hold) return 'hold block missing';
  if (cfg.hold.expiry_minutes !== 60) return `got: ${cfg.hold.expiry_minutes}`;
});

// ─── H. Payment options ──────────────────────────────────────────────────────

check('H1', 'payment_options includes "deposit"', () => {
  if (!Array.isArray(cfg.payment_options) || !cfg.payment_options.includes('deposit')) {
    return `payment_options = ${JSON.stringify(cfg.payment_options)}`;
  }
});

check('H2', 'payment_options includes "full"', () => {
  if (!Array.isArray(cfg.payment_options) || !cfg.payment_options.includes('full')) {
    return `payment_options = ${JSON.stringify(cfg.payment_options)}`;
  }
});

check('H3', 'payment_options includes "pay_on_arrival"', () => {
  if (!Array.isArray(cfg.payment_options) || !cfg.payment_options.includes('pay_on_arrival')) {
    return `payment_options = ${JSON.stringify(cfg.payment_options)}`;
  }
});

// ─── I. Balance methods ──────────────────────────────────────────────────────

check('I1', 'balance_payment_methods includes "cash"', () => {
  if (!Array.isArray(cfg.balance_payment_methods) || !cfg.balance_payment_methods.includes('cash')) {
    return `balance_payment_methods = ${JSON.stringify(cfg.balance_payment_methods)}`;
  }
});

check('I2', 'balance_payment_methods includes "bank_transfer"', () => {
  if (!Array.isArray(cfg.balance_payment_methods) || !cfg.balance_payment_methods.includes('bank_transfer')) {
    return `balance_payment_methods = ${JSON.stringify(cfg.balance_payment_methods)}`;
  }
});

check('I3', 'balance_payment_methods includes "stripe_on_arrival"', () => {
  if (!Array.isArray(cfg.balance_payment_methods) || !cfg.balance_payment_methods.includes('stripe_on_arrival')) {
    return `balance_payment_methods = ${JSON.stringify(cfg.balance_payment_methods)}`;
  }
});

// ─── J. Add-on prices ────────────────────────────────────────────────────────

check('J1', 'add_ons.wetsuit_rental.price_cents = 500', () => {
  const a = cfg.add_ons && cfg.add_ons.wetsuit_rental;
  if (!a) return 'add_ons.wetsuit_rental missing';
  if (a.price_cents !== 500) return `got: ${a.price_cents}`;
});

check('J2', 'add_ons.soft_top_rental.price_cents = 1500', () => {
  const a = cfg.add_ons && cfg.add_ons.soft_top_rental;
  if (!a) return 'add_ons.soft_top_rental missing';
  if (a.price_cents !== 1500) return `got: ${a.price_cents}`;
});

check('J3', 'add_ons.hard_board_rental.price_cents = 2000', () => {
  const a = cfg.add_ons && cfg.add_ons.hard_board_rental;
  if (!a) return 'add_ons.hard_board_rental missing';
  if (a.price_cents !== 2000) return `got: ${a.price_cents}`;
});

check('J4', 'add_ons.wetsuit_soft_top_combo.price_cents = 1500', () => {
  const a = cfg.add_ons && cfg.add_ons.wetsuit_soft_top_combo;
  if (!a) return 'add_ons.wetsuit_soft_top_combo missing';
  if (a.price_cents !== 1500) return `got: ${a.price_cents}`;
});

check('J5', 'add_ons.wetsuit_hard_board_combo.price_cents = 2000', () => {
  const a = cfg.add_ons && cfg.add_ons.wetsuit_hard_board_combo;
  if (!a) return 'add_ons.wetsuit_hard_board_combo missing';
  if (a.price_cents !== 2000) return `got: ${a.price_cents}`;
});

check('J6', 'add_ons.surf_lesson_single.price_cents = 3500', () => {
  const a = cfg.add_ons && cfg.add_ons.surf_lesson_single;
  if (!a) return 'add_ons.surf_lesson_single missing';
  if (a.price_cents !== 3500) return `got: ${a.price_cents}`;
});

check('J7', 'add_ons.surf_lesson_multi.price_cents_each = 3000 and applies_when includes >= 2', () => {
  const a = cfg.add_ons && cfg.add_ons.surf_lesson_multi;
  if (!a) return 'add_ons.surf_lesson_multi missing';
  if (a.price_cents_each !== 3000) return `price_cents_each = ${a.price_cents_each}, expected 3000`;
  if (!a.applies_when || !a.applies_when.includes('2')) return `applies_when = ${a.applies_when}, expected to reference quantity >= 2`;
});

check('J8', 'add_ons.yoga_class.price_cents = 1500 and on_site = true', () => {
  const a = cfg.add_ons && cfg.add_ons.yoga_class;
  if (!a) return 'add_ons.yoga_class missing';
  if (a.price_cents !== 1500) return `price_cents = ${a.price_cents}, expected 1500`;
  if (a.on_site !== true) return `on_site = ${a.on_site}, expected true`;
});

// ─── K. REQUIRED_FROM_STAFF markers ──────────────────────────────────────────

const REQUIRED_KEYS = [
  'proration_formula',
  'deposit_varies_by_package',
  'deposit_varies_by_room_type',
  'add_on_charge_timing',
  'group_discount_rules',
  'retreat_camp_special_pricing',
  'operator_pricing_rules',
  'multi_week_proration',
  'edge_season_months_march_november',
];

check('K1', 'missing_required_values array is present and non-empty', () => {
  if (!Array.isArray(cfg.missing_required_values) || cfg.missing_required_values.length === 0) {
    return 'missing_required_values is absent or empty';
  }
});

REQUIRED_KEYS.forEach(key => {
  check(`K2_${key}`, `missing_required_values contains entry for "${key}"`, () => {
    const found = (cfg.missing_required_values || []).find(item => item.key === key);
    if (!found) return `no entry with key="${key}" in missing_required_values`;
    const status = found.status || '';
    if (!status.includes('REQUIRED_FROM_STAFF') && !status.includes('REQUIRED_FROM_STAFF_CONFIRM')) {
      return `entry for "${key}" does not have REQUIRED_FROM_STAFF status (got: ${status})`;
    }
  });
});

check('K3', 'deposits.deposit_varies_by_package = REQUIRED_FROM_STAFF', () => {
  if (!cfg.deposits) return 'deposits block missing';
  if (cfg.deposits.deposit_varies_by_package !== 'REQUIRED_FROM_STAFF') {
    return `got: ${cfg.deposits.deposit_varies_by_package}`;
  }
});

check('K4', 'deposits.deposit_varies_by_room_type = REQUIRED_FROM_STAFF', () => {
  if (!cfg.deposits) return 'deposits block missing';
  if (cfg.deposits.deposit_varies_by_room_type !== 'REQUIRED_FROM_STAFF') {
    return `got: ${cfg.deposits.deposit_varies_by_room_type}`;
  }
});

// ─── L. No invented prices / no secrets ──────────────────────────────────────

check('L1', 'No Stripe secret key in config file (sk_live_, sk_test_, rk_live_)', () => {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  if (/sk_live_|sk_test_|rk_live_/.test(raw)) return 'Stripe secret key found in config file';
});

check('L2', 'No WhatsApp/n8n API token pattern in config file', () => {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  if (/whatsapp_token|n8n_api_key|bearer\s+ey/i.test(raw)) return 'WhatsApp or n8n token found in config file';
});

check('L3', 'No package code other than malibu, uluwatu, waimea in seasonal_prices', () => {
  const knownCodes = new Set(['malibu', 'uluwatu', 'waimea']);
  const unknownCodes = (cfg.packages || []).filter(p => !knownCodes.has(p.code)).map(p => p.code);
  if (unknownCodes.length) return `unexpected package codes: ${unknownCodes.join(', ')}`;
});

check('L4', 'No invented season codes other than spring_autumn, summer, august, closed', () => {
  const knownSeasons = new Set(['spring_autumn', 'summer', 'august', 'closed']);
  const unknownSeasons = (cfg.seasons || []).filter(s => !knownSeasons.has(s.code)).map(s => s.code);
  if (unknownSeasons.length) return `unexpected season codes: ${unknownSeasons.join(', ')}`;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\nverify-wolfhouse-pricing-config FAILED (${failed} check(s) failed)\n`);
  process.exit(1);
} else {
  console.log('\nverify-wolfhouse-pricing-config PASS\n');
  process.exit(0);
}
