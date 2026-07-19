# FOUNDATION Slice 14N — Lunabox PostgreSQL firewall rule

**Status:** complete (offline RED/GREEN + one live ARM PUT of AllowLunaboxEgress; zero PostgreSQL)
**Master basis:** `6da7470029cf747f7326b255ec0651aa975c937c`
**Generated:** 2026-07-19T21:07:57.711Z

## Outcome

Declared standalone Bicep `infra/azure/sunset-staging/lunabox-pg-firewall-rule.bicep` referencing existing `luna-sunset-staging-pg-app`, then applied exactly **one** ARM REST PUT for rule **`AllowLunaboxEgress`** with start=end=**`20.238.124.76`**.

Live verification:

| Check | Result |
|-------|--------|
| Outbound IPv4 (api.ipify.org) | `20.238.124.76` |
| Outbound IPv4 (ifconfig.me/ip) | `20.238.124.76` |
| Both match locked IP | true |
| Live PUT count | **1** |
| Exact rule GET polls | **1** |
| ARM GET count | 5 |
| ARM DELETE count | 0 |
| Retries | 0 |
| networkMutation | **true** (firewall ARM only) |
| applyFlagPresent | **true** |
| Rules before→after count | **2→3** |
| Server Ready before→after | `Ready` → `Ready` |
| publicNetworkAccess unchanged | `Enabled` (unchanged=true) |
| Existing two rules unchanged | true |
| Third rule exact | true |
| PostgreSQL client/query | **none** |
| KV/RBAC/identity mutation | **false** |

### Rules before

- `AllowSunsetCaeEgress` 4.209.106.13–4.209.106.13
- `AllowSunsetAppEgress` 4.208.189.26–4.208.189.26

### Rules after

- `AllowSunsetCaeEgress` 4.209.106.13–4.209.106.13
- `AllowSunsetAppEgress` 4.208.189.26–4.208.189.26
- `AllowLunaboxEgress` 20.238.124.76–20.238.124.76

### Cost (safe totals only)

| Phase | Actual | Amortized | Currency | Period |
|-------|--------|-----------|----------|--------|
| Before | 16.2526276666667 | 16.2526276666667 | USD | 2026-07-01→2026-07-19 |
| After | 16.2526276666667 | 16.2526276666667 | USD | 2026-07-01→2026-07-19 |

Cost delta flagged: **false** (actualΔ=0, amortizedΔ=0). Firewall rule has **no expected direct charge**.

Safe ARM IDs:
- Server: `/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/luna-sunset-staging-pg-app`
- Rule: `/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/luna-sunset-staging-pg-app/firewallRules/AllowLunaboxEgress`

## Operator command (default-disabled)

```bash
SUNSET_PHASE_D_LUNABOX_PG_FIREWALL_APPLY=1 AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  npm run phase-d:lunabox-pg-firewall-apply -- --apply-firewall-rule \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --vm-resource-group wh-staging-rg \
  --vm-name lunabox \
  --managed-identity wh-staging-identity \
  --postgres-server luna-sunset-staging-pg-app \
  --firewall-rule-name AllowLunaboxEgress \
  --start-ip 20.238.124.76 \
  --end-ip 20.238.124.76
```

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default/missing/wrong gates; ranges; 0.0.0.0; forbidden argv; outbound IP mismatch zero PUT; sanitized PUT failure; live transport rejects deviations |
| GREEN | apply activated/delete disabled; exact gates; injected one-PUT sequence; offline mode zero HTTP; CLI default refuse; locks; hashes preserved; no pg Client |

## Non-goals / still open

- **No** Phase D constraint apply, DDL, or ledger write
- **No** KV/RBAC/identity change
- **No** PostgreSQL connection/query in this slice
- Still `product_schema_differs`
- **Do not claim Sunset repaired.**

## Zero DB mutation

No PostgreSQL client. No SQL. Firewall ARM rule only (`networkMutation=true`). Private refs zeroed. No token/DSN in evidence.
