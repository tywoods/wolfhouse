# FOUNDATION Slice 14H — Key Vault Secrets User RBAC apply-plan (offline)

**Status:** complete (plan-only; live apply hard-disabled; zero Azure mutation)
**Master basis:** `f7d8126b2a980591220b81cd243bcff5ad84abd6`
**Generated:** 2026-07-19T19:55:36.183Z

## Outcome

Defined and offline-proven **exactly one** least-privilege Azure RBAC assignment that resolves the Slice **14G** live credential-preflight **403** — without deploying it.

| Field | Value |
|-------|-------|
| Principal | `wh-staging-identity` / `e3136eed-948b-4947-a26e-50a33b45a41a` |
| Role | Key Vault Secrets User / `4633458b-17de-408a-b874-0445c86b69e6` |
| Scope | `/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.KeyVault/vaults/luna-sunset-staging-kv` |
| Assignment name (deterministic) | `4653f1f5-6c4f-54bd-acba-6cad3d56d791` |
| principalType | ServicePrincipal |
| Module | `infra/azure/sunset-staging/wh-staging-identity-kv-secrets-user-role.bicep` (standalone; **not** in `main.bicep`) |

Determinism: Bicep `guid(existingKeyVault.id, principalId, roleDefinitionId)` ≡ ARM UUID v5 namespace `11fb06fb-712d-4ddd-98c7-e71bbd588830` over hyphen-joined inputs.

## Operator command (plan-only; default refuse)

```bash
SUNSET_PHASE_D_KV_SECRETS_USER_RBAC_PLAN=1 \
AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
npm run phase-d:kv-secrets-user-rbac-plan -- \
  --plan-only \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --key-vault luna-sunset-staging-kv \
  --managed-identity wh-staging-identity \
  --principal-id e3136eed-948b-4947-a26e-50a33b45a41a \
  --role-definition-id 4633458b-17de-408a-b874-0445c86b69e6 \
  --scope /subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.KeyVault/vaults/luna-sunset-staging-kv
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default/missing env/flag; wrong subscription/RG/vault/principal/role; scope broadening; Owner/Contributor/Admin; delete; duplicate/random GUID; unrelated changes; apply/deploy/what-if argv |
| GREEN | exact locked plan + deterministic GUID; standalone Bicep existing-vault locks; CLI safe IDs; live apply hard-disabled; migration/product hashes preserved |

## Non-goals / still open

- **No** Azure what-if / deploy / RBAC mutation in this slice
- **No** Key Vault retry or secret read
- **No** PostgreSQL / network / migration / DDL / ledger
- Still `product_schema_differs`
- **Do not claim** Slice 14G credential-preflight or Sunset repaired.

## Zero live mutation

Plan-only offline emission. Default/wrong args → zero Azure mutation counters. Live apply flag remains `false`.
