# Wolfhouse Somo — operational knowledge gaps (Ale/Cami)

**Purpose:** Capture answers the **public website does not provide**. Feeds [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](../STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) and the provisional baseline config [`config/clients/wolfhouse-somo.baseline.json`](../../config/clients/wolfhouse-somo.baseline.json).

**Status:** Mostly answered — **P1 prices/policies applied 2026-05-29 (Stage 3x.2c–3x.2d)** to baseline config v0.3 as **PROVISIONAL**. Remaining items are mainly to **confirm** provisional prices and fill a few gaps below.

---

## How to use

1. Answer each section below (short bullets OK).
2. Do **not** duplicate Malibu / Uluwatu / Waimea marketing copy from the website unless correcting it.
3. When complete, notify engineering to promote provisional rules in `config/clients/wolfhouse-somo.baseline.json` to `confirmed`.

### Priority guide

| Priority | Label | Meaning |
|----------|-------|---------|
| 🔴 **P1** | Required before autonomous live mode | Bot cannot safely act without this; currently `handoff_only` or `owner_required` |
| 🟡 **P2** | Can be provisional for Stage 4 start | Safe default exists; confirm to improve bot quality |
| 🟢 **P3** | Nice to have later | Does not block any stage; polish and retention |

---

## ✅ Answered 3x.2c–3x.2d (2026-05-29) — applied to baseline config (v0.3)

*No longer blocking. Prices below are **PROVISIONAL** (working values pending Ale/Cami sign-off): safe for dry-run/shadow, not for live autonomous charging until confirmed.*

**3x.2c (rules):**
- [x] Bot may auto-send payment link after required details (asks deposit vs full); **hold = 60 min**.
- [x] Balance payable at arrival (cash / bank transfer / Stripe-planned).
- [x] Auto-confirm after payment truth; confirmation includes **address, gate `2684#`, room number**; not bed number.
- [x] Auto-assign rooms when config clear; never move staff/manual; **R6 protected**; R7/R9/R10 assignable unless operator-blocked.
- [x] Conditional auto cancel/date-change; else staff.

**3x.2d (prices + policies, provisional):**
- [x] **Deposit = flat €200 per booking** (for now).
- [x] **2026 package table** (per person, 7nt, shared room): shoulder (Apr/May/Jun/Oct) Malibu 249 / Uluwatu 349 / Waimea 499 · high (Jul/Sep) 299 / 399 / 549 · peak (Aug) 349 / 449 / 599. **Double room +€10/night/person.**
- [x] **Inclusions:** Malibu = room + shirt; Uluwatu = + surfboard + wetsuit (6 days); Waimea = + lesson each day (6 days).
- [x] **Non-7-night:** prorate per night, **round up to nearest €5**.
- [x] **Cancellation:** unpaid → bot cancels; paid → staff. **Changes → staff unless same nights + same rate + availability**, then bot moves. Refunds always manual.
- [x] **Check-out 11:00 / check-in 15:00.** Freed room still cleaned even with no next guest (whole-room).
- [x] **Add-on prices derived:** lesson **€25/day**; surfboard+wetsuit bundle **€16.67/day** (split 50/50 placeholder).
- [x] **Handoff:** WhatsApp message to **Cami** (number editable per client).
- [x] **Bad weather / no waves:** refund possible but **staff does it manually**.
- [x] **Staff numbers:** managed by messaging the bot a **password** to unlock edit (mechanism spec'd).

---

**3x.2e (added):**
- [x] **Dinner = €15** (per person per meal); **surfboard €20/day**, **wetsuit €20/day** (round up to nearest 5).
- [x] **Handoff** WhatsApp number = operator number **+491726422307** (TEST stand-in for Cami; editable).
- [x] **Master-admin numbers** can manage staff numbers + admin tasks via the bot; operator number set as admin.
- [x] **No-show:** keep deposit, return the rest (refund executed manually by staff).
- [x] **Recommendation:** don't ask skill level — ask what they **want** (wetsuit / board / lessons) → Malibu / Uluwatu / Waimea.
- [x] **Non-7-night:** prorate **accommodation** per night (Malibu base) + **add-ons per day** at catalog rates.
- [x] **No minimum nights.**
- [x] **Add-on days** capped by **free days remaining** in the booking.
- [x] **No bundle discount** (board/wetsuit/lesson day rates just stack).
- [x] **Dinners** bookable during stay; guest shows the booking message / payment to staff when collecting food.
- [x] **Secrets** (handoff number, master-admin numbers, admin password) moved to an untracked secret file (`*.secrets.json`, gitignored); easy to edit later.
- [x] **March + November = shoulder**; **Dec / Jan / Feb = CLOSED** (no bookings).
- [x] **Yoga** bookable like dinners (pay → show Cami the WhatsApp conversation + payment confirmation before the lesson); **provisional €15**.
- [x] **No cleaning buffer** (0 min).
- [x] **Cami = operator number** for now (in secret file; replace at deploy).

---

## 🔴 Remaining — needed to CONFIRM (flip provisional → confirmed) / unblock live

- [ ] **P1** **Confirm** the provisional prices are correct for 2026 (deposit €200, package table, double-room +€10/nt/person, dinner €15, board/wetsuit €20/day, lesson €25/day).
- [ ] **P1** **Cami's real WhatsApp number** for production (currently operator test number in the secret file; update at deploy):
- [ ] **P1** **Emergency script** wording (medical/legal/emergency):
- [ ] **P1** Real **approved staff numbers + roles** (operator number is the only admin so far) + the **admin password** if you want the optional second factor (send securely, not in chat):
- [ ] **P2** Confirm accommodation-only = Malibu base is fine:
- [ ] **P2** How lessons are scheduled/tracked (slots / instructors / capacity):
- [ ] **P2** Payment deadline after link sent + reminders:
- [ ] **P3** Confirm the bot may say "I'll ask the team" before handoff (wording):
- [ ] **P3** Anything else the owner thinks matters:

---

## 🟡 P2 — Can be provisional for Stage 4 start

*Safe defaults exist. Answering these improves bot accuracy but does not block Stage 4.*

### Packages + pricing (2026)

- [ ] **P2** Malibu / Uluwatu / Waimea valid names for **2026**? Any renames?:
- [ ] **P2** 2026 price table or formula (season months, weekly EUR, per-person vs fixed):
- [ ] **P2** Always 7 nights, or can guests book shorter stays?:
- [ ] **P2** Accommodation-only allowed? If yes: min nights, deposit rule, what is included/excluded?:
- [ ] **P2** Custom packages / discounts allowed? Who approves? Bot-hold or staff-only?:
- [ ] **P2** Lessons / rentals: bundled in packages or sold separately? Bot-bookable or info-only?:

### Rooming rules detail

- [ ] **P2** Max group size before manual assignment is required:
- [ ] **P2** Mixed-gender group strategy (e.g. split by gender, or together in mixed room if available):
- [ ] **P2** Family room rules (children, families together):
- [ ] **P2** When must rooming/reassign be staff-only rather than bot-assigned?:

### Operations

- [ ] **P2** Balance payment: when due? how collected? bot-automated or staff-only?:
- [ ] **P2** Payment reminders: should bot send reminders before hold expires?:
- [ ] **P2** Surf level: should bot collect this, or is it staff-only? Allowed values?:
- [ ] **P2** Transfers: bot books, or info-only? Any logistics partners?:
- [ ] **P2** Breakfast / meals per package (Malibu / Uluwatu / Waimea) — exact confirmation wording:

---

## 🟢 P3 — Nice to have later

*Does not block any stage. Polish, retention, and advanced features.*

### Tone + language

- [ ] **P3** Languages the bot should support (en / es / it / other):
- [ ] **P3** Formality level (formal vs casual), emoji use, "WolfHouse Family" phrasing:
- [ ] **P3** Any phrases that should always or never appear in bot messages:

### Customer memory (historical WhatsApp → returning guests)

*Policy and product choices for §3x.5. Engineering will not import history until these are answered.*

- [ ] **P3** Comfortable using historical WhatsApp to **recognize returning guests** by phone?
- [ ] **P3** Which guest facts are **useful to remember**? (language, package, surf level, rooming, group type, …)
- [ ] **P3** What should **never** be remembered? (medical, disputes, personal details, …)
- [ ] **P3** Should returning guests get a **different greeting**? (examples welcome)
- [ ] **P3** How long should guest info be kept? (months / years / until delete request)
- [ ] **P3** Should staff be able to **delete or edit** customer memory in a future UI?
- [ ] **P3** Track **marketing opt-in** separately from booking/support WhatsApp?
- [ ] **P3** What notes are **staff-only** and must never be shown to guests by the bot?
- [ ] **P3** OK to **delete raw WhatsApp exports** after facts are extracted? (recommended default: yes)
- [ ] **P3** Anyone who must **not** have access to raw import files? (roles)

### Surf + extras

- [ ] **P3** How bot should ask for surf level (phrasing, allowed values):
- [ ] **P3** Board/wetsuit rental: info-only vs bookable:
- [ ] **P3** Breakfast / meals per package in confirmations (exact wording per package):
- [ ] **P3** Advanced returning-guest behavior (different greeting, remember preferences):
- [ ] **P3** Full FAQ polish beyond standard booking flow:
- [ ] **P3** Marketing opt-in and future marketing messaging:

---

*Operational gaps: [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](../STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) §3x.3 · Customer memory: §3x.5 · Baseline config: [`config/clients/wolfhouse-somo.baseline.json`](../../config/clients/wolfhouse-somo.baseline.json)*
