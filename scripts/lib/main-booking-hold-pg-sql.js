/**
 * Phase 3c.c — Main booking hold (read-only guards + future mutation SQL names).
 * No INSERT/UPDATE/DELETE in 3c.c.1 — SELECT-only guards.
 */
const { toIsoDateString } = require('./bed-drift-keys');

const NULL_SENTINEL = '__NULL__';

/** Active guest holds — align with Main Search Active Booking / resolver. */
const ACTIVE_HOLD_STATUSES = ['hold', 'payment_pending'];

/** Execute path: Main Create Booking Hold (no guest email/name) — not payment_pending promote. */
const EXECUTE_HOLD_STATUSES = {
  status: 'hold',
  payment_status: 'not_requested',
  assignment_status: 'unassigned',
  availability_check_status: 'available',
};

const FUTURE_SQL = {
  PROMOTE_TO_PAYMENT_PENDING: 'TODO_3c.c.4: Ensure Booking / guest-details promote',
  BACKFILL_AIRTABLE_RECORD_ID: 'TODO_3c.e: UPDATE bookings SET airtable_record_id=$rec WHERE booking_code=$code',
};

function parseHoldInput(raw = {}) {
  const checkIn = toIsoDateString(raw.check_in ?? raw.checkIn);
  const checkOut = toIsoDateString(raw.check_out ?? raw.checkOut);
  const guestCount = Math.max(1, Number(raw.guest_count ?? raw.guestCount ?? 1) || 1);
  const guestName = String(raw.guest_name ?? raw.guestName ?? '').trim();
  const email = String(raw.email ?? '').trim();
  const phone = String(raw.phone ?? '').trim();

  return {
    client_slug: String(raw.client_slug ?? raw.clientSlug ?? 'wolfhouse-somo').trim(),
    booking_code: String(raw.booking_code ?? raw.bookingCode ?? '').trim(),
    phone: phone || null,
    guest_name: guestName || null,
    email: email || null,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    room_type: String(raw.room_type ?? raw.roomType ?? 'shared').trim(),
    room_preference: String(raw.room_preference ?? raw.roomPreference ?? raw.room_type ?? 'shared').trim(),
    guest_gender_group_type: String(
      raw.guest_gender_group_type ?? raw.guestGenderGroupType ?? 'unknown'
    ).trim(),
    primary_room_code: String(raw.primary_room_code ?? raw.primaryRoomCode ?? '').trim() || null,
    package_code: String(raw.package_code ?? raw.packageCode ?? '').trim() || null,
    notes: String(raw.notes ?? '').trim() || null,
    has_guest_details: !!(guestName && email),
  };
}

function proposeHoldExpiresAt(now = new Date()) {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}

function proposeStatuses(holdInput) {
  if (holdInput.has_guest_details) {
    return {
      proposed_status: 'payment_pending',
      proposed_payment_status: 'waiting_payment',
      proposed_assignment_status: 'unassigned',
      proposed_availability_check_status: 'available',
      status_reason: 'has_guest_details: mirrors AT Payment_Pending / waiting_payment',
    };
  }
  return {
    proposed_status: 'hold',
    proposed_payment_status: 'not_requested',
    proposed_assignment_status: 'unassigned',
    proposed_availability_check_status: 'available',
    status_reason: 'hold_only: mirrors AT Hold / not_requested',
  };
}

/**
 * @param {import('pg').Client} client
 * @param {string} clientSlug
 */
async function resolveClientId(client, clientSlug) {
  const { rows } = await client.query(`SELECT id, slug FROM clients WHERE slug = $1`, [clientSlug]);
  if (!rows.length) return { error: 'client_not_found', client_slug: clientSlug };
  return { client_id: rows[0].id, client_slug: rows[0].slug };
}

/**
 * SELECT active holds for phone overlapping proposed dates.
 * @param {import('pg').Client} client
 */
async function selectActiveHoldGuard(client, clientId, holdInput) {
  if (!holdInput.phone) {
    return {
      checked: false,
      skipped_reason: 'no_phone_provided',
      blocking: false,
      matches: [],
    };
  }

  const { rows } = await client.query(
    `SELECT
       id::text AS booking_id,
       booking_code,
       phone,
       status::text AS status,
       payment_status::text AS payment_status,
       check_in::text AS check_in,
       check_out::text AS check_out,
       hold_expires_at,
       airtable_record_id
     FROM bookings
     WHERE client_id = $1
       AND phone = $2
       AND status::text = ANY($3::text[])
       AND check_in < $5::date
       AND check_out > $4::date
     ORDER BY created_at DESC`,
    [
      clientId,
      holdInput.phone,
      ACTIVE_HOLD_STATUSES,
      holdInput.check_in,
      holdInput.check_out,
    ]
  );

  const otherHolds = rows.filter((r) => r.booking_code !== holdInput.booking_code);
  const sameCode = rows.find((r) => r.booking_code === holdInput.booking_code);

  return {
    checked: true,
    phone: holdInput.phone,
    statuses_considered: ACTIVE_HOLD_STATUSES,
    date_overlap_rule: 'check_in < proposed_check_out AND check_out > proposed_check_in',
    blocking: otherHolds.length > 0,
    matches: rows,
    other_active_holds: otherHolds,
    same_booking_code_match: sameCode || null,
    would_block_new_hold: otherHolds.length > 0,
    action_if_blocking: 'active_hold_exists_for_phone: skip or return existing hold',
  };
}

/**
 * SELECT booking by booking_code.
 * @param {import('pg').Client} client
 */
async function selectBookingCodeGuard(client, clientId, bookingCode) {
  const { rows } = await client.query(
    `SELECT
       id::text AS booking_id,
       booking_code,
       phone,
       guest_name,
       email,
       status::text AS status,
       payment_status::text AS payment_status,
       assignment_status::text AS assignment_status,
       availability_check_status::text AS availability_check_status,
       check_in::text AS check_in,
       check_out::text AS check_out,
       hold_expires_at,
       airtable_record_id,
       primary_room_code,
       guest_count,
       send_confirmation
     FROM bookings
     WHERE client_id = $1 AND booking_code = $2
     LIMIT 2`,
    [clientId, bookingCode]
  );

  if (rows.length > 1) {
    return { error: 'booking_code_ambiguous', booking_code: bookingCode, matches: rows.length };
  }

  const existing = rows[0] || null;
  return {
    booking_code: bookingCode,
    exists: !!existing,
    existing,
  };
}

function classifyBookingCodeAction(codeGuard, holdInput, statusProposal) {
  if (!codeGuard.exists) {
    return {
      action: 'would_insert',
      note: 'No row with this booking_code; execute phase would INSERT',
    };
  }

  const ex = codeGuard.existing;
  const terminal = ['cancelled', 'expired', 'confirmed', 'checked_in'].includes(ex.status);

  if (terminal) {
    return {
      action: 'would_conflict',
      note: `Existing booking status=${ex.status}; new hold on same code is unsafe`,
    };
  }

  if (holdInput.phone && ex.phone && ex.phone !== holdInput.phone) {
    return {
      action: 'would_conflict',
      note: 'booking_code exists for a different phone',
    };
  }

  const isPromote =
    ex.status === 'hold' &&
    statusProposal.proposed_status === 'payment_pending' &&
    holdInput.has_guest_details;

  if (ex.status === 'payment_pending' || isPromote) {
    return {
      action: isPromote ? 'would_promote' : 'would_update',
      note: isPromote
        ? 'Would UPDATE hold → payment_pending (guest details on hold)'
        : 'Would UPDATE existing row fields (idempotent refresh)',
      would_downgrade: false,
    };
  }

  if (ex.status === 'hold') {
    return {
      action: 'would_update',
      note: 'Would UPDATE existing hold row (dates, room, guest fields)',
      would_downgrade: false,
    };
  }

  return {
    action: 'would_update',
    note: `Would UPDATE existing status=${ex.status} (review manually)`,
    would_downgrade: false,
  };
}

function buildExecuteMetadata(holdInput, extra = {}) {
  return {
    source: 'phase3c_hold_cli',
    booking_code: holdInput.booking_code,
    session: {
      check_in: holdInput.check_in,
      check_out: holdInput.check_out,
      guest_count: holdInput.guest_count,
      room_type: holdInput.room_type,
      room_preference: holdInput.room_preference,
      guest_gender_group_type: holdInput.guest_gender_group_type,
    },
    notes: holdInput.notes,
    ...extra,
  };
}

/**
 * Upsert one bookings row (hold). No booking_beds. No payments.
 * @param {import('pg').Client} client
 * @param {string} clientId
 * @param {ReturnType<typeof parseHoldInput>} holdInput
 * @param {object} wouldUpsert from plan
 */
async function upsertBookingHold(client, clientId, holdInput, wouldUpsert) {
  const meta = buildExecuteMetadata(holdInput, { executed_at: new Date().toISOString() });
  const { rows: before } = await client.query(
    `SELECT id::text AS booking_id FROM bookings WHERE client_id = $1 AND booking_code = $2`,
    [clientId, holdInput.booking_code]
  );
  const existedBefore = before.length > 0;

  const { rows } = await client.query(
    `INSERT INTO bookings (
       client_id,
       booking_code,
       airtable_record_id,
       guest_name,
       phone,
       email,
       status,
       payment_status,
       assignment_status,
       availability_check_status,
       check_in,
       check_out,
       guest_count,
       requested_room_type,
       room_preference,
       guest_gender_group_type,
       primary_room_code,
       package_code,
       booking_source,
       hold_expires_at,
       send_confirmation,
       metadata
     ) VALUES (
       $1, $2, NULL, $3, $4, $5,
       $6::booking_status, $7::payment_status, $8::assignment_status, $9::availability_check_status,
       $10::date, $11::date, $12,
       $13, $14, $15, $16, $17,
       'whatsapp'::booking_source,
       $18::timestamptz, FALSE, $19::jsonb
     )
     ON CONFLICT (client_id, booking_code) DO UPDATE SET
       guest_name = COALESCE(EXCLUDED.guest_name, bookings.guest_name),
       phone = COALESCE(EXCLUDED.phone, bookings.phone),
       email = COALESCE(EXCLUDED.email, bookings.email),
       check_in = EXCLUDED.check_in,
       check_out = EXCLUDED.check_out,
       guest_count = EXCLUDED.guest_count,
       requested_room_type = EXCLUDED.requested_room_type,
       room_preference = EXCLUDED.room_preference,
       guest_gender_group_type = EXCLUDED.guest_gender_group_type,
       primary_room_code = COALESCE(EXCLUDED.primary_room_code, bookings.primary_room_code),
       package_code = COALESCE(EXCLUDED.package_code, bookings.package_code),
       hold_expires_at = EXCLUDED.hold_expires_at,
       assignment_status = EXCLUDED.assignment_status,
       availability_check_status = EXCLUDED.availability_check_status,
       status = CASE
         WHEN bookings.status IN ('payment_pending', 'confirmed', 'checked_in', 'needs_review', 'blocked')
           THEN bookings.status
         ELSE EXCLUDED.status
       END,
       payment_status = CASE
         WHEN bookings.payment_status IN ('waiting_payment', 'deposit_paid', 'paid')
           THEN bookings.payment_status
         ELSE EXCLUDED.payment_status
       END,
       metadata = bookings.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING
       id::text AS booking_id,
       booking_code,
       status::text AS status,
       payment_status::text AS payment_status,
       assignment_status::text AS assignment_status,
       availability_check_status::text AS availability_check_status,
       airtable_record_id,
       primary_room_code`,
    [
      clientId,
      holdInput.booking_code,
      wouldUpsert.guest_name,
      wouldUpsert.phone,
      wouldUpsert.email,
      EXECUTE_HOLD_STATUSES.status,
      EXECUTE_HOLD_STATUSES.payment_status,
      EXECUTE_HOLD_STATUSES.assignment_status,
      EXECUTE_HOLD_STATUSES.availability_check_status,
      wouldUpsert.check_in,
      wouldUpsert.check_out,
      wouldUpsert.guest_count,
      wouldUpsert.requested_room_type,
      wouldUpsert.room_preference,
      wouldUpsert.guest_gender_group_type,
      wouldUpsert.primary_room_code,
      wouldUpsert.package_code,
      wouldUpsert.hold_expires_at,
      JSON.stringify(meta),
    ]
  );

  return {
    created: !existedBefore,
    updated: existedBefore,
    booking: rows[0],
  };
}

module.exports = {
  NULL_SENTINEL,
  ACTIVE_HOLD_STATUSES,
  EXECUTE_HOLD_STATUSES,
  FUTURE_SQL,
  parseHoldInput,
  proposeHoldExpiresAt,
  proposeStatuses,
  resolveClientId,
  selectActiveHoldGuard,
  selectBookingCodeGuard,
  classifyBookingCodeAction,
  buildExecuteMetadata,
  upsertBookingHold,
};
