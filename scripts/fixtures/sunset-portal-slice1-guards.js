'use strict';

/**
 * Shared safety guards for Sunset Portal Slice 1 seed/cleanup scripts.
 * Fail-closed: --execute permitted only on localhost/test OR approved Sunset staging DB.
 */

const fs = require('fs');
const path = require('path');

const DEMO_TAG = 'sunset_demo_slice1';
const ALLOW_ENV_KEY = 'ALLOW_SUNSET_DEMO_SEED';
const STAGING_DB_ALLOW_ENV_KEY = 'SUNSET_DEMO_SEED_STAGING_DB_ALLOW';
const EXPECTED_TENANT = 'sunset';
const APPROVED_STAGING_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const APPROVED_STAGING_DB = 'sunset_staging';
const MANIFEST_PATH = path.join(__dirname, '..', '..', 'fixtures', 'sunset-portal-slice1', 'seed-manifest.json');

const REJECT_HOST_PATTERNS = [
  /wh-staging/i,
  /wolfhouse/i,
  /production/i,
  /(^|[-_.])prod([-.]|$)/i,
  /\.prod\./i,
  /staff-staging\.lunafrontdesk/i,
  /lunafrontdesk/i,
];

const REJECT_DATABASE_PATTERNS = [
  /wolfhouse_staging/i,
];

const ALLOW_LOCAL_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.0\.0\.1$/,
  /^host\.docker\.internal$/i,
  /^postgres$/i,
  /\.local$/i,
  /\.test$/i,
  /^test-db$/i,
];

function parseCliArgs(argv) {
  const args = argv || process.argv.slice(2);
  return {
    execute: args.includes('--execute'),
    forceRefresh: args.includes('--force-refresh'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function getDatabaseUrl() {
  return String(process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL || '').trim();
}

function parseDatabaseTarget(connectionString) {
  const url = String(connectionString || '').trim();
  if (!url) return { host: null, database: null };

  let host = null;
  let database = null;
  try {
    const normalized = url.replace(/^postgres(ql)?:\/\//i, 'http://');
    const parsed = new URL(normalized);
    host = parsed.hostname || null;
    database = parsed.pathname.replace(/^\//, '').split('?')[0] || null;
  } catch {
    const hostMatch = url.match(/@([^:/?#]+)/);
    const dbMatch = url.match(/\/([^/?#]+)(?:\?|$)/);
    host = hostMatch ? hostMatch[1] : null;
    database = dbMatch ? dbMatch[1] : null;
  }

  return { host, database };
}

function parseDatabaseHost(connectionString) {
  return parseDatabaseTarget(connectionString).host;
}

function isApprovedStagingTarget(host, database) {
  return host === APPROVED_STAGING_HOST && database === APPROVED_STAGING_DB;
}

function matchesRejectPatterns(host, database) {
  const hostLower = String(host || '').toLowerCase();
  const dbLower = String(database || '').toLowerCase();

  for (const pattern of REJECT_HOST_PATTERNS) {
    if (pattern.test(hostLower)) {
      return `blocked host pattern: ${pattern}`;
    }
  }
  for (const pattern of REJECT_DATABASE_PATTERNS) {
    if (pattern.test(dbLower)) {
      return `blocked database pattern: ${pattern}`;
    }
  }
  return null;
}

/**
 * @returns {{ status: 'allowed'|'allowed-staging'|'missing'|'ambiguous'|'rejected', host?: string, database?: string, reason?: string }}
 */
function classifyDatabaseUrl(connectionString) {
  const url = String(connectionString || '').trim();
  if (!url) {
    return { status: 'missing', reason: 'WOLFHOUSE_DATABASE_URL/DATABASE_URL is missing' };
  }

  const { host, database } = parseDatabaseTarget(url);
  if (!host || !database) {
    return { status: 'ambiguous', reason: 'could not parse database host/database from connection string' };
  }

  const blocked = matchesRejectPatterns(host, database);
  if (blocked) {
    return { status: 'rejected', host, database, reason: `host/database matches ${blocked}` };
  }

  if (isApprovedStagingTarget(host, database)) {
    return { status: 'allowed-staging', host, database };
  }

  const hostLower = host.toLowerCase();
  const localAllowed = ALLOW_LOCAL_HOST_PATTERNS.some((pattern) => pattern.test(hostLower));
  if (localAllowed) {
    return { status: 'allowed', host, database };
  }

  return {
    status: 'rejected',
    host,
    database,
    reason: `host not in localhost/test allowlist and not approved Sunset staging target (${APPROVED_STAGING_HOST}/${APPROVED_STAGING_DB})`,
  };
}

function assertAllowSeedEnv() {
  if (process.env[ALLOW_ENV_KEY] !== '1') {
    throw new Error(`${ALLOW_ENV_KEY}=1 is required for --execute mode`);
  }
}

function assertStagingDbAllowEnv() {
  if (process.env[STAGING_DB_ALLOW_ENV_KEY] !== '1') {
    throw new Error(`${STAGING_DB_ALLOW_ENV_KEY}=1 is required for --execute against Sunset staging DB`);
  }
}

function assertNotProductionEnv() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('NODE_ENV=production is not allowed for seed/cleanup scripts');
  }
}

function assertDatabaseUrlForExecute(connectionString) {
  const verdict = classifyDatabaseUrl(connectionString);
  if (verdict.status === 'allowed' || verdict.status === 'allowed-staging') {
    if (verdict.status === 'allowed-staging') {
      assertStagingDbAllowEnv();
    }
    return verdict;
  }
  throw new Error(`database URL fail-closed for --execute: ${verdict.reason}`);
}

function assertExecuteGates(opts, connectionString) {
  if (!opts || !opts.execute) return { mode: 'dry-run' };
  assertNotProductionEnv();
  assertAllowSeedEnv();
  const verdict = assertDatabaseUrlForExecute(connectionString || getDatabaseUrl());
  return {
    mode: 'execute',
    host: verdict.host,
    database: verdict.database,
    target: verdict.status,
  };
}

function loadManifest(filePath = MANIFEST_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function assertTenantScoped(label, obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error(`${label}: expected object`);
  }
  if (obj.tenant_id !== EXPECTED_TENANT) {
    throw new Error(`${label}: tenant_id must be ${EXPECTED_TENANT}, got ${JSON.stringify(obj.tenant_id)}`);
  }
  if (obj.client_slug !== EXPECTED_TENANT) {
    throw new Error(`${label}: client_slug must be ${EXPECTED_TENANT}, got ${JSON.stringify(obj.client_slug)}`);
  }
}

function assertNoWolfhouse(label, value) {
  const str = JSON.stringify(value);
  if (/wolfhouse/i.test(str)) {
    throw new Error(`${label}: wolfhouse scope is not allowed`);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest must be an object');
  }
  assertTenantScoped('manifest', manifest);
  assertNoWolfhouse('manifest', manifest);

  if (!Array.isArray(manifest.conversations)) {
    throw new Error('manifest.conversations must be an array');
  }
  if (!Array.isArray(manifest.booking_service_records)) {
    throw new Error('manifest.booking_service_records must be an array');
  }

  for (const conv of manifest.conversations) {
    assertTenantScoped(`conversation ${conv.conversation_id || '(unknown)'}`, conv);
    assertNoWolfhouse(`conversation ${conv.conversation_id}`, conv);
    if (!Array.isArray(conv.turns) || conv.turns.length === 0) {
      throw new Error(`conversation ${conv.conversation_id}: turns required`);
    }
  }

  for (const rec of manifest.booking_service_records) {
    assertTenantScoped(`booking_service_record ${rec.record_id || '(unknown)'}`, rec);
    assertNoWolfhouse(`booking_service_record ${rec.record_id}`, rec);
  }

  if (Array.isArray(manifest.accommodation_partner_queue)) {
    for (const rec of manifest.accommodation_partner_queue) {
      assertTenantScoped(`accommodation ${rec.record_id || '(unknown)'}`, rec);
      assertNoWolfhouse(`accommodation ${rec.record_id}`, rec);
    }
  }

  return manifest;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\s+/g, '').trim();
}

function demoMetadata(extra = {}) {
  return {
    source: DEMO_TAG,
    tenant_id: EXPECTED_TENANT,
    client_slug: EXPECTED_TENANT,
    note: 'Sunset portal Slice 1 staging demo — safe to delete',
    ...extra,
  };
}

function mapServiceRecords(manifestRecord) {
  const base = {
    manifest_record_id: manifestRecord.record_id,
    manifest_service_type: manifestRecord.service_type,
    pricing_status: manifestRecord.pricing_status || 'unverified_seed',
    offering_label: manifestRecord.offering_label || null,
    slot_time: manifestRecord.slot_time || null,
  };

  if (manifestRecord.service_type === 'group_lesson_adult') {
    return [{
      db_service_type: 'surf_lesson',
      quantity: Number(manifestRecord.seats) > 0 ? Number(manifestRecord.seats) : 1,
      metadata: demoMetadata(base),
    }];
  }

  if (manifestRecord.service_type === 'board_rental') {
    return [{
      db_service_type: 'surfboard',
      quantity: 1,
      metadata: demoMetadata(base),
    }];
  }

  if (manifestRecord.service_type === 'board_and_suit_rental') {
    return [
      {
        db_service_type: 'surfboard',
        quantity: 1,
        metadata: demoMetadata({ ...base, bundle_part: 'board' }),
      },
      {
        db_service_type: 'wetsuit',
        quantity: 1,
        metadata: demoMetadata({ ...base, bundle_part: 'wetsuit' }),
      },
    ];
  }

  throw new Error(`unsupported manifest service_type: ${manifestRecord.service_type}`);
}

function buildSeedPlan(manifest) {
  const conversations = manifest.conversations.length;
  const messages = manifest.conversations.reduce((sum, c) => sum + c.turns.length, 0);
  const bookings = manifest.booking_service_records.length;
  const serviceRecords = manifest.booking_service_records.reduce(
    (sum, rec) => sum + mapServiceRecords(rec).length,
    0,
  );
  const handoffs = manifest.conversations.filter((c) => c.demo_state && c.demo_state.handoff_needed).length;
  const accommodationSkipped = Array.isArray(manifest.accommodation_partner_queue)
    ? manifest.accommodation_partner_queue.length
    : 0;

  return {
    tag: DEMO_TAG,
    conversations,
    messages,
    bookings,
    booking_service_records: serviceRecords,
    staff_handoffs: handoffs,
    payments: 0,
    booking_beds: 0,
    accommodation_skipped: accommodationSkipped,
  };
}

function buildCleanupPlan() {
  return {
    tag: DEMO_TAG,
    staff_handoffs: 'all tagged',
    messages: 'all tagged',
    conversations: 'all tagged (after nulling hold FK)',
    booking_service_records: 'client_slug=sunset AND tagged',
    bookings: 'all tagged',
    payments: 'all tagged (expect 0)',
  };
}

function printSeedPlan(plan, mode) {
  console.log(`\nsunset-portal-slice1-seed — ${mode}`);
  console.log(`  tag: ${plan.tag}`);
  console.log('  PLANNED row counts:');
  console.log(`    conversations:           ${plan.conversations}`);
  console.log(`    messages:                ${plan.messages}`);
  console.log(`    bookings:                ${plan.bookings}`);
  console.log(`    booking_service_records: ${plan.booking_service_records}`);
  console.log(`    staff_handoffs:          ${plan.staff_handoffs}`);
  console.log(`    payments:                ${plan.payments}`);
  console.log(`    booking_beds:            ${plan.booking_beds}`);
  console.log(`    accommodation_skipped:   ${plan.accommodation_skipped} (manifest-only in v1)`);
}

function printCleanupPlan(plan, mode) {
  console.log(`\nsunset-portal-slice1-cleanup — ${mode}`);
  console.log(`  tag: ${plan.tag}`);
  console.log('  PLANNED delete scope:');
  for (const [table, scope] of Object.entries(plan)) {
    if (table === 'tag') continue;
    console.log(`    ${table}: ${scope}`);
  }
}

module.exports = {
  DEMO_TAG,
  ALLOW_ENV_KEY,
  STAGING_DB_ALLOW_ENV_KEY,
  APPROVED_STAGING_HOST,
  APPROVED_STAGING_DB,
  EXPECTED_TENANT,
  MANIFEST_PATH,
  parseCliArgs,
  getDatabaseUrl,
  parseDatabaseHost,
  parseDatabaseTarget,
  classifyDatabaseUrl,
  assertAllowSeedEnv,
  assertStagingDbAllowEnv,
  assertNotProductionEnv,
  assertDatabaseUrlForExecute,
  assertExecuteGates,
  loadManifest,
  validateManifest,
  normalizePhone,
  demoMetadata,
  mapServiceRecords,
  buildSeedPlan,
  buildCleanupPlan,
  printSeedPlan,
  printCleanupPlan,
};
