# Phase 3c + 3d — Local Main / Stripe / Confirmation freeze

**Status:** **Frozen** (docs checkpoint, 2026-05-28)  
**HEAD at freeze:** `8dfa450` (includes Phase **3e.2** Main reassign URL remap — rooming E2E **not** in this freeze)

**Sign-off posture:** Engineering freeze for **Phase 3c** (local Main + Postgres + stub payment path) and **Phase 3d** (real Stripe + webhook + Send Confirmation dry-run). Owner review optional; treat evidence bookings as **terminal** unless reset.

**Related freezes:** [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md) · [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md) · [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md)

**Detail runbooks:** [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md) through [`PHASE-3c-g.md`](PHASE-3c-g.md) · [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) · [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) (planning only)

---

## 1. Freeze scope

### Frozen — completed proof

| Phase | Scope | Proof summary |
|-------|--------|----------------|
| **3c** | Local Main fork + Postgres (hold, availability, Ensure promote, conversation upsert) + **stub** payment path | Fresh `booking_flow` hold; `payment_details_provided` → stub CPS; no Stripe; no payment/confirmation side effects — [`PHASE-3c-g.md`](PHASE-3c-g.md) |
| **3d** | Real Stripe test Checkout + **organic** webhook + Send Confirmation **dry-run** | Isolated chain on `WH-260528-1493`; integrated chain on `WH-260528-5369` — [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |

**3c boundary:** `booking_flow` → hold in PG + Airtable; `payment_details_provided` → Ensure promote + stub `create-payment-session-stub-local` when `N8N_CREATE_PAYMENT_SESSION_URL` points at stub.

**3d boundary:** Same Main paths with **real** `create-payment-session`; manual Checkout pay; Stripe Webhook Handler owns `payments` / `payment_events`; Send Confirmation only after payment truth + `send_confirmation=true`.

### Explicitly not frozen / still pending

| Item | Notes |
|------|--------|
| Real WhatsApp send | `WHATSAPP_DRY_RUN=true` for 3d.6 / 3d.9b |
| Send Confirmation **schedule-poll** mode | Schedule node **`disabled: true`** in isolated tests |
| Single-window full integrated E2E | 3d.7b / 3d.8b / 3d.9b were **separate** windows |
| Rooming / reassign E2E | 3e.2 URL remap only; 3e.3+ not signed off |
| Stage **3x** knowledge / `client_config` implementation | Planning committed (`5318b56`); execution pending |
| Staff UI | Stage 6 |
| Airtable removal / large refactor | Later stages |
| Bed-ops **Assign/Cancel** active webhooks | Still active from 3b — do not POST casually |

**Phase 3e.2** (Main hosted → local reassign URL) is **committed after** this checkpoint was requested but is **documented here** as a safety invariant; it does **not** sign off rooming runtime.

---

## 2. Current known-good behavior

| Behavior | Evidence |
|----------|----------|
| Main `booking_flow` can create a **fresh hold** | 3c.g (`WH-260528-9437`); 3d.7b (`WH-260528-5369` exec **1063**) |
| Main `payment_details_provided` selects **correct current hold** | 3c.g Search Hold + Ensure; 3d.7b same phone/wamid chain |
| Main calls **real CPS** when `N8N_CREATE_PAYMENT_SESSION_URL` → `http://n8n:5678/webhook/create-payment-session` | 3d.7b CPS exec **1065** |
| Real CPS creates **Stripe test** Checkout session | 3d.4 exec **1050**; 3d.7b `cs_test_…` |
| **Organic** Stripe webhook updates payment truth | 3d.8b execs **1066–1076**, `evt_1Tc9ehG36qRefvdPg9mXYrcr` |
| Send Confirmation **dry-run** confirms only after payment truth | 3d.6 exec **1061**; 3d.9b exec **1077** |
| Main does **not** write `payments` / `payment_events` | Static contract + all 3c/3d gates |
| Payment/confirmation path does **not** write `booking_beds` | All listed gates `booking_beds=0` |
| **Terminal** evidence bookings must not be reused | See §5 — reset required |

---

## 3. Safety invariants

| Invariant | Enforcement |
|-----------|-------------|
| Main must **not** directly INSERT/UPDATE `payments` or `payment_events` | `build-main-local-stripe.js --verify-targets`; `report-main-payment-contract.js` |
| Payment truth comes from **Stripe Webhook Handler** (`KZUQvwR6SPWpvaZ5`) | 3d.5b / 3d.8b |
| Confirmation requires `payment_pending` + `deposit_paid`/`paid` + `send_confirmation=true` + `confirmation_sent_at` NULL | Send Confirmation SQL gates |
| Mark Booking Confirmed runs only after **`whatsapp_sent=true`** | 3d.6e / 3d.9b chain order |
| **`WHATSAPP_DRY_RUN=true`** for dry-run confirmation tests | `infra/.env` / compose default |
| Send Confirmation **schedule disabled** for isolated tests | n8n DB + workflow JSON `disabled: true` |
| Phase test **`wamid.PHASE…`** bypasses WhatsApp typing/read | `e620822` typing guard |
| Worker callbacks use **service DNS** (`http://n8n:5678/…`, `http://n8n-main:5678/…`), not `localhost`/`127.0.0.1` in worker paths | 3c.f stub; 3e.2 reassign |
| **`current_hold_booking_id` / active booking** beats phone-only fallback | Resolver + Ensure contract — [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) §3x.9 |
| Terminal evidence bookings **not reused** without documented reset | §5 |
| Main reassign HTTP uses **local-safe** endpoint (post **3e.2**) | `$env.N8N_REASSIGN_BOOKING_BEDS_URL \|\| http://n8n-main:5678/webhook/reassign-booking-beds` — **rooming E2E not signed off** |
| Hosted reassign URL **must not** return to Main fork | `--verify-targets` errors on `tywoods.app.n8n.cloud/webhook/reassign-booking-beds` |

---

## 4. Environment notes

| Purpose | URL / setting |
|---------|----------------|
| Stub CPS (3c / stub tests) | `http://n8n:5678/webhook/create-payment-session-stub-local` |
| Real CPS (3d Stripe tests) | `http://n8n:5678/webhook/create-payment-session` — workflow `esuDIT96iPT63OaQ` |
| Main webhook | `http://localhost:5678/webhook/booking-assistant` (host POST); workers use internal routing |
| Local reassign (3e.2+, Main rooming HTTP) | `http://n8n-main:5678/webhook/reassign-booking-beds` or `N8N_REASSIGN_BOOKING_BEDS_URL` |
| Send Confirmation schedule | **`disabled: true`** for isolated tests |
| Webhook registration after import | **`n8n publish`** + restart **`n8n-main`** / **`n8n-worker`** may be required (3d.6 / 3d.9) |
| Organic Stripe during manual Checkout | If `stripe listen` or forwarder hits local `stripe-webhook`, payment truth may update **during** pay window — plan scope accordingly (3d.8b) |

**Queue mode:** `EXECUTIONS_MODE=queue` in `infra/docker-compose.local.yml` — HTTP nodes in workers must target **`n8n`** or **`n8n-main`**, not host `localhost`.

**Test Airtable base (Main fork):** `appiyO4FmkKsyHZdK` (neutralized from prod in build).

---

## 5. Evidence references

### Key n8n executions

| Gate | Execution(s) | Notes |
|------|----------------|-------|
| 3d.4 CPS direct | **1050** | Isolated; `WH-260528-1493` |
| 3d.5b webhook truth | **1058** | Crafted test event `evt_test_phase3d5b_001` |
| 3d.6 Send Confirmation isolated | **1061** | Dry-run; `WH-260528-1493` → confirmed |
| 3d.7b Main integrated checkout | Main **1063** / **1064**, CPS **1065** | Stop at checkout URL |
| 3d.8b organic Stripe webhook | **1066–1076** (max **1076**) | `evt_1Tc9ehG36qRefvdPg9mXYrcr` |
| 3d.9b integrated Send Confirmation | **1077** | Dry-run; `WH-260528-5369` → confirmed |

### Key bookings (do not reuse without reset)

| Booking code | UUID (PG) | Phone | Terminal state | Used for |
|--------------|-----------|-------|----------------|----------|
| `WH-260528-1493` | `33ac2766-537c-4b95-85d4-91c01c862beb` | `+353399990329` | **confirmed** | Isolated 3d.4 → 3d.6 |
| `WH-260528-9437` | (3c.g hold) | — | stub / payment path | 3c.g.2l fresh E2E |
| `WH-260528-5369` | `3dd17e1b-b0c4-46f9-beaf-b2d8653aa0c8` | `+353399990330` | **confirmed** | Integrated 3d.7b → 3d.8b → 3d.9b |

**Payment row (5369):** `389a5fdd-daa7-4bc1-a5e0-2bf105a5f471`

### Key commits (freeze lineage)

| Commit | Message |
|--------|---------|
| `f454a39` | Phase 3d.7: Main integrated Stripe payment-link success |
| `f04c099` | Phase 3d.8: paid Checkout webhook truth success |
| `cd48a5a` | Phase 3d.9: integrated confirmation dry-run success |
| `5318b56` | Stage 3x: bot knowledge guardrails and rooming planning |
| `8dfa450` | Phase 3e.2: remap Main reassign URL to local endpoint |

---

## 6. Next phase boundary

**Further Phase 3e rooming/reassign work may continue only after this freeze document is committed.**

| Step | Status |
|------|--------|
| **3e.1** Rooming inventory + safety plan | Done — [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| **3e.2** Hosted reassign URL → local `n8n-main` | Done — `8dfa450` |
| **3e.3** Static reassign / rooming contract checker | **Next** |
| **3e.4** Fresh disposable rooming E2E | After 3e.3 |
| **3e.5** Negative / guard tests | After 3e.4 |

Rooming/reassign must remain **config-driven** from `rooms` / `beds` (and future `client_config`), not hardcoded room IDs in Main workflow logic.

**Parallel (non-blocking):** Stage **3x.2** owner questionnaire → draft `config/clients/wolfhouse-somo.json`.

---

## 7. Workflow IDs (local, post-test expectation)

| Workflow | ID | Expected after gates |
|----------|-----|----------------------|
| Main (local Stripe) | `RBfGNtVgrAkvhBHJ` | **inactive** |
| Create Payment Session | `esuDIT96iPT63OaQ` | **inactive** |
| CPS stub | `whCreatePaymentStubLocal01` | **inactive** |
| Stripe Webhook Handler | `KZUQvwR6SPWpvaZ5` | **inactive** |
| Send Confirmation (local) | `gxivKRJexzTCw9x6` | **inactive**, schedule **disabled** |
| Reassign (local PG) | `B3c3ReassignLocal01` | **inactive** |
| Assign / Cancel (local PG) | `B3c2AssignLocalPg01` / `KchhRC9b3MIdkzPT` | May be **active** from 3b — isolate before bed tests |

---

## 8. Read-only validation (at freeze authoring)

Run before relying on this freeze after pulls:

```powershell
git status --short
node scripts/build-main-local-stripe.js --verify-targets
node scripts/report-main-payment-contract.js
node scripts/report-stripe-contract.js
```

Do **not** POST to Main, reassign, Stripe, or confirmation webhooks as part of freeze validation.

---

## 9. Regression rule

Any change to **Main build** (`scripts/build-main-local-stripe.js`), **Send Confirmation build**, **Stripe workflows**, or **payment/confirmation SQL gates** requires:

1. Re-run §8 static checks  
2. Update this freeze or add a new sub-freeze section  
3. Do not assume §5 evidence bookings remain valid after workflow JSON import
