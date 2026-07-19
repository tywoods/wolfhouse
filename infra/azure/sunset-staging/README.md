# Sunset Isolated Staging — Azure Bicep Runbook

> **FOUNDATION Slice 2:** core Bicep reconciled to `inventory/live-inventory.normalized.json`.
> **Do not `az deployment group create` from this slice — what-if only until Captain approves a later deploy.**
>
> Parent plan: [`docs/sunset/SUNSET-PORTAL-SLICE-1-INFRA-BUILD-PLAN.md`](../../../docs/sunset/SUNSET-PORTAL-SLICE-1-INFRA-BUILD-PLAN.md)
> Live drift baseline: [`inventory/DRIFT-REPORT.md`](inventory/DRIFT-REPORT.md)

---

## Files

| File | Purpose |
|------|---------|
| `main.bicep` | Sunset-only staging resources (Staff API + DB + KV + identity) — reconciled to live core |
| `schema-observer-job.bicep` | Manual schema-drift observer job module (gated; default off) |
| `acr-pull-role.bicep` | Cross-RG module: `AcrPull` on `whstagingacr` for Sunset identity |
| `parameters.example.json` | **NON-DEPLOYABLE** example — unmistakable `<REQUIRED…>` placeholders only; supply real values via ignored secure params file or CLI |
| `inventory/` | FOUNDATION Slice 1 live-to-IaC drift baseline (read-only source of truth) |
| `README.md` | This runbook |

> **parameters.example.json cannot be used for deployment** without explicit real values for secure/operational parameters (`deploySha`, `forceRevision`, WhatsApp numbers/IDs, inbox emails, `lunaBotInternalToken`, `postgresAdminPassword`) supplied through an ignored secure parameter file or approved secret source. Never commit those values.

---

## Live reconcile contract (Slice 2)

| Setting | Declared value |
|---------|----------------|
| Non-CA resources location | `westeurope` |
| Container Apps env + Staff API location | `northeurope` |
| Staff API scale | `minReplicas=1`, `maxReplicas=1` |
| `STAFF_ACTIONS_ENABLED` | `true` (hardcoded; matches live) |
| Image | `whstagingacr.azurecr.io/luna-sunset-staff-api:<staffApiImageTag>` — **tag required via parameters** |
| Deploy flags | `deployContainerApps=true`, `deployStaffApi=true` (represent existing live app) |
| Schema observer job | Live: `luna-sunset-staging-sch-obs` Manual/unscheduled (Slice 10). Source default remains `deploySchemaObserverJob=false` |
| Owner tag | `tywoods` (parameter; omitted on staff-api tags to match live) |

### Still unmanaged / manual (not claimed by Bicep)

| Item | Notes |
|------|-------|
| Managed certificate | Custom domain TLS — live only |
| `luna-sunset-staging-hold-expiry` job | Scheduled job — live only |
| Schema observer dedicated RO DB role + KV secret | FOUNDATION Slice 9 live provision of `sunset_schema_observer` + `sunset-schema-observer-database-url` (job still gated off in Bicep) |
| Postgres firewall rules | Live egress allow rules — leave `postgresAllowedIpAddresses: []` |
| External DNS | `sunset-staging.lunafrontdesk.com` outside this subscription |
| Operator Key Vault Secrets Officer | Human RBAC — not in template |
| Inline `luna-bot-internal-token` | Value remains manual secure param at what-if/deploy time — **never committed** |
| Managed certificate resource | Cert is `existing` reference only — Bicep does not create/rotate it |
| Custom domain binding | Declared against existing cert for live parity; DNS still external |

---

## Target resources (encoded in Bicep)

| Resource | Name |
|----------|------|
| Resource group (external) | `luna-sunset-staging-rg` |
| Container Apps environment | `luna-sunset-staging-env` |
| Container App | `luna-sunset-staging-staff-api` |
| Managed identity | `luna-sunset-staging-identity` |
| Key Vault | `luna-sunset-staging-kv` |
| Postgres server | `luna-sunset-staging-pg-app` |
| Database | `sunset_staging` |
| Image | `whstagingacr.azurecr.io/luna-sunset-staff-api:<tag>` |
| Portal URL (post-DNS) | `https://sunset-staging.lunafrontdesk.com` |
| Health | `GET /healthz` |

**Out of scope:** n8n, Redis, dedicated ACR, Wolfhouse runtime resources.

---

## Anti-Wolfhouse guards (ABORT if violated)

Before any `az` command, verify targets:

| Forbidden | Reason |
|-----------|--------|
| `wh-staging-rg` as **deployment target** | Sunset deploys to `luna-sunset-staging-rg` only |
| `wh-staging-staff-api` | Wolfhouse Container App — hands off |
| `staff-staging.lunafrontdesk.com` | Wolfhouse portal URL |
| `wh-staff-api:*` image tag | Wrong image repo |
| `wolfhouse_staging` DB URL / database name | Wrong tenant DB |
| Role assignments on Wolfhouse KV / Container App / Postgres | No Sunset access to WH runtime |

**Allowed cross-RG touch (Option A only):**

- Read existing `whstagingacr` in `wh-staging-rg`
- `AcrPull` role for `luna-sunset-staging-identity` on `whstagingacr` (no `AcrPush`)

Bicep guards via `@allowed` on `appNamePrefix` and `appDbName`; image repo hardcoded as `luna-sunset-staff-api` (never `wh-staff-api`).

---

## ACR strategy (Option A — Captain approved)

- **Reuse** `whstagingacr` in `wh-staging-rg`
- **Image repo:** `luna-sunset-staff-api` only
- **Live reconcile tag (example):** `186307418400581a74f86b096e02bc32a41513b6`
- **Never** deploy or reference `wh-staff-api` images

### ACR RBAC limitation (Captain review)

Azure RBAC **`AcrPull` is registry-scoped**, not repository-scoped in Bicep. This template assigns:

```
luna-sunset-staging-identity  →  AcrPull  →  whstagingacr (entire registry)
```

**Implication:** The identity *could* pull any image in `whstagingacr` if misconfigured in the Container App `image` field. Mitigations:

1. Bicep hardcodes image path `luna-sunset-staff-api:<tag>` (repo not parameterizable)
2. No `AcrPush` on Sunset identity
3. Ops pre-flight: verify deployed image repo before traffic enable

---

## Identity / RBAC (encoded)

| Principal | Role | Scope | Notes |
|-----------|------|-------|-------|
| `luna-sunset-staging-identity` | Key Vault Secrets User | `luna-sunset-staging-kv` | get/list secrets only |
| `luna-sunset-staging-identity` | AcrPull | `whstagingacr` | pull only; no push |

Container App uses user-assigned identity for Key Vault secret refs and ACR pull.

---

## Postgres networking (encoded)

| Setting | Value |
|---------|-------|
| SKU | `Standard_B1ms` (Burstable) |
| Server | `luna-sunset-staging-pg-app` |
| Database | `sunset_staging` |
| `publicNetworkAccess` | `Enabled` |
| Declared firewall rules | Empty by default — **live rules remain manual** |

**Wolfhouse DB:** Never referenced. Admin user default `sunsetadmin`.

---

## Secrets (Key Vault — manual; names only in git)

Secrets are **not** created by Bicep. Expected secret **names:** `sunset-database-url`, `staff-session-secret`, `stripe-secret-key`, `stripe-webhook-secret`, `meta-whatsapp-token`.

**App env mapping:** KV secret `sunset-database-url` → env `WOLFHOUSE_DATABASE_URL` (value must be Sunset DB only).

---

## Safety flags (hardcoded in Bicep — not overridable)

| Variable | Value |
|----------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `STAFF_ACTIONS_ENABLED` | `true` (live reconcile) |
| `STAFF_AUTH_REQUIRED` | `true` |
| `STAFF_AUTH_HTTPS` | `true` |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` |

---

## What-if only (FOUNDATION Slice 2)

```bash
# Compile / lint
az bicep build --file infra/azure/sunset-staging/main.bicep
az bicep lint --file infra/azure/sunset-staging/main.bicep

# Incremental what-if — NEVER deployment create in this slice
az deployment group what-if \
  --resource-group luna-sunset-staging-rg \
  --mode Incremental \
  --template-file infra/azure/sunset-staging/main.bicep \
  --parameters @infra/azure/sunset-staging/parameters.example.json \
  --parameters postgresAdminPassword='<EPHEMERAL>' \
              lunaBotInternalToken='<EPHEMERAL>' \
              deploySha='<LIVE_OR_APPROVED>' \
              forceRevision='<LIVE_OR_APPROVED>' \
              sunsetSomoWhatsappNumber='<LIVE_OR_APPROVED>' \
              sunsetSardineroWhatsappNumber='<LIVE_OR_APPROVED>' \
              sunsetSomoWhatsappPhoneNumberId='<LIVE_OR_APPROVED>' \
              sunsetSardineroWhatsappPhoneNumberId='<LIVE_OR_APPROVED>' \
              sunsetSomoInboxEmail='<LIVE_OR_APPROVED>' \
              sunsetSardineroInboxEmail='<LIVE_OR_APPROVED>'
```

Prefer an **ignored** local secure params file (gitignored) over shell history for real values. Never record live values in the repo.

Expect: **no Create/Delete** and **no material Modify** on declared core resources. Classify secret/redacted/no-effect noise explicitly (secure param diffs, reference() resolution, platform default properties).

### Slice 2 what-if result (2026-07-17, Incremental, read-only)

| Resource | Change | Classification |
|----------|--------|----------------|
| `luna-sunset-staging-identity` | Nochange | matches |
| `luna-sunset-staging-logs` | Nochange | matches |
| `luna-sunset-staging-kv` | Nochange | matches |
| `sunset_staging` database | Nochange | matches |
| `luna-sunset-staging-staff-api` | Modify (platform props: `exposedPort`, `maxInactiveRevisions`, `runningStatus`; six ingress-routing env values shown as `parameters('…')` expressions) | **harmless no-effect / secure-param resolution noise** (live values supplied only at execution time; not committed) |
| `luna-sunset-staging-env` | Modify (`peerAuthentication` omit; Log Analytics `customerId` reference()) | **harmless no-effect noise** |
| `luna-sunset-staging-pg-app` | Modify (omit platform defaults: storage tier/iops, replica role, authConfig) | **harmless no-effect noise** |
| `luna-sunset-staging-appinsights` | Modify (add default `Flow_Type`/`Request_Source`) | **harmless no-effect noise** |
| KV Secrets User role assignment | Modify (`principalId` reference(); `principalType` unsupported) | **harmless reference / unsupported noise** |
| `luna-sunset-staging-hold-expiry` | Ignore | unmanaged (not claimed) |
| managed certificate | Ignore | unmanaged (existing reference only) |
| ACR AcrPull assignment | Unsupported (cross-RG ID until deploy) | **harmless unsupported analysis noise** |

**Create: 0 · Delete: 0 · Material Modify: 0**

### Slice 6 schema observer (source-only)

Manual Container Apps Job module `schema-observer-job.bicep`, wired only when `deploySchemaObserverJob=true`. Default remains `false` so Incremental what-if stays Create=0. Proposal what-if with the flag enabled should show exactly one Create (`luna-sunset-staging-sch-obs`, ≤32-char job name) and no other Creates. Dedicated read-only DB identity/secret are **not** provisioned in this slice. Existing deployment preflight stays fail-closed on Create until a later approved slice.

The committed fixture is a **structural-and-security product-schema contract** (tables/columns/constraints/indexes/sequences/views/enums/functions/triggers/RLS flags+policies/ownership/ACLs/extensions). It is **not** complete schema equivalence — see `excludedSections` in the contract and observer report (`schema_migration_ledger`, guest rows, statistics, toast, publications, event triggers). Enums, public function definitions, and RLS/policies are included.

Local observer proof (no Azure job create):

```bash
node scripts/generate-sunset-expected-schema-contract.js
node scripts/verify-sunset-schema-observer.js
node scripts/prove-sunset-schema-observer-local.js
```

Verifier:
```bash
node scripts/verify-sunset-staging-bicep-reconcile.js --self-test
node scripts/verify-sunset-staging-bicep-reconcile.js
```

## Deployment preflight (FOUNDATION Slice 3 — fail-closed, read-only)

Never creates/updates Azure resources. Incremental what-if only (`az deployment group what-if --no-pretty-print`). No `deployment group create` path exists in the preflight command surface.

**Scope note:** ACR image existence is the **post-build** deployment gate (immutable tag == master SHA must already be in ACR). This command does **not** replace the existing **pre-build** master/source preflight (`assert-repo-sync` / `assert-deploy-from-master`). Run those before building/pushing an image; run this preflight before any Sunset Bicep deploy candidate.

Prerequisite short-circuit: if Git, secure-params provenance, or parameters fail, Azure account/ACR/cost/what-if are **not** called. If subscription/RG validation fails, ACR/cost/what-if are skipped. Skipped checks are reported with `skipped: true` and reason codes (never as passes).

Secure params provenance: in-repo files must be **untracked** and match `git check-ignore` (tracked `tmp`/`local` names are rejected). Outside-repo paths must be regular files (no symlinks). Env-only `WH_SUNSET_PF_*` remains allowed. File contents are never printed.

```bash
# Secure params must be gitignored (tmp/*.local.json) or WH_SUNSET_PF_* env vars
node scripts/preflight-sunset-staging-bicep.js \
  --base-params infra/azure/sunset-staging/parameters.example.json \
  --secure-params tmp/sunset-preflight.secure.local.json \
  --report tmp/sunset-bicep-preflight-report.json

node scripts/verify-sunset-staging-bicep-preflight.js

# Optional: live Azure probe from a feature branch (mocks clean origin/master git)
node scripts/run-sunset-staging-bicep-preflight-live-probe.js
```

Requires: clean `HEAD == origin/master`, `staffApiImageTag`/`deploySha`/`forceRevision` == full master SHA, immutable ACR image present, subscription/RG match Slice 1 inventory, rejected placeholders/`****`/example.test routing literals absent, and what-if with Create=Delete=Replace=MaterialModify=0 (only explicitly fingerprinted platform noise allowed).

Secret-free live probe fixture: `fixtures/sunset-staging-bicep-preflight/live-preflight-report.json`.

---

## Cost attribution tags

| Tag | Example |
|-----|---------|
| `product` | `Luna Front Desk` |
| `tenant` | `sunset` |
| `environment` | `staging` |
| `owner` | `tywoods` (parameter; not on staff-api live tags) |
| `slice` | `portal-1` |

---

## Schema observer job (FOUNDATION Slice 10)

Manual, unscheduled Container Apps Job `luna-sunset-staging-sch-obs` is deployed in Sunset staging and wired to Key Vault secret `sunset-schema-observer-database-url` (secretRef only — never plaintext DSN).

- **Source default stays off:** `deploySchemaObserverJob=false` in `main.bicep` / `parameters.example.json`.
- **Deployment path (only):** standalone `infra/azure/sunset-staging/schema-observer-job.bicep` with gitignored `tmp/foundation-slice10/slice10-job-module.secure.local.json`.
- **Parameter preparer:** `node scripts/prepare-sunset-schema-observer-job-slice10-params.js` writes that module file only (non-secret locked metadata: job name, CAE/MI IDs, live Staff API image, KV base URI, observer secret **name**, compute/retry/timeout, tags). It never prepares a `main.bicep` overlay and never reads app DB DSN, bot tokens, WhatsApp/inbox values, or any secret **value**.
- Do **not** start or schedule the job from this slice.
- Evidence: `fixtures/sunset-schema-observer/slice10-job-deploy-evidence.json`.

```bash
node scripts/prepare-sunset-schema-observer-job-slice10-params.js
# then operator-approved what-if/create against schema-observer-job.bicep only:
# az deployment group what-if --template-file infra/azure/sunset-staging/schema-observer-job.bicep \
#   --parameters @tmp/foundation-slice10/slice10-job-module.secure.local.json
```

---

## Schema observer role + KV secret (FOUNDATION Slice 7–9)

Fail-closed convergent provision tooling for the dedicated observer role / DSN secret. **Default is dry-run.** Slice 9 enables live apply for Sunset staging only (`LIVE_APPLY_ENABLED=true`) when `--apply` and env gates are set.

| Locked target | Value |
|---------------|-------|
| RG | `luna-sunset-staging-rg` |
| PostgreSQL | `luna-sunset-staging-pg-app` |
| Database | `sunset_staging` |
| Key Vault | `luna-sunset-staging-kv` |
| Role | `sunset_schema_observer` |
| Secret | `sunset-schema-observer-database-url` |

**Hardening (Slice 8) + live wire-up (Slice 9):**
- Verify live Azure subscription/RG/Postgres FQDN/KV before any DB/KV action
- Connect only to locked `sslmode=verify-full` host; require `current_database()=sunset_staging`
- Enforce `NOBYPASSRLS`; fail closed on memberships/ownership/excess ACLs outside CONNECT-only
- Convergent bootstrap: absent+absent→create; both valid→no-op; inconsistent→refuse; KV failure rolls back only a newly created role (REVOKE CONNECT → RESET readonly → DROP ROLE); never rotate existing credentials
- `CREATE ROLE PASSWORD` uses validated URL-safe SQL literals (not protocol bind params); KV writes via 0600 temp `--file` (never DSN in argv); redact secrets from results/errors/reports
- Live adapters: `scripts/lib/sunset-schema-observer-role-live-adapters.js` (no firewall/network, no schema/data, no Container Apps job)
- PostgreSQL bootstrap is **transactional** (`BEGIN` → CREATE → GRANT CONNECT → ALTER readonly → `COMMIT`); on failure `ROLLBACK` and prove role absent. If a non-transactional partial create ever remains, the adapter runs the ordered REVOKE→RESET→DROP rollback (never `DROP OWNED`).
- If bootstrap **commits** but temp worker/bootstrap-password secret cleanup leaves an active secret, the adapter does **not** write the final observer DSN secret — it runs the same narrow rollback and fails closed with a secret-free report (`bootstrapCommitted` + cleanup failure + rollback outcome).
- Temp KV secrets (`*-bootstrap-temp`, `*-worker-temp*`) are deleted/purged then verified absent as active secrets; cleanup failure is fail-closed.

```bash
# Dry-run (default) — prints plan; no Azure/Postgres mutation
node scripts/provision-sunset-schema-observer-role.js

# Focused verifier (injected adapters; no Azure mutation)
npm run verify:sunset-schema-observer-role-provision

# Approved Slice 9 live apply (Sunset staging only)
SUNSET_SCHEMA_OBSERVER_ROLE_APPLY=1 \
AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
SUNSET_STAGING_PG_ADMIN_USER=<admin-login> \
SUNSET_STAGING_PG_ADMIN_PASSWORD=<admin-password> \
  node scripts/provision-sunset-schema-observer-role.js --apply
```

Role contract: `LOGIN` + `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, `default_transaction_read_only=on`, `CONNECT` on `sunset_staging` only (no product DML/DDL grants; no firewall/network mutation).

---

*FOUNDATION Slice 3 — enforced Bicep deployment preflight (read-only; fail-closed) — 2026-07-17*
*FOUNDATION Slice 7 — schema-observer role/KV provision tooling (source-only; live apply disabled) — 2026-07-18*
*FOUNDATION Slice 8 — convergent/safe provisioner hardenings — 2026-07-18*
*FOUNDATION Slice 9 — live Sunset staging role+KV provision (approved; no job/firewall/schema/data) — 2026-07-19*
*FOUNDATION Slice 10 — deploy manual unscheduled `luna-sunset-staging-sch-obs` job (not executed; KV secret ref only) — 2026-07-19*
