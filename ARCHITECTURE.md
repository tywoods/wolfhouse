# Wolfhouse Staff API — Architecture

## Overview

The system has two main pieces:

1. **Staff API** (`scripts/staff-query-api.js`) — the Node.js HTTP server that handles all booking operations, Stripe payments, WhatsApp mirroring, and the Luna bot routes.
2. **Hermes (Luna)** — the AI agent running on Azure Container Apps that talks to the Staff API to book guests, create payment links, and save transfers.

---

## Directory Map

```
scripts/
  staff-query-api.js         ← Entry point. All HTTP routes. 30k lines — see "the monolith" below.
  run-live-booking-from-plan-e2e.js ← Live e2e proof script (run to validate the live path)
  verify-stage57a-hermes-staff-api-tools.js  ← Hermes tool definition checks
  verify-stage57b-staff-api-bot-routes.js    ← Bot route contract checks (28 assertions)
  verify-stage57c-hermes-luna-e2e-rehearsal.js ← Dry-run rehearsal
  verify-stage37c-short-payment-links.js     ← Short /pay/ link helper checks
  lib/
    [84 active modules]
    staff-bot-v2-routes.js   ← Luna V2 bot handlers (extracted, see below)
    luna-payment-short-link.js ← Short /pay/<booking_code> redirect helpers
    staff-booking-transfers-routes.js ← Transfer save/read logic
    wolfhouse-quote-calculator.js     ← Pricing engine
    ... (see lib/ for full list)

config/
  clients/wolfhouse-somo.pricing.json    ← Package pricing rules
  clients/wolfhouse-somo.messaging.json  ← WhatsApp/payment URL config

database/
  migrations/   ← Postgres migration files

docker/
  hermes-staging/   ← Hermes container config + SOUL.md

hermes-local/
  SOUL.md    ← Luna/Cami personality + system prompt
  .env       ← Local Hermes secrets (gitignored)

infra/
  .env       ← Azure/Stripe/WhatsApp secrets (gitignored)
  azure/     ← Container App deployment configs
```

---

## The Live Booking Path (Luna V2)

This is the only path that matters for guest bookings. Luna must follow these steps in order:

```
1. check_availability      POST /staff/bot/availability-check
2. quote_booking           POST /staff/bot/booking-preview
3. create_booking          POST /staff/bot/booking-create-from-plan
4. create_payment_link     POST /staff/bot/payments/:id/create-stripe-link
5. send guest_payment_url  (the /pay/<booking_code> short link)
6. save_transfer           POST /staff/bot/transfers/save   (if guest needs transfer)
7. check_payment_status    POST /staff/bot/payments/status  (by booking_code)
```

**Rule:** Luna cannot say a step succeeded unless the Staff API confirmed it with `success: true` and the relevant truth field (`write_performed`, `guest_payment_url`, `transfer.id`, etc.).

---

## The Bot Route Module (V2 clean layer)

The 4 most critical bot handlers have been extracted to:

```
scripts/lib/staff-bot-v2-routes.js
```

These are the handlers that make a real booking go through:

| Function | Route | Purpose |
|----------|-------|---------|
| `handleBotTransferSave` | `POST /staff/bot/transfers/save` | Save arrival/departure transfer |
| `handleBotPaymentStatus` | `POST /staff/bot/payments/status` | Look up payment truth by booking_code |
| `handleBotBookingCreateFromPlan` | `POST /staff/bot/booking-create-from-plan` | Create booking + flatten payment_id |
| `handleBotPaymentCreateStripeLink` | `POST /staff/bot/payments/:id/create-stripe-link` | Create Stripe checkout + return short link |

Each handler uses a `ctx` object injected by `staff-query-api.js`, keeping them testable in isolation.

---

## The Monolith (staff-query-api.js)

`staff-query-api.js` is 30k lines. It contains:

- **Lines 1–400**: imports and env var constants
- **Lines 400–850**: regex constants for route matching  
- **Lines 850–1100**: auth (login, logout, session, bot token)
- **Lines 1100–1400**: payment landing pages + short-link redirect
- **Lines 1400–1760**: staff query + Ask Luna
- **Lines 1760–13000**: write routes (bookings, transfers, payments, Stripe)
- **Lines 13000–25500**: more write routes (bot booking create, manual booking create)
- **Lines 25500–28900**: UI serving + conversation/inbox routes
- **Lines 28900–30000**: main router function
- **Lines 30000–30100**: HTTP server startup

**Splitting it is the right next step** — but it works correctly as-is. The bot V2 handlers are already extracted to `lib/staff-bot-v2-routes.js`. The next extraction candidates are:
- `lib/staff-auth-routes.js` (~lines 850–1100)
- `lib/staff-stripe-routes.js` (~lines 12500–13500)
- `lib/staff-conversation-routes.js` (~lines 25700–28900)

---

## Key Contracts

### Booking code format
Generated codes look like: `MB-WOLFHO-20260801-7aaf07`  
Always compare case-insensitively: `UPPER(b.booking_code) = UPPER($1)`.

### Payment link
The bot Stripe link endpoint returns:
```json
{
  "guest_payment_url": "https://staff-staging.lunafrontdesk.com/pay/MB-WOLFHO-...",
  "payment_short_url": "https://staff-staging.lunafrontdesk.com/pay/MB-WOLFHO-...",
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```
Luna should always send `guest_payment_url` to the guest — never the raw Stripe URL.

### Transfer source
Transfer writes require `source` to be one of: `staff`, `luna`, `owner`, `import`, `flight_lookup`.  
The bot route normalizes any unknown source to `luna`.

### Deposit rules
- Package bookings (7+ nights): **€200 deposit**
- Custom/shorter stays: **€100 deposit**

---

## Verifier Suite

Run these to confirm the system is healthy:

```bash
node scripts/verify-stage57a-hermes-staff-api-tools.js   # 16 checks
node scripts/verify-stage57b-staff-api-bot-routes.js     # 28 checks
node scripts/verify-stage57c-hermes-luna-e2e-rehearsal.js # 18 checks
node scripts/verify-stage37c-short-payment-links.js      # 51 checks
node scripts/run-live-booking-from-plan-e2e.js            # live end-to-end
```

Expected output of e2e:
```
OK booking_code= MB-WOLFHO-... guest_url= https://staff-staging.lunafrontdesk.com/pay/...  pay_status= 302  transfers=arrival+departure
```

---

## Deployment

Staff API runs on Azure Container Apps as `wh-staging-staff-api`.

To deploy a change:
```bash
# From WH-v2deploy worktree (keeps deploy separate from dev commits):
az acr build --registry whstagingacr --image wh-staff-api:<tag> .
az containerapp update -g wh-staging-rg -n wh-staging-staff-api --image whstagingacr.azurecr.io/wh-staff-api:<tag>
```

Key env vars required on the container:
- `BOT_BOOKING_ENABLED=true`
- `STRIPE_LINKS_ENABLED=true`
- `LUNA_BOT_INTERNAL_TOKEN` (from wh-staging-kv)
- `STRIPE_SECRET_KEY`, `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`
- `DATABASE_URL` (Postgres connection string)
