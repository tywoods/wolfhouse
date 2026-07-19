'use strict';

/**
 * run-phase-d-credential-preflight — FOUNDATION Slice 14F/14G
 *
 * Narrow metadata-only credential-preflight CLI that activates the merged 14E
 * managed-identity HTTP loader. DEFAULT: refused (zero HTTP / zero pg Clients).
 *
 * Requires:
 *   SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT=1
 *   SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity
 *   AZURE_SUBSCRIPTION_ID=<exact Sunset staging subscription>
 *   --credential-preflight-only
 *   --credential-source managed-identity
 *   exact --subscription / --resource-group / --vm-resource-group / --vm-name
 *     / --managed-identity / --key-vault / --secret-name / --postgres-server
 *     / --database
 *
 * Slice 14G activates live IMDS/KV HTTP behind these gates. Never instantiates
 * a pg Client. Count-only DB command unchanged.
 *
 * Safe output only: booleans + identity/vault/secret/PG host/database/TLS.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-credential-preflight.js
 */

const {
  evaluateCredentialPreflightGates,
  executeCredentialPreflight,
  renderCredentialPreflightUsage,
  renderFailClosedCredentialPreflightCatch,
  CLI_CREDENTIAL_PREFLIGHT_ONLY,
  resetPgClientInstantiateCount,
  resetManagedIdentityHttpCounters,
  getPgClientInstantiateCount,
  getManagedIdentityHttpCounters,
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-credential-preflight');
const { redactDeep } = require('./lib/phase-d-live-readonly-boundary');

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderCredentialPreflightUsage());
    process.exit(0);
  }

  resetPgClientInstantiateCount();
  resetManagedIdentityHttpCounters();

  // Default / missing flags: refuse before any HTTP / Client.
  if (!argv.includes(CLI_CREDENTIAL_PREFLIGHT_ONLY) && argv.length === 0) {
    console.log(renderCredentialPreflightUsage());
    console.log('');
    console.log(JSON.stringify(redactDeep({
      ok: false,
      code: 'default_disabled',
      clientsInstantiated: 0,
      httpRequestCount: 0,
      imdsRequestCount: 0,
      keyVaultRequestCount: 0,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      realImdsCall: false,
      realKeyVaultCall: false,
      realPostgresCall: false,
      note: 'Default path refused — zero HTTP / zero pg Clients',
    }, []), null, 2));
    process.exit(2);
  }

  const gates = evaluateCredentialPreflightGates({
    env: process.env,
    argv,
  });

  if (!gates.ok) {
    const safe = redactDeep({
      ok: false,
      code: 'cli_gates_rejected',
      errors: gates.errors,
      clientsInstantiated: getPgClientInstantiateCount(),
      httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
      imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
      keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      realImdsCall: false,
      realKeyVaultCall: false,
      realPostgresCall: false,
      note: 'CLI gates failed — zero HTTP / zero Clients',
    }, []);
    console.error(JSON.stringify(safe, null, 2));
    process.exit(2);
  }

  // Gates passed — live HTTP may run (14G) for exact IMDS GET + KV GET only.
  // Still never instantiates a pg Client.
  const result = await executeCredentialPreflight({
    env: process.env,
    argv,
  });

  const safe = redactDeep(result, []);
  if (result.ok) {
    console.log(JSON.stringify(safe, null, 2));
    process.exit(0);
  }
  console.error(JSON.stringify(safe, null, 2));
  process.exit(2);
}

main().catch((err) => {
  const safe = renderFailClosedCredentialPreflightCatch(err, {
    clientsInstantiated: getPgClientInstantiateCount(),
  });
  console.error(JSON.stringify(safe, null, 2));
  process.exit(1);
});
