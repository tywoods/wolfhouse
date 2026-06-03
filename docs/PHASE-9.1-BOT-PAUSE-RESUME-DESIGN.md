# Phase 9.1 — Bot Pause/Resume Design

**Status:** PASS — docs-only design (2026-06-03).  
**Parent:** Phase 9 — Control & Safety  
**Non-negotiables:** No code. No DB apply. No API routes. No UI. No deploy. No n8n activation. No WhatsApp. No Stripe.

**Context:** Stage 8 is **closed** as the Staff Portal + Ask Luna + add-on dry-run foundation. Guest/client Luna booking WhatsApp is **not** fully live. Live WhatsApp remains **NO_GO** (8.6.8 / 8.8.1 / 8.8.33). Staff must be able to **control Luna** before any live guest automation.

---

## 1. Purpose

Staff need an explicit, auditable way to **pause** Luna for a guest conversation when they want to handle it manually, and **resume** when automation may continue.

Pause/resume must be:

- **Visible** in Staff Portal (Inbox) before live guest automation goes live.
- **Scoped** to automated **guest** replies only — not Staff Ask Luna.
- **Separate** from payment truth, booking truth, and chat-log inference.

---

## 2. Scope

| In scope | Out of scope (this phase) |
|----------|---------------------------|
| Pause state per guest conversation/thread | Live WhatsApp send |
| Optional link to `booking_id` / `booking_code` when known | n8n workflow activation |
| Pause by `guest_phone` and/or `conversation_id` when booking unknown | Booking or payment mutation |
| Block automated guest replies when paused | Stripe / webhook changes |
| Staff Portal read + toggle UI (design only) | Chat logs as operational SoT |
| Staff Ask Luna continues unchanged | Auto-expire policy (open question) |

**Pause affects:** automated guest Luna replies (n8n → Staff API → WhatsApp path, when eventually enabled).

**Pause does not affect:** Staff Portal Ask Luna (`POST /staff/ask-luna`, `source=staff_portal`); staff WhatsApp Ask Luna dry-run; payment webhooks; booking drawer; structured service queries.

---

## 3. Recommended data model

**Prefer a dedicated `bot_pause_states` table** rather than extending `conversations`, `staff_handoffs`, or session blobs.

**Reason:** Pause/resume is a staff-controlled operational flag with audit requirements. It must not be mixed with payment truth, booking lifecycle, handoff reason codes, or chat-log-only state.

### 3.1 Table: `bot_pause_states`

| Column | Type | Required | Notes |
|--------|------|----------|-------|
| `id` | UUID | ✓ | Primary key |
| `client_slug` | TEXT | ✓ | Tenant scope (e.g. `wolfhouse-somo`) |
| `guest_phone` | TEXT | — | E.164; nullable if `conversation_id` set |
| `conversation_id` | UUID | — | FK → `conversations(id)`; nullable if `guest_phone` set |
| `booking_id` | UUID | — | FK → `bookings(id)`; optional context |
| `booking_code` | TEXT | — | Denormalized for staff display |
| `paused` | BOOLEAN | ✓ | `true` = guest automation blocked |
| `pause_reason` | TEXT | — | Optional staff note |
| `paused_by` | TEXT | ✓ | Staff user id or email |
| `paused_at` | TIMESTAMPTZ | ✓ | Set on pause |
| `resumed_by` | TEXT | — | Set on resume |
| `resumed_at` | TIMESTAMPTZ | — | Set on resume |
| `metadata` | JSONB | ✓ | Default `{}`; extensibility |
| `updated_at` | TIMESTAMPTZ | ✓ | Row touch |

**Constraints (design intent):**

- At least one of `guest_phone` or `conversation_id` must be present.
- Unique active pause per scope key, e.g. partial unique index on `(client_slug, conversation_id) WHERE paused = true AND conversation_id IS NOT NULL`, and analogous for `(client_slug, guest_phone)` when no conversation id.
- **Do not** store pause state only in n8n static data or conversation message text.

### 3.2 Why not reuse existing tables?

| Existing | Gap |
|----------|-----|
| `conversations` | Message/thread container; no pause audit fields; mixing ops flags pollutes guest comms model |
| `staff_handoffs` | “Needs human” escalation, not reversible pause/resume; different lifecycle |
| Chat / n8n session | Not audit-ready SoT; not staff-authoritative |

---

## 4. Staff Portal behavior (design)

**Location:** Inbox conversation detail panel.

| Element | Behavior |
|---------|----------|
| Status badge | **Luna active** (green/neutral) or **Luna paused** (amber) |
| Primary action | **Pause Luna** when active; **Resume Luna** when paused |
| Pause detail | When paused: show `paused_by`, `paused_at`, optional `pause_reason` |
| Booking context | If `booking_code` known, show inline (“Paused for MB-WOLFHO-…”) |
| Live send | **None** in 9.1 — toggle writes pause state only (future API slice) |

**Needs Human filter:** Unchanged in 9.1. Phase 9.3 may add visual distinction between “needs human” and “Luna paused” (can overlap).

---

## 5. n8n / Luna behavior

Before any **automated guest reply** (preview, booking, add-on, confirmation — when live paths exist):

1. n8n or Staff API **checks pause state** for `(client_slug, conversation_id | guest_phone)`.
2. If **paused**:
   - Do **not** send guest WhatsApp message.
   - Preserve or return **draft reply** / handoff note for staff review.
   - Response flags: `live_send_blocked: true`, `bot_paused: true`, `whatsapp_sent: false`.
3. If **not paused**: existing dry-run / live-send gates apply (`dry_run`, `WHATSAPP_DRY_RUN`, explicit GO).

**Staff Ask Luna:** Always allowed — pause check is **skipped** for `source=staff_portal` and allowlisted `source=staff_whatsapp`.

**Recommended check location:** Staff API helper (e.g. `GET /staff/bot/pause-state` or internal lookup inside bot reply endpoints) so n8n stays a thin pipe.

---

## 6. Safety

| Rule | Enforcement |
|------|-------------|
| Staff-controlled write only | Pause/resume via authenticated staff API (Phase 9.4); operator+ role |
| Audited | `paused_by` / `paused_at` / `resumed_by` / `resumed_at`; optional `workflow_events` |
| No WhatsApp in 9.1 | Design only |
| No n8n activation | Workflows remain inactive |
| No booking mutation | Pause rows are separate table |
| No payment mutation | No touch to `payments` / `bookings.payment_status` |
| No Stripe / webhook changes | Payment truth unchanged |
| No chat-log SoT | Structured tables only |

---

## 7. Implementation phases (Phase 9 sequence)

| Phase | Scope | Delivers |
|-------|-------|----------|
| **9.1** | Bot pause/resume design | **This doc** — PASS |
| **9.2** | Pause/resume schema/API spec | [PHASE-9.2-BOT-PAUSE-RESUME-SCHEMA-API-SPEC.md](PHASE-9.2-BOT-PAUSE-RESUME-SCHEMA-API-SPEC.md) — **PASS** |
| **9.3** | Inbox paused status display | Read-only badge + detail — **PASS** (PARTIAL verifier acceptable) |
| **9.4** | Gated pause/resume API + staging migration | **9.4a–9.4c PASS** |
| **9.5** | Inbox live pause-state + hosted proof | **PASS** |
| **9.5b** | Inbox Pause/Resume buttons + hosted button proof | **PASS** |
| **9.6** | Guest automation gate (`check-guest-automation-gate`) + hosted proof | **PASS** (API gate; n8n wiring deferred) |

**Phase 9 status:** **COMPLETE ENOUGH / PASS (2026-06-03).** Latest hosted: **`7360c24`** / `7360c24-stage95b-inbox-pause-buttons` / revision **`--0000046`**. **Live WhatsApp: NO_GO.** **n8n: inactive unless explicitly approved.** **Production DB / guest automation: NO_GO.**

**After Phase 9:** **Phase 10.1** — Manual booking operational polish — then Phase 10 (Staff Operations Polish), Phase 11 (Guest Luna Booking Dry-Run), etc. — see [ROADMAP.md](ROADMAP.md).

---

## 8. Open questions

| # | Question | Options / notes |
|---|----------|-----------------|
| Q1 | What existing table represents guest conversations cleanly? | `conversations` (001_init) has `id`, guest linkage; `staff_handoffs` references `conversation_id`. **Likely:** pause keys primarily on `conversation_id`, fallback `guest_phone`. |
| Q2 | First implementation key: `conversation_id` or `guest_phone`? | **Recommend:** `conversation_id` when Inbox row exists; `guest_phone` for pre-conversation / webhook-only threads. |
| Q3 | Should pause auto-expire? | **Recommend:** manual-only until pilot; optional TTL in metadata later. |
| Q4 | Pause scope: one conversation vs all bookings for a phone? | **Recommend:** per **conversation/thread** (and optional `booking_id` context), not global phone ban — staff may want Luna active on a new inquiry while paused on an old thread. |

---

## 9. Stage 8 foundation (reference)

Stage 8 delivered the platform this design builds on. See [PROJECT-STATE.md](PROJECT-STATE.md) Stage 8 closeout and [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md) §13.

**Live WhatsApp:** **NO_GO**. **Guest booking WhatsApp:** not fully live. **Production guest automation:** **NO_GO**. **Phase 9:** **COMPLETE ENOUGH / PASS** — see [PHASE-9.2-BOT-PAUSE-RESUME-SCHEMA-API-SPEC.md](PHASE-9.2-BOT-PAUSE-RESUME-SCHEMA-API-SPEC.md) §1 and [PROJECT-STATE.md](PROJECT-STATE.md). **Next:** **Phase 10.1** — Manual booking operational polish.
