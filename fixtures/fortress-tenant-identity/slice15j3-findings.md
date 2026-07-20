# FORTRESS Slice 15J3 — Payment UUID callback tenant ACL (B15 remediation, no prod exports)

**Status:** implemented (source + offline verifier; no live Stripe/DB/deploy)
**Master basis:** `6d9f0e99c6c00d9831710c392ec3ac41dcef811b`
**Design freeze:** `fixtures/fortress-tenant-identity/slice15i-b15-remediation-contract.json`
**Boundary:** `B15_booking_hold_payment_callbacks`
**Outcome:** `15J3_payment_uuid_callback_tenant_acl_no_prod_exports`

## Outcome

Bind the three path-UUID payment-link callbacks to staff ACL or bot-principal tenant **before** any Stripe session create or payment/DB mutation. Object tenant comes from a read-only lookup; trusted tenant requires canonical `assertStaffClientAccess` (staff) or nonempty `boundClientSlug` match (bot). Staff foreign-object denials are **indistinguishable** from nonexistent UUIDs: same uniform 404 body (no `client_slug`, existence oracle, amount, booking, or checkout detail). Canonical ACL still runs internally; its 403 body is swallowed before the HTTP response.

## No production test exports (15J3 delta)

- Listener-level tests drive the **real** `staff-query-api` router plus staff-session and bot-token middleware.
- PG / session / Stripe boundaries inject only when **both** `NODE_ENV=test` **and** `STAFF_API_FORTRESS_OFFLINE_LISTENER=1`.
- **Production and partial-gate** `require('staff-query-api')` expose **ZERO** seam/factory/counter/router/server test exports and create **zero** `http.createServer` instances.
- Test exports (`setFortress15j3OfflineSeams`, factory, counter, router, server, route regexes) exist **only** under the full dual gate.
- **No** `STAFF_PORTAL_ACCESS_FILE` env override — production ACL file loading unchanged. Secondary-client staff ACL is injected via harness `canAccessClient` seam only.
- **No** pre-gate `Module._load` patch — harness asserts dual gate before Stripe patch.
- Clean implementation from master `6d9f0e9`; deferred `fortress/slice-15j-*` and `fortress/slice-15j2-*` are **not** ancestry.

## Historical artifacts unchanged

- **15A** matrix/doc: B15 remains `unproven`
- **15I** overlay/evidence/contract: B15 reaudit remains `vulnerable`; remediation contract remains design-only snapshot
- Guest short links, B13 Stripe lookup, B14 locked-payment identity: untouched

## Guarded routes

| Handler | Route | Control |
|---------|-------|---------|
| `handlePaymentCreateStripeLink` | `POST /staff/payments/:payment_id/create-stripe-link` | `gateStaffPaymentUuidCallbackTenantAcl` → `assertStaffClientAccess` (silent) → uniform 404 or `createPaymentLink` |
| `handleBotPaymentCreateStripeLink` | `POST /staff/bot/payments/:payment_id/create-stripe-link` | `gateBotPaymentUuidCallbackTenantAcl` (bound slug + scoped SELECT) before `createPaymentLink` |
| `handleBookingServiceRecordsCreatePaymentLink` | `POST /staff/bookings/:booking_id/service-records/create-payment-link` | `gateStaffBookingUuidCallbackTenantAcl` → `assertStaffClientAccess` (silent) → uniform 404 or payment INSERT/Stripe |

## Preserved

- Authorized secondary-client staff via `assertStaffClientAccess` / harness `canAccessClient` seam (not ACL file override)
- Same-tenant bot access when `boundClientSlug` matches
- Existing success/idempotent response shapes after ACL allow
- Open-mode staff (`STAFF_AUTH_REQUIRED=false`) still skips ACL deny inside `assertStaffClientAccess`
- Bot unbound principal still 403 `client_access_denied` (no object probe)
- Normal CLI `require.main === module` startup still creates/listens via the same factory

## Residual risk

- Other booking/hold/payment callbacks outside these three routes were inventoried by 15I as mixed/slug-scoped and remain out of scope
- Staff uniform 404 on cross-tenant UUID does not distinguish missing vs wrong-tenant (intentional; closes existence oracle)
- Bot uniform 404 on cross-tenant UUID does not distinguish missing vs wrong-tenant (intentional)
