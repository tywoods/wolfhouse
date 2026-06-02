'use strict';
/**
 * verify-wolfhouse-quote-calculator.js
 * Stage 8.4.3 — Verifier for wolfhouse-quote-calculator.js
 *
 * Checks:
 *  A. Structural: config loads, export exists, no forbidden deps.
 *  B. Formula B per-night ceil5 arithmetic.
 *  C. 7-night flat price (all packages × seasons).
 *  D. Non-7-night proration (4-night sample, all packages × seasons).
 *  E. Room supplement (double, private, shared).
 *  F. Deposit tiers (7-night vs. short-stay).
 *  G. Payment choice (deposit / full / pay_on_arrival).
 *  H. Add-ons (wetsuit, soft-top, hard-board, combos, lessons, yoga).
 *  I. Blockers (invalid dates, unknown package, edge months, closed months).
 *  J. Output shape (formula_summary, line_items, balance).
 *
 * Usage:
 *   node scripts/verify-wolfhouse-quote-calculator.js
 *   node --check scripts/verify-wolfhouse-quote-calculator.js
 */

const fs   = require('fs');
const path = require('path');

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

// ─── Load ────────────────────────────────────────────────────────────────────

const CALC_PATH   = path.join(__dirname, 'lib', 'wolfhouse-quote-calculator.js');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

let calculateWolfhouseQuote;
let config;

check('A1', 'Calculator file exists', () => {
  if (!fs.existsSync(CALC_PATH)) return `File not found: ${CALC_PATH}`;
});

check('A2', 'Calculator exports calculateWolfhouseQuote', () => {
  const mod = require(CALC_PATH);
  calculateWolfhouseQuote = mod.calculateWolfhouseQuote;
  if (typeof calculateWolfhouseQuote !== 'function') {
    return `calculateWolfhouseQuote is not a function (got ${typeof calculateWolfhouseQuote})`;
  }
});

if (typeof calculateWolfhouseQuote !== 'function') {
  console.error('\n  Cannot continue — calculator did not export calculateWolfhouseQuote.\n');
  process.exit(1);
}

check('A3', 'Config file exists and is valid JSON', () => {
  if (!fs.existsSync(CONFIG_PATH)) return `Config not found: ${CONFIG_PATH}`;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  config = JSON.parse(raw);
});

if (!config) {
  console.error('\n  Cannot continue — config file missing or invalid JSON.\n');
  process.exit(1);
}

// ─── A. Static source checks ─────────────────────────────────────────────────

const calcSrc = fs.readFileSync(CALC_PATH, 'utf8');

check('A4', 'Calculator source has no "require(\'pg\')" or "require(\"pg\")"', () => {
  if (/require\(['"]pg['"]\)/.test(calcSrc)) return 'Found pg require in calculator source';
});

check('A5', 'Calculator source has no fetch / node-fetch / axios', () => {
  if (/require\s*\(\s*['"](?:node-fetch|axios|fetch)['"]\s*\)/.test(calcSrc)
    || /\bfetch\s*\(/.test(calcSrc)) {
    return 'Found fetch/node-fetch/axios in calculator source';
  }
});

check('A6', 'Calculator source has no Stripe import', () => {
  if (/require\s*\(\s*['"]stripe['"]\s*\)/.test(calcSrc)) return 'Found stripe require in calculator source';
});

check('A7', 'Calculator source has no n8n or WhatsApp require/import', () => {
  if (/require\s*\(\s*['"](?:n8n|whatsapp)['"]\s*\)/.test(calcSrc)) {
    return 'Found n8n/whatsapp require in calculator source';
  }
  if (/^import\s.+from\s+['"](?:n8n|whatsapp)/m.test(calcSrc)) {
    return 'Found n8n/whatsapp import in calculator source';
  }
});

check('A8', 'Calculator source uses ceil5 (Formula B marker present)', () => {
  if (!calcSrc.includes('ceil5')) return 'ceil5 function not found — Formula B not implemented';
  if (!calcSrc.includes('Math.ceil')) return 'Math.ceil not found — ceil5 not correct';
});

check('A9', 'Calculator source documents Formula B per-night ceil5 selection', () => {
  if (!calcSrc.includes('Formula B')) return 'Formula B documentation not found in source';
});

// ─── B. Formula B arithmetic ─────────────────────────────────────────────────

check('B1', 'ceil5: ceil5(24900/7) = 4000 (Malibu spring per-night)', () => {
  // 24900/7 = 3557.14... → nearest 500 above = 4000
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 1, package_code: 'malibu', room_type: 'shared', payment_choice: 'deposit',
  }, config);
  if (!q.success) return `Calculator failed: ${q.blockers.join('; ')}`;
  // 4 nights × 1 guest × 4000 = 16000
  const pkgItem = q.line_items.find(li => li.code === 'package_proration');
  if (!pkgItem) return 'No package_proration line item found';
  if (pkgItem.unit_cents !== 4000) return `per-night unit_cents = ${pkgItem.unit_cents}, expected 4000`;
});

check('B2', '4-night Malibu spring_autumn, 1 guest: package = 16000¢', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.package_code !== 'malibu') return `package_code = ${q.package_code}`;
  const pkgItem = q.line_items.find(li => li.code === 'package_proration');
  if (!pkgItem || pkgItem.total_cents !== 16000) return `package_proration total = ${pkgItem && pkgItem.total_cents}, expected 16000`;
});

check('B3', '4-night Uluwatu spring_autumn, 1 guest: package = 20000¢ (matches config example)', () => {
  // config._examples shows Formula B gives 20000 for 4n Uluwatu spring
  // ceil5(34900/7) = ceil5(4985.71) = 5000; 5000 × 4 × 1 = 20000
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 1, package_code: 'uluwatu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  const pkgItem = q.line_items.find(li => li.code === 'package_proration');
  if (!pkgItem || pkgItem.total_cents !== 20000) return `uluwatu 4n spring = ${pkgItem && pkgItem.total_cents}¢, expected 20000¢`;
});

check('B4', '4-night Malibu spring_autumn, 2 guests: package = 32000¢', () => {
  // 4000 × 4n × 2g = 32000
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 2, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  const pkgItem = q.line_items.find(li => li.code === 'package_proration');
  if (!pkgItem || pkgItem.total_cents !== 32000) return `2-guest 4n malibu = ${pkgItem && pkgItem.total_cents}¢, expected 32000¢`;
});

check('B5', 'formula_summary contains per-night rate and Formula B label for non-7-night', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (!q.formula_summary) return 'formula_summary missing';
  if (!q.formula_summary.includes('Formula B') && !q.formula_summary.includes('ceil5')) {
    return `formula_summary does not mention Formula B or ceil5: "${q.formula_summary}"`;
  }
});

// ─── C. 7-night flat price (all packages × all seasons) ──────────────────────

const PKG_SEASON_PRICES = {
  malibu:  { spring_autumn: 24900, summer: 29900, august: 34900 },
  uluwatu: { spring_autumn: 34900, summer: 39900, august: 44900 },
  waimea:  { spring_autumn: 49900, summer: 54900, august: 59900 },
};

// One check-in date per season (spring_autumn=April, summer=July, august=August)
const SEASON_DATES = {
  spring_autumn: { check_in: '2026-04-06', check_out: '2026-04-13' }, // 7 nights
  summer:        { check_in: '2026-07-06', check_out: '2026-07-13' },
  august:        { check_in: '2026-08-03', check_out: '2026-08-10' },
};

for (const [pkgCode, seasonMap] of Object.entries(PKG_SEASON_PRICES)) {
  for (const [seasonCode, expectedWeekly] of Object.entries(seasonMap)) {
    const { check_in, check_out } = SEASON_DATES[seasonCode];
    check(`C_${pkgCode}_${seasonCode}`, `7-night ${pkgCode} ${seasonCode}: package = ${expectedWeekly}¢ × 1 guest`, () => {
      const q = calculateWolfhouseQuote({
        client_slug: 'wolfhouse-somo', check_in, check_out,
        guest_count: 1, package_code: pkgCode,
      }, config);
      if (!q.success) return `blocked: ${q.blockers.join('; ')}`;
      if (q.season_code !== seasonCode) return `season_code = "${q.season_code}", expected "${seasonCode}"`;
      const pkgItem = q.line_items.find(li => li.code === 'package');
      if (!pkgItem) return 'no "package" line item for 7-night stay';
      if (pkgItem.total_cents !== expectedWeekly) {
        return `package total = ${pkgItem.total_cents}¢, expected ${expectedWeekly}¢`;
      }
    });
  }
}

check('C_7night_2guests', '7-night Malibu spring, 2 guests: package = 24900×2 = 49800¢', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 2, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  const pkgItem = q.line_items.find(li => li.code === 'package');
  if (!pkgItem || pkgItem.total_cents !== 49800) return `package = ${pkgItem && pkgItem.total_cents}¢, expected 49800¢`;
});

check('C_7night_formula_summary', '7-night stay formula_summary uses flat weekly rate', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (!q.formula_summary) return 'formula_summary missing';
  if (q.formula_summary.includes('Formula B') || q.formula_summary.includes('ceil5')) {
    return `7-night formula_summary should not mention Formula B/ceil5 for flat rate: "${q.formula_summary}"`;
  }
  if (!q.formula_summary.includes('249')) return `formula_summary should reference weekly rate (249€): "${q.formula_summary}"`;
});

// ─── D. 4-night proration (all packages × seasons) ───────────────────────────

const PRORATION_4N = {
  malibu:  { spring_autumn: 16000, summer: 17500, august: 20000 },
  //   ceil5(24900/7)=4000 × 4n × 1g = 16000
  //   ceil5(29900/7)=ceil5(4271.43)=4500; 4500×4=18000  -- wait let me recalculate
  //   29900/7 = 4271.43 → ceil5 → 4500; 4500×4 = 18000
  //   34900/7 = 4985.71 → ceil5 → 5000; 5000×4 = 20000
};

// Calculated per-night ceil5 values (ceil(weekly/7/500)*500):
// Malibu  spring: ceil5(24900/7)=ceil5(3557.14)=4000; ×4n×1g=16000
// Malibu  summer: ceil5(29900/7)=ceil5(4271.43)=4500; ×4=18000
// Malibu  august: ceil5(34900/7)=ceil5(4985.71)=5000; ×4=20000
// Uluwatu spring: ceil5(34900/7)=ceil5(4985.71)=5000; ×4=20000 (config example ✓)
// Uluwatu summer: ceil5(39900/7)=ceil5(5700.00)→5700/500=11.4→ceil=12→6000; ×4=24000
// Uluwatu august: ceil5(44900/7)=ceil5(6414.29)=6500; ×4=26000
// Waimea  spring: ceil5(49900/7)=ceil5(7128.57)=7500; ×4=30000
// Waimea  summer: ceil5(54900/7)=ceil5(7842.86)=8000; ×4=32000
// Waimea  august: ceil5(59900/7)=ceil5(8557.14)=9000; ×4=36000

const PRORATION_4N_ALL = {
  malibu:  { spring_autumn: 16000, summer: 18000, august: 20000 },
  uluwatu: { spring_autumn: 20000, summer: 24000, august: 26000 },
  waimea:  { spring_autumn: 30000, summer: 32000, august: 36000 },
};

for (const [pkgCode, seasonMap] of Object.entries(PRORATION_4N_ALL)) {
  for (const [seasonCode, expectedTotal] of Object.entries(seasonMap)) {
    const { check_in } = SEASON_DATES[seasonCode];
    const check_out_4n = new Date(new Date(check_in + 'T00:00:00Z').getTime() + 4 * 86400000)
      .toISOString().slice(0, 10);
    check(`D_${pkgCode}_${seasonCode}_4n`, `4-night ${pkgCode} ${seasonCode}, 1 guest: package = ${expectedTotal}¢`, () => {
      const q = calculateWolfhouseQuote({
        client_slug: 'wolfhouse-somo', check_in, check_out: check_out_4n,
        guest_count: 1, package_code: pkgCode,
      }, config);
      if (!q.success) return `blocked: ${q.blockers.join('; ')}`;
      const pkgItem = q.line_items.find(li => li.code === 'package_proration');
      if (!pkgItem) return 'no package_proration line item';
      if (pkgItem.total_cents !== expectedTotal) {
        return `${pkgCode} ${seasonCode} 4n = ${pkgItem.total_cents}¢, expected ${expectedTotal}¢`;
      }
    });
  }
}

// ─── E. Room supplement ───────────────────────────────────────────────────────

check('E1', '7-night Malibu spring, 1 guest, private: supplement = 1000×7×1 = 7000¢', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu', room_type: 'private',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  const suppItem = q.line_items.find(li => li.code === 'room_supplement');
  if (!suppItem) return 'no room_supplement line item for private room';
  if (suppItem.total_cents !== 7000) return `supplement = ${suppItem.total_cents}¢, expected 7000¢`;
  if (q.total_cents !== 24900 + 7000) return `total = ${q.total_cents}¢, expected ${24900 + 7000}¢`;
});

check('E2', '7-night Malibu spring, 2 guests, double: supplement = 1000×7×2 = 14000¢', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 2, package_code: 'malibu', room_type: 'double',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  const suppItem = q.line_items.find(li => li.code === 'room_supplement');
  if (!suppItem) return 'no room_supplement line item for double room';
  if (suppItem.total_cents !== 14000) return `supplement = ${suppItem.total_cents}¢, expected 14000¢`;
});

check('E3', '7-night Malibu spring, shared: no room supplement line item', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu', room_type: 'shared',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  const suppItem = q.line_items.find(li => li.code === 'room_supplement');
  if (suppItem) return `unexpected room_supplement for shared room: ${suppItem.total_cents}¢`;
});

check('E4', '4-night Malibu spring, 2 guests, private: supplement = 1000×4×2 = 8000¢', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 2, package_code: 'malibu', room_type: 'private',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  const suppItem = q.line_items.find(li => li.code === 'room_supplement');
  if (!suppItem) return 'no room_supplement for private';
  if (suppItem.total_cents !== 8000) return `supplement = ${suppItem.total_cents}¢, expected 8000¢`;
  // base 4000×4×2=32000 + 8000 = 40000
  if (q.total_cents !== 40000) return `total = ${q.total_cents}¢, expected 40000¢`;
});

// ─── F. Deposit tiers ─────────────────────────────────────────────────────────

check('F1', '7-night stay: deposit_required_cents = 20000', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.deposit_required_cents !== 20000) return `deposit = ${q.deposit_required_cents}¢, expected 20000¢`;
});

check('F2', '4-night stay: deposit_required_cents = 10000', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.deposit_required_cents !== 10000) return `deposit = ${q.deposit_required_cents}¢, expected 10000¢`;
});

check('F3', '3-night stay: deposit_required_cents = 10000', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-09',
    guest_count: 2, package_code: 'uluwatu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.deposit_required_cents !== 10000) return `deposit = ${q.deposit_required_cents}¢, expected 10000¢`;
});

// ─── G. Payment choices ───────────────────────────────────────────────────────

check('G1', 'payment_choice=deposit: payment_link_amount = deposit_required_cents', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu', payment_choice: 'deposit',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.payment_link_amount_cents !== q.deposit_required_cents) {
    return `payment_link = ${q.payment_link_amount_cents}¢, deposit = ${q.deposit_required_cents}¢ — should be equal`;
  }
});

check('G2', 'payment_choice=full: payment_link_amount = total_cents', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu', payment_choice: 'full',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.payment_link_amount_cents !== q.total_cents) {
    return `payment_link = ${q.payment_link_amount_cents}¢, total = ${q.total_cents}¢ — should be equal`;
  }
});

check('G3', 'payment_choice=pay_on_arrival: payment_link_amount = 0, warning present', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu', payment_choice: 'pay_on_arrival',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.payment_link_amount_cents !== 0) return `payment_link = ${q.payment_link_amount_cents}¢, expected 0`;
  if (!Array.isArray(q.warnings) || q.warnings.length === 0) return 'no warnings for pay_on_arrival';
  if (!q.warnings.some(w => w.includes('pay_on_arrival') || w.includes('arrival'))) {
    return `no pay_on_arrival warning found: ${q.warnings.join('; ')}`;
  }
});

check('G4', 'payment_choice=pay_on_arrival: staff_review_required = true', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu', payment_choice: 'pay_on_arrival',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (!q.staff_review_required) return 'staff_review_required should be true for pay_on_arrival';
});

check('G5', 'balance_due_cents = total_cents (amount_paid = 0 default)', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 2, package_code: 'uluwatu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.balance_due_cents !== q.total_cents - q.amount_paid_cents) {
    return `balance = ${q.balance_due_cents}¢, expected total(${q.total_cents}) - paid(${q.amount_paid_cents}) = ${q.total_cents - q.amount_paid_cents}¢`;
  }
  if (q.amount_paid_cents !== 0) return `amount_paid should default to 0, got ${q.amount_paid_cents}`;
});

// ─── H. Add-ons ───────────────────────────────────────────────────────────────

function baseInput7n(extra) {
  return Object.assign({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, extra);
}

check('H1', 'wetsuit_rental 3 days: add-on = 500×3 = 1500¢', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'wetsuit_rental', days: 3 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'wetsuit_rental');
  if (!li) return 'no wetsuit_rental line item';
  if (li.total_cents !== 1500) return `wetsuit = ${li.total_cents}¢, expected 1500¢`;
  if (q.total_cents !== 24900 + 1500) return `total = ${q.total_cents}¢, expected ${24900 + 1500}¢`;
});

check('H2', 'soft_top_rental 4 days: add-on = 1500×4 = 6000¢', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'soft_top_rental', days: 4 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'soft_top_rental');
  if (!li) return 'no soft_top_rental line item';
  if (li.total_cents !== 6000) return `soft_top = ${li.total_cents}¢, expected 6000¢`;
});

check('H3', 'hard_board_rental 5 days: add-on = 2000×5 = 10000¢', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'hard_board_rental', days: 5 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'hard_board_rental');
  if (!li) return 'no hard_board_rental line item';
  if (li.total_cents !== 10000) return `hard_board = ${li.total_cents}¢, expected 10000¢`;
});

check('H4', 'wetsuit_soft_top_combo 3 days: combo = 1500×3 = 4500¢', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'wetsuit_soft_top_combo', days: 3 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'wetsuit_soft_top_combo');
  if (!li) return 'no wetsuit_soft_top_combo line item';
  if (li.total_cents !== 4500) return `combo = ${li.total_cents}¢, expected 4500¢`;
});

check('H5', 'combo replaces individual items: wetsuit+soft_top+combo → only combo billed', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [
      { code: 'wetsuit_rental',       days: 3 },
      { code: 'soft_top_rental',      days: 3 },
      { code: 'wetsuit_soft_top_combo', days: 3 },
    ],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const wetsuit = q.line_items.find(l => l.code === 'wetsuit_rental');
  const softTop = q.line_items.find(l => l.code === 'soft_top_rental');
  const combo   = q.line_items.find(l => l.code === 'wetsuit_soft_top_combo');
  if (wetsuit) return 'wetsuit_rental should be replaced by combo but appears as line item';
  if (softTop) return 'soft_top_rental should be replaced by combo but appears as line item';
  if (!combo) return 'wetsuit_soft_top_combo line item missing';
  if (combo.total_cents !== 4500) return `combo total = ${combo.total_cents}¢, expected 4500¢`;
  // Warnings about replaced items should appear
  if (!q.warnings.some(w => w.includes('wetsuit_rental') && w.includes('replaced'))) {
    return 'no "replaced" warning for wetsuit_rental';
  }
});

check('H6', 'wetsuit_hard_board_combo 4 days: combo = 2000×4 = 8000¢', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'wetsuit_hard_board_combo', days: 4 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'wetsuit_hard_board_combo');
  if (!li) return 'no wetsuit_hard_board_combo line item';
  if (li.total_cents !== 8000) return `combo = ${li.total_cents}¢, expected 8000¢`;
});

check('H7', 'combo replaces: wetsuit+hard_board+combo → only combo billed', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [
      { code: 'wetsuit_rental',         days: 4 },
      { code: 'hard_board_rental',      days: 4 },
      { code: 'wetsuit_hard_board_combo', days: 4 },
    ],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  if (q.line_items.find(l => l.code === 'wetsuit_rental')) return 'wetsuit_rental not replaced by combo';
  if (q.line_items.find(l => l.code === 'hard_board_rental')) return 'hard_board_rental not replaced by combo';
  if (!q.line_items.find(l => l.code === 'wetsuit_hard_board_combo')) return 'combo line item missing';
});

check('H8', 'surf_lesson_single quantity=1: 3500¢ (single rate)', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'surf_lesson_single', quantity: 1 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'surf_lesson_single');
  if (!li) return 'no surf_lesson_single line item';
  if (li.total_cents !== 3500) return `single lesson = ${li.total_cents}¢, expected 3500¢`;
  if (li.unit_cents !== 3500) return `unit = ${li.unit_cents}¢, expected 3500¢`;
});

check('H9', 'surf_lesson_multi quantity=3: 3000×3 = 9000¢ (bundle rate)', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'surf_lesson_multi', quantity: 3 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'surf_lesson_multi');
  if (!li) return 'no surf_lesson_multi line item';
  if (li.total_cents !== 9000) return `multi lesson = ${li.total_cents}¢, expected 9000¢`;
  if (li.unit_cents !== 3000) return `unit = ${li.unit_cents}¢, expected 3000¢`;
});

check('H10', 'surf_lesson_multi quantity=2: 3000×2 = 6000¢', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'surf_lesson_multi', quantity: 2 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'surf_lesson_multi');
  if (!li) return 'no surf_lesson_multi line item';
  if (li.total_cents !== 6000) return `2-lesson bundle = ${li.total_cents}¢, expected 6000¢`;
});

check('H11', 'yoga_class quantity=2: 1500×2 = 3000¢ and on_site warning present', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [{ code: 'yoga_class', quantity: 2 }],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const li = q.line_items.find(l => l.code === 'yoga_class');
  if (!li) return 'no yoga_class line item';
  if (li.total_cents !== 3000) return `yoga = ${li.total_cents}¢, expected 3000¢`;
  if (!q.warnings.some(w => w.toLowerCase().includes('yoga') || w.toLowerCase().includes('on site') || w.toLowerCase().includes('on-site'))) {
    return `no on-site warning for yoga: [${q.warnings.join('; ')}]`;
  }
});

check('H12', 'Combined add-ons: wetsuit 5d + yoga 3 classes total correct', () => {
  const q = calculateWolfhouseQuote(baseInput7n({
    add_ons: [
      { code: 'wetsuit_rental', days: 5 },  // 500×5 = 2500
      { code: 'yoga_class', quantity: 3 },   // 1500×3 = 4500
    ],
  }), config);
  if (!q.success) return q.blockers.join('; ');
  const ws  = q.line_items.find(l => l.code === 'wetsuit_rental');
  const yg  = q.line_items.find(l => l.code === 'yoga_class');
  if (!ws || ws.total_cents !== 2500) return `wetsuit = ${ws && ws.total_cents}¢, expected 2500¢`;
  if (!yg || yg.total_cents !== 4500) return `yoga = ${yg && yg.total_cents}¢, expected 4500¢`;
  // base 24900 + 2500 + 4500 = 31900
  if (q.total_cents !== 31900) return `total = ${q.total_cents}¢, expected 31900¢`;
});

// ─── I. Blockers ──────────────────────────────────────────────────────────────

check('I1', 'Invalid check_in date: success=false, blocker present', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: 'not-a-date', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false for invalid date';
  if (!q.blockers || q.blockers.length === 0) return 'No blockers for invalid date';
  if (!q.blockers.some(b => b.includes('invalid') || b.includes('date') || b.includes('Invalid'))) {
    return `No date-related blocker: ${q.blockers.join('; ')}`;
  }
});

check('I2', 'check_out before check_in: success=false, blocker present', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-13', check_out: '2026-04-06',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false when check_out < check_in';
  if (!q.blockers || !q.blockers.some(b => b.includes('after') || b.includes('nights'))) {
    return `Expected nights blocker: ${q.blockers.join('; ')}`;
  }
});

check('I3', 'Unknown package_code: success=false, staff_review_required=true', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'pipeline',
  }, config);
  if (q.success) return 'Expected success=false for unknown package';
  if (!q.staff_review_required) return 'staff_review_required should be true for unknown package';
  if (!q.blockers.some(b => b.includes('pipeline') || b.includes('unknown'))) {
    return `No blocker mentioning unknown package: ${q.blockers.join('; ')}`;
  }
});

check('I4', 'Missing package_code: success=false', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1,
  }, config);
  if (q.success) return 'Expected success=false for missing package_code';
  if (!q.staff_review_required) return 'staff_review_required should be true';
});

check('I5', 'March check-in (month 3): missing_config=true, staff_review_required=true', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-03-09', check_out: '2026-03-16',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false for March (edge month)';
  if (!q.missing_config) return 'missing_config should be true for March';
  if (!q.staff_review_required) return 'staff_review_required should be true for March';
});

check('I6', 'November check-in (month 11): missing_config=true, staff_review_required=true', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-11-09', check_out: '2026-11-16',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false for November (edge month)';
  if (!q.missing_config) return 'missing_config should be true for November';
  if (!q.staff_review_required) return 'staff_review_required should be true for November';
});

check('I7', 'January check-in (closed month): success=false, blocker about closed/not bookable', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-01-12', check_out: '2026-01-19',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false for January (closed month)';
  if (!q.blockers.some(b => b.includes('closed') || b.includes('not bookable'))) {
    return `No closed-month blocker: ${q.blockers.join('; ')}`;
  }
});

check('I8', 'February check-in (closed month): success=false', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-02-09', check_out: '2026-02-16',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false for February (closed month)';
  if (!q.blockers.some(b => b.includes('closed') || b.includes('not bookable'))) {
    return `No closed-month blocker: ${q.blockers.join('; ')}`;
  }
});

check('I9', 'December check-in (closed month): success=false', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-12-07', check_out: '2026-12-14',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false for December (closed month)';
  if (!q.blockers.some(b => b.includes('closed') || b.includes('not bookable'))) {
    return `No closed-month blocker: ${q.blockers.join('; ')}`;
  }
});

check('I10', 'client_slug mismatch: success=false, blocker present', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'other-client', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected success=false for client_slug mismatch';
  if (!q.blockers.some(b => b.includes('mismatch') || b.includes('client_slug'))) {
    return `No client_slug blocker: ${q.blockers.join('; ')}`;
  }
});

// ─── J. Output shape ──────────────────────────────────────────────────────────

check('J1', 'Success result contains formula_summary string', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!q.formula_summary || typeof q.formula_summary !== 'string') {
    return `formula_summary missing or not string: ${JSON.stringify(q.formula_summary)}`;
  }
});

check('J2', 'Blocked result also contains formula_summary', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-01-12', check_out: '2026-01-19',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.success) return 'Expected blocked result';
  if (!q.formula_summary || typeof q.formula_summary !== 'string') {
    return `formula_summary missing in blocked result: ${JSON.stringify(q.formula_summary)}`;
  }
});

check('J3', 'Success result contains line_items array', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!Array.isArray(q.line_items)) return `line_items is not an array: ${typeof q.line_items}`;
  if (q.line_items.length === 0) return 'line_items is empty for successful quote';
});

check('J4', 'All required top-level fields present', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 2, package_code: 'uluwatu',
  }, config);
  const required = [
    'success', 'client_slug', 'currency', 'nights', 'guest_count',
    'package_code', 'room_type', 'season_code', 'line_items',
    'subtotal_cents', 'discount_cents', 'total_cents',
    'deposit_required_cents', 'payment_link_amount_cents',
    'amount_paid_cents', 'balance_due_cents', 'payment_options',
    'confidence', 'blockers', 'warnings', 'formula_summary',
    'staff_review_required', 'source', 'missing_config',
  ];
  const missing = required.filter(k => !(k in q));
  if (missing.length) return `missing fields: ${missing.join(', ')}`;
});

check('J5', 'source = "wolfhouse-quote-calculator"', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.source !== 'wolfhouse-quote-calculator') return `source = "${q.source}"`;
});

check('J6', 'currency = EUR', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-13',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (q.currency !== 'EUR') return `currency = "${q.currency}"`;
});

check('J7', 'night count correct (check: 6 Apr → 10 Apr = 4 nights)', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-04-06', check_out: '2026-04-10',
    guest_count: 1, package_code: 'malibu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.nights !== 4) return `nights = ${q.nights}, expected 4`;
});

check('J8', 'season_code correctly detected for September (summer)', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-09-07', check_out: '2026-09-14',
    guest_count: 1, package_code: 'uluwatu',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.season_code !== 'summer') return `season_code = "${q.season_code}", expected "summer" for September`;
});

check('J9', 'August override: month 8 → season_code = august (priority 10)', () => {
  const q = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2026-08-03', check_out: '2026-08-10',
    guest_count: 1, package_code: 'waimea',
  }, config);
  if (!q.success) return q.blockers.join('; ');
  if (q.season_code !== 'august') return `season_code = "${q.season_code}", expected "august"`;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\nverify-wolfhouse-quote-calculator FAILED (${failed} check(s) failed)\n`);
  process.exit(1);
} else {
  console.log('\nverify-wolfhouse-quote-calculator PASS\n');
  process.exit(0);
}
