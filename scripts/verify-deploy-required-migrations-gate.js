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
  createdRelationsFromSql,
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

const migDir = path.join(repo, 'database', 'migrations');
function realSql(name) {
  return fs.readFileSync(path.join(migDir, name), 'utf8');
}

const rels007 = createdRelationsFromSql(realSql('007_add_addon_orders.sql'));
assert.ok(rels007.includes('add_on_orders'), '007 still requires public add_on_orders');
assert.ok(!rels007.includes('if'), '007 comment CREATE TABLE IF must not become table if');

const rels103 = createdRelationsFromSql(realSql('103_crowsnest_comms_number_route_audit.sql'));
assert.ok(!rels103.includes('does'), '103 comment must not become table does');
assert.ok(!rels103.includes('crowsnest_comms'), '103 schema-qualified name is not public relname');

const rels042 = createdRelationsFromSql(realSql('042_luna_sales_schema.sql'));
assert.ok(!rels042.includes('luna_sales'), '042 luna_sales.prospects is not public');
assert.deepEqual(rels042, [], '042 creates no public tables');

const rels048 = createdRelationsFromSql(realSql('048_crowsnest_metrics_client_metrics_snapshots.sql'));
assert.ok(!rels048.includes('crowsnest_metrics'));

const rels132 = createdRelationsFromSql(realSql('132_supervisor_events.sql'));
assert.ok(rels132.includes('supervisor_events'));
assert.deepEqual(
  createdRelationsFromSql('CREATE TABLE public.booking_conversation_links (id uuid);'),
  ['booking_conversation_links'],
  'schema-qualified public.relname matches pg_class.relname',
);

const bogus = ['if', 'does', 'luna_sales', 'crowsnest_metrics', 'crowsnest_comms'];
const demanded = new Set();
for (const rels of Object.values(required)) {
  for (const rel of rels) demanded.add(rel);
}
for (const name of bogus) {
  assert.ok(!demanded.has(name), `real migrations must not demand table ${name}`);
}

const presentPublicOnly = new Set(['bookings', 'payments', 'supervisor_events', 'supervisor_incidents', 'supervisor_catchup_checkpoints', 'supervisor_lifecycle', 'booking_conversation_links']);
const missingOnPartialDb = missingCodeMigrations({ required, presentRelations: presentPublicOnly });
assert.ok(!missingOnPartialDb.some((f) => /042_luna_sales|048_crowsnest_metrics|103_crowsnest_comms/.test(f)),
  `false missing from comment/schema parse: ${missingOnPartialDb.join(',')}`);

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
