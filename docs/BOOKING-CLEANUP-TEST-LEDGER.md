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
the isolated PGlite room/pricing rows. Each of the five retained Sim23 inputs now preserves its
captured dates, full names, language, explicit person facts, bed/room facts, and commercial terms.
The registered `/booking-create-from-plan` dispatch executes the isolated SQL operation and returns
that real result through owner completion before assertions cover the persisted booking, occupants,
payment, and final reply. Missing historical backend receipts remain explicitly synthetic; the test
does not invent a historical failure cause. Generic alternative-input failure controls are separately
labelled and reject with zero booking writes. Committed inventory, tariffs, offer identity, and
production validators are unchanged.
