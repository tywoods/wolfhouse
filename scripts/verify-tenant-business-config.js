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

  console.log('\n[5] Admin writes — flag-gated (offline)');
  const writes = require('./lib/tenant-admin-writes');
  const savedWritesFlag = process.env.SUNSET_ADMIN_WRITES_ENABLED;

  delete process.env.SUNSET_ADMIN_WRITES_ENABLED;
  assert('writes flag default off', writes.isSunsetAdminWritesEnabled() === false);
  const flagOffGate = writes.evaluateAdminWriteGate({
    user: { role: 'owner', email: 'o@example.com', staff_user_id: 'u1' },
    clientSlug: 'sunset',
    staffAuthRequired: true,
  });
  assert('flag off blocks writes 403', flagOffGate.ok === false && flagOffGate.status === 403);
  assert('flag off error writes_disabled', flagOffGate.body && flagOffGate.body.error === 'writes_disabled');

  process.env.SUNSET_ADMIN_WRITES_ENABLED = 'true';
  assert('writes flag true when set', writes.isSunsetAdminWritesEnabled() === true);

  const viewerGate = writes.evaluateAdminWriteGate({
    user: { role: 'viewer', email: 'v@example.com', staff_user_id: 'u2' },
    clientSlug: 'sunset',
    staffAuthRequired: true,
  });
  assert('viewer blocked from writes', viewerGate.ok === false && viewerGate.body.error === 'forbidden_role');

  const wolfGate = writes.evaluateAdminWriteGate({
    user: { role: 'owner', email: 'o@example.com', staff_user_id: 'u1' },
    clientSlug: 'wolfhouse-somo',
    staffAuthRequired: true,
  });
  assert('wolfhouse client blocked', wolfGate.ok === false && wolfGate.body.error === 'unsupported_client');

  const ownerGate = writes.evaluateAdminWriteGate({
    user: { role: 'owner', email: 'o@example.com', staff_user_id: 'u1' },
    clientSlug: 'sunset',
    staffAuthRequired: true,
  });
  assert('owner allowed past gate', ownerGate.ok === true);

  const badPrice = writes.validatePricePatchBody({ amount_cents: -1 });
  assert('negative amount rejected', badPrice.ok === false);
  const unknownField = writes.validatePricePatchBody({ hacker: true, amount_cents: 100 });
  assert('unknown price field rejected', unknownField.ok === false);
  const goodPrice = writes.validatePricePatchBody({ amount_cents: 1500, currency: 'eur' });
  assert('valid price patch accepted', goodPrice.ok === true && goodPrice.patch.amount_cents === 1500);

  const badCap = writes.validateLessonCapacityBody({ default_daily_cap: 0 });
  assert('capacity zero rejected', badCap.ok === false);
  const goodCap = writes.validateLessonCapacityBody({ default_daily_cap: 24 });
  assert('valid capacity accepted', goodCap.ok === true);

  const badTime = writes.validateLessonTimePatchBody({ time_local: '25:00' });
  assert('invalid time rejected', badTime.ok === false);
  const badWeekday = writes.validateLessonTimePatchBody({ weekdays_active: [7] });
  assert('invalid weekday rejected', badWeekday.ok === false);

  const ruleId = '11111111-1111-4111-8111-111111111111';
  let auditInserted = false;
  let updateRan = false;
  const mockPg = {
    async query(sql, params) {
      const s = String(sql);
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('FROM tenant_price_rules') && s.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: ruleId,
            tenant_id: 'sunset',
            client_slug: 'sunset',
            item_type: 'lesson',
            item_code: 'group_lesson_adult',
            display_name: 'Group lesson',
            currency: 'EUR',
            amount_cents: 5000,
            unit: 'person',
            active: true,
          }],
        };
      }
      if (s.startsWith('UPDATE tenant_price_rules')) {
        updateRan = true;
        return { rows: [{ id: ruleId, amount_cents: 5500, client_slug: 'sunset', tenant_id: 'sunset' }] };
      }
      if (s.includes('INSERT INTO tenant_config_audit_log')) {
        auditInserted = true;
        return { rows: [] };
      }
      throw new Error('unexpected query: ' + s.slice(0, 80));
    },
  };

  const writeResult = await writes.patchPriceRule(mockPg, {
    ruleId,
    clientSlug: 'sunset',
    patch: { amount_cents: 5500 },
    actor: { staff_user_id: 'u1', email: 'owner@example.com' },
  });
  assert('mock price write success', writeResult.ok === true && writeResult.status === 200);
  assert('mock update ran', updateRan === true);
  assert('mock audit inserted', auditInserted === true);

  if (savedWritesFlag == null) delete process.env.SUNSET_ADMIN_WRITES_ENABLED;
  else process.env.SUNSET_ADMIN_WRITES_ENABLED = savedWritesFlag;

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
