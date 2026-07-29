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
 * Scope safety (mandatory for any DB access):
 *   Explicit --client <slug> --location <location_id> --offering <offering_key>
 *   Query/lock only that exact client_slug + non-null location_id + item codes
 *   <offering>__half_day and <offering>__12_hours. Parameterized equality only
 *   (no LIKE / wildcards). Every returned row is re-verified against scope;
 *   mismatch blocks and rolls back.
 *
 * Exact Sunset staging identity (when authorized later):
 *   --client sunset --location sunset-somo --offering towel_rental
 *
 * Preserves: amount_cents, active, currency, display_name, location, client.
 * Does NOT touch booking_service_records or any historical booking rows.
 *
 * Fail-closed:
 *   - Per (client_slug, location_id, offering base): if a 12_hours sibling
 *     already exists for the same identity scope → refuse that row (collision).
 *   - --apply uses one transaction: lock candidates, scan all, then either
 *     update all clean rewrites + COMMIT, or zero UPDATEs + ROLLBACK.
 *   - Missing any of client/location/offering refuses DB access (nonzero exit).
 *
 * DO NOT run against production without operator approval.
 * Intentionally inert unless invoked with --apply, full scope, and a DATABASE_URL.
 *
 * Usage (dry-run default; scope always required for DB access):
 *   node scripts/reconcile-rental-half-day-to-12-hours.js \
 *     --client sunset --location sunset-somo --offering towel_rental
 *   node scripts/reconcile-rental-half-day-to-12-hours.js \
 *     --client sunset --location sunset-somo --offering towel_rental --apply
 */

const LEGACY_DURATION = 'half_day';
const CANONICAL_DURATION = '12_hours';
const BILLING_UNIT = 'session';

const SCOPE_FLAGS = Object.freeze(['client', 'location', 'offering']);

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
 * Parse CLI flags. Scope flags require a following non-flag value.
 * @param {string[]} [argv]
 * @returns {{ apply: boolean, client: string|null, location: string|null, offering: string|null }}
 */
function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(2);
  const out = {
    apply: false,
    client: null,
    location: null,
    offering: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--apply') {
      out.apply = true;
      continue;
    }
    if (a === '--client' || a === '--location' || a === '--offering') {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val == null || String(val).startsWith('--')) {
        out[key] = '';
        continue;
      }
      out[key] = String(val);
      i += 1;
      continue;
    }
  }
  return out;
}

/**
 * Resolve mandatory identity scope for DB access.
 * @param {{ client?: string, location?: string, offering?: string, client_slug?: string, location_id?: string, offering_key?: string }} opts
 * @returns {{ client_slug: string, location_id: string, offering_key: string, half_day_code: string, twelve_hours_code: string }}
 */
function resolveScope(opts = {}) {
  const client_slug = String(opts.client_slug != null ? opts.client_slug : (opts.client || '')).trim();
  const location_id = String(opts.location_id != null ? opts.location_id : (opts.location || '')).trim();
  const offering_key = String(opts.offering_key != null ? opts.offering_key : (opts.offering || '')).trim();
  const missing = [];
  if (!client_slug) missing.push('client');
  if (!location_id) missing.push('location');
  if (!offering_key) missing.push('offering');
  if (missing.length) {
    const err = new Error(
      `Refusing DB access without explicit scope: missing --${missing.join(', --')} `
      + '(require --client <slug> --location <location_id> --offering <offering_key>)',
    );
    err.code = 'MISSING_SCOPE';
    err.missing = missing;
    throw err;
  }
  return {
    client_slug,
    location_id,
    offering_key,
    half_day_code: `${offering_key}__${LEGACY_DURATION}`,
    twelve_hours_code: `${offering_key}__${CANONICAL_DURATION}`,
  };
}

/**
 * True when a price-rule row is exactly inside the authorized scope.
 * location_id must be non-null and equal; item_code must be one of the two
 * exact offering duration codes.
 */
function rowMatchesScope(row, scope) {
  if (!row || !scope) return false;
  if (String(row.client_slug || '').trim() !== scope.client_slug) return false;
  if (row.location_id == null || String(row.location_id).trim() === '') return false;
  if (String(row.location_id).trim() !== scope.location_id) return false;
  const code = String(row.item_code || '').trim();
  if (code !== scope.half_day_code && code !== scope.twelve_hours_code) return false;
  return true;
}

/**
 * Verify every returned row matches scope. Throws on first mismatch.
 */
function assertRowsMatchScope(rows, scope) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!rowMatchesScope(row, scope)) {
      const err = new Error(
        `scope_mismatch: row id=${row && row.id} client_slug=${row && row.client_slug} `
        + `location_id=${row && row.location_id} item_code=${row && row.item_code} `
        + `outside authorized scope ${scope.client_slug}|${scope.location_id}|${scope.offering_key}`,
      );
      err.code = 'SCOPE_MISMATCH';
      err.row = row;
      err.scope = scope;
      throw err;
    }
  }
  return true;
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
 * Pure planner — no DB, no scope gate (testable in isolation).
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
 * Dry-run or apply under a mandatory identity scope.
 * When apply:
 *   BEGIN → SELECT … FOR UPDATE of exact scoped half_day + 12_hours rows →
 *   verify every row matches scope → plan → if blocked/mismatch ROLLBACK else
 *   UPDATE item_code (+ unit grain when unit was the duration key) → COMMIT.
 *
 * Never mutates booking tables.
 *
 * @param {object} pg  pg Pool/Client or { query, connect? }
 * @param {{ apply?: boolean, client?: string, location?: string, offering?: string,
 *           client_slug?: string, location_id?: string, offering_key?: string }} opts
 */
async function dryRunOrApply(pg, opts = {}) {
  const wantApply = !!(opts && opts.apply);
  const report = {
    apply: wantApply,
    scope: null,
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

  let scope;
  try {
    scope = resolveScope(opts || {});
  } catch (err) {
    if (err && err.code === 'MISSING_SCOPE') {
      report.blocked = true;
      report.errors.push(err.message);
      report.missing_scope = err.missing;
      return report;
    }
    throw err;
  }
  report.scope = {
    client_slug: scope.client_slug,
    location_id: scope.location_id,
    offering_key: scope.offering_key,
    half_day_code: scope.half_day_code,
    twelve_hours_code: scope.twelve_hours_code,
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
    // Exact scope only: client_slug + non-null location_id + two exact item_codes.
    // Parameterized equality — no LIKE / wildcards.
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
          AND client_slug = $1
          AND location_id = $2
          AND location_id IS NOT NULL
          AND item_code IN ($3, $4)
        ORDER BY client_slug, location_id, item_code, id${lockClause}`,
      [
        scope.client_slug,
        scope.location_id,
        scope.half_day_code,
        scope.twelve_hours_code,
      ],
    );
    const rows = res.rows || [];
    report.scanned = rows.length;

    // Fail-closed: every returned row must match authorized scope.
    try {
      assertRowsMatchScope(rows, scope);
    } catch (err) {
      if (err && err.code === 'SCOPE_MISMATCH') {
        report.blocked = true;
        report.errors.push(err.message);
        if (begun) {
          await client.query('ROLLBACK');
          begun = false;
          report.rolled_back = true;
        }
        return report;
      }
      throw err;
    }

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
        // Scope predicates on UPDATE keep the write fail-closed.
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
              AND active = true
              AND client_slug = $6
              AND location_id = $7`,
          [
            plan.to,
            BILLING_UNIT,
            LEGACY_DURATION,
            plan.row.id,
            plan.from,
            scope.client_slug,
            scope.location_id,
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

  // Scope resolve requires all three.
  let threw = false;
  try {
    resolveScope({ client: 'sunset', location: 'sunset-somo' });
  } catch (err) {
    threw = err && err.code === 'MISSING_SCOPE' && Array.isArray(err.missing) && err.missing.includes('offering');
  }
  if (!threw) throw new Error('resolveScope must refuse missing offering');

  const sunset = resolveScope({
    client: 'sunset',
    location: 'sunset-somo',
    offering: 'towel_rental',
  });
  if (sunset.half_day_code !== 'towel_rental__half_day'
    || sunset.twelve_hours_code !== 'towel_rental__12_hours') {
    throw new Error('Sunset towel codes must be exact');
  }
  if (!rowMatchesScope({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item_code: 'towel_rental__half_day',
  }, sunset)) {
    throw new Error('rowMatchesScope must accept exact Sunset towel half_day');
  }
  if (rowMatchesScope({
    client_slug: 'other',
    location_id: 'sunset-somo',
    item_code: 'towel_rental__half_day',
  }, sunset)) {
    throw new Error('rowMatchesScope must reject cross-tenant');
  }

  console.log('reconcile-rental-half-day-to-12-hours self-check OK (no DB mutation)');
}

/**
 * CLI entry. Pure self-check when no DATABASE_URL.
 * Any DB path (dry or apply) requires explicit scope; --apply also refuses
 * missing DATABASE_URL. Missing scope → nonzero exit.
 */
function main(argv = process.argv.slice(2)) {
  const flags = parseCliArgs(argv);
  const hasDb = !!(process.env.DATABASE_URL || process.env.WOLFHOUSE_DATABASE_URL);

  if (!hasDb) {
    selfCheck();
    if (flags.apply) {
      // Apply always needs DB + full scope.
      try {
        resolveScope(flags);
      } catch (err) {
        if (err && err.code === 'MISSING_SCOPE') {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }
      console.error('Refusing --apply without DATABASE_URL');
      process.exit(2);
    }
    // Dry-run with no DB: optional scope check only if any scope flag present.
    const anyScope = flags.client != null || flags.location != null || flags.offering != null;
    if (anyScope) {
      try {
        resolveScope(flags);
      } catch (err) {
        if (err && err.code === 'MISSING_SCOPE') {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }
    }
    process.exit(0);
  }

  // DB access path: scope is mandatory for dry and apply.
  let scope;
  try {
    scope = resolveScope(flags);
  } catch (err) {
    if (err && err.code === 'MISSING_SCOPE') {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  // Lazy require so pure self-check never loads pg.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const url = process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url });
  return dryRunOrApply(pool, {
    apply: flags.apply,
    client: scope.client_slug,
    location: scope.location_id,
    offering: scope.offering_key,
  })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.blocked || (report.missing_scope && report.missing_scope.length)) {
        console.error('Reconciliation blocked: scope/collisions/errors; zero updates applied');
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

if (require.main === module) {
  main();
}

module.exports = {
  LEGACY_DURATION,
  CANONICAL_DURATION,
  SCOPE_FLAGS,
  splitItemCode,
  targetItemCode,
  parseCliArgs,
  resolveScope,
  rowMatchesScope,
  assertRowsMatchScope,
  planHalfDayRewrite,
  planBatch,
  dryRunOrApply,
  selfCheck,
  main,
};
