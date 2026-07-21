# RADAR findings (16A freeze + 16B–16Z partials + 16AA–16AD G02 + 16AF–16AO G06 + **16AP finite closeout**)

**Master basis (16AP):** `66e34a5833ff3bcc7f297108f594b4fc58a0eccc`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16AP progress class:** `finite_milestone_closeout_staging_readiness_only` (executive freeze of score **0/9/0** + exact evidence classes G01–G09; RADAR **current-stage complete** under bounded staging-readiness exit only; formal gates remain **partial**; objective reopen triggers + unconditional break-glass + FACTORY handoff locked; docs/fixtures/verifier only — **not** an implementation expansion; does **not** raise proven, erase gaps, claim production, or authorize endless discretionary RADAR slices absent reopen; break-glass urgent work may start immediately).
**16AO progress class (retained):** `partial_live_proven_evidence_only` (corrected dual-staging **admission activation** of 16AN image @ `9da228436c21bf7777cee553c91877a7e62a4092`; ACR cb11g + digest locked; Sunset `--0000282`; WH `--0000524` off then `--0000525` on; both flags true; 80/80 invalid-signature probes **expected 403** prove auth-rejection/healthy activation only — **not** overload shed; Sunset MTD ActualCost identical **18.5705435806452 USD** delta 0 covers build/deploy/elapsed MTD not causal feature cost; G06 remains partial).
**16AN progress class (retained):** `source_deploy_config_partial_progress_only` (dedicated `STAFF_API_INGRESS_TENANT_SLUG` + Wolfhouse/Sunset staging IaC; failed WH canary recorded as **identity fail-closed** not overload shed).
**16AM progress class (retained):** `partial_live_proven_evidence_only` (dual-staging **deploy** of 16AL Staff API image with `STAFF_API_ADMISSION_CONTROL` **OFF/unset**; ACR cb11f + digest/tag locked; WH revision `0000521`; Sunset latestReady `g02503r` name unchanged while image changed; both `/readyz` ready; Sunset MTD ActualCost identical **18.4680092365591 USD**; does **not** claim flag enable, live shed, raising backpressure/G06 verdicts; G06 remains partial).
**16AL progress class (retained):** `integration_source_partial_progress_only` (Staff API admission-control **wire** behind flag default **OFF**; deterministic fake req/res integration source proof).
**16AK progress class (retained):** `source_partial_progress_only` (tenant-safe admission/backpressure source contract + pure state machine + offline RED/GREEN).
## Verdict rollup

| Verdict | Count |
|--------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly retained by 16AP freeze)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); live open.
2. **Central capability boundary** — prerequisite before dry-run.
3. Capacity alert firing / notification delivery — **not claimed**.
4. Load soak / sustained capacity — **not claimed** (16AI proves only the conservative `/readyz` bounded profile).
5. Autoscaling (rules=null) — **not claimed**.
6. Capacity SLO / error budget **live** proof — **not claimed** (16AJ defines availability-only source contract + calculator only; burn alert/drill acceptance `defined_not_executed`).
7. Latency percentile SLI — **blocked** pending joint request telemetry/instrumentation (not part of 16AJ SLO; no ACA duration histogram / p99≤500ms / combined intersection).
8. Backpressure **runtime/live** / queue-overflow **503 overload shedding** — **not claimed** (16AO proves flag-on activation + invalid-signature **403 auth-rejection** path only; not overload shed / fairness).
9. Fairness under contention — **not claimed**.
10. Absolute/continuous zero downtime / cold-start — **not claimed** (16AD sampling-resolution only).
11. Human inbox receipt — **not claimed** (organic restart fire closed via 16AC).
12. Requests 5xx alert firing — **not claimed**.
13. Production — forbidden.
14. Raising any gate verdict to `proven`.
15. Endless additional RADAR implementation slices without reopen trigger — **blocked by 16AP**.

## Gate progress after 16AP (truthful freeze)

| Gate | evidence_class | Notes |
|------|----------------|-------|
| G01 | staging_live_partial | 16S LAW retained; G01-A live open |
| G02 | staging_live_partial | **16AD** sampled restart continuity; absolute zero-downtime / cold-start / production open |
| G03 | staging_live_partial | **16AC** organic restart fire/resolve + **16P** AG test; human inbox open |
| G04 | source_partial | backlog/DLQ open |
| G05 | source_partial | 16M event-id claim; live drill open |
| G06 | staging_live_partial | **16AO** activation (403 auth-rejection only); overload-shed/fairness/soak/fire/autoscale/SLO-live/backpressure-proven open |
| G07 | staging_live_partial | via 16P rollback |
| G08 | staging_live_partial | via 16P/16O webhook error minimization |
| G09 | staging_live_partial | via 16P AG test |

## Slice 16AP

`16AP_finite_milestone_closeout` — docs/fixtures/verifier-only finite milestone closeout from master `66e34a5833ff3bcc7f297108f594b4fc58a0eccc`. Freezes score **0/9/0**, exact evidence class per G01–G09 (source-proven vs staging-live partial vs production-only unknowns), residual risks (all 10 with severity/owner/description/status) + deferred owners, objective reopen triggers with locked IDs/descriptions/thresholds/applicability (production launch / third-tenant FACTORY / traffic-cost threshold / incident / security boundary change), unconditional break-glass (incident containment, credential compromise, vuln/security remediation, legal/compliance, availability/data-integrity safety fix at any severity — work may start immediately; evidence/reopen bookkeeping follows after stabilization), and short FACTORY handoff gate. Marks RADAR **current-stage complete** only under bounded staging-readiness exit while retaining all nine formal gates **partial**. Sole production `validateCloseout` lives in deep-frozen `module.exports` (closes over private locks; executable verifier imports it — no local duplicate). Export immutability covers post-require assignment/redefinition only — **not** `require.cache`/code-injection defense. Deterministic verifier deep-compares canonical locks (not fixture-as-oracle), rejects score inflation, gap deletion/mutation, residual-risk deletion, trigger circular/impossible weakening, owner/severity drift, handoff weakening, break-glass deletion, unsupported live/production claims, and endless discretionary RADAR slices absent reopen. **Does not** mutate runtime/IaC/live, raise any gate to proven, erase gaps, or claim production ready. G06 honesty retained: exact-SHA deploy + bounded readiness load + SLO source + backpressure source/wire/deploy/activation + failed identity canary/rollback/correction evidenced; overload shed/fairness/soak/autoscale/live SLO/alert fire/production remain open.

**Post-stabilization break-glass bookkeeping (availability/data-integrity; not a discretionary slice):** after PR #137 merged candidate `7870a9fb` into master `b9feab24`, detached-master C1 failed solely on branch name `HEAD` (110/1); follow-on correction removed branch-name trust (spoofable `branchName===locks.BRANCH`) and aligned operations ledger F48 to the same mandatory ancestry helper (was 247/1). Every tip must pass `git merge-base --is-ancestor` exact candidate `7870a9fb…`; matrix/contract/`selected_16ap` pins stay exact; spoofed locked-branch + pre-candidate/`66e34a58`/orphan/invalid tips reject. Score/evidence/gaps remain **0/9/0** unchanged.

## Slice 16AO

`16AO_g06_backpressure_activation_evidence` — evidence-only reconciliation of **corrected dual-staging admission activation** of the 16AN ingress-binding image @ master `9da228436c21bf7777cee553c91877a7e62a4092`. Operator facts locked via committed secret-free raw fixtures (sanitized update/readbacks, ACR digest, Sunset MTD cost, labeled operator-attested probe/env facts; SHA-256 provenance): historical Wolfhouse failed canary `--0000522` 80/80 **503** was **identity fail-closed** (not overload shed) rolled to `--0000523`; ACR **cb11g** digest `sha256:46ebd0a8ab4dd7c9a6ac92d4003c1f0fbaf9d664f8c35c1ae1810becc3a7b655`; Sunset `--0000282` ingress=`sunset` admission true; WH `--0000524` admission false then `--0000525` admission true + ingress `wolfhouse-somo`; both flags true; 80/80 invalid-signature probes **expected 403** prove auth-rejection/healthy activation only; Sunset MTD ActualCost before/after identical **18.5705435806452 USD** (delta 0; covers build/deploy/elapsed MTD not causal feature cost). Strict REDs for digest/tag/revision/overload-shed/overclaim drift. **Does not** claim queue-overflow/503 overload shedding, fairness, soak, autoscale, SLO, alerts, backpressure proven, production, or raise G06 verdict. Score unchanged (proven=0 / partial=9 / absent=0). G06 remains **partial**.

## Slice 16AN

`16AN_g06_wolfhouse_ingress_binding` — diagnose operator-observed Wolfhouse admission activation failure: Sunset (`DEFAULT_CLIENT_SLUG=sunset`, flag true, `--0000281`) returned expected **403** on 80/80 invalid-signature probes with ready **200**; Wolfhouse (no `DEFAULT_CLIENT_SLUG`, flag true, `--0000522`) returned **503** on 80/80 same probes with ready **200**; operator rolled Wolfhouse flag false (`--0000523`, probe **403**); Sunset remains true. Root cause: `resolveTrustedIngressBinding` used only `DEFAULT_CLIENT_SLUG` → missing identity → **identity fail-closed** (not overload shed). Safety: setting Wolfhouse `DEFAULT_CLIENT_SLUG=wolfhouse-somo` alone rejected (unrelated portal/payment/bot/Stripe semantic risk). Ships dedicated immutable **`STAFF_API_INGRESS_TENANT_SLUG`** preferred over `DEFAULT_CLIENT_SLUG` with conflict fail-closed; Wolfhouse Bicep `=wolfhouse-somo` without `DEFAULT_CLIENT_SLUG`; Sunset Bicep `=sunset` matching existing default; REDs for missing/conflict/spoof/OFF parity. **Does not** live-deploy, enable the flag, claim overload shed, or raise G06 verdict. Score unchanged (proven=0 / partial=9 / absent=0). G06 remains **partial**.

## Slice 16AM

`16AM_g06_backpressure_deploy_evidence` — evidence-only reconciliation of dual-staging Staff API deploy of **16AL** @ master `905ff9ff57a75d0b3defc15a16078b47e94e930f` with `STAFF_API_ADMISSION_CONTROL` **OFF/unset**. Operator facts locked via committed secret-free raw fixtures (sanitized update/readback, `/readyz`, ACR digest, Sunset MTD cost before/after; SHA-256 provenance): clean exact-SHA preflight on synchronized Lunabox master; remote continuation stopped before build (`az` absent) then resumed via authenticated local Azure CLI; ACR build **cb11f**; both repos full SHA tag + digest `sha256:55ddc5ebaba3c6021b3d3a1d746935bb5dfc20b228d1de71daa97e33c6e235e1`; Wolfhouse image exact tag + revision `wh-staging-staff-api--0000521`; Sunset image exact tag + reported latestReady `luna-sunset-staging-staff-api--g02503r` (**disclose revision name unchanged while image readback changed**; do **not** infer new revision identity beyond readback); both `/readyz` `{status:ready}`; admission env query empty both so controller remains disabled and **no** live backpressure/shed claimed; Sunset MTD ActualCost before/after identical **18.4680092365591 USD**. Strict REDs for digest/tag/revision/flag/readiness/cost/overclaim drift. **Does not** enable the flag, claim live shed, or raise G06 verdict. Score unchanged (proven=0 / partial=9 / absent=0). G06 remains **partial**.

## Slice 16AL

`16AL_g06_backpressure_wire` — integrate the reviewed **16AK** admission controller into Staff API `createStaffQueryApiHttpServer` behind fail-closed deployment flag **`STAFF_API_ADMISSION_CONTROL` default OFF**. Placement: after `resolveTrustedIngressBinding(...).tenant_slug`, before router body/DB/tool side effects; **eligible-route allowlist only**; `/healthz` `/readyz` `/` and unknown routes **excluded**. Response lifecycle releases **exactly once** on finish/close/error/abort; queued disconnect cancels; queued promotion resumes handler exactly once; transport-dead cancel before queue and before promoted router execution; named once listeners detach to baseline; late events cannot cancel promoted tokens; sync/async throws clean up; `admissionBoundary.close()` at readiness-lifecycle shutdown **BEGIN** (before `server.close` waits on connections — not the server `close` event) via per-server **Set-deduped registry/dispatcher** with module-private **WeakSet fired sentinel** (duplicate bind no-op; close exactly once; prior hook once; no wrapper chains; mark fired before snapshot; symbols cleared after fire; reentrant/post-fire bind immediately safe-closes with documented `already_fired` result and no symbol reinstall; independent safe invoke of prior+owners absorbs sync throws and thenable rejections / getter-call adversaries; OFF registers nothing); post-side-effect work is never 503-shed; public 503 body/Retry-After bounded/non-sensitive. Flag parsing rejects malformed values; OFF is exact behavior-preserving. Ships `staff-api-admission-boundary.js` + deterministic fake req/res integration tests including adversarial REDs. **Does not** enable the flag, deploy, run live load, or claim live shed or raise backpressure/G06 verdicts. Score unchanged (proven=0 / partial=9 / absent=0). G06 remains **partial**.

## Slice 16AK

`16AK_g06_backpressure_source` — text/source-only tenant-safe Staff API **admission-control / backpressure** contract informed by inspected `staff-query-api.js` request topology (entry order, `/healthz`/`/readyz` exclusions, Stripe/Meta webhooks, write vs preview vs GET families). Trusted admission tenant source is **only** `resolveTrustedIngressBinding(...).tenant_slug` — never request spoof. Reviewed **eligible-route allowlist** (unknown default-exclude fail-closed; **no** suffix heuristic; **no** all-router-literal coverage claim); classifies `POST /staff/bookings/move-targets` as read-like and `POST /staff/test/reset-luna-phone` as write. Locks ceilings (in-flight global **8** / queue **16**; per-tenant **4**/**8**; Retry-After **1**s; tombstones **128**). Fail-fast **503** only for **pre-side-effect overload**; post-side-effect rejection is internal continue/fail-closed with **no** http_status/Retry-After/retryable metadata. Per-tenant isolation + round-robin; idle empty tenant buckets/rr keys evicted; terminal tokens deleted via tombstone ring; `close()` rejects queued pre-side-effect work and settles state; diagnostics are aggregate/opaque only (no tenant slugs). Ships pure dependency-free state machine + deterministic RED/GREEN (incl. real induced reentrancy, large churn, 65th historical tenant). Staff API integration drill was **`defined_not_executed`** at the 16AK tip (wire ownership deferred to **16AL**). **Sync-throw integration ownership was explicitly not claimed by 16AK**. Does **not** deploy, execute live/load/soak, mutate scale, or claim production scope, backpressure proven, autoscaling, or raise G06 verdict.

## Slice 16AJ

`16AJ_g06_slo_error_budget_source` — text/source-only **availability-only** staging readiness SLO/error-budget contract informed by existing Azure Container Apps `Requests` Total (Sum of request counts) / `statusCodeCategory` metric surface (16H), PT5M/PT15M capacity-alert cadence (16L/16AF), and 16AI conservative `/readyz` observability (not reused as SLO proof). Locks: availability target **99%** (2xx/total); **exact rolling PT7D** span with coverage against PT7D; **PT5M** grain; min coverage **0.5**; min requests **100**; error-budget fraction **0.01**; multi-window burns **14.4 / 6 / 3 / 1** with AND fire rule and baseline-within-one-grain slicing; latency percentile SLI **blocked** pending joint request telemetry (not part of this SLO); combined min/intersection and combined error budget **forbidden**. Ships pure dependency-free calculator + deterministic RED/GREEN verifier. Future burn-alert/drill acceptance **`defined_not_executed`** only. Does **not** deploy alerts, execute live, mutate scale, or claim production scope, live SLO compliance, backpressure runtime, autoscaling, soak, ACA duration histograms, p99≤500ms, or raise G06 verdict. Retained under 16AK tip.

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
