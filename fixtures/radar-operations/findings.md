# RADAR findings (16A freeze + 16B–16Z partials + 16AA–16AD G02 + 16AF–16AL G06)

**Master basis (16AL):** `502d762f897432c67bb8b17a8a49bfab01a0787d`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16AL progress class:** `integration_source_partial_progress_only` (Staff API admission-control **wire** behind `STAFF_API_ADMISSION_CONTROL` default **OFF**; deterministic fake req/res integration source proof; flag **not** enabled; no deploy/live load; does **not** claim backpressure live/proven/full G06; G06 remains partial).
**16AK progress class (retained):** `source_partial_progress_only` (tenant-safe admission/backpressure source contract + pure state machine + offline RED/GREEN; Staff API integration was `defined_not_executed` at 16AK tip — wire ownership is 16AL).
## Verdict rollup

| Verdict | Count |
|--------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16AK)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary** — prerequisite before dry-run.
3. Capacity alert firing / notification delivery — **not claimed**.
4. Load soak / sustained capacity — **not claimed** (16AI proves only the conservative `/readyz` bounded profile).
5. Autoscaling (rules=null) — **not claimed**.
6. Capacity SLO / error budget **live** proof — **not claimed** (16AJ defines availability-only source contract + calculator only; burn alert/drill acceptance `defined_not_executed`).
7. Latency percentile SLI — **blocked** pending joint request telemetry/instrumentation (not part of 16AJ SLO; no ACA duration histogram / p99≤500ms / combined intersection).
8. Backpressure **runtime/live** — **not claimed** (16AK source + 16AL wire **source** behind flag default OFF; flag not enabled; no live 503 shed proof).
9. Absolute/continuous zero downtime / cold-start — **not claimed** (16AD sampling-resolution only).
10. Human inbox receipt — **not claimed** (organic restart fire closed via 16AC).
11. Requests 5xx alert firing — **not claimed**.
12. Production — forbidden.
13. Raising any gate verdict to `proven`.

## Gate progress after 16AL (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | **16AD** sampled restart continuity; absolute zero-downtime / cold-start / production open |
| G03 | partial_live_proven | **16AC** organic restart fire/resolve + **16P** AG test; human inbox open |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | partial_live_proven + 16AL wire source + 16AK backpressure source + 16AJ SLO source | **16AL** Staff API admission **wire** behind flag default OFF (integration source only); **16AK** admission/backpressure **source** contract + library; **16AJ** SLO/error-budget **source**; **16AI** conservative dual-staging `/readyz` bounded-load `live_proven`; prior 16AH `attempted_not_proof` retained; **16AG** harness source; **16AF** capacity-alert deploy live; **16L** source retained; flag-on live shed, soak, firing/notification, autoscaling, SLO **live** proof open |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16AL

`16AL_g06_backpressure_wire` — integrate the reviewed **16AK** admission controller into Staff API `createStaffQueryApiHttpServer` behind fail-closed deployment flag **`STAFF_API_ADMISSION_CONTROL` default OFF**. Placement: after `resolveTrustedIngressBinding(...).tenant_slug`, before router body/DB/tool side effects; **eligible-route allowlist only**; `/healthz` `/readyz` `/` and unknown routes **excluded**. Response lifecycle releases **exactly once** on finish/close/error/abort; queued disconnect cancels; queued promotion resumes handler exactly once; transport-dead cancel before queue and before promoted router execution; named once listeners detach to baseline; late events cannot cancel promoted tokens; sync/async throws clean up; `admissionBoundary.close()` at readiness-lifecycle shutdown **BEGIN** (before `server.close` waits on connections — not the server `close` event) via per-server **Set-deduped registry/dispatcher** (duplicate bind no-op; close exactly once; prior hook once; no wrapper chains; symbols cleared after fire; OFF registers nothing); post-side-effect work is never 503-shed; public 503 body/Retry-After bounded/non-sensitive. Flag parsing rejects malformed values; OFF is exact behavior-preserving. Ships `staff-api-admission-boundary.js` + deterministic fake req/res integration tests including adversarial REDs. **Does not** enable the flag, deploy, run live load, or claim backpressure live/proven/full G06. Score unchanged (proven=0 / partial=9 / absent=0). G06 remains **partial**.

## Slice 16AK

`16AK_g06_backpressure_source` — text/source-only tenant-safe Staff API **admission-control / backpressure** contract informed by inspected `staff-query-api.js` request topology (entry order, `/healthz`/`/readyz` exclusions, Stripe/Meta webhooks, write vs preview vs GET families). Trusted admission tenant source is **only** `resolveTrustedIngressBinding(...).tenant_slug` — never request spoof. Reviewed **eligible-route allowlist** (unknown default-exclude fail-closed; **no** suffix heuristic; **no** all-router-literal coverage claim); classifies `POST /staff/bookings/move-targets` as read-like and `POST /staff/test/reset-luna-phone` as write. Locks ceilings (in-flight global **8** / queue **16**; per-tenant **4**/**8**; Retry-After **1**s; tombstones **128**). Fail-fast **503** only for **pre-side-effect overload**; post-side-effect rejection is internal continue/fail-closed with **no** http_status/Retry-After/retryable metadata. Per-tenant isolation + round-robin; idle empty tenant buckets/rr keys evicted; terminal tokens deleted via tombstone ring; `close()` rejects queued pre-side-effect work and settles state; diagnostics are aggregate/opaque only (no tenant slugs). Ships pure dependency-free state machine + deterministic RED/GREEN (incl. real induced reentrancy, large churn, 65th historical tenant). Staff API integration drill was **`defined_not_executed`** at the 16AK tip (wire ownership deferred to **16AL**). **Sync-throw integration ownership was explicitly not claimed by 16AK**. Does **not** deploy, execute live/load/soak, mutate scale, or claim production scope, backpressure proven, autoscaling, or raise G06.

## Slice 16AJ

`16AJ_g06_slo_error_budget_source` — text/source-only **availability-only** staging readiness SLO/error-budget contract informed by existing Azure Container Apps `Requests` Total (Sum of request counts) / `statusCodeCategory` metric surface (16H), PT5M/PT15M capacity-alert cadence (16L/16AF), and 16AI conservative `/readyz` observability (not reused as SLO proof). Locks: availability target **99%** (2xx/total); **exact rolling PT7D** span with coverage against PT7D; **PT5M** grain; min coverage **0.5**; min requests **100**; error-budget fraction **0.01**; multi-window burns **14.4 / 6 / 3 / 1** with AND fire rule and baseline-within-one-grain slicing; latency percentile SLI **blocked** pending joint request telemetry (not part of this SLO); combined min/intersection and combined error budget **forbidden**. Ships pure dependency-free calculator + deterministic RED/GREEN verifier. Future burn-alert/drill acceptance **`defined_not_executed`** only. Does **not** deploy alerts, execute live, mutate scale, or claim production scope, live SLO compliance, backpressure runtime, autoscaling, soak, ACA duration histograms, p99≤500ms, or raise G06. Retained under 16AK tip.

## Slice 16AI

`16AI_g06_live_load_evidence` — reconciles the operator-controlled successful re-run @ `2026-07-21T16:50:16Z` of profile `16AG_DRILL_dual_staging_readyz_bounded_load` against the exact two staging `/readyz` allowlist targets, claiming **only** what committed secret-free raw fixtures prove (`slice16ai-raw-drill` + `slice16ai-raw-cost-before/after`; ephemeral `/tmp` and `tmp/` excluded; SHA-256 provenance locked): each **60/60 2xx**; concurrency peak **2**; zero timeout/error/non-2xx; WH p50/p95/p99/max **30/32/44/44ms** wall **954**; Sunset **28/29/40/40ms** wall **879**; response bodies/redirects/headers/auth/body **false**; DNS pinned; active remaining **0**. Sunset RG MTD ActualCost before/after identical **18.2443795483871 USD**. Explicitly does **not** claim pre/post `/readyz` readiness (absent from raw drill) or after-query 429/retry (no durable transcript). Records `final_controlled_drill` status **`live_proven`** for this **conservative readiness profile only**. Does **not** claim soak, alert fire/notification, autoscaling, capacity SLO/error budget live proof, backpressure runtime, production, or raising G06 to `proven`. Retained under 16AK tip. G06 remains **partial**.

## Slice 16AH

`16AH_g06_live_load_correction` — corrects `pinnedLookup` so Node Happy Eyeballs (`options.all=true`) receives a validated pinned `{address,family}[]` (scalar retained for `all=false`; family filter + exact pins retained; every pin fail-closed through `assertPublicDnsAddresses`). Offline production-shaped RED proves scalar replies fail before TLS/HTTP. Records the controlled post-16AG dual-staging `/readyz` attempt (60/60 error-before-HTTP while direct pre/post `/readyz` stayed ready) as **`attempted_not_proof`**. Retained under 16AK tip. G06 remains **partial**.

## Slice 16AG

`16AG_g06_bounded_load_harness` — dependency-free bounded Node load harness hard-locked to the two exact staging Staff API `/readyz` URLs with offline fail-closed RED/GREEN verifier. Future drill profile remains **`defined_not_executed`** as the 16AG source lock; live success ownership is 16AI. Retained under 16AK tip. G06 remains **partial**.

## Slice 16AF

`16AF_g06_capacity_alert_live_evidence` — reconciles Azure-readonly dual-staging readback of four capacity-pressure alerts + scale truth. Retained under 16AK tip. G06 remains **partial**.

## Slice 16AD

`16AD_g02_sampled_restart_continuity_evidence` — concurrent sampled revision-restart continuity retained. G02 stays **partial**.

## Slice 16AC

`16AC_organic_restart_alert_evidence` — organic RestartCount alerts fired/resolved/unsuppressed; inbox open. G02/G03 stay **partial**.

## Slice 16AB / 16AA / 16Z / 16Y / 16X / 16W / 16U / 16P / 16S (retained)

Retained as prior.
