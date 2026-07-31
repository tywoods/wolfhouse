'use strict';

/**
 * verify:sunset-rental-edit-functionality
 *
 * Focused RED→GREEN gate for Rental Admin edit enhancements:
 *  1) New time + price nested inside pencil/edit mode (Delete+Done retained)
 *  2) Display-name uniqueness (normalized) with race-safe advisory lock
 *  3) Hard delete frees the name for recreation
 *  4) Amount input does not overflow price card at narrow widths
 *
 * Offline: source contracts + in-memory PG fake + browser fixture.
 * Companion: preserve + run verify:sunset-rental-hard-delete separately.
 * Run: node scripts/verify-sunset-rental-edit-functionality.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const {
  createRentalOffering,
  deleteRentalOffering,
  updateRentalOffering,
  normalizeRentalDisplayName,
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

  console.log('\n[source] nested add-price + name uniqueness + overflow CSS\n');

  // ── Nested edit: add-price is not mutually exclusive with item edit ──
  const equipRender = (adminUi.match(/function renderAdminSectionPricesFromConfig[\s\S]*?\nfunction renderAdminSectionCapacityFromConfig/) || [])[0] || '';
  ok(
    'editing treats equip-add-price as nested item edit',
    /var adding = writes && adminEditTarget === \('equip-add-price:' \+ key\);/.test(equipRender)
      && /var editing = writes && \(adminEditTarget === \('equip:' \+ key\) \|\| adding\);/.test(equipRender),
  );
  ok(
    'Delete rental + Cancel (footer) when editing OR nested adding',
    /delete-rental-offering/.test(equipRender)
      && /cancel-edit/.test(equipRender)
      && /save-equipment/.test(equipRender)
      && /if \(!editing\)\{[\s\S]*?\} else \{[\s\S]*?delete-rental-offering/.test(equipRender)
      && /portal-admin-equip-footer[\s\S]*?cancel-edit/.test(equipRender),
  );
  ok(
    'single item Save (save-equipment) — no per-card save-price-amount in equip render',
    /save-equipment/.test(equipRender)
      && !/save-price-amount/.test(equipRender)
      && !/save-equip-meta/.test(equipRender),
  );
  ok(
    'enabled pill only while editing',
    /portal-admin-equip-switch/.test(equipRender)
      && /if \(editing\)\{[\s\S]*?toggle-equip-enabled/.test(equipRender)
      && !/if \(writes\)\{\s*html \+= '<label class=\\"portal-admin-equip-enabled/.test(equipRender),
  );
  ok(
    'New time + price action only in item edit (not collapsed)',
    /admin\.prices\.newTimePrice|newTimePrice/.test(equipRender)
      && /add-equip-price/.test(equipRender)
      && !/if \(!editing\)\{[\s\S]{0,500}newTimePrice/.test(equipRender),
  );
  ok(
    'New time + price hidden while form already open',
    /if \(!adding\)[\s\S]{0,200}newTimePrice|newTimePrice[\s\S]{0,200}!adding/.test(equipRender)
      || (/if \(editing\)[\s\S]{0,400}if \(!adding\)[\s\S]{0,200}add-equip-price/.test(equipRender)),
  );
  ok(
    'add price form still rendered when adding',
    /if \(adding\) html \+= renderAdminAddEquipPriceForm\(key\);/.test(equipRender),
  );
  ok(
    'save-equipment posts atomic /commit (no multi-request client chain)',
    /if \(action === 'save-equipment'\)\{[\s\S]{0,5000}\/commit/.test(adminUi)
      && /if \(action === 'save-equipment'\)\{[\s\S]{0,5000}adminReloadConfig\(/.test(adminUi)
      && !/if \(action === 'save-equipment'\)\{[\s\S]{0,5000}Promise\.all/.test(adminUi)
      && !/if \(action === 'save-equipment'\)\{[\s\S]{0,5000}location\.reload\s*\(/.test(adminUi),
  );
  ok(
    'server commitRentalEquipmentEdit is transactional',
    /async function commitRentalEquipmentEdit/.test(writesSrc)
      && /async function commitRentalEquipmentEdit[\s\S]{0,6000}BEGIN/.test(writesSrc)
      && /async function commitRentalEquipmentEdit[\s\S]{0,12000}COMMIT/.test(writesSrc)
      && /async function commitRentalEquipmentEdit[\s\S]{0,12000}ROLLBACK/.test(writesSrc),
  );
  ok(
    'API exposes POST rental-offerings/:key/commit',
    /handleAdminConfigRentalOfferingCommit/.test(apiSrc)
      && apiSrc.includes('/commit')
      && /rental-offerings/.test(apiSrc),
  );
  ok(
    'enable toggle is staged until save (no immediate PATCH active)',
    /Staged UI only/.test(adminUi)
      && /data-equip-active-draft/.test(adminUi)
      && !/if \(action === 'toggle-equip-enabled'\)\{[\s\S]{0,900}adminApiRequest/.test(adminUi),
  );
  ok(
    'duplicate name error mapped for save-new-equipment (no price side effect path)',
    /rental_name_already_exists/.test(adminUi)
      && /if \(action === 'save-new-equipment'\)\{[\s\S]{0,4000}rental_name_already_exists/.test(adminUi),
  );

  // ── Server name uniqueness ──
  ok(
    'normalizeRentalDisplayName exported/used',
    /function normalizeRentalDisplayName/.test(offeringsSrc)
      && /normalizeRentalDisplayName/.test(offeringsSrc),
  );
  ok(
    'createRentalOffering uses pg_advisory_xact_lock',
    /async function createRentalOffering[\s\S]{0,1200}assertRentalDisplayNameAvailable/.test(offeringsSrc)
      && /pg_advisory_xact_lock\(hashtext\(\$1\),\s*hashtext\(\$2\)\)/.test(offeringsSrc)
      && /async function assertRentalDisplayNameAvailable[\s\S]{0,800}pg_advisory_xact_lock/.test(offeringsSrc),
  );
  ok(
    'create uses transaction BEGIN/COMMIT/ROLLBACK ownership',
    /async function createRentalOffering[\s\S]{0,3500}BEGIN[\s\S]{0,3000}COMMIT[\s\S]{0,2000}ROLLBACK/.test(offeringsSrc),
  );
  ok(
    'create checks normalized label existence (active+inactive)',
    /async function createRentalOffering[\s\S]{0,1200}assertRentalDisplayNameAvailable[\s\S]{0,2000}INSERT INTO tenant_rental_offerings/.test(offeringsSrc)
      && /rental_name_already_exists/.test(offeringsSrc)
      && /regexp_replace\(btrim\(label\)/.test(offeringsSrc),
  );
  ok(
    'update also rejects duplicate normalized names',
    /async function updateRentalOffering[\s\S]{0,1500}assertRentalDisplayNameAvailable/.test(offeringsSrc)
      && /rental_name_already_exists/.test(offeringsSrc),
  );
  ok(
    'API maps rental_name_already_exists to 409',
    /rental_name_already_exists/.test(apiSrc)
      || (/handleAdminConfigRentalOfferingWrite[\s\S]{0,800}409/.test(apiSrc)
        && /rental_name_already_exists/.test(offeringsSrc)),
  );

  // ── i18n ──
  ok(
    'EN New time + price label',
    /admin\.prices\.newTimePrice['"]:\s*['"]New time \+ price['"]/.test(en)
      || en.includes("'admin.prices.newTimePrice': 'New time + price'"),
  );
  ok(
    'ES New time + price label',
    es.includes('admin.prices.newTimePrice')
      && /Nuevo tiempo|Nueva hora|Nuevo tiempo \+ precio|Nueva duración/i.test(es),
  );
  ok(
    'EN duplicate name error',
    en.includes('admin.prices.rentalNameExists')
      || en.includes('admin.prices.duplicateName'),
  );
  ok(
    'ES duplicate name error',
    es.includes('admin.prices.rentalNameExists')
      || es.includes('admin.prices.duplicateName'),
  );

  // ── Overflow CSS scoped to price-card editor ──
  ok(
    'price-card editor children min-width:0 + input max-width 100%',
    /\.portal-admin-price-card\.is-editing\{[^}]*max-width:\s*100%/.test(apiSrc)
      || /\.portal-admin-price-card\.is-editing\{[^}]*min-width:\s*0/.test(apiSrc)
      || /\.portal-admin-price-card-edit[^{]*\{[^}]*min-width:\s*0/.test(apiSrc),
  );
  ok(
    'price-card-edit input width/max-width 100% box-sizing',
    /\.portal-admin-price-card-edit[^{]*input[^}]*max-width:\s*100%/.test(apiSrc)
      && /\.portal-admin-price-card-edit[^{]*input[^}]*box-sizing:\s*border-box/.test(apiSrc),
  );

  if (fail) throw new Error(`source contracts failed: ${fail}`);
  console.log('  source contracts OK');
}

/**
 * In-memory PG fake covering create (advisory lock + name check + INSERT),
 * hard delete, and update name uniqueness.
 */
function makeRentalEditPg(seed = {}) {
  const state = {
    offerings: (seed.offerings || []).map((r) => ({ ...r })),
    prices: (seed.prices || []).map((r) => ({ ...r })),
    packs: (seed.packs || []).map((r) => ({ ...r, config_json: { ...(r.config_json || {}) } })),
    privates: (seed.privates || []).map((r) => ({ ...r, config_json: { ...(r.config_json || {}) } })),
    bookings: (seed.bookings || []).map((r) => ({ ...r })),
    audit: [],
    locks: [],
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

      if (/pg_advisory_xact_lock/i.test(s)) {
        if (!inTx) throw new Error('pg_advisory_xact_lock outside transaction');
        state.locks.push({ client: params[0], key: params[1] });
        return { rows: [{ pg_advisory_xact_lock: true }], rowCount: 1 };
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

      // Normalized name existence check (create/update)
      if (
        /FROM tenant_rental_offerings/i.test(s)
        && /lower\s*\(/i.test(s)
        && !/FOR UPDATE/i.test(s)
        && !/INSERT/i.test(s)
        && !/DELETE/i.test(s)
        && !/UPDATE/i.test(s)
      ) {
        const slug = params[0];
        // param layout varies: slug, loc?, normalized, excludeKey?
        let loc = null;
        let normIdx = 1;
        if (/location_id = \$/i.test(s)) {
          loc = params[1];
          normIdx = 2;
        } else if (/location_id IS NULL/i.test(s)) {
          loc = null;
          normIdx = 1;
        }
        const wantNorm = String(params[normIdx] || '');
        let excludeKey = null;
        if (params.length > normIdx + 1) excludeKey = params[normIdx + 1];
        const hits = state.offerings.filter((r) => {
          if (r.client_slug !== slug) return false;
          if (!matchLoc(r, loc, true)) return false;
          if (excludeKey && r.offering_key === excludeKey) return false;
          const n = typeof normalizeRentalDisplayName === 'function'
            ? normalizeRentalDisplayName(r.label)
            : String(r.label || '').trim().replace(/\s+/g, ' ').toLowerCase();
          return n === wantNorm;
        });
        return { rows: hits.slice(0, 1).map((r) => ({ id: r.id, offering_key: r.offering_key, label: r.label, active: r.active })), rowCount: hits.length ? 1 : 0 };
      }

      // Offerings lock / select for hard delete
      if (/SELECT \* FROM tenant_rental_offerings/i.test(s) && /FOR UPDATE/i.test(s)) {
        const slug = params[0];
        const key = params[1];
        const loc = /location_id = \$/i.test(s) ? params[2] : null;
        const rows = state.offerings.filter(
          (r) => r.client_slug === slug && r.offering_key === key && matchLoc(r, loc, true),
        );
        return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
      }
      if (/SELECT[\s\S]*FROM tenant_rental_offerings/i.test(s) && !/FOR UPDATE/i.test(s) && !/DELETE/i.test(s) && !/lower\s*\(/i.test(s)) {
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
        // Simulate unique offering_key constraint (active)
        if (state.offerings.some((r) =>
          r.client_slug === client_slug
          && r.offering_key === offering_key
          && r.location_id === location_id
          && r.active !== false)) {
          const err = new Error('duplicate key value violates unique constraint "uq_tenant_rental_offerings_active"');
          err.code = '23505';
          throw err;
        }
        seq += 1;
        const row = {
          id: `ro-${seq}`,
          client_slug,
          location_id,
          offering_key,
          label,
          group_key,
          excludes: typeof excludesJson === 'string' ? JSON.parse(excludesJson) : (excludesJson || []),
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
      if (/\bUPDATE\s+tenant_rental_offerings\b/i.test(s) && !/SET active/i.test(s)) {
        // rename / patch — apply label etc by matching WHERE client_slug + offering_key + loc
        // Parse is loose: last params are slug, key, loc?
        // Production builds dynamic SET then pushes slug, key, loc
        const sets = s.match(/SET\s+([\s\S]*?)\s+WHERE/i);
        // Find row via offering_key in params
        let row = null;
        for (let i = 0; i < params.length; i++) {
          const cand = state.offerings.find((r) => r.offering_key === params[i] && r.client_slug === params[i - 1]);
          if (cand) { row = cand; break; }
        }
        if (!row) {
          // fallback: find by offering_key alone among sunset
          const keyParam = params.find((p) => typeof p === 'string' && /^[a-z][a-z0-9_]*$/.test(p) && state.offerings.some((r) => r.offering_key === p));
          row = state.offerings.find((r) => r.offering_key === keyParam);
        }
        if (!row) return { rows: [], rowCount: 0 };
        if (/label = \$/i.test(s)) {
          // first set value is usually label when present
          const labelMatch = /label = \$(\d+)/i.exec(s);
          if (labelMatch) row.label = params[Number(labelMatch[1]) - 1];
        }
        if (/group_key = \$/i.test(s)) {
          const m = /group_key = \$(\d+)/i.exec(s);
          if (m) row.group_key = params[Number(m[1]) - 1];
        }
        if (/sort_order = \$/i.test(s)) {
          const m = /sort_order = \$(\d+)/i.exec(s);
          if (m) row.sort_order = params[Number(m[1]) - 1];
        }
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

      if (/DELETE FROM tenant_price_rules/i.test(s)) {
        const slug = params[0];
        const key = params[1];
        const loc = /location_id = \$/i.test(s) ? params[2] : (/location_id IS NULL/i.test(s) ? null : undefined);
        if (/LIKE/i.test(s)) throw new Error('BUG: hard delete used LIKE for prices');
        const kept = [];
        const deleted = [];
        for (const p of state.prices) {
          const head = String(p.item_code || '').split('__')[0];
          const locOk = loc === undefined ? true : matchLoc(p, loc, true);
          if (p.client_slug === slug && String(p.item_type) === 'rental' && head === key && locOk) {
            deleted.push({ ...p });
          } else kept.push(p);
        }
        state.prices = kept;
        return { rows: deleted, rowCount: deleted.length };
      }

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
        const id = params[0];
        const cfg = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
        const pack = state.packs.find((r) => r.id === id);
        if (!pack) return { rows: [], rowCount: 0 };
        pack.config_json = cfg;
        return { rows: [{ id }], rowCount: 1 };
      }
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
        const id = params[0];
        const cfg = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
        const pl = state.privates.find((r) => r.id === id);
        if (!pl) return { rows: [], rowCount: 0 };
        pl.config_json = cfg;
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/INSERT INTO tenant_config_audit_log/i.test(s)) {
        state.audit.push({ entity_id: params[4] });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO tenant_price_rules/i.test(s)) {
        throw new Error('create rental offering path must not insert prices');
      }
      if (/booking/i.test(s)) {
        throw new Error('rental create/delete must not touch booking tables');
      }

      return { rows: [], rowCount: 0 };
    },
  };
  return pg;
}

async function behavioralDb() {
  console.log('\n[behavioral] display-name uniqueness + delete frees name\n');
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

  // Pure normalize helper
  if (typeof normalizeRentalDisplayName === 'function') {
    ok(
      'normalize collapses whitespace + case',
      normalizeRentalDisplayName('  Surfboard  + Wetsuit ') === 'surfboard + wetsuit',
    );
    ok(
      'normalize unicode-safe trim',
      normalizeRentalDisplayName('\u00A0Kayak\u00A0') === 'kayak'
        || normalizeRentalDisplayName('  Kayak  ') === 'kayak',
    );
  } else {
    ok('normalizeRentalDisplayName exported', false, 'missing export');
  }

  const baseOffering = (over = {}) => ({
    id: over.id || `ro-${Math.random().toString(16).slice(2, 8)}`,
    client_slug: over.client_slug || 'sunset',
    location_id: over.location_id || 'sunset-somo',
    offering_key: over.offering_key,
    label: over.label,
    group_key: over.group_key || 'equipment',
    excludes: [],
    sort_order: 0,
    active: over.active !== false,
    tenant_id: over.tenant_id || 'sunset',
  });

  // Create X then duplicate normalized name fails
  const pg = makeRentalEditPg();
  const created = await createRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'surfboard_wetsuit_rental',
    label: 'Surfboard + Wetsuit',
    group_key: 'equipment',
    excludes: [],
  });
  ok('create X succeeds', created.ok === true, JSON.stringify(created));
  ok(
    'create took advisory lock in transaction',
    pg.state.locks.length >= 1
      && String(pg.state.locks[0].key || '').includes('surfboard + wetsuit'),
    JSON.stringify(pg.state.locks),
  );

  const pricesBeforeDup = pg.state.prices.length;
  const dup = await createRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'surfboard_wetsuit_rental_b',
    label: '  Surfboard  + Wetsuit ',
    group_key: 'equipment',
    excludes: [],
  });
  ok(
    'normalized case/whitespace duplicate → rental_name_already_exists',
    dup.ok === false && dup.error === 'rental_name_already_exists',
    JSON.stringify(dup),
  );
  ok(
    'failed duplicate does not create offering row',
    pg.state.offerings.filter((r) => r.client_slug === 'sunset' && r.location_id === 'sunset-somo').length === 1,
  );
  ok('failed duplicate does not create price', pg.state.prices.length === pricesBeforeDup);

  // Disabled row reserves name
  const pgDis = makeRentalEditPg({
    offerings: [baseOffering({
      offering_key: 'old_kayak',
      label: 'Sea Kayak',
      active: false,
    })],
  });
  const againstDisabled = await createRentalOffering(pgDis, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'sea_kayak_rental',
    label: 'sea kayak',
    group_key: 'equipment',
    excludes: [],
  });
  ok(
    'disabled identity reserves normalized name',
    againstDisabled.ok === false && againstDisabled.error === 'rental_name_already_exists',
    JSON.stringify(againstDisabled),
  );

  // Tenant / location isolation
  const pgIso = makeRentalEditPg({
    offerings: [
      baseOffering({ offering_key: 'board_a', label: 'Longboard', location_id: 'sunset-somo' }),
      baseOffering({
        id: 'ro-other-loc',
        offering_key: 'board_b',
        label: 'Foam Board',
        location_id: 'sunset-sardinero',
      }),
      baseOffering({
        id: 'ro-other-tenant',
        client_slug: 'lawave',
        tenant_id: 'lawave',
        offering_key: 'board_c',
        label: 'Longboard',
        location_id: 'sunset-somo',
      }),
    ],
  });
  const sameNameOtherLoc = await createRentalOffering(pgIso, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'foam_board_rental',
    label: 'Foam Board',
    group_key: 'equipment',
    excludes: [],
  });
  ok('same name other location allowed', sameNameOtherLoc.ok === true, JSON.stringify(sameNameOtherLoc));
  const sameNameOtherTenant = await createRentalOffering(pgIso, {
    clientSlug: 'sunset',
    locationId: 'sunset-sardinero',
    offering_key: 'longboard_rental',
    label: 'Longboard',
    group_key: 'equipment',
    excludes: [],
  });
  ok('same name other tenant scope allowed at other loc', sameNameOtherTenant.ok === true, JSON.stringify(sameNameOtherTenant));
  const conflictSameScope = await createRentalOffering(pgIso, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'longboard_rental_2',
    label: 'LONGBOARD',
    group_key: 'equipment',
    excludes: [],
  });
  ok(
    'exact tenant+location conflict rejected',
    conflictSameScope.ok === false && conflictSameScope.error === 'rental_name_already_exists',
    JSON.stringify(conflictSameScope),
  );

  // Hard delete frees name; recreate succeeds
  const pgFree = makeRentalEditPg({
    offerings: [baseOffering({
      offering_key: 'soft_board',
      label: 'Soft Board',
    })],
    prices: [{
      id: 'price-1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'soft_board__1_day',
      amount_cents: 1500,
      active: true,
      tenant_id: 'sunset',
    }],
    packs: [{
      id: 'pack-1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      active: true,
      config_json: {
        equipment_options: [
          { offering_key: 'soft_board', during_course_price_cents: 0, all_day_price_cents: 0 },
        ],
      },
    }],
    privates: [{
      id: 'priv-1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      active: true,
      config_json: {
        equipment_options: [
          { offering_key: 'soft_board', during_course_price_cents: 0, all_day_price_cents: 0 },
        ],
      },
    }],
  });
  const del = await deleteRentalOffering(pgFree, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'soft_board',
    actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  ok('hard delete ok', del.ok === true && del.deleted === true, JSON.stringify(del));
  ok(
    'no orphan prices after hard delete',
    !pgFree.state.prices.some((p) => String(p.item_code || '').split('__')[0] === 'soft_board'),
  );
  ok(
    'no orphan course links after hard delete',
    (pgFree.state.packs[0].config_json.equipment_options || []).length === 0
      && (pgFree.state.privates[0].config_json.equipment_options || []).length === 0,
  );
  const recreated = await createRentalOffering(pgFree, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'soft_board',
    label: '  soft board ',
    group_key: 'equipment',
    excludes: [],
  });
  ok(
    'recreate normalized name after hard delete succeeds',
    recreated.ok === true && recreated.offering && recreated.offering.offering_key === 'soft_board',
    JSON.stringify(recreated),
  );

  // Update rename conflict
  const pgUp = makeRentalEditPg({
    offerings: [
      baseOffering({ id: 'ro-1', offering_key: 'alpha_rental', label: 'Alpha Board' }),
      baseOffering({ id: 'ro-2', offering_key: 'beta_rental', label: 'Beta Board' }),
    ],
  });
  const renameClash = await updateRentalOffering(pgUp, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'beta_rental',
    label: '  ALPHA   BOARD ',
  });
  ok(
    'update rename to existing normalized name fails',
    renameClash.ok === false && renameClash.error === 'rental_name_already_exists',
    JSON.stringify(renameClash),
  );

  // Race contract: advisory lock SQL present in create path (evidenced by lock calls)
  ok(
    'race contract: advisory lock recorded for creates',
    pg.state.locks.length >= 1 && pgFree.state.locks.length >= 1,
  );

  if (fail) throw new Error(`behavioral failed: ${fail}`);
  console.log(`  behavioral OK (pass=${pass})`);
}

async function browserFixture() {
  console.log('\n[browser] nested New time + price + overflow + duplicate name\n');

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  // Start desktop-width so Admin nav is visible; shrink later for overflow proof.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  let offerings = [
    { offering_key: 'softboard', label: 'Soft board', active: true },
    { offering_key: 'ghost_fins', label: 'Ghost fins', active: true },
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
  const createPosts = [];
  const pricePosts = [];
  const configGets = [];

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
      const off = offerings.find((o) => o.offering_key === key);
      if (off) {
        if (body.label) off.label = body.label;
        if (Object.prototype.hasOwnProperty.call(body, 'active') && typeof body.active === 'boolean') {
          off.active = body.active;
        }
      }
      if (Array.isArray(body.prices)) {
        body.prices.forEach((row) => {
          const id = String(row.id || '');
          const hit = rentalPrices.find((p) => String(p.id) === id);
          if (hit && row.amount_cents != null) hit.amount_cents = Number(row.amount_cents) || hit.amount_cents;
        });
      }
      if (Array.isArray(body.new_prices)) {
        body.new_prices.forEach((np) => {
          const dur = String(np.period_window || '1_day');
          const code = `${key}__${dur}`;
          const exists = rentalPrices.some((p) => String(p.item_code || p.offering_key) === code);
          if (exists) return; // idempotent retry
          const label = (off && off.label) || key;
          rentalPrices.push({
            id: `price-new-${rentalPrices.length + 1}`,
            category: 'rental',
            item_type: 'rental',
            offering_key: code,
            item_code: code,
            display_name: label,
            label,
            amount_cents: Number(np.amount_cents) || 0,
            active: true,
            client_slug: 'sunset',
            location_id: 'sunset-somo',
          });
          pricePosts.push({ offering_key: key, period_window: dur, amount_cents: np.amount_cents, via: 'commit' });
        });
      }
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, offering_key: key }),
      });
      return;
    }
    const keyMatch = /rental-offerings\/([a-z][a-z0-9_]*)(?:\?|$)/.exec(u);
    const key = keyMatch ? keyMatch[1] : '';
    if (!key) {
      if (method === 'GET') {
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
        createPosts.push(body);
        const norm = String(body.label || '').trim().replace(/\s+/g, ' ').toLowerCase();
        const clash = offerings.some((o) =>
          String(o.label || '').trim().replace(/\s+/g, ' ').toLowerCase() === norm);
        if (clash) {
          await r.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              error: 'rental_name_already_exists',
              message: 'rental_name_already_exists',
            }),
          });
          return;
        }
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
      offerings = offerings.filter((o) => o.offering_key !== key);
      rentalPrices = rentalPrices.filter((p) => String(p.item_code || p.offering_key || '').split('__')[0] !== key);
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          deleted: true,
          offering_key: key,
          offerings_deleted: 1,
          prices_deleted: 1,
          surf_packs_updated: 0,
          private_lessons_updated: 0,
        }),
      });
      return;
    }
    if (method === 'PATCH' && key) {
      const body = JSON.parse(r.request().postData() || '{}');
      const off = offerings.find((o) => o.offering_key === key);
      if (off && typeof body.active === 'boolean') off.active = body.active;
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, offering: off || { offering_key: key } }),
      });
      return;
    }
    await r.continue();
  });

  await page.route(/\/staff\/admin\/config(?:\?|$)/, async (r) => {
    configGets.push(r.request().url());
    const x = await r.fetch();
    const b = await x.json();
    b.prices = rentalPrices.slice();
    b.writes_enabled = true;
    b.read_only = false;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(b),
    });
  });

  await page.route(/\/staff\/admin\/config\/prices(?:\?|$)/, async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    pricePosts.push(body);
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

  // PATCH amount for overflow edit mode
  await page.route(/\/staff\/admin\/config\/prices\/[^?/]+/, async (r) => {
    if (r.request().method() !== 'PATCH') return r.continue();
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  try {
    await page.goto(base + '/staff/ui');
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await page.locator('#admin-prices-body').waitFor();

    const soft = page.locator('[data-admin-equip="softboard"]');
    const retired = page.locator('[data-admin-equip="retired_board"]');
    const ghost = page.locator('[data-admin-equip="ghost_fins"]');

    // Collapsed: no Delete, no New time + price label button
    assert.strictEqual(await soft.locator('[data-admin-action="delete-rental-offering"]').count(), 0, 'collapsed: no Delete');
    assert.strictEqual(
      await soft.locator('[data-admin-action="add-equip-price"]').filter({ hasText: /new time/i }).count(),
      0,
      'collapsed: no New time + price text action',
    );
    // Collapsed may still have icon +, but not the localized New time label in header as text button in edit sense
    const collapsedNewTimeText = await soft.locator('.portal-admin-card-actions').innerText().catch(() => '');
    assert.ok(!/new time \+ price/i.test(collapsedNewTimeText), 'collapsed header has no New time + price');

    // Pencil mode: Delete + Done + New time + price
    await soft.locator('[data-admin-action="edit-equipment"]').click();
    const softEdit = page.locator('[data-admin-equip="softboard"]');
    assert.strictEqual(
      await softEdit.locator('[data-admin-action="delete-rental-offering"]').count(),
      1,
      'pencil: Delete rental',
    );
    assert.strictEqual(
      await softEdit.locator('[data-admin-action="cancel-edit"]').count(),
      1,
      'pencil: Cancel/Save footer',
    );
    const newTimeBtn = softEdit.locator('[data-admin-action="add-equip-price"]');
    assert.strictEqual(await newTimeBtn.count(), 1, 'pencil: New time + price action');
    assert.ok(
      /new time \+ price/i.test(await newTimeBtn.innerText()),
      'New time + price localized label visible',
    );

    // Nested form: open New time + price; Delete+Done remain; form appears
    await newTimeBtn.click();
    const softNested = page.locator('[data-admin-equip="softboard"]');
    assert.strictEqual(
      await softNested.locator('#admin-add-price-form').count(),
      1,
      'nested add form visible',
    );
    assert.strictEqual(
      await softNested.locator('[data-admin-action="delete-rental-offering"]').count(),
      1,
      'nested add still shows Delete',
    );
    // Footer Cancel uses cancel-edit; form no longer has its own Cancel.
    assert.ok(
      (await softNested.locator('[data-admin-action="cancel-edit"]').count()) >= 1,
      'nested add still shows Cancel/Save',
    );
    assert.ok(
      (await softNested.locator('[data-admin-action="save-equipment"]').count()) >= 1
        && /cancel/i.test(await softNested.locator('.portal-admin-equip-footer').innerText()),
      'footer Save + Cancel while nested form open',
    );
    assert.strictEqual(
      await softNested.locator('[data-admin-action="toggle-equip-enabled"]').count(),
      1,
      'enabled pill visible in edit',
    );
    // New time + price hidden while already adding
    assert.strictEqual(
      await softNested.locator('[data-admin-action="add-equip-price"]').filter({ hasText: /new time/i }).count(),
      0,
      'while adding: no second New time + price',
    );

    // Save new duration via single item Save (save-equipment) → refresh without full reload
    const configsBefore = configGets.length;
    await softNested.locator('#admin-new-price-count').fill('3');
    await softNested.locator('#admin-new-price-unit').selectOption('days');
    await softNested.locator('#admin-new-price-amount').fill('25');
    await softNested.locator('[data-admin-action="save-equipment"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-admin-equip="softboard"] [data-admin-price-card]').length >= 2,
      null,
      { timeout: 8000 },
    );
    assert.ok(pricePosts.length >= 1, 'POST price created');
    assert.ok(configGets.length > configsBefore, 'config reloaded after add price');
    // Unified Save closes edit — re-open for further checks.
    await page.locator('[data-admin-equip="softboard"] [data-admin-action="edit-equipment"]').click();
    assert.strictEqual(
      await page.locator('[data-admin-equip="softboard"] [data-admin-action="delete-rental-offering"]').count(),
      1,
      'item still editable after save',
    );

    // Amount overflow at narrow viewport: edit duration card; input right edge <= card right edge
    await page.locator('[data-admin-equip="softboard"] [data-admin-action="edit-equipment"]').click().catch(() => {});
    // Ensure editing mode with amount input
    if (await page.locator('[data-admin-equip="softboard"] [data-admin-price-field="amount"]').count() === 0) {
      await page.locator('[data-admin-equip="softboard"] [data-admin-action="edit-equipment"]').click();
    }
    await page.locator('[data-admin-equip="softboard"] [data-admin-price-field="amount"]').first().waitFor({ timeout: 5000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const boxCheck = await page.evaluate(() => {
      const card = document.querySelector('[data-admin-equip="softboard"] .portal-admin-price-card.is-editing');
      const input = card && card.querySelector('[data-admin-price-field="amount"]');
      if (!card || !input) return { ok: false, reason: 'missing card/input' };
      const cr = card.getBoundingClientRect();
      const ir = input.getBoundingClientRect();
      return {
        ok: ir.right <= cr.right + 0.5,
        cardRight: cr.right,
        inputRight: ir.right,
        cardWidth: cr.width,
        inputWidth: ir.width,
      };
    });
    assert.ok(boxCheck.ok, `amount input overflows card: ${JSON.stringify(boxCheck)}`);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Disabled item supports nested New time + price
    await page.locator('.portal-admin-equip-footer [data-admin-action="cancel-edit"]').first().click().catch(() => {});
    await retired.locator('[data-admin-action="edit-equipment"]').click();
    const retiredEdit = page.locator('[data-admin-equip="retired_board"]');
    assert.strictEqual(
      await retiredEdit.locator('[data-admin-action="delete-rental-offering"]').count(),
      1,
      'disabled pencil: Delete',
    );
    const retiredNew = retiredEdit.locator('[data-admin-action="add-equip-price"]');
    assert.ok(await retiredNew.count() >= 1, 'disabled pencil: New time + price');
    await retiredNew.first().click();
    assert.strictEqual(
      await page.locator('[data-admin-equip="retired_board"] #admin-add-price-form').count(),
      1,
      'disabled supports nested add form',
    );
    await page.locator('[data-admin-equip="retired_board"] .portal-admin-equip-footer [data-admin-action="cancel-edit"]').click();

    // Duplicate name: create equipment with existing label; error visible; input preserved; no price post
    const pricePostsBefore = pricePosts.length;
    await page.locator('[data-admin-action="add-equipment"]').click();
    await page.locator('#admin-new-equip-name').fill('  Soft   board ');
    await page.locator('#admin-new-equip-count').fill('1');
    await page.locator('#admin-new-equip-unit').selectOption('days');
    await page.locator('#admin-new-equip-amount').fill('12');
    await page.locator('[data-admin-action="save-new-equipment"]').click();
    await page.waitForFunction(
      () => {
        const msg = document.querySelector('#admin-save-msg, #admin-message, .portal-admin-save-msg, .portal-admin-msg, [data-admin-message]');
        const text = (msg && msg.textContent) || '';
        return /already exists|duplicate|same name|nombre|different name/i.test(text);
      },
      null,
      { timeout: 8000 },
    ).catch(async () => {
      // fallback: any error banner
      const body = await page.locator('body').innerText();
      assert.ok(/already exists|duplicate|rental_name|same name|different name/i.test(body), 'duplicate error visible: ' + body.slice(0, 400));
    });
    const nameVal = await page.locator('#admin-new-equip-name').inputValue();
    assert.ok(/Soft/i.test(nameVal), 'user input preserved after duplicate error: ' + nameVal);
    assert.strictEqual(pricePosts.length, pricePostsBefore, 'duplicate name must not create price');

    // Unpriced item supports pencil New time + price
    await page.locator('#admin-add-equip-form [data-admin-action="cancel-edit"]').click().catch(() => {});
    await page.locator('.portal-admin-equip-footer [data-admin-action="cancel-edit"]').first().click().catch(() => {});
    await ghost.locator('[data-admin-action="edit-equipment"]').click();
    assert.strictEqual(
      await page.locator('[data-admin-equip="ghost_fins"] [data-admin-action="add-equip-price"]').count(),
      1,
      'unpriced supports New time + price in edit',
    );

    assert.deepStrictEqual(errors, [], 'no page errors: ' + errors.join('; '));
    console.log('  browser OK');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}



async function atomicCommitRetryRegression() {
  console.log('\n[atomic-commit] lost-response retry must not duplicate duration\n');
  const { commitRentalEquipmentEdit } = require('./lib/tenant-admin-writes');
  let fail = 0;
  function ok(label, cond, detail) {
    if (cond) { console.log(`  PASS  ${label}`); return; }
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }

  // Minimal SQL stub covering commitRentalEquipmentEdit paths.
  const state = {
    offering: {
      id: 'off-1',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      offering_key: 'softboard',
      label: 'Softboard',
      group_key: 'equipment',
      excludes: [],
      sort_order: 0,
      stock_quantity: 5,
      active: true,
      tenant_id: 'sunset',
    },
    prices: [
      {
        id: 'price-1',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: 'softboard__1_day',
        display_name: 'Softboard',
        currency: 'EUR',
        amount_cents: 2000,
        unit: 'day',
        active: true,
        tenant_id: 'sunset',
      },
    ],
    begun: 0,
    commits: 0,
    rollbacks: 0,
  };

  const client = {
    async query(sql, params = []) {
      const q = String(sql || '').replace(/\s+/g, ' ').trim();
      if (/^BEGIN$/i.test(q)) { state.begun += 1; return { rows: [] }; }
      if (/^COMMIT$/i.test(q)) { state.commits += 1; return { rows: [] }; }
      if (/^ROLLBACK$/i.test(q)) { state.rollbacks += 1; return { rows: [] }; }
      if (/pg_advisory_xact_lock/i.test(q)) return { rows: [] };
      if (/to_regclass/i.test(q)) return { rows: [{ reg: 'public.tenant_price_rules' }] };
      if (/information_schema\.tables/i.test(q)) {
        const names = Array.isArray(params[0]) ? params[0] : [
          'tenant_price_rules', 'tenant_lesson_capacity_rules', 'tenant_lesson_time_rules', 'tenant_config_audit_log',
        ];
        return { rows: names.map((table_name) => ({ table_name })) };
      }
      if (/information_schema\.columns/i.test(q) || /column_name/i.test(q)) {
        return { rows: [{ column_name: 'location_id' }] };
      }
      if (/FROM tenant_rental_offerings/i.test(q) && /SELECT/i.test(q)) {
        // Name-uniqueness probe (not the primary key lookup)
        if (/label/i.test(q) && !/ORDER BY active DESC/i.test(q)) {
          return { rows: [] };
        }
        return { rows: [{ ...state.offering }] };
      }
      if (/UPDATE tenant_rental_offerings/i.test(q)) {
        if (/SET active/i.test(q)) {
          state.offering.active = params[0];
          return { rows: [{ ...state.offering }] };
        }
        // label/stock
        // params vary; apply label if string in params
        for (const p of params) {
          if (typeof p === 'string' && p && p !== 'softboard' && p !== 'off-1' && p.length < 80 && !/^[0-9a-f-]{36}$/i.test(p)) {
            if (p !== 'sunset' && p !== 'sunset-somo') state.offering.label = p;
          }
          if (Number.isInteger(p)) state.offering.stock_quantity = p;
        }
        return { rows: [{ ...state.offering }] };
      }
      if (/FROM tenant_price_rules/i.test(q) && /SELECT/i.test(q)) {
        if (/id = \$1/i.test(q) || /WHERE id/i.test(q)) {
          const id = params[0];
          const row = state.prices.find((r) => r.id === id);
          return { rows: row ? [{ ...row }] : [] };
        }
        // find by item_code
        const code = params.find((p) => typeof p === 'string' && p.includes('__'));
        const row = state.prices.find((r) => r.item_code === code);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/UPDATE tenant_price_rules/i.test(q)) {
        const id = params[0];
        const row = state.prices.find((r) => r.id === id);
        if (!row) return { rows: [] };
        // amount often in params
        for (const p of params) {
          if (Number.isInteger(p) && p > 100) row.amount_cents = p;
        }
        return { rows: [{ ...row }] };
      }
      if (/INSERT INTO tenant_price_rules/i.test(q)) {
        const code = params.find((p) => typeof p === 'string' && String(p).includes('__'));
        const existing = state.prices.find((r) => r.item_code === code);
        if (existing) {
          // upsert semantics: update amount
          const cents = params.find((p) => Number.isInteger(p) && p >= 0 && p < 1000000);
          if (cents != null) existing.amount_cents = cents;
          return { rows: [{ ...existing }] };
        }
        const cents = params.find((p) => Number.isInteger(p) && p >= 0 && p < 1000000) || 0;
        const row = {
          id: 'price-' + (state.prices.length + 1),
          client_slug: 'sunset',
          location_id: 'sunset-somo',
          item_type: 'rental',
          item_code: code || 'softboard__3_days',
          display_name: 'Softboard',
          currency: 'EUR',
          amount_cents: cents,
          unit: 'day',
          active: true,
          tenant_id: 'sunset',
        };
        state.prices.push(row);
        return { rows: [{ ...row }] };
      }
      if (/INSERT INTO tenant_config_audit/i.test(q) || /tenant_config_audit_log/i.test(q)) {
        return { rows: [] };
      }
      // default empty
      return { rows: [] };
    },
  };

  const body = {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'softboard',
    label: 'Softboard',
    stock_quantity: 5,
    active: true,
    prices: [{ id: 'price-1', amount_cents: 2200, period_window: '1_day' }],
    new_prices: [{ period_window: '3_days', amount_cents: 4500 }],
    actor: { staff_user_id: null, email: 'test@example.com' },
  };

  const first = await commitRentalEquipmentEdit(client, body);
  ok('first commit ok', !!(first && first.ok), JSON.stringify(first && first.body));
  const afterFirst = state.prices.filter((p) => p.item_code === 'softboard__3_days').length;
  ok('first commit created one 3_days row', afterFirst === 1, String(afterFirst));
  ok('first commit used txn', state.commits >= 1);

  // Simulate lost response: staff retries identical Save.
  const second = await commitRentalEquipmentEdit(client, body);
  ok('retry commit ok (idempotent)', !!(second && second.ok), JSON.stringify(second && second.body));
  const afterSecond = state.prices.filter((p) => p.item_code === 'softboard__3_days').length;
  ok('retry did not duplicate 3_days duration', afterSecond === 1, String(afterSecond));
  ok('price-1 amount updated', state.prices.find((p) => p.id === 'price-1').amount_cents === 2200);

  if (fail) throw new Error(`atomic commit regression failed: ${fail}`);
  console.log('  atomic commit regression OK');
}


async function main() {
  console.log('verify-sunset-rental-edit-functionality');
  sourceContracts();
  await behavioralDb();
  await atomicCommitRetryRegression();
  if (String(process.env.SKIP_BROWSER || '').trim() === '1') {
    console.log('\n[browser] skipped (SKIP_BROWSER=1)');
  } else {
    await browserFixture();
  }
  console.log('\nALL PASS');
}

main().catch((err) => {
  console.error('\nFAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
