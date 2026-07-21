# RADAR findings (16A freeze + 16B–16Z partials + 16AA live SIGINT evidence)

**Master basis (16AA):** `fd333b22c984bad1abe387da456b6fbf87396c13`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16AA progress class:** `partial_live_proven_evidence_only` (SIGINT LAW + post-drill recovery; G02 remains partial).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16AA)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary (16V)** — prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — not implementable yet.
4. Serving-revision `/readyz=503` body path (failed revision never became ready to serve).
5. Zero downtime during restart / concurrent restart continuity — **not claimed** (post-drill /readyz only).
6. Human inbox receipt / organic metric alert firing.
7. Production — forbidden.
8. Unqualified revision-lifetime exactly-one LAW cardinality — **false** at both target revisions; not claimed.

## Gate progress after 16AA (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16AA** SIGINT LAW + post-drill recovery; **16Z** SIGTERM; **16X** traffic-shed; **16Y** completion source; /readyz=503 / zero-downtime open |
| G03 | partial_live_proven | via 16P AG test |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16AA

`16AA_g02_live_sigint_lifecycle_evidence` — reconciles dual-staging live SIGINT drill with provenance split (A)/(B). Class A: `az containerapp exec` + `kill -INT 1` + ClusterExecFailure exit 137 (**az containerapp exec transport/process-termination disconnect only** — not app failure; not proof of application/Node native exit status, shell code, signal encoding, or ACA restart reason) + post-drill `/readyz=200`. Class B: digests/revisions/replicas/probes @ `2026-07-21T12:10:51Z`; LAW cardinality @ `2026-07-21T12:11:18Z` = exactly one allowlisted SIGINT completion **in each declared bounded inclusive drill query window** (WH `12:08:00Z–12:09:00Z` → `12:08:28.6734879Z`; Sunset `12:09:00Z–12:10:00Z` → `12:09:25.9915987Z`). **Independent LAW allowlisted record — not 137 — is evidence the lifecycle received original_signal SIGINT and completed pool/server cleanup.** Other revision-lifetime records disclosed; revision-lifetime count is not one. **Does not claim** serving `/readyz=503`, zero-downtime-during-restart, organic alerts, production, or closing G02 as fully proven. G02 stays **partial**.

## Slice 16Z (retained)

`16Z_g02_live_sigterm_lifecycle_evidence` — dual-staging live SIGTERM drill retained. SIGINT live closed via 16AA. G02 stays **partial**.

## Slice 16Y (retained)

`16Y_readiness_shutdown_completion_log` — source observability retained. Live SIGTERM via 16Z; live SIGINT via 16AA. G02 stays **partial**.

## Slice 16X / 16W / 16U / 16P / 16S (retained)

- **16X** traffic-shed live evidence retained.
- **16W** closeReadinessPool lifecycle source retained.
- **16U** correlation design freeze; G01-A open.
- **16P** live drill evidence @ **594247f** retained.
- **16S** request completion LAW @ `1bf9695` retained.
