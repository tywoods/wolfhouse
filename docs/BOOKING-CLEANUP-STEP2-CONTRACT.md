# Booking Cleanup Step 2 contract

Base: `f76c34f06c9395ad610625283b26959597523d25` (tree `f48a0fbe65bc7cac9914c694da300971c121663b`).
Brief: `BOOKING-CLEANUP-STEP2-BUILD-20261019T1955`, R2 brief SHA-256 `276ce42305d0f733627fc12059405b906a0e2a745f694d7890fdfc4b416e853c`.

## Preserved Step 1 authority

The Step 1 `room_eligibility` object is unchanged: `status` is `yes|no|unsure`; `requested_room_preference`, zero-based `affected_guest_indices`, `reason_code`, and `question_kind` retain their documented meanings. Staff remains authoritative for eligibility and stock. Stock, package policy, and room eligibility are separate outcomes. Payment math, offer revisions/fingerprints, assignment order, create validation, idempotency, and SQL are unchanged.

## Typed clarification

An offerless package-preview response with `package_choice_needed` is rendered as a package question. A package transport/policy-availability failure asks whether the guest wants an accommodation-only quote; it does **not** claim the requested room is unavailable and does not silently select accommodation-only. A structured room `unsure`/`no` response continues through the Step 1 renderer. A known no-stock result continues to use the bounded room refusal. Arbitrary Staff prose is never classified.

A one-person affected scope is singular and person-scoped in EN/ES/FR/DE. Date, name, and payment updates do not establish eligibility. Explicit contextual person facts remain subject to the existing owner evidence and Staff recheck contracts; there is no asked-once assumption, name-based demographic inference, or mixed-room substitution.

## Presentation only

A checked assignment remains authoritative. The renderer may use the guest's original spelling only when the same zero-based slot normalizes to the assignment identity. This preserves case, accents, compound names, and duplicates without changing assignment order or fingerprints. A stale/mismatched roster falls back to Staff's assignment name. Single-bed room copy is naturalized while preserving only the authoritative room strategy; `male_preferred` and `female_preferred` remain neutral shared-room descriptions, never exclusivity claims. Same-room/split disclosure is retained.

Known payment choice remains selected. Consent is still required after the first shown price. Equal deposit/total behavior from Step 1 remains one full-payment line.

## Evidence boundaries

The Becker registered/SQL control retains the two-stage captured shape: availability first uses `male dorm` with no roster or group field, then the quote/package stage uses `male_only` with `group_gender=male`. The separate focused package-failure fixture is synthetic. These controls prove boundary/domain separation, not the unavailable historical HTTP response body or live cause. No live call was made.

Lucía remains audit-only. The allocator and ranking/settings were not edited. Existing mixed-pool regressions continue to permit R1 or R3. Matching retained probe 4019 policy/rank/occupancy evidence was not present in this worktree, so no claim is made about the historical exact selection.

Sim23 amounts used by inherited registered/SQL controls are scenario fixtures, not production tariffs: Lucía €100 deposit / €120 total; French group €240 full; Becker €200 deposit / €240 total; Emma 4–7 November €120 full; Raj R1-B4 €80 full. Historical captures are immutable and were not edited.
