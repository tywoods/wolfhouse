# Staging ledger recovery (plan + one-time apply)

**Status:** plan/certification contract (PR #158) plus a **narrowly-scoped, one-time executable apply mode** for the locked sole-042 staging case. Apply is staging-only, fail-closed, and exercised only through an **injected DB-client seam** in verification — this repository path does **not** retrieve secrets or open a live database during `verify:staging-ledger-recovery`.

**Problem:** Sunset staging `schema_migration_ledger` can contain **only** `042_luna_sales_schema` (forward order 40) while the canonical manifest still has older forward migrations. Canonical `reconcileLedger` correctly fails closed with `ledger_partial_history`. That failure is intentional and must **not** be weakened.

**Goal:** certify a contiguous baseline from immutable structural evidence, then (when explicitly approved) insert **exactly** the 39 missing historical ledger rows as `verified_structural_baseline` inside one transaction + advisory lock, preserving the existing 042 row unchanged.

## Non-negotiables

| Rule | Enforcement |
|------|-------------|
| No invented historical provenance | Recovery inserts use `verified_structural_baseline` only after per-migration structural assertions |
| Never label recovery rows `executed_by_canonical_runner` | Certifier + apply refuse that apply_kind on recovery inserts |
| Staging only | Exact host/database/subscription/RG lock; production targets refused |
| Dry-run default | `--plan-only` for certification; apply requires `--apply-ledger-recovery` |
| No secrets / DSN printing | Forbidden argv + secret scan on public output; no Key Vault/IMDS retrieval in this module |
| No generic arbitrary SQL | Assertions must not embed `sql` / `query` / `arbitrarySql`; apply SQL is allowlisted |
| Fail closed | Missing evidence/assertions, checksum/manifest/target mismatch, unexpected ledger shape, empty ledger, repeated application, or non-contiguous post-write baseline → refuse + full ROLLBACK |
| Canonical reconcile unchanged | This tooling **calls** `reconcileLedger`; it does not relax it |

## Locked scenario

- Observed ledger: **exactly one** row → `042_luna_sales_schema` @ order **40**
- Diagnosis: `ledger_partial_history`
- Historical migrations requiring structural evidence: forward orders **1..39**
- Apply writes: **39** `verified_structural_baseline` rows only; **042 preserved byte-for-byte**
- Certified projected ledger tip: contiguous orders **1..40**
- Forward entry **043** remains unapplied / pending for the canonical runner after recovery
- Repeated apply against a non-sole-042 ledger is refused

## Evidence artifact

Kind: `staging-ledger-recovery-evidence-v1`

Required content:

1. **Target identity** — locked Sunset staging fields (`environment=staging`, host, database, subscription, RG, server, port)
2. **Manifest binding** — `checksumMode=canonical_lf_v1`, `manifestHash`, `forwardCount`
3. **`evidenceDigest`** — canonical digest of the immutable payload
4. **Observed ledger** — sole-042 row + `diagnosisCode=ledger_partial_history`
5. **Historical migrations** — one entry per order 1..39 with:
   - manifest id / filename / order / `checksumSha256`
   - baseline `applyKind` = `verified_structural_baseline` (never `executed_by_canonical_runner`)
   - `requiredAssertionIds` + satisfied `structuralAssertions` with `evidenceRef`
6. **Operator approval contract** — token + flag (also required at CLI/env)

Example sealed fixture (offline placeholders, **not** live proof collection):

`fixtures/staging-ledger-recovery/staging-ledger-recovery-evidence.example.json`

### Operator must collect real staging structural evidence before apply

The example fixture is for offline contract tests only. Before any real apply invocation, an operator must:

1. Collect **real** staging catalog/structural assertions for every historical migration (orders 1..39) against Sunset staging
2. Seal those assertions into an immutable `staging-ledger-recovery-evidence-v1` artifact with a matching `evidenceDigest`
3. Confirm the live ledger is still exactly the sole-042 partial shape
4. Confirm manifest hash / forward checksums still match
5. Only then invoke apply with approval token/flag and an injected client bound to the locked staging target

Do **not** treat the repo example evidence as live proof.

## Operator dry-run (plan)

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

## One-time apply mode

`STAGING_LEDGER_RECOVERY_MUTATION_ENABLED === true` (capability), but apply still fail-closed:

- Requires `--apply-ledger-recovery` (mutually exclusive with `--plan-only`)
- Requires approval flag + `SUNSET_STAGING_LEDGER_RECOVERY_APPROVAL_TOKEN`
- Requires sealed evidence (digest, target lock, manifest checksum, sole-042 shape, structural assertions)
- Executes inside **one** DB transaction with `pg_advisory_xact_lock` (WH / MIG1)
- Inserts only the 39 missing rows as `verified_structural_baseline`
- Preserves existing 042 unchanged
- Re-reads ledger and runs contiguous `reconcileLedger` **before COMMIT**
- Rolls back fully on any error
- Refuses production, arbitrary DSN/SQL argv, empty/other ledger shapes, weak/missing evidence, and repeated application
- Safe public output contains no secrets

### DB-client seam (no secret retrieval here)

Apply requires an **injected** `dbClient` / `Client` seam (used by the verifier with a scripted fake client). This module does **not** call managed identity, IMDS, or Key Vault. Operators who later perform a real staging apply must supply a client already bound to the locked staging target after collecting real structural evidence.

```bash
SUNSET_STAGING_LEDGER_RECOVERY=1 \
SUNSET_STAGING_LEDGER_RECOVERY_APPROVAL_TOKEN=APPROVE-STAGING-LEDGER-RECOVERY-V1 \
npm run staging-ledger-recovery:apply -- \
  --apply-ledger-recovery \
  --approve-staging-ledger-recovery \
  --evidence /path/to/real-sealed-staging-evidence.json \
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \
  --resource-group luna-sunset-staging-rg \
  --postgres-server luna-sunset-staging-pg-app \
  --database sunset_staging
```

Without an injected client, CLI apply exits fail-closed with `db_client_required` (it will not invent a DSN or fetch secrets).

## Verify

```bash
npm run verify:staging-ledger-recovery
npm run verify:migration-integrity
```

## Owner files

| Path | Role |
|------|------|
| `scripts/lib/staging-ledger-recovery.js` | Contract + certifier + apply sequence + fake client seam |
| `scripts/run-staging-ledger-recovery.js` | Plan / apply CLI (no live secret retrieval) |
| `scripts/verify-staging-ledger-recovery.js` | RED→GREEN verifier (fake client only) |
| `fixtures/staging-ledger-recovery/` | Contract + example evidence |
| `docs/STAGING-LEDGER-RECOVERY.md` | This process / runbook |

## Related terminology

Reuses FOUNDATION migration-integrity vocabulary:

- `schema_migration_ledger`
- `canonical_lf_v1`
- `verified_structural_baseline` / `verified_current_state_baseline`
- `executed_by_canonical_runner` (forbidden for recovery inserts)
- `ledger_partial_history`
- `reconcileLedger`
