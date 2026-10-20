# Booking cleanup Step 3 contract

## Scope

This slice keeps checked commercial identity, trusted occupant-slot display facts, and typed clarification state distinct from quote through completion, revalidation, and create.

* Canonical names remain comparison/identity authority. Guest spelling and accents may be rendered only when the same indexed occupant normalizes to the canonical identity; stale names cannot relabel beds.
* An explicit whole-party `male`/`female` fact may fill unnamed slots for typed room eligibility. A contradictory person-bound fact wins for that slot. Names and room preferences never imply eligibility.
* Missing package selection, accommodation-only, policy ineligibility, retrieval failure, and stock failure remain distinct. Staff-backed options are explained before one package question.
* Corrected dates and the known slot name are retained when asking the sole unresolved eligibility question.
* `female preferred`/`male preferred` inventory is shared, not exclusive. Completion must not strengthen the checked room promise.
* Booking intent before price is not acceptance. Unchanged, accepted revalidation and same-slot name completion need no second consent; material terms and session fences still invalidate consent.

## Evidence and exclusions

`fixtures/booking-cleanup-step3/sim24-cases.json` is derived provenance, not raw capture or reconstructed Staff responses. The six JSONL files and `CHATS.md` remain external and byte-identical. Guest 9 is audit-only and creates no ranking expectation.

No allocator ranking, inventory policy, DB schema/data, payment lifecycle, routing, prompt, deploy, live query, or guest-message change is included. Offline tests use constructed receipts where full historical bodies are unavailable. A successful create/link summary does not prove payment.
