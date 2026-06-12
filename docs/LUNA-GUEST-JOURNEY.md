# Luna Guest Journey (canonical flow)

**Status:** canonical guest experience map. Aligns with `docs/LUNA-GUEST-BEHAVIOR-SPEC.md` (rules + owner files). When this doc and the spec disagree, fix the mismatch.

**Voice:** warm Cami — chill, friendly, respectful, fun, cute. **One clear question per turn.** No language switching mid-thread.

**Automation:** every step below should have fixture coverage; nightly suite runs multilingual hammer + curated batches (`npm run luna:nightly`).

---

## 0. No active booking — hello

| Step | Luna does | Staff portal |
|------|-----------|--------------|
| Guest says hi | Welcome to Wolfhouse (Somo). Light invite to book or ask anything. **No price dump.** | — |

---

## 1. New booking intake (chill collection)

| Order | Field | Luna does |
|-------|--------|-----------|
| 1 | Intent | If they want a booking → start intake in a relaxed tone |
| 2 | Dates | Travel dates (accept messy natural language) |
| 3 | Guest count | How many guests |
| — | Side questions | Any FAQ/service/surf question answered briefly, then **resume** same intake step |

Then: **availability check** → **hold rooms** if available.

---

## 2. Stay length branches

### ≥ 7 nights (weekly package eligible)

| Step | Luna does | Staff portal |
|------|-----------|--------------|
| Packages | Brief Malibu / Uluwatu / Waimea explainer **before** asking to pick | Overview package summary |
| Choice | Guest picks package | `package_interest` on booking |
| Name | Confirm booking name; use WhatsApp display name when sensible | Overview guest name |
| Transfer | **Package bookings:** offer Santander pickup only (included) | Transfers tab |
| Santander | Included with weekly packages | Transfer record |
| Bilbao | Only if guest asks — groups of 4+ at €15/person; mention bus only if they ask about the bus | Transfer + pricing |

### &lt; 7 nights (no weekly package)

| Step | Luna does | Staff portal |
|------|-----------|--------------|
| Services | Offer optional services with brief explanation | Services tab records |
| Gear | Wetsuit, soft board, hard board — **prices only if guest asks** | Schedulable per night |
| Lessons | Surf lessons — explain, price on request | Schedulable |
| No double bill | Uluwatu/Waimea gear not duplicated as separate services when package chosen | — |

---

## 3. Quote → payment → confirmation

| Step | Luna does | Staff portal |
|------|-----------|--------------|
| Quote | Total for stay + package + services + transfer extras | Payments quote |
| Payment choice | Deposit or full — guest picks | Payment draft |
| Link | Stripe checkout URL | Payments checkout |
| Paid | Webhook truth → confirmation message | Payments paid + auto-send |

---

## 4. After booking (open world)

| Guest can | Luna does | Staff portal |
|-----------|-----------|--------------|
| Book more services | Any service from Services catalog | Services tab add + optional `service_date` |
| Schedule dates | Optional — can leave unscheduled | Schedule picker per night |
| Surf report | Answer waves; **no intake reset** | Surf API read |
| Flight times | Accept arrival/departure updates anytime | Transfers tab update |
| Multiple bookings | If 2+ active bookings → **list both** (dates + booking code) and ask which one to use | Disambiguation in router |

---

## 5. Hard rules

1. **Sticky language** — no flip to DE/IT/ES from loanwords (`wetsuit`, month names in English).
2. **Facts from code/DB** — prices, availability, payment state never invented by Cami.
3. **Cami voice-only** on truth states (payment URLs, amounts, confirmations).
4. **Services & transfers** must become staff-visible records (not chat-only).

---

## 6. Nightly automation

```bash
npm run luna:nightly          # full local suite (~few minutes)
npm run luna:nightly -- --quick   # golden + verify only
```

Reports: `reports/luna-nightly/latest.json`

**Deploy gate:** only `verify:luna-all` + golden must pass. Hammer / cami-realism / FAQ batches are **advisory** (`ADVISORY_FAIL` in report) — they surface bugs to fix or promote into golden, but do not block exit code.

See `scripts/lib/luna-staff-portal-capability-matrix.js` for scenario ↔ portal mapping.

---

*Last updated: guest journey + nightly automation pass.*
