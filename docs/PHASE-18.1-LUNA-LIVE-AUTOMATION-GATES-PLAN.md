# Phase 18.1 — Luna Live Guest Automation Gate Plan

**Status:** PASS — Phase 18f closeout (`verify:luna-agent-phase18-closeout`). **Draft-only + eligibility layer complete. No live send.**
**Parent:** Phase 18 — move from inactive shadow/intake comparison into controlled guest automation.
**Prior:** Phase 17c shadow comparison closeout (`20ba4b0`), Phase 17a–17b plan + canonical harness, Phase 16 inactive n8n intake shadow, Phase 15 multilingual intake, Phase 14 confirmation gates, Phase 13 gated writes, Phase 12 dry-run, Phase 11 Ask Luna ops.
**Next:** Phase 19 — staff shadow review / allowlisted test mode planning (no live send without gates).

**Non-negotiables (18a):** No runtime code changes (beyond this doc + verifier). No n8n activation. No WhatsApp sends. No DB writes. No booking creation. No payment rows. No Stripe. No migrations. No deploy. No production data.

**Architecture (unchanged):**

- **Staff API is the brain**; n8n is only the WhatsApp message pipe.
- Live WhatsApp remains **NO_GO** (Stage 7.8 gate) until explicit go-live gates.
- Automation graduates in stages: **shadow draft → allowlisted test → limited live** — never a single flip to full automation.

---

## 0. Go/No-Go framing (read first)

Phases 11–17 built a **read-only brain** (intake → dry-run → preview) and an **inactive pipe** (n8n shadow + canonical comparison). Nothing sends or writes without explicit gates. Phase 18 defines the **controlled path forward**: what can be automated first, what stays blocked, and the gates that must exist before any live guest automation.

The default posture is **draft-only**: Luna produces a staff-reviewable suggested reply; a human copies/sends. No automatic send, write, or payment.

---

## 1. What can be automated first (draft-only, no send/write)

| Capability | Source | Output |
|-----------|--------|--------|
| **Intake preview** | `POST /staff/bot/message-intake-preview` | extraction (deterministic, multilingual) |
| **Dry-run quote/availability** | `runLunaGuestBookingDryRun` (read-only) | quote, availability, gate, missing_fields |
| **ask_next draft** | intake helper `buildAskNext` | localized next-question prompt |
| **handoff draft** | intake helper handoff detection | handoff reason + staff note |
| **Staff-visible suggested reply** | new 18b draft builder | `suggested_reply` text for staff to review/copy |

All of the above are **extraction/preview only** — `no_write_performed: true`, `sends_whatsapp: false`, `creates_booking: false`, `creates_payment: false`, `creates_stripe_link: false`, `calls_n8n: false`.

---

## 2. What must remain blocked

- **Live WhatsApp sends** (no Graph API, no Twilio, `WHATSAPP_DRY_RUN` default true).
- **Booking writes without explicit approval** (no `booking-create-from-plan` / `bookings/create` auto-call).
- **Stripe link creation without explicit approval** (no `generate-payment-link` / `create-stripe-link`).
- **Confirmation sends** (no `confirmation_sent_at` write; no `Mark Booking Confirmed`).
- **Paid cancellation / refund / date-change automation** (always handoff to human).
- **n8n production activation** (workflows stay `active: false`).

---

## 3. Gates required before any live guest automation

| Gate | Rule | Anchor |
|------|------|--------|
| **Live-send gate** | `WHATSAPP_DRY_RUN !== 'false'` ⇒ draft-only; live needs explicit env (future `WHATSAPP_LIVE_SENDS_ENABLED`) | Phase 14c |
| **Bot pause gate** | `bot_paused === false` AND `live_send_blocked === false` | `bot_pause_states` / `check-guest-automation-gate` |
| **Stage 7.8 owner approval** | Owner sign-off required before any live send/activation | Stage 7.8 |
| **Staff approval / explicit confirm** | Booking/payment writes require explicit staff `confirm` (Phase 13 eligibility) | Phase 13 write gates |
| **Idempotency keys** | All write attempts carry `idempotency_key` | Phase 13 |
| **Audit log** | Every automated action logged (who/what/when, draft vs send) | new in 18+ |
| **Kill switch** | Single flag instantly returns to draft-only / pause | bot pause + env |
| **Fallback / handoff on ambiguity** | Low confidence, refund/cancel, human request ⇒ handoff, never auto-act | intake handoff |

**All gates must pass simultaneously** for any live action. Any single gate false ⇒ draft-only.

---

## 4. First operational mode (recommended)

**Staff Portal / n8n shadow mode (draft-only):**

```
inbound message → Staff API intake → dry-run → Luna draft → staff reviews/copies manually
```

- **No live send.** Staff manually sends the reviewed reply.
- n8n shadow workflow stays `active: false`; runs via manual editor execute or Staff Portal helper.
- Luna output is advisory: `suggested_reply` + `next_action` + safety flags.

---

## 5. First limited live mode (later, not now)

- **Allowlisted test numbers only** (explicit phone allowlist; no real guests).
- **No real guests.**
- **No automatic booking writes.**
- **No automatic Stripe links.**
- **No confirmation sends.**
- Requires: live-send env + Stage 7.8 + bot pause gate green + audit log + kill switch verified.

---

## 6. Phase 18b — first implementation (recommended)

- **Inactive** n8n workflow OR Staff Portal helper that turns intake + dry-run result into a **staff-reviewable Luna draft**.
- **No send. No write.**
- Returns:
  - `message_text` (inbound, echoed)
  - `extraction`
  - `dry_run_plan`
  - `suggested_reply` (draft text for staff)
  - `next_action`
  - safety flags (`no_write_performed`, `sends_whatsapp:false`, `creates_*:false`, `calls_n8n:false`, `preview_only`, `live_send_blocked:true`)
- Add `verify:luna-agent-phase18-draft-builder` when implemented.

---

## 7. Verifiers that must protect this

A Phase 18 draft builder must statically prove it:

- **cannot send WhatsApp** (no Graph API / Twilio / `sendWhatsApp`).
- **cannot activate workflow** (no n8n activation endpoint; `active:false`).
- **cannot call booking-create-from-plan** (no write bridge auto-call).
- **cannot create Stripe link** (no `generate-payment-link` / `create-stripe-link`).
- **cannot call webhook** (no `/staff/stripe/webhook`).
- **cannot update confirmation_sent_at** (no confirmation write).
- **must preserve `no_write_performed`** (true in all outputs).
- **must handoff refunds/cancellations** (`handoff_required: true`).
- **must only draft, not send** (`suggested_reply` present; `sends_whatsapp:false`).

---

## 8. Safety proof (18a)

- This slice adds only a **doc** + a **fast static verifier**. No runtime/route/helper change.
- No n8n activation; shadow workflow stays `active: false`.
- No WhatsApp send, no Stripe, no DB write, no booking/payment rows, no migration, no deploy.
- Live WhatsApp remains **NO_GO** (Stage 7.8).

---

## 9. Stop conditions

Stop and report before proceeding if any 18b step would:

- **send** WhatsApp (live or via Graph/Twilio),
- **activate** any n8n workflow,
- **write** DB rows, create bookings/payments, or set `confirmation_sent_at`,
- **call** booking-create-from-plan / payment-link / create-stripe-link / Stripe webhook,
- **auto-act** on refund/cancellation/date-change instead of handoff,
- turn this plan into **implementation** rather than a draft-only reviewable helper.

---

## 10. Phase map

| Phase | Deliverable | State |
|-------|-------------|-------|
| 11 | Staff Ask Luna ops queries | DONE |
| 12 | Luna dry-run booking orchestrator | DONE |
| 13 | Gated booking/payment writes | DONE |
| 14 | Confirmation preview/gates | DONE |
| 15 | Multilingual Staff API intake | DONE |
| 16 | Inactive n8n intake shadow | DONE (superseded by 18e for draft path) |
| 17 | Canonical shadow comparison harness | DONE (`20ba4b0`) |
| 18a | Live guest automation gate plan + static verifier | DONE (`079758a`) |
| 18b | Staff-reviewable Luna draft builder + route | DONE (`4011221`) |
| 18b.1 | Hosted guest-reply-draft route proof | PASS (`4011221`) |
| 18c | Auto-reply send eligibility helper | DONE (`36d276f`) |
| 18d | Draft route returns `send_eligibility` | DONE (`7fc47ad`) |
| 18d.1 | Hosted send_eligibility proof | PASS (`7fc47ad`) |
| 18e | Inactive n8n shadow → guest-reply-draft | DONE (`c57523e`) |
| 18e.1 | Hosted n8n shadow proof | **ACCEPTED WITH WAIVER** (see §11) |
| **18f** | **Phase 18 closeout verifier + doc** | **THIS SLICE** |
| 19+ | Staff shadow review / allowlisted test (gated) | NEXT |

**Live WhatsApp:** NO_GO until all Section 3 gates pass + Stage 7.8 owner approval.

---

## 11. Phase 18e.1 hosted proof waiver (18f)

18e.1 accepted with waiver: workflow import/static/simulated chain passed; Case C editor output confirmed /staff/bot/guest-reply-draft; A/B editor execution IDs were not captured due manual n8n editor friction. Owner accepted as non-blocking. Live WhatsApp remains NO_GO.

| Proof slice | Verdict | Notes |
|-------------|---------|-------|
| 18b.1 hosted route | **PASS** | `POST /staff/bot/guest-reply-draft` A/B/C on staging Staff API |
| 18d.1 hosted eligibility | **PASS** | `send_eligibility` on draft route A/B/C |
| 18e.1 n8n import/static | **PASS** | Workflow re-import, safety checks, inactive |
| 18e.1 simulated chain A/B/C | **PASS** | Parse → guest-reply-draft → Map |
| 18e.1 n8n editor runtime (A/B) | **WAIVER** | Clean execution IDs not captured (sign-in + webhook-test friction) |
| 18e.1 n8n editor runtime (C) | **CONFIRMED** | Case C editor output hit guest-reply-draft endpoint |

Closeout **does not claim full n8n runtime proof for all cases.**

---

## 12. Phase 18 capabilities (18f closeout)

| Capability | Route / artifact | Send now? |
|------------|------------------|-----------|
| Guest reply draft | `POST /staff/bot/guest-reply-draft` | No — draft-only |
| Suggested reply text | `suggested_reply` on draft response | No — staff review |
| Future auto-reply eligibility | `send_eligibility` classifier | No — `auto_send_ready: false` while gates off |
| ask_missing_field eligible later | `allowed_send_kind: ask_missing_field` | Later only, gated |
| show_quote eligible later | `allowed_send_kind: show_quote` | Later only, gated |
| Refund/handoff / risky intent | `requires_staff: true` | Always staff |
| Inactive n8n shadow pipe | `Wolfhouse Booking Assistant - Message Intake Shadow` | No — `active: false` |

---

## 13. Phase 18f safety proof

- Closeout adds **verifier + doc only** — no runtime behavior changes.
- No n8n activation; shadow workflow stays `active: false`.
- No WhatsApp send, no Stripe, no DB write, no booking/payment rows, no migration, no deploy.
- Live WhatsApp remains **NO_GO** (Stage 7.8).
- `auto_send_ready` remains false while `WHATSAPP_DRY_RUN` and live-send gates are off.

---

## 14. Known limitations (18f)

- Full n8n editor runtime proof for cases A/B not captured; waived as non-blocking.
- Simulated chain + hosted Staff API proofs cover draft path behavior.
- Phase 16 closeout verifier superseded by Phase 18e n8n draft-shadow verifier for this workflow shape.

---

## 15. Recommended Phase 19

- **Staff shadow review surface** — read-only list/view of shadow draft results (`suggested_reply` + `send_eligibility`) for ops review.
- **Optional:** close 18e.1 waiver with three manual n8n editor execution IDs when staging access is available.
- **Planning only:** allowlisted test-number live-send mode — requires all Section 3 gates + Stage 7.8; no implementation in Phase 19 unless explicitly scoped.
