# FORTRESS Slice 15J — Payment UUID callback tenant ACL (B15 remediation)

**Status:** implemented (source + offline verifier; no live Stripe/DB/deploy)
**Master basis:** `6d9f0e99c6c00d9831710c392ec3ac41dcef811b`
**Design freeze:** `fixtures/fortress-tenant-identity/slice15i-b15-remediation-contract.json`
**Boundary:** `B15_booking_hold_payment_callbacks`

## Outcome

Bind the three path-UUID payment-link callbacks to staff ACL or bot-principal tenant **before** any Stripe session create or payment/DB mutation. Object tenant comes from a read-only lookup; trusted tenant requires canonical `assertStaffClientAccess` (staff) or nonempty `boundClientSlug` match (bot). Fail closed without disclosing foreign object details beyond canonical deny / uniform miss.

## Historical artifacts unchanged

- **15A** matrix/doc: B15 remains `unproven`
- **15I** overlay/evidence/contract: B15 reaudit remains `vulnerable`; remediation contract remains design-only snapshot
- Guest short links, B13 Stripe lookup, B14 locked-payment identity: untouched

## Guarded routes

| Handler | Route | Control |
|---------|-------|---------|
| `handlePaymentCreateStripeLink` | `POST /staff/payments/:payment_id/create-stripe-link` | `gateStaffPaymentUuidCallbackTenantAcl` → `assertStaffClientAccess` before `createPaymentLink` |
| `handleBotPaymentCreateStripeLink` | `POST /staff/bot/payments/:payment_id/create-stripe-link` | `gateBotPaymentUuidCallbackTenantAcl` (bound slug + scoped SELECT) before `createPaymentLink` |
| `handleBookingServiceRecordsCreatePaymentLink` | `POST /staff/bookings/:booking_id/service-records/create-payment-link` | `gateStaffBookingUuidCallbackTenantAcl` → `assertStaffClientAccess` before payment INSERT/Stripe |

## Preserved

- Authorized secondary-client staff via `assertStaffClientAccess` / `userCanAccessClient`
- Same-tenant bot access when `boundClientSlug` matches
- Existing success/idempotent response shapes after ACL allow
- Open-mode staff (`STAFF_AUTH_REQUIRED=false`) still skips ACL deny inside `assertStaffClientAccess`

## Residual risk

- Other booking/hold/payment callbacks outside these three routes were inventoried by 15I as mixed/slug-scoped and remain out of scope
- `assertStaffClientAccess` 403 body may include `client_slug` (canonical staff ACL semantics elsewhere) — does not return foreign payment/booking fields
- Bot uniform 404 on cross-tenant UUID does not distinguish missing vs wrong-tenant (intentional)
