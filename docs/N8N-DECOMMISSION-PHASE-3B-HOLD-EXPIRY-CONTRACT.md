# n8n Decommission — Phase 3B: Hold-Expiry Contract

**Date:** 2026-07-15  
**Branch:** `feat/n8n-decommission-hold-expiry-contract`  
**Mode:** inspection / specification only — no worker, no DB writes, no deploy  
**Base:** `origin/master` @ Phase 3A merge (`b43b4f8`)

## Purpose

Replace historical n8n Main schedule **“Delete Expired Holds (6hrs)”** with a Staff API–owned, idempotent hold-expiry contract before any Phase 3C implementation.

Historical outcome (docs): expired holds → cancelled (`docs/regression-test-plan.md` §6.6).  
Postgres already has `booking_status.expired` and detection queries; **no expire worker exists**.

---

## Lifecycle map (current owners)

```text
CREATE
  Main / legacy hold upsert     → status=hold|payment_pending, hold_expires_at = now+1h,
                                  NO booking_beds
                                  scripts/lib/main-booking-hold-pg-sql.js
  Luna guest hold+draft (27n)   → status=hold, payment waiting_payment, hold_expires_at = now+6h,
                                  payments.status=draft, NO booking_beds
                                  scripts/lib/luna-guest-hold-payment-draft-*.js
  Staff/bot accommodation create→ status=confirmed + booking_beds (NOT a soft hold)
                                  luna-front-desk-accommodation-booking-create-service.js

PROMOTE (pre-pay)
  Ensure Booking                → hold → payment_pending (does not clear hold_expires_at)
                                  scripts/lib/main-ensure-booking-pg-sql.js

PAYMENT LINK
  Staff/bot create-stripe-link  → payments checkout_created
  Luna staging test link        → rejects if hold_expires_at <= now (hold_expired)

STRIPE TRUTH
  POST /staff/stripe/webhook    → payments → paid; booking money fields;
                                  status hold → confirmed (payment_pending unchanged)
                                  NO hold_expires_at check today
  Staging 27p apply             → blocks hold_expired; does NOT set confirmed
  Reconcile helper              → same hold → confirmed CASE

BEDS
  Classic hold                  → unassigned, no booking_beds (soft hold)
  Demo / later assign           → may insert booking_beds
  Availability overlap          → uses booking_beds; excludes cancelled/expired

CANCEL (human/API)
  POST /staff/bookings/cancel   → status=cancelled, DELETE booking_beds

EXPIRE (historical n8n)
  Schedule Delete Expired Holds → docs: expired holds → cancelled
                                  workflow JSON absent from repo; Cloud workspace gone

EXPIRE (current PG)
  Detection only                → staff-booking-hold-queries.getExpiredHoldsQuery
                                  (still status='hold', hold_expires_at < NOW())
  Worker                        → MISSING
```

### TTL skew (must unify in Phase 3C create-path cleanup — not this doc’s implementation)

| Source | TTL |
|--------|-----|
| `config/clients/wolfhouse-somo.baseline.json` | **360 minutes / 6h** (product SoT for guest holds) |
| Luna hold+draft write | **6h** |
| Main `proposeHoldExpiresAt` / n8n SQL | **1h** |
| `wolfhouse-somo.pricing.json` hold.expiry_* | **60 minutes / 1h** |

**Expiry worker must use row `hold_expires_at` (wall clock), not recompute TTL.**

---

## Authoritative expire transaction (Phase 3C target)

### Eligibility (all must be true)

1. `bookings.status = 'hold'`
2. `bookings.hold_expires_at IS NOT NULL AND hold_expires_at < NOW()`
3. **Unpaid proof** (see below)
4. Scoped `client_id` (+ `location_id` when multi-location)
5. Not in never-expire set

**v1 scope:** `status = 'hold'` only.  
`payment_pending` past `hold_expires_at` is **out of v1** (separate decision — unpaid Checkout may still be valid).

### Unpaid proof

A hold is still unpaid if **all** of:

- `bookings.payment_status` NOT IN (`deposit_paid`, `paid`)
- No `payments` row for that booking with `status = 'paid'`
- No successful Stripe payment truth already applied for that booking (`payment_events` / paid payment)

If any of those fail → **skip** (do not expire).

### Atomic mutation (single booking, one transaction)

```text
BEGIN
  SELECT … FROM bookings WHERE id = $id AND status = 'hold'
    AND hold_expires_at < NOW()
    FOR UPDATE;

  Re-check unpaid proof under the row lock.

  UPDATE bookings
     SET status = 'expired',                    -- terminal (distinct from staff cancel)
         updated_at = NOW()
   WHERE id = $id AND status = 'hold';          -- idempotent guard

  DELETE FROM booking_beds WHERE booking_id = $id;

  For each unpaid payments row (draft|checkout_created|pending):
     UPDATE payments SET status = 'expired'     -- or cancelled; see open Q
     WHERE id = … AND status IN (...unpaid...);

  INSERT audit / workflow_events:
     type = hold_expired
     booking_id, client_id, location_id,
     previous_status, hold_expires_at, beds_deleted, payments_expired

COMMIT
```

**Guest / staff messaging:** none by default (no WhatsApp, no email). Staff see expired holds via existing queries / calendar.

### Status changes summary

| Entity | Field | From → To |
|--------|-------|-----------|
| booking | `status` | `hold` → **`expired`** |
| booking | `payment_status` | unchanged (still unpaid) |
| booking_beds | rows | **deleted** |
| payments (unpaid) | `status` | `draft` / `checkout_created` / `pending` → **`expired`** |
| Stripe Checkout session | — | not cancelled via Stripe API in v1 (see open Q); app ignores expired drafts |

Contract choice **`expired`** (not `cancelled`) so staff cancel remains a distinct human action. Historical “→ cancelled” wording maps to terminal removal from inventory; PG enum `expired` is the precise fit.

### Beds / locking

- Release under the same `SELECT … FOR UPDATE` on the booking row before delete.
- Classic soft holds have zero beds → DELETE is a no-op.
- Demo/bot holds that received beds must release them or they zombie-block inventory.

### Concurrent Stripe payment

| Timing | Required behavior |
|--------|-------------------|
| Payment truth applied **before** expire lock | Unpaid proof fails → skip expire |
| Expire commits, then Stripe webhook arrives | **Payment wins:** do not leave guest paid+expired. Phase 3C Stripe path must either revive (`expired` → `confirmed` when paid) **or** refuse Checkout when already expired. **Staging 27p already blocks expired holds; production webhook currently does not check `hold_expires_at` — that gap is a Phase 3C companion fix, not open-ended.** |
| Both race in parallel | Booking row `FOR UPDATE` serializes expire vs promote; unpaid re-check under lock |

### Revival

- **Automatic:** only via successful Stripe payment truth that explicitly allows revive from `expired` (companion Stripe policy).
- **Staff:** may cancel/recreate or manual status fix; guest cannot “unexpire” via a new soft hold for the same slot without creating a new booking.

### Idempotency / retries

- Predicate `status = 'hold' AND hold_expires_at < NOW()` → second run finds nothing.
- Audit may emit one event per successful transition; retries must not spam guest/staff messages (there are none).
- Dry-run lists candidates without writes; live run returns counts only.

### Tenant / location

- Every select/update must filter `client_id` (required).
- When `location_id` is set on the booking, preserve and filter by it in the job batch.
- Never cross-client expire.

### Never expire automatically

- `confirmed`, `checked_in`, `cancelled`, `blocked`, `needs_review` (unless separately specified)
- Any booking with paid / deposit_paid money truth
- Staff/bot creations that are already `confirmed` with beds (not soft holds)
- Sunset / non-Wolfhouse tenants unless that client opts into the same job with its own config

### Dry-run / rollback evidence (required before live expire)

Dry-run output per candidate:

- `booking_id`, `booking_code`, `client_id`, `location_id`
- `hold_expires_at`, `expired_minutes_ago`
- `payment_status`, unpaid payment ids/statuses
- `bed_count` to delete
- `would_status` = `expired`

Rollback evidence:

- Pre-change snapshot of booking row + bed ids + payment ids (audit payload or companion table)
- Ability for operator to restore `status=hold` + re-insert beds only via **manual staff recovery** (v1 does not auto-rollback)

### External scheduler (eventual owner)

**Not n8n.** Prefer the same pattern as staff automated notifications:

- Pure module + CLI runner (e.g. `node scripts/run-booking-hold-expiry.js`)
- Invoked by Azure Container Apps Job / cron / GitHub scheduled workflow with secrets
- Defaults: `WHATSAPP_DRY_RUN`-irrelevant (no sends); job-level `--dry-run` / `--live`

---

## Race-condition analysis

1. **Paid after wall-clock TTL, before expire worker** — Webhook can confirm; worker must skip. Mitigation: unpaid proof under `FOR UPDATE`.
2. **Expire then pay** — Production webhook ignores TTL today → paid+expired possible. Mitigation (3C): Stripe path checks status; revive or reject.
3. **Beds reassigned after expire, then late pay** — physical conflict. Mitigation: revive only with re-availability check or staff Needs Review.
4. **`payment_pending` + open Checkout past `hold_expires_at`** — v1 does not expire these; link may still work. Separate phase for Checkout session expiry alignment with `payment_link_expiry_hours` (baseline 6h).
5. **TTL skew 1h vs 6h** — worker uses stored timestamp; wrong TTL on create is a create-path bug, not expire-path.

---

## Unresolved questions (block fully closed product policy, not the contract skeleton)

1. Unpaid payment terminal: payments.`expired` vs `cancelled` (enum already has `expired` on payments in init migration — confirm usage).
2. Should v1 call Stripe API to expire open Checkout sessions?
3. Does `payment_pending` ever auto-expire in v2?
4. Revive rules after expire+pay: auto-confirm vs Needs Review if beds gone.
5. Config unification of baseline 6h vs Main 1h / pricing.json 60m (create path).
6. Exact historical n8n node mutation (Airtable `Expired` vs Cancelled) — workflow JSON absent.

---

## Proposed Phase 3C implementation files (not created here)

| File | Role |
|------|------|
| `scripts/lib/booking-hold-expiry.js` | eligibility, unpaid proof, dry-run + live txn |
| `scripts/run-booking-hold-expiry.js` | CLI `--dry-run` / `--live` / `--client=` |
| `scripts/verify-booking-hold-expiry.js` | unit/fixture tests for txn |
| Companion Stripe edit (operator-owned) | `hold_expires` / revive policy in webhook truth path |
| Optional TTL unify | `main-booking-hold-pg-sql.js`, Luna hold write, pricing/baseline |

Do **not** put business logic back into n8n.

---

## Smallest safe Phase 3C implementation slice

1. **Dry-run CLI only** listing candidates via existing `getExpiredHoldsQuery` + unpaid proof (no writes).
2. Then **live expire for `status=hold` + unpaid + zero or any beds delete**, scoped to one client, with audit event, **no messaging**.
3. Separately: Stripe unpaid/expired hold policy alignment (block or revive) — smallest companion PR after (2) soaks.

Do not combine TTL create-path unification, payment_pending expiry, or Stripe session cancel API into the first live slice.

---

## Offline guard

`node scripts/verify-n8n-hold-expiry-contract.js` checks that this document exists and that current-repo invariants still match the contract’s premises (detection query present, expire worker absent, TTL skew documented in sources, Stripe hold→confirmed + staging hold_expired gate both present).
