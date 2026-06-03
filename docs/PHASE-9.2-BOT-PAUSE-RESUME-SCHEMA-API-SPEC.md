# Phase 9.2 — Bot Pause/Resume Schema & API Spec

**Status:** PASS — docs-only schema/API contract (2026-06-03).  
**Parent:** Phase 9 — Control & Safety  
**Prior:** [PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md](PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md) (PASS, commit `4be36d3`)  
**Next:** Phase 9.5 — Inbox live pause-state wiring / hosted proof

**Non-negotiables (this slice):** No code. No migration file. No DB apply. No API routes. No UI. No deploy. No n8n activation. No WhatsApp. No Stripe. No DB writes.

**Context:** Stage 8 **CLOSED** (Staff Portal + Ask Luna + add-on dry-run foundation). Live WhatsApp **NO_GO**. n8n workflows **inactive** unless explicitly approved. Pause/resume blocks **automated guest replies only**; Staff Ask Luna continues.

**Migration 012 apply status (2026-06-03):** Applied on **staging/test DB only** — `wh-staging-pg-app` / `wolfhouse_staging` (Phase 9.4c). Repo file `database/migrations/012_bot_pause_states.sql` retains **NOT YET APPLIED** header for local/production; **do not assume production/local apply.**

---

## 1. Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| **9.1** | Bot pause/resume design | **PASS** |
| **9.2** | Pause/resume schema/API spec | **PASS** |
| **9.3** | Inbox paused status display (read-only) | **PASS** |
| **9.4a** | Migration spec + static verifier | **PASS** |
| **9.4b** | Gated pause/resume API handlers | **PASS** |
| **9.4b.1** | Schema verifier aligned with API routes | **PASS** |
| **9.4c** | Staging migration apply + runtime API proof | **PASS** |
| **9.5** | Inbox live pause-state from API | **Next** |
| **9.6** | n8n dry-run respects pause | Planned |

---

## 2. Schema spec — `bot_pause_states`

**Migration file:** `database/migrations/012_bot_pause_states.sql` (created Phase 9.4a). **Staging apply:** Phase 9.4c — `wh-staging-pg-app` / `wolfhouse_staging` only. **Not applied** to production or assumed for local unless explicitly run.

### 2.1 Columns

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | Primary key |
| `client_slug` | `TEXT` | NOT NULL | — | Tenant scope (e.g. `wolfhouse-somo`) |
| `guest_phone` | `TEXT` | NULL | — | E.164 preferred; nullable when `conversation_id` set |
| `conversation_id` | `TEXT` | NULL | — | UUID string → `conversations.id`; nullable when `guest_phone` set |
| `booking_id` | `UUID` | NULL | — | Optional context; not part of uniqueness key |
| `booking_code` | `TEXT` | NULL | — | Denormalized display (e.g. `MB-WOLFHO-…`) |
| `paused` | `BOOLEAN` | NOT NULL | `true` | `true` = guest automation blocked |
| `pause_reason` | `TEXT` | NULL | — | Optional staff note |
| `paused_by` | `TEXT` | NOT NULL | — | Staff actor (see §6 open questions) |
| `paused_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | Set on pause |
| `resumed_by` | `TEXT` | NULL | — | Set on resume |
| `resumed_at` | `TIMESTAMPTZ` | NULL | — | Set on resume |
| `metadata` | `JSONB` | NOT NULL | `'{}'` | Extensibility + optional audit extras |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | Row created |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | Row touch (`set_updated_at` trigger) |

### 2.2 Constraints and rules

| Rule | Spec |
|------|------|
| `client_slug` | Required on every row |
| Scope key | **At least one** of `guest_phone` or `conversation_id` required (`CHECK`) |
| Primary lookup | **Prefer `conversation_id`** when Inbox/conversation row exists |
| Booking context | `booking_id` / `booking_code` optional; never primary key |
| Active pause uniqueness | **One active paused row** per `(client_slug, conversation_id)` when `conversation_id IS NOT NULL AND paused = true` — partial unique index |
| Phone fallback | **One active paused row** per `(client_slug, guest_phone)` when `conversation_id IS NULL AND paused = true` — partial unique index |
| Expiry | **Manual-only for MVP** — no auto-expire; staff must resume |
| Scope | **Per conversation/thread for MVP** — not global across all bookings for a guest phone |
| FK (optional) | `conversation_id` values must match `conversations.id`; `booking_id` → `bookings.id` when set |
| History | On resume, set `paused = false`, `resumed_by`, `resumed_at`; **retain row** for audit (do not DELETE) |

### 2.3 Indexes (design intent)

- Partial unique: `(client_slug, conversation_id) WHERE paused = true AND conversation_id IS NOT NULL`
- Partial unique: `(client_slug, guest_phone) WHERE paused = true AND conversation_id IS NULL`
- Lookup: `(client_slug, conversation_id)` and `(client_slug, guest_phone)`

### 2.4 Static verifier (future 9.2+ implementation slice)

When migration is authored: static verifier checks DDL, constraints, partial uniques, and column defaults — same pattern as `verify-service-payment-linkage-schema.js`. **Not created in 9.2.**

---

## 3. API contract spec (proposed — not implemented)

**Auth:** Staff session (`requireAuth`, operator+ for writes). Bot/n8n reads via internal helper or authenticated bot path in later slices.

**Base path:** `/staff/bot/…` (alongside existing `/staff/bot/addon-request-preview`, etc.)

### 3.1 `GET /staff/bot/pause-state`

**Query parameters:**

| Param | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | Tenant |
| `conversation_id` | — | Prefer when available |
| `guest_phone` | — | Fallback when no conversation |
| `booking_code` | — | Optional; narrows display context only, not lookup key |

**Lookup order:**

1. If `conversation_id` → `(client_slug, conversation_id)` where `paused = true`
2. Else if `guest_phone` → `(client_slug, guest_phone)` where `conversation_id IS NULL AND paused = true`
3. Else → not paused (default active)

**Response 200:**

```json
{
  "success": true,
  "paused": false,
  "client_slug": "wolfhouse-somo",
  "guest_phone": "+34999000123",
  "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
  "booking_id": null,
  "booking_code": null,
  "pause_reason": null,
  "paused_by": null,
  "paused_at": null,
  "resumed_by": null,
  "resumed_at": null,
  "updated_at": null,
  "source": "default_active"
}
```

When a paused row exists, same shape with `paused: true`, populated audit fields, `"source": "bot_pause_states"`.

**Errors:** `400` missing `client_slug` or both scope keys; `401` unauthenticated.

---

### 3.2 `POST /staff/bot/pause`

**Request body:**

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | |
| `conversation_id` | — | Prefer when available |
| `guest_phone` | — | Required if no `conversation_id` |
| `booking_id` | — | Optional context |
| `booking_code` | — | Optional context |
| `pause_reason` | — | Optional staff note |
| `staff_user` | ✓ | Actor id/email (see §6; session may override) |

**Behavior:**

- Validate scope key (at least one of `conversation_id`, `guest_phone`)
- If active paused row exists for scope → **idempotent** return existing row (`200`)
- Else INSERT with `paused = true`, audit fields
- **No** booking/payment/service mutation
- **No** WhatsApp send

**Response 200:**

```json
{
  "success": true,
  "paused": true,
  "bot_paused": true,
  "live_send_blocked": true,
  "pause_state": {
    "id": "…",
    "client_slug": "wolfhouse-somo",
    "conversation_id": "…",
    "guest_phone": "+34999000123",
    "booking_id": null,
    "booking_code": "MB-WOLFHO-20260901-cb4799",
    "paused": true,
    "pause_reason": "Staff handling checkout question",
    "paused_by": "…",
    "paused_at": "2026-06-03T12:00:00.000Z",
    "resumed_by": null,
    "resumed_at": null,
    "metadata": {},
    "updated_at": "2026-06-03T12:00:00.000Z"
  }
}
```

---

### 3.3 `POST /staff/bot/resume`

**Request body:**

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | |
| `conversation_id` | — | Prefer when available |
| `guest_phone` | — | Required if no `conversation_id` |
| `staff_user` | ✓ | Actor |

**Behavior:**

- Find active paused row for scope
- If none → **200** with `paused: false`, `source: default_active` (idempotent no-op)
- Else UPDATE: `paused = false`, `resumed_by`, `resumed_at`, `updated_at`
- **No** booking/payment/service mutation
- **No** WhatsApp send

**Response 200:**

```json
{
  "success": true,
  "paused": false,
  "bot_paused": false,
  "pause_state": {
    "id": "…",
    "client_slug": "wolfhouse-somo",
    "conversation_id": "…",
    "guest_phone": "+34999000123",
    "paused": false,
    "paused_by": "…",
    "paused_at": "2026-06-03T12:00:00.000Z",
    "resumed_by": "…",
    "resumed_at": "2026-06-03T12:30:00.000Z",
    "metadata": {},
    "updated_at": "2026-06-03T12:30:00.000Z"
  }
}
```

---

## 4. Enforcement contract (automated guest replies)

Before any **automated guest reply** (booking, add-on, confirmation, generic Luna guest path — when live paths exist):

1. Caller (n8n HTTP node or Staff API guest-automation handler) **must check pause state** via internal lookup or `GET /staff/bot/pause-state`.
2. If **paused**:
   - **Do not** send guest WhatsApp message
   - Preserve or return **draft reply** / handoff note for staff
   - Response **must** include: `bot_paused: true`, `live_send_blocked: true`, `whatsapp_sent: false`
3. If **not paused**: existing gates apply (`dry_run`, `WHATSAPP_DRY_RUN`, explicit GO).

**Staff Ask Luna — not blocked:**

| Path | Pause check |
|------|-------------|
| `POST /staff/ask-luna` with `source: staff_portal` | **Skip** |
| `POST /staff/ask-luna` with `source: staff_whatsapp` (allowlisted) | **Skip** |
| Guest automation / bot endpoints that would reply to guest | **Required** |

**Recommended integration point:** shared helper `resolveBotPauseState(client_slug, conversation_id, guest_phone)` inside `staff-query-api.js` (implementation in 9.4+), called from bot reply formatters and n8n-facing bot routes.

---

## 5. Audit and source-of-truth notes

| Topic | Rule |
|-------|------|
| Writes | Pause/resume are **staff-controlled writes** only (operator+ when implemented) |
| Audit | Every write records `staff_user` → `paused_by` / `resumed_by`, timestamps, optional `pause_reason`, `metadata` |
| Bookings | **Must not** mutate `bookings`, `booking_beds`, or booking payment fields |
| Payments | **Must not** mutate `payments` or trigger Stripe |
| Service records | **Must not** mutate `booking_service_records` |
| Stripe webhook | Remains **payment truth** for booking and `addon_service` payments — unchanged |
| Chat logs | **Not** structured SoT for pause state |
| n8n | Workflows remain **inactive** until explicit approval |
| WhatsApp | **No** live send in Phase 9.2 |

---

## 6. Open questions (resolve before implementation)

| # | Question | Current evidence / recommendation |
|---|----------|-----------------------------------|
| Q1 | Confirm conversation identifier name in schema | **`conversations.id`** (UUID PK) in `001_init.sql`; Staff Inbox uses `GET /staff/conversations` and `/staff/conversations/:id/…`. Store as TEXT UUID string in `bot_pause_states.conversation_id`. |
| Q2 | Confirm `staff_user` source | Session loader returns `staff_user_id` (UUID) from `staff_users` + email at login. **Recommend:** persist `staff_users.id::text` in `paused_by`/`resumed_by`; accept `staff_user` in API body for proofs only; production writes derive from session. |
| Q3 | Confirm `guest_phone` normalization | Inbox/conversations use `conversations.phone` (NOT NULL). Bot paths trim `guest_phone` but no shared E.164 normalizer found. **Recommend:** normalize to E.164 on write (same helper as WhatsApp inbound when added); document in 9.4. |
| Q4 | Audit: `metadata` vs shared audit table | **Recommend MVP:** row-level audit columns + optional `metadata.audit[]` append; defer shared `staff_audit_events` unless cross-feature audit needed in 9.4. |

---

## 7. Safety checklist (Phase 9.2)

- [x] Schema/API spec only — no migration file created
- [x] No API route implementation
- [x] No UI changes
- [x] No deploy
- [x] No n8n activation
- [x] No WhatsApp
- [x] No Stripe changes
- [x] No DB writes
- [x] Live WhatsApp remains **NO_GO**

---

## 8. References

- Design: [PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md](PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md)
- Conversations DDL: `database/migrations/001_init.sql` (`conversations`)
- Stage 8 closeout: [PROJECT-STATE.md](PROJECT-STATE.md), [ROADMAP.md](ROADMAP.md)
