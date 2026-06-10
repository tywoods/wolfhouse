# Stage 28e — Staging WhatsApp Guest Playground

**Status:** **OPERATING MODEL** (docs only — 2026-06-10)  
**Parent:** [STAGE-28C3-META-STAFFAPI-OPEN-DEMO-BOOKING-PATH.md](STAGE-28C3-META-STAFFAPI-OPEN-DEMO-BOOKING-PATH.md) · [STAGE-28A-REAL-PHONE-STAGING-REHEARSAL.md](STAGE-28A-REAL-PHONE-STAGING-REHEARSAL.md)  
**Next:** **Stage 28f** — tiny cleanup script for staging test bookings by `booking_code` or phone

---

## 0. What this is

A **repeatable staging playground** so Ty can text the demo WhatsApp number as a guest, exercise Luna through real Meta inbound, create staging bookings, inspect Staff Portal behavior, and clean up test data — **without** production traffic, live confirmations, live Stripe, or n8n activation.

| In scope | Out of scope |
|----------|--------------|
| Real handset → Meta → Staff API open-demo path | Production / Main |
| Short, explicit test windows (write / payment / preview) | Broad Staff Portal UI changes |
| Stripe **TEST** only when gate is on | Live Stripe (`sk_live_`) |
| Confirmation **preview** dry-run | WhatsApp confirmation send (default blocked) |
| Script/harness cleanup plan | n8n activation (unless explicitly needed later) |

**Hard rules:** default safe gates stay on; each window is opened with explicit intent and **rolled back immediately** after proof or failure.

---

## 1. What is proven (anchors)

| Stage | Result | Anchor |
|-------|--------|--------|
| **28c.7** | **PASS** — real handset `+491726422307` → Meta → Staff API → hold + draft payment + bed assign + calendar | `WH-G27-3888294D42` · `DEMO-R1-B1/B2` · Jul 24–31, 2026 |
| **28d** | **PASS** — existing booking → Stripe TEST checkout → real webhook `deposit_paid` → confirmation preview ready | Same booking · no confirmation sent · no WhatsApp payment link |

**Architecture in use:** Meta Cloud API → `POST /staff/meta/whatsapp/webhook` (Staff API brain) → `executeOpenDemoWhatsAppInbound` — **not** n8n. See [28c.3](STAGE-28C3-META-STAFFAPI-OPEN-DEMO-BOOKING-PATH.md).

**Staging surfaces:**

| Item | Value |
|------|-------|
| Staff API | `https://staff-staging.lunafrontdesk.com` |
| Meta callback | `https://staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook` |
| Demo WhatsApp | `+34 663 43 94 19` |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | `1152900101233109` |
| Proof phone (Ty) | `+491726422307` |

---

## 2. Default safe baseline (always restore here)

```
WHATSAPP_DRY_RUN=true
OPEN_DEMO_WHATSAPP_ENABLED=true
OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false
OPEN_DEMO_BOOKING_WRITES_ENABLED=false
OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST unset (removed)
STRIPE_LINKS_ENABLED=false          # unless payment window explicitly needs it
STAFF_ACTIONS_ENABLED=false         # unless payment/cleanup window needs staff routes
n8n workflows: inactive
```

**Never leave** `WHATSAPP_DRY_RUN=false`, write/link gates `true`, or confirmation allowlist set outside an approved window.

Azure restore (Staff API `wh-staging-staff-api`):

```powershell
az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg `
  --set-env-vars WHATSAPP_DRY_RUN=true OPEN_DEMO_WHATSAPP_ENABLED=true `
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false OPEN_DEMO_BOOKING_WRITES_ENABLED=false `
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID=1152900101233109
```

---

## 3. Playground test windows

Enable **one window at a time**. Meta path never auto-enables Stripe links, payment-link WhatsApp, or confirmation send.

### Window 1 — Booking-write test

**Goal:** Multi-turn guest intake → hold + draft payment + demo bed assignment + calendar block.

| Gate | Value |
|------|-------|
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` **only during window** |
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| n8n | **inactive** |

**Pre-window:**

1. `curl https://staff-staging.lunafrontdesk.com/healthz` → **200**
2. Confirm Meta callback points at Staff API staging webhook (not production, not inactive n8n-only URL)
3. **Owner demotion** if using `+491726422307` (see §9)
4. **Date pre-check:** chosen window must have **pricing season** + **≥2 free demo beds** (e.g. Jul 24–31 summer, or Nov 10–17)
5. Set `OPEN_DEMO_BOOKING_WRITES_ENABLED=true` on `wh-staging-staff-api`; wait ~12s for revision env

**During:** Send scripted turns from handset (§4). Poll DB or Staff Portal — live WhatsApp replies are **not** required for write proof.

**Post-window:** Rollback §7 immediately; restore owner row if demoted.

### Window 2 — Payment test

**Goal:** Stripe TEST checkout link from an existing hold/draft → Ty completes TEST card → payment truth (`deposit_paid`).

**Prerequisite:** Booking from Window 1 (or prior anchor) with `payment_draft_id`, beds assigned, `payment_status` not yet `deposit_paid` (or reuse paid booking only for preview).

| Gate | Value |
|------|-------|
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `true` **only during window** |
| `STRIPE_LINKS_ENABLED` | `true` |
| `STAFF_ACTIONS_ENABLED` | `true` (simulator / staff routes) |
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| Stripe key | **`sk_test_` only** — verify Key Vault before window |

**During:** Create link via staff bot route (§5). Open checkout URL on handset/browser; pay with Stripe test card `4242 4242 4242 4242`. **Do not** approve WhatsApp payment-link send unless separate explicit GO.

**Post-window:** Rollback Stripe gates §7. **Do not** undo `deposit_paid` unless explicitly asked (§8).

### Window 3 — Confirmation preview

**Goal:** Generate confirmation preview message/draft after `deposit_paid`; **no send**.

| Gate | Value |
|------|-------|
| All write/Stripe gates | **false** (baseline §2) |
| `WHATSAPP_DRY_RUN` | `true` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **unset** |

**During:** Call confirmation preview endpoint (§6). Verify `confirmation_sent_at` null, `sends_whatsapp: false`.

**Live send** requires a **separate** approval: `WHATSAPP_DRY_RUN=false` + allowlist + `confirm_send:true` — **not** part of default playground.

---

## 4. Three-turn booking test (Window 1)

**Phone:** `+491726422307` (demote owner — §9)  
**Dates:** Prefer **2026-07-24 → 2026-07-31** (proven) or **2026-11-10 → 2026-11-17** after calendar pre-check  
**Package:** Malibu · **2 guests** · **Deposit**

Send exactly (one message per turn; wait for Meta delivery between turns):

1. `Hi, we are 2 people interested in the Malibu package`
2. `July 24 to July 31` *(or chosen window)*
3. `Deposit is fine`

**Poll after each turn** — `guest_message_events` / `conversations.metadata.guest_context` for proof phone:

```sql
-- Example: latest open-demo result for proof phone (staging DB)
SELECT gme.created_at, gme.normalized->'open_demo_result' AS result
  FROM guest_message_events gme
  JOIN conversations c ON c.id = gme.conversation_id
 WHERE c.guest_phone IN ('+491726422307', '491726422307')
 ORDER BY gme.created_at DESC LIMIT 5;
```

**Turn 3 expected (write window):**

| Check | Expected |
|-------|----------|
| `payment_choice_ready` | `true` |
| `write_status` | `created` |
| `assignment_write_status` | `created` |
| `booking_code`, `booking_id`, `payment_draft_id` | present |
| `calendar_visible_expected` | `true` |
| `guest_email` | `open-demo+491726422307@example.test` (synthesized) |
| `stripe_link_created` | `false` |
| `payment_link_sent` | `false` |
| `confirmation_sent` | `false` |

**Staff Portal:** Inbox thread + Bed Calendar blocks on `DEMO-R1-B1/B2` (or assigned demo beds).

**Harness reference:** `.tmp-stage28c-staff-api-handset-proof.js` / `.tmp-stage28c7-hosted-proof.js` (temp — patterns only).

---

## 5. Stripe TEST link from created booking (Window 2)

**Inputs:** `booking_code`, `booking_id`, `payment_draft_id` from Window 1.

1. Enable payment gates (§3 Window 2).
2. Staff login (staging operator fixture).
3. POST `/staff/bot/guest-simulator-create-stripe-test-link`:

```json
{
  "source": "luna_guest_simulator",
  "confirm_simulator_stripe": true,
  "confirm_stripe_test_link": true,
  "payment_draft_id": "<uuid>",
  "booking_id": "<uuid>",
  "booking_code": "WH-G27-…"
}
```

**Expected:** `stripe_link_created: true` or `stripe_link_status: reused`, `stripe_mode: test`, `checkout_url` + `stripe_checkout_session_id`, `payment_link_sent: false`, `sends_whatsapp: false`.

**Human step:** Open `checkout_url`; complete TEST payment.

**Harness reference:** `.tmp-stage28d-hosted-proof.js` (`STEP=link` pauses for checkout; `STEP=truth` verifies payment).

---

## 6. Verify webhook payment truth

After TEST checkout completes, prefer **real** staging webhook path:

1. Stripe TEST `checkout.session.completed` → `POST /staff/stripe/webhook` (signed)
2. Poll booking:

```sql
SELECT booking_code, status::text, payment_status::text,
       amount_paid_cents, balance_due_cents, confirmation_sent_at
  FROM bookings WHERE booking_code = 'WH-G27-3888294D42';
```

**Expected (28d anchor):** `payment_status = deposit_paid`, `amount_paid_cents = 20000`, `confirmation_sent_at` null.

**Fallback:** If webhook delayed, harness may apply truth via `runGuestStripePaymentTruthApplyApproved` (28d proof) — document method as `webhook-real` vs `harness-applied`. **Do not** revert paid truth during normal cleanup.

**Generate confirmation preview** (Window 3 — baseline gates):

```http
POST /staff/bot/bookings/confirmation-preview
```

```json
{
  "booking_code": "WH-G27-3888294D42",
  "booking_id": "<uuid>",
  "client_slug": "wolfhouse-somo"
}
```

**Expected:** `preview_ready: true`, message includes booking code, deposit €200, balance, `DEMO-R1`, gate `2684#`, `sends_whatsapp: false`, `confirmation_sent_at` null.

---

## 7. Rollback checklist (after every window)

- [ ] `OPEN_DEMO_BOOKING_WRITES_ENABLED=false`
- [ ] `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false`
- [ ] `STRIPE_LINKS_ENABLED=false`
- [ ] `STAFF_ACTIONS_ENABLED=false` (unless other staged work needs it)
- [ ] `WHATSAPP_DRY_RUN=true`
- [ ] `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false`
- [ ] `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` unset
- [ ] Owner `staff_phone_access.is_active=true` restored if demoted (§9)
- [ ] n8n `stage27demoLWrite01` (and related) **inactive**
- [ ] Meta callback remains Staff API staging webhook
- [ ] Record session log: `booking_code`, gates before/after, payment session id, preview HTTP status

---

## 8. Cleanup / reset checklist (script-first)

Prefer harness/SQL over Staff Portal UI. **Staging only** — never run against production.

### 8.1 List Luna-created staging test bookings

```sql
SELECT b.booking_code, b.id::text AS booking_id, b.phone, b.email,
       b.check_in::text, b.check_out::text, b.status::text,
       b.payment_status::text, b.created_at::text
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
 WHERE c.slug = 'wolfhouse-somo'
   AND (b.phone IN ('+491726422307', '491726422307')
        OR b.email LIKE 'open-demo+%@example.test'
        OR b.booking_code LIKE 'WH-G27-%')
 ORDER BY b.created_at DESC
 LIMIT 20;
```

Filter by date/status as needed before cancel.

### 8.2 Cancel / expire hold by `booking_code`

When `STAFF_ACTIONS_ENABLED=true` (short cleanup window only):

- `POST /staff/bookings/cancel` with `client_slug` + `booking_id` — cancels booking and **deletes `booking_beds`** (frees calendar). No Stripe refund, no WhatsApp.

For unpaid holds only. **Skip** or use read-only archive if `payment_status` is `deposit_paid` / `paid` unless owner explicitly requests paid-booking teardown.

### 8.3 Cancel draft payments (unpaid only)

```sql
-- Inspect first
SELECT id::text, status::text, amount_due_cents, stripe_checkout_session_id
  FROM payments WHERE booking_id = $1::uuid;

-- Manual cleanup (unpaid draft / checkout_created only — not paid)
UPDATE payments SET status = 'cancelled'
 WHERE booking_id = $1::uuid AND status IN ('draft', 'checkout_created');
```

### 8.4 Free beds / calendar

Bed release is handled by booking cancel (`DELETE booking_beds`). Verify:

```sql
SELECT COUNT(*) FROM booking_beds WHERE booking_id = $1::uuid;
```

### 8.5 Conversations (optional trim)

List recent open-demo threads:

```sql
SELECT c.id::text, c.guest_phone, c.updated_at,
       c.metadata->'guest_context'->>'booking_code' AS ctx_booking
  FROM conversations c
 WHERE c.guest_phone IN ('+491726422307', '491726422307')
 ORDER BY c.updated_at DESC LIMIT 10;
```

Conversation rows may be left for audit; cleanup focus is bookings/beds/payments.

### 8.6 Paid bookings

**Do not** undo real webhook-paid `deposit_paid` status unless explicitly asked. For paid anchors used in preview tests, leave payment truth intact; cancel only **unpaid** holds blocking calendar.

---

## 9. Known gotchas

| Gotcha | Mitigation |
|--------|------------|
| **Owner phone routing** | `+491726422307` in `staff_phone_access` with `is_active=true` routes to **owner command center**, not guest open-demo. Demote: `UPDATE staff_phone_access SET is_active=false WHERE phone_normalized='491726422307'`. Restore after test. |
| **Date + pricing season** | Dates must fall in a configured season (e.g. summer for July). Wrong season → quote/hold failure. |
| **≥2 free demo beds** | 2-guest Malibu needs 2 assignable demo beds; pre-check Bed Calendar / occupancy SQL before window. |
| **`guest_email` synthesis** | Meta does not supply email; adapter sets `open-demo+{digits}@example.test`. Required for hold write (28c.6). |
| **Live replies not required** | `WHATSAPP_DRY_RUN=true` blocks outbound WhatsApp; multi-turn context still persists via open-demo review path. |
| **No confirmations by default** | Preview only; live send needs separate allowlist + `WHATSAPP_DRY_RUN=false` GO. |
| **n8n inactive** | Playground uses Staff API Meta path; do not activate n8n for routine guest tests. |
| **Stripe TEST only** | Abort if Key Vault `stripe-secret-key` is not `sk_test_`. |
| **Duplicate bookings** | Same phone + dates may idempotency-reuse; check existing holds before a new Window 1. |

**Owner demotion one-liner** (temp pattern — Stage 28f may formalize):

```javascript
// .tmp-stage28c-demote-owner.js pattern
UPDATE staff_phone_access SET is_active=false
 WHERE client_slug='wolfhouse-somo' AND phone_normalized='491726422307';
```

---

## 10. Optional script proposal (not built in 28e)

**`scripts/report-open-demo-playground-state.js`** — read-only report for pre-flight and post-session audit:

| Section | Source |
|---------|--------|
| Current gates | `az containerapp show` env on `wh-staging-staff-api` |
| Meta callback | Graph API `webhook_configuration` for phone id `1152900101233109` |
| n8n active/inactive | `workflow_entity.active` for `stage27demoLWrite01` (+ m/n if needed) |
| Owner status `+491726422307` | `staff_phone_access.is_active` |
| Recent open-demo conversations | `conversations` by guest phone |
| Recent Luna-created bookings | `bookings` filter §8.1 |
| Draft/paid payments | `payments` for those bookings |
| Outstanding holds | `status=hold` |
| Calendar blocks | `booking_beds` joined to demo room codes |

Exit `0` with JSON; no writes. **Implement in Stage 28f** alongside cleanup-by-`booking_code`.

---

## 11. Recommended next patch

**Stage 28f** — tiny cleanup script:

- `scripts/cleanup-open-demo-staging-booking.js`
- Args: `--booking-code WH-G27-…` or `--phone +491726422307`
- Actions: list → confirm unpaid hold → cancel booking → release beds → cancel draft payments
- Flags: `--dry-run` default; `--include-paid` requires explicit second flag
- Pair with `report-open-demo-playground-state.js` from §10

---

## 12. Related verifiers (static / prior stages)

```bash
npm run verify:stage28c3-meta-staffapi-open-demo-booking-path
npm run verify:stage28a-real-phone-rehearsal
npm run verify:stage27q-confirmation-preview
npm run verify:stage27o-stripe-test-link
```

No new verifier in 28e — operating model is docs-only.
