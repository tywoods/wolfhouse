# Sunset Staff Portal — v1 Build Plan (post-demo cleanup)

**Status:** DRAFT — planning only; **no code, deploy, seed, or production changes in this doc**  
**Date:** 2026-06-19  
**Branch target:** `master` (Sunset Slice 1 merged)  
**Staging URL:** https://sunset-staging.lunafrontdesk.com  
**Parent docs:** `SUNSET-PORTAL-SLICE-1-IMPLEMENTATION-PLAN.md`, `SUNSET-PORTAL-SLICE-1-STAGING-DEPLOY-PLAN.md`, `LUNA-SUNSET-OVERVIEW.md`, `MULTI-TENANT-PLAN.md`

---

## Approval gate

**Do not start Staff Portal v1 implementation until:**

1. Captain approves this plan.
2. **Demo cleanup** has run (`sunset-portal-slice1-cleanup.js --execute`) and staging DB shows zero `sunset_demo_slice1` rows.
3. Wolfhouse `/staff/ui` regression smoke is documented green (standing post-merge condition).

**Still forbidden without separate approval:** production deploy, Wolfhouse staging changes, live Stripe/WhatsApp, Luna SOUL edits, new migrations (unless a later slice is explicitly approved).

---

## Captain recommendation (build order)

After demo cleanup, build in this order:

1. **Portal labels / navigation cleanup** — make Sunset feel like Sunset, not a hidden Wolfhouse portal
2. **Day Schedule real UI**
3. **Inbox / conversation polish**
4. **Surf booking / service drawer**
5. **Staff actions / status updates**
6. **Email channel preparation**

**First implementation slice:** **Slice 2A** — clean navigation, labels, and surf vocabulary before adding booking actions.

---

## 1. Current state

### What Sunset portal can do today (Slice 1 + staging)

| Capability | Status | Notes |
|------------|--------|-------|
| Sunset-only login | ✅ | `staff-portal-access.sunset-staging.json` baked into `luna-sunset-staff-api` image |
| Client list | ✅ | Session returns `clients: [sunset]` only |
| Default tab | ✅ | `conversations` (WhatsApp inbox) |
| Hidden main tabs | ✅ | `bed-calendar`, `tour-operator` via `loadClientPortalProfile()` |
| Day Schedule tab | ✅ read-only | Visible for `surf_school_rentals` vertical only |
| Day Schedule — DB rows | ✅ read-only | `GET /staff/query?intent=services.lessons_today` and `services.gear_today` |
| Day Schedule — demo slots | ✅ config-only | `portal_demo.lesson_slots` in `sunset.baseline.json` (not DB) |
| Conversations inbox | ✅ read-only | `GET /staff/conversations?client=sunset` + messages/context |
| Handoff visibility | ✅ read-only | Inbox shows `handoff_reason` / status from `staff_handoffs` |
| Luna Staff tab | ✅ | Ask Luna operations chips (read-only for Sunset) |
| Staff actions (writes) | ❌ | No status updates, no manual booking, no payment links |
| Surf booking drawer | ❌ | Bed-calendar drawer exists in codebase but tab is hidden; not Sunset-polished |
| Email channel | ❌ | WhatsApp only in schema and UI |
| Settings / admin | ❌ | No Sunset-specific settings surface |

**Runtime files:** `scripts/staff-query-api.js`, `scripts/lib/staff-portal-clients.js`, `scripts/lib/staff-portal-i18n.js`, `config/clients/sunset.baseline.json`.

**Offline verifiers:** `verify:sunset-all`, `verify:sunset-portal-slice1`, `verify:sunset-portal-slice1-seed-runner`, `verify:sunset-staging-staff-user`.

### What is demo-only (remove before v1 build)

| Item | Tag / source | Cleanup |
|------|--------------|---------|
| Seeded conversations (2) | `metadata.source = sunset_demo_slice1` | `sunset-portal-slice1-cleanup.js --execute` |
| Seeded messages (8) | same | same |
| Seeded bookings (3) | `SUNSET-DEMO-001..003` | same |
| Seeded service records (4) | same | same |
| Seeded staff handoff (1) | same | same |
| Config lesson slot tiles | `portal_demo.lesson_slots` | **Keep for now** — replace with real capacity model in a later slice |
| `portal_demo.demo_mode: true` | baseline config | Flip to `false` when real ops data exists |
| Unverified seed prices | `pricing_status: unverified_seed` | Replace with confirmed pricing workflow later |

**Prerequisite:** Run approved cleanup on `sunset_staging` only. Do **not** delete the Sunset `staff_users` row or `clients.slug=sunset`.

### What is missing for real operations

| Gap | Impact |
|-----|--------|
| Surf-native navigation labels | Staff still see Wolfhouse lodging copy in drawer, empty states, and some i18n keys |
| Dedicated Rentals / Lessons views | Day Schedule is the only schedule surface; no filtered list or week view |
| Booking/service drawer for surf | Existing drawer is bed-calendar-centric (move bed, rooming, transfers) |
| Status updates | Cannot mark rental out/returned, lesson checked-in, or service cancelled |
| Real lesson capacity | Demo slots are config fiction; no DB `lesson_slots` or instructor roster |
| Rental inventory | No stock table, sizes, or “out / due back” lifecycle |
| Payment actions | Read `payment_status` only; no staff-triggered links (may stay read-only in v1) |
| Email inbox | Schema supports channel field; no email ingest or UI |
| `hidden_drawer_tabs` wiring | Profile returns `['transfers']` but UI still renders transfers tab if drawer opened |
| Production-ready egress | Consumption CAE egress IP not stable for DB auth |
| Confirmed pricing | All catalog prices still `unverified_seed` |

---

## 2. Staff workflows (plain English)

Core employee workflows Staff Portal v1 should support (progressively across slices):

### Daily operations (read-first, then write)

1. **Check guest inbox** — Open the portal, land on Conversations, see who messaged today and whether Luna or a human should respond.
2. **Review Luna conversations** — Open a thread, read guest/Luna messages, see conversation stage and whether Luna is paused.
3. **See today’s lessons** — Open Day Schedule (or Lessons tab in v1 nav), pick today’s date, see lesson rows with guest name, quantity, time slot, status.
4. **See today’s rentals** — Same date picker; see boards/wetsuits out today and due back.
5. **Mark rental/lesson status** — *(Slice 2E)* Update service status (e.g. confirmed → checked_in → returned) without using bed-calendar concepts.
6. **Open a customer/booking drawer** — *(Slice 2D)* Click a schedule or inbox row to open a surf booking drawer: guest contact, services, notes, payment summary — **no room/bed UI**.
7. **Handle handoff/escalation** — See handoff flag in inbox; open thread; mark needs-human or resolve handoff (existing routes partially support this).
8. **See payment status** — View pending/paid/not_requested per service; **no live Stripe link generation in v1 unless separately approved**.
9. **Avoid Wolfhouse lodging concepts** — Staff never see room codes, bed moves, tour-operator blocks, or transfer shuttles unless deliberately reworked for surf.

### Out of scope for v1

- Accommodation partner queue (manifest existed; no DB/API)
- Inventory purchasing or maintenance
- Instructor payroll
- Multi-location tenants

---

## 3. Portal navigation (v1 proposal)

### Main tabs — Sunset v1

| Tab ID | Label (EN) | Slice | Purpose |
|--------|------------|-------|---------|
| `conversations` | **Inbox** (rename from “WhatsApp”) | 2A/2C | Primary guest messaging; channel badge WhatsApp now, email later |
| `day-schedule` | **Day Schedule** | 2B | Date picker + combined lessons/rentals for selected day |
| `rentals` | **Rentals** *(optional v1.1)* | 2B+ | Filtered gear/board list; can defer and keep Day Schedule gear table only |
| `lessons` | **Lessons** *(optional v1.1)* | 2B+ | Filtered lesson list; can defer and keep Day Schedule lessons table only |
| `customers` | **Customers** or **Bookings** | 2D | Searchable list of bookings/service records by guest, phone, booking code |
| `ask-luna` | **Luna Staff** | unchanged | Internal ops assistant |
| `settings` | **Settings** | 2F+ | Only if needed: profile, notification prefs, demo_mode off — **defer unless required** |

**v1 minimum nav (Captain-aligned):** Inbox + Day Schedule + Luna Staff. Add Customers/Bookings when drawer slice lands. Split Rentals/Lessons into separate tabs only if Day Schedule feels crowded in QA.

### Explicitly hidden (all slices unless Captain reopens)

| Hidden | Reason |
|--------|--------|
| `bed-calendar` | Lodging grid; wrong mental model for surf school |
| `tour-operator` | Wolfhouse tour blocks |
| Lodging room views | Rooming, bed labels, move-bed drawer cards |
| `transfers` drawer tab | Shuttle/transfer workflow is Wolfhouse-specific; hide via `hidden_drawer_tabs` |
| Developer tabs | `query-tools`, `luna-guest-simulator` — role-gated, not operator-facing |

### Copy / branding (Slice 2A)

- Product name: **Luna Front Desk** / **Staff Portal** (not Cami dashboard).
- Replace lodging strings in Sunset context: “Booking Calendar” → hidden; “move bed” → never shown; “room” → never shown.
- Surf vocabulary: **lesson**, **rental**, **gear**, **board**, **wetsuit**, **guest**, **booking code**.

---

## 4. Data model gap analysis

### Reusable today (no migration required for read paths)

| Table / concept | Reuse for Sunset v1 | Existing routes / queries |
|-----------------|---------------------|---------------------------|
| `clients` | Tenant row `slug=sunset` | Session, all `client=` params |
| `conversations` | WhatsApp inbox | `GET /staff/conversations`, `…/messages`, `…/context` |
| `messages` | Thread history | `GET /staff/conversations/:id/messages` |
| `bookings` | Guest booking header | `booking_code`, `guest_name`, `phone`, `metadata`; created by future manual booking or integrations |
| `booking_service_records` | Lessons + rentals | `services.lessons_today`, `services.gear_today`; `service_type IN ('surf_lesson','surfboard','wetsuit')` |
| `staff_handoffs` | Escalation queue | Inbox handoff fields; `GET /staff/inbox/handoffs` |
| `staff_users` | Auth | `staff_users` + client scope in metadata |
| `client_profiles` (config) | Tab gating, demo slots | `sunset.baseline.json` → `portal_demo`, `_meta.vertical` |
| `payments` | Read payment status | Joined in booking context; **do not create Stripe links in v1 without approval** |

**Existing write routes (Wolfhouse-oriented — gate carefully for Sunset):**

- `PATCH /staff/bookings/:id/services/:record_id/date` — date only today
- `POST /staff/conversations/:id/needs-human` — handoff toggle
- `POST /staff/inbox/send-reply` — staff reply (WhatsApp path; staging dry-run policies apply)

### Likely new fields / tables (later slices — plan, do not build yet)

| Need | Candidate approach | Earliest slice |
|------|-------------------|----------------|
| Rental inventory / stock | `rental_inventory` or extend `booking_service_records.metadata` with `asset_tag`, `size` | Post-v1 |
| Rental return status | `service_status` enum extension or metadata `returned_at` | 2E |
| Lesson capacity | `lesson_slots` table or external calendar sync | Post-v1 |
| Instructor assignment | `instructor_id` on service records or slot table | Post-v1 |
| Equipment size/condition | metadata JSON on service records | 2D/2E |
| Email channel | `conversations.channel='email'`, message ingest worker | 2F |
| Payment metadata | Existing `payments` + Stripe IDs in metadata; read-only in v1 | 2D |
| Customer search index | Query bookings by phone/name — may use existing indexes | 2D |

**No new migrations in Slice 2A–2C.** Reuse `booking_service_records` and metadata JSON for surf-specific labels until capacity/inventory requires schema.

---

## 5. Day Schedule v1

### Purpose

Single operational view: “What is happening on this date?” for lessons and rentals.

### UI elements

| Element | Source | Slice |
|---------|--------|-------|
| Date picker | Client-side; default today (tenant TZ from config) | 2B |
| Lesson cards/table | `intent=services.lessons_today` | 2B |
| Rental cards/table | `intent=services.gear_today` | 2B |
| Demo lesson slot tiles | `profile.lesson_slots_demo` filtered by date | 2B (label as “scheduled capacity” until real slots) |
| Service type | `service_type` + `metadata.offering_label` | 2B |
| Guest name / contact | `guest_name`, booking `phone` | 2B |
| Quantity | `quantity` | 2B |
| Status | `service_status` | 2B read; 2E write |
| Notes | `metadata.note` or `notes` column | 2B |
| Handoff flag | Join conversation by phone/booking if linked | 2C+ |
| Payment status | `payment_status` | 2B |
| Row click → drawer | Opens surf booking drawer | 2D |

### Read-only banner

Keep **“View only”** pill until Slice 2E enables status updates. Remove banner when writes are gated and tested.

### Empty states

- No rows: “No lessons/rentals for this date” (not “no beds”).
- Post-cleanup: expect empty schedule until real bookings exist or approved non-demo seed.

---

## 6. Inbox v1

### Purpose

Primary front-desk queue for guest communication.

### v1 scope (WhatsApp)

| Element | Source |
|---------|--------|
| Conversation list | `GET /staff/conversations?client=sunset` |
| Guest / contact | `guest_name`, `phone` |
| Last message preview | `last_message_preview` |
| Luna / staff status | `bot_mode`, `needs_human`, `luna_paused` |
| Handoff reason | `handoff_reason`, `handoff_status`, `handoff_priority` |
| Conversation stage | `conversation_stage` |
| Quick open | Click row → thread + context panel |
| Thread messages | `GET /staff/conversations/:id/messages` |
| Staff reply | `POST /staff/inbox/send-reply` *(staging policy: dry-run / approval gates)* |

### Later (Slice 2F — email)

- `channel=email` in conversations
- Unified inbox with channel badge
- No implementation in v1 until ingest pipeline approved

### Polish (Slice 2C)

- Rename tab **Inbox** (subtitle: WhatsApp · Email coming soon)
- Sunset empty state copy
- Handoff badge styling consistent with Day Schedule
- Hide Wolfhouse-specific inbox filters

---

## 7. Auth / access

### Keep (non-negotiable)

| Rule | Implementation |
|------|----------------|
| Sunset-only staff users | `client_access` map — **no** `all_clients_emails` on Sunset image |
| No Wolfhouse in dropdown | `getAccessibleClients()` returns sunset only |
| No Wolfhouse data leakage | API `assertStaffClientAccess(user, 'sunset')`; DB queries scoped by `client_id` / `client_slug` |
| Isolated staging image | `Dockerfile.luna-sunset-staff-api` copies `staff-portal-access.sunset-staging.json` |
| Wolfhouse staging unchanged | `wh-staging-staff-api` keeps its own access file and image tag |

### Production access (future)

- Separate Sunset production image or env-specific access file.
- Do not reuse Wolfhouse `all_clients_emails` shortcut for Sunset operators.

---

## 8. Verification plan

### Per-slice offline (CI-safe)

| Script | Asserts |
|--------|---------|
| `npm run verify:sunset-all` | Full Sunset offline suite |
| `npm run verify:sunset-portal-slice1` | Wolfhouse profile unchanged; Sunset gating |
| `npm run verify:sunset-portal-slice1-seed-runner` | Seed/cleanup guards (if seed scripts touched) |
| `npm run verify:sunset-staging-staff-user` | Staff user script guards |
| **New:** `verify:sunset-portal-v1` *(add in 2A)* | Nav labels, hidden tabs, no lodging strings in Sunset profile paths |

### Wolfhouse regression (mandatory before any shared Staff API production deploy)

| Check | Method |
|-------|--------|
| Portal loads | `GET https://staff-staging.lunafrontdesk.com/staff/ui` → 200 |
| Default tab bed calendar | Authenticated session `client_profiles.wolfhouse-somo.default_tab === 'bed-calendar'` |
| Bed-calendar visible | Tab not in `hidden_tabs` |
| Tour-operator visible | Tab not hidden |
| No Sunset demo data | DB counts `wolfhouse-somo` + `sunset_demo_slice1` = 0 |
| No Sunset override leakage | Wolfhouse image does not include `staff-portal-access.sunset-staging.json` |

### Sunset staging smoke (after each slice)

| Check | Method |
|-------|--------|
| Login | `POST /staff/auth/login` |
| Session scope | `clients: ['sunset']` only |
| Default tab | `conversations` / Inbox |
| Hidden tabs | bed-calendar, tour-operator absent from DOM |
| Day Schedule API | `services.lessons_today` + `services.gear_today` for chosen date |
| Conversations API | List + messages for live (non-demo) data |
| Zero Wolfhouse rows | SQL counts on `wolfhouse-somo` tables = 0 |
| Browser smoke | Manual or Playwright: nav, Day Schedule, Inbox thread open |

---

## 9. Implementation slices

### Prerequisite — Demo cleanup (Ops, not a code slice)

```bash
# Approved execute only on sunset_staging
ALLOW_SUNSET_DEMO_SEED=1 SUNSET_DEMO_SEED_STAGING_DB_ALLOW=1 \
  node scripts/fixtures/sunset-portal-slice1-cleanup.js --execute
```

Verify zero tagged rows; staff user remains.

---

### Slice 2A — Portal labels / navigation cleanup *(first build slice)*

**Goal:** Sunset feels like a surf school portal, not a hidden Wolfhouse shell.

| Work | Files (likely) |
|------|----------------|
| Rename WhatsApp tab → **Inbox** | `staff-portal-i18n.js`, `staff-query-api.js` |
| Sunset-specific empty states | `staff-query-api.js`, i18n |
| Hide lodging copy when `is_surf_vertical` | `staff-query-api.js` (conditional render) |
| Wire `hidden_drawer_tabs` (hide transfers) | `staff-query-api.js` `renderBookingContextDrawer` |
| Remove “bed”, “room”, “move bed” strings in surf context | i18n + drawer overview cards |
| Add `verify:sunset-portal-v1` offline checks | new verifier script |
| Document Wolfhouse regression checklist | this doc §8 |

**Out of scope:** new APIs, migrations, writes, email.

**DoD:** Staging browser walkthrough — Inbox + Day Schedule + Luna Staff only; no lodging language visible.

---

### Slice 2B — Day Schedule real UI polish

| Work | Details |
|------|---------|
| Card/table layout | Guest, service type, qty, status, payment, notes |
| Date picker UX | TZ-aware default; loading/error states |
| Demo slot section | Clear “capacity preview” labeling until real slots |
| Row actions (disabled) | “Open booking” placeholder → 2D |

---

### Slice 2C — Inbox / conversation polish

| Work | Details |
|------|---------|
| Inbox list UX | Handoff badges, stage labels, surf copy |
| Thread panel | Guest header, Luna paused indicator |
| Context drawer link | Jump to booking when `booking_code` known |
| Handoff workflow | Review open handoffs list |

---

### Slice 2D — Surf booking / service drawer

| Work | Details |
|------|---------|
| New surf drawer or adapt existing | Overview + Services + Payments only |
| Hide rooming/move-bed cards | Surf vertical guard |
| Customers/Bookings tab | Search by phone, name, `booking_code` |
| Read APIs | Reuse `GET /staff/bookings/:code/context`, `…/services` |

---

### Slice 2E — Staff actions / status updates

| Work | Details |
|------|---------|
| Service status PATCH | confirmed → checked_in → completed / returned |
| Gate with `STAFF_ACTIONS_ENABLED` + Sunset allowlist | env + client guard |
| Audit metadata | `updated_by`, `source=staff_portal` |
| Remove Day Schedule read-only banner | when writes verified |

**Requires Captain approval** for staging writes and production policy.

---

### Slice 2F — Email channel preparation

| Work | Details |
|------|---------|
| Schema review | `conversations.channel`, email identifiers |
| Inbox UI channel badge | design only until ingest exists |
| Plan ingest worker | separate runtime slice; no WhatsApp wiring change |

---

## 10. Risks and follow-ups

| Risk | Mitigation |
|------|------------|
| **Unstable CAE egress** | NAT gateway / workload profile before production; document egress IPs in runbook |
| **Migration ledger** | Sunset DB applied out-of-order once; maintain `database/migrations/README.md` fresh-DB order |
| **Production region co-location** | Plan Sunset prod in same region as Postgres + CAE to reduce latency |
| **Dedicated / platform ACR** | Sunset image currently on `whstagingacr`; split registry for prod isolation |
| **Full browser QA** | Add Playwright or checklist per slice; consumption plan limits |
| **Wolfhouse regression** | Run `/staff/ui` smoke before **any** shared Staff API production deploy |
| **Shared `staff-query-api.js`** | Every change risks Wolfhouse; verifiers + staging smoke both tenants |
| **Drawer debt** | Bed-calendar drawer is large; surf adapter may need new `renderSurfBookingDrawer()` rather than patching all lodging conditionals |
| **Pricing trust** | `unverified_seed` prices must not surface as live quotes to guests |
| **Demo slot confusion** | Label config slots clearly until DB lesson capacity exists |

### Open questions for Captain

1. **v1 nav:** Day Schedule only, or separate Rentals + Lessons tabs in first release?
2. **Customers tab:** Required in v1 or defer until drawer slice?
3. **Staff writes:** Which status transitions are allowed in v1 (rental return, lesson check-in)?
4. **Payment links:** Read-only forever in v1, or staged Stripe link generation on Sunset staging?
5. **Settings tab:** Needed for owner, or config-only changes via repo deploy?
6. **Spanish i18n:** Required for operator demo, or English-only v1?
7. **When to flip `portal_demo.demo_mode` to false?** After first real booking ingest?

---

## Summary

Sunset Slice 1 delivered a **read-only, isolated staging portal** with Inbox, Day Schedule, and correct tab gating. **Staff Portal v1** builds real surf-school operations on that foundation **after demo cleanup**, starting with **Slice 2A: navigation and labeling** so staff never see lodging concepts. Subsequent slices add Day Schedule polish, Inbox UX, a surf booking drawer, controlled status writes, and email preparation — all under Wolfhouse regression gates and Sunset-only access rules.

**Next action:** Captain approves this plan → Ops runs demo cleanup → Cursor implements Slice 2A.
