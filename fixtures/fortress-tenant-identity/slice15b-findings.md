# FORTRESS Slice 15B — Stripe payment lookup tenant bind

**Status:** remediated (B13 closed by runtime tenant bind)
**Master basis:** `8ed81111b9a67a656dee0b7dbd5a46ab91ca125c`
**Boundary:** `B13_stripe_webhook_payment_lookup`
**Live mutation:** none (code + offline tests only)

## Outcome

Fail-closed bind of Stripe checkout-session payment lookup and validation to an authoritative deployment/runtime tenant slug. Stripe metadata is never tenant authority.

## Historical 15A

15A matrix/attack-cases/doc remain the frozen audit (B13 `vulnerable`). Status update is this overlay only — see `slice15b-b13-remediation-overlay.json`.

## API / config

| Surface | Behavior |
|---------|----------|
| `lookupPaymentForStripeSession(pg, session, expectedClientSlug)` | Requires nonempty slug. Session-id SELECT: `AND cl.slug = $2`. Metadata fallback: require `metadata.client_slug === expectedClientSlug` before any `p.id` UUID query; SELECT also `AND cl.slug = $2`. Rejected fallback reports `queried=true` / `query_count=1` (session miss already ran) with `metadata_fallback_queried=false` / `metadata_query_executed=false` — it does not probe `metadata.payment_id` existence. Early missing slug/invalid session stay `queried=false` / `query_count=0`. Session hit `query_count=1`; metadata path `query_count=2`. Returns `{ ok, payment, reason, queried, query_count, lookup_path, metadata_fallback_queried, metadata_query_executed }`. |
| `validateStripeBookingPaymentEvent(..., expectedClientSlug)` | Independent `pm.client_slug === expectedClientSlug`; retains metadata/session/amount/status checks. |
| `resolveStripeWebhookExpectedClientSlug(env)` | `STRIPE_WEBHOOK_CLIENT_SLUG` preferred; nonempty `DEFAULT_CLIENT_SLUG` compat; both conflict or neither → fail closed `no_db_write`. No hardcoded tenants. |
| Webhook | Resolve tenant before DB; 503 + `no_db_write` if unconfigured. Addon path inherits scoped lookup. |
| `reconcilePaidStripeSession` | Requires `meta.expectedClientSlug`; batch helpers pass `clientSlug`. |

## Rollout (both tenant deployments)

Set **`STRIPE_WEBHOOK_CLIENT_SLUG`** on each Staff API runtime to that deployment’s tenant slug. Optionally keep matching nonempty `DEFAULT_CLIENT_SLUG`. Missing or conflicting values fail closed with no payment write.

## Gates

```bash
npm run verify:fortress-slice15b-stripe-payment-tenant-bind
npm run verify:fortress-tenant-identity-boundary-matrix
npm run verify:waterbottle-expired-hold-payment-truth
npm run verify:sunset-stripe-payment-webhook
npm run verify:sunset-stripe-payment-reconcile
npm run verify:multiclient
npm run verify:staff-auth-api
npm run verify:migration-integrity
git diff --check
```

## Explicit non-goals

- No live Stripe / DB / payment / deploy / guest calls
- No signature skip-verify enablement
- No PR/merge in this slice
