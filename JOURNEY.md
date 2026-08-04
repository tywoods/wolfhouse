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

**Aug 03**
- Luna email platform foundation through delegated-grant custody shipped to master: endpoint identity + Microsoft delegated OAuth contract, Graph adapter/readiness, dedicated encrypted grant custody, and the Standard-Key-Vault RSA envelope provider.
- **2F-A encrypted custody merged** — dedicated tenant-safe grant table, lease/generation fencing, reconciliation + commit-unknown handling, canonical encrypted-envelope contract; PR #352, `c04c5f2d`. Stock PostgreSQL concurrency proof: 29/29.
- **2F-B Azure envelope provider merged** — local AES-256-GCM with exact-version Standard Key Vault RSA-OAEP-256 DEK wrapping; A256KW production path rejected; PR #353, `95754acc`. Focused gate 92/92.
- Email runtime remains deliberately **OFF**: refresh exchange, OAuth callback integration, Key Vault client composition, activation, routes, and deploy are not enabled.

## 🍳 On the stove (in progress)
- **L3 / email 2F-C — WAITING on Earthling Azure access (~8h):** inventory `wh-staging-kv` keys, then version-pin or create the approved RSA wrapping key and prove controlled staging wrap/unwrap. Current operator can inspect the Standard/RBAC vault but lacks `keys/read`. No runtime activation while waiting.
- Safe parallel lane (while 2F-C waits): Sunset UI/functional work from **[SUNSET-TODO.md]** — Bookings/Cockpit polish + Finance Slice 2 now shipped; next up is the bug batch **L2/D4/A1**, then Finance **F1/F2/F3** & Cockpit **C1**, each in an isolated branch/worktree.
- **Earthling** — resume 2F-C at the Azure credential boundary; add any separate active work here before deploying.

## 📋 To do
- Luna email after 2F-C: SDK/managed-identity composition → controlled staging Key Vault proof → refresh-exchange adapter and callback integration → shadow/readiness proof → separately approved activation. No guest mail flow before every gate passes.
- **Crowsnest favicon deploy** — image `crowsnest:34e4b7f3…` built & in ACR; **blocked** (this host has no write on `luna-crowsnest-rg`) → Earthling runs the `az containerapp update`.
- Staff-API decomposition — more slices (1–5 shipped).
- Lunabox deep disk clean (~20G: stale clones + `docker image prune -a`) when agents idle.

---

## 🚀 Live where
- **Sunset · staff-api** (staging) — `454f8015` rev 0000459 · 08-03 23:56 · Captain _(Bookings+Cockpit UI + Finance Slice 2 refund-aware Net; atop 2F-B)_
- **Sunset · Luna** plugin+SOUL (staging) — `c79da8aa` Slice E · 08-02 05:17 · Captain _(separate deploy — drifts from staff-api)_
- **Wolfhouse · staff-api** (PROD) — _verify_ · Earthling
- **Wolfhouse · Luna** guest WhatsApp (prod) — _verify_ · Earthling
- **Crowsnest** (crowsnest-internal) — `b7eaba09` old · favicon `34e4b7f3` built, deploy pending (Earthling)
- **Marketing** (lunafrontdesk.com) — _verify_ · SWA `luna-marketing`

_Sunset is staging-only (no prod client yet); Wolfhouse carries the live prod hostel._
