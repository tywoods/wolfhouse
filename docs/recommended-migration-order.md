# Recommended Migration Order

Phased path from ~70–80% prototype to production for Ale & Cami, without rewriting everything at once.

## Phase 0 — Foundation (no production traffic change)

1. **Postgres schema** — apply `database/migrations/001_init.sql` on staging.
2. **Seed Wolfhouse** — `database/seeds/001_wolfhouse_seed.sql` from CSV exports; validate counts vs Airtable.
3. ~~**Document Airtable automations**~~ — done in `docs/airtable-automations.md` (screenshots in `Screenshots/automations/`).
4. **Remove secrets from repo** — delete/ignore `docs/api keys.txt`; rotate exposed keys.
5. **Azure staging** — `infra/docker-compose.local.yml` locally; deploy n8n queue mode to staging per `docs/azure-n8n-hosting-plan.md`.

**Exit criteria:** Staging DB populated; n8n connects to Postgres; no workflow JSON changes yet.

---

## Phase 1 — Read replica + hygiene

1. **One-way sync** Airtable → Postgres (n8n scheduled or script) for Bookings, Booking Beds, Beds, Rooms, Conversations, Messages.
2. **Clean legacy fields** — stop writing `Status - OLD`, duplicate bed links.
3. **`automation_errors` + `workflow_events` tables** — wire central error handler (design only → implement minimal insert nodes).
4. **Packages table** — seed Malibu / Uluwatu / Waimea / Custom with price rules (confirm amounts with Ale/Cami).

**Exit criteria:** Postgres mirrors Airtable within 5 minutes; staff can query Postgres read-only.

---

## Phase 2 — Payments (Stripe) before DB cutover

1. Implement **Stripe Checkout Session** creation (replace placeholder payment link).
2. **`payments` + `payment_events`** — webhook marks `paid` only.
3. New n8n workflows (design in `docs/stripe-payment-design.md`):
   - Create payment session
   - Stripe webhook handler
   - Update booking → trigger Send Confirmation
4. Keep writing payment fields to Airtable during dual-write for staff visibility.

**Exit criteria:** Test booking can pay in Stripe test mode; confirmation WhatsApp sends; Airtable still updated.

---

## Phase 3 — Dual-write operational workflows (highest value, lowest guest risk)

Migrate **one workflow at a time** to Postgres writes, keeping Airtable sync:

| Order | Workflow | Why this order |
|-------|----------|----------------|
| 3a | Sync Planning Sheet | Read-only from assignments; validates Postgres queries |
| 3b | Cancel Bed Assignments | Small surface; tests deletes |
| 3c | Bed Assignment | Core inventory; keep Airtable sync after Postgres write |
| 3d | Reassign Bed Assignments | Depends on 3c |
| 3e | Manual Entries Queue Processor | Staff path; Sheets unchanged |
| 3f | Operator Room Release | Low volume |
| 3g | Send Confirmation | Depends on Stripe from Phase 2 |
| 3h | Send Staff Reply / Return To Bot | Staff WhatsApp |
| 3i | **Main Booking Assistant** | Last — highest complexity; 167 nodes |

**Exit criteria:** Each workflow passes `docs/regression-test-plan.md` section before next.

---

## Phase 4 — Flip source of truth

1. Disable Airtable automations one-by-one as Postgres triggers/n8n webhooks take over.
2. Stop Airtable writes; keep read-only export backup 30 days.
3. Point all webhooks to Azure n8n.
4. Update Apps Script webhook base URL once.

**Exit criteria:** New bookings exist only in Postgres; Airtable archived.

---

## Phase 5 — Hardening for non-technical owners

1. Staff alert channel (WhatsApp group or email) on `automation_errors` severity ≥ high.
2. Simple runbook PDF: “sync failed → press Sync Manual Entries”.
3. Monitoring: n8n execution failures, Postgres connections, Redis queue depth.
4. Optional: retire duplicate assignment code in Main after Bed Assignment uses Postgres.

---

## What NOT to do early

- Do not migrate Main assistant before Bed Assignment + Cancel/Reassign are stable on Postgres.
- Do not remove Google Sheets until Ale/Cami approve Postgres admin UI or keep Sheets as view-only.
- Do not commit real API keys to git.
- Do not change exported JSON in `n8n/` until staging tests pass (copy to new versions instead).

---

## Smallest safe first implementation step

**Phase 0 only:** Local Docker Postgres + seed + `002_package_pricing.sql` + read `docs/PROJECT-ROADMAP.md`.  
**Do not** start Airtable→Postgres sync until Phase 1 — see roadmap.
