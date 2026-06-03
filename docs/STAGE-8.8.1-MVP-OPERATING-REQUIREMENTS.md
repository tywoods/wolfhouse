# Stage 8.8.1 — Luna MVP Operating Requirements (post-demo)

**Status:** PASS — docs only (2026-06-03). **Updated by:** Stage 8.8.4 multilingual intent router (local; not deployed).  
**Captured after:** Stage 8.7.27 staging demo-ready confirmation (`wh-staging-staff-api--0000032`).  
**Hosted (8.8.3):** Date-aware check-in/check-out intents live on `--0000033` — see [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) §8.8.3.  
**Local (8.8.4):** Multilingual Ask Luna keyword router (EN/ES/IT/DE/FR) for checkout, cleaning, balance-due + basic date words — deterministic only, no LLM.  
**Owner input:** Ty (post-demo with Ale/Cami).  
**Non-negotiables:** No code. No deploy. No n8n activation. No WhatsApp. No Stripe. No DB writes.

**Related:** [STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md](STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md) · [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) · [ROADMAP.md](ROADMAP.md)

---

## 1. Staff Portal UI — freeze (good enough for now)

| Area | Decision |
|------|----------|
| **Booking drawer** | **Good enough** — payment truth, compact layout, Luna confirmation draft panel. No further polish required before MVP build-out. |
| **Bed Calendar view** | **Good enough** — range chips (8.7.23), Selected Stay layout (8.7.23–8.7.25), auto-load Next 30 days, manual booking form. No further polish required before MVP build-out. |

Future work on drawer/calendar should be **bug-fix or write-path only**, not cosmetic rework.

---

## 2. Guest Luna — full autonomous guest journey (MVP target)

Luna must eventually complete the **entire guest journey automatically** on live WhatsApp (after explicit GO):

```
inquiry → collect details → check availability → quote → create booking
  → send payment link → Stripe webhook payment truth → send confirmation
```

| Step | Today (staging) | MVP target |
|------|-----------------|------------|
| Inquiry / details | Main workflow (Airtable); dry-run fork proven inactive | Shared Postgres engine on live inbound |
| Availability | `POST /staff/bot/availability-check` (8.5.8) | Same; first-fit bed selection |
| Quote | `calculateWolfhouseQuote()` via bot preview | Same engine as staff portal |
| Booking create | `POST /staff/bot/bookings/create` | Same; idempotent |
| Payment link | `POST /staff/bot/payments/:id/create-stripe-link` | Same; test/live Stripe per env |
| Stripe truth | Webhook → `deposit_paid` / drawer (8.5.13–8.5.17) | Same path |
| Confirmation | Draft only; `sends_whatsapp:false`; no live send | **Approved send policy** + guest message (gated) |

**Not in scope for 8.8.1:** activating live WhatsApp or migrating production Main workflow — see §6.

---

## 3. Staff Ask Luna — priority questions

All answers must come from **structured Postgres records** (bookings, payments, booking_beds, add-on orders, assignments) — **never chat-log guessing**.

### 3.1 Payments

| Priority question | Example phrasing | Current coverage (8.7.27) | Data dependency |
|-------------------|------------------|---------------------------|-----------------|
| Who still needs to pay? | “Who still owes money?” / “Quien debe pagar?” | ✓ `payments.balance_due` (8.8.4 i18n router) | `bookings` + `payments` |
| Who paid for yoga on a date? | “Who paid for yoga tonight / tomorrow / June 15?” | ✗ Not implemented | **Structured add-on/service records** (`add_on_orders` / yoga line items) |
| Who paid for a meal on a date? | “Who paid for meals on June 15?” | ✗ Not implemented | **Structured meal/add-on records** — not chat logs |

### 3.2 Lessons & rental prep (date-aware)

| Priority question | Example phrasing | Current coverage | Data dependency |
|-------------------|------------------|------------------|-----------------|
| Who has a lesson today? | “Who has a surf lesson today?” | ✗ Not implemented | Lesson/add-on records + service date |
| Who needs a wetsuit today? | “Who needs a wetsuit today?” | ✗ Not implemented | Rental add-on records + stay/service dates |
| Who needs a surfboard today? | “Who needs a board today?” | ✗ Not implemented | Rental add-on records |
| How many surfboards ready today? | “How many boards do we need ready today?” | ✗ Not implemented | Aggregated rental demand from structured records |
| How many wetsuits ready today? | “How many wetsuits do we need ready today?” | ✗ Not implemented | Aggregated rental demand |

### 3.3 Housekeeping & arrivals/departures

| Priority question | Example phrasing | Current coverage | Data dependency |
|-------------------|------------------|------------------|-----------------|
| Which rooms need cleaning today? | “Which rooms need cleaning?” / “Cual cuartos tengo que limpiar hoy?” / “Welche Zimmer müssen heute gereinigt werden?” | ✓ `rooms_or_beds_need_cleaning` (8.8.4 i18n) | `bookings` + `booking_beds` check-out = today |
| Who is checking out today? | “Who leaves today?” / “Quien sale hoy?” / “Chi parte oggi?” / “Qui part aujourd'hui?” | ✓ `departures_today` or `check_outs.on_date` (8.8.4 i18n) | `bookings.check_out = today` |
| Who is checking in today? | “Who checks in today?” | ✓ `check_ins.on_date` (8.8.2–8.8.3 hosted) | `bookings.check_in = resolved date` |
| Who is checking in tomorrow? | “Who checks in tomorrow?” | ✓ `check_ins.on_date` (8.8.2) | Same |
| How many check in tomorrow? | “How many people arrive tomorrow?” | ✓ `check_ins.count` (8.8.2) | Sum `guest_count` on matching bookings |
| Who is checking out today? | “Who leaves today?” | ✓ `departures_today` | `bookings.check_out = today` |
| Who is checking out tomorrow? | “Who leaves tomorrow?” | ✓ `check_outs.on_date` (8.8.2) | `bookings.check_out = resolved date` |
| How many checking out tomorrow? | “How many people leave tomorrow?” | ✓ `check_outs.count` (8.8.2) | Sum `guest_count` |
| How many checking out Saturday? | “How many people check out on Saturday?” | ✓ `check_outs.count` + weekday resolver (8.8.2) | Named weekday → next occurrence (today if same weekday) |
| How many check in tomorrow? | “How many people arrive tomorrow?” | ✗ Not implemented | Count with `check_in = tomorrow` |

**Rule:** Add-on, yoga, meal, lesson, and rental questions **require structured add-on/service records** in Postgres (Stage 5 schema stubs → implementation). Manual booking UI already captures add-on qty in quote payload; **persisted operational rows** are the prerequisite for trustworthy Ask Luna answers.

---

## 4. Manual staff operations — priority order

Replace spreadsheet workflows in this order:

| Priority | Operation | Status (8.7.27) | Notes |
|----------|-----------|-------------------|-------|
| **1** | **Create booking** | ✓ MVP on staging (8.4.13) | Manual portal path + Luna bot path share engine |
| **2** | **Move booking** | ✗ Future (`8.3p+`) | Reassign beds/dates; no UI write yet |
| **3** | **Cancel booking** | ✗ Future (`8.3p+`) | Release beds; payment/refund policy TBD |
| **4** | **Operator blocks / releases** | ✗ Skeleton only | Tour Operator forms simplified; Create/Preview/Release disabled |

---

## 5. Live WhatsApp — remains NO_GO

| Gate | Status |
|------|--------|
| Guest Luna live inbound | **NO_GO** until Main workflow cutover + owner approval |
| Staff Ask Luna live send | **NO_GO** per [8.6.8 checklist](ROADMAP.md) — explicit Ty/Ale/Cami sign-off required |
| Confirmation send to guest | **NO_GO** — draft exists; `confirmation_sent_at` never set from UI |

Stay **dry-run / demo-ready** on staging until a documented GO for a single pilot number (staff) or full guest path.

---

## 6. Suggested implementation roadmap (docs-only sequencing)

| Phase | Focus | Depends on |
|-------|-------|------------|
| **8.8.x** | Structured add-on/service persistence + Ask Luna intents (§3) | Stage 5 add-on tables or equivalent |
| **8.3p+** | Manual move / cancel / operator writes (§4) | Staff action flags + SQL helpers |
| **8.5.x / 8.6.x** | Guest Luna live path + optional staff WhatsApp GO (§2, §5) | Workflow migration, 8.6.8 sign-off |
| **8.5.20+** | Confirmation send policy (§2 last step) | Owner policy; still gated |

---

**Next doc slice:** Pick one Staff Ask Luna intent family (e.g. check-in/check-out counts) or add-on persistence — smallest vertical with verifier + staging proof.
