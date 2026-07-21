# RADAR findings (16A freeze + 16B–16Z partials + 16AA–16AD G02 + 16AF–16AJ G06)

**Master basis (16AJ):** `0994989a3d5d14daa98797fac55083b0c2ea809c`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16AJ progress class:** `source_partial_progress_only` (finite staging readiness SLO/error-budget source contract + pure calculator + offline RED/GREEN; future burn-alert/drill acceptance `defined_not_executed` only — not live SLO proof; G06 remains partial).
**16AI progress class (retained):** `partial_live_proven_evidence_only` (successful controlled dual-staging `/readyz` bounded-load drill reconciled; `final_controlled_drill` = `live_proven` for this conservative readiness profile only — not soak; G06 remains partial).
**16AH progress class (retained):** `source_partial_progress_only` (pinnedLookup Happy Eyeballs `all=true` callback-contract correction + fail-closed pin validation + offline real-TLS production-shaped RED; post-16AG live attempt recorded as `attempted_not_proof`).
**16AG progress class (retained):** `source_partial_progress_only` (bounded staging `/readyz` load harness + offline verifier; future drill profile `defined_not_executed`).
**16AF progress class (retained):** `partial_live_proven_evidence_only` (four capacity-pressure alerts deployed Enabled + scale truth recorded).

## Verdict rollup

| Verdict | Count |
|--------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16AJ)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary** — prerequisite before dry-run.
3. Capacity alert firing / notification delivery — **not claimed**.
4. Load soak / sustained capacity — **not claimed** (16AI proves only the conservative `/readyz` bounded profile).
5. Autoscaling (rules=null) — **not claimed**.
6. Capacity SLO / error budget **live** proof — **not claimed** (16AJ defines source contract + calculator only; burn alert/drill acceptance `defined_not_executed`).
7. Backpressure — **not claimed**.
8. Absolute/continuous zero downtime / cold-start — **not claimed** (16AD sampling-resolution only).
9. Human inbox receipt — **not claimed** (organic restart fire closed via 16AC).
10. Requests 5xx alert firing — **not claimed**.
11. Production — forbidden.
12. Raising any gate verdict to `proven`.

## Gate progress after 16AJ (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16AD** sampled restart continuity; absolute zero-downtime / cold-start / production open |
| G03 | partial_live_proven | **16AC** organic restart fire/resolve + **16P** AG test; human inbox open |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | partial_live_proven + 16AJ SLO source | **16AJ** SLO/error-budget **source** contract + calculator; **16AI** conservative dual-staging `/readyz` bounded-load `live_proven`; prior 16AH `attempted_not_proof` retained; **16AG** harness source; **16AF** capacity-alert deploy live; **16L** source retained; soak, firing/notification, autoscaling, SLO **live** proof, backpressure open |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16AJ

`16AJ_g06_slo_error_budget_source` — text/source-only finite staging readiness SLO/error-budget contract informed by existing Azure Container Apps `Requests`/`statusCodeCategory` metric surface (16H), PT5M/PT15M capacity-alert cadence (16L/16AF), and 16AI conservative `/readyz` observability (not reused as SLO proof). Locks: availability target **99%** (2xx/total), latency objective **500ms** at **99%** histogram success fraction, combined **min(availability, latency)** target **99%**, finite **PT7D** window, **PT5M** grain, min coverage **0.5**, min requests **100**, error-budget fraction **0.01**, multi-window burns **14.4 / 6 / 3 / 1** with AND fire rule, fail-closed missing/reset/out-of-order/zero-traffic/sparse/percentile-misuse. Ships pure dependency-free calculator + deterministic RED/GREEN verifier. Future burn-alert/drill acceptance **`defined_not_executed`** only. Does **not** deploy alerts, execute live, mutate scale, or claim production scope, live SLO compliance, backpressure, or autoscaling. G06 remains **partial**; score unchanged (proven=0 / partial=9 / absent=0).

## Slice 16AI

`16AI_g06_live_load_evidence` — reconciles the operator-controlled successful re-run @ `2026-07-21T16:50:16Z` of profile `16AG_DRILL_dual_staging_readyz_bounded_load` against the exact two staging `/readyz` allowlist targets, claiming **only** what committed secret-free raw fixtures prove (`slice16ai-raw-drill` + `slice16ai-raw-cost-before/after`; ephemeral `/tmp` and `tmp/` excluded; SHA-256 provenance locked): each **60/60 2xx**; concurrency peak **2**; zero timeout/error/non-2xx; WH p50/p95/p99/max **30/32/44/44ms** wall **954**; Sunset **28/29/40/40ms** wall **879**; response bodies/redirects/headers/auth/body **false**; DNS pinned; active remaining **0**. Sunset RG MTD ActualCost before/after identical **18.2443795483871 USD**. Explicitly does **not** claim pre/post `/readyz` readiness (absent from raw drill) or after-query 429/retry (no durable transcript). Records `final_controlled_drill` status **`live_proven`** for this **conservative readiness profile only**. Does **not** claim soak, alert fire/notification, autoscaling, capacity SLO/error budget live proof, backpressure, production, or raising G06 to `proven`. Retained under 16AJ tip. G06 remains **partial**.

## Slice 16AH

`16AH_g06_live_load_correction` — corrects `pinnedLookup` so Node Happy Eyeballs (`options.all=true`) receives a validated pinned `{address,family}[]` (scalar retained for `all=false`; family filter + exact pins retained; every pin fail-closed through `assertPublicDnsAddresses`). Offline production-shaped RED proves scalar replies fail before TLS/HTTP. Records the controlled post-16AG dual-staging `/readyz` attempt (60/60 error-before-HTTP while direct pre/post `/readyz` stayed ready) as **`attempted_not_proof`**. Retained under 16AJ tip. G06 remains **partial**.

## Slice 16AG

`16AG_g06_bounded_load_harness` — dependency-free bounded Node load harness hard-locked to the two exact staging Staff API `/readyz` URLs with offline fail-closed RED/GREEN verifier. Future drill profile remains **`defined_not_executed`** as the 16AG source lock; live success ownership is 16AI. Retained under 16AJ tip. G06 remains **partial**.

## Slice 16AF

`16AF_g06_capacity_alert_live_evidence` — reconciles Azure-readonly dual-staging readback of four capacity-pressure alerts + scale truth. Retained under 16AJ tip. G06 remains **partial**.

## Slice 16AD

`16AD_g02_sampled_restart_continuity_evidence` — concurrent sampled revision-restart continuity retained. G02 stays **partial**.

## Slice 16AC

`16AC_organic_restart_alert_evidence` — organic RestartCount alerts fired/resolved/unsuppressed; inbox open. G02/G03 stay **partial**.

## Slice 16AB / 16AA / 16Z / 16Y / 16X / 16W / 16U / 16P / 16S (retained)

Retained as prior.
