# Booking cleanup test ledger

R4 starting head: `660d49e46868ea39f9973cca56bf956712ea0926`.

## Evidence rule

No local result is relabelled as historical reproduction. The retained masked Sim22 summary records the actual guarded Staff refusal for G3 twice: `A checked offer revision is required before this booking can be created.` It records the exact first quote, names/payment acceptance, second quote, availability, create and retry order. This is the required original-case RED evidence available to this builder; it is live-capture evidence, not a newly reproduced base run. G1/G2 full receipts are unavailable and are not invented.

## Baseline execution

The retained baseline packet contains real per-entrypoint logs from the pinned base and its `results.json` index. Results were: owner/dispatch **112/112 pass**; first-yes owner/persistence **68 run, 31 failures + 15 errors**; eligibility/localized copy **18/18 pass**; registered boundary **13 run, 2 copy-expectation failures**; replay **5/5 pass** (31 decisions replayed, 25 explicitly unavailable); offer identity **42/42 pass**; occupants, exact-bed, mixed-room 69/69, needs-human isolation, and send-flags 53/53 pass. Fully qualified IDs, assertions and traces are preserved verbatim in `artifacts/booking-cleanup-step1/baseline/*.log`; `LOG_SHA256SUMS` seals each log.

The repeated persistence failures/errors share the PGlite setup/cleanup fault recorded in their traces and are classified **harness defect**, not product waiver; their guarantees remain covered by the real occupants/retry SQL gates. The two registered failures are **obsolete copy expectations**: they expected no authoritative room line although the owner correctly rendered `two beds in the same mixed room.`; the room-disclosure tests preserve that guarantee. The automatic create-without-model expectation is **obsolete expectation** under the canonical model-owned create contract; registered model-issued create is the replacement and SQL/reset/idempotency assertions remain mandatory.

The R2 review already established that its registered sequence passed base and head and that its separate fact-equivalent second-quote test was RED but was not the original G3 path. This packet does not call that original reproduction.

## Candidate gates

The R3 candidate execution on 2026-10-19 used the pinned offline Hermes runtime overlay and real PGlite Staff handlers. Its focused persistence suite passed **14/14**, combined first-yes owner + persistence suite passed **68/68**, and registered boundary suite passed **17/17** before the R4 controls below were added.

R4 cleanup execution added three registered boundary tests (structured localized rendering,
no-stock separation, and both German equal-total render branches) plus the partial multi-guest
scope control. The directly affected R4 set passed **12/12** (3 registered tests plus 9
localized-helper tests). With the repository's shared Node dependencies bound into the isolated
worktree, the complete Sim16 module passed **20/20**. The owner/dispatch suite passed **112/112**,
first-yes owner/persistence passed **68/68**, and eligibility/localized copy passed **19/19**. The
producer contract gate passed separately.

R5 closes only Captain's three review findings. The actual JS producer→BOT_HTTP mapper
contract proves canonical `no` carries `question_kind: null`; registered owner/plugin tests prove
that `no` still renders as incompatibility, zero-stock `unsure`/`no` remains unavailable through
availability and quote projection, successful quotes retain Staff's structured `yes`, and JSON
tool results shaped as `[]`, `null`, numbers, or strings are skipped without crashing. The
complete registered boundary suite passed **24/24**; owner/dispatch **112/112**,
first-yes owner/persistence **68/68**, eligibility/localized **19/19**, decision replay **5/5**
(31 replayed, 25 excluded, zero mismatches), and Sim22 outer tests **5/5**.

### Final persistence classifications

| Test | Classification | Candidate result / contract |
|---|---|---|
| `test_enriched_yes_cannot_override_original_guest_refusal` | harness authority defect repaired | PASS; the scripted interpretation is bound to preserved raw `No thanks`, so enriched `yes` cannot mint acceptance or a SQL booking |
| `test_lost_commit_reply_recovers_same_sql_booking_and_idempotency_key` | supported SQL idempotency retry | PASS; exact original ingress retry reaches Staff create a second time with the same owner key; Staff returns `idempotent:true`; one SQL booking remains |
| `test_unchanged_registered_revalidation_still_reaches_sql_without_reconfirm` | supported unchanged registered revalidation | PASS; the registered create wrapper's real quote boundary performs the second preview, then one create reaches SQL without reconfirmation |
| Remaining 11 persistence tests | supported positive/negative persistence controls | 11/11 PASS; presentation, replay, reset, occupied-bed, changed-room-rule, catalog duration and unrelated-yes controls remain intact |
| First-yes owner tests | supported owner unit contracts | 54/54 PASS; combined with persistence, 68/68 PASS |
| Registered boundary tests | supported registered acquisition/create contracts; historical copy expectations updated to authoritative room disclosure | 24/24 PASS |

| Gate | Result | Guarantees |
|---|---|---|
| `verify-wolfhouse-offer-identity.js` | 42/42 PASS | unchanged identity, retry/recovery, material-change negatives |
| `verify-luna-create-booking-occupants.js` | PASS | real PGlite create, named people/beds, money, SQL fail-closed |
| `verify-wolfhouse-offer-retry-handler.js` | PASS | exact retry and changed occupant/legacy refusal controls; shared UUID/schema fixed |
| `verify-wolfhouse-eligibility-contract.js` | PASS | real producer yes/no/unsure, zero-based scope, inventory separation |
| `test_sim22_cleanup.py` | 5/5 PASS | five outer tests including the executable wrapper; Becker frozen terms; Emma no booking; Raj equality |
| exact-bed + mixed allocation | PASS (69/69 mixed) | eligibility/stock and placement controls |
| needs-human isolation SQL | PASS | synthetic/ordinary isolation and no notification leakage |
| Hermes send flags | 53/53 PASS | no live send; kill switches and pause checks |
| Python syntax / Node syntax | PASS | candidate parses |

## Baseline/candidate classifications

* Historical observation: the retained masked G3 capture records the checked-revision refusal; it is evidence from the supplied capture, not a newly reproduced base execution.
* Accepted ruling-(b) constructed negative: the fact-equivalent refusal control establishes completion-continuity behavior, but is not labelled as the original G3 reproduction.
* Shared-fixture continuity proof: the registered replacement preserves checked revision and real SQL controls independently of both historical evidence and the constructed negative.
* R2 UUID season/range and duplicate `payments.created_at`: **harness defects**; fixed by UUID-compatible seeds and one shared schema owner.
* Automatic create without a model-issued registered create: **obsolete expectation** where encountered in the historical audit; no blanket skip was added. Registered model-issued create remains the replacement contract.
* Emma historical unanswered eligibility: **supported no-booking outcome**, not rewritten as success. Structured continuations are separate controls.
* Missing G1/G2 full Sim22 receipts and blocked local Python baseline: **missing evidence**.

## Step 2 execution — 2026-10-19

Pinned base was `f76c34f06c9395ad610625283b26959597523d25`, tree `f48a0fbe65bc7cac9914c694da300971c121663b`; the worktree was clean. Brief SHA-256 was `276ce42305d0f733627fc12059405b906a0e2a745f694d7890fdfc4b416e853c`.

Baseline dependency-free eligibility/localizer tests passed **19/19**. The larger baseline first-yes run initially retained the established environment classification: missing worktree Node dependencies produced **14 failures + 15 errors**, while owner tests also exposed one cwd-sensitive subprocess path when run below repository root. These were harness/dependency failures, not product failures; `npm ci --ignore-scripts` installed the lockfile dependencies without tracked changes, and candidate commands were run from repository root.

Focused RED witnesses on the unmodified product produced **5 failures + 4 errors** across singular one-person copy, package-failure domain copy, and validated display spelling. The bounded single-room-copy witness separately failed with old `Alex: a bed in the mixed room.` copy. The exact focused candidate entrypoint then passed **7/7**.

Candidate results:

| Gate | Result |
|---|---|
| `python -m unittest wolfhouse.test_structured_room_clarification -v` | 7/7 PASS |
| focused structured + localized + room policy | 26/26 PASS |
| complete Sim16 registered boundary | 24/24 PASS |
| offer identity | 42/42 PASS |
| real PGlite occupants/create/SQL | PASS |
| eligibility producer + exact-bed + mixed-room + allocator | PASS; mixed 69/69, allocator 63/63 |
| Sim13–21 decision replay | 5/5 PASS; 31 replayed, 25 explicitly unavailable, zero mismatches |
| Hermes send flags | 53/53 PASS |
| owner + focused order/composition regression | 118/118 PASS after isolating the plugin boundary witness from intentional module reloads in earlier owner tests |

The historical G3 full package-preview response remains unavailable. The package-failure test is explicitly synthetic and does not claim the historical cause. The registered Becker/SQL control preserves the two-stage captured argument shape (`male dorm`, no roster/group; then `male_only`, `group_gender=male`). The focused entrypoint now passes **9/9**, adding genuine package-policy ineligibility copy and immutable assertions for all five positive Sim23 scenario amounts/outcomes; the existing registered controls remain the executable continuation/stock/eligibility/SQL evidence. Retained matching probe 4019 room-mode/rank/occupancy data was not available, so Lucía remains audit-only; allocator sources and policy were unchanged.

### R3 review corrections

The Sim23 French fixture now carries the supplied historical facts independently of the
request under test: 6–8 November 2026, Camille Martin / Léa Dubois / Hugo Bernard,
flexible R1-B1/R1-B2/R1-B3 with no invented per-person genders, package none, French,
and one chosen full €240 payment line (not a derived full-payment-only policy). Enabled
fixture-capability controls mutate price, deposit, and room strategy and must reject with
zero booking writes. Emma retains 4–7 November, R8-B4 with `female preferred`, €100
required deposit, and the chosen €120 full payment.

The localized helper's stale French expectation changed only from
`Bea peut-elle séjourner…` to neutral named wording `Est-ce que Bea peut séjourner…`.
This prevents grammatical gender from being inferred from a guest name or room while
retaining the same eligibility question and women-only room fact.

### Sim23 test-only PGlite seam follow-up

The occupants verifier exports an opaque, process-local fixture capability; no CLI flag or
environment variable enables it. It is bound to the exact registered create body and changes only
the isolated PGlite room/pricing rows. The five retained Sim23 cases preserve the captured
final dates, full names, language, explicit person facts, bed/room facts, and commercial terms;
the registered traces also load all 14 retained guest texts in order. Becker's package-preview
block and Emma's eligibility/date-correction blocks are deterministic synthetic continuations of
the captured chronology, not claims about historical Staff response bodies or backend causes.
The registered `/booking-create-from-plan` dispatch executes the isolated SQL operation and returns
that real result through owner completion before assertions cover the persisted booking, occupants,
payment, and final reply. Missing historical backend receipts remain explicitly synthetic; the test
does not invent a historical failure cause. Generic alternative-input failure controls are separately
labelled and reject with zero booking writes. Committed inventory, tariffs, offer identity, and
production validators are unchanged.

## Step 3 execution — 2026-10-20

Pinned base `d2699c5091d7be24bda86181d546c6194f9eb3c7`, tree
`4aaf6e75fd9a8d0d0acb336fcb7a0e884d9d0f0a`. All six supplied JSONL hashes and the
CHATS hash matched the approved brief before derivation; originals were not modified.

Strict RED on the unmodified product was genuine: the new Sim24 Python suite ran 5 tests
with one failure (missing Staff-backed package options rendered only the generic question),
and the eligibility producer gate failed `unsure !== yes` for Becker's explicit unnamed
whole-party fact. After the bounded owner/producer changes, both gates passed (5/5 and PASS).

Candidate offline results: offer identity 42/42; ordinary retry controls PASS; real PGlite
occupants/SQL PASS; mixed-room 69/69; allocator 63/63; send flags 53/53; syntax and diff
checks PASS. The broad `verify:luna-all` aggregate remains failed in this scrubbed environment
with the established plugin/harness expectation mismatches (missing legacy `reply_draft` /
`room_decision` shapes). The exact-bed aggregate retained one environment-sensitive failure:
its actual BOT_HTTP handler returned 403 rather than expected 409. Focused installed-Hermes
suites could not be matched to the repository runtime: no pinned overlay is present; the
available unrelated upstream checkout first lacked `ruamel.yaml`. Those are recorded as
harness limitations, not product passes or waivers. No live service, DB, send, deploy, or guest
operation was used.

## Step 3 R3 review repairs — 2026-10-20

Exact starting head `c8722884f906bbb14313fd6160a06c4aa2e4d84e` was repaired offline within the approved allowlist.

- Captain's availability audit now proves unchanged accepted quote → standalone availability → one create dispatch; sparse rosters keep known names; changed dates still require fresh acceptance with zero dispatches; identical same-turn retries retain the date acknowledgement.
- Captain's nine-case completion audit now retains canonical inline deposit/full, separate-payment and split-payment URLs plus selected amounts. EN/ES/FR/DE heading/payment copy follows owner language, and arbitrary model URLs/top-level metadata remain non-authoritative. Explicit SessionDB append/reopen retained final bytes in every case.
- Registered Sim16 returned to **24/24 PASS** and Sim22 to **5/5 PASS**. Sim24 R3 returned **7/7 PASS**, but Captain's review later established that its five loops substituted generic solo dates/party facts; that result is retained here only as the historical R3 gate result and not as captured-journey coverage.
- Structured-room plus eligibility/localized suites passed **33/33**. Owner/dispatch ran **112/113** from the staging subdirectory; the sole failure was the existing cwd-sensitive Node `require('./scripts/lib/...')` harness invocation and passed when rerun from repository root.

No deploy, live DB, guest message, payment, or external send was performed.

## Step 3 R4 review repairs — 2026-10-20

Exact starting head `309cdc3e30ef0098f1b8f7b97e8cd67d5ed6005c` was repaired offline within the same approved allowlist.

- Availability continuity: Captain's unchanged witness now dispatches `Emma Clarke` for omitted, stale `Emma`, and sparse `{}` availability rosters. The shrink/grow witness now asks about `guest 2`, never the removed `Liam`. The captured reviewer script exited 0 after all four outcomes were checked.
- Payment continuity: successful current per-person recovery now contributes Emma's booking-and-person-bound `100.00 EUR` link; successful booking payment recovery remains in owner completion through SessionDB reopen and idempotent create retry. Captain's extra completion script exited 0 and retained both URLs/amounts; its other-booking and reversed-order controls also remained green. A follow-up independent review tightened binding so every shared booking identifier must agree.
- Durable retirement and committed coverage: removed roster indices remain tombstoned across stale regrowth projections until an explicit owner completion reassigns them. Repository tests now cover stale names, shrink → stale-grow non-resurrection, owner reassignment, partial booking-identity mismatch rejection and booking/person-bound payment retention.
- Sim24: each executable case now reads its preserved fixture facts and uses its own dates, party size, full roster, package, payment selection, bed count and first-price/post-price chronology. Constructed Staff receipts are explicitly labelled. Exact create payloads, all names, selected payment amount/link and one create dispatch are asserted; **7/7 PASS**.
- Fresh focused results: accepted-quote plus dispatch recovery **113/113 PASS**; registered Sim16 plus Sim24 **31/31 PASS**; structured-room, localized and room-eligibility **33/33 PASS**. Initial runs lacking local `@electric-sql/pglite` failed only at the harness dependency boundary; after `npm ci --ignore-scripts`, the same suites passed.
- The six supplied JSONL originals and `CHATS.md` were hash-checked before derived-fixture use; their bytes were not modified.

No merge, deploy, live DB, guest message, payment, external send or runtime configuration change was performed. SEALED HOLD remains.

## Step 4 Slice 2 — 2026-10-21

Approved job `BOOKING-CLEANUP-STEP4-SLICE2-SIM26-20261021` started from `3d94ad87434364f51aa4aa148364cc59eb66bc42` (tree `1f9a6971108bd909ba8450516e30d1ad7ea52f65`). The companion archive SHA-256 matched `b7196d69adb57d40a186317a9220fba9f650b53872576e4138fdeb568ab97744`; every embedded input passed its supplied checksum.

Strict focused RED ran 6 tests with 3 failures: ordinary success boilerplate remained, authoritative Room 1 was absent, and the initial Lucía oracle incorrectly expected link amount at a top-level adapter field. The first two are genuine S2-04 product REDs; the third is explicitly a test-oracle correction, not product attribution. The current base registered Lucía continuation already reached one dispatch and receipt reuse, so no new historical S2-01 RED is claimed. Focused GREEN passed 6/6.

The registered availability description's old assertion, “gender-neutral capacity only / Do NOT pass group_gender,” was replaced with the approved explicit-fact propagation contract. Schema, no-inference, private-room, stock, and conflict controls remain unchanged. Successful quote copy no longer emits routine availability caveats; authoritative numbered rooms are disclosed without bed codes and room sentences are capitalized. Obsolete copy expectations are updated only where required; monetary, eligibility and identity guarantees are retained.

Fresh section-4 gate outputs and exact exits are sealed in `artifacts/booking-cleanup-step4-slice2/gate-summary.json` and `gates/*.log`. `fixtures/booking-cleanup-step4/slice2-cases.json` maps every retained Sim13–26 case; inherited `not_replayable` cases remain approved unavailable. Scripted calls do not prove future model selection, historical missing bodies are not invented, and Sim26 readback remains 4/5 with Emma delivery classified S2-02. No push, PR, merge, deploy, restart, live DB, guest send or outbound business action occurred. SEALED HOLD.

Final evidence-completeness follow-up: the two new focused modules passed **8/8** using the pinned interpreter/overlay. The added Sim26 test loads sealed `guest1.jsonl` and compares four raw texts plus all eleven top-level tool names and complete argument dictionaries against a literal oracle; package-preview failure and the zero-tool fourth turn are explicit. A separate registered S2-03 matrix test passed **1/1**, covering explicit unnamed male/female whole-party facts, later names, partial/conflicting/corrected person facts, unknown composition, private room and zero stock without name/room/payment inference. A same-process aggregate of the two older fact modules was not green under the available overlay (27 tests, 27 failures and 71 subtest errors, dominated by unexpected quote preflight `/availability-check` and missing legacy result shapes); this run is retained as a harness/runtime mismatch, not reported as product evidence or waived.

Historical refusal not reproduced or attributed; current-base and candidate continuation pass. S2-01 is preservation/coverage, not a proven historical bug fix.


## Step 4 Slice 3 diagnostics lane — 2026-10-22

Approved job `DH-STEP4-S3-DIAGNOSTICS-CLOSEOUT-20261022` started from GitHub master `55c4cf1b2f0f1a779cca76f8cf8aec2b55ca35b6`. That tip was not newer than the inspected base. `simulate_write_guards.py` and `test_simulate_write_guards.py` are unchanged. This lane does not consume Seadog or Skip receipts; their copy and flow items stay open in `docs/BOOKING-CLEANUP-CLOSEOUT.md`. Captain owns the close-out verdict.

PR #1394 (`c29d9181`) already preserves `success=False` and safe `reason` / `error_code` / `detail`, with `reason=unavailable` when no safe field exists. No new product repair was made. Historical preview bodies were not invented.

Immutable Sim28/Sim29 input hashes matched the packet `SUMS.txt` before and after the verifier run. The new offline consumer reports two ordinary `package_price_preview` failures (guest 3 turn 1 and guest 4 turn 1), both later booked, diagnostic unavailable. Sim29 booking journeys have zero tool failures. Sim29 `probe.log` has one intentional `owner_insights` guard denial and is not folded into zero tool errors. CHATS.md top error lines are empty and are not the source of those counts.

Available-interpreter gates, not the missing recorded 3.14.4 pin: `wolfhouse.test_simulate_write_guards` ran 31 tests, exit 1, one inherited failure `test_france_origin_exception_is_exact_and_keeps_all_other_gates` (`BOT_BOOKING_ENABLED=false` still admitted). The same assertion fails on the unmodified base. Guard permissions were not edited and the failure is not waived. The first capture-summary suite result of 12/12 used a private packet path and is not the portable result. R2 `DH-1395-R2-CHANGES-20261022T1358` reads `SIM28_INPUT_DIR` and `SIM29_INPUT_DIR`, rejects non-string journey name/summary and probe n/r as malformed input, and measured 24/24 exit 0 from a different packet location. Original-packet verifier exit 0. Captain's unchanged malformed-capture probe exit 0, with each schema mutation exit 2 and `ok: false`. `node scripts/verify-hermes-send-flags.js` 53 passed, exit 0. Recorded pin `/opt/data/artifacts/bcr-r2-venv/bin/python` and overlay `/opt/data/artifacts/bcr-r2-runtime-overlay` are absent on this machine; that pinned-runtime gate is incomplete, not PASS. No source PASS is claimed.
