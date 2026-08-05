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
  createProductionPinnedPgClient,
  closePinnedPgClient,
} = require('./sunset-staging-ledger-reconcile-pg');

async function runSunsetStagingLedgerReconcileCli(options) {
  const env = options.env || process.env;
  const argv = options.argv || [];
  const parsed = parseArgvFlags(argv);
  const dry = parsed.flags.has(CLI_DRY_RUN);
  const evidencePath = parsed.values[CLI_EVIDENCE] || options.evidencePath || null;
  let evidence = options.evidence || null;
  if (!evidence && evidencePath) {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  }

  let client = null;
  let clientsClosed = 0;
  let result = { ok: false, code: 'unhandled' };
  try {
    const pinned = await createProductionPinnedPgClient(APPLICATION_NAME, env);
    if (!pinned.ok) {
      return {
        result: {
          ok: false,
          code: pinned.errors[0]?.code || 'pinned_client_refused',
          errors: pinned.errors,
        },
        clientsClosed: 0,
      };
    }
    client = pinned.client;

    const fn = dry ? executeReconcileDryRun : executeReconcileMutation;
    result = await fn({
      env,
      argv,
      evidence,
      evidencePath,
      client,
      pinnedClient: client,
      productionCli: true,
    });
  } catch (err) {
    result = {
      ok: false,
      code: err.code || 'unhandled',
      message: String(err.message || err).slice(0, 240),
    };
  } finally {
    if (client) {
      await closePinnedPgClient(client);
      clientsClosed += 1;
    }
  }
  return { result, clientsClosed };
}

module.exports = {
  runSunsetStagingLedgerReconcileCli,
};
