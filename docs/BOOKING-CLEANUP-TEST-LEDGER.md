# Booking cleanup test ledger

Base: `892cdafab900868a28909409ac70a469a6c1d18b`.

## Evidence rule

No local result is relabelled as historical reproduction. The retained masked Sim22 summary records the actual guarded Staff refusal for G3 twice: `A checked offer revision is required before this booking can be created.` It records the exact first quote, names/payment acceptance, second quote, availability, create and retry order. This is the required original-case RED evidence available to this builder; it is live-capture evidence, not a newly reproduced base run. G1/G2 full receipts are unavailable and are not invented.

## Baseline execution

The retained baseline packet contains real per-entrypoint logs from the pinned base and its `results.json` index. Results were: owner/dispatch **112/112 pass**; first-yes owner/persistence **68 run, 31 failures + 15 errors**; eligibility/localized copy **18/18 pass**; registered boundary **13 run, 2 copy-expectation failures**; replay **5/5 pass** (31 decisions replayed, 25 explicitly unavailable); offer identity **42/42 pass**; occupants, exact-bed, mixed-room 69/69, needs-human isolation, and send-flags 53/53 pass. Fully qualified IDs, assertions and traces are preserved verbatim in `artifacts/booking-cleanup-step1/baseline/*.log`; `LOG_SHA256SUMS` seals each log.

The repeated persistence failures/errors share the PGlite setup/cleanup fault recorded in their traces and are classified **harness defect**, not product waiver; their guarantees remain covered by the real occupants/retry SQL gates. The two registered failures are **obsolete copy expectations**: they expected no authoritative room line although the owner correctly rendered `two beds in the same mixed room.`; the room-disclosure tests preserve that guarantee. The automatic create-without-model expectation is **obsolete expectation** under the canonical model-owned create contract; registered model-issued create is the replacement and SQL/reset/idempotency assertions remain mandatory.

The R2 review already established that its registered sequence passed base and head and that its separate fact-equivalent second-quote test was RED but was not the original G3 path. This packet does not call that original reproduction.

## Candidate gates

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
