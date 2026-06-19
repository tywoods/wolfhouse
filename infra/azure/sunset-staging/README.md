# Sunset Isolated Staging — Azure Bicep Runbook (REVIEW ONLY)

> **Status: DRAFT — DO NOT RUN `az deployment` until Captain signs the infra-creation checkbox in `docs/sunset/SUNSET-PORTAL-SLICE-1-STAGING-APPROVAL-PACKET.md`.**
>
> Parent plan: [`docs/sunset/SUNSET-PORTAL-SLICE-1-INFRA-BUILD-PLAN.md`](../../../docs/sunset/SUNSET-PORTAL-SLICE-1-INFRA-BUILD-PLAN.md)

---

## Files

| File | Purpose |
|------|---------|
| `main.bicep` | Sunset-only staging resources (Staff API + DB + KV + identity) |
| `acr-pull-role.bicep` | Cross-RG module: `AcrPull` on `whstagingacr` for Sunset identity |
| `parameters.example.json` | Example values — **no secrets** |
| `README.md` | This runbook |

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
- **Default tag:** `25518554bcf635b59c594dae8f930c0190609209`
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
4. **Future:** Dedicated ACR (Option B) or Azure Container Registry **token** scoped to `luna-sunset-staff-api` repository (manual/token pipeline — not in this Bicep draft)

---

## Identity / RBAC (encoded)

| Principal | Role | Scope | Notes |
|-----------|------|-------|-------|
| `luna-sunset-staging-identity` | Key Vault Secrets User (`4633458b-…`) | `luna-sunset-staging-kv` | get/list secrets only |
| `luna-sunset-staging-identity` | AcrPull (`7f951dda-…`) | `whstagingacr` | pull only; no push |
| — | — | `wh-staging-kv` | **No assignment** |
| — | — | `wh-staging-staff-api` | **No assignment** |
| — | — | `wh-staging-pg-app` | **No assignment** |

Container App uses user-assigned identity for Key Vault secret refs and ACR pull.

---

## Postgres networking (encoded)

| Setting | Value |
|---------|-------|
| SKU | `Standard_B1ms` (Burstable) |
| Server | `luna-sunset-staging-pg-app` |
| Database | `sunset_staging` |
| `publicNetworkAccess` | `Enabled` |
| `0.0.0.0` firewall rule | **Not created** |
| Initial firewall rules | Empty (`postgresAllowedIpAddresses: []`) |

**Post-deploy:** Container Apps egress IPs are not known until `luna-sunset-staging-env` exists. After CAE creation:

```bash
# PROPOSED ONLY — discover outbound IPs, then re-deploy or add rules via CLI
az containerapp env show \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-env \
  --query properties.staticIp -o tsv

# Add each IP to postgresAllowedIpAddresses and redeploy, OR:
az postgres flexible-server firewall-rule create \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-pg-app \
  --rule-name AllowSunsetStagingEgress0 \
  --start-ip-address <CAE_EGRESS_IP> \
  --end-ip-address <CAE_EGRESS_IP>
```

**Private Endpoint / VNet integration:** Not in Slice 1 Bicep. If Captain requires no public Postgres endpoint, add CAE VNet integration + private DNS in a follow-up template revision.

**Wolfhouse DB:** Never referenced. Admin user default `sunsetadmin` (not `whadmin`).

---

## Secrets (Key Vault — manual post-KV creation)

Secrets are **not** created by Bicep. Populate via CLI after KV exists:

```bash
# PROPOSED ONLY — placeholders; never commit real values
az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name sunset-database-url \
  --value "postgres://sunsetadmin:<DB_PASSWORD>@luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging?sslmode=require"

az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name staff-session-secret \
  --value "<RANDOM_SESSION_SECRET>"

# Stripe: sk_test_* ONLY for staging — never sk_live_*
az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name stripe-secret-key \
  --value "sk_test_<PLACEHOLDER>"

az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name stripe-webhook-secret \
  --value "whsec_<PLACEHOLDER>"

# WhatsApp: dry-run enforced; placeholder token acceptable
az keyvault secret set --vault-name luna-sunset-staging-kv \
  --name meta-whatsapp-token \
  --value "EAAG_PLACEHOLDER_DRY_RUN_ONLY"
```

**App env mapping:** KV secret `sunset-database-url` → env `WOLFHOUSE_DATABASE_URL` (generic PG env name in Staff API code; **value** must be Sunset DB only).

---

## Safety flags (hardcoded in Bicep — not overridable)

| Variable | Value |
|----------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `STAFF_ACTIONS_ENABLED` | `false` |
| `STAFF_AUTH_REQUIRED` | `true` |
| `STRIPE_WEBHOOK_SKIP_VERIFY` | `false` |

---

## Portal access (least privilege — image build, not Bicep)

Sunset isolated staging must **not** rely on `all_clients_emails`. At image build time (separate deploy checkbox), configure `config/clients/staff-portal-access.json` with **Sunset-only** `client_access` for the owner demo user:

```json
{
  "users": [
    {
      "email": "<OWNER_DEMO_EMAIL>",
      "client_access": ["sunset"]
    }
  ]
}
```

No real passwords or session secrets in the git repo. Seed staff users after migrations (manual step).

---

## Migration-015 gap (required before DB use)

**This IaC does not run migrations.**

Before applying migrations to fresh `sunset_staging`, resolve the **migration-015 gap** documented in `docs/sunset/VERIFY-LUNA-GOLDEN-DB-NOTE.md`. Captain must approve DB creation checkbox before any migration run against `luna-sunset-staging-pg-app`.

---

## Cost attribution tags

All resources tagged:

| Tag | Example |
|-----|---------|
| `product` | `Luna Front Desk` |
| `tenant` | `sunset` |
| `environment` | `staging` |
| `owner` | `<FILL_ME_OWNER>` (parameter) |
| `slice` | `portal-1` |

Not billed as Wolfhouse (`tenant=sunset`).

---

## Deployment phases (proposed — not executed)

### Phase A — Preflight (safe)

```bash
# Verify RG name before any command
TARGET_RG=luna-sunset-staging-rg
test "$TARGET_RG" = "luna-sunset-staging-rg"

# Optional: compile Bicep locally
az bicep build --file infra/azure/sunset-staging/main.bicep
```

### Phase B — Create resource group (checkbox #1)

```bash
# PROPOSED ONLY
az group create \
  --name luna-sunset-staging-rg \
  --location westeurope \
  --tags product="Luna Front Desk" tenant=sunset environment=staging
```

### Phase C — What-if (safe — no changes)

```bash
# PROPOSED ONLY
az deployment group what-if \
  --resource-group luna-sunset-staging-rg \
  --template-file infra/azure/sunset-staging/main.bicep \
  --parameters @infra/azure/sunset-staging/parameters.example.json \
  --parameters postgresAdminPassword="<PLACEHOLDER_FOR_WHATIF_ONLY>"
```

### Phase D — Deploy base infra (checkbox #1 — approval required)

```bash
# PROPOSED ONLY — deployContainerApps=false by default
az deployment group create \
  --resource-group luna-sunset-staging-rg \
  --template-file infra/azure/sunset-staging/main.bicep \
  --parameters @infra/azure/sunset-staging/parameters.example.json \
  --parameters postgresAdminPassword="<STRONG_PASSWORD>" \
  --name "luna-sunset-staging-infra-YYYYMMDD"
```

### Phase E — Key Vault secrets (manual)

See §Secrets above.

### Phase F — Build image (checkbox #2)

```bash
# PROPOSED ONLY — dedicated repo only
az acr build --registry whstagingacr \
  --image luna-sunset-staff-api:25518554bcf635b59c594dae8f930c0190609209 \
  --file Dockerfile .
```

### Phase G — Postgres firewall + redeploy Staff API (checkbox #2/#4)

1. Add CAE egress IPs to `postgresAllowedIpAddresses`
2. Redeploy with `deployContainerApps=true` and `deployStaffApi=true`

### Phase H — DNS (checkbox #3)

CNAME `sunset-staging.lunafrontdesk.com` → `luna-sunset-staging-staff-api` ingress FQDN; bind managed cert.

---

## Rollback (Sunset only)

```bash
# PROPOSED ONLY — disable traffic
az containerapp ingress disable \
  --resource-group luna-sunset-staging-rg \
  --name luna-sunset-staging-staff-api

# PROPOSED ONLY — delete Sunset RG (destructive)
az group delete --name luna-sunset-staging-rg --yes --no-wait
```

**Never** delete or modify `wh-staging-rg` resources for Sunset rollback.

---

## Bicep validation

```bash
az bicep build --file infra/azure/sunset-staging/main.bicep
```

If `az bicep` is unavailable, perform static review of `main.bicep` + `parameters.example.json` only.

---

*Draft version: 1.0 — 2026-06-19 — review only, no resources created*
