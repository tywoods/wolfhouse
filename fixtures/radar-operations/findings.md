# RADAR findings (16A freeze + 16B–16X partials + 16Y shutdown completion source)

**Master basis (16Y):** `798a5f26e9aa0376e2993b7d590fc818dfa171f7`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16Y progress class:** `source_partial_progress_only` (shutdown completion observability; G02 remains partial; SIGTERM live open).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16Y)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary (16V)** — prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — not implementable yet.
4. **SIGTERM/SIGINT `closeReadinessPool` live lifecycle behavior** — source closed (16W); completion log source closed (16Y); **live open** until deployment/drill.
5. Serving-revision `/readyz=503` body path (failed revision never became ready to serve).
6. Human inbox receipt / organic metric alert firing.
7. Production — forbidden.

## Gate progress after 16Y (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16X** deploy + Activating traffic-shed; **16Y** shutdown completion source; SIGTERM live open |
| G03 | partial_live_proven | via 16P AG test |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16Y

`16Y_readiness_shutdown_completion_log` — one bounded non-sensitive `staff_api_readiness_shutdown_completion` JSON record per readiness shutdown (after pool/server results, before detach/native re-signal). Default logger: one stdout JSON line; injected logger supported/non-throwing; exactly one record under same/repeated/mixed signals. **Does not claim** live SIGTERM proof, organic alerts, production, serving `/readyz=503`, or closing G02 as fully proven. G02 stays **partial**.

## Slice 16X (retained)

`16X_g02_lifecycle_deploy_traffic_shed_live_evidence` — reconciles dual-staging exact-SHA `2dcda08` deploy with provenance split (A)/(B). **Does not claim** SIGTERM live lifecycle. G02 stays **partial**.

## Slice 16W (retained)

`16W_readiness_shutdown_lifecycle` — wires `closeReadinessPool` into Staff API SIGTERM/SIGINT shutdown on CLI main. Semantics preserved by 16Y. Live SIGTERM behavior remains open.

## Slice 16U / 16P / 16S (retained)

- **16U** `16U_correlation_design_freeze` — audit-only design freeze; live Caddy `/whatsapp/*` → **8092**; G01-A open; dry-run not implementable yet; capability boundary prerequisite.
- **16P** `16P_live_drill_evidence_reconciliation` — **partial_live_proven** @ **594247f**. **Does not claim** human inbox receipt, organic metric alert firing, or production.
- **16S** `16S_request_completion_log_live_evidence` @ SHA `1bf9695` (WH `--0000517`, Sunset `--0000277`) — LAW delivery/search/retention retained; Meta→Hermes end-to-end still open.
