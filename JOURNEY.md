# JOURNEY — shared dev status (Monshies + Earthling)

**Keyword: "Journey".** *"pull up the Journey"* → Captain/Skipper reads this back + brings you current. *"update the Journey"* → we save the current state here. Keep it terse — a living board, not docs. Whoever picks up / ships / deploys updates the matching section. Say *"I'm deploying X"* before deploying to avoid parallel-deploy collisions (deploy only from clean `HEAD == origin/master`).

_Last updated: 2026-08-02 17:56 UTC by Captain_

---

## ✅ Recently done (last ~5 days)

**Jul 30**
- Seasonal + multi-stay accommodation bookings
- Rental qty steppers + day-tier continuation pricing + qty/duration integrity guards
- Invoice display cleanup; course-owned equipment shown on course cards
- Staff-API decomposition plan + templating-runtime audit
- Deckhand↔Seadog A2A-lite on navigation thread; Lunabox DNS-fallback fix

**Jul 31**
- Schedule Day Cockpit (P1–P3, clock-freeze, Timeline/Cards toggle, dark-mode polish)
- Rentals: independent catalog stock + transactional availability
- Cancelled-booking lifecycle (restore / delete wording / finance exclusion)
- Templatable external Google-Form waiver (link-only v1)

**Aug 01**
- Luna Sunset de-hardcoding (catalog Slices 1–2, catalog tool v2, rental-create P1/b/c, course-equip P2)
- Staff-API decomposition Slices 1–5 (notif-settings, whatsapp-numbers, customers CRM, inbox, automated-notifications)
- Staff-API perf: gzip responses + non-blocking schedule reconcile
- Finance tab Option B Slice 1; Group Course edit-drawer polish; owl favicon

**Aug 02**
- Sunset canonical course-equipment chain (Slices A–E)
- Combo-pricing fixes P0–P0e (included gear attaches, one all-day mechanism, standalone pricing, pickups per-record scope, friendly labels)
- Crowsnest favicon built; this JOURNEY board added
- Sunset rental/equipment thread **closed** (owner-verified: pricing, pickups scope, "+" labels)
- Admin Rental Prices card redesign shipped — hybrid (compact rows + expand-in-place editor); `89ace136`, gate 104/104
- Admin Rental Prices card **polish** shipped — Add-equipment inline, "Stock = X · Enabled/Disabled" (dot left), edit-header fix, ⋯ removed; `9a8aaf35`, gate 230/230
- Sunset **D/E/H live-verified** (staff cookie): D=unavailable gear rejected + not auto-included (restored); E=full drawer combo quote→create €115 all lines no stale (SUNSET-…707E02); H=per-date SUP stock sold-out fail-closed + isolation
- Booking-drawer **EQUIPMENT reorg** shipped (Create + Edit) — name-as-toggle, per-line totals, "from €X", labels dropped; `f056e2d6`, gate green

## 🍳 On the stove (in progress)
- _(Captain idle — booking-drawer reorg shipped; awaiting next task.)_
- **Earthling** — _add what you're on here._

## 📋 To do
- **Crowsnest favicon deploy** — image `crowsnest:34e4b7f3…` built & in ACR; **blocked** (this host has no write on `luna-crowsnest-rg`) → Earthling runs the `az containerapp update`.
- Staff-API decomposition — more slices (1–5 shipped).
- Finance tab — deeper items (real refund ledger / true net).
- Lunabox deep disk clean (~20G: stale clones + `docker image prune -a`) when agents idle.

---

## 🚀 Live where
- **Sunset · staff-api** (staging) — `f056e2d6` rev 0000453 · 08-03 02:56 · Captain
- **Sunset · Luna** plugin+SOUL (staging) — `c79da8aa` Slice E · 08-02 05:17 · Captain _(separate deploy — drifts from staff-api)_
- **Wolfhouse · staff-api** (PROD) — _verify_ · Earthling
- **Wolfhouse · Luna** guest WhatsApp (prod) — _verify_ · Earthling
- **Crowsnest** (crowsnest-internal) — `b7eaba09` old · favicon `34e4b7f3` built, deploy pending (Earthling)
- **Marketing** (lunafrontdesk.com) — _verify_ · SWA `luna-marketing`

_Sunset is staging-only (no prod client yet); Wolfhouse carries the live prod hostel._
