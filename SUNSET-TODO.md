# SUNSET-TODO — Sunset staff portal (+ Luna)

Running Sunset product TODO (formerly `UI-BACKLOG.md`): UI/UX, functional work, and Luna platform capabilities. Owner brain-dumps; Captain sorts, sizes, sketches, and hands scoped briefs to Skipper; Captain gates + deploys. Testing happens during + after each change (devs manage). Linked from [JOURNEY.md].

**Tags:** `[UI]` layout/visual · `[BUG]` broken behavior · `[FEAT]` new capability · `[LUNA]` chatbot brain/wiring · `[I18N]` translation.
**Size:** S / M / L. **Sketch?** = wants a concept mock before build. **@Earthling** = needs Earthling's call.
_Started 2026-08-03. Last updated 2026-08-11 22:10 UTC by Skipper. Owner brain-dump complete; refine + resequence as we go._

---

## ✅ Sea Dog + Skipper were down — RESOLVED (Captain, 2026-08-12 ~06:00 UTC)
- **[BUG] Seadog & Skipper threw `PermissionError` on `/opt/wolfhouse/WH/.git`.** Real cause was **not** group membership (my earlier 05:00 diagnosis was wrong — do **not** touch `.git` perms/ACLs or the `wolfhouse-dev` group). The repo is bind-mounted **read-only** into every Hermes container by design (anti-clobber), and both agents' `terminal.cwd` pointed at that ro mount, so any git write (fetch/index/commit) failed. Deckhand worked because its cwd is a writable clone under `/opt/data`. **Fix (live):** gave each a writable clone at `/opt/data/workspace/sandbox-repos/WH-<role>` and repointed `terminal.cwd` there in `docker/hermes-staging/99z-wh-vm-post-bootstrap.sh` (+ a guarded self-heal that re-seeds on a fresh volume), then restarted both. Both verified healthy + writable. **⚠️ Durability:** the bootstrap fix is live from the host working tree but **not yet committed** (that file carries unrelated uncommitted changes) — commit it so a branch switch/reset can't wipe the fleet cwd config.

## ❓ Open questions (answered)
- **"− N +" control** → the **quantity stepper**.
- **Historical booking log placement/name** → recommended name **"Bookings"** (Schedule stays the calendar view; Bookings = searchable master list). Alts: "Records" / "Booking Log". Feeds both ops (find any booking) and Finance (refund home). **(Update 08-06: Bookings promoted to a top-level tab — see T1.)**
- **Moving a tab** → easy (nav entry + panel); real work is the panel content.

## ▶️ Recommended next (sequencing)
1. ✅ **SHIPPED (revs 0458–0473):** Bookings/Cockpit polish, Finance S2, D4, Inbox toggle, F2, A1, F1, F3, Finance-UI cleanup/revisions/polish v2, cancel/hide v2 (+ migration 060), Bookings tab v2, rental-editor v1+v5, **A2 course-cards** (revs 0469–0470), **Bookings tab edits + Restore** (0471), **finance fail-soft + clickable codes + cancelled-Type + shared item-name resolver** (0472), **schedule guest-collapse rule** (0473). Email **2F-C2** runtime-composition factory integrated to master (`1b6fa65b`, default-off, **not deployed**).
2. **Remaining:** **T1** tab restructure (4 tabs: Schedule·Inbox·Bookings·Admin) + **R1** roles, **A3** (beaches de-hardcode + Luna wire — *important*), Cockpit **C1** (selector placement — needs design), **B1** (booking-click 503 + jump-to-day), **L2** (Luna offers disabled rentals — @Earthling), Luna wiring **W1–W4** (@Earthling), then **Mobile** last.
3. **OPEN — finance money-truth:** booking `c713c1d7` (€35 total / €20 balance / no captured payment) needs correcting once owner says whether €15 was paid or €35 owed.
3. **Mobile — LAST.**
4. **L3 email 2F-C** resumes only when Earthling has Azure access; parked with runtime OFF.
5. **Mobile LAST** — after the main-site UI settles (we're still adding/removing buttons; no point chasing a moving target).

---

## 🗂️ Tabs & navigation (restructure) — owner 2026-08-06
- **T1 — [UI][FEAT] Collapse to 4 top-level tabs: Schedule · Inbox · Bookings · Admin.** `M–L`
  - **Schedule** — unchanged.
  - **Inbox** — **merge Customers into Inbox** (Customers stops being its own tab; its content lives inside Inbox).
  - **Bookings** — promote to its own top-level tab (currently a sub-tab under Admin); this is the **only** thing that leaves Admin.
  - **Admin** — **Finance stays in Admin** (unchanged), along with Pricing + Luna Staff; only Bookings is removed (promoted).
  - Gated by **R1** roles (Admin tab visibility). Depends on nothing else; mostly nav wiring + moving panel content.
- **B1 — [BUG] Booking click: schedule 503 + no jump-to-day.** From Bookings/admin, clicking a recent booking opens the drawer but the schedule behind fails **"Could not load schedule. HTTP 503"**, and it should also navigate to the **day the booking starts** (drawer opened on the wrong day). Repro on `SUNSET-20260804-1497D`. Overlaps the shipped "clickable codes → Schedule day + drawer" (rev 0472) — investigate why it 503s / lands wrong. `M`

## 🔐 Access & roles
- **R1 — [FEAT] Two user classes: Staff vs Admin/Owner.** Only **Admin/Owner** sees the **Admin** tab (Staff can't). User/credential creation is managed in **Crowsnest** (not in the portal). Gates T1's Admin tab. **@Earthling** (Crowsnest side). `L`

## 🧠 Luna (brain / behavior)
- **L1 — Personality/voice.** Luna needs a defined personality. **@Earthling.** `L`
- **L2 — [BUG] Disabled rental still offered.** Turning a rental OFF in Admin doesn't stop Luna offering it; she must respect the enabled/active flag. `M`
- **L3 — [FEAT] Email capabilities for Luna.** Give Luna the ability to send/handle email (not just WhatsApp). **@Earthling + Skipper — in progress (foundation on master, email OFF).** `L`
  - **PAUSED SAFE (2026-08-11) — Gmail G3 ~90%:** OAuth callback/transaction completion and fixed one-shot Gmail `users/me/profile` evidence are merged. Latest checkpoint is PR #479, approved `fe63d368…`, merged as `6ff4e054…`; profile request 15/15 plus mailbox-authority/token/JWKS gates green. **No route, DB binding, mailbox activation, deployment, or live Google call was added.**
  - **Handoff / do not disturb:** do not replace, bypass, casually refactor, or directly wire the merged custody/transport owners; do not enable email flags or add provider calls. Any change to those owners needs its own RED, exact-head review, and clean PR. The current pause is intentional while Monshies works on other site tasks.
  - **Exact resume order:** (1) compose verified OIDC identity + Gmail profile evidence through the existing pure mailbox-authority contract; (2) build inert runtime assembly; (3) add exact Sunset ACL Staff start/callback routes while default-off; (4) run source acceptance; (5) build IMAP/SMTP owners; (6) separately approve staging activation.
  - **2F-C done + 2F-C2 integrated:** KEK created in `luna-sunset-staging-kv` (`luna-email-grant-kek/fde9704b…`) + Sunset identity granted Crypto User; default-off runtime-composition factory on master (`1b6fa65b`), **not deployed**. Next: Azure pre-deploy gate → deploy → staging wrap/unwrap custody proof → refresh-exchange/OAuth callback → separately-approved activation. Nothing on until each gate passes.
  - **Shipped foundation:** delegated endpoint/OAuth contracts, Graph adapter/readiness, encrypted grant custody (2F-A, PR #352), and Standard Key Vault RSA envelope provider (2F-B, PR #353).
  - **WAITING — 2F-C Azure boundary:** step-by-step runbook at **[EARTHLING-2F-C-AZURE-RUNBOOK.md]** — create/version-pin the RSA wrapping key in `wh-staging-kv`, grant the Sunset identity (`5338388f…`) Crypto User, paste the versioned key ID back; Captain then wires config + runs the staging wrap/unwrap proof.
  - **Still OFF / later:** SDK managed-identity composition, refresh exchange, OAuth callback installation, routes, mailbox activation, deployment, and guest email behavior.
  - **Safety:** raw refresh tokens never enter PostgreSQL; no production A256KW/Managed HSM; no activation until live staging custody proof and later gates pass.

## 🔌 Luna wiring & de-hardcode (audit)
- **W1 — [FEAT][LUNA] Wire Luna for every relevant setting.** Standing initiative; beaches (A3) is case #1.
  - **Pre (not started):** Captain audits every Admin setting → maps which Luna reads vs ignores, with a wire/skip recommendation per setting. This produces the concrete checklist the wiring work runs off. _(deferred — not tonight)_ `L` (ongoing)
- **W2 — Age range de-hardcode?** Currently hardcoded; maybe it shouldn't be. **@Earthling** to decide. `M`
- **W3 — Frequency de-hardcode?** Currently hardcoded; maybe it shouldn't be. **@Earthling** to decide. `M`
- **W4 — [I18N] Custom course names translated everywhere.** Course names are custom but must be translated across menus, cockpit, Luna — everywhere they appear. **@Earthling.** `M–L`

## 🧾 Create / Edit booking drawer
- **D5 — [BUG] Create booking as Paid updates the bubble but not payment truth.** When staff creates a booking and sets it to **Paid**, the booking shows the correct Paid status bubble, but the invoice still treats it as unpaid and the Finance tab does not include the collection. Fix the write path so **Paid on create records the canonical payment/collection ledger state** consumed consistently by booking balance, invoice, Bookings, and Finance; do not solve this with display-only status inference. Add a real create→invoice→Finance regression, including amount/date attribution and protection against duplicate collection records. `M–L` · **high priority**
- ✅ **D4 (shipped) — [BUG] Group Course on, none picked → rentals unpriced.** If "Group Course" is toggled but no actual course is selected, rentals show no estimate → booking can't complete. Fix: let standalone rentals price without a course, OR block submit until a real course is chosen. `M`

## 📅 Schedule tab
- **S1 — Rental pickups (by-guest) redundant tags.** Staff/Paid/Unpaid/Waiver repeat on every *item* row; keep them only next to the *guest*, items stay clean. _(concept already sketched)_ `S–M`

## 🖥️ Cockpit
- **C1 — Selector placement.** Daily/Monthly + Timeline/Cards selectors control a whole panel underneath them, so they're misplaced; need repositioning + some redesign (no obvious home right now). `M` · sketch?

## 💶 Finance tab
- ✅ **F1 (shipped) — "This month" quick jump.** Month switcher up top needs a fast way back to the current month. `S`
- ✅ **F2 (shipped) — [FEAT] Revenue-by-product hardcoded.** Remove hardcoded "board rental / wetsuit rental"; show the same items as the Cockpit right side: course-included item(s) + the 2 next most-rented items for the selected period (driven by the day/month/year filter). `M`
- ✅ **F3 (shipped) — [FEAT] Gross-vs-last-year view toggle.** The "daily gross collected vs last year" chart needs a switch between the current month's days (now) and a yearly 12-months view. `M`

## 🛠️ Admin panel (courses / config)
- ✅ **A1 (shipped) — Group courses sorted by name → by time.** The created group-courses list orders alphabetically; sort by the time each course runs (earliest → latest). `S`
- ✅ **A2 (shipped, revs 0469–0470) — [UI] Reformat Group & Private course panels.** Private: closed 2a full-width columns + one-row edit, neutral site colors. Group: Option 3 (meta rows + equipment-under-meta + two-column price). Shared equipment editor: equal During/All-day widths, `×` inline, `+` beside `×`. _Owner has minor tweaks tomorrow (proportions/one-row polish)._ `M`
- **A3 — [FEAT][LUNA] Beaches: de-hardcode + custom + wire.** *(important)* On create/edit group course, beaches are hardcoded — delete them and add a **"+ add beach"** so admin defines their own; also **wire Luna** to pick them up (she doesn't today). First case of W1. `M`

## ✅ Recently shipped from this TODO
- **Schedule guest-collapse rule** (rev 0473): cards mode shows course guests by default; timeline collapses a course's guests only when no all-day course gear AND ≥1h past end (people keep equipment). `2b25d077`.
- **Finance fail-soft + item-name audit** (rev 0472): one stale-balance/malformed row no longer 503s the whole finance tab (flagged in `data_quality`, still renders); clickable booking codes → Schedule day + drawer; cancelled/hidden show Type; shared `item-display-name` resolver (rentals by catalog key, accommodation package name) across bookings/drawer/invoices/Luna. `820d4ec7`. Audit map `docs/BOOKINGS-FINANCE-LABEL-AUDIT-MAP.md`.
- **Bookings tab edits + Restore** (rev 0471): Type→plain text (+ server accommodation categories), refund section hidden unless cancelled/refunded, Restore on cancelled rows (Bookings + schedule drawer), Created column sorting `created_at`, centered status chips. `7bdbcacf`.
- **A2 course-card redesign + polish** (revs 0469–0470): Private closed **2a** full-width columns + **one-row edit** (Notes under), Group **Option 3** (meta rows + equipment-under-meta + two-column price), **neutral site colors** (dropped blue/purple/green), and shared equipment editor (equal During/All-day widths, `×` inline, `+` beside `×`); `0ac9c499` + `068c8874`. Live-verified on authed page. Owner has minor tweaks tomorrow.
- **Cancel/hide v2** (no Deleted; Hidden filter/tag/Unhide; Refund-needed gating), **Finance UI cleanup + revisions + polish v2** (title removed, Custom floating calendar, Accommodation, equal cards, Jan→Dec monthly graph, capacity ring), **Bookings tab v2** (sortable cols, What→Type Rentals/Lessons/Accommodation, aligned/slimmer cols, darker chips), and the **rental-editor layout** v1+v5 — all live, revs 0461–0468.
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
