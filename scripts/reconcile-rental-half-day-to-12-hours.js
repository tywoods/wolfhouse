'use strict';

/**
 * Safe reconciliation — active rental price identities half_day → 12_hours.
 *
 * Live proof: Admin numeric "12 Hours" used to serialize as legacy half_day via
 * rentalDurationKeyFromUnitCount. New writers emit 12_hours. This script rewrites
 * active tenant_price_rules price *identities* (item_code tail) so existing
 * catalog rows match the canonical write form:
 *
 *   towel_rental__half_day  →  towel_rental__12_hours
 *
 * Preserves: amount_cents, active, currency, display_name, location, client.
 * Does NOT touch booking_service_records or any historical booking rows.
 *
 * Fail-closed:
 *   - Per (client_slug, location_id, offering base): if a 12_hours sibling
 *     already exists for the same identity scope → refuse that row (collision).
 *   - --apply uses one transaction: lock candidates, scan all, then either
 *     update all clean rewrites + COMMIT, or zero UPDATEs + ROLLBACK.
 *
 * DO NOT run against production without operator approval.
 * Intentionally inert unless invoked with --apply and a DATABASE_URL.
 *
 * Usage (dry-run default):
 *   node scripts/reconcile-rental-half-day-to-12-hours.js
 *   node scripts/reconcile-rental-half-day-to-12-hours.js --apply
 */

const LEGACY_DURATION = 'half_day';
const CANONICAL_DURATION = '12_hours';
const BILLING_UNIT = 'session';

function splitItemCode(itemCode) {
  const raw = String(itemCode || '').trim();
  if (!raw) return null;
  const parts = raw.split('__');
  if (parts.length < 2) return null;
  return {
    offering_key: parts[0],
    duration_key: parts.slice(1).join('__'),
    item_code: raw,
  };
}

function targetItemCode(offeringKey) {
  return `${String(offeringKey || '').trim()}__${CANONICAL_DURATION}`;
}

/**
 * Pure plan for one half_day price row given the set of sibling item_codes
 * already present for the same tenant/location.
 *
 * @param {{ id, client_slug, location_id, item_code, amount_cents, active, unit, currency }} row
 * @param {Set<string>} siblingItemCodes  item_codes at same client+location
 * @returns {{ action: 'rewrite'|'skip'|'collision'|'invalid', reason?: string, from?: string, to?: string, row?: object }}
 */
function planHalfDayRewrite(row, siblingItemCodes) {
  if (!row || typeof row !== 'object') {
    return { action: 'invalid', reason: 'invalid_row' };
  }
  if (row.active === false) {
    return { action: 'skip', reason: 'inactive', row };
  }
  const parsed = splitItemCode(row.item_code);
  if (!parsed || parsed.duration_key !== LEGACY_DURATION) {
    return { action: 'skip', reason: 'not_half_day_item_code', row };
  }
  const to = targetItemCode(parsed.offering_key);
  if (!to || to === parsed.item_code) {
    return { action: 'invalid', reason: 'bad_target', row };
  }
  const siblings = siblingItemCodes || new Set();
  if (siblings.has(to)) {
    return {
      action: 'collision',
      reason: '12_hours_already_exists',
      from: parsed.item_code,
      to,
      row,
    };
  }
  return {
    action: 'rewrite',
    from: parsed.item_code,
    to,
    offering_key: parsed.offering_key,
    amount_cents: row.amount_cents,
    active: row.active !== false,
    unit: BILLING_UNIT,
    row,
  };
}

/**
 * Group rows by client|location and plan rewrites. Collision if ANY other row
 * (active or inactive) already holds the target item_code in that scope.
 */
function planBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byScope = new Map();
  for (const row of list) {
    const client = String((row && row.client_slug) || '').trim();
    const loc = row && row.location_id != null ? String(row.location_id).trim() : '';
    const scope = `${client}|${loc}`;
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(row);
  }

  const plans = [];
  let rewrite = 0;
  let skip = 0;
  let collision = 0;
  let invalid = 0;

  for (const [, scopeRows] of byScope) {
    const siblingCodes = new Set(
      scopeRows.map((r) => String((r && r.item_code) || '').trim()).filter(Boolean),
    );
    for (const row of scopeRows) {
      const parsed = splitItemCode(row && row.item_code);
      // Only plan active half_day identities.
      if (!parsed || parsed.duration_key !== LEGACY_DURATION) continue;
      const plan = planHalfDayRewrite(row, siblingCodes);
      plans.push(plan);
      if (plan.action === 'rewrite') rewrite += 1;
      else if (plan.action === 'collision') collision += 1;
      else if (plan.action === 'invalid') invalid += 1;
      else skip += 1;
    }
  }

  return {
    plans,
    rewrite,
    skip,
    collision,
    invalid,
    blocked: collision > 0 || invalid > 0,
  };
}

/**
 * Dry-run or apply. When apply:
 *   BEGIN → SELECT … FOR UPDATE of candidate half_day rental rows + any
 *   same-scope 12_hours siblings → plan → if blocked ROLLBACK else UPDATE
 *   item_code (+ unit grain when unit was the duration key) → COMMIT.
 *
 * Never mutates booking tables.
 */
async function dryRunOrApply(pg, { apply } = {}) {
  const wantApply = !!apply;
  const report = {
    apply: wantApply,
    scanned: 0,
    rewrite: 0,
    skip: 0,
    collision: 0,
    invalid: 0,
    updated: 0,
    blocked: false,
    committed: false,
    rolled_back: false,
    plans: [],
    errors: [],
  };

  let client = pg;
  let release = null;
  if (pg && typeof pg.connect === 'function') {
    client = await pg.connect();
    release = typeof client.release === 'function' ? () => client.release() : null;
  }

  let begun = false;
  try {
    if (wantApply) {
      await client.query('BEGIN');
      begun = true;
    }

    const lockClause = wantApply ? ' FOR UPDATE' : '';
    // Lock half_day candidates and any same-tenant rental rows that could collide
    // (item_code ends with __12_hours) so the collision check is race-safe.
    const res = await client.query(
      `SELECT id::text AS id,
              client_slug,
              location_id,
              item_code,
              amount_cents,
              active,
              unit,
              currency,
              display_name
         FROM tenant_price_rules
        WHERE item_type = 'rental'
          AND (
            item_code LIKE '%__${LEGACY_DURATION}'
            OR item_code LIKE '%__${CANONICAL_DURATION}'
          )
        ORDER BY client_slug, location_id NULLS FIRST, item_code, id${lockClause}`,
    );
    const rows = res.rows || [];
    report.scanned = rows.length;

    const batch = planBatch(rows);
    report.plans = batch.plans.map((p) => ({
      action: p.action,
      reason: p.reason || null,
      from: p.from || (p.row && p.row.item_code) || null,
      to: p.to || null,
      id: p.row && p.row.id != null ? String(p.row.id) : null,
      client_slug: p.row && p.row.client_slug,
      location_id: p.row && p.row.location_id,
      amount_cents: p.row && p.row.amount_cents,
      active: p.row && p.row.active,
    }));
    report.rewrite = batch.rewrite;
    report.skip = batch.skip;
    report.collision = batch.collision;
    report.invalid = batch.invalid;

    if (batch.blocked) {
      report.blocked = true;
      report.errors.push(
        batch.collision
          ? 'collision: one or more offerings already have a 12_hours price identity'
          : 'invalid half_day rows present',
      );
      if (begun) {
        await client.query('ROLLBACK');
        begun = false;
        report.rolled_back = true;
      }
      return report;
    }

    if (wantApply) {
      for (const plan of batch.plans) {
        if (plan.action !== 'rewrite') continue;
        // Rewrite item_code only. Preserve amount/active/currency. Coerce unit
        // to billing grain when it still holds the duration key (legacy footgun).
        await client.query(
          `UPDATE tenant_price_rules
              SET item_code = $1,
                  unit = CASE
                    WHEN unit = $3 OR unit IS NULL OR btrim(unit) = '' THEN $2
                    WHEN unit IN ('session', 'day', 'person', 'item') THEN unit
                    ELSE $2
                  END,
                  updated_at = NOW()
            WHERE id = $4::uuid
              AND item_type = 'rental'
              AND item_code = $5
              AND active = true`,
          [
            plan.to,
            BILLING_UNIT,
            LEGACY_DURATION,
            plan.row.id,
            plan.from,
          ],
        );
        report.updated += 1;
      }
      await client.query('COMMIT');
      begun = false;
      report.committed = true;
    }

    return report;
  } catch (err) {
    if (begun) {
      try {
        await client.query('ROLLBACK');
        report.rolled_back = true;
      } catch (_) { /* ignore */ }
      begun = false;
    }
    throw err;
  } finally {
    if (release) {
      try { release(); } catch (_) { /* ignore */ }
    }
  }
}

function selfCheck() {
  // Clean rewrite plan.
  const clean = planBatch([
    {
      id: '1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_code: 'towel_rental__half_day',
      amount_cents: 500,
      active: true,
      unit: 'session',
    },
  ]);
  if (clean.blocked || clean.rewrite !== 1) {
    throw new Error('expected single clean rewrite');
  }
  if (clean.plans[0].to !== 'towel_rental__12_hours') {
    throw new Error('target must be towel_rental__12_hours');
  }
  if (clean.plans[0].amount_cents !== 500) {
    throw new Error('must preserve amount_cents on plan');
  }

  // Collision when 12_hours already exists (active or inactive).
  const collision = planBatch([
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
      active: false,
      unit: 'session',
    },
  ]);
  if (!collision.blocked || collision.collision !== 1) {
    throw new Error('expected collision block when 12_hours exists');
  }

  // Inactive half_day not rewritten.
  const inactive = planBatch([
    {
      id: '1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_code: 'towel_rental__half_day',
      amount_cents: 500,
      active: false,
      unit: 'session',
    },
  ]);
  if (inactive.rewrite !== 0 || inactive.plans[0].action !== 'skip') {
    throw new Error('inactive half_day must skip');
  }

  // Location isolation: same offering, different location, no collision.
  const multiLoc = planBatch([
    {
      id: '1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_code: 'board_rental__half_day',
      amount_cents: 1000,
      active: true,
    },
    {
      id: '2',
      client_slug: 'sunset',
      location_id: 'sunset-liencres',
      item_code: 'board_rental__12_hours',
      amount_cents: 1200,
      active: true,
    },
  ]);
  if (multiLoc.blocked || multiLoc.rewrite !== 1) {
    throw new Error('cross-location 12_hours must not collide');
  }

  // planHalfDayRewrite unit tests.
  const p = planHalfDayRewrite(
    {
      id: 'x',
      item_code: 'kayak_rental__half_day',
      active: true,
      amount_cents: 2000,
    },
    new Set(),
  );
  if (p.action !== 'rewrite' || p.to !== 'kayak_rental__12_hours') {
    throw new Error('planHalfDayRewrite clean failed');
  }

  console.log('reconcile-rental-half-day-to-12-hours self-check OK (no DB mutation)');
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL && !process.env.WOLFHOUSE_DATABASE_URL) {
    selfCheck();
    if (apply) {
      console.error('Refusing --apply without DATABASE_URL');
      process.exit(2);
    }
    process.exit(0);
  }
  // Lazy require so pure self-check never loads pg.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const url = process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url });
  dryRunOrApply(pool, { apply })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.blocked) {
        console.error('Reconciliation blocked: collisions/errors; zero updates applied');
        return pool.end().then(() => process.exit(1));
      }
      return pool.end();
    })
    .catch(async (err) => {
      console.error(err);
      try { await pool.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}

module.exports = {
  LEGACY_DURATION,
  CANONICAL_DURATION,
  splitItemCode,
  targetItemCode,
  planHalfDayRewrite,
  planBatch,
  dryRunOrApply,
  selfCheck,
};
