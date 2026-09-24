# LUNA-INTEL-WEATHER-SILENT-HANDOFF-001

## Scope

Local product repair for ordinary WhatsApp handoff notice and public-research failure behavior, Wolfhouse/Sunset Luna only. No live guest sends, state changes, push, merge, deployment, restart or credential/trust changes. Payment-truth work is separate and untouched; #1173/#1174 UI/email changes are out of scope.

Starting GitHub master: `d0a0cc59506fc007289b99a420b39d2a006aaf90` (includes #1173 and #1174).
Branch: `captain/luna-intel-weather-silent-handoff-001`.

## Before: direct staging observation

Authenticated read-only Staff API GETs confirmed the reported Ty thread (phone suffix 2307):
- Weather question: “Can you check the weather for somo this weekend?”
- Handoff opened 2026-09-24 06:11:13.749Z for **Weather lookup failed**.
- Paused by `luna_flag_needs_human` at 06:11:13.710Z; live_send_blocked=true.
- Latest mirrored inbound at 06:11:18.427Z; no subsequent outbound in the returned snapshot.
- Intelligence currently enabled; WhatsApp mode auto.

Mirror persistence times are not execution timestamps. The observation proves handoff/pause and absence of a mirrored reply, not which provider failure occurred or whether final text was generated.

The source-level reproduction explains a silence mechanism: `flag_needs_human` persists Wolfhouse Needs Human/pause immediately, then the send-time gate suppresses the ordinary final response. Its adapter return has success=true but no provider message ID; success alone does not prove delivery.

### Unresolved diagnostic boundary

Lunabox log access failed at SSH host verification: no trusted ED25519 host key in this sandbox (exit 255). No trust bypass attempted. Thus **ActivationFailed, missing provider credentials, timeout, concrete public-tool error, and model exception are not established as the underlying weather-lookup cause**. Staff message-events returned an empty list, not a Hermes trace. The transfer evidence includes the sanitized GET observations and exact failed read-only log command.

## Verification boundary

Existing Intelligence, public-worker, explicit-handoff, pause, draft/manual, send-flag, coalescing, fresh-start, personality-bind and simulation-guard tests pass on the pristine base. The existing Node Intelligence cross-language integration also passes offline. These tests use injected provider/Staff boundaries; no live forecast or provider configuration has been verified.

Baseline `test_luna_tool_guards.py` has **94 passed / 2 failed**:
- S9: availability hits `/sunset/lesson-availability` route.
- S10: availability `take_request=true` when capacity unknown.
These are unrelated baseline failures, not permission to change booking/equipment behavior.

The pristine-base `npm run verify:luna-all` result is **59/63 green**, with these existing failing steps: `verify:inbox-shell-channel-defaults`, `verify:inbox-theme`, `verify:inbox-middle-column-fill`, and `verify:luna-personality-live-eval`.

An interim candidate run exposed two new verifier import-path failures: `verify:sunset-luna-live-test-001` and `verify:luna-tenant-defaults` loaded a different installed `wolfhouse` package instead of this checkout's runtime. Their fixtures now put `docker/hermes-staging` on `sys.path`; original assertions remain unchanged. Both canonical Node commands pass with inherited `PYTHONPATH` removed. The post-repair aggregate matches the pristine-base result and failure identities.

## Acceptance and proof limits

The offline acceptance matrix must exercise the emitted ordinary worker, real registered handoff handler, and real patched WhatsApp send (only external Staff/provider/model boundaries injected):
- Useful public evidence succeeds without a handoff.
- Public lookup denial/failure alone returns an honest limitation, not a staff-follow-up promise.
- Independent safety, explicit-human, complaint and booking exceptions remain eligible for handoff.
- A legitimate ordinary-agent handoff acknowledges before persistence/pause, including an agent exception afterward; repeated tool flags do not duplicate the notice.
- Already-paused, draft/manual, global kill-switch, failed provider, simulation and cross-tenant paths keep their restrictions; no suppression result is counted as delivery.
- Both coalesced and non-coalesced production entrypoints, ordinary executor context propagation, and late/concurrent copied contexts are covered.

Any separately authorized post-land staging check must use an approved test identity. Inspect actual public-tool receipts and real outbound message IDs; Staff thread state or a `success:true` suppression result alone is insufficient. Do not break live provider configuration to simulate an outage. No post-land test, real weather provider success, guest send, or deployment is claimed here.

## Bounded repair acceptance (Chief GO)

The prior independent review was FAIL; intermediate green results are not acceptance of that snapshot. Chief authorized one bounded local repair pass and a fresh independent review. Required acceptance:

1. Optional burst coalescing disabled: the installed ordinary dispatch still attempts the guest notice before persisting pause/handoff, without blocking webhook acknowledgement on the whole model turn.
2. Real `MessageEvent` source identity: use `source.chat_id`; do not depend on a fixture-only root attribute.
3. A delivered acknowledgement and failed handoff write: acknowledgement deduplication must not cache the failed write as completed; retry/reconciliation must preserve truthful status and fail-closed automation.
4. Cancellation while awaiting the acknowledgement: revoked work must not subsequently persist.
5. Ordinary raw executor dispatch: handoff authority must propagate explicitly into the emitted worker rather than depending on optional initialization elsewhere.

Skipper's diagnosis is incorporated: SOUL already prohibits lookup-only handoff; the broad flag-tool guidance and pause-before-final ordering were inconsistent with that rule. The provider's specific lookup failure remains unproven. No reopening of landing or fresh live diagnosis is required for this local repair.

## Candidate verification before fresh review

- `python3 -B -m unittest discover -s docker/hermes-staging/wolfhouse -p test_ordinary_handoff.py -v`: PASS, 15 tests. `tmp/weather-repair-parent-focused-GREEN.log`.
- `python3 tmp/run-weather-checks.py current`: 22 command receipts; only the existing `test_luna_tool_guards` failure. Pristine-base comparison records 21 commands; the new ordinary-handoff suite is the additional candidate command. No new failing command.
- `npm run verify:luna-all`: 59/63, same failing-step identities as pristine base. No all-green aggregate claim.
- The real installed Hermes `MessageEvent` probe passes for both tenants through the installed background ingress and raw executor. Run with `/opt/hermes/.venv/bin/python3 -B tmp/weather-messageevent-probe.py`; no real adapter/provider call occurs.
- Independent parent cancellation probe: PASS, no Staff writes after dispatch revocation.
- The earlier private `_coalesced_handle_message` probe bypasses the new installed background-task lifetime; it is historical RED evidence, not the final ingress acceptance test. The installed-entrypoint test asserts webhook return before model completion with coalescing disabled.

The added public-success fixture initially used a numeric date sequence rejected by the pre-existing privacy filter (`invalid_public_query`). The fixture now uses a clearly separated public-date query. No privacy guard was weakened. This does not establish the cause of the live lookup failure. Successful lookup evidence is explicitly an offline fixture, not a live forecast.

Fail-closed automation state now keys runtime tenant, origin and phone; it is process-local protection, not a claim of durable Staff handoff. Failed persistence remains unsuccessful, permits retry, attempts a truthful guest correction after a delivered acknowledgement and marks operator reconciliation. The simplified cancellation fixture reports any real late receipt truthfully without granting new write authority, but the fresh installed-class probe below falsifies that guarantee during asynchronous adapter cleanup.

## Fresh independent review: FAIL — LOCAL CLEAN withheld

The reviewer found a remaining cancellation race in both tenants. Revocation occurs in the outer dispatch `finally`, but the real installed adapter catches cancellation and awaits processing-complete/cleanup hooks before that `finally` runs. A provider receipt settling during this interval still permits Staff persistence. The actual offline sequence is `ack_send → cancellation_cleanup → persist`, and the tool incorrectly reports successful handoff without reconciliation need.

Captain independently reran `/opt/hermes/.venv/bin/python3 -B tmp/weather-fresh-review-probe.py`: exit 1, reproduced for both tenants. Normal non-cancelled controls retain notice-before-persistence. Receipt: `tmp/weather-parent-confirmed-review-FAIL.log`. All reviewed non-documentation source hashes remain unchanged.

Historical FAIL report: `tmp/weather-review-before-cancellation-repair.json`; SHA-256 `a830cd0a280563f6cdb9e5a2e6b1ee008f653cf3c1fad8399f18d5e475dd8d95`.

The reviewer also found a shared pre-existing compatibility limitation: both pristine base and candidate reject full patch emission against installed Hermes with `bind/rebuild AST mismatch`. Compiling rejected output is not installation success. The standalone bridge also lacked `LUNA_E2E_LOCAL_ORIGIN`; it was not counted as passed. These limitations remain separate from the reproduced candidate cancellation defect.

That bounded repair/review cycle completed but was rejected. No acceptance commit or LOCAL CLEAN package was produced. Its immutable report copy is `tmp/weather-review-before-cancellation-repair.json` with the SHA-256 above.

## Chief-approved narrow cancellation repair — in progress

Chief subsequently authorized one local cancellation-authority repair covering the real-adapter cleanup window, a repository regression using that actual adapter lifecycle, and fresh independent review. Only the existing handoff owner and its focused regression tests may change in this pass. Other runtime policy, gateway emitter, payment, routing/config and service definitions are out of scope.

Gateway-patch compatibility remains **separately gated** as explicitly directed by Chief: an accepted local repair would not prove installation compatibility or authorize deploy. No bypass of the production validator is permitted.

## Narrow cancellation candidate — frozen for fresh review

This pass changes only `explicit_human_handoff.py` (capture dispatch task and reject its pending cancellation) and adds `test_ordinary_handoff_cancellation.py`. Before/after source hashes are recorded in `tmp/weather-cancel-after.json`; Captain independently verified the exact delta and all resulting hashes.

- New real-adapter repository regression: genuine RED then GREEN; two tests exercise both tenants without skips. Run separately using `/opt/hermes/.venv/bin/python3 -B docker/hermes-staging/wolfhouse/test_ordinary_handoff_cancellation.py`. It requires the real installed Hermes classes and dependencies and errors if unavailable; it never substitutes a miniature adapter.
- Captain reran the original independent adverse probe unchanged: exit 0, both tenants now produce `ack_send → cancellation_cleanup` with **no persistence**. Delivered receipt remains `ack_sent=true`; unsuccessful handoff, local fail-closed and reconciliation remain explicit. Normal controls still produce `ack_send → persist`. Receipt: `tmp/weather-cancel-parent-original-probe.log`.
- Parent broad rerun: 23 command receipts, only the unchanged baseline tool-guard failures. Existing ordinary suite remains 15 passing tests; new real-adapter suite passes. `npm run verify:luna-all` remains 59/63 with the same baseline failing-step identities.
- External model/provider/Staff boundaries are injected and network attempts denied in the real-adapter regression. This proves the installed adapter's offline cleanup lifecycle, **not** a live guest exchange or full gateway installation.

## Final independent review — PASS (bounded local scope)

Fresh independent review accepted the frozen runtime/test snapshot. Report: `tmp/weather-independent-review.json`; SHA-256 `3ed1d5d71d214bfc5dbefc047837cab8a8e072be48863a6b6ed93f8f29aa8570`. Captain independently re-enumerated all nine changed non-documentation paths and verified every complete-file hash against that report before packaging. No runtime/test source was modified after review.

The reviewer independently passed the real-adapter regression (two tests, both tenants, no skips), the ordinary suite (15 tests), original rejection reproducer and relevant offline guard suites. The trusted test-only `exec(emitted, ns)` was reviewed; no untrusted input is compiled. Source approval is not approval of full gateway installation, live model/provider behavior or deployment.

### Aggregate qualification

Archived aggregate runs both reported 59/63 and the same four top-level failing gates, but the reviewer correctly noted different nested live-eval identities. The archived baseline used a different Python environment; the current run lacked `run_agent`. Captain reran the pristine baseline in the current environment and verified the **complete nested FAIL/ERROR identities and summaries match** the candidate. Receipts: `tmp/weather-base-current-environment-verify-luna-all.log` and `tmp/weather-cancel-parent-matched-environment.json`. This is a baseline comparison, not a full-suite green result, and does not remove the separate gateway compatibility gate.

### Transfer/acceptance boundary

The local artifact contains the reviewed source commit as a Git bundle and format-patch, the handoff document, historical RED/FAIL evidence, current verification and the fresh PASS report. `manifest.json` binds the committed tip/base and every included file checksum; the archive has its own SHA-256 sidecar. Historical/intermediate green or red logs are not the current verdict. The final packet receipt is authoritative for the resulting commit and archive hashes.

No Intel GitHub publication, landing, deployment, restart or live guest send is claimed. Skipper owns landing; the separately gated gateway compatibility issue must not be hidden by this local acceptance.


Payment remains parked until Intel LOCAL CLEAN. Only then is publication of the already-approved payment CLEAN to GitHub authorized, with remote-tip verification for Skipper; no payment landing or deployment is assigned here. No landing, deployment, restart or real guest sends are authorized in this repair.
