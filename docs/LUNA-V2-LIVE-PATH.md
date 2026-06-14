# Luna V2 live path

Luna V2 is a controlled reset of the Wolfhouse guest-facing booking path. The goal is not to add another brain; it is to make one small live path that cannot tell a guest an operational action happened unless Staff API proves it happened.

## Product rule

Conversation can be flexible. Operations must be boring.

Luna may reason about guest intent, package explanation, side questions, and the next natural message. Luna may not freestyle operational truth.

## Active live path

```text
Guest WhatsApp
  -> Hermes WhatsApp Cloud Gateway
  -> Luna V2 prompt / state
  -> wolfhouse_staff_api plugin tools
  -> Staff API /staff/bot/* routes
  -> Postgres + Stripe + Staff Portal
```

## V2 tool surface

Keep the tool surface intentionally small:

1. `check_availability` — real bed availability before availability claims.
2. `quote_booking` — real totals/deposit/remaining amount before price claims.
3. `create_booking_from_plan` — create booking only after accepted quote, payment choice, name, and package/guest facts are known.
4. `create_payment_link` — create/recover secure payment link for an existing payment row.
5. `save_transfer_request` — persist arrival/departure transfer rows for Staff Portal visibility.
6. `add_service_to_booking` — persist service/add-on requests.
7. `update_guest_packages` — persist package changes.
8. `get_payment_status` — read payment truth; never trust guest claims.

## Hard success gates

Luna V2 must not say booking created unless the tool result has:

```text
success === true
write_performed === true
booking_id or booking_code present
```

Luna V2 must not send a payment link unless the tool result has:

```text
payment_id present
secure_payment_url present
payment_link_created === true
```

For short `/pay/<booking_code>` links, the verifier must also prove the public URL resolves to a redirect/payment page, not 404.

Luna V2 must not say transfer saved unless:

```text
save_transfer_request.success === true
save_transfer_request.write_performed === true
```

Luna V2 must not confirm payment unless:

```text
get_payment_status.payment_confirmed === true
```

## Known fixes included in V2 reset

- `/staff/bot/payments/status` accepts `booking_code` as well as `payment_id`/`booking_id`, because Luna often has booking code after create.
- `/staff/bot/transfers/save` accepts `booking_code` lookup as well as `booking_id`, because the guest-facing flow should not fail just because the model kept the human-facing code.
- Tests must include live smoke after deploy. Static route checks are not enough.

## Legacy quarantine policy

Do not delete old Luna code immediately. First prove the V2 happy path. Then move old overlapping guest-brain/demo/n8n files into `-old` folders with import checks.

Candidate legacy areas after import audit:

- old `luna-guest-agent-*` planner/tool executor layers
- old `luna-guest-gpt-*` planner layers
- old open-demo / n8n scripts
- old stage27/stage28/stage40 style proof scripts that are not used by V2
- temporary `.tmp-*` files

Keep Staff API, quote/pricing, payment short link, transfer/service routes, and the minimal Hermes plugin path.

## Done means

A Luna V2 staging run is not done until a real staged flow proves:

1. booking row exists
2. booking code returned
3. draft payment exists
4. Stripe checkout URL exists
5. `/pay/<booking_code>` resolves
6. requested transfer row(s) exist in Staff API
7. Luna sends guest-safe copy only after those facts are true
