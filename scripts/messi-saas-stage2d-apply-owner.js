#!/usr/bin/env node
'use strict';
/** MESSI SaaS Stage 2D CLI — plan | status | apply | rollback (synthetic staging owner). */
const path = require('path');
const lib = require('./lib/messi-saas-stage2d-apply-owner');

function usage() {
  return `Usage:
  node scripts/messi-saas-stage2d-apply-owner.js plan --slug <slug> --manifest-dir <stage1-dir>
  node scripts/messi-saas-stage2d-apply-owner.js status --slug <slug> --manifest-dir <stage1-dir>
  node scripts/messi-saas-stage2d-apply-owner.js apply --slug <slug> --manifest-dir <stage1-dir> \\
      --confirm-cost-approval --max-monthly-estimate <usd> [--rollback-on-failure]
  node scripts/messi-saas-stage2d-apply-owner.js rollback --slug <slug> --confirm-rollback
`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm-cost-approval') { out.confirmCostApproval = true; continue; }
    if (a === '--confirm-rollback') { out.confirmRollback = true; continue; }
    if (a === '--rollback-on-failure') { out.rollbackOnFailure = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1]; i += 1; continue;
    }
    out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || !['plan', 'status', 'apply', 'rollback'].includes(cmd)) {
    process.stderr.write(usage());
    process.exit(2);
  }
  if (/password|secret|token|database-url|dsn/i.test(process.argv.join(' '))) {
    // Refuse secret-shaped argv flags entirely
    if (process.argv.some((a) => /^--(password|admin-database-url|database-url|app-role-password|session-secret|postgres-admin-password)=?/i.test(a))) {
      process.stderr.write(JSON.stringify({ ok: false, errors: [{ code: 'secret_argv_forbidden' }] }) + '\n');
      process.exit(1);
    }
  }
  const deps = lib.createDeps({ repoRoot: path.join(__dirname, '..') });
  const opts = {
    slug: args.slug,
    manifestDir: args.manifestDir,
    confirmCostApproval: !!args.confirmCostApproval,
    confirmRollback: !!args.confirmRollback,
    rollbackOnFailure: !!args.rollbackOnFailure,
    maxMonthlyEstimate: args.maxMonthlyEstimate != null ? Number(args.maxMonthlyEstimate) : undefined,
    expectedPlanDigest: args.expectedPlanDigest,
  };
  let result;
  if (cmd === 'plan') result = await lib.plan(opts, deps);
  else if (cmd === 'status') result = await lib.status(opts, deps);
  else if (cmd === 'apply') result = await lib.apply(opts, deps);
  else result = await lib.rollback(opts, deps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`${JSON.stringify({ ok: false, errors: [{ code: 'cli_exception', message: lib.redactSecrets(String(e && e.message), []) }] })}\n`);
  process.exit(1);
});
