'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const {
  PRICES, TENANT_ID, CLIENT_SLUG, LOCATION_ID, EXPECTED_HOST, EXPECTED_DB,
  assertExecuteTarget, seedWithClient,
} = require('./fixtures/sunset-somo-group-course-price-seed');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`PASS ${name}`); }

function mockPg(initial = []) {
  const rows = new Map(initial.map((r) => [r.item_code, { ...r }]));
  let snapshot;
  return {
    rows,
    calls: [],
    async query(sql, params = []) {
      this.calls.push({ sql, params });
      if (sql === 'BEGIN') { snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }])); return { rows: [] }; }
      if (sql === 'COMMIT') return { rows: [] };
      if (sql === 'ROLLBACK') { rows.clear(); for (const [k, v] of snapshot) rows.set(k, v); return { rows: [] }; }
      if (/INSERT INTO tenant_price_rules/.test(sql)) {
        const [tenant_id, client_slug, location_id, item_code, display_name, amount_cents] = params;
        const existing = rows.get(item_code);
        if (existing && existing.tenant_id === tenant_id && existing.client_slug === client_slug
          && existing.location_id === location_id && existing.active && existing.effective_from == null) return { rows: [] };
        rows.set(item_code, { tenant_id, client_slug, location_id, item_type: 'package', item_code,
          display_name, currency: 'EUR', amount_cents, unit: 'day', active: true,
          effective_from: null, effective_to: null });
        return { rows: [{ item_code }] };
      }
      if (/SELECT tenant_id, client_slug/.test(sql)) {
        return { rows: [...rows.values()].filter((r) => r.tenant_id === params[0]
          && r.client_slug === params[1] && r.location_id === params[2] && params[3].includes(r.item_code))
          .sort((a, b) => a.item_code.localeCompare(b.item_code)) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

async function main() {
  check('exact operator-authoritative cents', () => assert.deepStrictEqual(PRICES.map((r) => [r.item_code, r.amount_cents]), [
    ['group_course__4_days', 800], ['group_course__5_days', 1000],
    ['group_course__6_days', 1200], ['group_course__7_days', 2000],
  ]));
  check('scope is Sunset Somo only', () => assert.deepStrictEqual([TENANT_ID, CLIENT_SLUG, LOCATION_ID], ['sunset', 'sunset', 'sunset-somo']));

  const pg = mockPg();
  const first = await seedWithClient(pg);
  check('first run inserts four deterministic rows', () => assert.strictEqual(first.inserted.length, 4));
  check('readback proves four exact rows', () => assert.deepStrictEqual(first.rows.map((r) => [r.item_code, r.amount_cents]), PRICES.map((r) => [r.item_code, r.amount_cents])));
  const second = await seedWithClient(pg);
  check('second run is idempotent', () => { assert.strictEqual(second.inserted.length, 0); assert.strictEqual(second.skipped.length, 4); });

  const edited = mockPg([{ tenant_id: TENANT_ID, client_slug: CLIENT_SLUG, location_id: LOCATION_ID,
    item_type: 'package', item_code: 'group_course__4_days', currency: 'EUR', amount_cents: 999,
    unit: 'day', active: true, effective_from: null, effective_to: null }]);
  await assert.rejects(() => seedWithClient(edited), /existing Admin values preserved/);
  check('operator-edited value is not overwritten and transaction rolls back other inserts', () => {
    assert.strictEqual(edited.rows.get('group_course__4_days').amount_cents, 999);
    assert.strictEqual(edited.rows.size, 1);
  });

  const oldEnv = { ...process.env };
  process.env.ALLOW_SUNSET_ADMIN_PRICE_SEED = '1';
  process.env.SUNSET_ADMIN_PRICE_SEED_STAGING_DB_ALLOW = '1';
  delete process.env.NODE_ENV;
  check('approved staging target passes explicit gates', () => assert.doesNotThrow(() => assertExecuteTarget(`postgres://u:p@${EXPECTED_HOST}/${EXPECTED_DB}`)));
  check('Wolfhouse and arbitrary targets fail closed', () => {
    assert.throws(() => assertExecuteTarget('postgres://u:p@wh-staging-pg-app.postgres.database.azure.com/wolfhouse_staging'), /fail-closed/);
    assert.throws(() => assertExecuteTarget('postgres://u:p@localhost/test'), /fail-closed/);
  });
  process.env = oldEnv;

  const dry = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/sunset-somo-group-course-price-seed.js')], { encoding: 'utf8', env: {} });
  check('default invocation is executable dry-run with no DB access', () => { assert.strictEqual(dry.status, 0); assert.match(dry.stdout, /"mode": "dry-run"/); });
  console.log(`${passed} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
