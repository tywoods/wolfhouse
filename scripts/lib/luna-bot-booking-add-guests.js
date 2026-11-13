'use strict';

const { addGuestToBooking, normalizeNewGuestNames } = require('./luna-guest-addguest-attach');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * POST /staff/bot/booking-add-guests
 * Authenticated classic Luna bot: add occupant(s) to an existing booking.
 * Does not create payment links. Caller asks deposit/full then uses create_guest_payment_link once.
 */
async function handleBotBookingAddGuests(req, res, user, authMode, ctx) {
  const { sendJSON, send400, readBody, withPgClient, DEFAULT_CLIENT } = ctx;

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug = trimStr(
    (ctx.boundClientSlug != null && trimStr(ctx.boundClientSlug))
      || body.client_slug
      || DEFAULT_CLIENT
      || 'wolfhouse-somo',
  );
  const bookingId = trimStr(body.booking_id);
  const bookingCode = trimStr(body.booking_code);
  const names = normalizeNewGuestNames(body.new_guest_names || body.guest_names || body.guest_name);
  if (!bookingId && !bookingCode) return send400(res, 'booking_id or booking_code is required');
  if (!names.length) return send400(res, 'new_guest_names is required');

  const senderPhone = trimStr(
    (req.headers && (req.headers['x-luna-guest-phone'] || req.headers['X-Luna-Guest-Phone']))
    || body.phone
    || '',
  );

  try {
    const result = await withPgClient(async (pg) => {
      if (senderPhone) {
        const owned = await pg.query(
          `SELECT b.id::text AS booking_id, b.phone
             FROM bookings b
             JOIN clients c ON c.id = b.client_id
            WHERE c.slug = $1
              AND ($2::text IS NULL OR b.id::text = $2)
              AND ($3::text = '' OR UPPER(b.booking_code) = UPPER($3))
            LIMIT 1`,
          [clientSlug, bookingId || null, bookingCode],
        );
        const row = owned.rows[0];
        if (row && row.phone && digits(row.phone) && digits(row.phone) !== digits(senderPhone)) {
          return { status: 'forbidden', reason: 'booking_not_owned_by_sender' };
        }
      }
      return addGuestToBooking(pg, {
        classicBot: true,
        clientSlug,
        bookingId,
        bookingCode,
        newGuestNames: names,
        writeSource: 'classic_luna_add_guests_to_booking',
      });
    });

    if (result && result.status === 'forbidden') {
      return sendJSON(res, 403, { success: false, error: result.reason, staff_review_needed: true });
    }
    if (result && result.status === 'no_availability') {
      return sendJSON(res, 200, {
        success: false,
        tool: 'add_guests_to_booking',
        error: result.reason,
        status: result.status,
        booking_id: result.booking_id,
        booking_code: result.booking_code,
        staff_review_needed: true,
        handoff_reason: result.handoff_reason || 'no_bed_for_added_guest',
        write_performed: false,
        next_action: 'flag_needs_human',
      });
    }
    if (result && result.status === 'ok') {
      const added = (result.inserted_booking_guests || [])[0] || {};
      return sendJSON(res, 200, {
        success: true,
        tool: 'add_guests_to_booking',
        write_performed: result.write_performed !== false,
        already_added: result.already_added === true,
        booking_id: result.booking_id,
        booking_code: result.booking_code,
        new_guest_count: result.new_guest_count,
        invoice_total_cents: result.new_total_amount_cents,
        balance_due_cents: result.new_balance_due_cents,
        price_needs_staff_review: result.price_needs_staff_review === true,
        inserted_booking_guests: result.inserted_booking_guests,
        added_booking_guest_id: added.booking_guest_id,
        added_guest_name: added.guest_name,
        added_guest_number: added.guest_number,
        assigned_bed_code: added.assigned_bed_code,
        assigned_room_code: added.assigned_room_code,
        bed_label: added.bed_label,
        ask_deposit_or_full: true,
        next_action: 'ask_deposit_or_full_then_one_guest_payment_link',
        staff_review_needed: false,
      });
    }
    return sendJSON(res, 200, {
      success: false,
      tool: 'add_guests_to_booking',
      error: (result && result.reason) || 'add_guest_failed',
      status: result && result.status,
      staff_review_needed: true,
      write_performed: false,
    });
  } catch (err) {
    return sendJSON(res, 500, {
      success: false,
      error: err && err.message ? String(err.message) : 'add_guest_failed',
      staff_review_needed: true,
    });
  }
}

module.exports = {
  handleBotBookingAddGuests,
};
