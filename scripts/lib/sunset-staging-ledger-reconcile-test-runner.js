'use strict';

/**
 * Test-only CLI runner with pinned-client injection for offline verify gates.
 * Production entrypoints must not import this module.
 */

const fs = require('fs');
const {
  executeReconcileDryRun,
  executeReconcileMutation,
  CLI_DRY_RUN,
  CLI_EVIDENCE,
  parseArgvFlags,
} = require('./sunset-staging-ledger-reconcile');
const { closePinnedPgClient } = require('./sunset-staging-ledger-reconcile-pg');

async function runSunsetStagingLedgerReconcileCliTest(options) {
  if (typeof options.clientFactory !== 'function') {
    return {
      result: { ok: false, code: 'test_client_factory_required' },
      clientsClosed: 0,
    };
  }

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
    client = options.clientFactory();
    const fn = dry ? executeReconcileDryRun : executeReconcileMutation;
    result = await fn({
      env,
      argv,
      evidence,
      evidencePath,
      client,
      pinnedClient: client,
      productionCli: false,
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
  runSunsetStagingLedgerReconcileCliTest,
};
