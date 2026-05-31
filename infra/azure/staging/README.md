# Wolfhouse Staging — Azure Deployment Runbook

> **⛔ DO NOT RUN any `az deployment` command until all go/no-go gates in [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](../../../docs/PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) sections A, B, and C are recorded PASS with evidence and sign-off.**
>
> Current status: **NOT_STARTED — deployment blocked.**

---

## Files

| File | Purpose |
|---|---|
| `main.bicep` | Bicep template — all staging resources |
| `parameters.example.json` | Example parameter values (no secrets) |
| `README.md` | This runbook |

---

## Prerequisites (complete before any deployment)

### 1. Azure CLI setup
```bash
# Install Azure CLI if not present: https://docs.microsoft.com/cli/azure/install-azure-cli
az --version

# Login
az login

# Select the correct subscription
az account set --subscription "<SUBSCRIPTION_ID_PLACEHOLDER>"

# Confirm
az account show
```

### 2. Resource group
```bash
# Create the staging resource group (safe to run before full deploy)
az group create \
  --name wh-staging-rg \
  --location westeurope
```

### 3. Key Vault secrets (MUST be set before deploy)
The following secrets must be created in Key Vault before the Bicep deployment runs Container Apps. Key Vault itself is created by the Bicep template, but secrets are populated separately to avoid them appearing in deployment history.

```bash
# Set after Key Vault is created (first create KV manually or run partial deploy)
# Replace ALL placeholder values — never use real sk_live_* keys in staging

az keyvault secret set --vault-name wh-staging-kv --name wolfhouse-database-url \
  --value "postgres://whadmin:<DB_PASSWORD>@wh-staging-pg-app.postgres.database.azure.com:5432/wolfhouse_staging?sslmode=require"

az keyvault secret set --vault-name wh-staging-kv --name n8n-database-url \
  --value "postgres://whadmin:<DB_PASSWORD>@wh-staging-pg-n8n.postgres.database.azure.com:5432/n8n_staging?sslmode=require"

az keyvault secret set --vault-name wh-staging-kv --name n8n-encryption-key \
  --value "<RANDOM_32_CHAR_MIN_UNIQUE_KEY>"

az keyvault secret set --vault-name wh-staging-kv --name redis-connection-string \
  --value "rediss://:<ACCESS_KEY>@wh-staging-redis.redis.cache.windows.net:6380"

# Stripe: MUST be sk_test_* — never sk_live_* in staging
az keyvault secret set --vault-name wh-staging-kv --name stripe-secret-key \
  --value "sk_test_<PLACEHOLDER>"

az keyvault secret set --vault-name wh-staging-kv --name stripe-webhook-secret \
  --value "whsec_<PLACEHOLDER>"

# WhatsApp — dry-run is enforced; token is loaded but WHATSAPP_DRY_RUN=true prevents sends
az keyvault secret set --vault-name wh-staging-kv --name meta-whatsapp-token \
  --value "EAAG_PLACEHOLDER_DO_NOT_USE_REAL_TOKEN_IN_STAGING"

az keyvault secret set --vault-name wh-staging-kv --name meta-whatsapp-phone-id \
  --value "<PHONE_ID_PLACEHOLDER>"

az keyvault secret set --vault-name wh-staging-kv --name wolfhouse-airtable-token \
  --value "pat<PLACEHOLDER>"

az keyvault secret set --vault-name wh-staging-kv --name n8n-webhook-shared-secret \
  --value "<RANDOM_WEBHOOK_SECRET>"

az keyvault secret set --vault-name wh-staging-kv --name staff-session-secret \
  --value "<RANDOM_SESSION_SECRET>"
```

### 4. Postgres DB passwords (Bicep limitation)
Bicep cannot take Postgres admin passwords as Key Vault refs in `administratorLoginPassword` — they must be passed as a secure parameter at deploy time:

```bash
# Generate a strong password and store it in Key Vault BEFORE deploying
az keyvault secret set --vault-name wh-staging-kv --name wolfhouse-db-admin-password \
  --value "<STRONG_RANDOM_PASSWORD>"

az keyvault secret set --vault-name wh-staging-kv --name n8n-db-admin-password \
  --value "<STRONG_RANDOM_PASSWORD>"
```

### 5. Database migrations (AFTER Postgres is created)
After Postgres is provisioned and before first use:
```bash
# Apply all migrations (001–009) to staging DB
# Use local scripts with WOLFHOUSE_DATABASE_URL pointed at staging (with appropriate firewall rules)
npm run db:migrate:staging   # if script exists, or run each migration manually
```

---

## Dry-run / what-if (SAFE — reads only, no changes)

```bash
# Show what WOULD be created — no resources touched
az deployment group what-if \
  --resource-group wh-staging-rg \
  --template-file infra/azure/staging/main.bicep \
  --parameters @infra/azure/staging/parameters.example.json \
  --parameters postgresAdminLoginPassword="$(az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-db-admin-password --query value -o tsv)"
```

---

## Deploy command — ⛔ DO NOT RUN WITHOUT APPROVAL

> This command creates real Azure resources that incur cost. Run ONLY after all go/no-go gates pass.

```bash
# APPROVAL REQUIRED — do not run until PHASE-7.6 gates A, B, C are PASS
az deployment group create \
  --resource-group wh-staging-rg \
  --template-file infra/azure/staging/main.bicep \
  --parameters @infra/azure/staging/parameters.example.json \
  --parameters postgresAdminLoginPassword="$(az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-db-admin-password --query value -o tsv)" \
  --name wh-staging-deploy-$(date +%Y%m%d%H%M)
```

---

## Post-deploy verification checklist

After a successful deployment, verify each item before declaring staging ready:

- [ ] `GET https://<staff-api-fqdn>/healthz` returns `{ "status": "ok", "auth_enabled": true }`
- [ ] `GET https://<staff-api-fqdn>/staff/intents` returns 401 (auth required)
- [ ] `POST https://<staff-api-fqdn>/staff/auth/login` succeeds with seeded staff user
- [ ] `GET https://<staff-api-fqdn>/staff/ui` returns 200 after login
- [ ] n8n UI accessible at `https://<n8n-fqdn>` and **all workflows are inactive**
- [ ] No `WHATSAPP_DRY_RUN=false` in any Container App revision
- [ ] `STAFF_ACTIONS_ENABLED=false` confirmed in Container App environment variables
- [ ] Stripe key confirmed `sk_test_*` (never `sk_live_*`)
- [ ] Postgres backup confirmed enabled (Azure Portal → Backup settings)
- [ ] Staff API container logs visible in Log Analytics
- [ ] n8n worker logs visible in Log Analytics
- [ ] `STAFF_OPERATOR_TOKEN` is NOT set in staging (local/dev only)
- [ ] Run `scripts/verify-azure-staging-scaffold.js` static checks pass (this verifies the scaffold, not the live deployment)

---

## Rollback / teardown — ⛔ DESTRUCTIVE / APPROVAL REQUIRED

```bash
# Deletes ALL staging resources. Irreversible. Requires explicit owner approval.
# APPROVAL REQUIRED — do not run without explicit sign-off from Ty.
az group delete \
  --name wh-staging-rg \
  --yes
```

Soft rollback (roll back app revision without deleting resources):
```bash
az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg
az containerapp revision activate --revision <previous-revision-name> --resource-group wh-staging-rg
az containerapp ingress traffic set --name wh-staging-staff-api --resource-group wh-staging-rg \
  --revision-weight <previous-revision-name>=100
```

---

## Cost estimate (staging, idle)

| Resource | Approx idle cost |
|---|---|
| Container Apps (3 apps, min 1 replica) | ~€15–25/month |
| Postgres Flexible Server B1ms × 2 | ~€25–35/month |
| Redis Cache Basic C0 | ~€15/month |
| Key Vault | ~€1/month |
| Log Analytics (minimal ingestion) | ~€2–5/month |
| Container Registry Basic | ~€5/month |
| **Total estimate** | **~€63–86/month** |

Scale down or pause Postgres/Redis when not in active use.
