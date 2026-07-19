'use strict';

/**
 * run-phase-d-kv-dsn-verify-full-apply — FOUNDATION Slice 14K
 *
 * Default-disabled operator CLI that activates the merged 14J
 * metadata-preserving sslmode-only Key Vault mutation adapter behind exact
 * SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY=1 + --apply-verify-full + target flags.
 *
 * DEFAULT: refused (zero HTTP / zero KV writes).
 * With exact gates: resolves locked live HTTP (or inject in offline proof) and
 * invokes the reviewed 14J adapter. Rollback separately hard-disabled.
 * Never exposes token/DSN/user/password/metadata values.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-kv-dsn-verify-full-apply.js
 */

const {
  evaluateDsnApplyGates,
  executeDsnVerifyFullApply,
  renderDsnApplyUsage,
  renderFailClosedDsnApplyCatch,
  CLI_APPLY_VERIFY_FULL,
  pickSafeApplyOutput,
  resetDsnPlanCounters,
  getDsnPlanCounters,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
} = require('./lib/phase-d-kv-dsn-verify-full-apply');

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderDsnApplyUsage());
    process.exit(0);
  }

  resetDsnPlanCounters();

  if (!argv.includes(CLI_APPLY_VERIFY_FULL) && argv.length === 0) {
    console.log(renderDsnApplyUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeApplyOutput({
      ok: false,
      code: 'default_disabled',
      applyVerifyFull: false,
      liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true,
      liveHttpEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED === true,
      liveRollbackEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === true,
      liveMutation: false,
      usedLiveHttp: false,
      realImdsCall: false,
      realKeyVaultCall: false,
      realPostgresCall: false,
      kvWriteCount: getDsnPlanCounters().kvWriteCount,
      httpRequestCount: getDsnPlanCounters().httpRequestCount,
      pgClientInstantiated: 0,
      note: 'Default path refused — zero HTTP / zero KV writes',
    }), null, 2));
    process.exit(2);
  }

  const gates = evaluateDsnApplyGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeApplyOutput({
      ok: false,
      code: gates.code,
      applyVerifyFull: gates.applyVerifyFull === true,
      liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true,
      liveHttpEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED === true,
      liveRollbackEnabled: false,
      liveMutation: false,
      usedLiveHttp: false,
      realImdsCall: false,
      realKeyVaultCall: false,
      realPostgresCall: false,
      kvWriteCount: getDsnPlanCounters().kvWriteCount,
      httpRequestCount: getDsnPlanCounters().httpRequestCount,
      errors: gates.errors,
      message: 'DSN verify-full apply gates rejected — zero HTTP / zero KV writes',
      pgClientInstantiated: 0,
    }), null, 2));
    process.exit(2);
  }

  // Gates passed. Live HTTP may run when no inject is supplied.
  // Slice 14K prove never reaches this without inject; do not execute live here
  // from CI/prove. Operator live apply is a later explicit run outside this slice.
  const result = await executeDsnVerifyFullApply({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafeApplyOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  const safe = renderFailClosedDsnApplyCatch(err);
  console.error(JSON.stringify(safe, null, 2));
  process.exit(1);
});
