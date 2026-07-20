# RADAR Slice 16A3 — Azure evidence-capture contract (design freeze)

**Status:** design frozen (audit only; zero live/network calls; zero runtime behavior change)
**Master basis:** `5a8b08d395e11c51baf928b918016d5dd5bb4afe`
**Branch:** `radar/slice-16a3-capture-contract`
**Supersedes:** unmerged RADAR 16A2 (`radar/slice-16a2-ledger-provenance` @ `9d98590109c99f53a2d03b59d488373d9f9377d1`) — **deferred, do not merge/modify**

## Outcome

Freeze an **independent, data-only** exact Azure evidence-capture contract that binds every method ID to command/REST method/path/API version/body schema, allowed subscription/RGs/hosts, retry + fallback policy, and one attempt-log record per physical dispatch (including failures). Sanitized raw response artifact hashes and the complete manifest hash are independently recomputable. The offline verifier consumes only the frozen spec and artifacts — it must not import any capture implementation.

## Why 16A2 is deferred

16A2 mixed live capture implementation constants with verifier imports (`require('./lib/radar-operations-azure-capture')`), hid retries inside `azJson` without per-attempt failure records, and allowed undeclared healthz curl→Node fallback. That couples evidence provenance to an implementation that can drift. 16A3 freezes the contract first.

## Frozen method / attempt semantics

- **17 method IDs** in `slice16a3-method-spec.json` (subscription pin, RG inventory, CostManagement ActualCost query, budgets/alerts/diagnostics/ACA/PG/LAW/AppInsights/healthz).
- **Scope:** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`; healthz hosts `staff-staging.lunafrontdesk.com`, `sunset-staging.lunafrontdesk.com`.
- **POST** allowed only for `cost_query` with frozen ActualCost body schema.
- **Retry/fallback** are explicit per method; hidden retries/fallbacks are defects.
- **Attempt unit:** one log record per physical dispatch attempt, including failures and declared fallback steps.
- **Hashes:** canonical JSON + SHA-256; `complete_manifest_sha256` covers the hashable method-spec projection.

## Preserved G09 budget-vs-anomaly semantics (from 16A2)

1. Corrected gate identity: `G09_cost_controls` (not anomaly-only).
2. Budgets = **threshold** controls; anomaly detection is **separate**.
3. Selected 16B = `16B_staging_rg_cost_budget_threshold` / `budget_threshold_partial_progress_only`.
4. 16B does **not** implement anomaly detection.
5. Notification acceptance requires **real delivery proof**; Enabled config alone fails.

Merged 16A historical matrix naming remains until a later ledger remediation slice rewrites it.

## Adversarial RED coverage

| ID | Attack |
|----|--------|
| AC16A3_COMMAND_SUBSTITUTION | Allowlisted method_id with substituted secret command |
| AC16A3_LISTKEYS | `/listKeys` path |
| AC16A3_RESTART_POST | Restart POST mutation |
| AC16A3_ALTERED_PATH | REST path drift |
| AC16A3_ALTERED_API_VERSION | API version drift |
| AC16A3_ALTERED_BODY | cost_query body schema drift |
| AC16A3_HIDDEN_RETRY | Unrecorded 429 retry |
| AC16A3_HIDDEN_FALLBACK | Unrecorded healthz transport fallback |
| AC16A3_MISSING_FAILURE_RECORD | Known failure absent from attempt log |
| AC16A3_SHARED_CONSTANT_DRIFT | Impl hardcoded inventory diverges from frozen spec |

## Bounded replacement implementation owner

**Slice:** `16A4_azure_capture_implementation`  
**Planned module:** `scripts/lib/radar-operations-azure-capture.js`  
**Planned CLI:** `scripts/capture-radar-operations-staging-readonly.js`  
**Must load:** `fixtures/radar-operations/slice16a3-method-spec.json`  
**Must not be imported by the verifier.**  
**Ancestry:** clean master after 16A3 merge — not deferred 16A2.

## Gates

```bash
npm run verify:radar-slice16a3-azure-capture-contract
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check 5a8b08d395e11c51baf928b918016d5dd5bb4afe..HEAD
```
