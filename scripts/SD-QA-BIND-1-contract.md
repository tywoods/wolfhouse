# SD-QA-BIND-1 — owner/Cap contract v1 (publication held)

## Typed seam

`accepted_quote.commit_question_outbound(text: str, kind: str, options: list[str], *, messages=None)`
requires a consumed owner turn and returns `{contract_version: 1, message_id: int,
question: dict}`. One SQLite transaction uses SessionDB `_insert_message_rows` for
all new prefix rows and the final assistant transcript, updates message/tool
counters and persists the question ledger. Prefix or metadata failure rolls all
of these back. Original timestamps and assistant reasoning/Codex metadata survive.
The runtime freezes and validates the historical boundary by value; copied history
is not inserted again. Multimodal persistence matches normal runtime text-summary
normalization on a copy, leaving live content intact. This is local persistence,
**not provider delivery**.

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
has behavioral coverage through the installed owner wrapper, real finalizer and
SQLite writer: saved receipt yields a durable deposit/full question with the final
message ID, without calling the model loop. The test seeds the recovery admission
state and substitutes create/confirmation authoring: **not** autonomous recovery,
authenticated retry-token admission, business persistence or provider evidence.
A negative control bypassing outbound commit fails on missing transcript rows.

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
both an injected transport exception and a real PostgreSQL BEFORE UPDATE trigger
failure in booking_guests. The latter returns `payment_update_failed` with
`partial_stripe_session=true`, leaves payment draft, and preserves saved
booking/guest/bed rows. This is **not** a registered owner-consent checkout
continuation proof.

## Verified locally

Foreground final run: **80 tests, OK (expected failures=1), 137.968s**.
Log: `/tmp/sd-bind-complete-python.log`. Exact invocation:

```sh
export NODE_OPTIONS=--max-old-space-size=1024
export NODE_PATH=/tmp/sd-0250-pg/node_modules
export PYTHONPATH=docker/hermes-staging:docker/hermes-staging/plugins:/opt/hermes
/opt/hermes/.venv/bin/python -m unittest -v \
  wolfhouse.test_infer_payment_completions \
  wolfhouse.test_deposit_or_full_after_save \
  wolfhouse.test_saved_payment_distribution \
  wolfhouse.test_save_payment_marker \
  wolfhouse.test_serious_booking_persistence \
  wolfhouse.test_saved_before_payment_sql \
  wolfhouse.test_incident_solo_finance \
  wolfhouse.test_question_binding \
  wolfhouse.test_question_runtime \
  wolfhouse.test_question_cap_pending
```

The __new__ harness initializes existing-session runtime flush state. No
`Session DB append_message failed` appears in the final log. Existing authoring
advisories and deprecated environment warning remain visible, not suppressed.
The legacy default-bearing plan negative test requires durable bound consent;
older positive fixtures now explicitly bind their prior amount/distribution.

All six gates from SD1701R3-local-verification.md plus
`verify-question-owner-boundaries.js` passed (each exit 0), foreground, with the
same Node environment: `/tmp/sd-bind-complete-node.log`.

Multimodal parity test first failed because the atomic path persisted raw image
payloads; after copy-only normalization it passes against actual runtime output.
Recovery missing-writer negative control failed as intended; normal case passes.
Copied history, tool-prefix SQL rollback, assistant metadata/timestamps/tool
accounting, SQLite metadata rollback and unsupported-kind/options controls pass.
Incident 74753 is synthetic; real incident mapping remains known-open. No live
runtime edits, services, deployment, restart, provider sends, push, or forbidden
owner files changed. Parent independent review and Cap integration remain required.
