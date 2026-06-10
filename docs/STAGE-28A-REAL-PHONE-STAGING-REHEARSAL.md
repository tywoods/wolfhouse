# Stage 28a — Wolfhouse Real-Phone Staging Rehearsal Readiness

**Status:** **READINESS PLAN** (docs only — 2026-06-10)  
**Parent closeout:** [STAGE-27DEMO-CLOSEOUT.md](STAGE-27DEMO-CLOSEOUT.md) · commit `4f76aae`  
**Verifier:** `npm run verify:stage28a-real-phone-rehearsal`  
**Next actionable:** **Stage 28b** — real-phone **review-only** rehearsal (recommended first)

---

## 0. What Stage 28 is (and is not)

| In scope | Out of scope |
|----------|--------------|
| Real-phone staging rehearsal runbook | Staff Portal UI polish |
| Ale/Cami test phones on **staging only** | Production / Main traffic |
| Booking visible in Staff Portal Inbox + Calendar | Services / add-ons booking |
| Controlled, gate-by-gate automation ramp | Uncontrolled WhatsApp automation |
| Reuse proven 27demo-l→o.3 brain path | Live Stripe |
| Explicit owner GO per live-send/write slice | Inbox redesign / drawer polish |

**Stage 27 proved** the hosted open-demo chain end-to-end (anchor `WH-G27-0ECC1D9B57`). **Stage 28** repeats that *experience* with **real phones** and **allowlisted test phones only** — not open-demo “anyone with the number.”

---

## 1. Demo goal

Ale and Cami pull out their phones and message Luna on the **staging WhatsApp number**. Success means:

1. Inbound message reaches staging n8n → Staff API brain.
2. Staff can open **Staff Portal Inbox** and see the conversation thread.
3. When booking-write mode is approved, a **hold + payment draft** appears with a **booking code**.
4. Assigned **demo beds** show on **Bed Calendar** (e.g. `DEMO-R1`, `DEMO-R2`).
5. Optional later slices: Stripe TEST link, payment truth, confirmation preview/send — **each only with explicit GO**.

**Hard rules:**

- **No production traffic** — staging Staff API + staging n8n + staging DB only.
- **No uncontrolled automation** — default `WHATSAPP_DRY_RUN=true`; writes/links/sends require explicit gates + owner approval.
- **Gates restored after every rehearsal window.**

---

## 2. Demo scenario (one clean base booking)

Use a **single scripted scenario** per rehearsal session so Staff Portal checks are predictable.

| Field | Value |
|-------|--------|
| Guests | **2** |
| Package | **Malibu** |
| Dates | **Clear window with free demo beds** — e.g. check-in **2026-10-06**, check-out **2026-10-13** (adjust after calendar pre-check; avoid overlap with anchor `WH-G27-0ECC1D9B57` Sep 9–16) |
| Payment choice | **Deposit** (€200) |
| Beds | Demo inventory only (`DEMO-R*`); expect 2-bed assignment for 2 guests |
| Stripe | **TEST mode only** (`sk_test_`) when payment slice approved |
| Confirmation | Preview dry-run by default; **live send only** with allowlist + explicit GO |

**Conversation script (EN):**

1. “Hi, we’re two guests interested in Malibu for Oct 6–13.”
2. Answer Luna’s intake questions (dates, guest count, package).
3. Choose deposit when asked.
4. Stop after booking appears on calendar unless payment/confirmation slice is explicitly approved for that session.

---

## 3. Rehearsal modes (gates / modes)

Enable **one mode at a time**. Never combine live reply + booking write + Stripe link + confirmation send without a written GO checklist.

### Mode A — Review-only phone rehearsal (recommended **28b** first)

| Gate / setting | Value |
|----------------|--------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| n8n workflow | **27demo-j** review pipe only (`open-demo-whatsapp-inbound-review-27j` or equivalent) — **inactive in repo; activate only for window** |

**Behavior:** Real phone inbound → n8n → Staff API review/orchestrator dry-run. Luna reply may be **reviewed in Staff Portal** or dry-run logged — **no booking write**, no Stripe, no confirmation send.

### Mode B — Booking-write rehearsal (**28c** candidate)

| Gate / setting | Value |
|----------------|--------|
| `WHATSAPP_DRY_RUN` | `true` (replies still dry unless live-reply GO) |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` **only during window** |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| n8n workflow | **27demo-l** booking write pipe (`open-demo-whatsapp-booking-write-27l`) |

**Behavior:** Allowlisted test phones only. Hold + draft payment + demo bed assignment. **Calendar must show booking.** No Stripe link unless Mode C approved.

### Mode C — Payment-link rehearsal (**28d** candidate)

| Gate / setting | Value |
|----------------|--------|
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `true` **only during window** |
| `STRIPE_LINKS_ENABLED` | `true` (staging) |
| Stripe keys | **`sk_test_` only** — verify Key Vault / env before window |
| n8n workflow | **27demo-m** stripe test link pipe (`open-demo-whatsapp-stripe-test-link-27m`) |

**Behavior:** Stripe TEST Checkout link created/reused. Payment link WhatsApp send **only if explicitly approved** (separate from link creation). Payment truth via signed webhook (27demo-n pattern) — not chat fake.

### Mode D — Confirmation rehearsal (**28e** candidate)

| Step | Gate |
|------|------|
| Preview dry-run | Always first — `runGuestConfirmationPreviewDryRun` / 27q; no send |
| Go/no-go blocked | `confirm_send:false`, `WHATSAPP_DRY_RUN:true` |
| Live confirmation send | `WHATSAPP_DRY_RUN=false` + `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST=<phone>` + `confirm_send:true` + **owner GO** |

**Behavior:** Same as 27demo-o.1 → o.2 → o.3 sequence. Restore dry-run + clear allowlist immediately after.

---

## 4. Test phone policy

| Rule | Detail |
|------|--------|
| **Allowlisted staging test phones only** | Ale/Cami numbers recorded before rehearsal; no public guest traffic |
| **No open demo for Stage 28** | Unlike 27demo-a, real-phone rehearsal is **not** “anyone with the demo number” |
| **No production WhatsApp number** | Unless explicitly approved in a separate production cutover stage |
| **No Main/production n8n** | Staging n8n host only: `wh-staging-n8n-main…azurecontainerapps.io` |
| **Inbound allowlist** | Document exact E.164 numbers in rehearsal brief; rotate if numbers change |
| **Outbound allowlist** | `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` for confirmation slice only; unset after |

**Suggested placeholder numbers** (replace with confirmed Ale/Cami staging phones before 28b):

- Ale staging test phone: `TBD — record in 28b brief`
- Cami staging test phone: `TBD — record in 28b brief`
- Prior proof phone (27demo): `+34600995557` — engineering harness only unless re-approved

---

## 5. Runbook checklist

### 5.1 Before rehearsal

- [ ] Confirm **baseline gates** (see §6 Rollback) — all `OPEN_DEMO_*` write/link flags **false**, `WHATSAPP_DRY_RUN=true`, allowlist **unset**
- [ ] `curl https://staff-staging.lunafrontdesk.com/healthz` → **200**
- [ ] Record Staff API **revision + image** (expect `9b43cb5-stage27demo-j-n8n-review-pipe` or newer rehearsal image)
- [ ] Confirm target n8n workflow **`active: false`** in repo; staging import inactive until window
- [ ] Confirm **test phone allowlist** written in session brief (Ale/Cami E.164)
- [ ] **Calendar pre-check:** demo beds free for scenario dates (Bed Calendar → filter demo rooms)
- [ ] Staff Portal **login works** for observers (Ale/Cami + engineer)
- [ ] Stripe **TEST** only: `sk_test_` in staging KV; webhook secret present; **no `sk_live_`**
- [ ] Choose **rehearsal mode** (A/B/C/D) and get **owner GO** for that mode only
- [ ] Open Staff Portal **Inbox** + **Bed Calendar** side by side

### 5.2 During rehearsal

- [ ] Send scripted message from **allowlisted phone only**
- [ ] Watch **Staff Portal Inbox** — thread appears; note `conversation_id` if shown
- [ ] Watch **Bed Calendar** after Mode B+ — booking block on demo beds
- [ ] **Capture `booking_code`** (e.g. `WH-G28-…`) in session log
- [ ] Verify **no duplicate booking** (same idempotency / same phone+dates)
- [ ] If Mode C: verify **payment draft** + `checkout_created` + TEST session id
- [ ] If Mode D: preview first; **no send** unless live-send GO active
- [ ] Screenshot or copy **proof IDs** (payment_id, session_id, wamid if send approved)

### 5.3 After rehearsal

- [ ] **Restore gates** (§6) — mandatory even on failure
- [ ] **Deactivate n8n workflow** used for session
- [ ] Clear **webhook_entity** row if workflow was DB-imported (see 27demo-k/l docs)
- [ ] Record in session log: `booking_code`, `guest_phone`, `payment_draft_id`, Stripe session, `confirmation_sent_at`, `guest_message_send_id`, wamid
- [ ] Run targeted verifiers (§8)
- [ ] File short PASS/PARTIAL/FAIL note in git or shared doc — no DB writes from verifier

---

## 6. Rollback / safe baseline gates

Restore this state after **every** rehearsal window (matches post-27demo-o.3):

```
WHATSAPP_DRY_RUN=true
LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST unset (removed)
OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false
OPEN_DEMO_BOOKING_WRITES_ENABLED=false
OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
OPEN_DEMO_WHATSAPP_ENABLED=true          # inbound routing may stay enabled for staging
LUNA_AUTO_SEND_ENABLED=true              # default staging; live send still blocked by dry-run
n8n workflows: inactive
```

**Never leave** `WHATSAPP_DRY_RUN=false` or allowlist set overnight after a rehearsal.

---

## 7. Explicit non-goals (Stage 28)

- Inbox redesign or conversation UI polish
- Booking drawer layout / field edit polish
- **Services / add-ons** on guest path (Stage 29+ core capability)
- Production cutover or Main branch deploy
- Live Stripe (`sk_live_`)
- Uncontrolled WhatsApp automation (auto-send without GO)
- Public marketing on staging WhatsApp number
- n8n Meta activation on production

**UI polish waits** unless it **blocks** Ale/Cami from seeing inbox thread or calendar booking during rehearsal.

---

## 8. Reused infrastructure (from Stage 27demo)

| Slice | n8n export | Webhook path | Staff API brain |
|-------|------------|--------------|-----------------|
| Review | `Luna Open Demo WhatsApp Inbound Review Pipe.json` | `open-demo-whatsapp-inbound-review-27j` | `guest-inbound-review` / orchestrator |
| Live reply | `Luna Open Demo WhatsApp Live Reply Pipe.json` | `open-demo-whatsapp-inbound-live-reply-27k` | open-demo inbound + live reply gate |
| Booking write | `Luna Open Demo WhatsApp Booking Write Pipe.json` | `open-demo-whatsapp-booking-write-27l` | hold/draft + demo bed assign |
| Stripe link | `Luna Open Demo WhatsApp Stripe Test Link Pipe.json` | `open-demo-whatsapp-stripe-test-link-27m` | `runGuestStripeTestLinkCreateApproved` |
| Payment truth | (no n8n) | POST `/staff/stripe/webhook` | signed `checkout.session.completed` |
| Confirmation | (no n8n) | 27q preview + 27r go/no-go + 27s allowlist | `runGuestConfirmationLiveSendAllowlisted` |

**Staging hosts:**

- Staff API: `https://staff-staging.lunafrontdesk.com`
- Staff Portal: same origin (staff login)
- n8n: `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io`

---

## 9. Exit criteria (Stage 28a complete)

Stage **28a** is complete when this document exists and defines:

- [x] Demo goal (§1)
- [x] One base booking scenario (§2)
- [x] Rehearsal modes A–D with gates (§3)
- [x] Test phone policy (§4)
- [x] Before / during / after runbook (§5)
- [x] Rollback gates (§6)
- [x] Non-goals (§7)
- [x] Next actionable stage (§10)
- [x] Static verifier registered (§11)

---

## 10. Recommended next stage (28b)

**Stage 28b — real-phone review-only rehearsal (Mode A)**

**Why first:** Validates real handset → Meta → staging n8n → Staff API → Inbox visibility **without** booking writes or payments. Lowest risk ramp after 27demo automation proof.

**28b proof goal:**

1. Ale or Cami sends scripted intake message from **allowlisted phone**.
2. Engineer activates **review pipe only** for a short window.
3. Staff Portal Inbox shows inbound thread + Luna review output.
4. **No** `booking_code` created; calendar unchanged.
5. Gates restored; n8n inactive.

**Alternative (skip only if review path already observed on real phones):** **Stage 28c — live booking-write rehearsal (Mode B)** — same scenario §2 with `OPEN_DEMO_BOOKING_WRITES_ENABLED=true` and 27demo-l pipe.

---

## 11. Verifiers

```bash
npm run verify:stage28a-real-phone-rehearsal
npm run verify:stage27demo-l-n8n-booking-write
npm run verify:stage27demo-m-n8n-stripe-test-link
npm run verify:stage27demo-i-confirmation-send
```

---

## 12. Product roadmap note

- **Stage 27:** closed (`4f76aae`).
- **Stage 28:** real-phone staging rehearsal / launch candidate (this plan = 28a).
- **After base booking rehearsal:** **services / add-ons** — next core booking capability.
- **UI polish:** deferred unless blocking demo observability.
