# Regression Test Plan

Run before each workflow cutover to Postgres and before handing to Ale/Cami.

**Environments:** staging n8n + staging Postgres + Stripe test mode + WhatsApp test number.

## 1. Inventory & static beds

| # | Test | Expected |
|---|------|----------|
| 1.1 | Seed applied: 10 rooms, 52 beds | Counts match `Rooms`/`Beds` CSV |
| 1.2 | Availability index query | Overlap query < 50ms on staging |
| 1.3 | Package rows | malibu, uluwatu, waimea, custom exist |

## 2. Bed Assignment (`assign-beds-to-booking`)

| # | Test | Expected |
|---|------|----------|
| 2.1 | 3 guests, shared, flexible dates with space | `assignment_status = assigned`, 3 `booking_beds` |
| 2.2 | Female-only preference | Prefer R5/R8 strategy |
| 2.3 | Private room request | Private-like room (R6) considered |
| 2.4 | Fully booked dates | `needs_review` / conflict notes |
| 2.5 | Operator whole-room block | All beds in room assigned |
| 2.6 | Re-run assignment idempotent | No duplicate bed rows |

## 3. Cancel & Reassign

| # | Test | Expected |
|---|------|----------|
| 3.1 | Cancel booking with beds | Beds removed; assignment needs review |
| 3.2 | Reassign after rooming change | Old beds deleted; new assignment possible |
| 3.3 | Main → reassign HTTP | 200 from webhook; booking ready state |

## 4. Manual Entries Queue

| # | Test | Expected |
|---|------|----------|
| 4.1 | Create row in Manual Entries | Booking + beds in DB; sheet Synced |
| 4.2 | Update dates/guest count | Booking updated |
| 4.3 | Delete / cancel | Beds removed; booking cancelled |
| 4.4 | Invalid bed code | Error in sheet column R; `automation_errors` row |
| 4.5 | Apps Script webhook with wrong secret | 401/403 |

## 5. Sync Planning Sheet

| # | Test | Expected |
|---|------|----------|
| 5.1 | Schedule run | Planning tab colors match booking status |
| 5.2 | Cancelled booking | Cells cleared |
| 5.3 | Multi-room booking | Multiple cells painted |

## 6. WhatsApp Main assistant

| # | Test | Expected |
|---|------|----------|
| 6.1 | New booking intent EN | Parser JSON valid; conversation updated |
| 6.2 | Spanish guest message | Reply in Spanish |
| 6.3 | Hold created | `hold` + `hold_expires_at` ~1h |
| 6.4 | Guest details → payment pending | Status transition; payment link not placeholder |
| 6.5 | Existing hold same phone | No duplicate orphan holds |
| 6.6 | Hold expiry job | Expired holds → cancelled |
| 6.7 | Human handoff | `needs_human`; staff mode |
| 6.8 | Payment claim without payment | Does not set paid without Stripe event |
| 6.9 | Large group (8+ guests) | Still books (no forced handoff) |

## 7. Stripe (Phase 2b — local)

Runbook: `docs/PHASE-2b.md`. Workflows: `n8n/phase2/`.

| # | Test | Expected |
|---|------|----------|
| 7.1 | `POST create-payment-session` default body | `payment_kind=deposit_only`, `amount_due_cents=20000`, `checkout_url` set |
| 7.1b | Booking with `deposit_required_cents=0` or NULL | Checkout still **€200** (uses default), not €0 |
| 7.2 | Repeat same booking + kind | `reused: true`, same `checkout_url` |
| 7.3 | Test card `4242…` + `stripe listen` | `payments.status=paid`; `bookings.payment_status=deposit_paid`; `send_confirmation=true` |
| 7.4 | After webhook | `bookings.status` still `payment_pending` (not Confirmed) |
| 7.5 | Invalid signature webhook | n8n execution error; no money fields updated |
| 7.6 | `payment_kind=full_amount` (manual API) | `bookings.payment_status=paid` after pay |
| 7.7 | Expired session | `payments.status = expired` (future) |
| 7.8 | Main (local Stripe) guest details path | Ensure Booking returns `booking_id`; Airtable Payment Link = `checkout.stripe.com`; WhatsApp text has no placeholder |
| 7.8b | After deposit pay + webhook | `deposit_paid`, `send_confirmation=true`, `status=payment_pending`; full E2E through success page |
| 7.9 | Phase 2 local freeze | See `docs/PHASE-2-FREEZE.md` + `docs/PHASE-2c-CHECKPOINT.md`; Ensure Booking uses `__NULL__`; hosted exports read-only |

## 7c. Main routing (Phase 2f — local)

Runbook: `docs/PHASE-2f.md`. Freeze: `docs/PHASE-2-FREEZE.md`. Unit tests: `npm run test:phase2f-resolver`.

| # | Test | Expected |
|---|------|----------|
| 7c.1 | Jamy one-shot (dates+count+contact, no hold) | `resolved_route=booking_flow`, `R2F_FULL_BOOKING_NO_HOLD`, no Search Hold first |
| 7c.2 | Name+email only with Hold on phone | `payment_details_provided`, Search Hold → Update Hold |
| 7c.3 | Search Hold returns 0 rows | Fallback reply or Parser Node — execution completes |
| 7c.4 | Payment claim | `payment_completed_claim`; money unchanged without webhook |
| 7c.5 | General question | `general_question` |
| 7c.6 | Full first message → Stripe (2f.3) | Fresh phone; dates+count+room+name+email; `booking_flow`, `apply_after_hold=true`, Apply Stripe After Hold → Assemble/Guard → `Create Outbound Message` has `checkout.stripe.com`; Airtable Payment Link matches outbound URL; €200 checkout; rooming once — **passed 2026-05-25** |

## 8. Send Confirmation

Runbook: `docs/PHASE-2d.md`. Workflow: `n8n/phase2/Wolfhouse - Send Confirmation (local).json`.

| # | Test | Expected |
|---|------|----------|
| 8.1 | Booking with `send_confirmation=true`, dry-run | `status=confirmed`, `send_confirmation=false`, `confirmation_sent_at` set |
| 8.2 | Room summary in LLM message | Airtable beds read; summary in reply when assigned |
| 8.3 | No phone on booking | `whatsapp_error=missing_phone`; status stays `payment_pending` |
| 8.4 | WhatsApp send failure | `send_confirmation` stays `true`; `confirmation_sent_at` NULL |
| 8.5 | Re-trigger same booking | Idempotent — no second confirm row update |
| 8.6 | Hosted path | Airtable checkbox **not** used in local fork |

## 9. Operator Room Release

| # | Test | Expected |
|---|------|----------|
| 9.1 | Valid release request | Original cancelled; A + B blocks created |
| 9.2 | Ambiguous match | `error_notes` set |

## 10. Staff conversations

| # | Test | Expected |
|---|------|----------|
| 10.1 | Send staff reply | WhatsApp outbound + message row |
| 10.2 | Return to bot | `bot_mode = bot` |

## 11. Error handler

| # | Test | Expected |
|---|------|----------|
| 11.1 | Forced failure node | Row in `automation_errors` |
| 11.2 | Critical alert | Notification received (once configured) |

## 12. Dual-write validation (during Phase 3)

| # | Test | Expected |
|---|------|----------|
| 12.1 | Create booking in n8n | Row in Postgres AND Airtable with linked `airtable_record_id` |
| 12.2 | Compare counts nightly | Drift < 0.1% |

## Phase 3.0b — ID link + drift (local scripts)

**Runbook:** [`PHASE-3-0b.md`](PHASE-3-0b.md). **3a not started.**

**Status:** **3.0b-1 passed** (2026-05-25). No n8n / hosted export / payment changes.

| Step | Command | Pass |
|------|---------|------|
| 3.0b-1a | `npm run db:backfill:airtable-ids -- --dry-run` then apply | yes |
| 3.0b-1b | `npm run db:report:drift` → `missing_airtable_record_id` and `wrong_airtable_record_id` empty | yes |
| 3.0b-1c | `npm run test:phase2f-resolver` | yes |

3.0b-1 notes (2026-05-25): Backfill scanned 11 `WH-rec*`, filled 2, 9 already linked. Drift actionable fields clean. CSV bookings=9 vs Postgres=28 (Δ19) is **non-blocking** — Phase 2 local-only test bookings in Postgres only. `db:verify` count mismatch expected until CSV refresh or test DB cleanup.

## Phase 3a — Postgres planning report (read-only)

**Runbook:** [`PHASE-3a.md`](PHASE-3a.md). **3b+ not started.**

**Status:** **passed** (2026-05-26).

| Step | Command | Pass |
|------|---------|------|
| 3a-1 | `npm run test:planning-row-format` | yes |
| 3a-2 | `npm run planning:report:postgres` → `reports/planning-postgres-*.csv` | yes |
| 3a-3 | 20 columns; ISO dates; Nights correct (spot-check vs Bookings Sync) | yes |
| 3a-4 | `npm run test:phase2f-resolver` + `npm run db:report:drift` still OK | yes |

3a notes (2026-05-26): Report `planning-postgres-2026-05-26T10-53-57.csv`, 12 rows, read-only. Nights fix: compute from raw dates via `toIsoDateString()` before CSV display. Examples: 2026-05-31→2026-06-04 = 4 nights; 2026-08-06→2026-08-11 = 5. Drift ID linkage clean. Bookings CSV=9 vs PG=28 non-blocking (Phase 2 local tests).

## Phase 3b.0 — Bed / booking_beds drift audit (read-only)

**Runbook:** [`PHASE-3b-0.md`](PHASE-3b-0.md). **3b.1b+ not started** (no cancel DELETE, Assign/Reassign, dual-write).

| Step | Command | Pass |
|------|---------|------|
| 3b0-1 | `npm run test:bed-drift-keys` | |
| 3b0-2 | `npm run db:report:bed-drift` → `reports/bed-drift-*.json` | |
| 3b0-3 | Actionable exit 0, or exit 1 only for CSV-export booking mismatches | |
| 3b0-4 | `npm run test:phase2f-resolver` + `npm run db:report:drift` + `npm run planning:report:postgres` unchanged | |

Optional: `npm run db:report:bed-drift -- --overlap-from=YYYY-MM-DD --overlap-to=YYYY-MM-DD` for overlap window.

## Phase 3b.2c — Assign workflow local fork (PG + Airtable)

**Runbook:** [`PHASE-3b-2c.md`](PHASE-3b-2c.md). **Reassign (3b.3)** not started.

| Step | Command | Pass |
|------|---------|------|
| 3b2c-1 | `npm run build:assign-beds:local` | |
| 3b2c-2 | Import `n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json`; map Postgres + Airtable (test base) | |
| 3b2c-3 | Deactivate hosted Assign on local n8n; publish/activate local PG fork | |
| 3b2c-4 | `db:sync`; booking with 0 PG beds; `db:report:assign-impact` | |
| 3b2c-5 | `scripts/test-assign-beds-webhook.ps1 -RecordId rec…` — AT **Unassigned** required for full path | |
| 3b2c-6 | Response: `pg_inserted_count` > 0; second call `idempotent` | |
| 3b2c-7 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | |

CLI PG mirror (no n8n): `db:assign:booking-beds --execute` (3b.2b). SQL shared via `scripts/lib/assign-booking-beds-pg-sql.js`.

## Phase 3b.2b — Postgres assign booking beds

**Runbook:** [`PHASE-3b-2b.md`](PHASE-3b-2b.md). **3b.2c** local n8n fork documented separately.

| Step | Command | Pass |
|------|---------|------|
| 3b2b-1 | `db:report:assign-impact` before execute | |
| 3b2b-2 | `db:assign:booking-beds` dry-run | |
| 3b2b-3 | `db:assign:booking-beds --execute` | |
| 3b2b-4 | Second `--execute` → 0 inserts, exit 0 | |
| 3b2b-5 | Unknown bed / overlap / guest-count cases | |
| 3b2b-6 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | |

Undo: `db:cancel:booking-beds --execute` or `db:sync`.

## Phase 3b.4c — Manual Entries local n8n fork (MVP)

**Runbook:** [`PHASE-3b-4c.md`](PHASE-3b-4c.md). **Signed off** 2026-05-27 (local Docker + test Sheet + test Airtable).

| Step | Command / action | Pass |
|------|------------------|------|
| 3b4c-0 | `node scripts/build-manual-entries-local.js --verify-targets` | 0 prod Sheet / 0 prod Airtable |
| 3b4c-1 | Import `B3c4ManualEntriesLocal01`; workflow **inactive** by default | |
| 3b4c-2 | **Create** — exec **613** (`MAN-LOCAL-CREATE-20260526C`) | PG + AT + backfill; sheet Synced; payments unchanged |
| 3b4c-3 | **Update** — exec **621** | PG + AT guest/notes; beds unchanged; sheet Synced |
| 3b4c-4 | **Delete** — exec **623** | PG cancelled, beds 0; AT cancelled + BB deleted; sheet Deleted |
| 3b4c-5 | **Overlap gate** — exec **602** | PG conflict; sheet Error; no AT create |
| 3b4c-6 | Deactivate workflow + restart `n8n-main` | webhook not left active |

**Deferred (non-blocking):** repeat create/delete webhook; unknown-bed webhook; `build:manual-entries:local` npm script; PowerShell test helper; optional test row cleanup; Respond to Webhook JSON.

## Phase 3b.4b — Manual Entry Postgres mirror (CLI only)

**Runbook:** [`PHASE-3b-4b.md`](PHASE-3b-4b.md).

| Step | Command | Pass |
|------|---------|------|
| 3b4b-1 | `db:report:manual-entry-impact` before first execute | exit 0 |
| 3b4b-2 | `db:manual-entry:postgres` create dry-run | no mutations |
| 3b4b-3 | `db:manual-entry:postgres` create `--execute` (unique `MAN-…`, free beds) | exit 0; beds inserted |
| 3b4b-4 | Repeat create `--execute` | exit 0; idempotent 0 inserts |
| 3b4b-5 | Overlap create `--execute` | exit 1; no mutation |
| 3b4b-6 | Unknown bed `--execute` | exit 1 |
| 3b4b-7 | `--strict-guest-count` mismatch | exit 1 |
| 3b4b-8 | `update` on `recBtWzIvmjQ5mmo0` `--execute` | exit 0 |
| 3b4b-9 | `delete` on test booking `--execute` | exit 0; beds gone; cancelled |
| 3b4b-10 | Repeat delete | idempotent |
| 3b4b-11 | `db:sync`; `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | |

## Phase 3b.4a — Manual Entry impact report (read-only)

**Runbook:** [`PHASE-3b-4a.md`](PHASE-3b-4a.md). **3b.4b** mirror CLI documented above; **3b.4c** fork signed off — see [`PHASE-3b-4c.md`](PHASE-3b-4c.md).

| Step | Command | Pass |
|------|---------|------|
| 3b4a-1 | `npm run db:report:manual-entry-impact -- --action=create --manual-entry-id=MAN-test-clean --guest-name=Test --check-in=2026-06-05 --check-out=2026-06-10 --guest-count=2 --beds=R1-B1,R1-B2` (free beds) | exit 0 |
| 3b4a-2 | Missing `--beds` on create | exit 2 `missing_required_fields` (exit 1 if no manual-entry-id) |
| 3b4a-3 | `--beds=R99-B1` | exit 2 `unknown_bed_codes` |
| 3b4a-4 | Overlap fixture (occupied bed/dates) | exit 2 `postgres_overlap_conflicts` |
| 3b4a-5 | `guest-count=3` with one bed | exit 2 `guest_count_mismatch` |
| 3b4a-6 | `--action=update --airtable-record-id=recBtWzIvmjQ5mmo0` + field changes | exit 0 |
| 3b4a-7 | `--action=delete --airtable-record-id=recBtWzIvmjQ5mmo0` | exit 0 |
| 3b4a-8 | `check-out` ≤ `check-in` | exit 2 `invalid_date_range` |
| 3b4a-9 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | all pass |

## Phase 3b.3b — Reassign workflow local fork (PG + Airtable + chained Assign)

**Runbook:** [`PHASE-3b-3.md`](PHASE-3b-3.md). **3b.4b+** not started.

| Step | Command | Pass |
|------|---------|------|
| 3b3b-1 | `npm run build:reassign-beds:local` | |
| 3b3b-2 | Import `n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).json`; map creds; deactivate hosted Reassign on local n8n | |
| 3b3b-3 | Local Assign fork active on `assign-beds-to-booking` | |
| 3b3b-4 | `db:sync`; `db:report:reassign-impact` clean case `WH-recBtWzIvmjQ5mmo0` | |
| 3b3b-5 | `test-reassign-beds-webhook.ps1 -RecordId recBtWzIvmjQ5mmo0` → `ok`, `pg_deleted_count` > 0, `pg_inserted_count` > 0 | |
| 3b3b-6 | Second webhook → no duplicate PG natural keys | |
| 3b3b-7 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | |

## Phase 3b.3a — Reassign impact report (read-only)

**Runbook:** [`PHASE-3b-3a.md`](PHASE-3b-3a.md). **3b.3b Reassign n8n fork** not started.

| Step | Command | Pass |
|------|---------|------|
| 3b3a-1 | `npm run db:report:reassign-impact -- --booking-code=WH-rec… --beds=R7-B1,…` (booking with existing PG beds) | |
| 3b3a-2 | JSON: `no_mutations`, `would_delete` + `would_insert`, `payments_untouched`, planning before/after | |
| 3b3a-3 | Unknown bed → exit 2 `unknown_bed_codes` | |
| 3b3a-4 | Overlap fixture → exit 2 `postgres_overlap_conflicts` | |
| 3b3a-5 | Guest-count mismatch → exit 2 `guest_count_mismatch` | |
| 3b3a-6 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | |

## Phase 3b.2a — Assign impact report (read-only)

**Runbook:** [`PHASE-3b-2a.md`](PHASE-3b-2a.md). **3b.2b+ / Reassign** not started.

| Step | Command | Pass |
|------|---------|------|
| 3b2a-1 | `npm run db:report:assign-impact -- --booking-code=WH-rec… --beds=R7-B1,…` | |
| 3b2a-2 | JSON: `no_mutations`, `would_insert` listed, `payments_untouched` | |
| 3b2a-3 | Overlap or guest-count fixture → exit 2 with `actionable[]` | |
| 3b2a-4 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | |

## Phase 3b.1a — Cancel impact report (read-only)

**Runbook:** [`PHASE-3b-1a.md`](PHASE-3b-1a.md). **3b.1b+ execute / 3b.1c** documented separately.

| Step | Command | Pass |
|------|---------|------|
| 3b1a-1 | `npm run db:report:cancel-impact -- --booking-code=WH-rec…` (booking with beds) | |
| 3b1a-2 | JSON: `no_mutations`, beds listed, `payments_untouched` | |
| 3b1a-3 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` still OK | |

## Phase 3b.1b — Postgres cancel booking beds

**Runbook:** [`PHASE-3b-1b.md`](PHASE-3b-1b.md). **3b.1c not started** (no n8n fork, no Airtable writes).

| Step | Command | Pass |
|------|---------|------|
| 3b1b-1 | `db:report:cancel-impact` before | |
| 3b1b-2 | `db:cancel:booking-beds` dry-run (no `--execute`) | |
| 3b1b-3 | `db:cancel:booking-beds --execute` | |
| 3b1b-4 | Second `--execute` → 0 deletes, exit 0 | |
| 3b1b-5 | `planning:report:postgres` — bed rows gone; `test:phase2f-resolver` OK | |

Note: `db:report:bed-drift` may exit 1 for CSV-export bookings until AT beds removed (3b.1c).

## Phase 3b.1c — Cancel workflow local fork (PG + Airtable)

**Runbook:** [`PHASE-3b-1c.md`](PHASE-3b-1c.md). **3b.2+ not started.**

| Step | Command | Pass |
|------|---------|------|
| 3b1c-1 | `npm run build:cancel-beds:local` | |
| 3b1c-2 | Import `n8n/phase3b/Wolfhouse - Cancel Bed Assignments (local PG).json` into local n8n; map Postgres + Airtable creds | |
| 3b1c-3 | Deactivate hosted Cancel on local n8n; activate local PG fork | |
| 3b1c-4 | `scripts/test-cancel-beds-webhook.ps1 -RecordId rec…` (test AT only) | |
| 3b1c-5 | Response: `pg_deleted_count` > 0 first run; `idempotent` on second | |
| 3b1c-6 | `db:report:bed-drift` + `planning:report:postgres` + `test:phase2f-resolver` | |

CLI-only alternative (no n8n): `db:cancel:booking-beds --execute` (3b.1b).

## Phase 2 local sign-off (freeze)

**Runbook:** `docs/PHASE-2-FREEZE.md`. Complete before starting Phase 3.

**Status:** Phase 2 local **signed off** (2026-05-25). Tiers **A**, **B**, and **C** passed. Phase 3 **3.0b-1** through **3b.3b** implemented; **3b.4a** impact report + **3b.4b** Postgres mirror CLI implemented; **3b.4c+** not started.

### Tier A — automated

**Status:** passed (2026-05-25).

| Step | Command | Pass |
|------|---------|------|
| A.1 | `npm run test:phase2f-resolver` | yes |
| A.2 | `npm run build:main:local-stripe` | yes |
| A.3 | `npm run build:send-confirmation:local` | yes |

### Tier B — one booking (API / DB)

**Status:** passed (2026-05-25). Reference booking: `WH-recSyn7QcPdVrYa1D`.

| Step | Test | Pass |
|------|------|------|
| B.1 | `test-phase2c-stripe-branch.ps1 -BookingCode WH-recSyn7QcPdVrYa1D` → `ok=true`, `amount_due_cents=20000`, `checkout_url` | yes |
| B.2 | Stripe test pay + webhook → `deposit_paid`, `send_confirmation=true` | yes |
| B.3 | `test-phase2d-send-confirmation.ps1 -BookingCode WH-recSyn7QcPdVrYa1D` → `confirmed`, `send_confirmation=false`, `confirmation_sent=true` | yes |

B.3 notes: webhook accepted; poll until `status=confirmed`; script exit 0 after quote fix in `test-phase2d-send-confirmation.ps1`.

### Tier C — WhatsApp E2E minimum (local n8n)

**Status:** **passed** (2026-05-25) — C.1, C.2, C.3, C.4 complete. Reference booking for C.2–C.4 chain: `WH-recnO7hgHBR5ixUEc` (Shakira/Taylor hold+contact test).

| Step | Maps to | Pass |
|------|---------|------|
| C.1 | §7c.6 full first message → Stripe link; Airtable Payment Link = WhatsApp URL (byte-identical); checkout opens at €200; rooming once | yes |
| C.2 | §7.8 existing hold + contact → Stripe link | yes |
| C.3 | §7.8b payment → webhook | yes |
| C.4 | §8.1 Send Confirmation (local), dry-run | yes |

C.1 notes (2026-05-25): James full-first-message test after `build:main:local-stripe` re-import. Verified `IF - Apply Stripe After Hold` true, Create Payment Session `ok=true`, Assemble/Guard `send_allowed=true`, `Create Outbound Message - Payment Pending` → `Message Text` with `checkout.stripe.com` (no placeholder), rooming question once (friendly copy → URL → rooming), Stripe checkout €200.00, Airtable Payment Link matches outbound URL.

C.2 notes (2026-05-25): Fresh existing-hold/contact-only test after resolver **2f.4** re-import. Message 1: 2 people, shared room, August 1–3 — hold created; first reply asked for lead guest name/email (no Stripe link). Message 2: contact-only details. **Search Hold With Guest Details** and **Update Hold With Guest Details** ran; Stripe chain ran. `Create Outbound Message - Payment Pending` → `Message Text` with `checkout.stripe.com` (no `booking-payment-placeholder`); Stripe checkout €200.00; rooming question after payment link.

C.3 notes (2026-05-25): Paid C.2 Stripe Checkout (`WH-recnO7hgHBR5ixUEc`) with Stripe test card; success page. Postgres: `status=payment_pending`, `payment_status=deposit_paid`, `deposit_paid_cents=20000`, `amount_paid_cents=20000`, `balance_due_cents=0`, `send_confirmation=true`. Payments: latest `deposit_only` → `paid`, 20000/20000. `payment_events`: `checkout.session.completed`, `processed=true`.

C.4 notes (2026-05-25): `test-phase2d-send-confirmation.ps1 -BookingCode WH-recnO7hgHBR5ixUEc`. Before: `payment_pending`, `deposit_paid`, `send_confirmation=true`, `confirmation_sent=false`. Webhook accepted; poll OK. After: `status=confirmed`, `deposit_paid`, `send_confirmation=false`, `confirmation_sent=true`.

| Role | Name | Date |
|------|------|------|
| Engineer | Cursor | 2026-05-25 |
| Owner | Ty | 2026-05-25 |

**Sign-off notes:** Tier A passed; Tier B passed; Tier C passed; hosted n8n exports unchanged; Phase 3 **3.0b-1** and **3a** passed; 3b+ dual-write not started; Azure/live deployment not started; short pay URLs deferred; local generated workflows are import-only and must be regenerated from build scripts.

---

## Sign-off (go-live / Phase 3+)

| Role | Name | Date |
|------|------|------|
| Engineer | | |
| Owner (Ale/Cami) | | |

## Test data cleanup

Use staging hostel slug `wolfhouse-somo-staging` or prefix booking codes `TEST-` to avoid polluting production exports.
