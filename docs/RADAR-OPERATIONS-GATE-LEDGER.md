# RADAR Slice 16AM — Operations gate ledger (G06 dual-staging 16AL deploy evidence, flag OFF)

**Status:** evidence-only dual-staging deploy of 16AL with `STAFF_API_ADMISSION_CONTROL` OFF/unset (no flag enable / live shed / activation claim by this tip; G06 remains partial)
**Master basis:** `905ff9ff57a75d0b3defc15a16078b47e94e930f`
**Branch:** `radar/slice-16am-g06-backpressure-deploy-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16AL admission wire source + 16AK backpressure source + 16AJ SLO source + 16AI/16AH/16AG/16AF/16L capacity path
**This tip does not enable the flag / does not claim live shed / does not mutate scale:** durable sanitized update/readback/readyz/ACR/cost evidence only

## Outcome (16AM)

Reconcile operator dual-staging Staff API deploy of **16AL** @ master `905ff9ff` with admission flag **OFF/unset**:

| Fact | Locked value |
|------|----------------|
| Preflight | clean exact-SHA preflight passed on synchronized Lunabox master |
| Resume path | initial remote continuation stopped before build (`az` absent); resumed via authenticated local Azure CLI |
| ACR | build **cb11f** succeeded; both repos tag full SHA `905ff9ff57a75d0b3defc15a16078b47e94e930f`; digest `sha256:55ddc5ebaba3c6021b3d3a1d746935bb5dfc20b228d1de71daa97e33c6e235e1` |
| Wolfhouse | image exact tag; revision `wh-staging-staff-api--0000521` |
| Sunset | image exact tag; reported latestReady `luna-sunset-staging-staff-api--g02503r` (**unchanged name** while image readback changed; do **not** infer new revision identity beyond readback) |
| `/readyz` | both returned `{status:ready}` |
| Flag | `STAFF_API_ADMISSION_CONTROL` env query **empty/absent** both → controller remains **disabled**; **no** live backpressure/shed claimed |
| Cost | Sunset RG MTD ActualCost before/after identical **18.4680092365591 USD** |
| Proof | `16AM_EVIDENCE_dual_staging_16al_deploy_flag_off` **`live_proven`** (deploy-with-flag-OFF only) |
| Score | proven=0 / partial=9 / absent=0 — **unchanged** |

### Claim ownership (16AM locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Dual-staging 16AL image deploy + flag absent | Exact digest/tag/WH revision/Sunset latestReady/readyz/cost from committed raw fixtures | Flag enable / controller activation / live 503 shed / soak / fire / autoscale / SLO live / raising backpressure or G06 verdicts — **not claimed** |
| Sunset latestReady name unchanged while image changed | Readback honesty for g02503r | New Sunset revision identity beyond latestReady readback |
| G06 stays partial | Score preserved (0/9/0) | Raising G06 to `proven` |

## Truthful disposition (16AM)

**Proves (evidence):** Dual-staging Staff API deploy of the 16AL image at exact SHA/digest with admission flag OFF/unset, both `/readyz` ready, and Sunset MTD ActualCost unchanged; Sunset latestReady revision **name** remains `g02503r` while image tag changed.

**Does not prove:** flag enabled; admission activation; live 503 shed; load soak; alert fire/notification; autoscaling; capacity SLO live; backpressure live/proven; production; raising G06 to `proven`.

**16AL deploy-with-flag-OFF gap closed; activation/shed/soak/fire/autoscale/SLO-live remain open; G06 remains partial.**

## Outcome (16AL — retained)

Integrate the reviewed **16AK** tenant-safe admission controller into Staff API behind a fail-closed deployment flag:

| Contract | Locked value |
|----------|----------------|
| Flag | `STAFF_API_ADMISSION_CONTROL` — fail-closed parse; default **OFF**; malformed rejected; OFF exact behavior-preserving |
| Placement | `createStaffQueryApiHttpServer` after `resolveTrustedIngressBinding(...).tenant_slug`, before router body/DB/tool side effects |
| Routes | 16AK **eligible-route allowlist** only; `/healthz` `/readyz` `/` + unknown routes **excluded** |
| Tenant identity | **only** trusted ingress `tenant_slug` — never request header/query/body spoof |
| Lifecycle | release **exactly once** on finish/close/error/abort; queued disconnect cancels; queued promotion resumes handler **exactly once**; transport-dead cancel before queue and before promoted run; named once listeners detach to baseline; late events cannot cancel promoted tokens; sync/async throws clean up; `admissionBoundary.close()` at readiness-lifecycle shutdown **BEGIN** (before `server.close`, not server `close` event) via per-server Set-deduped registry/dispatcher (duplicate bind no-op; close===1; prior hook once; no wrapper chains; module-private WeakSet fired sentinel marked before snapshot; symbols cleared after fire and remain absent after reentrant/post-fire binds which immediately safe-close with `already_fired` result; independent safe invoke of prior+owners with thenable rejection absorb; OFF registers nothing) |

| Reject | public **503** + `Retry-After` only for pre-side-effect overload; post-side-effect never 503-shed; body bounded/non-sensitive |
| Proof | `16AL_INTEGRATION_staff_api_admission_wire_source` **`integration_source_proven`** (fake req/res + source locks) |
| Flag enable / live shed | **not claimed** — flag remains OFF |

### Claim ownership (16AL locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Flagged Staff API wire + deterministic integration tests | Source-proven boundary behaviors with flag OFF default | Flag enabled in staging; live 503 shed; soak; production; raising G06 |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AL)

**Proves (integration source):** Staff API HTTP-boundary wire of the 16AK controller behind fail-closed flag default OFF, with deterministic fake req/res coverage for OFF-adjacent exclusions, saturation/no-side-effect-before-admit, per-tenant isolation, spoof rejection, queued disconnect cancel, queued promotion resume-once, transport-dead pre-queue/pre-run cancel, listener baseline after promote/finish and abort/close races, throw cleanup, release-once, post-side-effect non-shed, readiness-lifecycle shutdown-BEGIN admission close via Set-deduped registry/dispatcher with WeakSet fired sentinel (not server close event; close===1; prior once; no wrapper chains; post-fire/reentrant bind immediate safe-close; thenable-safe independent invokes), and bounded public 503.

**Does not prove:** flag enabled; live 503 shed under load; load soak; autoscaling; capacity SLO live; claiming backpressure live/proven; production; raising G06 to `proven`.

**Admission wire source gap closed; live/flag-on proof remains open; G06 remains partial.**

## Outcome (16AK)

Define the smallest **tenant-safe admission controller** for future Staff API integration (no runtime wire invented):

| Contract | Locked value |
|----------|----------------|
| Topology (inspected) | `createStaffQueryApiHttpServer` → correlation → completion → `router`; health/ready at `/healthz` `/` `/readyz`; Stripe/Meta webhooks; write vs preview vs GET families — see `slice16ak-staff-api-topology.json` |
| Existing runtime backpressure | **none** (no semaphore / admission queue / 503 Retry-After shed in Staff API) |
| Limits | in-flight global **8** / queue global **16**; per-tenant in-flight **4** / queue **8**; Retry-After **1**s; diag ring **32**; tombstones **128**; tracked tenants **64** |
| Reject | HTTP **503** + `Retry-After` **only** for **pre-side-effect overload**; post-side-effect = internal continue/fail-closed (**no** `http_status` / Retry-After / retryable metadata) |
| Route class | reviewed **eligible-route allowlist**; unknown routes **default-exclude fail-closed**; **no** suffix heuristic; **no** all-router-literal coverage claim; `move-targets` read-like; `reset-luna-phone` write |
| Tenant identity | **only** `resolveTrustedIngressBinding(...).tenant_slug` — never request header/query/body spoof |
| Isolation / fairness | per-tenant caps + round-robin promote; idle empty tenant buckets + rr keys **evicted** (historical tenants do not exhaust cardinality) |
| Cleanup | `release` / `abort` / `timeout` / `close`; terminal tokens deleted + **tombstone ring**; underflow/overflow guards; reentrancy-safe promote |
| Diagnostics | aggregate/bounded counts + opaque event kinds only — **no** raw tenant identifiers/keys |
| Exclusions | `/healthz` `/readyz` `/` always excluded (readiness independence); in-progress transactional work after `markSideEffectStarted` cannot be 503-shed |
| Library | pure dependency-free `radar-g06-admission-control.js` |
| Integration drill | `16AK_INTEGRATION_staff_api_admission_wire` **`defined_not_executed`** only |
| Offline source | `16AK_OFFLINE_admission_control_source_contract` **`offline_source_proven`** |

### Claim ownership (16AK locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Topology-informed admission/backpressure source contract + pure state machine + offline RED/GREEN | Exact limits/allowlist/fail-closed behaviors exist in source | Runtime wire; live 503 shed; soak; production; sync-throw integration ownership |
| Integration drill locked | Parameters ready for a later approved wire slice | That wire ran; claiming backpressure is proven; raising G06; sync-throw ownership |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AK)

**Proves (source):** Tenant-safe admission-control / backpressure **source** contract with pure dependency-free controller and deterministic RED/GREEN covering burst, fairness, spoofed/missing tenant, queue overflow, timeout/abort/races, counter underflow/overflow, real induced reentrancy, post-side-effect internal continue, tombstone-bounded churn, idle tenant eviction (65th historical), close/shutdown settle, cross-tenant isolation, readiness independence, and opaque bounded diagnostics; Staff API integration defined only.

**Does not prove:** Staff API runtime wire; live 503 shed under load; load soak; autoscaling; capacity SLO live; claiming backpressure is proven; production; sync-throw integration ownership; raising G06 to `proven`.

**Backpressure source gap closed; runtime/live proof remains open; G06 remains partial.**

## Outcome (16AJ)

Define a finite **staging readiness** capacity SLO / error-budget **source** contract (no live proof invented):

| Contract | Locked value |
|----------|----------------|
| Metric surface (inspected) | ACA `Requests` **Total** (= Sum of request counts) split by `statusCodeCategory` (16H) — implementable availability-only |
| Latency percentile SLI | **blocked** pending joint request telemetry/instrumentation — **not part of this SLO**; no ACA duration histogram / p99≤500ms |
| Combined / intersection | **forbidden** (disjoint marginals cannot claim min/intersection or combined error budget) |
| Alert cadence (inspected) | 16L/16AF capacity PT5M/PT15M; 16H 5xx PT1M/PT5M; SLO eval grain **PT5M** |
| Availability SLI | `2xx_delta / total_delta`; target **99.0%** |
| Window / coverage | exact rolling **PT7D** span; coverage against **PT7D**; step **PT5M**; min coverage **0.5**; min requests **100** |
| Short burn windows | distinct from PT7D — coverage/span use declared burn window; baseline within one PT5M grain; reject gaps/stale |
| Error budget | availability-only fraction **0.01**; burn = `bad_rate / 0.01`; consumed = `burn * (window / PT7D)` |
| Multi-window burns | page_fast 5m+1h@**14.4**; page_slow 30m+6h@**6**; ticket_fast 2h+1d@**3**; ticket_slow 6h+3d@**1** (AND) |
| Fail-closed | missing / reset / out-of-order / zero-traffic / sparse / span mismatch / stale baseline / irregular grain / unsafe integer / NaN / latency-blocked / combined-forbidden |
| Calculator | pure dependency-free `radar-g06-slo-error-budget.js` |
| Future alert/drill | `16AJ_ALERT_*` + `16AJ_DRILL_*` **`defined_not_executed`** only |
| `final_controlled_drill` | **`offline_source_proven`** — source contract only |

### Claim ownership (16AJ locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Availability-only SLI/error-budget source contract + calculator + offline RED/GREEN | Exact math/boundaries + fail-closed states exist in source | Live SLO compliance; burn alert deploy/fire; notification; latency percentile SLO |
| Future alert/drill acceptance locked | Parameters ready for a later approved slice | That alert/drill ran; production; raising G06 |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AJ)

**Proves (source):** Finite staging readiness **availability-only** SLO/error-budget contract with pure calculator and deterministic RED/GREEN covering exact PT7D boundaries, burn baseline grain, counter resets, sparse samples, and overclaims; latency percentile SLI recorded **blocked**; future burn-alert/drill acceptance defined only.

**Does not prove:** live SLO compliance; burn alert deploy/fire/notification; load soak; autoscaling; backpressure; production; raising G06 to `proven`. Does **not** reuse 16AI drill latency as SLO proof. Does **not** claim ACA duration histograms, p99≤500ms, or combined min/intersection.

**SLO/error-budget source gap closed (availability-only); live burn/SLO proof remains open; G06 remains partial.**

## Outcome (16AI — retained)

Reconcile the successful controlled dual-staging `/readyz` bounded-load drill @ `2026-07-21T16:50:16Z` for profile `16AG_DRILL_dual_staging_readyz_bounded_load`, claiming **only** what committed secret-free raw fixtures prove (`slice16ai-raw-drill` + `slice16ai-raw-cost-before/after`; ephemeral `/tmp` and `tmp/` excluded):

| Fact | Locked value |
|------|----------------|
| Targets | exact two staging `/readyz` allowlist URLs |
| Counts | each target 60/60 2xx; peak_in_flight=2 |
| Errors | zero timeout / error / non-2xx |
| WH latency / wall | p50/p95/p99/max 30/32/44/44ms; wall 954ms |
| Sunset latency / wall | p50/p95/p99/max 28/29/40/40ms; wall 879ms |
| Transport hygiene | response bodies/redirects/headers/auth/body false; DNS pinned; active remaining 0 |
| Sunset MTD ActualCost | before=after **18.2443795483871 USD** (raw before/after JSON only) |
| Raw artifact SHA-256 | drill `58512515…`; cost-before `f2428205…`; cost-after `30453489…` |
| Explicitly omitted | pre/post `/readyz` readiness (absent from raw drill); after-query 429/retry (no durable transcript) |
| `final_controlled_drill` | **`live_proven`** — conservative readiness profile only |

### Claim ownership (16AI locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Conservative dual-staging `/readyz` bounded-load drill (raw drill JSON) | Profile success with exact counts/latency/hygiene | Pre/post readiness; soak / sustained capacity |
| Sunset MTD ActualCost identical before/after (raw cost JSON) | Cost guard unchanged across drill | 429/retry; budget anomaly / production cost |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AI)

**Proves (evidence):** Conservative dual-staging `/readyz` bounded-load profile `live_proven` with exact metrics from committed raw drill + Sunset MTD ActualCost identical before/after from committed raw cost JSON (SHA-256 provenance locked).

**Does not prove:** pre/post `/readyz` readiness; after-query 429/retry; load soak; capacity alert firing/notification; autoscaling; capacity SLO/error budget live proof; backpressure; production; raising G06 to `proven`.

**Conservative readiness profile closed as `live_proven`; soak/fire/autoscale/SLO-live/backpressure remain open; G06 remains partial.**

## Outcome (16AH — retained)

Correct the G06 bounded load harness so `pinnedLookup` honors Node’s `dns.lookup` callback contract when `options.all===true` (Happy Eyeballs / `autoSelectFamily`):

| Contract | Behavior |
|----------|----------|
| `all=true` | `callback(err, addresses[])` with validated pinned `{address,family}` entries |
| `all=false` | scalar `callback(err, address, family)` retained |
| family filter | exact pins only; miss → `RADAR_LOAD_DNS_PIN_MISS` |
| pin validation | every pin through `assertPublicDnsAddresses` before selection (`RADAR_LOAD_DNS` / `_ADDRESS` / `_FAMILY` / `_PRIVATE`; no coercion/TypeError) |
| diagnostics | safe error-code classes only (no messages/hosts/bodies) |

Offline production-shaped RED proves scalar replies under `all=true` fail **before TLS/HTTP** with `ERR_INVALID_IP_ADDRESS` via real local TLS + real Node `https.request`/`net.connect` lookup (ephemeral self-signed cert at test runtime; OpenSSL required or fail-closed). GREEN proves the corrected array contract reaches that local TLS endpoint while preserving allowlisted SNI/hostname.

### Post-16AG live attempt (cautious)

A controlled attempt of profile `16AG_DRILL_dual_staging_readyz_bounded_load` against both exact staging `/readyz` allowlist targets yielded **60/60 error-before-HTTP** while direct pre/post `/readyz` stayed ready. Root-cause class: `pinned_lookup_scalar_under_options_all_true`. Status locked as **`attempted_not_proof`** — **not** load/soak success.

### Claim ownership (16AH locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| pinnedLookup `all=true` array contract + offline RED/GREEN | Happy Eyeballs callback bug corrected in source | Live staging load/soak success |
| Live attempt `attempted_not_proof` | Cautious record of failed pre-HTTP attempt | Load success; raising G06 verdict |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AH — retained)

**Proves (source):** Corrected `pinnedLookup` Node callback contract for `all=true` with fail-closed public-address validation and offline production-shaped real-TLS proof; safe error-code class aggregation; prior live attempt classified `attempted_not_proof`.

**Does not prove (16AH alone):** live load/soak success (later conservative profile success is owned by 16AI); capacity alert firing/notification; autoscaling; capacity SLO/error budget; backpressure; production; raising G06 to `proven`.

**Pinned-lookup source gap closed; 16AH live attempt remains `attempted_not_proof`; G06 remains partial.**

## Outcome (16AG — retained)

Land a dependency-free bounded Node load harness for G06 hard-locked to the two exact staging Staff API `/readyz` URLs:

| Target | Role |
|--------|------|
| `https://staff-staging.lunafrontdesk.com/readyz` | Wolfhouse staging readiness |
| `https://sunset-staging.lunafrontdesk.com/readyz` | Sunset staging readiness |

Contract: GET only; no headers/body/auth; no redirects; TLS required; fail-closed on any other target; max duration/concurrency/request budget; **harness-owned absolute run deadline + per-request deadline** (deadline starts before DNS; DNS raced/aborted against remaining budget so missing/late callbacks settle with no request start; abort/destroy actives; settle end/aborted/error/premature-close/trickle); **unexported fixed HTTPS transport** (no caller transport escape); **fail-closed globally-routable DNS pin** (exact pinned address; IANA special-purpose IPv4/IPv6 prefix tables with explicit `globallyReachable` flags + longest-match; permit only globally reachable classifications / ordinary public unicast; rejects multicast and non-global specials including 192.88.99.0/24, 2001:2::/48, 2001:10::/28 while allowing globally reachable 192.0.0.9/32, 192.0.0.10/32, 2001:20::/28); **monotonic internal latency** (transport latency ignored); aggregate counts + p50/p95/p99/max + timeout/error/status classes; **no response bodies**.

Offline fail-closed (http/https/net/DNS sealed) RED/GREEN verifier covers bounds, concurrency, redirects, target escape, latency percentiles, non-2xx, hanging/trickle/abort/close settle, deadline cleanup, DNS private/IANA-special-purpose table-driven reject/allow, hanging/late DNS settle, header/body/auth not sent, and transport escape.

Conservative future drill profile `16AG_DRILL_dual_staging_readyz_bounded_load` is **defined_not_executed** (concurrency=2, max_duration_ms=30000, max_requests=60, request_timeout_ms=4000).

### Claim ownership (16AG locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Harness source + offline verifier | Bounded allowlisted `/readyz` load tooling exists with fail-closed escapes | Live staging load/soak execution |
| Future drill profile locked | Conservative parameters ready for a later approved drill | That drill ran; SLO; backpressure; autoscaling |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AG)

**Proves (source):** Dependency-free bounded `/readyz` load harness hard-locked to the two staging URLs with offline fake-server accounting proof; future drill profile defined.

**Does not prove:** live load/soak; capacity alert firing/notification; autoscaling; capacity SLO/error budget; backpressure; production; raising G06 to `proven`.

**Load-harness source gap closed; live load/soak remains open; G06 remains partial.**

## Outcome (16AF — retained)

Reconcile live dual-staging readback of the four deployed Staff API capacity-pressure metric alerts and current scale truth @ `2026-07-21T14:30:07Z`:

| Tenant | Alerts (Enabled Sev2) | Criterion | Scale truth |
|--------|----------------------|-----------|-------------|
| Wolfhouse `wh-staging-staff-api` | `wolfhouse-staff-api-cpu-pressure` (CpuPercentage) + `wolfhouse-staff-api-memory-pressure` (MemoryPercentage) | Average >80; PT5M eval / PT15M window; scoped to app; AG `wh-staging-ops-budget-ag` | minReplicas=0 maxReplicas=1 rules=null; latest=latestReady `wh-staging-staff-api--g02503r`; Single / 100% |
| Sunset `luna-sunset-staging-staff-api` | `sunset-staff-api-cpu-pressure` + `sunset-staff-api-memory-pressure` | same | minReplicas=1 maxReplicas=1 rules=null; latest=latestReady `luna-sunset-staging-staff-api--g02503r`; Single / 100% |

Action groups enabled; receiver name `ops-email` status Enabled; **address intentionally not recorded**; notification/inbox delivery **unproven**.

### Claim ownership (16AF locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Four capacity alerts Enabled with exact metric/threshold/window/scope/AG | Alert **deployment** gap closed | Alert firing; notification delivery; human inbox |
| Scale truth min/max/rules null + latest=latestReady g02503r | Current bounds/revision identity | Autoscaling; load-driven scale-out; replica mutation by this slice |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven`; load/soak; SLO/error budget; backpressure; production |

## Truthful disposition (16AF)

**Proves (live):** Four capacity-pressure alerts deployed Enabled Sev2 Average >80 PT5M/PT15M on exact Staff API app scopes wired to tenant ops AGs; current scale truth WH min0/max1/rules null and Sunset min1/max1/rules null with latest=latestReady g02503r.

**Does not prove:** capacity alert firing/notification; load/soak; autoscaling; capacity SLO/error budget; backpressure; production; raising G06 to `proven`.

**Alert-deployment gap closed; G06 remains partial** (firing/notification, load/soak, autoscaling, SLO/error budget, backpressure open).

## Outcome (16AD — retained)

Reconcile the completed dual-staging **concurrent sampled revision-restart continuity drill** with mandatory provenance split:

| Class | Source | Covers |
|-------|--------|--------|
| **A** | Operator drill transcript (contemporaneous) | Bounded sequential public `/healthz` + `/readyz` poller (max-time 4s, ~1s cadence) during `az containerapp revision restart`. **WH** samples `0..90` @ `13:21:11Z–13:23:17Z`; samples `0..2` **timeout** during initial scale-from-zero warmup **before restart** — **disclosed and excluded** from the restart-window claim; samples `3..90` all health=200 ready=200; restart command window exact `13:21:47Z–13:21:50Z`; samples `8@47`, `9@48`, `10@49`, `11@50` all both 200. **Sunset** samples `0..90` @ `13:23:39Z–13:25:18Z` all both 200; restart `13:23:54Z–13:23:58Z`; samples `14@54`, `15@56`, `16@57`, `17@58` all both 200 |
| **B** | Independently reverified Azure/LAW/public @ `2026-07-21T13:29:32Z` | LAW SIGTERM completions: WH `13:22:29.3669823Z` revision `wh-staging-staff-api--g02503r` replica `…-9764596b8-mgfw2`; Sunset `13:24:29.7970752Z` revision `luna-sunset-staging-staff-api--g02503r` replica `…-f4d4b7875-dw7cx`; allowlisted payload `original_signal=SIGTERM` pool/server ok `failure_classes=[]` `completion=true`. Both apps **Single / latest / latestReady / 100%**; digests on image SHA `95dc363`; public-current healthz/readyz **200** |

### Claim ownership (16AD locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Concurrent poll during restart (after WH warmup exclusion) | No observed public interruption **at this sampling resolution** during declared restart command windows after warmup | Absolute/continuous zero downtime; between-sample proof; no sub-second interruption; cold-start availability; all 91 WH passed; production; raising G02 to proven |
| WH warmup timeouts 0..2 | Disclosed + excluded; cold-start remains real | Restart-window failure; hidden failures |
| LAW SIGTERM + current Azure | Exact timestamps/replicas/payload; Single/latest/latestReady/100%; public current 200 | Historical poll arrays; absolute zero downtime |

## Truthful disposition (16AD)

**Proves (live):** No observed public `/healthz`+`/readyz` interruption at the declared sampling resolution during the declared restart command windows on both staging tenants **after** WH warmup exclusion, with exact LAW SIGTERM cleanup telemetry and final Single/latest/latestReady/100%.

**Does not prove:** absolute/continuous zero downtime; proof between samples; absence of sub-second interruption; cold-start availability (WH warmup timeouts remain real); production; raising G02 to `proven`.

**Concurrent sampled restart continuity gap closed; G02 remains partial** (production intentionally untouched / acceptance policy).

## Outcome (16AC — retained)

Organic Azure Monitor RestartCount alerts fired/resolved/unsuppressed both staging apps; temporally associated with 16AA SIGINT; inbox/unique-causality/5xx open. G02/G03 stay partial.

## Outcome (16AB — retained)

Serving-revision `/readyz=503` `{status:not-ready}` on isolated fail revisions; public healthy stayed 200; `observed_at=unavailable_in_command_transcript`. Azure cannot recreate historical localhost 503/body. G02 stays partial.

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Full E2E close — not met |
| `partial` | 9 | Code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (16S live + 16U design freeze; G01-A live open) |
| G02 | Readiness / dependencies | `partial` (**16AD** sampled restart continuity; **16AC** organic restart alerts; **16AB** serving `/readyz=503`; **16AA** SIGINT; **16Z** SIGTERM; **16X** traffic-shed; absolute zero-downtime / cold-start / production still open) |
| G03 | Actionable tenant-aware alerts | `partial` (**16AC** organic restart fire/resolve + **16P** AG test API; human inbox still open) |
| G04–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)


### 16AG_g06_bounded_load_harness

Bounded staging `/readyz` load harness — retained under 16AJ tip. Closes only G06 load-harness **source** gap. Live load/soak execution, alert fire/notification, autoscaling, SLO/error budget live proof, backpressure remain open. Future drill defined_not_executed. G06 stays partial.

### 16AF_g06_capacity_alert_live_evidence

Capacity-alert deploy + scale-truth evidence — retained under 16AG tip. Closes only G06 alert-deployment gap. Firing/notification, load/soak, autoscaling, SLO/error budget, backpressure remain open. G06 stays partial.

### 16AD_g02_sampled_restart_continuity_evidence

Concurrent sampled revision-restart continuity — retained under 16AF tip. Sampling-resolution claim after WH warmup exclusion only. G02 stays partial.

### 16AC_organic_restart_alert_evidence

Organic restart alert evidence — retained. Inbox open. G02/G03 stay partial.

### 16AB_g02_serving_readyz_503_body_path_evidence

Serving-revision `/readyz=503` body-path — retained.

### 16AA_g02_live_sigint_lifecycle_evidence

Dual-staging live SIGINT drill evidence — retained. Provenance split (A)/(B): operator-observed `az containerapp exec` + `kill -INT 1` + ClusterExecFailure exit 137 (**az containerapp exec transport/process-termination disconnect only** — not an application failure; **not proof of** application/Node process native exit status, shell code, signal encoding, or ACA restart reason) + post-drill `/readyz=200`. Independent Azure/ACR/LAW class B: **Independent LAW allowlisted record — not 137 —** evidences `original_signal=SIGINT` and pool/server cleanup; bounded inclusive drill query windows WH `12:08:00Z→12:09:00Z` / Sunset `12:09:00Z→12:10:00Z`; other revision-lifetime records disclosed (WH SIGTERM `11:16:20.3631884Z` etc.) — revision-lifetime count is not one. Serving `/readyz=503` closed via 16AB; organic restart alerts via 16AC; concurrent sampled continuity via 16AD tip. G02 stays partial.

### 16Z_g02_live_sigterm_lifecycle_evidence

Dual-staging live SIGTERM drill evidence — retained. LAW exactly one allowlisted SIGTERM completion each tenant in declared drill query windows (WH restart `11:15:18Z` window cardinality); post-restart recovery samples were **not** concurrent continuity (closed via 16AD tip). G02 stays partial.

### 16Y_readiness_shutdown_completion_log

Source observability for readiness shutdown completion — retained.

### 16X_g02_lifecycle_deploy_traffic_shed_live_evidence

Dual-staging exact-SHA `2dcda08` deploy + Activating traffic-shed drill — retained with (A)/(B) provenance.

### 16W_readiness_shutdown_lifecycle

Source wiring of `closeReadinessPool` on SIGTERM/SIGINT — retained.

### 16S_request_completion_log_live_evidence

Dual-staging LAW delivery/search/retention @ SHA `1bf9695` — retained. Meta→Hermes E2E still open as G01-A.

### 16U_correlation_design_freeze

Audit-only G01 design freeze — live Caddy `/whatsapp/*` → **8092** (`hermes-sunset-luna`); `/wolfhouse/*` → `:8090` (`hermes-luna`). Tracked Caddy reference is **stale** evidence, not live authority. **G01-A** Meta→Hermes→Staff open. **Independent same-ID probes are not E2E evidence.** Genuine Stripe Checkout **cannot be exercised without mutation**; G01-B is **tenant/payment/booking/session metadata only**. Dry-run phrase **`RADAR-16U-CORRELATION-DRY-RUN`** reserved; **not implementable yet** (blocked on **central capability boundary**). Coalesced burst provenance uses ordered immutable **source-wamid** set.

### 16P_live_drill_evidence_reconciliation (retained)

Bounded operator-observed facts @ image **594247f** — retained. **Does not claim** human inbox / organic metric alert as inbox proof / production / end-to-end gate close.

### 16O / G05 / G06 / G08 (retained partials)

- **16O** — Stripe webhook error minimization (G08 partial).
- **G05** — 16M Stripe webhook event-id claim (source partial; live drill open).
- **G06** — **16AH** corrects pinnedLookup Happy Eyeballs `all=true` contract and records prior live attempt as `attempted_not_proof`; **16AG** source-closes bounded load harness; **16AF** live-proves capacity-alert deploy; **16L** source retained; live load/soak success, alert fire/notification, autoscaling, SLO/backpressure open (G06 remains partial).
- **G08** — 16O/16P webhook error minimization + privacy drill partial; abrupt/retention/search open.

## G02 semantics (truthful after 16AD)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `live_present` | verified on serving revisions |
| Healthy-path live health/ready | `live_proven` | 16P + later |
| closeReadinessPool lifecycle source | `source_closed_16W` | SIGTERM/SIGINT CLI main |
| Shutdown completion log source | `source_closed_16Y` | one JSON record per shutdown |
| Live lifecycle image deploy | `live_proven_16X` / `95dc363 via 16Z/16AA/16AB` | exact SHA both tenants |
| Dependency-failure traffic-shed drill | `live_proven_16X` | Activating never latestReady |
| SIGTERM live cleanup telemetry | `live_proven_16Z` | LAW drill-window cardinality |
| SIGINT live cleanup telemetry | `live_proven_16AA` | LAW drill-window cardinality |
| Serving-revision /readyz=503 path | `live_proven_16AB` | isolated fail local 503 |
| Organic restart metric alert firing | `live_proven_16AC` | fired/resolved/unsuppressed |
| Concurrent sampled restart continuity | `live_proven_16AD` | sampling resolution after WH warmup exclusion |
| Absolute/continuous zero downtime | `open` / `not claimed` | between-sample / sub-second not claimed |
| Cold-start availability | `open` / `not claimed` | WH warmup timeouts remain real |
| Production | `open` / forbidden | intentionally untouched |

## Slice 16AD artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ad-g02-sampled-restart-continuity-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16ad-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16ad-g02-sampled-restart-continuity-evidence.js` | Locks |
| `scripts/verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js` | Strict RED/GREEN verifier |


## G06 semantics (truthful after 16AL)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Capacity-pressure alert IaC (16L) | `source_closed_16L` | CpuPercentage + MemoryPercentage Average >80 |
| Capacity-pressure alert live deploy | `live_proven_16AF` | four alerts Enabled Sev2 PT5M/PT15M exact scopes/AGs |
| Current scale truth | `live_recorded_16AF` | WH min0/max1/rules null; Sunset min1/max1/rules null; g02503r |
| Bounded `/readyz` load harness | `source_closed_16AG` | hard-locked two staging URLs; offline fake-server verifier |
| pinnedLookup Happy Eyeballs `all=true` | `source_corrected_16AH` | validated pinned address array callback contract |
| Future load drill profile (16AG lock) | `defined_not_executed_16AG` | 16AG source lock retained |
| Post-16AG live load attempt | `attempted_not_proof_16AH` | 60/60 error-before-HTTP; retained |
| Conservative dual-staging `/readyz` bounded-load | `live_proven_16AI` | 60/60 2xx both; peak2; exact latency/wall; cost before=after; raw SHA-256 bound; no pre/post or 429 claim |
| Capacity SLO / error budget **source** | `source_defined_16AJ` | finite staging SLI + calculator + offline verifier; future alert/drill `defined_not_executed` |
| Capacity SLO / error budget **live** | `open` / `not claimed` | 16AJ does not claim live compliance |
| Alert fire / notification delivery | `open` / `not claimed` | |
| Load soak / sustained capacity | `open` / `not claimed` | 16AI does not claim soak |
| Autoscaling | `open` / `not claimed` | rules=null |
| Backpressure / admission **source** | `source_defined_16AK` | topology-informed contract + pure controller + offline verifier |
| Backpressure / admission **wire source** | `integration_source_proven_16AL` | Staff API wire behind flag default OFF; fake req/res integration tests |
| Backpressure / admission **runtime/live** | `open` / `not claimed` | flag not enabled; no live 503 shed claimed |
| Production | `open` / forbidden | intentionally untouched |

## Slice 16AL artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16al-g06-backpressure-wire-contract.json` | Frozen wire contract (flag_enabled=false) |
| `fixtures/radar-operations/slice16al-expected-contract.json` | Contract |
| `scripts/lib/staff-api-admission-boundary.js` | HTTP-boundary wire + flag parse |
| `scripts/lib/radar-slice16al-g06-backpressure-wire.js` | Locks |
| `scripts/verify-radar-slice16al-g06-backpressure-wire.js` | Strict RED/GREEN + fake req/res integration |
| `scripts/staff-query-api.js` | Optional admitAndRun in createStaffQueryApiHttpServer |

## Slice 16AK artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ak-g06-backpressure-contract.json` | Frozen admission/backpressure source contract |
| `fixtures/radar-operations/slice16ak-expected-contract.json` | Contract |
| `fixtures/radar-operations/slice16ak-staff-api-topology.json` | Inspected topology classification |
| `scripts/lib/radar-g06-admission-control.js` | Pure dependency-free state machine |
| `scripts/lib/radar-slice16ak-g06-backpressure.js` | Locks |
| `scripts/verify-radar-slice16ak-g06-backpressure.js` | Strict RED/GREEN verifier |

## Slice 16AJ artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16aj-g06-slo-error-budget-contract.json` | Frozen SLI/error-budget source contract |
| `fixtures/radar-operations/slice16aj-expected-contract.json` | Contract |
| `scripts/lib/radar-g06-slo-error-budget.js` | Pure dependency-free calculator |
| `scripts/lib/radar-slice16aj-g06-slo-error-budget.js` | Locks |
| `scripts/verify-radar-slice16aj-g06-slo-error-budget.js` | Strict RED/GREEN verifier |

## Slice 16AI artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ai-raw-drill.json` | Secret-free durable raw drill JSON (SHA-256 locked) |
| `fixtures/radar-operations/slice16ai-raw-cost-before.json` | Secret-free durable Sunset MTD ActualCost before |
| `fixtures/radar-operations/slice16ai-raw-cost-after.json` | Secret-free durable Sunset MTD ActualCost after |
| `fixtures/radar-operations/slice16ai-g06-live-load-evidence.json` | Locked evidence + lock_hash + raw provenance |
| `fixtures/radar-operations/slice16ai-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16ai-g06-live-load-evidence.js` | Locks |
| `scripts/verify-radar-slice16ai-g06-live-load-evidence.js` | Strict RED/GREEN verifier |

## Slice 16AH artifacts

| Path | Role |
|------|------|
| `scripts/lib/radar-g06-bounded-load-harness.js` | Harness + pinnedLookup correction + safe error-code classes |
| `scripts/lib/radar-slice16ah-g06-live-load-correction.js` | Locks |
| `scripts/verify-radar-slice16ah-g06-live-load-correction.js` | Offline production-shaped RED/GREEN verifier |
| `fixtures/radar-operations/slice16ah-expected-contract.json` | Contract |

## Slice 16AG artifacts

| Path | Role |
|------|------|
| `scripts/lib/radar-g06-bounded-load-harness.js` | Dependency-free harness |
| `scripts/lib/radar-slice16ag-g06-bounded-load-harness.js` | Locks |
| `scripts/verify-radar-slice16ag-g06-bounded-load-harness.js` | Offline fake-server RED/GREEN verifier |
| `fixtures/radar-operations/slice16ag-expected-contract.json` | Contract |

## Slice 16AF artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16af-g06-capacity-alert-live-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16af-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16af-g06-capacity-alert-live-evidence.js` | Locks |
| `scripts/verify-radar-slice16af-g06-capacity-alert-live-evidence.js` | Strict RED/GREEN verifier |

## Still open

1. Capacity alert firing / notification delivery — **not claimed**
2. Load soak / sustained capacity — **not claimed** (16AI `live_proven` is conservative `/readyz` bounded profile only; 16AH prior attempt remains `attempted_not_proof`; 16AG profile lock remains `defined_not_executed`)
3. Autoscaling (rules=null) — **not claimed**
4. Capacity SLO / error budget **live** proof — **not claimed** (16AJ source contract only; burn alert/drill `defined_not_executed`)
5. Backpressure **runtime/live** proof — **not claimed** (16AK source + 16AL wire source behind flag default OFF; flag not enabled)
6. Absolute/continuous zero downtime / between-sample / sub-second interruption — **not claimed**
7. Cold-start availability — **not claimed** (WH warmup timeouts remain real)
8. G01-A live Meta→Hermes→Staff correlated read path
9. Human inbox receipt — **not claimed**
10. Unique causality beyond platform alert fields — **not claimed**
11. Requests 5xx alert firing — **not claimed**
12. Production — forbidden
13. Raising any gate verdict to `proven`
