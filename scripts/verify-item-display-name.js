'use strict';

/**
 * Shared item-display-name resolver gates.
 * Proves Surfboard + Wetsuit comes from fixture catalog label, not a constant.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  resolveItemDisplayName,
  resolveAccommodationDisplayName,
  buildRentalCatalogLabelMap,
} = require(path.join(ROOT, 'scripts', 'lib', 'item-display-name.js'));
const {
  resolveRentalOfferingFriendlyLabel,
} = require(path.join(ROOT, 'scripts', 'lib', 'rental-offering-label.js'));
const DOMAIN = require(path.join(ROOT, 'scripts', 'lib', 'sunset-bookings-admin.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}

// Fixture catalog — authoritative Admin labels (not product constants).
const FIXTURE_CATALOG = [
  {
    offering_key: 'board_and_suit_rental',
    label: 'Surfboard + Wetsuit',
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
    offering_key: 'board_rental',
    label: 'Surfboard',
    active: true,
    client_slug: 'sunset',
    location_id: 'sunset-somo',
  },
];
const catalogMap = buildRentalCatalogLabelMap(FIXTURE_CATALOG, {
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
});

ok('catalog map has board_and_suit from fixture', catalogMap.board_and_suit_rental === 'Surfboard + Wetsuit');

// Rental: catalog label wins; prove not a hardcoded constant in item-display-name source.
const itemSrc = require('fs').readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'item-display-name.js'),
  'utf8',
);
ok('item-display-name has no hardcoded Surfboard + Wetsuit constant',
  !/Surfboard \+ Wetsuit/.test(itemSrc));

const bundleName = resolveItemDisplayName(
  {
    service_type: 'addon_service',
    metadata: {
      offering_key: 'board_and_suit_rental',
      duration_key: '1_day',
      rental_offering: true,
      // Stale snapshot — catalog must win
      label: 'Old Bundle Name',
      offering_label: 'board_and_suit_rental',
    },
  },
  { catalogLabelMap: catalogMap },
);
ok('Surfboard + Wetsuit comes from fixture catalog', bundleName === 'Surfboard + Wetsuit', bundleName);

const historicalOnly = resolveItemDisplayName({
  service_type: 'addon_service',
  metadata: {
    offering_key: 'retired_offering_xyz',
    rental_offering: true,
    offering_label: 'Legacy Towel Set',
  },
}, { catalogLabelMap: catalogMap });
ok('historical snapshot when catalog key absent', historicalOnly === 'Legacy Towel Set', historicalOnly);

const accomPkg = resolveItemDisplayName({
  service_type: 'addon_service',
  metadata: {
    staff_accommodation: true,
    source: 'staff_accommodation',
    component: 'staff_accommodation',
    package_name: 'Ocean View Suite',
    room_code: 'R2',
    bed_code: 'B1',
  },
});
ok('accommodation package name wins', accomPkg === 'Ocean View Suite', accomPkg);

const accomRoomBed = resolveAccommodationDisplayName({
  staff_accommodation: true,
  room_code: 'Room 3',
  bed_code: 'Bed A',
});
ok('accommodation room·bed fallback', accomRoomBed === 'Room 3 · Bed A', accomRoomBed);

const accomPlain = resolveItemDisplayName({
  service_type: 'accommodation',
  metadata: { staff_accommodation: true },
});
ok('accommodation bare fallback', accomPlain === 'Accommodation', accomPlain);

// Bookings list row uses resolver for items.
const listRow = DOMAIN.buildBookingListRow({
  booking: {
    booking_id: 'bk1',
    booking_code: 'SUN-LABEL',
    status: 'confirmed',
    total_amount_cents: 5000,
  },
  services: [{
    service_type: 'addon_service',
    status: 'active',
    service_date: '2026-07-15',
    amount_due_cents: 5000,
    metadata: {
      offering_key: 'board_and_suit_rental',
      duration_key: '1_day',
      rental_offering: true,
      label: 'stale',
    },
  }],
  collected_cents: 0,
  refunded_cents: 0,
  catalog_label_map: catalogMap,
});
ok('bookings list item label from catalog',
  listRow.items && listRow.items[0] && listRow.items[0].label === 'Surfboard + Wetsuit',
  listRow.items && listRow.items[0] && listRow.items[0].label);

// Same key via rental-offering-label shared path
ok('shared rental helper agrees',
  resolveRentalOfferingFriendlyLabel(
    { offering_key: 'board_and_suit_rental', label: 'stale' },
    { catalogLabelMap: catalogMap },
  ) === 'Surfboard + Wetsuit');

// ── Luna guest-copy path: current Admin catalog rename must win over stale history ──
const {
  serviceTypeStaffLabel,
  formatServiceChargeDueLine,
  buildServiceChargesDueFromContext,
  formatAddonServicePaymentLedgerLabel,
} = require(path.join(ROOT, 'scripts', 'lib', 'luna-guest-addon-service-payment-ledger.js'));

const ADMIN_RENAME = 'Ocean Bundle Pro Renamed';
const renameMap = buildRentalCatalogLabelMap(
  [{
    offering_key: 'board_and_suit_rental',
    label: ADMIN_RENAME,
    active: true,
    client_slug: 'sunset',
    location_id: 'sunset-somo',
  }],
  { clientSlug: 'sunset', locationId: 'sunset-somo' },
);
ok('rename map holds Admin label (not a product constant)', renameMap.board_and_suit_rental === ADMIN_RENAME);

const staleRentalMeta = {
  offering_key: 'board_and_suit_rental',
  duration_key: '1_day',
  rental_offering: true,
  label: 'Stale Historical Bundle',
  offering_label: 'Stale Historical Bundle',
  display_name: 'Stale Historical Bundle',
};
const lunaLabel = serviceTypeStaffLabel('addon_service', staleRentalMeta, { catalogLabelMap: renameMap });
ok('Luna guest-copy emits current Admin rename (not stale history)',
  lunaLabel === ADMIN_RENAME, lunaLabel);
const lunaLine = formatServiceChargeDueLine('addon_service', 2500, staleRentalMeta, { catalogLabelMap: renameMap });
ok('Luna due-line uses current renamed catalog label',
  lunaLine.startsWith(`${ADMIN_RENAME} —`) && lunaLine.includes('due at checkout'),
  lunaLine);
const lunaCtx = buildServiceChargesDueFromContext({
  booking: { balance_due_cents: null },
  serviceRecords: [{
    service_type: 'addon_service',
    amount_due_cents: 2500,
    payment_status: 'pending',
    metadata: staleRentalMeta,
  }],
  paymentRows: [],
  catalogLabelMap: renameMap,
});
ok('buildServiceChargesDueFromContext guest lines use Admin rename',
  Array.isArray(lunaCtx.service_charges_due_lines)
  && lunaCtx.service_charges_due_lines.some((l) => String(l).startsWith(ADMIN_RENAME)),
  JSON.stringify(lunaCtx.service_charges_due_lines));
const historicalOnlyLuna = serviceTypeStaffLabel('addon_service', {
  offering_key: 'retired_offering_xyz',
  rental_offering: true,
  offering_label: 'Legacy Towel Set',
}, { catalogLabelMap: renameMap });
ok('Luna preserves historical fallback when current catalog identity absent',
  historicalOnlyLuna === 'Legacy Towel Set', historicalOnlyLuna);

const ledgerSrc = require('fs').readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'luna-guest-addon-service-payment-ledger.js'),
  'utf8',
);
ok('Luna ledger has no hardcoded Admin rename string', !ledgerSrc.includes(ADMIN_RENAME));
ok('Luna ledger has no hardcoded Surfboard + Wetsuit constant', !/Surfboard \+ Wetsuit/.test(ledgerSrc));
// API still accepts call without catalog map (backward compatible).
ok('serviceTypeStaffLabel backward-compatible without catalog opts',
  typeof serviceTypeStaffLabel('wetsuit', {}) === 'string'
  && typeof formatAddonServicePaymentLedgerLabel({
    payment_status: 'draft',
    amount_due_cents: 100,
    metadata: { service_type: 'wetsuit' },
  }) === 'string');

// Real caller (booking context) wires catalog map into buildServiceChargesDueFromContext.
const apiSrc = require('fs').readFileSync(
  path.join(ROOT, 'scripts', 'staff-query-api.js'),
  'utf8',
);
ok('handleBookingContext loads listRentalOfferings for guest-copy catalog authority',
  /listRentalOfferings/.test(apiSrc)
  && /buildServiceChargesDueFromContext\s*\(\s*\{[\s\S]*?catalogLabelMap/.test(apiSrc));

// ── Production hold/add-on draft-write path ──
// Primary proof: execute public entry runGuestHoldPaymentDraftWriteDryRunApproved through
// BOTH real branches (existing-hold reuse + newly-created hold) into real attach→ledger.
// Regex / helper-only checks are secondary; they must not be the only proof.
const holdWriteSrc = require('fs').readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'luna-guest-hold-payment-draft-write.js'),
  'utf8',
);
// Secondary (source shape): two attach branches pass through buildHoldWriteAddonAttachOpts.
// Call sites use local `attachAll` (DI seam) → still must invoke builder with location authority.
const attachViaBuilder = (holdWriteSrc.match(
  /attachAll\s*\(\s*pg\s*,\s*buildHoldWriteAddonAttachOpts\s*\(/g,
) || []).length;
ok('[secondary/source] both hold-write attach branches use buildHoldWriteAddonAttachOpts',
  attachViaBuilder === 2, `builder_calls=${attachViaBuilder}`);
ok('[secondary/source] hold-write shared attach opts builder owns locationId/catalogLabelMap',
  /function buildHoldWriteAddonAttachOpts/.test(holdWriteSrc)
  && /locationId:\s*o\.locationId/.test(holdWriteSrc)
  && /catalogLabelMap:\s*o\.catalogLabelMap/.test(holdWriteSrc));
ok('[secondary/source] hold-write does not hardcode Admin rename string',
  !holdWriteSrc.includes(ADMIN_RENAME));

const {
  runGuestHoldPaymentDraftWriteDryRunApproved,
  buildHoldWriteAddonAttachOpts,
  resolveHoldWriteLocationId,
  WRITE_SOURCE,
} = require(path.join(ROOT, 'scripts', 'lib', 'luna-guest-hold-payment-draft-write.js'));
const {
  attachAllGuestAddonServices,
} = require(path.join(ROOT, 'scripts', 'lib', 'luna-guest-addon-service-attach.js'));
const {
  syncGuestAddonServicePaymentLedger,
} = require(path.join(ROOT, 'scripts', 'lib', 'luna-guest-addon-service-payment-ledger.js'));
const tenantRentalOfferings = require(path.join(ROOT, 'scripts', 'lib', 'tenant-rental-offerings.js'));

const LOCATION_ID = 'sunset-somo';
const CLIENT_SLUG = 'sunset';
const CLIENT_ID = 'client-sunset-1';
const STALE_HISTORICAL = 'Stale Historical Bundle';
const OFFERING_KEY = 'board_and_suit_rental';
const BOOKING_ID = '00000000-0000-4000-8000-0000000000ab';
const BOOKING_CODE = 'SUN-LABEL-HOLD';
const GUEST_PHONE = '+34600111222';
const GUEST_EMAIL = 'label-guest@example.test';
const IDEMPOTENCY_KEY = 'item-display-hold-label-proof-001';

// ── Narrower helper tests (not sole proof of production branches) ──
const resolvedLoc = resolveHoldWriteLocationId(
  { location_id: LOCATION_ID, client_slug: CLIENT_SLUG },
  {},
  null,
  {},
);
ok('[helper] resolveHoldWriteLocationId reads context.location_id',
  resolvedLoc === LOCATION_ID, resolvedLoc);

const helperAttachOpts = buildHoldWriteAddonAttachOpts({
  clientSlug: CLIENT_SLUG,
  bookingId: BOOKING_ID,
  bookingCode: BOOKING_CODE,
  guestName: 'Label Guest',
  extractedFields: {},
  resultContext: {},
  quote: {},
  clientId: CLIENT_ID,
  writeSource: WRITE_SOURCE,
  locationId: resolvedLoc,
  // catalogLabelMap omitted — production path loads via locationId
});
ok('[helper] buildHoldWriteAddonAttachOpts carries locationId without injected catalogLabelMap',
  helperAttachOpts.locationId === LOCATION_ID
  && helperAttachOpts.catalogLabelMap == null,
  JSON.stringify({
    locationId: helperAttachOpts.locationId,
    catalogLabelMap: helperAttachOpts.catalogLabelMap,
  }));

const staleServiceRecord = {
  service_record_id: 'sr-rental-1',
  id: 'sr-rental-1',
  service_type: 'addon_service',
  amount_due_cents: 2500,
  payment_status: 'pending',
  metadata: {
    offering_key: OFFERING_KEY,
    duration_key: '1_day',
    rental_offering: true,
    label: STALE_HISTORICAL,
    offering_label: STALE_HISTORICAL,
    display_name: STALE_HISTORICAL,
  },
};

const retiredServiceRecord = {
  service_record_id: 'sr-retired',
  id: 'sr-retired',
  service_type: 'addon_service',
  amount_due_cents: 1500,
  payment_status: 'pending',
  metadata: {
    offering_key: 'retired_offering_xyz',
    rental_offering: true,
    offering_label: 'Legacy Towel Set',
    label: 'Legacy Towel Set',
  },
};

/** Ledger-only fake (helper path). Distinct from full hold-write entry-point fake. */
function makeLedgerOnlyPg(serviceRecords) {
  return {
    async query(sql, params) {
      const s = String(sql || '').replace(/\s+/g, ' ');
      if (/FROM booking_service_records/i.test(s)
        && /source = 'luna_guest'/i.test(s)
        && /amount_due_cents/i.test(s)) {
        return { rows: serviceRecords };
      }
      if (/FROM payments/i.test(s) && /idempotency_key/i.test(s)) {
        return { rows: [] };
      }
      if (/INSERT INTO payments/i.test(s)) {
        return {
          rows: [{
            payment_id: 'pay-ledger-1',
            amount_due_cents: params && params[2] != null ? params[2] : 2500,
          }],
        };
      }
      if (/UPDATE booking_service_records/i.test(s) && /payment_id/i.test(s)) {
        return { rows: [] };
      }
      if (/FROM clients WHERE slug/i.test(s) || /SELECT id, slug FROM clients WHERE slug/i.test(s)) {
        return { rows: [{ id: CLIENT_ID, slug: CLIENT_SLUG }] };
      }
      return { rows: [] };
    },
  };
}

/**
 * Full fake pg for public hold-write entry (no real DB/network).
 * mode: 'reuse' → existing-hold branch; 'create' → newly-created hold branch.
 */
function makeHoldWriteEntryPg(mode, serviceRecords) {
  const records = serviceRecords || [staleServiceRecord];
  return {
    async query(sql, params) {
      const s = String(sql || '').replace(/\s+/g, ' ').trim();
      if (/^BEGIN$/i.test(s) || /^COMMIT$/i.test(s) || /^ROLLBACK$/i.test(s)) {
        return { rows: [] };
      }
      // resolveClientId
      if (/SELECT id,\s*slug FROM clients WHERE slug/i.test(s)
        || (/FROM clients WHERE slug/i.test(s) && /SELECT/i.test(s))) {
        return { rows: [{ id: CLIENT_ID, slug: params && params[0] ? params[0] : CLIENT_SLUG }] };
      }
      // lookupExistingHoldPaymentDraft — bookings by idempotency_key
      if (/FROM bookings b/i.test(s)
        && /metadata->>'idempotency_key'/i.test(s)
        && /INNER JOIN clients/i.test(s)) {
        if (mode === 'reuse') {
          return {
            rows: [{
              booking_id: BOOKING_ID,
              booking_code: BOOKING_CODE,
              status: 'hold',
              payment_status: 'waiting_payment',
              hold_expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
              phone: GUEST_PHONE,
              check_in: '2026-08-10',
              check_out: '2026-08-15',
            }],
          };
        }
        return { rows: [] };
      }
      // lookupExistingHoldPaymentDraft — payment by ghpd-pay idempotency
      if (/FROM payments/i.test(s)
        && /metadata->>'idempotency_key'/i.test(s)
        && /booking_id = \$1/i.test(s)
        && !/addon_service/i.test(s)
        && !/payment_kind = 'addon_service'/i.test(s)
        && !/status IN/i.test(s)) {
        if (mode === 'reuse') {
          return {
            rows: [{
              payment_draft_id: 'pay-draft-existing',
              status: 'draft',
              payment_kind: 'deposit_only',
              amount_due_cents: 5000,
              checkout_url: null,
              stripe_checkout_session_id: null,
            }],
          };
        }
        return { rows: [] };
      }
      // loadPaymentDraftForBooking
      if (/FROM payments/i.test(s) && /status IN \('draft'/i.test(s)) {
        return { rows: [] };
      }
      // selectActiveHoldGuard (create path)
      if (/FROM bookings/i.test(s)
        && /status::text = ANY/i.test(s)
        && /check_in </i.test(s)) {
        return { rows: [] };
      }
      // upsertBookingHold — pre-check by booking_code
      if (/SELECT id::text AS booking_id FROM bookings WHERE client_id/i.test(s)
        && /booking_code/i.test(s)) {
        return { rows: [] };
      }
      // upsertBookingHold — INSERT ... RETURNING
      if (/INSERT INTO bookings/i.test(s)) {
        return {
          rows: [{
            booking_id: BOOKING_ID,
            booking_code: (params && params[1]) || BOOKING_CODE,
            status: 'hold',
            payment_status: 'not_requested',
            assignment_status: 'unassigned',
            availability_check_status: 'available',
            airtable_record_id: null,
            primary_room_code: null,
          }],
        };
      }
      // hold money / metadata update
      if (/UPDATE bookings/i.test(s) && /total_amount_cents/i.test(s)) {
        return { rows: [] };
      }
      // loadPricedGuestServiceRecords (ledger)
      if (/FROM booking_service_records/i.test(s)
        && /source = 'luna_guest'/i.test(s)
        && /amount_due_cents/i.test(s)
        && /payment_status/i.test(s)) {
        return { rows: records };
      }
      // attach priced / pending existing checks
      if (/FROM booking_service_records/i.test(s)) {
        return { rows: [] };
      }
      // findExistingServicePayment (addon ledger)
      if (/FROM payments/i.test(s)
        && (/addon_service/i.test(s) || /payment_kind = 'addon_service'/i.test(s))) {
        return { rows: [] };
      }
      // generic payments idempotency lookup
      if (/FROM payments/i.test(s) && /idempotency_key/i.test(s)) {
        return { rows: [] };
      }
      // INSERT payments (hold draft or addon ledger)
      if (/INSERT INTO payments/i.test(s)) {
        const amount = params && (params[3] != null ? params[3] : params[2]);
        return {
          rows: [{
            payment_draft_id: 'pay-draft-new',
            payment_id: 'pay-ledger-1',
            amount_due_cents: amount != null ? amount : 2500,
          }],
        };
      }
      // linkServiceRecordPaymentId
      if (/UPDATE booking_service_records/i.test(s) && /payment_id/i.test(s)) {
        return { rows: [] };
      }
      // INSERT service records (priced attach — should not run without service_interest)
      if (/INSERT INTO booking_service_records/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function makeReadyPlanner(idempKey) {
  return {
    plan_status: 'ready',
    would_create_hold: true,
    would_create_payment_draft: true,
    would_create_stripe_link: false,
    plan_handoff_required: false,
    payment_kind: 'deposit',
    payment_amount_cents: 5000,
    balance_due_after_payment_cents: 15000,
    idempotency_key_preview: idempKey,
    planned_records: {
      booking_hold: { package_code: 'surf_pack' },
      quote_snapshot: { quote_total_cents: 20000 },
    },
  };
}

function makeReadyChain() {
  return {
    result: {
      success: true,
      message_lane: 'new_booking_inquiry',
      booking_intake_ready: true,
      readiness_state: 'ready_for_availability_check',
      detected_language: 'en',
      extracted_fields: {
        guest_name: 'Label Guest',
        guest_phone: GUEST_PHONE,
        guest_email: GUEST_EMAIL,
        check_in: '2026-08-10',
        check_out: '2026-08-15',
        guest_count: 1,
        package_interest: 'surf_pack',
        // no service_interest / transfers — ledger uses pre-seeded BSR rows
      },
    },
    availability: { availability_status: 'available' },
    quote: {
      quote_status: 'ready',
      quote_total_cents: 20000,
      deposit_options: { deposit_required_cents: 5000 },
    },
    payment_choice: {
      payment_choice_ready: true,
      next_safe_step: 'ready_for_hold_payment_draft',
      payment_choice: 'deposit',
    },
  };
}

function linesFromAttachCapture(capture) {
  const ledger = capture && capture.result && capture.result.service_payment_ledger;
  return (ledger && ledger.service_charges_due_lines) || [];
}

async function runHoldWriteAttachLedgerGate() {
  const origList = tenantRentalOfferings.listRentalOfferings;
  let listCalls = [];
  tenantRentalOfferings.listRentalOfferings = async (pg, q) => {
    listCalls.push({
      clientSlug: q && q.clientSlug,
      locationId: q && q.locationId,
      includeInactive: q && q.includeInactive,
    });
    // Admin rename for this concrete location only — not a product constant in resolvers.
    if (q && q.clientSlug === CLIENT_SLUG && q.locationId === LOCATION_ID) {
      return [{
        offering_key: OFFERING_KEY,
        label: ADMIN_RENAME,
        active: true,
        client_slug: CLIENT_SLUG,
        location_id: LOCATION_ID,
      }];
    }
    return [];
  };

  /** Wrap production attach so we observe opts + ledger from the real call sites. */
  function makeCapturingAttach(bucket) {
    return async (pg, opts) => {
      const result = await attachAllGuestAddonServices(pg, opts);
      bucket.push({
        opts: {
          clientSlug: opts && opts.clientSlug,
          bookingId: opts && opts.bookingId,
          locationId: opts && opts.locationId,
          catalogLabelMap: opts && opts.catalogLabelMap,
          writeSource: opts && opts.writeSource,
        },
        result,
      });
      return result;
    };
  }

  try {
    // ── [helper] narrower RED/GREEN (manual helper construction — not sole proof) ──
    const redLedger = await syncGuestAddonServicePaymentLedger(makeLedgerOnlyPg([staleServiceRecord]), {
      clientSlug: CLIENT_SLUG,
      clientId: CLIENT_ID,
      bookingId: BOOKING_ID,
      bookingCode: BOOKING_CODE,
      writeSource: WRITE_SOURCE,
      // intentionally omit locationId + catalogLabelMap
    });
    const redHelperLines = redLedger.service_charges_due_lines || [];
    ok('[helper] RED: ledger without locationId falls back to historical snapshot label',
      redHelperLines.some((l) => String(l).startsWith(STALE_HISTORICAL))
      && !redHelperLines.some((l) => String(l).startsWith(ADMIN_RENAME)),
      JSON.stringify(redHelperLines));

    listCalls = [];
    const greenHelperAttach = await attachAllGuestAddonServices(
      makeLedgerOnlyPg([staleServiceRecord]),
      helperAttachOpts,
    );
    const greenHelperLines = (greenHelperAttach.service_payment_ledger
      && greenHelperAttach.service_payment_ledger.service_charges_due_lines) || [];
    ok('[helper] GREEN: attach→ledger with locationId emits Admin rename',
      greenHelperLines.some((l) => String(l).startsWith(ADMIN_RENAME))
      && !greenHelperLines.some((l) => String(l).startsWith(STALE_HISTORICAL)),
      JSON.stringify(greenHelperLines));
    ok('[helper] listRentalOfferings tenant+location when map omitted',
      listCalls.some((c) => c.clientSlug === CLIENT_SLUG && c.locationId === LOCATION_ID),
      JSON.stringify(listCalls));

    // ══════════════════════════════════════════════════════════════════
    // PRIMARY: public entry point — existing-hold reuse branch
    // Entry: runGuestHoldPaymentDraftWriteDryRunApproved → executeHoldPaymentDraftWrite
    // Branch: lookupExistingHoldPaymentDraft hit → attach at reuse call site
    // ══════════════════════════════════════════════════════════════════
    listCalls = [];
    const reuseCaptures = [];
    const reuseOut = await runGuestHoldPaymentDraftWriteDryRunApproved(
      makeReadyChain(),
      {
        confirm_write: true,
        client_slug: CLIENT_SLUG,
        guest_name: 'Label Guest',
        guest_phone: GUEST_PHONE,
        guest_email: GUEST_EMAIL,
        location_id: LOCATION_ID,
        // catalogLabelMap intentionally omitted — production must load via locationId
        env: { NODE_ENV: 'test' },
        pg: makeHoldWriteEntryPg('reuse', [staleServiceRecord]),
        planner: makeReadyPlanner(`${IDEMPOTENCY_KEY}-reuse`),
        attachAllGuestAddonServices: makeCapturingAttach(reuseCaptures),
      },
    );
    ok('[entry/reuse] public write succeeds (reused_existing)',
      reuseOut && reuseOut.success === true && reuseOut.write_status === 'reused_existing',
      JSON.stringify({
        success: reuseOut && reuseOut.success,
        write_status: reuseOut && reuseOut.write_status,
        reasons: reuseOut && reuseOut.write_block_reasons,
      }));
    ok('[entry/reuse] real attach call site invoked exactly once',
      reuseCaptures.length === 1, `captures=${reuseCaptures.length}`);
    ok('[entry/reuse] attach opts carry locationId without injected catalogLabelMap',
      reuseCaptures[0]
      && reuseCaptures[0].opts.locationId === LOCATION_ID
      && reuseCaptures[0].opts.catalogLabelMap == null
      && reuseCaptures[0].opts.clientSlug === CLIENT_SLUG
      && reuseCaptures[0].opts.bookingId === BOOKING_ID,
      JSON.stringify(reuseCaptures[0] && reuseCaptures[0].opts));
    const reuseLines = linesFromAttachCapture(reuseCaptures[0]);
    ok('[entry/reuse] GREEN: service_charges_due_lines use current Admin rename (not stale)',
      reuseLines.some((l) => String(l).startsWith(ADMIN_RENAME))
      && !reuseLines.some((l) => String(l).startsWith(STALE_HISTORICAL)),
      JSON.stringify(reuseLines));
    ok('[entry/reuse] GREEN: listRentalOfferings tenant+location scoped',
      listCalls.some((c) => c.clientSlug === CLIENT_SLUG && c.locationId === LOCATION_ID),
      JSON.stringify(listCalls));

    // RED via same public entry without location authority → historical wins.
    listCalls = [];
    const reuseRedCaptures = [];
    const reuseRedOut = await runGuestHoldPaymentDraftWriteDryRunApproved(
      makeReadyChain(),
      {
        confirm_write: true,
        client_slug: CLIENT_SLUG,
        guest_name: 'Label Guest',
        guest_phone: GUEST_PHONE,
        guest_email: GUEST_EMAIL,
        // no location_id / catalogLabelMap
        env: { NODE_ENV: 'test' },
        pg: makeHoldWriteEntryPg('reuse', [staleServiceRecord]),
        planner: makeReadyPlanner(`${IDEMPOTENCY_KEY}-reuse-red`),
        attachAllGuestAddonServices: makeCapturingAttach(reuseRedCaptures),
      },
    );
    ok('[entry/reuse] RED write still succeeds (path independent of catalog)',
      reuseRedOut && reuseRedOut.success === true && reuseRedOut.write_status === 'reused_existing',
      JSON.stringify({
        success: reuseRedOut && reuseRedOut.success,
        write_status: reuseRedOut && reuseRedOut.write_status,
      }));
    const reuseRedLines = linesFromAttachCapture(reuseRedCaptures[0]);
    ok('[entry/reuse] RED: without locationId lines fall back to historical snapshot',
      reuseRedCaptures.length === 1
      && reuseRedCaptures[0].opts.locationId == null
      && reuseRedLines.some((l) => String(l).startsWith(STALE_HISTORICAL))
      && !reuseRedLines.some((l) => String(l).startsWith(ADMIN_RENAME)),
      JSON.stringify({ opts: reuseRedCaptures[0] && reuseRedCaptures[0].opts, lines: reuseRedLines }));
    ok('[entry/reuse] RED: listRentalOfferings not called with location authority',
      !listCalls.some((c) => c.clientSlug === CLIENT_SLUG && c.locationId === LOCATION_ID),
      JSON.stringify(listCalls));

    // Catalog miss retains historical fallback through reuse entry branch.
    listCalls = [];
    const reuseHistCaptures = [];
    await runGuestHoldPaymentDraftWriteDryRunApproved(
      makeReadyChain(),
      {
        confirm_write: true,
        client_slug: CLIENT_SLUG,
        guest_name: 'Label Guest',
        guest_phone: GUEST_PHONE,
        guest_email: GUEST_EMAIL,
        location_id: LOCATION_ID,
        env: { NODE_ENV: 'test' },
        pg: makeHoldWriteEntryPg('reuse', [retiredServiceRecord]),
        planner: makeReadyPlanner(`${IDEMPOTENCY_KEY}-reuse-hist`),
        attachAllGuestAddonServices: makeCapturingAttach(reuseHistCaptures),
      },
    );
    const reuseHistLines = linesFromAttachCapture(reuseHistCaptures[0]);
    ok('[entry/reuse] catalog miss retains historical fallback label',
      reuseHistLines.some((l) => String(l).startsWith('Legacy Towel Set')),
      JSON.stringify(reuseHistLines));

    // ══════════════════════════════════════════════════════════════════
    // PRIMARY: public entry point — newly-created hold branch
    // Entry: runGuestHoldPaymentDraftWriteDryRunApproved → executeHoldPaymentDraftWrite
    // Branch: no existing hold → upsertBookingHold → attach at create call site
    // ══════════════════════════════════════════════════════════════════
    listCalls = [];
    const createCaptures = [];
    const createOut = await runGuestHoldPaymentDraftWriteDryRunApproved(
      makeReadyChain(),
      {
        confirm_write: true,
        client_slug: CLIENT_SLUG,
        guest_name: 'Label Guest',
        guest_phone: GUEST_PHONE,
        guest_email: GUEST_EMAIL,
        location_id: LOCATION_ID,
        env: { NODE_ENV: 'test' },
        pg: makeHoldWriteEntryPg('create', [staleServiceRecord]),
        planner: makeReadyPlanner(`${IDEMPOTENCY_KEY}-create`),
        attachAllGuestAddonServices: makeCapturingAttach(createCaptures),
      },
    );
    ok('[entry/create] public write succeeds (created)',
      createOut && createOut.success === true && createOut.write_status === 'created',
      JSON.stringify({
        success: createOut && createOut.success,
        write_status: createOut && createOut.write_status,
        reasons: createOut && createOut.write_block_reasons,
      }));
    ok('[entry/create] real attach call site invoked exactly once',
      createCaptures.length === 1, `captures=${createCaptures.length}`);
    ok('[entry/create] attach opts carry locationId without injected catalogLabelMap',
      createCaptures[0]
      && createCaptures[0].opts.locationId === LOCATION_ID
      && createCaptures[0].opts.catalogLabelMap == null
      && createCaptures[0].opts.clientSlug === CLIENT_SLUG
      && createCaptures[0].opts.bookingId === BOOKING_ID,
      JSON.stringify(createCaptures[0] && createCaptures[0].opts));
    const createLines = linesFromAttachCapture(createCaptures[0]);
    ok('[entry/create] GREEN: service_charges_due_lines use current Admin rename (not stale)',
      createLines.some((l) => String(l).startsWith(ADMIN_RENAME))
      && !createLines.some((l) => String(l).startsWith(STALE_HISTORICAL)),
      JSON.stringify(createLines));
    ok('[entry/create] GREEN: listRentalOfferings tenant+location scoped',
      listCalls.some((c) => c.clientSlug === CLIENT_SLUG && c.locationId === LOCATION_ID),
      JSON.stringify(listCalls));

    // RED create path without location authority.
    listCalls = [];
    const createRedCaptures = [];
    const createRedOut = await runGuestHoldPaymentDraftWriteDryRunApproved(
      makeReadyChain(),
      {
        confirm_write: true,
        client_slug: CLIENT_SLUG,
        guest_name: 'Label Guest',
        guest_phone: GUEST_PHONE,
        guest_email: GUEST_EMAIL,
        env: { NODE_ENV: 'test' },
        pg: makeHoldWriteEntryPg('create', [staleServiceRecord]),
        planner: makeReadyPlanner(`${IDEMPOTENCY_KEY}-create-red`),
        attachAllGuestAddonServices: makeCapturingAttach(createRedCaptures),
      },
    );
    ok('[entry/create] RED write still succeeds (path independent of catalog)',
      createRedOut && createRedOut.success === true && createRedOut.write_status === 'created',
      JSON.stringify({
        success: createRedOut && createRedOut.success,
        write_status: createRedOut && createRedOut.write_status,
        reasons: createRedOut && createRedOut.write_block_reasons,
      }));
    const createRedLines = linesFromAttachCapture(createRedCaptures[0]);
    ok('[entry/create] RED: without locationId lines fall back to historical snapshot',
      createRedCaptures.length === 1
      && createRedCaptures[0].opts.locationId == null
      && createRedLines.some((l) => String(l).startsWith(STALE_HISTORICAL))
      && !createRedLines.some((l) => String(l).startsWith(ADMIN_RENAME)),
      JSON.stringify({ opts: createRedCaptures[0] && createRedCaptures[0].opts, lines: createRedLines }));

    // Catalog miss on create branch.
    listCalls = [];
    const createHistCaptures = [];
    await runGuestHoldPaymentDraftWriteDryRunApproved(
      makeReadyChain(),
      {
        confirm_write: true,
        client_slug: CLIENT_SLUG,
        guest_name: 'Label Guest',
        guest_phone: GUEST_PHONE,
        guest_email: GUEST_EMAIL,
        location_id: LOCATION_ID,
        env: { NODE_ENV: 'test' },
        pg: makeHoldWriteEntryPg('create', [retiredServiceRecord]),
        planner: makeReadyPlanner(`${IDEMPOTENCY_KEY}-create-hist`),
        attachAllGuestAddonServices: makeCapturingAttach(createHistCaptures),
      },
    );
    const createHistLines = linesFromAttachCapture(createHistCaptures[0]);
    ok('[entry/create] catalog miss retains historical fallback label',
      createHistLines.some((l) => String(l).startsWith('Legacy Towel Set')),
      JSON.stringify(createHistLines));

    // Both independent branches observed (regression guard: one branch alone is insufficient).
    ok('[entry] both reuse and create branches exercised via public entry',
      reuseCaptures.length === 1 && createCaptures.length === 1);
  } finally {
    tenantRentalOfferings.listRentalOfferings = origList;
  }
}

runHoldWriteAttachLedgerGate()
  .then(() => {
    console.log(`\n── verify:item-display-name: ${pass} passed, ${fail} failed ──`);
    if (fail === 0) console.log('verify:item-display-name — ALL CHECKS PASSED');
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    fail += 1;
    console.error('  FAIL  hold-write attach ledger gate threw', err && err.stack ? err.stack : err);
    console.log(`\n── verify:item-display-name: ${pass} passed, ${fail} failed ──`);
    process.exit(1);
  });
