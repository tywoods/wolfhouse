'use strict';

/**
 * verify:sunset-admin-equipment-rental-fixes
 *
 * Focused RED→GREEN gate for Admin course equipment + rental availability UX:
 *  - course equipment Remove affordance + layout
 *  - active-only equipment dropdown with historical disabled fallback
 *  - per-item Enabled toggle (soft-disable / re-enable; price-independent)
 *  - duration-row × is price-duration delete (not item delete)
 *  - last price delete does NOT auto-disable the offering
 *  - enable works with zero/no prices
 *
 * Companion hard-delete gate: verify-sunset-rental-hard-delete.js
 * Offline: source contracts + in-memory CRUD/write behavior. No network/deploy.
 *
 * Run: node scripts/verify-sunset-admin-equipment-rental-fixes.js
 */

const fs = require('fs');
const path = require('path');
const {
  listRentalOfferings,
  createRentalOffering,
  updateRentalOffering,
  deleteRentalOffering,
  setRentalOfferingActive,
} = require('./lib/tenant-rental-offerings');
const {
  itemCodeBelongsToRentalOffering,
  hasActivePositiveRentalPriceForOffering,
  buildActivePositivePriceForOfferingSql,
} = require('./lib/tenant-admin-writes');

/** PostgreSQL LIKE simulator (`_` = one char, `%` = any sequence). Used only to prove the bug class. */
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

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function assert(label, cond, detail) {
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

/** In-memory tenant_rental_offerings for active-toggle contracts. */
function makeOfferingsPg() {
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
          excludes: JSON.parse(excludesJson),
          sort_order,
          active: true,
          updated_by,
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/SELECT[\s\S]*FROM tenant_rental_offerings/i.test(s) && !/\bUPDATE\s+tenant_rental_offerings\b/i.test(s)) {
        const slug = params[0];
        let out = rows.filter((r) => r.client_slug === slug);
        if (/offering_key = \$/i.test(s)) {
          const key = params[1];
          out = out.filter((r) => r.offering_key === key);
          if (/location_id = \$/i.test(s)) {
            const loc = params[2];
            out = out.filter((r) => matchLoc(r, loc));
          } else if (/location_id IS NULL/i.test(s)) {
            out = out.filter((r) => r.location_id == null);
          }
          return { rows: out.slice(0, 1), rowCount: Math.min(out.length, 1) };
        }
        const loc = /location_id = \$2/.test(s) ? params[1] : undefined;
        if (loc !== undefined) out = out.filter((r) => r.location_id === loc || r.location_id == null);
        if (/active = true/.test(s)) out = out.filter((r) => r.active);
        out = out.slice().sort((a, b) => (a.sort_order - b.sort_order) || a.offering_key.localeCompare(b.offering_key));
        return { rows: out, rowCount: out.length };
      }
      if (/\bUPDATE\s+tenant_rental_offerings\b/i.test(s)) {
        if (/SET active = (true|false|\$)/i.test(s) || /active = \$/i.test(s)) {
          // id-targeted active flip preferred: SET active = $1, updated_by = $2 WHERE id = $3
          if (/WHERE id = \$/i.test(s)) {
            const id = params[2] != null ? params[2] : params.find((p) => String(p).startsWith('ro-'));
            const target = rows.find((r) => r.id === id);
            if (!target) return { rows: [], rowCount: 0 };
            if (typeof params[0] === 'boolean') target.active = params[0];
            else if (/SET active = false/i.test(s)) target.active = false;
            else if (/SET active = true/i.test(s)) target.active = true;
            if (params[1] !== undefined) target.updated_by = params[1];
            return { rows: [{ ...target }], rowCount: 1 };
          }
          // key+slug soft-delete path
          const isDelete = /SET active = false/.test(s);
          let slug; let key; let loc = null;
          if (isDelete) {
            [slug, key] = [params[0], params[1]];
            loc = params.length > 3 ? params[3] : null;
          } else {
            const locProvided = /location_id = \$/.test(s);
            key = params[params.length - (locProvided ? 2 : 1)];
            slug = params[params.length - (locProvided ? 3 : 2)];
            loc = locProvided ? params[params.length - 1] : null;
          }
          const target = rows.find((r) => r.client_slug === slug && r.offering_key === key && matchLoc(r, loc)
            && (isDelete ? r.active : true));
          if (!target) return { rows: [], rowCount: 0 };
          if (isDelete) {
            target.active = false;
            return { rows: [{ offering_key: key, ...target }], rowCount: 1 };
          }
          if (/active = \$/i.test(s) || /active = true/i.test(s) || /active = false/i.test(s)) {
            const bool = params.find((p) => p === true || p === false);
            if (bool !== undefined) target.active = bool;
          }
          return { rows: [{ ...target }], rowCount: 1 };
        }
        // generic label/etc update (active rows only)
        const locProvided = /location_id = \$/.test(s);
        const key = params[params.length - (locProvided ? 2 : 1)];
        const slug = params[params.length - (locProvided ? 3 : 2)];
        const loc = locProvided ? params[params.length - 1] : null;
        const target = rows.find((r) => r.active && r.client_slug === slug && r.offering_key === key && matchLoc(r, loc));
        if (!target) return { rows: [], rowCount: 0 };
        if (/label = \$1/.test(s)) target.label = params[0];
        return { rows: [{ ...target }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function main() {
  console.log('\nverify:sunset-admin-equipment-rental-fixes\n');

  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  const apiSrc = read('scripts/staff-query-api.js');
  const offeringsSrc = read('scripts/lib/tenant-rental-offerings.js');
  const writesSrc = read('scripts/lib/tenant-admin-writes.js');
  const en = read('scripts/lib/staff-portal-i18n.js');
  const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');
  const modelSrc = read('scripts/browser/sunset-equipment-pricing-model.js');

  console.log('[A] Course equipment Remove affordance + layout');
  const rowsFn = adminUi.match(/function adminEquipmentRowsHtml\([\s\S]*?\n\}/);
  assert('adminEquipmentRowsHtml defined', !!rowsFn);
  assert(
    'equipment row renders remove-equipment-option',
    !!(rowsFn && /data-admin-action="remove-equipment-option"/.test(rowsFn[0])),
  );
  assert(
    'remove control uses visible localized Remove text (not bare × only)',
    !!(rowsFn && /remove-equipment-option[\s\S]{0,220}portalT\('admin\.action\.remove'\)/.test(rowsFn[0])
      && !/>\s*×\s*<\/button>/.test(rowsFn[0].replace(/aria-label="[^"]*"/g, '').replace(/title="[^"]*"/g, ''))),
  );
  assert(
    'equipment row allocates full-width action strip class',
    /portal-admin-equipment-option-actions/.test(adminUi) && /portal-admin-equipment-option-fields/.test(adminUi),
  );
  assert(
    'CSS stacks equipment fields + full-width action (not 4-col clip)',
    /portal-admin-equipment-option-row\{[^}]*flex-direction:\s*column/.test(apiSrc)
      || /portal-admin-equipment-option-actions\{[^}]*width:\s*100%/.test(apiSrc),
  );
  assert('EN Remove copy', en.includes("'admin.action.remove': 'Remove'"));
  assert('ES Remove copy', es.includes("'admin.action.remove': 'Quitar'"));

  console.log('\n[B] Course equipment selector authority (active only + historical fallback)');
  const equipFn = (adminUi.match(/function adminEquipmentOfferings\(\)\{[\s\S]*?\n\}/) || [])[0] || '';
  assert(
    'adminEquipmentOfferings filters active !== false',
    /active === false|active !== false/.test(equipFn),
  );
  assert(
    'adminEquipmentOfferings does NOT require active positive price',
    !/adminOfferingHasActivePositivePrice/.test(equipFn),
  );
  assert(
    'historical disabled selected fallback option present',
    /admin\.courseEquipment\.unavailable/.test(adminUi) && /selected disabled/.test(adminUi),
  );
  assert(
    'config load uses include_inactive=true for full catalog',
    /rental-offerings[\s\S]{0,80}include_inactive=true/.test(adminUi),
  );
  assert(
    'keep-edit reload also refreshes rental offerings catalog',
    /function adminReloadConfigKeepingEdit[\s\S]*?rental-offerings[\s\S]*?include_inactive=true[\s\S]*?_equipment_offerings/.test(adminUi),
  );

  console.log('\n[C] Rental item Enabled toggle + duration delete labeling');
  assert(
    'per-item Enabled toggle action present',
    /data-admin-action="toggle-equip-enabled"/.test(adminUi) || /data-admin-action="toggle-offering-active"/.test(adminUi),
  );
  assert(
    'Enabled toggle posts active boolean to rental-offerings',
    /toggle-equip-enabled|toggle-offering-active[\s\S]{0,800}\/staff\/admin\/config\/rental-offerings\/[\s\S]{0,200}active:\s*/.test(adminUi),
  );
  assert(
    'disabled item muted styling class',
    /is-equip-disabled|portal-admin-equip-disabled/.test(adminUi) && /is-equip-disabled|portal-admin-equip-disabled/.test(apiSrc),
  );
  assert(
    'duration delete has removeDuration label (not generic item remove)',
    /admin\.prices\.removeDuration/.test(adminUi) && /delete-price[\s\S]{0,200}removeDuration/.test(adminUi),
  );
  assert('EN removeDuration copy', /admin\.prices\.removeDuration['"]:\s*['"]Remove duration price/.test(en)
    || en.includes("'admin.prices.removeDuration': 'Remove duration price'"));
  assert('ES removeDuration copy', es.includes('admin.prices.removeDuration'));
  assert('EN Enabled/Disabled present', en.includes("'admin.prices.enabled'") && en.includes("'admin.prices.disabled'"));
  assert(
    'Done stays in item header while editing equipment',
    /edit-equipment|equip:[\s\S]{0,400}admin\.action\.done/.test(adminUi)
      || /admin\.action\.done[\s\S]{0,200}cancel-edit/.test(adminUi),
  );
  assert(
    'prices render merges rental offerings for disabled visibility',
    /function adminMergeEquipmentPricingItems/.test(adminUi)
      && /adminAllEquipmentOfferings|\_equipment_offerings/.test(adminUi)
      && /renderAdminSectionPricesFromConfig[\s\S]{0,500}adminMergeEquipmentPricingItems/.test(adminUi)
      && /is-equip-disabled/.test(adminUi),
  );

  console.log('\n[D] Backend offering active-state operation');
  assert('setRentalOfferingActive exported', /function setRentalOfferingActive/.test(offeringsSrc)
    && /setRentalOfferingActive/.test(offeringsSrc.match(/module\.exports[\s\S]*\}/)?.[0] || ''));
  assert(
    'strict boolean validation for active',
    /active must be a boolean|active must be boolean/i.test(offeringsSrc),
  );
  assert(
    'reactivation updates inactive row (no active=true filter on enable path)',
    /setRentalOfferingActive[\s\S]{0,1200}active = true[\s\S]{0,400}active = false|setRentalOfferingActive[\s\S]{0,1200}active = false[\s\S]{0,400}active = true/.test(offeringsSrc)
      || /SET active = \$[\s\S]{0,200}WHERE id =/.test(offeringsSrc),
  );
  assert(
    'API write handler passes body.active',
    /handleAdminConfigRentalOfferingWrite[\s\S]{0,900}active:\s*body\.active|params\.active|setRentalOfferingActive/.test(apiSrc),
  );

  console.log('\n[E] Last-price delete does NOT auto-disable; enable independent of price');
  assert(
    'deactivatePriceRule does not soft-disable offering on last price',
    !/Last active positive price for a rental offering[\s\S]{0,500}setRentalOfferingActive/.test(writesSrc)
      && /must NOT auto-disable the rental offering identity|Catalog active state is independent/.test(writesSrc),
  );
  assert(
    'enable path does not reject unpriced offering',
    !/cannot_enable_unpriced_offering/.test(apiSrc)
      && !/body\.active === true[\s\S]{0,600}buildActivePositivePriceForOfferingSql/.test(apiSrc),
  );
  const ownershipSqlFn = (writesSrc.match(/function buildActivePositivePriceForOfferingSql\([\s\S]*?\n\}/) || [])[0] || '';
  assert(
    'ownership SQL builder uses split_part, not unescaped LIKE',
    /split_part\(item_code,\s*'__',\s*1\)\s*=\s*\$/.test(ownershipSqlFn)
      && !/LIKE/i.test(ownershipSqlFn)
      && !/\$\{[^}]+\}__%/.test(ownershipSqlFn),
  );
  // Hard-delete ownership (split_part) lives on the rental offerings delete path.
  assert(
    'hard delete price ownership uses split_part (not LIKE)',
    /DELETE FROM tenant_price_rules[\s\S]{0,300}split_part\(item_code,\s*'__',\s*1\)/.test(offeringsSrc)
      && !/DELETE FROM tenant_price_rules[\s\S]{0,300}LIKE/i.test(offeringsSrc),
  );

  console.log('\n[F] Behavioral: disable / re-enable exact row + validation');
  const pg = makeOfferingsPg();
  const created = await createRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    label: 'Kayak',
    group_key: 'equipment',
    excludes: [],
    sort_order: 1,
    actorId: 'actor-1',
  });
  assert('create kayak', created.ok === true, JSON.stringify(created));
  const rowId = created.offering && created.offering.id;

  const badActive = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: 'yes',
  });
  assert('invalid active string rejected', badActive.ok === false && /boolean/i.test(String(badActive.error || '')), JSON.stringify(badActive));

  const nullActive = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: null,
  });
  assert('null active rejected', nullActive.ok === false, JSON.stringify(nullActive));

  const disabled = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: false,
    actorId: 'actor-2',
  });
  assert('soft-disable ok', disabled.ok === true && disabled.offering && disabled.offering.active === false, JSON.stringify(disabled));
  assert('same identity preserved on disable', disabled.offering.id === rowId && disabled.offering.offering_key === 'kayak_rental');

  const activeList = await listRentalOfferings(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' });
  assert('disabled absent from active list', !activeList.some((r) => r.offering_key === 'kayak_rental'));

  const allList = await listRentalOfferings(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    includeInactive: true,
  });
  assert('disabled still listed with includeInactive', allList.some((r) => r.offering_key === 'kayak_rental' && r.active === false));

  // label update on inactive must not invent a duplicate; re-enable the exact row
  const renameWhileInactive = await updateRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    label: 'Sea Kayak',
  });
  assert(
    'rename while inactive fails closed OR targets inactive (no silent noop success inventing state)',
    renameWhileInactive.ok === false || (renameWhileInactive.ok && renameWhileInactive.offering.active === false),
    JSON.stringify(renameWhileInactive),
  );

  const reenabled = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: true,
    actorId: 'actor-3',
  });
  assert('re-enable exact row', reenabled.ok === true && reenabled.offering.active === true, JSON.stringify(reenabled));
  assert('re-enable preserves id (no duplicate)', reenabled.offering.id === rowId, JSON.stringify(reenabled));
  assert('re-enable preserves key/label history fields', reenabled.offering.offering_key === 'kayak_rental'
    && reenabled.offering.group_key === 'equipment');

  const idempotent = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: true,
  });
  assert('idempotent re-enable of already-active', idempotent.ok === true && idempotent.offering.active === true);

  const crossLoc = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-sardinero',
    offering_key: 'kayak_rental',
    active: false,
  });
  assert('cross-location denied (not found)', crossLoc.ok === false, JSON.stringify(crossLoc));

  const crossTenant = await setRentalOfferingActive(pg, {
    clientSlug: 'lawave',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: false,
  });
  assert('cross-tenant denied (not found)', crossTenant.ok === false, JSON.stringify(crossTenant));

  // Hard-delete requires multi-table readiness; the offerings-only fake fails closed
  // (authoritative hard-delete lives in verify-sunset-rental-hard-delete.js).
  const hardDel = await deleteRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
  });
  assert(
    'offerings-only fake fails closed for hard delete (missing tables)',
    hardDel.ok === false && hardDel.error === 'admin_db_tables_missing',
    JSON.stringify(hardDel),
  );
  // Enable/disable still works without prices on the same identity.
  const stillThere = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: true,
  });
  assert('can still enable unpriced identity after failed hard-delete probe',
    stillThere.ok === true && stillThere.offering.active === true
    && stillThere.offering.id === rowId, JSON.stringify(stillThere));

  console.log('\n[G] Source gates for equipment pricing model inactive skip still documented');
  assert(
    'pricing model still builds from prices (offerings merged in UI layer)',
    /function buildEquipmentPricingList/.test(modelSrc),
  );

  console.log('\n[H] Adversarial: underscore-containing sibling offering keys (exact ownership)');
  // soft_board vs softxboard: PostgreSQL LIKE soft_board__% matches softxboard__1_day
  // because `_` is a one-character wildcard. Exact split_part ownership must not.
  const TARGET_KEY = 'soft_board';
  const SIBLING_KEY = 'softxboard';
  const targetPriceCode = 'soft_board__1_day';
  const siblingPriceCode = 'softxboard__1_day';
  const legacyBareTarget = 'soft_board';

  assert(
    'BUG CLASS: unescaped LIKE would false-match sibling item_code',
    pgLike(siblingPriceCode, `${TARGET_KEY}__%`) === true,
    `expected LIKE ${TARGET_KEY}__% to match ${siblingPriceCode}`,
  );
  assert(
    'BUG CLASS: unescaped LIKE also matches the true target (control)',
    pgLike(targetPriceCode, `${TARGET_KEY}__%`) === true,
  );
  assert(
    'exact ownership: target duration belongs to soft_board',
    itemCodeBelongsToRentalOffering(targetPriceCode, TARGET_KEY) === true,
  );
  assert(
    'exact ownership: legacy bare item_code equals offering key',
    itemCodeBelongsToRentalOffering(legacyBareTarget, TARGET_KEY) === true,
  );
  assert(
    'exact ownership: sibling softxboard duration does NOT belong to soft_board',
    itemCodeBelongsToRentalOffering(siblingPriceCode, TARGET_KEY) === false,
  );
  assert(
    'exact ownership: target does NOT belong to sibling key',
    itemCodeBelongsToRentalOffering(targetPriceCode, SIBLING_KEY) === false,
  );
  assert(
    'exact ownership: sibling belongs to its own key',
    itemCodeBelongsToRentalOffering(siblingPriceCode, SIBLING_KEY) === true,
  );

  // Exact ownership helper still correct for commercial price resolution
  // (booking/quote fail-closed). Catalog enable is independent of this helper.
  const afterLastTargetDeleted = [
    {
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: targetPriceCode,
      amount_cents: 1500,
      active: false, // just deactivated
    },
    {
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: siblingPriceCode,
      amount_cents: 2200,
      active: true, // sibling still live — must not count for target
    },
  ];
  const targetStillPriced = hasActivePositiveRentalPriceForOffering(afterLastTargetDeleted, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: TARGET_KEY,
  });
  assert(
    'sibling price does not count as target active positive price',
    targetStillPriced === false,
    'target must appear unpriced under exact ownership',
  );
  assert(
    'sibling remains priced under its own key after target last-price delete',
    hasActivePositiveRentalPriceForOffering(afterLastTargetDeleted, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKey: SIBLING_KEY,
    }) === true,
  );

  const unpricedTargetWithSibling = [
    {
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: siblingPriceCode,
      amount_cents: 2200,
      active: true,
    },
  ];
  assert(
    'sibling price is not target ownership for commercial checks',
    hasActivePositiveRentalPriceForOffering(unpricedTargetWithSibling, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKey: TARGET_KEY,
    }) === false,
  );
  assert(
    'true target price still resolves under exact ownership',
    hasActivePositiveRentalPriceForOffering([
      {
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: targetPriceCode,
        amount_cents: 1500,
        active: true,
      },
    ], {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKey: TARGET_KEY,
    }) === true,
  );
  assert(
    'cross-location sibling/target prices do not authorize',
    hasActivePositiveRentalPriceForOffering([
      {
        client_slug: 'sunset',
        location_id: 'sunset-sardinero',
        item_type: 'rental',
        item_code: targetPriceCode,
        amount_cents: 1500,
        active: true,
      },
    ], {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKey: TARGET_KEY,
    }) === false,
  );
  assert(
    'zero amount does not authorize enable',
    hasActivePositiveRentalPriceForOffering([
      {
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: targetPriceCode,
        amount_cents: 0,
        active: true,
      },
    ], {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKey: TARGET_KEY,
    }) === false,
  );

  // SQL builder contract — both production call sites share this exact predicate.
  const withLoc = buildActivePositivePriceForOfferingSql({ hasLocation: true });
  const noLoc = buildActivePositivePriceForOfferingSql({ hasLocation: false });
  assert(
    'SQL builder emits split_part equality (with location)',
    /split_part\(item_code,\s*'__',\s*1\)\s*=\s*\$3/.test(withLoc.sql)
      && /location_id = \$2/.test(withLoc.sql)
      && /amount_cents > 0/.test(withLoc.sql)
      && /active = true/.test(withLoc.sql)
      && /item_type = 'rental'/.test(withLoc.sql)
      && !/LIKE/i.test(withLoc.sql),
  );
  assert(
    'SQL builder emits split_part equality (no location)',
    /split_part\(item_code,\s*'__',\s*1\)\s*=\s*\$2/.test(noLoc.sql)
      && !/location_id/.test(noLoc.sql)
      && !/LIKE/i.test(noLoc.sql),
  );

  console.log(`\n── verify:sunset-admin-equipment-rental-fixes ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
