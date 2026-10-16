# BOOKING-SIM11-REPAIR-13f714cd-20261016T1910

## Scope and custody

- Base: `13f714cd830c8b9e80ebab5d76dd4f91b5d9c212` (LIVE `origin/master` when worktree was created).
- Branch: `fix/booking-sim11-repair-13f714cd`.
- Source-only repair in isolated worktree `/opt/data/workspace/BOOKING-SIM11-REPAIR-13f714cd`.
- No deploy, restart, simulator turn, WhatsApp send, booking write, Stripe call, or live Staff API call.

## Step 0: Jim payment/confirmation audit

The requested live read-only audit for paid booking `WH-20261020-08231490` (`+999956030938002`) was **not available from this isolated source checkout** without entering prohibited hosts/services. Therefore this report does not claim a payment-source metadata value or a webhook `confirmation_auto_send` audit result.

Because there is no deterministic evidence that Jim's audit result was `luna_auto_send_not_enabled`, the Wolfhouse TEST provider-free confirmation mirror was **not implemented**. No cause was guessed from static defaults.

## Repair

### G1/G4 — one owner-backed offer path

`quote_booking` now asks Staff availability first when exact beds are absent. It proceeds to `/booking-preview` only when Staff returns a complete, unambiguous party-sized bed selection. Clarification, insufficient availability, or incomplete selection produces a typed unresolved-eligibility result with no amount and no `offer_revision`.

The existing owner ledger records and renders the resulting bed-backed quote. A model-authored price/payment invitation cannot become presentation evidence while eligibility is unresolved; the owner substitutes the Staff-safe clarification instead. No price-only presentation is created.

### G2 — Staff owns exact-bed eligibility

The JS Staff availability service emits `exact_bed_eligibility` from its existing `validateExplicitBedSelection` result. Python no longer classifies room labels (including `operator_surfweek`); it verifies that Staff's positive receipt is bound to the exact ordered beds, persons, and dates. A narrow legacy compatibility path accepts only a Staff response whose returned bed rows exactly equal the requested ordered bed list; larger, missing, reordered, occupied, or substituted lists do not authorize create.

### G5 — exact revalidation and recovery

The reproduced mismatch is Staff exact-bed eligibility failure, not an argument-order mismatch. On mismatch, checked/create readiness is revoked and retry performs no create. The immutable accepted presentation/snapshot and its acceptance identity remain preserved. Only a materially identical, Staff-positive exact revalidation restores `checked_offer`, presentation create readiness, and dispatch authority. Changed or ineligible beds remain blocked.

### `flag_needs_human` 403

The generic route now relies on the authenticated Staff bot principal's tenant binding instead of supplying a competing body tenant override. Typed tenant denial details are surfaced as `tenant_auth_subreason`; no permission scope was widened.

## Cap independent offer-boundary proof

Cap supplied fixture SHA-256 was verified unchanged:

```text
f5a840d7b5d60ec0fa1539d8c359da6e85b627ea777a01abce2d255b70aac3d1  replay_offer_boundary.py
```

Exact candidate command (artifact copied byte-for-byte from the supplied attachment; captured `guest1.jsonl` placed at its documented relative input path):

```sh
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHON_DOTENV_DISABLED=1 PYTHONPATH=/opt/data/workspace/BOOKING-SIM11-REPAIR-13f714cd/docker/hermes-staging:/opt/data/workspace/BOOKING-SIM11-REPAIR-13f714cd/docker/hermes-staging/plugins:/opt/hermes /opt/hermes/.venv/bin/python /opt/data/workspace/evidence/CAP-SIM11-PROOF/acceptance-proof/replay_offer_boundary.py
```

Output/exit:

```text
booking_owner_refusal category=quote_owner_presented_offer_required comparison_key=unknown
booking_owner_refusal category=quote_owner_presented_offer_required comparison_key=unknown
{"case":"emre_null_revision", ... "presentation_before":false,"presentation_after":false,"identity_stable":true,"captured_payment_invitation_passed_through":false,"final_error":"quote_owner_presented_offer_required","inert_create_calls":0, ...}
{"case":"jim_checked_control", ... "presentation_before":true,"presentation_after":true,"identity_stable":true,"captured_payment_invitation_passed_through":false,"final_error":null,"inert_create_calls":1, ...}
BOUNDARY CONTRACT PASS; not a live acceptance result
```

Exit code: `0`. Emre's synthetic unresolved-eligibility case no longer leaks the payment invitation or creates. Jim's checked control remains presented and reaches the inert create exactly once.

## Tests

```text
python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_selected_bed_retention.py -q
Ran 13 tests in 0.068s — OK

python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_handoff_reason_contract.py -q
Ran 6 tests in 0.161s — OK

node scripts/verify-sim11-exact-bed-eligibility.js
PASS Staff-authoritative exact bed eligibility: valid, occupied, changed

env -i ... /opt/hermes/.venv/bin/python docker/hermes-staging/wolfhouse/test_accepted_quote.py -q
Ran 79 tests in 110.232s — OK

git diff --check
exit 0
```

`test_accepted_quote.py` includes the G5 exact mismatch/recovery/no-retry regression and owner-path regressions. The JS verifier proves valid operator-room exact beds pass while occupied and changed/nonexistent beds fail.

## Hold

Candidate is source-only and must remain undeployed/unrestarted pending Captain exact-head review.
