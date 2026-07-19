'use strict';

/**
 * run-phase-d-live-readonly-count-only — FOUNDATION Slice 14D/14E
 *
 * Narrow operator CLI for the activated Phase D live read-only count-only
 * preflight. DEFAULT: refused (zero pg Clients / zero HTTP).
 *
 * Requires:
 *   SUNSET_PHASE_D_LIVE_READONLY=1
 *   SUNSET_PHASE_D_LIVE_PREFLIGHT=1
 *   SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1
 *   AZURE_SUBSCRIPTION_ID=<exact Sunset staging subscription>
 *   --execute-count-only
 *   --subscription --resource-group --postgres-server --database (exact locks)
 *
 * Credential sources:
 *   protected-admin-env (default): SUNSET_STAGING_PG_ADMIN_USER / PASSWORD
 *   managed-identity (Slice 14E): requires BOTH
 *     SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity
 *     --credential-source managed-identity
 *     Live IMDS/KV HTTP remains hard-disabled in 14E (offline injected HTTP only).
 *
 * Forbidden: --dsn --host --query --connection-string --user --password --sql
 *
 * Does not mutate Azure/network/schema. Wire real pg Client only after every
 * gate passes.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-live-readonly-count-only.js
 */

const {
  evaluatePhaseDLiveReadonlyCliGates,
  renderCliUsage,
  collectProtectedAdminSecrets,
  renderFailClosedCliCatch,
  maybeThrowOfflineInjectedTopLevelError,
  CLI_EXECUTE_COUNT_ONLY,
} = require('./lib/phase-d-live-readonly-cli');
const {
  executePhaseDLiveReadonlyPgAdapter,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  TARGETS,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const { redactDeep } = require('./lib/phase-d-live-readonly-boundary');
const {
  zeroPrivateCredentialRefs,
} = require('./lib/phase-d-managed-identity-credential-loader');

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderCliUsage());
    process.exit(0);
  }

  // Offline proof only — unexpected top-level throw embedding admin secrets.
  maybeThrowOfflineInjectedTopLevelError(process.env);

  resetPgClientInstantiateCount();

  const secrets = collectProtectedAdminSecrets(process.env);

  // Default / missing flags: refuse before any Client.
  if (!argv.includes(CLI_EXECUTE_COUNT_ONLY) && argv.length === 0) {
    console.log(renderCliUsage());
    console.log('');
    console.log(JSON.stringify(redactDeep({
      ok: false,
      code: 'default_disabled',
      clientsInstantiated: 0,
      liveQueryExecution: false,
      liveMutation: false,
      note: 'Default path refused — zero pg Clients / zero HTTP',
    }, secrets), null, 2));
    process.exit(2);
  }

  const gates = evaluatePhaseDLiveReadonlyCliGates({
    env: process.env,
    argv,
  });

  if (!gates.ok) {
    const safe = redactDeep({
      ok: false,
      code: 'cli_gates_rejected',
      errors: gates.errors,
      clientsInstantiated: getPgClientInstantiateCount(),
      liveReadonlyConnectEnabled: true,
      liveQueryExecution: false,
      liveMutation: false,
      note: 'CLI gates failed — zero pg Clients instantiated',
    }, secrets);
    console.error(JSON.stringify(safe, null, 2));
    process.exit(2);
  }

  // All gates passed — wire real pg Client via activated 14C adapter.
  // No Client injection; no DSN/host/query options.
  // Managed-identity path uses in-process loader (live HTTP hard-disabled in 14E).
  const result = await executePhaseDLiveReadonlyPgAdapter({
    env: process.env,
    argv: ['node', 'run-phase-d-live-readonly-count-only', ...argv],
    targets: TARGETS,
  });

  // Never leave private credential bags on the result object.
  zeroPrivateCredentialRefs(result);

  const safe = redactDeep({
    ok: result.ok,
    code: result.code,
    counts: result.counts || null,
    steps: result.steps || [],
    outputKeys: result.outputKeys || null,
    closed: result.closed,
    clientsInstantiated: result.clientsInstantiated,
    counters: result.counters,
    credentialSource: gates.credentialSource,
    liveReadonlyConnectEnabled: result.liveReadonlyConnectEnabled,
    liveQueryExecution: result.liveQueryExecution === true,
    liveMutation: false,
    appliesConstraints: false,
    writesLedger: false,
    errors: result.errors || undefined,
    message: result.message || undefined,
  }, secrets);

  if (result.ok) {
    console.log(JSON.stringify(safe, null, 2));
    process.exit(0);
  }
  console.error(JSON.stringify(safe, null, 2));
  process.exit(2);
}

main().catch((err) => {
  const safe = renderFailClosedCliCatch(err, {
    env: process.env,
    clientsInstantiated: getPgClientInstantiateCount(),
  });
  console.error(JSON.stringify(safe, null, 2));
  process.exit(1);
});
