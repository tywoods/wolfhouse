'use strict';

// Only the recognizable initial booking draft is eligible. This is not a
// provider cancellation path: even an unresolved provider identity is retained.
// Caller must hold the tenant-scoped booking lock and validate guest ownership.
async function retireInertInitialBookingDraft(pg, clientId, bookingId, guestMetadata = {}) {
  // Adding one payer does not switch the original occupants to separate pay.
  // This is a persisted add-guest-owner fact, never a caller-supplied choice.
  if (guestMetadata.payment_collection_scope === 'added_guest_only') return [];
  const result = await pg.query(`UPDATE payments p SET status='expired'::payment_record_status,
    metadata=COALESCE(p.metadata,'{}'::jsonb) || jsonb_build_object(
      'superseded_reason','separate_guest_collection','superseded_at',NOW())
    WHERE p.client_id=$1::uuid AND p.booking_id=$2::uuid
      AND p.booking_guest_id IS NULL AND p.status='draft'
      AND COALESCE(p.amount_paid_cents,0)=0
      AND COALESCE(p.metadata->>'payment_scope','booking')='booking'
      AND NULLIF(p.metadata->>'booking_guest_id','') IS NULL
      AND (p.metadata->>'source'='bot_booking_payment_prepare'
        OR (p.metadata->>'source'='bot_booking_stage854' AND p.metadata ? 'quote_total_cents')
        OR (p.metadata->>'source'='staff_manual' AND p.metadata->>'note'='Deposit requested'
            AND p.metadata ? 'deposit_requested_cents' AND p.metadata ? 'total_amount_cents'))
      AND COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),
        NULLIF(to_jsonb(p)->>'checkout_url',''),NULLIF(to_jsonb(p)->>'stripe_payment_intent_id',''),
        NULLIF(p.metadata->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_session_id',''),
        NULLIF(p.metadata->>'checkout_url',''),NULLIF(p.metadata->>'payment_link_url',''),
        NULLIF(p.metadata->>'provider_idempotency_key',''),NULLIF(p.metadata->>'idempotency_key',''),
        NULLIF(p.metadata->>'checkout_preparation','')) IS NULL
    RETURNING p.id`, [clientId, bookingId]);
  return result.rows.map(row => row.id);
}
module.exports = { retireInertInitialBookingDraft };
