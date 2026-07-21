# RADAR findings (16A freeze + 16B–16W partials + 16X G02 live evidence)

**Master basis (16X):** `2dcda08008fe951565560cefafe37f1a78b0791a`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16X progress class:** `partial_live_proven_evidence_only` (deploy + traffic-shed drill; G02 remains partial).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16X)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary (16V)** — prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — not implementable yet.
4. **SIGTERM/SIGINT `closeReadinessPool` live lifecycle behavior** — source closed (16W); live open after 16X.
5. Serving-revision `/readyz=503` body path (failed revision never became ready to serve).
6. Human inbox receipt / organic metric alert firing.
7. Production — forbidden.

## Gate progress after 16X (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16X** deploy + Activating traffic-shed; SIGTERM live open |
| G03 | partial_live_proven | via 16P AG test |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16X

`16X_g02_lifecycle_deploy_traffic_shed_live_evidence` — reconciles dual-staging exact-SHA `2dcda08` deploy with explicit provenance split: **(A)** operator-transcript contemporaneous `g02fail` Activating ≥90s @ 5s never latestReady + prior public `/healthz=200` `/readyz=200` (not Azure-reconstructible); **(B)** independently reverified digests/revisions/secretRef/probes/traffic/public-current @ `2026-07-21T10:33:28Z` (WH digest `sha256:53682837…` base `--0000518`; Sunset `sha256:3c702217…` base `--0000278`; `g02restore` Healthy/latestReady/100%). **Does not claim** SIGTERM live lifecycle, organic alerts, production, serving `/readyz=503`, or closing G02 as fully proven. G02 stays **partial**.

## Slice 16W (retained)

`16W_readiness_shutdown_lifecycle` — wires `closeReadinessPool` into Staff API SIGTERM/SIGINT shutdown on CLI main. Live SIGTERM behavior remains open after 16X.

## Slice 16U / 16P / 16S (retained)

- **16U** `16U_correlation_design_freeze` — audit-only design freeze; live Caddy `/whatsapp/*` → **8092**; G01-A open; dry-run not implementable yet; capability boundary prerequisite.
- **16P** `16P_live_drill_evidence_reconciliation` — **partial_live_proven** @ **594247f**. **Does not claim** human inbox receipt, organic metric alert firing, or production.
- **16S** `16S_request_completion_log_live_evidence` @ SHA `1bf9695` (WH `--0000517`, Sunset `--0000277`) — LAW delivery/search/retention retained; Meta→Hermes end-to-end still open.
