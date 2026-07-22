#!/usr/bin/env node
'use strict';

/**
 * FACTORY Slice 1C — onboard-client CLI (stdout / in-memory dry-run only).
 *
 * Default and only emission path: one canonical JSON envelope on stdout.
 * Zero filesystem writes. Safe disk materialization is unsupported.
 *
 * Usage:
 *   node scripts/onboard-client.js \
 *     --archetype surf_house \
 *     --substitutions fixtures/.../subs.json \
 *     [--stdout]
 *
 * Rejects: --output-dir, --apply, and all materialization / write flags.
 */

const fs = require('fs');
const path = require('path');
const gen = require('./lib/factory-slice1c-dry-run-generator');

const ROOT = path.join(__dirname, '..');

const REJECTED_DISK_FLAGS = Object.freeze([
  '--output-dir',
  '--write',
  '--materialize',
  '--publish',
  '--dest',
  '--out',
  '--outdir',
  '--out-dir',
]);

function printHelp() {
  process.stdout.write(`FACTORY onboard-client — stdout dry-run preview only (zero writes)

Usage:
  node scripts/onboard-client.js --archetype <id> --substitutions <file.json> [--stdout] [--mode dry-run]

Archetypes: ${gen.ARCHETYPE_IDS.join(', ')}
Mode: ${gen.MODE_DRY_RUN} (only)
Emission: stdout JSON envelope (default; --stdout optional)

Rejects: --output-dir, --apply, materialization/write flags, registry writes,
config/clients writes, secrets, live-target shaped inputs, path traversal,
existing tenant/location conflicts.

Safe disk materialization is unsupported in 1C.
`);
}

function parseArgs(argv) {
  const out = {
    archetype: null,
    substitutionsPath: null,
    stdout: false,
    mode: gen.MODE_DRY_RUN,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--stdout') {
      out.stdout = true;
    } else if (a === '--archetype') {
      out.archetype = argv[++i];
    } else if (a === '--substitutions') {
      out.substitutionsPath = argv[++i];
    } else if (a === '--mode') {
      out.mode = argv[++i];
    } else if (a === '--apply' || a.startsWith('--apply=')) {
      return { error: 'apply_path_forbidden' };
    } else if (
      REJECTED_DISK_FLAGS.includes(a)
      || a.startsWith('--output-dir=')
      || REJECTED_DISK_FLAGS.some((f) => a.startsWith(`${f}=`))
    ) {
      const flag = REJECTED_DISK_FLAGS.find((f) => a === f || a.startsWith(`${f}=`)) || a;
      return { error: `disk_materialization_unsupported:${flag}` };
    } else {
      return { error: `unknown_arg:${a}` };
    }
  }
  return out;
}

function fail(errors) {
  const list = Array.isArray(errors) ? errors : [String(errors)];
  process.stderr.write(`onboard-client: FAILED\n${list.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) fail([args.error]);
  if (args.help || process.argv.length <= 2) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.archetype) fail(['archetype_required']);
  if (!args.substitutionsPath) fail(['substitutions_required']);
  // stdout is default; --stdout is accepted as an explicit no-op affirmation.

  let substitutions;
  const loaded = gen.loadSubstitutionsFile(path.resolve(args.substitutionsPath));
  if (!loaded.ok) fail(loaded.errors);
  substitutions = loaded.substitutions;

  const result = gen.generateDryRunPreview({
    repoRoot: ROOT,
    archetype: args.archetype,
    mode: args.mode,
    substitutions,
  });
  if (!result.ok) fail(result.errors);

  const emitted = gen.emitStdout(result);
  if (!emitted.ok) fail(emitted.errors);
  process.stdout.write(emitted.stdout);
}

main();
