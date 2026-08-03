# UI-BACKLOG — Sunset staff portal (+ Luna)

Running backlog of UI/UX + functional polish. Owner brain-dumps; Captain sorts, sizes, sketches, and hands scoped briefs to Skipper; Captain gates + deploys. Testing happens during + after each change (devs manage). Linked from [JOURNEY.md].

**Tags:** `[UI]` layout/visual · `[BUG]` broken behavior · `[FEAT]` new capability · `[LUNA]` chatbot brain.
**Size:** S / M / L. **Sketch?** = needs a concept mock before build.
_Started 2026-08-03. Still being added to — not final._

---

## ❓ Open questions (answered)
- **"− N +" control** → called the **quantity stepper**.
- **Historical booking log placement/name** → new **Admin tab**, recommended name **"Bookings"** (Schedule stays the calendar view; Bookings = searchable master list). Alts: "Records" / "Booking Log". It feeds both ops (find any booking) and Finance (refund home).
- **Moving a tab** → easy (nav entry + panel); real work is the panel content, not the placement.

---

## 🧠 Luna (brain / behavior)
- **L1 [LUNA] Personality/voice** — Luna needs a defined personality. → **Earthling**. `L`
- **L2 [LUNA][BUG] Disabled rental still offered** — turning a rental OFF in Admin doesn't stop Luna offering it; she must respect the enabled/active flag. `M`

## 🧾 Create / Edit booking drawer (equipment section — ~30% done, more tuning)
- **D1 [UI] Quantity stepper too big** — shrink it to save space; right now it pushes the estimated line total *underneath* it. Fix layout so the line total sits inline/tight. `S` · sketch?
- **D2 [UI] Inconsistent greens** — the greens on the Create/Edit drawer don't match; unify to one green token. `S`
- **D3 [UI] Section header mismatch (Captain-spotted)** — header reads "EQUIPMENT" in Create vs "RENTALS" in Edit; unify. `S`
- **D4 [BUG] Group Course toggled but none selected → rentals unpriced** — if "Group Course" is on but no actual course is chosen, rental items show no estimate and the booking can't complete. Fix approach TBD (either let standalone rentals price without a course, or block submit until a real course is picked). `M`

## 📅 Schedule tab
- **S1 [UI] Rental pickups (by-guest) redundant tags** — Staff/Paid/Unpaid/Waiver repeat on each *item*; keep them only on the *guest* row, items stay clean. _(concept already sketched)_ `S–M`

## 🖥️ Cockpit
- **C1 [UI] Selector placement** — the Daily/Monthly + Timeline/Cards selectors control a panel underneath them; needs repositioning + some redesign (no obvious home for them right now). `M` · sketch?

## 💶 Finance tab
- **F1 [UI] "This month" quick jump** — the month switcher up top needs a fast way back to the current month. `S`
- **F2 [FEAT] Revenue-by-product is hardcoded** — remove hardcoded "board rental / wetsuit rental"; replace with dynamic items = same logic as the Cockpit right side: course-included item(s) + the 2 next most-rented items for the selected period, driven by the top filter (day / month / year). `M`
- **F3 [FEAT] Gross-collected-vs-last-year toggle** — the "daily gross collected vs last year" chart needs a switch between the current month's-days view and a yearly 12-months view. `M`

## 🆕 New features
- **N1 [FEAT] Bookings tab (historical booking log)** — new Admin tab: searchable list of all bookings (past + present), find one, see basic info; **home for refund info** (the piece we didn't know where to put). Ties into Finance Slice 2. `M–L` · sketch?

## 🔁 Process
- Testing runs **during + after** each change; devs (Monshies + Earthling) manage it for now.
