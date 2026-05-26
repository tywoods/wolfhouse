# Phase 3 — Dual-write proposal

**Status:** Proposal only (no implementation).  
**Prerequisite:** Phase 2 local signed off (2026-05-25) — see [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md), [`regression-test-plan.md`](regression-test-plan.md).  
**Commit baseline:** `91461ea` — *Freeze Phase 2 local booking payment flow*.

**Explicitly out of scope for Phase 3 (this proposal and implementation until Phase 4):**

- Hosted n8n Cloud (`tywoods.app.n8n.cloud`) — read-only export inputs only  
- Production Airtable base — no schema changes, no automation toggles on live base  
- Production WhatsApp / Meta Business API cutover  
- Stripe webhook URL or signing changes on production Stripe  
- Azure / live deployment  
- Short payment redirect URLs (`wolf-house.com/pay/…`)  
- Flipping Airtable off as source of truth (that is **Phase 4**)

---

## 1. Goal of Phase 3

### What changes after Phase 2?

| Area | After Phase 2 (frozen) | After Phase 3 (target) |
|------|------------------------|-------------------------|
| **Money** | Postgres is payment truth (local): `payments`, `payment_events`, webhook → `deposit_paid`, `send_confirmation` | Same; optionally **mirror** payment link / status fields to Airtable for staff visibility |
| **Guest booking (WhatsApp)** | Main (local Stripe) still **creates/updates Airtable** bookings, conversations, messages; **also** `Ensure Booking In Postgres` on Stripe paths | Main and satellite workflows **write Postgres first**, then **sync to Airtable** with `airtable_record_id` linkage |
| **Bed inventory** | Bed Assignment / Cancel / Reassign / Planning Sheet use **Airtable** Booking Beds | Same operations **persist in Postgres** `booking_beds` (+ assignments), Airtable kept in sync |
| **Staff paths** | Manual Entries → Airtable; Planning Sheet reads Airtable | Dual-write to Postgres; Sheets UI unchanged |
| **Confirmation** | Send Confirmation **(local)** reads Postgres only | Dual-write: Postgres remains authority; Airtable row updated for staff UI |
| **n8n** | Local forks under `n8n/phase2/` generated from build scripts | Same pattern: **build scripts + local forks**; hosted exports still inputs only |

Phase 3 does **not** replace Ale/Cami’s Google Sheets or Airtable views. It makes Postgres a **durable, queryable copy** that workflows trust, while Airtable remains the **staff-facing mirror** until Phase 4.

### What does “dual-write” mean in this project?

For each workflow step that today **creates, updates, or deletes** an Airtable record:

1. **Write Postgres** inside a clear transaction boundary (single booking + beds + related rows where possible).  
2. **Write Airtable** in a follow-up branch (same execution or sub-workflow), using `airtable_record_id` stored on the Postgres row.  
3. On Airtable failure: log to `automation_errors`, **do not roll back money**; retry Airtable sync from Postgres id.  
4. On Postgres failure: **do not** write Airtable (avoid orphan Airtable records without Postgres).

Optional n8n env flag (per workflow or global):

```text
DATA_SOURCE=airtable | postgres | dual
```

- **Phase 2 local:** effectively `postgres` for payments + Send Confirmation; `airtable` for most Main paths.  
- **Phase 3:** move workflows to `dual` one at a time.  
- **Rollback:** set `DATA_SOURCE=airtable` for that workflow only.

**Idempotency:** Upserts keyed by `booking_code` (`WH-rec…`) and `airtable_record_id`; bed rows keyed by `(booking_id, bed_id, date range)`; webhook/payment events already idempotent via `payment_events.stripe_event_id`.

### What remains Airtable source-of-truth temporarily?

Until **Phase 4 flip**:

| Domain | Airtable role |
|--------|----------------|
| Staff **Manual Entries** sheet → processor | Entry queue still driven from Sheets; Airtable is what staff see today |
| **Planning Sheet** calendar colors | Painted from assignment data; during 3a Postgres is read source, Airtable may still hold rows staff edit |
| **Operator** blocks / release UI | Low-volume; mirror in Postgres |
| **Historical** bookings not yet backfilled | Read from Airtable until sync job catches up |
| **Automations** on hosted base | Stay **disabled locally**; not replicated to production base in Phase 3 |

### What becomes Postgres-backed?

| Domain | Postgres tables (existing schema) | Phase 3 write? |
|--------|-----------------------------------|----------------|
| Bookings | `bookings` | Yes — dual-write per workflow |
| Bed assignments | `booking_beds` | Yes — 3b–3d |
| Guests | `guests` (link from bookings/conversations) | Incremental — backfill + new writes |
| Conversations | `conversations` | Yes — Main last (3i) |
| Messages | `messages` | Yes — with conversations |
| Payments | `payments`, `payment_events` | **Already** Phase 2; add Airtable mirror optional |
| Rooms / beds (static) | `rooms`, `beds` | Read-only (seeded); no dual-write |
| Operator release | `operator_room_release_requests` | 3f |
| Manual entries | `manual_entries` (if populated) | 3e |
| Planning calendar | No table — **derived** from `booking_beds` | 3a read-only |
| Workflow audit | `workflow_events`, `automation_errors` | New writes on failure |

---

## 2. Proposed Phase 3 stages

Small, reviewable chunks. Each stage: local n8n only, regenerate forks, run Tier A + stage tests + Phase 2 regression subset.

### 3.0 — Dual-write foundation (no guest-facing workflow change)

| Deliverable | Description |
|-------------|-------------|
| **3.0a** | Document `DATA_SOURCE` convention in build scripts; stub env checks in one workflow |
| **3.0b** | **Backfill** `airtable_record_id` on Postgres rows from CSV or one-way sync (Phase 1 script extended) |
| **3.0c** | **Drift report** script: compare counts / key fields Airtable vs Postgres for bookings + booking_beds |
| **3.0d** | Standard **Airtable sync sub-workflow** pattern (Postgres row → Airtable upsert) + `automation_errors` insert |
| **3.0e** | Proposal-only schema gaps list (e.g. `manual_entries`, confirmation flags) — **no migration files until stage approved** |

**Exit:** Drift report runs clean on staging data; one test booking has both IDs linked.

### 3a — Sync Planning Sheet (read Postgres)

| Item | Detail |
|------|--------|
| Risk | **Lowest** — read-only paint to Google Sheets |
| Change | Replace Airtable assignment queries with Postgres overlap query on `booking_beds` |
| Airtable | Unchanged writes; sheet still staff UI |
| Test | Colors match Airtable-backed run for same date range |

### 3b — Cancel Bed Assignments

| Item | Detail |
|------|--------|
| Risk | Low — deletes only |
| Change | Delete `booking_beds` in Postgres, then remove Airtable Booking Bed records |
| Test | Cancel booking → beds free in both systems |

### 3c — Bed Assignment

| Item | Detail |
|------|--------|
| Risk | Medium — core inventory |
| Change | Assignment algorithm writes Postgres first; sync Booking Beds to Airtable |
| Test | §2 regression (assign 3 guests, female-only, private room) on Postgres + Airtable |
| Note | Deprecate duplicate inline assignment in Main **after** 3c stable (not in first 3c PR) |

### 3d — Reassign Bed Assignments

| Item | Detail |
|------|--------|
| Risk | Medium — depends on 3c |
| Change | Same dual-write pattern as 3c |
| Test | Reassign after rooming change; no duplicate bed rows |

### 3e — Manual Entries Queue Processor

| Item | Detail |
|------|--------|
| Risk | Medium — staff path |
| Change | Postgres booking + beds, then Airtable; Sheets status column unchanged |
| Test | §4 regression (create/update/delete row) |

### 3f — Operator Room Release

| Item | Detail |
|------|--------|
| Risk | Low volume |
| Change | Postgres `operator_room_release_requests` + bookings/beds dual-write |
| Test | §3 + operator release scenario |

### 3g — Payment field mirror (optional, small)

| Item | Detail |
|------|--------|
| Risk | Low if webhook unchanged |
| Change | After Postgres webhook sets `deposit_paid`, **update Airtable** Payment Status / Payment Link (staff visibility) |
| **Do not** change Stripe webhook handler signature or URL |
| Test | Tier B/C payment checks still pass |

**Note:** Stripe Create Session + Webhook are **Phase 2 complete** on Postgres. Phase 3g is **mirror only**, not a new payment path.

### 3h — Send Confirmation dual-write

| Item | Detail |
|------|--------|
| Risk | Medium |
| Change | Keep Postgres as authority (2d); add Airtable booking status sync after confirm |
| Test | C.4 + Airtable row shows Confirmed |

### 3i — Staff Reply / Return To Bot

| Item | Detail |
|------|--------|
| Risk | Medium — staff WhatsApp |
| Change | `conversations` flags in Postgres + Airtable |
| Test | Handoff / return flows |

### 3j — Main Booking Assistant (last)

| Item | Detail |
|------|--------|
| Risk | **Highest** — ~189 nodes local |
| Change | Holds, conversations, messages, availability → dual-write; preserve 2f resolver + 2f.3 payment URL assembly |
| Test | Full Tier C + §6 WhatsApp regression |
| Build | Only via `scripts/build-main-local-stripe.js` |

**Phase 3 complete when:** 3a–3j (and 3.0) exit criteria met locally; Phase 2 Tier A–C still pass; drift report &lt; 0.1% on bookings/beds.

---

## 3. Recommended first Phase 3 step

### Lowest-risk first change: **3.0b + 3a (Sync Planning Sheet)**

| Order | Why |
|-------|-----|
| **1 — 3.0b** | Link `airtable_record_id` on existing Postgres bookings from Airtable export — no workflow behavior change |
| **2 — 3a** | Read-only Postgres query proves SQL/bed overlap logic without creating guest bookings |

### What to test first

1. **Drift report (3.0c)** on current local DB + latest CSV export.  
2. **3a:** Run Sync Planning Sheet against a known week; compare sheet colors to pre-Phase-3 Airtable run (screenshot or cell diff).  
3. **Tier A** (`npm run test:phase2f-resolver`, both build scripts).  
4. **No Tier C** required for 3a alone.

Do **not** start with Main (3j) or Bed Assignment (3c) until 3a–3b prove Postgres reads and sync patterns.

---

## 4. Data ownership map

| Entity | Phase 2 authority | Phase 3 authority (during dual-write) | Phase 4 target |
|--------|-------------------|----------------------------------------|----------------|
| **bookings** | Airtable (Main); Postgres on Stripe/Ensure path | **Postgres write first**, Airtable mirror | Postgres |
| **booking_beds** | Airtable | **Postgres write first**, Airtable mirror | Postgres |
| **guests** | Denormalized on Booking/Conversation | Postgres `guests` + FK; backfill | Postgres |
| **conversations** | Airtable | Dual-write (3i / 3j) | Postgres |
| **messages** | Airtable | Dual-write with conversation | Postgres |
| **payments** | Postgres (2b) | Postgres; optional Airtable fields (3g) | Postgres |
| **payment_events** | Postgres only | Postgres only | Postgres |
| **rooms / beds** | Postgres seed | Postgres read-only | Postgres |
| **room assignments** | `booking_beds` rows | Same — dual-write | Postgres |
| **planning sheet / calendar** | Google Sheet view | **Read** Postgres assignments (3a) | Postgres read |
| **manual_entries** | Sheet + Airtable | Dual-write (3e) | Postgres + Sheet |
| **operator releases** | Airtable | Dual-write (3f) | Postgres |
| **packages / pricing** | Postgres (`package_pricing`) | Postgres read | Postgres |

**Join keys:**

- Public: `booking_code` (`WH-rec…`)  
- Bridge: `airtable_record_id` (`rec…`) on every dual-written row  
- Internal: Postgres `UUID` (`bookings.id`) for FKs and webhooks

---

## 5. Workflow map

| Workflow | Phase 3 action | Read from | Write to | Risk / when |
|----------|----------------|-----------|----------|-------------|
| **Sync Planning Sheet** | **3a** — migrate read path | Postgres `booking_beds` | Google Sheets only | **First** |
| **Cancel Bed Assignments** | **3b** — dual-write | Postgres | Postgres + Airtable | Early |
| **Bed Assignment** | **3c** — dual-write | Postgres availability | Postgres + Airtable | Before Main |
| **Reassign Bed Assignments** | **3d** — dual-write | Postgres | Postgres + Airtable | After 3c |
| **Manual Entries Queue** | **3e** — dual-write | Sheet trigger | Postgres + Airtable | Staff path |
| **Operator Room Release** | **3f** — dual-write | Webhook | Postgres + Airtable | Low volume |
| **Create Payment Session** | Stay Postgres (2b) | Postgres | Postgres | No URL change |
| **Stripe Webhook Handler** | **No change** in Phase 3 | Stripe | Postgres | **Do not touch** signing/URL |
| **Stripe Checkout Success** | No change | — | HTML only | — |
| **Send Confirmation (local)** | **3h** — add Airtable mirror | Postgres | Postgres + Airtable | After 3g optional |
| **Send Staff Reply** | **3i** | Mixed → Postgres | Dual-write | Before Main |
| **Return Conversation To Bot** | **3i** | Mixed → Postgres | Dual-write | Before Main |
| **Main Booking Assistant (local Stripe)** | **3j** — dual-write last | Postgres + Airtable | Dual-write | **Last** |
| **Hosted Main / all hosted JSON** | **No change** | Airtable | Airtable | Until Phase 4 Azure |

### Stay Airtable-driven (Phase 3)

- Hosted n8n Cloud workflows (all)  
- Production guest WhatsApp (until Phase 4)  
- Airtable automations on **production** base (document only; replace in Phase 4)  
- Google Sheets **layout** and staff editing UX  

### Should dual-write (Phase 3)

All rows in §2 stages 3b–3j except Stripe webhook core.

### Should read Postgres (Phase 3)

- Sync Planning Sheet (3a)  
- Bed Assignment availability (3c+)  
- Send Confirmation (already 2d)  
- Payment Session / webhook (already 2b)  

### Risky — wait until late

| Workflow | Why wait |
|----------|----------|
| **Main Assistant** | 167+ hosted nodes; resolver, holds, LLM, merged payment path |
| **Inline bed logic in Main** | Remove only after 3c proven |
| **Flip `DATA_SOURCE=postgres` only** | Phase 4 — no Airtable write |
| **Disable Airtable automations** | Phase 4 |
| **Production Stripe webhook endpoint move** | Phase 4 Azure |

---

## 6. Rollback strategy

### Per stage

| Stage | Rollback |
|-------|----------|
| **3.0–3a** | Set Planning workflow `DATA_SOURCE=airtable`; redeploy previous local JSON from git tag |
| **3b–3d** | `DATA_SOURCE=airtable` on Cancel/Assignment/Reassign; Postgres rows may be ahead — run drift report, optional one-way Airtable→Postgres repair job |
| **3e–3f** | Disable Postgres write nodes; Sheets processor Airtable-only |
| **3g** | Remove Airtable mirror branch; Postgres payment truth unchanged |
| **3h–3i** | Revert to Phase 2d Send Confirmation (Postgres-only) |
| **3j** | Revert `build-main-local-stripe.js` to Phase 2 freeze commit; re-import `n8n/phase2/` from build |

### Global rollback (Phase 3 only)

1. Set all local workflows `DATA_SOURCE=airtable`.  
2. Re-import forks from commit `91461ea` (Phase 2 freeze).  
3. Pause any scheduled Postgres→Airtable repair jobs.  
4. **Do not** delete Postgres data — keep for diff.  
5. Re-enable Airtable automations only on **local/test** base if used.

### What not to touch on rollback

- Hosted n8n Cloud workflows  
- Production Airtable schema/automations  
- Production WhatsApp / Meta config  
- Stripe production webhook secret or endpoint  
- `payment_events` / paid money rows in Postgres (never “rollback” payments)  
- Phase 2 freeze commit history — tag `phase2-freeze` recommended

---

## 7. Test plan

### Phase 2 regression (must keep passing)

Run after **every** Phase 3 stage merge:

| Tier | Command / scenario |
|------|-------------------|
| **A** | `npm run test:phase2f-resolver`, `npm run build:main:local-stripe`, `npm run build:send-confirmation:local` |
| **B** | `test-phase2c-stripe-branch.ps1`, webhook deposit, `test-phase2d-send-confirmation.ps1` |
| **C** | C.1–C.4 WhatsApp E2E minimum (local n8n) |

**Must-not-regress (from [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md)):**

- `__NULL__` / `NULLIF` on Ensure Booking  
- Resolver `RESOLVER_VERSION` + C.2 hold lookup path  
- No `booking-payment-placeholder` when `USE_STRIPE_CHECKOUT=true`  
- Assemble/Guard canonical Stripe URL in outbound message  
- Webhook: money only → `deposit_paid`, `send_confirmation=true`; booking stays `payment_pending` until confirmation  
- Send Confirmation: `confirmed` only after send OK  

### New Phase 3 checks

| ID | Test | Expected |
|----|------|----------|
| **3.0-1** | Drift report | Bookings/beds counts match within 0.1%; sample `booking_code` linked |
| **3.0-2** | Dual-write failure inject | Airtable node fails → `automation_errors` row; Postgres committed |
| **3a-1** | Planning sheet vs Postgres | Cell colors match for same week |
| **3b-1** | Cancel booking | No orphan `booking_beds` in either system |
| **3c-1** | Assign 3 guests shared | `assignment_status=assigned`, 3 beds both sides |
| **3e-1** | Manual entry create | Sheet Synced; Postgres + Airtable IDs linked |
| **3g-1** | Pay deposit | Airtable Payment Status mirrors Postgres (if 3g enabled) |
| **3j-1** | Full Tier C on dual-write Main | Same as Phase 2 C.1–C.4 |
| **12.1** | Create booking | Postgres + Airtable row; `airtable_record_id` set |
| **12.2** | Nightly drift | &lt; 0.1% divergence |

---

## 8. Risks

| Risk | Description | Mitigation |
|------|-------------|------------|
| **Duplicate bookings** | Main + Manual Entries both create rows | Upsert on `booking_code` / phone+hold window; single “active hold” resolver rules (2f) |
| **Bed assignment mismatch** | Main inline assign vs Bed Assignment workflow | One Postgres assignment module; disable duplicate after 3c |
| **Airtable/Postgres drift** | Sync branch fails silently | Drift report 3.0c; `automation_errors`; nightly 12.2 |
| **Manual staff edits** | Staff edit Airtable only | Phase 3: document “edit in sheet → Manual Entries”; optional one-way AT→PG repair job |
| **Failed writes** | PG ok, AT fail (or reverse) | Postgres-first rule; retry queue; never delete PG payment rows |
| **Idempotency** | Webhook retry, duplicate sheet rows | `payment_events.stripe_event_id` unique; manual entry status column |
| **Double bed booking** | Overlap logic diverges | SQL exclusion indexes; same overlap query for 3a and 3c |
| **LLM non-determinism** | Wrong dates in Main | Keep resolver overrides; log to `workflow_events` |
| **Hold expiry** | Zombie holds | Postgres `hold_expires_at` job (n8n schedule) in 3j |
| **Credential leak** | Keys in repo | Keep `infra/.env` gitignored; rotate if exposed |
| **Hosted export accident** | Edit `n8n/Wolfhouse*.json` | Build scripts only; CI check: hosted paths unchanged |
| **Stripe scope creep** | Change webhook in 3g | **Forbidden** — mirror fields only |
| **Phase 4 conflation** | Turn off Airtable early | Explicit Phase 4 checklist; Phase 3 exit = dual-write stable only |

---

## 9. Implementation rules (when Phase 3 is approved)

1. **Local only:** `docker compose -f infra/docker-compose.local.yml`, local n8n, test Stripe, `WHATSAPP_DRY_RUN=true` unless explicitly testing send.  
2. **Build scripts are source of truth** for Main and Send Confirmation forks — regenerate, do not hand-edit `n8n/phase2/*.json` for logic.  
3. **Hosted exports** (`n8n/Wolfhouse Booking Assistant  - Main.json`, `n8n/Wolfhouse - Send Confirmation.json`) — read-only inputs.  
4. **One stage per PR / checkpoint** — git tag `phase3-3a`, etc.  
5. **Migrations:** propose in stage doc; apply only with `database/migrations/00N_*.sql` + review; never on production Airtable.  
6. **Sign-off:** Update [`regression-test-plan.md`](regression-test-plan.md) §12 and freeze doc when Phase 3 completes (separate from Phase 2 sign-off).

---

## 10. References

| Doc | Use |
|-----|-----|
| [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) | Phase 3 order |
| [`phased-cutover-plan.md`](phased-cutover-plan.md) | Dual-write pattern, rollback |
| [`recommended-migration-order.md`](recommended-migration-order.md) | Workflow sequence |
| [`airtable-field-usage.md`](airtable-field-usage.md) | Field mapping |
| [`migration-risks.md`](migration-risks.md) | Risk register |
| [`regression-test-plan.md`](regression-test-plan.md) | §12 dual-write tests |
| [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md) | Must-not-change list |
| [`airtable-automations.md`](airtable-automations.md) | Automation replacement (Phase 4) |

---

## Approval (not yet)

| Role | Name | Date | Notes |
|------|------|------|-------|
| Engineer | | | |
| Owner | | | Phase 3 proposal approved → start 3.0b |

**Do not implement Phase 3 until this proposal is explicitly approved.**
