# SUNSET-TODO — Sunset staff portal (+ Luna)

Running Sunset product TODO (formerly `UI-BACKLOG.md`): UI/UX, functional work, and Luna platform capabilities. Owner brain-dumps; Captain sorts, sizes, sketches, and hands scoped briefs to Skipper; Captain gates + deploys. Testing happens during + after each change (devs manage). Linked from [JOURNEY.md].

**Tags:** `[UI]` layout/visual · `[BUG]` broken behavior · `[FEAT]` new capability · `[LUNA]` chatbot brain/wiring · `[I18N]` translation.
**Size:** S / M / L. **Sketch?** = wants a concept mock before build. **@Earthling** = needs Earthling's call.
_Started 2026-08-03. Last updated 2026-08-14 00:47 UTC by Skipper. Owner brain-dump complete; refine + resequence as we go._

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

## 🐞 Bug Finder pass — 2026-08-14 (Sunset staging, external agent)

_Added by Captain from Bug Finder / Chief of Staff report. Inbox re-verified 14 Aug (redesigned 4-col workspace); Horario/Reservas/Admin items are still-open from the 12 Aug pass, **not** re-verified 14 Aug. No merge, no deploy — triage list only._

### Inbox — NEW (14 Aug, redesigned 4-column workspace)
- **[BUG] P2 — Filter counts don't reconcile:** All 17 ≠ WhatsApp 8 + Email 3 (6 conversations unaccounted). Rail badges vs list query mismatch.
- **[BUG] P2 — People views clip rows + inner horizontal scrollbar** (All people 133; multiselect checkbox overflows).
- **[BUG] P2 — Guest card contradicts thread:** "No linked bookings yet" / BOOKINGS 0 while thread has a confirmed booking (e.g. Simulate Guest / SUNSET-20260714-D12AE3).
- **[BUG] P2 — List timestamp ≠ last message time** (Simulate Guest row "Aug 5", newest in-thread Jul 14) — triage order wrong.
- **[BUG] P2 — Selecting some threads hard-reloads the portal** ("Loading portal…"), drops staff on Horario, can flip locale ES→EN.
- **[BUG] P3 — Changing filter/search silently reselects the first thread** (unrelated guest under a filtered list).
- **[BUG] P3 — Empty states duplicated + generic** ("No guest email…" twice; Needs human 0 still says there are no conversations at all).
- **[BUG] P3 — "Linked bookings" codes look like links but aren't clickable** (no href).
- **[BUG] P3 — Email thread header shows raw internal ID** (`emailv1:sunset-somo:32cb2f9a…`) instead of the guest email.
- **[BUG] P3 — ~1040px: 4-col layout collapses;** thread header can render as "H." / "+_".

### Inbox — STILL OPEN (carried from prior pass)
- **[BUG] P2 — Stale detail pane:** previous thread + guest card persist ~1s after click (wrong-guest action risk). Still repro.
- **[I18N] P2 — Heavy bilingual leakage in new inbox chrome** (rail INBOX/NEEDS YOU/PEOPLE/CHANNEL AUTONOMY, Search contacts, Email broadcast, Generate/Save/Approve & send, guest card CHECKED IN/BOOKINGS/LESSONS/UNPAID BALANCE, mixed ES/EN accordions). After locale toggle, pane can stay in the other language until re-render.
- **[UI] P3 — Destructive Reset Luna session / Full Wipe** now in an unlabeled ⋯ overflow on the live thread toolbar (better than under reply box, still too close). Not clicked.

### Inbox — NOT REPRODUCED this pass (possibly fixed)
- **P1 — Open customer card opens the wrong guest** (Monshies → +dddddddd). Guest binding looked correct on threads opened today.

### Horario / Reservas / Admin — 12 Aug pass, NOT re-verified 14 Aug
**P1**
- **[BUG] Timeline overlap** — "Curso privado" covers "Curso Mañana"; Mañana unclickable (Daily Timeline).
- **[I18N] Raw i18n key on Reservas booking-code control:** `admin.bookings.openInSchedule: SUNSET-…` (ES+EN). ✅ fixed — localized `Open in Schedule` / `Abrir en Agenda` + code on aria-label/title; raw key rejected.
- **[BUG] ~~Booking code opens Horario on today,~~ not the booking's service date.** ✅ Fixed: `schedulePrimeOpenDay` + Reservas wraps `switchToTab` so `loadPortalHome` lands on `service_date_start` (past dates no longer clamped). Gate: `node scripts/verify-sunset-reservas-booking-code-service-date.js`.
- **[BUG] Booking detail drawer opens behind invisible backdrop;** nav blocked until Escape.
- **[BUG] Guest chip "Pagado" while drawer shows €0 of €960 paid** (Gary / SUNSET-20260811-EA783E).
- **[BUG] Monthly Next advances grid but header stays stuck;** can skip a week / land on wrong day.
- **[BUG] Reservas text search ignores active date-range filter** (count can rise, e.g. 17→21).
- **[BUG] Finanzas Day: Pendiente €3,130 > Booked €1,240** for same 3 reservas.
- **[BUG] Finanzas "Next 30 days" / "Delivered, unpaid" ignore selected period.**

**P2**
- **[BUG] Schedule empty-state flash before data loads.**
- **[BUG] Booking drawer says "add a phone"** though list already shows one.
- **[BUG] Guest name in Reservas silently jumps to Inbox/Clientes;** loses context.
- **[I18N] Locale leakage:** Admin (esp. Luna Staff) largely English in ES; Reservas filters Spanish in EN; Bookings table doesn't re-localize until refetch; Horario ES keeps English chrome; course names inconsistently translated.
- **[BUG] Closing booking drawer leaves body `overflow:hidden`** — scroll-locked / blank beige until reload.
- **[BUG] Horario booking drawer ignores Escape** (only ✕ closes).
- **[BUG] Create-booking date "Aplicar" sits under sticky "Crear reserva" footer** (near-miss submit).
- **[BUG] Create booking accepts 99 guests on a 24-seat course;** submit stays enabled when quote fails.
- **[BUG] Create booking phone accepts letters/symbols;** still submittable.
- **[BUG] Expanded Reservas rows inject line-items into table;** raw ISO timestamps; KPI pollution. ~~Fixed: expand is a full-width sibling under `row-block` (not a 7-col grid child); item labels strip ISO/payment junk.~~
- **[BUG] Customer-card linked bookings show raw payment enums** vs localized table. — **fixed** (linked bookings use staff EN/ES payment labels).
- ✅ **[BUG] Clientes Filters popover overflows; Esc doesn't dismiss.** Fixed: fixed-position menu + Esc/outside dismiss + ES filter labels.
- **[BUG] Finanzas Year 2026 totals identical to August 2026** while 12-month chart shows other months.
- **[BUG] Finanzas Custom: Prev/Next arrows dead;** raw ISO + English calendar chrome in ES.
- **[BUG] Luna Staff: "No numbers yet"** while Guest Conversation Alerts have recipients; automations blocked.
- **[BUG] Alert toggles checked/editable with "Disabled on server".**
- **[BUG] Capacity: 132/100 · 100%;** "Alojamiento out 2" with no %.

**P3 / process**
- **[UI] Inbox thread header clipping** (may be improved by redesign — not re-checked).
- **[UI] Precios bare unlabeled × on course cards.**
- **[BUG] Create booking allows past dates.**
- **[BUG] "TODAY'S PREP" on non-today dates;** weekday prefix missing on today.
- **[UI] Reply UI differs by channel with no explanation** (more intentional in new inbox — lower priority).
- **[BUG] Reservas no pagination at 46+ rows;** sort collapses expansion.
- **[UI] No "Crear reserva" CTA inside Reservas.**
- **[UI] Finanzas "—" placeholder product rows;** bilingual product names.
- **[I18N] Precios enums/helpers English inside ES admin.**
- **[BUG] Delete conversation × on thread hover (old)** — confirm if still present in new list.
- **[BUG] Exportar CSV enabled at 0 results** — not clicked.
- **[UI] Luna Staff header styles look instant-apply** — not clicked.

## 🌐 Language audit — Inbox (Bandeja de entrada) — 2026-08-14 (EN/ES)

_Added by Captain from Luna Language / Chief of Staff audit. Sunset staging, redesigned inbox, read-only (17 conversations, one WhatsApp thread opened, no send). Nothing changed in production copy. Priorities HIGH/MED/LOW per audit. Provided ES/EN fixes inline._

**Re-check of prior inbox items**
- **#7 (mixed ES inbox chrome) — STILL PRESENT**, now worse: the whole left rail is English in ES. Empty state + loading still mixed.
- **#8 (detail pane untranslated in ES) — PARTLY FIXED.** Reply composer now ES ("Respuesta:", "Escribe una respuesta…", "Enviar respuesta", "Avisar"). Still broken: right-rail labels, Luna Auto/Off, Channel Autonomy.

### HIGH
- **[I18N] Left rail entirely English in ES** (nav itself says "Bandeja de entrada"): INBOX, All, WhatsApp, Email, NEEDS YOU, Needs human, PEOPLE, All people, Checked in, Hot leads, Warm leads, Unpaid, Waiver due, Lesson today, Upcoming, Do not contact.
  - Fix ES: BANDEJA / Todas / WhatsApp / Email / TE NECESITAN / Requiere personal / PERSONAS / Todas las personas / Con check-in / Clientes potenciales calientes / Clientes potenciales templados / Sin pagar / Waiver pendiente / Clase hoy / Próximas / No contactar.
- **[I18N] Right-rail customer card English in ES:** CHECKED IN, BOOKINGS, LESSONS, UNPAID BALANCE, WAIVER STATUS, LAST SETUP, Linked bookings; values "No", "9 due", "21 lessons, 25 addon service" (mixed with translated TELÉFONO / ESCUELA ACTIVA).
  - Fix ES: CON CHECK-IN / RESERVAS / CLASES / SALDO PENDIENTE / ESTADO DEL WAIVER ("9 pendientes") / ÚLTIMA CONFIGURACIÓN ("21 clases, 25 servicios adicionales") / Reservas vinculadas.
- **[I18N] "NOTES FOR NEXT TIME" stays English in ES** while value is "Sin notas aún" (mixed in one row). Fix ES: NOTAS PARA LA PRÓXIMA VEZ.
- **[I18N] NEW — Spanish leftovers in EN mode** (tooltips/chrome from Inbox): "Reserva del staff", "Ocupación 3 de 24", "Día 2 de 8", "Duración del alquiler", "Cant.", "Curso Mañana 10:00–12:00", plus Channel Autonomy helpers still Spanish ("Luna prepara borradores…", "La automatización de WhatsApp está en pausa.").
  - Fix EN: Staff booking / Occupancy 3 of 24 / Day 2 of 8 / Rental duration / Qty / Morning course 10:00–12:00 / "Luna drafts WhatsApp replies for staff approval. It does not send." / "WhatsApp automation is paused." / "Luna drafts email replies for staff approval. Email is never sent automatically." / "Luna will not draft email replies."

### MED
- **[I18N] "Loading conversations…" and "Loading…" in ES.** Fix: Cargando conversaciones… / Cargando…
- **[I18N] Empty state mixed:** ES "Aún no hay conversaciones." + EN "Guest emails and WhatsApp for Sunset will appear here when they arrive." Fix ES body: Los emails y mensajes de WhatsApp de huéspedes de Sunset aparecerán aquí cuando lleguen.
- **[I18N] Search placeholder "Search contacts" untranslated in ES** (a second search IS localized). Fix ES: Buscar contactos.
- **[I18N] Channel Autonomy card English in ES:** CHANNEL AUTONOMY, Draft, Auto, Global Pause, Off, On. Fix ES: AUTONOMÍA POR CANAL / Borrador / Automático / Pausa global / Desactivada / Activada.
- **[I18N] Thread header still English in ES:** "Luna: Auto", Auto, Off (only "Avisar" translated). Fix ES: Luna: automático / Automático / Desactivada. Prefer "Requiere personal" over "Avisar".
- **[I18N] List timestamps not localized in ES:** "24m ago", "13h ago", "Aug 11", "Jul 31". Fix ES: hace 24 min / hace 13 h / 11 ago / 31 jul.
- **[I18N] Untranslated tooltips/aria in ES:** Delete conversation, Back, Reply channel, Inbox view, Saved views, WhatsApp/Email autonomy, Global Pause, Account, School, Language, Menu, Schedule/Open schedule, Refresh.
  - Fix ES: Eliminar conversación / Volver / Canal de respuesta / Vista de la bandeja / Vistas guardadas / Autonomía de WhatsApp / Autonomía de email / Pausa global / Cuenta / Escuela / Idioma / Menú / Horario / Abrir horario / Actualizar.
- **[I18N] PEOPLE filter tooltips mixed in ES.** English leftovers: "Contacted but never booked", "Customers who have booked before", "Marked do not contact". Fix ES: Contactado pero nunca reservó / Clientes que ya han reservado / Marcado como no contactar.
- **[I18N] Layout toggle:** EN "Full / Chat / Guest"; ES "Las cuatro / Chat / Huésped" ("Las cuatro" is opaque). Fix ES: Completa / Chat / Huésped.

### LOW
- **[I18N] Reply composer FIXED in ES** (Respuesta: / Escribe una respuesta… / Enviar respuesta). "Create booking for this guest" now "Crear reserva"; tags localized. Optional: "Crear reserva para este huésped".
- **[I18N] Testing-tools strings English in both modes** (Delete Hermes state.db…, Full wipe…). Hide in production or translate; ES "Herramientas de prueba".
- **[I18N] Sidebar title "INBOX" never localizes** (nav already says Bandeja de entrada). Fix ES: Bandeja de entrada.

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
  - **Gmail G3 authority composition COMPLETE (2026-08-12):** PR #482 approved at `684b4305…`, merged as `25d4f353…`. The genuine OIDC verifier now binds signature, audience, nonce, token and clock before one-shot Gmail `users/me/profile`; exact case-sensitive profile matching returns frozen sanitized authority with activation still false. Gates: composition 14/14, profile 15/15, identity 15/15, JWKS 26/26, custody/exchange and adjacent gates green. **No route, DB binding, mailbox activation, deployment, or live Google call was added.**
  - **Handoff / do not disturb:** do not replace, bypass, casually refactor, or directly wire the merged identity/custody/profile/authority owners; do not enable email flags or add provider calls. Any change to those owners needs its own RED, exact-head review, and clean PR.
  - **Exact resume order:** (1) build inert runtime assembly; (2) add exact Sunset ACL Staff start/callback routes while default-off; (3) run source acceptance; (4) build Gmail inbound/outbound owners; (5) build generic IMAP/SMTP owners; (6) separately approve staging activation.
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
- **Inbox i18n Batch A** (PR #568, master `0014fe7a`): static Sunset Inbox/admin copy translated and normalized, including `Bandeja de entrada`, `Buscar contactos`, `Requiere personal`, `CONTROL DE CANALES`, `Borrador`, `Pausa global`, `CLASES`, `SALDO PENDIENTE`, and `Abrir en Agenda`; English preserved as `CHANNEL AUTONOMY`, `Lessons`, and `Unpaid balance`. Deployed to Sunset staging revision `luna-sunset-staging-staff-api--0000593` using image `luna-sunset-staff-api:0014fe7a…` (digest `sha256:958ec19d…`), 100% traffic, health/ready 200. Tenant-only authenticated verifier found all 16 required EN/ES markers, then logged out and proved the session revoked (401). Static copy only; no booking/customer/payment/routing data mutation.
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
