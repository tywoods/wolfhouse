#!/usr/bin/env node
'use strict';
/** MESSI SaaS Stage 2D1 CLI — parent exact-snapshot + internal worker. */
const path = require('path');
const lib = require('./lib/messi-saas-stage2d1-plan-status');
const ALLOWED = new Set(['--slug', '--action-group-resource-id', '--lifecycle-mode', '--expected-plan-digest']);
const LIFECYCLES = new Set(['temporary-drill', 'durable-staging']);
function usage() {
  return 'Usage: node scripts/messi-saas-stage2d1-plan-status.js <plan|status> --slug <slug> [--action-group-resource-id <id>] [--lifecycle-mode temporary-drill|durable-staging]\n';
}
function failCli(errors) { process.stderr.write(`${JSON.stringify({ ok: false, errors })}\n`); process.exit(2); }
/** Strict allowlist parse — fail-closed before snapshot worker/Azure. */
function parseArgs(argv) {
  const out = { _: [] }; const seen = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    if (!ALLOWED.has(a)) return { ok: false, errors: [{ code: 'unknown_cli_flag', message: `unknown or unsupported flag ${a}` }] };
    const v = argv[i + 1];
    if (v == null || String(v).startsWith('--')) return { ok: false, errors: [{ code: 'missing_cli_flag_value', message: `missing value for ${a}` }] };
    i += 1;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (seen[a]) return { ok: false, errors: [{ code: out[key] === v ? 'duplicate_cli_flag' : 'conflicting_cli_flag', message: a }] };
    seen[a] = true; out[key] = v;
  }
  if (out.lifecycleMode != null && !LIFECYCLES.has(out.lifecycleMode)) {
    return { ok: false, errors: [{ code: 'lifecycle_mode_invalid', message: 'lifecycleMode must be temporary-drill|durable-staging' }] };
  }
  // Strict arity: exactly one positional command; reject extras before snapshot spawn.
  if (out._.length !== 1) {
    return { ok: false, errors: [{ code: 'unexpected_cli_positional', message: 'exactly one command required (plan|status)' }] };
  }
  out.ok = true; return out;
}
function buildOpts(args) {
  const opts = { slug: args.slug, actionGroupResourceId: args.actionGroupResourceId };
  if (args.lifecycleMode != null) opts.lifecycleMode = args.lifecycleMode; return opts;
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
  if (!args.ok) failCli(args.errors);
  const cmd = args._[0];
  if (!cmd || !['plan', 'status'].includes(cmd)) { process.stderr.write(usage()); process.exit(2); }
  if (rejectDigest(args)) process.exit(2);
  const deps = lib.createDeps({
    repoRoot: gate.payload.snapRoot || path.join(__dirname, '..'), inExactSnapshot: true,
    verifiedDeploySha: gate.payload.verifiedDeploySha, toolAuthority: gate.payload.toolAuthority,
  });
  const result = cmd === 'plan' ? await lib.plan(buildOpts(args), deps) : await lib.status(buildOpts(args), deps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes(lib.INTERNAL_FLAG)) return runInternal(argv);
  const args = parseArgs(argv); // fail-closed before snapshot worker/Azure
  if (!args.ok) failCli(args.errors);
  const cmd = args._[0];
  if (!cmd || !['plan', 'status'].includes(cmd)) { process.stderr.write(usage()); process.exit(2); }
  if (rejectDigest(args)) process.exit(2);
  const result = await lib.runProductionParent(argv, lib.createDeps({ repoRoot: path.join(__dirname, '..') }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result && result.ok ? 0 : 1);
}
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${JSON.stringify({ ok: false, errors: [{ code: 'cli_exception', message: lib.redact(String(e && e.message)) }] })}\n`);
    process.exit(1);
  });
}
module.exports = { usage, parseArgs, buildOpts, ALLOWED, LIFECYCLES };
