# Stage 27x-lite — Inbound Luna Review-Only Wiring Design

**Status:** DESIGN LOCK — docs only (2026-06-08).  
**Parent:** [STAGE-27W-LUNA-GUEST-SIMULATOR.md](STAGE-27W-LUNA-GUEST-SIMULATOR.md) · [STAGE-27V-GUEST-AUTOMATION-REVIEW.md](STAGE-27V-GUEST-AUTOMATION-REVIEW.md) · [STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md](STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md) · [STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md](STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md)  
**Verifier:** `npm run verify:stage27x-lite-inbound-review-design`

**Non-negotiables (27x-lite):** No runtime code. No deploy. No DB writes. No Stripe. No WhatsApp sends. No Meta activation. No n8n activation changes. **No public guest automation wired yet.** No live guest auto-send approved.

**Context:** Stages **27u–27w** proved the Luna guest automation chain on Staff API and in the Luna Guest Simulator (multi-turn context auto-chain, hold/draft write, Stripe TEST link, payment truth, confirmation draft ready). **Real inbound WhatsApp is not connected.** Stage **27x-lite** locks how the **next wiring step** connects staged/real inbound messages to that chain in **review-only mode** — staff sees proposed Luna replies; nothing is sent automatically.

**Architecture (unchanged):**

| Layer | Role |
|-------|------|
| **n8n** | **Message pipe** — Meta WhatsApp webhook → normalize → forward to Staff API; outbound send when explicitly GO'd later |
| **Staff API** | **Brain** — gates, orchestrator, shared booking/pricing/payment engine, audit |
| **Staff Portal** | **Review surface** — inbox thread + Luna review panel; copy draft manually for now |

---

## 1. Inbound source

### 1.1 Flow (target)

```
Meta WhatsApp (staging allowlist only in later 27x.4+)
  ↓
n8n inbound workflow (pipe — normalize, dedupe, auth to Staff API)
  ↓
POST /staff/bot/guest-inbound-review-dry-run   ← NEW in 27x.1 (design target)
  ↓
runGuestAutomationOrchestratorDryRun (27u) + persistence hooks (27x.1+)
  ↓
Store review artifact + conversation event (no outbound send)
  ↓
Staff Portal Inbox / Luna review panel (27x.3)
```

**27x-lite does not activate n8n or Meta.** The payload shape below is the contract n8n will use when **27x.2** wires the pipe in disabled/dry-run mode.

### 1.2 Inbound payload shape (n8n → Staff API)

Proposed `POST /staff/bot/guest-inbound-review-dry-run` body (extends 27v review fields with inbound metadata):

```json
{
  "source": "n8n_whatsapp_inbound",
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "message_text": "Hi, we are 2 people interested in the Malibu package",
  "guest_phone": "+34600999988",
  "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
  "inbound_message_id": "wamid.HBgLM...",
  "idempotency_key": "wolfhouse-somo:whatsapp:wamid.HBgLM...",
  "received_at": "2026-06-08T14:32:01.000Z",
  "reference_date": "2026-06-08",
  "language_hint": "en",
  "guest_context": {},
  "automation_gate_context": {
    "public_guest_automation_enabled": false,
    "whatsapp_dry_run": true,
    "bot_paused": false,
    "human_takeover": false,
    "is_owner_or_staff": false
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | Resolved by n8n from WhatsApp business account / phone-number mapping table (config), not guessed by LLM |
| `channel` | ✓ | `whatsapp` for this slice |
| `message_text` | ✓ | Normalized text body; empty → 400 or handoff |
| `guest_phone` | ✓ | E.164 from Meta `from`; primary thread key with `client_slug` |
| `conversation_id` | ✓ | Staff API `conversations.id` when thread exists; n8n may pass after upsert or Staff API resolves on ingest |
| `inbound_message_id` | ✓ | Meta `wamid.*` — dedupe key |
| `idempotency_key` | ✓ | `{client_slug}:{channel}:{inbound_message_id}` — replay-safe |
| `received_at` | ✓ | ISO timestamp from Meta; drives `reference_date` when harness date not injected |
| `reference_date` | — | Optional override for staging harness; default = date portion of `received_at` in property TZ |
| `guest_context` | — | Prior slim chain state loaded from DB (§5); empty on first message |
| `automation_gate_context` | — | n8n passes known pause/takeover flags from Staff API conversation row when available |

### 1.3 Client slug resolution

| Step | Owner | Rule |
|------|-------|------|
| 1 | n8n config | Map Meta `phone_number_id` / business WABA → `client_slug` |
| 2 | Staff API gate | Reject unknown slug → `blocked`, staff handoff event |
| 3 | Future | Multi-tenant table; MVP: single staging tenant `wolfhouse-somo` |

Luna must **not** infer `client_slug` from message text.

### 1.4 Guest phone / conversation mapping

| Key | Resolution |
|-----|------------|
| Thread lookup | `(client_id, guest_phone, channel=whatsapp)` → `conversations` row |
| Create-if-missing | **27x.1+** may upsert conversation + inbound `messages` row before orchestrator (still no outbound) |
| `conversation_id` | UUID returned to n8n for correlation; stored on review artifact |
| Staff/owner phones | Route per 27t G3 — **no guest automation chain**; owner inbox slice separate |

### 1.5 Idempotency

| Mechanism | Behavior |
|-----------|----------|
| Primary key | `idempotency_key` = `{client_slug}:{channel}:{inbound_message_id}` |
| Duplicate inbound | Return **stored review result** for same key; no second orchestrator run |
| Meta retries | Safe — same `wamid` → same draft reply proposal |
| Audit | Log `idempotent_replay: true` on conversation event |

### 1.6 Timestamp / reference date

| Field | Use |
|-------|-----|
| `received_at` | Audit, inbox ordering, conversation events |
| `reference_date` | Relative date parsing in router (e.g. "July 10–17") — default from `received_at` in `Europe/Madrid` unless harness overrides |
| No backdating | Orchestrator uses latest inbound timestamp; staff cannot silently shift engine dates via n8n |

---

## 2. Review-only behavior

Every inbound message eligible for automation runs the **existing 27u orchestrator** (via 27v-equivalent logic) with **hard review-only enforcement**:

| Output | Produced | Sent live |
|--------|----------|-----------|
| `proposed_luna_reply` | ✓ | ❌ |
| `proposed_next_action` | ✓ | ❌ |
| `automation_gate` | ✓ | — |
| Chain: `result` (intake/router) | ✓ | — |
| Chain: `availability` | ✓ when eligible | — |
| Chain: `quote` | ✓ when eligible | — |
| Chain: `payment_choice` | ✓ when eligible | — |
| Chain: `hold_payment_draft_plan` | ✓ plan only | — |
| `handoff_reasons` | ✓ when applicable | — |

**Explicit prohibitions on inbound path (27x-lite through 27x.4):**

| Action | Allowed |
|--------|---------|
| Live WhatsApp send | ❌ |
| Booking / hold / payment draft **write** | ❌ unless explicit staff/test action (27w simulator pattern) |
| Stripe TEST link create | ❌ unless explicit staff/test action |
| Payment truth apply from guest text | ❌ — webhook only (27p) |
| Confirmation send | ❌ |
| Meta Graph outbound | ❌ |
| n8n outbound workflow trigger | ❌ |

Response envelope (always):

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "public_guest_automation_enabled": false,
  "review": { "...": "27v shape" }
}
```

Staff **test actions** (hold, Stripe link) remain on **Luna Guest Simulator** or explicit staff buttons — **not** triggered by inbound message alone until **27x.5** GO.

---

## 3. Staff Portal visibility

### 3.1 Where the draft appears

| Surface | Priority | Content |
|---------|----------|---------|
| **Inbox conversation detail** | Primary (27x.3) | Latest guest message + Luna proposed reply card |
| **Luna review panel** | Secondary / expandable | Full 27v JSON: gate, chain steps, handoff reasons, safety flags |
| **Luna Guest Simulator** | Unchanged | Manual harness; not replaced by inbound |

### 3.2 Inbox UI elements (27x.3 target)

| Element | Source |
|---------|--------|
| Guest message bubble | Inbound `messages` row |
| **Luna proposed reply** (draft) | Latest `luna_review_artifacts.proposed_luna_reply` |
| **Next action** | `proposed_next_action` |
| **Gate status** | `automation_gate.gate_status` + `gate_reasons[]` |
| **Handoff reasons** | `handoff_reasons[]` when present |
| **Safety flags** | `dry_run`, `sends_whatsapp`, `live_send_blocked`, `no_write_performed` |
| **Lane / intake** | `result.message_lane`, `result.intake_state` |
| **Quote summary** | `quote.quote_status`, `quote_total_cents` when ready |
| **Approve / Send** | **Disabled** — label: "Send not enabled (review-only)" |
| **Copy reply** | Enabled — staff copies draft to WhatsApp manually |

No auto-send button until a future explicit GO stage with 27r/27s gates.

---

## 4. Gate rules

All **27t entry gates** apply on every inbound review. Additional 27x-lite rules:

| Gate | Check | Fail behavior |
|------|-------|---------------|
| **G0** | `public_guest_automation_enabled` | Must remain **`false`** until 27x.5 GO — inbound still allowed via `dry_run` + review endpoint |
| **G6** | `WHATSAPP_DRY_RUN` | Must be **`true`** on staging for 27x.2–27x.4 |
| **G4** | Bot pause | `bot_paused: true` → `staff_handoff_required`; store draft, no chain advance |
| **G5** | Human takeover | Active staff ownership → automation stops; preserve context |
| **G3** | Owner/staff routing | `is_owner_or_staff: true` → block guest chain |
| **G2** | Unsupported channel | Non-whatsapp → handoff |
| **G1** | Unknown `client_slug` | Block + audit |
| **G9** | Duplicate `idempotency_key` | Return cached review; no re-orchestration |
| **G10** | n8n pipe disabled | 27x.2: workflow **inactive** or hard-fail before Meta — no accidental live path |

Live send, Stripe link to guest, hold write, and confirmation send remain behind existing slice gates (27n, 27o, 27r, 27s) — **not** reachable from inbound review-only path.

---

## 5. State persistence design

### 5.1 Store now (27x.1–27x.3)

| Artifact | Storage | Notes |
|----------|---------|-------|
| Inbound message | `messages` (existing) | `direction=inbound`, `external_id=wamid` |
| Conversation event | `conversation_events` or equivalent audit | `intent: guest_inbound_review_dry_run` |
| Review artifact | **New table or JSON column** `luna_review_artifacts` | Slim fields — see §5.3 |
| Idempotency index | Unique on `idempotency_key` | Duplicate → return existing artifact |
| `guest_context` (slim) | Per-conversation `metadata.luna_guest_context` or artifact pointer | Multi-turn continuity; auto-chain like 27w.9 |

### 5.2 Store later (post-27x.5)

| Artifact | When |
|----------|------|
| Outbound send records | After live send GO |
| Booking/hold/payment writes from inbound | After explicit automation GO + write gates |
| Stripe session from inbound | Staff action or approved automation slice only |

### 5.3 Slim `guest_context` persistence (avoid giant blobs)

Persist **only** fields needed for next-turn orchestrator input (mirrors 27w.9 / CLI harness):

```json
{
  "message_lane": "new_booking_inquiry",
  "booking_intake_ready": true,
  "readiness_state": "ready_for_availability_check",
  "extracted_fields": { "guest_count": 2, "package_interest": "malibu", "check_in": "2026-07-10", "check_out": "2026-07-17" },
  "quote": { "quote_status": "ready", "quote_total_cents": 59800, "payment_choice_needed": true },
  "availability": { "availability_status": "available" },
  "payment_choice": { "payment_choice": "deposit", "payment_choice_ready": true },
  "last_review_artifact_id": "uuid",
  "last_inbound_message_id": "wamid..."
}
```

**Do not persist** full nested engine responses, raw LLM traces, or Turn-3-sized JSON in conversation metadata.

### 5.4 Proposed draft reply storage

| Field | Stored |
|-------|--------|
| `proposed_luna_reply` | ✓ text |
| `proposed_next_action` | ✓ |
| `automation_gate` snapshot | ✓ slim |
| `handoff_reasons` | ✓ |
| Full `review` JSON | Optional compressed blob for Staff Portal debug panel only; not re-posted to orchestrator wholesale |

### 5.5 Idempotent repeated inbound

1. n8n receives duplicate Meta delivery  
2. Staff API lookup by `idempotency_key`  
3. If found → return stored artifact + `idempotent_replay: true`  
4. No duplicate conversation events beyond single "replay noted" audit line  

---

## 6. Non-booking lanes

For **27x-lite through 27x.4**, all lanes are **classify + draft reply only**. No mutations.

| Lane | Orchestrator behavior | Writes |
|------|----------------------|--------|
| `new_booking_inquiry` | Full chain through hold **plan** | ❌ |
| `add_service_request` | Classify + draft ask/clarify | ❌ |
| `transfer_request` | Classify + handoff or info gather; **no invented prices/flights** | ❌ |
| `payment_balance_question` | Read booking/payment state from DB if linked; else handoff | ❌ |
| `check_in_logistics_faq` | Policy FAQ draft from config; low confidence → handoff | ❌ |
| `cancel_change_request` | Classify; paid change → `staff_handoff_required` | ❌ |
| `general_question` | Short draft; may skip availability/quote | ❌ |
| `staff_handoff_required` | Handoff note draft; automation stops | ❌ |

Payment truth, refunds, room assignment, and confirmation content always come from **engine/DB/webhook** — never guest-message inference alone.

---

## 7. Safety limits

| Limit | Policy |
|-------|--------|
| No public auto-send | Master NO_GO; `sends_whatsapp: false` on all inbound review responses |
| No Meta/n8n activation changes | 27x-lite is design only; 27x.2 enables pipe in **disabled/dry-run** |
| No live WhatsApp sends | `WHATSAPP_DRY_RUN=true`; no outbound n8n send nodes |
| No production DB | Staging tenant / staging DB only for proofs |
| No Stripe live mode | `sk_test_` only; no guest payment links from inbound |
| No confirmation send | 27r/27s not called from inbound path |
| No payment truth from guest text | 27p webhook only |
| Luna cannot invent | Availability, prices, payment state, rooms, flights — **27t §7** |

Default flags on every inbound review response: `dry_run: true`, `live_send_blocked: true`, `sends_whatsapp: false`, `no_write_performed: true`, `calls_n8n: false`.

---

## 8. Next implementation sequence

| Stage | Scope | Public automation | Outbound |
|-------|-------|-------------------|----------|
| **27x.1** | Staff API `POST /staff/bot/guest-inbound-review-dry-run` + harness; idempotency + slim context persistence | ❌ | ❌ |
| **27x.2** | n8n staging pipe → review endpoint; workflow **disabled** or dry-run flag; no Meta prod | ❌ | ❌ |
| **27x.3** | Staff Portal Inbox Luna review panel; copy draft; send disabled | ❌ | ❌ |
| **27x.4** | Allowlisted inbound proof (staging phone(s) only); verify end-to-end review | ❌ | ❌ |
| **27x.5** | Limited staging guest automation — **explicit product GO** only; may enable gated writes/send per 27t/27r/27s | Staging allowlist | Staging GO only |

**Production** remains later with explicit go/no-go — not in 27x series.

### 27x.1 deliverables (next code slice)

- Route + handler delegating to `runGuestAutomationOrchestratorDryRun`
- `idempotency_key` dedupe store
- Conversation upsert + inbound message row
- Slim `guest_context` load/save
- Harness script mirroring n8n payload
- Verifier; no n8n/Meta wiring

---

## 9. Proven chain reference (do not bypass)

Inbound review **calls the same orchestrator** proven in 27u/27v/27w:

```
27b router → 27g availability → 27i quote → 27k payment choice → 27m hold plan
  (review only on inbound path)
27n hold write · 27o Stripe link · 27p payment truth · 27q preview · 27r/27s send
  (staff/simulator explicit actions only until 27x.5 GO)
```

---

## 10. Related docs

- [STAGE-27W-LUNA-GUEST-SIMULATOR.md](STAGE-27W-LUNA-GUEST-SIMULATOR.md) — manual harness; auto-chains `guest_context` (27w.9)
- [STAGE-27V-GUEST-AUTOMATION-REVIEW.md](STAGE-27V-GUEST-AUTOMATION-REVIEW.md) — current staff review endpoint shape
- [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md) — engine boundaries
- [PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md](PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md) — inbox message thread UX
