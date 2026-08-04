'use strict';

/**
 * Real-DB validation for Bookings tab v2 Type categorization + sort.
 *
 * Read-only. Requires WOLFHOUSE_DATABASE_URL (or DATABASE_URL) for staging/prod-read.
 * Does not write. Flags unknown service types for owner confirm.
 *
 * Run (Captain / Lunabox):
 *   NODE_PATH=/opt/wolfhouse/WH/node_modules \
 *   WOLFHOUSE_DATABASE_URL=... \
 *   node scripts/validate-sunset-bookings-type-sort-db.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const sharedNodePath = [
  process.env.NODE_PATH,
  path.join(ROOT, 'node_modules'),
  '/opt/wolfhouse/WH/node_modules',
].filter(Boolean).join(path.delimiter);
process.env.NODE_PATH = sharedNodePath;
require('module').Module._initPaths();

const { Client } = require('pg');
const DOMAIN = require('./lib/sunset-bookings-admin');
const DATA = require('./lib/sunset-bookings-admin-data');

async function main() {
  const dsn = process.env.WOLFHOUSE_DATABASE_URL
    || process.env.DATABASE_URL
    || process.env.STAFF_DATABASE_URL
    || '';
  if (!dsn) {
    console.error('FAIL: no WOLFHOUSE_DATABASE_URL / DATABASE_URL — cannot real-DB validate here.');
    process.exit(2);
  }

  const clientSlug = process.env.BOOKINGS_VALIDATE_CLIENT || 'sunset';
  const locationId = process.env.BOOKINGS_VALIDATE_LOCATION || 'sunset-somo';
  const pg = new Client({ connectionString: dsn, statement_timeout: 30000 });
  await pg.connect();
  try {
    await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = await DATA.fetchScopedBookingRows(pg, clientSlug, locationId, {
      sort: null,
      dir: null,
    });
    await pg.query('COMMIT');

    const unknown = new Map();
    const bucketCounts = { lessons: 0, rentals: 0, accommodation: 0, empty: 0, multi: 0 };
    let courseEquipAsRentals = 0;
    const samples = { lessons: [], rentals: [], accommodation: [], multi: [], unknown: [] };

    for (const row of rows) {
      const cats = Array.isArray(row.type_categories) ? row.type_categories : [];
      if (!cats.length) bucketCounts.empty += 1;
      else if (cats.length > 1) {
        bucketCounts.multi += 1;
        if (samples.multi.length < 5) samples.multi.push({ code: row.booking_code, cats, what: row.what_summary });
      }
      for (const c of cats) {
        if (bucketCounts[c] != null) bucketCounts[c] += 1;
      }
      for (const u of row.type_categories_unknown || []) {
        unknown.set(u, (unknown.get(u) || 0) + 1);
        if (samples.unknown.length < 12) {
          samples.unknown.push({ code: row.booking_code, unknown: u, services: (row.items || []).map((i) => i.service_type) });
        }
      }
      // Guard: no service item with course-included flags should alone force Rentals without Lessons when CE present
      for (const it of row.items || []) {
        if (DOMAIN.isCourseIncludedEquipmentService(it) && cats.includes('rentals') && !cats.includes('lessons')) {
          courseEquipAsRentals += 1;
        }
      }
      if (cats.includes('lessons') && samples.lessons.length < 3) {
        samples.lessons.push({ code: row.booking_code, what: row.what_summary });
      }
      if (cats.includes('rentals') && samples.rentals.length < 3) {
        samples.rentals.push({ code: row.booking_code, what: row.what_summary });
      }
      if (cats.includes('accommodation') && samples.accommodation.length < 3) {
        samples.accommodation.push({
          code: row.booking_code,
          what: row.what_summary,
          type_flags: row.type_flags || null,
          created_at: row.created_at || null,
        });
      }
    }

    // Sort smoke on real rows
    const byTotalDesc = DOMAIN.sortBookingRows(rows, 'total', 'desc');
    const byCreatedDesc = DOMAIN.sortBookingRows(rows, 'created', 'desc');
    const totalOk = byTotalDesc.length < 2 || (
      Number(byTotalDesc[0].total_cents || 0) >= Number(byTotalDesc[byTotalDesc.length - 1].total_cents || 0)
    );
    const createdOk = byCreatedDesc.length < 2 || (() => {
      const a = byCreatedDesc.find((r) => r.created_at);
      const b = [...byCreatedDesc].reverse().find((r) => r.created_at);
      if (!a || !b) return true;
      return String(a.created_at) >= String(b.created_at);
    })();
    const flagsOk = rows.every((r) => {
      const f = r.type_flags || {};
      const cats = Array.isArray(r.type_categories) ? r.type_categories : [];
      return (!!f.lessons) === cats.includes('lessons')
        && (!!f.rentals) === cats.includes('rentals')
        && (!!f.accommodation) === cats.includes('accommodation');
    });

    console.log(JSON.stringify({
      ok: courseEquipAsRentals === 0 && totalOk && createdOk && flagsOk,
      client: clientSlug,
      location_id: locationId,
      row_count: rows.length,
      bucket_counts: bucketCounts,
      course_equip_as_rentals_only: courseEquipAsRentals,
      sort_total_desc_ok: totalOk,
      sort_created_desc_ok: createdOk,
      type_flags_match_categories: flagsOk,
      accommodation_sample_count: samples.accommodation.length,
      unknown_service_types: Object.fromEntries([...unknown.entries()].sort((a, b) => b[1] - a[1])),
      samples,
      owner_confirm_needed: unknown.size > 0
        ? [...unknown.keys()]
        : [],
    }, null, 2));

    if (courseEquipAsRentals > 0 || !totalOk || !createdOk || !flagsOk) process.exitCode = 1;
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    console.error('FAIL real-DB validate:', err && err.message);
    process.exit(1);
  } finally {
    await pg.end().catch(() => {});
  }
}

main();
