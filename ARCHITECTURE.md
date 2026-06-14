# Wolfhouse — System Architecture

## The Stack

```
                 Guest (WhatsApp)
                      │
                      │  WhatsApp Cloud API
                      ▼
         ┌────────────────────────┐
         │   Hermes (Luna)        │  docker/hermes-staging/
         │   ─────────────────    │
         │   SOUL.md              │  ← Luna identity + booking flow rules
         │   Cami personality     │  ← voice/tone layer (inside SOUL.md)
         │   Python plugin        │  ← 8 tool wrappers (thin HTTP clients)
         └────────────────────────┘
                      │
                      │  POST /staff/bot/* + X-Luna-Bot-Token
                      ▼
         ┌────────────────────────┐
         │   Staff API            │  scripts/staff-query-api.js
         │   (the "drivers")      │
         │   ─────────────────    │
         │   bot routes           │  /staff/bot/*  (Luna-facing)
         │   staff routes         │  /staff/*      (Portal-facing)
         │   Stripe integration   │
         │   WhatsApp webhook     │
         └────────────────────────┘
                      │
                      │  SQL (pg)
                      ▼
         ┌────────────────────────┐
         │   PostgreSQL DB        │  Azure Postgres Flexible Server
         │   bookings             │
         │   payments             │
         │   transfers            │
         │   booking_beds         │
         │   booking_services     │
         └────────────────────────┘
                      ▲
                      │  staff-staging.lunafrontdesk.com/staff/ui
         ┌────────────────────────┐
         │   Staff Portal         │  Served by Staff API (same process)
         │   (manual operations)  │  Calendar, bookings, inbox, transfers
         └────────────────────────┘
```

---

## Key Principle

**Conversation is flexible. Operations are boring.**

- Luna/Hermes handles the guest conversation — dates, packages, shuttle, name.
- Staff API is the only source of truth for: availability, prices, booking state, payment state, transfer records.
- Luna never invents prices, availability, or payment status. It always calls a tool.
- Luna never says a write succeeded unless the Staff API returns `write_performed: true` and the relevant truth field.
- Cami is a **voice layer only** — she styles the message that Luna's logic produces. She does not make operational decisions.

---

## Luna's Brain — `docker/hermes-staging/`

```
docker/hermes-staging/
  SOUL.md                          ← Luna/Cami system prompt
  plugins/
    wolfhouse_staff_api/
      __init__.py                  ← 8 tool wrappers (Python)
      plugin.yaml                  ← plugin manifest
  bootstrap.sh                     ← container startup script
  Dockerfile                       ← builds the Luna container
```

### SOUL.md — what it controls
- **Who Luna is** — warm, human WhatsApp host for Wolf-House
- **Booking flow** — 8 steps in strict order (dates → packages → quote → shuttle → payment choice → name → create booking → payment link)
- **Hard rules** — never state a price without `quote_booking`, never confirm payment without `get_payment_status`, one question per reply
- **Package facts** — Malibu / Uluwatu / Waimea definitions
- **Cami's voice** — warm, short, one emoji, WhatsApp tone

### Python Plugin — `__init__.py` — what it does
8 tool functions that Luna calls. Each is a thin HTTP POST to a Staff API bot route:

| Tool | Staff API Route | What it returns to Luna |
|------|----------------|------------------------|
| `check_availability` | `POST /staff/bot/availability-check` | available / unavailable / unclear |
| `quote_booking` | `POST /staff/bot/booking-preview` | total, deposit, remaining_after_deposit |
| `create_booking_from_plan` | `POST /staff/bot/booking-create-from-plan` + auto Stripe link | booking_code, payment_id, secure_payment_url |
| `create_payment_link` | `POST /staff/bot/payments/:id/create-stripe-link` | secure_payment_url (short /pay/ link) |
| `get_payment_status` | `POST /staff/bot/payments/status` | payment_confirmed: true/false |
| `update_guest_packages` | `POST /staff/bot/bookings/:code/guest-packages` | updated: true/false |
| `add_service_to_booking` | `POST /staff/bot/addon-requests/create` | write_performed: true/false |
| `save_transfer_request` | `POST /staff/bot/transfers/save` | write_performed: true/false |

**`create_booking_from_plan` auto-chains Stripe link creation** — so Luna only needs to call one tool and gets `secure_payment_url` back in the same result.

**`save_transfer_request` auto-confirms writes** — if `booking_id` or `booking_code` is present, `confirm_transfer_write: true` is injected automatically. No silent preview-only failures.

---

## Staff API — `scripts/staff-query-api.js`

The single Node.js HTTP server. 29k lines — it handles everything.

### Route groups (by path prefix)
| Prefix | Purpose |
|--------|---------|
| `/staff/bot/*` | Luna-facing. Authenticated with `X-Luna-Bot-Token`. |
| `/staff/auth/*` | Session auth (login/logout/session) |
| `/staff/ui` | Staff Portal HTML (served inline) |
| `/staff/conversations/*` | Inbox + conversation management |
| `/staff/bookings/*` | Booking write operations (move, edit, cancel) |
| `/staff/payments/*` | Stripe link creation, cash payment records |
| `/staff/bot/transfers/save` | Transfer write (Luna-facing) |
| `/pay/:booking_code` | Guest short-link redirect → Stripe checkout |
| `/staff/stripe/webhook` | Stripe payment truth webhook |
| `/whatsapp/webhook` | Meta WhatsApp Cloud inbound |

### Extracted V2 module
The 4 most critical bot handlers have been extracted to:
```
scripts/lib/staff-bot-v2-routes.js
```
The monolith imports and delegates to them. These are testable in isolation via the `ctx` injection pattern.

---

## Directory Map

```
WH/
  ARCHITECTURE.md              ← you are here
  AGENTS.md                    ← Hermes engineering assistant context
  Dockerfile                   ← Staff API container
  package.json
  scripts/
    staff-query-api.js         ← Staff API entry point (29k lines)
    lib/
      staff-bot-v2-routes.js   ← V2 bot handlers (extracted)
      luna-payment-short-link.js ← short /pay/ redirect helpers
      staff-booking-transfers-routes.js ← transfer read/write logic
      wolfhouse-quote-calculator.js     ← pricing engine
      [89 other active lib modules]
    verify-stage57a-hermes-staff-api-tools.js  ← tool def checks (16)
    verify-stage57b-staff-api-bot-routes.js    ← bot contract checks (28)
    verify-stage57c-hermes-luna-e2e-rehearsal.js ← dry-run e2e (18)
    verify-stage37c-short-payment-links.js     ← short link checks (51)
    run-live-booking-from-plan-e2e.js          ← live end-to-end proof
  docker/
    hermes-staging/            ← Luna container
      SOUL.md                  ← Luna/Cami system prompt
      Dockerfile
      bootstrap.sh
      plugins/
        wolfhouse_staff_api/
          __init__.py          ← 8 tool wrappers
          plugin.yaml
  config/
    clients/wolfhouse-somo.pricing.json     ← package pricing rules
    clients/wolfhouse-somo.messaging.json   ← payment URL + short-link base
  database/
    migrations/                ← Postgres schema migrations
  hermes-local/                ← Local Hermes dev runtime (not production Luna)
    SOUL.md                    ← Engineering assistant prompt (NOT guest-facing)
    config.yaml
  infra/
    .env                       ← Azure/Stripe/WhatsApp secrets (gitignored)
    azure/                     ← Container App deployment configs
```

---

## Key Contracts

### Booking code format
All generated codes: `MB-WOLFHO-YYYYMMDD-<6hex>`  
Example: `MB-WOLFHO-20260801-7aaf07`  
Always compare case-insensitively. SQL: `UPPER(b.booking_code) = UPPER($1)`.

### Payment link — what Luna sends to guest
```
https://staff-staging.lunafrontdesk.com/pay/MB-WOLFHO-20260801-7AAF07
```
This redirects (302) to the Stripe checkout URL. Luna always sends this short link, never the raw Stripe URL. Never markdown `[label](url)` — plain text only for WhatsApp.

### Transfer write gate
`confirm_transfer_write: true` is required to write. The Python plugin injects it automatically when `booking_id` or `booking_code` is present. For pre-booking transfers, the plugin returns a non-blocking cached response.

### Deposit rules
- Package bookings (7+ nights): **€200 deposit**
- Short stays / custom: **€100 deposit**  
These come from `quote_booking` — never from Luna's memory.

### Tool success gate
Luna must check these fields before sending success copy to guest:
- Booking: `write_performed: true` + `booking_code` present
- Payment link: `secure_payment_url` or `payment_link_created: true`
- Transfer: `write_performed: true`
- Payment confirmed: `payment_confirmed: true` (from `get_payment_status`)

---

## Verifier Suite

Run to confirm Staff API contracts are healthy:

```bash
# Static checks (fast, no network needed)
node scripts/verify-stage57a-hermes-staff-api-tools.js    # 16 Hermes tool definitions
node scripts/verify-stage57b-staff-api-bot-routes.js      # 28 bot route contracts
node scripts/verify-stage57c-hermes-luna-e2e-rehearsal.js # 18 dry-run rehearsal
node scripts/verify-stage37c-short-payment-links.js       # 51 short-link helper

# Live end-to-end (hits staging Staff API + Stripe test mode)
node scripts/run-live-booking-from-plan-e2e.js
```

Expected e2e output:
```
OK booking_code= MB-WOLFHO-...  guest_url= https://staff-staging.lunafrontdesk.com/pay/MB-WOLFHO-...  pay_status= 302  transfers=arrival+departure
```

---

## How to Test Luna (WhatsApp) Now

### 1. Verify Staff API is healthy
```bash
node scripts/run-live-booking-from-plan-e2e.js
```
If this passes: Staff API, Stripe, transfers, and payment links all work.

### 2. Test a Luna conversation
Send a WhatsApp message to the Wolfhouse staging number.  
Luna should respond with the Cami persona — warm, short, one question at a time.

What to test:
1. **Happy path**: give dates + guests + package → expect quote → confirm → get payment link → pay in Stripe test mode → Luna confirms
2. **Transfer**: say "yes I need the shuttle" → give arrival time → Luna should record it (check Staff Portal transfers tab)
3. **Service add-on**: after booking, say "can we add surf lessons?" → Luna should call `add_service_to_booking`
4. **Payment truth**: say "I paid" → Luna should call `get_payment_status`, not just believe you

### 3. Check Staff Portal
After a test booking: visit `https://staff-staging.lunafrontdesk.com/staff/ui`  
You should see the booking in the calendar and the transfer in the transfers drawer.

### 4. Check the payment short link
Copy the `/pay/MB-WOLFHO-...` URL Luna sent.  
Open it in a browser — it should redirect to the Stripe test checkout page.

---

## Deployment

### Staff API
```bash
# From WH-v2deploy worktree (keeps deploy separate from dev commits)
az acr build --registry whstagingacr --image wh-staff-api:<sha>-<label> .
az containerapp update -g wh-staging-rg -n wh-staging-staff-api --image whstagingacr.azurecr.io/wh-staff-api:<sha>-<label>
```

### Luna (Hermes)
The Luna container is separate from Staff API. It's built from `docker/hermes-staging/`.  
After editing `SOUL.md` or the Python plugin, rebuild and redeploy the Hermes container.

### Staff API required env vars
| Var | Source |
|-----|--------|
| `BOT_BOOKING_ENABLED=true` | set directly |
| `STRIPE_LINKS_ENABLED=true` | set directly |
| `LUNA_BOT_INTERNAL_TOKEN` | from wh-staging-kv Key Vault |
| `STRIPE_SECRET_KEY` | from wh-staging-kv |
| `STRIPE_CHECKOUT_SUCCESS_URL` | from config |
| `STRIPE_CHECKOUT_CANCEL_URL` | from config |
| `DATABASE_URL` | from wh-staging-kv |

### Luna required env vars
| Var | Source |
|-----|--------|
| `WOLFHOUSE_STAFF_API_BASE_URL` | `https://staff-staging.lunafrontdesk.com` |
| `LUNA_BOT_INTERNAL_TOKEN` | from wh-staging-kv |
| `WHATSAPP_CLOUD_VERIFY_TOKEN` | from wh-staging-kv |
| `WHATSAPP_CLOUD_APP_SECRET` | from wh-staging-kv |
