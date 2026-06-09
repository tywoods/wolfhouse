# Stage 27demo-a — Open WhatsApp Booking + Stripe TEST Demo Design

**Status:** DESIGN LOCK — docs only (2026-06-09).  
**Stability baseline:** commit **`51977c6`** → image `51977c6-stage27test-t1-pg-pool` (shared Postgres pool; hosted torture **565/565**).  
**Parents:** [STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md](STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md) · [STAGE-27X1-GUEST-INBOUND-REVIEW.md](STAGE-27X1-GUEST-INBOUND-REVIEW.md) · [STAGE-27N-HOLD-PAYMENT-DRAFT-WRITE.md](STAGE-27N-HOLD-PAYMENT-DRAFT-WRITE.md) · [STAGE-27O-STRIPE-TEST-LINK.md](STAGE-27O-STRIPE-TEST-LINK.md) · [STAGE-27P-STRIPE-PAYMENT-TRUTH.md](STAGE-27P-STRIPE-PAYMENT-TRUTH.md) · [STAGE-27W-LUNA-GUEST-SIMULATOR.md](STAGE-27W-LUNA-GUEST-SIMULATOR.md)  
**Verifier:** `npm run verify:stage27demo-a-open-whatsapp-stripe-design`

**Non-negotiables (27demo-a):** No runtime code. No deploy. No production DB. No live Stripe. No production WhatsApp number. No production guest automation. This is an **open demo** on a **staging/test WhatsApp number** connected only to **staging/test data**.

---

## 0. Product decision — open demo, not allowlist

| Decision | Rule |
|----------|------|
| **Who can message** | **Anyone** who has the demo WhatsApp number |
| **No Ty/Ale/Cami allowlist** | Demo gate is **not** a phone allowlist for staff/owners |
| **Protection model** | Demo number routes **only** to staging Staff API + `wolfhouse_staging` DB + Stripe **test** mode |
| **Number lifecycle** | Demo number may be replaced later; design must not hard-code one E.164 in code |
| **Production** | Production automation, production DB, production Stripe, and production WhatsApp remain **OFF** |

---

## 1. Architecture (unchanged)

| Layer | Role |
|-------|------|
| **Meta WhatsApp** | Inbound/outbound transport for the **demo business number** only |
| **n8n** | **Pipe only** — webhook normalize, dedupe, auth to Staff API, optional outbound send when GO'd |
| **Staff API** | **Brain** — gates, 27u orchestrator, availability/quote/pricing, hold/draft write, Stripe TEST link, payment truth, audit |
| **Staff Portal** | **Ops surface** — inbox, Luna review, **Booking Calendar** proof |
| **Stripe TEST** | Checkout + webhook payment truth (`sk_test_` only) |

```
Demo WhatsApp (any sender)
  → Meta webhook
  → n8n inbound demo workflow (pipe)
  → Staff API inbound route(s)
  → 27u orchestrator + gated writes
  → (optional) outbound WhatsApp reply
  → Staff Portal calendar / inbox
  → Stripe TEST checkout (link in WhatsApp)
  → Stripe webhook → payment truth → booking state update
```

---

## 2. WhatsApp inbound path

### 2.1 Flow

1. Guest sends message to **demo WhatsApp business number** (Meta).
2. Meta POST → n8n inbound workflow (staging n8n instance, **single demo workflow**).
3. n8n normalizes payload; **does not** run Luna logic, pricing, or availability.
4. n8n POST → Staff API (authenticated with `X-Luna-Bot-Token` or internal auth as today).
5. Staff API runs inbound handler → `runGuestInboundReviewDryRun` / live orchestrator path (27demo-b+).
6. Staff API persists conversation + inbound message + review artifact (existing 27x.1 patterns).
7. Staff API returns proposed reply + chain state; n8n sends outbound only when live-send gate allows (27demo-c+).

### 2.2 Target Staff API routes (by slice)

| Slice | Route | Mode |
|-------|-------|------|
| **27demo-b** | `POST /staff/bot/guest-inbound-review-dry-run` | Review + persistence; **no outbound send** |
| **27demo-c+** | Live inbound handler (extends review path or dedicated live route) | Orchestrator + **outbound WhatsApp** when gated |
| **Meta direct (existing, not primary)** | `POST /staff/meta/whatsapp/webhook` | Keep for Meta verify; **demo uses n8n pipe** per 27x-lite |

### 2.3 Required payload fields (n8n → Staff API)

Same contract as [STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md](STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md) §1.2:

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | `wolfhouse-somo` (from n8n phone-number-id map, not LLM) |
| `channel` | ✓ | `whatsapp` |
| `message_text` | ✓ | Normalized text |
| `guest_phone` | ✓ | E.164 from Meta `from` |
| `inbound_message_id` | ✓ | Meta `wamid.*` |
| `idempotency_key` | ✓ | `{client_slug}:whatsapp:{wamid}` |
| `received_at` | ✓ | ISO from Meta |
| `conversation_id` | — | Staff API may resolve/create |
| `guest_context` | — | Loaded from DB slim chain |
| `reference_date` | — | Harness override; default from `received_at` |

### 2.4 Conversation mapping

| Key | Rule |
|-----|------|
| Thread | `(client_id, guest_phone)` on `conversations` |
| Idempotency | Replay same `wamid` → same stored review / no double orchestrator |
| Bot pause | `bot_pause_states` + `needs_human` respected (Phase 9) |
| Demo metadata | Tag demo bookings/conversations in metadata where possible (`source: demo_whatsapp`, `demo_run_id`) for cleanup |

---

## 3. Open demo gate (no phone allowlist)

### 3.1 What is ON for demo

| Gate | Demo value | Notes |
|------|------------|-------|
| Demo WhatsApp number | Meta → n8n → staging Staff API | **Only** this number wired to demo workflow |
| `client_slug` | `wolfhouse-somo` | Staging tenant only |
| DB | `wolfhouse_staging` on `wh-staging-pg-app` | **Never** production DB URL |
| Stripe | `sk_test_*` + `STRIPE_LINKS_ENABLED=true` | Already proven on staging |
| Staff API revision | `51977c6-stage27test-t1-pg-pool` or later | Stability baseline |

### 3.2 What stays OFF (production)

| Gate | Production rule |
|------|-----------------|
| `PUBLIC_GUEST_AUTOMATION_ENABLED` | **false** on production |
| Production WhatsApp number | **Not** connected to demo workflow |
| Production Stripe | **Blocked** — refuse `sk_live_*` and `livemode: true` |
| Production DB | **No** demo writes |

### 3.3 Proposed staging env gate (27demo-b implementation)

New env flag (design target — **not set in 27demo-a**):

| Env | Purpose |
|-----|---------|
| `OPEN_DEMO_WHATSAPP_ENABLED` | Master kill switch for demo automation on staging |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | Meta phone-number-id allowlist (demo number only — **not** guest sender allowlist) |
| `WHATSAPP_DRY_RUN` | When `true`, blocks live outbound (current staging default) |
| `BOT_PAUSE_CONTROLS_ENABLED` | Staff can pause Luna per conversation |

**Open demo ≠ guest phone allowlist.** Any sender messaging the **demo business number** is accepted. The **business number** is the boundary.

### 3.4 Kill switches (immediate disable)

| Action | Effect |
|--------|--------|
| Deactivate n8n demo inbound workflow | Stops Meta → Staff API pipe |
| Set `OPEN_DEMO_WHATSAPP_ENABLED=false` | Staff API rejects demo live automation |
| Set `WHATSAPP_DRY_RUN=true` | No live WhatsApp sends (revert staging to current) |
| Set `STRIPE_LINKS_ENABLED=false` | No new Stripe TEST links |
| Set `BOT_BOOKING_ENABLED=false` | No bot hold/draft writes |
| Staff Portal **Pause Luna** | Per-conversation stop; human takeover |

---

## 4. Booking flow for demo

### 4.1 Happy path (multi-turn)

1. **Intake** — Luna collects dates, guest count, package/accommodation intent (27b/27e router).
2. **Availability** — Staff API pricing engine via `runGuestAvailabilityDryRun` (read-only SELECT).
3. **Quote** — `runGuestQuoteProposalDryRun` → deposit/full options; **no payment link in chat yet**.
4. **Payment choice** — Guest chooses deposit or full (27k).
5. **Hold + draft payment write** — `runGuestHoldPaymentDraftWriteDryRunApproved` with `confirm_write: true` (27n); requires guest name/email/phone.
6. **Calendar** — Booking hold appears in Staff Portal **Booking Calendar** (existing `booking_beds` / hold path).
7. **Stripe TEST link** — `runGuestStripeTestLinkCreate` (27o) after hold+draft; link sent on WhatsApp (27demo-e).
8. **Payment truth** — Stripe TEST webhook (27p) updates payment + booking state; Luna **must not** claim payment from chat text alone.
9. **Confirmation** — Optional 27demo-f; gated separately (see §6).

### 4.2 Demo record labeling

| Field | Target |
|-------|--------|
| `bookings.metadata.source` | `demo_whatsapp` or `luna_demo_open` |
| `bookings.metadata.demo_run_id` | Optional correlation UUID |
| Guest name | Prefix optional `Demo Guest` if auto-generated |
| Booking code | Normal `MB-WOLFHO-*` pattern (staging) |

Staff can filter demo rows in calendar by metadata / booking source color (Luna blue) and payment badge.

### 4.3 Writes allowed (demo only)

| Write | Gate |
|-------|------|
| Conversation upsert + inbound review artifact | 27x.1 (proven) |
| Hold + draft payment | `BOT_BOOKING_ENABLED=true` + `confirm_write` + staging env guard |
| Stripe TEST checkout session | `STRIPE_LINKS_ENABLED=true` + `sk_test_*` |
| Payment truth via webhook | Existing Stripe webhook handler |
| **Forbidden** | Production DB, live Stripe, irreversible prod sends |

---

## 5. Outbound WhatsApp policy

### 5.1 Demo goal

Luna sends **live WhatsApp replies** from the **demo business number** to anyone who messages it, once live-send slice is GO'd (27demo-c).

### 5.2 Current staging state (no change in 27demo-a)

| Env | Current | Blocks |
|-----|---------|--------|
| `WHATSAPP_DRY_RUN` | `true` on staging | Live outbound sends |

Code: `whatsappDryRun = process.env.WHATSAPP_DRY_RUN !== 'false'` — live send requires **`WHATSAPP_DRY_RUN=false`** on staging **only** during controlled demo proof.

### 5.3 Future gate change (document only — 27demo-c)

| Step | Action |
|------|--------|
| 1 | Prove inbound pipe with `WHATSAPP_DRY_RUN=true` (27demo-b) |
| 2 | Set `WHATSAPP_DRY_RUN=false` **only on staging** revision during 27demo-c proof window |
| 3 | Keep `OPEN_DEMO_WHATSAPP_ENABLED=true` + demo phone-number-id map |
| 4 | Revert `WHATSAPP_DRY_RUN=true` after proof or on kill switch |

### 5.4 Outbound rules

| Rule | Detail |
|------|--------|
| Demo number only | Outbound sends use demo WABA / phone-number-id |
| No production number | Never send from production WhatsApp assets |
| No payment-received claims | Luna must not say payment received from chat inference |
| Kill switch | `WHATSAPP_DRY_RUN=true` OR deactivate n8n outbound node OR `OPEN_DEMO_WHATSAPP_ENABLED=false` |

---

## 6. Stripe TEST payment behavior

### 6.1 Allowed (staging demo)

| Requirement | Rule |
|-------------|------|
| Stripe key | **`sk_test_` only** — verified on staging |
| `STRIPE_LINKS_ENABLED` | `true` on staging (proven) |
| Checkout mode | TEST — `livemode: false` on session/webhook |
| Link delivery | WhatsApp message **after** hold+draft + quote ready + payment choice |

### 6.2 Forbidden

| Rule | Enforcement |
|------|-------------|
| Live Stripe | Reject `sk_live_*`; reject webhook `livemode: true` for demo path |
| Chat payment claims | Router/safety — no "payment received" without webhook truth |
| Link before readiness | No Stripe link until planner `ready_for_hold_payment_draft` chain complete |

### 6.3 Send sequence (27demo-e)

```
required fields collected
  → availability checked
  → quote ready
  → guest chooses deposit or full
  → hold + draft payment created (27n)
  → Stripe TEST checkout session created (27o)
  → link sent on WhatsApp (gated live send)
  → guest pays in Stripe TEST checkout
  → Stripe webhook → payment truth (27p)
  → booking payment_status updated (deposit_paid / paid)
  → confirmation draft ready (27q)
```

### 6.4 Confirmation send (27demo-f — first demo decision)

| Option | Recommendation for first open demo |
|--------|-------------------------------------|
| **A. Disabled (default)** | Payment truth + Staff Portal proof sufficient; no auto confirmation WhatsApp |
| **B. Enabled with gate** | `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` or new `OPEN_DEMO_CONFIRMATION_SEND=true` |

**Design lock:** First open demo (**27demo-e**) ships **without** auto confirmation send. **27demo-f** adds optional confirmation after explicit GO.

---

## 7. Booking calendar proof

### 7.1 Before Stripe payment

| Field | Expected |
|-------|----------|
| Booking status | `hold` (or active hold equivalent) |
| Payment status | `not_requested` → `draft` / `checkout_created` after link |
| Calendar | Block visible on assigned bed(s); Luna blue source |
| Staff verify | Staff Portal → Booking Calendar → find guest phone / booking code |

### 7.2 After Stripe TEST payment truth

| Field | Expected |
|-------|----------|
| Payment row | `paid` (or deposit_paid per choice) |
| Booking | `payment_status` reflects truth from webhook |
| Calendar badge | Payment badge updates per existing calendar merge |
| Confirmation | Draft ready in drawer; send only if 27demo-f GO'd |

### 7.3 Idempotency / retry

| Case | Behavior |
|------|----------|
| Duplicate `wamid` | Same inbound review; no duplicate hold |
| Duplicate hold write | Idempotency key on write path (27n patterns) |
| Stripe link retry | Return existing unpaid checkout if valid |
| Webhook replay | Idempotent payment truth (27p proven) |

### 7.4 Demo cleanup

| Method | Notes |
|--------|-------|
| Staff Portal cancel | Cancel unpaid hold via existing cancel flow |
| SQL cleanup (staging) | Delete demo bookings by `metadata->>'source' = 'demo_whatsapp'` — **staging ops only** |
| Conversation clear | Existing clear-messages / admin delete conversation tools |

---

## 8. Safety and rollback

### 8.1 Disable demo immediately

```text
1. Deactivate n8n workflow "Open Demo WhatsApp Inbound" (Meta webhook stop)
2. az containerapp update … --set-env-vars OPEN_DEMO_WHATSAPP_ENABLED=false WHATSAPP_DRY_RUN=true
3. Optional: STRIPE_LINKS_ENABLED=false BOT_BOOKING_ENABLED=false
4. Staff Portal: Pause Luna on active demo conversations
```

### 8.2 Env var reference

| Env | Stops |
|-----|-------|
| `OPEN_DEMO_WHATSAPP_ENABLED=false` | Demo automation path |
| `WHATSAPP_DRY_RUN=true` | Live WhatsApp replies |
| `STRIPE_LINKS_ENABLED=false` | New Stripe TEST links |
| `BOT_BOOKING_ENABLED=false` | Bot hold/draft writes |
| n8n workflow inactive | All Meta ↔ Staff API traffic |

### 8.3 Data boundaries

| Boundary | Rule |
|----------|------|
| DB | `wh-staging-pg-app` / `wolfhouse_staging` only |
| Stripe | TEST mode only |
| WhatsApp | Demo business number only |
| Production | No env overlap; no prod secrets on staging revision |

---

## 9. Abuse / spam considerations (minimal)

| Guardrail | Notes |
|-----------|-------|
| Meta rate limits | Primary backpressure |
| Bot pause / human takeover | Staff can stop automation per thread |
| Off-topic / angry lanes | Existing router → safe reply or handoff |
| Audit logs | Staff API audit + `LUNA_REVIEW_DRY_RUN_ERROR` / inbound audit |
| Kill switch | n8n + env (§8) |
| No overbuild | No CAPTCHA, no guest blocklist in v1 |

Optional later: soft daily cap per `guest_phone` in demo metadata (not in 27demo-a scope).

---

## 10. Implementation sequence

| Stage | Scope | Live send | Writes | Stripe |
|-------|-------|-----------|--------|--------|
| **27demo-b** | n8n inbound pipe → Staff API review; persistence | **No** (`WHATSAPP_DRY_RUN=true`) | Review artifact only | No |
| **27demo-c** | Open demo live reply from demo number | **Yes** (staging window) | No booking write | No |
| **27demo-d** | Hold + draft write; calendar proof | Yes | Hold + draft | No link yet |
| **27demo-e** | Stripe TEST link on WhatsApp + payment truth | Yes | + checkout | TEST only |
| **27demo-f** | Optional confirmation after payment truth | Yes | No new writes | No |
| **Production launch** | Explicit GO much later | Prod gates | Prod DB | Live Stripe separate program |

Each slice: verifier + hosted proof + rollback doc update.

---

## 11. Proven baseline (do not regress)

| Proof | Result |
|-------|--------|
| Hosted torture | **565/565** (`51977c6-stage27test-t1-pg-pool`) |
| Hosted golden | **139/139** |
| Hosted booking-core | **26/26** |
| Shared Postgres pool | ETIMEDOUT eliminated |
| Luna Guest Simulator | Hold + draft + Stripe TEST link (staging) |
| Stripe webhook payment truth | Proven staging |
| Package explainer | Proven golden/torture |

---

## 12. Explicit non-goals (27demo-a)

- No production launch
- No live Stripe
- No production WhatsApp
- No Ty/Ale/Cami guest allowlist as demo gate
- No runtime code in this design lock
- No n8n/Meta activation in this commit
