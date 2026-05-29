# Staff Query Assistant Plan (read-only operations Q&A)

**Status:** Plan — docs only (Stage 3x.2c, 2026-05-29). No runtime yet.
**Related:** [`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md) · [`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md) · baseline config `config/clients/wolfhouse-somo.baseline.json` (`staff_queries`) · [`ROADMAP.md`](ROADMAP.md)

---

## Requirement (owner)

Staff should be able to **ask the bot operational questions** about reservations and add-ons, e.g.:

- *"Who has a surfboard today?"*
- *"Who has dinner tonight?"*
- *"Who's arriving today / checking out tomorrow?"*
- *"Which beds are free this weekend?"*
- *"Who still owes a balance?"*
- *"Which rooms need to be cleaned today, and by when?"*

The bot answers from the system's own data and shows a short list.

Only **approved staff numbers** (see *Staff directory & access* below) get answers; anyone else is treated as a guest.

---

## Why this is a low-risk capability

- **Read-only.** No booking, payment, rooming, or voucher mutation. A wrong answer is recoverable; there is no write surface to corrupt.
- **Staff channel only.** Never exposed to guests (it can reveal other guests' data — that is a staff privilege).
- **Reuses data we already collect.** Bookings + rooming today; add-on vouchers once tracked.

It is effectively the safe inverse of the guest bot: the guest bot *acts*; the staff assistant only *reads*.

---

## Safety design — structured intents, not freeform SQL

The bot must **not** generate arbitrary SQL/queries. Instead:

1. LLM maps the staff question → **one of a fixed set of safe, parameterized query intents**.
2. Each intent is a vetted, read-only lookup with typed parameters (date, service type, room, status).
3. If the question doesn't map to a known intent (or is ambiguous) → bot says it can't answer that yet / offers the closest intent. No guessing, no raw query execution.

### Initial safe intent set (proposed)

| Intent | Params | Source | Earliest |
|--------|--------|--------|----------|
| `arrivals_on_date` | date | bookings | Stage 4 |
| `departures_on_date` | date | bookings | Stage 4 |
| `room_occupancy_on_date` | date | bookings + beds | Stage 4 |
| `free_beds_on_range` | start, end | beds + booking_beds | Stage 4 |
| `balance_outstanding` | — | bookings + payments | Stage 4 |
| `guests_with_service_on_date` | service_type, date | guest_service_requests | Stage 4–5 (needs add-on tracking) |
| `service_redemptions_today` | service_type, date | guest_service_requests | Stage 4–5 |
| `rooms_to_clean_on_date` | date | bookings + beds + `operations` times | Stage 4 (needs check-in/out times + cleaning policy) |

"Who has a surfboard today?" → `guests_with_service_on_date(service_type=surfboard, date=today)`.
"Who has dinner tonight?" → `guests_with_service_on_date(service_type=dinner, date=today)`.
"Which rooms need cleaning today?" → `rooms_to_clean_on_date(date=today)`.

---

## Housekeeping intent — how "by when" is derived

`rooms_to_clean_on_date` is computed, not stored:

1. Find every bed/room with a **checkout on the date** (guest leaving → needs cleaning).
2. The **cleaning deadline** for that bed/room = the **next guest's check-in time** for the same bed/room. If a new guest arrives the same day, the deadline is the standard `check_in_time`; if no next guest, use the owner's `no_next_guest_rule` (e.g. end of day / next arrival date).
3. Apply `cleaning_buffer_minutes` and `cleaning_scope` (per-bed changeover vs whole-room daily) from config.

So the answer is a list like: *"R3 (beds B1, B2) — clean by 15:00 (new arrival); R5 (bed B4) — clean by end of day (no arrival)."*

**Owner data this needs** (`operations` block, currently `owner_required`): `check_in_time`, `check_out_time`, `cleaning_scope`, `cleaning_buffer_minutes`, `no_next_guest_rule`.

---

## Staff directory & access (approved numbers)

Every staff-only capability (queries, handoff replies, voucher redemption) is gated by an **allowlist of approved staff phone numbers** (`staff_directory` in config).

| Aspect | Short-term | Future |
|--------|-----------|--------|
| Where the list lives | Config / Airtable allowlist | Postgres `staff` table |
| **Management portal** | Add/edit numbers manually | **Stage 6 Staff UI** — add/remove staff, set roles & permissions |
| Per-staff fields | `name`, `phone`, `role`, `active`, `can_query`, `can_reply_handoff`, `can_redeem_vouchers` | same |
| Unknown number | **Treated as a guest** — no staff privileges, never sees other guests' data | same |

The portal the owner described **is** the Stage 6 Staff UI screen for managing this directory; until then the allowlist is maintained in config/Airtable.

---

## Boundaries (so it stays simple)

- **Read-only forever** on this path. Any *action* a staff member wants (cancel, refund, move a room, redeem a voucher) goes through the explicit staff actions / handoff tools — never inferred from a chat question.
- **No PII beyond what staff already see** in Airtable/Staff UI; same access level.
- **Auth required**: staff identity / staff channel only; reject if not staff.
- **Golden questions**: each intent gets fixture questions so NL→intent mapping is regression-tested (extends §3x.6 golden tests).

---

## Stage placement

| Work | Stage |
|------|-------|
| This plan + config stubs (`staff_queries`, `staff_directory`, `operations`) | **3x.2c (now)** — done |
| Intent list + golden questions (spec) | Stage 3x.3 (with golden tests) |
| Approved-staff allowlist (config/Airtable) gating staff features | Stage 4 |
| Booking/rooming intents (arrivals, occupancy, balance) | Stage 4 (read-only, off existing data) |
| Housekeeping intent (`rooms_to_clean_on_date`) | Stage 4 (needs owner check-in/out times + cleaning policy) |
| Add-on/voucher intents (surfboard/dinner today) | Stage 4–5 (needs add-on tracking from `DURING-STAY-ADDONS-PLAN.md`) |
| Staff management **portal** + rich answers | Stage 6 (Staff UI) |

**Do not** implement runtime until the intent set + auth + golden questions are specified and the underlying data exists for each intent.
