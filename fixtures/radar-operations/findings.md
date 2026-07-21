# RADAR findings (16A freeze + 16B–16Y partials + 16Z live SIGTERM evidence)

**Master basis (16Z):** `95dc3634ac6aaa6de495d22f5f5d8cd0a955df97`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16Z progress class:** `partial_live_proven_evidence_only` (SIGTERM LAW + post-restart recovery; G02 remains partial).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16Z)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary (16V)** — prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — not implementable yet.
4. **SIGINT `closeReadinessPool` live lifecycle behavior** — SIGTERM live closed via 16Z; SIGINT still open.
5. Serving-revision `/readyz=503` body path (failed revision never became ready to serve).
6. Zero downtime during restart / concurrent restart continuity — **not claimed** (post-restart samples only).
7. Human inbox receipt / organic metric alert firing.
8. Production — forbidden.

## Gate progress after 16Z (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16Z** SIGTERM LAW + post-restart recovery; **16X** traffic-shed; **16Y** completion source; SIGINT /readyz=503 / zero-downtime open |
| G03 | partial_live_proven | via 16P AG test |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16Z

`16Z_g02_live_sigterm_lifecycle_evidence` — reconciles dual-staging live SIGTERM drill with provenance split (A)/(B). Class A: operator restart + 31 post-restart healthz/readyz 200 pairs. Class B: digests/revisions/LAW exactly-one allowlisted SIGTERM completion each @ verify UTC `2026-07-21T11:42:38Z`. **Does not claim** SIGINT live, serving `/readyz=503`, zero-downtime-during-restart, organic alerts, production, or closing G02 as fully proven. G02 stays **partial**.

## Slice 16Y (retained)

`16Y_readiness_shutdown_completion_log` — source observability retained. Live SIGTERM drill closed via 16Z; SIGINT live still open. G02 stays **partial**.

## Slice 16X / 16W / 16U / 16P / 16S (retained)

- **16X** traffic-shed live evidence retained.
- **16W** closeReadinessPool lifecycle source retained.
- **16U** correlation design freeze; G01-A open.
- **16P** live drill evidence @ **594247f** retained.
- **16S** request completion LAW @ `1bf9695` retained.
