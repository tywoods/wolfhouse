'use strict';

/**
 * Focused verifier — reconcile-rental-half-day-to-12-hours fail-closed contract.
 * Pure plan + injected fake-pg only. Never opens a real database.
 */

const assert = require('assert');
const {
  planHalfDayRewrite,
  planBatch,
  dryRunOrApply,
  selfCheck,
  CANONICAL_DURATION,
  LEGACY_DURATION,
} = require('./reconcile-rental-half-day-to-12-hours');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFakePg(seed = {}) {
  const state = {
    rows: deepClone(seed.rows || []),
    queries: [],
    begins: 0,
    commits: 0,
    rollbacks: 0,
    updates: 0,
    failOnUpdateIndex: seed.failOnUpdateIndex == null ? null : seed.failOnUpdateIndex,
    locked: false,
  };
  let snapshot = null;

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ text, params: params.slice() });

    if (/^BEGIN$/i.test(text)) {
      state.begins += 1;
      snapshot = deepClone(state.rows);
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(text)) {
      state.commits += 1;
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(text)) {
      state.rollbacks += 1;
      if (snapshot) {
        state.rows = snapshot;
        snapshot = null;
      }
      return { rows: [], rowCount: 0 };
    }

    if (/FROM tenant_price_rules/i.test(text) && /SELECT/i.test(text)) {
      if (/FOR UPDATE/i.test(text)) state.locked = true;
      return {
        rows: state.rows.map((r) => deepClone(r)),
        rowCount: state.rows.length,
      };
    }

    if (/UPDATE tenant_price_rules/i.test(text)) {
      state.updates += 1;
      if (state.failOnUpdateIndex != null && state.updates === state.failOnUpdateIndex) {
        throw new Error('forced_update_failure');
      }
      const to = params[0];
      const id = String(params[3]);
      const from = params[4];
      const row = state.rows.find((r) => String(r.id) === id);
      assert.ok(row, `row ${id} missing`);
      assert.strictEqual(row.item_code, from);
      assert.strictEqual(row.active, true);
      row.item_code = to;
      if (row.unit === LEGACY_DURATION || !row.unit) row.unit = 'session';
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unexpected SQL: ${text}`);
  }

  return {
    query,
    connect: async () => ({ query, release() {} }),
    _state: state,
  };
}

async function main() {
  selfCheck();

  // Pure plan: rewrite towel half_day → 12_hours.
  const plan = planHalfDayRewrite(
    {
      id: 'a',
      item_code: 'towel_rental__half_day',
      amount_cents: 500,
      active: true,
      unit: 'session',
    },
    new Set(),
  );
  assert.strictEqual(plan.action, 'rewrite');
  assert.strictEqual(plan.to, `towel_rental__${CANONICAL_DURATION}`);
  assert.strictEqual(plan.from, `towel_rental__${LEGACY_DURATION}`);

  // Collision refuse.
  const collide = planHalfDayRewrite(
    {
      id: 'a',
      item_code: 'towel_rental__half_day',
      amount_cents: 500,
      active: true,
    },
    new Set(['towel_rental__12_hours']),
  );
  assert.strictEqual(collide.action, 'collision');

  // Dry-run: no BEGIN/UPDATE.
  {
    const pg = makeFakePg({
      rows: [{
        id: '1',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_code: 'towel_rental__half_day',
        amount_cents: 500,
        active: true,
        unit: 'session',
      }],
    });
    const report = await dryRunOrApply(pg, { apply: false });
    assert.strictEqual(report.apply, false);
    assert.strictEqual(report.rewrite, 1);
    assert.strictEqual(report.updated, 0);
    assert.strictEqual(report.committed, false);
    assert.strictEqual(pg._state.begins, 0);
    assert.strictEqual(pg._state.updates, 0);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__half_day');
  }

  // Apply: rewrites item_code, preserves amount/active, commits.
  {
    const pg = makeFakePg({
      rows: [{
        id: '1',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_code: 'towel_rental__half_day',
        amount_cents: 500,
        active: true,
        unit: 'session',
        currency: 'EUR',
      }],
    });
    const report = await dryRunOrApply(pg, { apply: true });
    assert.strictEqual(report.committed, true);
    assert.strictEqual(report.updated, 1);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__12_hours');
    assert.strictEqual(pg._state.rows[0].amount_cents, 500);
    assert.strictEqual(pg._state.rows[0].active, true);
    assert.strictEqual(pg._state.commits, 1);
    assert.ok(pg._state.locked, 'must FOR UPDATE lock on apply');
  }

  // Collision on apply: zero updates + rollback.
  {
    const pg = makeFakePg({
      rows: [
        {
          id: '1',
          client_slug: 'sunset',
          location_id: 'sunset-somo',
          item_code: 'towel_rental__half_day',
          amount_cents: 500,
          active: true,
          unit: 'session',
        },
        {
          id: '2',
          client_slug: 'sunset',
          location_id: 'sunset-somo',
          item_code: 'towel_rental__12_hours',
          amount_cents: 600,
          active: true,
          unit: 'session',
        },
      ],
    });
    const report = await dryRunOrApply(pg, { apply: true });
    assert.strictEqual(report.blocked, true);
    assert.strictEqual(report.updated, 0);
    assert.strictEqual(report.rolled_back, true);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__half_day');
    assert.strictEqual(pg._state.commits, 0);
  }

  // Mid-update failure rolls back.
  {
    const pg = makeFakePg({
      rows: [
        {
          id: '1',
          client_slug: 'sunset',
          location_id: 'sunset-somo',
          item_code: 'towel_rental__half_day',
          amount_cents: 500,
          active: true,
          unit: 'session',
        },
        {
          id: '2',
          client_slug: 'sunset',
          location_id: 'sunset-somo',
          item_code: 'board_rental__half_day',
          amount_cents: 1000,
          active: true,
          unit: 'session',
        },
      ],
      failOnUpdateIndex: 1,
    });
    let threw = false;
    try {
      await dryRunOrApply(pg, { apply: true });
    } catch (err) {
      threw = /forced_update_failure/.test(String(err && err.message));
    }
    assert.ok(threw, 'must surface update failure');
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__half_day', 'rolled back first update');
    assert.strictEqual(pg._state.rows[1].item_code, 'board_rental__half_day');
    assert.ok(pg._state.rollbacks >= 1);
  }

  // Idempotent: already 12_hours only → no rewrite plans.
  {
    const batch = planBatch([{
      id: '1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_code: 'towel_rental__12_hours',
      amount_cents: 500,
      active: true,
    }]);
    assert.strictEqual(batch.rewrite, 0);
    assert.strictEqual(batch.plans.length, 0);
  }

  console.log('PASS verify-reconcile-rental-half-day-to-12-hours');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
