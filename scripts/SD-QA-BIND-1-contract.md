# SD-QA-BIND-1 — owner/Cap contract v1 (publication held)

## Typed seam

`accepted_quote.commit_question_outbound(text: str, kind: str, options: list[str])`
requires a consumed owner turn and returns `{contract_version: 1, message_id: int,
question: dict}`. One SQLite transaction inserts the final assistant transcript,
updates session message_count and persists the question ledger. Metadata failure
rolls all three back. This is local persistence, **not provider delivery**.

Supported kinds/options:
- `add_on`, `go_ahead`: `[accepted, declined]`
- `payment_choice`: `[deposit, full]` or `[together, separate]`
- Other kinds (including unimplemented names binding) fail closed.

Question record: question_id, kind, field, options, asked_message_id,
outbound_digest, scope, status (`open`/`answered`), answer (selected_option,
raw, inbound_message_id). Answer history is retained. Only consumed current
scoped ingress binds an offered option; old bubbles and model distribution
parameters are not consent. A combined amount/distribution answer cannot answer
the subsequent distribution question before it exists.

`question_runtime.final_outbound` defers intermediate runtime flushes until
finalization and persists the final question via the atomic seam, not ordinary
append_message. Normal and automatic recovery returns use it. Runtime flush
method restoration is unconditional. Runtime tests execute the locally installed
flush implementation; that installation is **not pinned provenance**. Recovery
branch wiring has a source regression; it is not an autonomous recovery proof.

## Cap dependencies — QUEUED, not satisfied by this commit

`QuestionLedgerError.code = question_ledger_failed` and
`PaymentAdmissionError.code = payment_admission_failed` are RuntimeError subtypes.
Do not swallow them in broad RuntimeError handlers, substitute empty question
state, or turn persistence/admission failure into successful send/checkout.
Preserve an already committed saved-booking receipt; reject checkout independently.
Gateway integration must prevent transport for failed turns. Registered plugin
admission and exception propagation remain Cap-owned. The expected-failure test
`test_question_cap_pending` proves the current completion-retention swallowing gap;
remove its decorator when the Cap fix lands and require a normal pass.

The SQL regression uses real Staff create rows, then the real payment handler with
an injected transport exception and confirms saved booking/guest/bed rows survive.
This is **not** a registered owner-consent checkout continuation proof.

## Verified locally

Foreground run: required 56 tests plus 16 owner/runtime tests and 1 queued Cap
regression: **73 run, OK (expected failures=1), 119.713s**.
`/tmp/sd-bind-final-python.log`. Earlier required-only rerun: **56 OK, 118.196s**.
The __new__ harness now initializes existing-session runtime flush state; final
logs contain no `Session DB append_message failed`. Existing authoring advisories
and deprecated environment warning remain visible, not suppressed.

All six gates from SD1701R3-local-verification.md plus
`verify-question-owner-boundaries.js` passed (exit 0), foreground:
`/tmp/sd-bind-node-final.log`. Initial Node attempt lacked NODE_PATH and failed;
rerun explicitly exported NODE_PATH and NODE_OPTIONS and passed.

RED observed for model-distribution consent and early recovery wiring, then GREEN.
SQLite metadata rollback and unsupported-kind/options controls pass. Incident
74753 is synthetic; real incident mapping remains known-open. No live runtime
edits, services, deployment, restart, provider sends, push, or forbidden owner
files changed. Parent independent review and Cap integration required before PR.
