# Stage 27w — Luna Guest Simulator (Staff Portal)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27V-GUEST-AUTOMATION-REVIEW.md](STAGE-27V-GUEST-AUTOMATION-REVIEW.md) · [STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md](STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md)  
**Verifier:** `npm run verify:stage27w-luna-guest-simulator`

**Non-negotiables:** Staff Portal **dev tab only** · staging/local writes · **Stripe TEST only** · **no WhatsApp** · no Meta/n8n · **no public automation** · **no production DB**

---

## 1. Purpose

Hardcore staging/local testing: simulate guest phone numbers and messages, run the Stage **27u/27v** review chain, then optionally create **test holds**, **draft payments**, and **Stripe TEST checkout links** — all from Staff Portal without public inbound WhatsApp.

---

## 2. Access

Staff Portal tab: **Luna Guest Simulator** (dev-tab, same visibility as Developer Tools).

Requires staff session (or open local auth). **Not** a public route.

---

## 3. Local usage

```bash
npm run staff:api
```

Open Staff Portal → sign in → **Luna Guest Simulator** tab.

Safety banners on page:

- Simulator writes to **staging/local test data**
- **No WhatsApp sent**
- **Stripe TEST links only**

---

## 4. Test flow

1. **Run Luna Review** — calls `POST /staff/bot/guest-automation-review-dry-run`
2. **Use review result as guest_context** — client-side state for multi-turn
3. Guest message: **“Deposit is fine”** (or Full amount / cash on arrival)
4. **Run Luna Review** again
5. **Create Test Hold + Draft Payment** — when plan + payment choice ready  
   → `POST /staff/bot/guest-simulator-create-hold-draft` → 27n write helper
6. **Create Stripe TEST Link** — when `payment_draft_id` exists  
   → `POST /staff/bot/guest-simulator-create-stripe-test-link` → 27o helper
7. Open **Stripe TEST checkout URL** manually in browser (test card)

---

## 5. Example messages

| Message | Expected lane / note |
|---------|----------------------|
| Hi, we are 2 people and want to stay July 10-17 | Booking inquiry — collect dates/package |
| We want the Malibu package | Package intent |
| Deposit is fine | Payment choice (with guest_context from prior review) |
| Can I rent a wetsuit tomorrow? | Service request — no full booking chain |
| Can I pay cash when I arrive? | Payment choice / handoff |
| Can I cancel my booking? | Cancel/handoff |

---

## 6. API routes (staff/bot auth)

| Route | Helper | Writes |
|-------|--------|--------|
| `POST /staff/bot/guest-automation-review-dry-run` | 27u orchestrator | ❌ |
| `POST /staff/bot/guest-simulator-create-hold-draft` | `runGuestHoldPaymentDraftWriteDryRunApproved` | ✓ staging/local hold + draft |
| `POST /staff/bot/guest-simulator-create-stripe-test-link` | `runGuestStripeTestLinkCreateApproved` | ✓ Stripe TEST session URL |

### Hold/draft gates

- `NODE_ENV !== production`
- `confirm_simulator_write: true`
- `confirm_write: true` (27n)
- Chain `payment_choice.next_safe_step === ready_for_hold_payment_draft`
- `hold_payment_draft_plan.plan_status === ready`

### Stripe TEST gates

- `confirm_simulator_stripe: true`
- `confirm_stripe_test_link: true` (27o)
- `STAFF_ACTIONS_ENABLED=true`
- `STRIPE_LINKS_ENABLED=true`
- `WHATSAPP_DRY_RUN=true`
- `STRIPE_SECRET_KEY` starts with `sk_test_`
- Staging/local environment only

---

## 7. Safety limits

| Limit | Policy |
|-------|--------|
| Production | **Blocked** (403) |
| WhatsApp send | **Never** |
| Meta / n8n | **Never** |
| Public webhook | **None added** |
| Booking confirmation send | **Not in simulator** |
| Payment truth (27p) | **Not wired** in 27w |
| Live Stripe | **Blocked** — test mode only |

---

## 8. Verifier

```bash
npm run verify:stage27w-luna-guest-simulator
```

---

## 9. Next step

Optional **Staff Portal review panel** polish (inline in Inbox) or **27x** limited staging guest automation — explicit product GO only.
