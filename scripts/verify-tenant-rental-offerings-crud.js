'use strict';

/**
 * verify:tenant-rental-offerings-crud
 *
 * Offline unit coverage for the tenant_rental_offerings data-access + CRUD engine
 * (scripts/lib/tenant-rental-offerings.js) — validation, client+location scoping,
 * duplicate handling, exclusion symmetry, hard-delete. Uses an in-memory mock pg;
 * DB-backed render/book parity is the staging smoke gate (Skipper).
 * Deep transactional hard-delete: verify-sunset-rental-hard-delete.js
 */

const {
  isValidOfferingKey,
  validateRentalOfferingBody,
  listRentalOfferings,
  createRentalOffering,
  updateRentalOffering,
  deleteRentalOffering,
  seedRentalOfferings,
  applyRentalMutualExclusion,
} = require('./lib/tenant-rental-offerings');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

// Minimal in-memory multi-table backing for CRUD + hard-delete SQL the engine emits.
function makePg() {
  const rows = [];
  let seq = 0;
  const matchLoc = (row, loc) => (loc == null ? row.location_id == null : row.location_id === loc);
  const normLabel = (label) => String(label == null ? '' : label)
    .replace(/^\s+|\s+$/gu, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
  return {
    rows,
    query: async (sql, params = []) => {
      const s = String(sql);
      if (/^\s*BEGIN\s*$/i.test(s.trim()) || /^\s*COMMIT\s*$/i.test(s.trim()) || /^\s*ROLLBACK\s*$/i.test(s.trim())) {
        return { rows: [], rowCount: 0 };
      }
      if (/pg_advisory_xact_lock/i.test(s)) {
        return { rows: [{ pg_advisory_xact_lock: true }], rowCount: 1 };
      }
      if (/to_regclass/i.test(s)) {
        const fromParam = params && params[0] != null ? String(params[0]) : '';
        const fromLiteral = (s.match(/to_regclass\(\s*'([^']+)'\s*\)/i) || [])[1] || '';
        const name = (fromParam || fromLiteral).replace(/^public\./, '');
        const known = new Set([
          'tenant_rental_offerings',
          'tenant_price_rules',
          'tenant_surf_pack_rules',
          'tenant_private_lesson_rules',
          'tenant_config_audit_log',
        ]);
        return { rows: [{ reg: known.has(name) ? name : null }], rowCount: 1 };
      }
      if (/information_schema\.columns/i.test(s)) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (/INSERT INTO tenant_rental_offerings/i.test(s)) {
        // Support both pre-stock and stock-aware INSERT column lists.
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
        const dup = rows.find((r) => r.active && r.client_slug === client_slug
          && (r.location_id || '') === (location_id || '') && r.offering_key === offering_key);
        if (dup) { const e = new Error('duplicate key value violates unique constraint "uq_tenant_rental_offerings_active"'); throw e; }
        seq += 1;
        const row = {
          id: `ro-${seq}`, client_slug, location_id, offering_key, label, group_key,
          excludes: JSON.parse(excludesJson), sort_order,
          stock_quantity: stock_quantity === undefined ? null : stock_quantity,
          active: true, updated_by, tenant_id: 'sunset',
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/SELECT \* FROM tenant_rental_offerings/i.test(s) && /FOR UPDATE/i.test(s)) {
        const slug = params[0];
        const key = params[1];
        const loc = /location_id = \$/i.test(s) ? params[2] : null;
        const out = rows.filter((r) => r.client_slug === slug && r.offering_key === key && matchLoc(r, loc));
        return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
      }
      // Display-name uniqueness probe (includes inactive; exact normalized label).
      if (/FROM tenant_rental_offerings/i.test(s)
        && /lower\s*\(\s*regexp_replace/i.test(s)) {
        const slug = params[0];
        const locIsNull = /location_id IS NULL/i.test(s);
        const loc = locIsNull ? null : params[1];
        // params: [slug, loc?, normalized, excludeKey?]
        const normalized = params[locIsNull ? 1 : 2];
        const excludeKey = params.length > (locIsNull ? 2 : 3) ? params[params.length - 1] : null;
        let out = rows.filter((r) => r.client_slug === slug && matchLoc(r, loc)
          && normLabel(r.label) === String(normalized || ''));
        if (excludeKey && /offering_key <>/i.test(s)) {
          out = out.filter((r) => r.offering_key !== excludeKey);
        }
        out = out.slice(0, 1);
        return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
      }
      if (/SELECT[\s\S]*FROM tenant_rental_offerings/i.test(s)) {
        const slug = params[0];
        // listRentalOfferings: location_id = $2 OR location_id IS NULL
        // setActive find: offering_key = $2 AND location_id = $3
        let out = rows.filter((r) => r.client_slug === slug);
        if (/offering_key = \$2/i.test(s)) {
          const key = params[1];
          out = out.filter((r) => r.offering_key === key);
          if (/location_id = \$3/i.test(s)) {
            out = out.filter((r) => matchLoc(r, params[2]));
          } else if (/location_id IS NULL/i.test(s)) {
            out = out.filter((r) => r.location_id == null);
          }
        } else if (/location_id = \$2/i.test(s)) {
          const loc = params[1];
          out = out.filter((r) => r.location_id === loc || r.location_id == null);
        }
        if (/active = true/.test(s)) out = out.filter((r) => r.active);
        out = out.slice().sort((a, b) => (a.sort_order - b.sort_order) || a.offering_key.localeCompare(b.offering_key));
        return { rows: out, rowCount: out.length };
      }
      if (/DELETE FROM tenant_rental_offerings/i.test(s)) {
        const slug = params[0];
        const key = params[1];
        const loc = /location_id = \$/i.test(s) ? params[2] : null;
        const kept = [];
        const deleted = [];
        for (const r of rows) {
          if (r.client_slug === slug && r.offering_key === key && matchLoc(r, loc)) {
            deleted.push({ id: r.id, offering_key: r.offering_key, active: r.active });
          } else kept.push(r);
        }
        rows.length = 0;
        kept.forEach((r) => rows.push(r));
        return { rows: deleted, rowCount: deleted.length };
      }
      if (/DELETE FROM tenant_price_rules/i.test(s)) {
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT[\s\S]*FROM tenant_surf_pack_rules/i.test(s) || /SELECT[\s\S]*FROM tenant_private_lesson_rules/i.test(s)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO tenant_config_audit_log/i.test(s)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE tenant_rental_offerings/i.test(s)) {
        const locProvided = /location_id = \$/.test(s);
        // stock-only / multi-set updates: find by slug+key at end of params
        const key = params[params.length - (locProvided ? 2 : 1)];
        const slug = params[params.length - (locProvided ? 3 : 2)];
        const loc = locProvided ? params[params.length - 1] : null;
        const target = rows.find((r) => r.active && r.client_slug === slug && r.offering_key === key && matchLoc(r, loc));
        if (!target) return { rows: [], rowCount: 0 };
        if (/label = \$/.test(s)) { const m = s.match(/label = \$(\d+)/); if (m) target.label = params[Number(m[1]) - 1]; }
        if (/group_key = /.test(s)) { const m = s.match(/group_key = \$(\d+)/); if (m) target.group_key = params[Number(m[1]) - 1]; }
        if (/excludes = /.test(s)) { const m = s.match(/excludes = \$(\d+)/); if (m) target.excludes = JSON.parse(params[Number(m[1]) - 1]); }
        if (/sort_order = /.test(s)) { const m = s.match(/sort_order = \$(\d+)/); if (m) target.sort_order = params[Number(m[1]) - 1]; }
        if (/stock_quantity = /.test(s)) {
          const m = s.match(/stock_quantity = \$(\d+)/);
          if (m) target.stock_quantity = params[Number(m[1]) - 1];
        }
        return { rows: [{ ...target }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function run() {
  console.log('\nverify:tenant-rental-offerings-crud\n');

  console.log('── A. offering_key validation ──');
  ok('board_rental valid', isValidOfferingKey('board_rental'));
  ok('kayak_rental valid', isValidOfferingKey('kayak_rental'));
  ok('rejects "__" separator', !isValidOfferingKey('board_rental__half_day'));
  ok('rejects uppercase', !isValidOfferingKey('Board'));
  ok('rejects leading digit', !isValidOfferingKey('2board'));
  ok('rejects empty', !isValidOfferingKey(''));

  console.log('\n── B. body validation ──');
  ok('create requires label', !validateRentalOfferingBody({ offering_key: 'kayak_rental', group_key: 'sup' }).ok);
  ok('create requires group_key', !validateRentalOfferingBody({ offering_key: 'kayak_rental', label: 'Kayak' }).ok);
  ok('self-exclusion rejected', !validateRentalOfferingBody({ offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', excludes: ['kayak_rental'] }).ok);
  ok('bad exclude entry rejected', !validateRentalOfferingBody({ offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', excludes: ['not valid'] }).ok);
  const good = validateRentalOfferingBody({ offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', excludes: ['board_rental'] });
  ok('valid create body accepted', good.ok && good.value.offering_key === 'kayak_rental');

  console.log('\n── B2. stock_quantity validation (location-scoped catalog stock) ──');
  const stockMissing = validateRentalOfferingBody({
    offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup',
  });
  ok('stock omitted remains valid (nullable/unconfigured)',
    stockMissing.ok === true
      && (stockMissing.value.stock_quantity === undefined || stockMissing.value.stock_quantity === null),
    JSON.stringify(stockMissing));
  const stockNull = validateRentalOfferingBody({
    offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: null,
  });
  ok('explicit null stock accepted as unconfigured',
    stockNull.ok === true && stockNull.value.stock_quantity === null, JSON.stringify(stockNull));
  const stockOk = validateRentalOfferingBody({
    offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: 12,
  });
  ok('stock 12 accepted', stockOk.ok && stockOk.value.stock_quantity === 12, JSON.stringify(stockOk));
  const stockZero = validateRentalOfferingBody({
    offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: 0,
  });
  ok('stock 0 accepted (sold out, not deleted)', stockZero.ok && stockZero.value.stock_quantity === 0);
  const stockMax = validateRentalOfferingBody({
    offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: 999,
  });
  ok('stock 999 accepted', stockMax.ok && stockMax.value.stock_quantity === 999);
  ok('stock 1000 rejected',
    !validateRentalOfferingBody({
      offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: 1000,
    }).ok);
  ok('stock -1 rejected',
    !validateRentalOfferingBody({
      offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: -1,
    }).ok);
  ok('stock float rejected',
    !validateRentalOfferingBody({
      offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: 1.5,
    }).ok);
  ok('stock string rejected',
    !validateRentalOfferingBody({
      offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', stock_quantity: '5',
    }).ok);
  const renameStock = validateRentalOfferingBody({ stock_quantity: 7 }, 'rename');
  ok('rename/patch mode accepts stock_quantity alone',
    renameStock.ok && renameStock.value.stock_quantity === 7, JSON.stringify(renameStock));

  console.log('\n── C. CRUD + scoping ──');
  const pg = makePg();
  const created = await createRentalOffering(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental',
    label: 'Kayak', group_key: 'sup', excludes: [], sort_order: 5, stock_quantity: 8, actorId: null,
  });
  ok('create kayak ok', created.ok && created.offering.offering_key === 'kayak_rental', JSON.stringify(created));
  ok('create persists stock_quantity',
    created.ok && created.offering.stock_quantity === 8, JSON.stringify(created));

  const dup = await createRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', label: 'Kayak 2', group_key: 'sup' });
  ok('duplicate active offering_key rejected', !dup.ok && /already exists/.test(dup.error), JSON.stringify(dup));

  await createRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'board_rental', label: 'Surfboard', group_key: 'boards', sort_order: 1 });
  const list = await listRentalOfferings(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('list returns 2, sorted by sort_order', list.length === 2 && list[0].offering_key === 'board_rental', JSON.stringify(list.map((r) => r.offering_key)));

  const otherTenant = await listRentalOfferings(pg, { clientSlug: 'lawave', locationId: 'lawave-main' });
  ok('cross-tenant list isolated (lawave sees none)', otherTenant.length === 0);

  const renamed = await updateRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', label: 'Sea Kayak', actorId: null });
  ok('rename updates label', renamed.ok && renamed.offering.label === 'Sea Kayak', JSON.stringify(renamed));
  ok('rename preserves stock_quantity',
    renamed.ok && renamed.offering.stock_quantity === 8, JSON.stringify(renamed));

  const stockPatch = await updateRentalOffering(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', stock_quantity: 20,
  });
  ok('patch stock_quantity persists',
    stockPatch.ok && stockPatch.offering.stock_quantity === 20, JSON.stringify(stockPatch));
  const stockClear = await updateRentalOffering(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', stock_quantity: null,
  });
  ok('patch stock to null re-unconfigures',
    stockClear.ok && stockClear.offering.stock_quantity == null, JSON.stringify(stockClear));

  const excl = await updateRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', excludes: ['board_rental'] });
  ok('update excludes persists', excl.ok && excl.offering.excludes.includes('board_rental'));

  const del = await deleteRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental' });
  ok('hard-delete ok', del.ok === true && del.deleted === true && del.offerings_deleted >= 1, JSON.stringify(del));
  const afterDel = await listRentalOfferings(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('deleted item gone from active list', !afterDel.some((r) => r.offering_key === 'kayak_rental'));
  const afterDelAll = await listRentalOfferings(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', includeInactive: true });
  ok('hard-deleted item gone even with includeInactive', !afterDelAll.some((r) => r.offering_key === 'kayak_rental'));
  const delMissing = await deleteRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'nope' });
  ok('delete missing item -> idempotent noop', delMissing.ok === true && delMissing.noop === true, JSON.stringify(delMissing));

  console.log('\n── D. Idempotent seed/reconcile ──');
  const seedPg = makePg();
  const desired = [
    { offering_key: 'board_rental', label: 'Surfboard', group_key: 'boards', excludes: [], sort_order: 0 },
    { offering_key: 'wetsuit_rental', label: 'Wetsuit', group_key: 'wetsuits', excludes: [], sort_order: 1 },
    { offering_key: 'board_and_suit_rental', label: 'Surfboard + Wetsuit', group_key: 'bundles', excludes: ['board_rental', 'wetsuit_rental'], sort_order: 2 },
  ];
  const seed1 = await seedRentalOfferings(seedPg, { clientSlug: 'sunset', locationId: 'sunset-somo', rows: desired });
  ok('first seed creates all', seed1.ok && seed1.created === 3 && seed1.updated === 0, JSON.stringify(seed1));
  const seed2 = await seedRentalOfferings(seedPg, { clientSlug: 'sunset', locationId: 'sunset-somo', rows: desired });
  ok('re-seed is a no-op (idempotent)', seed2.ok && seed2.created === 0 && seed2.updated === 0, JSON.stringify(seed2));
  const seed3 = await seedRentalOfferings(seedPg, { clientSlug: 'sunset', locationId: 'sunset-somo', rows: [{ ...desired[0], label: 'Board (renamed)' }] });
  ok('seed reconciles drift (label update)', seed3.ok && seed3.updated === 1, JSON.stringify(seed3));

  console.log('\n── E. Mutual-exclusion resolver (data-driven) ──');
  const catalog = desired;
  const both = applyRentalMutualExclusion(['board_and_suit_rental', 'board_rental'], catalog);
  ok('bundle + component -> one blocked', both.blocked.length === 1, JSON.stringify(both));
  ok('bundle+component block is deterministic', both.blocked[0].key === 'board_rental' && both.blocked[0].excludedBy === 'board_and_suit_rental', JSON.stringify(both.blocked));
  const compat = applyRentalMutualExclusion(['board_rental', 'wetsuit_rental'], catalog);
  ok('two non-excluding items both allowed', compat.blocked.length === 0 && compat.allowed.length === 2);
  const solo = applyRentalMutualExclusion(['board_and_suit_rental'], catalog);
  ok('single bundle selection allowed', solo.blocked.length === 0 && solo.allowed.length === 1);

  console.log('\n── F. Sunset real-config parity (handoff Step 1 de-risk) ──');
  const { buildRentalOfferingRows } = require('./lib/tenant-rental-offerings-seed');
  const sunsetRows = buildRentalOfferingRows('sunset');
  ok('sunset seed builds 4 items', Array.isArray(sunsetRows) && sunsetRows.length === 4, JSON.stringify(sunsetRows && sunsetRows.map((r) => r.offering_key)));
  const parityPg = makePg();
  await seedRentalOfferings(parityPg, { clientSlug: 'sunset', locationId: 'sunset-somo', rows: sunsetRows });
  const parity = await listRentalOfferings(parityPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  const keys = parity.map((r) => r.offering_key).sort();
  ok('seeded catalog has the 4 canonical keys',
    JSON.stringify(keys) === JSON.stringify(['board_and_suit_rental', 'board_rental', 'sup_rental', 'wetsuit_rental']),
    JSON.stringify(keys));
  const bundle = parity.find((r) => r.offering_key === 'board_and_suit_rental');
  ok('canonical Surfboard + Wetsuit seeds with empty excludes (independent item)',
    bundle && Array.isArray(bundle.excludes) && bundle.excludes.length === 0,
    JSON.stringify(bundle && bundle.excludes));
  // Slice A: no auto component mapping — co-selection allowed on seeded catalog.
  const exclBoard = applyRentalMutualExclusion(['board_and_suit_rental', 'board_rental'], parity);
  const exclSuit = applyRentalMutualExclusion(['board_and_suit_rental', 'wetsuit_rental'], parity);
  ok('seeded catalog allows board + bundle co-selection (no auto excludes)', exclBoard.blocked.length === 0);
  ok('seeded catalog allows wetsuit + bundle co-selection (no auto excludes)', exclSuit.blocked.length === 0);
  ok('sup co-exists with everything', applyRentalMutualExclusion(['sup_rental', 'board_and_suit_rental'], parity).blocked.length === 0);

  console.log('\n── G. New-item add + delete parity (Step 5 template promise, offline half) ──');
  // Add a brand-new rentable item to the live Sunset catalog with its own
  // exclusion, then prove the resolver honors it symmetrically and that deleting
  // it drops it from resolution without disturbing the remaining catalog.
  const addKayak = await createRentalOffering(parityPg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental',
    label: 'Sea Kayak', group_key: 'sup', excludes: ['board_rental'], sort_order: 4, actorId: null,
  });
  ok('new kayak item created into live catalog', addKayak.ok && addKayak.offering.offering_key === 'kayak_rental', JSON.stringify(addKayak));
  const withKayak = await listRentalOfferings(parityPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('catalog now renders 5 items', withKayak.length === 5, JSON.stringify(withKayak.map((r) => r.offering_key)));
  // New item's exclusion is honored even though only kayak declares it (the
  // seeded board_rental row does NOT list kayak back). One-directional excludes
  // are sufficient to block co-selection — the "add item" UI needn't write a
  // symmetric back-reference. Winner/loser is deterministic by key sort order.
  const kayakVsBoard = applyRentalMutualExclusion(['kayak_rental', 'board_rental'], withKayak);
  ok('one-directional exclude still blocks co-selection (exactly one)', kayakVsBoard.blocked.length === 1, JSON.stringify(kayakVsBoard.blocked));
  ok('block is deterministic by key sort (kayak_rental loses to board_rental)',
    kayakVsBoard.blocked[0].key === 'kayak_rental' && kayakVsBoard.blocked[0].excludedBy === 'board_rental', JSON.stringify(kayakVsBoard.blocked));
  ok('new item coexists with unrelated item',
    applyRentalMutualExclusion(['kayak_rental', 'sup_rental'], withKayak).blocked.length === 0);
  // Delete it: back to the canonical 4, and resolution over the rest is unchanged.
  const delKayak = await deleteRentalOffering(parityPg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental' });
  ok('new item hard-deleted', delKayak.ok === true && delKayak.deleted === true, JSON.stringify(delKayak));
  const afterKayak = await listRentalOfferings(parityPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('delete restores the canonical 4', afterKayak.length === 4 && !afterKayak.some((r) => r.offering_key === 'kayak_rental'), JSON.stringify(afterKayak.map((r) => r.offering_key)));
  const postDelExcl = applyRentalMutualExclusion(['board_and_suit_rental', 'board_rental'], afterKayak);
  // Slice A seed has empty excludes — co-selection remains allowed after kayak delete.
  ok('remaining catalog resolves unchanged after delete (no auto excludes)',
    postDelExcl.blocked.length === 0 && afterKayak.length === 4, JSON.stringify(postDelExcl.blocked));

  console.log(`\nverify-tenant-rental-offerings-crud  pass=${pass}  fail=${fail}`);
  if (fail === 0) console.log('verify-tenant-rental-offerings-crud — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
