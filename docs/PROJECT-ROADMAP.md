# Wolfhouse Booking Platform — Your Roadmap

A plain-language guide so you always know **where we are**, **what is safe to touch**, and **what comes next**.

**Full product roadmap (stages 3–7):** [`ROADMAP.md`](ROADMAP.md)  
**Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) · **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) · **Cursor:** [`../CURSOR.md`](../CURSOR.md)

**You are here (May 2026):** **Stage 3 — Correct and safe.** We are proving payments, webhooks, and confirmations do not harm guests or staff — **not** building the full staff app or going live on Azure yet.

**How we build (direction):** n8n runs integrations; **code and Postgres** own decisions and memory; Wolfhouse is **client #1** of a future multi-property product.

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

## The journey in 5 stages (+ foundation)

```text
Foundation   ██████████  Docker, Postgres, Phase 2 local Stripe — done
Stage 3      ████████░░  Correct and safe — IN PROGRESS (payments, webhook, rooming)
Stage 3x     ░░░░░░░░░░  Bot knowledge + safety rules (specs) — NEXT PLANNING
Stage 4      ░░░░░░░░░░  Reliable (monitoring, stuck bookings, runbooks)
Stage 5      ░░░░░░░░░░  Clean (logic out of n8n into code)
Stage 6      ░░░░░░░░░░  Beautiful (staff UI)
Stage 7      ░░░░░░░░░░  Scalable (more clients, Azure when approved)
```

Detail: [`ROADMAP.md`](ROADMAP.md)

### Phase 0 — Foundation ✓

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

### Phase 2 local — freeze & regression ✓

**Runbook:** [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md) · [`regression-test-plan.md`](regression-test-plan.md) (Phase 2 local sign-off)

Phase 2 **local signed off** (2026-05-25). Payment + confirmation contracts frozen.

---

### Stage 3 — Correct and safe ← **YOU ARE HERE**

**Goal:** Prove the bot does not make dangerous mistakes (wrong booking, wrong payment link, wrong confirmation, duplicate charges, accidental live calls).

**Done or proven (high level):**

- Main + Postgres holds and `payment_details` path (stub and real Stripe checkout link)
- Isolated Stripe payment session, webhook, Send Confirmation (dry-run)
- Bed-ops / manual entries / operator room release (Phase 3b)

**Still open:** pay + webhook on Main-created checkout; rooming/reassign with **local** URLs (hosted reassign risk).

**Not this stage:** pretty guest UX, full staff dashboard, Azure go-live.

Engineering detail: [`PROJECT-STATE.md`](PROJECT-STATE.md) · [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

---

### Stage 3x — Bot knowledge + safety (before Stage 4)

**Goal:** Write down what the bot must know (packages, prices, policies) and when it must ask staff — as **specs and test messages**, not hundreds of new n8n branches.

Includes: required fields per action, package explanations, 30–50 golden guest messages, handoff rules, duplicate protection.

See [`ROADMAP.md` § Stage 3x](ROADMAP.md#stage-3x--bot-knowledge--safety-guardrails).

---

### Stages 4–7 (later)

| Stage | Plain English |
|-------|----------------|
| **4 Reliable** | Alerts, stuck bookings, runbooks, fewer silent failures |
| **5 Clean** | Business rules in code; simpler workflows |
| **6 Beautiful** | Calendar, bed grid, staff tools Ale & Cami actually use |
| **7 Scalable** | Second surf house, Azure, onboarding checklist |

**Not next:** Azure/live deploy, production WhatsApp cutover until Stage 3 (+ 3x) are in good shape.

---

### Phase 3 — Workflow order (reference)

**Goal:** Each workflow writes Postgres **and** (temporarily) Airtable, tested one at a time.

Order (safest first):

1. Sync Planning Sheet  
2. Cancel Bed Assignments  
3. Bed Assignment  
4. Reassign  
5. Manual Entries Queue  
6. Operator Room Release — **local MVP signed off** (2026-05-27): [`PHASE-3b-5.md`](PHASE-3b-5.md) (Postgres + direct JSON webhook; no Airtable in local fork)  
7. Send Confirmation  
8. Staff Reply / Return To Bot  
9. **Main WhatsApp assistant last**

Each step uses `docs/regression-test-plan.md`.

**Airtable automations** → replaced per `docs/airtable-automations.md` (webhooks fired from Postgres state changes or n8n after write).

---

### Stage 7 — Go live on Azure (much later)

**Not the immediate next step.** Finish Stage **3**, plan **3x**, then **4 Reliable** and **5 Clean** — see [`ROADMAP.md`](ROADMAP.md). Deploying early would ship immature logic and heavy Airtable dependency.

When approved: [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md)

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
| What step next (owner) | **this file** |
| Stages 3–7 + 3x detail | [`ROADMAP.md`](ROADMAP.md) |
| Current engineering state | [`PROJECT-STATE.md`](PROJECT-STATE.md) |
| Architecture direction | [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) |
| Cursor agent rules | [`../CURSOR.md`](../CURSOR.md) |
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
2. Open **`docs/PROJECT-STATE.md`** (engineering snapshot) or this roadmap
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

Active work is **Stage 3** (correct and safe). See [`PROJECT-STATE.md`](PROJECT-STATE.md) for the exact next runtime step and [`ROADMAP.md`](ROADMAP.md) for the full stage plan.
