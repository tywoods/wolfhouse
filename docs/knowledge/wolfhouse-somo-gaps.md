# Wolfhouse Somo — operational knowledge gaps (Ale/Cami)

**Purpose:** Capture answers the **public website does not provide**. Feeds [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](../STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) and the provisional baseline config [`config/clients/wolfhouse-somo.baseline.json`](../../config/clients/wolfhouse-somo.baseline.json).

**Status:** Questionnaire only — **not filled** (2026-05-28). Priorities added 2026-05-29 (Stage 3x.2 baseline).

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

## 🔴 P1 — Required before autonomous live mode

*Bot uses handoff-only or no-action defaults until these are answered.*

### Deposit + payment

- [ ] **P1** Deposit rule (fixed EUR / per person / per package — which?):
- [ ] **P1** Production deposit amount (EUR):
- [ ] **P1** Is standard deposit the same across Malibu / Uluwatu / Waimea, or package-specific?:
- [ ] **P1** Payment deadline after link sent (hours/days):
- [ ] **P1** Hold expiry (hours/days) before auto-cancel or manual release:
- [ ] **P1** Is bot allowed to send payment link without staff review for standard packages?:

### Cancellation + refunds

- [ ] **P1** Guest-cancel windows and refund % (e.g. >30 days = 100%, 14–30 days = 50%, <14 days = 0%):
- [ ] **P1** No-show policy:
- [ ] **P1** Date-change fee or free-change window:

### Confirmation approval

- [ ] **P1** Should bot send confirmation automatically after deposit, or does staff approve first?:
- [ ] **P1** What should confirmation include beyond booking summary? (room assignment, balance, check-in/out, house rules, cancellation policy):

### Rooming auto-assign

- [ ] **P1** Is bot allowed to auto-assign rooms/beds based on rooming rules, or should all rooming go to staff?:
- [ ] **P1** What happens if a guest explicitly requests a specific room the bot cannot verify?:

### Always-handoff triggers

- [ ] **P1** What phrases from a guest mean "take over immediately"? (e.g. "I want to speak to someone"):
- [ ] **P1** What hours/channels should the bot use to ping Cami or Ale for urgent handoffs?:
- [ ] **P1** Emergency script — what should bot say when medical/legal/emergency comes in?:

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
