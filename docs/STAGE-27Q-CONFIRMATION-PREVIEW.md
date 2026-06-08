# Stage 27q — Confirmation Preview Dry-Run (No Live Send)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27P-STRIPE-PAYMENT-TRUTH.md](STAGE-27P-STRIPE-PAYMENT-TRUTH.md) · [STAGE-27O-STRIPE-TEST-LINK.md](STAGE-27O-STRIPE-TEST-LINK.md)  
**Module:** `scripts/lib/luna-guest-confirmation-preview-dry-run.js`  
**Verifier:** `npm run verify:stage27q-confirmation-preview`

**Non-negotiables:** Read-only preview · **no WhatsApp** · no Meta · no n8n · no confirmation send · no Stripe · no payment writes · no booking `status = confirmed` write.

---

## 1. Purpose

After Stage **27p** records payment truth and persists `confirmation_draft` in `bookings.metadata`, this module produces a **safe Luna confirmation message preview** for staff review. Nothing is sent to the guest.

---

## 2. Reused preview path

Logic delegates to **`getLunaBookingConfirmationPreview`** (Phase **14b**) in `scripts/lib/luna-booking-confirmation-preview.js`:

| Step | Pattern |
|------|---------|
| Load booking | By `booking_id` or `booking_code` |
| Gate | `payment_status` ∈ `{ deposit_paid, paid }` |
| Draft | Read `metadata.confirmation_draft` (written by 27p / 8.4.11) |
| Message | Cami/Wolfhouse playbook via `buildConfirmationPreviewFromPlaybook` |
| Safety | `preview_only`, `sends_whatsapp: false`, no writes |

Route anchor: `POST /staff/bot/bookings/confirmation-preview`

Guest wrapper adds:
- Luna-from-Wolfhouse identity line when missing
- Deposit balance → on-arrival cash / bank transfer / Stripe line
- Hold-expiry copy stripped
- Stage 27q output shape + `next_safe_step`

---

## 3. API

```js
await runGuestConfirmationPreviewDryRun(input, context)
```

### Input

| Field | Required | Notes |
|-------|----------|-------|
| `booking_id` or `booking_code` | ✓* | Booking to preview |
| `confirmation_draft` | optional | Fixture override for static tests |
| `language_hint` | optional | `en` / `it` |
| `guest_name` | optional | Merged into draft when missing |
| `payment_status` | optional | Early gate check |
| `client_slug` | optional | Defaults `wolfhouse-somo` |

\* Or `confirmation_draft.booking_code` for fixture mode.

### Context

| Field | Notes |
|-------|-------|
| `pg` | Injected pg client |
| `use_fixture_pg` | Build in-memory booking row from draft (tests) |

---

## 4. Payment truth gate

Preview proceeds only when:

- Booking `payment_status` is `deposit_paid` or `paid`, **or**
- `confirmation_draft.payment_status` indicates paid/deposit paid

**Blocked:** `waiting_payment`, `checkout_created`, draft/unpaid payment records, missing draft with insufficient fields.

---

## 5. Confirmation message rules

- Identifies as **Luna from Wolfhouse** (warm Cami tone via playbook)
- Includes **address** and **gate code `2684#`** when configured
- Includes **room number/label** — never bed number
- **Deposit + balance:** mentions remaining balance payable on arrival/check-in by cash, bank transfer, or Stripe
- **Full paid:** payment complete — no balance ask
- **No hold expiry** language
- Only states facts supported by draft/booking state

---

## 6. Output

Ready preview:

```json
{
  "success": true,
  "confirmation_preview_attempted": true,
  "confirmation_preview_ready": true,
  "booking_code": "WH-G27-...",
  "payment_status": "deposit_paid",
  "balance_due_cents": 80000,
  "room_label": "MB-01",
  "proposed_confirmation_message": "Luna from Wolfhouse here ☀️\n\n...",
  "confirmation_send_allowed": false,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "next_safe_step": "ready_for_confirmation_send_go_no_go"
}
```

Blocked / handoff: `confirmation_preview_ready: false`, `next_safe_step: "staff_review_confirmation"`.

---

## 7. Handoff reasons

- Missing room number/label
- Missing gate code or address (when required)
- No payment truth
- Payment status mismatch
- Missing `confirmation_draft` and insufficient structured fields
- Bed-number leak in message
- Hold expiry copy detected

---

## 8. Local / staging usage

After 27p payment truth:

```js
const out = await runGuestConfirmationPreviewDryRun(
  { booking_code: 'WH-G27-...', language_hint: 'en' },
  { /* pg via DATABASE_URL */ },
);
// out.proposed_confirmation_message — staff review only
```

Fixture testing (no DB):

```js
await runGuestConfirmationPreviewDryRun(
  {
    booking_code: 'WH-G27-PREVIEW',
    confirmation_draft: { /* deposit_paid draft from 27p */ },
  },
  { use_fixture_pg: true },
);
```

---

## 9. What 27q does NOT do

- Send WhatsApp or any guest message
- Call Meta / n8n
- Create Stripe links or payment writes
- Set `confirmation_sent_at`
- Mark booking `confirmed`

---

## 10. Next slice

**Explicit confirmation send go/no-go** — separate gated slice using `POST /staff/bot/bookings/send-confirmation` path; not in 27q.

---

## 11. Verifier

```bash
npm run verify:stage27q-confirmation-preview
```

Checks helper, reused 14b path, unpaid blocks, message content rules, safety flags, output shape.
