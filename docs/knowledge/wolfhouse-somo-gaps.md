# Wolfhouse Somo — operational knowledge gaps (Ale/Cami)

**Purpose:** Capture answers the **public website does not provide**. Feeds [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](../STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) and future `client_config` for `wolfhouse-somo`.

**Status:** Questionnaire only — **not filled** (2026-05-28).

---

## How to use

1. Answer each section below (short bullets OK).
2. Do **not** duplicate Malibu / Uluwatu / Waimea marketing copy from the website unless correcting it.
3. When complete, notify engineering to draft `config/clients/wolfhouse-somo.json`.

---

## Deposit + payment

- [ ] Deposit rules (fixed / per person / per package):
- [ ] Production deposit amount (EUR):
- [ ] Payment deadline after link sent:
- [ ] Hold expiry (hours/days) + auto-cancel?:
- [ ] Balance payment process:

## Cancellation + refunds

- [ ] Guest-cancel windows + refund %:
- [ ] No-show policy:
- [ ] Date-change fees:

## Packages + pricing (2026)

- [ ] Malibu / Uluwatu / Waimea valid for 2026?:
- [ ] Price table or formula:
- [ ] Minimum nights; always 7 nights?:
- [ ] Accommodation-only rules:
- [ ] Custom packages allowed?:
- [ ] Lessons/rentals add-on prices:

## Rooming + property

- [ ] Gender / couple / friends / family rules:
- [ ] Max group size before manual assignment:
- [ ] Check-in / check-out times:

## Operations + handoff

- [ ] Surf level: bot collects or staff only?:
- [ ] Transfers: bot books or info-only?:
- [ ] Meals wording per package:
- [ ] When bot must ping staff (hours, channel):
- [ ] Tone / languages / emoji:
- [ ] Emergency script:

## WhatsApp

- [ ] Auto payment link OK for standard packages?:
- [ ] Phrases that mean staff takeover:

---

## Customer memory (historical WhatsApp → returning guests)

*Policy and product choices for §3x.11. Engineering will not import history until these are answered.*

- [ ] Comfortable using historical WhatsApp to **recognize returning guests** by phone?
- [ ] Which guest facts are **useful to remember**? (language, package, surf level, rooming, group type, …)
- [ ] What should **never** be remembered? (medical, disputes, personal details, …)
- [ ] Should returning guests get a **different greeting**? (examples welcome)
- [ ] How long should guest info be kept? (months / years / until delete request)
- [ ] Should staff be able to **delete or edit** customer memory in a future UI?
- [ ] Track **marketing opt-in** separately from booking/support WhatsApp?
- [ ] What notes are **staff-only** and must never be shown to guests by the bot?
- [ ] OK to **delete raw WhatsApp exports** after facts are extracted? (recommended default: yes)
- [ ] Anyone who must **not** have access to raw import files? (roles)

---

## Surf + extras (optional detail)

- [ ] How bot should ask surf level:
- [ ] Board/wetsuit rental: info-only vs bookable:
- [ ] Breakfast / meals per package in confirmations:

---

*Operational gaps: [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](../STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) §3x.3 · Customer memory: §3x.5.*
