# Stage 36b — Ale/Cami Staging Demo Runbook

**For:** Ty demoing Luna to Ale/Cami on **staging only**  
**Staff Portal:** https://staff-staging.lunafrontdesk.com  
**Test handset (allowlisted):** `+491726422307`  
**Client:** `wolfhouse-somo`  
**Reference date for scripts:** June 2026 (July dates in examples)

---

## 1. Demo goal

This demo proves Luna can:

| Capability | What to show |
|------------|--------------|
| WhatsApp booking | Guest messages → Luna replies on test phone (Mode B+) |
| Quote | Correct € totals for short stay / package |
| Surf add-ons only | Luna asks wetsuit/surfboard/lessons — **not** yoga/meals proactively |
| Deposit choice | Guest says `deposit` → hold plan ready |
| Staging hold + Stripe TEST link | Booking row + `checkout.stripe.com` TEST URL (Mode B+) |
| TEST payment webhook | Optional pay in Stripe test mode (Mode C) |
| Staff Portal | Booking in inbox/drawer with payment/balance/room/package |
| Pending services | Yoga/meals visible in drawer + Ask Luna (after reactive guest ask) |
| Messy flow safety | Date correction invalidates stale quote, no old payment link (Script 3 / review path) |

**Not proving today:** production cutover, live Stripe, n8n automation, service date scheduling, transfer auto-booking.

---

## 2. Demo modes

Pick **one mode** before starting. Do not mix gates mid-demo without restoring baseline.

### Mode A — Safe Staff Portal / Ask Luna *(recommended first)*

**Use when:** Ale/Cami first walkthrough; **no live WhatsApp** — handset stays quiet.

| Setting | Value |
|---------|-------|
| Live WhatsApp | **No** |
| Booking writes | **Off** |
| Stripe links | **Off** |
| Confirmation send | **Off** |

**How:** Log into Staff Portal → open existing staging booking or use Ask Luna on live DB read-only queries. Optional: run hosted review dry-run locally (`npm run proof:stage35b-hosted-messy-flow -- --skip-deploy`) to narrate messy flows without sends.

**Shows:** Staff visibility, pending services copy, payment/balance questions — without creating new holds.

---

### Mode B — Live WhatsApp booking → Stripe TEST link

**Use when:** Ty wants Ale/Cami to watch Luna book on the test phone through deposit + payment link.

| Setting | Value |
|---------|-------|
| Test phone only | `+491726422307` |
| Booking writes | **On** |
| Live WhatsApp replies | **On** |
| Stripe TEST links | **On** |
| Confirmation send | **Off** (allowlist unset) |
| n8n | **Inactive** |

**Prep (Ty only, before guests arrive):**

```bash
npm run report:open-demo-playground    # snapshot gates + healthz
npm run playground:open-demo-on          # writes + live replies ON
# Then set Stripe TEST links ON via Azure (see gate table below)
```

**After demo:** run **Restore checklist** (section 3) immediately.

---

### Mode C — Full TEST payment + confirmation

**Use only if Ty explicitly wants it.** Same as Mode B, plus:

| Setting | Value |
|---------|-------|
| Stripe TEST checkout | Complete payment in browser |
| Webhook truth | Staging webhook applies deposit/paid state |
| Confirmation send | Requires `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` with test phone |

**Rules:** `sk_test_*` only. No production. Restore all gates within 5 minutes of last message. Say upfront: *“This is staging test payment — not a real guest charge.”*

---

## 3. Gate checklist

### Safe baseline (default / after every demo)

| Gate | Required value |
|------|----------------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **unset / removed** |
| n8n `stage27demoLWrite01` | **inactive** |
| Stripe secret | `sk_test_*` only |
| healthz | `https://staff-staging.lunafrontdesk.com/healthz` → **200** |

**One-command restore (local CLI):**

```bash
npm run playground:open-demo-off
```

Then confirm Stripe links off + allowlist removed on Azure if Mode B/C was used.

---

### Mode A gates

Same as **safe baseline**. No changes.

---

### Mode B gates

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `true` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **unset** |
| n8n | **inactive** |

---

### Mode C gates (Mode B + confirmation)

| Gate | Value |
|------|-------|
| All Mode B gates | as above |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | test phone only (Ty sets explicitly) |
| Stripe | TEST checkout + staging webhook only |

---

### Restore checklist (after Mode B or C)

1. `npm run playground:open-demo-off`
2. Set `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false` on staging Staff API
3. Remove `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` if set
4. `curl -s -o /dev/null -w "%{http_code}" https://staff-staging.lunafrontdesk.com/healthz` → **200**
5. Confirm n8n workflow `stage27demoLWrite01` **inactive**
6. Confirm Stripe key still `sk_test_*` (never live)
7. Stop sending test WhatsApp messages
8. Note any `booking_code` / `conversation_id` created for cleanup if needed

---

## 4. WhatsApp demo scripts

Send from **test phone only**. Wait for Luna reply between lines.

### Script 1 — Clean short-stay booking

```
hi
book a stay
July 1-5
1
no thanks, I have my own stuff
deposit
```

**Expected**

- Accommodation quote **€180**
- Deposit prompt **€100**
- Stripe TEST link in WhatsApp (Mode B+)
- Luna asks surf add-ons only — **no proactive yoga/meals**
- No confirmation unless Mode C + allowlist enabled
- Staff Portal: hold, deposit paid after TEST pay, balance due ~€80

---

### Script 2 — Package + reactive yoga

```
Malibu July 10 to July 17 for 1
just the stay
Can I add yoga?
deposit
```

**Expected**

- Malibu package quote (~€299 deposit path)
- Add-ons (surf gear/lessons) asked before deposit — guest declined with “just the stay”
- Yoga only after guest asks — **reactive**, not proactive
- After hold: **Pending services** → `Yoga — requested by guest, needs scheduling`
- Ask Luna: “Who asked for yoga?” lists this booking
- No fake yoga date/time on record

---

### Script 3 — Messy date correction (optional)

Run on test phone **before** paying, or narrate via Stage 35b review path in Mode A.

```
July 1-5 for 1
no thanks, I have my own stuff
actually July 2-6
```

**Expected**

- First quote July 1–5 €180
- Correction → stale quote / dates updated to July 2–6
- **No old Stripe link** from pre-correction quote
- Luna re-quotes July 2–6 and asks deposit/full again

---

## 5. Staff Portal screens to open

Do these **while** or **after** Script 1 or 2 (Mode A: use any recent staging booking).

| # | Screen | What to point out |
|---|--------|-------------------|
| 1 | **Inbox / conversation** | Guest thread, Luna replies, no internal jargon |
| 2 | **Booking drawer → Overview** | Code, guest, dates, count, status, package |
| 3 | **Payment / balance** | Deposit paid, balance due, payment rows |
| 4 | **Pending services card** | Yoga/meals lines — needs scheduling / follow-up |
| 5 | **Ask Luna panel** | Live staff questions (section 6) |

**Tip:** Search booking by code from WhatsApp thread footer or Ask Luna lookup.

---

## 6. Ask Luna demo questions

Ask in Staff Portal Ask Luna (read-only):

| Question | Proves |
|----------|--------|
| Who asked for yoga? | Pending yoga list |
| Who needs meals scheduled? | Pending meals list |
| Show pending manual services | Combined pending manual |
| What does WH-G27-xxxx need? | Booking lookup by code *(use live code)* |
| Who still owes money? | Balance due list |
| Who is checking in today? | Arrivals |
| Who is checking out tomorrow? | Checkouts |
| What services need staff follow-up? | Pending manual services |

Example chip already in UI: **Show pending manual services**

---

## 7. What to avoid / not ready yet

Say these upfront so Ale/Cami know the boundary:

- **Service scheduling** — yoga/meals have no date/time yet; staff schedules manually
- **Transfer auto-booking** — deferred capture only, not full pickup booking
- **Production / live Stripe** — not part of this demo
- **n8n write pipe** — inactive; Luna writes via Staff API path on staging
- **Test phone / staging only** — not real guest handsets
- **Confirmation WhatsApp** — off unless Mode C + allowlist explicitly enabled
- **Do not promise** automated meal planning, yoga timetable, or airport pickup confirmation

---

## 8. Emergency restore (“panic restore”)

If something looks wrong mid-demo:

1. **Stop** sending WhatsApp messages from test phone
2. Run `npm run playground:open-demo-off`
3. Set staging gates back to **safe baseline** (section 3)
4. Check `healthz` → **200**
5. Confirm n8n **inactive** and host is `staff-staging.lunafrontdesk.com` (not production)
6. Capture **`booking_code`** and **`conversation_id`** from Staff Portal if a hold/payment looks stuck
7. Optional cleanup: `npm run cleanup:open-demo-booking -- --phone +491726422307 --dry-run` then review before confirm
8. Tell Ale/Cami: *“Staging demo mode reset — that last test booking may need staff cleanup.”*

**Never** enable production Stripe, production WhatsApp send, or n8n activation to “fix” a demo.

---

## Quick reference

| Item | Value |
|------|-------|
| Staging URL | https://staff-staging.lunafrontdesk.com |
| Test phone | +491726422307 |
| Meta phone number id | 1152900101233109 |
| Gate report | `npm run report:open-demo-playground` |
| Safe off | `npm run playground:open-demo-off` |
| Readiness checklist | `docs/STAGE-36A-ALE-CAMI-DEMO-READINESS-CHECKLIST.md` |
| Mock shapes (verifier) | `fixtures/staff-demo-readiness/demo-booking-shapes.json` |

---

## Suggested demo order (45–60 min)

1. **Mode A (10 min)** — Staff Portal tour + Ask Luna questions on existing data  
2. **Explain gates (5 min)** — what Mode B will turn on  
3. **Mode B Script 1 (15 min)** — short-stay live booking + drawer  
4. **Mode B Script 2 (15 min)** — Malibu + yoga + pending services  
5. **Optional Script 3 (5 min)** — messy correction or narrate 35b proof  
6. **Restore (5 min)** — panic checklist even if nothing failed  

**Skip Mode C** unless Ale/Cami explicitly ask to see confirmation send.
