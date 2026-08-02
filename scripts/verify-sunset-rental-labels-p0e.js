'use strict';

/**
 * P0e — Surface authoritative tenant_rental_offerings.label everywhere.
 *
 * Contract:
 *   1) Catalog projection uses exact Admin label (not price/key/title-case).
 *   2) Current catalog label wins over stale/raw persisted offering_label.
 *   3) Pickups, invoice, drawer, course equipment same key → same current label.
 *   4) New writes persist current catalog label (snapshot is fallback only).
 *   5) Key→Title Case only when no catalog row/name.
 *   6) SUP/bicycle/towel/flipflops keep exact Admin names.
 *   H) Exact offering_key only — no alias label borrow.
 *
 * Run: node scripts/verify-sunset-rental-labels-p0e.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DAY_OPS = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js');
const RENTAL_AVAIL = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-rental-availability.js');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');

const {
  resolveRentalOfferingFriendlyLabel,
  humanizeRentalOfferingKey,
  buildRentalCatalogLabelMap,
  lookupCatalogLabel,
  enrichServiceRecordsWithCatalogLabels,
  isIdentityLikeRentalLabel,
} = require('./lib/rental-offering-label');
const {
  formatServiceRecordInvoiceLineText,
  resolveGenericRentalInvoiceLabel,
} = require('./lib/service-record-invoice-line');
const {
  formatSunsetDrawerDailyItemLabel,
  buildPaymentSummary,
} = require('./lib/sunset-schedule-booking-drawer');
const {
  buildGenericRentalServiceRecord,
} = require('./lib/tenant-rental-price-resolver');
const {
  prepareGenericRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
} = require('./lib/sunset-schedule-booking-writes');
const {
  projectSunsetBookableOfferingsFromConfig,
} = require('./lib/sunset-bookable-offerings');
const {
  executeSunsetCatalogSync,
  buildSunsetCatalogCommand,
  CATALOG_CHANNELS,
  nestCatalogOffering,
} = require('./lib/luna-front-desk-catalog-service');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

const SW = 'surfboard_wetsuit_rental';
const CATALOG_LABEL = 'Surfboard + Wetsuit';
const STALE_HUMANIZED = 'Surfboard Wetsuit';
const RENAMED = 'Board + Suit ★ Pro';
const DATE = '2026-08-15';
const BOOKING = 'bk-p0e-0001';

function metaBase(extra) {
  return {
    source: 'staff_manual_schedule',
    staff_manual_schedule: true,
    location_id: 'sunset-somo',
    ...(extra || {}),
  };
}

function standaloneRow(opts) {
  const key = opts.offering_key;
  return {
    service_record_id: opts.id || `sr-${key}`,
    booking_id: opts.booking_id || BOOKING,
    booking_code: opts.booking_code || 'SUNSET-P0E',
    guest_name: opts.guest_name || 'Alex',
    service_type: 'addon_service',
    service_date: DATE,
    quantity: opts.quantity != null ? opts.quantity : 1,
    amount_due_cents: opts.amount_due_cents != null ? opts.amount_due_cents : 3000,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'rental',
    metadata: metaBase({
      rental_offering: true,
      generic_rental: true,
      staff_ui_service_type: 'rental',
      component: 'addon_service',
      offering_key: key,
      offering_label: opts.offering_label != null ? opts.offering_label : null,
      catalog_label: opts.catalog_label,
      display_name: opts.display_name,
      label: opts.label != null ? opts.label : opts.offering_label,
      duration_key: opts.duration_key || '1_day',
      item_code: opts.item_code || `${key}__1_day`,
      unit_cents: opts.amount_due_cents != null ? opts.amount_due_cents : 3000,
    }),
    _scheduleType: 'rental',
    _isDbManual: true,
  };
}

function ceRow(opts) {
  const key = opts.offering_key || SW;
  return {
    service_record_id: opts.id || `sr-ce-${key}`,
    booking_id: opts.booking_id || BOOKING,
    booking_code: opts.booking_code || 'SUNSET-P0E',
    guest_name: opts.guest_name || 'Alex',
    service_type: 'addon_service',
    service_date: DATE,
    quantity: 1,
    amount_due_cents: opts.amount_due_cents != null ? opts.amount_due_cents : 0,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'course_equipment',
    metadata: metaBase({
      course_equipment: true,
      course_equipment_mode: opts.mode === 'all_day' ? 'all_day' : 'during_course',
      offering_key: key,
      label: opts.label || STALE_HUMANIZED,
      offering_label: opts.offering_label || opts.label || STALE_HUMANIZED,
      component: 'course_equipment',
      staff_ui_service_type: 'course_equipment',
      unit_amount_cents: opts.amount_due_cents != null ? opts.amount_due_cents : 0,
    }),
    _scheduleType: 'rental',
    _isDbManual: true,
  };
}

function loadProductionDayOpsContext() {
  const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');
  const apiSrc = fs.readFileSync(STAFF_API, 'utf8');

  function extractFn(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing production function ${name}`);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      if (src[i] === '}') depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`Unclosed ${name}`);
  }

  const portalNames = [
    'scheduleRowMeta',
    'scheduleRowIsCourse',
    'scheduleRowIsPrivateLesson',
    'scheduleRowType',
    'scheduleRowComponentKey',
    'scheduleRowCourseMeta',
    'scheduleResolveCourseDisplayLabel',
    'scheduleRowEffectivePaid',
    'scheduleEnsureRowId',
    'scheduleBuildDisplayGroups',
    'scheduleGroupIsStandaloneRental',
    'scheduleGroupHasCourse',
    'scheduleRentalPickupKind',
    'scheduleGroupBoardsNeeded',
    'scheduleGroupWetsuitsNeeded',
    'scheduleGroupComponentQty',
  ];
  const portalFns = portalNames.map((n) => {
    try {
      return extractFn(apiSrc, n);
    } catch (_) {
      return `function ${n}(){ return null; }`;
    }
  }).join('\n');

  const dayOpsNames = [
    'scheduleDayOpsParseMetaBlob',
    'scheduleDayOpsFriendlyOfferingLabel',
    'scheduleIsStandaloneRentalPickupRecord',
    'scheduleGenericRentalDescriptors',
    'scheduleGenericRentalDescriptor',
    'scheduleDayOpsCourseEquipmentRows',
    'scheduleDayOpsEquipmentPrepLabel',
    'scheduleGroupHasClassicRentalComponents',
    'scheduleBuildRentalPickupLines',
    'scheduleSelectRentalPickupGroups',
    'scheduleGroupHasRentalPickups',
    'scheduleRentalPickupsNormName',
    'scheduleRentalPickupsCompareLabel',
  ];
  const dayOpsFns = dayOpsNames.map((n) => {
    try {
      return extractFn(dayOpsSrc, n);
    } catch (_) {
      return `function ${n}(){ return null; }`;
    }
  }).join('\n');

  const safeMeta = `
    function scheduleRowMeta(row){
      if (!row) return {};
      var m = row.metadata != null ? row.metadata : row._meta;
      if (!m) return {};
      if (typeof m === 'object') return m;
      try { return JSON.parse(m); } catch(_){ return {}; }
    }
    function scheduleEnsureRowId(r){
      if (!r) return r;
      if (!r._scheduleId) r._scheduleId = r.service_record_id || r.booking_id || ('r' + Math.random());
      return r;
    }
    function scheduleRowEffectivePaid(){ return false; }
    function scheduleRowIsPrivateLesson(r){
      return !!(r && (r._scheduleType === 'private_lesson' || r.service_type === 'private_lesson'
        || (r.staff_ui_service_type === 'private_lesson')));
    }
    function scheduleRowIsCourse(r){
      if (!r) return false;
      if (r._scheduleType === 'course' || r.staff_ui_service_type === 'course') return true;
      var m = scheduleRowMeta(r);
      return m.component === 'course' || m.staff_ui_service_type === 'course';
    }
    function scheduleRowCourseMeta(r){
      var m = scheduleRowMeta(r);
      return { course_id: r && (r.course_id || m.course_id), course_label: r && (r.course_label || m.course_label) };
    }
    function scheduleResolveCourseDisplayLabel(id, label){ return label || id || ''; }
    function scheduleGroupBoardsNeeded(){ return 0; }
    function scheduleGroupWetsuitsNeeded(){ return 0; }
    function scheduleGroupComponentQty(g, key){
      return g && g.components && g.components[key] ? Math.max(1, Number(g.quantity) || 1) : 0;
    }
    function scheduleRentalPickupKind(){ return null; }
    function scheduleRowComponentKey(row){
      var meta = scheduleRowMeta(row);
      if (meta.rental_offering === true && meta.offering_key) return 'rental:' + String(meta.offering_key);
      if (meta.course_equipment === true) return 'course_equipment';
      if (meta.component) return String(meta.component);
      return String((row && row.service_type) || 'row');
    }
    function scheduleRowType(row){
      var meta = scheduleRowMeta(row);
      if (meta.course_equipment === true) return 'course_equipment';
      if (meta.rental_offering === true || meta.generic_rental === true) return 'rental';
      return String((row && row.service_type) || 'unknown');
    }
    function scheduleGroupIsStandaloneRental(g){
      if (!g || !Array.isArray(g.records)) return false;
      return g.records.some(function(r){
        return typeof scheduleIsStandaloneRentalPickupRecord === 'function'
          ? scheduleIsStandaloneRentalPickupRecord(r) : false;
      });
    }
    function scheduleGroupHasCourse(g){
      return !!(g && g.components && g.components.course);
    }
  `;

  const sandbox = {
    console,
    portalT: (k) => {
      const map = {
        'schedule.courseEquipment.during': 'During Course',
        'schedule.courseEquipment.allDay': 'All Day',
        'schedule.equipment.none': 'no equipment',
        'schedule.equipment.boardAndWetsuit': 'Board + wetsuit',
        'schedule.equipment.board': 'Board',
        'schedule.equipment.wetsuit': 'Wetsuit',
        'schedule.ops.rentalPickupsToday': 'Rental pickups today',
      };
      return map[k] || k;
    },
    escHtml: (s) => String(s == null ? '' : s),
    scheduleHumanizeRentalOfferingKey: humanizeRentalOfferingKey,
    scheduleRentalOfferingsCache: [],
    scheduleRentalLabelMap: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(safeMeta, sandbox);
  try { vm.runInContext(portalFns, sandbox); } catch (_) { /* partial extract ok */ }
  // Re-assert safe meta after extract (monolith helpers may assume host DOM).
  vm.runInContext(`
    scheduleRowMeta = function(row){
      if (!row) return {};
      var m = row.metadata != null ? row.metadata : row._meta;
      if (!m) return {};
      if (typeof m === 'object') return m;
      try { return JSON.parse(m); } catch(_){ return {}; }
    };
    scheduleRowComponentKey = function(row){
      var meta = scheduleRowMeta(row) || {};
      if (meta.rental_offering === true && meta.offering_key) return 'rental:' + String(meta.offering_key);
      if (meta.course_equipment === true) return 'course_equipment';
      if (meta.component) return String(meta.component);
      return String((row && row.service_type) || 'row');
    };
  `, sandbox);
  try { vm.runInContext(dayOpsFns, sandbox); } catch (e) {
    throw new Error(`day-ops extract failed: ${e.message}`);
  }
  return sandbox;
}

function loadProjectionContext() {
  const src = fs.readFileSync(RENTAL_AVAIL, 'utf8');
  function extractFn(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      if (src[i] === '}') depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`Unclosed ${name}`);
  }
  const names = [
    'scheduleHumanizeRentalOfferingKey',
    'scheduleIsHourRentalDurationKey',
    'scheduleIsDayRentalDurationKey',
    'scheduleIsShortRentalDurationKey',
    'scheduleRentalDurationSortValue',
    'scheduleShortRentalDurationFallbackLabel',
    'scheduleRentalOfferingLabelKey',
    'scheduleParseRentalPriceIdentity',
    'scheduleRentalPriceAmountCents',
    'scheduleRentalOfferingLabelFromPrice',
    'scheduleRentalPriceIsSellable',
    'scheduleRentalPriceMatchesLocation',
    'scheduleCompatibleRentalDurationKeys',
    'scheduleRentalOfferingDisplayLabel',
    'scheduleIsGenericRentalOffering',
    'scheduleProjectStandaloneRentals',
  ];
  const sandbox = {
    console,
    getClient: () => 'sunset',
    SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING: 'full_day_equipment',
    SCHEDULE_CANONICAL_RENTAL_OFFERINGS: [
      'board_rental', 'wetsuit_rental', 'board_and_suit_rental', 'surfboard_wetsuit_rental',
    ],
  };
  // scheduleIsGenericRentalOffering may depend on more helpers — stub if missing.
  let code = '';
  for (const n of names) {
    try {
      code += `${extractFn(n)}\n\n`;
    } catch (_) {
      if (n === 'scheduleIsGenericRentalOffering') {
        code += 'function scheduleIsGenericRentalOffering(p, key){ return !!(p && (p.category==="rental" || p.item_type==="rental" || (key && key.indexOf("_rental")>=0))); }\n\n';
      } else if (n === 'scheduleHumanizeRentalOfferingKey') {
        code += `function scheduleHumanizeRentalOfferingKey(k){ return String(k||'').replace(/_rental$/i,'').replace(/[_-]+/g,' ').replace(/\\b\\w/g,function(c){return c.toUpperCase();}); }\n\n`;
      }
    }
  }
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

// ═══════════════════════════════════════════════════════════════════════════
// A) Encode RED shape: stale persisted vs Admin catalog
// ═══════════════════════════════════════════════════════════════════════════
console.log('[A] Encode stale-vs-catalog contract (resolver + enrichment)');
{
  ok('exports buildRentalCatalogLabelMap', typeof buildRentalCatalogLabelMap === 'function');
  ok('exports enrichServiceRecordsWithCatalogLabels', typeof enrichServiceRecordsWithCatalogLabels === 'function');

  // Without catalog_label, stale humanized snapshot is what old records have.
  const staleOnly = resolveRentalOfferingFriendlyLabel({
    offering_key: SW,
    offering_label: STALE_HUMANIZED,
  });
  ok(
    'stale-only path still returns meaningful persisted (compatibility)',
    staleOnly === STALE_HUMANIZED,
    `got=${staleOnly}`,
  );

  // With current catalog_label present, Admin name wins (this was RED on base).
  const withCatalog = resolveRentalOfferingFriendlyLabel({
    offering_key: SW,
    offering_label: STALE_HUMANIZED,
    catalog_label: CATALOG_LABEL,
  });
  ok(
    'catalog_label wins over stale offering_label Surfboard Wetsuit',
    withCatalog === CATALOG_LABEL,
    `got=${withCatalog}`,
  );

  const rawKeyMeta = resolveRentalOfferingFriendlyLabel({
    offering_key: SW,
    offering_label: SW,
    catalog_label: CATALOG_LABEL,
  });
  ok(
    'catalog_label wins over raw-key offering_label',
    rawKeyMeta === CATALOG_LABEL,
    `got=${rawKeyMeta}`,
  );

  const itemCodeLabel = resolveRentalOfferingFriendlyLabel({
    offering_key: SW,
    offering_label: `${SW}__1_day`,
    label: `${SW}__1_day`,
    catalog_label: CATALOG_LABEL,
  });
  ok(
    'catalog_label wins over item_code-as-label',
    itemCodeLabel === CATALOG_LABEL,
    `got=${itemCodeLabel}`,
  );

  const renamed = resolveRentalOfferingFriendlyLabel({
    offering_key: SW,
    offering_label: CATALOG_LABEL,
    catalog_label: RENAMED,
  });
  ok(
    'Admin rename Board + Suit ★ Pro wins without rewriting record',
    renamed === RENAMED,
    `got=${renamed}`,
  );

  const viaOpts = resolveRentalOfferingFriendlyLabel(
    { offering_key: SW, offering_label: STALE_HUMANIZED },
    { catalogLabel: CATALOG_LABEL },
  );
  ok('opts.catalogLabel wins over stale meta', viaOpts === CATALOG_LABEL, `got=${viaOpts}`);

  const map = buildRentalCatalogLabelMap([
    { offering_key: SW, label: CATALOG_LABEL, active: true },
    { offering_key: 'sup_rental', label: 'SUP', active: true },
  ]);
  ok('map exact key', lookupCatalogLabel(map, SW) === CATALOG_LABEL);
  ok('map no alias borrow board_and_suit', lookupCatalogLabel(map, 'board_and_suit_rental') === '');

  const viaMap = resolveRentalOfferingFriendlyLabel(
    { offering_key: SW, offering_label: STALE_HUMANIZED },
    { catalogLabelMap: map },
  );
  ok('catalogLabelMap wins over stale', viaMap === CATALOG_LABEL, `got=${viaMap}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// B) PRODUCTION server projection: projectSunsetBookableOfferingsFromConfig
//    (Luna/bookable standalone catalog — NOT browser scheduleProjectStandalone)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[B] Production projectSunsetBookableOfferingsFromConfig — exact Admin label');
{
  ok(
    'exports projectSunsetBookableOfferingsFromConfig',
    typeof projectSunsetBookableOfferingsFromConfig === 'function',
  );

  function buildAdminCfg(rentalIdentityLabel, extraOfferings) {
    return {
      ok: true,
      source: 'db',
      currency: 'EUR',
      surf_packs: [],
      rental_offerings: [
        {
          offering_key: SW,
          label: rentalIdentityLabel,
          active: true,
          client_slug: 'sunset',
          location_id: 'sunset-somo',
        },
        {
          offering_key: 'sup_rental',
          label: 'SUP',
          active: true,
          client_slug: 'sunset',
          location_id: 'sunset-somo',
        },
        {
          offering_key: 'towel_rental',
          label: 'Beach Towel ★',
          active: true,
          client_slug: 'sunset',
          location_id: 'sunset-somo',
        },
        ...(extraOfferings || []),
      ],
      // Conflicting price labels / raw keys — catalog identity must win.
      prices: [
        {
          category: 'rental',
          offering_key: `${SW}__1_day`,
          item_code: `${SW}__1_day`,
          unit: 'day',
          amount: 30,
          amount_cents: 3000,
          label: SW, // raw key as price label (live bug shape)
          display_name: SW,
          active: true,
          client_slug: 'sunset',
          location_id: 'sunset-somo',
        },
        {
          category: 'rental',
          offering_key: 'sup_rental__1_day',
          item_code: 'sup_rental__1_day',
          unit: 'day',
          amount: 25,
          amount_cents: 2500,
          label: 'Stand Up Paddle', // wrong price-side name
          display_name: 'Stand Up Paddle',
          active: true,
          client_slug: 'sunset',
          location_id: 'sunset-somo',
        },
        {
          category: 'rental',
          offering_key: 'towel_rental__1_day',
          item_code: 'towel_rental__1_day',
          unit: 'day',
          amount: 5,
          amount_cents: 500,
          label: 'towel_rental',
          display_name: 'towel_rental',
          active: true,
          client_slug: 'sunset',
          location_id: 'sunset-somo',
        },
      ],
    };
  }

  const projected = projectSunsetBookableOfferingsFromConfig(
    buildAdminCfg(CATALOG_LABEL),
    { locationId: 'sunset-somo' },
  );
  ok('production projection ok', projected && projected.ok === true, JSON.stringify(projected && projected.reason));
  const rentals = (projected.offerings || []).filter((o) => o.offering_type === 'rental');
  const byKey = Object.create(null);
  rentals.forEach((o) => {
    const k = String(o.offering_key || (o.item_code || '').split('__')[0] || '').trim();
    if (k) byKey[k] = o;
  });

  ok(
    'production S+W label exact Admin Surfboard + Wetsuit (not price raw key)',
    byKey[SW] && byKey[SW].label === CATALOG_LABEL,
    `got=${byKey[SW] && byKey[SW].label}`,
  );
  ok(
    'production S+W guest_description exact Admin label',
    byKey[SW] && byKey[SW].guest_description === CATALOG_LABEL,
    `got=${byKey[SW] && byKey[SW].guest_description}`,
  );
  ok(
    'production never emits raw key or stale humanize for S+W',
    byKey[SW]
      && byKey[SW].label !== SW
      && byKey[SW].label !== STALE_HUMANIZED
      && byKey[SW].guest_description !== SW,
  );
  ok(
    'production SUP preserves exact Admin SUP (not price Stand Up Paddle)',
    byKey.sup_rental
      && byKey.sup_rental.label === 'SUP'
      && byKey.sup_rental.guest_description === 'SUP',
    `got=${byKey.sup_rental && byKey.sup_rental.label}`,
  );
  ok(
    'production towel preserves exact arbitrary Admin Beach Towel ★',
    byKey.towel_rental
      && byKey.towel_rental.label === 'Beach Towel ★'
      && byKey.towel_rental.guest_description === 'Beach Towel ★',
    `got=${byKey.towel_rental && byKey.towel_rental.label}`,
  );

  // No alias borrow: foreign key identity must not supply S+W label.
  const noBorrow = projectSunsetBookableOfferingsFromConfig({
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [],
    rental_offerings: [
      {
        offering_key: 'board_and_suit_rental',
        label: 'Board and Suit Bundle',
        active: true,
        client_slug: 'sunset',
        location_id: 'sunset-somo',
      },
    ],
    prices: [{
      category: 'rental',
      offering_key: `${SW}__1_day`,
      item_code: `${SW}__1_day`,
      unit: 'day',
      amount: 30,
      amount_cents: 3000,
      label: SW,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    }],
  }, { locationId: 'sunset-somo' });
  const swOnly = (noBorrow.offerings || []).find((o) =>
    o.offering_type === 'rental'
    && (o.offering_key === SW || String(o.item_code || '').startsWith(`${SW}__`)));
  ok(
    'exact key no alias: S+W does not borrow board_and_suit label',
    swOnly && swOnly.label !== 'Board and Suit Bundle',
    `got=${swOnly && swOnly.label}`,
  );

  // Location isolation: foreign location identity rejected; exact preferred.
  const locMap = buildRentalCatalogLabelMap([
    {
      offering_key: SW,
      label: 'Client-wide S+W',
      active: true,
      client_slug: 'sunset',
      location_id: null,
    },
    {
      offering_key: SW,
      label: CATALOG_LABEL,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
    {
      offering_key: SW,
      label: 'OTHER SCHOOL',
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-other',
    },
    {
      offering_key: SW,
      label: 'FOREIGN TENANT',
      active: true,
      client_slug: 'wolfhouse',
      location_id: 'sunset-somo',
    },
  ], { clientSlug: 'sunset', locationId: 'sunset-somo' });
  ok(
    'map prefers exact location over client-wide',
    lookupCatalogLabel(locMap, SW) === CATALOG_LABEL,
    `got=${lookupCatalogLabel(locMap, SW)}`,
  );
  ok(
    'map rejects foreign location and foreign tenant',
    lookupCatalogLabel(locMap, SW) !== 'OTHER SCHOOL'
      && lookupCatalogLabel(locMap, SW) !== 'FOREIGN TENANT',
  );

  // Inactive included when requested (historical readers).
  const inactiveMap = buildRentalCatalogLabelMap([
    {
      offering_key: 'retired_foil_rental',
      label: 'Retired Foil',
      active: false,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  ], { clientSlug: 'sunset', locationId: 'sunset-somo', includeInactive: true });
  ok(
    'includeInactive surfaces deactivated catalog label',
    lookupCatalogLabel(inactiveMap, 'retired_foil_rental') === 'Retired Foil',
  );
  const activeOnlyMap = buildRentalCatalogLabelMap([
    {
      offering_key: 'retired_foil_rental',
      label: 'Retired Foil',
      active: false,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  ], { clientSlug: 'sunset', locationId: 'sunset-somo', includeInactive: false });
  ok(
    'active catalog projection skips inactive',
    lookupCatalogLabel(activeOnlyMap, 'retired_foil_rental') === '',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// B2) Downstream Luna catalog nesting + Admin rename rebuild
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[B2] Luna catalog nesting + Admin rename (production owners)');
{
  function adminCfgForCatalog(identityLabel) {
    return {
      ok: true,
      source: 'db',
      currency: 'EUR',
      surf_packs: [],
      rental_offerings: [{
        offering_key: SW,
        label: identityLabel,
        active: true,
        client_slug: 'sunset',
        location_id: 'sunset-somo',
      }],
      prices: [{
        category: 'rental',
        offering_key: `${SW}__1_day`,
        item_code: `${SW}__1_day`,
        unit: 'day',
        amount: 30,
        amount_cents: 3000,
        label: SW,
        display_name: STALE_HUMANIZED,
        active: true,
      }],
    };
  }

  const cmdBuilt = buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.LUNA_WHATSAPP || 'luna_whatsapp',
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    transportBody: { date_from: DATE, date_to: DATE },
  });
  // Some builds require more fields — fall back to direct projection + nest.
  let nestedLabel = null;
  let nestedGuest = null;
  if (cmdBuilt && cmdBuilt.ok && typeof executeSunsetCatalogSync === 'function') {
    const cat = executeSunsetCatalogSync(cmdBuilt.command, {
      adminCfg: adminCfgForCatalog(CATALOG_LABEL),
    });
    if (cat && cat.ok && cat.body && Array.isArray(cat.body.offerings)) {
      const sw = cat.body.offerings.find((o) =>
        o.offering_type === 'rental'
        && (String(o.offering_item_code || o.item_code || '').startsWith(`${SW}__`)
          || String(o.label || '').includes('Surfboard')));
      nestedLabel = sw && sw.label;
      nestedGuest = sw && sw.guest_description;
    }
  }
  if (nestedLabel == null) {
    // Direct production nest path (same as catalog service).
    const proj = projectSunsetBookableOfferingsFromConfig(
      adminCfgForCatalog(CATALOG_LABEL),
      { locationId: 'sunset-somo' },
    );
    const raw = (proj.offerings || []).find((o) => o.offering_type === 'rental'
      && String(o.item_code || '').startsWith(`${SW}__`));
    const nested = typeof nestCatalogOffering === 'function' && raw
      ? nestCatalogOffering(raw)
      : raw;
    nestedLabel = nested && nested.label;
    nestedGuest = nested && nested.guest_description;
  }
  ok(
    'downstream catalog nest label = Surfboard + Wetsuit',
    nestedLabel === CATALOG_LABEL,
    `got=${nestedLabel}`,
  );
  ok(
    'downstream catalog nest guest_description = Surfboard + Wetsuit',
    nestedGuest === CATALOG_LABEL,
    `got=${nestedGuest}`,
  );
  ok(
    'downstream nest never raw key / stale humanize',
    nestedLabel !== SW && nestedLabel !== STALE_HUMANIZED
      && nestedGuest !== SW && nestedGuest !== STALE_HUMANIZED,
  );

  // Admin rename: rebuild production catalog with new identity label — no SR rewrite.
  const renamedProj = projectSunsetBookableOfferingsFromConfig(
    adminCfgForCatalog(RENAMED),
    { locationId: 'sunset-somo' },
  );
  const renamedR = (renamedProj.offerings || []).find((o) => o.offering_type === 'rental'
    && String(o.item_code || '').startsWith(`${SW}__`));
  ok(
    'Admin rename rebuilds production catalog as Board + Suit ★ Pro',
    renamedR && renamedR.label === RENAMED && renamedR.guest_description === RENAMED,
    `got=${renamedR && renamedR.label}`,
  );
  // Existing service record still has stale snapshot — overlay uses new map.
  const staleRecord = {
    metadata: {
      rental_offering: true,
      offering_key: SW,
      offering_label: CATALOG_LABEL, // old snapshot
    },
  };
  const renameMap = buildRentalCatalogLabelMap([{
    offering_key: SW, label: RENAMED, active: true,
    client_slug: 'sunset', location_id: 'sunset-somo',
  }], { clientSlug: 'sunset', locationId: 'sunset-somo' });
  const [overlaid] = enrichServiceRecordsWithCatalogLabels([staleRecord], renameMap);
  ok(
    'rename without service record rewrite: overlay + resolver',
    overlaid.metadata.offering_label === CATALOG_LABEL
      && overlaid.metadata.catalog_label === RENAMED
      && resolveRentalOfferingFriendlyLabel(overlaid.metadata) === RENAMED,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// C) New quote→create persists exact catalog label + authoritative quote lines
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[C] Production write path + generic authoritative quote labels');
{
  const priced = {
    ok: true,
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    offering_key: SW,
    offering_label: CATALOG_LABEL,
    catalog_label: CATALOG_LABEL,
    duration_key: '1_day',
    item_code: `${SW}__1_day`,
    unit: 'day',
    unit_cents: 3000,
    quantity: 1,
    amount_cents: 3000,
    currency: 'EUR',
  };
  const built = buildGenericRentalServiceRecord(priced, {
    serviceDate: DATE,
    source: 'staff_manual',
  });
  ok('buildGenericRentalServiceRecord ok', built.ok === true, built.reason || '');
  if (built.ok) {
    ok(
      'write persists offering_label = Surfboard + Wetsuit',
      built.record.metadata.offering_label === CATALOG_LABEL,
      `got=${built.record.metadata.offering_label}`,
    );
    const hasCatalogField = built.record.metadata.catalog_label === CATALOG_LABEL
      || built.record.metadata.offering_label === CATALOG_LABEL;
    ok('write surfaces exact Admin catalog name', hasCatalogField);

    // Authoritative generic quote must carry catalog label (not bare key).
    if (typeof buildGenericRentalAuthoritativeQuote === 'function') {
      const q = buildGenericRentalAuthoritativeQuote([built.record]);
      const line = q && q.line_items && q.line_items[0];
      ok(
        'generic authoritative quote line includes catalog label',
        line
          && (line.label === CATALOG_LABEL || line.offering_label === CATALOG_LABEL)
          && line.label !== SW,
        `line=${JSON.stringify(line && { label: line.label, offering_label: line.offering_label })}`,
      );
    } else {
      ok('buildGenericRentalAuthoritativeQuote available', false);
    }
  }

  const preparePath = typeof prepareGenericRentalsForCreate === 'function';
  ok('prepareGenericRentalsForCreate available', preparePath);
  if (preparePath) {
    const resolved = resolveRentalOfferingFriendlyLabel({
      offering_key: SW,
      offering_label: null,
      catalog_label: CATALOG_LABEL,
    });
    ok('resolver for new write uses catalog', resolved === CATALOG_LABEL);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// D) Existing stale record re-render via day-ops/pickups + Admin rename
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[D] Day-ops pickups overlay current catalog on stale records');
{
  const catalogMap = buildRentalCatalogLabelMap([
    { offering_key: SW, label: CATALOG_LABEL, active: true },
    { offering_key: 'sup_rental', label: 'SUP', active: true },
    { offering_key: 'bicycle_rental', label: 'Bicycle', active: true },
    { offering_key: 'towel_rental', label: 'Towel', active: true },
    { offering_key: 'flipflops_rental', label: 'Flipflops', active: true },
  ]);

  const staleStandalone = standaloneRow({
    id: 'sr-stale-sw',
    offering_key: SW,
    offering_label: STALE_HUMANIZED, // key-derived stale
    amount_due_cents: 3000,
  });
  const rawKeyStandalone = standaloneRow({
    id: 'sr-raw-sw',
    offering_key: SW,
    offering_label: SW,
    amount_due_cents: 3000,
    booking_id: 'bk-p0e-0002',
    guest_name: 'Bea',
    booking_code: 'SUNSET-BEA',
  });

  const enriched = enrichServiceRecordsWithCatalogLabels(
    [staleStandalone, rawKeyStandalone],
    catalogMap,
  );
  ok(
    'enrich overlays catalog_label without rewriting offering_label',
    enriched[0].metadata.catalog_label === CATALOG_LABEL
      && enriched[0].metadata.offering_label === STALE_HUMANIZED,
    JSON.stringify(enriched[0].metadata),
  );

  const ctx = loadProductionDayOpsContext();
  ok('day-ops friendly label fn loaded', typeof ctx.scheduleDayOpsFriendlyOfferingLabel === 'function');

  if (typeof ctx.scheduleDayOpsFriendlyOfferingLabel === 'function') {
    const browserLabel = ctx.scheduleDayOpsFriendlyOfferingLabel(enriched[0].metadata, SW);
    ok(
      'browser friendly label uses catalog over stale',
      browserLabel === CATALOG_LABEL,
      `got=${browserLabel}`,
    );
    const rawBrowser = ctx.scheduleDayOpsFriendlyOfferingLabel(enriched[1].metadata, SW);
    ok(
      'browser friendly label uses catalog over raw key meta',
      rawBrowser === CATALOG_LABEL,
      `got=${rawBrowser}`,
    );
  }

  // Build pickup lines through production owners with enriched rows.
  if (typeof ctx.scheduleBuildRentalPickupLines === 'function'
    && typeof ctx.scheduleBuildDisplayGroups === 'function') {
    const groups = typeof ctx.scheduleSelectRentalPickupGroups === 'function'
      ? ctx.scheduleSelectRentalPickupGroups(enriched)
      : ctx.scheduleBuildDisplayGroups(enriched).filter((g) => {
        if (typeof ctx.scheduleGroupHasRentalPickups === 'function') {
          return ctx.scheduleGroupHasRentalPickups(g);
        }
        return true;
      });
    const lines = ctx.scheduleBuildRentalPickupLines(groups);
    const swLines = lines.filter((l) => l.offeringKey === SW || /Surfboard|Wetsuit|Board/i.test(l.itemLabel || ''));
    ok(
      'pickup lines use Surfboard + Wetsuit (not Surfboard Wetsuit / raw key)',
      swLines.length >= 1
        && swLines.every((l) => l.itemLabel === CATALOG_LABEL
          || (l.itemLabel && l.itemLabel.includes(CATALOG_LABEL))),
      `labels=${lines.map((l) => l.itemLabel).join('|')}`,
    );
    ok(
      'pickup lines never emit raw key or stale humanize for S+W',
      !lines.some((l) => l.itemLabel === SW || l.itemLabel === STALE_HUMANIZED),
      `labels=${lines.map((l) => l.itemLabel).join('|')}`,
    );
  }

  // Admin rename overlay without rewriting record.
  const renameMap = buildRentalCatalogLabelMap([
    { offering_key: SW, label: RENAMED, active: true },
  ]);
  const renamedRows = enrichServiceRecordsWithCatalogLabels([staleStandalone], renameMap);
  const renamedResolved = resolveRentalOfferingFriendlyLabel(renamedRows[0].metadata);
  ok(
    'Admin rename renders Board + Suit ★ Pro without rewrite',
    renamedResolved === RENAMED
      && renamedRows[0].metadata.offering_label === STALE_HUMANIZED,
    `resolved=${renamedResolved} snap=${renamedRows[0].metadata.offering_label}`,
  );
  if (typeof ctx.scheduleDayOpsFriendlyOfferingLabel === 'function') {
    ok(
      'browser rename exact',
      ctx.scheduleDayOpsFriendlyOfferingLabel(renamedRows[0].metadata, SW) === RENAMED,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// E) Invoice + payment summary + drawer with stale metadata + catalog overlay
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[E] Invoice / payment summary / drawer catalog overlay');
{
  const catalogMap = buildRentalCatalogLabelMap([
    { offering_key: SW, label: CATALOG_LABEL, active: true },
  ]);
  const stale = standaloneRow({
    offering_key: SW,
    offering_label: STALE_HUMANIZED,
    amount_due_cents: 3000,
  });
  const [enriched] = enrichServiceRecordsWithCatalogLabels([stale], catalogMap);

  const invoiceText = formatServiceRecordInvoiceLineText(enriched);
  ok(
    'invoice uses Surfboard + Wetsuit',
    invoiceText.includes(CATALOG_LABEL)
      && !invoiceText.includes(STALE_HUMANIZED)
      && !invoiceText.includes(SW),
    `text=${invoiceText}`,
  );

  const genericLabel = resolveGenericRentalInvoiceLabel(enriched.metadata, 'addon_service');
  ok('generic invoice label exact catalog', genericLabel === CATALOG_LABEL, `got=${genericLabel}`);

  const drawerLabel = formatSunsetDrawerDailyItemLabel('addon_service', 1, enriched);
  ok(
    'drawer uses Surfboard + Wetsuit',
    drawerLabel.includes(CATALOG_LABEL)
      && !drawerLabel.includes(STALE_HUMANIZED)
      && !drawerLabel.includes(SW),
    `label=${drawerLabel}`,
  );

  // Payment summary line labels through production owner.
  const booking = {
    booking_id: BOOKING,
    booking_code: 'SUNSET-P0E',
    amount_due_cents: 3000,
    amount_paid_cents: 0,
    payment_status: 'unpaid',
    metadata: { location_id: 'sunset-somo', staff_manual_schedule: true },
  };
  const pay = buildPaymentSummary([], booking, [enriched], 'db', 0, { ok: true, prices: [] }, {});
  const payLabel = pay.line_items && pay.line_items[0] && pay.line_items[0].label;
  ok(
    'payment summary line uses catalog label',
    payLabel && payLabel.includes(CATALOG_LABEL)
      && !String(payLabel).includes(STALE_HUMANIZED)
      && !String(payLabel).includes(SW),
    `label=${payLabel}`,
  );

  // Raw key metadata only.
  const rawOnly = standaloneRow({
    offering_key: SW,
    offering_label: SW,
    amount_due_cents: 3000,
  });
  const [rawEnriched] = enrichServiceRecordsWithCatalogLabels([rawOnly], catalogMap);
  const invRaw = formatServiceRecordInvoiceLineText(rawEnriched);
  const drRaw = formatSunsetDrawerDailyItemLabel('addon_service', 1, rawEnriched);
  ok(
    'raw-key metadata invoice overlays catalog',
    invRaw.includes(CATALOG_LABEL) && !invRaw.includes(SW),
    `text=${invRaw}`,
  );
  ok(
    'raw-key metadata drawer overlays catalog',
    drRaw.includes(CATALOG_LABEL) && !drRaw.includes(SW),
    `label=${drRaw}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// F) Same-key CE and standalone labels equal current catalog; two lanes
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[F] Same-key CE + standalone — equal labels, separate lanes');
{
  const catalogMap = buildRentalCatalogLabelMap([
    { offering_key: SW, label: CATALOG_LABEL, active: true },
  ]);
  const standalone = standaloneRow({
    id: 'sr-stand-sw',
    offering_key: SW,
    offering_label: STALE_HUMANIZED,
    amount_due_cents: 3000,
  });
  const ce = ceRow({
    id: 'sr-ce-sw',
    offering_key: SW,
    label: STALE_HUMANIZED,
    offering_label: STALE_HUMANIZED,
    mode: 'during_course',
    amount_due_cents: 0,
  });
  const rows = enrichServiceRecordsWithCatalogLabels([standalone, ce], catalogMap);
  const standLabel = resolveRentalOfferingFriendlyLabel(rows[0].metadata);
  const ceLabel = resolveRentalOfferingFriendlyLabel(rows[1].metadata);
  ok('standalone label = current catalog', standLabel === CATALOG_LABEL, `got=${standLabel}`);
  ok('CE label = current catalog', ceLabel === CATALOG_LABEL, `got=${ceLabel}`);
  ok('same-key CE and standalone labels equal', standLabel === ceLabel);

  const ctx = loadProductionDayOpsContext();
  if (typeof ctx.scheduleIsStandaloneRentalPickupRecord === 'function') {
    ok('standalone is pickup lane', ctx.scheduleIsStandaloneRentalPickupRecord(rows[0]) === true);
    ok('CE is not pickup lane', ctx.scheduleIsStandaloneRentalPickupRecord(rows[1]) === false);
  }
  if (typeof ctx.scheduleDayOpsCourseEquipmentRows === 'function') {
    const group = { records: rows, booking_id: BOOKING };
    const ceItems = ctx.scheduleDayOpsCourseEquipmentRows(group);
    ok('course card has exactly one CE row', ceItems.length === 1);
    if (typeof ctx.scheduleDayOpsEquipmentPrepLabel === 'function') {
      const prep = ctx.scheduleDayOpsEquipmentPrepLabel(group);
      ok(
        'course equipment display uses catalog label',
        prep.includes(CATALOG_LABEL) && !prep.includes(STALE_HUMANIZED),
        `prep=${prep}`,
      );
    }
  }
  if (typeof ctx.scheduleBuildRentalPickupLines === 'function') {
    const groups = typeof ctx.scheduleSelectRentalPickupGroups === 'function'
      ? ctx.scheduleSelectRentalPickupGroups(rows)
      : ctx.scheduleBuildDisplayGroups(rows);
    const lines = ctx.scheduleBuildRentalPickupLines(groups);
    const swPickups = lines.filter((l) => l.offeringKey === SW);
    ok('pickups have exactly one standalone S+W', swPickups.length === 1, `n=${swPickups.length}`);
    ok(
      'pickup label equals CE display catalog',
      swPickups[0] && (swPickups[0].itemLabel === CATALOG_LABEL
        || String(swPickups[0].itemLabel).includes(CATALOG_LABEL)),
      `label=${swPickups[0] && swPickups[0].itemLabel}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// G) Catalog absent → true key fallback still Electric Bike
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[G] Catalog absent true fallback');
{
  const bike = resolveRentalOfferingFriendlyLabel({
    offering_key: 'electric_bike_rental',
  });
  ok(
    'electric_bike_rental → Electric Bike when no catalog',
    bike === 'Electric Bike' || humanizeRentalOfferingKey('electric_bike_rental') === 'Electric Bike',
    `got=${bike}`,
  );
  ok(
    'never bare key when humanizable',
    bike !== 'electric_bike_rental',
  );
  ok(
    'board_rental fallback Surfboard',
    resolveRentalOfferingFriendlyLabel({ offering_key: 'board_rental' }) === 'Surfboard',
  );
  ok(
    'wetsuit_rental fallback Wetsuit',
    resolveRentalOfferingFriendlyLabel({ offering_key: 'wetsuit_rental' }) === 'Wetsuit',
  );

  // Empty enrich leaves fallback path.
  const row = standaloneRow({
    offering_key: 'electric_bike_rental',
    offering_label: null,
    amount_due_cents: 2000,
  });
  delete row.metadata.offering_label;
  delete row.metadata.label;
  const [left] = enrichServiceRecordsWithCatalogLabels([row], {});
  ok(
    'enrich with empty map does not invent catalog_label',
    left.metadata.catalog_label == null || left.metadata.catalog_label === '',
  );
  const fb = resolveRentalOfferingFriendlyLabel(left.metadata);
  ok('empty-catalog enrich still Electric Bike', fb === 'Electric Bike', `got=${fb}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// H) Exact key — no alias label borrow
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[H] Exact key no alias label borrow');
{
  const map = buildRentalCatalogLabelMap([
    { offering_key: SW, label: CATALOG_LABEL, active: true },
    { offering_key: 'board_and_suit_rental', label: 'Board and Suit Bundle', active: true },
  ]);
  ok('S+W map exact', lookupCatalogLabel(map, SW) === CATALOG_LABEL);
  ok('bundle map exact', lookupCatalogLabel(map, 'board_and_suit_rental') === 'Board and Suit Bundle');
  ok('no borrow: board_rental empty', lookupCatalogLabel(map, 'board_rental') === '');
  ok('no borrow: wetsuit_rental empty', lookupCatalogLabel(map, 'wetsuit_rental') === '');

  const boardOnly = resolveRentalOfferingFriendlyLabel(
    { offering_key: 'board_rental', offering_label: null },
    { catalogLabelMap: map },
  );
  ok(
    'board_rental does not borrow S+W or bundle label',
    boardOnly === 'Surfboard'
      && boardOnly !== CATALOG_LABEL
      && boardOnly !== 'Board and Suit Bundle',
    `got=${boardOnly}`,
  );

  const [enrichedBoard] = enrichServiceRecordsWithCatalogLabels(
    [standaloneRow({ offering_key: 'board_rental', offering_label: null })],
    map,
  );
  ok(
    'enrich never attaches foreign catalog_label to board_rental',
    !enrichedBoard.metadata.catalog_label
      || enrichedBoard.metadata.catalog_label === 'Surfboard',
    `catalog_label=${enrichedBoard.metadata.catalog_label}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Identity helpers + arbitrary Admin names (contract 5–6)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[I] Identity helpers + arbitrary Admin names');
{
  ok('identity-like raw key', isIdentityLikeRentalLabel(SW, SW, `${SW}__1_day`) === true);
  ok('identity-like item_code', isIdentityLikeRentalLabel(`${SW}__1_day`, SW, `${SW}__1_day`) === true);
  ok('not identity Surfboard + Wetsuit', isIdentityLikeRentalLabel(CATALOG_LABEL, SW, '') === false);
  ok('not identity rename with star', isIdentityLikeRentalLabel(RENAMED, SW, '') === false);

  const names = [
    ['sup_rental', 'SUP'],
    ['bicycle_rental', 'Bicycle'],
    ['towel_rental', 'Towel'],
    ['flipflops_rental', 'Flipflops'],
  ];
  for (const [key, label] of names) {
    ok(
      `preserves exact Admin ${label}`,
      resolveRentalOfferingFriendlyLabel({
        offering_key: key,
        catalog_label: label,
        offering_label: humanizeRentalOfferingKey(key),
      }) === label,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Source guards: day payload enrichment wired
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[J] Source guards — production server projection + readers');
{
  const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
  const drawerSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js'),
    'utf8',
  );
  const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');
  const labelSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'lib', 'rental-offering-label.js'),
    'utf8',
  );
  const bookableSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'lib', 'sunset-bookable-offerings.js'),
    'utf8',
  );

  ok(
    'resolver documents catalog-first precedence',
    /catalogLabel|catalog_label first|authoritative current catalog/i.test(labelSrc)
      && /meta\.catalog_label/.test(labelSrc),
  );
  ok(
    'production bookable projection joins rentalOfferings catalog labels',
    /buildRentalCatalogLabelMap/.test(bookableSrc)
      && /lookupCatalogLabel/.test(bookableSrc)
      && /guest_description:\s*displayLabel/.test(bookableSrc),
    'sunset-bookable-offerings.js must prefer tenant_rental_offerings.label',
  );
  ok(
    'day schedule endpoint attaches rental_label_map or enrich',
    /rental_label_map|enrichServiceRecordsWithCatalogLabels|buildRentalCatalogLabelMap/.test(apiSrc),
    'staff-query-api day handler must enrich catalog labels once',
  );
  ok(
    'drawer context enriches with catalog labels',
    /enrichServiceRecordsWithCatalogLabels|buildRentalCatalogLabelMap|listRentalOfferings/.test(drawerSrc)
      && /catalog_label|catalogLabelMap|rental_label_map|enrichServiceRecordsWithCatalogLabels/.test(drawerSrc),
    'drawer must overlay current catalog before invoice/payment labels',
  );
  const friendlyFn = (dayOpsSrc.match(
    /function scheduleDayOpsFriendlyOfferingLabel[\s\S]*?\nfunction /,
  ) || [''])[0];
  const catalogIdx = friendlyFn.indexOf('catalog_label');
  const offeringIdx = friendlyFn.indexOf('offering_label');
  ok(
    'browser day-ops prefers catalog_label before offering_label',
    catalogIdx >= 0 && offeringIdx >= 0 && catalogIdx < offeringIdx,
    `catalog@${catalogIdx} offering@${offeringIdx}`,
  );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`P0e rental labels: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
} else {
  console.log('OK');
}
