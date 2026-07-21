# RADAR findings (16A freeze + 16B–16Z partials + 16AA SIGINT + 16AB serving /readyz=503 evidence)

**Master basis (16AB):** `c43b4a14d14d5618d99e0e969b4f39784a526722`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16AB progress class:** `partial_live_proven_evidence_only` (serving `/readyz=503` body path; G02 remains partial — zero-downtime / organic alerts / production open).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16AB)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary (16V)** — prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — not implementable yet.
4. Zero downtime during restart / concurrent sampled continuity — **not claimed**.
5. Human inbox receipt / organic metric alert firing.
6. Production — forbidden.
7. Raising any gate verdict to `proven`.

## Gate progress after 16AB (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16AB** serving `/readyz=503` body path; **16AA** SIGINT; **16Z** SIGTERM; **16X** traffic-shed; **16Y** completion source; zero-downtime / organic alerts / production open |
| G03 | partial_live_proven | via 16P AG test |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16AB

`16AB_g02_serving_readyz_503_body_path_evidence` — reconciles dual-staging serving-revision `/readyz=503` body-path drill with provenance split (A)/(B). Class A: temporary Multiple mode + 100% pin to known healthy revision; isolated min=1/max=1 fail revisions `wh-staging-staff-api--g02503` / `luna-sunset-staging-staff-api--g02503` on exact SHA `95dc363` with dummy unreachable literal `WOLFHOUSE_DATABASE_URL` (value not recorded); `az containerapp exec` into exact replicas `…-r2jzv` / `…-fhnqt` + local Node HTTP GET `http://127.0.0.1:3036/readyz` exact status **503** + body `{status:not-ready}`; public healthy `/readyz` stayed 200; **`observed_at=unavailable_in_command_transcript`** (do not invent); cleanup deactivated fail + restored Single/100%. Class B @ `2026-07-21T12:43:09Z`: restores `…--g02503r` WH min0/max1 + Sunset min1/max1 Healthy/latestReady/100%; fail inactive/Stopped/0; digests locked; public current healthz/readyz 200. **Azure cannot recreate historical localhost 503/body or traffic sequence.** **Does not claim** concurrent sampled continuity, zero-downtime-during-restart, organic alerts, production, or closing G02 as fully proven. G02 stays **partial**.

## Slice 16AA (retained)

`16AA_g02_live_sigint_lifecycle_evidence` — dual-staging live SIGINT drill retained. Class A: `az containerapp exec` + `kill -INT 1` + ClusterExecFailure exit 137 (**az containerapp exec transport/process-termination disconnect only**). Class B LAW cardinality in bounded inclusive drill query windows (WH `12:08:00Z–12:09:00Z`; Sunset `12:09:00Z–12:10:00Z`); Independent LAW allowlisted record — not 137 — owns SIGINT cleanup; other revision-lifetime records disclosed. Serving `/readyz=503` closed via 16AB. G02 stays **partial**.

## Slice 16Z (retained)

`16Z_g02_live_sigterm_lifecycle_evidence` — dual-staging live SIGTERM drill retained. G02 stays **partial**.

## Slice 16Y (retained)

`16Y_readiness_shutdown_completion_log` — source observability retained. Live SIGTERM via 16Z; live SIGINT via 16AA. G02 stays **partial**.

## Slice 16X / 16W / 16U / 16P / 16S (retained)

- **16X** traffic-shed live evidence retained.
- **16W** closeReadinessPool lifecycle source retained.
- **16U** correlation design freeze; G01-A open.
- **16P** live drill evidence @ **594247f** retained.
- **16S** request completion LAW @ `1bf9695` retained.
