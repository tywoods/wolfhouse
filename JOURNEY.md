# JOURNEY — shared dev status (Monshies + Earthling)

**Keyword: "Journey".** *"pull up the Journey"* → Captain/Skipper reads this back + brings you current. *"update the Journey"* → we save the current state here. Keep it terse — a living board, not docs. Whoever picks up / ships / deploys updates the matching section. Say *"I'm deploying X"* before deploying to avoid parallel-deploy collisions (deploy only from clean `HEAD == origin/master`).

_Last updated: 2026-08-03 23:20 UTC by Skipper_

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
- Booking-drawer polish **D1–D3** shipped (Nav team: Deckhand+Seadog) — compact qty stepper + total inline, unified greens, "Equipment" header; `ef936ec5`
- **Fix:** Edit-drawer equipment picker regression (from D1–D3) + All-Day compact qty; gate extended w/ edit-no-rentals case; `6eed4823` (Nav team)
- SUNSET-TODO.md added (full owner dump, sorted + sequenced); Bookings tab (N1) design approved
- **N1 — "Bookings" tab SHIPPED** (Skipper built, Captain gated+deployed) — historical log w/ search+date/status/type/location filters, filter-global summary (collected/refunded/net/outstanding), full codes, CSV export, Archived (cancelled+deleted), inline item/payment/waiver/guest/creator, guest→Customers link, **manual refund ledger** (append-only DB triggers, operator-write/viewer-read, race-safe over-refund lock, idempotent, **no Stripe refund**); **migration 056** applied to sunset DB (table+2 triggers+idem idx verified); `42e30925`, N1 gate 147/147
- **Fix:** N1 list 500 + filter layout — waiver query selected non-existent `w.completed_count` (derive from `waiver_form_submissions`); toolbar flex→grid so filter fields stop colliding. Validated the real list query against the live sunset DB (5 rows, summary+CSV clean) before deploy; `27981048` rev 0000457
- **Bookings + Cockpit UI polish SHIPPED** (Nav team built, Captain gated+deployed) — Bookings: cards-on-top, colored metrics, live filters (no Apply/checkbox), drawer date-range picker, status pills, expand Guest→Items→Payment, trimmed refund note; Cockpit: non-today relative-day labels (Yesterday/In N days/Last week…/years)+day summary, EN/ES/IT. Verified pack (bundle `b36b9f95`) cherry-picked atop 2F-B master, zero email overlap; N1 154 + cockpit ui 116/p3 91 + luna-all 21; `1805d95b` rev 0000458
- **Finance Slice 2 — refund-aware Net SHIPPED** (Nav team built, Captain gated+deployed) — Finance hero now Net = gross collected − Σ recorded refunds (from `booking_refund_records`, `effective_date`), Gross/Refunds broken out, retired the pending-cancellation proxy; L1–L4 contracts, SAVEPOINT soft-empty if ledger absent, EN/ES/IT. Verified pack (bundle `8ab6d1f0`); gates S2 61 + finance-data 55 + redesign 63 + luna-all 21; **live-DB probe confirmed refund query returns €80/2 rows** before deploy; `454f8015` rev 0000459
- **Sunset batch SHIPPED — D4 + Inbox toggle + F2** (Nav team built, Captain gated+deployed) — **D4:** Group-Course-on/no-course now still quotes standalone rentals + blocks Create with "Select a course or turn off Group Course"; **Inbox:** collapsible booking/payment right rail (sessionStorage, chat reflows); **F2:** Revenue-by-product = 5 fixed rows (Lessons · course-equipment all-modes · top-2 by € · Other), EN/ES/IT. sha256 `238965ff`; gates D4 21 + Inbox 11 + F2 26 + redesign 64 + luna-all 21; live-DB validated F2 over 100 real BSR rows (a 0-rows scare was a probe-key artifact, not F2); `b217238b` rev 0000460
- **Sunset batch SHIPPED — A1 + F1/F3 + Finance UI + cancel/hide** (Nav team built, Captain gated+deployed) — **A1** courses sort by run-time; **F1** Day/Month/Year tabs snap to current period (no new button); **F3** gross chart month-days↔12-month toggle; Finance UI: dropped redundant title, Custom→date-range calendar, "Accommodation" rename, uniform smaller bars + note-under-bars, **Revenue 5 rows / Capacity 4 rows** (Captain fixed team's 4/4 → 5/4 per owner). **ESSENTIAL cancel/hide:** no site-side delete; Cancel greys + unlocks refund; **migration 060 `bookings.hidden`** applied+verified; Hide removes from schedule, Unhide only in Bookings tab, refund gated to cancelled. sha256 `14d56889`; gates F2 22 + batch 35 + unhide 18 + N1 154 + lifecycle 63 + migration-integrity + luna-all 21; `0c9c8d3d` rev 0000461
- **Finance UI revisions SHIPPED** (Nav team; Captain gated+deployed) — F3 trend now has its own Days/12-months toggle independent of the top period menu; Custom opens the date-range calendar; revenue/capacity bars fixed-label-column aligned + tighter; **capacity ring restored**. Revenue 5 / Capacity 4 unchanged, no migration. sha256 `3750d9a9`; gates custom-range 19 + ui-revisions 25 + F2 22 + luna-all 21; live compute-check clean; `7379108c` rev 0000462
- **Cancel/hide v2 SHIPPED** (Nav team; Captain gated+deployed) — **"Deleted" removed everywhere** (status/tag/filter/alias/export/i18n); All-statuses includes non-hidden cancelled (not greyed on Bookings panel, greyed on schedule only); **Hidden** = cancelled-only declutter (filter+tag+Unhide); **Refund-needed tag + Record Refund gated to cancelled ∧ collected>refunded**, clears when fully refunded (Refunded tag kept). Reuses migration 060, no new migration; live-validated bookings list under all/cancelled/hidden filters. sha256 `2c06e100`; gates cancel-hide-v2 33 + N1 154 + unhide 18 + lifecycle 63 + luna-all 21; `88c91f58` rev 0000463
- **Finance Custom picker FIXED + SHIPPED** (Skipper audit; Captain gated+deployed) — root cause: Custom sent `granularity=custom` with no start/end, so the server fell back to Month and repainted away the picker host (deferred open no-op'd). Fix: Custom opens a client-owned calendar immediately over the current view; only sends `granularity=custom` + start + end after 2 valid dates; survives repaint. Real /staff/ui Playwright gate 87/87 (replaced the VM/DOM stub — the offline-green/live-dead gap). sha256 `89181cd6`; `ef68c3b4` rev 0000464. Owner to confirm authenticated click-through.

**Aug 03**
- Luna email platform foundation through delegated-grant custody shipped to master: endpoint identity + Microsoft delegated OAuth contract, Graph adapter/readiness, dedicated encrypted grant custody, and the Standard-Key-Vault RSA envelope provider.
- **2F-A encrypted custody merged** — dedicated tenant-safe grant table, lease/generation fencing, reconciliation + commit-unknown handling, canonical encrypted-envelope contract; PR #352, `c04c5f2d`. Stock PostgreSQL concurrency proof: 29/29.
- **2F-B Azure envelope provider merged** — local AES-256-GCM with exact-version Standard Key Vault RSA-OAEP-256 DEK wrapping; A256KW production path rejected; PR #353, `95754acc`. Focused gate 92/92.
- Email runtime remains deliberately **OFF**: refresh exchange, OAuth callback integration, Key Vault client composition, activation, routes, and deploy are not enabled.

## 🍳 On the stove (in progress)
- **L3 / email 2F-C — WAITING on Earthling Azure access (~8h):** inventory `wh-staging-kv` keys, then version-pin or create the approved RSA wrapping key and prove controlled staging wrap/unwrap. Current operator can inspect the Standard/RBAC vault but lacks `keys/read`. No runtime activation while waiting.
- Safe parallel lane (while 2F-C waits): Sunset UI/functional work from **[SUNSET-TODO.md]** — shipped: Bookings/Cockpit polish, Finance S2, D4, Inbox toggle, F2; **next up: A1** (courses sort-by-time) + **L2** (Luna/@Earthling), then Finance **F1/F3** & Cockpit **C1**, each in an isolated branch/worktree.
- **Earthling** — resume 2F-C at the Azure credential boundary; add any separate active work here before deploying.

## 📋 To do
- Luna email after 2F-C: SDK/managed-identity composition → controlled staging Key Vault proof → refresh-exchange adapter and callback integration → shadow/readiness proof → separately approved activation. No guest mail flow before every gate passes.
- **Crowsnest favicon deploy** — image `crowsnest:34e4b7f3…` built & in ACR; **blocked** (this host has no write on `luna-crowsnest-rg`) → Earthling runs the `az containerapp update`.
- Staff-API decomposition — more slices (1–5 shipped).
- Lunabox deep disk clean (~20G: stale clones + `docker image prune -a`) when agents idle.

---

## 🚀 Live where
- **Sunset · staff-api** (staging) — `d8bff3f2` rev 0000466 · 08-04 05:35 · Captain _(rental editor layout: name/stock/enabled group + responsive duration/price grid + smaller remove btns)_
- **Sunset · Luna** plugin+SOUL (staging) — `c79da8aa` Slice E · 08-02 05:17 · Captain _(separate deploy — drifts from staff-api)_
- **Wolfhouse · staff-api** (PROD) — _verify_ · Earthling
- **Wolfhouse · Luna** guest WhatsApp (prod) — _verify_ · Earthling
- **Crowsnest** (crowsnest-internal) — `b7eaba09` old · favicon `34e4b7f3` built, deploy pending (Earthling)
- **Marketing** (lunafrontdesk.com) — _verify_ · SWA `luna-marketing`

_Sunset is staging-only (no prod client yet); Wolfhouse carries the live prod hostel._
