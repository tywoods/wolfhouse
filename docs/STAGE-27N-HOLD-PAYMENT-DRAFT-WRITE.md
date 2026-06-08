# Stage 27n — Hold + Payment Draft Gated Write

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27M-HOLD-PAYMENT-DRAFT-PLANNER.md](STAGE-27M-HOLD-PAYMENT-DRAFT-PLANNER.md) · [STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md](STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md)  
**Write module:** `scripts/lib/luna-guest-hold-payment-draft-write.js`  
**Verifier:** `npm run verify:stage27n-hold-payment-draft-write`

**Non-negotiables:** Staging/local DB only · **no production** · no Stripe link · no WhatsApp · no Meta · no n8n · no live guest automation · **requires explicit `confirm_write`**.

---

## 1. Purpose

First **controlled state-changing** guest booking step after Stage **27m** planner is `ready`: create booking hold + quote snapshot in metadata + draft `payments` row. No Stripe Checkout Session. No guest send.

Standalone module (not wired into guest intake HTTP endpoint in 27n).

---

## 2. API

```js
await runGuestHoldPaymentDraftWriteDryRunApproved(chainResult, context)
```

| Param | Notes |
|-------|--------|
| `chainResult` | `{ result, availability, quote, payment_choice }` |
| `context.confirm_write` | **Must be `true`** to attempt write |
| `context.client_slug` | Default `wolfhouse-somo` |
| `context.guest_name` / `guest_email` / `guest_phone` | Required for write |
| `context.env` | Used for production/staging guard |
| `context.planner` | Optional precomputed 27m planner |
| `context.pg` | Optional injected pg client (tests) |

---

## 3. Hard gates (all required)

| Gate | Requirement |
|------|-------------|
| Environment | `NODE_ENV` not `production`; staging/dev/localhost allowed |
| Explicit approval | `context.confirm_write === true` |
| Planner | `plan_status === "ready"` |
| Planner flags | `would_create_hold` + `would_create_payment_draft` true; `would_create_stripe_link` false |
| Payment choice | `payment_choice.next_safe_step === "ready_for_hold_payment_draft"` |
| Guest identity | `guest_phone`, `guest_email`, `guest_name` in context |

---

## 4. Reused write path / tables

| Layer | Reuse |
|-------|--------|
| **Hold upsert** | `upsertBookingHold()` in `scripts/lib/main-booking-hold-pg-sql.js` |
| **Client resolve** | `resolveClientId()` same module |
| **Active hold guard** | `selectActiveHoldGuard()` same module |
| **Hold status** | `EXECUTE_HOLD_STATUSES` → `status: hold`, `payment_status: not_requested` on insert |
| **Quote snapshot** | `bookings.metadata.quote_snapshot` + amount columns (same pattern as manual booking create) |
| **Draft payment** | `INSERT INTO payments` with `status = 'draft'` (Staff API / manual booking convention) |
| **Payment kind** | `deposit_only` or `full_amount` enum |
| **Idempotency** | `bookings.metadata->>'idempotency_key'` + `payments.metadata->>'idempotency_key'` (Stage 8.3f interim pattern) |
| **DB connection** | `withPgClient()` from `scripts/lib/pg-connect.js` |
| **Staging guard** | `isStagingResetEnvironment()` from `scripts/lib/luna-test-reset-phone.js` |

**No new migrations in 27n.** Uses existing `bookings`, `payments`, `clients` schema.

---

## 5. Hold rules

| Rule | Value |
|------|--------|
| `hold_expires_at` | `now + 6 hours` |
| Booking status after hold | `hold` (via `upsertBookingHold`) |
| After draft payment | `payment_status` → `waiting_payment` on booking |
| Luna reply | Does **not** mention hold expiry proactively |
| Confirmation | **Not** confirmed — hold + draft only |

---

## 6. Output

```json
{
  "success": true,
  "write_attempted": true,
  "write_status": "created",
  "booking_id": "...",
  "booking_code": "WH-G27-...",
  "payment_draft_id": "...",
  "hold_expires_at": "...",
  "created_records": {
    "booking_hold": {},
    "quote_snapshot": {},
    "payment_draft": { "status": "draft" }
  },
  "next_safe_step": "ready_for_stripe_test_link",
  "stripe_link_created": false,
  "sends_whatsapp": false,
  "live_send_blocked": true
}
```

`write_status` values: `not_ready` · `created` · `reused_existing` · `needs_staff_review` · `error`

---

## 7. Idempotency

1. Planner produces `idempotency_key_preview` (32-char hex).
2. Before insert, lookup active `bookings` row with same `metadata.idempotency_key`.
3. If found with non-expired hold + matching draft payment → `write_status: reused_existing`.
4. Payment idempotency key: `ghpd-pay-{idempotency_key_preview}`.
5. Booking code derived: `WH-G27-{hashPrefix}` (stable per idempotency key).

Repeated calls with the same chain must **not** create duplicate active holds/drafts.

---

## 8. Local / staging usage

Prerequisites:

- `DATABASE_URL` pointing at **local or staging** Postgres (never production)
- `NODE_ENV=development` or `staging` (or localhost host header)

Example (programmatic):

```js
const chain = { result, availability, quote, payment_choice };
const out = await runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
  confirm_write: true,
  client_slug: 'wolfhouse-somo',
  guest_name: 'Staging Test Guest',
  guest_email: 'staging-test@wolfhouse.test',
  guest_phone: '+34600999999',
});
```

**Do not** set `confirm_write: true` in production environments — gate returns `not_ready`.

---

## 9. Safety limits

| Action | 27n |
|--------|-----|
| Booking/hold write | ✓ staging/local only with `confirm_write` |
| Draft payment write | ✓ |
| Stripe link | ❌ always `stripe_link_created: false` |
| WhatsApp / Meta / n8n | ❌ |
| Booking confirmation | ❌ |
| Service/transfer line DB writes | ❌ (planner summary only) |

---

## 10. Rollback / cleanup

Test holds/payments created with `metadata.source = luna_guest_hold_payment_draft_27n` can be cleaned up in staging by:

- Cancelling/expiring the booking row (`status = cancelled` or wait for `hold_expires_at`)
- Deleting draft `payments` rows linked to test booking (staging only)

Use dedicated test phone numbers (e.g. `+34600999999`) to avoid colliding with real guest data.

---

## 11. Reply safety

May say secure payment step can be prepared next.

Must **not** say booking is held/confirmed, payment link is ready, payment received, or mention hold expiry proactively.

---

## 12. Next stage

**Stage 27o** — Stripe **test** Checkout link creation (no live WhatsApp send).

---

## 13. Verifier

```bash
npm run verify:stage27n-hold-payment-draft-write
```

Static gate, output shape, idempotency representation, source hygiene, reply safety (no live DB required).
