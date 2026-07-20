'use strict';

/**
 * RADAR 16M — fail-closed Stripe webhook event-id claim (payment_events).
 *
 * Uses existing payment_events.stripe_event_id UNIQUE. Ownership column is
 * payment_events.client_id (001_init hostel_id, renamed in migration 003).
 *
 * Contract (caller owns BEGIN/COMMIT/ROLLBACK on the same pg client):
 *   1. INSERT ... ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id
 *   2. zero rows → duplicate (caller rolls back; HTTP 200 idempotent)
 *   3. first claim → (path-specific lock/reload) → mutate or distinct-event
 *      business-idempotent skip → mark that row processed=true → caller COMMIT
 *   4. claim/mutate/processed failure BEFORE commit attempt → caller ROLLBACK
 *      → retryable 500
 *   5. COMMIT rejection/failure is AMBIGUOUS: never claim the txn definitely
 *      rolled back. Best-effort ROLLBACK, then retryable 500 with
 *      outcome_unknown=true (no secret/error details). Retry resolves via the
 *      durable stripe_event_id claim (idempotent if commit landed; can claim
 *      if it did not).
 *
 * Payload is privacy-minimized: allowlisted non-PII identifiers/state only.
 * Never persist raw Stripe event/session/customer or email/phone/name/addresses/tokens.
 */

const PAYMENT_EVENTS_OWNERSHIP_COLUMN = 'client_id';

/** Keys permitted inside payment_events.payload (audit identifiers/state only). */
const STRIPE_WEBHOOK_EVENT_PAYLOAD_ALLOWLIST = Object.freeze([
  'stripe_event_id',
  'event_type',
  'stripe_session_id',
  'payment_id',
  'booking_id',
  'client_slug',
  'payment_kind',
  'currency',
  'amount_paid_cents',
  'payment_status_before',
  'lookup_path',
  'livemode',
  'path',
  'duplicate_business_outcome',
]);

const FORBIDDEN_PAYLOAD_CANARIES = Object.freeze([
  'email',
  'phone',
  'name',
  'guest_name',
  'customer',
  'address',
  'addresses',
  'postal',
  'token',
  'client_secret',
  'payment_method',
  'raw',
  'raw_event',
  'raw_session',
  'data',
  'object',
]);

const CLAIM_INSERT_SQL = `
INSERT INTO payment_events (
  client_id,
  payment_id,
  booking_id,
  stripe_event_id,
  event_type,
  payload,
  processed
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6::jsonb,
  false
)
ON CONFLICT (stripe_event_id) DO NOTHING
RETURNING id`.replace(/\s+/g, ' ').trim();

const MARK_PROCESSED_SQL = `
UPDATE payment_events
   SET processed = true,
       payload = CASE
         WHEN $2::jsonb IS NULL THEN payload
         ELSE COALESCE(payload, '{}'::jsonb) || $2::jsonb
       END
 WHERE id = $1::uuid
   AND processed IS NOT TRUE
 RETURNING id`.replace(/\s+/g, ' ').trim();

const LOCK_OWNED_PAYMENT_SQL = `
SELECT id::text AS payment_id,
       status::text AS payment_status,
       payment_kind::text AS payment_kind,
       client_id::text AS client_id
  FROM payments
 WHERE id = $1::uuid
   AND client_id = $2::uuid
 FOR UPDATE`.replace(/\s+/g, ' ').trim();

const IDEMPOTENT_DUPLICATE_REASON = 'stripe_event_id_already_claimed';
const IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON = 'duplicate_business_outcome';
const COMMIT_OUTCOME_UNKNOWN_CODE = 'stripe_event_claim_commit_outcome_unknown';

function trimStr(value) {
  return value == null ? '' : String(value).trim();
}

function assertUuid(label, value) {
  const s = trimStr(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) {
    const err = new Error(`${label}_invalid`);
    err.code = `${label}_invalid`;
    throw err;
  }
  return s;
}

function assertStripeEventId(value) {
  const s = trimStr(value);
  if (!s || s.length > 255) {
    const err = new Error('stripe_event_id_invalid');
    err.code = 'stripe_event_id_invalid';
    throw err;
  }
  return s;
}

/**
 * Build privacy-minimized payment_events.payload from allowlisted fields only.
 * Rejects objects that still contain forbidden canary keys at the top level.
 */
function buildMinimizedStripeWebhookEventPayload(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of STRIPE_WEBHOOK_EVENT_PAYLOAD_ALLOWLIST) {
    if (src[key] === undefined || src[key] === null || src[key] === '') continue;
    const v = src[key];
    if (typeof v === 'object') continue;
    out[key] = typeof v === 'boolean' || typeof v === 'number' ? v : trimStr(v);
  }
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_PAYLOAD_CANARIES.some((c) => lower === c || lower.includes(c))) {
      const err = new Error('stripe_event_payload_forbidden_key');
      err.code = 'stripe_event_payload_forbidden_key';
      throw err;
    }
  }
  return out;
}

/**
 * INSERT claim row (processed=false). Same transaction as caller mutations.
 * @returns {{ claimed: boolean, duplicate: boolean, id: string|null, payload: object }}
 */
async function claimStripeWebhookEvent(pg, input) {
  if (!pg || typeof pg.query !== 'function') {
    const err = new Error('pg_client_required');
    err.code = 'pg_client_required';
    throw err;
  }
  const hostelId = assertUuid('hostel_id', input && (input.hostelId || input.hostel_id || input.clientId || input.client_id));
  const paymentId = assertUuid('payment_id', input && (input.paymentId || input.payment_id));
  const bookingId = assertUuid('booking_id', input && (input.bookingId || input.booking_id));
  const stripeEventId = assertStripeEventId(input && (input.stripeEventId || input.stripe_event_id));
  const eventType = trimStr(input && (input.eventType || input.event_type));
  if (!eventType) {
    const err = new Error('event_type_required');
    err.code = 'event_type_required';
    throw err;
  }

  const payload = buildMinimizedStripeWebhookEventPayload({
    stripe_event_id: stripeEventId,
    event_type: eventType,
    stripe_session_id: input.sessionId || input.stripe_session_id || input.session_id,
    payment_id: paymentId,
    booking_id: bookingId,
    client_slug: input.clientSlug || input.client_slug,
    payment_kind: input.paymentKind || input.payment_kind,
    currency: input.currency,
    amount_paid_cents: input.amountPaidCents != null ? Number(input.amountPaidCents) : input.amount_paid_cents,
    payment_status_before: input.paymentStatusBefore || input.payment_status_before,
    lookup_path: input.lookupPath || input.lookup_path,
    livemode: input.livemode === true,
    path: input.path,
  });

  const result = await pg.query(CLAIM_INSERT_SQL, [
    hostelId,
    paymentId,
    bookingId,
    stripeEventId,
    eventType,
    JSON.stringify(payload),
  ]);
  const id = result && result.rows && result.rows[0] && result.rows[0].id
    ? String(result.rows[0].id)
    : null;
  if (!id) {
    return { claimed: false, duplicate: true, id: null, payload };
  }
  return { claimed: true, duplicate: false, id, payload };
}

/**
 * Mark only the claimed row processed=true (same transaction).
 * Optional privacy-minimized payloadPatch (e.g. duplicate_business_outcome).
 */
async function markStripeWebhookEventProcessed(pg, claimId, payloadPatch) {
  if (!pg || typeof pg.query !== 'function') {
    const err = new Error('pg_client_required');
    err.code = 'pg_client_required';
    throw err;
  }
  const id = assertUuid('claim_id', claimId);
  let patchJson = null;
  if (payloadPatch && typeof payloadPatch === 'object') {
    const minimized = buildMinimizedStripeWebhookEventPayload(payloadPatch);
    if (Object.keys(minimized).length > 0) {
      patchJson = JSON.stringify(minimized);
    }
  }
  const result = await pg.query(MARK_PROCESSED_SQL, [id, patchJson]);
  const updated = result && result.rows && result.rows[0] && result.rows[0].id
    ? String(result.rows[0].id)
    : null;
  if (!updated) {
    const err = new Error('stripe_event_claim_mark_processed_miss');
    err.code = 'stripe_event_claim_mark_processed_miss';
    throw err;
  }
  return updated;
}

/**
 * Lock/reload owned payment by payment_id + client_id (FOR UPDATE).
 * Used by addon_service after event claim and before any business mutation.
 */
async function lockOwnedPaymentForAddonEventClaim(pg, input) {
  if (!pg || typeof pg.query !== 'function') {
    const err = new Error('pg_client_required');
    err.code = 'pg_client_required';
    throw err;
  }
  const paymentId = assertUuid('payment_id', input && (input.paymentId || input.payment_id));
  const clientId = assertUuid('client_id', input && (input.clientId || input.client_id || input.hostelId || input.hostel_id));
  const result = await pg.query(LOCK_OWNED_PAYMENT_SQL, [paymentId, clientId]);
  return (result && result.rows && result.rows[0]) || null;
}

/**
 * Claim → mutate → mark processed. Caller must already be inside BEGIN.
 * Does not COMMIT or ROLLBACK. Duplicate → mutate is not called.
 *
 * mutateFn may return `{ duplicate_business_outcome: string }` to skip business
 * writes while still marking the claimed event processed with that marker.
 *
 * @returns {{
 *   duplicate: boolean,
 *   claimId: string|null,
 *   payload: object|null,
 *   duplicate_business_outcome: string|null,
 * }}
 */
async function withStripeWebhookEventClaim(pg, claimInput, mutateFn) {
  const claim = await claimStripeWebhookEvent(pg, claimInput);
  if (!claim.claimed) {
    return {
      duplicate: true,
      claimId: null,
      payload: claim.payload,
      duplicate_business_outcome: null,
    };
  }
  if (typeof mutateFn !== 'function') {
    const err = new Error('mutate_fn_required');
    err.code = 'mutate_fn_required';
    throw err;
  }
  const mutateResult = await mutateFn(pg);
  const dbo = mutateResult && mutateResult.duplicate_business_outcome
    ? trimStr(mutateResult.duplicate_business_outcome)
    : '';
  await markStripeWebhookEventProcessed(
    pg,
    claim.id,
    dbo ? { duplicate_business_outcome: dbo } : null,
  );
  return {
    duplicate: false,
    claimId: claim.id,
    payload: claim.payload,
    duplicate_business_outcome: dbo || null,
  };
}

function buildStripeEventClaimIdempotentBody(fields) {
  const f = fields || {};
  return {
    success: true,
    idempotent: true,
    reason: IDEMPOTENT_DUPLICATE_REASON,
    stripe_event_id: f.stripeEventId || f.stripe_event_id || null,
    event_type: f.eventType || f.event_type || null,
    payment_id: f.paymentId || f.payment_id || null,
    booking_id: f.bookingId || f.booking_id || null,
    booking_code: f.bookingCode || f.booking_code || null,
    no_db_write: true,
    no_confirmation_sent: true,
    no_whatsapp: true,
    no_n8n: true,
  };
}

/**
 * Distinct-event business idempotency (new stripe_event_id claimed+processed,
 * payment already paid under lock — no payment/service rewrite).
 */
function buildStripeEventDistinctBusinessIdempotentBody(fields) {
  const f = fields || {};
  return {
    success: true,
    idempotent: true,
    reason: IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON,
    duplicate_business_outcome: f.duplicateBusinessOutcome
      || f.duplicate_business_outcome
      || 'payment_already_paid',
    stripe_event_id: f.stripeEventId || f.stripe_event_id || null,
    event_type: f.eventType || f.event_type || null,
    payment_id: f.paymentId || f.payment_id || null,
    booking_id: f.bookingId || f.booking_id || null,
    booking_code: f.bookingCode || f.booking_code || null,
    no_db_write: true,
    no_confirmation_sent: true,
    no_whatsapp: true,
    no_n8n: true,
  };
}

/**
 * Retryable 500 body after COMMIT ambiguity. No secrets or error details.
 * Retry: if commit landed, durable stripe_event_id claim → idempotent;
 * if not, a fresh claim can proceed.
 */
function buildStripeEventClaimOutcomeUnknownBody() {
  return {
    success: false,
    retryable: true,
    outcome_unknown: true,
  };
}

function isStripeEventClaimCommitOutcomeUnknown(err) {
  return !!(err && (err.outcome_unknown === true || err.code === COMMIT_OUTCOME_UNKNOWN_CODE));
}

/**
 * Attempt COMMIT. On failure: best-effort ROLLBACK, then throw outcome_unknown.
 * Never asserts that a rejected COMMIT definitely rolled back.
 */
async function commitStripeWebhookEventTxnOrThrowUnknown(pg) {
  try {
    await pg.query('COMMIT');
  } catch (_) {
    try { await pg.query('ROLLBACK'); } catch (__){ /* best-effort */ }
    const err = new Error(COMMIT_OUTCOME_UNKNOWN_CODE);
    err.code = COMMIT_OUTCOME_UNKNOWN_CODE;
    err.outcome_unknown = true;
    throw err;
  }
}

module.exports = {
  PAYMENT_EVENTS_OWNERSHIP_COLUMN,
  STRIPE_WEBHOOK_EVENT_PAYLOAD_ALLOWLIST,
  FORBIDDEN_PAYLOAD_CANARIES,
  CLAIM_INSERT_SQL,
  MARK_PROCESSED_SQL,
  LOCK_OWNED_PAYMENT_SQL,
  IDEMPOTENT_DUPLICATE_REASON,
  IDEMPOTENT_DISTINCT_EVENT_BUSINESS_REASON,
  COMMIT_OUTCOME_UNKNOWN_CODE,
  buildMinimizedStripeWebhookEventPayload,
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  lockOwnedPaymentForAddonEventClaim,
  withStripeWebhookEventClaim,
  buildStripeEventClaimIdempotentBody,
  buildStripeEventDistinctBusinessIdempotentBody,
  buildStripeEventClaimOutcomeUnknownBody,
  isStripeEventClaimCommitOutcomeUnknown,
  commitStripeWebhookEventTxnOrThrowUnknown,
};
