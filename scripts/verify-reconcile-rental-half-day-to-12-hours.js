'use strict';

/**
 * Focused verifier — reconcile-rental-half-day-to-12-hours fail-closed contract.
 * Pure plan + injected fake-pg only. Never opens a real database.
 *
 * Covers:
 *   - missing scope refusal (function + CLI --apply)
 *   - cross-tenant / cross-location / cross-offering exclusion
 *   - scope mismatch rollback
 *   - exact clean rewrite
 *   - collision fail-closed
 *   - parameterized SQL (no LIKE)
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const {
  planHalfDayRewrite,
  planBatch,
  dryRunOrApply,
  selfCheck,
  parseCliArgs,
  resolveScope,
  rowMatchesScope,
  assertRowsMatchScope,
  CANONICAL_DURATION,
  LEGACY_DURATION,
} = require('./reconcile-rental-half-day-to-12-hours');

const SCRIPT = path.join(__dirname, 'reconcile-rental-half-day-to-12-hours.js');

const SUNSET_SCOPE = Object.freeze({
  client: 'sunset',
  location: 'sunset-somo',
  offering: 'towel_rental',
});

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
    /** When true, SELECT ignores params and returns all rows (mismatch probe). */
    ignoreSelectParams: !!seed.ignoreSelectParams,
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
      // Refuse LIKE / wildcards in production SQL path.
      assert.ok(!/\bLIKE\b/i.test(text), 'SELECT must not use LIKE');
      assert.ok(!/%/.test(text), 'SELECT must not embed % wildcards');
      let rows = state.rows;
      if (!state.ignoreSelectParams && params.length >= 4) {
        const [client, loc, half, twelve] = params;
        rows = state.rows.filter((r) => (
          String(r.client_slug) === String(client)
          && r.location_id != null
          && String(r.location_id) === String(loc)
          && (String(r.item_code) === String(half) || String(r.item_code) === String(twelve))
        ));
      }
      return {
        rows: rows.map((r) => deepClone(r)),
        rowCount: rows.length,
      };
    }

    if (/UPDATE tenant_price_rules/i.test(text)) {
      state.updates += 1;
      if (state.failOnUpdateIndex != null && state.updates === state.failOnUpdateIndex) {
        throw new Error('forced_update_failure');
      }
      // Expected: $1=to, $2=billing unit, $3=legacy, $4=id, $5=from, $6=client, $7=location
      const to = params[0];
      const id = String(params[3]);
      const from = params[4];
      const clientSlug = params[5];
      const locationId = params[6];
      const row = state.rows.find((r) => String(r.id) === id);
      assert.ok(row, `row ${id} missing`);
      assert.strictEqual(row.item_code, from);
      assert.strictEqual(row.active, true);
      if (clientSlug != null) assert.strictEqual(row.client_slug, clientSlug);
      if (locationId != null) assert.strictEqual(String(row.location_id), String(locationId));
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

function towelHalfDay(overrides = {}) {
  return {
    id: '1',
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item_code: 'towel_rental__half_day',
    amount_cents: 500,
    active: true,
    unit: 'session',
    ...overrides,
  };
}

async function main() {
  selfCheck();

  // ── Pure plan: rewrite towel half_day → 12_hours ──────────────────────
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

  // Collision refuse (pure).
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

  // ── Missing scope refusal ─────────────────────────────────────────────
  {
    const missingAll = await dryRunOrApply({ query: async () => { throw new Error('no query'); } }, { apply: true });
    assert.strictEqual(missingAll.blocked, true);
    assert.ok(Array.isArray(missingAll.missing_scope));
    assert.ok(missingAll.missing_scope.includes('client'));
    assert.ok(missingAll.missing_scope.includes('location'));
    assert.ok(missingAll.missing_scope.includes('offering'));
    assert.strictEqual(missingAll.updated, 0);
    assert.strictEqual(missingAll.committed, false);
  }
  {
    const partial = await dryRunOrApply(
      { query: async () => { throw new Error('no query'); } },
      { apply: true, client: 'sunset', location: 'sunset-somo' },
    );
    assert.strictEqual(partial.blocked, true);
    assert.deepStrictEqual(partial.missing_scope, ['offering']);
  }
  {
    const dryMissing = await dryRunOrApply(
      { query: async () => { throw new Error('no query'); } },
      { apply: false, client: 'sunset' },
    );
    assert.strictEqual(dryMissing.blocked, true);
    assert.ok(dryMissing.missing_scope.includes('location'));
    assert.ok(dryMissing.missing_scope.includes('offering'));
  }
  // resolveScope throws MISSING_SCOPE
  {
    let err = null;
    try { resolveScope({ client: 'sunset' }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'MISSING_SCOPE');
    assert.ok(err.missing.includes('location'));
    assert.ok(err.missing.includes('offering'));
  }
  // CLI --apply without scope → nonzero exit
  {
    const res = spawnSync(process.execPath, [SCRIPT, '--apply'], {
      env: { ...process.env, DATABASE_URL: '', WOLFHOUSE_DATABASE_URL: '' },
      encoding: 'utf8',
    });
    assert.notStrictEqual(res.status, 0, 'CLI --apply without scope must exit nonzero');
    assert.ok(
      /missing|--client|scope|DATABASE_URL/i.test(`${res.stderr}\n${res.stdout}`),
      'CLI must mention scope or DATABASE_URL refusal',
    );
  }
  // CLI --apply with partial scope → nonzero exit
  {
    const res = spawnSync(process.execPath, [
      SCRIPT, '--apply', '--client', 'sunset', '--location', 'sunset-somo',
    ], {
      env: { ...process.env, DATABASE_URL: '', WOLFHOUSE_DATABASE_URL: '' },
      encoding: 'utf8',
    });
    assert.notStrictEqual(res.status, 0);
    assert.ok(/offering|scope/i.test(`${res.stderr}\n${res.stdout}`));
  }
  // parseCliArgs
  {
    const flags = parseCliArgs([
      '--client', 'sunset',
      '--location', 'sunset-somo',
      '--offering', 'towel_rental',
      '--apply',
    ]);
    assert.strictEqual(flags.client, 'sunset');
    assert.strictEqual(flags.location, 'sunset-somo');
    assert.strictEqual(flags.offering, 'towel_rental');
    assert.strictEqual(flags.apply, true);
  }

  // ── Cross-tenant / location / offering exclusion ──────────────────────
  {
    const pg = makeFakePg({
      rows: [
        towelHalfDay({ id: '1' }),
        towelHalfDay({
          id: '2',
          client_slug: 'other-tenant',
          item_code: 'towel_rental__half_day',
        }),
        towelHalfDay({
          id: '3',
          location_id: 'sunset-liencres',
          item_code: 'towel_rental__half_day',
        }),
        towelHalfDay({
          id: '4',
          item_code: 'board_rental__half_day',
          amount_cents: 1000,
        }),
        towelHalfDay({
          id: '5',
          item_code: 'board_rental__12_hours',
          amount_cents: 1200,
        }),
      ],
    });
    const report = await dryRunOrApply(pg, { apply: true, ...SUNSET_SCOPE });
    assert.strictEqual(report.scanned, 1, 'only exact sunset towel identities');
    assert.strictEqual(report.rewrite, 1);
    assert.strictEqual(report.updated, 1);
    assert.strictEqual(report.committed, true);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__12_hours');
    // Cross-scope rows untouched.
    assert.strictEqual(pg._state.rows[1].item_code, 'towel_rental__half_day');
    assert.strictEqual(pg._state.rows[1].client_slug, 'other-tenant');
    assert.strictEqual(pg._state.rows[2].item_code, 'towel_rental__half_day');
    assert.strictEqual(pg._state.rows[2].location_id, 'sunset-liencres');
    assert.strictEqual(pg._state.rows[3].item_code, 'board_rental__half_day');
    // SELECT params are exact scope values.
    const select = pg._state.queries.find((q) => /SELECT/i.test(q.text) && /tenant_price_rules/i.test(q.text));
    assert.ok(select);
    assert.deepStrictEqual(select.params, [
      'sunset',
      'sunset-somo',
      'towel_rental__half_day',
      'towel_rental__12_hours',
    ]);
    assert.ok(!/\bLIKE\b/i.test(select.text));
  }

  // ── Scope mismatch → block + rollback ─────────────────────────────────
  {
    const pg = makeFakePg({
      rows: [
        towelHalfDay({ id: '1' }),
        towelHalfDay({
          id: 'evil',
          client_slug: 'evil-tenant',
          item_code: 'towel_rental__half_day',
        }),
      ],
      ignoreSelectParams: true, // simulate driver returning out-of-scope rows
    });
    const report = await dryRunOrApply(pg, { apply: true, ...SUNSET_SCOPE });
    assert.strictEqual(report.blocked, true);
    assert.ok(report.errors.some((e) => /scope_mismatch/i.test(e)));
    assert.strictEqual(report.updated, 0);
    assert.strictEqual(report.committed, false);
    assert.strictEqual(report.rolled_back, true);
    assert.strictEqual(pg._state.commits, 0);
    assert.ok(pg._state.rollbacks >= 1);
    // No mutation.
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__half_day');
    assert.strictEqual(pg._state.rows[1].item_code, 'towel_rental__half_day');
  }
  // assertRowsMatchScope helper
  {
    const scope = resolveScope(SUNSET_SCOPE);
    assert.strictEqual(rowMatchesScope(towelHalfDay(), scope), true);
    assert.strictEqual(rowMatchesScope(towelHalfDay({ client_slug: 'x' }), scope), false);
    assert.strictEqual(rowMatchesScope(towelHalfDay({ location_id: null }), scope), false);
    assert.strictEqual(rowMatchesScope(towelHalfDay({ item_code: 'board_rental__half_day' }), scope), false);
    let threw = false;
    try {
      assertRowsMatchScope([towelHalfDay({ client_slug: 'nope' })], scope);
    } catch (err) {
      threw = err && err.code === 'SCOPE_MISMATCH';
    }
    assert.ok(threw);
  }

  // ── Dry-run: no BEGIN/UPDATE, scoped ───────────────────────────────
  {
    const pg = makeFakePg({ rows: [towelHalfDay()] });
    const report = await dryRunOrApply(pg, { apply: false, ...SUNSET_SCOPE });
    assert.strictEqual(report.apply, false);
    assert.strictEqual(report.rewrite, 1);
    assert.strictEqual(report.updated, 0);
    assert.strictEqual(report.committed, false);
    assert.strictEqual(pg._state.begins, 0);
    assert.strictEqual(pg._state.updates, 0);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__half_day');
    assert.deepStrictEqual(report.scope, {
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      offering_key: 'towel_rental',
      half_day_code: 'towel_rental__half_day',
      twelve_hours_code: 'towel_rental__12_hours',
    });
  }

  // ── Apply: exact clean rewrite ────────────────────────────────────────
  {
    const pg = makeFakePg({
      rows: [towelHalfDay({
        currency: 'EUR',
      })],
    });
    const report = await dryRunOrApply(pg, { apply: true, ...SUNSET_SCOPE });
    assert.strictEqual(report.committed, true);
    assert.strictEqual(report.updated, 1);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__12_hours');
    assert.strictEqual(pg._state.rows[0].amount_cents, 500);
    assert.strictEqual(pg._state.rows[0].active, true);
    assert.strictEqual(pg._state.commits, 1);
    assert.ok(pg._state.locked, 'must FOR UPDATE lock on apply');
    // UPDATE carries scope predicates.
    const upd = pg._state.queries.find((q) => /UPDATE tenant_price_rules/i.test(q.text));
    assert.ok(upd);
    assert.strictEqual(upd.params[5], 'sunset');
    assert.strictEqual(upd.params[6], 'sunset-somo');
    assert.ok(/client_slug\s*=\s*\$6/i.test(upd.text));
    assert.ok(/location_id\s*=\s*\$7/i.test(upd.text));
  }

  // ── Collision on apply: zero updates + rollback ───────────────────────
  {
    const pg = makeFakePg({
      rows: [
        towelHalfDay({ id: '1' }),
        towelHalfDay({
          id: '2',
          item_code: 'towel_rental__12_hours',
          amount_cents: 600,
        }),
      ],
    });
    const report = await dryRunOrApply(pg, { apply: true, ...SUNSET_SCOPE });
    assert.strictEqual(report.blocked, true);
    assert.strictEqual(report.collision, 1);
    assert.strictEqual(report.updated, 0);
    assert.strictEqual(report.rolled_back, true);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__half_day');
    assert.strictEqual(pg._state.commits, 0);
  }

  // ── Mid-update failure rolls back ─────────────────────────────────────
  {
    const pg = makeFakePg({
      rows: [towelHalfDay({ id: '1' })],
      failOnUpdateIndex: 1,
    });
    let threw = false;
    try {
      await dryRunOrApply(pg, { apply: true, ...SUNSET_SCOPE });
    } catch (err) {
      threw = /forced_update_failure/.test(String(err && err.message));
    }
    assert.ok(threw, 'must surface update failure');
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__half_day', 'rolled back');
    assert.ok(pg._state.rollbacks >= 1);
  }

  // ── Idempotent: already 12_hours only → no rewrite plans ──────────────
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
  {
    const pg = makeFakePg({
      rows: [towelHalfDay({
        id: '1',
        item_code: 'towel_rental__12_hours',
      })],
    });
    const report = await dryRunOrApply(pg, { apply: true, ...SUNSET_SCOPE });
    assert.strictEqual(report.rewrite, 0);
    assert.strictEqual(report.updated, 0);
    assert.strictEqual(report.committed, true);
    assert.strictEqual(pg._state.rows[0].item_code, 'towel_rental__12_hours');
  }

  // ── No booking-table mutation SQL ─────────────────────────────────────
  {
    const src = require('fs').readFileSync(SCRIPT, 'utf8');
    assert.ok(!/FROM\s+booking_service_records/i.test(src));
    assert.ok(!/UPDATE\s+booking_service_records/i.test(src));
    assert.ok(!/FROM\s+bookings\b/i.test(src));
    assert.ok(!/UPDATE\s+bookings\b/i.test(src));
    assert.ok(!/INSERT\s+INTO\s+bookings\b/i.test(src));
    assert.ok(/UPDATE tenant_price_rules/.test(src), 'must UPDATE tenant_price_rules');
    // SQL mutation surface is only tenant_price_rules (backtick template).
    const sqlUpdates = src.match(/`UPDATE\s+\w+/g) || [];
    assert.ok(sqlUpdates.length >= 1);
    for (const u of sqlUpdates) {
      assert.ok(/`UPDATE\s+tenant_price_rules/.test(u), `unexpected SQL UPDATE: ${u}`);
    }
  }

  console.log('PASS verify-reconcile-rental-half-day-to-12-hours');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
