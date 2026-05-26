/**
 * Phase 3b.4a — Manual Entry impact plan (read-only, SELECT-only).
 * Simulates hosted Manual Entries queue create/update/delete against Postgres.
 */
const fs = require('fs');
const { assignmentNaturalKey, toIsoDateString } = require('./bed-drift-keys');
const { parseBedList, roomCodeFromBedCode } = require('./assign-booking-beds-plan');

const PENDING_BOOKING_ID = '00000000-0000-0000-0000-000000000000';

const PACKAGE_MAP = {
  malibu: 'malibu',
  uluwatu: 'uluwatu',
  waimea: 'waimea',
  custom: 'custom',
};

const STATUS_MAP = {
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  expired: 'expired',
  pending: 'pending',
};

const PAYMENT_STATUS_MAP = {
  waiting_payment: 'waiting_payment',
  deposit_paid: 'deposit_paid',
  paid_in_full: 'paid_in_full',
  refunded: 'refunded',
  failed: 'failed',
};

function normalizePackage(raw) {
  const key = String(raw || 'malibu')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return PACKAGE_MAP[key] || key || 'malibu';
}

function normalizeStatus(raw, fallback = 'confirmed') {
  const key = String(raw || fallback)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return STATUS_MAP[key] || key || fallback;
}

function normalizePaymentStatus(raw, fallback = 'waiting_payment') {
  const key = String(raw || fallback)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return PAYMENT_STATUS_MAP[key] || key || fallback;
}

function deriveActionFromSyncStatus(syncStatus) {
  const s = String(syncStatus || '')
    .trim()
    .toLowerCase();
  if (s.includes('delete')) return 'delete';
  if (s.includes('update')) return 'update';
  if (s === 'ready' || s === 'processing' || s === '') return 'create';
  return null;
}

function provisionalBookingCode(manualEntryId) {
  const safe = String(manualEntryId || 'unknown')
    .replace(/[^\w-]/g, '_')
    .slice(0, 80);
  return `WH-pending-${safe}`;
}

function parseManualEntryInput(argv) {
  const input = {
    clientSlug: 'wolfhouse-somo',
    manualEntryId: null,
    action: null,
    syncStatus: null,
    guestName: null,
    checkIn: null,
    checkOut: null,
    guestCount: null,
    bedCodes: [],
    status: null,
    paymentStatus: null,
    packageCode: null,
    phone: null,
    email: null,
    notes: null,
    depositPaid: null,
    airtableRecordId: null,
    bookingCode: null,
    jsonFile: null,
    parsedFrom: 'cli_flags',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];

    if (arg.startsWith('--manual-entry-id=')) {
      input.manualEntryId = arg.slice('--manual-entry-id='.length).trim();
    } else if (arg === '--manual-entry-id' && argv[i + 1]) {
      input.manualEntryId = next().trim();
    } else if (arg.startsWith('--action=')) {
      input.action = arg.slice('--action='.length).trim().toLowerCase();
    } else if (arg === '--action' && argv[i + 1]) {
      input.action = next().trim().toLowerCase();
    } else if (arg.startsWith('--sync-status=')) {
      input.syncStatus = arg.slice('--sync-status='.length).trim();
    } else if (arg === '--sync-status' && argv[i + 1]) {
      input.syncStatus = next().trim();
    } else if (arg.startsWith('--guest-name=')) {
      input.guestName = arg.slice('--guest-name='.length).trim();
    } else if (arg === '--guest-name' && argv[i + 1]) {
      input.guestName = next().trim();
    } else if (arg.startsWith('--check-in=')) {
      input.checkIn = toIsoDateString(arg.slice('--check-in='.length));
    } else if (arg === '--check-in' && argv[i + 1]) {
      input.checkIn = toIsoDateString(next());
    } else if (arg.startsWith('--check-out=')) {
      input.checkOut = toIsoDateString(arg.slice('--check-out='.length));
    } else if (arg === '--check-out' && argv[i + 1]) {
      input.checkOut = toIsoDateString(next());
    } else if (arg.startsWith('--guest-count=')) {
      input.guestCount = Number(arg.slice('--guest-count='.length));
    } else if (arg === '--guest-count' && argv[i + 1]) {
      input.guestCount = Number(next());
    } else if (arg.startsWith('--beds=')) {
      input.bedCodes = parseBedList(arg.slice('--beds='.length));
    } else if (arg === '--beds' && argv[i + 1]) {
      input.bedCodes = parseBedList(next());
    } else if (arg.startsWith('--status=')) {
      input.status = arg.slice('--status='.length).trim();
    } else if (arg === '--status' && argv[i + 1]) {
      input.status = next().trim();
    } else if (arg.startsWith('--payment-status=')) {
      input.paymentStatus = arg.slice('--payment-status='.length).trim();
    } else if (arg === '--payment-status' && argv[i + 1]) {
      input.paymentStatus = next().trim();
    } else if (arg.startsWith('--package=')) {
      input.packageCode = arg.slice('--package='.length).trim();
    } else if (arg === '--package' && argv[i + 1]) {
      input.packageCode = next().trim();
    } else if (arg.startsWith('--airtable-record-id=')) {
      input.airtableRecordId = arg.slice('--airtable-record-id='.length).trim();
    } else if (arg === '--airtable-record-id' && argv[i + 1]) {
      input.airtableRecordId = next().trim();
    } else if (arg.startsWith('--booking-code=')) {
      input.bookingCode = arg.slice('--booking-code='.length).trim();
    } else if (arg === '--booking-code' && argv[i + 1]) {
      input.bookingCode = next().trim();
    } else if (arg.startsWith('--client=')) {
      input.clientSlug = arg.slice('--client='.length).trim();
    } else if (arg.startsWith('--json-file=')) {
      input.jsonFile = arg.slice('--json-file='.length).trim();
    } else if (arg === '--json-file' && argv[i + 1]) {
      input.jsonFile = next().trim();
    }
  }

  if (input.jsonFile) {
    mergeJsonFile(input, input.jsonFile);
  }

  if (!input.action && input.syncStatus) {
    input.action = deriveActionFromSyncStatus(input.syncStatus);
  }

  return input;
}

function mergeJsonFile(input, jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  const row = data.manual_entry || data.queue_item || data;
  input.parsedFrom = 'json_file';

  if (row.manual_entry_id) input.manualEntryId = row.manual_entry_id;
  if (row.action) input.action = String(row.action).toLowerCase();
  if (row.sync_status) input.syncStatus = row.sync_status;
  if (row.guest_name) input.guestName = row.guest_name;
  if (row.check_in) input.checkIn = toIsoDateString(row.check_in);
  if (row.check_out) input.checkOut = toIsoDateString(row.check_out);
  if (row.guest_count != null) input.guestCount = Number(row.guest_count);
  if (row.room_bed) input.bedCodes = parseBedList(row.room_bed);
  if (row.beds) input.bedCodes = parseBedList(row.beds);
  if (Array.isArray(row.bed_ids) && row.bed_ids.length) {
    input.bedCodes = row.bed_ids.map((b) => String(b).trim().toUpperCase()).filter(Boolean);
  }
  if (row.status) input.status = row.status;
  if (row.payment_status) input.paymentStatus = row.payment_status;
  if (row.package) input.packageCode = row.package;
  if (row.phone) input.phone = row.phone;
  if (row.email) input.email = row.email;
  if (row.notes) input.notes = row.notes;
  if (row.deposit_paid != null) input.depositPaid = row.deposit_paid;
  const atId =
    row.airtable_booking_record_id || row.airtable_record_id || row.airtable_booking_id;
  if (atId) input.airtableRecordId = atId;
  if (row.booking_code) input.bookingCode = row.booking_code;
  if (row.client_slug) input.clientSlug = row.client_slug;
}

function buildParsedManualEntry(input) {
  const guestCount =
    Number(input.guestCount) > 0 ? Number(input.guestCount) : input.action === 'delete' ? null : 1;

  return {
    manual_entry_id: input.manualEntryId,
    action: input.action,
    sync_status: input.syncStatus,
    guest_name: input.guestName,
    check_in: input.checkIn,
    check_out: input.checkOut,
    guest_count: guestCount,
    bed_codes: [...input.bedCodes],
    status: normalizeStatus(input.status, 'confirmed'),
    payment_status: normalizePaymentStatus(input.paymentStatus, 'waiting_payment'),
    package_code: normalizePackage(input.packageCode),
    booking_source: 'manual_staff',
    phone: input.phone,
    email: input.email,
    notes: input.notes,
    deposit_paid: input.depositPaid,
    airtable_record_id: input.airtableRecordId,
    booking_code: input.bookingCode,
  };
}

function validateInput(parsed, input) {
  const missing = [];
  const actionable = [];

  if (!parsed.manual_entry_id) missing.push('manual_entry_id');
  if (!parsed.action || !['create', 'update', 'delete'].includes(parsed.action)) {
    missing.push('action');
  }

  if (parsed.action === 'create') {
    if (!parsed.guest_name) missing.push('guest_name');
    if (!parsed.check_in) missing.push('check_in');
    if (!parsed.check_out) missing.push('check_out');
    if (!parsed.bed_codes.length) missing.push('beds');
  }

  if (missing.length && parsed.action === 'create' && missing.includes('beds')) {
    actionable.push('missing_required_fields');
  }

  if (parsed.action === 'update' || parsed.action === 'delete') {
    if (!parsed.airtable_record_id && !parsed.booking_code) {
      missing.push('airtable_record_id_or_booking_code');
    }
  }

  let invalidDateRange = false;
  if (parsed.check_in && parsed.check_out && parsed.check_out <= parsed.check_in) {
    invalidDateRange = true;
    actionable.push('invalid_date_range');
  }

  return { missing, invalidDateRange, actionable };
}

async function lookupBooking(client, clientId, parsed) {
  if (!parsed.booking_code && !parsed.airtable_record_id) {
    return { found: false, match_by: null, booking: null, ambiguous_count: 0 };
  }

  let bookingQuery = `SELECT
       id,
       booking_code,
       airtable_record_id,
       guest_name,
       status::text AS status,
       payment_status::text AS payment_status,
       assignment_status::text AS assignment_status,
       availability_check_status::text AS availability_check_status,
       check_in::text AS check_in,
       check_out::text AS check_out,
       guest_count,
       booking_source::text AS booking_source,
       package_code,
       staff_notes,
       requested_room_type,
       room_preference,
       guest_gender_group_type::text AS guest_gender_group_type
     FROM bookings
     WHERE client_id = $1`;
  const bookingParams = [clientId];
  if (parsed.booking_code) {
    bookingParams.push(parsed.booking_code);
    bookingQuery += ` AND booking_code = $${bookingParams.length}`;
  }
  if (parsed.airtable_record_id) {
    bookingParams.push(parsed.airtable_record_id);
    bookingQuery += ` AND airtable_record_id = $${bookingParams.length}`;
  }
  bookingQuery += ' LIMIT 2';

  const { rows } = await client.query(bookingQuery, bookingParams);
  if (!rows.length) {
    return { found: false, match_by: null, booking: null, ambiguous_count: 0 };
  }
  if (rows.length > 1) {
    return {
      found: false,
      match_by: parsed.booking_code ? 'booking_code' : 'airtable_record_id',
      booking: null,
      ambiguous_count: rows.length,
      error: 'booking_ambiguous',
    };
  }
  const booking = rows[0];
  return {
    found: true,
    match_by: parsed.booking_code ? 'booking_code' : 'airtable_record_id',
    booking_id: booking.id,
    booking_code: booking.booking_code,
    booking,
    ambiguous_count: 0,
  };
}

async function loadCreateBedPlan(client, clientId, bookingCode, bookingIdForOverlap, bedCodes, checkIn, checkOut) {
  const { rows: bedInventory } = await client.query(
    `SELECT id, bed_code FROM beds WHERE client_id = $1`,
    [clientId]
  );
  const bedByCode = Object.fromEntries(
    bedInventory.map((b) => [String(b.bed_code).trim().toUpperCase(), b])
  );

  const proposed = [];
  const wouldInsert = [];
  const wouldSkip = [];
  const unknownBedCodes = [];
  const overlapConflicts = [];

  for (const bedCode of bedCodes) {
    const naturalKey = assignmentNaturalKey(bookingCode, bedCode, checkIn, checkOut);
    const inv = bedByCode[bedCode];
    const entry = {
      bed_code: bedCode,
      room_code: roomCodeFromBedCode(bedCode),
      assignment_start_date: checkIn,
      assignment_end_date: checkOut,
      natural_key: naturalKey,
      bed_id: inv?.id || null,
      assignment_type: 'manual_staff',
    };
    proposed.push(entry);

    if (!inv) {
      unknownBedCodes.push(bedCode);
      continue;
    }

    const { rows: overlaps } = await client.query(
      `SELECT
         bb.id::text AS booking_bed_id,
         b.booking_code,
         bb.bed_code,
         bb.assignment_start_date::text AS assignment_start_date,
         bb.assignment_end_date::text AS assignment_end_date,
         b.status::text AS booking_status
       FROM booking_beds bb
       INNER JOIN bookings b ON b.id = bb.booking_id AND b.client_id = bb.client_id
       INNER JOIN beds bd ON bd.id = bb.bed_id AND bd.client_id = bb.client_id
       WHERE bb.client_id = $1
         AND bd.bed_code = $2
         AND bb.booking_id <> $3
         AND bb.assignment_start_date < $5::date
         AND bb.assignment_end_date > $4::date
         AND b.status NOT IN ('cancelled', 'expired')
       ORDER BY b.booking_code`,
      [clientId, bedCode, bookingIdForOverlap, checkIn, checkOut]
    );

    for (const o of overlaps) {
      overlapConflicts.push({
        proposed_bed_code: bedCode,
        proposed_dates: { start: checkIn, end: checkOut },
        conflicting_booking_code: o.booking_code,
        conflicting_booking_bed_id: o.booking_bed_id,
        conflicting_dates: {
          start: toIsoDateString(o.assignment_start_date),
          end: toIsoDateString(o.assignment_end_date),
        },
        conflicting_booking_status: o.booking_status,
      });
    }

    wouldInsert.push({
      ...entry,
      bed_id: inv.id,
      overlap_count: overlaps.length,
    });
  }

  return {
    proposed,
    wouldInsert,
    wouldSkip,
    unknownBedCodes,
    overlapConflicts,
  };
}

async function loadPaymentsSnapshot(client, clientId, bookingId) {
  if (!bookingId) {
    return { payments: [], payment_events_count: 0 };
  }
  const { rows: paymentRows } = await client.query(
    `SELECT id, status::text AS status, payment_kind::text AS payment_kind,
            amount_due_cents, amount_paid_cents, created_at::text AS created_at
     FROM payments WHERE client_id = $1 AND booking_id = $2 ORDER BY created_at`,
    [clientId, bookingId]
  );
  const { rows: paymentEventCount } = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM payment_events pe
     INNER JOIN payments p ON p.id = pe.payment_id
     WHERE p.client_id = $1 AND p.booking_id = $2`,
    [clientId, bookingId]
  );
  return {
    payments: paymentRows,
    payment_events_count: paymentEventCount[0]?.c ?? 0,
  };
}

async function loadExistingBeds(client, clientId, bookingId, bookingCode) {
  const { rows } = await client.query(
    `SELECT
       bb.id AS booking_bed_id,
       bb.airtable_record_id,
       bb.bed_code,
       bb.room_code,
       bb.assignment_start_date::text AS assignment_start_date,
       bb.assignment_end_date::text AS assignment_end_date
     FROM booking_beds bb
     WHERE bb.client_id = $1 AND bb.booking_id = $2
     ORDER BY bb.bed_code`,
    [clientId, bookingId]
  );
  return rows.map((row) => {
    const bedCode = String(row.bed_code || '').trim().toUpperCase();
    const startIso = toIsoDateString(row.assignment_start_date);
    const endIso = toIsoDateString(row.assignment_end_date);
    return {
      booking_bed_id: row.booking_bed_id,
      airtable_record_id: row.airtable_record_id,
      bed_code: bedCode,
      room_code: row.room_code,
      assignment_start_date: startIso,
      assignment_end_date: endIso,
      natural_key: assignmentNaturalKey(bookingCode, bedCode, startIso, endIso),
    };
  });
}

function buildBookingFieldDiff(booking, parsed) {
  const fields = {};
  const candidates = [
    ['guest_name', parsed.guest_name, booking.guest_name],
    ['check_in', parsed.check_in, toIsoDateString(booking.check_in)],
    ['check_out', parsed.check_out, toIsoDateString(booking.check_out)],
    ['guest_count', parsed.guest_count, booking.guest_count],
    ['status', parsed.status, booking.status],
    ['payment_status', parsed.payment_status, booking.payment_status],
    ['package_code', parsed.package_code, booking.package_code],
  ];
  for (const [key, proposed, current] of candidates) {
    if (proposed == null || proposed === '') continue;
    if (String(proposed) !== String(current ?? '')) {
      fields[key] = { current, would_be: proposed };
    }
  }
  return fields;
}

async function loadManualEntryImpactPlan(client, input) {
  const parsed = buildParsedManualEntry(input);
  const validation = validateInput(parsed, input);

  if (validation.missing.length) {
    return {
      error: 'missing_required_fields',
      missing: validation.missing,
      parsed,
      input,
    };
  }

  if (validation.invalidDateRange) {
    return {
      error: 'invalid_date_range',
      check_in: parsed.check_in,
      check_out: parsed.check_out,
      parsed,
      input,
    };
  }

  const { rows: clientRows } = await client.query(`SELECT id FROM clients WHERE slug = $1`, [
    input.clientSlug,
  ]);
  if (!clientRows.length) {
    return { error: 'client_not_found', slug: input.clientSlug };
  }
  const clientId = clientRows[0].id;

  const bookingMatch = await lookupBooking(client, clientId, parsed);
  if (bookingMatch.error === 'booking_ambiguous') {
    return { error: 'booking_ambiguous', matches: bookingMatch.ambiguous_count, parsed, input };
  }

  const paymentsBookingId = bookingMatch.booking_id || null;
  const payments = await loadPaymentsSnapshot(client, clientId, paymentsBookingId);

  const plan = {
    clientId,
    parsed,
    input,
    bookingMatch,
    payments,
    createPhase: null,
    updatePhase: null,
    deletePhase: null,
    guestCountCheck: null,
    actionable: [...validation.actionable],
    warnings: [],
  };

  if (parsed.action === 'create') {
    const pendingCode =
      bookingMatch.found && bookingMatch.booking_code
        ? bookingMatch.booking_code
        : provisionalBookingCode(parsed.manual_entry_id);
    const overlapBookingId = bookingMatch.booking_id || PENDING_BOOKING_ID;

    const bedPlan = await loadCreateBedPlan(
      client,
      clientId,
      pendingCode,
      overlapBookingId,
      parsed.bed_codes,
      parsed.check_in,
      parsed.check_out
    );

    const hasConflict =
      bedPlan.unknownBedCodes.length > 0 || bedPlan.overlapConflicts.length > 0;
    const guestCount = parsed.guest_count;
    const guestCountMatches =
      guestCount == null ? null : bedPlan.wouldInsert.length === guestCount;

    plan.guestCountCheck = {
      guest_count: guestCount,
      proposed_bed_count: parsed.bed_codes.length,
      would_insert_count: bedPlan.wouldInsert.length,
      matches: guestCountMatches,
    };

    plan.createPhase = {
      note: 'Would INSERT bookings + booking_beds (3b.4b+); AT creates booking first in hosted flow.',
      provisional_booking_code: pendingCode,
      postgres_booking_already_exists: bookingMatch.found,
      proposed_booking: {
        booking_code_would_be:
          bookingMatch.found
            ? bookingMatch.booking_code
            : `${pendingCode} (until AT Create Booking ID automation)`,
        guest_name: parsed.guest_name,
        status: parsed.status,
        payment_status: parsed.payment_status,
        assignment_status: hasConflict ? 'needs_review' : 'assigned',
        availability_check_status: hasConflict ? 'conflict' : 'available',
        booking_source: 'manual_staff',
        check_in: parsed.check_in,
        check_out: parsed.check_out,
        guest_count: parsed.guest_count,
        package_code: parsed.package_code,
        airtable_record_id: parsed.airtable_record_id || bookingMatch.booking?.airtable_record_id || null,
      },
      proposed_beds: bedPlan.proposed,
      would_insert: bedPlan.wouldInsert,
      would_skip: bedPlan.wouldSkip,
      unknown_bed_codes: bedPlan.unknownBedCodes,
      overlap_conflicts: bedPlan.overlapConflicts,
    };

    if (bookingMatch.found) {
      plan.warnings.push('booking_already_in_postgres: create would upsert/backfill rather than fresh INSERT');
    }
    if (bedPlan.unknownBedCodes.length) plan.actionable.push('unknown_bed_codes');
    if (bedPlan.overlapConflicts.length) plan.actionable.push('postgres_overlap_conflicts');
    if (guestCountMatches === false) plan.actionable.push('guest_count_mismatch');
  }

  if (parsed.action === 'update') {
    if (!bookingMatch.found) {
      return { error: 'booking_not_found', parsed, input };
    }
    const booking = bookingMatch.booking;
    const fieldsWouldUpdate = buildBookingFieldDiff(booking, parsed);

    plan.updatePhase = {
      note: 'Hosted Manual Entries update path changes booking fields only; beds are not reassigned in MVP.',
      booking_fields_would_update: fieldsWouldUpdate,
      beds_unchanged: true,
      existing_booking_beds_count: (
        await loadExistingBeds(client, clientId, booking.id, booking.booking_code)
      ).length,
    };

    if (parsed.bed_codes.length) {
      plan.warnings.push(
        'bed_changes_not_simulated_in_3b4a: Room/Bed on update row is ignored; use Reassign or future 3b.4+'
      );
    }
    if (!Object.keys(fieldsWouldUpdate).length) {
      plan.warnings.push('no_booking_field_changes: proposed values match current Postgres booking');
    }
  }

  if (parsed.action === 'delete') {
    if (!bookingMatch.found) {
      return { error: 'booking_not_found', parsed, input };
    }
    const booking = bookingMatch.booking;
    const existingBeds = await loadExistingBeds(client, clientId, booking.id, booking.booking_code);

    plan.deletePhase = {
      note: 'Would DELETE all booking_beds and UPDATE bookings.status = cancelled (no booking DELETE).',
      postgres_booking_beds_would_delete: existingBeds,
      booking_fields_would_update: {
        status: { current: booking.status, would_be: 'cancelled' },
        payment_status: { current: booking.payment_status, would_change: false },
        assignment_status: {
          current: booking.assignment_status,
          would_be: 'needs_review',
          note: 'After bed removal; mirrors cancel-bed style',
        },
      },
    };

    if (existingBeds.length === 0) {
      plan.warnings.push('no_postgres_booking_beds: delete path would remove 0 PG bed rows');
    }
    if (booking.status === 'cancelled') {
      plan.warnings.push('booking_already_cancelled: delete may be idempotent no-op for status');
    }
  }

  return plan;
}

module.exports = {
  parseManualEntryInput,
  buildParsedManualEntry,
  deriveActionFromSyncStatus,
  loadManualEntryImpactPlan,
  parseBedList,
  provisionalBookingCode,
};
