'use strict';

/**
 * Sunset Admin Accommodation settings + seasonal ranges.
 * Client+location scoped. Sunset only. Atomic replace on save.
 */

const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
} = require('./sunset-school-locations');
const {
  normalizeAccommodationRanges,
  STAFF_ACCOMMODATION_COMPONENT,
} = require('./sunset-accommodation-price-resolver');

const SUNSET_CLIENT_SLUG = 'sunset';

function defaultAccommodationApi(overrides) {
  return {
    enabled: false,
    currency: 'EUR',
    ranges: [],
    source: 'default',
    ...(overrides || {}),
  };
}

async function tableExists(client, tableName) {
  const r = await client.query(
    `SELECT to_regclass($1) AS t`,
    [`public.${tableName}`],
  );
  return !!(r.rows[0] && r.rows[0].t);
}

/**
 * Lazy DDL twin of migration 052 (lunabox may not apply migrations to staging).
 * Idempotent CREATE TABLE IF NOT EXISTS.
 */
async function ensureAccommodationTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_accommodation_settings (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug     TEXT NOT NULL,
      location_id     TEXT,
      enabled         BOOLEAN NOT NULL DEFAULT false,
      currency        CHAR(3) NOT NULL DEFAULT 'EUR',
      bed_capacity    INTEGER
                      CHECK (bed_capacity IS NULL OR (bed_capacity >= 1 AND bed_capacity <= 999)),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL
    )`);
  await client.query(`
    ALTER TABLE tenant_accommodation_settings
      ADD COLUMN IF NOT EXISTS bed_capacity INTEGER
      CHECK (bed_capacity IS NULL OR (bed_capacity >= 1 AND bed_capacity <= 999))`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_accommodation_settings_scope
      ON tenant_accommodation_settings (client_slug, COALESCE(location_id, ''))`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_settings_client
      ON tenant_accommodation_settings (client_slug)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_accommodation_season_ranges (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug     TEXT NOT NULL,
      location_id     TEXT,
      title           TEXT NOT NULL,
      check_in        DATE NOT NULL,
      check_out       DATE NOT NULL,
      amount_cents    INTEGER NOT NULL
                      CHECK (amount_cents > 0 AND amount_cents <= 100000000),
      currency        CHAR(3) NOT NULL DEFAULT 'EUR',
      active          BOOLEAN NOT NULL DEFAULT true,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
      CONSTRAINT tenant_accommodation_season_ranges_half_open
        CHECK (check_out > check_in)
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_ranges_client_active
      ON tenant_accommodation_season_ranges (client_slug, active)`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_ranges_client_loc
      ON tenant_accommodation_season_ranges (client_slug, location_id)
      WHERE active = true`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_accommodation_ranges_window
      ON tenant_accommodation_season_ranges (client_slug, check_in, check_out)
      WHERE active = true`);

  // Twin of migration 052 updated_at triggers. DROP IF EXISTS keeps lazy DDL
  // idempotent (CREATE TRIGGER is not IF NOT EXISTS on older Postgres).
  await client.query(`
    DROP TRIGGER IF EXISTS tenant_accommodation_settings_updated_at
      ON tenant_accommodation_settings`);
  await client.query(`
    CREATE TRIGGER tenant_accommodation_settings_updated_at
      BEFORE UPDATE ON tenant_accommodation_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
  await client.query(`
    DROP TRIGGER IF EXISTS tenant_accommodation_season_ranges_updated_at
      ON tenant_accommodation_season_ranges`);
  await client.query(`
    CREATE TRIGGER tenant_accommodation_season_ranges_updated_at
      BEFORE UPDATE ON tenant_accommodation_season_ranges
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
  return { ok: true };
}

function assertSunsetClient(clientSlug) {
  const slug = String(clientSlug || '').trim();
  if (slug !== SUNSET_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        error: 'unsupported_client',
        reason_code: 'unsupported_client',
        client_slug: slug,
      },
    };
  }
  return { ok: true, clientSlug: slug };
}

function mapRangeRow(row) {
  return {
    id: row.id ? String(row.id) : null,
    title: String(row.title || ''),
    check_in: row.check_in
      ? String(row.check_in).slice(0, 10)
      : (row.check_in_iso ? String(row.check_in_iso).slice(0, 10) : ''),
    check_out: row.check_out
      ? String(row.check_out).slice(0, 10)
      : (row.check_out_iso ? String(row.check_out_iso).slice(0, 10) : ''),
    amount_cents: Number(row.amount_cents) || 0,
    currency: String(row.currency || 'EUR').toUpperCase() || 'EUR',
    active: row.active !== false,
    sort_order: Number(row.sort_order) || 0,
  };
}

/**
 * Load accommodation config for Admin + booking create projection.
 * Fail-open to defaults when tables missing (feature simply disabled).
 */
async function loadAccommodationConfig(client, clientSlug, locationId) {
  const gate = assertSunsetClient(clientSlug);
  if (!gate.ok) {
    return defaultAccommodationApi({ source: 'unsupported_client' });
  }
  if (!isSunsetLocationId(locationId) && locationId != null && String(locationId).trim()) {
    // Unknown location → empty disabled (never cross-tenant leak).
    return defaultAccommodationApi({ source: 'invalid_location' });
  }
  const loc = normalizeSunsetLocationId(locationId);
  try {
    if (!(await tableExists(client, 'tenant_accommodation_settings'))) {
      return defaultAccommodationApi({ source: 'tables_missing' });
    }
  } catch (_) {
    return defaultAccommodationApi({ source: 'tables_missing' });
  }

  // MULTICLIENT_SCOPE_OK: client_slug + location_id predicates
  const settingsRes = await client.query(
    `SELECT id, enabled, currency, bed_capacity
       FROM tenant_accommodation_settings
      WHERE client_slug = $1
        AND location_id IS NOT DISTINCT FROM $2
      LIMIT 1`,
    [gate.clientSlug, loc],
  );
  const settings = settingsRes.rows[0] || null;

  let ranges = [];
  if (await tableExists(client, 'tenant_accommodation_season_ranges')) {
    const rangeRes = await client.query(
      `SELECT id, title, check_in::text AS check_in, check_out::text AS check_out,
              amount_cents, currency, active, sort_order
         FROM tenant_accommodation_season_ranges
        WHERE client_slug = $1
          AND location_id IS NOT DISTINCT FROM $2
          AND active = true
        ORDER BY check_in ASC, check_out ASC, sort_order ASC, title ASC`,
      [gate.clientSlug, loc],
    );
    ranges = rangeRes.rows.map(mapRangeRow);
  }

  return {
    enabled: settings ? settings.enabled !== false : false,
    currency: settings && settings.currency
      ? String(settings.currency).toUpperCase()
      : 'EUR',
    bed_capacity: settings && settings.bed_capacity != null && Number.isInteger(Number(settings.bed_capacity))
      && Number(settings.bed_capacity) > 0
      ? Number(settings.bed_capacity)
      : null,
    ranges,
    source: settings || ranges.length ? 'db' : 'default',
    settings_id: settings && settings.id ? String(settings.id) : null,
    location_id: loc,
    client_slug: gate.clientSlug,
    component: STAFF_ACCOMMODATION_COMPONENT,
  };
}

/**
 * Atomic Admin save: upsert settings + replace active ranges for scope.
 * Overlap/validation fail closed before any write.
 */
async function saveAccommodationConfig(client, {
  clientSlug, locationId, enabled, ranges, currency, bed_capacity, actor,
} = {}) {
  const gate = assertSunsetClient(clientSlug);
  if (!gate.ok) return gate;
  if (!isSunsetLocationId(locationId)) {
    return {
      ok: false,
      status: 400,
      body: { success: false, error: 'invalid_location', reason_code: 'invalid_location' },
    };
  }
  const loc = normalizeSunsetLocationId(locationId);
  const norm = normalizeAccommodationRanges(ranges);
  if (!norm.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: norm.error,
        reason_code: norm.reason_code || 'accommodation_ranges_invalid',
        overlap: norm.overlap || null,
      },
    };
  }
  const en = !(enabled === false || enabled === 'false' || enabled === 0);
  const cur = String(currency || 'EUR').trim().toUpperCase() || 'EUR';
  if (!/^[A-Z]{3}$/.test(cur)) {
    return {
      ok: false,
      status: 400,
      body: { success: false, error: 'currency must be ISO-4217', reason_code: 'accommodation_currency_invalid' },
    };
  }
  const actorId = actor && actor.staff_user_id ? actor.staff_user_id : null;
  let beds = null;
  if (bed_capacity != null && bed_capacity !== '') {
    const n = Number(bed_capacity);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          error: 'bed_capacity must be an integer 1..999 or null',
          reason_code: 'accommodation_bed_capacity_invalid',
        },
      };
    }
    beds = n;
  }

  await ensureAccommodationTables(client);

  // Always own the transaction: atomic settings + range replace, rollback on any failure.
  await client.query('BEGIN');
  try {
    // MULTICLIENT_SCOPE_OK: advisory lock keyed by client + location
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [gate.clientSlug, `accommodation:${loc || ''}`],
    );

    // Upsert settings
    const existing = await client.query(
      // MULTICLIENT_SCOPE_OK
      `SELECT id FROM tenant_accommodation_settings
        WHERE client_slug = $1 AND location_id IS NOT DISTINCT FROM $2
        LIMIT 1`,
      [gate.clientSlug, loc],
    );
    if (existing.rows[0]) {
      await client.query(
        // MULTICLIENT_SCOPE_OK
        `UPDATE tenant_accommodation_settings
            SET enabled = $1, currency = $2, bed_capacity = $3, updated_by = $4, updated_at = NOW()
          WHERE id = $5::uuid AND client_slug = $6`,
        [en, cur, beds, actorId, existing.rows[0].id, gate.clientSlug],
      );
    } else {
      await client.query(
        // MULTICLIENT_SCOPE_OK
        `INSERT INTO tenant_accommodation_settings
           (client_slug, location_id, enabled, currency, bed_capacity, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [gate.clientSlug, loc, en, cur, beds, actorId],
      );
    }

    // Replace ranges for this scope (hard delete inactive/stale; admin owns the list).
    await client.query(
      // MULTICLIENT_SCOPE_OK
      `DELETE FROM tenant_accommodation_season_ranges
        WHERE client_slug = $1 AND location_id IS NOT DISTINCT FROM $2`,
      [gate.clientSlug, loc],
    );

    const inserted = [];
    for (let i = 0; i < norm.value.length; i += 1) {
      const r = norm.value[i];
      const ins = await client.query(
        // MULTICLIENT_SCOPE_OK
        `INSERT INTO tenant_accommodation_season_ranges
           (client_slug, location_id, title, check_in, check_out, amount_cents, currency, active, sort_order, updated_by)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, true, $8, $9)
         RETURNING id, title, check_in::text AS check_in, check_out::text AS check_out,
                   amount_cents, currency, active, sort_order`,
        [
          gate.clientSlug, loc, r.title, r.check_in, r.check_out,
          r.amount_cents, r.currency || cur, i, actorId,
        ],
      );
      if (ins.rows[0]) inserted.push(mapRangeRow(ins.rows[0]));
    }

    await client.query('COMMIT');

    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        accommodation: {
          enabled: en,
          currency: cur,
          bed_capacity: beds,
          ranges: inserted,
          source: 'db',
          location_id: loc,
          client_slug: gate.clientSlug,
          component: STAFF_ACCOMMODATION_COMPONENT,
        },
      },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Resolve + price a booking stay from live admin ranges.
 * When requireEnabled and product disabled → 409 for NEW additions.
 * Historical edit can pass requireEnabled=false after confirming existing row.
 */
async function resolveAccommodationPrice(client, {
  clientSlug, locationId, checkIn, checkOut, requireEnabled = true,
} = {}) {
  const gate = assertSunsetClient(clientSlug);
  if (!gate.ok) {
    return {
      ok: false,
      status: 403,
      body: gate.body,
      reason_code: 'unsupported_client',
      error: 'unsupported_client',
    };
  }
  const cfg = await loadAccommodationConfig(client, gate.clientSlug, locationId);
  if (requireEnabled && !cfg.enabled) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'Accommodation is disabled for this school',
        reason_code: 'accommodation_disabled',
      },
      reason_code: 'accommodation_disabled',
      error: 'Accommodation is disabled for this school',
    };
  }
  if (!cfg.ranges.length) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        error: 'No accommodation seasonal prices configured',
        reason_code: 'accommodation_no_ranges',
      },
      reason_code: 'accommodation_no_ranges',
      error: 'No accommodation seasonal prices configured',
    };
  }
  const { priceAccommodationStay } = require('./sunset-accommodation-price-resolver');
  const priced = priceAccommodationStay({
    ranges: cfg.ranges,
    checkIn,
    checkOut,
    currency: cfg.currency,
  });
  if (!priced.ok) {
    return {
      ok: false,
      status: priced.reason_code === 'accommodation_uncovered_nights' ? 422 : 400,
      body: {
        success: false,
        error: priced.error,
        reason_code: priced.reason_code,
        uncovered_nights: priced.uncovered_nights || null,
        uncovered_span: priced.uncovered_span || null,
      },
      reason_code: priced.reason_code,
      error: priced.error,
      uncovered_nights: priced.uncovered_nights,
    };
  }
  return { ok: true, priced, config: cfg };
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  defaultAccommodationApi,
  ensureAccommodationTables,
  loadAccommodationConfig,
  saveAccommodationConfig,
  resolveAccommodationPrice,
  assertSunsetClient,
};
