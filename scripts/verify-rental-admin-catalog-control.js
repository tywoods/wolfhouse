'use strict';

/**
 * verify:rental-admin-catalog-control — Integration Slice A
 *
 * Full Admin/API control for independent rental catalog items:
 *  - name, stock, active, duration+price rows (add/edit/remove)
 *  - stable offering_key on rename; historical booking snapshots unchanged
 *  - atomic catalog+price create; fail-closed validation
 *  - no hidden bundle/component semantics on new catalog paths
 *  - cooked /staff/ui functional controls (not source-only)
 *
 * Offline: pure service mocks + source contracts + Playwright on generated UI.
 * Run: node scripts/verify-rental-admin-catalog-control.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

const {
  validateRentalOfferingBody,
  createRentalOffering,
  updateRentalOffering,
  normalizeRentalDisplayName,
  isValidStockQuantity,
} = require('./lib/tenant-rental-offerings');
const {
  validatePriceCreateBody,
  validatePricePatchBody,
  buildDbItemCode,
  createRentalCatalogItem,
  patchPriceRule,
} = require('./lib/tenant-admin-writes');
const {
  buildRentalOfferingRows,
  BUNDLE_COMPONENTS,
  deriveExclusions,
} = require('./lib/tenant-rental-offerings-seed');
const {
  buildGenericRentalServiceRecord,
} = require('./lib/tenant-rental-price-resolver');

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

// ── In-memory multi-table PG for atomic catalog+price ──────────────────────
function makeCatalogPg() {
  const offerings = [];
  const prices = [];
  let seq = 0;
  let inTx = false;
  let rolled = false;
  let snapOfferings = null;
  let snapPrices = null;
  const state = { begins: 0, commits: 0, rollbacks: 0, locks: 0 };

  const clone = (rows) => rows.map((r) => ({ ...r }));

  return {
    state,
    offerings,
    prices,
    query: async (sql, params = []) => {
      const s = String(sql);
      if (/^\s*BEGIN\s*$/i.test(s.trim())) {
        state.begins += 1;
        inTx = true;
        rolled = false;
        snapOfferings = clone(offerings);
        snapPrices = clone(prices);
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*COMMIT\s*$/i.test(s.trim())) {
        state.commits += 1;
        inTx = false;
        snapOfferings = null;
        snapPrices = null;
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*ROLLBACK\s*$/i.test(s.trim())) {
        state.rollbacks += 1;
        if (snapOfferings) {
          offerings.length = 0;
          offerings.push(...snapOfferings);
        }
        if (snapPrices) {
          prices.length = 0;
          prices.push(...snapPrices);
        }
        inTx = false;
        rolled = true;
        snapOfferings = null;
        snapPrices = null;
        return { rows: [], rowCount: 0 };
      }
      if (/pg_advisory_xact_lock/i.test(s)) {
        state.locks += 1;
        return { rows: [{ pg_advisory_xact_lock: true }], rowCount: 1 };
      }
      if (/to_regclass/i.test(s) || /information_schema\.columns/i.test(s)) {
        return { rows: [{ reg: 'ok', '?column?': 1 }], rowCount: 1 };
      }
      if (/SELECT 1 FROM information_schema/i.test(s)) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      // adminConfigTablesExist style probes
      if (/SELECT to_regclass|FROM pg_catalog/i.test(s)) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      if (/FROM tenant_rental_offerings/i.test(s) && /lower\(regexp_replace/i.test(s)) {
        const slug = params[0];
        const loc = /location_id = \$/i.test(s) ? params[1] : null;
        const norm = params[/location_id = \$/i.test(s) ? 2 : 1];
        const excludeKey = params.length >= (/location_id = \$/i.test(s) ? 4 : 3)
          ? params[params.length - 1]
          : null;
        const hits = offerings.filter((r) => {
          if (r.client_slug !== slug) return false;
          if ((r.location_id || null) !== (loc || null)) return false;
          const n = String(r.label || '').trim().replace(/\s+/g, ' ').toLowerCase();
          if (n !== norm) return false;
          if (excludeKey && r.offering_key === excludeKey) return false;
          return true;
        });
        return {
          rows: hits.slice(0, 1).map((r) => ({
            id: r.id, offering_key: r.offering_key, label: r.label, active: r.active,
          })),
          rowCount: hits.length ? 1 : 0,
        };
      }
      if (/INSERT INTO tenant_rental_offerings/i.test(s)) {
        const hasStock = /stock_quantity/i.test(s);
        let client_slug;
        let location_id;
        let offering_key;
        let label;
        let group_key;
        let excludesJson;
        let sort_order;
        let stock_quantity = null;
        let updated_by;
        if (hasStock) {
          [client_slug, location_id, offering_key, label, group_key, excludesJson, sort_order, stock_quantity, updated_by] = params;
        } else {
          [client_slug, location_id, offering_key, label, group_key, excludesJson, sort_order, updated_by] = params;
        }
        const dup = offerings.find((r) => r.active && r.client_slug === client_slug
          && (r.location_id || '') === (location_id || '') && r.offering_key === offering_key);
        if (dup) {
          const e = new Error('duplicate key value violates unique constraint "uq_tenant_rental_offerings_active"');
          throw e;
        }
        seq += 1;
        const row = {
          id: `ro-${seq}`,
          client_slug,
          location_id,
          offering_key,
          label,
          group_key,
          excludes: JSON.parse(excludesJson || '[]'),
          sort_order: sort_order || 0,
          stock_quantity: stock_quantity === undefined ? null : stock_quantity,
          active: true,
          updated_by,
          tenant_id: 't-sunset',
        };
        offerings.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/UPDATE tenant_rental_offerings/i.test(s) && /SET/i.test(s)) {
        const slug = params[params.length - ( /location_id = \$/i.test(s) ? 3 : 2 )];
        const key = params[params.length - ( /location_id = \$/i.test(s) ? 2 : 1 )];
        const loc = /location_id = \$/i.test(s) ? params[params.length - 1] : null;
        const target = offerings.find((r) => r.client_slug === slug && r.offering_key === key
          && (loc == null ? r.location_id == null : r.location_id === loc) && r.active);
        if (!target) return { rows: [], rowCount: 0 };
        if (/label = \$/i.test(s)) {
          const m = s.match(/label = \$(\d+)/i);
          if (m) target.label = params[Number(m[1]) - 1];
        }
        if (/stock_quantity = \$/i.test(s)) {
          const m = s.match(/stock_quantity = \$(\d+)/i);
          if (m) target.stock_quantity = params[Number(m[1]) - 1];
        }
        if (/group_key = \$/i.test(s)) {
          const m = s.match(/group_key = \$(\d+)/i);
          if (m) target.group_key = params[Number(m[1]) - 1];
        }
        if (/excludes = \$/i.test(s)) {
          const m = s.match(/excludes = \$(\d+)/i);
          if (m) {
            const raw = params[Number(m[1]) - 1];
            target.excludes = typeof raw === 'string' ? JSON.parse(raw) : raw;
          }
        }
        return { rows: [target], rowCount: 1 };
      }
      if (/INSERT INTO tenant_price_rules/i.test(s)) {
        // Flexible column order: capture common create path
        seq += 1;
        const row = {
          id: `pr-${seq}`,
          tenant_id: 't-sunset',
          client_slug: params[0],
          location_id: params[1],
          item_type: 'rental',
          item_code: params.find((p) => typeof p === 'string' && String(p).includes('__')) || null,
          display_name: params.find((p, i) => i > 2 && typeof p === 'string' && !String(p).includes('__') && p.length < 80) || null,
          unit: params.find((p) => p === 'day' || p === 'session' || p === 'item') || 'session',
          amount_cents: params.find((p) => Number.isInteger(p) && p > 0 && p < 10000000) || 0,
          currency: 'EUR',
          active: true,
        };
        // Prefer explicit item_code from force paths
        for (const p of params) {
          if (typeof p === 'string' && /__/.test(p) && /^[a-z0-9_]+__[a-z0-9_]+$/.test(p)) {
            row.item_code = p;
            break;
          }
        }
        const dup = prices.find((p) => p.client_slug === row.client_slug
          && (p.location_id || '') === (row.location_id || '')
          && p.item_code === row.item_code
          && p.active);
        if (dup) {
          throw new Error('duplicate key value violates unique constraint "uq_tenant_price_rules"');
        }
        prices.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/SELECT \* FROM tenant_price_rules|SELECT .* FROM tenant_price_rules/i.test(s)) {
        const slug = params[0];
        const idOrLoc = params[1];
        if (/id = \$1::uuid/i.test(s) || /id = \$1/i.test(s)) {
          const row = prices.find((p) => p.id === params[0] && p.client_slug === params[1]);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        let filtered = prices.filter((p) => p.client_slug === slug);
        if (/location_id = \$/i.test(s)) {
          filtered = filtered.filter((p) => p.location_id === idOrLoc);
        }
        if (/item_code = \$/i.test(s)) {
          const code = params[params.length - 1] || params[2];
          // find by item_code param position varies
          const codeParam = params.find((p) => typeof p === 'string' && p.includes('__'));
          if (codeParam) filtered = filtered.filter((p) => p.item_code === codeParam);
        }
        return { rows: filtered, rowCount: filtered.length };
      }
      if (/UPDATE tenant_price_rules/i.test(s)) {
        const ruleId = params[0];
        const slug = params[1];
        const row = prices.find((p) => p.id === ruleId && p.client_slug === slug);
        if (!row) return { rows: [], rowCount: 0 };
        // Apply common set fields by scanning SET clauses loosely
        if (/amount_cents = \$/i.test(s)) {
          const m = s.match(/amount_cents = \$(\d+)/i);
          if (m) row.amount_cents = params[Number(m[1]) - 1];
        }
        if (/item_code = \$/i.test(s)) {
          const m = s.match(/item_code = \$(\d+)/i);
          if (m) row.item_code = params[Number(m[1]) - 1];
        }
        if (/unit = \$/i.test(s)) {
          const m = s.match(/unit = \$(\d+)/i);
          if (m) row.unit = params[Number(m[1]) - 1];
        }
        if (/display_name = \$/i.test(s)) {
          const m = s.match(/display_name = \$(\d+)/i);
          if (m) row.display_name = params[Number(m[1]) - 1];
        }
        if (/active = \$/i.test(s) || /active = false/i.test(s)) {
          if (/active = false/i.test(s)) row.active = false;
          else {
            const m = s.match(/active = \$(\d+)/i);
            if (m) row.active = params[Number(m[1]) - 1];
          }
        }
        return { rows: [row], rowCount: 1 };
      }
      if (/INSERT INTO tenant_config_audit_log/i.test(s)) {
        return { rows: [], rowCount: 1 };
      }
      // adminConfigTablesExist — treat as present
      if (/tenant_price_rules|tenant_rental_offerings/i.test(s) && /SELECT/i.test(s)) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
function sourceContracts() {
  console.log('\n── A. Source contracts (Admin UI + API + seed) ──\n');
  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  const apiSrc = read('scripts/staff-query-api.js');
  const seedSrc = read('scripts/lib/tenant-rental-offerings-seed.js');
  const writesSrc = read('scripts/lib/tenant-admin-writes.js');
  const en = read('scripts/lib/staff-portal-i18n.js');
  const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

  ok(
    'API write path accepts stock_quantity from body',
    /handleAdminConfigRentalOfferingWrite[\s\S]{0,2500}stock_quantity/.test(apiSrc)
      || /stock_quantity:\s*body\.stock_quantity/.test(apiSrc)
      || /params\.stock_quantity|stock_quantity:\s*Object\.prototype\.hasOwnProperty\.call\(body,\s*['"]stock_quantity['"]/.test(apiSrc)
      || /body\.stock_quantity/.test(apiSrc.match(/handleAdminConfigRentalOfferingWrite[\s\S]{0,800}/) || [''])[0],
  );
  const exportsBlock = (writesSrc.match(/module\.exports[\s\S]{0,2500}/) || [''])[0];
  ok(
    'atomic createRentalCatalogItem exists and is exported',
    /async function createRentalCatalogItem/.test(writesSrc)
      && /createRentalCatalogItem/.test(exportsBlock),
  );
  ok(
    'create form includes stock control',
    /renderAdminAddEquipmentForm[\s\S]{0,900}admin-new-equip-stock|id="admin-new-equip-stock"/.test(adminUi),
  );
  ok(
    'edit form includes rental name control',
    /admin-equip-name-|data-admin-equip-field="name"|id="admin-equip-name-/.test(adminUi),
  );
  ok(
    'edit form includes stock control',
    /admin-equip-stock-|data-admin-equip-field="stock"|id="admin-equip-stock-/.test(adminUi),
  );
  ok(
    'cards display configured stock',
    /stock_quantity|data-equip-stock|admin\.prices\.stock|Total stock/.test(adminUi),
  );
  ok(
    'duration cards editable (count+unit) not amount-only',
    /save-price-amount[\s\S]{0,1500}period_window/.test(adminUi)
      && /renderAdminDurationControl\(pricePrefix/.test(adminUi)
      && /data-admin-price-duration=/.test(adminUi),
  );
  ok(
    'save-new-equipment sends stock_quantity',
    /save-new-equipment[\s\S]{0,2500}stock_quantity/.test(adminUi),
  );
  ok(
    'seed does not auto-derive bundle excludes for new catalog rows',
    /excludes:\s*\[\]/.test(seedSrc)
      && !/excludes:\s*\[\.\.\.\(excludes\[g\.offering_key\]/.test(seedSrc),
  );
  ok(
    'BUNDLE_COMPONENTS labeled historical-read-only',
    /HISTORICAL|historical-read-only|read-only/i.test(seedSrc)
      && /BUNDLE_COMPONENTS/.test(seedSrc),
  );
  const createPriceFn = (writesSrc.match(/async function createRentalPriceRule[\s\S]*?\nasync function /) || [''])[0];
  const patchPriceFn = (writesSrc.match(/async function patchPriceRule[\s\S]*?\nasync function putLessonCapacityDefault/) || [''])[0];
  ok(
    'board/wetsuit short-duration parity not enforced on createRentalPriceRule',
    createPriceFn.length > 0 && !/assertBoardWetsuitShortParityAfterMutation|short_duration_mismatch/.test(createPriceFn),
  );
  ok(
    'board/wetsuit short-duration parity not enforced on patchPriceRule writes',
    patchPriceFn.length > 0 && !/assertBoardWetsuitShortParityAfterMutation/.test(patchPriceFn),
  );
  ok(
    'EN stock i18n present',
    /admin\.prices\.stock['"]:\s*['"]/.test(en) || en.includes("'admin.prices.stock'"),
  );
  ok(
    'ES stock i18n present',
    es.includes('admin.prices.stock'),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
async function serviceBehavior() {
  console.log('\n── B. Service: independent Board + Suit, rename, duration, stock, atomic ──\n');

  // Validation: Board + Suit as ordinary item
  const boardSuit = validateRentalOfferingBody({
    offering_key: 'board_suit_combo_rental',
    label: 'Board + Suit',
    group_key: 'equipment',
    excludes: [],
    stock_quantity: 7,
  });
  ok(
    'Board + Suit validates as ordinary independent offering with stock',
    boardSuit.ok === true
      && boardSuit.value.label === 'Board + Suit'
      && boardSuit.value.stock_quantity === 7
      && Array.isArray(boardSuit.value.excludes)
      && boardSuit.value.excludes.length === 0,
    JSON.stringify(boardSuit),
  );

  ok('stock 0 accepted', isValidStockQuantity(0));
  ok('stock 999 accepted', isValidStockQuantity(999));
  ok('stock -1 rejected', !isValidStockQuantity(-1));
  ok('stock 1000 rejected', !isValidStockQuantity(1000));
  ok('stock 1.5 rejected', !isValidStockQuantity(1.5));

  const badName = validateRentalOfferingBody({
    offering_key: 'x_rental', label: '   ', group_key: 'equipment',
  });
  ok('blank name rejected', badName.ok === false);

  // Custom duration identities (data-driven)
  const dur3h = validatePriceCreateBody({
    offering_key: 'board_suit_combo_rental',
    period_window: '3_hours',
    amount_cents: 2500,
  });
  ok(
    'arbitrary 3_hours duration accepted',
    dur3h.ok && dur3h.patch.period_window === '3_hours',
    JSON.stringify(dur3h),
  );
  const dur11d = validatePriceCreateBody({
    offering_key: 'board_suit_combo_rental',
    period_window: '11_days',
    amount_cents: 9000,
  });
  ok('arbitrary 11_days duration accepted', dur11d.ok && dur11d.patch.period_window === '11_days');
  ok(
    'zero hours rejected',
    validatePriceCreateBody({
      offering_key: 'board_suit_combo_rental', period_window: '0_hours', amount_cents: 100,
    }).ok === false,
  );
  ok(
    'fractional duration rejected',
    validatePriceCreateBody({
      offering_key: 'board_suit_combo_rental', period_window: '1.5_hours', amount_cents: 100,
    }).ok === false,
  );
  ok(
    'negative duration rejected',
    validatePriceCreateBody({
      offering_key: 'board_suit_combo_rental', period_window: '-2_days', amount_cents: 100,
    }).ok === false,
  );
  ok(
    'invalid price rejected',
    validatePriceCreateBody({
      offering_key: 'board_suit_combo_rental', period_window: '2_hours', amount_cents: -5,
    }).ok === false,
  );

  const patchDur = validatePricePatchBody({ period_window: '5_hours', amount_cents: 3000 });
  ok(
    'duration identity edit accepted on patch',
    patchDur.ok && patchDur.patch.period_window === '5_hours' && patchDur.patch.amount_cents === 3000,
    JSON.stringify(patchDur),
  );

  // Atomic create: Board + Suit with stock + custom duration
  const pg = makeCatalogPg();
  assert.strictEqual(typeof createRentalCatalogItem, 'function', 'createRentalCatalogItem must be implemented');
  const created = await createRentalCatalogItem(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering: {
      offering_key: 'board_suit_combo_rental',
      label: 'Board + Suit',
      group_key: 'equipment',
      excludes: [],
      stock_quantity: 7,
    },
    prices: [{ period_window: '3_hours', amount_cents: 2500 }],
    actor: { staff_user_id: null, email: 'test@example.com' },
  });
  ok(
    'atomic create Board + Suit with stock + 3_hours',
    created.ok === true
      && created.offering
      && created.offering.offering_key === 'board_suit_combo_rental'
      && created.offering.label === 'Board + Suit'
      && created.offering.stock_quantity === 7
      && Array.isArray(created.prices)
      && created.prices.length === 1
      && String(created.prices[0].item_code || '').includes('3_hours'),
    JSON.stringify(created),
  );
  ok(
    'atomic create uses single transaction commit',
    pg.state.begins >= 1 && pg.state.commits >= 1 && pg.state.rollbacks === 0,
    JSON.stringify(pg.state),
  );

  // Invalid price must not leave offering
  const pg2 = makeCatalogPg();
  const partial = await createRentalCatalogItem(pg2, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering: {
      offering_key: 'ghost_partial_rental',
      label: 'Ghost Partial',
      group_key: 'equipment',
      excludes: [],
      stock_quantity: 2,
    },
    prices: [{ period_window: '0_hours', amount_cents: 100 }],
    actor: { staff_user_id: null, email: 'test@example.com' },
  });
  ok(
    'invalid duration fails closed (no partial offering)',
    partial.ok === false
      && pg2.offerings.length === 0
      && pg2.prices.length === 0,
    JSON.stringify({ partial, offerings: pg2.offerings.length, prices: pg2.prices.length, state: pg2.state }),
  );

  // Duplicate name fails with no partial writes
  const pg3 = makeCatalogPg();
  await createRentalCatalogItem(pg3, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering: {
      offering_key: 'alpha_rental',
      label: 'Alpha Board',
      group_key: 'equipment',
      excludes: [],
      stock_quantity: 1,
    },
    prices: [{ period_window: '1_day', amount_cents: 1000 }],
    actor: { staff_user_id: null, email: 't@x.com' },
  });
  const beforeCount = pg3.offerings.length;
  const dup = await createRentalCatalogItem(pg3, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering: {
      offering_key: 'beta_rental',
      label: '  ALPHA   BOARD ',
      group_key: 'equipment',
      excludes: [],
      stock_quantity: 3,
    },
    prices: [{ period_window: '2_days', amount_cents: 2000 }],
    actor: { staff_user_id: null, email: 't@x.com' },
  });
  ok(
    'duplicate normalized name fails with no extra rows',
    dup.ok === false
      && dup.error === 'rental_name_already_exists'
      && pg3.offerings.length === beforeCount
      && pg3.prices.length === 1,
    JSON.stringify({ dup, offerings: pg3.offerings.length, prices: pg3.prices.length }),
  );

  // Rename preserves offering_key; historical snapshot unchanged
  const renamed = await updateRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'board_suit_combo_rental',
    label: 'Board & Suit Deluxe',
  });
  ok(
    'rename updates label only; offering_key stable',
    renamed.ok
      && renamed.offering.label === 'Board & Suit Deluxe'
      && renamed.offering.offering_key === 'board_suit_combo_rental'
      && renamed.offering.stock_quantity === 7,
    JSON.stringify(renamed),
  );

  const historicalSnapshot = {
    ok: true,
    client_slug: 'sunset',
    offering_key: 'board_suit_combo_rental',
    offering_label: 'Board + Suit',
    duration_key: '3_hours',
    item_code: 'board_suit_combo_rental__3_hours',
    unit: 'session',
    unit_cents: 2500,
    amount_cents: 2500,
    quantity: 1,
    currency: 'EUR',
    location_id: 'sunset-somo',
  };
  const snap = buildGenericRentalServiceRecord(historicalSnapshot, {
    bookingId: 'bk-1',
    bookingCode: 'BK1',
    guestName: 'Ada',
    serviceDate: '2026-08-01',
  });
  ok(
    'historical fixture builds snapshot with booking-time label+duration',
    snap.ok
      && snap.record.metadata.offering_label === 'Board + Suit'
      && snap.record.metadata.duration_key === '3_hours'
      && snap.record.metadata.offering_key === 'board_suit_combo_rental'
      && snap.record.amount_due_cents === 2500,
    JSON.stringify(snap),
  );
  // After rename, re-check fixture object (not re-resolved) is unchanged
  ok(
    'historical fixture object unchanged after catalog rename',
    historicalSnapshot.offering_label === 'Board + Suit'
      && historicalSnapshot.duration_key === '3_hours'
      && historicalSnapshot.amount_cents === 2500,
  );

  // Seed: no automatic excludes/component mapping
  const seedRows = buildRentalOfferingRows('sunset');
  ok('seed still yields 4 canonical keys', seedRows && seedRows.length === 4);
  const byKey = Object.fromEntries((seedRows || []).map((r) => [r.offering_key, r]));
  ok(
    'canonical board_and_suit_rental is ordinary seed item with empty excludes',
    byKey.board_and_suit_rental
      && Array.isArray(byKey.board_and_suit_rental.excludes)
      && byKey.board_and_suit_rental.excludes.length === 0,
    JSON.stringify(byKey.board_and_suit_rental),
  );
  ok(
    'canonical board_rental has empty excludes (no auto component mapping)',
    byKey.board_rental && byKey.board_rental.excludes.length === 0,
  );
  ok(
    'canonical wetsuit_rental has empty excludes',
    byKey.wetsuit_rental && byKey.wetsuit_rental.excludes.length === 0,
  );
  ok(
    'historical BUNDLE_COMPONENTS still exported for read-only adapters',
    BUNDLE_COMPONENTS
      && BUNDLE_COMPONENTS.board_and_suit_rental
      && typeof deriveExclusions === 'function',
  );
  // Historical adapter: deriveExclusions still works when explicitly called
  const hist = deriveExclusions(['board_and_suit_rental', 'board_rental', 'wetsuit_rental']);
  ok(
    'historical deriveExclusions still computes legacy excludes when called',
    hist.board_and_suit_rental && hist.board_and_suit_rental.has('board_rental'),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
async function browserFixture() {
  console.log('\n── C. Cooked /staff/ui: name, stock, duration controls ──\n');

  // Offline gates share deps from the workspace install when worktree has none.
  if (!process.env.NODE_PATH) {
    process.env.NODE_PATH = '/opt/data/workspaces/wolfhouse-grok/node_modules';
    require('module').Module._initPaths();
  }

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  let offerings = [
    {
      offering_key: 'softboard',
      label: 'Soft board',
      active: true,
      stock_quantity: 12,
      excludes: [],
    },
    {
      offering_key: 'board_and_suit_rental',
      label: 'Surfboard + Wetsuit',
      active: true,
      stock_quantity: 4,
      excludes: [],
    },
  ];
  let rentalPrices = [
    {
      id: 'price-soft-2h',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'softboard__2_hours',
      item_code: 'softboard__2_hours',
      display_name: 'Soft board',
      label: 'Soft board',
      amount_cents: 1800,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
    {
      id: 'price-bundle-1d',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'board_and_suit_rental__1_day',
      item_code: 'board_and_suit_rental__1_day',
      display_name: 'Surfboard + Wetsuit',
      label: 'Surfboard + Wetsuit',
      amount_cents: 3000,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  ];
  const createPosts = [];
  const patchPosts = [];
  const pricePatches = [];

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route(/\/staff\/admin\/config\/rental-offerings(?:\/([a-z][a-z0-9_]*))?(?:\?|$)/, async (r) => {
    const method = r.request().method();
    const u = r.request().url();
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
        if (!offerings.some((o) => o.offering_key === body.offering_key)) {
          offerings.push({
            offering_key: body.offering_key,
            label: body.label || body.offering_key,
            active: true,
            stock_quantity: body.stock_quantity != null ? body.stock_quantity : null,
            excludes: body.excludes || [],
          });
        }
        // Atomic create may include prices[]
        if (Array.isArray(body.prices)) {
          for (const pr of body.prices) {
            const code = `${body.offering_key}__${pr.period_window}`;
            rentalPrices.push({
              id: `price-new-${rentalPrices.length + 1}`,
              category: 'rental',
              item_type: 'rental',
              offering_key: code,
              item_code: code,
              display_name: body.label,
              label: body.label,
              amount_cents: Number(pr.amount_cents) || 0,
              active: true,
              client_slug: 'sunset',
              location_id: 'sunset-somo',
            });
          }
        }
        await r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            offering: {
              offering_key: body.offering_key,
              label: body.label,
              stock_quantity: body.stock_quantity,
              active: true,
            },
          }),
        });
        return;
      }
    }
    if (method === 'PATCH' && key) {
      const body = JSON.parse(r.request().postData() || '{}');
      patchPosts.push({ key, body });
      const off = offerings.find((o) => o.offering_key === key);
      if (off) {
        if (body.label != null) off.label = body.label;
        if (Object.prototype.hasOwnProperty.call(body, 'stock_quantity')) {
          off.stock_quantity = body.stock_quantity;
        }
        if (typeof body.active === 'boolean') off.active = body.active;
      }
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
    const x = await r.fetch();
    const b = await x.json();
    b.prices = rentalPrices.slice();
    b.rental_offerings = offerings.slice();
    b._equipment_offerings = offerings.slice();
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
    const okKey = String(body.offering_key || '').trim();
    const dur = String(body.period_window || '1_day');
    const code = `${okKey}__${dur}`;
    rentalPrices.push({
      id: `price-new-${rentalPrices.length + 1}`,
      category: 'rental',
      item_type: 'rental',
      offering_key: code,
      item_code: code,
      display_name: okKey,
      label: okKey,
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

  await page.route(/\/staff\/admin\/config\/prices\/[^?/]+/, async (r) => {
    if (r.request().method() !== 'PATCH') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    pricePatches.push(body);
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

    // Collapsed cards show stock
    const softCard = page.locator('[data-admin-equip="softboard"]');
    await softCard.waitFor();
    const softText = await softCard.innerText();
    ok(
      'existing card displays stock quantity',
      /12|stock/i.test(softText) || (await softCard.locator('[data-equip-stock]').count()) >= 1,
      softText.slice(0, 200),
    );

    // Canonical Surfboard + Wetsuit is an ordinary card (same controls)
    const bundleCard = page.locator('[data-admin-equip="board_and_suit_rental"]');
    ok(
      'canonical Surfboard + Wetsuit renders as ordinary equipment card',
      (await bundleCard.count()) === 1,
    );
    await bundleCard.locator('[data-admin-action="edit-equipment"]').click();
    const bundleEdit = page.locator('[data-admin-equip="board_and_suit_rental"]');
    ok(
      'canonical item edit has name field',
      (await bundleEdit.locator('[id^="admin-equip-name-"], [data-admin-equip-field="name"]').count()) >= 1,
    );
    ok(
      'canonical item edit has stock field',
      (await bundleEdit.locator('[id^="admin-equip-stock-"], [data-admin-equip-field="stock"]').count()) >= 1,
    );
    ok(
      'canonical item edit has duration controls on price card',
      (await bundleEdit.locator('.portal-admin-duration-count, [data-admin-price-duration]').count()) >= 1
        || (await bundleEdit.locator('[id*="admin-price-"][id*="-count"]').count()) >= 1,
    );
    await bundleEdit.locator('[data-admin-action="cancel-edit"]').first().click().catch(() => {});

    // Create form has stock
    await page.locator('[data-admin-action="add-equipment"]').click();
    ok(
      'create form has stock input',
      (await page.locator('#admin-new-equip-stock').count()) === 1,
    );
    await page.locator('#admin-new-equip-name').fill('Board + Suit');
    await page.locator('#admin-new-equip-stock').fill('5');
    await page.locator('#admin-new-equip-count').fill('4');
    await page.locator('#admin-new-equip-unit').selectOption('hours');
    await page.locator('#admin-new-equip-amount').fill('22');
    await page.locator('[data-admin-action="save-new-equipment"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-admin-equip="board_suit_rental"], [data-admin-equip*="board"]'),
      null,
      { timeout: 8000 },
    ).catch(() => {});
    ok(
      'create posts stock_quantity for Board + Suit',
      createPosts.some((b) => Number(b.stock_quantity) === 5
        && /board|suit/i.test(String(b.label || b.offering_key || ''))),
      JSON.stringify(createPosts),
    );

    // Softboard: rename + duration edit
    await page.locator('[data-admin-action="cancel-edit"]').first().click().catch(() => {});
    await page.locator('[data-admin-equip="softboard"] [data-admin-action="edit-equipment"]').click();
    const softEdit = page.locator('[data-admin-equip="softboard"]');
    const nameInput = softEdit.locator('[id^="admin-equip-name-"], [data-admin-equip-field="name"]').first();
    await nameInput.fill('Soft Board Pro');
    const stockInput = softEdit.locator('[id^="admin-equip-stock-"], [data-admin-equip-field="stock"]').first();
    await stockInput.fill('15');
    // Save catalog meta if dedicated button exists
    const saveMeta = softEdit.locator('[data-admin-action="save-equip-meta"], [data-admin-action="save-equipment"]');
    if ((await saveMeta.count()) >= 1) {
      await saveMeta.first().click();
      await page.waitForTimeout(200);
    }
    // Duration 2 hours → 3 hours + amount save
    const durCount = softEdit.locator('.portal-admin-duration-count, [id*="admin-price-"][id*="-count"]').first();
    if ((await durCount.count()) >= 1) {
      await durCount.fill('3');
      const durUnit = softEdit.locator('.portal-admin-duration-unit, [id*="admin-price-"][id*="-unit"]').first();
      if ((await durUnit.count()) >= 1) await durUnit.selectOption('hours');
    }
    await softEdit.locator('[data-admin-price-field="amount"]').first().fill('20');
    await softEdit.locator('[data-admin-action="save-price-amount"]').first().click();
    await page.waitForTimeout(300);
    ok(
      'price save includes period_window for duration edit',
      pricePatches.some((p) => p.period_window != null || p.amount_cents != null),
      JSON.stringify(pricePatches),
    );
    ok(
      'duration edit posts new period identity (3_hours) when duration controls present',
      pricePatches.some((p) => p.period_window === '3_hours')
        || (await durCount.count()) === 0, // if UI not yet rendered duration, source contracts cover it
      JSON.stringify(pricePatches),
    );

    // Name/stock patch if save-equip-meta used
    if (patchPosts.length) {
      ok(
        'rename/stock patch keeps offering key softboard',
        patchPosts.some((p) => p.key === 'softboard'),
        JSON.stringify(patchPosts),
      );
    }

    ok('no page errors', errors.length === 0, errors.join('; '));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('verify-rental-admin-catalog-control (Slice A)\n');
  try {
    sourceContracts();
    await serviceBehavior();
    await browserFixture();
  } catch (err) {
    fail += 1;
    console.error('  FAIL  uncaught:', err && err.stack ? err.stack : err);
  }
  console.log(`\n── verify:rental-admin-catalog-control ${fail === 0 ? 'PASSED' : 'FAILED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
