'use strict';

/**
 * verify:tenant-rental-offerings-crud
 *
 * Offline unit coverage for the tenant_rental_offerings data-access + CRUD engine
 * (scripts/lib/tenant-rental-offerings.js) — validation, client+location scoping,
 * duplicate handling, exclusion symmetry, soft-delete. Uses an in-memory mock pg;
 * DB-backed render/book parity is the staging smoke gate (Skipper).
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

// Minimal in-memory tenant_rental_offerings backing the SQL the engine emits.
function makePg() {
  const rows = [];
  let seq = 0;
  const matchLoc = (row, loc) => (loc == null ? row.location_id == null : row.location_id === loc);
  return {
    rows,
    query: async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO tenant_rental_offerings/i.test(s)) {
        const [client_slug, location_id, offering_key, label, group_key, excludesJson, sort_order, updated_by] = params;
        const dup = rows.find((r) => r.active && r.client_slug === client_slug
          && (r.location_id || '') === (location_id || '') && r.offering_key === offering_key);
        if (dup) { const e = new Error('duplicate key value violates unique constraint "uq_tenant_rental_offerings_active"'); throw e; }
        seq += 1;
        const row = {
          id: `ro-${seq}`, client_slug, location_id, offering_key, label, group_key,
          excludes: JSON.parse(excludesJson), sort_order, active: true, updated_by,
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/SELECT[\s\S]*FROM tenant_rental_offerings/i.test(s)) {
        const slug = params[0];
        const loc = /location_id = \$2/.test(s) ? params[1] : undefined;
        let out = rows.filter((r) => r.client_slug === slug);
        if (loc !== undefined) out = out.filter((r) => r.location_id === loc || r.location_id == null);
        if (/active = true/.test(s)) out = out.filter((r) => r.active);
        out = out.slice().sort((a, b) => (a.sort_order - b.sort_order) || a.offering_key.localeCompare(b.offering_key));
        return { rows: out, rowCount: out.length };
      }
      if (/UPDATE tenant_rental_offerings/i.test(s)) {
        // last params: ...sets, slug, key, [loc]
        const isDelete = /SET active = false/.test(s);
        let slug; let key; let loc = null;
        if (isDelete) { [slug, key] = [params[0], params[1]]; loc = params.length > 3 ? params[3] : null; }
        else {
          // client_slug is 3rd-from-... find by the WHERE ordering we built
          const locProvided = /location_id = \$/.test(s);
          key = params[params.length - (locProvided ? 2 : 1)];
          slug = params[params.length - (locProvided ? 3 : 2)];
          loc = locProvided ? params[params.length - 1] : null;
        }
        const target = rows.find((r) => r.active && r.client_slug === slug && r.offering_key === key && matchLoc(r, loc));
        if (!target) return { rows: [], rowCount: 0 };
        if (isDelete) { target.active = false; return { rows: [{ offering_key: key }], rowCount: 1 }; }
        if (/label = \$1/.test(s)) target.label = params[0];
        if (/group_key = /.test(s)) { const m = s.match(/group_key = \$(\d)/); if (m) target.group_key = params[Number(m[1]) - 1]; }
        if (/excludes = /.test(s)) { const m = s.match(/excludes = \$(\d)/); if (m) target.excludes = JSON.parse(params[Number(m[1]) - 1]); }
        if (/sort_order = /.test(s)) { const m = s.match(/sort_order = \$(\d)/); if (m) target.sort_order = params[Number(m[1]) - 1]; }
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

  console.log('\n── C. CRUD + scoping ──');
  const pg = makePg();
  const created = await createRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup', excludes: [], sort_order: 5, actorId: null });
  ok('create kayak ok', created.ok && created.offering.offering_key === 'kayak_rental', JSON.stringify(created));

  const dup = await createRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', label: 'Kayak 2', group_key: 'sup' });
  ok('duplicate active offering_key rejected', !dup.ok && /already exists/.test(dup.error), JSON.stringify(dup));

  await createRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'board_rental', label: 'Surfboard', group_key: 'boards', sort_order: 1 });
  const list = await listRentalOfferings(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('list returns 2, sorted by sort_order', list.length === 2 && list[0].offering_key === 'board_rental', JSON.stringify(list.map((r) => r.offering_key)));

  const otherTenant = await listRentalOfferings(pg, { clientSlug: 'lawave', locationId: 'lawave-main' });
  ok('cross-tenant list isolated (lawave sees none)', otherTenant.length === 0);

  const renamed = await updateRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', label: 'Sea Kayak', actorId: null });
  ok('rename updates label', renamed.ok && renamed.offering.label === 'Sea Kayak', JSON.stringify(renamed));

  const excl = await updateRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental', excludes: ['board_rental'] });
  ok('update excludes persists', excl.ok && excl.offering.excludes.includes('board_rental'));

  const del = await deleteRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'kayak_rental' });
  ok('soft-delete ok', del.ok === true && del.deleted === true);
  const afterDel = await listRentalOfferings(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('deleted item gone from active list', !afterDel.some((r) => r.offering_key === 'kayak_rental'));
  const delMissing = await deleteRentalOffering(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'nope' });
  ok('delete missing item -> not deleted', delMissing.ok === false);

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
  ok('bundle excludes its two components',
    bundle && JSON.stringify(bundle.excludes.slice().sort()) === JSON.stringify(['board_rental', 'wetsuit_rental']),
    JSON.stringify(bundle && bundle.excludes));
  // Symmetry: selecting the bundle with either component blocks the component.
  const exclBoard = applyRentalMutualExclusion(['board_and_suit_rental', 'board_rental'], parity);
  const exclSuit = applyRentalMutualExclusion(['board_and_suit_rental', 'wetsuit_rental'], parity);
  ok('bundle blocks board (symmetric from real config)', exclBoard.blocked.length === 1 && exclBoard.blocked[0].key === 'board_rental');
  ok('bundle blocks wetsuit (symmetric from real config)', exclSuit.blocked.length === 1 && exclSuit.blocked[0].key === 'wetsuit_rental');
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
  ok('new item soft-deleted', delKayak.ok === true && delKayak.deleted === true);
  const afterKayak = await listRentalOfferings(parityPg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok('delete restores the canonical 4', afterKayak.length === 4 && !afterKayak.some((r) => r.offering_key === 'kayak_rental'), JSON.stringify(afterKayak.map((r) => r.offering_key)));
  const postDelExcl = applyRentalMutualExclusion(['board_and_suit_rental', 'board_rental'], afterKayak);
  ok('remaining catalog resolves unchanged after delete',
    postDelExcl.blocked.length === 1 && postDelExcl.blocked[0].key === 'board_rental', JSON.stringify(postDelExcl.blocked));

  console.log(`\nverify-tenant-rental-offerings-crud  pass=${pass}  fail=${fail}`);
  if (fail === 0) console.log('verify-tenant-rental-offerings-crud — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
