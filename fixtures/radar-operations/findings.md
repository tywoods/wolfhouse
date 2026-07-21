# RADAR findings (16A freeze + 16B–16Z partials + 16AA SIGINT + 16AB serving /readyz=503 + 16AC organic restart alerts)

**Master basis (16AC):** `72d8faf74df27a714482ebdefb8f88870d080306`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16AC progress class:** `partial_live_proven_evidence_only` (organic RestartCount alerts fired/resolved/unsuppressed both staging apps; G02/G03 remain partial — inbox / zero-downtime / production open).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16AC)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary (16V)** — prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — not implementable yet.
4. Zero downtime during restart / concurrent sampled continuity — **not claimed**.
5. Human inbox receipt — **not claimed** (organic restart fire closed via 16AC).
6. Unique causality beyond platform alert fields — **not claimed**.
7. Requests 5xx alert firing — **not claimed**.
8. Production — forbidden.
9. Raising any gate verdict to `proven`.

## Gate progress after 16AC (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16AC** organic restart alerts; **16AB** `/readyz=503`; **16AA** SIGINT; **16Z** SIGTERM; **16X** traffic-shed; zero-downtime / production open |
| G03 | partial_live_proven | **16AC** organic restart fire/resolve + **16P** AG test; human inbox open |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16AC

`16AC_organic_restart_alert_evidence` — reconciles independently discovered organic Azure Monitor restart alerts temporally associated with completed 16AA SIGINT drills. WH `wolfhouse-staff-api-restart-count` / `wh-staging-staff-api` Metric Sev2 Platform Resolved start `2026-07-21T12:11:40.2497189Z` resolved `12:17:59.4591399Z` `isSuppressed=false`; Sunset `sunset-staff-api-restart-count` / `luna-sunset-staging-staff-api` start `12:12:51.2774974Z` resolved `12:19:32.3682899Z` unsuppressed. Rules enabled `RestartCount` Total GreaterThan 0 PT1M/PT5M scoped to exact apps + ops-budget AGs; AGs enabled receiver `ops-email` status Enabled (address not recorded). Chronology follows 16AA LAW SIGINT WH `12:08:28.6734879Z` / Sunset `12:09:25.9915987Z` as cautious temporal association only. Costs locked WH `69.3920793568176` / Sunset `18.1452292043011` unchanged; no resources created. **Does not prove** inbox receipt, unique causality, 5xx fire, production, zero downtime, or raising G02/G03 to `proven`. G02 organic restart gap closed but G02 partial; G03 organic firing closed but inbox open and G03 partial.

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
