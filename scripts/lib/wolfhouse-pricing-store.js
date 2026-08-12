'use strict';

/**
 * Wolfhouse Admin Pricing — Postgres access layer.
 *
 * Runtime twin of database/migrations/076_wolfhouse_pricing_admin.sql:
 * ensureWolfhousePricingTables() creates the same shapes at runtime because
 * Lunabox cannot always run migrations against staging Postgres.
 *
 * Every statement is scoped by client_slug, and assertWolfhouseScope() refuses
 * any slug but Wolfhouse. That mirrors the tenant_scope_violation guard Sunset
 * uses on its own tables, pointing the other way, so neither tenant's admin can
 * read or write the other's prices even if a caller passes the wrong slug.
 *
 * @module wolfhouse-pricing-store
 */

const { WH_PRICING_CLIENT_SLUG } = require('./wolfhouse-pricing-resolve');

function assertWolfhouseScope(clientSlug) {
  if (String(clientSlug || '').trim() !== WH_PRICING_CLIENT_SLUG) {
    throw new Error('tenant_scope_violation');
  }
  return WH_PRICING_CLIENT_SLUG;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS wh_pricing_seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  bookable BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_seasons_code
  ON wh_pricing_seasons (client_slug, code) WHERE active = true;

CREATE TABLE IF NOT EXISTS wh_pricing_season_ranges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES wh_pricing_seasons(id) ON DELETE CASCADE,
  client_slug TEXT NOT NULL,
  start_month SMALLINT NOT NULL,
  start_day SMALLINT NOT NULL,
  end_month SMALLINT NOT NULL,
  end_day SMALLINT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wh_pricing_season_ranges_season
  ON wh_pricing_season_ranges (season_id);

CREATE TABLE IF NOT EXISTS wh_pricing_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_items_code
  ON wh_pricing_items (client_slug, item_type, item_code) WHERE active = true;

CREATE TABLE IF NOT EXISTS wh_pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_code TEXT NOT NULL,
  season_code TEXT,
  unit TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_rules_scope
  ON wh_pricing_rules (client_slug, item_type, item_code, COALESCE(season_code, ''))
  WHERE active = true;

CREATE TABLE IF NOT EXISTS wh_pricing_transfer_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug TEXT NOT NULL,
  airport_code TEXT NOT NULL,
  label TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  requires_package BOOLEAN NOT NULL DEFAULT false,
  included_when_package BOOLEAN NOT NULL DEFAULT false,
  min_guest_count INTEGER,
  unavailable_no_package_message TEXT,
  unavailable_below_min_group_message TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_pricing_transfer_rules_airport
  ON wh_pricing_transfer_rules (client_slug, airport_code) WHERE active = true;
`;

async function ensureWolfhousePricingTables(pg) {
  await pg.query(CREATE_SQL);
}

async function tablesExist(pg) {
  const r = await pg.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('wh_pricing_seasons','wh_pricing_rules',
                           'wh_pricing_items','wh_pricing_transfer_rules')`,
  );
  return r.rows[0].n === 4;
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function loadSeasons(pg, clientSlug) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `SELECT s.id, s.code, s.label, s.priority, s.bookable, s.active, s.sort_order,
            COALESCE(
              json_agg(
                json_build_object(
                  'start_month', rg.start_month, 'start_day', rg.start_day,
                  'end_month', rg.end_month, 'end_day', rg.end_day
                ) ORDER BY rg.sort_order, rg.start_month, rg.start_day
              ) FILTER (WHERE rg.id IS NOT NULL), '[]'
            ) AS ranges
       FROM wh_pricing_seasons s
       LEFT JOIN wh_pricing_season_ranges rg ON rg.season_id = s.id
      WHERE s.client_slug = $1 AND s.active = true
      GROUP BY s.id
      ORDER BY s.priority DESC, s.sort_order, s.code`,
    [slug],
  );
  return r.rows.map((row) => Object.assign({}, row, { source: 'db' }));
}

async function loadRules(pg, clientSlug) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `SELECT id, item_type, item_code, season_code, unit, amount_cents, currency, active
       FROM wh_pricing_rules
      WHERE client_slug = $1 AND active = true
      ORDER BY item_type, item_code, season_code NULLS FIRST`,
    [slug],
  );
  return r.rows.map((row) => Object.assign({}, row, { source: 'db' }));
}

async function loadItems(pg, clientSlug) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `SELECT id, item_type, item_code, label, description, metadata, active, sort_order
       FROM wh_pricing_items
      WHERE client_slug = $1 AND active = true
      ORDER BY item_type, sort_order, label`,
    [slug],
  );
  return r.rows.map((row) => Object.assign({}, row, { source: 'db' }));
}

async function loadTransferRules(pg, clientSlug) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `SELECT id, airport_code, label, aliases, requires_package, included_when_package,
            min_guest_count, unavailable_no_package_message,
            unavailable_below_min_group_message, active, sort_order
       FROM wh_pricing_transfer_rules
      WHERE client_slug = $1 AND active = true
      ORDER BY sort_order, airport_code`,
    [slug],
  );
  return r.rows.map((row) => Object.assign({}, row, { source: 'db' }));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Replace a season and its ranges atomically. Ranges are rewritten wholesale
 * rather than diffed: a half-applied range edit would silently change which
 * dates a package is priced for.
 */
async function saveSeason(pg, clientSlug, season, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const existing = await pg.query(
    `SELECT id FROM wh_pricing_seasons
      WHERE client_slug = $1 AND code = $2 AND active = true`,
    [slug, season.code],
  );

  let seasonId;
  if (existing.rows.length) {
    seasonId = existing.rows[0].id;
    await pg.query(
      `UPDATE wh_pricing_seasons
          SET label = $3, priority = $4, bookable = $5, updated_by = $6
        WHERE id = $1 AND client_slug = $2`,
      [seasonId, slug, season.label, season.priority, season.bookable, actorId || null],
    );
    await pg.query(
      'DELETE FROM wh_pricing_season_ranges WHERE season_id = $1 AND client_slug = $2',
      [seasonId, slug],
    );
  } else {
    const ins = await pg.query(
      `INSERT INTO wh_pricing_seasons
         (client_slug, code, label, priority, bookable, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [slug, season.code, season.label, season.priority, season.bookable, actorId || null],
    );
    seasonId = ins.rows[0].id;
  }

  for (let i = 0; i < season.ranges.length; i += 1) {
    const rg = season.ranges[i];
    await pg.query(
      `INSERT INTO wh_pricing_season_ranges
         (season_id, client_slug, start_month, start_day, end_month, end_day, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [seasonId, slug, rg.start_month, rg.start_day, rg.end_month, rg.end_day, i],
    );
  }
  return seasonId;
}

async function deactivateSeason(pg, clientSlug, code, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `UPDATE wh_pricing_seasons SET active = false, updated_by = $3
      WHERE client_slug = $1 AND code = $2 AND active = true RETURNING id`,
    [slug, code, actorId || null],
  );
  return r.rowCount > 0;
}

/**
 * Upsert one price. The partial unique index covers only active rows, so the
 * conflict target has to be spelled out the same way.
 */
async function savePriceRule(pg, clientSlug, ruleBody, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const existing = await pg.query(
    `SELECT id FROM wh_pricing_rules
      WHERE client_slug = $1 AND item_type = $2 AND item_code = $3
        AND COALESCE(season_code, '') = COALESCE($4, '') AND active = true`,
    [slug, ruleBody.item_type, ruleBody.item_code, ruleBody.season_code],
  );
  if (existing.rows.length) {
    const r = await pg.query(
      `UPDATE wh_pricing_rules
          SET unit = $3, amount_cents = $4, currency = $5, active = $6, updated_by = $7
        WHERE id = $1 AND client_slug = $2 RETURNING *`,
      [existing.rows[0].id, slug, ruleBody.unit, ruleBody.amount_cents,
        ruleBody.currency, ruleBody.active, actorId || null],
    );
    return r.rows[0];
  }
  const r = await pg.query(
    `INSERT INTO wh_pricing_rules
       (client_slug, item_type, item_code, season_code, unit, amount_cents, currency, active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [slug, ruleBody.item_type, ruleBody.item_code, ruleBody.season_code, ruleBody.unit,
      ruleBody.amount_cents, ruleBody.currency, ruleBody.active, actorId || null],
  );
  return r.rows[0];
}

async function deactivatePriceRule(pg, clientSlug, query, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `UPDATE wh_pricing_rules SET active = false, updated_by = $5
      WHERE client_slug = $1 AND item_type = $2 AND item_code = $3
        AND COALESCE(season_code, '') = COALESCE($4, '') AND active = true
      RETURNING id`,
    [slug, query.item_type, query.item_code, query.season_code, actorId || null],
  );
  return r.rowCount > 0;
}

async function saveItem(pg, clientSlug, item, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const existing = await pg.query(
    `SELECT id FROM wh_pricing_items
      WHERE client_slug = $1 AND item_type = $2 AND item_code = $3 AND active = true`,
    [slug, item.item_type, item.item_code],
  );
  if (existing.rows.length) {
    const r = await pg.query(
      `UPDATE wh_pricing_items
          SET label = $3, description = $4, metadata = $5, active = $6, updated_by = $7
        WHERE id = $1 AND client_slug = $2 RETURNING *`,
      [existing.rows[0].id, slug, item.label, item.description,
        JSON.stringify(item.metadata || {}), item.active, actorId || null],
    );
    return r.rows[0];
  }
  const r = await pg.query(
    `INSERT INTO wh_pricing_items
       (client_slug, item_type, item_code, label, description, metadata, active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [slug, item.item_type, item.item_code, item.label, item.description,
      JSON.stringify(item.metadata || {}), item.active, actorId || null],
  );
  return r.rows[0];
}

/**
 * Retiring a catalog item also retires its prices, so a removed rental cannot
 * leave an orphan price that still resolves in a quote.
 */
async function deactivateItem(pg, clientSlug, itemType, itemCode, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `UPDATE wh_pricing_items SET active = false, updated_by = $4
      WHERE client_slug = $1 AND item_type = $2 AND item_code = $3 AND active = true
      RETURNING id`,
    [slug, itemType, itemCode, actorId || null],
  );
  await pg.query(
    `UPDATE wh_pricing_rules SET active = false, updated_by = $4
      WHERE client_slug = $1 AND item_type = $2 AND active = true
        AND (item_code = $3 OR item_code LIKE $3 || '\\_\\_%')`,
    [slug, itemType, itemCode, actorId || null],
  );
  return r.rowCount > 0;
}

async function saveTransferRule(pg, clientSlug, transferRule, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const existing = await pg.query(
    `SELECT id FROM wh_pricing_transfer_rules
      WHERE client_slug = $1 AND airport_code = $2 AND active = true`,
    [slug, transferRule.airport_code],
  );
  const params = [
    slug, transferRule.airport_code, transferRule.label, transferRule.aliases,
    transferRule.requires_package, transferRule.included_when_package,
    transferRule.min_guest_count, transferRule.unavailable_no_package_message,
    transferRule.unavailable_below_min_group_message, transferRule.active, actorId || null,
  ];
  if (existing.rows.length) {
    const r = await pg.query(
      `UPDATE wh_pricing_transfer_rules
          SET label = $3, aliases = $4, requires_package = $5, included_when_package = $6,
              min_guest_count = $7, unavailable_no_package_message = $8,
              unavailable_below_min_group_message = $9, active = $10, updated_by = $11
        WHERE client_slug = $1 AND airport_code = $2 AND active = true RETURNING *`,
      params,
    );
    return r.rows[0];
  }
  const r = await pg.query(
    `INSERT INTO wh_pricing_transfer_rules
       (client_slug, airport_code, label, aliases, requires_package, included_when_package,
        min_guest_count, unavailable_no_package_message,
        unavailable_below_min_group_message, active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    params,
  );
  return r.rows[0];
}

async function deactivateTransferRule(pg, clientSlug, airportCode, actorId) {
  const slug = assertWolfhouseScope(clientSlug);
  const r = await pg.query(
    `UPDATE wh_pricing_transfer_rules SET active = false, updated_by = $3
      WHERE client_slug = $1 AND airport_code = $2 AND active = true RETURNING id`,
    [slug, airportCode, actorId || null],
  );
  await pg.query(
    `UPDATE wh_pricing_rules SET active = false, updated_by = $3
      WHERE client_slug = $1 AND item_type = 'transfer' AND item_code = $2 AND active = true`,
    [slug, airportCode, actorId || null],
  );
  return r.rowCount > 0;
}

module.exports = {
  CREATE_SQL,
  assertWolfhouseScope,
  ensureWolfhousePricingTables,
  tablesExist,
  loadSeasons,
  loadRules,
  loadItems,
  loadTransferRules,
  saveSeason,
  deactivateSeason,
  savePriceRule,
  deactivatePriceRule,
  saveItem,
  deactivateItem,
  saveTransferRule,
  deactivateTransferRule,
};
