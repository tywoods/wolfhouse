# Stage 28g — Open Demo Playground Live Mode

**Status:** **STAGING PLAYGROUND MODE** (2026-06-10)  
**Parent:** [STAGE-28E-STAGING-GUEST-PLAYGROUND.md](STAGE-28E-STAGING-GUEST-PLAYGROUND.md) · [STAGE-28F-OPEN-DEMO-PLAYGROUND-TOOLS.md](STAGE-28F-OPEN-DEMO-PLAYGROUND-TOOLS.md)  
**Verifier:** `npm run verify:stage28g-open-demo-playground-live-mode`

---

## 1. Why the old workflow was bad

Stage 28e/28f used a **short booking-write window** where:

- `WHATSAPP_DRY_RUN=true` — Ty saw **no Luna replies** on the handset
- Cursor had to **poll** `guest_message_events` after each turn
- Ty had to send messages **while Cursor was watching**

That is fragile and not a real playground. Ty should text Luna **whenever he wants**, get **real replies**, and inspect results later with report tools.

---

## 2. What playground live mode does

When **ON** (staging only):

| Behavior | Detail |
|----------|--------|
| Meta → Staff API | Real inbound on demo WhatsApp number |
| Guest routing | `+491726422307` with `staff_phone_access.is_active=false` → open-demo guest path |
| Luna replies | **Live WhatsApp** when `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true` and `WHATSAPP_DRY_RUN=false` |
| Booking writes | Hold + draft payment + bed assign when intake ready (`OPEN_DEMO_BOOKING_WRITES_ENABLED=true`) |
| Calendar | Demo bed blocks visible after assignment |
| n8n | **Inactive** — not required |

**Still blocked (always):**

- Stripe TEST link creation (`OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false`)
- Payment-link WhatsApp send
- Confirmation send / allowlist
- Production traffic
- Live Stripe

Meta open-demo path **never** passes `create_stripe_test_link_confirmed`, `send_payment_link_whatsapp_confirmed`, or confirmation send flags.

---

## 3. Runtime wiring (28g)

`processMetaOpenDemoGuestInbound()` now:

1. Calls `executeOpenDemoWhatsAppInbound()` as before
2. When `evaluateOpenDemoWhatsAppLiveReplyGate()` passes, sets `send_live_reply_confirmed` on the internal body
3. Sends `proposed_luna_reply` via `evaluateGuestReplySendRouteWithPause`
4. Auto-confirms booking writes when `OPEN_DEMO_BOOKING_WRITES_ENABLED=true` and intake is ready (unchanged from 28c.3)

No Cursor polling required during normal use.

---

## 4. Turn playground ON

```bash
npm run playground:open-demo-on
```

Or:

```bash
node scripts/set-open-demo-playground-mode.js --on --phone +491726422307 --duration-minutes 120
```

**Sets staging Staff API env:**

```
WHATSAPP_DRY_RUN=false
OPEN_DEMO_WHATSAPP_ENABLED=true
OPEN_DEMO_BOOKING_WRITES_ENABLED=true
OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true
OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID=1152900101233109
WHATSAPP_PHONE_NUMBER_ID=1152900101233109
```

Also:

- Clears `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` if set
- Sets `staff_phone_access.is_active=false` for `+491726422307`

**Warning:** Luna will send **real WhatsApp messages** to guests while ON.

**After code deploy:** run ON script on hosted staging. Requires Azure CLI access to `wh-staging-staff-api`.

---

## 5. Turn playground OFF

```bash
npm run playground:open-demo-off
```

Or:

```bash
node scripts/set-open-demo-playground-mode.js --off
```

**Restores safe baseline:**

```
WHATSAPP_DRY_RUN=true
OPEN_DEMO_BOOKING_WRITES_ENABLED=false
OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false
OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
```

By default `+491726422307` **stays inactive** (guest test phone). Restore owner only if needed:

```bash
node scripts/set-open-demo-playground-mode.js --off --restore-owner
```

---

## 6. What Ty can test (async)

1. Text demo WhatsApp `+34 663 43 94 19` from `+491726422307`
2. Have a normal multi-turn Malibu booking conversation (Luna replies on phone)
3. Complete intake + deposit choice → staging hold + draft + beds
4. Inspect later:

```bash
npm run report:open-demo-playground -- --phone +491726422307 --limit 10
```

5. Clean up unpaid test holds:

```bash
npm run cleanup:open-demo-booking -- --booking-code WH-G27-... --dry-run
npm run cleanup:open-demo-booking -- --booking-code WH-G27-... --confirm-cleanup
```

**Do not cleanup** paid anchors like `WH-G27-3888294D42` (`deposit_paid`).

---

## 7. Hosted deploy steps (after merge)

1. Build + deploy `wh-staff-api` image containing 28g Meta adapter changes
2. Confirm healthz 200 on `staff-staging.lunafrontdesk.com`
3. Run `npm run playground:open-demo-off` first (safe baseline)
4. Run `npm run playground:open-demo-on` when ready to test
5. Ty texts Luna whenever — no Cursor session required
6. Run `npm run playground:open-demo-off` when done

---

## 8. Verifiers

```bash
npm run verify:stage28g-open-demo-playground-live-mode
npm run verify:stage28f-open-demo-playground-tools
npm run verify:stage28c3-meta-staffapi-open-demo-booking-path
```
