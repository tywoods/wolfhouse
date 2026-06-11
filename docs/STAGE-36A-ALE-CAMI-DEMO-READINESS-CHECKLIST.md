# Stage 36a — Ale/Cami Demo Readiness Checklist

**Status:** PASS (static audit + verifiers)  
**Runtime commit:** `1d8a6d3`  
**Audit commit:** (this doc + verifier)

---

## Ready to demo

### Luna guest booking (staging, safe gates)

- Core booking ladder: dates → guests → package/add-ons → quote → deposit/full choice
- Messy flows: date correction, reset, cash side-questions (Stage 35b hosted proof)
- Package add-ons before deposit; explicit add-on selections
- Yoga pending attach writes `booking_service_records` (source `luna_guest`)

### Staff visibility after Luna hold

| Area | What staff see |
|------|----------------|
| **Booking basics** | code, guest, dates, guest count, status, payment status, deposit paid / balance due, room label, package or accommodation-only |
| **Pending services** | Yoga — requested by guest, needs scheduling; Meals/dinner — interested/deferred, needs staff follow-up |
| **Ask Luna** | Pending yoga/meals, balance due, arrivals/checkouts, booking lookup by code |
| **Staff Portal drawer** | Booking summary, payment/balance, room/package, **Pending services** card (read-only) |

### Ask Luna — try these

- Who asked for yoga?
- Who needs meals scheduled?
- Show pending manual services
- What does WH-G27-DEMO36A need? *(or any live staging booking code)*
- Who still owes money?
- Who is checking in today?
- Who is checking out tomorrow?
- What services need staff follow-up?

### Suggested demo flow (staging)

1. Use test handset `+491726422307` (allowlisted) or review-only inbound dry-run.
2. Short stay: July 1–5, 1 guest, decline add-ons, deposit — show Staff Portal + Ask Luna balance.
3. Optional messy beat: “actually July 2–6” or “can I pay cash?” then deposit.
4. Package path: Malibu Jul 10–17, yoga/meals interest before deposit — show pending services in drawer + Ask Luna.

---

## Intentionally not ready (say this upfront)

- **Service scheduling** — pending yoga/meals have no date/time; staff must follow up manually
- **Transfer scheduling** — deferred capture only; no auto airport pickup booking
- **Live handset messy proof** — Stage 35b used hosted review path; one-phone live demo is Stage 36b
- **Confirmation send** — gated off; do not demo live confirmation unless allowlist explicitly enabled
- **n8n write pipe** — inactive by design on staging demos
- **Production** — not in scope

---

## Safe staging gates for demo

| Gate | Recommended |
|------|-------------|
| `WHATSAPP_DRY_RUN` | `true` unless doing controlled live reply demo |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` for read-only walkthrough; `true` only for live booking write demo |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` unless handset demo |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` unless payment link demo |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **unset** |
| n8n `stage27demoLWrite01` | **inactive** |

After demo: restore `PLAYGROUND_OFF` baseline (dry-run, writes off, live replies off).

---

## Test phone / allowlist

- Staging demo handset: `+491726422307`
- Open-demo Meta phone number id: `1152900101233109`
- Confirmation live send requires explicit allowlist — keep unset for Ale/Cami walkthrough

---

## Mock reference shapes (verifier only)

`fixtures/staff-demo-readiness/demo-booking-shapes.json`:

- **WH-G27-DEMO36A** — accommodation only, deposit paid, €80 balance, pending yoga
- **WH-G27-DEMO36B** — Malibu, add-ons skipped, meals interested/deferred, transfer deferred

---

## Known non-blockers

- Full conversation torture suite can be flaky — use booking-core batch (26/26) instead
- Ask Luna list answers include guest name + booking code (useful for staff, not guest-facing)
- Room shown as `R1`/`R2` — bed codes in move-bed UI only, not in pending services copy

---

## Next stage

**Stage 36b** — controlled Ale/Cami staging demo runbook (step-by-step with gate checklist), or **Stage 35c** — one small live handset messy flow if they want to watch Luna on phone.
