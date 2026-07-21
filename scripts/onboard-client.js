#!/usr/bin/env node
'use strict';

/**
 * FACTORY Slice 1C — onboard-client CLI (dry-run preview only).
 *
 * Default and only supported mode: dry-run. No apply path, no registry edits,
 * no config/clients writes, no runtime/DB/cloud/secrets/deploy/network.
 *
 * Usage:
 *   node scripts/onboard-client.js \
 *     --archetype surf_house \
 *     --substitutions fixtures/.../subs.json \
 *     --output-dir /tmp/factory-1c-preview
 *
 *   node scripts/onboard-client.js ... --stdout
 */

const fs = require('fs');
const path = require('path');
const gen = require('./lib/factory-slice1c-dry-run-generator');

const ROOT = path.join(__dirname, '..');

function printHelp() {
  process.stdout.write(`FACTORY onboard-client — dry-run preview only

Usage:
  node scripts/onboard-client.js --archetype <id> --substitutions <file.json> \\
    (--output-dir <dir> | --stdout) [--mode dry-run]

Archetypes: ${gen.ARCHETYPE_IDS.join(', ')}
Mode: ${gen.MODE_DRY_RUN} (only)

Rejects: apply, registry writes, config/clients writes, overwrite, secrets,
live-target shaped inputs, path traversal, existing tenant/location conflicts.
`);
}

function parseArgs(argv) {
  const out = {
    archetype: null,
    substitutionsPath: null,
    outputDir: null,
    stdout: false,
    mode: gen.MODE_DRY_RUN,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--stdout') out.stdout = true;
    else if (a === '--archetype') out.archetype = argv[++i];
    else if (a === '--substitutions') out.substitutionsPath = argv[++i];
    else if (a === '--output-dir') out.outputDir = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--apply') {
      return { error: 'apply_path_forbidden' };
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
  if (!args.stdout && !args.outputDir) fail(['output_dir_or_stdout_required']);
  if (args.stdout && args.outputDir) fail(['stdout_and_output_dir_mutually_exclusive']);

  let substitutions;
  try {
    substitutions = JSON.parse(fs.readFileSync(path.resolve(args.substitutionsPath), 'utf8'));
  } catch (err) {
    fail([`substitutions_unreadable:${err.message}`]);
  }
  if (!substitutions || typeof substitutions !== 'object' || Array.isArray(substitutions)) {
    fail(['substitutions_must_be_object']);
  }

  const result = gen.generateDryRunPreview({
    repoRoot: ROOT,
    archetype: args.archetype,
    mode: args.mode,
    substitutions,
  });
  if (!result.ok) fail(result.errors);

  if (args.stdout) {
    const emitted = gen.emitStdout(result);
    if (!emitted.ok) fail(emitted.errors);
    process.stdout.write(emitted.stdout);
    return;
  }

  const written = gen.writeDryRunPreview(result, {
    repoRoot: ROOT,
    outputDir: args.outputDir,
  });
  if (!written.ok) fail(written.errors);

  process.stdout.write(gen.sortedStringify({
    ok: true,
    mode: gen.MODE_DRY_RUN,
    output_dir: written.outputDir,
    files: written.written.map((w) => ({
      relative_path: w.relativePath,
      sha256: w.sha256,
    })),
  }));
}

main();
