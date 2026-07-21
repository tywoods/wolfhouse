# RADAR findings (16A freeze + 16B–16Z partials + 16AA SIGINT + 16AB serving /readyz=503 + 16AC organic restart alerts + 16AD sampled restart continuity)

**Master basis (16AD):** `137b14a0b3efc689ba749340a97ab4e9bc220edc`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16AD progress class:** `partial_live_proven_evidence_only` (concurrent sampled revision-restart continuity at declared sampling resolution after WH warmup exclusion; G02 remains partial — absolute zero-downtime / cold-start / production open).

## Verdict rollup

| Verdict | Count |
|--------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16AD)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary (16V)** — prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — not implementable yet.
4. Absolute/continuous zero downtime / between-sample / sub-second interruption — **not claimed**.
5. Cold-start availability — **not claimed** (WH warmup timeouts remain real).
6. Human inbox receipt — **not claimed** (organic restart fire closed via 16AC).
7. Unique causality beyond platform alert fields — **not claimed**.
8. Requests 5xx alert firing — **not claimed**.
9. Production — forbidden.
10. Raising any gate verdict to `proven`.

## Gate progress after 16AD (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16AD** sampled restart continuity; **16AC** organic restart alerts; **16AB** `/readyz=503`; **16AA** SIGINT; **16Z** SIGTERM; **16X** traffic-shed; absolute zero-downtime / cold-start / production open |
| G03 | partial_live_proven | **16AC** organic restart fire/resolve + **16P** AG test; human inbox open |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16AD

`16AD_g02_sampled_restart_continuity_evidence` — reconciles dual-staging concurrent sampled revision-restart continuity with provenance split (A)/(B). Class A: bounded sequential public `/healthz`+`/readyz` poller (max-time 4s ~1s) during `az containerapp revision restart`. WH samples `0..90` @ `13:21:11Z–13:23:17Z`; samples `0..2` timeout disclosed/excluded (scale-from-zero warmup before restart); samples `3..90` both 200; restart window `13:21:47Z–13:21:50Z` samples `8..11` both 200. Sunset samples `0..90` @ `13:23:39Z–13:25:18Z` all both 200; restart `13:23:54Z–13:23:58Z` samples `14..17` both 200. Class B @ `2026-07-21T13:29:32Z`: LAW SIGTERM WH `13:22:29.3669823Z` replica `…-mgfw2` / Sunset `13:24:29.7970752Z` replica `…-dw7cx` allowlisted payload; both Single/latest/latestReady/100%; public current 200. **Claim only** no observed public interruption at this sampling resolution during declared restart windows after warmup — **not** absolute/continuous zero downtime, **not** between-sample proof, **not** cold-start, **not** production, **not** full G02. Concurrent sampled continuity gap closed; G02 remains **partial**.

## Slice 16AC

`16AC_organic_restart_alert_evidence` — organic RestartCount alerts fired/resolved/unsuppressed both staging apps; temporally associated with 16AA SIGINT; inbox/unique-causality open. G02/G03 stay **partial**.

## Slice 16AB

`16AB_g02_serving_readyz_503_body_path_evidence` — serving-revision `/readyz=503` body-path retained. `observed_at=unavailable_in_command_transcript`. G02 stays **partial**.

## Slice 16AA (retained)

`16AA_g02_live_sigint_lifecycle_evidence` — dual-staging live SIGINT drill retained. Class A: `az containerapp exec` + `kill -INT 1` + ClusterExecFailure exit 137 (**az containerapp exec transport/process-termination disconnect only**). Class B LAW cardinality in bounded inclusive drill query windows (WH `12:08:00Z–12:09:00Z`; Sunset `12:09:00Z–12:10:00Z`); Independent LAW allowlisted record — not 137 — owns SIGINT cleanup; other revision-lifetime records disclosed. Serving `/readyz=503` closed via 16AB; concurrent sampled continuity via 16AD. G02 stays **partial**.

## Slice 16Z (retained)

`16Z_g02_live_sigterm_lifecycle_evidence` — dual-staging live SIGTERM drill retained. LAW drill-query-window cardinality (WH restart `11:15:18Z`); post-restart recovery was not concurrent continuity (closed via 16AD). G02 stays **partial**.

## Slice 16Y / 16X / 16W / 16U / 16P / 16S (retained)

Retained as prior.
