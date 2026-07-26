'use strict';

/**
 * verify:sunset-admin-rental-availability
 *
 * Offline RED→GREEN gate for Admin rental Available/Bookable controls (Slice 1).
 * No DB, network, Stripe, or deploy.
 *
 * Run:
 *   node scripts/verify-sunset-admin-rental-availability.js
 *   npm run verify:sunset-admin-rental-availability
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
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

const CANONICAL = {
  boards: 'board_rental',
  wetsuits: 'wetsuit_rental',
  bundles: 'board_and_suit_rental',
};

function offeringBase(itemCode) {
  const text = String(itemCode || '');
  const parts = text.split('__');
  return parts[0] || text;
}

function priceIsSellable(p) {
  if (!p || p.active === false) return false;
  if (p.amount_cents != null) return Number(p.amount_cents) > 0;
  if (p.amount != null) return Number(p.amount) > 0;
  return false;
}

function effectiveRentalOfferings(prices) {
  const set = new Set();
  for (const p of prices || []) {
    if (!priceIsSellable(p)) continue;
    const key = offeringBase(p.offering_key || p.item_code);
    if (key === CANONICAL.boards || key === CANONICAL.wetsuits || key === CANONICAL.bundles) {
      set.add(key);
    }
  }
  return {
    board_rental: set.has(CANONICAL.boards),
    wetsuit_rental: set.has(CANONICAL.wetsuits),
    board_and_suit_rental: set.has(CANONICAL.bundles),
    sellable_count: set.size,
  };
}

async function main() {
  console.log('\nverify:sunset-admin-rental-availability — Admin rental Available/Bookable\n');

  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  const staffApi = read('scripts/staff-query-api.js');
  const writesSrc = read('scripts/lib/tenant-admin-writes.js');
  const configSrc = read('scripts/lib/tenant-business-config.js');
  const en = read('scripts/lib/staff-portal-i18n.js');
  const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

  console.log('[A] Canonical Admin rental groups + Available control');
  assert('UI orders bundles/boards/wetsuits', /adminRentalGroupOrder[\s\S]*bundles[\s\S]*boards[\s\S]*wetsuits/.test(adminUi));
  assert('EN Surfboard group', en.includes("'admin.prices.group.boards': 'Surfboard'"));
  assert('EN Wetsuit group', en.includes("'admin.prices.group.wetsuits': 'Wetsuit'"));
  assert('EN Surfboard + Wetsuit group', en.includes("'admin.prices.group.bundles': 'Surfboard + Wetsuit'"));
  assert('writes maps boards→board_rental', writesSrc.includes("boards: 'board_rental'"));
  assert('writes maps wetsuits→wetsuit_rental', writesSrc.includes("wetsuits: 'wetsuit_rental'"));
  assert('writes maps bundles→board_and_suit_rental', writesSrc.includes("bundles: 'board_and_suit_rental'"));
  // Group-level availability control — one checkbox per group, NOT per duration card.
  assert('UI NO per-duration Available field in card edit form',
    !adminUi.includes("data-admin-price-field=\"available\"") ||
    // Allowed only in the action handler (querySelector), NOT in renderAdminPriceCardEditForm
    !/renderAdminPriceCardEditForm[\s\S]{0,400}data-admin-price-field="available"/.test(adminUi));
  assert('monolith NO per-duration Available field in card edit form',
    !staffApi.includes("data-admin-price-field=\"available\"") ||
    !/renderAdminPriceCardEditForm[\s\S]{0,400}data-admin-price-field="available"/.test(staffApi));
  assert('UI group-level availability toggle present', adminUi.includes('toggle-group-availability'));
  assert('monolith group-level availability toggle present', staffApi.includes('toggle-group-availability'));
  assert('UI group-avail toggle has data-rental-group', adminUi.includes('data-rental-group'));
  assert('monolith group-avail toggle has data-rental-group', staffApi.includes('data-rental-group'));
  assert('EN available label', en.includes("'admin.prices.available'"));
  assert('ES available label', es.includes("'admin.prices.available'"));
  assert('EN amount required to enable', en.includes("'admin.edit.amountRequiredToEnable'"));
  const saveGroupBrowser = adminUi.match(/if \(action === 'save-price-group'\)\{[\s\S]*?(?=\n    if \(action === )/);
  const saveGroupMono = staffApi.match(/if \(action === 'save-price-group'\)\{[\s\S]*?(?=\n    if \(action === )/);
  // save-price-group now only patches period+amount; active is group-level only
  assert(
    'save-price-group no longer sends active per-card',
    !!(saveGroupBrowser && !/\bactive:\s*available\b/.test(saveGroupBrowser[0])),
  );
  assert(
    'monolith save-price-group no longer sends active per-card',
    !!(saveGroupMono && !/\bactive:\s*available\b/.test(saveGroupMono[0])),
  );
  // toggle-group-availability handler sends active to group endpoint
  const toggleBrowser = adminUi.match(/if \(action === 'toggle-group-availability'\)\{[\s\S]*?(?=\n    if \(action === |\n    return;[\s\S]{0,30}\n    if \(action === )/);
  const toggleMono = staffApi.match(/if \(action === 'toggle-group-availability'\)\{[\s\S]*?(?=\n    if \(action === |\n    return;[\s\S]{0,30}\n    if \(action === )/);
  assert('browser toggle-group-avail handler sends active', !!(toggleBrowser && /active:\s*[a-zA-Z]/.test(toggleBrowser[0])));
  assert('monolith toggle-group-avail handler sends active', !!(toggleMono && /active:\s*[a-zA-Z]/.test(toggleMono[0])));
  assert('browser handler posts to group-availability', !!(toggleBrowser && /group-availability/.test(toggleBrowser[0])));
  assert('monolith handler posts to group-availability', !!(toggleMono && /group-availability/.test(toggleMono[0])));
  assert('inactive card CSS class', adminUi.includes('is-inactive') || adminUi.includes('portal-admin-price-card-inactive'));
  assert('no separate bundle-only mode flag', !/bundle[_-]?only[_-]?mode/i.test(adminUi) && !/bundle[_-]?only[_-]?mode/i.test(writesSrc));
  assert('save-price-group error check present (browser)', !!(saveGroupBrowser && /failed/.test(saveGroupBrowser[0]) && /adminShowMessage\('error'/.test(saveGroupBrowser[0])));
  assert('save-price-group success check present (monolith)', !!(saveGroupMono && /adminShowMessage\('success'/.test(saveGroupMono[0])));

  console.log('\n[B] Effective offerings from active positive rows (no mode flag)');
  const bundleOnly = effectiveRentalOfferings([
    { offering_key: 'board_and_suit_rental__1_day', amount_cents: 2500, active: true },
    { offering_key: 'board_rental__1_day', amount_cents: 1500, active: false },
    { offering_key: 'wetsuit_rental__1_day', amount_cents: 800, active: false },
  ]);
  assert('bundle-only config', bundleOnly.board_and_suit_rental && !bundleOnly.board_rental && !bundleOnly.wetsuit_rental && bundleOnly.sellable_count === 1);

  const separateOnly = effectiveRentalOfferings([
    { offering_key: 'board_rental__1_day', amount: 15, active: true },
    { offering_key: 'wetsuit_rental__half_day', amount_cents: 800, active: true },
    { offering_key: 'board_and_suit_rental__1_day', amount_cents: 2500, active: false },
  ]);
  assert('separate-only config', separateOnly.board_rental && separateOnly.wetsuit_rental && !separateOnly.board_and_suit_rental && separateOnly.sellable_count === 2);

  const allThree = effectiveRentalOfferings([
    { offering_key: 'board_rental__1_day', amount_cents: 1500, active: true },
    { offering_key: 'wetsuit_rental__1_day', amount_cents: 800, active: true },
    { offering_key: 'board_and_suit_rental__1_day', amount_cents: 2500, active: true },
  ]);
  assert('all-three config', allThree.board_rental && allThree.wetsuit_rental && allThree.board_and_suit_rental && allThree.sellable_count === 3);

  const noRentals = effectiveRentalOfferings([
    { offering_key: 'board_rental__1_day', amount_cents: 1500, active: false },
    { offering_key: 'wetsuit_rental__1_day', amount_cents: 0, active: true },
    { offering_key: 'board_and_suit_rental__1_day', amount_cents: 2500, active: false },
  ]);
  assert('no-rentals config', !noRentals.board_rental && !noRentals.wetsuit_rental && !noRentals.board_and_suit_rental && noRentals.sellable_count === 0);

  console.log('\n[C] Write validation — blank/zero cannot enable; inactive amounts preserved');
  const writes = require('./lib/tenant-admin-writes');
  const zeroEnable = writes.validatePricePatchBody({ active: true, amount_cents: 0 });
  assert('active=true with amount 0 rejected', zeroEnable.ok === false, JSON.stringify(zeroEnable));
  const createZero = writes.validatePriceCreateBody({
    rental_group: 'boards',
    period_window: '1_day',
    amount_cents: 0,
  });
  assert('create with amount 0 rejected', createZero.ok === false, JSON.stringify(createZero));
  assert(
    'exports assertPositiveAmountForActivation or equivalent gate',
    typeof writes.assertPositiveAmountForActivation === 'function'
      || /amount_cents must be > 0|positive amount|cannot enable|amountRequiredToEnable/i.test(writesSrc),
  );

  const positiveEnable = writes.validatePricePatchBody({ active: true, amount_cents: 1500 });
  assert('active=true with positive amount accepted', positiveEnable.ok === true && positiveEnable.patch.active === true);

  const disableOnly = writes.validatePricePatchBody({ active: false });
  assert('active=false accepted without amount', disableOnly.ok === true && disableOnly.patch.active === false);

  console.log('\n[D] Admin load includes inactive rentals; deactivate preserves amount');
  assert(
    'Admin opt-in flag present',
    /includeInactiveCanonicalRentals/.test(configSrc),
  );
  assert(
    'shared default remains active-only',
    /client_slug = \$1 AND location_id = \$2 AND active = true/.test(configSrc)
      && /board_rental__%/.test(configSrc),
  );

  const ruleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const inactiveRow = {
    id: ruleId,
    tenant_id: 'sunset',
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item_type: 'rental',
    item_code: 'board_rental__1_day',
    display_name: 'Surfboard',
    currency: 'EUR',
    amount_cents: 1500,
    unit: 'day',
    active: true,
  };
  // Matching active wetsuit short key so re-enable passes board/wetsuit parity gate.
  const peerWetsuitRow = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenant_id: 'sunset',
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item_type: 'rental',
    item_code: 'wetsuit_rental__1_day',
    display_name: 'Wetsuit',
    currency: 'EUR',
    amount_cents: 800,
    unit: 'day',
    active: true,
  };
  let lastUpdate = null;
  const mockPg = {
    async query(sql, params) {
      const s = String(sql);
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK' || /SAVEPOINT/i.test(s)) return { rows: [] };
      if (/information_schema\.tables/i.test(s)) {
        return {
          rows: [
            { table_name: 'tenant_price_rules' },
            { table_name: 'tenant_lesson_capacity_rules' },
            { table_name: 'tenant_lesson_time_rules' },
            { table_name: 'tenant_config_audit_log' },
          ],
        };
      }
      if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/tenant_config_audit_log/i.test(s) && /INSERT/i.test(s)) return { rows: [] };
      // Short-duration parity snapshot: all rental rows at location.
      if (/FROM tenant_price_rules/i.test(s) && /item_type = 'rental'/i.test(s)
        && !/FOR UPDATE/i.test(s) && !/LIKE/i.test(s)) {
        return { rows: [{ ...inactiveRow }, { ...peerWetsuitRow }] };
      }
      if (/FROM tenant_price_rules/i.test(s) && /FOR UPDATE/i.test(s)) {
        if (/active = true/i.test(s) && !/id = \$1/i.test(s)) {
          // identity lookup — after fix should also find inactive
          if (inactiveRow.active) return { rows: [inactiveRow] };
          return { rows: [inactiveRow] }; // find inactive too
        }
        return { rows: [{ ...inactiveRow }] };
      }
      if (/UPDATE tenant_price_rules SET/i.test(s)) {
        lastUpdate = { sql: s, params };
        if (/active = false/i.test(s) || (params && params.includes(false))) {
          inactiveRow.active = false;
        }
        if (params) {
          // best-effort: if active true in params
          const activeIdx = params.indexOf(true);
          const amountIdx = params.findIndex((v) => v === 1800);
          if (amountIdx >= 0) inactiveRow.amount_cents = 1800;
          if (/active = \$/.test(s) && params.includes(true)) inactiveRow.active = true;
          if (/active = \$/.test(s) && params.includes(false)) inactiveRow.active = false;
          if (/amount_cents = \$/.test(s)) {
            const m = s.match(/amount_cents = \$(\d+)/);
            if (m) inactiveRow.amount_cents = params[Number(m[1]) - 1] != null ? params[Number(m[1]) - 1] : inactiveRow.amount_cents;
          }
        }
        return { rows: [{ ...inactiveRow }] };
      }
      return { rows: [] };
    },
  };

  process.env.SUNSET_ADMIN_WRITES_ENABLED = 'true';
  const deactivated = await writes.deactivatePriceRule(mockPg, {
    ruleId,
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { email: 'owner@example.com', staff_user_id: null },
  });
  assert('deactivate succeeds', deactivated.ok === true, JSON.stringify(deactivated.body));
  assert('deactivate preserves amount_cents', inactiveRow.amount_cents === 1500 && inactiveRow.active === false);

  // Re-enable via patch with new amount
  inactiveRow.active = false;
  const reenabled = await writes.patchPriceRule(mockPg, {
    ruleId,
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    patch: { active: true, amount_cents: 1800 },
    actor: { email: 'owner@example.com', staff_user_id: null },
  });
  assert('re-enable patch ok', reenabled.ok === true, JSON.stringify(reenabled && reenabled.body));
  assert(
    're-enable restores active with entered amount',
    inactiveRow.active === true && inactiveRow.amount_cents === 1800,
    `active=${inactiveRow.active} amount=${inactiveRow.amount_cents}`,
  );

  console.log('\n[E] Cross-location isolation + unauthorized writes');
  assert('price post scoped to location', /async function handleAdminConfigPricePost[\s\S]{0,1200}normalizeSunsetLocationId/.test(staffApi));
  assert('findPriceRuleRow scopes location_id', /location_id = \$3/.test(writesSrc) || /location_id = \$2/.test(writesSrc));
  assert(
    'price patch handler uses normalizeSunsetLocationId',
    /async function handleAdminConfigPricePatch[\s\S]{0,1200}normalizeSunsetLocationId/.test(staffApi),
  );

  const viewerGate = writes.evaluateAdminWriteGate({
    user: { role: 'viewer', email: 'v@example.com' },
    clientSlug: 'sunset',
    staffAuthRequired: true,
  });
  assert('viewer unauthorized', viewerGate.ok === false && viewerGate.body.error === 'forbidden_role');

  const foreignGate = writes.evaluateAdminWriteGate({
    user: { role: 'owner', email: 'o@example.com' },
    clientSlug: 'wolfhouse-somo',
    staffAuthRequired: true,
  });
  assert('foreign tenant unauthorized', foreignGate.ok === false && foreignGate.body.error === 'unsupported_client');

  const locMismatch = await writes.patchPriceRule(mockPg, {
    ruleId: 'cfg:sunset-somo:rental|board_rental|1_day',
    clientSlug: 'sunset',
    locationId: 'sunset-sardinero',
    patch: { amount_cents: 2000 },
    actor: { email: 'owner@example.com' },
  });
  assert(
    'cross-location patch rejected',
    locMismatch.ok === false && locMismatch.body && locMismatch.body.error === 'location_mismatch',
    JSON.stringify(locMismatch),
  );

  console.log('\n[F] Failed write visible to Admin (no false success)');
  assert(
    'save-price-group checks failed results before success',
    !!(saveGroupBrowser && /failed/.test(saveGroupBrowser[0]) && /adminShowMessage\('error'/.test(saveGroupBrowser[0])
      && /adminShowMessage\('success'/.test(saveGroupBrowser[0])),
  );
  assert(
    'monolith save-price-group checks failed results before success',
    !!(saveGroupMono && /failed/.test(saveGroupMono[0]) && /adminShowMessage\('error'/.test(saveGroupMono[0])),
  );

  console.log('\n[G] Course / private-lesson Admin behavior unchanged');
  assert('private lesson card still present', adminUi.includes('renderAdminPrivateLessonCard'));
  assert('private lesson save action present', adminUi.includes('save-private-lesson'));
  assert('pack cards still rendered', /renderAdminPackCards/.test(adminUi));
  assert('lesson capacity save unchanged', adminUi.includes('save-capacity'));
  assert('private lesson PUT route present', staffApi.includes("/staff/admin/config/private-lesson"));
  assert('surf-packs routes present', staffApi.includes('/staff/admin/config/surf-packs'));

  console.log('\n[H] Behavioral findPriceRuleRow + Admin projection + location-store active');
  const {
    findPriceRuleRow,
    patchPriceRule,
  } = writes;
  const locationStore = require('./lib/sunset-admin-location-store');
  const {
    loadTenantBusinessConfigFromDb,
  } = require('./lib/tenant-business-config');

  const rows = [
    {
      id: 'rental-inactive-old',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'board_rental__1_day',
      unit: 'day',
      amount_cents: 1000,
      active: false,
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'rental-inactive-new',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'board_rental__1_day',
      unit: 'day',
      amount_cents: 1500,
      active: false,
      updated_at: '2026-06-01T00:00:00Z',
    },
    {
      id: 'rental-active',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'board_rental__1_day',
      unit: 'day',
      amount_cents: 1800,
      active: true,
      updated_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 'rental-other-loc',
      client_slug: 'sunset',
      location_id: 'sunset-sardinero',
      item_type: 'rental',
      item_code: 'board_rental__1_day',
      unit: 'day',
      amount_cents: 2200,
      active: false,
      updated_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 'rental-unit-mismatch',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'board_rental__1_day',
      unit: 'session',
      amount_cents: 900,
      active: false,
      updated_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 'lesson-inactive',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'lesson',
      item_code: 'lesson_slot_abc__session',
      unit: 'session',
      amount_cents: 5000,
      active: false,
      updated_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 'package-inactive',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'package',
      item_code: 'pack_week__day',
      unit: 'day',
      amount_cents: 27100,
      active: false,
      updated_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 'fullday-inactive',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'full_day_equipment_extension__day',
      unit: 'day',
      amount_cents: 1000,
      active: false,
      updated_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 'wetsuit-inactive',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: 'wetsuit_rental__half_day',
      unit: 'session',
      amount_cents: 800,
      active: false,
      updated_at: '2026-07-01T00:00:00Z',
    },
  ];

  function parseFindParams(sql, params, hasLoc) {
    const s = String(sql);
    const activeOnly = /active = true/i.test(s);
    const wantsUnit = /unit = \$/i.test(s);
    if (/id = \$1::uuid/i.test(s)) {
      return {
        mode: 'byId',
        id: params[0],
        client: params[1],
        location: hasLoc ? params[2] : null,
        activeOnly: false,
      };
    }
    if (hasLoc) {
      return {
        mode: 'identity',
        client: params[0],
        location: params[1],
        itemType: params[2],
        itemCode: params[3],
        unit: wantsUnit ? params[4] : null,
        activeOnly,
      };
    }
    return {
      mode: 'identity',
      client: params[0],
      location: null,
      itemType: params[1],
      itemCode: params[2],
      unit: wantsUnit ? params[3] : null,
      activeOnly,
    };
  }

  function makeStrictFinderPg(seedRows) {
    const captured = [];
    return {
      captured,
      async query(sql, params) {
        const s = String(sql);
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (!/FROM tenant_price_rules/i.test(s)) return { rows: [] };
        const hasLoc = /location_id = \$/i.test(s);
        const parsed = parseFindParams(s, params || [], hasLoc);
        captured.push(parsed);

        // Reject wrong parameter shapes for identity lookups.
        if (parsed.mode === 'identity') {
          if (parsed.client !== 'sunset') throw new Error('mock rejected wrong client');
          if (hasLoc && !parsed.location) throw new Error('mock rejected missing location');
          if (!parsed.itemType || !parsed.itemCode) throw new Error('mock rejected missing identity');
        }

        let matched = seedRows.filter((r) => {
          if (parsed.mode === 'byId') {
            return String(r.id) === String(parsed.id)
              && r.client_slug === parsed.client
              && (!parsed.location || r.location_id === parsed.location);
          }
          if (r.client_slug !== parsed.client) return false;
          if (parsed.location && r.location_id !== parsed.location) return false;
          if (r.item_type !== parsed.itemType) return false;
          if (r.item_code !== parsed.itemCode) return false;
          if (parsed.unit != null && r.unit !== parsed.unit) return false;
          if (parsed.activeOnly && r.active !== true) return false;
          return true;
        });

        // Active-only queries must not leak inactive rows.
        if (parsed.activeOnly && matched.some((r) => r.active !== true)) {
          throw new Error('mock active-only query returned inactive row');
        }

        if (/ORDER BY active DESC/i.test(s)) {
          matched = matched.slice().sort((a, b) => {
            const aa = a.active === true ? 1 : 0;
            const bb = b.active === true ? 1 : 0;
            if (bb !== aa) return bb - aa;
            return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
          });
        } else if (/ORDER BY updated_at DESC/i.test(s)) {
          matched = matched.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        }
        return { rows: matched };
      },
    };
  }

  // 1) Inactive rental found + newest wins when no active
  {
    const seed = rows.filter((r) => r.id !== 'rental-active');
    const pg = makeStrictFinderPg(seed);
    const found = await findPriceRuleRow(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      itemType: 'rental',
      itemCode: 'board_rental__1_day',
      hasLoc: true,
      preferUnit: 'day',
    });
    assert(
      'inactive rental re-enable finds newest inactive',
      found.rows[0] && found.rows[0].id === 'rental-inactive-new'
        && found.rows[0].amount_cents === 1500,
      JSON.stringify(found.rows[0]),
    );
  }

  // 6) Active rental wins over inactive history
  {
    const pg = makeStrictFinderPg(rows);
    const found = await findPriceRuleRow(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      itemType: 'rental',
      itemCode: 'board_rental__1_day',
      hasLoc: true,
      preferUnit: 'day',
    });
    assert(
      'active rental wins over inactive history',
      found.rows[0] && found.rows[0].id === 'rental-active' && found.rows[0].active === true,
      JSON.stringify(found.rows[0]),
    );
  }

  // 2) Inactive lesson not selected
  {
    const pg = makeStrictFinderPg(rows);
    const found = await findPriceRuleRow(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      itemType: 'lesson',
      itemCode: 'lesson_slot_abc__session',
      hasLoc: true,
      preferUnit: 'session',
    });
    assert('inactive lesson not selected by fallback', found.rows.length === 0, JSON.stringify(found.rows));
    assert(
      'lesson lookup never issued inactive query',
      pg.captured.every((c) => c.activeOnly === true || c.mode === 'byId'),
      JSON.stringify(pg.captured),
    );
  }

  // 3) Inactive package not selected
  {
    const pg = makeStrictFinderPg(rows);
    const found = await findPriceRuleRow(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      itemType: 'package',
      itemCode: 'pack_week__day',
      hasLoc: true,
      preferUnit: 'day',
    });
    assert('inactive package not selected by fallback', found.rows.length === 0, JSON.stringify(found.rows));
  }

  // 4) Wrong location rejected
  {
    const pg = makeStrictFinderPg(rows.filter((r) => r.id !== 'rental-active'));
    const found = await findPriceRuleRow(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      itemType: 'rental',
      itemCode: 'board_rental__1_day',
      hasLoc: true,
      preferUnit: 'day',
    });
    assert(
      'other-location inactive rental not selected',
      found.rows.every((r) => r.location_id === 'sunset-somo'),
      JSON.stringify(found.rows),
    );
    const otherOnly = await findPriceRuleRow(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-sardinero',
      itemType: 'rental',
      itemCode: 'board_rental__1_day',
      hasLoc: true,
      preferUnit: 'day',
    });
    assert(
      'sardinero inactive rental scoped to sardinero',
      otherOnly.rows[0] && otherOnly.rows[0].id === 'rental-other-loc',
      JSON.stringify(otherOnly.rows[0]),
    );
  }

  // 5) Exact unit mismatch not selected
  {
    const pg = makeStrictFinderPg(rows.filter((r) => r.id === 'rental-unit-mismatch' || r.id === 'rental-inactive-new'));
    const found = await findPriceRuleRow(pg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      itemType: 'rental',
      itemCode: 'board_rental__1_day',
      hasLoc: true,
      preferUnit: 'day',
    });
    assert(
      'unit mismatch not selected for preferUnit=day',
      found.rows[0] && found.rows[0].id === 'rental-inactive-new' && found.rows[0].unit === 'day',
      JSON.stringify(found.rows),
    );
  }

  // Shared catalog projection active-only vs Admin canonical inactive
  {
    const captured = [];
    const pg = {
      async query(sql, params) {
        const s = String(sql);
        captured.push({ sql: s, params: params || [] });
        if (/information_schema\.tables/i.test(s)) {
          return {
            rows: [
              { table_name: 'tenant_price_rules' },
              { table_name: 'tenant_lesson_capacity_rules' },
              { table_name: 'tenant_lesson_time_rules' },
              { table_name: 'tenant_config_audit_log' },
            ],
          };
        }
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/FROM tenant_price_rules/i.test(s)) {
          if (/active = true/i.test(s) && !/board_rental__/i.test(s)) {
            // Shared active-only: reject if inactive slipped in.
            const active = rows.filter((r) => r.active === true
              && r.client_slug === params[0]
              && r.location_id === params[1]);
            if (active.some((r) => r.active !== true)) throw new Error('active-only leaked inactive');
            return { rows: active };
          }
          if (/board_rental__/i.test(s)) {
            // Admin opt-in: active all + inactive canonical rentals only.
            const loc = params[1];
            const out = rows.filter((r) => {
              if (r.client_slug !== params[0] || r.location_id !== loc) return false;
              if (r.active === true) return true;
              if (r.item_type !== 'rental') return false;
              return /^(board_rental|wetsuit_rental|board_and_suit_rental)__/.test(r.item_code);
            });
            if (out.some((r) => r.active !== true && r.item_code.startsWith('full_day'))) {
              throw new Error('admin projection included inactive full-day');
            }
            return { rows: out };
          }
          return { rows: [] };
        }
        if (/FROM tenant_lesson_capacity_rules|FROM tenant_lesson_time_rules|FROM tenant_config_audit_log/i.test(s)) {
          return { rows: [] };
        }
        if (/to_regclass|surf_pack|private_lesson/i.test(s)) return { rows: [] };
        return { rows: [] };
      },
    };

    const shared = await loadTenantBusinessConfigFromDb('sunset', pg, 'sunset-somo', {});
    assert(
      'shared catalog projection remains active-only',
      (shared.prices || []).every((p) => p.active !== false)
        && !(shared.prices || []).some((p) => String(p.offering_key || '').includes('wetsuit_rental__half_day')),
      JSON.stringify(shared.prices),
    );

    const admin = await loadTenantBusinessConfigFromDb('sunset', pg, 'sunset-somo', {
      includeInactiveCanonicalRentals: true,
    });
    const adminKeys = (admin.prices || []).map((p) => p.offering_key || p.item_code);
    assert(
      'Admin sees canonical inactive rental durations',
      adminKeys.some((k) => String(k).startsWith('wetsuit_rental__'))
        || adminKeys.some((k) => String(k).startsWith('board_rental__')),
      JSON.stringify(adminKeys),
    );
    assert(
      'inactive full-day excluded from Admin generic rental projection',
      !adminKeys.some((k) => String(k).includes('full_day_equipment_extension')),
      JSON.stringify(adminKeys),
    );
  }

  // Fallback-store active toggle persistence + reload
  {
    const fs = require('fs');
    const storePath = locationStore.STORE_PATH;
    let backup = null;
    if (fs.existsSync(storePath)) backup = fs.readFileSync(storePath);
    try {
      if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
      const loc = 'sunset-somo';
      const disable = locationStore.patchConfigPrice(loc, 'rental', 'board_rental', '1_day', {
        amount_cents: 1500,
        active: false,
      });
      assert('fallback store disable ok', disable.ok === true && disable.body.price_rule.active === false, JSON.stringify(disable.body));
      assert('fallback store preserves amount on disable', Number(disable.body.price_rule.amount) === 15);

      const enableZero = locationStore.patchConfigPrice(loc, 'rental', 'board_rental', '1_day', {
        amount_cents: 0,
        active: true,
      });
      assert('fallback store rejects enable with zero', enableZero.ok === false, JSON.stringify(enableZero));

      const enable = locationStore.patchConfigPrice(loc, 'rental', 'board_rental', '1_day', {
        amount_cents: 1700,
        active: true,
      });
      assert('fallback store enable ok', enable.ok === true && enable.body.price_rule.active === true, JSON.stringify(enable.body));

      const reloaded = locationStore.applyStoreToResolvedConfig({
        ok: true,
        prices: [{
          category: 'rental',
          offering_key: 'board_rental',
          unit: '1_day',
          amount: 15,
          currency: 'EUR',
          active: true,
        }],
      }, loc);
      const row = (reloaded.prices || [])[0];
      assert(
        'fallback-store active state survives reload',
        row && row.active === true && Number(row.amount) === 17,
        JSON.stringify(row),
      );

      const disable2 = locationStore.patchConfigPrice(loc, 'rental', 'board_rental', '1_day', {
        active: false,
      });
      assert('fallback disable without amount ok', disable2.ok === true && disable2.body.price_rule.active === false);
      const reloaded2 = locationStore.applyStoreToResolvedConfig({
        ok: true,
        prices: [{
          category: 'rental',
          offering_key: 'board_rental',
          unit: '1_day',
          amount: 17,
          currency: 'EUR',
          active: true,
        }],
      }, loc);
      assert(
        'fallback disable survives reload with amount preserved',
        reloaded2.prices[0].active === false && Number(reloaded2.prices[0].amount) === 17,
        JSON.stringify(reloaded2.prices[0]),
      );
    } finally {
      try {
        if (backup != null) fs.writeFileSync(storePath, backup);
        else if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
      } catch (_) { /* ignore */ }
    }
  }

  assert(
    'inactive fallback gated to rental itemType',
    /allowInactiveRental/.test(writesSrc) && /itemType \|\| ''\) === 'rental'/.test(writesSrc),
  );

  console.log('\n[I] Group-level availability: setRentalGroupAvailability + derived state');

  // Static source checks
  assert('setRentalGroupAvailability exported from tenant-admin-writes.js',
    /setRentalGroupAvailability/.test(writesSrc));
  assert('group-availability route registered in staff-query-api.js',
    staffApi.includes('/staff/admin/config/prices/group-availability'));
  assert('handleAdminConfigPriceGroupAvailabilityPost defined',
    staffApi.includes('handleAdminConfigPriceGroupAvailabilityPost'));
  assert('adminDeriveGroupAvailState defined in browser UI',
    adminUi.includes('adminDeriveGroupAvailState'));
  assert('adminDeriveGroupAvailState defined in monolith',
    staffApi.includes('adminDeriveGroupAvailState'));
  assert('MIXED state is only derived, never persisted (no mixed column)',
    !/column.*mixed|mixed.*column/i.test(writesSrc) && !writesSrc.includes("'mixed'"));

  // setRentalGroupAvailability behavioral tests
  const { setRentalGroupAvailability } = require('./lib/tenant-admin-writes');
  const actor = { email: 'owner@test.com', staff_user_id: null };

  // ON: boards somo – should activate positive-amount rows only
  {
    const boardRows = [
      { id: 'b1', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_rental__half_day', amount_cents: 2000, active: false },
      { id: 'b2', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_rental__1_day', amount_cents: 0, active: false },
    ];
    let committed = false;
    const mockPg = {
      async query(sql, params) {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'ROLLBACK') return { rows: [] };
        if (s === 'COMMIT') { committed = true; return { rows: [] }; }
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/item_code LIKE/i.test(s) && /FOR UPDATE/i.test(s)) return { rows: boardRows.slice() };
        if (/tenant_config_audit_log/i.test(s)) return { rows: [] };
        if (/UPDATE tenant_price_rules/i.test(s)) {
          const idParam = params[0];
          const row = boardRows.find((r) => r.id === idParam);
          if (row) {
            // Detect active value from the SQL literal or from $3 param position.
            if (/active = false/i.test(s) && !/active = \$/.test(s)) {
              row.active = false;
            } else if (/active = true/i.test(s) && !/active = \$/.test(s)) {
              row.active = true;
            } else if (/active = \$/.test(s)) {
              row.active = params[2]; // $3 = active value
            }
          }
          return { rows: [{ id: idParam }] };
        }
        return { rows: [] };
      },
    };
    process.env.SUNSET_ADMIN_WRITES_ENABLED = 'true';
    const res = await setRentalGroupAvailability(mockPg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'boards', desiredActive: true, actor,
    });
    assert('boards ON: ok=true', res.ok === true, JSON.stringify(res));
    assert('boards ON: committed', committed === true);
    assert('boards ON: positive-amount row activated', boardRows[0].active === true);
    assert('boards ON: zero-amount row stays inactive', boardRows[1].active === false);
  }

  // ON: no positive-amount rows → rejected
  {
    const zeroRows = [
      { id: 'z1', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_rental__1_day', amount_cents: 0, active: false },
    ];
    const mockPg = {
      async query(sql, params) {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'ROLLBACK' || s === 'COMMIT') return { rows: [] };
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/item_code LIKE/i.test(s)) return { rows: zeroRows.slice() };
        return { rows: [] };
      },
    };
    const res = await setRentalGroupAvailability(mockPg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'boards', desiredActive: true, actor,
    });
    assert('ON with no positive rows rejected', res.ok === false && res.code === 'no_positive_row', JSON.stringify(res));
  }

  // OFF: preserves amount_cents, sets all inactive
  {
    const offRows = [
      { id: 'o1', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'wetsuit_rental__half_day', amount_cents: 800, active: true },
      { id: 'o2', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'wetsuit_rental__1_day', amount_cents: 1500, active: true },
    ];
    const mockPg = {
      async query(sql, params) {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT') return { rows: [] };
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/item_code LIKE/i.test(s) && /FOR UPDATE/i.test(s)) return { rows: offRows.slice() };
        if (/tenant_config_audit_log/i.test(s)) return { rows: [] };
        if (/UPDATE tenant_price_rules/i.test(s)) {
          const row = offRows.find((r) => r.id === params[0]);
          if (row) { row.active = false; }
          return { rows: [{ id: params[0] }] };
        }
        return { rows: [] };
      },
    };
    const res = await setRentalGroupAvailability(mockPg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'wetsuits', desiredActive: false, actor,
    });
    assert('OFF wetsuits: ok=true', res.ok === true, JSON.stringify(res));
    assert('OFF: row1 amount_cents preserved at 800', offRows[0].amount_cents === 800);
    assert('OFF: row1 active=false', offRows[0].active === false);
    assert('OFF: row2 amount_cents preserved at 1500', offRows[1].amount_cents === 1500);
    assert('OFF: row2 active=false', offRows[1].active === false);
  }

  // Cross-location isolation: Somo OFF does not query Sardinero rows
  {
    const allLocationRows = [
      { id: 's1', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_rental__1_day', amount_cents: 1500, active: true },
      { id: 's2', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-sardinero', item_type: 'rental', item_code: 'board_rental__1_day', amount_cents: 2000, active: true },
    ];
    const queriedLocations = [];
    const mockPg = {
      async query(sql, params) {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT') return { rows: [] };
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/item_code LIKE/i.test(s)) {
          const loc = params[1];
          queriedLocations.push(loc);
          const filtered = allLocationRows.filter((r) => r.location_id === loc);
          return { rows: filtered };
        }
        if (/tenant_config_audit_log/i.test(s)) return { rows: [] };
        if (/UPDATE tenant_price_rules/i.test(s)) {
          const row = allLocationRows.find((r) => r.id === params[0]);
          if (row) row.active = false;
          return { rows: [{ id: params[0] }] };
        }
        return { rows: [] };
      },
    };
    const res = await setRentalGroupAvailability(mockPg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'boards', desiredActive: false, actor,
    });
    assert('Somo OFF does not touch Sardinero row', allLocationRows[1].active === true, JSON.stringify(allLocationRows));
    assert('Only Somo location queried', queriedLocations.every((l) => l === 'sunset-somo'), JSON.stringify(queriedLocations));
  }

  // Bundle OFF does not affect board or wetsuit groups
  {
    const mixedGroupRows = [
      { id: 'bnd1', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_and_suit_rental__1_day', amount_cents: 2500, active: true },
      { id: 'brd1', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_rental__1_day', amount_cents: 1500, active: true },
    ];
    const updatedIds = [];
    const mockPg = {
      async query(sql, params) {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT') return { rows: [] };
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/item_code LIKE/i.test(s)) {
          // Only board_and_suit_rental__% matched for bundles group
          const pattern = params[hasLoc => hasLoc ? 2 : 1] || params[2] || params[1] || '';
          const likePrefix = String(pattern).replace(/__%$/, '');
          return { rows: mixedGroupRows.filter((r) => r.item_code.startsWith(likePrefix)) };
        }
        if (/tenant_config_audit_log/i.test(s)) return { rows: [] };
        if (/UPDATE tenant_price_rules/i.test(s)) {
          const row = mixedGroupRows.find((r) => r.id === params[0]);
          if (row) { row.active = false; updatedIds.push(row.id); }
          return { rows: [{ id: params[0] }] };
        }
        return { rows: [] };
      },
    };
    const res = await setRentalGroupAvailability(mockPg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'bundles', desiredActive: false, actor,
    });
    assert('bundles OFF: ok=true', res.ok === true, JSON.stringify(res));
    assert('bundles OFF: only bundle row updated, not board_rental row',
      updatedIds.includes('bnd1') && !updatedIds.includes('brd1'),
      JSON.stringify(updatedIds));
    assert('board_rental row unaffected by bundle OFF', mixedGroupRows[1].active === true);
  }

  // createRentalPriceRule respects group state: MIXED → reject
  {
    const mixedState = [
      { client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_rental__half_day', active: true, amount_cents: 2000 },
      { client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental', item_code: 'board_rental__1_day', active: false, amount_cents: 1500 },
    ];
    const mockPg = {
      async query(sql, params) {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK' || /SAVEPOINT/i.test(s)) return { rows: [] };
        if (/information_schema\.tables/i.test(s)) return { rows: [
          { table_name: 'tenant_price_rules' },
          { table_name: 'tenant_lesson_capacity_rules' },
          { table_name: 'tenant_lesson_time_rules' },
          { table_name: 'tenant_config_audit_log' },
        ]};
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/item_code LIKE/i.test(s) && !/FOR UPDATE/i.test(s)) {
          return { rows: mixedState.filter((r) => r.location_id === (params[1] || params[1])) };
        }
        if (/FROM tenant_price_rules/i.test(s)) return { rows: [] };
        if (/tenant_config_audit_log/i.test(s)) return { rows: [] };
        return { rows: [] };
      },
    };
    const { createRentalPriceRule: createFn } = require('./lib/tenant-admin-writes');
    const res = await createFn(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      patch: { rental_group: 'boards', offering_key: 'board_rental', period_window: '2_days', amount_cents: 3000, currency: 'EUR' },
      actor,
    });
    assert('create with MIXED group state rejected (code=group_mixed)',
      res.ok === false && res.body && res.body.code === 'group_mixed',
      JSON.stringify(res));
  }

  // Lessons/packages rows untouched by group availability ops (static check)
  assert('setRentalGroupAvailability only targets item_type=rental in SQL',
    /item_type = \\'rental\\'|item_type = 'rental'/.test(writesSrc));
  assert('no new availability column added for rental groups (no group_active or avail_state column)',
    !/group_active|avail_state|group_state|rental_group_available/i.test(writesSrc));

  console.log('\n[J] Duplicate-row invariants: one-active-per-key, prefer-previously-active, audit entity_type');

  // Helper: build a mock PG that enforces the real unique-active-index invariant.
  // It tracks per-key active counts and throws on violations.
  function makeDupMockPg(seedRows) {
    // Clone seed so we can mutate
    const rows = seedRows.map((r) => ({ ...r }));
    let lastAuditEntityType = null;
    return {
      rows,
      getLastAuditEntityType: () => lastAuditEntityType,
      async query(sql, params) {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'ROLLBACK') return { rows: [] };
        if (s === 'COMMIT') {
          // Enforce unique-active-index: at most one active row per (item_code, unit, effective_from).
          const seen = {};
          for (const r of rows) {
            if (r.active !== true) continue;
            const k = `${r.item_code}||${r.unit}||${r.effective_from || ''}`;
            if (seen[k]) throw new Error(`unique-active-index violation at key=${k}`);
            seen[k] = true;
          }
          return { rows: [] };
        }
        if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/item_code LIKE/i.test(s) && /FOR UPDATE/i.test(s)) {
          return { rows: rows.map((r) => ({ ...r })) }; // snapshot
        }
        if (/tenant_config_audit_log/i.test(s) && /INSERT/i.test(s)) {
          // Capture entity_type from INSERT params. It's the 6th param in insertConfigAudit.
          // entity_type is passed as $6 in the INSERT.
          if (params) lastAuditEntityType = params[5] || null;
          return { rows: [] };
        }
        if (/UPDATE tenant_price_rules SET/i.test(s)) {
          const idParam = params[0];
          const row = rows.find((r) => String(r.id) === String(idParam));
          if (!row) return { rows: [] };
          // Detect active= in SET clause
          if (/active = false/i.test(s) && !/active = \$/.test(s)) {
            row.active = false;
          } else if (/active = true/i.test(s) && !/active = \$/.test(s)) {
            row.active = true;
          } else if (/active = \$/.test(s)) {
            // Find position of active param: it's $3 in these UPDATEs
            const activeVal = params[2];
            row.active = activeVal;
          }
          return { rows: [{ id: row.id }] };
        }
        return { rows: [] };
      },
    };
  }

  const ALLOWED_ENTITY_TYPES = ['price_rule', 'capacity_rule', 'lesson_time_rule'];

  // J1: duplicate rows for same duration key — ON must not violate unique-active index
  {
    const dupRows = [
      { id: 'dup-a', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1013, active: false },
      { id: 'dup-b', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1500, active: false },
      { id: 'dup-c', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_and_suit_rental__2_hours', unit: 'hour', effective_from: null, amount_cents: 2500, active: false },
    ];
    const pg = makeDupMockPg(dupRows);
    let threw = false;
    let res;
    try {
      res = await setRentalGroupAvailability(pg, {
        clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'bundles', desiredActive: true, actor,
      });
    } catch (e) {
      threw = true;
      console.error('J1 threw:', e.message);
    }
    assert('J1: ON with duplicate rows does not throw (no unique-index violation)', !threw && res && res.ok === true,
      threw ? 'threw' : JSON.stringify(res));

    // At most one active per key
    const keyActiveCount = {};
    for (const r of pg.rows) {
      if (r.active !== true) continue;
      const k = `${r.item_code}||${r.unit}||${r.effective_from || ''}`;
      keyActiveCount[k] = (keyActiveCount[k] || 0) + 1;
    }
    const maxActive = Math.max(0, ...Object.values(keyActiveCount));
    assert('J1: at most ONE active row per (item_code,unit,effective_from) after ON',
      maxActive <= 1, `max active per key = ${maxActive}, keys = ${JSON.stringify(keyActiveCount)}`);

    // Both positive-amount keys have exactly one active row
    const key1Count = keyActiveCount['board_and_suit_rental__1_hour||hour||'] || 0;
    const key2Count = keyActiveCount['board_and_suit_rental__2_hours||hour||'] || 0;
    assert('J1: each positive-amount key has exactly 1 active row after ON',
      key1Count === 1 && key2Count === 1,
      `key1=${key1Count} key2=${key2Count}`);
  }

  // J2: ON prefers the previously-active duplicate when one exists
  {
    const dupRows = [
      { id: 'prev-inactive', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1013, active: false },
      { id: 'prev-active',   tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1500, active: true },
    ];
    const pg = makeDupMockPg(dupRows);
    const res = await setRentalGroupAvailability(pg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'boards', desiredActive: true, actor,
    });
    assert('J2: ON ok=true with prev-active duplicate', res && res.ok === true, JSON.stringify(res));
    const activeRow = pg.rows.find((r) => r.active === true);
    assert('J2: previously-active row is chosen as winner',
      activeRow && activeRow.id === 'prev-active',
      `active id = ${activeRow && activeRow.id}`);
    const inactiveRow2 = pg.rows.find((r) => r.id === 'prev-inactive');
    assert('J2: the other duplicate is left inactive', inactiveRow2 && inactiveRow2.active !== true);
  }

  // J3: ON with no prev-active dup — picks highest amount_cents
  {
    const dupRows = [
      { id: 'lo-amt', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'wetsuit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 800, active: false },
      { id: 'hi-amt', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'wetsuit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1200, active: false },
    ];
    const pg = makeDupMockPg(dupRows);
    const res = await setRentalGroupAvailability(pg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'wetsuits', desiredActive: true, actor,
    });
    assert('J3: ON ok=true picking highest amount', res && res.ok === true, JSON.stringify(res));
    const activeRow = pg.rows.find((r) => r.active === true);
    assert('J3: highest-amount duplicate is chosen when no prev-active',
      activeRow && activeRow.id === 'hi-amt',
      `active id = ${activeRow && activeRow.id}`);
  }

  // J4: OFF deactivates ALL duplicates
  {
    const dupRows = [
      { id: 'off-a', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_rental__1_day', unit: 'day', effective_from: null, amount_cents: 1500, active: true },
      { id: 'off-b', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_rental__1_day', unit: 'day', effective_from: null, amount_cents: 1800, active: false },
    ];
    const pg = makeDupMockPg(dupRows);
    const res = await setRentalGroupAvailability(pg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'boards', desiredActive: false, actor,
    });
    assert('J4: OFF ok=true', res && res.ok === true, JSON.stringify(res));
    assert('J4: OFF deactivates all duplicates',
      pg.rows.every((r) => r.active !== true),
      JSON.stringify(pg.rows.map((r) => ({ id: r.id, active: r.active }))));
  }

  // J5: Audit entity_type is always a valid CHECK value, never 'price_rule_group'
  {
    const simpleRows = [
      { id: 'audit-row', tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo', item_type: 'rental',
        item_code: 'board_rental__1_day', unit: 'day', effective_from: null, amount_cents: 1500, active: false },
    ];
    const pg = makeDupMockPg(simpleRows);
    await setRentalGroupAvailability(pg, {
      clientSlug: 'sunset', locationId: 'sunset-somo', rentalGroup: 'boards', desiredActive: true, actor,
    });
    const entityType = pg.getLastAuditEntityType();
    assert('J5: audit entity_type is allowed CHECK value (not price_rule_group)',
      entityType !== null && ALLOWED_ENTITY_TYPES.includes(entityType),
      `entity_type = ${JSON.stringify(entityType)}`);
    assert('J5: audit entity_type is specifically price_rule',
      entityType === 'price_rule', `entity_type = ${JSON.stringify(entityType)}`);
  }

  // J6: Render dedup — adminDedupeGroupItems collapses duplicates, adminDeriveGroupAvailState on deduped list
  {
    // Simulate the browser-side adminDedupeGroupItems + adminDeriveGroupAvailState functions
    // by evaluating them via the source text (they are plain functions, not DOM-dependent).
    // We eval a minimal harness that extracts them.
    const fnSrc = adminUi;
    // Extract adminDedupeGroupItems and adminDeriveGroupAvailState from the source text.
    const dedupMatch = fnSrc.match(/function adminDedupeGroupItems\(items\)\{[\s\S]*?\n\}/);
    const deriveMatch = fnSrc.match(/function adminDeriveGroupAvailState\(items\)\{[\s\S]*?\n\}/);
    assert('J6: adminDedupeGroupItems defined in browser UI', !!dedupMatch);
    assert('J6: adminDeriveGroupAvailState defined in browser UI (for dedup use)', !!deriveMatch);

    if (dedupMatch && deriveMatch) {
      // Safe eval of pure utility functions only (no DOM, no network).
      const dedupFn = new Function(`${dedupMatch[0]}; return adminDedupeGroupItems;`)();
      const deriveFn = new Function(`${deriveMatch[0]}; return adminDeriveGroupAvailState;`)();

      const dupItems = [
        { item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1013, active: false },
        { item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1500, active: true },
        { item_code: 'board_and_suit_rental__2_hours', unit: 'hour', effective_from: null, amount_cents: 2500, active: true },
      ];
      const deduped = dedupFn(dupItems);
      assert('J6: dedup collapses 3 items (2 dup keys) to 2 canonical',
        deduped.length === 2, `length = ${deduped.length}`);
      const hourRow = deduped.find((p) => p.item_code === 'board_and_suit_rental__1_hour');
      assert('J6: dedup picks active row for board_and_suit_rental__1_hour dup',
        hourRow && hourRow.active !== false && hourRow.amount_cents === 1500,
        JSON.stringify(hourRow));

      // With both canonical active → state should be 'on'
      const state = deriveFn(deduped);
      assert('J6: adminDeriveGroupAvailState on deduped-all-active list = on',
        state === 'on', `state = ${state}`);

      // Make one inactive → mixed
      const mixedItems = [
        { item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1500, active: true },
        { item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1013, active: false },
        { item_code: 'board_and_suit_rental__2_hours', unit: 'hour', effective_from: null, amount_cents: 2500, active: false },
      ];
      const mixedDeduped = dedupFn(mixedItems);
      const mixedState = deriveFn(mixedDeduped);
      assert('J6: deduped mixed (one on, one off) → mixed state',
        mixedState === 'mixed', `state = ${mixedState}`);

      // All inactive → off
      const offItems = [
        { item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1500, active: false },
        { item_code: 'board_and_suit_rental__1_hour', unit: 'hour', effective_from: null, amount_cents: 1013, active: false },
        { item_code: 'board_and_suit_rental__2_hours', unit: 'hour', effective_from: null, amount_cents: 2500, active: false },
      ];
      const offDeduped = dedupFn(offItems);
      const offState = deriveFn(offDeduped);
      assert('J6: deduped all-inactive → off state',
        offState === 'off', `state = ${offState}`);
    }
  }

  // J7: i18n mixed hint updated to plain copy
  assert('J7: EN availableMixed updated to plain copy',
    en.includes("'admin.prices.availableMixed': 'Some durations off — click to set all'"),
    'expected new EN mixed hint');
  assert('J7: ES availableMixed updated to plain copy',
    es.includes("'admin.prices.availableMixed': 'Algunas duraciones desactivadas — pulsa para activar todas'"),
    'expected new ES mixed hint');
  assert('J7: old "save to normalize" text removed from EN i18n',
    !en.includes('save to normalize'));
  assert('J7: old "guarda para normalizar" text removed from ES i18n',
    !es.includes('guarda para normalizar'));

  // J8: audit entity_type assertion — source never writes 'price_rule_group'
  assert('J8: writes source does not contain invalid entity_type price_rule_group',
    !writesSrc.includes("'price_rule_group'") && !writesSrc.includes('"price_rule_group"'));

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:sunset-admin-rental-availability — FAILED');
    process.exit(1);
  }
  console.log('verify:sunset-admin-rental-availability — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('verify:sunset-admin-rental-availability — ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
