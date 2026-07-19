'use strict';

/**
 * run-phase-d-kv-dsn-verify-full-plan — FOUNDATION Slice 14J
 *
 * Default-disabled operator plan CLI for the locked recoverable mutation that
 * normalizes luna-sunset-staging-kv/sunset-database-url to sslmode=verify-full
 * (same host/port/database/user/password). Plan-only in this slice.
 *
 * DEFAULT: refused (zero KV writes).
 * With exact env + --plan-only + exact targets: emits safe plan IDs only.
 * Rollback plan: separate env + --rollback-plan-only + --prior-version-id.
 * Never live mutate / read / delete / purge / PG.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-kv-dsn-verify-full-plan.js
 */

const {
  evaluateDsnPlanGates,
  executeDsnVerifyFullPlanOnly,
  renderDsnPlanUsage,
  CLI_PLAN_ONLY,
  CLI_ROLLBACK_PLAN_ONLY,
  resetDsnPlanCounters,
  getDsnPlanCounters,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
  SAFE_OUTPUT_KEYS,
} = require('./lib/phase-d-kv-dsn-verify-full-plan');

function pickSafe(obj) {
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderDsnPlanUsage());
    process.exit(0);
  }

  resetDsnPlanCounters();

  if (!argv.includes(CLI_PLAN_ONLY)
    && !argv.includes(CLI_ROLLBACK_PLAN_ONLY)
    && argv.length === 0) {
    console.log(renderDsnPlanUsage());
    console.log('');
    console.log(JSON.stringify(pickSafe({
      ok: false,
      code: 'default_disabled',
      planOnly: false,
      rollbackPlanOnly: false,
      liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true,
      liveRollbackEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === true,
      liveMutation: false,
      kvWriteCount: getDsnPlanCounters().kvWriteCount,
      httpRequestCount: getDsnPlanCounters().httpRequestCount,
      pgClientInstantiated: 0,
      note: 'Default path refused — zero KV writes',
    }), null, 2));
    process.exit(2);
  }

  const gates = evaluateDsnPlanGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafe({
      ok: false,
      code: gates.code,
      planOnly: gates.planOnly === true,
      rollbackPlanOnly: gates.rollbackPlanOnly === true,
      liveMutateEnabled: false,
      liveRollbackEnabled: false,
      liveMutation: false,
      kvWriteCount: getDsnPlanCounters().kvWriteCount,
      httpRequestCount: getDsnPlanCounters().httpRequestCount,
      errors: gates.errors,
      message: 'DSN verify-full plan gates rejected — zero KV writes',
      pgClientInstantiated: 0,
    }), null, 2));
    process.exit(2);
  }

  const result = executeDsnVerifyFullPlanOnly({ env: process.env, argv });
  console.log(JSON.stringify(pickSafe(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main();
