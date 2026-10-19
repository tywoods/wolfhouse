# Booking cleanup test ledger

Base: `892cdafab900868a28909409ac70a469a6c1d18b`.

## Evidence rule

No local result is relabelled as historical reproduction. The retained masked Sim22 summary records the actual guarded Staff refusal for G3 twice: `A checked offer revision is required before this booking can be created.` It records the exact first quote, names/payment acceptance, second quote, availability, create and retry order. This is the required original-case RED evidence available to this builder; it is live-capture evidence, not a newly reproduced base run. G1/G2 full receipts are unavailable and are not invented.

## Baseline execution

The retained baseline packet contains real per-entrypoint logs from the pinned base and its `results.json` index. Results were: owner/dispatch **112/112 pass**; first-yes owner/persistence **68 run, 31 failures + 15 errors**; eligibility/localized copy **18/18 pass**; registered boundary **13 run, 2 copy-expectation failures**; replay **5/5 pass** (31 decisions replayed, 25 explicitly unavailable); offer identity **42/42 pass**; occupants, exact-bed, mixed-room 69/69, needs-human isolation, and send-flags 53/53 pass. Fully qualified IDs, assertions and traces are preserved verbatim in `artifacts/booking-cleanup-step1/baseline/*.log`; `LOG_SHA256SUMS` seals each log.

The repeated persistence failures/errors share the PGlite setup/cleanup fault recorded in their traces and are classified **harness defect**, not product waiver; their guarantees remain covered by the real occupants/retry SQL gates. The two registered failures are **obsolete copy expectations**: they expected no authoritative room line although the owner correctly rendered `two beds in the same mixed room.`; the room-disclosure tests preserve that guarantee. The automatic create-without-model expectation is **obsolete expectation** under the canonical model-owned create contract; registered model-issued create is the replacement and SQL/reset/idempotency assertions remain mandatory.

The R2 review already established that its registered sequence passed base and head and that its separate fact-equivalent second-quote test was RED but was not the original G3 path. This packet does not call that original reproduction.

## Candidate gates

Candidate execution on 2026-10-19 used the pinned offline Hermes runtime overlay and real PGlite Staff handlers. The focused persistence suite passed **14/14**. The combined first-yes owner + persistence suite passed **68/68**. The registered boundary suite passed **13/13**.

### Final persistence classifications

| Test | Classification | Candidate result / contract |
|---|---|---|
| `test_enriched_yes_cannot_override_original_guest_refusal` | harness authority defect repaired | PASS; the scripted interpretation is bound to preserved raw `No thanks`, so enriched `yes` cannot mint acceptance or a SQL booking |
| `test_lost_commit_reply_recovers_same_sql_booking_and_idempotency_key` | supported SQL idempotency retry | PASS; exact original ingress retry reaches Staff create a second time with the same owner key; Staff returns `idempotent:true`; one SQL booking remains |
| `test_unchanged_registered_revalidation_still_reaches_sql_without_reconfirm` | supported unchanged registered revalidation | PASS; the registered create wrapper's real quote boundary performs the second preview, then one create reaches SQL without reconfirmation |
| Remaining 11 persistence tests | supported positive/negative persistence controls | 11/11 PASS; presentation, replay, reset, occupied-bed, changed-room-rule, catalog duration and unrelated-yes controls remain intact |
| First-yes owner tests | supported owner unit contracts | 54/54 PASS; combined with persistence, 68/68 PASS |
| Registered boundary tests | supported registered acquisition/create contracts; two historical copy expectations updated to authoritative room disclosure | 13/13 PASS |

| Gate | Result | Guarantees |
|---|---|---|
| `verify-wolfhouse-offer-identity.js` | 42/42 PASS | unchanged identity, retry/recovery, material-change negatives |
| `verify-luna-create-booking-occupants.js` | PASS | real PGlite create, named people/beds, money, SQL fail-closed |
| `verify-wolfhouse-offer-retry-handler.js` | PASS | exact retry and changed occupant/legacy refusal controls; shared UUID/schema fixed |
| `verify-wolfhouse-eligibility-contract.js` | PASS | real producer yes/no/unsure, zero-based scope, inventory separation |
| `test_sim22_cleanup.py` | 4/4 PASS | five-case accounting; Becker frozen terms; Emma no booking; Raj equality |
| exact-bed + mixed allocation | PASS (69/69 mixed) | eligibility/stock and placement controls |
| needs-human isolation SQL | PASS | synthetic/ordinary isolation and no notification leakage |
| Hermes send flags | 53/53 PASS | no live send; kill switches and pause checks |
| Python syntax / Node syntax | PASS | candidate parses |

## Baseline/candidate classifications

* Becker checked-revision refusal: **supported defect** under the completion continuity contract; fixed in the accepted-offer owner. Registered replacement preserves checked revision and real SQL controls.
* R2 UUID season/range and duplicate `payments.created_at`: **harness defects**; fixed by UUID-compatible seeds and one shared schema owner.
* Automatic create without a model-issued registered create: **obsolete expectation** where encountered in the historical audit; no blanket skip was added. Registered model-issued create remains the replacement contract.
* Emma historical unanswered eligibility: **supported no-booking outcome**, not rewritten as success. Structured continuations are separate controls.
* Missing G1/G2 full Sim22 receipts and blocked local Python baseline: **missing evidence**.
