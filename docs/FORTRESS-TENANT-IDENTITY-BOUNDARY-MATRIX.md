# FORTRESS Slice 15A — Tenant identity & confused-deputy boundary matrix

**Status:** audit only (zero live mutation / deploy / payment / guest messages)  
**Master basis:** `32b44930685450cb27ac519d052332be7b18150d`  
**Tenants:** Wolfhouse, Sunset  
**Classifier policy:** absence of evidence is `unproven`, never “safe”

## Outcome

Code-grounded, test-backed end-to-end tenant identity and confused-deputy boundary matrix across Meta WhatsApp → router → Hermes → Staff API → DB → portal → Stripe checkout → Stripe webhook → booking/hold/payment callbacks. Exactly one Slice 15B fix is **selected** (not implemented).

## Artifacts

| Path | Role |
|------|------|
| `fixtures/fortress-tenant-identity/boundary-matrix.json` | Machine-readable matrix |
| `fixtures/fortress-tenant-identity/attack-cases.json` | Offline RED/GREEN attack cases |
| `scripts/lib/fortress-tenant-identity-boundary.js` | Classifiers + secret-free scan |
| `scripts/verify-fortress-tenant-identity-boundary-matrix.js` | Verifier |
| `npm run verify:fortress-tenant-identity-boundary-matrix` | Gate |

## Verdict counts

Computed from `boundary-matrix.json` (15 boundaries):

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven_fail_closed` | 5 | Offline evidence proves reject/block on conflict |
| `proven_isolated_by_runtime` | 3 | Safe only because separate runtime/DB/secrets (architecture) |
| `unproven` | 3 | Missing evidence — fail closed in classification |
| `vulnerable` | 4 | Direct code evidence of confused-deputy / cross-tenant risk |

## Boundary chain (summary)

| ID | Chain hop | Verdict |
|----|-----------|---------|
| B01 | Meta WhatsApp signature / hub verify | `unproven` |
| B02 | Meta normalize live `client_slug` vs shadow | `vulnerable` |
| B03 | Channel resolver `phone_number_id` → tenant | `proven_fail_closed` |
| B04 | Hermes Wolfhouse `LUNA_CLIENT_SLUG` | `proven_isolated_by_runtime` |
| B05 | Sunset Hermes Somo vs Sardinero | `proven_fail_closed` |
| B06 | Staff API `requireBotAuth` principal | `vulnerable` |
| B07 | Bot body/query `client_slug` trust | `vulnerable` |
| B08 | Session `assertStaffClientAccess` | `proven_fail_closed` |
| B09 | Portal host / `DEFAULT_CLIENT_SLUG` vs session | `proven_fail_closed` |
| B10 | DB `client_id` / `client_slug` predicates | `proven_fail_closed` |
| B11 | Stripe checkout / payment-link creation | `proven_isolated_by_runtime` |
| B12 | Stripe webhook signature | `proven_isolated_by_runtime` |
| B13 | Stripe webhook payment lookup | `vulnerable` **(critical)** |
| B14 | Locked payment identity revalidation | `unproven` |
| B15 | Booking/hold/payment lookup callbacks | `unproven` |

Full per-boundary fields (`source_identity`, `trusted_principal`, `untrusted_tenant_fields`, `conflict_behavior`, `db_scope_predicate`, `payment_secret_account_binding`, `cross_tenant_object_id_behavior`, evidence paths/lines/tests) live in the JSON matrix.

## Critical / high findings (ranked)

1. **Critical — B13** Stripe webhook `lookupPaymentForStripeSession` falls back to `metadata.payment_id` with `WHERE p.id = $1::uuid` and **no `client_id` predicate**. `validateStripeBookingPaymentEvent` rejects `client_slug` mismatch only when `metadata.client_slug` is present.  
   Evidence: `scripts/lib/stripe-webhook-payment-truth.js:54-79,128-136`; caller `scripts/staff-query-api.js:13566-13786`.

2. **High — B06** Bot token auth returns `{ role:'operator', staff_user_id:'luna-bot-internal' }` with no tenant. `getAccessibleClientSlugs` returns **all** baseline clients when `user.email` is missing.  
   Evidence: `scripts/staff-query-api.js:1200`; `scripts/lib/staff-portal-clients.js:298-300`.

3. **High — B07** Generic `/staff/bot/*` uses `body.client_slug || DEFAULT_CLIENT` where `DEFAULT_CLIENT` is hardcoded `'wolfhouse-somo'` (ignores `DEFAULT_CLIENT_SLUG`). Sunset bot routes force `client_slug=sunset` (contrast).  
   Evidence: `scripts/staff-query-api.js:742,14745-14753,39227+`; `scripts/lib/staff-bot-v2-routes.js`.

4. **High — B02** Meta normalize keeps legacy `client_slug` (`wolfhouse-somo` default) while `tenant_channel_shadow` may resolve Sunset; hard blocking not enabled.  
   Evidence: `scripts/lib/luna-meta-whatsapp-webhook.js:14-15,196-251`; `docs/MULTICLIENT-STAGING-ROUTING.md`.

5. **High — B14** Locked payment revalidation binds to `expectedClientId` from the already-selected payment row — cannot independently defeat a poisoned B13 lookup.  
   Evidence: `scripts/lib/stripe-hold-promote-policy.js:169-217`.

6. **High — B01 / B12 / B15** Signature skip / skip-verify footguns and mixed callback scoping remain `unproven` or runtime-isolated only.

## Attack cases covered (offline)

RED/GREEN fixtures exercise: conflicting tenant in header/body/query model, forged `client_slug`/`location_id`, other-tenant payment UUID, duplicate location ID registry check, wrong WhatsApp `phone_number_id`, mixed Stripe metadata/session binding, Sunset Somo vs Sardinero confusion, portal session vs request mismatch, email-less bot ACL.

Fake sample IDs only (`*_SAMPLE`, `cs_test_*`, UUID fixtures). Never real secrets or external requests.

## Selected Slice 15B outcome (selection only — do not fix in 15A)

**ID:** `15B_stripe_metadata_payment_lookup_tenant_bind`  
**Boundary:** `B13_stripe_webhook_payment_lookup`  
**Why:** highest severity, directly evidenced, smallest ownership surface, regression-testable offline.

**Owner files**

- `scripts/lib/stripe-webhook-payment-truth.js`
- `scripts/staff-query-api.js` (webhook caller only as needed)

**Acceptance tests (for 15B implementation)**

- RED: metadata-only lookup with other-tenant `payment_id` must not select/apply  
- RED: metadata-only lookup missing `metadata.client_slug` must fail closed  
- RED: `metadata.client_slug` mismatch vs payment must fail closed  
- GREEN: authoritative `session.id` match still applies when metadata slug absent  
- GREEN: same-tenant metadata-only path requires explicit client predicate in SQL/validation  

## Gates

```bash
npm run verify:fortress-tenant-identity-boundary-matrix
npm run verify:multiclient
npm run verify:staff-auth-api
npm run verify:waterbottle-expired-hold-payment-truth
npm run verify:migration-integrity
# secret-free scan is included in the fortress verifier
npm run verify:luna-all   # if unaffected/feasible
git diff --check
```

## Explicit non-goals (15A)

- No behavior fix  
- No live Stripe / Meta / WhatsApp / DB mutation  
- No deploy  
- No PR/merge in this slice (branch push only per operator request)
