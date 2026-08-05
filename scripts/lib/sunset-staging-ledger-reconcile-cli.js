'use strict';

const fs = require('fs');
const {
  executeReconcileDryRun,
  executeReconcileMutation,
  CLI_DRY_RUN,
  CLI_APPLY,
  CLI_EVIDENCE,
  parseArgvFlags,
  APPLICATION_NAME,
} = require('./sunset-staging-ledger-reconcile');
const {
  createPinnedPgClient,
  closePinnedPgClient,
  isDisposableProofEnv,
} = require('./sunset-staging-ledger-reconcile-pg');

async function runSunsetStagingLedgerReconcileCli(options) {
  const env = options.env || process.env;
  const argv = options.argv || [];
  const parsed = parseArgvFlags(argv);
  const dry = parsed.flags.has(CLI_DRY_RUN);
  const apply = parsed.flags.has(CLI_APPLY);
  const evidencePath = parsed.values[CLI_EVIDENCE] || options.evidencePath || null;
  let evidence = options.evidence || null;
  if (!evidence && evidencePath) {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  }

  const pinned = await createPinnedPgClient(APPLICATION_NAME, env, {
    clientFactory: options.clientFactory,
  });
  if (!pinned.ok) {
    return {
      result: {
        ok: false,
        code: pinned.errors[0]?.code || 'pinned_client_refused',
        errors: pinned.errors,
      },
      cleanup: async () => undefined,
    };
  }

  const client = pinned.client;
  const targetProofMode = pinned.mode;
  const fn = dry ? executeReconcileDryRun : executeReconcileMutation;
  const result = await fn({
    env,
    argv,
    evidence,
    evidencePath,
    client,
    targetProofMode,
    pinnedClient: client,
  });

  const cleanup = async () => {
    await closePinnedPgClient(client);
  };

  return { result, cleanup, targetProofMode, clientsInstantiated: 1 };
}

module.exports = {
  runSunsetStagingLedgerReconcileCli,
  isDisposableProofEnv,
};
