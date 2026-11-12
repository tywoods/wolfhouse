'use strict';

/**
 * Deploy must refuse to finish when the DB is missing migrations the code needs.
 * This morning's gap: prod went live without 132/133.
 *
 * Run: node scripts/verify-deploy-required-migrations-gate.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  requiredRelationsByMigration,
  missingCodeMigrations,
  formatDeployFail,
  assertCodeMigrationsApplied,
} = require('./lib/deploy-required-migrations-gate');

const repo = path.join(__dirname, '..');
const required = requiredRelationsByMigration(repo);

assert.ok(required['132_supervisor_events.sql'], 'code tree includes 132');
assert.ok(required['132_supervisor_events.sql'].includes('supervisor_events'));
assert.ok(required['133_booking_conversation_links.sql'], 'code tree includes 133');
assert.ok(required['133_booking_conversation_links.sql'].includes('booking_conversation_links'));

const presentWithout132133 = new Set(['bookings', 'payments']);
const missing = missingCodeMigrations({ required, presentRelations: presentWithout132133 });
assert.ok(missing.includes('132_supervisor_events.sql'), missing.join(','));
assert.ok(missing.includes('133_booking_conversation_links.sql'), missing.join(','));

const msg = formatDeployFail(missing);
assert.match(msg, /DEPLOY FAIL: database missing migrations the code needs/);
assert.match(msg, /132_supervisor_events\.sql/);
assert.match(msg, /133_booking_conversation_links\.sql/);

assert.throws(
  () => assertCodeMigrationsApplied({ required, presentRelations: presentWithout132133 }),
  (err) => err && err.code === 'missing_code_migrations' && /DEPLOY FAIL/.test(err.message),
);

const present = new Set(presentWithout132133);
for (const rels of Object.values(required)) {
  for (const rel of rels) present.add(rel);
}
assert.deepEqual(missingCodeMigrations({ required, presentRelations: present }), []);
assert.equal(assertCodeMigrationsApplied({ required, presentRelations: present }).ok, true);

const stagingSrc = fs.readFileSync(path.join(__dirname, 'france-wolfhouse-staging-fast-deploy.js'), 'utf8');
assert.match(
  stagingSrc,
  /assertDeployTargetHasCodeMigrations|assertCodeMigrationsApplied|assert-deploy-required-migrations/,
  'staging deploy must refuse to finish without the gate',
);
assert.ok(
  Math.max(
    stagingSrc.indexOf('assertDeployTargetHasCodeMigrations'),
    stagingSrc.indexOf('assertCodeMigrationsApplied'),
    stagingSrc.indexOf('assert-deploy-required-migrations'),
  ) < stagingSrc.indexOf('FASTDEPLOY DONE'),
  'gate runs before FASTDEPLOY DONE',
);

const gateSrc = fs.readFileSync(path.join(__dirname, 'lib', 'deploy-required-migrations-gate.js'), 'utf8');
assert.match(gateSrc, /france-prod/);
assert.match(gateSrc, /wolfhouse-prod-postgres/);

const { spawnSync } = require('node:child_process');
const cliFail = spawnSync(process.execPath, [
  path.join(__dirname, 'assert-deploy-required-migrations.js'),
  '--present-relations', 'bookings,payments',
], { encoding: 'utf8' });
assert.equal(cliFail.status, 1, 'CLI must refuse when 132/133 tables are absent');
assert.match(String(cliFail.stderr || '') + String(cliFail.stdout || ''), /DEPLOY FAIL: database missing migrations the code needs/);
assert.match(String(cliFail.stderr || '') + String(cliFail.stdout || ''), /132_supervisor_events\.sql/);

const runbooks = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'wolfhouse-prod', 'runbooks.md'), 'utf8');
assert.match(runbooks, /assert-deploy-required-migrations\.js --target france-prod/);

console.log('PASS deploy refuses to finish when DB is missing migrations the code needs');
