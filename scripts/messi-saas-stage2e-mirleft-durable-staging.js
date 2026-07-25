#!/usr/bin/env node
'use strict';
/** Stage 2E CLI — durable staging (mirleft; fail-closed). */
const path = require('path');
const lib = require('./lib/messi-saas-stage2e-mirleft-durable-staging');
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['failedPartialCreation', 'rollbackOnSuccess', 'destroyAfterSuccess', 'temporaryDrill'].includes(key)) {
      out[key] = true; continue;
    }
    out[key] = argv[++i];
  }
  return out;
}
async function main() {
  const a = parseArgs(process.argv.slice(2)); const cmd = a._[0];
  if (!cmd || !['status', 'apply', 'rollback'].includes(cmd)) {
    process.stderr.write('Usage: node scripts/messi-saas-stage2e-mirleft-durable-staging.js <status|apply|rollback> --slug mirleft [...]\n');
    process.exit(2);
  }
  const deps = lib.createDeps({ repoRoot: path.join(__dirname, '..') });
  const opts = {
    slug: a.slug, humanApprovalToken: a.humanApprovalToken, ttlHours: a.ttlHours,
    temporaryDrill: a.temporaryDrill, approveMaxTotalUsd: a.approveMaxTotalUsd,
    rollbackOnSuccess: !!a.rollbackOnSuccess, destroyAfterSuccess: !!a.destroyAfterSuccess,
    failedPartialCreation: !!a.failedPartialCreation, confirmDelete: a.confirmDelete,
  };
  const result = cmd === 'status' ? lib.status(opts, deps)
    : cmd === 'apply' ? await lib.apply(opts, deps) : await lib.rollback(opts, deps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}
main().catch((e) => {
  process.stderr.write(`${JSON.stringify({ ok: false, errors: [{ code: 'cli_exception', message: String(e && e.message || e) }] })}\n`);
  process.exit(1);
});
