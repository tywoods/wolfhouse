# SUNSET-TODO — Sunset staff portal (+ Luna)

Running backlog of UI/UX + functional polish. Owner brain-dumps; Captain sorts, sizes, sketches, and hands scoped briefs to Skipper; Captain gates + deploys. Testing happens during + after each change (devs manage). Linked from [JOURNEY.md].

**Tags:** `[UI]` layout/visual · `[BUG]` broken behavior · `[FEAT]` new capability · `[LUNA]` chatbot brain/wiring · `[I18N]` translation.
**Size:** S / M / L. **Sketch?** = wants a concept mock before build. **@Earthling** = needs Earthling's call.
_Started 2026-08-03. Owner brain-dump complete; refine + resequence as we go._

---

## ❓ Open questions (answered)
- **"− N +" control** → the **quantity stepper**.
- **Historical booking log placement/name** → new **Admin tab**, recommended name **"Bookings"** (Schedule stays the calendar view; Bookings = searchable master list). Alts: "Records" / "Booking Log". Feeds both ops (find any booking) and Finance (refund home).
- **Moving a tab** → easy (nav entry + panel); real work is the panel content.

## ▶️ Recommended next (sequencing)
1. **Finance Slice 2**, starting with **N1 Bookings tab** as the prerequisite (refunds need a home first) → then wire refund data into Finance.
2. Quick **bug-fixes** in parallel (L2, D4, A1) — small and high-annoyance.
3. Then **screen-by-screen UI batches** (drawer polish, courses panels, finance, cockpit, schedule).
4. **Mobile LAST** — after the main-site UI settles (we're still adding/removing buttons; no point chasing a moving target).

---

## 🧠 Luna (brain / behavior)
- **L1 — Personality/voice.** Luna needs a defined personality. **@Earthling.** `L`
- **L2 — [BUG] Disabled rental still offered.** Turning a rental OFF in Admin doesn't stop Luna offering it; she must respect the enabled/active flag. `M`
- **L3 — [FEAT] Email capabilities for Luna.** Give Luna the ability to send/handle email (not just WhatsApp). **@Earthling + Skipper — in progress.** `L`

## 🔌 Luna wiring & de-hardcode (audit)
- **W1 — [FEAT][LUNA] Wire Luna for every relevant setting.** Standing initiative; beaches (A3) is case #1.
  - **Pre (not started):** Captain audits every Admin setting → maps which Luna reads vs ignores, with a wire/skip recommendation per setting. This produces the concrete checklist the wiring work runs off. _(deferred — not tonight)_ `L` (ongoing)
- **W2 — Age range de-hardcode?** Currently hardcoded; maybe it shouldn't be. **@Earthling** to decide. `M`
- **W3 — Frequency de-hardcode?** Currently hardcoded; maybe it shouldn't be. **@Earthling** to decide. `M`
- **W4 — [I18N] Custom course names translated everywhere.** Course names are custom but must be translated across menus, cockpit, Luna — everywhere they appear. **@Earthling.** `M–L`

## 🧾 Create / Edit booking drawer (equipment section — ~30% of plan done)
- **D1 — Quantity stepper too big.** Shrink the `− N +` (quantity stepper); it's so big it pushes the estimated line total *underneath* it. Fix layout so the total sits inline/tight. `S` · sketch?
- **D2 — Greens don't match.** Green shades on the Create/Edit drawer are inconsistent; unify to one green token. `S`
- **D3 — Header mismatch (Captain-spotted).** Reads "EQUIPMENT" on Create vs "RENTALS" on Edit; pick one. `S`
- **D4 — [BUG] Group Course on, none picked → rentals unpriced.** If "Group Course" is toggled but no actual course is selected, rentals show no estimate → booking can't complete. Fix: let standalone rentals price without a course, OR block submit until a real course is chosen. `M`

## 📅 Schedule tab
- **S1 — Rental pickups (by-guest) redundant tags.** Staff/Paid/Unpaid/Waiver repeat on every *item* row; keep them only next to the *guest*, items stay clean. _(concept already sketched)_ `S–M`

## 🖥️ Cockpit
- **C1 — Selector placement.** Daily/Monthly + Timeline/Cards selectors control a whole panel underneath them, so they're misplaced; need repositioning + some redesign (no obvious home right now). `M` · sketch?

## 💶 Finance tab
- **F1 — "This month" quick jump.** Month switcher up top needs a fast way back to the current month. `S`
- **F2 — [FEAT] Revenue-by-product hardcoded.** Remove hardcoded "board rental / wetsuit rental"; show the same items as the Cockpit right side: course-included item(s) + the 2 next most-rented items for the selected period (driven by the day/month/year filter). `M`
- **F3 — [FEAT] Gross-vs-last-year view toggle.** The "daily gross collected vs last year" chart needs a switch between the current month's days (now) and a yearly 12-months view. `M`

## 🛠️ Admin panel (courses / config)
- **A1 — Group courses sorted by name → by time.** The created group-courses list orders alphabetically; sort by the time each course runs (earliest → latest). `S`
- **A2 — [UI] Reformat Group & Private course panels.** Give the Group and Private course admin panels the same treatment as the Rental Prices card (compact rows + expand-in-place editor). `M`
- **A3 — [FEAT][LUNA] Beaches: de-hardcode + custom + wire.** *(important)* On create/edit group course, beaches are hardcoded — delete them and add a **"+ add beach"** so admin defines their own; also **wire Luna** to pick them up (she doesn't today). First case of W1. `M`

## 🆕 New feature
- **N1 — [FEAT] "Bookings" tab (historical booking log).** New Admin tab; **design approved** (concept mocked). Prerequisite for Finance Slice 2 (refund home). `M–L`
  - Summary strip (re-totals per active filter): Bookings · Collected · Refunded · Net · Outstanding.
  - Table: Booking (**full code visible — wide column**), Guest, Service dates, What, Total, Paid, Status chip (Paid/Unpaid/Partial/Refunded/Cancelled/Deleted).
  - Filters: search (guest/phone/code), date range, status, type, location; **CSV export**.
  - Row-click → inline detail: item breakdown, charged/collected/refunded/net, guest/waiver/created-by, **Record refund** (amount·date·reason·staff) = the refund home.
  - **Deleted bookings viewable** via an **"Archived" filter/toggle** (deleted + cancelled, shown dimmed) — NOT a separate tab. _(Step-0: confirm deletes are soft/retained; if hard-deleted, switch to soft-delete/archive so they can be shown.)_
  - **Click guest name → opens the Customers tab for that client.**

## 📱 Mobile — LAST
- Deprioritized on purpose: do the main-site UI first (still adding/removing buttons, reformatting menus), *then* go mobile screen-by-screen. Add specifics here as you hit them: "mobile: [screen]".

## 🔁 Process
- Testing runs **during + after** each change; devs (Monshies + Earthling) manage it for now.
