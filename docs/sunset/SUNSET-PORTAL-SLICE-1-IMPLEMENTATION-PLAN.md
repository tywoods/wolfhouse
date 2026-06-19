# Sunset Portal Slice 1 — Implementation Plan

**Status:** approved plan (Captain sign-off on approach); **no runtime implementation in this commit**  
**Date:** 2026-06-19  
**Branch target:** `feat/sunset-multitenant-luna` on `/opt/luna/Luna-Sunset` (platform work lands in `scripts/staff-query-api.js` on merge)  
**Parent docs:** `SUNSET-PORTAL-DEMO-PLAN.md`, `LUNA-SUNSET-OVERVIEW.md`, `MULTI-TENANT-PLAN.md`

---

## Captain decisions (locked for Slice 1)

| Decision | Value |
|----------|-------|
| Slice scope | **Read-only** Sunset portal demo |
| Lesson slots | **Config-seeded demo slots** — no `lesson_slots` DB table / migration |
| Runtime owner | **Cursor** implements portal slice later |
| Config/seed inputs | **Deckhand** supplies `sunset.baseline.json` additions + seed manifest |
| Wolfhouse | **No behavior change** when `client_slug=wolfhouse-somo` |
| Deploy | Staging only; no production config edits |

---

## Slice 1 outcome (definition of done)

When implemented and seeded on **staging only**, a Sunset-scoped staff user can:

1. Log in to Luna Front Desk Staff Portal.
2. Select tenant **Sunset Surf School** (`sunset`) — Wolfhouse not visible if access-scoped.
3. Land on **WhatsApp** tab by default (not Booking Calendar).
4. See **no** Booking Calendar or Tour Operator tabs.
5. Open a read-only **Day Schedule** panel showing:
   - Active rentals / gear (`booking_service_records`: `wetsuit`, `surfboard`)
   - Lesson rows (`booking_service_records`: `surf_lesson`)
   - Config-seeded lesson slot capacity summary (demo numbers, not DB schema)
6. Browse seeded demo conversations in WhatsApp inbox (read-only).
7. Use **Luna Staff → Operations** chips read-only (lessons/gear today) without Wolfhouse rooming answers.
8. Confirm **zero Wolfhouse leakage** (no rooms, packages, Wolfhouse rates, or `wolfhouse-somo` data when scoped to Sunset).

**Explicitly not in Slice 1:** writes (manual booking, service create, payment links, bed calendar, migrations, deploy scripts execution.

---

## 1. Exact files likely to change

### Platform runtime (Cursor — later, on approved branch)

| File | Change type | Purpose |
|------|-------------|---------|
| `scripts/staff-query-api.js` | **Modify** | Portal UI: vertical gating, default tab, Day Schedule panel, session profile injection |
| `scripts/lib/staff-portal-clients.js` | **Modify** | Load per-client portal profile from baseline (`vertical`, hidden tabs) |
| `scripts/lib/staff-portal-i18n.js` | **Modify** | Day Schedule labels; Sunset-safe copy |
| `scripts/lib/staff-portal-i18n-es.js` | **Modify** (optional Slice 1) | Spanish nav strings if demo requires |
| `scripts/verify-sunset-portal-slice1.js` | **Add** | Offline/staging verification script |
| `scripts/fixtures/sunset-portal-slice1-seed.js` | **Add** | Idempotent staging seed (executed later, not in this doc commit) |
| `scripts/fixtures/sunset-portal-slice1-cleanup.js` | **Add** | Tag-scoped delete for rollback |

### Tenant config & access (Deckhand supplies content; Cursor wires paths)

| File | Change type | Purpose |
|------|-------------|---------|
| `config/clients/sunset.baseline.json` | **Add/update** | Tenant config + `portal_demo` block (lesson slot seeds) |
| `config/clients/sunset.secrets.example.json` | **Update** (if missing keys) | Document required secret keys |
| `config/clients/staff-portal-access.json` | **Modify** | Sunset-only staging staff user (not `all_clients_emails` unless Captain wants) |

### Docs & fixtures (Deckhand)

| File | Change type | Purpose |
|------|-------------|---------|
| `docs/sunset/SUNSET-PORTAL-SLICE-1-SEED-MANIFEST.md` | **Add** | Human-readable seed row spec (Deckhand) |
| `fixtures/sunset-portal-slice1/seed-manifest.json` | **Add** | Machine-readable seed inputs from golden fixtures |
| `fixtures/sunset-golden/*.json` | **Reference only** | Conversation copy sources (already exist) |

### Files that must **NOT** change in Slice 1

| File | Reason |
|------|--------|
| `database/migrations/*` | Captain: no schema-backed lesson slots |
| `scripts/lib/wolfhouse-inventory-source.js` | Wolfhouse-only; do not alter exclusion logic |
| `scripts/lib/staff-bed-calendar-queries.js` | Bed calendar unchanged |
| `scripts/lib/staff-portal-room-label.js` | Room labels unchanged |
| `scripts/verify-luna-golden.js` | Wolfhouse golden runner — must still pass unchanged |
| Production env / Azure prod configs | Hard boundary |

---

## 2. Exact routes / functions in `scripts/staff-query-api.js`

> Line numbers refer to `/opt/wolfhouse/WH` @ `master` (~2026-06-19). Shift after edits; search by function name.

### Server-side (Node)

| Symbol / route | Approx lines | Slice 1 role |
|----------------|--------------|--------------|
| `DEFAULT_CLIENT` | ~477 | **Do not change** — stays `wolfhouse-somo` |
| `buildUiHtml(port)` | ~15536 | Inject vertical profile JSON; render Day Schedule markup; gate tab buttons |
| `handleAuthSession` | ~28949 | **Extend response** with `client_profiles[]` including `vertical`, `hidden_tabs`, `default_tab`, `lesson_slots_demo` |
| `GET /staff/auth/session` | ~31913 | Route dispatch to `handleAuthSession` |
| `GET /staff/ui` | ~15522 | Serves `buildUiHtml` output |
| `GET /staff/query` | ~1406 | **Reuse read-only** — `services.lessons_today`, `services.gear_today` |
| `GET /staff/conversations` | ~18848 (client JS) | Inbox load — unchanged API, Sunset-scoped `client=sunset` |
| `handleBookingContext` / `GET /staff/bookings/:code/context` | ~31352 | Read-only drawer data if linked from Day Schedule row (optional Slice 1) |
| `loadClientConfirmationArrival` | ~12987 | Pattern reference for baseline JSON load — **do not repurpose for portal**; use new helper in `staff-portal-clients.js` |

### Client-side (embedded in `buildUiHtml` template)

| Function | Approx lines | Slice 1 role |
|----------|--------------|--------------|
| `initStaffPortalSession()` | ~17891 | After session load → `applyClientPortalProfile()` |
| `populateClientSelect(clients, preferredSlug)` | ~17877 | On client change → re-apply vertical gating |
| `getClient()` | ~17838 | Returns selected `client_slug` from `#c-client` |
| `switchToTab(tab, subtab)` | ~17495 | Respect hidden tabs; never auto-switch to `bed-calendar` for surf vertical |
| Tab click listeners | ~17519 | Skip hidden tab buttons |
| `loadInbox()` | ~19462 init | Default load on startup — **becomes default tab path** |
| `bcOnBedCalendarTabOpen()` | bed-calendar JS | **Never called** for Sunset vertical |
| `toOnTourOperatorTabOpen()` | tour-operator JS | **Never called** for Sunset vertical |
| Ask Luna `alAsk()` / Operations chips | ~16441+, ~19721 | Filter chip set for surf vertical (hide arrivals/checkouts/occupancy/free-beds) |

### New client-side functions (to add in Slice 1 implementation)

```text
applyClientPortalProfile()       — read session client_profiles; hide tabs; set default tab
loadDaySchedule(dateStr)         — fetch services via GET /staff/query (two intents)
renderDayScheduleTable(rows)     — rental + lesson rows from booking_service_records
renderLessonSlotDemo(slots)      — config-seeded capacity bar (read-only)
onClientSelectChange()           — wire #c-client change → applyClientPortalProfile + reload
```

### New server-side helper (prefer `staff-portal-clients.js` over inline in monolith)

```text
loadClientPortalProfile(clientSlug)  → { vertical, default_tab, hidden_tabs, lesson_slots_demo }
listClientPortalProfiles(user)       → map over accessible clients
```

---

## 3. Detect `vertical=surf_school_rentals` from config

### Source of truth

```json
// config/clients/sunset.baseline.json
{
  "_meta": {
    "client_slug": "sunset",
    "vertical": "surf_school_rentals"
  }
}
```

Wolfhouse reference:

```json
// config/clients/wolfhouse-somo.baseline.json
"_meta": { "vertical": "lodging_surf_house" }
```

Template allows: `lodging_surf_house | surf_shop_rentals | surf_school_lessons | tours` (`_deploy-config.template.json`). Sunset uses **`surf_school_rentals`** (combined school + rentals per local skeleton).

### Loader implementation (planned)

Add to `scripts/lib/staff-portal-clients.js`:

```javascript
const SURF_VERTICALS = new Set([
  'surf_school_rentals',
  'surf_shop_rentals',
  'surf_school_lessons',
  'lessons',           // surf-school.sample.json legacy
]);

function loadClientPortalProfile(clientSlug) {
  const cfg = loadBaselineJson(clientSlug); // same pattern as luna-guest-lesson-schedule-config.js
  const vertical = cfg?._meta?.vertical || 'lodging_surf_house';
  const isSurfVertical = SURF_VERTICALS.has(vertical);
  return {
    client_slug: clientSlug,
    vertical,
    default_tab: isSurfVertical ? 'conversations' : 'bed-calendar',
    hidden_tabs: isSurfVertical
      ? ['bed-calendar', 'tour-operator']
      : [],
    hidden_drawer_tabs: isSurfVertical ? ['transfers'] : [],
    lesson_slots_demo: isSurfVertical ? loadLessonSlotsDemo(cfg) : null,
  };
}
```

### Session API shape (extend `GET /staff/auth/session`)

```json
{
  "success": true,
  "clients": [{ "slug": "sunset", "name": "Sunset Surf School" }],
  "client_profiles": {
    "sunset": {
      "vertical": "surf_school_rentals",
      "default_tab": "conversations",
      "hidden_tabs": ["bed-calendar", "tour-operator"],
      "lesson_slots_demo": [
        { "slot_time": "11:00-13:00", "label": "Morning group", "capacity": 8 },
        { "slot_time": "16:00-18:00", "label": "Afternoon group", "capacity": 8 }
      ]
    }
  }
}
```

**Wolfhouse path:** when `wolfhouse-somo` profile loads, `hidden_tabs: []`, `default_tab: bed-calendar` — identical to today.

---

## 4. Hide Wolfhouse-only tabs (Booking Calendar / Tour Operator)

### Mechanism (client-side, config-driven)

1. On `initStaffPortalSession()` success, call `applyClientPortalProfile(getClient())`.
2. For each tab in `hidden_tabs`:
   - `document.querySelector('.tab-btn[data-tab="' + tab + '"]').style.display = 'none'`
   - `document.getElementById('tab-' + tab).classList.remove('active')`
3. Remove `active` from hidden tab buttons in initial HTML **or** override at runtime before first paint (prefer runtime override to avoid Wolfhouse HTML churn).
4. On `#c-client` change, re-run gating.

### Tabs to hide for `surf_school_rentals`

| Tab | `data-tab` | Why |
|-----|------------|-----|
| Booking Calendar | `bed-calendar` | Room/bed grid — wrong vertical |
| Tour Operator | `tour-operator` | Whole-room blocking — Wolfhouse-only |

### Tabs to keep visible

| Tab | Notes |
|-----|-------|
| WhatsApp (`conversations`) | Default landing |
| Luna Staff (`ask-luna`) | Read-only ops queries |
| Developer Tools | Admin/dev only (existing role gate) |
| Luna Guest Simulator | Dev only — optional: hide for Sunset demo users |

### Drawer gating (if booking context opened)

When `hidden_drawer_tabs` includes `transfers`, hide `#bc-drawer-tab-btn-transfers` and panel. Slice 1 may defer drawer entirely if Day Schedule list does not open bed-calendar drawer.

### Fail-safe

If `client_profiles` missing (baseline file absent), **fall back to Wolfhouse behavior** — do not hide tabs. Sunset baseline must be present on staging before demo.

---

## 5. Sunset default tab

**Default tab: `conversations` (WhatsApp inbox)**

| Vertical | Default tab | Rationale |
|----------|-------------|-----------|
| `lodging_surf_house` | `bed-calendar` | Unchanged Wolfhouse behavior |
| `surf_school_rentals` | `conversations` | Read-only demo centers on guest threads + handoffs; no bed ops |

### Startup sequence change

Current (~19462):

```javascript
initStaffPortalSession().then(function(){
  loadInbox();
});
// HTML default: tab-bed-calendar.active
```

Planned:

```javascript
initStaffPortalSession().then(function(){
  var profile = getPortalProfile(getClient());
  switchToTab(profile.default_tab || 'conversations', null);
  if (profile.default_tab === 'conversations') loadInbox();
  if (profile.vertical === 'surf_school_rentals') loadDaySchedule(todayIso());
});
```

### Secondary panel (same slice)

Add visible sub-nav or third tab **`day-schedule`** (read-only) — **recommended** so ops data is not buried inside WhatsApp.

| Option | Pros | Cons |
|--------|------|------|
| A. WhatsApp only default | Minimal diff | No dedicated rentals/lessons view |
| B. **New `day-schedule` tab** (recommended) | Clear demo story | Small HTML addition |
| C. Reuse hidden `tab-today` | Less markup | Confusing "Today" copy |

**Plan recommends Option B:** new tab `day-schedule`, second in nav for Sunset only, not default (default stays WhatsApp).

---

## 6. Display `booking_service_records` as rental / lesson rows

### Data source (existing, migration 010)

Table: `booking_service_records`  
Relevant `service_type` values for Sunset:

| `service_type` | Sunset meaning |
|----------------|----------------|
| `surf_lesson` | Lesson seat / session |
| `wetsuit` | Wetsuit rental |
| `surfboard` | Board rental |
| `yoga`, `meal` | Hide for Sunset demo (Wolfhouse addons) |

### Read path (no new endpoint required for Slice 1)

Use existing **Staff Query API** intents (registry @ `staff-query-registry.js`):

| Intent | Helper | Params |
|--------|--------|--------|
| `services.lessons_today` | `staff-ask-luna-lessons.js` → `getAskLunaLessonsOnDateQuery` | `client=sunset`, `date=YYYY-MM-DD` |
| `services.gear_today` | `staff-ask-luna-gear.js` → `getAskLunaGearOnDateQuery` | `client=sunset`, `date=YYYY-MM-DD` |

Client JS (Day Schedule tab):

```javascript
function loadDaySchedule(dateIso) {
  var client = getClient();
  var base = '/staff/query?client=' + encodeURIComponent(client) + '&date=' + encodeURIComponent(dateIso);
  return Promise.all([
    fetch(base + '&intent=services.lessons_today').then(r => r.json()),
    fetch(base + '&intent=services.gear_today').then(r => r.json()),
  ]).then(function (results) {
    renderDaySchedule(results[0].rows, results[1].rows);
    renderLessonSlotDemo(computeSlotSeats(results[0].rows));
  });
}
```

### Row rendering rules

| Column | Lessons | Rentals |
|--------|---------|---------|
| Guest | `guest_name` | `guest_name` |
| Service | `surf lesson` × `quantity` | `wetsuit` / `surfboard` × `quantity` |
| Date | `service_date` | `service_date` |
| Status | `service_status` | `service_status` |
| Payment | `payment_status` | `payment_status` |
| Booking | `booking_code` (link optional) | `booking_code` |

**Hide** `bed_summary` column for Sunset vertical (comes from `booking_beds` join in SQL — show `—` or omit).

### Booking header dependency

Existing lesson/gear queries **INNER JOIN bookings** (`sr.booking_id IS NOT NULL`). Seed script must create lightweight `bookings` rows for Sunset demo (no `booking_beds` required).

### Optional Slice 1 enhancement (still read-only)

Add `GET /staff/services/day?client=sunset&date=` as thin wrapper — **defer** unless dual-fetch is too slow; not required for demo.

---

## 7. Seed demo conversations / service records (staging only)

### Tag convention (distinct from Wolfhouse `stage8_demo`)

```json
{ "source": "sunset_demo_slice1", "note": "Sunset portal Slice 1 staging demo — safe to delete" }
```

**Never reuse `stage8_demo`** — Wolfhouse cleanup scripts and inventory exclusions target that tag.

### Staging guards (mandatory in seed script)

Mirror `docs/STAGE-8.5-DEMO-DATA-SEED-PLAN.md` and `stage8-demo-cleanup.js` patterns:

```javascript
assertNotProduction();          // refuse if production DB / env
assertStagingHost();            // optional: staff-staging.lunafrontdesk.com
assertClientSlug('sunset');     // refuse wolfhouse-somo seeds
```

### Seed script location (implement later)

`scripts/fixtures/sunset-portal-slice1-seed.js`

### Rows to seed (Deckhand manifest → Cursor script)

| Entity | Count | Source |
|--------|-------|--------|
| `clients` row | 0 (assume exists) or upsert | `sunset` slug must resolve |
| `bookings` | 2–3 | Jamie (rental), Chris (lesson), optional accommodation request |
| `booking_service_records` | 3–5 | Golden fixture scenarios 02, 03, 05 |
| `conversations` | 2–3 | Golden fixture message text |
| `messages` | 4–8 | Inbound guest + outbound Luna (dry-run safe) |
| `staff_handoffs` | 0–1 | Optional: golden-04 kids age check |
| `payments` | 0 | Slice 1 read-only — optional `not_requested` only |
| `booking_beds` | **0** | Sunset has no beds |

### Deckhand deliverable: `fixtures/sunset-portal-slice1/seed-manifest.json`

Deckhand supplies before Cursor implements seed script:

- Guest names, phones, message text (from `fixtures/sunset-golden/`)
- Service record types, dates, quantities
- Reference date: `2026-06-20` (matches golden fixtures)
- `pricing_status` note: demo rows use `provisional` / dry-run only

### Execution policy

| Who | When |
|-----|------|
| Deckhand | Writes manifest + baseline `portal_demo` block |
| Cursor | Implements seed/cleanup scripts |
| Captain | Approves **running** seed against staging DB |
| Deckhand/Cursor | **Must not** run seed in this planning phase |

### Cleanup

`scripts/fixtures/sunset-portal-slice1-cleanup.js` deletes all rows where `metadata->>'source' = 'sunset_demo_slice1'` across: `messages`, `conversations`, `staff_handoffs`, `booking_service_records`, `payments`, `bookings` (order respects FKs).

---

## 8. Seed lesson slots for demo (no schema)

Captain decision: **config-seeded demo slots only**.

### Config block (Deckhand adds to `sunset.baseline.json`)

```json
"portal_demo": {
  "_note": "Staging demo only. Portal reads for Slice 1 slot capacity display. Not guest-runtime truth.",
  "lesson_slots": [
    {
      "slot_time": "11:00-13:00",
      "label": "Morning group lesson",
      "capacity": 8,
      "demo_date": "2026-06-21"
    },
    {
      "slot_time": "16:00-18:00",
      "label": "Afternoon group lesson",
      "capacity": 8,
      "demo_date": "2026-06-21"
    }
  ]
}
```

Alternate source (already in skeleton): `catalog.lessons.scheduling.common_slot_times` — loader merges with `portal_demo.lesson_slots` for capacity integers.

### Portal display logic (read-only)

1. `handleAuthSession` includes `lesson_slots_demo` from baseline.
2. Day Schedule panel renders slot cards: `slot_time`, `capacity`, `seats_booked`.
3. `seats_booked` = **computed client-side** (or server-side in session handler):
   - Count `quantity` from seeded `booking_service_records` where `service_type=surf_lesson` and `metadata->>'slot_time' = slot_time` on demo date.
4. Show **"X / 8 seats"** — never "confirmed" language without payment truth.

### Seeding service records with slot metadata

```json
{
  "service_type": "surf_lesson",
  "service_date": "2026-06-21",
  "quantity": 2,
  "metadata": {
    "source": "sunset_demo_slice1",
    "slot_time": "11:00-13:00",
    "lesson_offering": "group_lesson_adult",
    "capacity_check": "demo_seed_only"
  }
}
```

### What we are NOT doing

- No `lesson_slots` / `lesson_slot_capacity` tables
- No `POST /staff/lesson-slots` write API
- No Luna guest capacity check wiring (runtime slice later)

---

## 9. Verify zero Wolfhouse leakage

### Automated checks (add `scripts/verify-sunset-portal-slice1.js`)

| # | Check |
|---|-------|
| L1 | `loadClientPortalProfile('sunset').hidden_tabs` includes `bed-calendar`, `tour-operator` |
| L2 | `loadClientPortalProfile('wolfhouse-somo').hidden_tabs` is empty |
| L3 | `buildUiHtml` contains **no** unconditional hide of bed-calendar (gated by profile only) |
| L4 | Sunset profile `default_tab === 'conversations'` |
| L5 | Wolfhouse profile `default_tab === 'bed-calendar'` |
| L6 | `listBaselineClients()` returns `sunset` when baseline file present |
| L7 | Seed manifest uses `sunset_demo_slice1` tag — never `stage8_demo` |
| L8 | `npm run verify:luna-golden` still passes (Wolfhouse regression) |

### Staging manual checklist (post-seed, post-deploy)

| # | Step | Pass criterion |
|---|------|----------------|
| M1 | Log in as Sunset-only staff user | Client dropdown shows **only** `sunset` |
| M2 | Initial landing tab | WhatsApp, **not** Booking Calendar |
| M3 | Nav tabs | No Booking Calendar, no Tour Operator |
| M4 | Day Schedule | Shows lesson + gear rows for `sunset` only |
| M5 | Open Jamie / Chris threads | Message text matches golden fixtures; no Wolfhouse names |
| M6 | Search UI text / network responses | No `wolfhouse`, `Somo`, `Malibu`, `Uluwatu`, `Waimea`, `Cami`, room codes (`R1`, `R2`) |
| M7 | `GET /staff/query?intent=rooming.*&client=sunset` | Empty or N/A — not surfaced in UI |
| M8 | Switching client (if admin) | Selecting `wolfhouse-somo` restores bed calendar — **admin only** |
| M9 | Stripe / payment URLs | No Wolfhouse Stripe context on Sunset rows |

### Tenant isolation string grep (automate in verify script)

```bash
# After staging deploy — example patterns that must NOT appear when client=sunset
wolfhouse-somo | Somo | Malibu | Uluwatu | Waimea | Cami | gate_code | booking_beds
```

---

## 10. Tests and manual checks to run

### Before merge (Cursor implementation PR)

| Command / action | Owner | Required |
|------------------|-------|----------|
| `node scripts/verify-sunset-portal-slice1.js` | Cursor | Yes |
| `node scripts/verify-staff-portal-room-label.js` | Cursor | Yes (unchanged pass) |
| `npm run verify:luna-golden` | Cursor | Yes — Wolfhouse guard |
| `node scripts/verify-staff-portal-private-room-ui.js` | Cursor | Yes (unchanged pass) |
| Manual: load `/staff/ui` locally with `sunset.baseline.json` | Cursor | Yes |

### After staging seed (Captain-approved run)

| Action | Owner |
|--------|-------|
| Run `sunset-portal-slice1-seed.js` on staging DB | Captain |
| Manual checklist M1–M9 | Deckhand or Captain |
| Record screenshot / short screen capture for demo | Deckhand |

### Explicitly not required for Slice 1

- `verify:sunset-golden` (runner not wired)
- Bed calendar move/manual booking verifies
- Stripe live payment tests

---

## 11. Risks and rollback plan

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `staff-query-api.js` monolith edit breaks Wolfhouse UI | **Critical** | Vertical gating only; Wolfhouse profile returns current defaults; run `verify:luna-golden` |
| Session API change breaks existing portal clients | High | Additive fields only (`client_profiles`); clients ignore unknown keys |
| Sunset seed pollutes Wolfhouse staging queries | High | `client_slug=sunset` on all rows; `sunset_demo_slice1` tag; cleanup script |
| Accidental seed on production | Critical | `assertNotProduction()` in seed/cleanup |
| Lesson slot demo mistaken for live capacity | Medium | Label UI **"Demo schedule"**; `portal_demo._note` in config |
| Admin `all_clients_emails` sees both tenants | Low | Use scoped `client_access` for demo user |
| `booking_service_records` CHECK constraint blocks Sunset types | Medium | Use existing enum values only (`surf_lesson`, `wetsuit`, `surfboard`) |

### Rollback plan

1. **Code rollback:** Revert PR on `feat/sunset-multitenant-luna`; redeploy previous Staff API image on staging.
2. **Data rollback:** Run `sunset-portal-slice1-cleanup.js` — verify zero rows with `source=sunset_demo_slice1`.
3. **Config rollback:** Remove `sunset` from `staff-portal-access.json` (or disable Sunset baseline `deployment.enabled`).
4. **Wolfhouse verification:** Run `verify:luna-golden` + manual bed calendar smoke on `wolfhouse-somo`.
5. **No migration rollback needed** — Slice 1 adds no schema.

---

## 12. What must still wait for approval before runtime implementation

| Item | Approver | Status |
|------|----------|--------|
| This implementation plan | Captain | **Approved (read-only/gated approach)** |
| `staff-query-api.js` portal edits | Captain | **Pending** — implement after this doc in git |
| `staff-portal-clients.js` profile loader | Captain | Pending |
| Running seed script on staging DB | Captain | Pending |
| Staging Staff API deploy | Captain | Pending |
| Sunset `deployment.enabled=true` on staging | Captain | Pending |
| Owner-verified pricing for live quotes | Sunset owner | Out of scope Slice 1 |
| Schema-backed `lesson_slots` table | Skipper + Captain | **Explicitly deferred** |
| Write paths (manual rental, payment links) | Captain | Slice 2+ |
| Merge to `master` | Captain | Pending Wolfhouse regression |
| Production deploy | Captain | **Forbidden** for Slice 1 |

---

## Implementation handoff

### Deckhand (next, parallel to Cursor)

1. Add `portal_demo.lesson_slots` block to `config/clients/sunset.baseline.json`.
2. Create `fixtures/sunset-portal-slice1/seed-manifest.json` from golden fixtures 01–05.
3. Add `docs/sunset/SUNSET-PORTAL-SLICE-1-SEED-MANIFEST.md` describing each row.
4. Propose Sunset-only staging user in `staff-portal-access.json` (email TBD with Captain).

### Cursor (after this doc is committed)

1. Implement `loadClientPortalProfile` + session API extension.
2. Implement vertical tab gating + default tab + Day Schedule read-only panel.
3. Add `verify-sunset-portal-slice1.js`.
4. Add seed/cleanup scripts (do not run until Captain approves).
5. Open PR on `feat/sunset-multitenant-luna`; attach manual checklist results.

### Captain (before staging demo)

1. Review PR diff for Wolfhouse path regression.
2. Approve staging seed run.
3. Approve staging deploy.

---

## References

| Doc / file | Relevance |
|------------|-----------|
| `docs/sunset/SUNSET-PORTAL-DEMO-PLAN.md` | Parent discovery |
| `docs/STAGE-8.5-DEMO-DATA-SEED-PLAN.md` | Seed tag + cleanup pattern |
| `docs/STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md` | §11 Sunset readiness notes |
| `scripts/lib/staff-ask-luna-lessons.js` | Lessons query SQL |
| `scripts/lib/staff-ask-luna-gear.js` | Gear/rental query SQL |
| `scripts/lib/luna-guest-lesson-schedule-config.js` | Baseline load pattern |
| `fixtures/sunset-golden/*.json` | Guest message + behavior spec |
