# Sunset staging ledger reconcile 056–060

This is a one-time, fail-closed repair for the exact Sunset split where the
ledger is contiguous through order 53 / migration 055, while schema objects
from 056 and 060 already exist and 057–059 do not.

It is not `staging-ledger-recovery.js`, does not accept a DSN, host, password,
SQL, or migration-range CLI option, and cannot target anything except
`sunset_staging` on the locked Sunset staging PostgreSQL server.

The sealed evidence must contain the canonical manifest digest, the full
contiguous 001–055 ledger observation, and a SHA-256 fingerprint of read-only
catalog output. The mutation transaction re-probes the catalog and refuses a
fingerprint change before any write.

Within one transaction and the migration-integrity advisory lock, it:

1. records 056 as `verified_structural_baseline`, without DDL;
2. executes canonical 057, 058, and 059 SQL and inserts each as
   `executed_by_canonical_runner`;
3. records 060 as `verified_structural_baseline`, without DDL;
4. calls canonical `reconcileLedger` before committing.

The required approval value is:

```text
APPROVE-SUNSET-056060-<first 32 hex of sha256(evidenceDigest + ':' + planDigest)>
```

`SUNSET_STAGING_LEDGER_RECONCILE=1`, the approval environment variable, the
approval CLI flag, and a sealed evidence artifact are all required for both
dry-run and apply. Apply additionally requires
`EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED` to be unset/false.

Examples:

```text
node scripts/run-sunset-staging-ledger-reconcile.js --dry-run --approve-sunset-ledger-reconcile --evidence evidence.json --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging
```

The CLI never prints credentials. Do not run the apply command until evidence
has been independently reviewed.
