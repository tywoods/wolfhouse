# FOUNDATION Slice 14AD — Ledger baseline apply

**Status:** ledger_baseline_apply_live_ok
**Master basis:** `d6834dbbecc2aa0a8b0ecbdfa2ad1402210a6657`
**Canonical fingerprint (unchanged):** `120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18`
**proposedLedgerRows sha256:** `c136abccd8d61b723fddc61b1971b4553b0256306bbe546c01d672a63e1e5226`
**14AC evidence file sha256:** `45219e7b6738d847f9dc066db27b92caf271e0ee305e7c6e643f27519033ff96`
**Generated:** 2026-07-20T00:31:49.100Z

## Baseline rows

- structural: **34**
- current_state: **5**
- total: **39**

## Offline gates

- RED: 14 cases
- GREEN: 9 cases
- Authorized sequence length: **54**
- Advisory locks: WH (0x57480001) / MIG1 (0x4d494731)

## Timestamp semantics

- Ledger recording time within the inserting transaction; never historical migration execution time.
- Same transaction recording timestamp as applied_at; documents when the ledger row was written.
- neverHistoricalExecutionTime: **true**

## Live

apply application_name: `wh-sunset-ledger-baseline-apply`
observer application_name: `wh-sunset-schema-observer`
sameTarget: **true**
remaining mismatch before/after: **0** / **0**
ledger absent before: **true**
ledger rows after: **39**
14AC live fingerprint unchanged: **true** (`039b67d034d4bd1eec68cf8a348a1f6fad2b13bcc526f24584127d028d3f0c12`)
liveExecutionCount: **1**
ledgerTxnTs: `2026-07-20T00:31:52.213Z`

Mutation flags: schemaMutation=ledger_only; dataMutation=false; ledgerWritten=true; kvMutation=false.

## Do not claim

- Do **not** run verify with `--live`.
- Do **not** execute migration SQL as part of this slice.
- Do **not** claim applied_at/ledger_recorded_at are historical migration execution times.

## Operator live command

```
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_LEDGER_BASELINE_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:ledger-baseline-apply -- --apply-ledger-baseline --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
```

## Artifacts

- `fixtures/sunset-schema-observer/slice14ad-ledger-baseline-apply-evidence.json`
- `fixtures/sunset-schema-observer/slice14ad-ledger-baseline-apply-contract.json`
- `fixtures/sunset-schema-observer/slice14ad-findings.md`
