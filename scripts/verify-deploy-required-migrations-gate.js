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

const FALSE_STAGING_LIST = [
  '001_init.sql',
  '021_sunset_admin_business_config.sql',
  '026_tenant_surf_pack_rules.sql',
  '033_staff_automated_notifications.sql',
  '036_sunset_waivers.sql',
  '051_tenant_rental_offerings.sql',
  '052_tenant_accommodation.sql',
  '054_tenant_external_waiver_settings.sql',
  '059_tenant_email_delegated_grants.sql',
  '060_tenant_email_oauth_transactions.sql',
  '063_tenant_email_inbound_events.sql',
  '064_tenant_email_inbound_delta_states.sql',
  '065_tenant_email_delta_recovery_operations.sql',
  '067_tenant_email_inbound_inbox_projections.sql',
  '068_tenant_email_outbound_send_journal.sql',
  '070_tenant_email_reply_approvals.sql',
  '075_tenant_email_google_oauth_transactions.sql',
  '079_broadcasts.sql',
  '080_tenant_email_delta_from_now_v2.sql',
  '084_tenant_channel_endpoint_imap_health.sql',
  '085_tenant_email_luna_policy_audit.sql',
  '086_tenant_email_luna_automation_queue.sql',
  '088_tenant_email_luna_automation_principal_grants.sql',
  '092_tenant_email_luna_automation_issuance_material.sql',
  '093_tenant_email_luna_automation_shadow_outcomes.sql',
  '097_tenant_email_luna_controlled_draft_operations.sql',
  '098_tenant_email_luna_controlled_drafting_staging_test_authorization.sql',
  '100_tenant_email_same_desk_auto_send_claims.sql',
  '101_luna_guest_runtime_phase1.sql',
  '102_tenant_surf_beach_registry.sql',
];
const falseSet = new Set(FALSE_STAGING_LIST);
const wolfhouseStagingPresent = new Set();
for (const [file, rels] of Object.entries(required)) {
  for (const rel of rels) {
    if (rel === 'hostels') {
      wolfhouseStagingPresent.add('clients');
      continue;
    }
    if (falseSet.has(file) && file !== '001_init.sql') continue;
    wolfhouseStagingPresent.add(rel);
  }
}

const naiveMissing = missingCodeMigrations({
  required,
  presentRelations: wolfhouseStagingPresent,
  naive: true,
});
assert.deepEqual(naiveMissing, FALSE_STAGING_LIST, naiveMissing.join(','));

const stagingMissing = missingCodeMigrations({
  required,
  presentRelations: wolfhouseStagingPresent,
  extraPending: ['135_remove_operator_room_designation.sql'],
});
assert.deepEqual(
  stagingMissing,
  ['135_remove_operator_room_designation.sql'],
  `healthy wolfhouse staging must only pending 135, got ${stagingMissing.join(',')}`,
);

const without132133 = new Set(wolfhouseStagingPresent);
for (const rel of required['132_supervisor_events.sql']) without132133.delete(rel);
for (const rel of required['133_booking_conversation_links.sql']) without132133.delete(rel);
const prodMiss = missingCodeMigrations({ required, presentRelations: without132133 });
assert.ok(prodMiss.includes('132_supervisor_events.sql'), prodMiss.join(','));
assert.ok(prodMiss.includes('133_booking_conversation_links.sql'), prodMiss.join(','));
assert.ok(!prodMiss.includes('001_init.sql'), 'renamed hostels must not look like 001 is missing');
assert.ok(!prodMiss.includes('021_sunset_admin_business_config.sql'), 'Sunset tables are not a Wolfhouse gap');

assert.ok(
  missingCodeMigrations({
    required,
    presentRelations: new Set(['bookings']),
    appliedMigrationIds: ['001_init'],
  }).includes('132_supervisor_events.sql'),
);
assert.ok(
  !missingCodeMigrations({
    required,
    presentRelations: new Set(['bookings']),
    appliedMigrationIds: ['001_init', '001_init.sql'],
  }).includes('001_init.sql'),
  'ledger id 001_init counts as applied even without .sql',
);

const { assertDeployTargetHasCodeMigrations } = require('./lib/deploy-required-migrations-gate');
const liveCalls = [];
assert.throws(
  () => assertDeployTargetHasCodeMigrations({
    repoRoot: repo,
    target: 'france-staging',
    exec: (bin, args) => {
      const line = [bin, ...args].join(' ');
      liveCalls.push(line);
      if (line.includes('pg_class')) return [...wolfhouseStagingPresent].join('\n');
      if (line.includes('operator_surfweek')) return '135_remove_operator_room_designation.sql';
      if (line.includes('SELECT id FROM schema_migration_ledger')) return '042_luna_sales_schema\n076_wolfhouse_pricing_admin';
      if (line.includes('to_regclass')) return 'schema_migration_ledger';
      return '';
    },
  }),
  (err) => err && err.missing && err.missing.length === 1
    && err.missing[0] === '135_remove_operator_room_designation.sql',
);
assert.ok(liveCalls.some((c) => c.includes('schema_migration_ledger')), 'gate reads the ledger');
assert.ok(liveCalls.some((c) => c.includes('operator_surfweek')), 'gate probes leftover operator designation');

console.log('PASS deploy refuses to finish when DB is missing migrations the code needs');
