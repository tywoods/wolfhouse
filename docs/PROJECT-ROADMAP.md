# Wolfhouse Booking Platform — Your Roadmap

A plain-language guide so you always know **where we are**, **what is safe to touch**, and **what comes next**.

---

## Two environments (important)

| Environment | What it is | Your rule |
|-------------|------------|-----------|
| **Hosted prototype** | Airtable + n8n Cloud (`tywoods.app.n8n.cloud`) | **Do not change** while we build the new system. It keeps working for experiments. |
| **New platform (this repo)** | Postgres + self-hosted n8n on Azure + copied workflows | **All new work happens here.** Dummy/test data only until you deliberately go live. |

You downloaded JSON/CSVs into `WH/` so we can read and plan **without breaking** the hosted copy. When the new stack is ready, we **deploy up to Azure** and point WhatsApp/Stripe at the new URLs — not edit the old n8n in place.

---

## What Postgres is (60-second version)

Think of Postgres as **Airtable in a box**:

- **Tables** = Airtable tables (Bookings, Beds, …)
- **Rows** = records
- **Columns** = fields
- **SQL** = formulas + views + scripts, but stored and run on the server

You will not need to write SQL day to day. n8n will read/write Postgres like it does Airtable today. Ale and Cami can keep **Google Sheets** for the calendar until we give them something simpler.

**Why move:** one database for several hostels, real payment audit trail, no Airtable API limits, and cleaner bed-availability queries.

---

## The journey in 6 phases

```
Phase 0  ████░░░░░░  YOU ARE HERE — learn + local database
Phase 1  ░░░░░░░░░░  Mirror data (read-only), no workflow changes
Phase 2  ░░░░░░░░░░  Stripe payments (test mode)
Phase 3  ░░░░░░░░░░  Move workflows one-by-one to Postgres
Phase 4  ░░░░░░░░░░  Go live on Azure (DNS + WhatsApp)
Phase 5  ░░░░░░░░░░  Polish for Ale & Cami
```

### Phase 0 — Foundation (current)

**Goal:** Understand the system; run Postgres on your laptop; no guest impact.

| Step | What you do | Done when |
|------|-------------|-----------|
| 0.1 | Read `docs/current-system-map.md` (big picture) | You know the 10 workflows |
| 0.2 | Read this roadmap | You know not to touch hosted n8n |
| 0.3 | Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) | `docker` works in terminal |
| 0.4 | `cp infra/.env.example infra/.env` and set passwords | `.env` exists |
| 0.5 | `docker compose -f infra/docker-compose.local.yml up -d` | Containers running |
| 0.6 | Open n8n at http://localhost:5678 (optional) | You see the UI |
| 0.7 | Confirm DB: rooms + beds seeded | See below “First Postgres check” |

**We are NOT doing yet:** Airtable sync (old “step 3”), changing hosted workflows, or Azure billing.

---

### Phase 1 — Postgres as read-only copy ✓

### Phase 2a — Client rename + payment schema ✓

**Runbook:** [`docs/PHASE-2a.md`](PHASE-2a.md)

---

### Phase 2b — Stripe test workflows (local) ✓

**Runbook:** [`docs/PHASE-2b.md`](PHASE-2b.md)

---

### Phase 2c — Main (local Stripe) ✓

**Runbook:** [`docs/PHASE-2c.md`](PHASE-2c.md)

- Fork: `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json`
- Regenerate: `npm run build:main:local-stripe`
- `payment_details_provided` → real Stripe link (deposit_only)
- Ensure Booking uses `__NULL__` sentinel + `NULLIF` (n8n empty-param fix)
- Verified E2E locally (May 2026)
- 2c-b deferred; Phase 3 not started

---

### Phase 2d — Local Send Confirmation from Postgres ✓

**Runbook:** [`docs/PHASE-2d.md`](PHASE-2d.md)

- Fork: `n8n/phase2/Wolfhouse - Send Confirmation (local).json`
- Verified locally (May 2026, e.g. `WH-recSyn7QcPdVrYa1D`, `WHATSAPP_DRY_RUN=true`)
- Postgres poll/webhook → dry-run WhatsApp → `status=confirmed` only after send OK
- 2c-b deferred; **Phase 3 not started**

---

### Phase 2f — Booking Flow Router Hardening ✓

**Docs:** [`PHASE-2f-PROPOSAL.md`](PHASE-2f-PROPOSAL.md) · [`PHASE-2f.md`](PHASE-2f.md)

- **2f.1 done:** `Code - Booking State Resolver` in Main (local Stripe) build
- **2f.2 done:** Stripe after `booking_flow` hold + payment-link guard (verified local)
- **Deferred:** one-shot auto-continue after hold; short pay redirect URL

---

### Phase 2 local — freeze & regression ← **YOU ARE HERE**

**Runbook:** [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md) · [`regression-test-plan.md`](regression-test-plan.md) (Phase 2 local sign-off)

Phase 2 **local signed off** (2026-05-25): Tiers **A**, **B**, **C** passed; Engineer Cursor · Owner Ty. See [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md). **Do not start Phase 3** until explicitly approved.

**Not started:** Phase 3 dual-write, Azure/live, short `wolf-house.com/pay/…` links.

---

### Phase 3 — Dual-write (workflow by workflow)

**Goal:** Each workflow writes Postgres **and** (temporarily) Airtable, tested one at a time.

Order (safest first):

1. Sync Planning Sheet  
2. Cancel Bed Assignments  
3. Bed Assignment  
4. Reassign  
5. Manual Entries Queue  
6. Operator Room Release  
7. Send Confirmation  
8. Staff Reply / Return To Bot  
9. **Main WhatsApp assistant last**

Each step uses `docs/regression-test-plan.md`.

**Airtable automations** → replaced per `docs/airtable-automations.md` (webhooks fired from Postgres state changes or n8n after write).

---

### Phase 4 — Go live on Azure

**Goal:** Production URLs; WhatsApp + Apps Script point to Azure n8n.

- Deploy Container Apps + Postgres + Redis (`docs/azure-n8n-hosting-plan.md`)
- Import workflows from `n8n/*.json` into **new** n8n instance
- Turn off Airtable automations on the **new** base (or stop using old base)
- Keep old hosted stack as backup read-only for ~2 weeks

---

### Phase 5 — Owner-ready

**Goal:** 80–90% WhatsApp self-serve; simple runbook for Ale & Cami.

- Error alerts (`automation_errors`)
- Stripe live mode
- Training session + printed “if sync fails, press Sync Manual Entries”

---

## Package pricing (from Wolfhouse website)

**Per person per week** (shared). Shorter stays: **prorate** (`weekly × nights ÷ 7`), then **round up to nearest €5** per person.

| Season months | Malibu | Uluwatu | Waimea |
|---------------|--------|---------|--------|
| April, May, June, October | €249/wk | €349/wk | €499/wk |
| July, September | €299/wk | €399/wk | €549/wk |
| August | €349/wk | €449/wk | €599/wk |

**Double room:** +€10 per person per night on top of prorated package total.

Full rules + examples: **`docs/package-pricing.md`**  
DB + SQL helpers: **`database/migrations/002_package_pricing.sql`**

---

## First Postgres check (Phase 0 hands-on)

After Docker is up:

```powershell
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT slug FROM hostels;"
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT room_code, capacity FROM rooms ORDER BY room_code;"
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT bed_code, sellable FROM beds WHERE bed_code = 'R3-B1';"
```

Expected: hostel `wolfhouse-somo`, 10 rooms, `R3-B1` → `sellable = true`.

Apply pricing migration:

```powershell
Get-Content database\migrations\002_package_pricing.sql | docker exec -i wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

---

## Files to bookmark

| When you feel lost | Open this |
|------------------|-----------|
| Big picture | `docs/current-system-map.md` |
| Webhook URLs | `docs/webhook-map.md` |
| Airtable automations | `docs/airtable-automations.md` |
| What step next | **this file** |
| Risks | `docs/migration-risks.md` |
| Technical order | `docs/recommended-migration-order.md` |
| Before go-live tests | `docs/regression-test-plan.md` |
| Phase 2 local freeze | `docs/PHASE-2-FREEZE.md` |
| Azure deploy | `docs/azure-n8n-hosting-plan.md` |
| Stripe | `docs/stripe-payment-design.md` |

---

## What I need from you (only when we reach that phase)

| Phase | Question |
|-------|----------|
| 0 | ~~Docker + seed~~ ✓ (you completed this) |
| 1 | `npm run db:verify` passes? |
| 1 | Fresh Airtable CSV export before final seed? |
| 2 | Stripe account access (test mode) |
| 4 | Domain for n8n (e.g. `automation.wolf-house.com`) |
| 4 | Confirm deposit-only vs full payment online |

---

## After a reboot (Docker Desktop)

Yes — rebooting is normal for Docker installs. When you are back:

1. Open this project in Cursor: `C:\Users\tywoo\Desktop\WH`
2. Open **`docs/PROJECT-ROADMAP.md`** (you are on Phase 0)
3. Start Docker Desktop from the Start menu and wait until it says **Running**
4. In PowerShell:
   ```powershell
   cd C:\Users\tywoo\Desktop\WH
   docker compose -f infra/docker-compose.local.yml up -d
   ```
5. Message the agent: *“Docker is running, ready for Phase 0 checks”*

Your chat history and all files in `WH/` stay on disk — nothing is lost by rebooting.

---

## Comfort note

Nothing in this repo touches your hosted Airtable/n8n until **you** deploy to Azure and switch URLs. All current data being dummy is **ideal** — we can break and fix the local DB freely.

When you finish Phase 0 (Docker + seed check), tell me and we’ll walk through Phase 1 together step by step — still without touching the hosted system.
