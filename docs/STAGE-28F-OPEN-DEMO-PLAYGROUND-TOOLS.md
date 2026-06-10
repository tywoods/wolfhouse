# Stage 28f — Open Demo Playground Tools

**Status:** **CLI TOOLS** (2026-06-10)  
**Parent:** [STAGE-28E-STAGING-GUEST-PLAYGROUND.md](STAGE-28E-STAGING-GUEST-PLAYGROUND.md)  
**Verifier:** `npm run verify:stage28f-open-demo-playground-tools`

---

## 1. Scripts

| npm script | Script | Purpose |
|------------|--------|---------|
| `report:open-demo-playground` | `scripts/report-open-demo-playground-state.js` | Read-only playground state |
| `cleanup:open-demo-booking` | `scripts/cleanup-open-demo-staging-booking.js` | Unpaid hold cleanup (staging only) |

Both tools:

- Refuse production database URLs
- Do not send WhatsApp, create Stripe links, send confirmations, or activate n8n
- Target staging `wolfhouse-somo` open-demo data only

---

## 2. Report — read-only state

```bash
npm run report:open-demo-playground -- --phone +491726422307 --limit 10
```

Optional flags: `--json`, `--base-url`, `--db-url`

**Prints:**

- Staff API base URL
- Azure gates when `az` CLI is available (`WHATSAPP_DRY_RUN`, `OPEN_DEMO_*`, …) — otherwise `not checked`
- Meta webhook callback when Graph token available — otherwise `not checked`
- n8n `stage27demoLWrite01` active/inactive when n8n DB reachable — otherwise `not checked`
- `staff_phone_access` owner row for proof phone
- Recent conversations + open-demo bookings (beds, payments, `confirmation_sent_at`)
- Active `DEMO-R*` calendar blocks from today forward

**Requires:** `WOLFHOUSE_DATABASE_URL` or `--db-url` pointing at staging/local Postgres. Hosted: `az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url`.

---

## 3. Cleanup — unpaid holds only

### Dry-run (default)

```bash
npm run cleanup:open-demo-booking -- --booking-code WH-G27-EXAMPLE --dry-run
npm run cleanup:open-demo-booking -- --phone +491726422307 --limit 5
```

No writes unless `--confirm-cleanup` is passed.

### Confirm cleanup (unpaid hold)

```bash
npm run cleanup:open-demo-booking -- --booking-code WH-G27-NEW-HOLD --confirm-cleanup
```

**Actions when eligible:**

1. `bookings.status` → `cancelled` (+ staff_notes audit line)
2. `DELETE booking_beds` (frees calendar)
3. `payments.status` → `cancelled` for unpaid rows (`draft`, `checkout_created`, `pending` only)

**Does not:** touch Stripe, `guest_message_sends`, paid payment rows, or confirmation-sent bookings.

### Blocked by design — paid anchor

**Do not cleanup `WH-G27-3888294D42`** — Stage 28d proved `deposit_paid`. Dry-run shows:

```
BLOCKED: booking_payment_status_deposit_paid
```

Paid teardown is **not implemented** in 28f. `--allow-paid` still refuses with `paid_cleanup_not_implemented`.

---

## 4. Safety

| Guard | Behavior |
|-------|----------|
| Production DB patterns | Hard refuse |
| `NODE_ENV=production` | Hard refuse |
| `deposit_paid` / `paid` booking | Blocked |
| Paid payment row | Blocked |
| `confirmation_sent_at` set | Blocked |
| Default mode | `--dry-run` (no `--confirm-cleanup`) |

---

## 5. Related verifiers

```bash
npm run verify:stage28f-open-demo-playground-tools
npm run verify:stage28c3-meta-staffapi-open-demo-booking-path
npm run verify:stage27demo-d1-open-demo-calendar-assignment
```
