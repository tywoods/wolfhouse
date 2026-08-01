'use strict';

/**
 * verify:sunset-schedule-day-reconcile-nonblocking
 *
 * Proves handleSunsetScheduleDayGet does not await Stripe date reconcile, and that
 * kickAdvisoryReconcilePendingStripePaymentsForDate:
 *   - returns immediately even when the runner never resolves
 *   - swallows rejections (no unhandled rejection)
 *   - throttles once per (clientSlug+date) per ~2 minutes
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const {
  RECONCILE_DATE_THROTTLE_MS,
  resetReconcileDateThrottleForTests,
  shouldKickReconcileForDate,
  kickAdvisoryReconcilePendingStripePaymentsForDate,
} = require('./lib/stripe-payment-reconcile');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

// ── Source: day handler must not await reconcile before the schedule read ────
const dayStart = apiSrc.indexOf('async function handleSunsetScheduleDayGet');
ok('handleSunsetScheduleDayGet present', dayStart >= 0);
const dayEnd = apiSrc.indexOf('\nasync function ', dayStart + 10);
const dayFn = dayStart >= 0
  ? apiSrc.slice(dayStart, dayEnd > dayStart ? dayEnd : dayStart + 2500)
  : '';

// Advisory block = from STRIPE_SECRET_KEY gate up to the main schedule try.
const advStart = dayFn.indexOf('if (STRIPE_SECRET_KEY)');
const advTry = dayFn.indexOf('\n  try {', advStart >= 0 ? advStart : 0);
const advBlock = advStart >= 0 && advTry > advStart
  ? dayFn.slice(advStart, advTry)
  : '';

ok('day handler has advisory STRIPE block before schedule try', advBlock.length > 40);
ok('day handler kicks advisory reconcile',
  /kickAdvisoryReconcilePendingStripePaymentsForDate\s*\(/.test(advBlock));
// Strip async runner bodies so internal await withPgClient does not count as blocking.
const advTopLevel = advBlock.replace(/async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}/, 'async () => { /* runner */ }');
ok('advisory block has no top-level await',
  advTopLevel.length > 0 && !/\bawait\b/.test(advTopLevel));
ok('day handler does not await kickAdvisory',
  !/await\s+kickAdvisoryReconcilePendingStripePaymentsForDate\s*\(/.test(dayFn));
ok('day handler still calls reconcile inside runner',
  /reconcilePendingStripePaymentsForDate\s*\(/.test(advBlock));
ok('import includes kick helper',
  /kickAdvisoryReconcilePendingStripePaymentsForDate/.test(apiSrc)
  && /require\('\.\/lib\/stripe-payment-reconcile'\)/.test(apiSrc));
// Explicit anti-regression: old blocking shape gone from day handler.
ok('old blocking await-withPgClient-reconcile shape removed',
  !/if \(STRIPE_SECRET_KEY\) \{\s*try \{\s*const stripe = require\('stripe'\)[\s\S]{0,200}?await withPgClient\(\(pg\) => reconcilePendingStripePaymentsForDate/.test(dayFn));
// ── Kick never waits on never-resolving runner ───────────────────────────────
resetReconcileDateThrottleForTests();
let runnerStarted = false;
const t0 = Date.now();
const kick1 = kickAdvisoryReconcilePendingStripePaymentsForDate(
  () => new Promise(() => { runnerStarted = true; /* never resolves */ }),
  { clientSlug: 'sunset-surf', dateIso: '2026-08-01', nowMs: 1_000_000 },
);
const elapsed = Date.now() - t0;
ok('kick returns kicked:true', kick1.kicked === true);
ok('kick returns in <50ms with never-resolving runner', elapsed < 50, `elapsed=${elapsed}ms`);

// Allow microtask to start runner without awaiting it
awaitMicrotasks().then(async () => {
  ok('never-resolving runner was scheduled', runnerStarted === true);

  // ── Throttle same client+date ──────────────────────────────────────────────
  const kick2 = kickAdvisoryReconcilePendingStripePaymentsForDate(
    () => Promise.resolve('should-not-run'),
    { clientSlug: 'sunset-surf', dateIso: '2026-08-01', nowMs: 1_000_000 + 10_000 },
  );
  ok('second kick within window throttled', kick2.kicked === false && kick2.reason === 'throttled');

  ok('shouldKick false inside window',
    shouldKickReconcileForDate('sunset-surf', '2026-08-01', 1_000_000 + 30_000) === false);
  ok('shouldKick true after throttle window',
    shouldKickReconcileForDate('sunset-surf', '2026-08-01', 1_000_000 + RECONCILE_DATE_THROTTLE_MS + 1) === true);

  // Different date is independent
  resetReconcileDateThrottleForTests();
  const kA = kickAdvisoryReconcilePendingStripePaymentsForDate(() => Promise.resolve(), {
    clientSlug: 'sunset-surf', dateIso: '2026-08-01', nowMs: 5_000_000,
  });
  const kB = kickAdvisoryReconcilePendingStripePaymentsForDate(() => Promise.resolve(), {
    clientSlug: 'sunset-surf', dateIso: '2026-08-02', nowMs: 5_000_000,
  });
  ok('different date not throttled', kA.kicked && kB.kicked);

  // Rejection swallowed — no unhandledRejection
  resetReconcileDateThrottleForTests();
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  kickAdvisoryReconcilePendingStripePaymentsForDate(
    async () => { throw new Error('boom-advisory'); },
    { clientSlug: 'sunset-surf', dateIso: '2026-08-03', nowMs: 9_000_000 },
  );
  await awaitMicrotasks();
  await new Promise((r) => setImmediate(r));
  process.removeListener('unhandledRejection', onUnhandled);
  ok('rejected runner does not unhandled-reject', unhandled === 0, `unhandled=${unhandled}`);

  // Missing inputs
  ok('missing inputs not kicked',
    kickAdvisoryReconcilePendingStripePaymentsForDate(() => {}, { clientSlug: '', dateIso: 'x' }).kicked === false);

  // Syntax checks
  const checks = [
    'scripts/lib/stripe-payment-reconcile.js',
    'scripts/staff-query-api.js',
  ];
  for (const rel of checks) {
    const r = spawnSync(process.execPath, ['--check', rel], { cwd: root, encoding: 'utf8' });
    ok(`node --check ${rel}`, r.status === 0, r.stderr || r.stdout);
  }

  console.log(`\nverify-sunset-schedule-day-reconcile-nonblocking: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('PASS verify:sunset-schedule-day-reconcile-nonblocking');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

function awaitMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}
