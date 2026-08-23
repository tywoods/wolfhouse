# External Calendar Inventory Bridge

**Status:** implementation in progress on Wolfhouse staging (`wolfhouse-somo`). No Sunset activation. No production.  
**Owner:** Deckhand (proposal) → review before any build slice.  
**Scope:** Admin Portal → **Luna Staff**. Tenant-scoped, read-only Google Sheet ingest.  
**First activation:** **Wolfhouse staging** / tenant **`wolfhouse-somo`** only.  
**Not this programme:** Sunset configure, migrate, connect, deploy, or E2E. Schema stays reusable (`client_id`) but must not be turned on for Sunset.  
**Master inspected:** `bb3d2c40` (later design refresh on current sandbox master).  
**Approved product decisions (Earthling via Skipper):**

| # | Decision |
|---|----------|
| 1 | **P1 source = structured Google Sheet only.** No Google Calendar. ICS/iCal is not in this programme. |
| 2 | **Bed-only** mapping for MVP (no room-level expand). |
| 3 | UI lives on **Luna Staff**. |
| 4 | Stale / inaccessible / malformed Sheet → **keep last successfully imported blocks**. Never auto-release. |
| 5 | Booking calendar: new **yellow** state, label exactly **“Owner schedule blocked”**. Distinct from guest stays and ordinary staff blocks. |

---

## 1. Goal

Staff connect a **structured Google Sheet** in **Luna Staff**, map each **external unit key → one Luna bed**, and import **occupied** date ranges as inventory blocks.

Sheet **busy** may block a mapped bed. Sheet **free / missing rows must never** release or override:

- guest Luna bookings
- ordinary staff calendar blocks (`staff_block`)
- operator / tour-operator blocks
- private-room blocks

No Google write-back. No Calendar API. No production activation in this programme.

---

## 2. What already exists (do not reinvent)

### Occupancy authority

Inventory is a **half-open date range on `booking_beds`**, not a separate calendar table.

| Object | Path | Role |
|--------|------|------|
| `rooms` / `beds` | `database/migrations/001_init.sql` | Physical inventory; `sellable` / `active` |
| `bookings` | same | Stay or block row (`status`, `booking_source`, `block_type`, `metadata`) |
| `booking_beds` | same | Per-bed assignment `[assignment_start_date, assignment_end_date)` |
| Overlap gate | `scripts/lib/staff-manual-booking-create-sql.js` | `overlap_conflict` → `is_blocked` — Luna **and** staff writes |
| Staff bed block | `POST /staff/calendar/beds/block` | `status='blocked'`, `assignment_type='staff_block'`, grey **Blocked** legend |
| Operator block | `/staff/tour-operator/blocks/*` | `assignment_type='operator_block'`, purple **Tour** |
| Tenant | `clients` + `tenant_locations` (`057_…`) | First proof: `wolfhouse-somo`. Other tenants stay off. |
| Audit | `appendAuditLog` | Intent + actor; no secrets |

Staff “Block” is already a **booking**, not a `blocks` table. Luna already treats those rows as occupied.

**Implication:** the Sheet bridge creates **owned** blocked bookings through the same overlap SQL, tagged so sync can only mutate its own rows.

### Booking calendar colours today

| Legend | Swatch (light) | Meaning |
|--------|----------------|---------|
| Luna | `#D5E5EF` / `#7AAABB` | Guest / payment-pending |
| Staff | `#DCEAD2` / `#B5D3AD` | Manual staff stay |
| Tour | `#E8DDF5` / `#B39BCB` | Operator block |
| Blocked | `#E4E2DE` / `#B0AEA8` | Ordinary staff / private **Blocked** |
| Hold / review / balance | sand / amber / peach | Other guest states |

**Owner schedule blocked** must be a **new yellow** — not grey Blocked, not sand Hold, not amber Review.

Proposed tokens (implement later; do not ship now):

| Token | Value | Use |
|-------|--------|-----|
| `--bc-owner-block-fill` | `#F6E56B` | Cell / bar fill |
| `--bc-owner-block-edge` | `#C4A017` | Left edge / border |
| `--bc-owner-block-text` | `#4E5853` | Label (existing primary; weight ≤700) |
| i18n | `calendar.legend.ownerScheduleBlocked` | **Owner schedule blocked** (exact EN) |

Dark theme: keep yellow readable — e.g. fill `#C9B22A`, edge `#E8D34A`, text `#1e1e1e`. Distinct from `--tan` / review `#F3DCC1`.

Cell title / aria: **Owner schedule blocked** — never “Blocked”, “Staff”, or “Luna”.

### Luna Staff UI

`#tab-ask-luna` is the home. Add a **new card** there (connections, map, conflicts). Do not add a top-level nav tab. Do not reuse Admin’s hidden Luna Staff subtab as a second owner.

MVP inventory target: **Wolfhouse bed calendar** (`wolfhouse-somo`). Do not enable on Sunset.

---

## 3. Authority boundary (hard rules)

1. **Read-only ingest.** Read the Sheet. Write **only** Luna-owned owner-schedule block rows. Never write cells back to Google.
2. **Busy → may block** only on **explicitly mapped beds**.
3. **Free / deleted row → never release Luna inventory.** Sync may cancel/update only rows with  
   `assignment_type = 'external_inventory_block'`  
   **and** `metadata.external_calendar.connection_id = this connection`.
4. **Fail closed + keep last blocks.** Stale, 401/403, parse fail, header drift, clock/TZ junk, unmapped unit, or overlap with a non-owned row → **keep last good owned blocks**, mark connection `stale` / `error`, list conflicts. Do **not** delete inventory because the Sheet went quiet or empty.
5. **Bed-only maps.** One `external_unit_key` → one `bed_id`. No room-level “block all beds”.
6. **Tenant scoped.** Every row has `client_id`. Runtime allowlist defaults to `wolfhouse-somo`. Requests for `sunset` / Sunset locations are refused.
7. **Secrets** in Key Vault / env only — never workspace, `metadata`, Sheet URL query tokens in git, or audit bodies.
8. **Wolfhouse staging only** until an explicit production gate. Flag: `EXTERNAL_CALENDAR_INGEST_ENABLED` (default false). Client allowlist: `EXTERNAL_CALENDAR_CLIENTS` default `wolfhouse-somo`.

---

## 4. Why Sheet only (this programme)

| | Google Sheet (P1) | ICS / iCal | Google Calendar |
|--|-------------------|------------|-----------------|
| Status | **Build this** | Out of programme | Out of programme |
| Auth | OAuth **or** service account + share | n/a | n/a |
| Shape | Frozen header + one row per occupancy | — | — |
| Failure | Header drift, locale dates, merged cells | — | — |
| Write-back | **Forbidden** | — | — |

Ops already live in a spreadsheet: one strict contract beats a calendar parser.

---

## 5. Strict Sheet contract

One tab (name configured). **Row 1 is frozen headers — exact strings, exact order.** Any drift → probe/sync **error**, no writes, last blocks kept.

### Required columns (row 1)

| # | Header (exact) | Meaning |
|---|----------------|---------|
| A | `unit_key` | External unit id (maps 1:1 to a Luna bed) |
| B | `start_date` | Occupied from (inclusive), `YYYY-MM-DD` |
| C | `end_date` | Occupied until (exclusive), `YYYY-MM-DD` |
| D | `status` | `busy` or `free` (lowercase) |
| E | `external_uid` | Stable row id (never reuse for a different stay) |

### Optional columns (must still match if present)

| Header | Meaning |
|--------|---------|
| `notes` | Staff-visible note, max 200 chars, no PII required |
| `updated_at` | ISO-8601; used only for ordering, not occupancy |

### Validation (fail closed)

| Rule | Fail action |
|------|-------------|
| Header row ≠ contract (name, order, extra required missing) | `error`, no writes |
| Merged cells in used range | `error` |
| `unit_key` empty | skip row, count as unmapped |
| Dates not `YYYY-MM-DD` (no `DD/MM/YYYY`, no Excel serial leaked as float) | skip row + increment parse_errors; if parse_errors > 0 **and** zero valid busy rows → `error` |
| `end_date` ≤ `start_date` | skip row |
| `status` not `busy`/`free` | skip row |
| `external_uid` empty | skip row |
| Duplicate `(external_uid)` with different dates | `error` (ambiguous identity) |
| `status=free` | **do not create a block**; if an owned XBLK exists for that uid, cancel **only that** XBLK |
| Unmapped `unit_key` | `skipped_unmapped`; no insert |
| Valid `busy` overlaps non-owned `booking_beds` | `skipped_conflict`; **keep guest/staff row** |

Timezone: dates are **calendar dates in the tenant hostel TZ** (Wolfhouse: Europe/Madrid unless config says otherwise). No times in MVP.

Empty sheet / only headers: treat as “no busy rows” — **do not** mass-cancel owned blocks on a single empty fetch. Require **N consecutive successful empty parses** (recommend N=3) **or** explicit Disable+Release. First empty success → `healthy` + warning, blocks kept.

---

## 6. Auth / access (design, not built)

Two options — pick at implement time; both read-only:

| Option | How | Pros | Cons |
|--------|-----|------|------|
| **A. Service account** | Share the Sheet with a Luna Google SA (`…@….iam.gserviceaccount.com`), scope `spreadsheets.readonly` | No per-staff OAuth dance | SA JSON in secret store |
| **B. Staff OAuth** | Google OAuth, `spreadsheets.readonly` only | Staff owns the file | Token refresh; paused if OAuth programme is paused |

**Recommend A** for staging MVP (one SA, one shared Sheet). Document “share this address, Viewer only.”

Never request `spreadsheets` write scopes.  
Never store the sheet as a published-to-web CSV URL (unauthenticated scrape) — that’s not fail-closed and leaks.

`secret_ref` on the connection points at Key Vault / env. API responses expose `has_secret: true/false` only.

---

## 7. Data model (not implemented)

All tables: `client_id NOT NULL REFERENCES clients(id) ON DELETE CASCADE`.  
Optional `location_id` — required when tenant has locations.

```
external_calendar_connections
  id, client_id, location_id NULL,
  kind            TEXT NOT NULL CHECK (kind = 'gsheet'),   -- only gsheet in this programme
  name, status    TEXT CHECK (status IN ('disabled','pending','healthy','stale','error')),
  spreadsheet_id  TEXT NOT NULL,
  sheet_name      TEXT NOT NULL DEFAULT 'inventory',
  poll_seconds    INT NOT NULL DEFAULT 900,
  stale_after     INTERVAL NOT NULL DEFAULT '6 hours',
  last_success_at, last_attempt_at, last_error,
  last_header_sha, last_content_sha256,
  consecutive_empty_ok INT NOT NULL DEFAULT 0,
  created_by_staff_id, created_at, updated_at

external_calendar_secrets          -- ciphertext / ref only
  connection_id PK,
  secret_ref    TEXT NOT NULL,
  updated_at

external_calendar_unit_maps        -- bed-only
  id, connection_id, client_id,
  external_unit_key TEXT NOT NULL,
  bed_id UUID NOT NULL REFERENCES beds(id),
  UNIQUE (connection_id, external_unit_key),
  UNIQUE (connection_id, bed_id)           -- one sheet unit per bed

external_inventory_events
  id, connection_id, client_id,
  external_uid    TEXT NOT NULL,
  period_start    DATE NOT NULL,           -- inclusive
  period_end      DATE NOT NULL,           -- exclusive
  map_id          UUID REFERENCES external_calendar_unit_maps,
  booking_id      UUID REFERENCES bookings(id),
  status          TEXT CHECK (status IN (
                    'imported','skipped_unmapped','skipped_conflict','tombstoned')),
  skip_reason     TEXT,
  UNIQUE (connection_id, external_uid)
```

**Owned block row** (reuses occupancy):

- `bookings.status = 'blocked'`
- `booking_beds.assignment_type = 'external_inventory_block'`
- `bookings.metadata.external_calendar = { connection_id, external_uid, source_kind: 'gsheet', label: 'owner_schedule_blocked' }`
- `booking_code` prefix `XBLK-` (not staff `BLK-`)

Calendar renderer (later slice) keys off `assignment_type` / metadata label → **yellow** + **Owner schedule blocked**.  
`staff_block` stays grey **Blocked**. Guest stays stay Luna/Staff colours.

### What sync may mutate

| Row | Sync may |
|-----|----------|
| `external_inventory_block` + matching `connection_id` | insert / shorten / cancel |
| guest stay, `staff_block`, `operator_block`, `private_room_block` | **never** |

---

## 8. API (staff session, flag-gated)

All: existing staff auth + `assertStaffClientAccess`. Client must be `wolfhouse-somo` (or explicit allowlist). Sunset slugs are rejected.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/staff/luna-staff/calendar-bridge?client=&location=` | List connections (no secrets) |
| `POST` | `/staff/luna-staff/calendar-bridge` | Create **disabled** gsheet connection |
| `PATCH` | `/staff/luna-staff/calendar-bridge/:id` | Rename, poll, disable |
| `POST` | `…/:id/probe` | Read+validate Sheet **dry-run**, no writes |
| `GET`/`PUT` | `…/:id/maps` | Bed maps only |
| `POST` | `…/:id/sync` | Manual sync (cron uses same) |
| `GET` | `…/:id/conflicts` | unmapped + skipped_conflict |
| `POST` | `…/:id/release-owned` | Two-step: cancel **only** this connection’s XBLK rows |

Cron: per enabled connection; skip if flag off. One sync at a time (`FOR UPDATE` on connection).

Audit: `intent: api:external_calendar_*`. Never log sheet cells, SA JSON, or tokens.

---

## 9. Sync / conflict lifecycle

```
disabled → (maps + probe ok) → pending
pending  → first successful sync → healthy
healthy  → fetch/parse/header fail past stale_after → stale   (XBLK kept)
any      → explicit disable → disabled  (XBLK kept)
disable + confirm release-owned → only this connection’s XBLK cancelled
```

Per **busy** row:

1. Validate dates + uid.
2. Map `unit_key` → `bed_id`. None → `skipped_unmapped`.
3. Overlap vs **non-owned** `booking_beds` → `skipped_conflict`.
4. Else upsert owned XBLK (same overlap SQL).

Per **free** row or vanished `external_uid` (on a **successful** non-empty parse):

- Cancel **owned** XBLK for that uid only.

**Empty successful parse:** increment `consecutive_empty_ok`; do **not** tombstone all XBLK until threshold or human release.

**Stale / error:** no occupancy writes at all.

---

## 10. UI behaviour

### Luna Staff card

1. Connections — name, Sheet id (truncated), status, last success/error.
2. Connect — spreadsheet id, sheet name, secret-ref, **Probe**.
3. Map — `unit_key` → bed picker (this tenant’s sellable beds only).
4. Conflicts — read-only; staff fix the Sheet or the bed calendar; no force-overwrite.
5. Disable / **Release owner blocks** — two-step confirm; copy:  
   “This only removes Owner schedule blocked cells. Luna bookings and staff blocks stay.”

Banner copy: “The Sheet can block beds. An empty or broken Sheet never removes a Luna booking or staff block.”

### Booking calendar (implement with writer, not before)

- New legend swatch (yellow) + **Owner schedule blocked**.
- Cells from `external_inventory_block` use that swatch and label.
- Tooltip / title exact EN string.
- Do not paint `staff_block` yellow.
- i18n keys later (ES/IT) — EN locked now.
- Typography / 1240 / font-weight ≤700 unchanged. No homemade icons.

---

## 11. Staged backlog (Sheet-first)

| Slice | What | Proof | Not |
|-------|------|-------|-----|
| **0** | This document + decisions above | Human approve | Code |
| **1** | Schema + `external_inventory_block` overlap contract | SQL fixtures: guest/staff/operator untouched | Network / UI |
| **2** | Sheet parser + header contract + probe dry-run | Golden CSV/Sheet fixtures (good, header drift, locale dates, merged, empty, dup uid) | DB writes / OAuth UI |
| **3** | Staging writer + keep-last-blocks + yellow calendar paint | Integration: busy→yellow XBLK; free→only XBLK gone; 5xx→stale+blocks remain; staff_block stays grey | Prod / Calendar API |
| **4** | Luna Staff UI connect + bed map + conflicts | Typography + staff-login; Inbox 3-col untouched | GCal / ICS |
| **5** | Cron + stale_after + consecutive empty | Time-travel fixtures | Prod |
| **6** | Production gate | Explicit Earthling + Captain | Default-on |

ICS and Google Calendar are **not** later slices in this programme unless reopened.

---

## 12. Test matrix (before any write slice)

- Header exact match; extra column; missing `external_uid`; reordered columns.
- `DD/MM/YYYY` and Excel serial → reject.
- `busy` mapped bed, free bed, unmapped key.
- Overlap vs confirmed guest; vs `staff_block`; vs `operator_block`; vs existing XBLK (idempotent).
- `status=free` cancels only matching XBLK.
- Empty sheet ×1 keeps XBLK; ×3 still keeps unless policy says otherwise (doc: keep).
- Stale/401: last XBLK remain; calendar still yellow.
- Cross-tenant map rejected.
- Non-allowlisted client (including Sunset) → 403 / no SQL.
- Secret never in JSON/audit.
- Calendar: yellow label **Owner schedule blocked**; grey Blocked still used for staff blocks.
- UI hidden when flag off.

---

## 13. Out of scope

- Google Calendar API / ICS / iCal
- Any Google write-back
- Room-level mapping
- Auto-creating beds from `unit_key`
- Releasing staff/guest inventory because the Sheet is empty
- Production enablement
- Inbox layout, email ingest, paused Gmail owners

---

## 14. Decisions locked

1. **Sheet only** — P1.  
2. **Bed-only** maps.  
3. **Luna Staff** UI.  
4. **Keep last blocks** on stale/error/malformed/empty.  
5. Calendar colour **yellow**, label **Owner schedule blocked**.

No code until Slice 1 is explicitly assigned. Implementation branch off then-current `github/master`.
