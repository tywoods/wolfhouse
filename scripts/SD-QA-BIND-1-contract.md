# SD-QA-BIND-1 — owner/Cap contract v1 (publication held)

## SD-1704-R2 local integration and restart fix

Integrated exact Cap PR1702 `419dc1b5477da99e54a0525648d8043319de6814`
with a normal, conflict-free local merge:
`a95cd8fb9f916928bdc68ce5a6bb7f911041e22f`. First parent is
`2236be0632b6be2746a41a9e0335be494540086e`; second parent is the exact Cap SHA.
No GitHub merge, rebase, push, deployment, live service, or provider operation.
PR1701 REST reviews/comments/inline-comments were accessible and empty; its body
was read. Neither PR was changed remotely.

Root cause: cancellation/exhaustion stored the entire confirmation projection in
`confirmation_owed`. `_merge_confirmation_debt` copied that projection before
applying only present fresh fields. After amount binding and receipt refresh,
the fresh projection omitted `ask_payment_amount`, leaving the old true flag
alongside `ask_payment_distribution`. The durable question ledger had already
answered full, but final authoring received contradictory question authority.

Debt now excludes question flags at both persistence writers and at legacy debt
read/merge. Current question flags still come from the fresh owner projection.
No save admission, prompts, retry, fallback, handoff, or financial facts changed.

Two regressions use real SessionDB close/reopen: seed a saved group receipt,
create debt through the real interrupted finalizer, atomically commit the amount
question, consume `full`, invoke the actual payment tool with a throwing checkout
transport guard, close/reopen SQLite, and run recovery finalization against the
reopened receipt. They assert retained full, fresh together/separate authoring
facts, final response, staged descriptor, and the next atomically committed open
question. The legacy variant injects old stored flags. External wording is
scripted; business save/provider/model execution is not claimed.

RED was observed before the product fix at the actual finalizer's stale
`ask_payment_amount=True` assertion (`/tmp/sd1704-r2-red.log`). Subsequent
base-owner comparison confirms legacy restart failure at that same assertion
(`/tmp/sd1704-r2-legacy-red.log`). Final focused owner/runtime run: **24 tests OK**
(`/tmp/sd1704-r2-owner-green.log`).

### Integration is NOT fully green

The exact previous invocation below plus two new regressions ran **82 tests,
10 failure records, 1 expected failure**, 132.091s
(`/tmp/sd1704-r2-python-final.log`). Replacing only accepted_quote with the exact
merge-commit source (including linecache for introspection) ran 82 tests with
12 failures and 1 expected failure. The 10 existing failure records are identical;
only the two new debt regressions fail additionally with the merge owner.
This is a **base-owner comparison**, not a clean checkout comparison.

Imported integration incompatibilities retained, not weakened:
- Six serious-booking persistence controls expect one draft payment; Cap save
  now returns zero (`test_serious_booking_persistence.py:127`).
- Two solo/group subcases expect propagated PaymentAdmissionError; Cap now
  returns preserved-save/payment-admission failure instead
  (`test_saved_before_payment_sql.py:70`).
- Two finance controls encounter `invalid input value for enum
  payment_record_status: "paid"` in the imported payment path's SQL against the
  existing fixture. No SQL owner or fixture contract was altered for this task.

Cap plugin tests: **14 tests, 1 failure** (`/tmp/sd1704-r2-cap.log`).
The separate-links positive control in `test_authority_fail_closed.py:91`
expects three transport calls but gets two; all other Cap tests pass.

**Unsatisfied Cap contract:** plugin `__init__.py:2519-2525`,
`_retain_owner_payment_completion`, still catches `(ImportError, RuntimeError)`
and silently passes. `QuestionLedgerError` is a RuntimeError subtype. Running
`test_payment_completion_must_not_swallow_question_ledger_failure` with the
expected-failure attribute disabled in a disposable process fails normally:
`QuestionLedgerError not raised`. The decorator is intentionally retained;
this is not a passing integration regression. Cap must propagate the typed error.

All seven Node gates were executed with the documented environment. Six pass:
checkout-status-postgres, hermes-send-flags, luna-agreed-private-quote-on-save,
included-shuttle-and-mixed-room, luna-guest-payment-status, and
question-owner-boundaries. `verify-wolfhouse-always-save.js:106` fails with
`0 !== 40000` after imported save/draft behavior. Individual logs:
`/tmp/sd1704-r2-verify-*.log`. No Node source differs from the merge commit.

Authored delta from merge commit is limited to accepted_quote.py,
test_question_binding.py, and this document. **Zero authored prohibited-path
changes.** The 31 paths imported by the merge are separately visible with
`git diff --name-only a95cd8fb^1 a95cd8fb`; they include Cap's plugin and Staff
service/router changes. Local fix is for parent review, not a green-stack or
publication approval. The historical verification below predates integration.


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
