'use strict';

const fs = require('fs');
const {
  executeReconcileDryRun,
  executeReconcileMutation,
  CLI_DRY_RUN,
  CLI_APPLY,
  CLI_EVIDENCE,
  CLI_APPROVE,
  parseArgvFlags,
  APPLICATION_NAME,
  RECONCILE_TARGET,
} = require('./sunset-staging-ledger-reconcile');
const {
  createDisposablePinnedPgClient,
  assertDisposableSessionTarget,
  closeDisposablePinnedPgClient,
} = require('./sunset-staging-ledger-reconcile-disposable-pg');

const CLI_PROOF_CONNECTION = '--proof-connection-file';
const CLI_INJECT_FAIL = '--inject-fail-step';

const ALLOWED_DISPOSABLE_FLAGS = Object.freeze([
  CLI_DRY_RUN,
  CLI_APPLY,
  CLI_APPROVE,
  CLI_EVIDENCE,
  CLI_PROOF_CONNECTION,
  CLI_INJECT_FAIL,
  '--subscription',
  '--resource-group',
  '--postgres-server',
  '--database',
]);

function parseDisposableProofArgv(argv) {
  const parsed = parseArgvFlags(argv);
  const errors = parsed.errors.slice();
  for (const f of parsed.flags) {
    if (!ALLOWED_DISPOSABLE_FLAGS.includes(f)) {
      errors.push({ code: 'unknown_argv', message: `unknown argv ${f}`, flag: f });
    }
  }
  if (!parsed.flags.has(CLI_PROOF_CONNECTION)) {
    errors.push({ code: 'proof_connection_required', message: `${CLI_PROOF_CONNECTION} is required` });
  }
  return {
    parsed,
    errors,
    connectionPath: parsed.values[CLI_PROOF_CONNECTION] || null,
    injectFailStep: String(parsed.values[CLI_INJECT_FAIL] || ''),
  };
}

function stripDisposableProofArgv(argv) {
  const out = [];
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === CLI_PROOF_CONNECTION || a === CLI_INJECT_FAIL) {
      if (args[i + 1] && !String(args[i + 1]).startsWith('--')) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

function loadProofConnection(connectionPath) {
  const raw = JSON.parse(fs.readFileSync(connectionPath, 'utf8'));
  const connect = {
    host: String(raw.host || ''),
    port: Number(raw.port),
    database: String(raw.database || ''),
    user: String(raw.user || ''),
    password: String(raw.password || ''),
  };
  if (!connect.host || !connect.port || !connect.database || !connect.user) {
    return { ok: false, errors: [{ code: 'proof_connection_invalid' }] };
  }
  return { ok: true, connect, errors: [] };
}

async function runDisposableProofCli(options) {
  const env = options.env || process.env;
  const argv = options.argv || [];
  const parsedProof = parseDisposableProofArgv(argv);
  if (parsedProof.errors.length) {
    return {
      result: {
        ok: false,
        code: parsedProof.errors[0].code,
        errors: parsedProof.errors,
      },
      clientsClosed: 0,
    };
  }

  const connGate = loadProofConnection(parsedProof.connectionPath);
  if (!connGate.ok) {
    return {
      result: { ok: false, code: connGate.errors[0].code, errors: connGate.errors },
      clientsClosed: 0,
    };
  }

  const dry = parsedProof.parsed.flags.has(CLI_DRY_RUN);
  const apply = parsedProof.parsed.flags.has(CLI_APPLY);
  if ((dry && apply) || (!dry && !apply)) {
    return {
      result: {
        ok: false,
        code: 'exactly_one_mode_required',
        errors: [{ code: 'exactly_one_mode_required' }],
      },
      clientsClosed: 0,
    };
  }

  const evidencePath = parsedProof.parsed.values[CLI_EVIDENCE] || options.evidencePath || null;
  let evidence = options.evidence || null;
  if (!evidence && evidencePath) {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  }

  let client = null;
  let clientsClosed = 0;
  const sessionAssertFn = assertDisposableSessionTarget;
  try {
    const pinned = await createDisposablePinnedPgClient(connGate.connect, APPLICATION_NAME);
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
    const reconcileArgv = stripDisposableProofArgv(argv);
    const result = await fn({
      env,
      argv: reconcileArgv,
      evidence,
      evidencePath,
      client,
      pinnedClient: client,
      productionCli: false,
      sessionAssertFn,
      injectFailStep: parsedProof.injectFailStep || options.injectFailStep || '',
      target: RECONCILE_TARGET,
    });
    return { result, clientsClosed };
  } finally {
    if (client) {
      await closeDisposablePinnedPgClient(client);
      clientsClosed += 1;
    }
  }
}

module.exports = {
  CLI_PROOF_CONNECTION,
  CLI_INJECT_FAIL,
  ALLOWED_DISPOSABLE_FLAGS,
  parseDisposableProofArgv,
  stripDisposableProofArgv,
  loadProofConnection,
  runDisposableProofCli,
};
