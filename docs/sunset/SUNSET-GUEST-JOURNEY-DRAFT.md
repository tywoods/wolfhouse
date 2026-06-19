# Sunset Surf School — guest journey (DRAFT)

**Status:** Planning draft (docs-only). No runtime behavior. Example replies below are **illustrative drafts** to show shape/tone — they are NOT approved copy, and every price / time / link shown is a **placeholder for a config/tool-sourced value**, never a literal Luna may invent. Authored by Deckhand for Skipper/Captain review.

**Aligns with:** `docs/LUNA-GUEST-BEHAVIOR-SPEC.md` (rules), `docs/LUNA-GUEST-JOURNEY.md` (Wolfhouse spine), `LUNA-SUNSET-OVERVIEW.md` + `MULTI-TENANT-PLAN.md` (this folder).

**Tenant:** `sunset`. **Channels:** WhatsApp (short, one question per reply) and email (more structured). **Spine:** `question → quote/availability → payment link → booking/order confirmed`.

> **Placeholder convention.** `{like_this}` = a value that MUST come from config / Staff API / payment tool at runtime. Luna fills it from the tool result, never from memory or from the seed numbers in `LUNA-SUNSET-OVERVIEW.md`.

---

## 0. Channel tone contract

| | WhatsApp | Email |
|--|----------|-------|
| Length | Short, ~1 short paragraph | Can be multi-section |
| Questions per reply | **One** clear next step | May ask 1–2 grouped, clearly listed |
| Structure | Line breaks, light emoji | Greeting + body sections + sign-off; small tables OK |
| Truth rule | identical | identical |

Everything below the truth line (prices, availability, links, confirmations) is identical across channels; only wrapping differs.

---

## 1. Rental inquiry flow (unlimited inventory — no availability check for MVP)

**Required fields:** `item` (board / wetsuit / board+suit / SUP) · `window` (1h / half-day / 1 / 2 / 5 / 7 days) · `quantity` · `start`. Then quote from config → payment link → order confirmed on payment truth.

```
guest asks about rental
  → identify item + time window + quantity   (one question at a time on WhatsApp)
  → quote {price} from config (no availability call — unlimited MVP)
  → guest accepts → payment link from payment tool
  → payment truth → order confirmed
```

### 1.1 WhatsApp — example (illustrative drafts only)

> **Guest:** Hey do you rent surfboards?
> **Sunset Luna:** Heyy! ☀️ Yes — we rent boards, wetsuits, board+suit combos and SUPs 🏄 What would you like, and for how long — a couple of hours, half day, or full day(s)?

> **Guest:** A board for 2 days
> **Sunset Luna:** Nice 🤙 A board for 2 days is {board_2day_price}. Want me to set that up for you?

> **Guest:** yes
> **Sunset Luna:** Perfect — here's your secure payment link: {payment_link}. As soon as it goes through I'll confirm your rental ☀️

> **Guest:** *(pays — webhook truth)*
> **Sunset Luna:** All set! ✅ Your board rental for {dates} is confirmed. Pop by {pickup_location_from_config} to grab it — see you in the water 🌊

### 1.2 Email — example (illustrative)

> **Subject:** Your Sunset board rental
> Hi {name},
> Thanks for reaching out! Here's your rental:
> • Board × {qty} — {window} — **{price}**
> To confirm, just complete payment here: {payment_link}.
> Once payment is through we'll send your confirmation with pickup details.
> See you in the water,
> Sunset Surf School

---

## 2. Lesson booking flow (capacity-limited — availability check required)

**Required fields:** `lesson_type` (adult/adolescent group · kids Surfpark · private/coaching · large group) · `date` · `time slot` · `participant_count` · (`ages` if kids). Capacity check → quote → payment link → confirmed.

```
guest asks about a lesson
  → explain lesson types briefly (before asking them to pick)   [rule 5.1 analogue]
  → collect type + date + time + #surfers (+ ages for kids)
  → Staff-API capacity check for that slot
       available → quote {price} → payment link → confirmed
       unknown/manual → collect request → hand to staff to schedule
  → kids / large group / out-of-range age → handoff path (§5)
```

### 2.1 WhatsApp — example (illustrative)

> **Guest:** I want a surf lesson next Saturday
> **Sunset Luna:** Love it 🌊 We run group lessons (over 12s), kids' Surfpark lessons (~6–11), and private/coaching sessions. Which sounds right for you?

> **Guest:** group lesson, 2 of us
> **Sunset Luna:** Great — group lessons usually run {slot_times_from_config}. Which time works for Saturday, and are both surfers over 12?

> **Guest:** the morning one, yes both adults
> **Sunset Luna:** Let me check that slot for 2… ✨ *(Staff-API capacity check)*
> Yes! Saturday {slot} has space. It's {price_per_surfer} per surfer, so {total} for 2 — board, wetsuit and all gear included. Want me to hold it with a payment link?

> **Guest:** yes please
> **Sunset Luna:** Here's your secure link: {payment_link}. Once it's paid I'll confirm 🤙 (Heads up: please arrive ~20 min before the class.)

> **Guest:** *(pays)*
> **Sunset Luna:** Confirmed ✅ See you Saturday — remember, arrive 20 min before {slot} at {meeting_point_from_config}. ☀️

### 2.2 Capacity unknown / manual scheduling (illustrative)

> **Sunset Luna:** Got it — 2 surfers for a group lesson Saturday. I've passed this to our team to lock in the exact time; they'll confirm your slot and the {price} shortly 🙌

### 2.3 Email — example (illustrative)

> **Subject:** Your Sunset surf lesson — Saturday
> Hi {name},
> Here are the lesson options for your group:
> • **Group lesson (12+)** — {slot_times} — {price_per_surfer}/surfer, gear included
> • **Private / coaching** — {price} — flexible timing
> Could you confirm: how many surfers, which time, and that everyone is over 12?
> Once confirmed I'll check the slot and send a payment link.
> Sunset Surf School

---

## 3. Accommodation package request flow (partner-hotel confirmation)

Accommodation is **not** Sunset-owned inventory. Unless the Staff API confirms availability, this is a **request that needs partner/hotel confirmation** — Luna never promises a room or final price on its own.

```
guest asks about surf + stay package
  → explain it's surf + a nearby partner hotel
  → collect dates + #people + lessons/rentals wanted
  → Staff API:
       confirms availability + price → quote → payment link → confirmed
       cannot confirm → "request sent to team/partner to confirm" (no promise)
```

### 3.1 WhatsApp — example (illustrative)

> **Guest:** Do you do surf + hotel packages?
> **Sunset Luna:** We do! 🌅 It's surf lessons/rentals paired with a stay at a hotel nearby. What dates are you thinking, how many people, and how much surfing — lessons, rentals, or both?

> **Guest:** 3 nights in July, 2 of us, lessons each day
> **Sunset Luna:** Perfect, thanks 🙌 Let me check the hotel availability and put together the surf side for those dates — I'll come back to you with options shortly.

> *(If Staff API confirms:)*
> **Sunset Luna:** Good news ✨ For {dates}, 2 people with daily lessons, it's {package_total}. Want me to send a payment link to lock it in?

> *(If it can't be auto-confirmed:)*
> **Sunset Luna:** I've sent your dates to our team to confirm with the hotel — they'll get back to you with availability and the price soon 🌊 *(no room/price promised yet)*

### 3.2 Email — example (illustrative)

> **Subject:** Sunset surf + stay — {dates}
> Hi {name},
> Thanks for your interest in a surf + accommodation package!
> Here's what I have so far: {nights} nights, {people} people, daily lessons.
> The hotel side needs a quick confirmation from our partner — I've requested availability for your dates and will follow up with the full price. Nothing is reserved until that's confirmed and paid.
> Sunset Surf School

---

## 4. Payment / confirmation flow (shared across all services)

Same truth spine as Wolfhouse (`docs/LUNA-GUEST-JOURNEY.md` §3, payment-truth phases):

```
quote (config/Staff-API sourced)
  → guest accepts
  → payment link created by Staff-API / payment tool (tenant=sunset, Sunset Stripe)
  → guest pays
  → Stripe webhook truth (NOT the LLM)
  → booking/order marked paid → confirmation message sent
```

Rules:
- **No price** stated without a verified config/tool quote.
- **No payment URL** Luna didn't receive from the payment tool — relayed verbatim.
- **No "confirmed / paid / reserved"** before webhook truth.
- Payment-link URL, amount, confirmation text are **composer-owned** and not reworded by the voice layer (rule 6.3).

---

## 5. Handoff cases

Inherits the engine handoff policy (opt-in, explicit reasons only — rule 8.x, `surf-school.sample.json` / `surf-shop-rental.sample.json` `always_handoff`). Sunset-specific triggers:

| Trigger | Why | Luna does |
|---------|-----|-----------|
| Refund / cancellation / date-change request | Always staff | Hand off with a safe reply; never promise a refund |
| Complaint / angry guest | Always staff | Empathize briefly, hand off |
| Discount / custom / bulk deal | Not bot-priced | Hand off |
| **Large group beyond configured limit** | Capacity/pricing not auto-handled | Hand off |
| **Kids lesson — guardian consent / minor's personal data** | Privacy + safeguarding gate | Hand off |
| **Age outside range** (e.g. under-min for kids, under-12 for adult group) | Eligibility | Explain options or hand off; don't guess eligibility |
| Guest claims paid but no payment record | Payment mismatch | Hand off |
| Partner-hotel exceptions (special requests, changes) | Not Sunset-owned | Hand off / route to partner workflow |
| Low route confidence / parse or API error | Safety | Safe fallback / hand off (never invent) |

Low confidence **alone** never triggers handoff (rule 8.1). Example safe reply:

> **Sunset Luna:** Let me connect you with our team — they'll sort this out for you shortly 🙌

---

## 6. Cross-cutting behavior notes

- **Explain before asking to pick** (rentals tiers, lesson types) — don't ask "group or private?" before the guest knows the difference (rule 5.1 analogue).
- **One question per WhatsApp reply**; email may group a short list.
- **Preserve context** across turns and side questions (dates, item, count) — don't re-ask known fields (rule 4.2/4.3).
- **A correction invalidates a stale quote** — re-quote, don't silently keep the old total (rule 4.4).
- **No internal language** to guests (no "tenant", "Staff API", "dry run", etc. — §2).
- **Materials-included** ("board, wax, leash, wetsuit") stated only if config says so.
- **Arrive ~20 min before class** stated from config for lessons.
- **No Wolfhouse references** ever — Sunset Luna doesn't know about Somo packages / Cami.

---

## 7. Suggested fixtures (for a later implementation slice — not built here)

To prove these flows the Wolfhouse way (a fixture per behavior, `npm run verify:luna-all`):

1. `sunset-rental-quote-to-payment` — item + window → config quote → link → paid → confirmed.
2. `sunset-lesson-capacity-available` — type+date+slot+count → capacity check → quote → confirmed.
3. `sunset-lesson-capacity-manual` — capacity unknown → collect → staff-schedule (no fake confirm).
4. `sunset-accommodation-needs-confirmation` — package request → "team/partner to confirm", no promise.
5. `sunset-kids-lesson-guardian-handoff` — minor consent → handoff.
6. `sunset-no-invented-price` — unknown item/price → asks/handoff, never invents.
7. `sunset-no-fake-confirmation` — never "paid/confirmed" before webhook truth.
8. `sunset-tenant-isolation` — Sunset reply never contains Wolfhouse facts (and vice-versa).
9. `sunset-email-structured-vs-whatsapp-short` — same truth, channel-appropriate shape.

---

## 8. Open questions for Skipper / Captain

1. **Sunset Luna persona/voice** — own named voice or neutral Sunset-branded Luna? (drives the messaging playbook copy).
2. **Lesson slot times** — public site shows `11:00–13:00` and `16:00–18:00`; confirm these are the live Sunset slots before Luna states them.
3. **Lesson capacity source** — Staff-API capacity per slot, or fully manual collect-then-schedule for MVP?
4. **Accommodation** — any Staff-API hotel integration, or every package a staff/partner confirmation for MVP?
5. **Email** — in scope for MVP or fast-follow?
6. **Kids age policy** — exact min-age rules per group size before Luna states eligibility.
7. **Pickup/meeting points** — config values for rental pickup and lesson meeting point.
