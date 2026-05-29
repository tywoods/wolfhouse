# Wolfhouse Booking Bot — Owner Checklist

**Print this page.** Plain-language summary of where we are and what comes next.  
**Last updated:** May 2026 · Detail: [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) · [`PROJECT-STATE.md`](PROJECT-STATE.md)

---

## The golden rule

| Old prototype (cloud) | New platform (this project) |
|-----------------------|----------------------------|
| Airtable + n8n online | Postgres + local n8n on your laptop |
| **Do not change** | **All new work here** — test data only until you go live |

---

## Full journey — done vs next

### ✅ DONE — Foundation & safety (your laptop, test data)

- [x] **Understand the system** — mapped workflows, downloaded copies, agreed not to break the live prototype
- [x] **Set up the lab** — Docker, Postgres database, rooms/beds seeded
- [x] **Payment schema** — booking + payment structure in the new database
- [x] **Local payment flow (Phase 2)** — hold → payment link → confirmation (WhatsApp dry-run)
- [x] **Bed operations (Phase 3b)** — assign, reassign, cancel, manual entries, room release
- [x] **Main bot + database (Phase 3c)** — guest message → hold → payment details → stub link
- [x] **Real Stripe tests (Phase 3d)** — test payment → webhook → confirmation (dry-run WhatsApp)
- [x] **Rooming & guards (Phase 3e)** — bed assignment, wrong-booking protection, no double-confirm
- [x] **Safety seatbelts (Stage 3.5)** — overlap checks, logging, idempotency
- [x] **Business rules draft (Stage 3x planning)** — deposits, holds, cancel rules, package prices (provisional)

### 🔄 IN PROGRESS — Teach the bot & practice safely

- [ ] **Stage 3x — Confirm knowledge** — Ale/Cami verify prices/policies (see page 2)
- [ ] **Stage 3x — Example messages** — redacted WhatsApp samples + golden test conversations
- [ ] **Stage 3y — Shadow / co-pilot build** — bot drafts replies; staff approve; no surprise live sends
- [ ] **Stage 3y — Practice tests** — run offline-safe tests before any real guest traffic

### ⏳ LATER — In order, do not skip

- [ ] **Stage 4 — Reliable** — alerts, stuck-booking detection, runbooks
- [ ] **Stage 5 — Clean** — move business rules from automation into code
- [ ] **Stage 6 — Beautiful** — calendar, bed grid, staff tools; retire Airtable
- [ ] **Stage 7 — Go live** — Azure deploy, switch WhatsApp/Stripe URLs, second property

### 🚫 NOT YET (on purpose)

- [ ] Azure / cloud go-live
- [ ] Real guest WhatsApp on the new system
- [ ] Full staff dashboard
- [ ] Bot replying to guests without staff approval

---

## Where you are today (one sentence)

**Safe booking + payments proven on test data → now locking in what the bot must know, then practice mode where staff approve every reply before we go reliable, pretty, and live.**

---

# Page 2 — Ale & Cami: answer this week

**Purpose:** Flip provisional rules → confirmed so the bot can draft safely in shadow mode.  
**Full list:** [`docs/knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)  
**How to return answers:** Short bullets in the gaps doc, or message engineering when done.

---

## 🔴 Must confirm before live / shadow with real quotes

| # | Question | Your answer |
|---|----------|-------------|
| 1 | **Are these 2026 prices correct?** Deposit €200/booking · packages (shoulder/high/peak table) · double room +€10/night/person · dinner €15 · board €20/day · wetsuit €20/day · lesson €25/day · yoga €15 | |
| 2 | **Cami's real WhatsApp number** for production handoff (test number in secret file today) | |
| 3 | **Emergency script** — exact wording for medical / legal / emergency (bot must hand off immediately) | |
| 4 | **Approved staff numbers + roles** — who is operator, who is master-admin? | |
| 5 | **Admin password** (optional second factor for staff edits) — send securely, not in chat | |

---

## 🟡 Helpful this week (safe defaults exist; improves bot quality)

| # | Question | Your answer |
|---|----------|-------------|
| 6 | Accommodation-only = Malibu base — still correct? | |
| 7 | How are **lessons scheduled**? (slots, instructors, capacity) | |
| 8 | **Payment deadline** after link sent — any reminder messages before hold expires? | |
| 9 | Malibu / Uluwatu / Waimea — still the 2026 package names? | |
| 10 | **Max group size** before rooming must be manual? | |
| 11 | **Mixed-gender groups** — split by gender or together if room available? | |
| 12 | **Family / children** rooming rules | |
| 13 | When must **rooming be staff-only** (never bot)? | |

---

## 🟢 Can wait (polish & returning guests)

- Bot languages (EN / ES / IT / other)
- Tone (formal vs casual, emoji)
- Using old WhatsApp chats to recognize returning guests — yes/no and privacy limits
- Marketing opt-in, FAQ polish, advanced greetings

---

## Already decided (no need to re-answer unless something changed)

- Bot may send payment link after collecting details; **60-minute hold**
- Balance due at arrival (cash / bank / Stripe planned)
- Confirmation includes **address, gate 2684#, room number** (not bed number)
- Auto room assign when clear; **R6 protected**; R7/R9/R10 assignable
- Unpaid cancel → bot; paid cancel/refund → staff; date changes → staff unless same nights + same rate + availability
- Check-in **15:00** / check-out **11:00**; **Dec/Jan/Feb closed**; March + November = shoulder season
- Don't ask skill level — ask what they **want** → recommend Malibu / Uluwatu / Waimea
- No-show: keep deposit, refund rest manually
- Dinners & yoga: book during stay, show Cami the WhatsApp + payment proof

---

## After Ale/Cami answer

1. Engineering promotes config → **confirmed** (`config/clients/wolfhouse-somo.json`)
2. Finish **offline-safe shadow build** (Stage 3y)
3. Run practice tests with sample guest messages
4. Shadow mode: bot drafts, staff tap send

---

*Questions? Open [`docs/PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) or ask in Cursor.*
