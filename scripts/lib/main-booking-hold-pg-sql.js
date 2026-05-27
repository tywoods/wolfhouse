/**
 * Phase 3c.c — Main booking hold (read-only guards + future mutation SQL names).
 * No INSERT/UPDATE/DELETE in 3c.c.1 — SELECT-only guards.
 */
const { toIsoDateString } = require('./bed-drift-keys');

const NULL_SENTINEL = '__NULL__';

/** Active guest holds — align with Main Search Active Booking / resolver. */
const ACTIVE_HOLD_STATUSES = ['hold', 'payment_pending'];

/**
 * Future 3c.c execute — hold upsert (not used in 3c.c.1).
 * @see build-main-local-stripe.js ensureBookingSql for promote pattern
 */
const FUTURE_SQL = {
  UPSERT_BOOKING_HOLD: 'TODO_3c.c.2: INSERT ... ON CONFLICT (client_id, booking_code) DO UPDATE',
  PROMOTE_TO_PAYMENT_PENDING: 'TODO_3c.c.2: UPDATE bookings SET status=payment_pending ...',
  BACKFILL_AIRTABLE_RECORD_ID: 'TODO_3c.e: UPDATE bookings SET airtable_record_id=$rec WHERE booking_code=$code',
  ENSURE_BOOKING_PROMOTE: 'TODO_3c.c.4: shared with Postgres - Ensure Booking In Postgres',
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

module.exports = {
  NULL_SENTINEL,
  ACTIVE_HOLD_STATUSES,
  FUTURE_SQL,
  parseHoldInput,
  proposeHoldExpiresAt,
  proposeStatuses,
  resolveClientId,
  selectActiveHoldGuard,
  selectBookingCodeGuard,
  classifyBookingCodeAction,
};
