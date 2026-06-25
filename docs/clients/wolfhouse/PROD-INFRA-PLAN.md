# Wolfhouse — Prod Infra Plan (Dry-Run / Proposed)

Client: `wolfhouse` · Location: `wolfhouse-somo` · Region: **northeurope**

> **Every action in this document is PROPOSED and NOT EXECUTED.** No Azure
> resource is created, updated, or deleted by this plan. The companion script
> `scripts/plan-wolfhouse-prod-infra.js` is **dry-run only** — it prints suggested
> `az` commands as text and runs none of them.
>
> Names mirror `docs/clients/wolfhouse/LIVE-ENV-INVENTORY.md` (canonical). See also
> `LIVE-CUTOVER-RUNBOOK.md`, `LIVE-ROLLBACK-RUNBOOK.md`, `GO-LIVE-CHECKLIST.md`.

## ACR decision

The `LIVE-ENV-INVENTORY.md` left ACR open (reuse shared `whstagingacr` vs create
prod). **This plan chooses a separate prod registry: `whprodacr`** — cleaner blast
radius and lifecycle separation from staging. The planner script defaults to
`whprodacr` and accepts `--acr <name>` to override. (Still proposed — not created.)

## Resources (proposed — not executed)

| Resource | Planned name | Purpose | Owner | Isolation rationale |
|----------|--------------|---------|-------|---------------------|
| Resource group | `wh-prod-rg` | Container for all Wolfhouse prod resources | Ops | Per-client prod RG; staging stays in `wh-staging-rg` |
| Container registry | `whprodacr` | Immutable image tags for prod | Ops | Separate from `whstagingacr`; prod pulls only prod-tagged images |
| Key Vault | `wh-prod-kv` | All prod secrets (names only listed) | Ops | Per-client vault; no shared secrets across clients |
| Log Analytics | `wh-prod-logs` | Logs/metrics sink + alerts | Ops | Per-client telemetry; 30-day retention |
| Container Apps env | `wh-prod-env` | Hosting env for the two apps | Ops | Dedicated prod env |
| Staff API app | `wh-prod-staff-api` | Booking brain / portal / bot API | Ops + Wolfhouse owner | Own runtime, own DB creds |
| Hermes/Luna app | `wh-prod-hermes` | Guest WhatsApp agent | Ops | Own runtime bound to prod Staff API |
| Postgres server | `wh-prod-pg` | Isolated prod database server | Ops | Dedicated server; not the staging `wh-staging-pg-app` |
| Database | `wolfhouse_prod` | Wolfhouse live data | Ops + Wolfhouse owner | No cross-client rows; locations tagged by `location_id` |
| Staff portal DNS | `staff.lunafrontdesk.com` | Staff portal / Staff API ingress | Ops | Wolfhouse-specific host |
| Hermes webhook DNS | `hermes.lunafrontdesk.com` | Meta WhatsApp webhook ingress | Ops | Wolfhouse-specific host |

### Secret names (names only — no values, ever)

Stored in `wh-prod-kv`; values are operator-provided at provisioning, never committed:
`WOLFHOUSE_PROD_DB_USER`, `WOLFHOUSE_PROD_DB_PASSWORD`, `WOLFHOUSE_PROD_DATABASE_URL`,
`LUNA_BOT_INTERNAL_TOKEN`, `WOLFHOUSE_STAFF_SESSION_SECRET`,
`WOLFHOUSE_WHATSAPP_PHONE_NUMBER_ID`, `WOLFHOUSE_WHATSAPP_ACCESS_TOKEN`,
`WOLFHOUSE_META_APP_SECRET`, `WOLFHOUSE_META_VERIFY_TOKEN`,
`WOLFHOUSE_STRIPE_SECRET_KEY`, `WOLFHOUSE_STRIPE_WEBHOOK_SECRET`.

## Isolation rationale (why per-client prod)

Per `docs/MULTICLIENT-ARCHITECTURE.md`: isolate what carries risk (DB, runtimes,
secrets) per live client; share what's cheap and stateless (codebase, image, CI).
A Wolfhouse incident must not be able to touch Sunset/Mirleft data, money, or
guests. Locations within Wolfhouse share this runtime/DB and are separated by
`location_id`.

## Cost controls

- **Small SKUs first:** Postgres `Burstable / Standard_B1ms`, ACR `Basic`. Scale up
  only if real load requires it.
- **Min replicas:** Staff API and Hermes start at **min 1 / max 1** (no autoscale).
- **No autoscale unless needed:** add `--max-replicas > 1` only with evidence of load.
- **Logs retention:** Log Analytics retention **30 days** (raise only if required).
- **Staging scale-down policy:** once prod is stable, scale non-essential staging
  apps to min 0 / stop schedules to avoid paying for idle staging alongside prod.
- **Immutable tags:** deploy by `:<git-sha>` tag; no rebuild churn, easy rollback.

## Approval gates (must not proceed without operator sign-off)

- [ ] **Meta webhook** — pointing the Wolfhouse `phone_number_id` webhook to
      `https://hermes.lunafrontdesk.com/whatsapp/webhook` requires **explicit approval**.
      No Meta webhook change from this plan.
- [ ] **Stripe live** — wiring the live Stripe context and any live charge/refund
      requires **explicit approval**. No live Stripe action from this plan.
- [ ] **Flip `live_enabled=true`** for `wolfhouse` only after the go-live checklist
      passes (`GO-LIVE-CHECKLIST.md`).

## Rollback / no-op statement

This plan is a **no-op**: running `scripts/plan-wolfhouse-prod-infra.js` changes
nothing and executes no `az` command, so there is nothing to roll back from the
plan itself. If/when the suggested commands are later run (separately, with
approval), rollback follows `LIVE-ROLLBACK-RUNBOOK.md`: redeploy the previous
known-good image tag, restore the previous Meta webhook target, set
`live_enabled=false`, and preserve the database (no manual payment/booking
mutation). Resource creation is forward-only; teardown, if ever needed, is a
deliberate separate operator action, not part of this plan.
