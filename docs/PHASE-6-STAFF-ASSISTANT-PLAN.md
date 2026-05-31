# Stage 6 — Staff / Admin Assistant Plan

**Status:** CLOSED WITH DEFERRALS (2026-05-31) — all exit criteria MET. Production auth/TLS/live-ops deferred to Stage 7.
**Prerequisites:** Stage 5 SoT cleanup CLOSED WITH DEFERRALS (de6c3c0). Migrations 007+008 applied. Luna handoff write path wired (Stage 5.9b).
**Scope:** Staff-facing operational query layer. Not guest-facing automation. Not live WhatsApp. Not production.

---

## Objective

Enable Wolfhouse staff to ask operational questions and act on Luna handoffs using structured Postgres data — without touching Airtable, n8n internals, or Luna's guest conversation flow.

**In scope for Stage 6:**
- Natural-language staff question → parameterized Postgres query (no arbitrary SQL)
- Staff handoff queue: view, filter, resolve
- Read-only first; safe write stubs later
- Client-scoped (`wolfhouse-somo`); no cross-client data

**Out of scope for Stage 6:**
- Live WhatsApp staff bridge
- Guest-facing automation changes
- Production auth/roles/multi-tenancy
- Full staff UI (calendar, bed grid)
- Analytics dashboard
- Decision-engine extraction
- Airtable cutover

---

## Staff Question → Query Helper Map

All 30+ query helpers from Stage 5 are the exclusive SQL source. The query router maps natural-language intents to a named helper — never to raw SQL.

### Payments & Balances (`staff-payment-queries.js`)

| Staff question | Query helper | Params |
|---|---|---|
| Who is waiting for payment / has a payment link pending? | `getWaitingPaymentQuery` | client_slug |
| Who paid deposit but not in full? | `getDepositPaidQuery` | client_slug |
| Who paid in full? | `getFullyPaidQuery` | client_slug |
| Who owes a remaining balance? | `getBalanceDueQuery` | client_slug |
| Who has no payment record at all? | `getNoPaymentRecordQuery` | client_slug |
| Who needs a confirmation email sent? | `getConfirmationNeededQuery` | client_slug |
| Who claimed payment but has no Stripe record? | `getPaymentClaimedNoRecordQuery` | client_slug |

### Rooming & Beds (`staff-rooming-queries.js`)

| Staff question | Query helper | Params |
|---|---|---|
| Who is in which room/bed? (rooming roster) | `getRoomingRosterQuery` | client_slug |
| Who has no bed assigned? | `getUnassignedBookingsQuery` | client_slug |
| Who needs rooming review? | `getRoomingReviewQuery` | client_slug |
| Who requested a specific room type / preference? | `getRoomingPreferencesQuery` | client_slug |
| Which beds are occupied over a date range? | `getOccupiedBedsQuery` | client_slug, start_date, end_date |
| Who is arriving and still needs a bed assignment? | `getArrivalsNeedingAssignmentQuery` | client_slug |

### Add-ons (`staff-addon-queries.js`)

| Staff question | Query helper | Params |
|---|---|---|
| Which add-ons are unpaid? | `getUnpaidAddOnsQuery` | client_slug |
| Who requested surf lessons on a given date? | `getLessonsByDateQuery` | client_slug, date |
| Who has yoga on a given date? | `getYogaByDateQuery` | client_slug, date |
| Who has a board/wetsuit rental active today? | `getActiveRentalsByDateQuery` | client_slug, date |
| What add-ons does a specific booking have? | `getAddonsByBookingQuery` | client_slug, booking_code |
| Which add-ons require staff action/scheduling? | `getStaffRequiredAddOnsQuery` | client_slug |
| Who has dinner/meals on a given date? | `getMealsByDateQuery` | client_slug, date |
| Who has an airport transfer on a given date? | `getTransfersByDateQuery` | client_slug, date |
| Which add-on requests need any staff action? | `getStaffActionRequiredAddOnsQuery` | client_slug |

### Handoffs (`staff-handoff-queries.js`)

| Staff question | Query helper | Params |
|---|---|---|
| Which conversations need a human reply? | `getOpenHandoffsQuery` | client_slug |
| Which handoffs are urgent or high priority? | `getHighPriorityHandoffsQuery` | client_slug |
| Show handoffs for a specific reason | `getHandoffsByReasonQuery` | client_slug, reason_code |
| Which payment-claimed handoffs need review? | `getPaymentClaimedHandoffsQuery` | client_slug |
| Which cancellation/refund handoffs are open? | `getCancellationRefundHandoffsQuery` | client_slug |
| Show handoffs assigned to a staff member | `getHandoffsByStaffQuery` | client_slug, staff_name |
| Which handoffs have gone stale (N hours with no response)? | `getStaleHandoffsQuery` | client_slug, hours |
| All handoffs for a specific booking | `getBookingHandoffsQuery` | client_slug, booking_code |
| Conversations marked needs_human with no handoff row | `getNeedsHumanWithoutOpenHandoffQuery` | client_slug |

---

## Architecture Recommendation

### Option A — Internal CLI / Script Runner (recommended first)

**Rationale:** lowest risk, no new auth surface, directly exercises the proven query helpers. Staff runs `node scripts/staff-query-runner.js "who has surf lessons tomorrow"` or `node scripts/staff-query-runner.js open-handoffs`.

**Pros:** zero new infra, directly proves query helpers work end-to-end, safe read-only, no web server, no auth to design yet.
**Cons:** requires staff terminal access; not a polished UX.

**This is Stage 6.0–6.4.** Stage 6.5+ adds a thin HTTP API and optionally a minimal web dashboard.

### Option B — n8n Staff Webhook (later)

A dedicated n8n workflow with a staff-facing webhook (`/staff-query`). Routes intent → PG query → formatted reply. Safe for read-only intents. **Deferred to 6.5.**

### Option C — Lightweight Web Dashboard (later)

Express/Next.js page rendering query results. Minimal, no auth beyond basic token in 6.x. **Deferred to 6.6.**

### Option D — Full Staff UI (Stage 6.7+ or Stage 7)

Calendar, bed grid, booking detail, conversation history, write actions. **Deferred.**

---

## Query API Layer Design

### `scripts/staff-query-runner.js` (Stage 6.2)

```
node scripts/staff-query-runner.js <intent> [--date YYYY-MM-DD] [--booking WH-XXXX] [--reason cancellation_request] [--staff alice]
```

**Intent allowlist (strict):**

```
waiting-payment       → getWaitingPaymentQuery
deposit-paid          → getDepositPaidQuery
fully-paid            → getFullyPaidQuery
balance-due           → getBalanceDueQuery
no-payment-record     → getNoPaymentRecordQuery
confirmation-needed   → getConfirmationNeededQuery
payment-claimed       → getPaymentClaimedNoRecordQuery

rooming-roster        → getRoomingRosterQuery
unassigned-beds       → getUnassignedBookingsQuery
rooming-review        → getRoomingReviewQuery
rooming-preferences   → getRoomingPreferencesQuery
occupied-beds         → getOccupiedBedsQuery         (requires --date or --start + --end)
arrivals-needing-bed  → getArrivalsNeedingAssignmentQuery

unpaid-addons         → getUnpaidAddOnsQuery
lessons               → getLessonsByDateQuery         (requires --date)
yoga                  → getYogaByDateQuery             (requires --date)
rentals               → getActiveRentalsByDateQuery   (requires --date)
addons-by-booking     → getAddonsByBookingQuery       (requires --booking)
staff-required-addons → getStaffRequiredAddOnsQuery
meals                 → getMealsByDateQuery            (requires --date)
transfers             → getTransfersByDateQuery        (requires --date)
action-required-addons→ getStaffActionRequiredAddOnsQuery

open-handoffs         → getOpenHandoffsQuery
urgent-handoffs       → getHighPriorityHandoffsQuery
handoffs-by-reason    → getHandoffsByReasonQuery      (requires --reason)
payment-claimed-hoffs → getPaymentClaimedHandoffsQuery
cancel-refund-hoffs   → getCancellationRefundHandoffsQuery
handoffs-by-staff     → getHandoffsByStaffQuery       (requires --staff)
stale-handoffs        → getStaleHandoffsQuery         (optional --hours, default 24)
booking-handoffs      → getBookingHandoffsQuery       (requires --booking)
needs-human-no-hoff   → getNeedsHumanWithoutOpenHandoffQuery
```

**Design rules:**
- No LLM generates SQL. The LLM (if used) maps intent to one of the above named intents only.
- All queries are parameterized and client-scoped to `wolfhouse-somo`.
- Query result is passed to a formatter, not returned raw.
- Unknown intents return an explicit error with the allowlist.
- Audit log: append `{timestamp, intent, params, row_count}` to `logs/staff-query-log.jsonl`.

### `scripts/lib/staff-answer-formatter.js` (Stage 6.4)

Formats PG rows into a readable table or summary for terminal/API output. Example:

```
open-handoffs → "3 open handoffs:
  [urgent] +34600... — cancellation_request — opened 2h ago
  [high]   +34600... — payment_claimed — opened 4h ago
  [normal] +34600... — unclear_request — opened 1h ago"
```

---

## Staff Action Layer Design

### Read-only first (Stage 6.0–6.4)

All queries are SELECT-only. No writes. No mutations to any table.

### Safe write stubs (Stage 6.5)

Actions behind explicit `--action` flags or confirmation prompts. Initially: static helpers only, not wired to DB.

| Action | Write helper | Target table | Safety gate |
|---|---|---|---|
| Resolve handoff | `resolveHandoffSql` (exists in `staff-handoff-write-sql.js`) | `staff_handoffs` | `--confirm` flag required |
| Assign staff to handoff | inline UPDATE | `staff_handoffs` | `--confirm` flag |
| Mark add-on fulfilled | new helper | `add_on_items` | `--confirm` flag |
| Mark yoga redeemed | new helper | `yoga_requests` | `--confirm` flag |
| Mark rental returned | new helper | `rental_requests` | `--confirm` flag |
| Add notes to handoff | new helper | `staff_handoffs.resolution_summary` | `--confirm` flag |

**Important:** `resolveHandoffSql` is already in `staff-handoff-write-sql.js` (Stage 5.8, NOT WIRED). Stage 6.5 wires it behind an explicit confirm gate.

### Not in Stage 6

- Cancel booking
- Issue refund
- Modify room assignment
- Create payment link
- Any guest-facing WhatsApp write

---

## Implementation Slices

| Slice | Name | Scope | Status |
|---|---|---|---|
| 6.0 | Planning | This document | DONE |
| 6.1 | Staff query registry | `scripts/lib/staff-query-registry.js` — intent→helper map, param schema, audit fields | DONE |
| 6.2 | CLI query runner | `scripts/staff-query-runner.js` — intent parsing, registry lookup, PG exec, raw output | DONE |
| 6.3 | Handoff queue batch report | `scripts/report-staff-handoff-queue.js` — all 9 handoff intents in one pass | DONE |
| 6.4a | Payments batch report | `scripts/report-staff-payments.js` — all 7 payment intents in one pass | DONE |
| 6.4b | Rooming batch report | `scripts/report-staff-rooming.js` — all 6 rooming intents in one pass | DONE |
| 6.4c | Add-ons batch report | `scripts/report-staff-addons.js` — all 9 add-on intents in one pass | DONE |
| 6.4d | Combined ops digest | `scripts/report-staff-digest.js` — all 4 categories, per-category summary, grand total | DONE |
| 6.5a | Staff action runner — proposal only | `scripts/staff-action-runner.js` — `handoff.resolve` proposal, `--confirm` hard-fails, SQL preview only | DONE |
| 6.5b | Staff action runner — confirmed write | Wire `--confirm` gate; execute `resolveHandoffSql` against DB; proof requires fixture + rollback | DONE |
| 6.6 | Minimal HTTP API | scripts/staff-query-api.js — Node http GET /staff/query + /staff/intents; no Express dep; 39/39 verifier checks PASS; 5 live API proofs PASS; protected tables Δ0; local/dev read-only only | DONE |
| 6.7 | Pilot staff smoke test | All 35 intents run; 0 failed; 0 skipped; 144 rows; 496ms; protected tables Δ=0 | DONE |
| 6.8 | Thin read-only staff UI | GET /staff/ui inline HTML in staff-query-api.js; category/intent dropdowns; param fields; table results; READ-ONLY banner; 29/29 verifier PASS; UI 200 HTML; protected tables Δ0; local/dev only | DONE |
| 6.9 | Token-gated HTTP write endpoint | POST /staff/handoff/:id/resolve; STAFF_ACTIONS_ENABLED gate; x-staff-operator-token header; action allowlist; idempotent; audit log; 43/43 verifier PASS; 5 proof calls PASS; protected tables Δ0; fixture cleaned up | DONE |

---

## Proof Criteria

| Criterion | Method |
|---|---|
| Runner answers ≥ 10 common intents from fixture data | `scripts/verify-stage6-query-runner-smoke.js` |
| No arbitrary SQL accepted | Registry rejects unknown intents with error |
| All queries client-scoped to `wolfhouse-somo` | All helpers pass `$1 = 'wolfhouse-somo'` |
| Read-only: no INSERT/UPDATE/DELETE in Slice 6.0–6.4 | Static verifier on all registry helpers |
| Handoff queue visible: open/urgent/by-reason return expected rows | Fixture smoke |
| Cleanup restores fixture data to pre-test state | Post-smoke row count = baseline |
| No guest-facing workflows activated | All workflow `active=false` during proofs |
| Audit log entry written per query run | Log file asserted in smoke |

---

## Stage 6.9 — Write Endpoint Readiness Plan

### Safety checklist (all required before implementing)

| Gate | Requirement |
|---|---|
| Auth | `x-staff-operator-token` header required — checked against `STAFF_OPERATOR_TOKEN` env var |
| Feature flag | `STAFF_ACTIONS_ENABLED=true` env var required — endpoint returns 403 by default |
| Action allowlist | Only `handoff.resolve` for v1 — no arbitrary write intents |
| Row lookup | Target `staff_handoffs` row must exist and match `client_slug` before write |
| Client scoping | `client_slug` param required; `$1` in SQL always `client_slug` |
| SQL source | Write SQL from `resolveHandoffSql()` only — no template literals, no user-controlled SQL |
| Idempotency | Already-resolved handoff returns 200 + `{already_resolved: true}` — no error, no duplicate write |
| Audit log | One entry per write attempt (both rejected and confirmed) with `action:api:handoff.resolve` prefix |
| Protected tables | `bookings`, `payments`, `payment_events`, `booking_beds` must not be mutated |
| No UI write button | `/staff/ui` remains read-only — no resolve button until explicit UI-write approval |
| Static verifier | `scripts/verify-staff-write-api.js` must pass before any live proof |
| Fixture test | Seed test handoff, call POST endpoint, verify resolved, cleanup — delta 0 on protected tables |
| Docs warning | Header comment + docs must say local/dev only, no production auth, no TLS |

### Endpoint design

```
POST /staff/handoff/:id/resolve
Headers:
  x-staff-operator-token: <value matching STAFF_OPERATOR_TOKEN env>
Body (JSON):
  { client, resolution, staff, confirm: true }
Responses:
  200  { success: true, handoff_id, resolved_at, resolution }
  200  { success: true, already_resolved: true }
  400  missing body fields
  403  missing/invalid token
  403  STAFF_ACTIONS_ENABLED not set
  404  handoff not found / client mismatch
  405  non-POST to write path
```

### Prerequisite decisions before implementing

- [ ] Confirm STAFF_OPERATOR_TOKEN approach is acceptable for local/dev scope
- [ ] Confirm write action stays CLI + API but NOT surfaced in /staff/ui yet
- [ ] Confirm fixture seed/cleanup strategy
- [ ] User approves Stage 6.9 implementation task

### Recommendation

**Proceed to Stage 6.9 when:** safety checklist above is reviewed and approved by user.
**Do not:** expose write endpoint before token gate.
**Do not:** add resolve button to /staff/ui in Stage 6.9 — keep UI read-only.
**Do not:** approve live/production write path here — local/dev scope only.

---

## Deferrals

| Item | Reason | Target |
|---|---|---|
| Full staff UI (calendar, bed grid, conversation history) | Large scope, requires design work | Stage 6.6+ or Stage 7 |
| Production auth / roles / JWT | No live users yet | Stage 6.6+ |
| Real WhatsApp staff bridge (staff receives Luna drafts) | Unapproved live channel | Stage 7 / pilot approval |
| Multi-client admin / client picker | Only Wolfhouse today | Stage 7 |
| Analytics dashboard | Post-pilot | Stage 7 |
| Airtable cutover (remove Airtable entirely) | Requires staff UI to cover all AT use cases first | Stage 7 |
| Decision-engine extraction (`src/booking-assistant/`) | Separate workstream; independent of staff layer | Stage 5 engine track |
| Bot auto-resolve handoffs | Write path wired (CLI 6.5b proven); HTTP write endpoint planned (Stage 6.9 pending approval); auto-trigger not approved | Stage 6.9 |
| Historical `needs_human=TRUE` backfill to `staff_handoffs` | Post-pilot data hygiene | Post-pilot |
| Stripe webhook idempotency replay fixture | Deferred from Stage 5.3 | Stage 6 or 7 |
| `payment_balances` promoted to DB VIEW | Not needed for query helper approach yet | Stage 6 if needed |
| Add-on write automation (bot creates `add_on_orders`) | Schema ready; automation not approved | Stage 6.5+ |

---

## Files to create in Stage 6.1–6.4

```
scripts/lib/staff-query-registry.js       — intent → helper map (6.1)
scripts/staff-query-runner.js             — CLI entrypoint (6.2)
scripts/lib/staff-answer-formatter.js     — output formatter (6.4)
scripts/verify-stage6-query-runner-smoke.js — fixture smoke proof (6.3/6.7)
logs/staff-query-log.jsonl                — audit log (created at runtime, gitignored)
```

---

## Relationship to Existing Work

| Stage 5 artifact | Stage 6 use |
|---|---|
| `staff-payment-queries.js` (7 helpers) | Query registry — payments section |
| `staff-rooming-queries.js` (6 helpers) | Query registry — rooming section |
| `staff-addon-queries.js` (9 helpers) | Query registry — add-ons section |
| `staff-handoff-queries.js` (9 helpers) | Query registry — handoffs section |
| `staff-handoff-write-sql.js` (`resolveHandoffSql`) | Stage 6.5 safe action — resolve handoff |
| `migration 007 + 008` (applied) | Live schema backing all queries |
| `Postgres - Open Staff Handoff` (wired) | Luna feeds the handoff queue that staff reads in 6.3 |

---

## Next Recommended Prompt

```
Use Sonnet. Static implementation only. Minimize API use.

Task: Stage 6.1 — staff query registry.

Goal:
Create scripts/lib/staff-query-registry.js with the full intent→helper map,
param schema, and client_slug binding for all 30+ query helpers from Stage 5.
Add static verifier scripts/verify-staff-query-registry.js.
No DB connection. No runtime. Static only.
```

---

## Stage 6 Closeout

**Decision: CLOSE WITH DEFERRALS — 2026-05-31**

### Exit criteria — all met

| Criterion | Evidence |
|---|---|
| Query registry proven | 35 intents, 5 categories, static verifier |
| Batch reports proven | payments, rooming, add-ons, combined digest |
| HTTP API read-only proven | GET /staff/query, GET /staff/intents — 39/39 verifier, 5 live proofs |
| UI read-only proven | GET /staff/ui — 29/29 verifier, no write controls |
| All-intent smoke test | 35/35 intents, 0 failed, 144 rows, tables Δ=0 |
| CLI write proven | handoff.resolve --confirm gate, fixture seed/cleanup |
| HTTP write proven | POST /staff/handoff/:id/resolve — token gate, flag gate, idempotent, 43/43 verifier |
| Audit log throughout | every query, action attempt, and write result logged |
| Protected tables clean | bookings/payments/payment_events/booking_beds unchanged across all proofs |

### Deferrals — explicitly moved to Stage 7+

| Item | Target |
|---|---|
| Production auth / roles / JWT | Stage 7 |
| TLS / deployment config | Stage 7 |
| UI write controls (resolve button, etc.) | Stage 7 after auth gate |
| Real staff accounts / staff_directory | Stage 7 / pilot |
| Live WhatsApp staff bridge | Stage 7 / pilot approval |
| Live Stripe / live booking writes | Stage 7 / pilot approval |
| Additional write actions (handoff.assign, task.complete, add-on.mark_redeemed, rental.mark_returned) | Stage 7+ |
| Full dashboard polish (calendar, bed grid, conversation history) | Stage 7+ |
| Analytics / owner dashboard | Stage 7+ |
| Multi-client admin / client picker | Stage 7 |
| Airtable cutover | Stage 7 (gated on staff UI covering all AT use cases) |
| Bot auto-resolve handoffs (auto-trigger) | Stage 7+ approval gate |
| Natural-language question parsing (NL → intent) | Stage 7+ |

### What Stage 6 is NOT

- Not production-ready (no auth, no TLS, no real accounts).
- Not approved for live WhatsApp or live Stripe.
- Not a replacement for Airtable yet.
- Not a full staff dashboard.

### Next stage recommendation

**Stage 7 — Scalable / Production hardening + pilot deployment.**
Focus: auth layer, TLS, deployment config, multi-client, real staff accounts, pilot soak.
Do not add more local/dev write actions before Stage 7 auth/TLS plan is in place.

