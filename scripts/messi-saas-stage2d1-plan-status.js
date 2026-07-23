#!/usr/bin/env node
'use strict';
/** MESSI SaaS Stage 2D1 CLI — parent exact-snapshot + internal worker. */
const path = require('path');
const lib = require('./lib/messi-saas-stage2d1-plan-status');
function usage() {
  return 'Usage: node scripts/messi-saas-stage2d1-plan-status.js <plan|status> --slug <slug> [--action-group-resource-id <id>]\n';
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]; continue; }
    out._.push(a);
  }
  return out;
}
function rejectDigest(args) {
  if (args.expectedPlanDigest == null) return false;
  process.stderr.write(`${JSON.stringify({ ok: false, errors: [{ code: 'expected_plan_digest_removed', message: 'status always uses freshly derived plan digest' }] })}\n`);
  return true;
}
async function runInternal(argv) {
  const gate = lib.readCapabilityFd(lib.CAPABILITY_FD);
  if (!gate.ok) { process.stderr.write(`${JSON.stringify({ ok: false, errors: gate.errors })}\n`); process.exit(2); }
  const args = parseArgs(argv.filter((a) => a !== lib.INTERNAL_FLAG));
  const cmd = args._[0];
  if (!cmd || !['plan', 'status'].includes(cmd)) { process.stderr.write(usage()); process.exit(2); }
  if (rejectDigest(args)) process.exit(2);
  const deps = lib.createDeps({
    repoRoot: gate.payload.snapRoot || path.join(__dirname, '..'), inExactSnapshot: true,
    verifiedDeploySha: gate.payload.verifiedDeploySha, toolAuthority: gate.payload.toolAuthority,
  });
  const opts = { slug: args.slug, actionGroupResourceId: args.actionGroupResourceId };
  const result = cmd === 'plan' ? await lib.plan(opts, deps) : await lib.status(opts, deps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes(lib.INTERNAL_FLAG)) return runInternal(argv);
  const args = parseArgs(argv); const cmd = args._[0];
  if (!cmd || !['plan', 'status'].includes(cmd)) { process.stderr.write(usage()); process.exit(2); }
  if (rejectDigest(args)) process.exit(2);
  const result = await lib.runProductionParent(argv, lib.createDeps({ repoRoot: path.join(__dirname, '..') }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}
main().catch((e) => {
  process.stderr.write(`${JSON.stringify({ ok: false, errors: [{ code: 'cli_exception', message: lib.redact(String(e && e.message)) }] })}\n`);
  process.exit(1);
});
