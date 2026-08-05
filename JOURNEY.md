# JOURNEY — shared dev status (Monshies + Earthling)

**Keyword: "Journey".** *"pull up the Journey"* → Captain/Skipper reads this back + brings you current. *"update the Journey"* → we save the current state here. Keep it terse — a living board, not docs. Whoever picks up / ships / deploys updates the matching section. Say *"I'm deploying X"* before deploying to avoid parallel-deploy collisions (deploy only from clean `HEAD == origin/master`).

_Last updated: 2026-08-05 06:07 UTC by Captain_

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
- **Finance polish v2 SHIPPED** (Skipper; Captain gated+deployed) — equal-width Revenue/Capacity cards; Monthly view = "Monthly gross vs last year", fixed **Jan→Dec** axis + full-width graph; Custom picker restyled to a **compact floating window** (Su–Sa, Cancel/Apply), second range readout removed, clears on Day/Month/Year. **Captain caught + rejected a stale-base v1** (parent was an old pre-tonight commit — would've reverted revs 0458–0464); redone on current master. Real-browser gates custom-range 89 + Finance UI 105 (reproduced) + finance suite + luna-all 21; sha256 `ae5139e0`; `4ddb90d2` rev 0000465
- **Rental editor layout SHIPPED** (Skipper; Captain gated+deployed) — name/stock/enabled compact group + responsive 3/2/1 duration-price grid + smaller transparent remove ×. Hybrid `/staff/ui` Playwright 252/252; the "1 fail" I first saw was the `/opt/data/artifacts` EACCES perms, not code; confirmed the few other reds fail on base too (pre-existing). `d8bff3f2` rev 0000466
- **Bookings tab v2 SHIPPED** (Nav team; Captain gated+deployed) — sortable columns (server-side, Total/Paid highest-first, dates earliest-first); **"What" → "Type"** = Rentals/Lessons/Accommodation (all courses grouped), show-all-applicable chips; Total/Paid aligned under headers, Booking/Guest slimmer; **Status column bigger, chips smaller + darker dark-mode palette**. Clean 3-way merge onto master (rental editor verified 100% intact); gates sort-type 63 + N1 175 + luna-all 21; real-DB Type/sort validator passed; sha256 `e2db793d…c3cb37c`; `5c930314` rev 0000467
- **Rental editor v5 polish SHIPPED** (Skipper; Captain gated+deployed, supersedes v3/v4) — stock ~72px, Enabled shifted for ≥24px gap + ≤2px align, 35px fields, 30×30 remove × w/ 18px glyph, 3/2/1 grid. CSS-only (staff-query-api + verifier). Hybrid `/staff/ui` **262/262** geometry gate + catalog 51 + equipment-fixes 63 + rental-stock + luna-all 21; sha256 `9540e655`; `9271c3d3` rev 0000468

**Aug 03**
- Luna email platform foundation through delegated-grant custody shipped to master: endpoint identity + Microsoft delegated OAuth contract, Graph adapter/readiness, dedicated encrypted grant custody, and the Standard-Key-Vault RSA envelope provider.
- **2F-A encrypted custody merged** — dedicated tenant-safe grant table, lease/generation fencing, reconciliation + commit-unknown handling, canonical encrypted-envelope contract; PR #352, `c04c5f2d`. Stock PostgreSQL concurrency proof: 29/29.
- **2F-B Azure envelope provider merged** — local AES-256-GCM with exact-version Standard Key Vault RSA-OAEP-256 DEK wrapping; A256KW production path rejected; PR #353, `95754acc`. Focused gate 92/92.
- Email runtime remains deliberately **OFF**: refresh exchange, OAuth callback integration, Key Vault client composition, activation, routes, and deploy are not enabled.

**Aug 04**
- **Private Course card redesign SHIPPED** (Nav team built, Captain gated+deployed) — closed **2a** full-width columns (Lesson · Price · Duration · Equipment pills · ✎) + **one-row edit** (identity | equipment | Save/Cancel) with Notes under; equipment editor subtree byte-intact. New served-`/staff/ui` gate 26/26 (round-trip save, invalid-policy fail-closed, remove-to-zero, narrow-width) + rental-fixes 63 + pricing-model 17 + private-lessons 27 + authority; base-integrity verified (parent==master); `0ac9c499` rev 0000469. **Live-wire confirmed on authed page** (staff cookie).
- **Course-cards polish SHIPPED** (Nav team; Captain gated+deployed) — **Private:** dropped the accent palette (no blue/purple/green → neutral `--text`/`--text-3`), price/duration 88/86→64px, name field grows, true one-row closed; **Group Option 3:** meta rows + equipment moved under meta + **two-column price list**; **shared equipment editor:** equal During/All-day widths, `×` on the same row, `+` beside `×`. CSS-only, no backend/migration. Gates private-onerow + group-opt3 + rental-fixes 63 + pricing-model 17 + private-lessons + authority; **live authed check = 0 accent tokens on the served page**; `068c8874` rev 0000470. _Owner has a few more tweaks coming tomorrow._
- **Bookings tab edits + Restore SHIPPED** (Nav team; Captain gated+deployed) — Type→plain text + server-derived categories (accommodation fixed), refund section hidden unless cancelled/refunded (kills raw `refundNeedsCancel` leak), **Restore** button on cancelled rows (Bookings + schedule drawer, not on hidden), Created column sorting `created_at`, status chips centered, EN/ES/IT. Real-DB validated (type/sort). `7bdbcacf` rev 0000471.
- **Bookings/Finance/item-name audit SHIPPED** (Skipper; Captain gated+deployed, no Seadog — Captain sole gate) — **finance fail-soft:** one stale-balance/malformed row no longer 503s the whole tab (structured `data_quality` flag + still 200); clickable booking codes → Schedule day + drawer; cancelled/hidden show Type; **shared `item-display-name`** resolver (rentals by catalog key, accommodation package name) across bookings/drawer/invoices/Luna — Luna money paths label-only (amounts untouched). Pre-flip real-DB proof: finance returns 200 with drift booking flagged; **live finance 503→200**. `820d4ec7` rev 0000472. Audit map `docs/BOOKINGS-FINANCE-LABEL-AUDIT-MAP.md`.
  - **Finance incident (Captain pinpointed via read-only reconcile job):** booking `c713c1d7` — total €35, persisted balance €20, no captured payment = €15 material drift → tripped the old fail-closed guard. Fail-soft renders around it. **OPEN: owner money-truth decision** — was €15 paid, or is €35 owed? Then correct that one booking.
- **Schedule guest-collapse rule SHIPPED** (Captain authored + self-gated; Earthling requested) — cards mode shows course guests by default; timeline collapses a course's guests **only when no all-day course gear AND ≥1h past end** (people keep equipment). Ops-board gate 255/0 (+ rule cases). `2b25d077` rev 0000473.
- **Email 2F-C2 checkpoint** — integrated to master at `1b6fa65b` (serial after `2b25d077`; newer schedule work preserved). Runtime composition is Sunset-staging-canary-only, default-off, explicit-factory-only, not wired into startup/OAuth/refresh. Gates: runtime composition 31/31, provider 92/92, custodian 80/80, OAuth contract 118/118, migration integrity PASS, npm audit 0 vulns. **Not deployed** (staging left on `2b25d077` for this slice); migration 059 not applied; no mailbox/OAuth consent/Graph access/polling/ingestion/drafts/sending. Next (at slice close): Azure identity/KEK/RBAC readback, then deploy code with every email capability off.

## 🍳 On the stove (in progress)
- **L3 / email 2F-C3 DEPLOYED dormant (email OFF):** Azure pre-deploy gate done by Captain read-back — identity clientId `0e05fbe3…`/principalId `5338388f…` ✅, **Crypto User granted narrowly to the exact KEK** `luna-email-grant-kek` ✅ (least-privilege); KEK `enabled` flag not host-readable (least-privilege) but proven by the later custody test (runs as the MI). 2F-C2 factory now on staging (rev 0474) but dormant — no routes, migration 059 unapplied. **Next (each own gate, still OFF):** apply migration 059 → synthetic wrap/unwrap custody proof → OAuth callback plumbing → shadow/readiness → separately-approved activation. No guest mail before all green.
- **OPEN — finance money-truth:** booking `c713c1d7` (€35 total / €20 persisted balance / no captured payment). Finance renders around it (fail-soft), but the record needs correcting once owner says whether €15 was paid or €35 is owed.
- Sunset UI from **[SUNSET-TODO.md]** — Bookings/Finance/cancel-hide/rental-editor + course-card (A2) + bookings-tab-edits/Restore + item-name audit + schedule guest-collapse all **shipped (revs 0458–0473)**. **Remaining:** **L2** (Luna still offers disabled rentals — @Earthling/Luna layer), Admin **A3** (beaches de-hardcode + Luna wire), Cockpit **C1**, Luna wiring **W1–W4** (@Earthling), then **Mobile** last.
- Notice-board auto-message idea (one editable Discord message mirroring Journey+SUNSET-TODO) — parked pending owner enabling the Discord send/edit tool for Captain.
## 📋 To do
- Luna email — post-2F-C2 path (all OFF until each gate passes): Azure pre-deploy verify → deploy 2F-C2 → controlled staging Key Vault wrap/unwrap custody proof → refresh-exchange adapter + OAuth callback → shadow/readiness proof → separately-approved activation. No guest mail before every gate passes.
- **Crowsnest favicon deploy** — image `crowsnest:34e4b7f3…` built & in ACR; **blocked** (this host has no write on `luna-crowsnest-rg`) → Earthling runs the `az containerapp update`.
- Staff-API decomposition — more slices (1–5 shipped).
- Lunabox deep disk clean (~20G: stale clones + `docker image prune -a`) when agents idle.

---

## 🚀 Live where
- **Sunset · staff-api** (staging) — deployed `29106e4d` rev 0000474 · 08-05 04:37 · Captain _(**2F-C3**: 2F-C2 email factory now ON staging but **dormant** — email OFF, no routes, migration 059 unapplied)_. Verified: healthz 200, staff UI 200, email/oauth routes 404, finance 200. Prior tonight: 0471 bookings+Restore, 0472 finance fail-soft + item-name audit, 0473 schedule guest-collapse.
- **Sunset · Luna** plugin+SOUL (staging) — `c79da8aa` Slice E · 08-02 05:17 · Captain _(separate deploy — drifts from staff-api)_
- **Wolfhouse · staff-api** (PROD) — _verify_ · Earthling
- **Wolfhouse · Luna** guest WhatsApp (prod) — _verify_ · Earthling
- **Crowsnest** (crowsnest-internal) — `b7eaba09` old · favicon `34e4b7f3` built, deploy pending (Earthling)
- **Marketing** (lunafrontdesk.com) — _verify_ · SWA `luna-marketing`

_Sunset is staging-only (no prod client yet); Wolfhouse carries the live prod hostel._
