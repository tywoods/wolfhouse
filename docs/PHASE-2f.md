# Phase 2f — Booking Flow Router Hardening (local)

**Proposal:** [`PHASE-2f-PROPOSAL.md`](PHASE-2f-PROPOSAL.md)

**Implemented:** 2f.0 (docs) + 2f.1 (resolver + guards) + **2f.2** (Stripe after `booking_flow` hold + payment-link guard). **Not implemented:** one-shot auto-continue (deferred).

---

## Regenerate fork

```powershell
node scripts/build-main-local-stripe.js
```

Re-import `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` into **local n8n only**.

---

## Run tests

```powershell
.\scripts\test-phase2f-routing.ps1 -RunResolverOnly
```

---

## Acceptance (Jamy case)

**Message:**

```text
Hi, we are 2 people, shared room, June 1-3, my name is Jamy, email is jamy@example.com.
```

**On `Code - Booking State Resolver` output:**

| Field | Expected |
|-------|----------|
| `resolved_route` | `booking_flow` |
| `logging.decision_code` | `R2F_FULL_BOOKING_NO_HOLD` |
| `hold_lookup.should_search_hold` | `false` |
| `route_overridden` | `true` (if LLM said `payment_details_provided`) |

**Workflow must not** enter `Search Hold With Guest Details` before a hold exists.

---

## Details-only with existing hold (Tier C.2)

**Message:** `Jamy Garcia jamy@example.com`  
**State:** Prior message created a hold for the same phone (e.g. C.1 full booking). Conversation may be `payment_pending` even if `Code - Pick Active Booking` did not find the hold.

| Field | Expected |
|-------|----------|
| `resolved_route` | `payment_details_provided` |
| `logging.decision_code` | `R2F_PAYMENT_DETAILS_ON_HOLD` (Pick Active found hold) **or** `R2F_PAYMENT_DETAILS_ON_HOLD_LOOKUP` (conversation hold hint / `payment_pending` stage) |
| `hold_lookup.should_search_hold` | `true` |

Path continues through **Search Hold With Guest Details** → Update Hold With Guest Details → Stripe (2c).

**Resolver v2f.4:** Contact-only + no Pick Active hit no longer forces `R2F_CONTACT_NO_HOLD` when `Current Hold ID` / session hold id exists or conversation stage is `payment_pending` / `booking_flow`. `Create/update Conversation - Payment Pending` now persists `Current Hold ID` after C.1.

---

## Phase 2f.2 — Stripe after full first-message booking

When `booking_flow` creates a hold and guest contact is already known (`staged_contact.apply_after_hold` or `has_guest_details`):

1. `Code - Summarize Holds` → `IF - Apply Stripe After Hold`
2. `Update Booking Hold - Apply Staged Contact` → `Code - Prepare Stripe Payment Context`
3. Same 2c chain: Ensure Booking In Postgres → Create Payment Session → Update Airtable Payment Link
4. `Update Conversation - Guest Details` → `Code - Summarize Payment Pending` → … → `Reply - Payment Pending`

`IF - Payment Link Safe For Reply` blocks `booking-payment-placeholder` when `USE_STRIPE_CHECKOUT=true` and routes to `Code - Stripe Payment Fallback Reply` instead.

### Acceptance (Sammy / Paul case) — verified local 2026-05-25

**Message (example):**

```text
Hi, we are 2 people looking for a shared room from June 1 to June 3. My name is Sammy and my email is samy@example.com
```

| Check | Expected | Verified |
|-------|----------|----------|
| `resolved_route` | `booking_flow` | yes |
| `staged_contact.apply_after_hold` | `true` | yes |
| Hold created | yes | yes |
| Stripe nodes executed | Ensure Booking, Create Payment Session, Update Payment Link | yes |
| Airtable Payment Link | `checkout.stripe.com` | yes |
| Final reply | real Stripe URL, **no** `booking-payment-placeholder` | yes |

**Note:** Stripe Checkout URLs are long by design. A short redirect (e.g. `https://wolf-house.com/pay/WH-xxxx`) is a **future** local phase — not implemented unless explicitly approved.

### Build fixes baked in (2f.2 post-test)

The generator (`scripts/build-main-local-stripe.js` + `scripts/lib/merged-payment-path.js`) now includes manual fixes from local E2E:

1. **`Code - Booking State Resolver`** — `const RESOLVER_VERSION = '2f.2';` injected (fixes `RESOLVER_VERSION is not defined`).
2. **Merged-path nodes** — no hard refs to `Code - Extract Guest Details` / `Search Hold With Guest Details` on shared nodes; use `$json`, then `Code - Prepare Stripe Payment Context`.
3. **`Code - Summarize Payment Pending`** — safe `safeNodeJson()` + forwards guest/booking fields on `$json`.
4. **`AI - Classify Rooming Info`** — prompt uses `$json.guest_*` / Prepare Context, not Search Hold.
5. **`Create/update Conversation - Payment Pending`** — `Last Bot Reply` from Reply / fallback / outbound (not WhatsApp API `$json.text`); `Pending Action` = `none`; staff flags false; `Bot Mode` = `bot_active`.

---

## If Search Hold returns no rows

Controlled fallback (no silent stop):

- If `message_signals.has_booking_core` → `Parser Node` (booking_flow)
- Else → `Reply - Collect Booking Details`

---

## Optional logging

Set in `infra/.env` (local only):

```env
PHASE2F_LOG_WORKFLOW_EVENTS=false
```

Resolver output in n8n execution is always the source of truth.

---

## Rollback

1. Revert `scripts/build-main-local-stripe.js` / `scripts/lib/booking-state-resolver.js` changes.
2. Regenerate fork without 2f patches.
3. Re-import previous JSON in local n8n.

Hosted exports unchanged.
