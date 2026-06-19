# SUNSET-PORTAL-SLICE-1-SEED-INPUTS.md

**Purpose:** Planning/support doc — seed inputs and config shapes for the Sunset portal Slice 1 read-only demo.
Cursor/Captain write the implementation. This doc provides only the data shapes they will need.

**Status:** Planning draft. No portal code, Staff API edits, migrations, or production changes.
**Tenant:** `client_slug = sunset` / `tenant_id = sunset`
**Source of truth for prices:** `config/clients/sunset.baseline.json` (all prices carry `pricing_status = unverified_seed`)

---

## 1. Tenant config fields needed for portal gating

These fields drive tenant resolution, tab visibility, and portal guard logic.

```json
{
  "client_slug": "sunset",
  "tenant_id": "sunset",
  "business_name": "Sunset Surf School",
  "vertical": "surf_school_rentals",
  "vertical_note": "Combined surf school + rental shop + partner-hotel accommodation workflow.",
  "timezone": "Europe/Madrid",
  "currency": "EUR",
  "languages": ["en", "es"],

  "portal": {
    "enabled_for_demo": true,
    "demo_mode": true,
    "demo_mode_note": "Staging only. No real bookings, no real Stripe links.",
    "default_tab": "rentals",
    "visible_tabs": [
      "rentals",
      "lessons",
      "conversations",
      "inbox"
    ],
    "hidden_tabs": [
      "packages",
      "accommodation",
      "rooming",
      "bed_calendar",
      "tour_operators"
    ],
    "hidden_tabs_note": "packages/accommodation/rooming/bed_calendar/tour_operators are Wolfhouse-only concepts. Must not appear in Sunset portal. Gating must be driven by client_slug, not hardcoded tab lists in shared portal code.",
    "gating_mechanism": "client_slug_config_driven",
    "staff_access_scope": "sunset_only"
  }
}
```

### 1.1 Tab visibility gating rule

| Tab | Sunset Slice 1 | Wolfhouse | Gate mechanism |
|---|---|---|---|
| `rentals` | ✅ visible | ✅ visible | default |
| `lessons` | ✅ visible | ❌ not applicable | `vertical` includes `lessons` |
| `conversations` | ✅ visible | ✅ visible | default |
| `inbox` | ✅ visible | ✅ visible | default |
| `packages` | ❌ hidden | ✅ visible | absent from `portal.visible_tabs` |
| `accommodation` | ❌ hidden | ✅ visible | absent from `portal.visible_tabs` |
| `rooming` | ❌ hidden | ✅ visible | absent from `portal.visible_tabs` |
| `bed_calendar` | ❌ hidden | ✅ visible | absent from `portal.visible_tabs` |
| `tour_operators` | ❌ hidden | ✅ visible | absent from `portal.visible_tabs` |

**Critical:** tab visibility must be resolved from `client_slug` config at render time, not from a shared enum. A Wolfhouse staff session must never see Sunset data, and vice versa.

---

## 2. Staging-only staff access entry shape

```json
{
  "staff_access_entries": [
    {
      "entry_id": "sunset-demo-staff-001",
      "client_slug": "sunset",
      "tenant_id": "sunset",
      "role": "owner",
      "display_name": "Sunset Demo Owner",
      "email": "demo-owner@sunset-demo.internal",
      "phone": "+34 600 000 001",
      "access_scope": "sunset_only",
      "portal_tabs_allowed": ["rentals", "lessons", "conversations", "inbox"],
      "can_approve_quotes": true,
      "can_confirm_pricing": true,
      "staging_only": true,
      "note": "Staging demo account only. Replace with real owner credentials at deploy time."
    },
    {
      "entry_id": "sunset-demo-staff-002",
      "client_slug": "sunset",
      "tenant_id": "sunset",
      "role": "staff_viewer",
      "display_name": "Sunset Demo Staff",
      "email": "demo-staff@sunset-demo.internal",
      "phone": "+34 600 000 002",
      "access_scope": "sunset_only",
      "portal_tabs_allowed": ["rentals", "lessons", "conversations", "inbox"],
      "can_approve_quotes": false,
      "can_confirm_pricing": false,
      "staging_only": true,
      "note": "Read-only demo staff viewer."
    }
  ],
  "_guard": "No Wolfhouse staff entry may carry access_scope=sunset or vice versa. Scope check must be enforced server-side on every Staff API call."
}
```

---

## 3. Demo WhatsApp conversation examples

Two example conversations for `client_slug = sunset`. These are demo seed only — not live transcripts.

### Conversation A — Rental price inquiry

```
Guest phone:   +34 611 000 101  (placeholder)
Contact name:  Alex
client_slug:   sunset
channel:       whatsapp

Turn 1 — guest:
  "Hi, how much is it to rent a surfboard for one day?"

Turn 1 — Luna (expected demo response shape):
  Greets as Sunset Surf School (not Wolfhouse, not "Luna Front Desk").
  Quotes board rental 1_day = ~€15 (seed, unverified — preview only).
  States price needs owner confirmation before live quoting.
  Asks one next question: e.g. "Are you bringing your own wetsuit or would you like to add one?"

Turn 2 — guest:
  "I'll need a wetsuit too."

Turn 2 — Luna (expected demo response shape):
  Quotes board+wetsuit bundle 1_day = ~€20 (seed, unverified — preview only).
  Notes price is approximate pending owner verification.
  Asks: "What date are you thinking?"

Demo state at end:
  service_type: board_and_suit_rental
  duration:     1_day
  amount_eur:   20  (seed / unverified_seed)
  payment_link: NOT sent (unverified_seed blocks payment link)
  live_send_allowed: false
```

### Conversation B — Lesson inquiry (kids)

```
Guest phone:   +34 611 000 102  (placeholder)
Contact name:  Maria
client_slug:   sunset
channel:       whatsapp

Turn 1 — guest:
  "Hello, do you have surf lessons for children? My son is 8."

Turn 1 — Luna (expected demo response shape):
  Confirms Sunset Surf School runs a Surfpark for younger surfers.
  Notes age range is approx. 6–11 (unverified_seed — says "roughly").
  Does NOT quote a price (kids pricing = null / owner_required in config).
  Asks: "What dates are you planning to visit?"

Turn 2 — guest:
  "We'll be there 5–12 July."

Turn 2 — Luna (expected demo response shape):
  Acknowledges the dates.
  Explains lesson slot times (seed: 11:00–13:00 or 16:00–18:00, unverified).
  Tells guest the team will confirm availability and pricing for the kids session.
  No payment link. Marks for staff handoff / follow-up.

Demo state at end:
  service_type:   group_lesson_kids_surfpark
  guest_age:      8
  dates:          2026-07-05 to 2026-07-12
  price_eur:      null  (owner_required — bot must not invent)
  handoff_needed: true
  live_send_allowed: false
```

---

## 4. Demo booking_service_records (3 records)

These are seed-only records for the demo portal. No real Stripe, no real booking IDs.

### Record 1 — Board rental

```json
{
  "record_id": "demo-sunset-bk-001",
  "client_slug": "sunset",
  "tenant_id": "sunset",
  "service_type": "board_rental",
  "offering_label": "Surfboard rental",
  "guest_name": "Alex García",
  "guest_phone": "+34 611 000 101",
  "date": "2026-07-10",
  "duration": "1_day",
  "amount_eur": 15,
  "pricing_status": "unverified_seed",
  "payment_status": "unpaid",
  "payment_link": null,
  "payment_link_note": "No payment link issued — pricing_status must be confirmed before link is generated.",
  "booking_status": "demo_pending",
  "notes": "Demo record only. Not a real booking.",
  "channel": "whatsapp",
  "source": "demo_seed"
}
```

### Record 2 — Board + wetsuit bundle rental

```json
{
  "record_id": "demo-sunset-bk-002",
  "client_slug": "sunset",
  "tenant_id": "sunset",
  "service_type": "board_and_suit_rental",
  "offering_label": "Board + wetsuit rental (bundle)",
  "guest_name": "Sam Lee",
  "guest_phone": "+34 611 000 103",
  "date": "2026-07-11",
  "duration": "5_days",
  "amount_eur": 65,
  "pricing_status": "unverified_seed",
  "payment_status": "unpaid",
  "payment_link": null,
  "payment_link_note": "No payment link issued — pricing_status must be confirmed before link is generated.",
  "booking_status": "demo_pending",
  "notes": "Demo record only. Not a real booking.",
  "channel": "whatsapp",
  "source": "demo_seed"
}
```

### Record 3 — Adult group surf lesson

```json
{
  "record_id": "demo-sunset-bk-003",
  "client_slug": "sunset",
  "tenant_id": "sunset",
  "service_type": "group_lesson_adult",
  "offering_label": "Adult / adolescent group surf lesson (over 12)",
  "guest_name": "Jordan Taylor",
  "guest_phone": "+34 611 000 104",
  "date": "2026-07-12",
  "slot_time": "11:00-13:00",
  "seats": 2,
  "amount_eur_per_seat": 30,
  "amount_eur_total": 60,
  "pricing_status": "unverified_seed",
  "payment_status": "unpaid",
  "payment_link": null,
  "payment_link_note": "No payment link issued — pricing_status must be confirmed before link is generated.",
  "capacity_check": "not_run",
  "capacity_check_note": "Lesson records require Staff API slot capacity check before confirming seats.",
  "booking_status": "demo_pending",
  "notes": "Demo record only. Not a real booking.",
  "channel": "whatsapp",
  "source": "demo_seed"
}
```

---

## 5. Seeded lesson slot examples (demo only — no schema)

These are illustrative shapes only. No lesson slot schema has been created or migrated.

```
Slot set A — Adult group lesson
  date:          2026-07-10
  slot_time:     11:00–13:00
  session_type:  group_lesson_adult
  capacity:      8 seats     (demo number — owner must confirm real max)
  seats_booked:  3           (demo only)
  seats_available: 5         (demo only)
  price_eur_per_seat: 30     (unverified_seed)
  instructor:    <FILL: owner provides>
  meet_point:    <FILL: owner provides — "Beach entrance / Sunset Surf School tent">
  arrive_before_minutes: 20  (seed from public site — unverified)

Slot set B — Adult group lesson (afternoon)
  date:          2026-07-10
  slot_time:     16:00–18:00
  session_type:  group_lesson_adult
  capacity:      8 seats     (demo number)
  seats_booked:  1
  seats_available: 7
  price_eur_per_seat: 30
  instructor:    <FILL>
  meet_point:    <FILL>
  arrive_before_minutes: 20

Slot set C — Kids Surfpark
  date:          2026-07-11
  slot_time:     11:00–13:00
  session_type:  group_lesson_kids_surfpark
  capacity:      <FILL: owner must confirm>
  price_eur_per_seat: <FILL: owner must confirm — null in config>
  age_range:     approx. 6–11  (unverified_seed)
  instructor:    <FILL>
  guardian_consent_required: <FILL: owner must confirm>
```

---

## 6. Payment / demo status examples (no real Stripe links)

| record_id | service | amount_eur | payment_status | link_issued | reason |
|---|---|---|---|---|---|
| demo-sunset-bk-001 | board_rental / 1_day | €15 | unpaid | NO | pricing_status=unverified_seed |
| demo-sunset-bk-002 | board_and_suit / 5_days | €65 | unpaid | NO | pricing_status=unverified_seed |
| demo-sunset-bk-003 | group_lesson_adult ×2 | €60 | unpaid | NO | pricing_status=unverified_seed + capacity unconfirmed |

**Link generation rule (from config):**
> `payment.safe_default = "do_not_send_payment_link_without_confirmed_deposit_rule_and_pricing_status_confirmed"`

For Slice 1 demo, no payment links exist. Payment link generation requires:
1. `pricing_status = confirmed` (owner-verified price)
2. `payment.deposit_rule` populated (currently `owner_required`)
3. Staff API payment tool gate open (not wired for Slice 1)

Demo payment status vocabulary:
- `unpaid` — no link issued
- `demo_pending` — booking record exists for UI demo; no real hold
- `paid_demo` — hypothetical "what it looks like after payment" — use only in labelled demo fixtures, never in a real flow

---

## 7. Guardrails to prevent Wolfhouse leakage

These must be enforced in portal implementation (for Cursor/Captain reference):

| Guard | Mechanism |
|---|---|
| Staff API calls scoped to sunset | Every request carries `tenant_id=sunset`; server rejects cross-tenant reads |
| Tab visibility from config | `portal.visible_tabs` resolved from `client_slug` at render — no shared tab enum |
| No Wolfhouse package/room/bed UI | `packages`, `accommodation`, `rooming`, `bed_calendar`, `tour_operators` absent from `portal.visible_tabs` for sunset |
| No price quote without `pricing_status=confirmed` | Engine guard from `pricing_policy.on_unverified_seed_in_live = block_do_not_quote` |
| No payment link without confirmed deposit rule | `payment.safe_default` blocks link generation until rule is set and pricing confirmed |
| No Stripe keys shared with Wolfhouse | `deployment.stripe_context_ref` resolves to sunset-specific secret file |
| Demo records are labelled | All seed records carry `"source": "demo_seed"` and `"booking_status": "demo_pending"` |
| Staff access scope enforced | `access_scope = sunset_only` on every staff entry; server rejects scope mismatch |

---

## 8. Verification checklist for Cursor / Captain

Before Slice 1 demo is considered done:

### Config
- [ ] `config/clients/sunset.baseline.json` — `client_slug = sunset`, `tenant_id = sunset`
- [ ] `portal.visible_tabs` present and does not include Wolfhouse-only tabs
- [ ] `portal.demo_mode = true` on staging; `false` enforced on production until owner go-live
- [ ] `deployment.enabled = false` — not live

### Wolfhouse isolation
- [ ] `npm run verify:sunset-all` — 150 PASS / 0 FAIL (all four checks)
- [ ] `npm run verify:luna-all` — unchanged, all Wolfhouse fixtures green
- [ ] No new import of Sunset modules in `scripts/lib/luna-guest-*.js`
- [ ] No Sunset tabs visible in a Wolfhouse staff session

### Portal UI
- [ ] Portal header shows "Sunset Surf School" (not "Wolfhouse")
- [ ] `rentals` tab shows rental records scoped to `client_slug=sunset` only
- [ ] `lessons` tab visible; `packages` / `bed_calendar` / `rooming` tabs absent
- [ ] Demo booking records (bk-001, bk-002, bk-003) render without errors
- [ ] Payment link column shows "not issued" / blank (no real Stripe links)
- [ ] No Wolfhouse guest data visible in any Sunset portal view

### Payment / pricing
- [ ] No payment link generated for any `pricing_status=unverified_seed` record
- [ ] Price display carries a "seed / unverified" indicator in demo mode
- [ ] `pricing_policy.on_unverified_seed_in_live = block_do_not_quote` enforced

### Conversations
- [ ] WhatsApp conversation records scoped to `client_slug=sunset`
- [ ] Demo conversations A and B render in `conversations` tab
- [ ] Luna persona shows as Sunset Surf School (not Wolfhouse / Somo references)

### Staff access
- [ ] Demo staff entries (sunset-demo-staff-001 / 002) can log in on staging
- [ ] `access_scope=sunset_only` enforced — attempting to read Wolfhouse data returns 403
- [ ] Real owner credentials replace demo placeholders before go-live

---

_Doc authored by Deckhand for Skipper/Captain planning review._
_Do not merge, deploy, or wire WhatsApp from any branch based solely on this doc without Captain approval._
