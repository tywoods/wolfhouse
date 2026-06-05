# Phase 19.1 — Luna Production Auto-Send Gate Plan

**Status:** PASS — plan doc + static plan verifier (Phase 19a). **No sending implemented in this slice.**
**Parent:** Phase 19 — move from draft-only safe replies (Phase 18) to gated real-client auto-replies in production.
**Prior:** Phase 18f closeout (`5612d69`), Phase 18a–18e draft builder + send-eligibility + inactive n8n draft shadow, Phase 17 shadow comparison, Phase 11–16 brain + intake + dry-run + gated writes.
**Next:** Phase 19b — extend send-eligibility with production gates (default-deny), still no WhatsApp call.

**Non-negotiables (19a):** No runtime send code. No WhatsApp send. No n8n activation. No DB writes. No booking creation. No payment rows. No Stripe. No migrations. No deploy. No production data.

**Architecture (unchanged):**

- **Staff API is the brain and the send gate**; n8n is only the WhatsApp message pipe.
- Live WhatsApp remains **NO_GO** until every Section 4 gate is implemented and green.
- Automation graduates in stages: **draft-only → gated eligibility (compute-only) → default-deny send route → staging real-contact proof → limited production** — never a single flip to full automation.

---

## 0. Go/No-Go framing (read first)

Phase 18 produced a **draft-only brain**: `POST /staff/bot/guest-reply-draft` returns `suggested_reply`, `next_action`, and `send_eligibility` with `auto_send_ready: false` because live-send gates are off. Phase 19 defines the **controlled path to real-client auto-replies**: what scope sends first, what stays staff-required, the gates that must all pass, and the implementation/proof order.

The default posture remains **default-deny**: nothing is auto-sent unless every gate passes simultaneously. Any uncertainty falls back to staff handoff.

**Product direction:** Luna should talk to real clients and handle normal safe booking conversations automatically; staff should only handle risky/unclear/exception cases — but only after the gates below exist and are proven.

---

## 1. First production auto-send scope

| Dimension | Phase 19 first scope |
|-----------|----------------------|
| Audience | **Real client numbers allowed** (no longer test-only) |
| Safe draft kinds | **`ask_missing_field`** and **`show_quote`** only |
| Paid cancellation / refund / date-change | **NOT handled** — staff-required |
| Complaint handling | **NOT handled** — staff-required |
| Unsupported / low-confidence reply | **NOT auto-sent** — staff-required |
| Automatic booking write | **NOT included** unless Phase 13 write gates are explicitly added later |
| Automatic Stripe link | **NOT included** unless payment/link gates are explicitly added later |
| Automatic confirmation send | **NOT included yet** |

Auto-send is **reply-only**: Luna sends the `suggested_reply` text already produced by the Staff API draft route. It performs no writes, no payments, no confirmations.

---

## 2. What Luna should auto-send first

**Allowed safe replies (initial auto-send kinds):**

- **Missing-field questions** (`ask_missing_field`):
  - dates
  - guests
  - package
  - payment choice (deposit / full)
- **Safe quote replies from dry-run** (`show_quote`):
  - quote generated
  - availability checked
  - no write performed
  - no payment link created
  - `send_eligibility.send_allowed_later: true`

**Safe handoff acknowledgement:** may be considered later, but for now **marked staff-required** unless explicitly approved.

These map exactly to the Phase 18 `allowed_send_kind` values `ask_missing_field` and `show_quote`.

---

## 3. What remains blocked / staff-required

Auto-send is refused (handoff to staff) for any of:

- refund
- cancellation
- paid date change
- complaint / angry guest
- human request
- low confidence
- unsupported message
- not enough beds / availability failure
- ambiguous package / pricing
- booking-create / write bridge
- payment-link / Stripe link
- Stripe webhook / payment truth
- confirmation send
- non-guest operational / admin commands
- anything with `send_eligibility.requires_staff: true`

**Rule:** if `requires_staff` is true OR `allowed_send_kind` is not in the safe list, Luna never auto-sends — it hands off.

---

## 4. Gates required before any real-client send

**All gates must pass simultaneously.** Any single gate false ⇒ no send, fall back to staff handoff.

| Gate | Rule |
|------|------|
| **Auto-send env gate** | `LUNA_AUTO_SEND_ENABLED=true` (explicit, default off) |
| **Live-send env gate** | `WHATSAPP_DRY_RUN=false` |
| **Bot pause gate** | bot pause state says **not paused** |
| **Eligibility ready** | `send_eligibility.auto_send_ready: true` |
| **Allowed later** | `send_allowed_later: true` |
| **Not staff-required** | `requires_staff: false` |
| **Safe kind** | `allowed_send_kind` in {`ask_missing_field`, `show_quote`} |
| **Idempotency / dup guard** | idempotency key + duplicate-send guard |
| **Audit log** | every send (and refusal) logged |
| **Kill switch** | bot pause endpoint instantly returns to draft-only |
| **Rate / spam guard** | max reply rate per conversation/number |
| **Confidence threshold** | extraction/intent confidence above threshold |
| **Structured send reason** | machine-readable reason logged for why Luna sent |
| **Fallback to handoff** | any uncertainty ⇒ handoff, never auto-act |

---

## 5. Phase 19b — implement first (compute-only, default-deny)

- Extend send eligibility to support **production gates** but **still default-deny**.
- **No actual WhatsApp call yet.**
- Compute and return:
  - `auto_send_ready`
  - `blocked_gates`
  - `allowed_send_kind`
  - `send_reason`
  - `idempotency_key_required`
- Verify that with env gates **off**, `auto_send_ready` stays **false**.
- Verify that with test env gates **mocked on**, safe `ask_missing_field` / `show_quote` becomes `auto_send_ready: true`.
- Verify risky cases remain **blocked even with gates on**.

---

## 6. Phase 19c — implement later (default-deny send route)

- Default-deny send route: **`POST /staff/bot/guest-reply-send`**.
- Route **refuses unless all gates pass**.
- Route still does **not** create booking / payment / Stripe.
- Route sends **only** the `suggested_reply` generated by the Staff API.
- Route logs an **audit event**.
- Route has **idempotency replay** protection.
- Route checks **bot pause immediately before send**.

---

## 7. Phase 19d — what to prove (staging)

- Staging WhatsApp send proof to a **real test conversation/contact**.
- One safe `ask_missing_field` send.
- One safe `show_quote` send.
- One refund **blocked**.
- Idempotency replay does **not** send a duplicate.
- Audit log written.
- **No** booking / payment / Stripe actions.
- Pause gate **blocks** send.

---

## 8. n8n role

- n8n remains the **message pipe**.
- n8n calls the Staff API **draft route** to get the suggested reply + eligibility.
- n8n calls the Staff API **send route only if Staff API says ready**.
- n8n does **not** call WhatsApp directly unless the Staff API owns the final send decision.
- **Staff API remains the brain and the send gate.**

---

## 9. Verifiers that must protect this

A Phase 19 verifier must statically confirm:

- **no send implementation in 19a** (no live WhatsApp send code in this slice).
- **no `graph.facebook.com` call**.
- **no n8n activation**.
- **no booking / payment / Stripe / webhook** action.
- **production send gate required** (`LUNA_AUTO_SEND_ENABLED` + `WHATSAPP_DRY_RUN=false`).
- **bot pause required** before send.
- **idempotency required**.
- **risky replies blocked** (refund/cancel/complaint/unsupported/low-confidence ⇒ staff).
- **safe `ask_missing_field` / `show_quote` are the only initial auto-send kinds**.

---

## 10. Safety proof (19a)

- This slice adds only a **doc** + a **fast static verifier**. No runtime/route/helper change.
- No n8n activation; shadow workflow stays `active: false`.
- No WhatsApp send, no Stripe, no DB write, no booking/payment rows, no migration, no deploy.
- Live WhatsApp remains **NO_GO** (Stage 7.8 owner approval still required).
- `auto_send_ready` remains false until Phase 19b+ gates are implemented and explicitly enabled.

---

## 11. Stop conditions

Stop and report before proceeding if any 19a/19b step would:

- **send** WhatsApp (live or via Graph/Twilio),
- **activate** any n8n workflow,
- **write** DB rows, create bookings/payments, or set `confirmation_sent_at`,
- **call** booking-create-from-plan / payment-link / create-stripe-link / Stripe webhook,
- **auto-act** on refund/cancellation/date-change/complaint instead of handoff,
- set `auto_send_ready: true` while live-send gates are off,
- turn this plan into **send implementation** rather than a default-deny compute/plan slice.

---

## 12. Phase map

| Phase | Deliverable | State |
|-------|-------------|-------|
| 18a–18f | Draft-only builder + send-eligibility + inactive n8n shadow + closeout | DONE (`5612d69`) |
| **19a** | **Production auto-send gate plan + static verifier** | **THIS SLICE** |
| 19b | Send-eligibility production gates (compute-only, default-deny) | NEXT |
| 19c | Default-deny send route `POST /staff/bot/guest-reply-send` | LATER |
| 19d | Staging real-contact send proof (safe sends + refund blocked + idempotency) | LATER |
| 19e+ | Limited production auto-send (gated, audited, kill-switched) | LATER |

**Live WhatsApp:** NO_GO until all Section 4 gates pass + Stage 7.8 owner approval.
