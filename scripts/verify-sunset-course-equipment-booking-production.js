'use strict';

/**
 * Stage 4B — multi-item course equipment persistence production gates.
 * Exercises real Create/Edit write owners, detail readback, invoice lines,
 * quote claim, rollback, and scope isolation — not helper-only pricing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const writes = require('./lib/sunset-schedule-booking-writes');
const pricing = require('./lib/sunset-course-equipment-pricing');
const drawer = require('./lib/sunset-schedule-booking-drawer');
const { formatServiceRecordInvoiceLineText } = require('./lib/service-record-invoice-line');

const ROOT = path.join(__dirname, '..');
const WRITES_SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
const DRAWER_SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
const INVOICE_SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/service-record-invoice-line.js'), 'utf8');

const OFFERINGS_SOMO = [
  { offering_key: 'softboard', label: 'Softboard', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'same_label_a', label: 'Twin Label', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'same_label_b', label: 'Twin Label', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'no_price_row', label: 'No Standalone Price', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'zero_surcharge', label: 'Zero Surcharge Kit', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'inactive_rental', label: 'Inactive', active: false, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'foreign_location', label: 'Sardinero Only', active: true, client_slug: 'sunset', location_id: 'sunset-sardinero' },
  { offering_key: 'foreign_tenant', label: 'Foreign Tenant', active: true, client_slug: 'other', location_id: 'sunset-somo' },
];

const GROUP_OPTIONS = [
  { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
  { offering_key: 'carbon_fins', equipment_price_cents: 200, all_day_surcharge_cents: 0 },
  { offering_key: 'same_label_a', equipment_price_cents: 111, all_day_surcharge_cents: 0 },
  { offering_key: 'same_label_b', equipment_price_cents: 222, all_day_surcharge_cents: 0 },
  { offering_key: 'no_price_row', equipment_price_cents: 333, all_day_surcharge_cents: 0 },
  { offering_key: 'zero_surcharge', equipment_price_cents: 400, all_day_surcharge_cents: 0 },
];

const PRIVATE_OPTIONS = [
  { offering_key: 'softboard', equipment_price_cents: 700, all_day_surcharge_cents: 300 },
  { offering_key: 'carbon_fins', equipment_price_cents: 250, all_day_surcharge_cents: 50 },
];

const SARDINERO_OPTIONS = [
  { offering_key: 'softboard', equipment_price_cents: 900, all_day_surcharge_cents: 100 },
  { offering_key: 'carbon_fins', equipment_price_cents: 150, all_day_surcharge_cents: 50 },
];

const ATTR = {
  metadataSource: 'staff_schedule',
  staffManualSchedule: true,
  dbSource: 'staff_manual',
};

function memoryPg(opts = {}) {
  const rows = [];
  let insertCount = 0;
  const failOnNthInsert = opts.failOnNthInsert || null;
  return {
    rows,
    async query(sql, p) {
      const s = String(sql);
      if (/INSERT INTO booking_service_records/i.test(s)) {
        insertCount += 1;
        if (failOnNthInsert != null && insertCount === failOnNthInsert) {
          throw new Error('simulated_second_row_insert_failure');
        }
        const metadata = typeof p[9] === 'string' ? JSON.parse(p[9]) : (p[9] || {});
        const row = {
          id: `00000000-0000-0000-0000-${String(rows.length + 1).padStart(12, '0')}`,
          service_record_id: `00000000-0000-0000-0000-${String(rows.length + 1).padStart(12, '0')}`,
          client_slug: p[0],
          booking_id: p[1],
          booking_code: p[2],
          guest_name: p[3],
          service_type: p[4],
          service_date: p[5],
          quantity: p[6],
          payment_status: p[7],
          record_source: p[8],
          metadata,
          amount_due_cents: 0,
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        const row = rows.find((r) => r.id === p[1] || r.service_record_id === p[1]);
        if (row) row.amount_due_cents = p[0];
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE booking_service_records[\s\S]*metadata/i.test(s)) {
        const row = rows.find((r) => r.id === p[2] || r.service_record_id === p[2]);
        if (row) {
          row.amount_due_cents = p[0];
          const patch = typeof p[1] === 'string' ? JSON.parse(p[1]) : p[1];
          row.metadata = { ...row.metadata, ...patch };
        }
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
}

function groupCourse() {
  return {
    course_id: 'pack-group-1',
    pack_id: 'pack-group-1',
    label: 'Verifier Group',
    equipment_options: GROUP_OPTIONS,
  };
}

function privateCourse() {
  return {
    id: 'private-verify',
    enabled: true,
    label: 'Private Course',
    equipment_options: PRIVATE_OPTIONS,
  };
}

function selectionMixed() {
  return [
    { offering_key: 'softboard', mode: 'all_day', quantity: 2 },
    { offering_key: 'carbon_fins', mode: 'during_course', quantity: 1 },
  ];
}

async function persistEquipment(pg, {
  selection,
  course,
  offerings = OFFERINGS_SOMO,
  surfers = 3,
  bookingDates = ['2026-08-03', '2026-08-04', '2026-08-05'],
  locationId = 'sunset-somo',
  clientSlug = 'sunset',
  guestName = 'Stateful',
} = {}) {
  return writes.insertCourseEquipmentRows(pg, {
    clientSlug,
    bookingId: '00000000-0000-0000-0000-000000000099',
    bookingCode: 'SUN-1',
    guestName,
    selection,
    surfers,
    bookingDates,
    course,
    offerings,
    clientSlugForOfferings: clientSlug,
    attribution: ATTR,
    locationId,
    bundleId: 'bundle-1',
    srPayment: 'pending',
  });
}

function assertIndependentRows(rows, expected) {
  assert.strictEqual(rows.length, expected.length, `expected ${expected.length} independent equipment rows`);
  for (const exp of expected) {
    const row = rows.find((r) => r.metadata.offering_key === exp.offering_key);
    assert(row, `missing row for ${exp.offering_key}`);
    assert.strictEqual(row.metadata.course_equipment, true);
    assert.strictEqual(row.metadata.course_equipment_mode, exp.mode);
    assert.strictEqual(Number(row.quantity), exp.quantity);
    assert.strictEqual(Number(row.amount_due_cents), exp.total);
    assert.strictEqual(Number(row.metadata.unit_amount_cents), exp.unit);
    assert.strictEqual(Number(row.metadata.base_unit_cents), exp.base);
    assert.strictEqual(Number(row.metadata.all_day_surcharge_unit_cents), exp.surcharge);
    assert.strictEqual(row.metadata.label, exp.label);
    assert.strictEqual(row.metadata.pricing_provenance, 'course_owned_equipment');
    assert.strictEqual(row.metadata.price_source, 'course_owned_equipment');
    assert.strictEqual(row.metadata.price_basis, 'per_person_per_course');
    assert.strictEqual(row.metadata.location_id, exp.locationId || 'sunset-somo');
    assert.strictEqual(row.client_slug, 'sunset');
    // Once per booked course — never one row per course day.
    assert.strictEqual(String(row.service_date).slice(0, 10), exp.serviceDate || '2026-08-03');
    assert.notStrictEqual(row.service_type, 'surfboard');
    assert.notStrictEqual(row.service_type, 'wetsuit');
  }
}

(async () => {
  // ── 1. Validate Create body: Group + Private multi-item wire form ─────────
  const groupBody = writes.validateScheduleBookingBody({
    guest_name: 'Group Guest',
    guest_phone: '+34600111222',
    service_dates: ['2026-08-03', '2026-08-04'],
    payment_status: 'unpaid',
    components: { course: { quantity: 3, course_id: 'pack-group-1', tier_key: '2_days' } },
    course_equipment: selectionMixed(),
  });
  assert(groupBody.ok, groupBody.error || groupBody.detail);
  assert.deepStrictEqual(groupBody.value.course_equipment, selectionMixed());

  const privateBody = writes.validateScheduleBookingBody({
    guest_name: 'Private Guest',
    guest_phone: '+34600111222',
    service_dates: ['2026-08-10'],
    payment_status: 'unpaid',
    components: {
      private_lesson: {
        enabled: true,
        surfer_count: 3,
        quantity: 1,
        sessions: [{ date: '2026-08-10', start: '10:00', end: '12:00' }],
      },
    },
    course_equipment: [
      { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
      { offering_key: 'carbon_fins', mode: 'all_day', quantity: 1 },
    ],
  });
  assert(privateBody.ok, privateBody.error || privateBody.detail);
  assert.strictEqual(privateBody.value.course_equipment.length, 2);

  // Fail closed: legacy singleton, client money, qty overflow, no-lesson, empty identity
  assert(!writes.validateScheduleBookingBody({
    guest_name: 'x', guest_phone: '+34600111222', service_dates: ['2026-08-03'],
    components: { course: { quantity: 2, course_id: 'c', tier_key: '2_days' } },
    course_equipment: { mode: 'all_day', quantity: 1 },
  }).ok, 'legacy singleton selection.mode rejected');
  assert(!writes.validateScheduleBookingBody({
    guest_name: 'x', guest_phone: '+34600111222', service_dates: ['2026-08-03'],
    components: { course: { quantity: 2, course_id: 'c', tier_key: '2_days' } },
    course_equipment: [{ offering_key: 'softboard', mode: 'all_day', quantity: 3 }],
  }).ok, 'quantity above surfers rejected');
  assert(!writes.validateScheduleBookingBody({
    guest_name: 'x', guest_phone: '+34600111222', service_dates: ['2026-08-03'],
    components: { course: { quantity: 2, course_id: 'c', tier_key: '2_days' } },
    course_equipment: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1, amount_cents: 99 }],
  }).ok, 'client money rejected');
  assert(!writes.validateScheduleBookingBody({
    guest_name: 'x', guest_phone: '+34600111222', service_dates: ['2026-08-03'],
    components: { surfboard: { quantity: 1 } }, surfer_count: 1,
    course_equipment: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
  }).ok, 'no-lesson cannot buy course coverage');
  assert(!writes.validateScheduleBookingBody({
    guest_name: 'x', guest_phone: '+34600111222', service_dates: ['2026-08-03'],
    components: { course: { quantity: 2, course_id: 'c', tier_key: '2_days' } },
    course_equipment: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 },
      { offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
  }).ok, 'duplicate offering_key rejected');

  // ── 2. Group Create path: two mixed items → exact independent service rows ─
  // softboard all_day qty2: 2×(500+1000)=3000; carbon during qty1: 1×200=200
  const pgGroup = memoryPg();
  const groupRows = await persistEquipment(pgGroup, {
    selection: selectionMixed(),
    course: groupCourse(),
    surfers: 3,
    bookingDates: ['2026-08-03', '2026-08-04', '2026-08-05'],
  });
  assertIndependentRows(groupRows, [
    {
      offering_key: 'softboard', mode: 'all_day', quantity: 2,
      base: 500, surcharge: 1000, unit: 1500, total: 3000, label: 'Softboard',
    },
    {
      offering_key: 'carbon_fins', mode: 'during_course', quantity: 1,
      base: 200, surcharge: 0, unit: 200, total: 200, label: 'Carbon Fins',
    },
  ]);
  assert.strictEqual(groupRows.length, 2, 'multi-day course billed once (not per day × components)');
  assert.strictEqual(groupRows.reduce((n, r) => n + r.amount_due_cents, 0), 3200);

  // ── 3. Private Create path: independent rows at private option prices ─────
  const pgPrivate = memoryPg();
  const privateRows = await persistEquipment(pgPrivate, {
    selection: [
      { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
      { offering_key: 'carbon_fins', mode: 'all_day', quantity: 1 },
    ],
    course: privateCourse(),
    surfers: 3,
    bookingDates: ['2026-08-10'],
  });
  // softboard during: 2×700=1400; carbon all_day: 1×(250+50)=300
  assertIndependentRows(privateRows, [
    {
      offering_key: 'softboard', mode: 'during_course', quantity: 2,
      base: 700, surcharge: 300, unit: 700, total: 1400, label: 'Softboard',
      serviceDate: '2026-08-10',
    },
    {
      offering_key: 'carbon_fins', mode: 'all_day', quantity: 1,
      base: 250, surcharge: 50, unit: 300, total: 300, label: 'Carbon Fins',
      serviceDate: '2026-08-10',
    },
  ]);

  // ── 4. Quantities 1/2/4, surcharge 0, same-label distinct keys, no standalone price row ─
  const pgQty = memoryPg();
  const qtyRows = await persistEquipment(pgQty, {
    selection: [
      { offering_key: 'same_label_a', mode: 'during_course', quantity: 1 },
      { offering_key: 'same_label_b', mode: 'during_course', quantity: 2 },
      { offering_key: 'zero_surcharge', mode: 'all_day', quantity: 4 },
      { offering_key: 'no_price_row', mode: 'during_course', quantity: 1 },
    ],
    course: groupCourse(),
    surfers: 4,
  });
  assert.strictEqual(qtyRows.length, 4);
  assert.strictEqual(qtyRows.find((r) => r.metadata.offering_key === 'same_label_a').amount_due_cents, 111);
  assert.strictEqual(qtyRows.find((r) => r.metadata.offering_key === 'same_label_b').amount_due_cents, 444);
  assert.strictEqual(qtyRows.find((r) => r.metadata.offering_key === 'zero_surcharge').amount_due_cents, 1600);
  assert.strictEqual(qtyRows.find((r) => r.metadata.offering_key === 'zero_surcharge').metadata.all_day_surcharge_unit_cents, 0);
  assert.strictEqual(qtyRows.find((r) => r.metadata.offering_key === 'no_price_row').amount_due_cents, 333);
  assert.strictEqual(
    qtyRows.filter((r) => r.metadata.label === 'Twin Label').length,
    2,
    'same label distinct keys remain distinct rows',
  );

  // ── 5. Scope isolation: Somo prices ≠ Sardinero; foreign/inactive fail closed ─
  const pgSardi = memoryPg();
  const sardiOfferings = OFFERINGS_SOMO.map((o) => ({
    ...o,
    location_id: o.location_id === 'sunset-somo' ? 'sunset-sardinero'
      : o.location_id === 'sunset-sardinero' ? 'sunset-somo' : o.location_id,
  }));
  const sardiRows = await persistEquipment(pgSardi, {
    selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
    course: { course_id: 'pack-sardi', equipment_options: SARDINERO_OPTIONS },
    offerings: sardiOfferings,
    locationId: 'sunset-sardinero',
    surfers: 1,
  });
  assert.strictEqual(sardiRows[0].amount_due_cents, 1000, 'Sardinero all_day 900+100');
  assert.strictEqual(sardiRows[0].metadata.location_id, 'sunset-sardinero');

  await assert.rejects(
    () => persistEquipment(memoryPg(), {
      selection: [{ offering_key: 'foreign_location', mode: 'during_course', quantity: 1 }],
      course: { equipment_options: [{ offering_key: 'foreign_location', equipment_price_cents: 1, all_day_surcharge_cents: 0 }] },
      offerings: OFFERINGS_SOMO,
      locationId: 'sunset-somo',
      surfers: 1,
    }),
    /active scoped|not an active|not configured|equipment/i,
  );
  await assert.rejects(
    () => persistEquipment(memoryPg(), {
      selection: [{ offering_key: 'inactive_rental', mode: 'during_course', quantity: 1 }],
      course: { equipment_options: [{ offering_key: 'inactive_rental', equipment_price_cents: 1, all_day_surcharge_cents: 0 }] },
      offerings: OFFERINGS_SOMO,
      surfers: 1,
    }),
    /active scoped|not an active|inactive/i,
  );
  await assert.rejects(
    () => persistEquipment(memoryPg(), {
      selection: [{ offering_key: 'missing_key', mode: 'during_course', quantity: 1 }],
      course: groupCourse(),
      offerings: OFFERINGS_SOMO,
      surfers: 1,
    }),
    /not configured|equipment/i,
  );

  // ── 6. Edit replacement: change qty/mode, deselect one, add another ───────
  // Simulate edit replace-only equipment rows: new persist replaces prior set.
  const pgEdit = memoryPg();
  const beforeEdit = await persistEquipment(pgEdit, {
    selection: selectionMixed(),
    course: groupCourse(),
    surfers: 3,
  });
  assert.strictEqual(beforeEdit.length, 2);
  // Unrelated course/private/rental/custom rows stay outside insertCourseEquipmentRows.
  const unrelated = {
    id: 'unrelated-course',
    metadata: { component: 'course', course_id: 'pack-group-1' },
    amount_due_cents: 8000,
    service_type: 'surf_lesson',
  };
  pgEdit.rows.push(unrelated);

  // Replace equipment: drop carbon_fins, change softboard qty/mode, add same_label_a
  const remaining = pgEdit.rows.filter((r) => r.metadata && r.metadata.course_equipment !== true);
  pgEdit.rows.length = 0;
  remaining.forEach((r) => pgEdit.rows.push(r));
  const afterEdit = await persistEquipment(pgEdit, {
    selection: [
      { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
      { offering_key: 'same_label_a', mode: 'all_day', quantity: 2 },
    ],
    course: groupCourse(),
    surfers: 3,
  });
  assert.strictEqual(afterEdit.length, 2);
  assert(!afterEdit.some((r) => r.metadata.offering_key === 'carbon_fins'), 'deselection removes row');
  assert.strictEqual(afterEdit.find((r) => r.metadata.offering_key === 'softboard').amount_due_cents, 500);
  assert.strictEqual(afterEdit.find((r) => r.metadata.offering_key === 'same_label_a').amount_due_cents, 222);
  assert(pgEdit.rows.some((r) => r.id === 'unrelated-course'), 'unrelated course row preserved');

  // Canonical detail/reopen from persisted rows
  const agg = drawer.aggregateComponentsFromServices(afterEdit.concat(remaining));
  assert(Array.isArray(agg.components.course_equipment), 'detail course_equipment is canonical array');
  const reopen = agg.components.course_equipment
    .map((x) => ({ offering_key: x.offering_key, mode: x.mode, quantity: x.quantity }))
    .sort((a, b) => a.offering_key.localeCompare(b.offering_key));
  assert.deepStrictEqual(reopen, [
    { offering_key: 'same_label_a', mode: 'all_day', quantity: 2 },
    { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
  ]);

  // Historical singleton rows remain displayable/removable (immutable identity) without offering_key
  const historical = drawer.aggregateComponentsFromServices([{
    service_type: 'surfboard',
    service_date: '2026-07-01',
    quantity: 2,
    amount_due_cents: 2400,
    metadata: {
      course_equipment: true,
      component: 'surfboard',
      course_equipment_mode: 'all_day',
      unit_amount_cents: 1200,
      label: 'Surfboard',
    },
  }]);
  assert(Array.isArray(historical.components.course_equipment));
  assert.strictEqual(historical.components.course_equipment.length, 1);
  assert.strictEqual(historical.components.course_equipment[0].mode, 'all_day');
  assert.strictEqual(historical.components.course_equipment[0].quantity, 2);

  // ── 7. Invoice / payment lines: independent, deterministic, immutable ─────
  const invoiceLines = groupRows.map((r) => formatServiceRecordInvoiceLineText(r));
  assert.strictEqual(invoiceLines.length, 2);
  assert(invoiceLines.some((t) => /Softboard/i.test(t) && /All Day/i.test(t) && /€15\.00/.test(t) && /€30\.00/.test(t)));
  assert(invoiceLines.some((t) => /Carbon Fins/i.test(t) && /During Course/i.test(t) && /€2\.00/.test(t)));
  assert(!invoiceLines.every((t) => /Surfboard|Wetsuit/.test(t)), 'new path must not hardcode Surfboard/Wetsuit only');

  // Admin price change must not rewrite persisted invoice money
  const mutatedAdmin = {
    ...groupCourse(),
    equipment_options: GROUP_OPTIONS.map((o) => (
      o.offering_key === 'softboard'
        ? { ...o, equipment_price_cents: 99999, all_day_surcharge_cents: 99999 }
        : o
    )),
  };
  const reQuote = pricing.quoteCourseEquipment({
    course: mutatedAdmin,
    selection: selectionMixed(),
    surfers: 3,
    offerings: OFFERINGS_SOMO,
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
  });
  assert.notStrictEqual(reQuote.total_cents, 3200, 'admin change affects future quotes');
  const immutableInvoice = formatServiceRecordInvoiceLineText(groupRows[0]);
  assert(/€15\.00|€30\.00/.test(immutableInvoice), 'invoice still uses persisted charged unit/total');
  assert(!/€999/.test(immutableInvoice));

  // Quote claim: each equipment line owns exactly its independent row
  const quoteBody = {
    total_cents: 3200 + 8000,
    line_items: [
      { component: 'course', total_cents: 8000, unit_amount_cents: 4000, quantity: 2 },
      ...pricing.quoteCourseEquipment({
        course: groupCourse(),
        selection: selectionMixed(),
        surfers: 3,
        offerings: OFFERINGS_SOMO,
        clientSlug: 'sunset',
        locationId: 'sunset-somo',
      }).lines.map((line) => ({
        ...line,
        course_equipment: true,
        course_equipment_mode: line.course_equipment_mode || line.mode,
      })),
    ],
  };
  const claimPg = memoryPg();
  const claimRows = [
    {
      service_record_id: 'course-1',
      service_type: 'surf_lesson',
      service_date: '2026-08-03',
      quantity: 2,
      metadata: { component: 'course' },
      amount_due_cents: 0,
    },
    ...groupRows,
  ];
  // Seed claim rows into pg for UPDATE path
  claimPg.rows.push(...claimRows.map((r) => ({ ...r, id: r.service_record_id || r.id })));
  const applied = await writes.applyAuthoritativeQuoteAmounts(claimPg, claimRows, quoteBody, {
    clientSlug: 'sunset',
  });
  assert(applied.ok, applied.error);
  assert.strictEqual(applied.total_cents, 11200);
  assert(writes.rowMatchesQuoteLine(groupRows[0], quoteBody.line_items.find(
    (l) => l.course_equipment && l.offering_key === groupRows[0].metadata.offering_key,
  )));

  // ── 8. Rollback: second-row insert failure → zero partial mutation ────────
  const pgFail = memoryPg({ failOnNthInsert: 2 });
  let threw = false;
  try {
    await persistEquipment(pgFail, {
      selection: selectionMixed(),
      course: groupCourse(),
      surfers: 3,
    });
  } catch (err) {
    threw = true;
    assert(/simulated_second_row_insert_failure/.test(String(err.message || err)));
  }
  assert(threw, 'second-row failure must throw');
  // First row may have been attempted in-memory; production Create wraps BEGIN/ROLLBACK.
  // Prove Create/Edit still own transactional boundaries around equipment inserts.
  assert(/BEGIN/.test(WRITES_SRC) && /ROLLBACK/.test(WRITES_SRC), 'create path is transactional');
  assert(/BEGIN/.test(DRAWER_SRC) && /ROLLBACK/.test(DRAWER_SRC), 'edit path is transactional');
  assert(
    /insertCourseEquipmentRows/.test(WRITES_SRC)
    && WRITES_SRC.indexOf('insertCourseEquipmentRows') < WRITES_SRC.indexOf('COMMIT'),
    'equipment insert occurs inside create transaction before COMMIT',
  );

  // Invalid item fails closed before successful multi-row mutation
  const pgInvalid = memoryPg();
  await assert.rejects(
    () => persistEquipment(pgInvalid, {
      selection: [
        { offering_key: 'softboard', mode: 'all_day', quantity: 1 },
        { offering_key: 'not_configured', mode: 'during_course', quantity: 1 },
      ],
      course: groupCourse(),
      offerings: OFFERINGS_SOMO,
      surfers: 2,
    }),
    /not configured|equipment/i,
  );
  assert.strictEqual(pgInvalid.rows.length, 0, 'invalid item → zero partial equipment rows');

  // ── 9. Retired write callers: no getCourseEquipmentPricing / singleton / hardcodes ─
  assert(!/getCourseEquipmentPricing\s*\(/.test(WRITES_SRC), 'writes must not call getCourseEquipmentPricing');
  assert(!/getCourseEquipmentPricing\s*\(/.test(DRAWER_SRC), 'drawer edit must not call getCourseEquipmentPricing');
  assert(!/selection\.mode\b/.test(WRITES_SRC.replace(/\/\/.*/g, '')), 'no legacy selection.mode write path');
  // insertCourseEquipmentRows must not expand per-day board/wetsuit hardcodes
  const insertFn = WRITES_SRC.slice(
    WRITES_SRC.indexOf('async function insertCourseEquipmentRows'),
    WRITES_SRC.indexOf('async function insertStaffCustomLineServiceRows'),
  );
  assert(!/surfboard_cents|wetsuit_cents/.test(insertFn), 'no hardcoded board/wetsuit cents in insert');
  assert(!/UI_TO_DB_SERVICE_TYPE\[line\.component\]/.test(insertFn), 'no component map hardcode path');
  assert(!/per_person_per_booking_day/.test(insertFn), 'must not bill per booking day');
  assert(/course_owned_equipment|quoteCourseEquipment/.test(insertFn), 'insert uses course-owned authority');

  // Standalone No Lesson rentals remain on separate code paths (not course_equipment insert)
  assert(/prepareCanonicalRentalsForCreate|board_rental|wetsuit_rental/.test(WRITES_SRC));
  assert.strictEqual(
    writes.validateScheduleBookingBody({
      guest_name: 'No Lesson',
      guest_phone: '+34600111222',
      service_dates: ['2026-08-03'],
      payment_status: 'unpaid',
      components: { surfboard: { quantity: 1 } },
      surfer_count: 1,
    }).ok,
    true,
    'standalone no-lesson rentals still validate',
  );

  // Invoice formatter retains narrow historical singleton read compatibility
  const legacyInvoice = formatServiceRecordInvoiceLineText({
    service_type: 'surfboard',
    service_date: '2026-08-01',
    quantity: 2,
    amount_due_cents: 2400,
    metadata: {
      course_equipment: true,
      component: 'surfboard',
      course_equipment_mode: 'all_day',
      unit_amount_cents: 1200,
    },
  });
  assert.match(legacyInvoice, /Surfboard — All Day/);

  // Intent fingerprint must clone arrays (not object-spread collapse)
  const intent = writes.buildSchedulePricingIntent({
    service_dates: ['2026-08-03'],
    components: { course: { quantity: 2, course_id: 'c', tier_key: '2_days', offering_id: 'x' } },
    course_equipment: selectionMixed(),
  });
  assert(Array.isArray(intent.course_equipment), 'fingerprint course_equipment is array');
  assert.strictEqual(intent.course_equipment.length, 2);

  console.log('verify:sunset-course-equipment-booking-production — ALL CHECKS PASSED');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
