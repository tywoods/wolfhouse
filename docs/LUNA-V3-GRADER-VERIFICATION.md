# Luna v3 grader — TEST verification and handoff

Scope: CAP-PR1426-GRADER-BUILD-20261026T0750, on approved `5c3c575cda6df306f332ecc4e96e3d2ecb99690d`. No production, guest sends, alerts, gateway restart or live model execution.

## Root boundaries

- **Database destination:** `staff-owner-run-plan.js` rejects supplied URI options and ambient/supplied PG overrides before parsing, constructs controlled connection URLs, and verifies the actual `pg.Client.connectionParameters` for both admin and target databases. Only numeric loopback sockets, explicit identity, the intended database and disabled SSL are admitted. Parser errors never echo connection strings. Database creation is fresh-only; no existing database is dropped.
- **Independent session context:** `score_events()` derives expected authority only from the retained outbound request thread. Missing/blank/non-string context fails fidelity closed. Receipt, response and case fields are not substitutes. A continuation needs a verified refusal, the same session and a different event. Direct `semantic_score()` callers must pass the keyword `expected_authority` from their independently retained request/runtime context.
- **Rendered claims:** `luna_v3_rendered_claims.py` parses complete clauses into typed propositions (subject, predicate, value, polarity, source span and modality), checks coverage, then compares every proposition with the Staff owner graph. Money roles/currency, transaction state, person/product/quantity/date relations, inclusion and speech-act claims are separate relations. Unknown or ambiguous prose fails closed rather than being ignored after required tokens appear. Diagnostics expose consumed and unparsed spans.
- **Inclusion and price evidence:** selection, scoped inclusion and zero price are separate relations. Missing prices establish neither free nor paid. For public Staff quotes, package and stay inclusion claims share complete selected-package metadata; missing rows are unknown, explicit empty rows can establish exclusion, and conflicting duplicates are rejected. Bare inclusion clauses use the same provenance check. Explicit legacy fact arrays retain their documented contract.
- **Owner provenance:** normalizer CLI issuance is removed. v5 receipt admission derives outcomes from captured authenticated Staff HTTP bytes and binds the capability snapshot, normalized request, actual owner facts, category and same-session correction. Fault cases identify matrix injection, not observed owner failure.
- **Timeout originals:** see `LUNA-V3-GRADER-EMPTY-BODY-RULING.md`. Present empty bytes are valid captured originals; absent fields or incoherent transformations are not.

## Offline gates

Use a Python environment containing this repository's Hermes dependencies, plus Node dependencies (`NODE_PATH` if shared). Run:

```sh
python3 -B scripts/test-luna-v3-grader-independent.py
python3 -B scripts/test-luna-v3-claims-semantics.py
python3 -B scripts/test-luna-v3-grader-claims.py
python3 -B scripts/test-luna-v3-grader-binding.py
python3 -B scripts/test-luna-v3-grader-empty-body.py
python3 -B scripts/test-luna-v3-grader-session.py
python3 -B scripts/test-luna-v3-grader-integration.py
python3 -B scripts/test-luna-v3-grader-pipeline.py
python3 -B scripts/test-luna-v3-rendered-reply-harness.py
python3 -B scripts/test-luna-v3-rootfix-r4.py
python3 -B scripts/test-luna-v3-rootfix-r5.py
python3 -B scripts/test-luna-v3-rootfix-r6.py
node --test scripts/test-luna-v3-grader-owner.js
node --test scripts/test-luna-v3-grader-staff-env.js
python3 -B scripts/test-luna-v3-grader-inclusion-price.py
node scripts/verify-hermes-send-flags.js
```

The committed owner fixtures are historical authenticated loopback Staff/PostgreSQL TEST captures, not live model conversations. The independent claims fixture freezes all 262 original `(label, category, reply, expected)` cases with source hashes. Its test invokes the actual plugin under an offline transport and the current direct/composed graders. No cases or expectations are changed to achieve a pass.

**API migration is material:** the historical independent `probe.py` omits the now-required explicit caller authority; its literal unadapted invocation intentionally fails prepared positives closed. The current-API replay supplies independently configured offline caller authority, without changing replies, owner inputs or expectations. The preserved probe's byte hash and the adapter are included in the evidence packet. Do not call the unadapted command green or infer authority from the case/receipt to make it pass.

## Fresh owner and PostgreSQL evidence

`artifacts/cap-grader-final/run-final-gates.py` (included in the evidence packet) runs a fresh real-owner database/loopback Staff instance and the full targeted suite with ephemeral TEST signing material retained only in the process environment. It records each exit status and before/after source hashes. No key is printed or written. Each run creates a new output directory and fresh databases; existing evidence is preserved. This runner uses the documented local Hermes/Node installation paths in the sealed sandbox packet. `latest-run.txt` identifies its final gate directory.

The same controller creates a separate fresh disposable DB for the complete `test-v3-postgres.js` suite; `postgres-target.json` identifies it. The suite reports real database readback. Its sandbox payment-provider receipt remains explicitly **PENDING**; an offline suite pass is not a live payment-provider claim.

### Staff child dotenv isolation

The TEST owner runner writes a per-run preload and requires it before Staff starts. It disables both dotenv entrypoints so the isolated child environment cannot be repopulated from operational `.env` files. `test-luna-v3-grader-staff-env.js` tests the actual emitted payload with the real dotenv and pg libraries.

`artifacts/cap-grader-final/run-dotenv-composed.py` additionally executes the actual owner runner and Staff child, substituting hostile virtual `.env` bytes without reading or modifying operational files. Before the patch, Staff restored four PG/native settings; the connection guard stopped execution. With the patch, the authenticated real-owner run completed with zero env reads, zero restored overrides, and two calls forwarded to the real loopback PG connect method. Successful Staff HTTP owner responses provide the complementary database-execution evidence; the counter alone is not proof of connection completion. The instrumentation denies non-loopback child sockets. RED/GREEN receipts and the exact applied patch are retained.

`npm run verify:luna-all` is also run against the candidate and approved base under the final sanitized TEST environment. Both report 48/71 green with the same 23 failing gates and no candidate-only failures. Earlier runs reported 49/71; the final sanitized-environment receipts supersede those counts. This is gate-level baseline parity, not a clean suite or proof that every failure cause is identical. Source hashes, full outputs and the comparison are retained.

## Live handoff — Skip only, after publication

The later GitHub Actions run must use the published candidate SHA, fresh real Staff owner fixtures and capability snapshot, the actual Hermes final response, retained independent request context and complete raw exchanges. Run the requested three rounds; do not replace replies with deterministic text. Keep all TEST/no-send/no-alert fences. Captain judges that evidence separately. No workflow dispatch, routing change, deployment or live pass is claimed by these offline gates.

## Limits

This is bounded English grammar, not unrestricted language entailment. Zero mismatches on the retained corpus is not proof for all English or other languages. Spelled-out dates, unrestricted names/coreference, currency names beyond the supported lexicon and unfamiliar paraphrases can be rejected. Owner receipt authenticity/custody and session binding are separate from semantic comparison. Historical corpus replays without independent caller context are diagnostic only, not acceptance gates.
