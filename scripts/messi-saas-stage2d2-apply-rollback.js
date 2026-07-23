#!/usr/bin/env node
'use strict';
/** MESSI SaaS Stage 2D2 CLI — prepare-spec / temporary apply / rollback / expiry-status. */
const path = require('path');
const lib = require('./lib/messi-saas-stage2d2-apply-rollback');
function usage() {
  return [
    'Usage:',
    '  node scripts/messi-saas-stage2d2-apply-rollback.js prepare-spec --slug <slug> --approve-max-total-usd 8 --ttl-hours 48',
    '  node scripts/messi-saas-stage2d2-apply-rollback.js apply --slug <slug> --approve-max-total-usd 8 --ttl-hours 48 [--adopt-prepared-rg] [--rollback-on-failure]',
    '  node scripts/messi-saas-stage2d2-apply-rollback.js rollback --slug <slug> --confirm-delete luna-<slug>-staging-rg',
    '  node scripts/messi-saas-stage2d2-apply-rollback.js expiry-status --slug <slug>',
    '',
  ].join('\n');
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key === 'rollbackOnFailure' || key === 'adoptPreparedRg') { out[key] = true; continue; }
      out[key] = argv[++i];
      continue;
    }
    out._.push(a);
  }
  return out;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || !['prepare-spec', 'apply', 'rollback', 'expiry-status'].includes(cmd)) {
    process.stderr.write(usage());
    process.exit(2);
  }
  const deps = lib.createDeps({ repoRoot: path.join(__dirname, '..') });
  let result;
  if (cmd === 'prepare-spec') {
    result = await lib.prepareSpec({
      slug: args.slug,
      approveMaxTotalUsd: args.approveMaxTotalUsd,
      ttlHours: args.ttlHours,
      approveMonthlyUsd: args.approveMonthlyUsd,
      confirmCostApproval: args.confirmCostApproval,
      maxMonthlyEstimate: args.maxMonthlyEstimate,
      actionGroupResourceId: args.actionGroupResourceId,
    }, deps);
  } else if (cmd === 'apply') {
    result = await lib.apply({
      slug: args.slug,
      approveMaxTotalUsd: args.approveMaxTotalUsd,
      ttlHours: args.ttlHours,
      approveMonthlyUsd: args.approveMonthlyUsd,
      confirmCostApproval: args.confirmCostApproval,
      maxMonthlyEstimate: args.maxMonthlyEstimate,
      rollbackOnFailure: !!args.rollbackOnFailure,
      adoptPreparedRg: !!args.adoptPreparedRg,
      actionGroupResourceId: args.actionGroupResourceId,
    }, deps);
  } else if (cmd === 'rollback') {
    result = await lib.rollback({ slug: args.slug, confirmDelete: args.confirmDelete }, deps);
  } else {
    result = await lib.expiryStatus({ slug: args.slug }, deps);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}
main().catch((e) => {
  process.stderr.write(`${JSON.stringify({
    ok: false, errors: [{ code: 'cli_exception', message: lib.redact(String(e && e.message), []) }],
  })}\n`);
  process.exit(1);
});
