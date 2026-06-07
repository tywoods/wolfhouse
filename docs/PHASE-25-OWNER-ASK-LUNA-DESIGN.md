# Phase 25 — Owner Ask Luna + allowlisted WhatsApp (design lock)

**Status:** DESIGN LOCK (no implementation in this document)  
**Date:** 2026-06-07  
**Scope:** Owner/operator Ask Luna — Staff Portal + allowlisted owner WhatsApp  
**Explicitly out of scope:** Guest-facing AI intake → **Stage 26**

---

## 1. Product direction

**Stage 25 is NOT guest-facing AI.** Guest AI intake/extraction moves to **Stage 26**.

**Stage 25 delivers:**

- **Owner Ask Luna** — read-only business intelligence over client data
- **Operator Ask Luna** — operational read-only questions (subset/narrower catalog)
- Access from **Staff Portal** (session auth) and **allowlisted owner/operator WhatsApp numbers**
- **Working and testable in staging** when each slice lands — not shadow-mode-only, not “copy manually forever”

**Wolfhouse (`wolfhouse-somo`) owner access:** all three are **owner**:

| Display | Role | Notes |
|---------|------|-------|
| Ty | owner | Wolfhouse owner |
| Ale | owner | Wolfhouse owner |
| Cami | owner | Wolfhouse owner |

Future clients retain **operator** and **owner** roles (admin may be added later for cross-client staff; not required for 25 core).

---

## 2. Roles and access

| Role | Staff Portal | WhatsApp (allowlisted) | Ask Luna scope |
|------|--------------|------------------------|----------------|
| **owner** | Full Owner mode + Operator mode | Yes — direct replies | Broad read-only BI + operational queries |
| **operator** | Operator mode only | Yes — direct replies | Operational queries only |
| **admin** (future) | TBD cross-client | Optional later | Deferred — not Stage 25 core |

**Session auth (Staff Portal):** existing staff roles map to Ask Luna mode visibility:

- `owner` / `admin` → Owner mode + Operator mode tabs
- `operator` / `viewer` (operational staff) → Operator mode only

**WhatsApp auth:** `staff_phone_access` row for `(client_slug, phone_e164, channel='whatsapp')` with `is_active=true` and role `owner` or `operator`.

---

## 3. `staff_phone_access` table

New table for allowlisted staff/owner phones (staging seed + future admin UI).

```sql
CREATE TABLE staff_phone_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug  TEXT NOT NULL,
  phone_e164   TEXT NOT NULL,
  display_name TEXT,
  role         TEXT NOT NULL CHECK (role IN ('operator', 'owner')),
  channel      TEXT NOT NULL DEFAULT 'whatsapp',
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_slug, phone_e164, channel)
);

CREATE INDEX idx_staff_phone_access_lookup
  ON staff_phone_access (client_slug, phone_e164, channel)
  WHERE is_active = true;
```

### Phone normalization rules

1. **Inbound (Meta `from_phone`):** strip spaces, `+`, dashes, parentheses; retain digits; if missing country code, apply client default (Wolfhouse: `+351` or configured per client).
2. **Storage:** prefer **E.164** in `phone_e164` (e.g. `+351912345678`).
3. **Matching:** normalize both sides to digits-only comparison **or** canonical E.164 before lookup — never partial/substring match on raw Meta payloads.
4. **Display:** `display_name` for staff UI; phone shown masked in operator views where policy requires.

### Wolfhouse seed (25b)

Seed Ty, Ale, Cami as `role='owner'`, `client_slug='wolfhouse-somo'`, `channel='whatsapp'`, `is_active=true` (exact E.164 from staging Meta test numbers or owner-provided).

**Allowed writes in Stage 25:** migrations + seed/update of `staff_phone_access` in **staging/test** only for proof. No production DB cutover in 25.

---

## 4. WhatsApp routing

### Routing order (Meta inbound)

```
Meta inbound webhook received
    │
    ▼
Resolve client_slug (existing phone-number-id / WABA mapping)
    │
    ▼
Normalize from_phone → phone_e164 candidate
    │
    ▼
SELECT staff_phone_access
  WHERE client_slug = ?
    AND phone_e164 matches normalized from_phone
    AND channel = 'whatsapp'
    AND is_active = true
    │
    ├─ HIT (role owner|operator)
    │       ▼
    │   Staff/Owner Ask Luna path
    │   • source=staff_whatsapp (or owner_whatsapp)
    │   • NO guest conversation create
    │   • NO guest booking preview/write
    │   • NO payment link generation
    │   • NO handoff-to-staff as guest
    │   • Read-only Ask Luna answer → WhatsApp reply (when safe)
    │
    └─ MISS
            ▼
        Normal guest Luna flow (unchanged)
        • guest message intake
        • booking inquiry routing
        • existing deterministic/template guest replies
```

### Critical invariant

**Owner/staff WhatsApp messages must not accidentally create guest conversations, bookings, payment links, or handoffs.** Router runs **before** guest intake side effects. Owner path is a **hard fork** with explicit early return from guest pipelines.

### Staging behavior

When 25c+ slices ship, allowlisted owner WhatsApp gets **real replies in staging** (`WHATSAPP_DRY_RUN` may log-only per env — but flow is not disabled placeholder). No shadow-mode-only design.

---

## 5. Owner Ask Luna capability (read-only)

Owner may ask broader **read-only business intelligence** questions, e.g.:

| Domain | Example questions |
|--------|-------------------|
| Revenue | Revenue this month; revenue by package |
| Balances | Outstanding balance; who owes; deposit vs balance due |
| Packages | Package popularity; mix by month |
| Occupancy | Occupancy by date/room; underbooked dates |
| Add-ons | Add-on revenue; lessons/meals/gear attach rate |
| Bookings | Bookings by source; conversion funnel counts |
| Payments | Payment status breakdown; link sent vs paid |
| Cancellations | Cancellations/refunds if data exists in ledger |

All answers sourced from **validated SELECT** against curated catalog — not free-form SQL in LLM output executed blindly.

---

## 6. Operator Ask Luna capability (read-only)

Operator scope (existing Ask Luna registry + ops planner emphasis):

| Domain | Example questions |
|--------|-------------------|
| Arrivals/checkouts | Who arrives tomorrow; departures today |
| Payments ops | Who owes; payment links pending |
| Services | Who has lessons; gear booked; meals/yoga |
| Housekeeping | Who needs cleaning; turnover |
| Transfers | Who requested transfer (when transfer table exists) |
| Handoffs | Who needs human reply |

**Future clients:** operators get this slice only; owners get operator + BI catalog.

For **Wolfhouse**, Ty/Ale/Cami use **owner** role → full capability.

---

## 7. Owner read-only SQL model

### Principles

- AI may **plan** SELECT queries against the **owner data catalog** only
- **Staff API validates** every query before execution
- **Staff API executes** read-only query server-side
- AI never receives DB credentials; no direct DB access from model

### Validator rules (hard reject)

| Rule | Enforcement |
|------|-------------|
| Statement type | **SELECT only** — single statement |
| Blocked keywords | No INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, COPY, CREATE, GRANT, REVOKE |
| Multi-statement | Reject `;` chaining (except trailing optional) |
| Client scope | **`client_slug` enforced** — every query must join/filter `clients.slug = $client` or equivalent approved pattern |
| Row limit | **`LIMIT` enforced** — default cap (e.g. 500), max cap (e.g. 2000) |
| Timeout | **Query timeout** (e.g. 5s staging, 10s prod later) |
| Cross-client | Reject queries touching multiple clients or missing client filter |
| Secrets | No `pg_catalog`, env, credential tables; no arbitrary file/external |
| Functions | Allowlist safe aggregates only; block `pg_sleep`, `dblink`, copy-to-program patterns |

### Execution path

```
Owner question
  → classify (owner vs operator intent)
  → AI SQL planner (catalog-bound, SELECT template)
  → validator approves/rejects (+ reason)
  → read-only executor (parameterized client_slug)
  → optional AI answer formatter (rows → natural language)
  → Staff Portal JSON or WhatsApp text
```

---

## 8. Owner data catalog

Curated, documented tables/columns AI may reference. Versioned JSON or code registry (25e).

| Entity | Include | Sensitive field policy |
|--------|---------|------------------------|
| `bookings` | codes, dates, status, guest_name, counts, source | guest phone/email: **owner yes**, operator masked optional |
| `payments` | amounts, status, type, due dates | hide Stripe IDs unless needed for “link sent” status |
| `booking_beds` | room/bed assignment | — |
| `booking_service_records` | add-ons, lessons, gear | — |
| `rooms` / beds config | capacity, labels | — |
| `guest_message_events` | counts, timestamps, direction | **raw_payload hidden by default** |
| `conversations` / messages | operational inbox context | operator subset; owner broader |
| `transfer` (when built) | transfer requests | — |

**Never visible:** API keys, Key Vault refs, webhook secrets, full payment provider payloads, arbitrary JSON blobs unless explicitly allowlisted columns.

Catalog entries define: table name, allowed columns, required joins, example filters, max date range.

---

## 9. Owner answer flow (end-to-end)

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Staff Portal    │     │ Allowlisted      │     │ Guest WhatsApp  │
│ (session auth)  │     │ owner WhatsApp   │     │ (not allowlisted)│
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │                       │                        │
         └───────────┬───────────┘                        │
                     ▼                                    ▼
              Owner/Operator Ask Luna              Guest Luna (Stage 26+ intake)
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
   classify role scope     (operator vs owner catalog)
         ▼
   AI SQL planner (catalog-only)
         ▼
   validator (SELECT, client_slug, LIMIT, timeout)
         ▼
   read-only execute
         ▼
   AI format answer (optional; deterministic fallback)
         ▼
   Response → Portal JSON / WhatsApp text
```

---

## 10. WhatsApp response behavior (allowlisted owner)

- **Answer directly in WhatsApp** when query validated and result safe to summarize
- If query too broad, ambiguous, or fails validation → **safe clarification** or blocked explanation (no silent failure, no guest fallback)
- **No shadow placeholder** — staging sends real template/text replies per `WHATSAPP_DRY_RUN` policy
- **No guest booking side effects**
- **No payment links**
- **No Stripe** calls from owner Ask Luna path

---

## 11. Staff Portal Owner mode (25i)

**Ask Luna tab** modes:

| Mode | Visible to | Capability |
|------|------------|------------|
| **Operator mode** | operator, owner, admin | Registry + ops planner (existing + polish) |
| **Owner mode** | owner, admin only | Owner BI catalog + SQL planner path |

**Owner mode UI (design):**

- Question input (same surface, mode toggle)
- Answer text (natural language)
- Metadata: sources/tables used, `row_count`, elapsed ms
- Optional accordion: approved SQL (read-only, for debugging — owner only)
- No execute/edit SQL in browser

---

## 12. Audit log

**Deferred — not in Stage 25 core build.** User explicitly skipped audit log for now. Future phase may log: question hash, catalog query id, row count, role, channel — not full PII dumps.

---

## 13. Safety boundaries

### Allowed in Stage 25

- Staging DB **reads** (validated SELECT)
- Read-only owner/operator questions
- Allowlisted owner **WhatsApp replies in staging**
- Staff Portal Owner mode
- Test/staging **writes** for `staff_phone_access` seed/admin only

### Explicit go/no-go (not Stage 25)

- Production live cutover
- Real Stripe / refunds / payment actions from owner path
- Destructive DB writes (except allowlist admin)
- Meta **production** webhook cutover
- **n8n** activation
- Production DB/data changes

Also unchanged: guest WhatsApp reply path remains deterministic/template until Stage 26 scopes guest AI.

---

## 14. Stage 25 implementation roadmap (working slices)

Each slice should be **deployable and testable in staging** — no shadow-mode-only.

| Slice | ID | Deliverable | Proof |
|-------|-----|-------------|-------|
| Allowlist table | **25b** | Migration `staff_phone_access` + lookup helper + seed Ty/Ale/Cami as owner | Unit verifier + staging row check |
| WhatsApp router | **25c** | Early fork: owner phone → Ask Luna; else guest | Inbound proof: owner message no guest event |
| SQL validator | **25d** | SELECT-only validator + executor shell (no AI yet) | Verifier rejects writes/multi-statement |
| Data catalog | **25e** | Owner catalog registry + column allowlist | Verifier catalog completeness |
| AI SQL planner | **25f** | LLM plans catalog-bound SELECT; no execute without validator | Mock planner tests |
| Query + answer | **25g** | End-to-end: plan → validate → execute → format | Portal owner question proof |
| Owner WhatsApp | **25h** | Allowlisted owner gets WhatsApp reply; no guest side effects | Hosted proof Ty/Ale/Cami number |
| Portal Owner mode | **25i** | UI toggle Owner/Operator; metadata display | UI verifier |
| Closeout | **25j** | Doc + closeout verifier | Full chain PASS |

**Not in roadmap:** audit log slice (deferred).

---

## 15. Stage 26 preview (deferred)

**Guest AI intake/extraction only** — structured field fill from inbound guest messages; deterministic engine remains source of truth; **no generative guest replies** in initial 26 slice. Do not implement in Stage 25.

---

## 16. Related existing assets (Phase 24)

Stage 25 owner BI path may reuse **shared AI provider** (`luna-ai-provider.js`) for planner/formatter with **separate prompts and validators** — distinct from guest path. Phase 24 proved OpenAI on staging (`LUNA_AI_PROVIDER=openai`, fingerprint `fd617f34`); owner SQL planner adds new validation layer not present in registry-only Ask Luna.

---

## 17. Focused verifier (design gate)

`npm run verify:luna-agent-phase25-owner-design` — static doc checks only; no runtime, no OpenAI calls.
