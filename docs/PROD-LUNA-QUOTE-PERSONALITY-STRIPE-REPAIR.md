# Wolfhouse production: quote, personality and test-payment repair

## Scope and status

Repository fixes only: correct suffix-currency punctuation in classic Luna's money
parser, and admit the exact existing private production Staff origin for personality
settings. No guest prose templates, pricing changes, new runtime, migrations,
Skipper configuration, production deploy, webhook creation or payment replay.

The payment failure is **not fixed by merging these Python changes**. The production
Stripe endpoint/signing configuration and the missed event require an authorized
operator under a separately approved production window. Captain does not execute
those steps. Do not call this incident resolved until the acceptance below passes.

## Verified causes (2026-11-09 read-only investigation)

- A valid quote of the form `Anna: Uluwatu – 349 €` was rejected because suffix-currency
  token matching consumed the whitespace after the dash. The sign check then saw
  the dash as adjacent. Repair timed out and the conversation was flagged.
- Production selected Extra but `http://staff-api:3036` was not in the personality
  module's exact internal HTTP allowlist. The consumed pack silently became Sunny.
  Staging loaded Extra. The new origin is already declared in the production Compose
  file; other HTTP origins, redirects and Sunset's isolated policy remain unchanged.
- Stripe reported the affected test Checkout Session paid, but the account had only
  the staging webhook endpoint. Production lacked `STRIPE_WEBHOOK_SECRET` and its
  payment row remained unpaid. Production's ingress tenant slug was present.
- The Staff API image IDs matched. Compared Luna booking modules matched; image,
  simulator overlays, settings and DB columns were not wholly identical. This PR
  does not assert complete staging/production parity or reconcile unrelated schema.

## Offline verification

Regression tests live in `test_quote_polish.py` and `test_luna_personality.py` under
`docker/hermes-staging/wolfhouse/`. Use the pinned Hermes runtime for integration
suites, its dependencies, and both the source and plugin paths in `PYTHONPATH`.

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=docker/hermes-staging:docker/hermes-staging/plugins:/path/to/pinned-hermes \
  /path/to/hermes-python -m unittest \
  wolfhouse.test_quote_polish wolfhouse.test_quote_authoring_context \
  wolfhouse.test_luna_personality wolfhouse.test_luna_personality_gateway_bind
node scripts/verify-hermes-send-flags.js
node scripts/verify-wolfhouse-stripe-webhook-tenant-slug.js
node scripts/verify-fortress-slice15b-stripe-payment-tenant-bind.js
node scripts/verify-radar-slice16m-stripe-event-claim.js
node scripts/verify-radar-slice16o-stripe-webhook-error-minimization.js
node scripts/verify-sunset-stripe-payment-webhook.js
node scripts/verify-wolfhouse-paid-confirmation.js
node scripts/verify-wolfhouse-paid-confirmation-style.js
```

These are offline/fixture checks, not proof of a live payment, model-generated tone
or WhatsApp delivery. Preserve baseline failures and report them rather than removing
assertions. In particular, the historical 16M and 16O gates also assert branch-name
policies; those branch assertions failing are not failures of duplicate-event or
signature-error behavioral checks.

## Production test-Stripe work order — authorized operator only

1. **Re-read before change.** Confirm current containers, image digests, effective
   Compose files/mounts and environment-file paths. The observed production service
   is `wolfhouse-prod-staff-api`, Compose service `staff-api`, with resident file
   `/opt/wolfhouse-prod/release/deploy/wolfhouse-prod/compose.yaml`. Observed
   `STAFF_PUBLIC_BASE_URL=https://wh.lunafrontdesk.com`. Confirm TLS/routing reaches
   this production service at `https://wh.lunafrontdesk.com/staff/stripe/webhook`;
   a hostname or generic 200 response alone is insufficient.
2. **Seal scope and rollback.** Obtain Chief review and Ty's exact window, operator,
   service/config allowlist, affected test-event identity and intended recipient.
   Back up effective production config securely and record old image/overlay hashes.
   Do not replace production state or data with staging copies. Retain simulator
   admission and test-reset overrides; do not bulk-copy staging environment files.
3. **Create the production destination in the same Stripe test account.** Preserve
   staging's destination. Subscribe to the handler's supported events:
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   Do not switch to live Stripe, regenerate a Checkout Session, or make another charge.
   Creating/enabling a destination may deliver other test events; approval must cover
   that effect. Prove unmatched staging sessions cannot update production bookings.
4. **Install that destination's own signing secret securely.** Set
   `STRIPE_WEBHOOK_SECRET` only through the approved production secret mechanism;
   never paste it into Git, images, Discord, terminal output or receipts. Configure
   `STRIPE_WEBHOOK_CLIENT_SLUG=wolfhouse-somo`, keep the existing ingress slug aligned,
   and keep `STRIPE_WEBHOOK_SKIP_VERIFY=false`. Do not reuse staging's signing secret.
   An authorized operator applies only the approved Staff service/config change.
5. **Check delivery prerequisites before replay.** Verify signature enforcement,
   tenant binding, confirmation policy and effective send flags. Do not automatically
   enable broad send switches. Re-read the booking/payment/hold state: a now-expired
   hold, cancellation or terminal booking can correctly suppress confirmation and
   needs separate handling. Do not revive it or release Kathi's staff flag blindly.
6. **Recover the original event once.** Use Stripe's supported event redelivery
   mechanism for the exact recorded event/destination; if unavailable for the event's
   age/destination, stop for a scoped recovery decision. Do not invent a webhook,
   alter its body, skip signature checks or manually mark the payment paid.
7. **Read back real results.** Match Stripe event/session/payment IDs to the production
   payment, booking and client; check paid amount/balance, event claim and processing
   state, booking status, confirmation attempt/result and provider delivery receipt.
   Confirm staging was not mutated by the production replay. HTTP 200 alone is not
   acceptance: the handler can return 200 for ignored/unmatched/late events.
8. **Check duplication safely.** Existing offline gates cover duplicate-event behavior.
   A live duplicate redelivery requires explicit scope; if authorized, confirm no
   second financial application and no second confirmation. If already paid but
   confirmation failed, duplicate payment replay is not a universal resend mechanism;
   inspect the existing confirmation reconciliation result before further action.
9. **Rollback narrowly if required.** Stop new deliveries to the new destination and
   restore the approved prior service/config pair. Do not undo a genuine payment,
   delete its event claim or restore stale booking data. Report financial truth and
   message-delivery state separately.

## Final acceptance (not executed by this PR)

- Reviewed immutable Luna candidate includes both fixes and preserves resident overlays.
- On separately approved existing staging, normal dash-formatted quote is sent through
  the intended no-send/test lane without repair or staff flag; bad prices still fail.
- Extra is fetched and bound into the actual fresh conversation and quote/confirmation
  contexts, not merely shown as selected in the portal. Guest tone is chat-tested.
- Authorized production operator verifies the above after release, then the original
  test payment updates the correct booking and yields one confirmed delivery.
- Capture actual source/image IDs, changed config names (never secrets), receipts and
  exclusions. No claim of deployment, paid-state repair or guest send before readback.
