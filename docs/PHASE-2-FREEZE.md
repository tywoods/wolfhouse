# Phase 2 local — freeze & regression

**Status:** Phase 2 local **signed off** (2026-05-25). Regression Tiers **A**, **B**, and **C** passed. Phase 3 not started.

**Not started:** Phase 3 dual-write, Azure/live deploy, short payment redirect URLs, hosted n8n Cloud changes.

**Sign-off:** Engineer Cursor · Owner Ty · 2026-05-25.

**Master checklist:** [`regression-test-plan.md`](regression-test-plan.md) — sections **7**, **7c**, **8**, and **Phase 2 local sign-off**.

---

## What “Phase 2 local complete” means

On **Docker + local n8n + Postgres + Stripe test mode**, the following work end-to-end without touching hosted production:

| Track | Scope | Runbook |
|-------|--------|---------|
| **2a** | Client rename + payment schema | [`PHASE-2a.md`](PHASE-2a.md) |
| **2b** | Create Payment Session + Stripe webhook | [`PHASE-2b.md`](PHASE-2b.md) |
| **2c** | Main fork — `payment_details_provided` → Stripe | [`PHASE-2c.md`](PHASE-2c.md) · [`PHASE-2c-CHECKPOINT.md`](PHASE-2c-CHECKPOINT.md) |
| **2d** | Send Confirmation from Postgres | [`PHASE-2d.md`](PHASE-2d.md) |
| **2f** | Booking router + full-message Stripe | [`PHASE-2f.md`](PHASE-2f.md) |

Reference bookings (examples):

- **Tier B (passed 2026-05-25):** `WH-recSyn7QcPdVrYa1D` — Stripe branch + webhook + confirmation script
- **Tier C C1 (passed 2026-05-25):** fresh phone, full first message (James) → outbound `checkout.stripe.com`, €200, rooming once
- **Tier C C2–C4 (passed 2026-05-25):** `WH-recnO7hgHBR5ixUEc` — hold+contact → Stripe pay → webhook → Send Confirmation local

---

## Canonical build scripts (source of truth)

Regenerate forks from these — **do not hand-edit** generated JSON except in n8n UI for credentials, then re-export only if you intentionally update the build script.

| Script | Output |
|--------|--------|
| [`scripts/build-main-local-stripe.js`](../scripts/build-main-local-stripe.js) | `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` |
| [`scripts/lib/booking-state-resolver.js`](../scripts/lib/booking-state-resolver.js) | Resolver logic + `buildN8nResolverJsCode()` |
| [`scripts/lib/merged-payment-path.js`](../scripts/lib/merged-payment-path.js) | Merged-path expressions (2f.2) + deterministic payment URL assemble/guard (2f.3) |
| [`scripts/build-send-confirmation-local.js`](../scripts/build-send-confirmation-local.js) | `n8n/phase2/Wolfhouse - Send Confirmation (local).json` |

```powershell
npm run build:main:local-stripe
npm run build:send-confirmation:local
```

---

## Generated workflows (import-only)

Import into **local n8n** (`http://localhost:5678`) only:

| File | Role |
|------|------|
| `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` | Main WhatsApp assistant (Stripe + 2f) |
| `n8n/phase2/Wolfhouse - Send Confirmation (local).json` | Confirmation from Postgres |
| `n8n/phase2/` (Create Payment Session, Stripe webhook, etc.) | See [`PHASE-2b.md`](PHASE-2b.md) |

After import: set credentials, **save & publish** active workflows.

---

## Hosted exports (read-only)

| Path | Rule |
|------|------|
| `n8n/Wolfhouse Booking Assistant  - Main.json` | Input to `build-main-local-stripe.js` only — **do not edit** for Phase 2 experiments |
| `n8n/Wolfhouse - Send Confirmation.json` | Input to `build-send-confirmation-local.js` only |
| `tywoods.app.n8n.cloud` | **Do not change** hosted workflows |

---

## Required local environment

Set in [`infra/.env`](../infra/.env) (see [`infra/.env.example`](../infra/.env.example)):

| Variable | Value / purpose |
|----------|-----------------|
| `USE_STRIPE_CHECKOUT` | `true` — never send `booking-payment-placeholder` when Stripe path runs |
| `WHATSAPP_DRY_RUN` | `true` for Send Confirmation tests (no real guest WhatsApp) |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` — Code nodes must read `$env.USE_STRIPE_CHECKOUT`, webhook URLs, etc. |
| Stripe test keys | `STRIPE_SECRET_KEY`, webhook secret, `stripe listen` for local webhook |
| Postgres / n8n | Via `docker compose -f infra/docker-compose.local.yml up -d` |

Client slug in Postgres: **`wolfhouse-somo`**.

---

## Must-not-change (without a new phase)

| Item | Why |
|------|-----|
| **`__NULL__` + `NULLIF` on Ensure Booking** | n8n drops empty Postgres query params and shifts `$n` |
| **`RESOLVER_VERSION` in generated resolver** | Injected constant; missing → runtime error |
| **Merged payment path** (`Code - Prepare Stripe Payment Context`, shared node expressions) | booking_flow + payment_details paths must not reference unexecuted branch nodes |
| **No placeholder when Stripe enabled** | `IF - Payment Link Safe For Reply` + real link from Create Payment Session |
| **Exact Stripe URL in WhatsApp (2f.3)** | LLM never outputs URLs; `Code - Assemble Payment Pending Reply` appends canonical `checkout_url`; `Code - Guard Payment Pending WhatsApp` blocks mismatches before send |
| **Stripe webhook = money only** | Sets `deposit_paid` / `send_confirmation=true`; does **not** confirm booking or send WhatsApp |
| **Send Confirmation local** | `status=confirmed` only after successful send (or dry-run success); `send_confirmation=false`, `confirmation_sent_at` set |

**Deferred (explicitly out of freeze):**

- Short pay URL (`https://wolf-house.com/pay/WH-xxxx` → Stripe session)
- Phase 3 Airtable dual-write
- Azure / live WhatsApp / Stripe live mode

---

## Regression tiers

### Tier A — Automated (~2 min)

No n8n UI. Run after any change to build scripts or resolver/merged-path libs.

```powershell
cd C:\Users\tywoo\Desktop\WH
npm run test:phase2f-resolver
npm run build:main:local-stripe
npm run build:send-confirmation:local
```

**Pass:** all resolver fixtures green; both build scripts exit 0; Main fork ~186 nodes (tags include `phase2f`, `phase2f2`).

Optional:

```powershell
.\scripts\test-phase2f-routing.ps1 -RunResolverOnly
```

---

### Tier B — API / DB smoke (~5–10 min)

Requires Docker Postgres + local n8n webhooks active.

| Step | Command / doc |
|------|----------------|
| Stripe branch | `.\scripts\test-phase2c-stripe-branch.ps1 -BookingCode "<booking_code>"` |
| Stripe webhook | [`PHASE-2b.md`](PHASE-2b.md) — `stripe listen`, test card, check `deposit_paid` |
| Send Confirmation | `.\scripts\test-phase2d-send-confirmation.ps1` (after `send_confirmation=true`) |

**Pass (minimum):** one booking with Postgres UUID gets `checkout_url`; after test pay + webhook → `payment_status=deposit_paid`, `send_confirmation=true`; confirmation script → `status=confirmed`, `send_confirmation=false`, `confirmation_sent_at` NOT NULL.

---

### Tier C — Local n8n WhatsApp E2E (~30–45 min)

Fresh test phone per scenario (or clean conversation + holds in test Airtable).

| ID | Scenario | Expected |
|----|----------|----------|
| **C1** ✓ | Full first message (dates + count + room + name + email) | **Passed 2026-05-25.** `booking_flow`, Apply Stripe After Hold, Assemble/Guard, outbound `checkout.stripe.com`, no placeholder, rooming once, €200 checkout |
| **C2** ✓ | Hold on phone → contact only (name + email) | **Passed 2026-05-25.** Search Hold → Update Hold → Stripe; `checkout.stripe.com`, €200, rooming after link |
| **C3** ✓ | C2 + Stripe test pay + webhook | **Passed 2026-05-25.** `WH-recnO7hgHBR5ixUEc`: `deposit_paid`, `send_confirmation=true`, `payment_pending` until confirmation |
| **C4** ✓ | After C3 | **Passed 2026-05-25.** `test-phase2d-send-confirmation.ps1` → `confirmed`, `send_confirmation=false`, `confirmation_sent=true` |

**Stretch (not required for freeze sign-off):** regression §7c.3–7c.5, §6.x, §7.7.

Example **C1** message:

```text
Hi, we are 2 people looking for a shared room from June 1 to June 3. My name is Sammy and my email is samy@example.com
```

---

## Minimum sign-off (Phase 2 local)

Before any Phase 3 work:

- [x] **Tier A** passed (2026-05-25) — resolver + both build scripts
- [x] **Tier B** passed (2026-05-25) — `WH-recSyn7QcPdVrYa1D` (Stripe branch + webhook + confirmation script)
- [x] **Tier C** passed (2026-05-25) — C.1–C.4; see [`regression-test-plan.md`](regression-test-plan.md)
- [x] Hosted exports unchanged unless intentionally re-exported for build input
- [x] Freeze doc and roadmap reviewed (this doc + [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md))
- [x] Named sign-off recorded (Engineer / Owner rows)

| Role | Name | Date | Notes |
|------|------|------|-------|
| Engineer | Cursor | 2026-05-25 | Tier A passed; Tier B passed; Tier C passed; hosted n8n exports unchanged; Phase 3 not started; Azure/live not started; short pay URLs deferred; local `n8n/phase2/` workflows import-only — regenerate from build scripts |
| Owner | Ty | 2026-05-25 | Phase 2 local sign-off approved |

---

## Pre-flight (each regression session)

1. `docker compose -f infra/docker-compose.local.yml up -d`
2. Local n8n: Main (local Stripe) + phase2 Stripe workflows + Send Confirmation (local) **active**
3. `infra/.env` per table above
4. For C3: `stripe listen --forward-to localhost:5678/webhook/stripe` (or your local webhook path per 2b)

---

## After freeze — what’s next

**Phase 2 local sign-off is complete (2026-05-25).** Do not start **Phase 3** until explicitly approved. Next planned work when ready: Phase 3 dual-write (workflow by workflow) — see [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md).
