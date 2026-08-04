# SUNSET-TODO — Sunset staff portal (+ Luna)

Running Sunset product TODO (formerly `UI-BACKLOG.md`): UI/UX, functional work, and Luna platform capabilities. Owner brain-dumps; Captain sorts, sizes, sketches, and hands scoped briefs to Skipper; Captain gates + deploys. Testing happens during + after each change (devs manage). Linked from [JOURNEY.md].

**Tags:** `[UI]` layout/visual · `[BUG]` broken behavior · `[FEAT]` new capability · `[LUNA]` chatbot brain/wiring · `[I18N]` translation.
**Size:** S / M / L. **Sketch?** = wants a concept mock before build. **@Earthling** = needs Earthling's call.
_Started 2026-08-03. Last updated 2026-08-03 23:20 UTC. Owner brain-dump complete; refine + resequence as we go._

---

## ❓ Open questions (answered)
- **"− N +" control** → the **quantity stepper**.
- **Historical booking log placement/name** → new **Admin tab**, recommended name **"Bookings"** (Schedule stays the calendar view; Bookings = searchable master list). Alts: "Records" / "Booking Log". Feeds both ops (find any booking) and Finance (refund home).
- **Moving a tab** → easy (nav entry + panel); real work is the panel content.

## ▶️ Recommended next (sequencing)
1. ✅ SHIPPED (revs 0458–0460): Bookings/Cockpit polish, Finance S2 (refund-aware Net), **D4**, Inbox toggle, **F2**.
2. **Next small wins:** **L2** (Luna still offers disabled rentals — Luna/@Earthling layer) + Admin **A2/A3**, Cockpit **C1**. (A1/F1/F3 shipped.)
3. Then Finance **F1/F3** + Cockpit **C1** + Admin course panels (**A2/A3**).
4. **L3 email 2F-C** resumes only when Earthling has Azure access; until then parked safely with runtime OFF.
4. Then **screen-by-screen UI batches** (courses panels, finance, cockpit, schedule).
5. **Mobile LAST** — after the main-site UI settles (we're still adding/removing buttons; no point chasing a moving target).

---

## 🧠 Luna (brain / behavior)
- **L1 — Personality/voice.** Luna needs a defined personality. **@Earthling.** `L`
- **L2 — [BUG] Disabled rental still offered.** Turning a rental OFF in Admin doesn't stop Luna offering it; she must respect the enabled/active flag. `M`
- **L3 — [FEAT] Email capabilities for Luna.** Give Luna the ability to send/handle email (not just WhatsApp). **@Earthling + Skipper — in progress.** `L`
  - **Shipped foundation:** delegated endpoint/OAuth contracts, Graph adapter/readiness, encrypted grant custody (2F-A, PR #352), and Standard Key Vault RSA envelope provider (2F-B, PR #353).
  - **WAITING — 2F-C Azure boundary:** Earthling inventories `wh-staging-kv` keys and supplies an exact versioned RSA key path (or creates the approved key with narrow RBAC), then runs a controlled staging wrap/unwrap proof.
  - **Still OFF / later:** SDK managed-identity composition, refresh exchange, OAuth callback installation, routes, mailbox activation, deployment, and guest email behavior.
  - **Safety:** raw refresh tokens never enter PostgreSQL; no production A256KW/Managed HSM; no activation until live staging custody proof and later gates pass.

## 🔌 Luna wiring & de-hardcode (audit)
- **W1 — [FEAT][LUNA] Wire Luna for every relevant setting.** Standing initiative; beaches (A3) is case #1.
  - **Pre (not started):** Captain audits every Admin setting → maps which Luna reads vs ignores, with a wire/skip recommendation per setting. This produces the concrete checklist the wiring work runs off. _(deferred — not tonight)_ `L` (ongoing)
- **W2 — Age range de-hardcode?** Currently hardcoded; maybe it shouldn't be. **@Earthling** to decide. `M`
- **W3 — Frequency de-hardcode?** Currently hardcoded; maybe it shouldn't be. **@Earthling** to decide. `M`
- **W4 — [I18N] Custom course names translated everywhere.** Course names are custom but must be translated across menus, cockpit, Luna — everywhere they appear. **@Earthling.** `M–L`

## 🧾 Create / Edit booking drawer
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

## ✅ Recently shipped from this TODO
- **D1–D3 — Booking-drawer equipment polish:** compact quantity/total layout, unified green, and one Equipment header; `ef936ec5`, followed by picker regression fix `6eed4823`.
- **N1 — Bookings tab:** searchable historical log, filter-global finance summary, CSV, archived records, guest→Customers, and append-only manual refund ledger; `42e30925`. List-500/layout fix `27981048` is live on Sunset staging.
- **Bookings summary + Cockpit UI polish:** Bookings cards-on-top, colored metrics, live filters (no Apply/checkbox), drawer date-range picker, status pills, expand order Guest→Items→Payment, trimmed refund note; Cockpit non-today relative-day labels (Yesterday/In N days/Last week…/years) + day summary, EN/ES/IT; `1805d95b` rev 0000458.
- **Finance Slice 2 — refund-aware Net:** Finance hero Net = gross − Σ recorded refunds (`booking_refund_records`, by `effective_date`), Gross/Refunds broken out, pending-cancellation proxy retired; L1–L4, SAVEPOINT soft-empty, EN/ES/IT; live-DB validated; `454f8015` rev 0000459.
- **Sunset batch (D4 + Inbox + F2):** D4 group-course/no-course now quotes standalone rentals + blocks Create with a clear message; Inbox collapsible booking/payment right rail (sessionStorage); F2 Revenue-by-product = 5 fixed rows (Lessons/course-equipment-all-modes/top-2-€/Other); `b217238b` rev 0000460.
- **Sunset batch (A1 + F1/F3 + Finance UI + cancel/hide):** A1 courses sort-by-time; F1 tabs snap to current period; F3 gross month↔year toggle; Finance UI cleanup (no title, Custom calendar, Accommodation, uniform bars, note-under); Revenue 5 rows / Capacity 4 rows; **essential cancel/hide** (migration 060 `bookings.hidden`; no site delete; Cancel→grey+refund; Hide off schedule; Unhide in Bookings; refund only when cancelled); `0c9c8d3d` rev 0000461.

## 📱 Mobile — LAST
- Deprioritized on purpose: do the main-site UI first (still adding/removing buttons, reformatting menus), *then* go mobile screen-by-screen. Add specifics here as you hit them: "mobile: [screen]".

## 🔁 Process
- Testing runs **during + after** each change; devs (Monshies + Earthling) manage it for now.
