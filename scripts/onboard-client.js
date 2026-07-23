#!/usr/bin/env node
'use strict';

/**
 * FACTORY / MESSI onboard-client — stdout dry-run by default; MESSI Stage 1
 * adds --materialize-to <DEST> (DEST must not exist). Legacy --output-dir rejected.
 */

const path = require('path');
const gen = require('./lib/factory-slice1c-dry-run-generator');
const mat = require('./lib/messi-saas-stage1-materialize');

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
  process.stdout.write(`FACTORY onboard-client — stdout dry-run (default) or --materialize-to <DEST>

Usage:
  node scripts/onboard-client.js --archetype <id> --substitutions <file.json> [--stdout] [--mode dry-run]
  node scripts/onboard-client.js --archetype <id> --substitutions <file.json> --materialize-to <DEST>

Archetypes: ${gen.ARCHETYPE_IDS.join(', ')}
Mode: ${gen.MODE_DRY_RUN}; materialize publishes those bytes into a non-existent DEST.
Rejects: --output-dir/--apply/legacy write flags, traversal/NUL, symlink parents,
reserved/existing tenants, destination collisions. Historical --output-dir unsupported.
`);
}

function parseArgs(argv) {
  const out = {
    archetype: null,
    substitutionsPath: null,
    stdout: false,
    mode: gen.MODE_DRY_RUN,
    materializeTo: null,
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
    } else if (a === '--materialize-to') {
      out.materializeTo = argv[++i];
      if (!out.materializeTo || out.materializeTo.startsWith('--')) {
        return { error: 'materialize_to_requires_dir' };
      }
    } else if (a.startsWith('--materialize-to=')) {
      out.materializeTo = a.slice('--materialize-to='.length);
      if (!out.materializeTo) return { error: 'materialize_to_requires_dir' };
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

  const loaded = gen.loadSubstitutionsFile(path.resolve(args.substitutionsPath));
  if (!loaded.ok) fail(loaded.errors);

  if (args.materializeTo) {
    if (args.mode && args.mode !== gen.MODE_DRY_RUN) fail(['apply_path_forbidden']);
    const result = mat.materializeDryRunTo({
      repoRoot: ROOT,
      archetype: args.archetype,
      substitutions: loaded.substitutions,
      dest: args.materializeTo,
    });
    if (!result.ok) fail(result.errors);
    const receipt = mat.emitMaterializeReceipt(result);
    if (!receipt.ok) fail(receipt.errors);
    process.stdout.write(receipt.stdout);
    return;
  }

  const result = gen.generateDryRunPreview({
    repoRoot: ROOT,
    archetype: args.archetype,
    mode: args.mode,
    substitutions: loaded.substitutions,
  });
  if (!result.ok) fail(result.errors);

  const emitted = gen.emitStdout(result);
  if (!emitted.ok) fail(emitted.errors);
  process.stdout.write(emitted.stdout);
}

main();
