'use strict';

/**
 * verify:tenant-business-config
 *
 * Offline assertions for tenant-business-config.js resolver.
 * No DB, no network, no secrets required.
 *
 * Run: node scripts/verify-tenant-business-config.js
 *      npm run verify:tenant-business-config
 */

const {
  DEFAULT_DAILY_CAP,
  SUNSET_ADMIN_CLIENT,
  isSunsetAdminDbReadEnabled,
  resolveTenantBusinessConfig,
  resolveTenantBusinessConfigAsync,
} = require('./lib/tenant-business-config');

let pass = 0;
let fail = 0;
const savedDbReadFlag = process.env.SUNSET_ADMIN_DB_READ_ENABLED;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function restoreEnv() {
  if (savedDbReadFlag == null) {
    delete process.env.SUNSET_ADMIN_DB_READ_ENABLED;
  } else {
    process.env.SUNSET_ADMIN_DB_READ_ENABLED = savedDbReadFlag;
  }
}

console.log('\nverify:tenant-business-config — read-only resolver checks\n');

console.log('[1] Sunset config resolution (flag off, sync)');
const sunset = resolveTenantBusinessConfig('sunset');
assert('sunset ok', sunset.ok === true);
assert('client_slug sunset', sunset.client_slug === 'sunset');
assert('read_only true', sunset.read_only === true);
assert('source is config', sunset.source === 'config');
assert('default_daily_cap 24', sunset.lesson_capacity.default_daily_cap === DEFAULT_DAILY_CAP);
assert('overrides empty array', Array.isArray(sunset.lesson_capacity.overrides) && sunset.lesson_capacity.overrides.length === 0);
assert('prices from baseline catalog', Array.isArray(sunset.prices) && sunset.prices.length > 0);
assert('includes rental price', sunset.prices.some((p) => p.category === 'rental' && p.offering_key === 'board_rental'));
assert('includes lesson price', sunset.prices.some((p) => p.category === 'lesson' && p.offering_key === 'group_lesson_adult'));
assert('lesson times from portal_demo', Array.isArray(sunset.lesson_times) && sunset.lesson_times.length >= 3);
assert('business name Sunset Surf School', sunset.business_info.name === 'Sunset Surf School');
assert('timezone Europe/Madrid', sunset.business_info.timezone === 'Europe/Madrid');
assert('change_history empty', Array.isArray(sunset.change_history) && sunset.change_history.length === 0);
assert('no db_read_warning when flag off', sunset.db_read_warning == null);

console.log('\n[2] Tenant isolation');
const wolfhouse = resolveTenantBusinessConfig('wolfhouse-somo');
assert('wolfhouse blocked', wolfhouse.ok === false && wolfhouse.reason === 'unsupported_client');
assert('wolfhouse slug preserved', wolfhouse.client_slug === 'wolfhouse-somo');

console.log('\n[3] Constants and flag default');
assert('SUNSET_ADMIN_CLIENT is sunset', SUNSET_ADMIN_CLIENT === 'sunset');
assert('DEFAULT_DAILY_CAP is 24', DEFAULT_DAILY_CAP === 24);
delete process.env.SUNSET_ADMIN_DB_READ_ENABLED;
assert('DB read flag default off', isSunsetAdminDbReadEnabled() === false);
process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
assert('DB read flag true when set', isSunsetAdminDbReadEnabled() === true);
restoreEnv();

async function runAsyncChecks() {
  console.log('\n[4] Async resolver — DB path behind flag (mocked)');

  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
  const flagOffAsync = await resolveTenantBusinessConfigAsync('sunset');
  assert('flag off async source config', flagOffAsync.source === 'config');
  assert('flag off async no warning', flagOffAsync.db_read_warning == null);

  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  const emptyDb = await resolveTenantBusinessConfigAsync('sunset', {
    loadFromDb: async () => ({ ok: true, hasData: false }),
  });
  assert('empty DB falls back to config source', emptyDb.source === 'config');
  assert('empty DB keeps baseline prices', Array.isArray(emptyDb.prices) && emptyDb.prices.length > 0);
  assert('empty DB no warning', emptyDb.db_read_warning == null);

  const missingTables = await resolveTenantBusinessConfigAsync('sunset', {
    loadFromDb: async () => ({ ok: false, reason: 'tables_missing', hasData: false }),
  });
  assert('missing tables falls back to config source', missingTables.source === 'config');
  assert('missing tables warning', missingTables.db_read_warning === 'tables_missing');

  const dbFailure = await resolveTenantBusinessConfigAsync('sunset', {
    loadFromDb: async () => { throw new Error('connection refused'); },
  });
  assert('DB failure falls back to config source', dbFailure.source === 'config');
  assert('DB failure warning present', typeof dbFailure.db_read_warning === 'string' && dbFailure.db_read_warning.length > 0);
  assert('DB failure keeps prices', Array.isArray(dbFailure.prices) && dbFailure.prices.length > 0);

  const dbPayload = await resolveTenantBusinessConfigAsync('sunset', {
    loadFromDb: async (slug) => {
      assert('loadFromDb scoped to sunset', slug === 'sunset');
      return {
        ok: true,
        hasData: true,
        prices: [{
          category: 'lesson',
          offering_key: 'group_lesson_adult',
          label: 'DB Group lesson',
          currency: 'EUR',
          unit: 'person',
          amount: 55,
          active: true,
          effective_state: 'db',
          source: 'db',
        }],
        lesson_capacity: {
          fromDb: true,
          default_daily_cap: 30,
          overrides: [{ scope: 'date', date: '2026-07-10', capacity: 18, source: 'db' }],
        },
        lesson_times: [{
          slot_id: 'slot-1',
          date: null,
          slot_time: '11:00-13:00',
          offering_label: 'Morning lesson',
          session_type: 'group_lesson_adult',
          capacity: null,
          source: 'db',
        }],
        change_history: [{
          id: 'audit-1',
          action: 'import',
          entity_type: 'price_rule',
          entity_id: 'rule-1',
          actor_email: 'owner@example.com',
          changed_at: '2026-06-20T12:00:00.000Z',
          source: 'db',
        }],
      };
    },
  });
  assert('DB data source is db', dbPayload.source === 'db');
  assert('DB prices used', dbPayload.prices.length === 1 && dbPayload.prices[0].label === 'DB Group lesson');
  assert('DB capacity default 30', dbPayload.lesson_capacity.default_daily_cap === 30);
  assert('DB capacity override preserved', dbPayload.lesson_capacity.overrides.length === 1);
  assert('DB lesson times used', dbPayload.lesson_times.length === 1);
  assert('DB change history used', dbPayload.change_history.length === 1);

  const wolfhouseAsync = await resolveTenantBusinessConfigAsync('wolfhouse-somo', {
    loadFromDb: async () => {
      throw new Error('must not be called for wolfhouse');
    },
  });
  assert('wolfhouse async blocked', wolfhouseAsync.ok === false && wolfhouseAsync.reason === 'unsupported_client');

  restoreEnv();

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:tenant-business-config — FAILED');
    process.exit(1);
  }
  console.log('verify:tenant-business-config — ALL CHECKS PASSED');
}

runAsyncChecks().catch((err) => {
  restoreEnv();
  console.error('verify:tenant-business-config — ERROR:', err.message);
  process.exit(1);
});
