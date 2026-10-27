'use strict';

const crypto = require('crypto');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE_STATUSES = new Set(['confirmed', 'hold', 'payment_pending', 'needs_review', 'checked_in']);

const BOOKING_SQL = `SELECT b.id::text AS booking_id, b.booking_code, b.client_id::text AS client_id,
  c.slug AS client_slug, b.phone AS guest_phone, b.check_in::text, b.check_out::text,
  COALESCE(b.guest_count, 1)::int AS guest_count, b.package_code, b.requested_room_type,
  b.room_preference, b.metadata, b.status,
  b.total_amount_cents, b.deposit_required_cents,
  COALESCE(b.amount_paid_cents, 0)::int AS amount_paid_cents, b.balance_due_cents
FROM bookings b JOIN clients c ON c.id=b.client_id
WHERE c.slug=$1 AND b.booking_code=$2
FOR UPDATE OF b`;
const ASSIGNMENTS_SQL = `SELECT bb.id::text AS booking_bed_id, bb.bed_id::text AS bed_id,
  bb.bed_code, bb.room_code
FROM booking_beds bb LEFT JOIN beds ON beds.id=bb.bed_id
WHERE bb.client_id=$1::uuid AND bb.booking_id=$2::uuid
ORDER BY bb.id FOR UPDATE OF bb`;
const CONFLICTS_SQL = `SELECT bb.booking_id::text AS conflicting_booking_id, bb.bed_code,
  bb.assignment_start_date::text AS check_in, bb.assignment_end_date::text AS check_out
FROM booking_beds bb JOIN bookings other ON other.id=bb.booking_id
WHERE bb.client_id=$1::uuid AND bb.booking_id <> $2::uuid
  AND bb.bed_code = ANY($3::text[])
  AND bb.assignment_start_date < $5::date AND bb.assignment_end_date > $4::date
  AND lower(other.status::text) NOT IN ('cancelled','canceled','expired')`;
const UPDATE_BOOKING_SQL = `UPDATE bookings SET check_in=$3::date, check_out=$4::date,
  total_amount_cents=$5::int, deposit_required_cents=$6::int,
  balance_due_cents=$7::int,
  metadata=COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('quote_snapshot', $8::jsonb),
  updated_at=NOW()
WHERE client_id=$1::uuid AND id=$2::uuid
RETURNING id::text AS booking_id, booking_code, check_in::text, check_out::text, status,
  total_amount_cents, deposit_required_cents, amount_paid_cents, balance_due_cents`;
const UPDATE_ASSIGNMENTS_SQL = `UPDATE booking_beds SET assignment_start_date=$3::date,
  assignment_end_date=$4::date, updated_at=NOW()
WHERE client_id=$1::uuid AND booking_id=$2::uuid
RETURNING id::text AS booking_bed_id, bed_code,
  assignment_start_date::text AS check_in, assignment_end_date::text AS check_out`;

function clean(value) { return String(value == null ? '' : value).trim(); }
function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch (_) { return {}; }
}
function savedQuoteSelection(booking) {
  const metadata = object(booking.metadata);
  const snapshot = object(metadata.quote_snapshot);
  const guestPackages = Array.isArray(snapshot.guest_packages) ? snapshot.guest_packages : [];
  const accommodationCodes = new Set(['package', 'package_proration', 'accommodation_only', 'manual_accommodation',
    'guest_package', 'guest_package_proration', 'guest_accommodation_only', 'room_supplement']);
  const addOns = (Array.isArray(snapshot.line_items) ? snapshot.line_items : [])
    .filter((line) => line && !accommodationCodes.has(clean(line.code)))
    .map((line) => ({
      code: clean(line.code).startsWith('surf_lesson_') ? 'surf_lesson' : clean(line.code),
      quantity: Math.max(1, Number(line.quantity) || 1),
    }));
  const storedRoom = clean(booking.requested_room_type).toLowerCase();
  const privateSaved = clean(snapshot.room_type).toLowerCase() === 'private'
    || /(?:couple_private|private_room|private|double|matrimonial)/i.test(clean(booking.room_preference))
    || metadata.private_room_enabled === true
    || (Array.isArray(snapshot.line_items) && snapshot.line_items.some((line) => (
      line && line.code === 'room_supplement' && Number(line.total_cents) > 0
    )));
  return {
    guest_packages: guestPackages.length ? guestPackages : undefined,
    add_ons: addOns,
    room_type: privateSaved ? 'private' : (['shared', 'private'].includes(storedRoom) ? storedRoom : clean(snapshot.room_type) || 'shared'),
  };
}
function phone(value) { const digits = clean(value).replace(/\D/g, ''); return digits ? `+${digits}` : ''; }
function validDate(value) {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function b64(value) { return Buffer.from(value).toString('base64url'); }
function signature(secret, payload) { return crypto.createHmac('sha256', secret).update(payload).digest('base64url'); }
function makeToken(secret, claims) {
  const payload = b64(JSON.stringify(stable(claims)));
  return `${payload}.${signature(secret, payload)}`;
}
function readToken(secret, token) {
  const [payload, supplied, extra] = clean(token).split('.');
  if (!payload || !supplied || extra) return null;
  const expected = signature(secret, payload);
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return null; }
}
function fail(reason_code, extra = {}) {
  return { success: false, write_performed: false, reason_code, staff_review_needed: false, ...extra };
}
function normalizeInput(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    client_slug: clean(input.client_slug), booking_code: clean(input.booking_code),
    guest_phone: phone(input.guest_phone), new_check_in: clean(input.new_check_in),
    new_check_out: clean(input.new_check_out), quote_token: clean(input.quote_token),
  };
}
function validate(input) {
  if (!input.client_slug) return 'client_slug_required';
  if (!input.booking_code) return 'booking_code_required';
  if (!input.guest_phone) return 'guest_phone_required';
  if (!validDate(input.new_check_in) || !validDate(input.new_check_out) || input.new_check_out <= input.new_check_in) return 'invalid_new_dates';
  return null;
}

function createWolfhouseDateChangeService(options = {}) {
  if (typeof options.withPgClient !== 'function') throw new TypeError('withPgClient_required');
  if (typeof options.quoteNewDates !== 'function') throw new TypeError('quoteNewDates_required');
  const secret = clean(options.tokenSecret || process.env.LUNA_DATE_CHANGE_TOKEN_SECRET || process.env.LUNA_BOT_INTERNAL_TOKEN);
  if (secret.length < 32) throw new TypeError('date_change_token_secret_required');
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  async function inspect(pg, input) {
    const bookingResult = await pg.query(BOOKING_SQL, [input.client_slug, input.booking_code]);
    const booking = bookingResult.rows[0];
    if (!booking) return fail('booking_not_found');
    if (!ACTIVE_STATUSES.has(clean(booking.status).toLowerCase())) return fail('booking_not_editable');
    if (phone(booking.guest_phone) !== input.guest_phone) return fail('booking_owner_mismatch');
    const assignmentResult = await pg.query(ASSIGNMENTS_SQL, [booking.client_id, booking.booking_id]);
    const assignments = assignmentResult.rows;
    if (!assignments.length || assignments.some((row) => !clean(row.bed_code))) return fail('booking_assignments_unavailable');
    const bedCodes = assignments.map((row) => clean(row.bed_code));
    const conflictResult = await pg.query(CONFLICTS_SQL, [booking.client_id, booking.booking_id, bedCodes, input.new_check_in, input.new_check_out]);
    if (conflictResult.rows.length) return fail('new_dates_unavailable', { conflicts: conflictResult.rows });
    const selection = savedQuoteSelection(booking);
    const quote = await options.quoteNewDates({
      client_slug: input.client_slug, booking_id: booking.booking_id, booking_code: booking.booking_code,
      exclude_booking_id: booking.booking_id, check_in: input.new_check_in, check_out: input.new_check_out,
      guest_count: Number(booking.guest_count), selected_bed_codes: bedCodes,
      package_code: clean(booking.package_code) || 'accommodation_only',
      guest_packages: selection.guest_packages,
      add_ons: selection.add_ons,
      room_type: selection.room_type,
    });
    if (!quote || quote.success !== true) return fail('date_change_quote_failed', { quote: quote || null, staff_review_needed: true });
    const totalCents = Number(quote.total_cents);
    const depositCents = Number(quote.deposit_cents);
    if (!Number.isSafeInteger(totalCents) || totalCents < 0
        || !Number.isSafeInteger(depositCents) || depositCents < 0 || depositCents > totalCents) {
      return fail('date_change_quote_failed', { quote, staff_review_needed: true });
    }
    const quoteFacts = { quote_id: quote.quote_id || null, total_cents: totalCents, currency: quote.currency || null, deposit_cents: depositCents };
    return { success: true, booking, assignments, bedCodes, quote, quoteFacts };
  }

  async function quote(raw) {
    const input = normalizeInput(raw); const reason = validate(input); if (reason) return fail(reason);
    return options.withPgClient(async (pg) => {
      await pg.query('BEGIN');
      try {
        const checked = await inspect(pg, input);
        await pg.query('ROLLBACK');
        if (!checked.success) return checked;
        const claims = { v: 1, client_slug: input.client_slug, booking_id: checked.booking.booking_id,
          booking_code: checked.booking.booking_code, guest_phone: input.guest_phone,
          new_check_in: input.new_check_in, new_check_out: input.new_check_out,
          bed_codes: checked.bedCodes, quote: checked.quoteFacts, issued_at: now().toISOString() };
        return { success: true, can_move: true, write_performed: false, booking_code: checked.booking.booking_code,
          current_stay: { check_in: checked.booking.check_in, check_out: checked.booking.check_out },
          proposed_stay: { check_in: input.new_check_in, check_out: input.new_check_out },
          quote: checked.quote, quote_token: makeToken(secret, claims), requires_guest_acceptance: true };
      } catch (error) { try { await pg.query('ROLLBACK'); } catch (_) {} throw error; }
    });
  }

  async function move(raw) {
    const input = normalizeInput(raw); const reason = validate(input); if (reason) return fail(reason);
    const claims = readToken(secret, input.quote_token);
    if (!claims || claims.client_slug !== input.client_slug || claims.booking_code !== input.booking_code || claims.guest_phone !== input.guest_phone || claims.new_check_in !== input.new_check_in || claims.new_check_out !== input.new_check_out) return fail('date_change_quote_required');
    return options.withPgClient(async (pg) => {
      await pg.query('BEGIN');
      try {
        const checked = await inspect(pg, input);
        if (!checked.success) { await pg.query('ROLLBACK'); return checked; }
        if (checked.booking.booking_id !== claims.booking_id || JSON.stringify(checked.bedCodes) !== JSON.stringify(claims.bed_codes) || JSON.stringify(stable(checked.quoteFacts)) !== JSON.stringify(stable(claims.quote))) {
          await pg.query('ROLLBACK'); return fail('date_change_terms_changed', { requires_new_quote: true, quote: checked.quote });
        }
        const balanceCents = Math.max(checked.quoteFacts.total_cents - Number(checked.booking.amount_paid_cents || 0), 0);
        const updated = await pg.query(UPDATE_BOOKING_SQL, [
          checked.booking.client_id, checked.booking.booking_id, input.new_check_in, input.new_check_out,
          checked.quoteFacts.total_cents, checked.quoteFacts.deposit_cents, balanceCents,
          JSON.stringify(checked.quote),
        ]);
        const assignments = await pg.query(UPDATE_ASSIGNMENTS_SQL, [checked.booking.client_id, checked.booking.booking_id, input.new_check_in, input.new_check_out]);
        await pg.query('COMMIT');
        return { success: true, write_performed: true, moved_same_booking: true,
          booking: updated.rows[0], assignments: assignments.rows, quote: checked.quote };
      } catch (error) { try { await pg.query('ROLLBACK'); } catch (_) {} throw error; }
    });
  }
  return { quote, move };
}

async function routeWolfhouseDateChangeRequest(req, res, deps = {}) {
  const path = new URL(req.url, 'http://localhost').pathname;
  const action = path === '/staff/bot/bookings/date-change-quote' ? 'quote'
    : path === '/staff/bot/bookings/date-change' ? 'move' : null;
  if (!action) return false;
  if (req.method !== 'POST') { deps.sendJSON(res, 405, { success: false, error: 'method_not_allowed' }); return true; }
  let body;
  try { body = JSON.parse((await deps.readBody(req)) || '{}'); }
  catch (_) { deps.sendJSON(res, 400, { success: false, error: 'invalid_json' }); return true; }
  const trustedGuestPhone = phone(deps.trustedGuestPhone);
  const requestedGuestPhone = phone(body && body.guest_phone);
  if (!trustedGuestPhone) {
    deps.sendJSON(res, 409, fail('invalid_guest_phone'));
    return true;
  }
  if (requestedGuestPhone && requestedGuestPhone !== trustedGuestPhone) {
    deps.sendJSON(res, 409, fail('booking_owner_mismatch'));
    return true;
  }
  body = { ...body, client_slug: deps.trustedClientSlug, guest_phone: trustedGuestPhone };
  const result = await deps.service[action](body);
  deps.sendJSON(res, result.success ? 200 : (result.reason_code === 'booking_not_found' ? 404 : 409), result);
  return true;
}

module.exports = { createWolfhouseDateChangeService, routeWolfhouseDateChangeRequest,
  BOOKING_SQL, ASSIGNMENTS_SQL, CONFLICTS_SQL, UPDATE_BOOKING_SQL, UPDATE_ASSIGNMENTS_SQL };
