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
| Schema observer job | Live: `luna-sunset-staging-sch-obs` Manual/unscheduled; Slice 12 canonical image (digest-pinned); DB drift still unresolved |
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
| `wh-staging-identity` (Lunabox) | Key Vault Secrets User | `luna-sunset-staging-kv` | Slice **14H plan-only** — not deployed yet; resolves 14G 403 |

Container App uses user-assigned identity for Key Vault secret refs and ACR pull. Lunabox MI assignment is a standalone module (`wh-staging-identity-kv-secrets-user-role.bicep`) — **not** wired into `main.bicep`.

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
| `STRIPE_WEBHOOK_CLIENT_SLUG` | **Required for FORTRESS 15B** — set to this deployment’s tenant slug (`sunset`). Prefer over `DEFAULT_CLIENT_SLUG`. If both are set they must match; missing/conflicting → webhook fail-closed (`no_db_write`). Same requirement on Wolfhouse Staff API with its tenant slug. |

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

## Schema observer execution (FOUNDATION Slice 11)

Manual job `luna-sunset-staging-sch-obs` was executed (not scheduled). Evidence: `fixtures/sunset-schema-observer/slice11-job-execution-evidence.json`.

**Outcome:** Slice 11 is **unresolved**. Canonical-vs-live drift remains (`match=false`, observer exit 4, mismatchCount 88). Prior `match=true` was invalid because a live-derived expected fixture made the observer circular.

**Canonical expected state** comes only from the reviewed migration chain / canonical manifest via `scripts/generate-sunset-expected-schema-contract.js` → `fixtures/sunset-schema-observer/expected-product-schema.json`.

**Live snapshots are observations only.** Any divergence between canonical expected and live Sunset is a **failure requiring investigation**, not a reason to refresh, overwrite, bless, or replace the expected fixture with live state.

- Baseline observe uses `node scripts/observe-sunset-schema-drift.js` with KV secretRef DSN only and the **canonical** fixture.
- Optional evidence-only live observation assembler (`scripts/capture-sunset-live-schema-observation.js`) consumes observer-job dump chunks and writes solely under gitignored `tmp/foundation-slice11/actual-live-state-evidence.json` (label: “actual live state — not canonical”). It **cannot** overwrite `expected-product-schema.json` and must not run via Staff API / arbitrary staged source.
- Committed audit report (all mismatch keys, secret-free): `fixtures/sunset-schema-observer/slice11-canonical-vs-live-mismatch-report.json`.
- Slice 11 left the job image unsafe for canonical monitoring (live-derived expected fixture). That image defect is repaired in Slice 12 (below). Database drift itself was not repaired in Slice 11.
- Safe synthetic drift proofs (in-job) compare against the **canonical** fixture via a temporary override; they must not alter canonical or live state.

```bash
# secret-free module params (metadata only), then operator-approved what-if:
node scripts/prepare-sunset-schema-observer-job-slice10-params.js
# az deployment group what-if --template-file infra/azure/sunset-staging/schema-observer-job.bicep \
#   --parameters @tmp/foundation-slice10/slice10-job-module.secure.local.json
```

---

## Schema observer image repair (FOUNDATION Slice 12)

**Outcome:** Runtime-image repair **complete**. Manual job `luna-sunset-staging-sch-obs` now runs an immutable image built from merged master `86de3ee59901205a22e3cdffef9ccc922e312d8d` (tag suffix `-slice12observer`, digest `sha256:42708ce7…`). Canonical live observe returns **exit 4** / `match=false` / `mismatchCount=88` against existing Sunset schema drift. **Database drift remains unresolved; FOUNDATION remains blocked.**

Evidence: `fixtures/sunset-schema-observer/slice12-observer-image-repair-evidence.json`. Contract: `fixtures/sunset-schema-observer/slice12-observer-image-repair-contract.json`.

| Check | Result |
|-------|--------|
| Job trigger | Manual; schedule absent |
| Job image | Digest-pinned Slice 12 observer image (not Slice 11 `…-slice11final`) |
| Embedded fixture fingerprint | `daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52` |
| Staff API app image/revision | Unchanged (`…1863074…` / `--0000266`) |
| Canonical execution | `luna-sunset-staging-sch-obs-egrrb8d` → Azure `Failed`, exit 4, `product_schema_differs` |
| `safeForCanonicalMonitoring` | `true` (image content); live still drifts |
| DB / ledger / role / secret / firewall / network | Not mutated |
| Fixture refresh / live blessing | Forbidden; not performed |

```bash
npm run verify:sunset-schema-observer
```

---

## Schema drift classification (FOUNDATION Slice 13A)

**Investigation only** — classifies the 88 canonical/live mismatches and infers structural provenance for all 36 forward migrations. **No repair design, no live mutation, no observer job start.**

Artifacts:
- `fixtures/sunset-schema-observer/slice13a-mismatch-classification-report.json`
- `fixtures/sunset-schema-observer/slice13a-migration-provenance-matrix.json`
- `fixtures/sunset-schema-observer/slice13a-manifest-byte-provenance-report.json`
- `fixtures/sunset-schema-observer/slice13a-findings.md`
- `fixtures/sunset-schema-observer/slice13a-operator-decision-list.json`

```bash
npm run build:sunset-schema-slice13a-manifest-hash-report
npm run build:sunset-schema-slice13a-classification
npm run verify:sunset-schema-slice13a
```

**Outcome:** ownership/ACL/extension mismatches are largely Azure environment-identity / observer-normalization differences (do not mutate ownership to match role names). Migration `035_customer_message_templates` is **absent** live and appears safely additive (not applied here). Proposed location_id / `*_loc` index shapes present live remain an operator decision. **migration_integrity_blocker:** resolved in Slice 13A.1 (`canonical_lf_v1`). `schema_migration_ledger` absent → FOUNDATION still blocked on unresolved DB drift pending Slice 13B+ repair phases.

---

## Schema reconciliation design (FOUNDATION Slice 13B)

**Design only** — approved forward-only reconciliation direction for the 88 mismatches and absent ledger. **No repair implementation, no Slice 13C rehearsal execution, no live mutation, no observer job start, no canonical migration/manifest/fixture changes.**

Artifacts:
- `fixtures/sunset-schema-observer/slice13b-decision-record.json` (DEC-001…006)
- `fixtures/sunset-schema-observer/slice13b-phased-reconciliation-design.json` (phases A–F)
- `fixtures/sunset-schema-observer/slice13b-mismatch-to-phase-map.json` (88 keys → exactly one phase)
- `fixtures/sunset-schema-observer/slice13b-ledger-bootstrap-spec.json`
- `fixtures/sunset-schema-observer/slice13b-slice13c-rehearsal-contract.json` (disposable-only)
- `fixtures/sunset-schema-observer/slice13b-findings.md`

```bash
npm run build:sunset-schema-slice13b-design
npm run verify:sunset-schema-slice13b
```

**Direction (operator approval still required before repair):** observer Azure normalization (no ownership mutation); promote location-aware model into canonical forward later; additive 035 + tenant_services columns; CHECK constraints after violation-count preflight; fail-closed ledger bootstrap (`verified_structural_baseline` vs `executed_by_canonical_runner`); keep 018/019/020 blocked until metadata checks pass.

### Slice 13C.1 — Phase A identity normalization (implemented)

Observer profile `azure_flexible_server_v1` normalizes Azure Flexible Server identity presentation only. Offline/committed evidence proves **88 → 46** mismatches (42 ownership/ACL/extension presentation keys cleared; 46 substantive remain). Live DB still does not match canonical.

```bash
npm run build:sunset-schema-slice13c1-normalization-evidence
npm run verify:sunset-schema-slice13c1
```

Artifacts: `fixtures/sunset-schema-observer/slice13c1-azure-identity-normalization-evidence.json`, `slice13c1-findings.md`. Phase A marked complete on the Slice 13C rehearsal contract. **No observer job start in this slice.**

### Slice 13C.2 — Phase B location-aware admin model promotion (implemented)

Promoted approved location-aware admin-rule model into one new canonical forward migration `039_sunset_admin_location_aware_rules.sql` (DEC-002). Disposable dual-path proof only. Offline mismatch trajectory **46 → 29** (17 Phase B keys resolved; 29 genuine drift remain). Still `product_schema_differs`. **Do not claim** Sunset is repaired. Historical PROPOSED 023/024/025 remain non-executable. **No live apply / observer job / image deploy.**

| Item | Value |
|------|-------|
| Forward count | 36 → 37 |
| Prior fingerprint | `daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52` |
| New fingerprint | `553d21d3dca91b60a1b9e09799f677051be63d491792fd68e12b5f6652c220f1` |
| Migration hash (`canonical_lf_v1`) | `b34d8886bc832db61e8fc67e333a655ab5976d35d1817f2b62ddfaf61682c2a3` |
| Manifest hash | `7ac14e1637b7e58f28bda8f494f8556dd0f03c27c00a04340ebf941f19e7beb0` |

Index/CHECK promotion is catalog fail-closed (exact targets preserved; incompatible definitions raise — no silent drop/replace).

```bash
npm run prove:sunset-schema-slice13c2-location-promotion
npm run verify:sunset-schema-slice13c2
```

Artifacts: `slice13c2-location-promotion-evidence.json`, `slice13c2-mismatch-46-to-29-evidence.json`, `slice13c2-findings.md`.

### Slice 13C.3a — Phase C tenant_services column promotion (implemented)

Promoted four approved `tenant_services` live-only SaaS catalog columns into one new canonical forward migration `040_tenant_services_saas_catalog_columns.sql` (DEC-004 Phase C). Disposable dual-path proof only. Offline mismatch trajectory **29 → 25** (4 Phase C column keys resolved; 25 genuine drift remain). Still `product_schema_differs`. Phase D CHECKs, CMT 035, notification indexes, and surf-pack reconciliation remain pending. **No live apply / observer job / image deploy.**

```bash
npm run prove:sunset-schema-slice13c3a-tenant-services-promotion
npm run verify:sunset-schema-slice13c3a
```

Artifacts: `slice13c3a-tenant-services-promotion-evidence.json`, `slice13c3a-mismatch-29-to-25-evidence.json`, `slice13c3a-findings.md`.

### Slice 13C.3b — Phase C migration 035 CMT disposable rehearsal (implemented)

Rehearsed **existing** canonical migration `035_customer_message_templates.sql` (byte-identical; no new forward migration) against a disposable Phase-C drift pre-state that omits only 035 effects. Disabled disposable-only harness with catalog preflight; does not claim canonical-runner/ledger provenance. Offline mismatch trajectory **25 → 8** (17 CMT-owned keys resolved; notification/surf-pack + Phase D CHECKs unchanged). Still `product_schema_differs`. **No live apply / observer job / image deploy.**

```bash
npm run prove:sunset-schema-slice13c3b-migration-035-rehearsal
npm run verify:sunset-schema-slice13c3b
```

Artifacts: `slice13c3b-migration-035-rehearsal-evidence.json`, `slice13c3b-mismatch-25-to-8-evidence.json`, `slice13c3b-migration-035-owned-key-map.json`, `slice13c3b-findings.md`.

### Slice 13C.3c — Phase C notification / surf-pack convergence (implemented)

Promoted fail-closed additive convergence for the six remaining Phase C notification indexes + surf-pack FK/index/trigger into one new canonical forward migration `041_notification_surfpack_convergence.sql`. Disposable dual-path proof only. Offline mismatch trajectory **8 → 2** (six Phase C keys resolved; two Phase D `tenant_services` CHECKs remain). Product fingerprint **unchanged** (objects already canonical via 026/032). Still `product_schema_differs`. **No live apply / observer job / image deploy.**

| Measure | Value |
|---------|------:|
| Forward count | **38 → 39** |
| Migration hash (`canonical_lf_v1`) | `3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09` |
| Manifest hash | `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e` |
| Product fingerprint | unchanged `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` |

```bash
npm run prove:sunset-schema-slice13c3c-notification-surfpack
npm run verify:sunset-schema-slice13c3c
```

Artifacts: `slice13c3c-notification-surfpack-evidence.json`, `slice13c3c-mismatch-8-to-2-evidence.json`, `slice13c3c-six-key-map.json`, `slice13c3c-findings.md`.

### Slice 13C.3d — integrated Phase C disposable proof (implemented)

Integrated disposable proof that the reviewed Phase C sequence **040 → immutable 035 rehearsal → 041** transforms the exact **29-key** post-13C.2 drift prestate into exactly the **two** Phase D `tenant_services` CHECK mismatches. Multi-transaction checkpoints (not all-three atomic); fail-stop + idempotent resume proven. No new forward migration. Still `product_schema_differs`. **No live apply / observer job / image deploy.**

| Measure | Value |
|---------|------:|
| Forward count | **39 (unchanged)** |
| Migration 035 hash | `924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565` |
| Migration 040 hash | `880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd` |
| Migration 041 hash | `3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09` |
| Manifest hash | `99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e` (**unchanged**) |
| Product fingerprint | `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18` (**unchanged**) |
| Mismatch trajectory | **29 → 25 → 8 → 2** |

```bash
npm run prove:sunset-schema-slice13c3d-integrated-phase-c
npm run verify:sunset-schema-slice13c3d
```

Artifacts: `slice13c3d-integrated-phase-c-evidence.json`, `slice13c3d-mismatch-29-to-2-evidence.json`, `slice13c3d-checkpoint-key-sets.json`, `slice13c3d-findings.md`.

### Slice 14A — Phase D CHECK aggregate preflight (implemented)

Source-only, default-disabled, read-only aggregate preflight for the two Phase D constraints already owned by immutable migration `028` (`tenant_services_date_window`, `tenant_services_price_unit`). Returns **only** total row count + violation counts — never row values, identifiers, guest data, or arbitrary SQL. Predicates locked to 028; table/column types validated before counting. Disposable PostgreSQL proof only (non-loopback rejected). **No** live/Azure connectivity, firewall action, mutation, migration, ledger, apply flag, or `ADD CONSTRAINT`. Still `product_schema_differs`. Migrations / manifest / expected fixture / product fingerprint / 13C hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14a-phase-d-preflight
npm run verify:sunset-schema-slice14a
```

Artifacts: `slice14a-phase-d-preflight-contract.json`, `slice14a-phase-d-preflight-evidence.json`, `slice14a-findings.md`.

### Slice 14B — Phase D live read-only connection boundary (implemented)

Live read-only connection boundary that gates the merged Slice 14A count-only preflight against the exact Sunset staging PostgreSQL/database. Locks subscription, resource group, server FQDN, database, TLS `verify-full`, `application_name=wh-sunset-phase-d-preflight`, and `BEGIN READ ONLY`. Credentials only from protected admin env (`SUNSET_STAGING_PG_ADMIN_USER` / `SUNSET_STAGING_PG_ADMIN_PASSWORD`), populated by the existing locked loader from Key Vault `sunset-database-url` — connection config constructed only for the locked host/database. Never accepts caller-supplied DSN, argv credential, `SUNSET_SCHEMA_OBSERVER_DATABASE_URL` (CONNECT-only / no SELECT), `WOLFHOUSE_DATABASE_URL`, or arbitrary file path; never prints/persists username/password in evidence/errors. Exact target accepted only with dual enable flags (`SUNSET_PHASE_D_LIVE_READONLY=1` + `SUNSET_PHASE_D_LIVE_PREFLIGHT=1` + matching `AZURE_SUBSCRIPTION_ID`). Slice 14D activates `PHASE_D_LIVE_READONLY_CONNECT_ENABLED`; the boundary itself still never connects/queries. Offline injected-adapter proof only; **no** live connect/query in the 14B proof, firewall/network mutation, apply/DDL/ledger, migration, observer role/grant changes, or 14A predicate changes. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14b-phase-d-live-readonly-boundary
npm run verify:sunset-schema-slice14b
```

Artifacts: `slice14b-phase-d-live-readonly-boundary-contract.json`, `slice14b-phase-d-live-readonly-boundary-evidence.json`, `slice14b-findings.md`.

### Slice 14C — Phase D live read-only PostgreSQL adapter (implemented)

Real `pg` Client adapter behind the merged Slice 14B boundary. Creates a Client only after all 14B gates pass **and** the Slice 14D execute-count-only gate; builds config only from locked TARGETS + protected admin env (`SUNSET_STAGING_PG_ADMIN_USER` / `SUNSET_STAGING_PG_ADMIN_PASSWORD`); reuses verified TLS (`rejectUnauthorized: true` + `servername` = locked FQDN) and `statement_timeout=30000`; executes only the exact authorized 14A sequence (`BEGIN READ ONLY` → read-only verification → locked catalog checks → exact aggregate → `COMMIT`/`ROLLBACK`); closes exactly once in `finally`. Close/end failure is fail-closed. `PHASE_D_LIVE_READONLY_CONNECT_ENABLED=true` (activated in 14D); missing execute-count-only gate instantiates **zero** Clients. Offline scripted fake-Client proof only in the 14C verifier; **no** live/Azure query in that proof. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14c-phase-d-pg-adapter
npm run verify:sunset-schema-slice14c
```

Artifacts: `slice14c-phase-d-pg-adapter-contract.json`, `slice14c-phase-d-pg-adapter-evidence.json`, `slice14c-findings.md`.

### Slice 14D — Phase D live read-only activation + gated CLI (implemented)

Activates the merged 14C adapter behind exact 14B target/credential/query gates. Adds a narrow operator CLI (`scripts/run-phase-d-live-readonly-count-only.js` / `npm run phase-d:live-readonly-count-only`) that remains **default-disabled** and requires dual flags + `SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1` + `--execute-count-only` + exact `--subscription` / `--resource-group` / `--postgres-server` / `--database` + protected admin env. No DSN/host/query args. Real `pg` Client only after every gate passes; default/missing/wrong inputs instantiate zero Clients. Offline injected-Client proof of the activated sequence only; **no** live CLI run, Key Vault load, Azure/network/database mutation, DDL/apply/ledger, or migration/predicate changes. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14d-phase-d-readonly-activation
npm run verify:sunset-schema-slice14d
# default refuse (zero Clients):
npm run phase-d:live-readonly-count-only
```

Artifacts: `slice14d-phase-d-readonly-activation-contract.json`, `slice14d-phase-d-readonly-activation-evidence.json`, `slice14d-findings.md`.

### Slice 14E — Phase D managed-identity credential loader (implemented)

In-process Lunabox managed-identity + exact Sunset staging Key Vault `sunset-database-url` loader for the merged count-only CLI. Locks IMDS host `169.254.169.254`, vault resource audience `https://vault.azure.net`, vault `luna-sunset-staging-kv` / HTTPS URL, secret name, IMDS API `2018-02-01`, KV API `7.4`, Lunabox user-assigned identity **`wh-staging-identity`** (clientId `0dd41fa2-52c8-4e04-bc23-8aa462938c19`, principalId `e3136eed-948b-4947-a26e-50a33b45a41a` — the identity assigned to VM `lunabox` in `wh-staging-rg`; **not** `luna-sunset-staging-identity`), and exact PG host/database/`sslmode=verify-full`. IMDS request `client_id` must equal this lock (never omit / system / default / arbitrary). When IMDS token JSON exposes identity metadata, it must match; mismatch rejects **before** Key Vault. Rejects caller URLs/names/tokens/DSNs. Parses secret only in memory; extracts user/password; validates exact target; passes privately to the existing 14D adapter; zeros private refs. Never prints/returns/persists/hashes/evidences/argv/temp/child-env the token/DSN/credentials. Keeps protected-admin-env mode; managed-identity requires explicit `SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity` **and** `--credential-source managed-identity`. `PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=false` — offline injected-HTTP proof only; default zero HTTP/Clients. **No** live secret read, Azure/PG query, firewall/network, DDL/apply/ledger, or migration/predicate changes. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14e-phase-d-managed-identity-loader
npm run verify:sunset-schema-slice14e
```

Artifacts: `slice14e-phase-d-managed-identity-loader-contract.json`, `slice14e-phase-d-managed-identity-loader-evidence.json`, `slice14e-findings.md`.

### Slice 14F — Phase D credential-preflight activation (implemented)

Activates the merged 14E managed-identity HTTP loader behind an explicit **metadata-only** credential-preflight CLI (`scripts/run-phase-d-credential-preflight.js` / `npm run phase-d:credential-preflight`). Requires dedicated env `SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT=1` + `--credential-preflight-only` + `SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity` + `--credential-source managed-identity` + exact `--subscription` / `--resource-group` / `--vm-resource-group` / `--vm-name` / `--managed-identity` / `--key-vault` / `--secret-name` / `--postgres-server` / `--database`. Default/missing/wrong inputs make zero HTTP/pg Clients. On approved offline execution: exact locked IMDS GET then exact locked Key Vault secret GET; validate secret DSN in memory; immediately zero private refs; output only safe booleans + identity/vault/secret/PG host/database/TLS — never token, DSN, user/password, version values, secret metadata IDs, or hashes. Never instantiates a pg Client. No POST/PUT/PATCH/DELETE. Count-only DB command **unchanged**. `PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=false` — offline injected-HTTP proof only. **No** live secret read, Azure/PG query, firewall/network, DDL/apply/ledger, or migration/predicate changes. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14f-phase-d-credential-preflight
npm run verify:sunset-schema-slice14f
# default refuse (zero HTTP / zero Clients):
npm run phase-d:credential-preflight
```

Artifacts: `slice14f-phase-d-credential-preflight-contract.json`, `slice14f-phase-d-credential-preflight-evidence.json`, `slice14f-findings.md`.

### Slice 14H — Key Vault Secrets User RBAC apply-plan for Lunabox MI (implemented; plan-only)

Defines and offline-proves **exactly one** least-privilege Azure RBAC assignment resolving the Slice **14G** live credential-preflight **403** (`http_status_rejected` on Key Vault secret GET) — **without deploying it**.

| Lock | Value |
|------|-------|
| Principal | `wh-staging-identity` / `e3136eed-948b-4947-a26e-50a33b45a41a` |
| Role | Key Vault Secrets User / `4633458b-17de-408a-b874-0445c86b69e6` |
| Scope | vault `luna-sunset-staging-kv` only (RG `luna-sunset-staging-rg` / sub `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`) |
| Assignment name | deterministic `4653f1f5-6c4f-54bd-acba-6cad3d56d791` (`guid(existingKeyVault.id, principalId, roleDefinitionId)`) |
| principalType | `ServicePrincipal` |
| Module | `wh-staging-identity-kv-secrets-user-role.bicep` (standalone existing-resource reference; **not** in `main.bicep`) |

Default-disabled operator CLI (`scripts/run-phase-d-kv-secrets-user-rbac-plan.js` / `npm run phase-d:kv-secrets-user-rbac-plan`) requires `SUNSET_PHASE_D_KV_SECRETS_USER_RBAC_PLAN=1` + `--plan-only` + exact `--subscription` / `--resource-group` / `--key-vault` / `--principal-id` / `--role-definition-id`. Default/wrong args → **zero Azure mutation**. Live apply / what-if / deploy / RBAC create hard-disabled. Offline tests reject subscription/RG/vault/principal/role/scope broadening, Owner/Contributor/Admin, wildcard/RG/subscription scope, delete, duplicate/random GUID, and unrelated changes. Safe IDs only. **No** Key Vault retry, PG, DB, network, secret read, migration/DDL/ledger. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14h-kv-secrets-user-rbac-plan
npm run verify:sunset-schema-slice14h
# default refuse (zero Azure mutation):
npm run phase-d:kv-secrets-user-rbac-plan
```

Artifacts: `slice14h-kv-secrets-user-rbac-apply-plan.json`, `slice14h-kv-secrets-user-rbac-plan-contract.json`, `slice14h-kv-secrets-user-rbac-plan-evidence.json`, `slice14h-findings.md`.

### Slice 14J — Key Vault DSN sslmode=verify-full normalize plan (implemented; plan-only)

Defines and offline-proves a locked, recoverable operator plan to normalize **only** the existing Key Vault secret `luna-sunset-staging-kv` / `sunset-database-url` from a TLS-deficient PostgreSQL DSN to the same exact host, port, database, username and password with `sslmode=verify-full` — **without** reading or mutating the live secret in this slice.

| Lock | Value |
|------|-------|
| Vault / secret | `luna-sunset-staging-kv` / `sunset-database-url` |
| Identity | `wh-staging-identity` / `0dd41fa2-52c8-4e04-bc23-8aa462938c19` |
| PG host / port / database | `luna-sunset-staging-pg-app.postgres.database.azure.com` / `5432` / `sunset_staging` |
| Mutation | `sslmode` query param only → `verify-full` |
| PUT | exactly one new secret version (no retries) |
| Rollback | immediately previous version only, after separate explicit approval |

Future live adapter (offline-proven with injected HTTP): IMDS GET → KV GET → parse+require exact host/port/database → retain user/password in memory → modify only `sslmode` → PUT one new version → verification GET → zero private refs. Prior-version safe ID retained for rollback. Rejects arbitrary value/DSN/url/token/version/file/secret names, host/db/user/password changes, delete/purge/disable, tags/contentType mutations, extra query changes, retries, and any pg Client.

Default-disabled operator CLI (`scripts/run-phase-d-kv-dsn-verify-full-plan.js` / `npm run phase-d:kv-dsn-verify-full-plan`) requires `SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_PLAN=1` + `--plan-only` + exact `--subscription` / `--resource-group` / `--key-vault` / `--secret-name` / `--managed-identity` / `--postgres-server` / `--database`. Rollback plan: `SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_ROLLBACK=1` + `--rollback-plan-only` + `--prior-version-id`. Default/wrong args → **zero KV writes**. Live mutate / rollback hard-disabled. Fake HTTP RED/GREEN success call counts: httpRequestCount=4, imds=1, keyVaultGet=2, keyVaultPut=1. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14j-kv-dsn-verify-full-plan
npm run verify:sunset-schema-slice14j
# default refuse (zero KV writes):
npm run phase-d:kv-dsn-verify-full-plan
```

Artifacts: `slice14j-kv-dsn-verify-full-apply-plan.json`, `slice14j-kv-dsn-verify-full-plan-contract.json`, `slice14j-kv-dsn-verify-full-plan-evidence.json`, `slice14j-findings.md`.

### Slice 14K — Key Vault DSN sslmode=verify-full apply activation (implemented; offline proof)

Activates the merged Slice **14J** metadata-preserving sslmode-only Key Vault mutation adapter behind a dedicated exact operator command. Real Node `http`/`https` transport is restricted to locked IMDS GET, exact current-secret GET, exactly one same-secret PUT, and exact verification GET. Live path requires `SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY=1` + exact `AZURE_SUBSCRIPTION_ID` + `--apply-verify-full` + exact targets. Default/wrong gates → **zero HTTP / zero writes**. Rollback remains separately hard-disabled. This slice does **not** execute live IMDS/Key Vault/PostgreSQL in its prove. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14k-kv-dsn-verify-full-activation
npm run verify:sunset-schema-slice14k
# default refuse (zero HTTP / zero writes):
npm run phase-d:kv-dsn-verify-full-apply
```

Artifacts: `slice14k-kv-dsn-verify-full-activation-contract.json`, `slice14k-kv-dsn-verify-full-activation-evidence.json`, `slice14k-findings.md`.

### Slice 14M — Phase D live read-only counts (managed-identity)

Exactly **one** live read-only Phase D count via the merged **14D/14E** managed-identity count-only CLI, after offline RED/GREEN and one live credential-preflight. Requires dual flags + execute-count-only + managed-identity credential-source + exact targets. Sequence: locked `wh-staging-identity` IMDS GET → `luna-sunset-staging-kv`/`sunset-database-url` GET → in-memory exact target validation → one `pg` Client to locked host/database with TLS `verify-full` and `application_name=wh-sunset-phase-d-preflight` → `BEGIN READ ONLY` → exact 14A aggregate → `COMMIT`/`ROLLBACK`. Output: safe counts/target identifiers/call counters only. On IMDS/KV/TLS/firewall/auth/query error: sanitize and stop (no broad retry). **No** INSERT/UPDATE/DELETE, DDL, constraints, ledger, RBAC, or network mutation. Verifier does **not** re-run live. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14m-phase-d-live-readonly-counts
npm run verify:sunset-schema-slice14m
# default refuse (zero Clients):
npm run phase-d:live-readonly-count-only
```

Artifacts: `slice14m-phase-d-live-readonly-counts-contract.json`, `slice14m-phase-d-live-readonly-counts-evidence.json`, `slice14m-findings.md`.

### Slice 14N — Lunabox PostgreSQL firewall rule (AllowLunaboxEgress)

Declares standalone Bicep `lunabox-pg-firewall-rule.bicep` (existing server reference only — **not** wired into `main.bicep`) and applies exactly **one** ARM REST PUT for rule **`AllowLunaboxEgress`** with start=end=**`20.238.124.76`** (Lunabox proven outbound IPv4). Requires dual outbound-IP HTTPS echoes equal to the locked address before any mutation; captures Cost Management Actual+Amortized RG snapshots before/after via managed-identity ARM REST (safe totals/currency/date only; firewall rule has no expected direct charge). Polls only the exact rule GET to terminal state (bounded). Verifies server remains Ready, `publicNetworkAccess` unchanged, existing two CAE/App rules byte-semantically unchanged, plus exact third rule. **No** PostgreSQL client/query, KV/RBAC/identity change, DDL/migration/ledger, delete/broaden/retry, ranges/`0.0.0.0`/Azure-services/IPv6, or full `main.bicep` deploy. Default/wrong env+argv → zero mutation.

```bash
# Offline RED/GREEN only (default; zero live HTTP/mutation):
npm run prove:sunset-schema-slice14n-lunabox-pg-firewall
npm run verify:sunset-schema-slice14n
# Live ARM PUT requires explicit --live (do not re-run after historical capture):
# node scripts/prove-sunset-schema-slice14n-lunabox-pg-firewall.js --live
# default refuse (zero ARM mutation):
npm run phase-d:lunabox-pg-firewall-apply
```

Artifacts: `slice14n-lunabox-pg-firewall-contract.json`, `slice14n-lunabox-pg-firewall-evidence.json`, `slice14n-findings.md`.

### Slice 14O — Post-firewall Phase D live read-only counts

Exactly **one** post-firewall live read-only Phase D count via the merged **14D/14E** managed-identity count-only CLI, after offline RED/GREEN, live firewall prestate (server Ready + `publicNetworkAccess` Enabled + exact three rules including **`AllowLunaboxEgress` `20.238.124.76/32`** + dual outbound IPv4 HTTPS echoes equal to the rule IP), and one metadata-only credential-preflight requiring exact host/database/`sslmode=verify-full`. Sequence then: one `pg` Client with `application_name=wh-sunset-phase-d-preflight` → `BEGIN READ ONLY` → verify `transaction_read_only` → locked catalog checks → exact 14A aggregate (`total_rows` / `date_window_violations` / `price_unit_violations`) → `COMMIT`/`ROLLBACK` → end. Output: safe counts/target identifiers/call counters only. On IMDS/KV/TLS/firewall/auth/query error: existing secret-free classifier, sanitize, stop (no retry). **No** INSERT/UPDATE/DELETE, DDL, constraints, ledger, RBAC, Azure/KV/network mutation. Verifier does **not** re-run live. Still `product_schema_differs`. Canonical hashes **byte-identical**.

```bash
# Offline RED/GREEN only (default; preserves historical live evidence):
npm run prove:sunset-schema-slice14o-post-firewall-phase-d-counts
npm run verify:sunset-schema-slice14o
# Live capture (exactly once; do not re-run after historical evidence):
# node scripts/prove-sunset-schema-slice14o-post-firewall-phase-d-counts.js --live
# default refuse (zero Clients):
npm run phase-d:live-readonly-count-only
```

Artifacts: `slice14o-post-firewall-phase-d-counts-contract.json`, `slice14o-post-firewall-phase-d-counts-evidence.json`, `slice14o-findings.md`.

### Slice 14P — Apply Phase D CHECK constraints

Offline RED/GREEN gates, then (with `--live` once) post-firewall prestate → credential preflight → exactly **one** gated managed-identity transaction applying the two missing canonical migration-028 CHECK constraints on `public.tenant_services`: **`tenant_services_date_window`** and **`tenant_services_price_unit`**. Statements are byte-locked to 028; zero-count aggregate preflight must pass before `ADD CONSTRAINT`. Sequence: advisory lock → catalog checks → aggregate (all zeros) → two `ADD CONSTRAINT` → catalog verify → `COMMIT`. Then canonical observer read-only compare against `expected-product-schema.json` (`azure_flexible_server_v1` normalization). **No** DML, ledger write, migration file change, or Azure/RBAC/network/KV mutation beyond the existing MI credential GET. Verifier does **not** re-run live apply or observer.

```bash
# Offline RED/GREEN only (default; preserves historical live evidence when present):
npm run prove:sunset-schema-slice14p-apply-phase-d-constraints
npm run verify:sunset-schema-slice14p
# Live capture (exactly once; do not re-run after historical evidence):
# node scripts/prove-sunset-schema-slice14p-apply-phase-d-constraints.js --live
# default refuse (zero pg Clients):
npm run phase-d:constraint-apply
```

Artifacts: `slice14p-apply-phase-d-constraints-contract.json`, `slice14p-apply-phase-d-constraints-evidence.json`, `slice14p-findings.md`.

### Slice 14Q — Active Staff API ↔ Key Vault DB target authority

Offline RED/GREEN gates, then (with `--live` once) one gated read-only proof that the active Sunset-staging Staff API Container App (`luna-sunset-staging-staff-api`) and the Key Vault admin secret (`luna-sunset-staging-kv` / `sunset-database-url`) resolve to the **same exact** PostgreSQL server/database/credential authority. Sequence: IMDS ARM token → ARM GET container app (active revision + DB env `secretRef`) → optional `listSecrets` POST (values zeroed) → IMDS vault token + KV GET → in-memory semantic DSN / Key Vault URL compare → one TLS `verify-full` `BEGIN READ ONLY` session (`application_name=wh-sunset-target-authority`) for schema inventory, ledger summary, and canonical observer compare. Drift is classified (`wrong_target` / `genuinely_sparse_active_runtime_db` / `observation_defect` / `schema_divergence` / `observer_match`) to choose a safe reconciliation path. **Zero mutation:** no DDL/DML/ledger/KV write/Azure/RBAC/network. Verifier does **not** re-run live.

```bash
# Offline RED/GREEN only (default; preserves historical live evidence when present):
npm run prove:sunset-schema-slice14q-active-db-target-authority
npm run verify:sunset-schema-slice14q
# Live capture (exactly once; do not re-run after historical evidence):
# node scripts/prove-sunset-schema-slice14q-active-db-target-authority.js --live
# default refuse (zero ARM / zero KV / zero pg Clients):
npm run phase-d:active-db-target-authority
```

Artifacts: `slice14q-active-db-target-authority-contract.json`, `slice14q-active-db-target-authority-evidence.json`, `slice14q-findings.md`.

### Slice 14U — Residual drift classify + preflight (implemented)

Read-only classify + preflight of the exact **35** residual drifts remaining after Slice **14T** NOT NULL observer normalization (`azure_flexible_server_v1`). Merged target-authority proof + one TLS `verify-full` `BEGIN READ ONLY` session with `application_name=wh-sunset-residual-drift-preflight`. Baseline gate requires mismatchCount === 35 with sections constraints=25, indexes=5, functions=1, triggers=1, ownership=1, acls=1, extensions=1 (stop with `baseline_drift_mismatch` otherwise). Builds secret-free canonical key inventory + migration ownership; runs safe aggregates (null/duplicate/orphan/violation counts; index column support + COUNT(*)); plans deterministic mutation batches with **`execute:false` always**. **Zero mutation.** Do **not** invent/carry forward the historical 448 NOT NULL normalized count as residual inventory. Default-disabled behind dual Phase D flags + `SUNSET_PHASE_D_TARGET_AUTHORITY=1` + `SUNSET_PHASE_D_RESIDUAL_DRIFT_PREFLIGHT=1` + managed-identity + exact locked targets. Verifier does **not** re-run live. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14u-residual-drift-preflight
npm run verify:sunset-schema-slice14u
# default refuse (zero Clients):
npm run phase-d:residual-drift-preflight
# offline-only (preserve prior liveOutcome if present):
node scripts/prove-sunset-schema-slice14u-residual-drift-preflight.js --offline-only
```

Artifacts: `slice14u-residual-drift-preflight-contract.json`, `slice14u-residual-drift-preflight-evidence.json`, `slice14u-findings.md`.

### Slice 14V — hostel_id→client_id rename-alias normalization (implemented)

Read-only observer normalization for migration **003** `{table}_hostel_id_not_null` / `NOT NULL client_id` name aliases (15 provenance tables; hash-locked). Merged target-authority proof + one TLS `verify-full` `BEGIN READ ONLY` session with `application_name=wh-sunset-rename-alias-normalization`. Baseline (identity + 14T; rename alias off) must be mismatchCount === **35** (sections as 14U) or stop with `baseline_drift_mismatch`. Then applies rename-alias normalization under `azure_flexible_server_v1` + `postgresql_15` and reports aliases normalized + remaining key inventory (accounting: baseline = aliases + remaining). Does **not** broaden 14T `parseCanonicalNotNullConstraint`. Soft-skips when PG15 versionClass absent. **Zero mutation.** Default-disabled behind dual Phase D flags + `SUNSET_PHASE_D_TARGET_AUTHORITY=1` + `SUNSET_PHASE_D_RENAME_ALIAS_NORMALIZATION=1` + managed-identity + exact locked targets. Verifier does **not** re-run live. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14v-rename-alias-normalization
npm run verify:sunset-schema-slice14v
# default refuse (zero Clients):
npm run phase-d:rename-alias-normalization
# offline-only (preserve prior liveOutcome if present):
node scripts/prove-sunset-schema-slice14v-rename-alias-normalization.js --offline
```

Artifacts: `slice14v-rename-alias-normalization-contract.json`, `slice14v-rename-alias-normalization-evidence.json`, `slice14v-findings.md`.

### Slice 14W — final NOT NULL rename-provenance normalization (implemented)

Read-only observer normalization for exact rename-provenance NOT NULL legacy-name residuals from migrations **002/003/004** (byte/hash-locked tuples). Extends — does not weaken — 14T exact-name or 14V hostel_id alias rules. Default **OFF** in compare (14V inventory stable). Merged target-authority + one TLS `verify-full` session `application_name=wh-sunset-final-rename-normalization`. Baseline (identity + 14T + 14V; final rename off) must be mismatchCount === **23** or `baseline_drift_mismatch`. Reports normalized count + remaining keys (accounting: baseline = normalized + remaining; do not force final count). Covers: 003 `hostels→clients` (`clients.hostels_<col>_not_null`, nine approved columns), 002 `price_per_person_per_night_cents→price_per_person_per_week_cents`, 004 `kind→payment_kind` + `amount_cents→amount_due_cents`. Truncated names / wrong defs / unapproved columns / old+new coexistence retain. **Zero mutation.** Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14w-final-rename-normalization
npm run verify:sunset-schema-slice14w
npm run phase-d:final-rename-normalization
node scripts/prove-sunset-schema-slice14w-final-rename-normalization.js --offline
```

Artifacts: `slice14w-final-rename-normalization-contract.json`, `slice14w-final-rename-normalization-evidence.json`, `slice14w-findings.md`.

### Slice 14X — NOT NULL identifier truncation normalization (implemented)

Read-only observer normalization for exactly **one** PostgreSQL auto-generated NOT NULL identifier truncation artifact from migration **002** (byte/hash-locked). Extends — does not weaken — 14T/14V/14W. Default **OFF** in compare. Locked tuple: `package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null` (exact 63-byte NAMEDATALEN name), type=`n`, definition=`NOT NULL double_supplement_per_person_per_night_cents`, column nullable=NO. Derives name via label-preserving `makeObjectName` truncation; rejects naive truncations / near-collisions / fuzzy prefixes. Merged target-authority + one TLS `verify-full` session `application_name=wh-sunset-identifier-truncation-normalization`. Baseline (identity + 14T + 14V + 14W; truncation off) must be mismatchCount === **12** with sections constraints=2,indexes=5,functions=1,triggers=1,ownership=1,acls=1,extensions=1 or `baseline_drift_mismatch`. Reports normalized count + remaining keys (accounting: baseline = normalized + remaining). **Zero mutation.** Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14x-identifier-truncation-normalization
npm run verify:sunset-schema-slice14x
npm run phase-d:identifier-truncation-normalization
node scripts/prove-sunset-schema-slice14x-identifier-truncation-normalization.js --offline
```

Artifacts: `slice14x-identifier-truncation-normalization-contract.json`, `slice14x-identifier-truncation-normalization-evidence.json`, `slice14x-findings.md`.

### Slice 14Y — apply five residual indexes (implemented)

Applies exactly the five missing canonical residual indexes from the post-14X inventory (byte/semantic-locked CREATE INDEX from expected-product-schema; owners 026/032/035 hash-locked). Default-disabled managed-identity apply. Preflight requires same target/TLS/PG15 and normalized baseline mismatchCount === **11** (sections indexes=5,constraints=1,triggers=1,functions=1,ownership=1,acls=1,extensions=1). One TLS `verify-full` session `application_name=wh-sunset-five-index-apply`: BEGIN → lock/statement/idle timeouts → advisory lock → recheck tables/columns/absence/no semantic duplicate/no incompatible name/approved row bounds → five regular CREATE INDEX (no CONCURRENTLY) in migration-dependency order → verify `pg_get_indexdef` + valid/ready → row counts unchanged → COMMIT (ROLLBACK on any error; no retry). Post-apply observer must reduce by exactly **five**; do **not** claim zero drift. No FK/trigger/function/extension/ownership/ACL/ledger/KV/RBAC/network/deploy; no DROP/ALTER; no migration change. Verifier does **not** re-run live. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14y-five-index-apply
npm run verify:sunset-schema-slice14y
npm run phase-d:five-index-apply
node scripts/prove-sunset-schema-slice14y-five-index-apply.js --offline
# live (default-disabled; gated):
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_FIVE_INDEX_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 node scripts/prove-sunset-schema-slice14y-five-index-apply.js --live --prove-active-db-target-authority --apply-five-indexes --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

Artifacts: `slice14y-five-index-apply-contract.json`, `slice14y-five-index-apply-evidence.json`, `slice14y-findings.md`.

### Slice 14Z — apply tenant_surf_pack_rules_updated_by_fkey (implemented)

Applies exactly the one missing canonical residual FK from the post-14Y inventory (byte-locked `FOREIGN KEY (updated_by) REFERENCES staff_users(id) ON DELETE SET NULL`; owner `026_tenant_surf_pack_rules` hash-locked). Default-disabled managed-identity apply. Preflight requires same target/TLS/PG15 and normalized baseline mismatchCount === **6** (sections constraints=1,triggers=1,functions=1,ownership=1,acls=1,extensions=1). One TLS `verify-full` session `application_name=wh-sunset-surf-pack-fk-apply`: BEGIN → lock/statement/idle timeouts → advisory lock WHPZ/SPFK (0x5748505A / 0x5350464B) → recheck tables/columns/type-compat (uuid) / FK absence / no semantic duplicate / no incompatible same-name / orphan_count=0 (NULL updated_by not orphan) → ADD CONSTRAINT NOT VALID → verify condef + convalidated=false → VALIDATE CONSTRAINT → verify convalidated=true → row counts unchanged → COMMIT (ROLLBACK on any error; no retry). Post-apply observer must reduce by exactly **one**; do **not** claim zero drift. No index/trigger/function/extension/ownership/ACL/ledger/KV/RBAC/network/deploy; no DROP/DML; no migration change. Verifier does **not** re-run live. Canonical hashes **byte-identical**.

```bash
npm run prove:sunset-schema-slice14z-surf-pack-fk-apply
npm run verify:sunset-schema-slice14z
npm run phase-d:surf-pack-fk-apply
node scripts/prove-sunset-schema-slice14z-surf-pack-fk-apply.js --offline
# live (default-disabled; gated):
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_SURF_PACK_FK_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 node scripts/prove-sunset-schema-slice14z-surf-pack-fk-apply.js --live --prove-active-db-target-authority --apply-surf-pack-fk --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

Artifacts: `slice14z-surf-pack-fk-apply-contract.json`, `slice14z-surf-pack-fk-apply-evidence.json`, `slice14z-findings.md`.

### Slice 14AA — apply tenant_surf_pack_rules_updated_at (implemented)

Applies exactly the one missing canonical residual trigger from the post-14Z inventory (byte-locked `CREATE TRIGGER tenant_surf_pack_rules_updated_at BEFORE UPDATE ON public.tenant_surf_pack_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at()`; owner `026_tenant_surf_pack_rules` hash-locked). Default-disabled managed-identity apply. Preflight requires same target/TLS/PG15 and normalized baseline mismatchCount === **5** (sections triggers=1,functions=1,ownership=1,acls=1,extensions=1). One TLS `verify-full` session `application_name=wh-sunset-surf-pack-trigger-apply`: BEGIN → lock/statement/idle timeouts → advisory lock WHPA/SPTG (0x57485041 / 0x53505447) → recheck table/columns / prior FK+index prestate / `set_updated_at()` contract / trigger absence / no semantic duplicate / no incompatible same-name → CREATE TRIGGER → verify trigger attrs → row counts unchanged → COMMIT (ROLLBACK on any error; no retry). Post-apply observer must reduce by exactly **one**; do **not** claim zero drift. No FK/index/function mutation/extension/ownership/ACL/ledger/KV/RBAC/network/deploy; no DROP/DML; no migration change. Verifier does **not** re-run live.

```bash
npm run prove:sunset-schema-slice14aa-surf-pack-trigger-apply
npm run verify:sunset-schema-slice14aa
npm run phase-d:surf-pack-trigger-apply
node scripts/prove-sunset-schema-slice14aa-surf-pack-trigger-apply.js --offline
# live (default-disabled; gated):
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_SURF_PACK_TRIGGER_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 node scripts/prove-sunset-schema-slice14aa-surf-pack-trigger-apply.js --live --prove-active-db-target-authority --apply-surf-pack-trigger --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

Artifacts: `slice14aa-surf-pack-trigger-apply-contract.json`, `slice14aa-surf-pack-trigger-apply-evidence.json`, `slice14aa-findings.md`.

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
*FOUNDATION Slice 11 — execute manual schema-observer job; canonical-vs-live drift unresolved (exit 4 / 88 mismatches); live blessing forbidden; follow-up image repair required — 2026-07-19*
*FOUNDATION Slice 12 — repair observer job image from canonical master; live observe exit 4; DB drift unresolved; FOUNDATION blocked — 2026-07-19*
*FOUNDATION Slice 13A — classify 88 mismatches + 36-migration provenance (investigation only; no repair/live mutation) — 2026-07-19*
*FOUNDATION Slice 13A.1 — canonical_lf_v1 migration checksums (EOL-invariant; DEC-007 resolved) — 2026-07-19*
*FOUNDATION Slice 13B — approved-direction reconciliation design (design only; no repair/live mutation) — 2026-07-19*
*FOUNDATION Slice 13C.1 — azure_flexible_server_v1 observer identity normalization (88→46; no live mutation) — 2026-07-19*
*FOUNDATION Slice 13C.2 — promote location-aware admin model via 039 (46→29; disposable proof only; no live mutation) — 2026-07-19*
*FOUNDATION Slice 13C.3a — promote tenant_services SaaS catalog columns via 040 (29→25; disposable proof only; no live mutation) — 2026-07-19*
*FOUNDATION Slice 13C.3b — rehearse existing migration 035 CMT (25→8; disposable proof only; no live mutation; no new forward migration) — 2026-07-19*
*FOUNDATION Slice 13C.3c — converge notification/surf-pack via 041 (8→2; disposable proof only; no live mutation) — 2026-07-19*
*FOUNDATION Slice 13C.3d — integrated Phase C disposable proof 040→035→041 (29→2; no new forward migration; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14A — Phase D CHECK aggregate preflight (source-only; disposable proof; no constraint apply; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14B — Phase D live read-only connection boundary (gates only; CONNECT_ENABLED activated in 14D; offline injected-adapter proof; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14C — Phase D live read-only PostgreSQL adapter (activated gated in 14D; offline fake-Client proof; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14D — Phase D live read-only activation + gated count-only CLI (default-disabled; offline injected-Client proof; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14E — Phase D managed-identity credential loader (live HTTP hard-disabled; offline injected-HTTP proof; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14F — Phase D credential-preflight activation (metadata-only; offline injected-HTTP proof; no pg Client; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14G — Phase D live metadata-only credential preflight (gated real IMDS+KV GET; no pg Client; no live mutation) — 2026-07-19*
*FOUNDATION Slice 14H — Key Vault Secrets User RBAC apply-plan for Lunabox wh-staging-identity (plan-only; offline prove; zero Azure mutation) — 2026-07-19*
*FOUNDATION Slice 14J — Key Vault DSN sslmode=verify-full normalize plan (plan-only; offline injected-HTTP proof; zero live KV mutation) — 2026-07-19*
*FOUNDATION Slice 14K — Key Vault DSN sslmode=verify-full apply activation (gated CLI; locked live HTTP transport; offline injected proof; zero live IMDS/KV/PG) — 2026-07-19*
*FOUNDATION Slice 14M — Phase D live read-only counts via managed-identity (offline RED/GREEN + credential preflight + one live count; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14N — Lunabox AllowLunaboxEgress firewall rule on luna-sunset-staging-pg-app (standalone Bicep + one gated ARM PUT; zero PostgreSQL) — 2026-07-19*
*FOUNDATION Slice 14O — Post-firewall Phase D live read-only counts (firewall prestate + credential preflight + one gated count; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14P — Apply Phase D CHECK constraints (offline gates + gated live apply + observer read-only; schema mutation only) — 2026-07-19*
*FOUNDATION Slice 14Q — Active Staff API ↔ Key Vault DB target authority (read-only proof + drift classification; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14R — Live reconcile decision (occupancy + drift; A–G design-only phases incl. NOT NULL + non-table ownership; clean rebuild vs in-place; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14S — Phase B additive reconcile (CREATE TABLE customer_message_templates from byte-locked 035; no INDEX/COMMENT; gated live apply) — 2026-07-19*
*FOUNDATION Slice 14T — NOT NULL observer representation normalization (constraint↔attnotnull; 483→35; 448 normalized; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14U — Residual drift classify + preflight (exact 35; read-only aggregates; execute:false batches; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14V — hostel_id→client_id rename-alias normalization (migration 003; 12 aliases; PG15; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14W — final NOT NULL rename-provenance normalization (002/003/004 tuples; baseline 23; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14X — NOT NULL identifier truncation normalization (one NAMEDATALEN tuple; baseline 12; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14Y — apply five residual indexes (baseline 11→6; schema mutation only; zero data/ledger) — 2026-07-19*
*FOUNDATION Slice 14Z — apply tenant_surf_pack_rules_updated_by_fkey (baseline 6→5; schema mutation only; zero data/ledger) — 2026-07-19*
*FOUNDATION Slice 14AA — apply tenant_surf_pack_rules_updated_at (baseline 5→4; schema mutation only; zero data/ledger) — 2026-07-19*
*FOUNDATION Slice 14AB — Azure PG15 pgcrypto compatibility normalization (baseline 4→0; presentation only; zero mutation) — 2026-07-19*
*FOUNDATION Slice 14AC — ledger bootstrap eligibility matrix (39 forwards; 020 tenant-scoped vacuous DML eligible; prefix may reach 39; design-only ledger DDL; zero mutation) — 2026-07-20*
