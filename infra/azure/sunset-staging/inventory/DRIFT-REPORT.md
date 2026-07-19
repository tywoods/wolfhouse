# Sunset staging — live-to-IaC drift baseline (FOUNDATION Slice 1)

**Status:** inventory only — do **not** “fix” Bicep from this slice.  
**Captured:** 2026-07-17 against master `186307418400581a74f86b096e02bc32a41513b6`  
**Scope:** `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` / tenant `sunset`

Compared to:

- `infra/azure/sunset-staging/main.bicep`
- `infra/azure/sunset-staging/acr-pull-role.bicep`
- `infra/azure/sunset-staging/parameters.example.json`
- `infra/azure/sunset-staging/README.md`

## Cost baseline (read-only)

| Field | Value |
|-------|-------|
| Type | ActualCost |
| Scope | `/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg` |
| Period | 2026-07-01 → 2026-07-17 (month-to-date) |
| Amount | **13.493559344086 USD** |

Recurring increase from this slice: **$0** (no Azure mutations).

## Live inventory count

**9** resources in `luna-sunset-staging-rg`.

## Drift table

| ID | Classification | Declared (IaC) | Live |
|----|----------------|----------------|------|
| identity | matches | `luna-sunset-staging-identity` | present, westeurope, expected tags |
| log-analytics | matches | PerGB2018 / 30d | same |
| app-insights | matches | web + workspace | same |
| key-vault | matches | standard / RBAC / soft-delete 7d | same |
| postgres-core | matches | B1ms / v15 / HA off / `sunset_staging` | same |
| cae | materially_drifted | `containerAppsLocation` ≈ westeurope (parameters.example) | **northeurope** |
| staff-api-app | materially_drifted | optional deploy flags false; minReplicas 0; `STAFF_ACTIONS_ENABLED=false`; image tag `2551855…`; transport `http` | deployed; **minReplicas=1**; **STAFF_ACTIONS_ENABLED=true**; image **`1863074…`**; transport **Auto**; missing `owner` tag; extra feature env flags |
| bicep-default-deploy-flags | materially_drifted | `deployContainerApps/deployStaffApi=false` | staff API live and serving |
| managed-certificate | live_but_unmanaged | Phase H / not in Bicep | managed cert for `sunset-staging.lunafrontdesk.com` |
| hold-expiry-job | live_but_unmanaged | not in Bicep | job `luna-sunset-staging-hold-expiry` cron `15 * * * *` |
| postgres-firewall-rules | live_but_unmanaged | example `postgresAllowedIpAddresses=[]`; standalone `lunabox-pg-firewall-rule.bicep` declares AllowLunaboxEgress | three egress allow rules present (CAE + App + Lunabox) |
| kv-secret-names | secret_manual_dependency | README secret names; values not in Bicep | 5 secret **names** only |
| app-inline-bot-token-secret | secret_manual_dependency | KV-backed secrets only | `luna-bot-internal-token` has no Key Vault URL |
| kv-operator-officer-role | secret_manual_dependency | identity = Secrets User only | human **Secrets Officer** also present |
| custom-domain-dns | secret_manual_dependency | DNS outside Bicep | custom domain bound; DNS zone not in this subscription |
| shared-acr | intentionally_shared_external_dependency | Option A `whstagingacr` + AcrPull | AcrPull on sunset identity confirmed |
| no-declared-absent-core | matches | core names when deploy flags true | no core declared-but-absent resource |

### Classification counts (fixture items)

| Classification | Count |
|----------------|------:|
| matches | 6 |
| live_but_unmanaged | 3 |
| declared_but_absent | 0 |
| materially_drifted | 3 |
| secret_manual_dependency | 4 |
| intentionally_shared_external_dependency | 1 |

## Safety notes

- Secret **values** were never exported; Key Vault inventory is **names only**.
- No Wolfhouse runtime targets (`wh-staging-staff-api`, `staff-staging.lunafrontdesk.com`, `wolfhouse_staging`, `wh-staff-api`) appear in live config.
- Shared ACR `whstagingacr` in `wh-staging-rg` is an intentional external dependency (Option A).

## Verifier

```bash
node scripts/verify-sunset-staging-live-iac-drift.js --self-test
node scripts/verify-sunset-staging-live-iac-drift.js
node scripts/verify-sunset-staging-iac-secret-scan.js
node scripts/verify-sunset-staging-iac-diff-check.js
```

Single sanitized baseline: `inventory/live-inventory.normalized.json`.  
Self-tests deep-clone that baseline in memory (no duplicated fixture copies).
