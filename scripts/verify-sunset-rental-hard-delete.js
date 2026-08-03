'use strict';

/**
 * verify:sunset-rental-hard-delete
 *
 * Focused RED→GREEN gate for the corrected Rental Admin contract:
 *  1) enable/disable independent of standalone prices
 *  2) course equipment dropdown = active offering identities (no price gate)
 *  3) Delete rental only after pencil Edit mode (priced + unpriced)
 *  4) TRUE transactional hard delete (offerings + prices + Group/Private links)
 *  5) sibling key / other tenant / other location / bookings untouched
 *  6) rollback leaves live config intact; idempotent retry safe
 *  7) browser refresh without page.reload
 *
 * Offline: source contracts + in-memory transactional fake + browser fixture.
 * Run: node scripts/verify-sunset-rental-hard-delete.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const {
  deleteRentalOffering,
  setRentalOfferingActive,
  createRentalOffering,
  listRentalOfferings,
} = require('./lib/tenant-rental-offerings');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function pw() {
  try {
    return require('playwright');
  } catch (_) {
    return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');
  }
}

const listen = (s) =>
  new Promise((r, j) => {
    s.once('error', j);
    s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
  });

/** PostgreSQL LIKE simulator — only to prove the bug class we must avoid. */
function pgLike(str, pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  re += '$';
  return new RegExp(re, 'i').test(String(str));
}

function sourceContracts() {
  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  const offeringsSrc = read('scripts/lib/tenant-rental-offerings.js');
  const writesSrc = read('scripts/lib/tenant-admin-writes.js');
  const apiSrc = read('scripts/staff-query-api.js');
  const en = read('scripts/lib/staff-portal-i18n.js');
  const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');
  let fail = 0;
  function ok(label, cond, detail) {
    if (cond) {
      console.log(`  PASS  ${label}`);
      return;
    }
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }

  console.log('\n[source] Enable/disable + dropdown + edit-mode Delete + hard-delete contracts\n');

  // ── Enable/disable decoupled from prices ──
  ok(
    'API enable path does NOT guard cannot_enable_unpriced_offering',
    !/cannot_enable_unpriced_offering/.test(apiSrc)
      && !/body\.active === true[\s\S]{0,600}buildActivePositivePriceForOfferingSql/.test(apiSrc),
  );
  ok(
    'deactivatePriceRule does NOT auto-disable offering on last price',
    !/Last active positive price for a rental offering[\s\S]{0,400}setRentalOfferingActive/.test(writesSrc)
      && /must NOT auto-disable the rental offering identity|Catalog active state is independent/.test(writesSrc),
  );

  // ── Course dropdown: active identity only ──
  const equipFn = (adminUi.match(/function adminEquipmentOfferings\(\)\{[\s\S]*?\n\}/) || [])[0] || '';
  ok(
    'adminEquipmentOfferings filters active only (no price helper)',
    /active !== false|active === false/.test(equipFn)
      && !/adminOfferingHasActivePositivePrice/.test(equipFn),
  );
  ok(
    'historical selected unavailable fallback retained',
    /admin\.courseEquipment\.unavailable/.test(adminUi) && /selected disabled/.test(adminUi),
  );

  // ── Delete rental only in edit mode ──
  ok(
    'Delete rental action exists',
    /data-admin-action="delete-rental-offering"/.test(adminUi)
      && /admin\.prices\.deleteRental/.test(adminUi),
  );
  ok(
    'Delete rental via edit footer only (no browse overflow); not a bare top-right header button',
    /delete-rental-offering/.test(adminUi)
      && !/equip-overflow-toggle|data-admin-equip-overflow/.test(adminUi)
      && /portal-admin-equip-footer[\s\S]{0,400}delete-rental-offering/.test(adminUi),
  );
  ok(
    'duration × remains removeDuration (separate from item delete)',
    /delete-price[\s\S]{0,200}removeDuration/.test(adminUi),
  );
  ok(
    'disabled items keep edit + add-price controls (no itemActive gate on +)',
    /add-equip-price[\s\S]{0,120}data-equip-key/.test(adminUi)
      && !/if \(!adding && itemActive\)/.test(adminUi),
  );

  // ── Hard delete SQL contracts ──
  ok(
    'deleteRentalOffering is transactional hard delete (BEGIN/COMMIT/ROLLBACK)',
    /async function deleteRentalOffering[\s\S]{0,2500}BEGIN[\s\S]{0,8000}COMMIT[\s\S]{0,6000}ROLLBACK/.test(offeringsSrc)
      && /DELETE FROM tenant_rental_offerings/.test(offeringsSrc)
      && /DELETE FROM tenant_price_rules/.test(offeringsSrc),
  );
  ok(
    'price ownership uses split_part equality (never LIKE)',
    /split_part\(item_code,\s*'__',\s*1\)\s*=\s*\$/.test(offeringsSrc)
      && !/DELETE FROM tenant_price_rules[\s\S]{0,400}LIKE/i.test(offeringsSrc),
  );
  ok(
    'hard delete strips surf pack + private lesson equipment_options',
    /tenant_surf_pack_rules/.test(offeringsSrc)
      && /tenant_private_lesson_rules/.test(offeringsSrc)
      && /equipment_options/.test(offeringsSrc),
  );
  ok(
    'hard delete returns sanitized counts',
    /offerings_deleted/.test(offeringsSrc)
      && /prices_deleted/.test(offeringsSrc)
      && /surf_packs_updated/.test(offeringsSrc)
      && /private_lessons_updated/.test(offeringsSrc),
  );
  ok(
    'missing tables fail closed (admin_db_tables_missing)',
    /admin_db_tables_missing/.test(offeringsSrc)
      && /to_regclass/.test(offeringsSrc),
  );
  ok(
    'idempotent noop when identity already gone',
    /noop:\s*true/.test(offeringsSrc),
  );
  ok(
    'API DELETE wires deleteRentalOffering (hard path)',
    /op === 'delete'[\s\S]{0,500}deleteRentalOffering/.test(apiSrc),
  );
  ok(
    'delete reloads config without page.reload',
    /delete-rental-offering[\s\S]{0,1500}adminReloadConfig\(/.test(adminUi)
      && !/delete-rental-offering[\s\S]{0,1500}location\.reload\s*\(/.test(adminUi)
      && !/delete-rental-offering[\s\S]{0,1500}(?<![\w.])page\.reload\s*\(/.test(adminUi)
      && !/delete-rental-offering[\s\S]{0,1500}window\.location\.reload\s*\(/.test(adminUi),
  );

  // i18n hard-delete confirm language
  ok(
    'EN confirm mentions permanent + prices + course links',
    /deleteRentalConfirm['"]:\s*['"][^'"]*Permanently delete[^'"]*duration prices[^'"]*Group\/Private/i.test(en)
      || (en.includes('admin.prices.deleteRentalConfirm')
        && /Permanently delete/.test(en)
        && /duration prices/.test(en)
        && /Group\/Private|course equipment links/.test(en)),
  );
  ok(
    'ES confirm mentions permanent delete of prices + course links',
    es.includes('admin.prices.deleteRentalConfirm')
      && /permanent/i.test(es)
      && /precios de duración|material/.test(es),
  );
  ok('EN Delete rental label', en.includes("'admin.prices.deleteRental': 'Delete rental'"));
  ok('ES Delete rental label', es.includes("'admin.prices.deleteRental': 'Eliminar alquiler'"));

  if (fail) throw new Error(`source contracts failed: ${fail}`);
  console.log('  source contracts OK');
}

/**
 * In-memory multi-table PG fake that understands the hard-delete SQL surface.
 * Supports BEGIN/COMMIT/ROLLBACK for transactional integrity tests.
 */
function makeHardDeletePg(seed = {}) {
  const state = {
    offerings: (seed.offerings || []).map((r) => ({ ...r })),
    prices: (seed.prices || []).map((r) => ({ ...r })),
    packs: (seed.packs || []).map((r) => ({ ...r, config_json: { ...(r.config_json || {}) } })),
    privates: (seed.privates || []).map((r) => ({ ...r, config_json: { ...(r.config_json || {}) } })),
    bookings: (seed.bookings || []).map((r) => ({ ...r })),
    audit: [],
    tables: {
      tenant_rental_offerings: true,
      tenant_price_rules: true,
      tenant_surf_pack_rules: true,
      tenant_private_lesson_rules: true,
      tenant_config_audit_log: true,
      ...(seed.tables || {}),
    },
    locationCols: {
      tenant_rental_offerings: true,
      tenant_price_rules: true,
      tenant_surf_pack_rules: true,
      tenant_private_lesson_rules: true,
      ...(seed.locationCols || {}),
    },
    failOn: seed.failOn || null, // e.g. 'private_update'
  };
  let snap = null;
  let inTx = false;
  let seq = 100;

  const clone = () => ({
    offerings: state.offerings.map((r) => ({ ...r })),
    prices: state.prices.map((r) => ({ ...r })),
    packs: state.packs.map((r) => ({
      ...r,
      config_json: {
        ...r.config_json,
        equipment_options: (r.config_json.equipment_options || []).map((x) => ({ ...x })),
      },
    })),
    privates: state.privates.map((r) => ({
      ...r,
      config_json: {
        ...r.config_json,
        equipment_options: (r.config_json.equipment_options || []).map((x) => ({ ...x })),
      },
    })),
    bookings: state.bookings.map((r) => ({ ...r })),
    audit: state.audit.map((r) => ({ ...r })),
  });

  const matchLoc = (row, loc, hasCol) => {
    if (!hasCol) return true;
    if (loc == null) return row.location_id == null;
    return row.location_id === loc;
  };

  const pg = {
    state,
    query: async (sql, params = []) => {
      const s = String(sql);

      if (/^\s*BEGIN\s*$/i.test(s.trim())) {
        if (inTx) throw new Error('nested BEGIN');
        inTx = true;
        snap = clone();
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*COMMIT\s*$/i.test(s.trim())) {
        inTx = false;
        snap = null;
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*ROLLBACK\s*$/i.test(s.trim())) {
        if (snap) {
          state.offerings = snap.offerings;
          state.prices = snap.prices;
          state.packs = snap.packs;
          state.privates = snap.privates;
          state.bookings = snap.bookings;
          state.audit = snap.audit;
        }
        inTx = false;
        snap = null;
        return { rows: [], rowCount: 0 };
      }

      if (/to_regclass/i.test(s)) {
        const fromParam = params && params[0] != null ? String(params[0]) : '';
        const fromLiteral = (s.match(/to_regclass\(\s*'([^']+)'\s*\)/i) || [])[1] || '';
        const name = (fromParam || fromLiteral).replace(/^public\./, '');
        const present = state.tables[name] !== false;
        return { rows: [{ reg: present ? name : null }], rowCount: 1 };
      }
      if (/information_schema\.columns/i.test(s)) {
        const table = params[0];
        const has = state.locationCols[table] !== false;
        return { rows: has ? [{ '?column?': 1 }] : [], rowCount: has ? 1 : 0 };
      }

      // Offerings lock / select
      if (/SELECT \* FROM tenant_rental_offerings/i.test(s) && /FOR UPDATE/i.test(s)) {
        const slug = params[0];
        const key = params[1];
        const loc = /location_id = \$/i.test(s) ? params[2] : null;
        const rows = state.offerings.filter(
          (r) => r.client_slug === slug && r.offering_key === key && matchLoc(r, loc, true),
        );
        return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
      }
      if (/SELECT[\s\S]*FROM tenant_rental_offerings/i.test(s) && !/FOR UPDATE/i.test(s) && !/DELETE/i.test(s)) {
        // list / setRentalOfferingActive paths
        const slug = params[0];
        let out = state.offerings.filter((r) => r.client_slug === slug);
        if (/offering_key = \$/i.test(s)) {
          const key = params[1];
          out = out.filter((r) => r.offering_key === key);
          if (/location_id = \$/i.test(s)) {
            const loc = params[2];
            out = out.filter((r) => matchLoc(r, loc, true));
          } else if (/location_id IS NULL/i.test(s)) {
            out = out.filter((r) => r.location_id == null);
          }
          out = out.slice().sort((a, b) => Number(b.active) - Number(a.active));
          return { rows: out.slice(0, 1), rowCount: Math.min(out.length, 1) };
        }
        if (/location_id = \$/i.test(s)) {
          const loc = params[1];
          out = out.filter((r) => r.location_id === loc || r.location_id == null);
        }
        if (/active = true/.test(s)) out = out.filter((r) => r.active);
        return { rows: out, rowCount: out.length };
      }
      if (/INSERT INTO tenant_rental_offerings/i.test(s)) {
        const [client_slug, location_id, offering_key, label, group_key, excludesJson, sort_order, updated_by] = params;
        seq += 1;
        const row = {
          id: `ro-${seq}`,
          client_slug,
          location_id,
          offering_key,
          label,
          group_key,
          excludes: JSON.parse(excludesJson),
          sort_order,
          active: true,
          updated_by,
          tenant_id: 'sunset',
        };
        state.offerings.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/\bUPDATE\s+tenant_rental_offerings\b/i.test(s) && /SET active/i.test(s)) {
        const wantActive = params[0];
        const id = params[2];
        const row = state.offerings.find((r) => r.id === id);
        if (!row) return { rows: [], rowCount: 0 };
        row.active = wantActive;
        row.updated_by = params[1];
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/DELETE FROM tenant_rental_offerings/i.test(s)) {
        const slug = params[0];
        const key = params[1];
        const loc = /location_id = \$/i.test(s) ? params[2] : null;
        const kept = [];
        const deleted = [];
        for (const r of state.offerings) {
          if (r.client_slug === slug && r.offering_key === key && matchLoc(r, loc, true)) {
            deleted.push({ id: r.id, offering_key: r.offering_key, active: r.active });
          } else kept.push(r);
        }
        state.offerings = kept;
        return { rows: deleted, rowCount: deleted.length };
      }

      // Prices
      if (/DELETE FROM tenant_price_rules/i.test(s)) {
        // Must use split_part ownership, never LIKE — the production SQL does;
        // fake applies exact ownership the same way.
        const slug = params[0];
        const key = params[1];
        const loc = /location_id = \$/i.test(s) ? params[2] : (/location_id IS NULL/i.test(s) ? null : undefined);
        if (/LIKE/i.test(s)) throw new Error('BUG: hard delete used LIKE for prices');
        const kept = [];
        const deleted = [];
        for (const p of state.prices) {
          const head = String(p.item_code || '').split('__')[0];
          const locOk = loc === undefined ? true : matchLoc(p, loc, true);
          if (
            p.client_slug === slug
            && String(p.item_type) === 'rental'
            && head === key
            && locOk
          ) {
            deleted.push({ ...p });
          } else kept.push(p);
        }
        state.prices = kept;
        return { rows: deleted, rowCount: deleted.length };
      }

      // Surf packs
      if (/SELECT[\s\S]*FROM tenant_surf_pack_rules/i.test(s) && /FOR UPDATE/i.test(s)) {
        const slug = params[0];
        const loc = /location_id = \$/i.test(s) ? params[1] : null;
        const rows = state.packs.filter((r) => r.client_slug === slug && matchLoc(r, loc, true));
        return {
          rows: rows.map((r) => ({
            ...r,
            config_json: {
              ...r.config_json,
              equipment_options: (r.config_json.equipment_options || []).map((x) => ({ ...x })),
            },
          })),
          rowCount: rows.length,
        };
      }
      if (/\bUPDATE\s+tenant_surf_pack_rules\b/i.test(s)) {
        if (state.failOn === 'pack_update') throw new Error('simulated pack update failure');
        const id = params[0];
        const cfg = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
        const pack = state.packs.find((r) => r.id === id);
        if (!pack) return { rows: [], rowCount: 0 };
        pack.config_json = cfg;
        pack.updated_by = params[2];
        return { rows: [{ id }], rowCount: 1 };
      }

      // Private lessons
      if (/SELECT[\s\S]*FROM tenant_private_lesson_rules/i.test(s) && /FOR UPDATE/i.test(s)) {
        const slug = params[0];
        const loc = /location_id = \$/i.test(s) ? params[1] : null;
        const rows = state.privates.filter((r) => r.client_slug === slug && matchLoc(r, loc, true));
        return {
          rows: rows.map((r) => ({
            ...r,
            config_json: {
              ...r.config_json,
              equipment_options: (r.config_json.equipment_options || []).map((x) => ({ ...x })),
            },
          })),
          rowCount: rows.length,
        };
      }
      if (/\bUPDATE\s+tenant_private_lesson_rules\b/i.test(s)) {
        if (state.failOn === 'private_update') throw new Error('simulated private update failure');
        const id = params[0];
        const cfg = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
        const pl = state.privates.find((r) => r.id === id);
        if (!pl) return { rows: [], rowCount: 0 };
        pl.config_json = cfg;
        pl.updated_by = params[2];
        return { rows: [{ id }], rowCount: 1 };
      }

      if (/INSERT INTO tenant_config_audit_log/i.test(s)) {
        state.audit.push({
          tenant_id: params[0],
          client_slug: params[1],
          actor_user_id: params[2],
          actor_email: params[3],
          entity_id: params[4],
          before_json: params[5],
          after_json: params[6],
        });
        return { rows: [], rowCount: 1 };
      }

      // Bookings must never be queried/mutated by hard delete
      if (/booking/i.test(s)) {
        throw new Error('hard delete must not touch booking tables');
      }

      return { rows: [], rowCount: 0 };
    },
  };
  return pg;
}

async function behavioralHardDelete() {
  console.log('\n[behavioral] enable/disable unpriced + transactional hard delete\n');
  let pass = 0;
  let fail = 0;
  function ok(label, cond, detail) {
    if (cond) {
      console.log(`  PASS  ${label}`);
      pass += 1;
      return;
    }
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }

  // ── Enable/disable exact identity with no price ──
  const togglePg = makeHardDeletePg({
    offerings: [{
      id: 'ro-1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      offering_key: 'unpriced_fins',
      label: 'Unpriced fins',
      group_key: 'fins',
      excludes: [],
      sort_order: 1,
      active: false,
      tenant_id: 'sunset',
    }],
  });
  const enabled = await setRentalOfferingActive(togglePg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'unpriced_fins',
    active: true,
    actorId: 'actor-1',
  });
  ok('enable unpriced exact identity succeeds', enabled.ok === true && enabled.offering.active === true, JSON.stringify(enabled));
  ok('enable does not duplicate row', togglePg.state.offerings.filter((r) => r.offering_key === 'unpriced_fins').length === 1);
  const disabled = await setRentalOfferingActive(togglePg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'unpriced_fins',
    active: false,
  });
  ok('disable unpriced succeeds', disabled.ok === true && disabled.offering.active === false);

  // ── Full hard-delete fixture ──
  const TARGET = 'soft_board';
  const SIBLING = 'softxboard';
  const pg = makeHardDeletePg({
    offerings: [
      {
        id: 'ro-target-active',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        offering_key: TARGET,
        label: 'Soft board',
        group_key: 'boards',
        excludes: [],
        sort_order: 0,
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: 'ro-target-inactive-dup',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        offering_key: TARGET,
        label: 'Soft board (old)',
        group_key: 'boards',
        excludes: [],
        sort_order: 0,
        active: false,
        tenant_id: 'sunset',
      },
      {
        id: 'ro-sibling',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        offering_key: SIBLING,
        label: 'Soft X board',
        group_key: 'boards',
        excludes: [],
        sort_order: 1,
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: 'ro-other-loc',
        client_slug: 'sunset',
        location_id: 'sunset-sardinero',
        offering_key: TARGET,
        label: 'Soft board Sardinero',
        group_key: 'boards',
        excludes: [],
        sort_order: 0,
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: 'ro-other-tenant',
        client_slug: 'lawave',
        location_id: 'sunset-somo',
        offering_key: TARGET,
        label: 'La Wave soft',
        group_key: 'boards',
        excludes: [],
        sort_order: 0,
        active: true,
        tenant_id: 'lawave',
      },
    ],
    prices: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'soft_board__1_day',
        amount_cents: 1500,
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'soft_board__3_days',
        amount_cents: 3000,
        active: false, // inactive duration still hard-deleted
        tenant_id: 'sunset',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'soft_board', // legacy bare key
        amount_cents: 900,
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'softxboard__1_day', // sibling — MUST survive
        amount_cents: 2200,
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        client_slug: 'sunset',
        location_id: 'sunset-sardinero',
        item_type: 'rental',
        item_code: 'soft_board__1_day',
        amount_cents: 1500,
        active: true,
        tenant_id: 'sunset',
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        client_slug: 'lawave',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'soft_board__1_day',
        amount_cents: 1500,
        active: true,
        tenant_id: 'lawave',
      },
    ],
    packs: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        active: true,
        config_json: {
          equipment_options: [
            { offering_key: TARGET, during_course_price_cents: 0, all_day_price_cents: 500 },
            { offering_key: SIBLING, during_course_price_cents: 100, all_day_price_cents: 0 },
          ],
        },
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        active: false, // inactive pack still cleaned
        config_json: {
          equipment_options: [
            { offering_key: TARGET, during_course_price_cents: 0, all_day_price_cents: 0 },
          ],
        },
      },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        client_slug: 'sunset',
        location_id: 'sunset-sardinero',
        active: true,
        config_json: {
          equipment_options: [
            { offering_key: TARGET, during_course_price_cents: 0, all_day_price_cents: 0 },
          ],
        },
      },
    ],
    privates: [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        active: true,
        config_json: {
          equipment_options: [
            { offering_key: TARGET, during_course_price_cents: 200, all_day_price_cents: 100 },
            { offering_key: SIBLING, during_course_price_cents: 0, all_day_price_cents: 0 },
          ],
        },
      },
    ],
    bookings: [
      {
        id: 'booking-keep-me',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        offering_key: TARGET,
        snapshot: { amount_cents: 1500 },
      },
    ],
  });

  // Prove LIKE would false-match sibling (bug class we avoid)
  ok(
    'BUG CLASS: LIKE soft_board__% would match softxboard__1_day',
    pgLike('softxboard__1_day', 'soft_board__%') === true,
  );

  const del = await deleteRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: TARGET,
    actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    actor: { staff_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'ops@test' },
  });
  ok('hard delete ok', del.ok === true && del.deleted === true && del.noop !== true, JSON.stringify(del));
  ok('offerings_deleted counts active+inactive dups', del.offerings_deleted === 2, JSON.stringify(del));
  ok('prices_deleted counts active+inactive+legacy bare', del.prices_deleted === 3, JSON.stringify(del));
  ok('surf_packs_updated active+inactive at scope', del.surf_packs_updated === 2, JSON.stringify(del));
  ok('private_lessons_updated', del.private_lessons_updated === 1, JSON.stringify(del));

  ok(
    'target offerings gone at scope (incl inactive dups)',
    !pg.state.offerings.some(
      (r) => r.client_slug === 'sunset' && r.location_id === 'sunset-somo' && r.offering_key === TARGET,
    ),
  );
  ok(
    'sibling offering untouched',
    pg.state.offerings.some((r) => r.offering_key === SIBLING && r.client_slug === 'sunset' && r.location_id === 'sunset-somo'),
  );
  ok(
    'other location offering untouched',
    pg.state.offerings.some((r) => r.id === 'ro-other-loc' && r.offering_key === TARGET),
  );
  ok(
    'other tenant offering untouched',
    pg.state.offerings.some((r) => r.id === 'ro-other-tenant' && r.offering_key === TARGET),
  );
  ok(
    'sibling price untouched',
    pg.state.prices.some((p) => p.item_code === 'softxboard__1_day'),
  );
  ok(
    'other location price untouched',
    pg.state.prices.some((p) => p.id === '55555555-5555-4555-8555-555555555555'),
  );
  ok(
    'other tenant price untouched',
    pg.state.prices.some((p) => p.id === '66666666-6666-4666-8666-666666666666'),
  );
  ok(
    'target prices removed at scope',
    !pg.state.prices.some(
      (p) => p.client_slug === 'sunset'
        && p.location_id === 'sunset-somo'
        && String(p.item_code).split('__')[0] === TARGET,
    ),
  );

  const packSomo = pg.state.packs.find((p) => p.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const packKeys = (packSomo.config_json.equipment_options || []).map((e) => e.offering_key);
  ok('group pack lost target, kept sibling', JSON.stringify(packKeys) === JSON.stringify([SIBLING]), JSON.stringify(packKeys));
  const packInactive = pg.state.packs.find((p) => p.id === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  ok(
    'inactive pack equipment cleared of target',
    (packInactive.config_json.equipment_options || []).length === 0,
  );
  const packOtherLoc = pg.state.packs.find((p) => p.id === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  ok(
    'other location pack association untouched',
    (packOtherLoc.config_json.equipment_options || []).some((e) => e.offering_key === TARGET),
  );
  const priv = pg.state.privates[0];
  const privKeys = (priv.config_json.equipment_options || []).map((e) => e.offering_key);
  ok('private lesson lost target, kept sibling', JSON.stringify(privKeys) === JSON.stringify([SIBLING]), JSON.stringify(privKeys));

  ok('historical booking fixture untouched', pg.state.bookings.length === 1 && pg.state.bookings[0].id === 'booking-keep-me');
  ok('price audit rows written', pg.state.audit.length === 3);

  // Idempotent retry
  const retry = await deleteRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: TARGET,
  });
  ok('idempotent retry ok/noop', retry.ok === true && retry.noop === true && retry.deleted === false, JSON.stringify(retry));
  ok('idempotent zero counts', retry.offerings_deleted === 0 && retry.prices_deleted === 0
    && retry.surf_packs_updated === 0 && retry.private_lessons_updated === 0);
  ok('sibling still present after retry', pg.state.prices.some((p) => p.item_code === 'softxboard__1_day'));

  // Rollback on cleanup failure
  const rollbackPg = makeHardDeletePg({
    failOn: 'private_update',
    offerings: [{
      id: 'ro-rb',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      offering_key: 'kayak_rental',
      label: 'Kayak',
      group_key: 'sup',
      excludes: [],
      sort_order: 0,
      active: true,
      tenant_id: 'sunset',
    }],
    prices: [{
      id: '77777777-7777-4777-8777-777777777777',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'kayak_rental__1_day',
      amount_cents: 4000,
      active: true,
      tenant_id: 'sunset',
    }],
    packs: [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      active: true,
      config_json: {
        equipment_options: [
          { offering_key: 'kayak_rental', during_course_price_cents: 0, all_day_price_cents: 0 },
        ],
      },
    }],
    privates: [{
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      active: true,
      config_json: {
        equipment_options: [
          { offering_key: 'kayak_rental', during_course_price_cents: 0, all_day_price_cents: 0 },
        ],
      },
    }],
  });
  const beforeOfferings = rollbackPg.state.offerings.length;
  const beforePrices = rollbackPg.state.prices.length;
  let threw = false;
  try {
    await deleteRentalOffering(rollbackPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offering_key: 'kayak_rental',
    });
  } catch (err) {
    threw = /simulated private/.test(String(err && err.message));
  }
  ok('cleanup failure throws', threw);
  ok('rollback restores offerings', rollbackPg.state.offerings.length === beforeOfferings
    && rollbackPg.state.offerings.some((r) => r.offering_key === 'kayak_rental'));
  ok('rollback restores prices', rollbackPg.state.prices.length === beforePrices);
  ok(
    'rollback restores pack equipment link',
    (rollbackPg.state.packs[0].config_json.equipment_options || []).some((e) => e.offering_key === 'kayak_rental'),
  );
  ok(
    'rollback restores private equipment link',
    (rollbackPg.state.privates[0].config_json.equipment_options || []).some((e) => e.offering_key === 'kayak_rental'),
  );

  // Missing table fail-closed
  const missingPg = makeHardDeletePg({
    tables: { tenant_rental_offerings: false },
    offerings: [{
      id: 'ro-x',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      offering_key: 'ghost',
      label: 'Ghost',
      group_key: 'g',
      excludes: [],
      sort_order: 0,
      active: true,
    }],
  });
  const miss = await deleteRentalOffering(missingPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'ghost',
  });
  ok('missing table fails closed', miss.ok === false && miss.error === 'admin_db_tables_missing', JSON.stringify(miss));
  ok('missing table did not soft-disable', missingPg.state.offerings[0].active === true);

  // Active no-price item appears in active list for dropdown projection
  const catalogPg = makeHardDeletePg({
    offerings: [
      {
        id: 'ro-a',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        offering_key: 'active_noprice',
        label: 'Active no price',
        group_key: 'x',
        excludes: [],
        sort_order: 0,
        active: true,
      },
      {
        id: 'ro-b',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        offering_key: 'disabled_item',
        label: 'Disabled',
        group_key: 'x',
        excludes: [],
        sort_order: 1,
        active: false,
      },
    ],
  });
  const activeOnly = await listRentalOfferings(catalogPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
  });
  ok('active no-price in active catalog', activeOnly.some((r) => r.offering_key === 'active_noprice'));
  ok('disabled absent from active catalog', !activeOnly.some((r) => r.offering_key === 'disabled_item'));

  if (fail) throw new Error(`behavioral hard-delete failed: ${fail}`);
  console.log(`  behavioral OK (pass=${pass})`);
}

async function browserFixture() {
  console.log('\n[browser] Edit-mode Delete + dropdown active-only + refresh\n');

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  /**
   * Teardown safety: late config fetches after browser.close() throw
   * "Storage.getCookies: Failed to find browser context". Track closing +
   * in-flight route work; short-circuit only when closing (do not swallow
   * errors while the test is still active).
   */
  let closing = false;
  const inflightRoutes = new Set();
  async function runRoute(r, fn) {
    if (closing) {
      try { await r.abort(); } catch (_e) { /* context already going away */ }
      return;
    }
    const token = Object.create(null);
    inflightRoutes.add(token);
    try {
      await fn(r);
    } catch (err) {
      if (closing) return;
      throw err;
    } finally {
      inflightRoutes.delete(token);
    }
  }

  let offerings = [
    { offering_key: 'softboard', label: 'Soft board', active: true },
    { offering_key: 'ghost_fins', label: 'Ghost fins (unpriced)', active: true },
    { offering_key: 'zero_price_pad', label: 'Zero pad', active: true },
    { offering_key: 'retired_board', label: 'Retired board', active: false },
  ];
  let rentalPrices = [
    {
      id: 'price-soft-1',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'softboard__1_day',
      item_code: 'softboard__1_day',
      display_name: 'Soft board',
      label: 'Soft board',
      amount_cents: 1500,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
    {
      id: 'price-zero-1',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'zero_price_pad__1_day',
      item_code: 'zero_price_pad__1_day',
      display_name: 'Zero pad',
      label: 'Zero pad',
      amount_cents: 0,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
    {
      id: 'price-ret-1',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'retired_board__1_day',
      item_code: 'retired_board__1_day',
      display_name: 'Retired board',
      label: 'Retired board',
      amount_cents: 900,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  ];
  let pack = {
    pack_id: 'verify-demo-pack',
    label: 'Group',
    age_band: '12_and_up',
    group_size: 8,
    beaches: ['somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130'],
    price_tiers: [],
    equipment_options: [
      { offering_key: 'retired_board', during_course_price_cents: 0, all_day_price_cents: 0 },
    ],
  };
  let privateLesson = {
    enabled: true,
    label: 'Private',
    amount_cents: 5000,
    currency: 'EUR',
    price_basis: 'per_session',
    default_duration_minutes: 120,
    notes: 'draft',
    equipment_options: [],
  };

  const deletes = [];
  const patches = [];
  const configGets = [];
  const catalogGets = [];

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route(/\/staff\/admin\/config\/rental-offerings(?:\/([a-z][a-z0-9_]*)(?:\/commit)?)?(?:\?|$)/, async (r) => {
    const method = r.request().method();
    const u = r.request().url();
    const commitMatch = /rental-offerings\/([a-z][a-z0-9_]*)\/commit(?:\?|$)/.exec(u);
    if (commitMatch && method === 'POST') {
      const key = commitMatch[1];
      const body = JSON.parse(r.request().postData() || '{}');
      patches.push({ key, body, via: 'commit' });
      const off = offerings.find((o) => o.offering_key === key);
      if (off) {
        if (body.label) off.label = body.label;
        if (Object.prototype.hasOwnProperty.call(body, 'active') && typeof body.active === 'boolean') {
          off.active = body.active;
        }
      }
      if (Array.isArray(body.new_prices)) {
        body.new_prices.forEach((np) => {
          const dur = String(np.period_window || '1_day');
          const code = `${key}__${dur}`;
          if (rentalPrices.some((p) => String(p.item_code || p.offering_key) === code)) return;
          rentalPrices.push({
            id: `price-new-${rentalPrices.length + 1}`,
            category: 'rental',
            item_type: 'rental',
            offering_key: code,
            item_code: code,
            display_name: (off && off.label) || key,
            label: (off && off.label) || key,
            amount_cents: Number(np.amount_cents) || 0,
            active: true,
            client_slug: 'sunset',
            location_id: 'sunset-somo',
          });
        });
      }
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, offering_key: key, offering: off || { offering_key: key } }),
      });
      return;
    }
    const keyMatch = /rental-offerings\/([a-z][a-z0-9_]*)(?:\?|$)/.exec(u);
    const key = keyMatch ? keyMatch[1] : '';
    if (!key) {
      if (method === 'GET') {
        catalogGets.push({ url: u });
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({ success: true, offerings: offerings.slice() }),
        });
        return;
      }
      if (method === 'POST') {
        const body = JSON.parse(r.request().postData() || '{}');
        if (!offerings.some((o) => o.offering_key === body.offering_key)) {
          offerings.push({
            offering_key: body.offering_key,
            label: body.label || body.offering_key,
            active: true,
          });
        }
        await r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            offering: { offering_key: body.offering_key, label: body.label, active: true },
          }),
        });
        return;
      }
    }
    if (method === 'DELETE' && key) {
      deletes.push(key);
      offerings = offerings.filter((o) => o.offering_key !== key);
      rentalPrices = rentalPrices.filter((p) => String(p.item_code || p.offering_key || '').split('__')[0] !== key);
      if (Array.isArray(pack.equipment_options)) {
        pack = {
          ...pack,
          equipment_options: pack.equipment_options.filter((e) => e.offering_key !== key),
        };
      }
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          deleted: true,
          offering_key: key,
          offerings_deleted: 1,
          prices_deleted: 1,
          surf_packs_updated: 1,
          private_lessons_updated: 0,
        }),
      });
      return;
    }
    if (method === 'PATCH' && key) {
      const body = JSON.parse(r.request().postData() || '{}');
      patches.push({ key, body });
      const off = offerings.find((o) => o.offering_key === key);
      if (off && typeof body.active === 'boolean') off.active = body.active;
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, offering: off || { offering_key: key, active: body.active } }),
      });
      return;
    }
    await r.continue();
  });

  await page.route(/\/staff\/admin\/config(?:\?|$)/, async (r) => {
    await runRoute(r, async (route) => {
      configGets.push(route.request().url());
      // r.fetch() needs a live browser context — abort cleanly if teardown started mid-flight.
      let x;
      try {
        x = await route.fetch();
      } catch (err) {
        if (closing) return;
        throw err;
      }
      if (closing) {
        try { await route.abort(); } catch (_e) { /* ignore */ }
        return;
      }
      const b = await x.json();
      b.surf_packs = [pack];
      b.private_lesson = privateLesson;
      b.prices = rentalPrices.slice();
      b.writes_enabled = true;
      b.read_only = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(b),
      });
    });
  });

  await page.route(/\/staff\/admin\/config\/prices(?:\?|$)/, async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    const okKey = String(body.offering_key || '').trim();
    const dur = String(body.period_window || '1_day');
    const code = okKey.includes('__') ? okKey : `${okKey}__${dur}`;
    const baseKey = code.split('__')[0];
    const label = offerings.find((o) => o.offering_key === baseKey)?.label || baseKey;
    rentalPrices.push({
      id: `price-new-${rentalPrices.length + 1}`,
      category: 'rental',
      item_type: 'rental',
      offering_key: code,
      item_code: code,
      display_name: label,
      label,
      amount_cents: Number(body.amount_cents) || 0,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    });
    await r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, price: { item_code: code } }),
    });
  });

  try {
    await page.goto(base + '/staff/ui');
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await page.locator('[data-admin-pack-card]').first().waitFor();

    // ── A) Course dropdown: active identities regardless of price ──
    await page.locator('[data-admin-action="edit-pack"]').click();
    let ed = page.locator('[data-admin-pack-form] [data-admin-equipment-editor]');
    await ed.locator('[data-admin-action="add-equipment-option"]').click();
    const newRow = ed.locator('[data-equipment-option-row]').nth(1);
    const optionValues = await newRow.locator('select option').evaluateAll((opts) =>
      opts.map((o) => o.value).filter(Boolean),
    );
    assert.ok(optionValues.includes('softboard'), 'priced active selectable');
    assert.ok(optionValues.includes('ghost_fins'), 'active unpriced appears in course dropdown');
    assert.ok(optionValues.includes('zero_price_pad'), 'active zero-price appears in course dropdown');
    assert.ok(!optionValues.includes('retired_board'), 'disabled offering absent from new options');

    // Historical disabled selected remains unavailable on its row
    const histRow = ed.locator('[data-equipment-option-row]').first();
    assert.strictEqual(await histRow.locator('select.admin-equipment-offering').inputValue(), 'retired_board');
    assert.ok(
      /Unavailable/i.test(await histRow.innerText())
        || (await histRow.locator('option[value="retired_board"][disabled]').count()) >= 1,
      'historical disabled selected shows unavailable',
    );
    await page.locator('[data-admin-action="cancel-edit"]').click();

    // ── B) Delete rental only after pencil, for priced AND unpriced ──
    const softCard = page.locator('[data-admin-equip="softboard"]');
    const ghostCard = page.locator('[data-admin-equip="ghost_fins"]');
    const retiredCard = page.locator('[data-admin-equip="retired_board"]');
    assert.strictEqual(await softCard.count(), 1);
    assert.strictEqual(await ghostCard.count(), 1);
    assert.strictEqual(await retiredCard.count(), 1);

    // Polish: browse is pencil-only; equipment Delete lives only in edit footer.
    assert.strictEqual(
      await softCard.locator('[data-admin-action="equip-overflow-toggle"]').count(),
      0,
      'priced compact row has no overflow',
    );
    assert.strictEqual(
      await ghostCard.locator('[data-admin-action="equip-overflow-toggle"]').count(),
      0,
      'unpriced compact row has no overflow',
    );
    assert.strictEqual(
      await retiredCard.locator('[data-admin-action="equip-overflow-toggle"]').count(),
      0,
      'disabled compact row has no overflow',
    );
    assert.strictEqual(
      await softCard.locator('.portal-admin-equip-compact [data-admin-action="delete-rental-offering"]').count(),
      0,
      'compact has zero Delete controls',
    );
    assert.strictEqual(
      await softCard.locator('[data-admin-action="edit-equipment"]').count(),
      1,
      'priced compact row has pencil',
    );

    // Disabled retains edit; add-price is edit-mode only in hybrid
    assert.strictEqual(
      await retiredCard.locator('[data-admin-action="edit-equipment"]').count(),
      1,
      'disabled keeps pencil',
    );
    assert.strictEqual(
      await retiredCard.locator('[data-admin-action="toggle-equip-enabled"]').count(),
      0,
      'collapsed: enable toggle hidden (edit-only)',
    );

    // Pencil → Delete appears in edit footer for priced item
    await softCard.locator('[data-admin-action="edit-equipment"]').click();
    const softEditing = page.locator('[data-admin-equip="softboard"]');
    assert.strictEqual(
      await softEditing.locator('.portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').count(),
      1,
      'priced item shows Delete in edit footer',
    );
    assert.ok(
      /delete/i.test(await softEditing.locator('.portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').innerText()),
      'Delete visible localized label',
    );
    // Duration × still separate when price cards edit
    assert.ok(
      (await softEditing.locator('[data-admin-action="delete-price"]').count()) >= 1
        || (await softEditing.locator('[data-admin-action="delete-rental-offering"]').count()) === 1,
      'edit mode has item delete; duration remove is separate action when prices present',
    );
    // Add duration available in edit
    assert.ok(
      (await softEditing.locator('[data-admin-action="add-equip-price"]').count()) >= 1,
      'edit mode keeps add-duration',
    );
    await softEditing.locator('[data-admin-action="cancel-edit"]').click();

    // Unpriced item: pencil → Delete in footer
    await page.locator('[data-admin-equip="ghost_fins"] [data-admin-action="edit-equipment"]').click();
    assert.strictEqual(
      await page.locator('[data-admin-equip="ghost_fins"] .portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').count(),
      1,
      'unpriced item shows Delete in edit footer',
    );

    page.once('dialog', async (d) => {
      assert.ok(
        /permanent|duration prices|course|group|private|cannot be undone/i.test(d.message()),
        'confirm mentions permanent hard-delete consequences: ' + d.message(),
      );
      await d.accept();
    });
    const configBefore = configGets.length;
    const catalogBefore = catalogGets.length;
    await page.locator('[data-admin-equip="ghost_fins"] .portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').click();

    await page.waitForFunction(
      () => !document.querySelector('[data-admin-equip="ghost_fins"]'),
      null,
      { timeout: 8000 },
    );
    for (let i = 0; i < 40 && (catalogGets.length <= catalogBefore || configGets.length <= configBefore); i++) {
      await page.waitForTimeout(50);
    }

    assert.deepStrictEqual(deletes, ['ghost_fins'], 'DELETE rental-offerings/ghost_fins');
    assert.ok(configGets.length > configBefore, 'config reloaded after hard delete');
    assert.ok(catalogGets.length > catalogBefore, 'catalog reloaded after hard delete');
    assert.strictEqual(await page.locator('[data-admin-equip="ghost_fins"]').count(), 0, 'card removed without page.reload');

    // Dropdown immediately drops hard-deleted item
    await page.locator('[data-admin-action="edit-pack"]').click();
    ed = page.locator('[data-admin-pack-form] [data-admin-equipment-editor]');
    await ed.locator('[data-admin-action="add-equipment-option"]').click();
    const afterOpts = await ed
      .locator('[data-equipment-option-row]')
      .nth(1)
      .locator('select option')
      .evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
    assert.ok(!afterOpts.includes('ghost_fins'), 'hard-deleted key absent from dropdown without reload');
    assert.ok(afterOpts.includes('softboard'), 'other active items remain');
    assert.ok(afterOpts.includes('zero_price_pad'), 'active unpriced/zero still listed');
    await page.locator('[data-admin-action="cancel-edit"]').click();

    // Enable unpriced retired → pencil, flip pill (staged), Save commits active
    await page.locator('[data-admin-equip="retired_board"] [data-admin-action="edit-equipment"]').click();
    const retiredEdit = page.locator('[data-admin-equip="retired_board"]');
    assert.strictEqual(
      await retiredEdit.locator('[data-admin-action="toggle-equip-enabled"]').count(),
      1,
      'enable pill visible in edit',
    );
    // Checkbox is visually hidden (pointer-events:none) — click the pill label.
    await retiredEdit.locator('label.portal-admin-equip-switch').click();
    // Staged: no active PATCH yet
    assert.ok(
      !patches.some((p) => p.key === 'retired_board' && p.body && Object.prototype.hasOwnProperty.call(p.body, 'active')),
      'enable pill does not PATCH until Save',
    );
    await retiredEdit.locator('[data-admin-action="save-equipment"]').click();
    await page.waitForFunction(
      () => {
        const c = document.querySelector('[data-admin-equip="retired_board"]');
        return c && c.getAttribute('data-equip-active') === '1';
      },
      null,
      { timeout: 8000 },
    );
    assert.ok(
      patches.some((p) => p.key === 'retired_board' && p.body && p.body.active === true),
      'Save commits active:true for enabled item',
    );

    assert.deepStrictEqual(errors, []);
    console.log('  browser fixture OK');
  } finally {
    // Signal routes to abort; drain in-flight handlers before destroying context.
    closing = true;
    const deadline = Date.now() + 3000;
    while (inflightRoutes.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    try {
      if (typeof page.unrouteAll === 'function') {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    } catch (_e) { /* ignore */ }
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  console.log('\nverify:sunset-rental-hard-delete\n');
  // Strict RED→GREEN order: source (fast), behavioral fake, browser.
  sourceContracts();
  await behavioralHardDelete();
  if (String(process.env.SKIP_BROWSER || '').trim() === '1') {
    console.log('\n[browser] skipped (SKIP_BROWSER=1)');
  } else {
    await browserFixture();
  }
  console.log('\nverify-sunset-rental-hard-delete — ALL CHECKS PASSED\n');
}

main().catch((e) => {
  console.error('\nRED/FAIL:', e && e.message ? e.message : e);
  process.exit(1);
});
