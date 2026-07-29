'use strict';

/**
 * verify:sunset-admin-equipment-rental-fixes
 *
 * Focused RED→GREEN gate for Admin course equipment + rental availability UX:
 *  - course equipment Remove affordance + layout
 *  - active-only equipment dropdown with historical disabled fallback
 *  - per-item Enabled toggle (offering soft-disable / re-enable)
 *  - duration-row × is price-duration delete (not item delete)
 *  - last active price delete soft-disables the offering server-side
 *  - enable requires at least one active positive price
 *
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
  assert(
    'adminEquipmentOfferings filters active !== false',
    /function adminEquipmentOfferings\(\)\{[^}]*active !== false/.test(adminUi),
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
  assert('EN cannot enable unpriced', en.includes('admin.prices.cannotEnableUnpriced')
    || en.includes("'admin.prices.cannotEnableUnpriced'"));
  assert('ES cannot enable unpriced', es.includes('admin.prices.cannotEnableUnpriced'));
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

  console.log('\n[E] Last-price delete soft-disables offering + enable requires price');
  assert(
    'deactivatePriceRule soft-disables offering when no remaining active prices',
    /deactivatePriceRule[\s\S]{0,3500}(setRentalOfferingActive|deleteRentalOffering|active = false)[\s\S]{0,800}(item_code|offering)/.test(writesSrc),
  );
  assert(
    'enable path rejects unpriced offering',
    /cannot_enable_unpriced|cannotEnableUnpriced|no active positive/.test(apiSrc + offeringsSrc + writesSrc),
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

  const softDel = await deleteRentalOffering(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
  });
  assert('legacy soft-delete still works', softDel.ok === true);
  const reAfterDel = await setRentalOfferingActive(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offering_key: 'kayak_rental',
    active: true,
  });
  assert('can re-enable after DELETE soft-disable', reAfterDel.ok === true && reAfterDel.offering.active === true
    && reAfterDel.offering.id === rowId, JSON.stringify(reAfterDel));

  console.log('\n[G] Source gates for equipment pricing model inactive skip still documented');
  assert(
    'pricing model still builds from prices (offerings merged in UI layer)',
    /function buildEquipmentPricingList/.test(modelSrc),
  );

  console.log(`\n── verify:sunset-admin-equipment-rental-fixes ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
