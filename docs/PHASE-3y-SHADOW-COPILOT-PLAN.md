# Phase 3y — Shadow / Co-pilot Plan

**Status:** PLANNING (2026-05-29)  
**Stage 3.5 closeout commit:** `d08c64e`  
**Purpose:** Bridge the gap between isolated dry-run proof and autonomous live guest operation. The bot reads (or classifies) real or real-ish guest messages, drafts proposed replies and actions, and presents them to staff for approval. Staff remains the final actor for every send, payment, and booking mutation. No autonomous dangerous action.

---

## What Stage 3y is

Stage 3y is **shadow / co-pilot mode**, not autonomous operation.

| Role | Actor |
|------|-------|
| Read and classify guest message | Bot (automated) |
| Draft reply + proposed action | Bot (automated) |
| Review draft and proposed action | Staff (Ale / Cami) |
| Approve and send | **Staff (manual)** |
| Log correction / edit as labeled example | System records (where infrastructure allows) |

Stage 3y exists because:

- Avoids the big-bang flip from isolated dry-run to fully autonomous live operation
- Generates real labeled guest-message data from actual interactions
- Builds Ale/Cami trust in the bot's drafting quality before handing over
- Staff corrections become labeled training examples for Stage 4
- "AI drafts, staff approves" is a distinct, sellable product tier

---

## Relationship to Stage 3x

Stage 3x provides the **knowledge** the bot needs; Stage 3y **exercises** it against real or real-ish guest data.

| Stage 3x output | Stage 3y use |
|-----------------|--------------|
| Required field map (§3x.1) | Bot checks which fields are missing before drafting |
| Package rules v0.3 (§3x.2) | Bot quotes packages without guessing price |
| Handoff rules (§3x.8) | Bot knows when to stop and alert staff |
| Wrong-booking protection (§3x.9) | Bot does not act on wrong booking |
| Golden message fixtures (§3x.6) | Source of test messages for Mode A offline shadow |
| Wolfhouse knowledge (§3x.3) | Richer draft quality |

**3x.2 provisional pricing is sufficient to start Mode A.** Full 3x.3 (WhatsApp mining) is not required to begin offline shadow testing.

**3x completion order does not block Mode A.** Mode A uses pasted/copied test messages — no live WhatsApp connection required. 3x.3 (real WhatsApp history mining) enriches the bot's knowledge but can run in parallel.

---

## Stage 3y entry criteria

All must be true before any Stage 3y work begins:

| # | Criterion | Status |
|---|-----------|--------|
| Y-E1 | Stage 3 closed | ✅ `68703fd` |
| Y-E2 | Stage 3.5 minimum safety bar met | ✅ `d08c64e` |
| Y-E3 | `automation_errors` write path wired into ≥1 workflow | ✅ Send Confirmation Gap 2 (exec 1089) |
| Y-E4 | `workflow_events` logging wired into ≥1 workflow | ✅ 3.5e runtime PASS |
| Y-E5 | Real WhatsApp send gate still CLOSED | ✅ `WHATSAPP_DRY_RUN=true` policy; no real send approved |
| Y-E6 | Staff approval model defined (this doc) | ✅ §Staff approval workflow below |
| Y-E7 | Allowed / forbidden action list accepted (this doc) | ✅ §Allowed vs forbidden below |
| Y-E8 | 3x.1 required field map complete | ✅ Done (2026-05-29) |
| Y-E9 | 3x.2 package rules at ≥ provisional baseline (v0.3) | ✅ Done (2026-05-29) |
| Y-E10 | 3x.8 handoff rules defined | ✅ Done (in §3x.8) |
| Y-E11 | Bot knowledge gaps documented | ✅ `knowledge/wolfhouse-somo-gaps.md` |
| Y-E12 | Airtable coupling known and documented | ✅ 3.5 deferrals documented |
| Y-E13 | Working tree clean, no temp/secrets committed | Must confirm before each session |

---

## Operating modes

Four modes in ascending risk and infrastructure order. Do not enter a higher mode without a separate gate decision.

### Mode A — Offline shadow (pasted messages)

**Risk:** Lowest. **Infrastructure needed:** None beyond current local stack.

How it works:
1. Take a real or representative WhatsApp guest message (copy-paste text; no live connection).
2. Trigger local Main workflow with a synthetic webhook payload containing that message text.
3. Observe the bot's resolved route, confidence score, missing-field list, and drafted reply.
4. Staff reviews the draft output.
5. No send. No mutation. Deactivate after test.

**What this proves:**
- Bot classifies intent correctly for common message types
- Bot identifies missing fields before attempting action
- Bot produces a usable draft reply
- Bot triggers correct handoff signals when confidence is low
- Bot does not attempt dangerous actions on its own

**Gate to start:** This doc accepted; entry criteria Y-E1–Y-E13 met. No additional approval needed.

**Source of test messages:** 3x.6 golden message fixtures (when created) + redacted real WhatsApp samples from Ale/Cami.

---

### Mode B — Read-only real inbound WhatsApp (no sends)

**Risk:** Medium. **Infrastructure needed:** Webhook from WhatsApp Cloud API → local or hosted n8n; no outbound send enabled.

How it works:
- Real WhatsApp messages arrive at n8n webhook.
- Bot classifies and drafts, logs to `workflow_events`.
- No outbound send (`WHATSAPP_DRY_RUN=true` enforced or WhatsApp send node disabled).
- Staff sees bot draft output via n8n execution log or simple output mechanism.

**Gate to start:** Separate explicit approval required. Must confirm:
- WhatsApp webhook pointed at safe test instance (not production send path).
- `WHATSAPP_DRY_RUN=true` (or send node disabled) verified before activation.
- No Airtable write risk from the inbound path.
- Staff informed that n8n is processing real messages.

**Not approved yet.** Do not proceed to Mode B without explicit gate decision.

---

### Mode C — Staff-approved draft queue

**Risk:** Medium-high. **Infrastructure needed:** A mechanism for staff to see bot drafts (n8n output, Google Sheet, or simple review UI) and record approve/edit/reject.

How it works:
- Bot processes real messages (or Mode A transcripts), writes draft to a review queue.
- Staff sees drafts in review interface (Google Sheet, simple n8n output, or Stage 6 Staff UI).
- Staff approves: draft is sent (manually by staff — NOT auto-sent by bot).
- Staff edits: corrected version sent; correction logged as labeled example.
- Staff rejects: handoff or no-op logged.

**Gate to start:** Requires:
- Mode B infrastructure stable.
- Review queue mechanism (even if Google Sheet) built and tested.
- Staff workflow documented and understood by Ale/Cami.
- Explicit approval that staff will manually send (not bot auto-send).

**Not approved yet.**

---

### Mode D — Staff-approved action proposals

**Risk:** High. **Infrastructure needed:** Staff UI (Stage 6) or approved backend API for executing proposed actions after staff approval.

How it works:
- Bot proposes a dangerous action (e.g. "send payment link to this guest").
- Staff clicks approve.
- Action executes (payment link creation, confirmation, bed assignment).

**Gate to start:** This is approaching autonomous operation. Requires:
- Stage 6 Staff UI or equivalent approval surface.
- Per-action approval gates from §3x.7.
- Real-send gate explicitly approved per action type.
- Explicit security/audit review.

**Not in scope for initial Stage 3y. Do not plan or implement Mode D without separate decision.**

---

## Allowed vs forbidden in Stage 3y

### Allowed without additional approval (Mode A)

| Action | Notes |
|--------|-------|
| Read/classify a message text (real or pasted) | Core shadow function |
| Resolve intent route + confidence score | Core shadow function |
| Identify missing required fields (per §3x.1) | Must ask guest or hand off |
| Draft a plain-text reply for staff review | No send |
| Propose a safe next step (e.g. "ask for dates") | Bot output only |
| Trigger handoff signal (log, not send) | Core safety gate |
| Log decision to `workflow_events` (info) | Existing infrastructure |
| Log missing fields / handoff reason to `workflow_events` | Existing infrastructure |
| Read from Postgres (SELECT only) | Existing pattern |
| Run local n8n activation with test/pasted payload | Mode A gate |

### Forbidden without separate explicit approval per gate

| Action | Why |
|--------|-----|
| Send real WhatsApp message (any content) | Real-send gate not approved |
| Create Stripe payment link | No autonomous payment without staff approval |
| Confirm booking | Must remain staff-triggered or webhook-triggered with payment truth |
| Assign / reassign / cancel beds | Rooming changes require staff approval |
| Mark payment truth (`payments`, `payment_events`) | Webhook owns truth |
| Write to `bookings` autonomously | No mutation without staff approval |
| Write to Airtable | Non-negotiable: do not touch live Airtable |
| Run hosted n8n cloud instance workflows | Non-negotiable: do not edit/run production |
| Accept real WhatsApp inbound (Mode B) | Requires separate gate (above) |
| Implement Mode C/D send/action pipeline | Requires Mode B stable + additional gate |
| Commit code/workflow changes without verification | Standard process |

---

## Staff approval workflow

In Stage 3y (specifically Mode A and Mode B), staff approval is manual — there is no automated send pipeline.

### What staff sees

| Output | Format (Mode A) |
|--------|-----------------|
| Resolved route | Text label: `booking_flow`, `payment_details_provided`, `handoff_needed`, etc. |
| Confidence score | Number 0–1 |
| Missing required fields | List of field names from §3x.1 |
| Drafted reply text | Plain text block |
| Proposed action | "Would ask guest for email" / "Would trigger payment link" / "Would hand off" |
| Handoff reason (if any) | Free text from handoff rules §3x.8 |
| `workflow_events` log | Evidence record for audit |

### What staff does

| Decision | Staff action |
|----------|--------------|
| Approve draft as-is | Copy text → paste into WhatsApp manually → send |
| Edit draft | Modify text → send edited version manually |
| Reject draft | Do not send; add note why |
| Escalate / hand off | Respond manually; note bot's proposed route |

### What gets logged

| Event | Target |
|-------|--------|
| Bot classified route + confidence | `workflow_events` (info) |
| Missing fields identified | `workflow_events` payload |
| Draft text produced | `workflow_events` payload (or n8n execution log) |
| Handoff triggered | `workflow_events` (warn or info) |
| Staff approved / edited / rejected | Pending: no automated mechanism in Mode A; staff notes offline |

### Staff correction capture (interim)

In Mode A, staff corrections are not automatically captured. Interim mechanism: Ale/Cami keep a simple log (Google Sheet or running doc) of:
- Message text
- Bot's proposed route
- Bot's draft
- What they actually sent
- Reason for any edit

This log becomes the first batch of real golden-message labeled data for Stage 3x.6 / Stage 4.

---

## Minimum infrastructure required per mode

### Mode A (offline shadow) — no new infrastructure needed

| Component | Status |
|-----------|--------|
| Local n8n (queue mode) | ✅ Running |
| Local Postgres + wolfhouse schema | ✅ Running |
| Main (local fork) | ✅ Built (`n8n/phase3b/`) — requires activation per test |
| `workflow_events` logging | ✅ Wired (3.5b + 3.5e) |
| `automation_errors` capture | ✅ Wired (3.5b Gap 2) |
| `WHATSAPP_DRY_RUN=true` | ✅ Policy enforced |
| Test message source | 3x.6 golden fixtures (in progress) + pasted samples |
| Kill switch | Deactivate workflow after each test gate (existing practice) |

### Mode B (real inbound, no sends) — additional infrastructure

| Component | Required |
|-----------|----------|
| WhatsApp Cloud API webhook → n8n | Need to configure; point to safe endpoint |
| `WHATSAPP_DRY_RUN=true` verified before activation | Hard requirement |
| Send node disabled or env-gated | Hard requirement |
| Staff awareness that real messages are being processed | Must inform Ale/Cami |
| Privacy: real guest data stays off-repo | `data/private/` gitignored |
| Separate activation gate | Required per session |

### Mode C (draft queue) — additional infrastructure

| Component | Required |
|-----------|----------|
| Mode B stable | Prerequisite |
| Draft storage (PG table, n8n output, or Google Sheet) | Design needed |
| Staff review interface (minimal) | Google Sheet or simple webhook output |
| Approve/reject/edit logging mechanism | Design needed |

---

## Stage 3y test matrix

These tests are all Mode A (offline/pasted messages) unless noted.

| Test ID | Message type | Expected route | Expected bot behavior | No-send assertion | No-mutation assertion |
|---------|-------------|----------------|----------------------|-------------------|----------------------|
| Y-T1 | "I want to book for 2 people, April 10–17" | `booking_flow` | Ask for package type or availability check | ✅ | ✅ |
| Y-T2 | "What packages do you have?" | `quote` | List all packages (Malibu / Uluwatu / Waimea) without guessing price | ✅ | ✅ |
| Y-T3 | "I want to pay" (no booking context) | `payment_details_provided` or `handoff_needed` | Ask for booking reference or hand off | ✅ | ✅ |
| Y-T4 | "I just sent the payment" | `payment_received_check` or `handoff_needed` | Log note, hand off to staff (do not mark paid) | ✅ | ✅ (no payment write) |
| Y-T5 | Message with missing dates | `booking_flow` | Request missing fields: check-in / check-out | ✅ | ✅ |
| Y-T6 | Message with missing guest count | `booking_flow` | Request missing field: number of guests | ✅ | ✅ |
| Y-T7 | Cancellation request | `cancel` or `handoff_needed` | Surface policy window, propose staff review; do NOT cancel | ✅ | ✅ (no booking write) |
| Y-T8 | "Can I change my dates?" | `date_change` or `handoff_needed` | Check policy, hand off to staff | ✅ | ✅ |
| Y-T9 | Low-confidence message ("hey what's up") | `unknown` / `handoff_needed` | Route to handoff with reason: low confidence | ✅ | ✅ |
| Y-T10 | Complaint / angry message | `handoff_needed` | Immediate handoff signal; no draft action | ✅ | ✅ |
| Y-T11 | Medical / emergency mention | `handoff_needed` | Immediate handoff signal; no draft action | ✅ | ✅ |
| Y-T12 | Message in Spanish | `booking_flow` (or relevant) | Draft in Spanish if language detected | ✅ | ✅ |
| Y-T13 | "I paid but my booking is still pending" | `handoff_needed` | Hand off to staff with context; do NOT mark paid | ✅ | ✅ (no payment write) |
| Y-T14 | Rooming preference ("can I be with my girlfriend?") | `rooming_info` or `handoff_needed` | Log preference; do NOT assign beds | ✅ | ✅ (no booking_beds write) |
| Y-T15 | Same message sent twice (duplicate) | Any | Idempotent: same draft, no double mutation | ✅ | ✅ |

**Logging assertion (all tests):** `workflow_events` must have ≥1 row per execution (route + confidence + action).  
**Automation_errors assertion (all tests):** Count must not increase unexpectedly.

---

## Stage 3y exit criteria

Stage 3y is complete when all of the following are met:

| # | Criterion | Proof |
|---|-----------|-------|
| Y-X1 | Mode A: all Y-T1–Y-T15 tests completed and reviewed by staff | Test log / `workflow_events` evidence |
| Y-X2 | Bot does not send autonomously in any test | `WHATSAPP_DRY_RUN=true` assertion + execution log |
| Y-X3 | Bot does not mutate dangerous data (payments, bookings, booking_beds) in any test | Count assertion post-teardown per test |
| Y-X4 | Bot produces useful drafts for ≥80% of standard booking/quote/missing-field messages | Staff review judgment |
| Y-X5 | Handoff triggers correctly for low-confidence, complaint, medical, and payment-claim messages | Y-T9–Y-T11, Y-T13 |
| Y-X6 | Missing-field detection is accurate for all routes | Y-T5, Y-T6 per §3x.1 required fields |
| Y-X7 | Package quoting is safe (does not invent prices) | Y-T2 |
| Y-X8 | Duplicate message handling is idempotent | Y-T15 |
| Y-X9 | `workflow_events` logs every execution with route + confidence + action | Confirmed per test |
| Y-X10 | Staff (Ale/Cami) has reviewed at least 5 real-or-realistic bot drafts and provided feedback | Offline log or direct input |
| Y-X11 | Labeled correction log started (at least 5 labeled rows) | Interim Google Sheet or doc |
| Y-X12 | Real WhatsApp send gate still CLOSED at exit | Policy confirmation |
| Y-X13 | Decision documented: proceed to Mode B, proceed to Stage 4, or return to 3x for knowledge gap | Explicit next-step decision |

---

## Stage 3y and Stage 3x parallelism

Stage 3y does not wait for all of Stage 3x to complete. The following are the minimum 3x prerequisites per stage 3y mode:

| 3y Mode | 3x prerequisites |
|---------|-----------------|
| Mode A (offline shadow) | 3x.1 DONE ✓; 3x.2 v0.3 provisional DONE ✓; 3x.8 handoff rules defined ✓ |
| Mode B (real inbound) | Mode A tests passed; 3x.6 golden fixtures ≥ 10 rows; separate gate |
| Mode C (draft queue) | Mode B stable; 3x.3 WhatsApp mining started; additional gate |
| Mode D (action proposals) | Stage 6 Staff UI + all 3x complete; separate major gate |

**Recommended parallel path:**
- 3x.2: Ale/Cami confirm provisional prices → promotes config from provisional to confirmed
- 3x.3: Ale/Cami provide redacted WhatsApp samples → enriches Mode A test messages
- Stage 3y Mode A: run Y-T1–Y-T15 offline tests → staff feedback → labeled corrections

---

## What Stage 3y does NOT do

- Start autonomous live operation
- Enable real WhatsApp send (separately gated)
- Enable real payment-link creation (separately gated)
- Enable autonomous booking confirmation or rooming
- Replace Stage 4 reliability work (monitoring, error rates, retry logic)
- Replace Stage 6 Staff UI (Mode C/D require a proper review surface)
- Complete Stage 3x (3x.3 WhatsApp mining and 3x.6 golden runner remain separate)

---

## Known gaps and dependencies

| Gap | Impact | Mitigation |
|-----|--------|------------|
| No Staff UI (Stage 6) | Mode C/D not yet possible; Mode A uses n8n output + staff copy-paste | Acceptable for Mode A; Mode C can use Google Sheet interim |
| 3x.3 WhatsApp mining not done | Mode A test corpus is synthetic / pasted | Use 3x.6 golden fixtures + staff-provided samples |
| Airtable-coupled L3 runtime paths (D6/D8/D9, I2/I5) | Cannot runtime-test rooming/reassign/payment paths with PG-only fixture | Non-blocking for Mode A; co-pilot mode doesn't execute these autonomously |
| Real WhatsApp ingestion (Mode B) | Requires separate gate | Mode A is first milestone; gate Mode B explicitly |
| 3x.2 Ale/Cami confirmation pending | Package pricing provisional only | Bot uses provisional prices + "prices may vary" caveat; staff corrects in review |
| `confirmation_sent_at` / dual-database state | If local fork diverges from Airtable truth, drafts may reference stale state | Mode A uses local Postgres state only; document caveat in each test |

---

## Recommended first implementation step

**Mode A offline shadow — Y-T1 through Y-T5 offline test run.**

1. Create 5 representative pasted-message payloads (one per test Y-T1–Y-T5) using real-ish guest message text.
2. Trigger local Main workflow (local fork, not hosted) with each payload as a synthetic webhook POST.
3. Record: resolved route, confidence, missing fields, draft text, `workflow_events` rows.
4. Share output with Ale/Cami for review — this is the first real shadow session.
5. Log any draft quality issues or missing knowledge as 3x gaps.
6. Teardown: deactivate workflow after each test. Confirm no DB mutations.

This is the minimum-viable Stage 3y action: all infrastructure already exists; only test message payloads are new.

---

## Related docs

- [`ROADMAP.md § Stage 3y`](ROADMAP.md#stage-3y--shadow--co-pilot-pilot) — brief overview
- [`ROADMAP.md § Stage 3x`](ROADMAP.md#stage-3x--bot-knowledge--safety-guardrails) — knowledge prerequisites
- [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) — full 3x spec (§3x.1–3x.11)
- [`PHASE-3.5-SAFETY-RAILS-PLAN.md`](PHASE-3.5-SAFETY-RAILS-PLAN.md) — safety rails that enable Stage 3y
- [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) — Ale/Cami owner knowledge gaps
- [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) — long-term architecture direction
- [`PROJECT-STATE.md`](PROJECT-STATE.md) — current stage snapshot
