'use strict';

/**
 * Idempotent hold-expiry worker (WB-4).
 *
 * Expires overdue unpaid booking holds: status hold → expired, releases beds,
 * and makes unpaid payment links non-actionable (clear checkout_url + invalidate
 * metadata) without changing eligible unpaid payment status. Preserves
 * stripe_checkout_session_id so a late signed Stripe event can still resolve
 * and record money via stripe-hold-promote-policy while booking stays expired.
 * No messaging. Tenant-scoped on every mutation.
 */

const {
  buildBookingMetadataInvalidationPatch,
} = require('./luna-front-desk-payment-link-service');

const HOLD_EXPIRY_WORKER_SOURCE = 'booking_hold_expiry_worker';
const HOLD_EXPIRED_BY_WORKER_META_KEY = 'hold_expired_by_worker';

const PAID_BOOKING_PAYMENT_STATUSES = new Set(['deposit_paid', 'paid']);
/** Unpaid link ledger statuses that become non-actionable on hold expiry. */
const INVALIDATABLE_PAYMENT_STATUSES = ['checkout_created', 'draft', 'pending'];
/** @deprecated use INVALIDATABLE_PAYMENT_STATUSES */
const CANCELLABLE_PAYMENT_STATUSES = INVALIDATABLE_PAYMENT_STATUSES;

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;

function emptySummary() {
  return {
    scanned: 0,
    expired: 0,
    skipped_paid: 0,
    skipped_changed: 0,
    beds_released: 0,
    payments_invalidated: 0,
    errors: [],
  };
}

function mergeSummary(into, one) {
  into.scanned += one.scanned || 0;
  into.expired += one.expired || 0;
  into.skipped_paid += one.skipped_paid || 0;
  into.skipped_changed += one.skipped_changed || 0;
  into.beds_released += one.beds_released || 0;
  into.payments_invalidated += one.payments_invalidated || 0;
  if (one.errors && one.errors.length) into.errors.push(...one.errors);
  return into;
}

function clampBatchSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(v), MAX_BATCH_SIZE);
}

function buildHoldExpiredMetadata(locked, nowIso) {
  return {
    [HOLD_EXPIRED_BY_WORKER_META_KEY]: {
      expired_at: nowIso,
      hold_expires_at: locked.hold_expires_at || null,
      source: HOLD_EXPIRY_WORKER_SOURCE,
      policy: 'wb-4',
    },
  };
}

function buildHoldExpiryPaymentInvalidationMetadata(nowIso) {
  return {
    invalidated_at: nowIso,
    invalidated_by: HOLD_EXPIRY_WORKER_SOURCE,
    invalidate_reason: 'Hold expired — payment link non-actionable',
    checkout_url_cleared: true,
    payment_link_invalidated: true,
    hold_expiry_worker: true,
    // Status intentionally unchanged so late Stripe truth can still mark paid.
    payment_status_preserved: true,
  };
}

function isBookingPaidForHoldExpiry(bookingRow, paidPaymentCount) {
  const ps = String(bookingRow.payment_status || '').toLowerCase();
  if (PAID_BOOKING_PAYMENT_STATUSES.has(ps)) return true;
  return Number(paidPaymentCount || 0) > 0;
}

function isHoldDueForExpiry(bookingRow, now) {
  if (!bookingRow) return false;
  if (String(bookingRow.status || '') !== 'hold') return false;
  if (!bookingRow.hold_expires_at) return false;
  const expiresAt = bookingRow.hold_expires_at instanceof Date
    ? bookingRow.hold_expires_at
    : new Date(bookingRow.hold_expires_at);
  if (Number.isNaN(expiresAt.getTime())) return false;
  const asOf = now instanceof Date ? now : new Date(now);
  return expiresAt.getTime() <= asOf.getTime();
}

/**
 * List candidate booking ids due for hold expiry (read-only scan).
 * Does not reference bookings.location_id — that column is absent on Sunset staging.
 */
async function selectDueHoldCandidates(pg, opts = {}) {
  const now = opts.now || new Date();
  const batchSize = clampBatchSize(opts.batchSize);
  const clientId = opts.clientId || null;
  if (opts.locationId) {
    throw new Error('location filter is not supported: bookings.location_id is not present on all tenants');
  }

  const res = await pg.query(
    `SELECT b.id::text AS booking_id,
            b.client_id::text AS client_id,
            c.slug AS client_slug,
            b.booking_code,
            b.hold_expires_at,
            b.payment_status::text AS payment_status
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE b.status = 'hold'::booking_status
        AND b.hold_expires_at IS NOT NULL
        AND b.hold_expires_at <= $1::timestamptz
        AND ($2::uuid IS NULL OR b.client_id = $2::uuid)
      ORDER BY b.hold_expires_at ASC
      LIMIT $3`,
    [now, clientId, batchSize],
  );
  return (res.rows || []).map((row) => ({ ...row, location_id: null }));
}

async function resolveClientIdForSlug(pg, clientSlug) {
  if (!clientSlug) return null;
  const res = await pg.query(
    `SELECT id::text AS client_id FROM clients WHERE slug = $1 LIMIT 1`,
    [String(clientSlug).trim()],
  );
  return (res.rows[0] && res.rows[0].client_id) || null;
}

/**
 * Expire one booking hold under an open transaction (caller owns BEGIN/COMMIT).
 * Returns outcome counters for this booking only.
 */
async function expireOneBookingHold(pg, opts = {}) {
  const bookingId = opts.bookingId;
  const clientId = opts.clientId;
  const clientSlug = opts.clientSlug || null;
  const now = opts.now || new Date();
  const apply = opts.apply !== false;
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();

  const out = {
    scanned: 1,
    expired: 0,
    skipped_paid: 0,
    skipped_changed: 0,
    beds_released: 0,
    payments_invalidated: 0,
    errors: [],
  };

  if (!bookingId || !clientId) {
    out.errors.push({ booking_id: bookingId, code: 'missing_scope', message: 'booking_id and client_id required' });
    return out;
  }

  const lockRes = await pg.query(
    `SELECT b.id::text AS booking_id,
            b.client_id::text AS client_id,
            b.status::text AS status,
            b.payment_status::text AS payment_status,
            b.hold_expires_at,
            c.slug AS client_slug
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE b.id = $1::uuid
        AND b.client_id = $2::uuid
      FOR UPDATE`,
    [bookingId, clientId],
  );
  const locked = lockRes.rows[0];
  if (!locked) {
    out.skipped_changed += 1;
    return out;
  }

  if (!isHoldDueForExpiry(locked, now)) {
    out.skipped_changed += 1;
    return out;
  }

  const paidCountRes = await pg.query(
    `SELECT COUNT(*)::int AS n
       FROM payments p
      WHERE p.booking_id = $1::uuid
        AND p.client_id = $2::uuid
        AND p.status = 'paid'::payment_record_status`,
    [bookingId, clientId],
  );
  const paidPaymentCount = paidCountRes.rows[0] && paidCountRes.rows[0].n;

  if (isBookingPaidForHoldExpiry(locked, paidPaymentCount)) {
    out.skipped_paid += 1;
    return out;
  }

  if (!apply) {
    const bedCountRes = await pg.query(
      `SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id = $1::uuid AND client_id = $2::uuid`,
      [bookingId, clientId],
    );
    const payCountRes = await pg.query(
      `SELECT COUNT(*)::int AS n
         FROM payments p
        WHERE p.booking_id = $1::uuid
          AND p.client_id = $2::uuid
          AND p.status::text = ANY($3::text[])
          AND COALESCE(p.amount_paid_cents, 0) = 0`,
      [bookingId, clientId, INVALIDATABLE_PAYMENT_STATUSES],
    );
    out.expired += 1;
    out.beds_released += (bedCountRes.rows[0] && bedCountRes.rows[0].n) || 0;
    out.payments_invalidated += (payCountRes.rows[0] && payCountRes.rows[0].n) || 0;
    return out;
  }

  const slug = clientSlug || locked.client_slug;
  const metaMerge = {
    ...buildHoldExpiredMetadata(locked, nowIso),
    ...(slug ? buildBookingMetadataInvalidationPatch(slug) : {}),
  };

  const updRes = await pg.query(
    `UPDATE bookings
        SET status = 'expired'::booking_status,
            updated_at = NOW(),
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE id = $1::uuid
        AND client_id = $2::uuid
        AND status = 'hold'::booking_status
      RETURNING id::text AS booking_id`,
    [bookingId, clientId, JSON.stringify(metaMerge)],
  );
  if (!updRes.rows[0]) {
    out.skipped_changed += 1;
    return out;
  }

  const bedsRes = await pg.query(
    `DELETE FROM booking_beds
      WHERE booking_id = $1::uuid
        AND client_id = $2::uuid
      RETURNING id::text AS bed_row_id`,
    [bookingId, clientId],
  );
  out.beds_released += bedsRes.rowCount || 0;

  // Invalidate unpaid links only — clear checkout_url + metadata; keep ledger
  // status and stripe_checkout_session_id so late Stripe events remain eligible.
  const invalidateMeta = JSON.stringify(buildHoldExpiryPaymentInvalidationMetadata(nowIso));
  const payRes = await pg.query(
    `UPDATE payments p
        SET checkout_url = NULL,
            metadata = COALESCE(p.metadata, '{}'::jsonb) || $4::jsonb
      WHERE p.booking_id = $1::uuid
        AND p.client_id = $2::uuid
        AND p.status::text = ANY($3::text[])
        AND COALESCE(p.amount_paid_cents, 0) = 0
      RETURNING p.id::text AS payment_id, p.status::text AS payment_status,
                p.stripe_checkout_session_id`,
    [bookingId, clientId, INVALIDATABLE_PAYMENT_STATUSES, invalidateMeta],
  );
  out.payments_invalidated += payRes.rowCount || 0;
  out.expired += 1;
  return out;
}

/**
 * Process one booking in its own transaction (apply path).
 */
async function expireOneBookingHoldTx(pg, opts = {}) {
  if (opts.apply === false) {
    return expireOneBookingHold(pg, opts);
  }
  await pg.query('BEGIN');
  try {
    const result = await expireOneBookingHold(pg, { ...opts, apply: true });
    if (result.errors.length) {
      await pg.query('ROLLBACK');
      return result;
    }
    await pg.query('COMMIT');
    return result;
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    return {
      scanned: 1,
      expired: 0,
      skipped_paid: 0,
      skipped_changed: 0,
      beds_released: 0,
      payments_invalidated: 0,
      errors: [{ booking_id: opts.bookingId, code: err.code || 'expire_failed', message: err.message }],
    };
  }
}

/**
 * Batch expire due holds. Default dry-run (apply=false).
 */
async function expireDueBookingHolds(pg, opts = {}) {
  const apply = opts.apply === true;
  const batchSize = clampBatchSize(opts.batchSize);
  const now = opts.now || new Date();
  let clientId = opts.clientId || null;
  if (!clientId && opts.clientSlug) {
    clientId = await resolveClientIdForSlug(pg, opts.clientSlug);
    if (!clientId) {
      const summary = emptySummary();
      summary.errors.push({ code: 'client_not_found', message: `unknown client slug: ${opts.clientSlug}` });
      return summary;
    }
  }

  const summary = emptySummary();
  const maxBatches = apply ? (opts.maxBatches || 100) : 1;

  for (let batchIdx = 0; batchIdx < maxBatches; batchIdx += 1) {
    const candidates = await selectDueHoldCandidates(pg, {
      now,
      batchSize,
      clientId,
      locationId: opts.locationId || null,
    });
    if (!candidates.length) break;

    for (const row of candidates) {
      try {
        let one;
        if (apply) {
          one = await expireOneBookingHoldTx(pg, {
            bookingId: row.booking_id,
            clientId: row.client_id,
            clientSlug: row.client_slug,
            now,
            apply: true,
          });
        } else {
          await pg.query('BEGIN');
          try {
            one = await expireOneBookingHold(pg, {
              bookingId: row.booking_id,
              clientId: row.client_id,
              clientSlug: row.client_slug,
              now,
              apply: false,
            });
            await pg.query('ROLLBACK');
          } catch (e) {
            try { await pg.query('ROLLBACK'); } catch (_) {}
            throw e;
          }
        }
        mergeSummary(summary, one);
      } catch (err) {
        summary.errors.push({
          booking_id: row.booking_id,
          code: err.code || 'batch_item_failed',
          message: err.message,
        });
      }
    }

    if (!apply || candidates.length < batchSize) break;
  }

  return summary;
}

module.exports = {
  HOLD_EXPIRY_WORKER_SOURCE,
  HOLD_EXPIRED_BY_WORKER_META_KEY,
  PAID_BOOKING_PAYMENT_STATUSES,
  INVALIDATABLE_PAYMENT_STATUSES,
  CANCELLABLE_PAYMENT_STATUSES,
  DEFAULT_BATCH_SIZE,
  emptySummary,
  mergeSummary,
  buildHoldExpiredMetadata,
  buildHoldExpiryPaymentInvalidationMetadata,
  isBookingPaidForHoldExpiry,
  isHoldDueForExpiry,
  selectDueHoldCandidates,
  resolveClientIdForSlug,
  expireOneBookingHold,
  expireOneBookingHoldTx,
  expireDueBookingHolds,
};
