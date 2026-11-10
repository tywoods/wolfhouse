# Luna reply-style fixes — offline review and staging handoff

Branch: `captain/prod-luna-reply-style-20261110`
Base: `d6237befc1f3af308f432322e28056d3ef05edf6` (GitHub master checked during publication preparation).

## Scope

- **REPLY-CONTINUATION-001:** omitted quote totals no longer force a full-card rewrite. Stated incorrect amounts remain rejected. Normal model context and repair context receive bounded, authenticated, same-chat sent replies. Guidance retains understood full/deposit and separate/together choices through the shuttle answer, while retaining existing offer-bound consent checks.
- **CONFIRMATION-STYLE-001:** saved-confirmation repair includes guide 06 and the bound personality. Extra's Booking reference, Total and payment-due-now lines are instructed to use suitable emoji bullets. No deterministic emoji injection or styling validator.
- **LOCATION-ONCE-001:** central Staff preview resolves prior accepted sends against durable tenant/chat identity. Paid-copy and legacy personality renderers omit only repeated location content. Unknown history conservatively keeps location. Python confirmation validation permits omission when Staff proves a prior send; the model decides whether an explicit resend request warrants including the canonical map.

The existing preview endpoint gains a read-only authoring-context mode, not a new endpoint. It requires the authenticated bot guest-phone header and matching mirrored inbound message ID. Reply excerpts are limited to three messages / 1,600 characters each. Drafts and inbound quoted maps are not sent evidence. Cleared threads, other chats/tenants, mismatched final recipients, ambiguous linkage and unavailable history cannot establish suppression. Provider acceptance is not claimed to be device delivery.

Integration changes beyond the initially listed files are necessary wiring: the existing normal model-context hook; the existing Staff preview route's trusted ingress phone; recipient forwarding in both confirmation send callers; and a location-only condition in the legacy personality renderer. No routing/configuration, schema, booking-state, payment-accounting, room-type or portal/mobile UI changes.

## Verification actually executed

- Python offline runner (network connections denied): `wolfhouse.test_quote_authoring_context`, `wolfhouse.test_accepted_quote`, `wolfhouse.test_quote_polish`: **238 tests, OK**.
- `node scripts/verify-wolfhouse-location-once.js`: **PASS**, real SQL on isolated PGlite relevant-column fixtures, not a full migration-chain test.
- `node scripts/verify-location-recipient-forwarding.js`: **PASS**, both send callers pass the actual final recipient into preview without making a live send.
- `verify-hermes-send-flags`, `verify-luna-confirmation-spacing`, `verify-luna-booking-confirmation-beach`, `verify-sunset-payment-confirmation`: **PASS**.
- Python AST parsing, Staff API JavaScript syntax and `git diff --check`: **PASS**.
- Added-code static scan found no hard-coded secret assignment, shell execution, unsafe pickle loading or dynamic evaluation in tracked additions. This is a limited scan, not a security certification.

Failing-first evidence includes short-follow-up/guide/context regressions, authoring endpoint binding, clear-chat reset, recipient isolation and retention of the existing balance-payment link. The normal model-hook regression also fails against the untouched base hook and passes with this change. Additional confirmation-finalizer tests cover an unchanged valid first draft, model-authored repair, first-time location and an explicit request to resend it.

During review, replacing the whole legacy confirmation renderer was found to lose an existing balance-payment link. That approach was removed. The regression now proves a repeated-location legacy confirmation preserves every other rendered line and its existing balance link.

### Baseline failures — no full-green claim

Both untouched base and working tree fail `verify-wolfhouse-paid-confirmation-style` and `verify-wolfhouse-paid-confirmation` at the same existing Spanish shuttle expectation (`recogida el` versus rendered `recogida prevista el`). These unrelated assertions were not weakened. New location cases also run independently in the passing location-once verifier.

`verify-luna-soul-guides` fails on both trees at its existing historical byte-equivalence assertion. No unrelated guide reconstruction was attempted.

`npm run verify:luna-all`: working tree **45/73 green**, untouched base **46/73 green**. The only extra failed step in the working-tree aggregate was `verify:inbox-list-hover-delete-x`; isolated reruns passed on **both** trees. All remaining failed step names matched the base. The aggregate is still red; this report does not turn an isolated rerun into a clean full-suite result.

`assert-repo-sync.js` was run before publication and returned the documented sandbox limitation: `Could not read Lunabox repo`. GitHub master was fetched separately and matched the base. The operator's deploy preflight remains mandatory.

## Evidence

Local artifact directory:
`/opt/data/workspace/sandbox-repos/WH-captain/artifacts/prod-luna-reply-style-20261110/`

Key logs: `python-complete.log`, `final-verify-wolfhouse-location-once.log`, `final-verify-location-recipient-forwarding.log`, `red-direct-balance-link.log`, `baseline-model-hook-red.log`, `luna-all-head.log`, `luna-all-baseline.log`, `head-verify-inbox-list-hover-delete-x.log`, `base-verify-inbox-list-hover-delete-x.log`, and `repo-sync-pre-push.log`. Publication receipt and checksums are added locally after the commit is created.

## Chief review / Skip staging replay

Offline proof is not a real model-behavior pass or deployment approval. No staging/production deployment, restart, real guest send or payment was performed.

After separate staging authorization, use the existing simulator with external WhatsApp delivery OFF. An authorized operator performs booking/payment actions. Replay:

1. New chat: Ty + Jake, 2–10 July 2027, both Uluwatu, accepted mixed shared room. Use actual staging prices, not the historical amount.
2. Ask for separate full-payment links before answering the shuttle question, then decline the shuttle. Confirm one brief follow-up, no quote replay, no reopened tier/distribution and no second save ask.
3. With Extra selected, inspect the model-authored invoice's Booking reference, Total and full-payment-due-now emoji bullets, names, amounts and exact links. Exercise both a good first draft and a forced exact-value repair.
4. First invoice sends the canonical map once; subsequent paid confirmation omits the repeated address/map while retaining check-in/access facts.
5. Independently test no prior map, a cleared/fresh chat, unavailable history and an explicit request to resend the location. Missing evidence must retain the first location; an explicit request must be answered.
6. Preserve other personalities, shared-room meaning, tenant isolation, existing payment/consent behavior and rollback discipline. No production rollout is implied by this handoff.
