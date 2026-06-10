'use strict';

/**
 * Stage 29c.1 — pre-proof hygiene for live/staging E2E tests.
 * Cancels unpaid holds for allowlisted test phone + date window only.
 * Reuses Stage 28f cleanup eligibility rules.
 */

const { Client } = require('pg');
const {
  CLIENT_SLUG,
  UNPAID_PAYMENT_CANCEL_STATUSES,
  assertNotProductionDb,
  assessCleanupEligibility,
  defaultConnectionString,
  parsePhoneVariants,
  redactUrl,
  trimStr,
} = require('./open-demo-playground-common');

const HOLD_LIKE_BOOKING_STATUSES = new Set([
  'hold',
  'pending',
  'unconfirmed',
  'payment_pending',
  'draft',
]);

const UNPAID_BOOKING_PAYMENT_STATUSES = new Set([
  'not_requested',
  'waiting_payment',
  'payment_link_sent',
  'failed',
  'expired',
]);

function requireAllowHygiene(context) {
  const ctx = context || {};
  if (ctx.allow_hygiene !== true && ctx.allowHygiene !== true) {
    return { ok: false, reason: 'allow_hygiene_required' };
  }
  return { ok: true };
}

function validateHygieneInput(input) {
  const src = input || {};
  const reasons = [];
  const clientSlug = trimStr(src.client_slug) || CLIENT_SLUG;
  const phone = trimStr(src.phone || src.guest_phone);
  const checkIn = trimStr(src.check_in);
  const checkOut = trimStr(src.check_out);

  if (!phone) reasons.push('phone_required');
  if (!checkIn || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) reasons.push('check_in_required_yyyy_mm_dd');
  if (!checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) reasons.push('check_out_required_yyyy_mm_dd');

  return { clientSlug, phone, checkIn, checkOut, reasons };
}

async function findMatchingBookings(pg, clientSlug, phone, checkIn, checkOut, limit = 20) {
  const { raw, e164 } = parsePhoneVariants(phone);
  const res = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.status::text AS status,
            b.payment_status::text AS payment_status, b.phone, b.check_in::text, b.check_out::text,
            b.confirmation_sent_at::text, b.amount_paid_cents, b.total_amount_cents
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND b.check_in = $2::date
        AND b.check_out = $3::date
        AND (
          b.phone IN ($4, $5, $6)
          OR REPLACE(COALESCE(b.phone, ''), '+', '') = $7
        )
      ORDER BY b.updated_at DESC
      LIMIT $8`,
    [clientSlug, checkIn, checkOut, e164, raw, phone, raw, limit],
  );
  return res.rows;
}

async function loadPayments(pg, bookingId) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, status::text, payment_kind::text,
            amount_due_cents, amount_paid_cents, stripe_checkout_session_id
       FROM payments WHERE booking_id = $1::uuid ORDER BY created_at`,
    [bookingId],
  );
  return res.rows;
}

async function loadBeds(pg, bookingId) {
  const res = await pg.query(
    `SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid ORDER BY bed_code`,
    [bookingId],
  );
  return res.rows;
}

async function applyUnpaidHoldCleanup(pg, clientId, booking, payments, beds, source) {
  const note = `[${source || 'luna_live_proof_hygiene'} ${new Date().toISOString()}] unpaid proof hold cancelled`;
  const unpaidPayments = payments.filter((p) => UNPAID_PAYMENT_CANCEL_STATUSES.includes(trimStr(p.status).toLowerCase()));

  await pg.query('BEGIN');
  try {
    const delBeds = await pg.query(
      'DELETE FROM booking_beds WHERE booking_id = $1::uuid AND client_id = $2::uuid',
      [booking.booking_id, clientId],
    );
    let paymentsCancelled = 0;
    for (const p of unpaidPayments) {
      const upd = await pg.query(
        `UPDATE payments SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1::uuid AND booking_id = $2::uuid AND status = ANY($3::payment_record_status[])`,
        [p.payment_id, booking.booking_id, UNPAID_PAYMENT_CANCEL_STATUSES],
      );
      paymentsCancelled += upd.rowCount || 0;
    }
    await pg.query(
      `UPDATE bookings
          SET status = 'cancelled',
              payment_status = CASE
                WHEN payment_status IN ('waiting_payment', 'payment_link_sent', 'not_requested') THEN 'expired'::payment_status
                ELSE payment_status
              END,
              amount_paid_cents = CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM payments px
                   WHERE px.booking_id = bookings.id AND px.status = 'paid'::payment_record_status
                ) THEN 0
                ELSE amount_paid_cents
              END,
              balance_due_cents = CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM payments px
                   WHERE px.booking_id = bookings.id AND px.status = 'paid'::payment_record_status
                ) THEN total_amount_cents
                ELSE balance_due_cents
              END,
              staff_notes = TRIM(BOTH FROM COALESCE(staff_notes, '') || E'\\n' || $3),
              updated_at = NOW()
        WHERE id = $1::uuid AND client_id = $2::uuid`,
      [booking.booking_id, clientId, note],
    );
    await pg.query('COMMIT');
    return {
      beds_released: delBeds.rowCount || 0,
      payments_cancelled: paymentsCancelled,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * @param {{ client_slug?: string, phone?: string, guest_phone?: string, check_in: string, check_out: string, limit?: number, source?: string }} input
 * @param {{ allow_hygiene?: boolean, allowHygiene?: boolean, confirm_hygiene?: boolean, confirmHygiene?: boolean, dry_run?: boolean, db_url?: string, pg?: object }} context
 */
async function runLiveProofHygiene(input, context) {
  const ctx = context || {};
  const summary = {
    success: false,
    found_unpaid_holds: 0,
    archived_or_cancelled: 0,
    skipped_paid_or_confirmed: 0,
    skipped_not_hold_like: 0,
    dry_run: ctx.dry_run !== false && ctx.confirm_hygiene !== true && ctx.confirmHygiene !== true,
    refused_reason: null,
    bookings_found: [],
    actions: [],
    skipped: [],
  };

  const allow = requireAllowHygiene(ctx);
  if (!allow.ok) {
    summary.refused_reason = allow.reason;
    return summary;
  }

  const dbUrl = trimStr(ctx.db_url) || defaultConnectionString();
  try {
    assertNotProductionDb(dbUrl);
  } catch (e) {
    summary.refused_reason = e.message;
    return summary;
  }

  const validated = validateHygieneInput(input);
  if (validated.reasons.length) {
    summary.refused_reason = validated.reasons.join('; ');
    return summary;
  }

  const run = async (pg) => {
    const clientRes = await pg.query('SELECT id::text FROM clients WHERE slug = $1', [validated.clientSlug]);
    const clientId = clientRes.rows[0]?.id;
    if (!clientId) {
      summary.refused_reason = `client_not_found:${validated.clientSlug}`;
      return summary;
    }

    const bookings = await findMatchingBookings(
      pg, validated.clientSlug, validated.phone, validated.checkIn, validated.checkOut, input.limit || 20,
    );
    summary.bookings_found = bookings.map((b) => ({
      booking_code: b.booking_code,
      booking_id: b.booking_id,
      status: b.status,
      payment_status: b.payment_status,
    }));

    for (const booking of bookings) {
      const payments = await loadPayments(pg, booking.booking_id);
      const beds = await loadBeds(pg, booking.booking_id);
      const eligibility = assessCleanupEligibility(booking, payments, { allowPaid: false });

      if (!eligibility.eligible) {
        summary.skipped_paid_or_confirmed += 1;
        summary.skipped.push({
          booking_code: booking.booking_code,
          reasons: eligibility.reasons,
        });
        continue;
      }

      const holdLike = HOLD_LIKE_BOOKING_STATUSES.has(trimStr(booking.status).toLowerCase())
        || UNPAID_BOOKING_PAYMENT_STATUSES.has(trimStr(booking.payment_status).toLowerCase());
      if (!holdLike) {
        summary.skipped_not_hold_like += 1;
        summary.skipped.push({
          booking_code: booking.booking_code,
          reasons: [`booking_not_hold_like:${booking.status}/${booking.payment_status}`],
        });
        continue;
      }

      summary.found_unpaid_holds += 1;
      const action = {
        booking_code: booking.booking_code,
        booking_id: booking.booking_id,
        beds_before: beds,
        payments_before: payments,
        mode: summary.dry_run ? 'dry_run' : 'cancelled',
      };

      if (summary.dry_run) {
        summary.actions.push(action);
        continue;
      }

      const result = await applyUnpaidHoldCleanup(
        pg, clientId, booking, payments, beds, input.source,
      );
      summary.archived_or_cancelled += 1;
      summary.actions.push({ ...action, result });
    }

    summary.success = true;
    return summary;
  };

  if (ctx.pg && typeof ctx.pg.query === 'function') {
    return run(ctx.pg);
  }

  const pg = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('azure') ? { rejectUnauthorized: false } : undefined,
  });
  await pg.connect();
  try {
    return await run(pg);
  } finally {
    await pg.end();
  }
}

function liveProofHygieneGuidanceLines() {
  return [
    'Live proof hygiene: use a unique future date window per run, or pass --preclean-unpaid-holds with --allow-writes before reusing the same phone + dates.',
    'Prefer unique synthetic test phones when possible; allowlisted staging phones require hygiene before repeat E2E.',
  ];
}

module.exports = {
  runLiveProofHygiene,
  requireAllowHygiene,
  validateHygieneInput,
  findMatchingBookings,
  liveProofHygieneGuidanceLines,
  HOLD_LIKE_BOOKING_STATUSES,
  UNPAID_BOOKING_PAYMENT_STATUSES,
};
