# Sunset staging inventory (FOUNDATION Slice 1)

Read-only live-to-IaC drift baseline. **Do not deploy or “fix” Bicep from this folder.**

| File | Purpose |
|------|---------|
| `live-inventory.normalized.json` | Secret-free normalized live snapshot + classifications |
| `DRIFT-REPORT.md` | Concise human drift table + cost baseline |
| `README.md` | This file |

## Refresh (optional, read-only)

```bash
node scripts/inventory-sunset-staging-live.js --out tmp/sunset-staging-live-raw
# Then hand-normalize into live-inventory.normalized.json (never commit secret values)
node scripts/verify-sunset-staging-live-iac-drift.js --self-test
```

## Gate

```bash
node scripts/verify-sunset-staging-live-iac-drift.js --self-test
node scripts/verify-sunset-staging-live-iac-drift.js
node scripts/verify-sunset-staging-iac-secret-scan.js
node scripts/verify-sunset-staging-iac-diff-check.js
```

Self-tests clone `live-inventory.normalized.json` in memory and mutate copies only.
