# Luna room-fill runtime connection

## Scope and owner

`clients.settings.luna_room_fill_policy` now feeds the existing Wolfhouse server-side allocator through the tenant-scoped bed-calendar inventory read. Both canonical capacity selection and booking-assignment selection use it. No model/plugin routing, Room Setup controls, selling-mode policy, payments or booking-commit writes are changed.

Staff API reports `activationStatus: "connected"` for this code capability. `configured`, `policyStatus`, and catalogue-review fields still describe whether a saved policy exists and is usable. This is not a deployment receipt or an enable/disable switch for guest automation.

## Ordering contract

- **Fill House:** lowest projected peak nightly occupancy, then projected mean nightly occupancy, normalized by active/sellable bed capacity; room priority breaks ties.
- **Fill Room:** saved room priority before the legacy consolidation/best-fit ordering.
- Existing eligibility filters, dedicated/operator/flipped-room tier order, private restrictions, bed blocks, and party-together decisions remain ahead of ranking.
- Only when the existing allocator must split a party does House rebalance one place at a time, within the existing eligible tier. Room packs the saved order.
- Staff preview and runtime use the same pure occupancy scorer/comparator in `scripts/lib/room-fill-ranking.js`; the Staff preview is not used as a booking allocator.

## Boundaries and fallback

- Policy comes from SQL for the trusted tenant, never from tool-body settings. Wolfhouse policy/catalogue metadata is not projected for another tenant.
- No saved policy retains the existing legacy ranking and legacy demo behavior.
- Unsupported, malformed or stale policy/catalogue fails closed for **automatic selection** with `room_fill_policy_requires_review`.
- Accepted exact bed codes still use their existing validator and retain their order. A fill-settings change is not permission to replace those beds. Expired/unavailable selections still reject rather than silently swap.
- A saved policy requires real persisted inventory. CSV fallback cannot resurrect disabled or absent rooms. The zero-active-room edge makes an additional read-only tenant-settings query because there is no inventory row on which to project the setting.
- Runtime capacity checks remain capacity checks; final assignment keeps the existing gender-aware validation. This change does not broaden the pre-existing availability contract into a booking promise.
- Shared/Private/Private optional semantics, full-stay private companion locks, and revalidation before commit remain under their existing owners.

## Offline verification

```bash
node --test scripts/verify-luna-room-fill-runtime.js
node --test scripts/verify-luna-mixed-room-allocation.js
node --test scripts/verify-staff-room-fill-policy.js
node --test scripts/verify-staff-room-fill-routes.js
node scripts/verify-luna-bed-allocator.js
node scripts/verify-luna-front-desk-accommodation-availability-service.js
node scripts/verify-luna-explicit-bed-selection.js
node scripts/verify-room-selling-allocator.js
node scripts/verify-room-selling-consumers.js <artifact-directory>
node scripts/verify-room-selling-booking.js <artifact-directory>
node scripts/verify-room-selling-mode.js <artifact-directory>
node scripts/verify-luna-all.js
```

The new regression uses real offline SQL plus Staff save/readback/preview handlers and the ordinary canonical availability service, not a synthetic placement implementation. It prohibits network access. It includes the original three divergent cases, changed priorities, normalized nightly occupancy, splits, safety precedence, exact selections, invalid/stale policy, tenant isolation and all-inactive inventory. The mixed-room mock accepts only the new idempotency lookup in addition to its previous read allowlist; its safety assertions are unchanged.

Publication is a review handoff only. Skip owns review and TEST Staff landing. No merge, deploy or live guest action is part of this change.
