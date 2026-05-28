# Stage 3x — Bot Knowledge + Safety Guardrails

**Status:** **Stage 3x.1 retry — standalone planning doc complete** (docs-only, 2026-05-28)  
**This file is the master spec** for bot knowledge + safety guardrails (§3x.1–3x.11). Related but separate: [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) (bed-ops / reassign inventory).

**Prerequisite:** Stage 3 engineering gates through **3d.9b** — integrated Main → Stripe pay → organic webhook → Send Confirmation dry-run on `WH-260528-5369` ([`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)).

### Standalone checklist (this document)

| # | Topic | Section |
|---|--------|---------|
| 1 | Required field map (hold, pay, confirm, cancel, rooming, date change, quote, book) | §3x.1 |
| 2 | Package explanation + decision flow (Malibu / Uluwatu / Waimea) | §3x.2 |
| 3 | Wolfhouse knowledge — Ale/Cami operational gaps only | §3x.3 + [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) |
| 4 | WhatsApp history mining plan + privacy | §3x.4 |
| 5 | Golden message tests (30–50 fixtures planned) | §3x.6 |
| 6 | Dangerous action gates | §3x.7 |
| 7 | Human handoff rules | §3x.8 |
| 8 | Wrong-booking protection | §3x.9 |
| 9 | Duplicate protection | §3x.10 |
| 10 | Client-config architecture | §3x.11 |

### Purpose

Stage 3x sits **between Stage 3 (Correct and safe)** and **Stage 4 (Reliable)**. It defines the business knowledge, customer memory, package rules, safety gates, and configurable client rules the bot needs before reliability work, cleanup, staff UI, and multi-client scaling.

### What Stage 3x produces

| Output type | Examples |
|-------------|----------|
| Docs + specs | This document, exit criteria, gate matrices |
| Fixtures | 30–50 golden guest messages (schema + samples) |
| Client-config design | `config/clients/wolfhouse-somo.json` *(planned)* |
| Owner question lists | [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) |
| Mining plan | WhatsApp history → anonymized knowledge + customer memory |

### What Stage 3x does not do

- Huge expansion of n8n IF nodes for business rules  
- Runtime code, workflow JSON, DB migrations, WhatsApp import, or processing real customer data  
- Full backend (`src/booking-assistant/`), staff UI, or multi-client SaaS  

**Non-goals (this stage):** Workflow activation, Postgres/Airtable/Stripe mutations, golden-message **runner** implementation (Stage 4).

**Architecture principle:**

| Layer | Role |
|-------|------|
| n8n | Orchestrates (webhooks, WhatsApp, Stripe, schedules) |
| Backend / code | Decides (route, fields, packages, guards, handoff) — **Stage 5** |
| Postgres | Remembers (bookings, payments, conversations, beds) |
| Client config | Controls (packages, policies, tone per property) — **Wolfhouse = client #1** |
| Staff UI | Manages (Stage 6+) |

**Evolution order:** Correct and safe → Reliable → Clean → Beautiful → Scalable ([`ROADMAP.md`](ROADMAP.md)).

### Client category (positioning)

**Category:** AI booking operations for WhatsApp-first experience businesses (*AI front desk* in plain language). **Beachhead:** Wolfhouse (surf house). **Engine:** same assistant for surf schools, rental shops, tour operators, etc. via `client_config` — not a surf-house-only chatbot. Full positioning: [`ROADMAP.md` § Client category](ROADMAP.md#client-category--market-positioning).

---

## Deliverables map

| § | Topic | Deliverable | When enforced |
|---|--------|-------------|---------------|
| 3x.1 | Required field map | Matrix below + per-action tables | Stage 5 code |
| 3x.2 | Package explanation + decision flow | Decision tree + owner confirmations | Stage 5 `packageDecision.ts` |
| 3x.3 | Wolfhouse knowledge collection | [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) | Config + prompts |
| 3x.4 | WhatsApp history mining | Mining plan; redacted samples off-repo | Stage 3x.3 execution |
| 3x.5 | Customer memory + migration | Layered model; table spec | Stage 5–6 schema/import |
| 3x.6 | Golden message tests | `docs/fixtures/golden-messages/` | Stage 4 runner |
| 3x.7 | Dangerous action gates | Proof matrix | Stage 4 monitors + Stage 5 |
| 3x.8 | Human handoff rules | Trigger list + staff payload | Stage 5 `handoffRules.ts` |
| 3x.9 | Wrong-booking protection | Resolver rules + test scenarios | Stage 4–5 |
| 3x.10 | Duplicate protection | Idempotency rules + test scenarios | Stage 4–5 |
| 3x.11 | Client-config architecture | `config/clients/*.json` + module layout | Stage 5–7 |
| — | **Exit criteria** | § [Stage 3x exit criteria](#stage-3x-exit-criteria) | Before Stage 4 start |

---

## 3x.1 — Required field map

Fields are **minimum** inputs the decision engine must have (from message + conversation + Postgres) before calling a dangerous workflow or sending a payment/confirmation message. “Unknown” = ask guest or hand off to staff — never guess on price, policy, or booking identity.

### Legend

| Symbol | Meaning |
|--------|---------|
| **R** | Required |
| **C** | Required if applicable (conditional) |
| **S** | Staff-only or staff-approved |
| **PG** | Must match Postgres truth |
| **AT** | May mirror Airtable during migration |

### Create booking hold (`booking_flow`)

| Field | R/C | Source | Notes |
|-------|-----|--------|-------|
| `client_id` / slug | R | Config | `wolfhouse-somo` for Wolfhouse |
| Guest phone (E.164) | R | WhatsApp | Conversation key |
| Check-in date | R | Message / context | Validated against availability |
| Check-out date | R | Message / context | Or derive from package nights if fixed |
| Guest count | R | Message | Adults; note children separately if policy differs |
| Package intent | R | Message or clarify | `malibu` / `uluwatu` / `waimea` / accommodation-only / unknown → clarify |
| Availability OK | R | PG SQL | Main availability gate (proven 3c.e) |
| Guest name | C | Message | Helpful early; not always blocking hold |
| Email | C | Message | Often collected before payment, not always at hold |
| Surf level / rooming hints | C | Message | Store in session; do not assign beds at hold |
| Language | C | Conversation AT/PG | Default `en` if missing |
| `wamid` / inbound id | R | WhatsApp | Duplicate protection (3x.9) |
| No terminal booking reuse | R | PG + resolver | Block `confirmed` / `cancelled` rows for new hold without staff |

**Safe action if missing:** Ask one focused clarification (dates, count, package type) or hand off if guest wants custom/ambiguous package.

### Send payment link (`payment_details_provided` → CPS)

| Field | R/C | Source | Notes |
|-------|-----|--------|-------|
| `booking_id` (UUID) | R | PG | Must match `conversation.current_hold_booking_id` (3x.8) |
| `booking_code` | R | PG | Human-readable cross-check |
| Hold status | R | PG | `hold` or promoted `payment_pending` per Ensure contract |
| Guest name | R | Message / PG | CPS / Stripe customer |
| Guest email | R | Message / PG | Stripe receipt |
| `payment_kind` | R | Config + PG | e.g. `deposit_only` (proven 3d.7b) |
| Deposit amount / rule | R | Config | `STRIPE_DEFAULT_DEPOSIT_CENTS` or package rule — **must be config, not LLM** |
| Package code | R | PG | Drives line items when multi-package pricing exists |
| Check-in / check-out | R | PG | Must match hold |
| Not `confirmed` / not terminal | R | PG | Hard stop |
| CPS idempotency key | R | System | Same booking + kind → reuse open session if valid (3x.9) |
| Real CPS URL env | R | Ops | Not stub URL (3d.7a lesson) |

**Safe action if missing:** Prompt for email/name; never invent deposit amount.

### Confirm booking (Send Confirmation)

| Field | R/C | Source | Notes |
|-------|-----|--------|-------|
| `booking_id` | R | PG | Webhook filter or schedule poll |
| `send_confirmation` | R | PG | `true` (set by webhook) |
| `status` | R | PG | `payment_pending` at gate |
| `payment_status` | R | PG | `deposit_paid` or `paid` |
| `confirmation_sent_at` | R | PG | Must be NULL |
| Payment truth | R | PG | `payments.status=paid`; `payment_events` processed |
| Phone | R | PG | WhatsApp destination |
| WhatsApp send proof | R | Runtime | `whatsapp_sent=true` before mark confirmed (proven 3d.6/3d.9 dry-run) |
| `WHATSAPP_DRY_RUN` | C | Env | Test windows: must be `true` unless real-send gate approved |

**Not required for confirmation:** `booking_beds` > 0 (proven 3d.9b with 0 beds).

### Cancel booking

| Field | R/C | Source | Notes |
|-------|-----|--------|-------|
| `booking_id` / code | R | PG + context | Must not be wrong booking (3x.8) |
| Cancellation intent | R | Message | Explicit guest or staff |
| Policy window | R | Config | Refund % / forfeit — **staff config, not LLM** |
| Payment state | R | PG | Paid vs unpaid paths differ |
| Bed rows | C | PG | Cancel-beds workflow if assigned |
| Staff approval | S | Handoff | Disputes, partial refunds, ambiguous timing |

### Room / bed assignment

| Field | R/C | Source | Notes |
|-------|-----|--------|-------|
| `booking_id` | R | PG | Confirmed or policy-allowed pre-assign |
| Guest count | R | PG | Matches beds needed |
| Gender / couple / group type | R/C | Message + PG | Rooming rules (3x.3) |
| Date range | R | PG | Assignment start/end |
| Available beds | R | PG / AT | Capacity check |
| Reassign local URL | R | Ops | Hosted URL blocked until remap (Stage 3 residual) |

### Date change

| Field | R/C | Source | Notes |
|-------|-----|--------|-------|
| `booking_id` | R | PG | |
| New check-in / check-out | R | Message | |
| Availability | R | PG SQL | |
| Policy (fee, blackout) | R | Config | |
| Payment impact | C | PG | May require new session or staff |
| Staff approval | S | Handoff | Conflicts, paid booking, package night constraints |

### Package quote (informational)

| Field | R/C | Source | Notes |
|-------|-----|--------|-------|
| Package code or intent | R | Message / clarify | |
| Dates or season | R | Message | |
| Guest count | R | Message | |
| Price source | R | Config | **No quote without config row** |
| Nights assumption | R | Config | See 3x.2 (7-night default TBD with owners) |

### Package booking (hold + payment path)

All **hold** fields plus **payment link** fields when guest ready to pay; package-specific inclusions must be confirmed in config (lessons, meals, transfers).

### Required field matrix (summary)

| Action | Must have before proceed |
|--------|--------------------------|
| **Create hold** | Check-in, check-out, guest count, package or accommodation intent, phone/conversation id, availability OK; room preference if stated |
| **Send payment link** | Active current hold linked to conversation, guest name, email, package/payment type, deposit amount, payment kind, non-terminal booking |
| **Confirm booking** | Payment truth (Stripe/webhook), `payment_pending`, `deposit_paid`/`paid`, `send_confirmation=true`, `confirmation_sent_at` NULL, WhatsApp send evidence |
| **Cancel booking** | Explicit intent, matched booking, policy known, payment/refund checked, staff if ambiguous |
| **Room/bed assignment** | Exact booking, guest count, dates, room preference, group type, gender mix if needed, availability, rooming rules, no terminal conflict |
| **Date change** | Exact booking, new dates, availability, price/payment impact, staff rules if needed |
| **Package quote** | Package intent, dates, guest count, config price source — **no invented price** |

---

## 3x.2 — Package explanation + decision flow

### Public website baseline (do not re-ask Ale/Cami to restate)

Wolfhouse Somo public marketing describes surf-house packages named after surf spots. Guests may refer to them by name:

| Package (public name) | Bot may explain at high level |
|----------------------|------------------------------|
| **Malibu** | Entry / beginner-friendly surf package positioning (lessons + camp structure) |
| **Uluwatu** | Intermediate package positioning |
| **Waimea** | Advanced / experienced surfer positioning |

The bot should use the **website** (and repo reference [`package-pricing.md`](package-pricing.md) for **seasonal weekly rates + proration rules**) as the first source for “what is Malibu vs Uluwatu vs Waimea” in guest-friendly language. Link or summarize from official copy when appropriate; do not invent inclusions.

**Do not ask Ale/Cami** to re-explain public website marketing for these three names unless correcting or updating 2026 operational config.

**Accommodation-only** guests: bot must distinguish “I only need a bed” vs full surf packages (see decision tree below).

### Still needs owner confirmation (config, not LLM invention)

| Topic | Why |
|-------|-----|
| Package names valid for **2026** season | Marketing names may change |
| **2026 prices** per package, season, guest count | Stripe line items must come from config |
| What each package is **best for** (beyond public blurbs) | Ops nuance |
| Accommodation-only rules | Deposit, min nights, room type |
| **Always 7 nights?** | Affects date parsing and quotes |
| **Custom stays / packages** allowed? | Handoff vs automated hold |
| Lessons / rentals **sold separately**? | Upsell path |
| Recommendations: beginner, experienced, cheapest, all-inclusive | Map to package codes in config |
| When to **hand off** package questions to staff | Discounts, exceptions, groups > N |

### Package decision flow (target behavior)

```text
Guest message
  → extract intent (book / quote / compare / pay / cancel / rooming / unclear)
  → if "what packages" → explain Malibu / Uluwatu / Waimea from website-level facts
  → if booking intent and package missing
        → ask: surf package (which level?) OR accommodation only
  → if guest unsure
        → recommend by goal:
              cheapest → accommodation-only (if allowed) or lowest-tier package
              beginner → Malibu
              already surfs / no lessons needed → accommodation + rentals path OR Waimea per staff rules
              "everything included" → clarify what "included" means; likely Uluwatu/Waimea + handoff if unclear
  → if price question
        → require dates + guest count + package + price from config
        → else: "I can confirm exact price once I have your dates and package" (no invented EUR amount)
  → if custom/discount/group
        → handoff (§3x.8)
```

### Bot must not

- Quote exact EUR/USD without config-backed calculation.
- Promise room numbers before assignment workflow.
- Confirm lesson schedule details not in config.
- Treat `custom` package as bookable without staff rules.

---

## 3x.3 — Wolfhouse knowledge collection (Ale/Cami gaps only)

**Maintain answers in:** [`docs/knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) (checkbox questionnaire for owners).

**Rule:** Questionnaire covers **operational gaps only** — not public website copy (Malibu / Uluwatu / Waimea marketing, general surf-house description).

### Concise Ale/Cami question list (operational gaps)

**Package + pricing rules**

- Confirm Malibu / Uluwatu / Waimea valid for **2026** (renames?).
- Confirm or correct **2026 price table** vs [`package-pricing.md`](package-pricing.md) (season months, weekly EUR, proration).
- What each package is **best for** beyond website blurbs (beginner / intermediate / advanced / “cheapest” / “all-inclusive”).
- **Accommodation-only:** allowed? min nights? deposit? what is included/excluded?
- Are packages **always 7 nights** or flexible? How should bot parse shorter stays?
- **Custom stays / packages:** allowed? who approves? bot hold or handoff only?
- **Lessons / rentals / board / wetsuit:** bundled in packages vs sold separately — prices and who books?

**Deposit + payment**

- Production **deposit** rule (fixed EUR, per person, per package).
- **Payment deadline** after link sent; reminders?
- **Hold expiry** (hours/days); auto-cancel?
- **Balance** payment: when due, how collected, bot vs staff.

**Cancellation + refund**

- Guest-cancel **windows** and refund % (deposit vs balance).
- **No-show** policy.
- **Date-change** fees vs free window.

**Rooming rules**

- **Gender** dorm rules; female-only / male-only requests.
- **Couple** private room; **friends** same room; **families**.
- Max **group size** before manual assignment.
- When **rooming/reassign** must be staff-only.

**Surf level**

- Should bot **collect** surf level or staff only? Allowed values?

**Extras + operations**

- **Board / wetsuit rental:** info-only vs bookable?
- **Breakfast / meals** per package — confirmation wording.
- **Airport transfer:** bookable vs info-only; logistics partners.

**Staff handoff**

- When bot must **stop** (hours, channel to ping Cami/Ale).
- Phrases that mean **staff takeover**.
- May bot send **payment link** without staff review for standard packages?

**Tone + language**

- Formality, **languages**, emoji, “WolfHouse Family” phrasing rules.

**Customer memory** (see §3x.5)

- Returning-guest recognition OK? Retention? Staff-only notes? Marketing opt-in?

**Emergency**

- Mandatory **handoff script** for injury, legal, medical, safety.

---

## 3x.4 — WhatsApp history mining plan

### Purpose

Use **real** Cami/Ale ↔ guest WhatsApp threads (export or sanctioned copy) to learn how the business actually operates.

**Inputs:** exported history · representative threads · package questions · booking requests · payment questions · cancellations · rooming · repeat guests · edge cases.

**Dual outputs** (see §3x.5):

| Output | Use |
|--------|-----|
| **A — Anonymized bot knowledge** | Golden fixtures, tone, package phrasing, FAQ gaps (safe for repo/tests) |
| **B — Structured customer memory** | Returning-guest recognition and operational prefs (PG, client-scoped) |

Do **not** treat “export WhatsApp → dump into LLM context forever” as the design. Extraction uses the **three-layer model** in §3x.5.

### Privacy rule (mandatory before upload or analysis)

Anonymize or redact:

- Guest names → `Guest_A`, `Guest_B`, …
- Phone numbers → `+353000000001`, …
- Emails → `guest001@example.test`
- Payment links / Stripe URLs / session ids
- Physical addresses, passport/ID, medical details
- Staff personal numbers (replace with `Staff_Cami`, `Staff_Ale`)

Store raw exports **outside git**; only redacted extracts in `docs/knowledge/whatsapp-samples/` if committed.

### Inputs

| Source | Owner | Format |
|--------|-------|--------|
| Cami guest threads | Cami | WhatsApp export `.txt` or approved tool |
| Ale guest threads | Ale | Same |
| Optional: staff group “how we reply” examples | Both | Redacted snippets |

### Processing steps (docs + offline scripts later — not Stage 3x.1 runtime)

1. **Ingest** — convert export to normalized JSONL: `{ timestamp, direction, text, thread_id }`.
2. **Cluster** — embed or keyword-cluster into intents: book, package, pay, paid, cancel, room, dates, rental, transfer, complaint, handoff.
3. **Extract patterns** — per cluster: typical guest phrasing, staff reply template, fields asked, time-to-payment-link.
4. **Gap analysis** — compare clusters to §3x.1 required fields and §3x.2 package flow; list missing config rules.
5. **Golden candidates** — pick 30–50 guest lines → §3x.6 fixtures with expected route/action.
6. **Tone guide** — short “do / don’t” from Cami/Ale samples for `client_config.language/tone`.
7. **Customer extract** — phone-keyed facts → Layer 2 draft (staff review).
8. **Owner review** — Ale/Cami validate only **true gaps** → `wolfhouse-somo-gaps.md`.

### Expected outputs

| Output | Destination |
|--------|-------------|
| Common guest questions | §3x.6 categories + FAQ |
| Package explanation patterns | §3x.2 + `packages[].guest_description` |
| Required fields Cami/Ale actually ask | §3x.1 refinements |
| Tone / payment-link / confirmation wording | `client_config` templates |
| Handoff cases | §3x.8 |
| FAQ gaps | `wolfhouse-somo-gaps.md` |
| 30–50 golden messages | `docs/fixtures/golden-messages/*.json` |
| Shortened Ale/Cami question list | Only true gaps remain in gaps doc |

**Storage rule:** Raw WhatsApp history stays **off-repo** unless intentionally sanitized (`docs/knowledge/whatsapp-samples/`).

### Success criteria

- ≥80% of golden fixtures sourced from real (redacted) threads or labeled synthetic edge cases.
- Zero PII in repo.
- Owner sign-off on tone + handoff list before Stage 4 runner uses fixtures.

---

## 3x.5 — Customer memory + WhatsApp history migration

### Purpose

Turn historical WhatsApp conversations into **two useful, separable outputs** — not a single “paste chat into the bot” memory blob.

| Output | Audience | Lifetime |
|--------|----------|----------|
| **A — Anonymized bot knowledge** | Engineers, tests, config authors | Long (fixtures, docs) — Layer 3 |
| **B — Structured customer memory** | Bot + staff ops (returning guests) | Long (PG), scoped per `client_id` — Layer 2 |

**Product decision:** WhatsApp history may inform **returning-guest recognition** when owners approve ([`wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)). Default: **not** raw chat as permanent bot memory.

### Layer 1 — Raw import archive

- Temporary · restricted access · migration/mining only  
- Deleted or archived after structured extraction when possible  

### Layer 2 — Structured customer facts

Longer-term operational memory. Possible fields:

`customer_id` · `client_id` / `client_slug` · `phone` · `name` · `email` · `preferred_language` · `first_seen_at` · `last_seen_at` · `returning_guest` · `surf_level` · `preferred_package` · `room_preference` · `group_type` · `special_requests` · `staff_notes` · `marketing_opt_in` · `data_source` · `last_booking_id`

Proposed tables (spec only): `customers` · `customer_booking_history` · `conversation_summaries` · `customer_preferences` · `customer_notes` · `privacy_requests`

### Layer 3 — Anonymized bot knowledge

Golden-message tests · FAQ examples · package explanation examples · handoff examples · tone examples (§3x.6).

### Safety / privacy rules

- Store only useful operational facts  
- Do not store raw chat forever by default  
- No passport/ID/medical/private details unless explicitly scoped  
- Do not expose `staff_notes` to guests  
- Tag facts with source + timestamp  
- Support future delete/export/correction  
- `marketing_opt_in` separate from booking support  

### Relationship to §3x.4

Single import pipeline, **dual extractors:** knowledge → Layer 3; customer → Layer 2 (staff review if uncertain).

**Hard stop:** No DB migrations or real imports in planning-only gates.

---

## 3x.6 — Golden message tests (plan)

**Target:** 30–50 fixtures. **Stage 3x.1** defines schema + representative samples; full set completed after §3x.4 mining and Ale/Cami gaps.

### Fixture schema (each case)

```json
{
  "id": "GM-001",
  "client_id": "wolfhouse-somo",
  "guest_message": "...",
  "conversation_context": {
    "current_hold_booking_id": null,
    "language": "en",
    "prior_route": null,
    "returning_guest": false
  },
  "expected": {
    "resolved_route": "booking_flow",
    "missing_fields": ["check_in", "check_out", "guest_count"],
    "safe_action": "ask_clarification",
    "clarification_question_pattern": "dates_and_pax",
    "handoff": false,
    "must_not": ["send_payment_link", "confirm_booking", "create_checkout", "assign_beds"]
  }
}
```

### Categories (count target)

| Category | Target count | Notes |
|----------|--------------|-------|
| Booking request (new) | 6–8 | Missing dates, count, package |
| Package compare / “which package” | 5–6 | Malibu vs Uluwatu vs Waimea |
| Accommodation only | 3–4 | |
| Payment link request | 4–5 | With/without hold |
| “I paid” / payment claim | 4–5 | With/without PG payment row |
| Cancellation | 3–4 | |
| Room preference / gender / couple | 5–6 | |
| Date change | 3–4 | |
| Rentals (board/wetsuit) | 2–3 | |
| Breakfast / transfer | 2–3 | |
| Unclear / low confidence | 4–5 | Handoff |
| Angry guest / complaint | 2–3 | Handoff |
| Discount / custom package | 2–3 | Handoff |
| Returning guest | 3–4 | Memory-aware greeting; no wrong hold |
| Duplicate / repeat message | 2–3 | §3x.10 |

### Planned fixtures (35 — expand to 50 after §3x.4 mining)

Each row: **route** · **missing fields** · **safe action** · **clarification / handoff**. Full JSON in `docs/fixtures/golden-messages/` *(Stage 3x.3 — not committed until redacted)*.

| ID | Guest message (excerpt) | Route | Missing / safe action | Handoff? |
|----|-------------------------|-------|------------------------|----------|
| GM-001 | “Hi we want to book surf camp July 10” | `booking_flow` | `check_out`, `guest_count`, package; ask | no |
| GM-002 | “2 people 14–21 July Malibu” | `booking_flow` | availability; hold if OK | no |
| GM-003 | “Book for next week” | `booking_flow` | exact dates; ask | no |
| GM-004 | “We need beds Aug 1–8, 3 guests” | `booking_flow` | package vs accommodation-only | no |
| GM-005 | “Same dates as last year” (returning) | `booking_flow` | dates from memory or ask; verify hold | maybe |
| GM-006 | “Book under my friend’s name” | `booking_flow` | clarify booker phone/hold; wrong-booking guard | maybe |
| GM-007 | Duplicate: same text twice (same `wamid`) | `duplicate` | no second hold | no |
| GM-010 | “What packages do you have?” | `package_info` | explain Malibu/Uluwatu/Waimea; no invented price | no |
| GM-011 | “Difference Malibu and Waimea?” | `package_info` | explain; no price without dates+pax | no |
| GM-012 | “Which package for beginner?” | `package_info` | recommend Malibu per config; handoff if custom | no |
| GM-013 | “Cheapest option?” | `package_info` | accommodation-only or Malibu per config | no |
| GM-014 | “All inclusive what do you mean?” | `package_info` | clarify inclusions; handoff if unclear | maybe |
| GM-015 | “Just a bed no lessons 5 nights” | `booking_flow` | accommodation-only rules; dates | no |
| GM-016 | “Price for Uluwatu 10 nights 2 ppl July” | `package_quote` | quote from config if dates valid | no |
| GM-017 | “How much?” (no dates) | `package_quote` | ask dates + pax + package | no |
| GM-018 | “Custom 10-day coaching package” | `package_info` | handoff — custom | **yes** |
| GM-019 | “Group of 12 friends” | `booking_flow` | handoff or split rules | **yes** |
| GM-020 | “Send payment link” (hold + email) | `payment_details_provided` | CPS if guards pass | no |
| GM-021 | “Send payment link” (no hold) | `payment_details_provided` | create hold first or ask dates | no |
| GM-022 | “Send link again” (open checkout) | `payment_details_provided` | reuse session (3x.10); no duplicate PI | no |
| GM-023 | “Here is my email name@…” | `payment_details_provided` | stage email; then link | no |
| GM-024 | “Pay deposit” (confirmed booking) | `payment_details_provided` | block terminal; handoff | **yes** |
| GM-025 | “I paid yesterday” (no PG payment) | `payment_claim` | check Stripe; never confirm from text | **yes** |
| GM-026 | “Paid on Stripe” (payment exists) | `payment_claim` | explain processing; no double confirm | no |
| GM-027 | “Wrong amount charged” | `payment_dispute` | handoff | **yes** |
| GM-030 | “Cancel my booking WH-2605…” | `cancel_intent` | policy; cancel workflow if clear | no |
| GM-031 | “Cancel please” (two active holds) | `cancel_intent` | handoff — ambiguous booking | **yes** |
| GM-032 | “Refund my deposit” | `cancel_intent` | handoff — refund policy | **yes** |
| GM-035 | “Girls only room please” | `rooming_details_provided` | store preference; reassign only when gated | no |
| GM-036 | “Male dorm only” | `rooming_details_provided` | store; config rules | no |
| GM-037 | “We’re a couple private room” | `rooming_details_provided` | couple rules; handoff if no private avail | maybe |
| GM-038 | “Friends want same room, 4 of us” | `rooming_details_provided` | stay_together; guest count | no |
| GM-039 | “Don’t put us with strangers” | `rooming_details_provided` | clarify private vs shared | no |
| GM-040 | “Change to Aug 1–8” | `date_change` | new dates; availability | no |
| GM-041 | “Extend one night” | `date_change` | availability; payment impact | maybe |
| GM-042 | “Move dates” (confirmed + paid) | `date_change` | staff approval | **yes** |
| GM-043 | “Can I rent a surfboard?” | `extras_info` | info or handoff per config | maybe |
| GM-044 | “Wetsuit rental for 3 days” | `extras_info` | info-only unless bookable | maybe |
| GM-045 | “Is breakfast included?” | `package_info` | package inclusions from config | no |
| GM-046 | “Airport pickup?” | `extras_info` | transfer rules | maybe |
| GM-047 | “?” / sticker only | `unclear` | clarify once; then handoff | maybe |
| GM-048 | “You suck / worst hostel” | `complaint` | handoff; empathetic ack | **yes** |
| GM-049 | “I need a doctor” | `emergency` | handoff immediately | **yes** |
| GM-050 | “10% discount?” | `custom_offer` | handoff | **yes** |

**Runner:** Stage 4 — `npm run test:golden-messages` against decision engine stub (not n8n live).

---

## 3x.7 — Dangerous action gates

Strict proof required before side effects. **Guest text alone never marks paid.**

### Payment link

Requires: active current hold · correct booking linked to conversation · guest name · email · payment amount · payment kind · booking not terminal · CPS idempotency. *(Proven: 3d.7b)*

### Confirmation

Requires: payment truth from Stripe/webhook · `send_confirmation=true` · `confirmation_sent_at` NULL · `payment_pending` + `deposit_paid`/`paid` · successful WhatsApp dry-run or real send · correct booking. *(Proven: 3d.6, 3d.9b dry-run)*

### Cancellation

Requires: explicit cancellation intent · exact booking match · cancellation policy known · refund/payment status checked · handoff if unclear.

### Room / bed change

Requires: exact booking · availability · current assignment known · no double-booking · rooming rules · staff approval if risky.

### Date change

Requires: exact booking · new dates · availability · price/payment impact · staff approval if needed.

### Payment-state change

**Bot must not** set `paid` from guest message. Guest says “I paid” → check `payments` / `payment_events`; if not found → handoff or explain verification in progress (§3x.8).

**Global hard stops:** `sk_live`; wrong workflow active; `payment_events` duplicate; terminal booking mutation; multiple confirmations.

---

## 3x.8 — Human handoff rules

Bot **must stop guessing** and alert staff when:

| Always hand off |
|-----------------|
| Refund request · complaint / angry guest · legal / medical / emergency |
| Multiple active holds · guest says paid but no payment record |
| Cancellation ambiguity · rooming / reassign uncertainty |
| Custom package · discount request · overbooking risk |
| Low confidence · conflicting dates or guest count |
| Policy not in `client_config` · Stripe paid but PG not updated |

**Handoff payload (target):** guest phone · latest message · `booking_id` if known · current stage/route · why handoff triggered · suggested next staff action.

**Guest-facing pattern:** Acknowledge; “Cami/Ale will reply shortly”; **do not** promise refund, room, or price.

---

## 3x.9 — Wrong-booking protection

Formalize rules observed in Main resolver + 3c.g / 3d.7:

| Rule | Enforcement target |
|------|-------------------|
| `conversation.current_hold_booking_id` **wins** over phone-only search | `Code - Pick Active Booking`, Ensure, CPS body |
| Terminal bookings (`confirmed`, `cancelled`, `expired`) **not** promotable or payable by guest path | Ensure SQL + resolver |
| Old holds with same phone **not** selected when conversation points to newer hold | Search Hold + PG updated_at |
| Active booking must match **latest intent** (payment vs new trip) | Session state + explicit “new booking” |
| Disposable evidence bookings **blocked** from automated tests without reset | Runbook labels (`WH-260528-5369`, `WH-260528-1493`) |
| Airtable record id from POST #1 must match POST #2 | 3d.7b evidence |

**Failure mode to prevent:** Guest says “pay for my booking” → bot attaches to stranger’s open hold with same phone.

**Rules:**

- `conversation.current_hold_booking_id` wins over phone fallback.
- Current active booking wins over old holds.
- Terminal bookings cannot be modified by guest path.
- Phone search is **fallback only**.
- If multiple active bookings → hand off.
- Updates must include `booking_id` or verified current hold — **never** name/email alone.

**Test scenarios:** old hold same phone · confirmed booking same phone · two active holds same phone · returning guest with old booking · payment link after old checkout.

---

## 3x.10 — Duplicate protection

| Scenario | Expected behavior | Stage 3 evidence |
|----------|-------------------|------------------|
| Same WhatsApp `wamid` / message id | No second hold; idempotent ingest | Typing guard + inbound dedup *(verify in 3x.2)* |
| Repeated “send payment link” | Reuse open `checkout_created` session if valid | CPS LATERAL reuse SQL |
| Same Stripe `event.id` | Single `payment_events` row | 3d.5b, 3d.8b organic burst → 1 row |
| Same `payment_intent` | Unique partial index (migration 005) | DB |
| Confirmation twice | `confirmation_sent_at` set; `send_confirmation=false` after first | 3d.9b |
| Schedule poll + webhook double-fire | Idempotent mark confirmed SQL | Send Confirmation RETURNING clause |
| Repeated booking request | No duplicate hold unless explicit new trip | *(verify wamid dedup)* |
| Cancellation twice | Idempotent cancel | *pending* |
| Room reassignment twice | No double-move beds | *pending* |

**Test scenarios:** duplicate `wamid` · repeated payment-link message · replayed Stripe event · repeated Send Confirmation webhook · retry after timeout · user sends same message twice manually.

**Stage 4:** automated tests for each row; chaos test duplicate webhook burst (3d.8 operational finding).

---

## 3x.11 — Client-config architecture plan

**Core idea:** One booking-assistant **engine** for WhatsApp-first experience businesses; many **clients** via config keyed by `client_slug` (`wolfhouse-somo` = client #1 beachhead). Adjacent verticals (surf school, rental shop, tours) reuse the engine with different packages, inventory, and rooming rules — see [`ROADMAP.md` § Client category](ROADMAP.md#client-category--market-positioning).

### Config storage (evolution)

| Phase | Storage |
|-------|---------|
| Stage 3x | Docs + JSON fixtures in `config/clients/wolfhouse-somo.json` *(planned path)* |
| Stage 5 | `client_config` module loads JSON/YAML; validated schema |
| Stage 7 | Postgres `clients` + `client_config` JSONB; admin UI |

### Config categories

```text
client_config
  meta: { slug, name, timezone, default_language }
  packages[]: { code, display_name, nights_default, inclusions[], deposit_rule, stripe_price_map }
  accommodation_only: { enabled, min_nights, deposit_rule }
  pricing: { seasons[], currency, rounding }
  payment_rules: { deposit_cents, payment_deadline_hours, hold_expiry_hours }
  cancellation_policy: { tiers[] }
  rooming_rules: { gendered_dorms, couples, groups, family }
  required_fields: { per_route overrides }
  handoff_rules: { triggers[], staff_notify }
  language_tone: { formality, emoji, templates }
  integrations: { stripe, whatsapp, webhook_paths }
  staff_notification_rules: { channels, severity, hours }
  customer_memory_policy: { retention, fields_allowed, returning_guest_rules }
```

### Engine API (Stage 5 target)

```text
resolveMessage(ctx) → { route, missingFields, handoff, safeAction }
canSendPaymentLink(ctx) → { ok, reason }
canConfirmBooking(ctx) → { ok, reason }
explainPackage(code, language) → { text, needsStaff }
```

n8n calls these endpoints instead of growing inline Code node policy.

### Multi-client onboarding (Stage 7)

- New surf house = new config file + `client_id` + isolated PG rows.
- Workflows remain generic; **no** Wolfhouse-only package names in shared workflow JSON.

### Do now (Stage 3x)

- Write config specs and rules · collect Wolfhouse knowledge · plan WhatsApp mining · create fixtures · avoid hardcoding Wolfhouse-only assumptions in shared engine design.

### Do not build now (later stages)

- Full multi-client SaaS · client onboarding UI · billing/subscription · settings editor · full staff dashboard · PMS connector platform.

### Future code structure (Stage 5 target)

```text
src/booking-assistant/
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  packageDecision.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  customerMemory.ts
```

**Future config path:** `config/clients/wolfhouse-somo.json`

---

## Stage 3x exit criteria

Stage 3x is **complete** when all of the following exist as reviewed docs/specs (implementation may follow in Stages 4–5):

| # | Criterion |
|---|-----------|
| 1 | Required field map (§3x.1 + matrix) |
| 2 | Package decision flow (§3x.2) |
| 3 | Wolfhouse gaps/questions documented ([`wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)) |
| 4 | WhatsApp mining plan (§3x.4) |
| 5 | Customer memory + migration plan (§3x.5) |
| 6 | Golden-message fixture **schema** + category plan (§3x.6); 30–50 fixtures may fill in 3x.3 |
| 7 | Dangerous action gates documented (§3x.7) |
| 8 | Human handoff rules documented (§3x.8) |
| 9 | Wrong-booking protection documented (§3x.9) |
| 10 | Duplicate protection documented (§3x.10) |
| 11 | Client-config architecture plan (§3x.11) |

**Stage 3x does not require:** full backend implementation · staff UI · multi-client SaaS · moving logic out of n8n yet.

**Stage 4 may start when:** exit criteria met + owner critical gaps (pricing, cancellation, rooming) have draft config or explicit “hand off” defaults.

---

## Stage 3x sub-phase roadmap

| Sub-phase | Scope | Status |
|-----------|--------|--------|
| **3x.1** | Full roadmap spec §3x.1–3x.11 + exit criteria | **Done** |
| **3x.1b** | Customer memory layered model (§3x.5) | **Done** |
| **3x.2** | Ale/Cami answers + draft `wolfhouse-somo.json` | Planned |
| **3x.3** | WhatsApp mining + golden fixtures + customer extract review | Planned |
| **3x.4** | Golden runner stub + Stage 4 reliability hooks | Planned |

---

## References

- [`ROADMAP.md`](ROADMAP.md) — stage order
- [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) — orchestration principle
- [`PROJECT-STATE.md`](PROJECT-STATE.md) — execution snapshot
- [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) — payment/confirmation proof
- [`current-system-map.md`](current-system-map.md) — package keys
