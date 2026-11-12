#!/usr/bin/env node
'use strict';

/**
 * Loud finish-gate for France staging and prod deploys.
 * Does not apply SQL. Exits 1 when the DB is missing tables the code's
 * numbered migrations create (the 132/133 miss).
 *
 *   node scripts/assert-deploy-required-migrations.js --target france-staging
 *   node scripts/assert-deploy-required-migrations.js --target france-prod
 *   node scripts/assert-deploy-required-migrations.js --present-relations bookings,payments
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  requiredRelationsByMigration,
  assertCodeMigrationsApplied,
  assertDeployTargetHasCodeMigrations,
} = require('./lib/deploy-required-migrations-gate');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return '';
  return String(process.argv[i + 1] || '').trim();
}

function exec(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim() || `${bin} ${args.join(' ')} failed`;
    console.error('DEPLOY FAIL:', msg);
    process.exit(1);
  }
  return (r.stdout || '').trim();
}

function main() {
  const repoRoot = path.join(__dirname, '..');
  const presentArg = arg('--present-relations');
  const target = arg('--target') || (presentArg ? '' : 'france-staging');
  try {
    if (presentArg) {
      const presentRelations = new Set(presentArg.split(',').map((s) => s.trim()).filter(Boolean));
      assertCodeMigrationsApplied({
        required: requiredRelationsByMigration(repoRoot),
        presentRelations,
      });
    } else {
      assertDeployTargetHasCodeMigrations({ repoRoot, target, exec });
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
  console.log('DEPLOY MIGRATIONS OK');
}

if (require.main === module) main();

module.exports = { main };
