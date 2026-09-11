# Luna Reliability — plan of record

**Outcome:** make Luna's guest-facing behaviour reliably testable against the exact serving Sunset staging runtime before broadening scenarios or permitting any booking/payment effect.

**Project state:** LR1 CLEARANCE complete as a scope and admission contract. This document does not authorize a guest send, booking write, payment-link write, production operation, `/sethome`, or an Owner Lab build.

**Mandatory status bar:** `Phase/chapter LRx.y | Status Not started|Ready|Active|Blocked|Done | Evidence/blocker one line | Next gate`.

Example while operating this chapter: `LR1.3 Safe test path | Active | exact Sunset runtime admitted by authenticated preflight | next: run one allowlisted case`.

## Outcome-first gates

A chapter advances only when its externally observable outcome and safety evidence are both present. Existing contracts, fixtures, runners, and runtime owners are reused before adding another layer. A passing offline fixture is not live-runtime evidence; a live response without settled no-effect counters is not acceptance.

## Reuse audit

| Need | Existing owner to reuse | LR1 decision |
|---|---|---|
| Sunset identity, service flow, tool truth | `docker/hermes-sunset/SOUL.md` | Reference; do not redefine services. |
| Catalog/quote/domain contract | Sunset Staff API plugin and `scripts/lib/sunset-lesson-availability.js` | Staff API remains the only fact authority. |
| EN/ES group-lesson dialogue | `fixtures/sunset-golden/sunset-golden-03-adult-group-lesson-two-whatsapp.json`, `sunset-golden-08-group-lessons-morning-mon-thu-spanish-whatsapp.json`, `sunset-golden-09-rapid-group-lesson-quote-whatsapp.json` | Select 03/08/09 as the diagnostic source set; 09 is runnable now. |
| Central offline no-effect guard | `scripts/lib/sunset-golden-no-send-guard.js` | Reuse unchanged; adversarially proven against permissive fixture flags. |
| First-answer truth and bilingual scoring | `scripts/verify-sunset-luna-first-answer-eval.js` and `fixtures/sunset-first-answer/` | Reuse for course choice, remaining seats, gear, location and fail-closed checks. |
| Exact serving-process isolated model test | `/whatsapp/v1/internal/luna-personality-live-eval`, `luna_personality_live_eval.py`, `luna_personality_isolation.py` | Reuse its closed-case, no-tool/no-send/no-persistence admission design; do not use generic simulation. |
| General synthetic webhook simulator | `docker/hermes-staging/wolfhouse/simulate_core.py` | Not admitted for LR1: single-turn mode accepts caller `allow_writes`; generic gateway launch flags are send-enabled. |

## LR1.1 — Booking promise

The first diagnostic slice is **Sunset Somo group lessons in English and Spanish**. It exercises only the existing promise:

1. Understand the requested date(s), quantity and preferred/selected class time.
2. Use the existing Sunset lesson catalog and Staff/Horario availability contracts.
3. Present only returned options, prices, inclusions and remaining seats.
4. Ask one next question where information is missing.
5. Never claim booked, paid, held, available, full, or included without the corresponding authoritative result.

This chapter references the live Sunset SOUL, Staff catalog and domain contract; it does not redefine products, prices, schedules, capacities, inclusions, age policy, or service names.

### Real gaps for Ty

Only these gaps are carried forward for a later approved implementation:

- Fixtures 03 and 08 are marked `draft` and are structure-only; they are not executed by the current central runner.
- The dedicated live-eval route allowlists personality/truth cases, not group-lesson cases 03/08/09. LR1 therefore authorizes the test contract, but does not authorize arbitrary text through the live route.
- A future approved chapter must decide whether to convert 03/08 into executable offline cases and add a closed group-lesson corpus to the existing isolated route. Reuse the isolation owner; do not create a parallel simulator.

## LR1.2 — Authority, limits and budget

### Owners

- **Skipper:** runtime ownership, exact artifact admission, execution ledger and safety stop authority.
- **Seadog:** QA contract review and independent scoring; reports PASS/FAIL/BLOCKED with evidence. Seadog does not alter runtime.
- **Deckhand:** UI-only. No runtime, prompt, fixture, Staff API, data or deployment ownership.
- **Captain:** not used for routine LR1 review.

### Budget

- Sunset staging only.
- Diagnostic subset: fixtures 03/08/09; run 09 first because it already has executable coverage.
- One case at a time; one retry maximum after a classified transient failure.
- Maximum model wall time: 180 seconds per case, matching the existing bounded runtime convention.
- Evidence is bounded to status, hashes/digests, counters and redacted outputs. Do not dump container files, session databases or credentials.

### Immediate halt conditions

Halt the run and mark **Blocked** if any of these occurs:

- target identity, tenant, location, model, SOUL, Staff origin or image digest cannot be observed;
- target is not `hermes-sunset-luna-http`;
- any external WhatsApp/email send is attempted or completed;
- any booking, payment-link, Stripe, waiver, Staff mutation, journal or other persistence effect occurs outside the explicit allowance below;
- isolation seam is absent, readiness is false, cleanup is partial, provider work is unsettled, or terminal-response evidence is missing;
- request accepts arbitrary guest text, caller-selected tenant/model/SOUL/auth, or `allow_writes`;
- production, another tenant, another location, a real guest identifier, `/sethome`, or Owner Lab enters scope;
- disk, timeout or usage budget is reached.

## LR1.3 — Safe test path

### Exact target

- Runtime: `hermes-sunset-luna-http` only.
- Exclusion: exited send-enabled `hermes-sunset-luna` is excluded.
- Environment: Lunabox Sunset staging.
- Staff origin: `https://sunset-staging.lunafrontdesk.com`.
- `tenant_id = sunset`.
- `location_id = sunset-somo`.
- Model: serving readiness must declare `gpt-5.6-sol`; a config-file default alone is not consumed-model evidence.
- Runtime ports must remain loopback-only (`127.0.0.1:8094` and `127.0.0.1:8095`).
- Artifact and SOUL SHA-256 are captured at each run tip; changing either invalidates admission and requires a new preflight.

Observed at LR1 clearance:

- image digest: `sha256:16809992a4a6ef027cf0436f86ff5948c17320c128bfe8bf519d7b5a76124ff2`;
- SOUL SHA-256: `81b29f40e12cf1738a617ec60de6a614011f285faf1f29d0b0a5b9b766186a74`;
- authenticated exact-route readiness: HTTP 200, `ready:true`, no missing seams/runtime requirements, isolated home and SOUL present, Sunset Staff origin accepted, model declaration `gpt-5.6-sol`;
- readiness itself made no model call and is not live acceptance.

### Synthetic identifiers

- Use an allowlisted corpus `case_id`; never caller-supplied guest text.
- Ephemeral message IDs: `wamid.lr1.<case-id>.<nonce>`.
- Synthetic phone namespace: `+3****09` in human-readable evidence; the runtime-generated full value must be reserved for the isolated test and never copied into chat/status output.
- Case IDs, tenant, location and personality IDs are closed server-owned inputs.

### Permitted-effects allowlist

The **only permitted product-side effect** is isolated synthetic conversation/session persistence when a later approved runner explicitly requires it. For the currently admitted personality live-eval route, even that persistence is denied and must remain zero.

Permitted now:

- authenticated readiness GET only;
- in-memory readiness capture, bounded counters and redacted artifact writing.

No model inference is currently permitted by LR1. A later approved change may admit only a closed `03`/`08`/`09`-derived Sunset group-lesson case through the exact isolated route; it must not admit personality/truth cases or arbitrary guest text. Read-only Staff catalog/availability/quote calls remain blocked until that closed group-lesson route explicitly permits them.

CLOSED:

- `create_sunset_booking` — CLOSED;
- `create_sunset_payment_link` and Stripe checkout — CLOSED;
- waiver mutation — CLOSED;
- WhatsApp send — CLOSED;
- email send — CLOSED;
- arbitrary Staff POST/mutation — CLOSED;
- production and cross-tenant access — CLOSED.

### Pause, timeout and cleanup

- **Pause:** before each case, rerun authenticated readiness. If it is not `ready:true`, do not invoke the model. Global Pause/Auto state is not overridden by the test.
- **Timeout:** 180 seconds maximum for a case; timeout is Blocked, not Fail, unless deterministic reproduction proves a product defect.
- **Cleanup:** wait for tracked provider work to settle; require terminal-response verification; exit isolation context; verify sends/tools/journal/persistence completed counters are zero. Delete only the case's synthetic conversation/session if one was explicitly opened. Never bulk-delete and never touch non-`wamid.lr1.*` records.
- If cleanup is partial or counters are unknown, preserve bounded evidence and halt. Unknown is not zero.

## LR1.4 — Test contract with Seadog

### Success

A case is **Success** only when all are true:

- exact artifact, runtime, tenant, location, Staff origin, isolated home/SOUL and `gpt-5.6-sol` are observed;
- the expected allowlisted case and language run once through the serving model;
- output satisfies the fixture's truth, language, one-question and no-internal-language expectations;
- all prohibited-effect completed counters are numeric zero;
- provider work settles, terminal response is verified and cleanup completes;
- Seadog can reproduce the classification from the bounded artifact.

### Fail

A case is **Fail** when the admitted path completes safely and deterministically but the guest-facing contract is wrong: invented fact, wrong language, unsupported availability/price/inclusion, false booking/payment claim, wrong next question, or forbidden internal copy. Any side-effect leak is also Fail and triggers the immediate halt conditions.

### Blocked

A case is **Blocked** when evidence cannot safely decide product behaviour: readiness/identity mismatch, non-allowlisted case, missing seam, timeout, unsettled provider work, partial cleanup, unknown counters, missing credentials, unavailable Staff read authority, artifact drift, or budget exhaustion. Blocked is never reported as PASS.

### Demo

A **Demo** is a redacted Sunset-staging replay showing the guest input, Luna output, exact case ID, language, artifact/SOUL hashes, consumed model observation, zero completed effects and Seadog's classification. It is not a real WhatsApp message and must not contact a guest.

### LR1 exit evidence

- Offline `sunset-golden-09` central runner: 47 passed, 0 failed.
- Adversarial central no-send gate: PASS, including permissive fixture flags.
- Sunset first-answer aggregate: 42 passed, 0 failed; underlying Python pack 58 passed, 0 failed, 1 documented skip.
- Authenticated exact-route readiness on `hermes-sunset-luna-http`: HTTP 200 and `ready:true` with every required isolation seam present.
- This scope, effects allowlist, owner map and Success/Fail/Blocked/Demo contract are executable-document checked by `scripts/verify-luna-reliability-lr1-clearance.js`.

**LR1 clearance conclusion:** authorised safe testing scope and criteria are complete. Live group-lesson execution remains **Blocked by design** until a later approved change adds those cases to a closed isolated corpus; generic simulation remains forbidden.

## LR2.4 — Failure map: Closed-fixture contract / abort observability

**Status bar:** `LR3.2 | Status Active | Golden offline PASS; #956 landed + live retest still empty_tool_calls (digest sha256:f74d9e5d… / master 39c9f014); Cap tip 1547934800348975165 / Skipper trace 1547935282974687245 reclassifies live pairing tool_calls+executor.observed-none as observer-stale-after-promote, not proof dispatch never ran; call1 provider_empty_with_wire_ok remains separate from call2 stale observer; 03/08 HOLD | Next gate: #962-image offline reclassify A|B|REPAIRED after classification A + dispatcher rebind deploy; do not treat read_tools_completed=[] or executor-none as authoritative alone`.

| Field | Value |
|---|---|
| Family | `Closed-fixture contract / abort observability mismatch` |
| Severity | Major — case-scoped QA blocker |
| Status | Partially cleared: #944 closed isolated harness is merged and deployed, #943 fixtures landed, #945/#946/#947 docs/verifier follow-ups are merged, #948 hardened the LR2 messy-pack receipt contract, #949 added metadata-first capture instrumentation at master tip `0ee15c4d`, #953 merged the Responses adapter `tool_choice` wire plus `empty_tool_calls` classification at master tip `0deceb93`, and #956 recovered terminal `function_call` items + wire tools normalization at master tip `39c9f014`. The post-#956 live retest (digest `sha256:f74d9e5d…`) still sealed `completion_category=empty_tool_calls` with healthy `tools_wire=responses_function`, named `tool_choice=function:get_sunset_lesson_catalog`, `status=completed`, `tool_calls=[]`, and `output_item_types=[]` for case-09 and named-read. New Cap/Skipper source trace reclassifies the later live pairing `tool_calls` plus `executor.observed-none` as `observer-stale-after-promote`: `BoundedMetadataCapture.observe_provider_result` / `observed_no_executor_calls()` can unconditionally replace executor state/dispositions after empty-terminal observe → assembled promote, while the isolation wrapper records accepted/dispatched/completed via `cap.metadata_capture`. Therefore the map must not treat executor-none as proof dispatch never ran. Keep call1 separate from call2: call1 remains the offline boundary class `provider_empty_with_wire_ok`; call2 is stale observer until independent handler evidence says otherwise. Staff `read_tools_completed=[]` may share the same faulty observer. Chief isolation disposition on #960 image classified **A** (handler/Staff ran; `record_disposition` never — stale `run_agent.handle_function_call` binding). #962 rebind deployed (`sha256:41b4f31a…`); sealed case-09 still BLOCKED observed-none; #962-image offline reclassify A|B|REPAIRED is the next gate — do not treat observer-only fields as authoritative yet. Staff `read_tools_completed=[]` remains unproven until independent handler evidence on the #962-image reclassify. Offline wire-to-native boundary records + fixture replay still discriminate: (1) terminal-native present → `adapter_drop_recovered`, (2) wire OK + completed empty with recorded stream events → `provider_empty_with_wire_ok`, (3) no stream/terminal observation → `observation_incomplete`, (4) native typed `function_call` but un-normalizable → `lost_normalization`. Compatibility blocker id `lr32_post956_observer_stale_after_promote`: collect handler/disposition/history fields before concluding no dispatch; do **not** claim PASS or no-dispatch from observer-only capture. Golden offline remains PASS; live case-09 remains BLOCKED; 03/08 live execution stays on HOLD. |
| Evidence tips | #943 fixtures; #944 harness merged+deployed; #945/#946/#947 docs/verifier follow-ups; #948 messy-pack verifier; #949 metadata-first capture instrumentation `0ee15c4d`; #953 Responses adapter landing `0deceb93`; post-#953 live retest `empty_tool_calls`; #956 terminal recovery `39c9f014`; post-#956 live retest digest `sha256:f74d9e5d…` still `empty_tool_calls` + `output_item_types=[]`; Cap tip `1547934800348975165` + Skipper source-trace `1547935282974687245` for `observer-stale-after-promote`; offline `fixtures/luna-lr32-wire-to-native/` + boundary-record replay |
| Owner boundary | Runtime/admission owners hold adapter deploy and any admitted live retest; Deckhand may keep this map current and babysit fixture/doc/harness-only PRs without touching runtime, inbox, email, guest sends, or deployment |

This family records the split result honestly: the closed isolated harness and map stub shipped, the offline golden path passes against the merged fixture/doc verifier work, the metadata-first capture hook needed for zero-tool diagnosis has landed, #953/#956 adapter wire/classification/terminal-recovery work is on master, and offline wire-to-native boundary records still discriminate native-empty vs adapter-drop. It is **not** a full LR3.2 PASS: the post-#956 healthy-deploy live retest still produced empty tool calls under both auto and named-read modes, and the newer live pairing is now classified as `observer-stale-after-promote`, not proof dispatch never ran. Treat Staff `read_tools_completed=[]` as observer-only until independent handler entries / record_disposition / #962-image offline reclassify confirms it (classification A already proved handler can run while dispositions stay missing). Keep 03/08 live checks on HOLD until a Chief-gated live retest/capture has independent handler-disposition fields.

Offline fixture/corpus hygiene: Sunset golden fixtures 03 and 08 remain active review-only corpus entries for ordinary group-lesson reliability, but they are **not** admitted live cases while 03/08 is on HOLD. Maintain them through offline fixture/docs verifiers only; do not run live 03/08 until the failure-map gate is cleared.

Operational limits remain unchanged: no `hermes-sunset-luna-http` deploy, no live-eval scope expansion by Deckhand, no capture-image rerun by Deckhand, no `inbox-thread.js`, no email inbound/poller work, no Skipper-owned adapter code, no `/sethome`, no production, and no merge by Deckhand.
