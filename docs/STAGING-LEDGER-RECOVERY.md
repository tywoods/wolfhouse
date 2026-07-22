# Staging ledger recovery (plan / certification contract)

**Status:** delivered as a **dry-run / plan-only** slice. Executable mutation stays **disabled** until a later, separately approved slice enables it.

**Problem:** Sunset staging `schema_migration_ledger` can contain **only** `042_luna_sales_schema` (forward order 40) while the canonical manifest still has older forward migrations. Canonical `reconcileLedger` correctly fails closed with `ledger_partial_history`. That failure is intentional and must **not** be weakened.

**Goal of this slice:** provide a repository-owned, fail-closed recovery **plan/certification** path that can certify a contiguous baseline **only** after an immutable evidence artifact supplies explicit structural assertions for every applicable historical migration (orders 1–39). It does **not** invent historical provenance and does **not** mutate any database.

## Non-negotiables

| Rule | Enforcement |
|------|-------------|
| No invented historical provenance | Recovery inserts use `verified_structural_baseline` / `verified_current_state_baseline` only after per-migration structural assertions |
| Never label recovery rows `executed_by_canonical_runner` | Certifier refuses that apply_kind on proposed inserts |
| Staging only | Exact host/database/subscription/RG lock; production targets refused |
| Dry-run default | `--plan-only` required; mutation flag hard-disabled |
| No secrets / DSN printing | Forbidden argv + secret scan on public output |
| No generic arbitrary SQL | Assertions must not embed `sql` / `query` / `arbitrarySql` |
| Fail closed | Missing evidence/assertions, checksum/manifest/target mismatch, unexpected partial ledger shape, non-contiguous projected baseline → refuse |
| Canonical reconcile unchanged | This tooling **calls** `reconcileLedger`; it does not relax it |

## Locked scenario

- Observed ledger: **exactly one** row → `042_luna_sales_schema` @ order **40**
- Diagnosis: `ledger_partial_history`
- Historical migrations requiring structural evidence: forward orders **1..39**
- Certified projected ledger tip: contiguous orders **1..40** (39 recovery inserts + preserved 042)
- Forward entry **043** remains unapplied / pending for the canonical runner after recovery

## Evidence artifact

Kind: `staging-ledger-recovery-evidence-v1`

Required content:

1. **Target identity** — locked Sunset staging fields (`environment=staging`, host, database, subscription, RG, server, port)
2. **Manifest binding** — `checksumMode=canonical_lf_v1`, `manifestHash`, `forwardCount`
3. **`evidenceDigest`** — canonical digest of the immutable payload
4. **Observed ledger** — sole-042 row + `diagnosisCode=ledger_partial_history`
5. **Historical migrations** — one entry per order 1..39 with:
   - manifest id / filename / order / `checksumSha256`
   - baseline `applyKind` (never `executed_by_canonical_runner`)
   - `requiredAssertionIds` + satisfied `structuralAssertions` with `evidenceRef`
6. **Operator approval contract** — token + flag (also required at CLI/env)

Example sealed fixture (offline placeholders, not live proof collection):

`fixtures/staging-ledger-recovery/staging-ledger-recovery-evidence.example.json`

Live structural assertion collection against staging catalog is **out of scope** for this slice; the certifier requires the assertions to be present and satisfied inside the sealed artifact.

## Operator dry-run

```bash
SUNSET_STAGING_LEDGER_RECOVERY=1 \
SUNSET_STAGING_LEDGER_RECOVERY_APPROVAL_TOKEN=APPROVE-STAGING-LEDGER-RECOVERY-V1 \
npm run staging-ledger-recovery:plan -- \
  --plan-only \
  --approve-staging-ledger-recovery \
  --evidence fixtures/staging-ledger-recovery/staging-ledger-recovery-evidence.example.json \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --postgres-server luna-sunset-staging-pg-app \
  --database sunset_staging
```

Success means: **contiguous baseline certified in dry-run**. It does **not** mean the staging ledger was rewritten.

## Mutation (disabled)

`STAGING_LEDGER_RECOVERY_MUTATION_ENABLED === false`

`--apply-ledger-recovery` / `--apply` / `--mutate` are refused with `mutation_disabled`.

A later slice must:

1. Be separately approved
2. Flip the mutation capability deliberately
3. Reuse this certification contract (still fail-closed)
4. Still refuse `executed_by_canonical_runner` labels for recovery inserts
5. Still avoid inventing provenance or weakening `reconcileLedger`

## Verify

```bash
npm run verify:staging-ledger-recovery
npm run verify:migration-integrity
```

## Owner files

| Path | Role |
|------|------|
| `scripts/lib/staging-ledger-recovery.js` | Contract + certifier + gates |
| `scripts/run-staging-ledger-recovery.js` | Plan-only CLI |
| `scripts/verify-staging-ledger-recovery.js` | RED→GREEN verifier |
| `fixtures/staging-ledger-recovery/` | Contract + example evidence |
| `docs/STAGING-LEDGER-RECOVERY.md` | This process doc |

## Related terminology

Reuses FOUNDATION migration-integrity vocabulary:

- `schema_migration_ledger`
- `canonical_lf_v1`
- `verified_structural_baseline` / `verified_current_state_baseline`
- `executed_by_canonical_runner` (forbidden for recovery inserts)
- `ledger_partial_history`
- `reconcileLedger`
