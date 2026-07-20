# FORTRESS Slice 15I — Payment callback boundary reaudit (B14/B15)

**Status:** reaudit complete (audit artifacts + read-only verifier only; zero runtime change)
**Master basis:** `7ae3d75f7223a3aea0027b047f2537081fa7e1ee`
**Boundaries:** `B14_stripe_locked_payment_identity`, `B15_booking_hold_payment_callbacks`
**Upstream context:** B13 remediated by FORTRESS-15B (tenant-bound Stripe payment lookup) — inventoried, not assumed to close B14/B15

## Outcome

Re-audit frozen B14/B15 after merged tenant-bound Stripe payment lookup. Trace locked-payment revalidation and booking/hold/payment callbacks from authenticated ingress through object lookup, expected tenant/client IDs, mutation, replay/idempotency, and response. Produce source-derived consumer/attack matrix, explicit overlay verdicts, and one bounded remediation contract for the remaining reproducible B15 gap.

## Historical 15A

15A matrix/attack-cases/doc remain the frozen audit (B14 `unproven`, B15 `unproven`). Status update is this overlay only — see `slice15i-b14-b15-audit-overlay.json`.

## Reaudit verdicts

| Boundary | 15A (historical) | 15I overlay | Severity |
|----------|------------------|-------------|----------|
| B14 locked payment identity | `unproven` | `proven_fail_closed` | medium |
| B15 booking/hold/payment callbacks | `unproven` | `vulnerable` | high |

### B14 — proven_fail_closed

End-to-end payment-truth apply chain (source-inventoried):

1. Stripe signature (or skip-verify) ingress
2. `resolveStripeWebhookExpectedClientSlug` → fail closed if missing/conflict
3. `lookupPaymentForStripeSession(..., expectedClientSlug)` (B13)
4. `validateStripeBookingPaymentEvent(..., expectedClientSlug)` independent slug check
5. `BEGIN` → lock booking/payment by `pm.client_id` → `validateLockedPaymentIdentityForStripeTruth` **before** already-paid shortcut
6. Mutable checks → client_id-scoped UPDATEs → COMMIT; idempotent already-paid returns without second promote

**Residual (non-blocking):** `expectedClientId` is still `pm.client_id` (row-derived); `CLIENT_MISMATCH` is tautological under the same `FOR UPDATE` predicate. Independent slug→`client_id` re-resolve is absent at B14 itself. Every production `applyStripeBookingPaymentTruthWrites` caller (webhook + reconcile) is source-proven to bind `expectedClientSlug` before apply — so the 15A compounding exploit is not independently reproducible without breaking B13 callers first.

### B15 — vulnerable

Mixed consumers: several slug-scoped SQL helpers and per-client `booking_code` uniqueness are sound. **Reproducible gap** remains on path-UUID callbacks:

| Consumer | Gap |
|----------|-----|
| `handlePaymentCreateStripeLink` | Global `WHERE p.id=$1::uuid` → `trustedClientSlug` from row; **no** `assertStaffClientAccess` |
| `handleBotPaymentCreateStripeLink` | Same global lookup; **ignores** `boundClientSlug` from 15F |
| `handleBookingServiceRecordsCreatePaymentLink` | Global booking UUID + weak `user.client_id` equality (not staff ACL) |

B13 does **not** cover these handlers (they never call `lookupPaymentForStripeSession`).

Guest `GET /pay/:bookingCode` uses slug-scoped SQL with `query.client || DEFAULT` — classified `proven_isolated_by_runtime` (wrong default → miss, not cross-tenant hit).

## Remediation contract (design only)

One bounded next outcome: **`15J_payment_uuid_callback_tenant_acl`** — see `slice15i-b15-remediation-contract.json`. Not implemented in 15I.

## Artifacts

| Path | Role |
|------|------|
| `slice15i-contract.json` | Slice contract |
| `slice15i-b14-b15-audit-overlay.json` | Overlay (preserves 15A) |
| `slice15i-consumer-matrix.json` | Source-derived consumer inventory |
| `slice15i-attack-cases.json` | Offline RED/GREEN cases |
| `slice15i-b15-remediation-contract.json` | Bounded 15J design |
| `scripts/verify-fortress-slice15i-payment-callback-boundary-audit.js` | Read-only verifier |

## Gates

```bash
npm run verify:fortress-slice15i-payment-callback-boundary-audit
npm run verify:fortress-tenant-identity-boundary-matrix
npm run verify:fortress-slice15b-stripe-payment-tenant-bind
npm run verify:waterbottle-expired-hold-payment-truth
npm run verify:sunset-stripe-payment-webhook
node scripts/verify-sunset-stripe-payment-reconcile.js
npm run verify:multiclient
npm run verify:migration-integrity
git diff --check
```

## Explicit non-goals

- No runtime edits, deploy, Stripe, DB, cloud, or live calls
- No rewrite of 15A historical B14/B15 verdicts
- No implementation of 15J in this slice
