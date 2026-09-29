# No gender ask after pay intent — L3 Implementation Plan

**Goal:** After a guest chooses payment / asks to proceed, Luna does not restart gender or group-composition intake. Resolve room policy before quoting/payment, reuse accepted room choices, and preserve safety checks.

**Architecture:** Keep the existing SOUL instruction owners, registered quote/create wrappers and shared room eligibility policy. No new conversation engine, payment path, UI, state service or gender inference source. Never turn pay intent into verified gender or override excluded-room safety.

**Tech stack:** Python unittest, registered Hermes tools, existing offline Node gates, markdown SOUL/spec.

## Scope / source
- Chief authorized PLAN + BUILD through LOCAL CLEAN only, LUNA-NO-GENDER-AFTER-PAY-INTENT-001.
- Fresh GitHub master base: e26aa4d10c14b8aac8535dc48c2876744e049a31. Separate worktree; root's unrelated changes untouched.
- L1/L2 accepted packets are separate and NOT cherry-picked/reopened. L4 remains soft, not dispatched.
- No push/PR/land/deploy, Staff UI, prod, port 8094, WABA, live guest/provider/Staff requests.

## Existing capability inventory and diagnosis
- `docker/hermes-staging/SOUL.md` already skips private-room composition, avoids direct solo gender asks, preserves known names, and requires real room eligibility.
- However short and weekly flows explicitly place room/composition AFTER payment choice (short step 7; weekly step 7). Group rules say ask immediately before create. This causes the reported sequencing error.
- `docker/hermes-staging/wolfhouse/room_eligibility_policy.py` returns `Is your group all girls, all guys, or a mix?` for unresolved groups even when `room_preference:mixed` was already accepted. Repeating quote/create can reopen settled intake.
- Registered `quote_booking` and `create_booking_from_plan` reuse this owner. Create already has normalized payment choice and create consent; payment choice is not demographic evidence.
- Sunset service booking has no accommodation allocation; its SOUL must not import Wolfhouse gender intake.

## Ranked hypotheses / falsifiers
1. SOUL ordering directs late questions: read short/weekly payment versus room steps and lock corrected order with contract test.
2. Room policy reopens already accepted mixed room: call registered create with names, full payment, mixed preference, no gender; expect transport attempt without room question. Current policy is predicted to block.
3. Missing room facts at pay boundary emit composition: call registered create/quote with payment choice and unresolved room hints; expect neutral room-only recovery, zero write, no handoff, no gender ask. Current policy is predicted to emit composition.

## Tasks
1. Write and run one focused registered-tool repro, network forbidden, response explicitly an offline transport capture (not a real successful booking). Save RED evidence outside worktree in artifacts/luna-no-gender-after-pay-intent-001.
2. Minimal room-policy repair: accepted mixed/shared preference with unknown composition can remain unknown and exclude gendered rooms; do not infer/store group_gender. Unknown preference at payment/create boundary uses neutral room recovery rather than group-composition question. Pre-payment group policy and explicit mismatch safeguards stay intact. Test missing rooms and corrections; no automatic incompatible allocation.
3. Expand registered-tool tests for quote/create, full/split/deposit choice, private and solo controls, explicit resolved genders, pre-payment controls, no duplicate room question, unknown eligibility, and existing payment tools. Observe RED before each implementation slice.
4. Change SOUL short/weekly ordering to resolve room preference before quote/payment; prohibit gender/composition asks after full/split/deposit/link intent across packs/languages. Reuse earlier fields, never re-ask known details. Unexpected missing room eligibility gets one neutral room-choice recovery, no guessed demographics or unsafe create. Sunset gets a bounded no-accommodation-intake rule. Align registered descriptions and canonical spec. Do not alter L1/L2 behavior.
5. Add focused offline gate and register with existing verify:luna-all. Exercise ordinary entrypoint when feasible with scripted model boundary (explicit fixture, not live inference), and document proof limits. No broad reply rewriting/filter layer.
6. Run focused policy/tool tests, nearby guards/room/personality gates and send-switch gate. Compare any red broad gates failure-by-failure with untouched base; do not repair unrelated baselines.
7. Freeze exact staged candidate and hashes; independent review PASS required. No concurrent product edits during review. Resolve blockers and repeat exact-candidate review.
8. Separate local commit/readback, verify clean worktree. Seal patch + bundle + plan + red/green/gates/review evidence; verify bundle import, patch applicability, archive members and SHA-256. Report LOCAL CLEAN with base, tip, packet, qualifications, no publication.

## Likely changed files
- docker/hermes-staging/wolfhouse/room_eligibility_policy.py
- docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py (room boundary/schema only)
- docker/hermes-staging/plugins/wolfhouse_staff_api/test_no_gender_after_pay_intent.py (new)
- docker/hermes-staging/SOUL.md
- docker/hermes-sunset/SOUL.md
- docs/LUNA-GUEST-BEHAVIOR-SPEC.md
- scripts/verify-luna-no-gender-after-pay-intent.js (new), scripts/verify-luna-all.js, package.json

## Chief-approved bounded extension

Chief approved allocator/availability safety for unknown-composition mixed/shared bookings after an offline reproduction: real availability inventory assigned female-only capacity beds to an unknown group accepting mixed accommodation. Preserve unknown gender; enforce compatible placement or neutral clarification/blocker, without a new gender ask or uncertainty-only handoff. Extend only existing allocator/availability owners and regression tests. No changes to routing, deployment or live services.

The newly mandatory create room guard also prevents three older payment/capability fixtures from reaching their asserted behavior (seven assertions), plus the Wolfhouse create-map fixture in the Sunset followthrough suite. Retain every assertion; supply explicitly accepted safe room prerequisites in those fixture inputs if necessary, and separately retain missing-eligibility/no-write controls. This is fixture reconciliation, not evidence of seven distinct product defects. Independent review must assess it.

New evidence must exercise real availability inventory and booking-preflight consumers, including unknown groups, mixed/shared choices, single-gender-only stock, occupied rooms, compatible success, explicit mismatch, and rules-off safety. Fresh returned unavailability must outrank caller claims.

## Acceptance and limitations
Focused reproduction must fail on the untouched base and pass on candidate; neutral recovery must never grant gendered rooms or create when eligibility remains unclear. Safe selection stays owned by existing Staff allocation; offline capture is not real DB/payment/provider proof. SOUL contract and scripted ordinary turns prove instruction loading/wiring, not every possible generated response from a live model. No live certification is claimed.
