'use strict';

/**
 * Reconcile Sunset Admin pack config_json tier amounts into linked
 * tenant_price_rules rows (canonical identity). Does not invent amounts.
 *
 * Sunset staging only. Dry-run by default.
 *
 * Usage:
 *   WOLFHOUSE_DATABASE_URL='postgres://…sunset_staging…' \
 *     node scripts/reconcile-sunset-admin-price-identities.js
 *   … --apply
 */

const { Client } = require('pg');
const {
  auditSunsetPackPriceIdentities,
  syncPackTierToPriceRules,
} = require('./lib/sunset-admin-price-sync');
const { loadSurfPacksFromDb } = require('./lib/sunset-admin-pack-rules');

const APPROVED_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const APPROVED_DB = 'sunset_staging';
const CLIENT = 'sunset';
const LOCATION = 'sunset-somo';

function assertStagingUrl(url) {
  const u = String(url || '');
  if (!u.includes(APPROVED_HOST) || !u.includes(APPROVED_DB)) {
    throw new Error(`Refusing non-staging URL (need ${APPROVED_HOST} / ${APPROVED_DB})`);
  }
  if (/wolfhouse|production|prod|wh-staging/i.test(u) && !u.includes('sunset')) {
    throw new Error('Refusing URL that looks like Wolfhouse/production');
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('WOLFHOUSE_DATABASE_URL required');
    process.exit(2);
  }
  assertStagingUrl(url);

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    console.log(`\nreconcile-sunset-admin-price-identities (${apply ? 'APPLY' : 'DRY-RUN'})`);
    console.log(`client=${CLIENT} location=${LOCATION}\n`);
    const before = await auditSunsetPackPriceIdentities(client, {
      clientSlug: CLIENT,
      locationId: LOCATION,
    });
    console.log('BEFORE audit (redacted):');
    before.forEach((row) => {
      console.log(JSON.stringify({
        label: row.display_label,
        course_id: row.course_id,
        tier_key: row.tier_key,
        item_code: row.item_code,
        expected_unit: row.expected_unit,
        config_amount_cents: row.config_amount_cents,
        db_status: row.db_status,
        db_amount_cents: row.db_amount_cents,
        db_unit: row.db_unit,
        resolvable: row.resolvable,
        needs_sync: row.needs_sync,
      }));
    });

    const needs = before.filter((r) => r.needs_sync);
    console.log(`\nNeeds sync: ${needs.length} / ${before.length}`);

    if (apply && needs.length) {
      const packs = await loadSurfPacksFromDb(client, CLIENT, LOCATION);
      for (const pack of packs) {
        await syncPackTierToPriceRules(client, {
          clientSlug: CLIENT,
          locationId: LOCATION,
          packId: pack.pack_id,
          packLabel: pack.label,
          tiers: pack.price_tiers || [],
          actor: {},
          skipTransaction: false,
        });
      }
    } else if (!apply) {
      console.log('Dry-run only — pass --apply to write linked price rows.');
    }

    const after = await auditSunsetPackPriceIdentities(client, {
      clientSlug: CLIENT,
      locationId: LOCATION,
    });
    console.log('\nAFTER audit:');
    after.forEach((row) => {
      console.log(JSON.stringify({
        label: row.display_label,
        item_code: row.item_code,
        resolvable: row.resolvable,
        needs_sync: row.needs_sync,
        db_amount_cents: row.db_amount_cents,
        db_unit: row.db_unit,
      }));
    });
    const unresolved = after.filter((r) => r.config_amount_cents > 0 && !r.resolvable);
    console.log(`\nStill unresolved with owner amount: ${unresolved.length}`);
    process.exit(unresolved.length && apply ? 1 : 0);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
