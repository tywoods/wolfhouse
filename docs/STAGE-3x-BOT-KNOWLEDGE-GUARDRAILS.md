# Stage 3x — Bot Knowledge + Safety Guardrails

**Status:** **3x.1 + 3x.1b planning complete** (2026-05-28, docs-only)  
**Prerequisite:** Stage 3 engineering gates through **3d.9b** — integrated Main → Stripe pay → organic webhook → Send Confirmation dry-run on `WH-260528-5369` ([`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md), commit `cd48a5a`).

**Purpose:** Define business knowledge, configurable client rules, and safety guardrails the bot needs **before Stage 4 (Reliable)** and **before Stage 5 (Clean)** moves decision logic out of n8n.

**Non-goals (this stage):** Runtime code changes, workflow JSON edits, workflow activation, Postgres/Airtable/Stripe mutations, golden-message runner implementation, or new n8n IF sprawl for business rules.

**Architecture principle:**

| Layer | Role |
|-------|------|
| n8n | Orchestrates (webhooks, WhatsApp, Stripe, schedules) |
| Backend / code | Decides (route, fields, packages, guards, handoff) — **Stage 5** |
| Postgres | Remembers (bookings, payments, conversations, beds) |
| Client config | Controls (packages, policies, tone per property) — **Wolfhouse = client #1** |
| Staff UI | Manages (Stage 6+) |

**Evolution order:** Correct and safe → Reliable → Clean → Beautiful → Scalable ([`ROADMAP.md`](ROADMAP.md)).

---

## Deliverables map

| Section | Deliverable | Implementation stage |
|---------|-------------|----------------------|
| 3x.1 | Required field map (this doc) | Spec now; enforce in code Stage 5 |
| 3x.2 | Package explanation + decision flow | Spec now; `packageDecision.ts` Stage 5 |
| 3x.3 | Ale/Cami gap questionnaire | [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) *(create when answers collected)* |
| 3x.4 | WhatsApp history mining plan | This doc §3x.4; outputs feed 3x.5 |
| 3x.5 | 30–50 golden message fixtures | `docs/fixtures/golden-messages/` *(Stage 3x.2+)* |
| 3x.6–3x.9 | Gates, handoff, wrong-booking, duplicates | Spec now; tests Stage 4 |
| 3x.10 | Client-config schema plan | This doc §3x.10; DB/config Stage 5–7 |
| 3x.11 | Customer memory + WhatsApp history migration | This doc §3x.11; schema Stage 5–6; import Stage 3x.3+ *(no DB migration in 3x.1b)* |

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

---

## 3x.2 — Package explanation + decision flow

### Public website baseline (do not re-ask Ale/Cami to restate)

Wolfhouse Somo public marketing describes surf-house packages named after surf spots. Guests may refer to them by name:

| Package (public name) | Bot may explain at high level |
|----------------------|------------------------------|
| **Malibu** | Entry / beginner-friendly surf package positioning (lessons + camp structure) |
| **Uluwatu** | Intermediate package positioning |
| **Waimea** | Advanced / experienced surfer positioning |

The bot should use the **website** as the first source for “what is Malibu vs Uluwatu vs Waimea” in guest-friendly language. Link or summarize from official copy when appropriate; do not invent inclusions.

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
        → handoff (3x.7)
```

### Bot must not

- Quote exact EUR/USD without config-backed calculation.
- Promise room numbers before assignment workflow.
- Confirm lesson schedule details not in config.
- Treat `custom` package as bookable without staff rules.

---

## 3x.3 — Wolfhouse knowledge collection (Ale/Cami gaps only)

**Location for answers:** [`docs/knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) *(to be created when owners fill questionnaire)*.

Questionnaire covers **operational gaps only** — not public website copy.

### Deposit + payment

1. Deposit amount(s): fixed EUR per booking vs per person vs per package?
2. Is deposit always **€200** (current test default) in production config?
3. Payment deadline after link sent? Auto-cancel hold?
4. Hold expiry TTL (hours/days) and reminder messages?
5. Balance payment: when due, how collected, bot role vs staff?

### Cancellation + refunds

6. Guest-cancel windows and refund % (deposit vs full)?
7. No-show policy?
8. Date-change fee rules vs free change window?

### Packages + pricing (2026)

9. Confirm Malibu / Uluwatu / Waimea valid for 2026 — any renames?
10. Price table or formula (season, nights, pax)?
11. Minimum nights per package; always 7 nights?
12. Accommodation-only: min nights, deposit, included services?
13. Custom packages: allowed? who approves?
14. Lessons/rentals/board/wetsuit: bundled vs add-on prices?

### Rooming + property

15. Gendered dorms rules; couple private room; friends same room; families?
16. Max group size per booking before staff assignment?
17. Check-in / check-out times; early arrival / late departure messaging?

### Operations + handoff

18. Surf level questions: does bot collect or only staff?
19. Airport transfer: bookable by bot or info-only?
20. Breakfast / meals: package-specific wording for confirmations?
21. When must bot **stop** and ping Cami/Ale (channels, hours)?
22. Tone: formal vs casual; languages offered; emoji OK?
23. Emergency / injury / legal: mandatory handoff script?

### WhatsApp-specific

24. May bot send payment link without staff review for standard packages?
25. Phrases that mean “staff takeover” from owners?

---

## 3x.4 — WhatsApp history mining plan

### Purpose

Mine **real** Cami/Ale ↔ guest WhatsApp threads (export or sanctioned copy) to produce **two** outputs (see also §3x.11):

| Output | Use |
|--------|-----|
| **A — Anonymized bot knowledge** | Golden fixtures, tone, package phrasing, FAQ gaps (safe for repo/tests) |
| **B — Structured customer memory** | Returning-guest recognition and operational prefs (PG, client-scoped; not raw chat logs) |

Do **not** treat “export WhatsApp → dump into prompt/context” as the long-term design. Extraction must pass through the layered model in §3x.11.

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
5. **Golden candidates** — pick 30–50 guest lines → §3x.5 fixtures with expected route/action.
6. **Tone guide** — short “do / don’t” from Cami/Ale samples for `client_config.language/tone`.
7. **Owner review** — Ale/Cami validate only **true gaps** → `wolfhouse-somo-gaps.md`.

### Expected outputs

| Output | Destination |
|--------|-------------|
| Package explanation patterns | §3x.2 + client config `packages[].guest_description` |
| Required-field checklist refinements | §3x.1 |
| FAQ gaps | `wolfhouse-somo-gaps.md` |
| Handoff rules | §3x.7 + `handoff_rules` config |
| 30–50 golden messages | `docs/fixtures/golden-messages/*.json` |
| Reduced owner questionnaire | Only unanswered items remain in §3x.3 |

### Success criteria

- ≥80% of golden fixtures sourced from real (redacted) threads or labeled synthetic edge cases.
- Zero PII in repo.
- Owner sign-off on tone + handoff list before Stage 4 runner uses fixtures.

---

## 3x.5 — Golden message tests (plan)

**Target:** 30–50 fixtures. **Stage 3x.1** defines schema + representative samples; full set completed after §3x.4 mining and Ale/Cami gaps.

### Fixture schema (each case)

```json
{
  "id": "GM-001",
  "guest_message": "...",
  "conversation_context": {
    "current_hold_booking_id": null,
    "language": "en",
    "prior_route": null
  },
  "expected": {
    "resolved_route": "booking_flow",
    "missing_fields": ["check_in", "check_out", "guest_count"],
    "safe_action": "ask_clarification",
    "clarification_pattern": "dates_and_pax",
    "handoff": false,
    "must_not": ["send_payment_link", "confirm_booking", "create_checkout"]
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
| Duplicate / repeat message | 2–3 | 3x.9 |

### Representative samples (full detail; expand to 30–50 in 3x.2)

| ID | Guest message (excerpt) | Expected route | Missing / action |
|----|-------------------------|----------------|------------------|
| GM-001 | “Hi we want to book surf camp July 10” | `booking_flow` | dates partial; ask checkout + pax + package |
| GM-010 | “What’s difference Malibu and Waimea?” | `package_info` | none; explain; no price without dates |
| GM-015 | “Just a bed no lessons 5 nights” | `booking_flow` | confirm accommodation-only allowed; dates |
| GM-020 | “Send payment link” (hold exists) | `payment_details_provided` | email if missing; verify hold id |
| GM-025 | “I paid yesterday” (no PG payment) | `payment_claim` | handoff or check Stripe; never confirm |
| GM-030 | “Cancel my booking WH-…” | `cancel_intent` | policy; staff if paid dispute |
| GM-035 | “Girls only room please” | `rooming_preference` | store preference; no bed write in Main |
| GM-040 | “We’re a couple private room” | `rooming_preference` | couple rules; may handoff |
| GM-045 | “Change to Aug 1–8” | `date_change` | availability; staff if paid |
| GM-050 | “?” / sticker / empty | `unclear` | handoff or clarify |

**Runner:** Stage 4 — `npm run test:golden-messages` against decision engine stub (not n8n live).

---

## 3x.6 — Dangerous action gates

Strict proof required before side effects. Aligns with proven Stage 3 gates.

| Action | Proof required | Proven by (Stage 3) |
|--------|----------------|---------------------|
| **Send payment link** | Hold + Ensure + real CPS; correct `booking_id`; not terminal; idempotent session | 3d.7b |
| **Mark payment paid** | Stripe webhook `checkout.session.completed`; `payment_events.processed`; intent id unique | 3d.5b, 3d.8b |
| **Confirm booking** | `send_confirmation=true`; payment truth; `whatsapp_sent` (or dry-run flag in test); then SQL mark | 3d.6, 3d.9b |
| **Cancel booking** | Booking id + policy + staff if ambiguous | *pending E2E* |
| **Assign / reassign beds** | Confirmed booking rules + capacity + local webhook | *pending URL remap* |
| **Date change** | New availability + policy + payment impact resolved | *pending* |
| **Payment state change (manual)** | Staff authorization only; never guest LLM | Architecture rule |

**Global hard stops:** `sk_live`; wrong workflow active; `payment_events` duplicate; terminal booking mutation; multiple confirmations.

---

## 3x.7 — Human handoff rules

Bot **must stop guessing** and notify staff (mechanism TBD: sheet, WhatsApp internal, queue table) when:

| Trigger | Examples |
|---------|----------|
| Low route confidence | Gibberish, mixed intents, unsupported language |
| Conflicting dates / guest count | Check-out before check-in; pax mismatch |
| Multiple active holds | Same phone, different open holds — never pick by phone alone |
| Paid claim, no payment record | “I paid” without PG `paid` / `payment_events` |
| Refund / dispute / cancel ambiguity | Chargeback tone, partial refund ask |
| Angry guest / complaint | Escalation keywords |
| Emergency / legal / medical | Injury, police, lawyer — no bot negotiation |
| Rooming / reassign uncertainty | Conflicting gender rules, special needs |
| Custom package / discount / group | Non-standard pricing |
| Policy exception | Anything not in `client_config` |
| Stripe / webhook anomaly | Paid in Stripe dashboard but not PG |

**Handoff message pattern:** Acknowledge, set expectation (“Cami/Ale will reply shortly”), **do not** promise refund/room/price.

---

## 3x.8 — Wrong-booking protection

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

---

## 3x.9 — Duplicate protection

| Scenario | Expected behavior | Stage 3 evidence |
|----------|-------------------|------------------|
| Same WhatsApp `wamid` / message id | No second hold; idempotent ingest | Typing guard + inbound dedup *(verify in 3x.2)* |
| Repeated “send payment link” | Reuse open `checkout_created` session if valid | CPS LATERAL reuse SQL |
| Same Stripe `event.id` | Single `payment_events` row | 3d.5b, 3d.8b organic burst → 1 row |
| Same `payment_intent` | Unique partial index (migration 005) | DB |
| Confirmation twice | `confirmation_sent_at` set; `send_confirmation=false` after first | 3d.9b |
| Schedule poll + webhook double-fire | Idempotent mark confirmed SQL | Send Confirmation RETURNING clause |

**Stage 4:** automated tests for each row; chaos test duplicate webhook burst (3d.8 operational finding).

---

## 3x.10 — Client-config architecture plan

**Core idea:** One booking-assistant **engine**; many **clients** via config rows keyed by `client_slug` (`wolfhouse-somo` = client #1).

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

---

## 3x.11 — Customer memory + WhatsApp history migration

### Purpose

Turn historical WhatsApp conversations into **two useful, separable outputs** — not a single “paste chat into the bot” memory blob.

| Output | Audience | Lifetime |
|--------|----------|----------|
| **A — Anonymized bot knowledge** | Engineers, tests, config authors | Long (fixtures, docs) |
| **B — Structured customer memory** | Bot + staff ops (returning guests) | Long (PG), scoped per `client_id` |

**Product decision:** WhatsApp history may inform **returning-guest recognition** and preferences when owners approve and privacy rules are met. Default is **not** to retain full raw chat as bot memory.

### Output A — Anonymized bot knowledge (from §3x.4)

- Package explanation examples (Malibu / Uluwatu / Waimea phrasing)
- Common guest questions and safe reply patterns
- Tone / style examples (Cami/Ale voice, redacted)
- Golden-message fixtures (§3x.5)
- Handoff examples
- FAQ gaps → `wolfhouse-somo-gaps.md`

**Storage:** `docs/fixtures/golden-messages/`, `docs/knowledge/whatsapp-samples/` (redacted only), client config snippets. **No** phone/name in git.

### Output B — Structured customer memory

Operational memory for **returning guests** — not a transcript archive.

| Memory type | Examples |
|-------------|----------|
| Recognition | Same phone → link to `customer_id`; `returning_guest=true` after N visits |
| Booking history | Past `booking_id` / codes, dates, package, outcome |
| Preferences | `preferred_language`, `preferred_package`, `surf_level` |
| Rooming | `room_preference`, `group_type` (couple, female-only, etc.) |
| Requests | `special_requests` (diet, arrival time — non-medical by default) |
| Staff | `staff_notes` (**staff-only**, never sent to guest verbatim) |
| Context | `last_booking_id`, `last_seen_at` |

**Bot use (Stage 5+):** personalize greeting (“welcome back”), pre-fill known language, suggest package tier — **never** quote staff notes or sensitive history to the guest.

### Layered data model (design principle)

Do **not** store raw WhatsApp history forever as default bot memory.

```text
Layer 1 — Raw import archive
  • Temporary, restricted access (owner export, offline job)
  • Used for migration / mining only
  • Deleted or archived after structured extraction (retention TBD with owners)

Layer 2 — Structured customer facts
  • Longer-term operational memory in Postgres
  • Only fields with clear ops value
  • Every fact: source, source_timestamp, client_id, optional confidence

Layer 3 — Anonymized bot knowledge
  • Fixtures and examples for tests and tone
  • No personal identifiers
  • Safe to commit after redaction review
```

**Flow:** Layer 1 → extract → Layer 2 + Layer 3 → **delete or lock Layer 1** per retention policy.

### Proposed future tables (spec only — no migration in Stage 3x.1b)

All tables include **`client_id`** (FK to `clients`) so Wolfhouse is **client #1**, not a hardcoded schema.

| Table | Role |
|-------|------|
| `customers` | Stable guest identity per client (phone E.164 unique per client) |
| `customer_booking_history` | Links `customer_id` ↔ past `booking_id`s (denormalized summary ok) |
| `conversation_summaries` | Short rolling summary per WhatsApp thread (optional; not full transcript) |
| `customer_preferences` | Key/value or typed columns for language, package, rooming, surf level |
| `customer_notes` | Staff-only notes; `visibility=staff` |
| `privacy_requests` | Future: delete / export / correction (GDPR-style) — `data_deletion_requests` |

Align with existing `conversations` / `bookings` in Postgres; `customers` may eventually subsume or link `conversations.phone` rather than duplicate blindly.

### Proposed `customers` fields (draft)

| Field | Type / notes |
|-------|----------------|
| `customer_id` | UUID PK |
| `client_id` | FK → `clients` (required) |
| `client_slug` | Denormalized for config load (`wolfhouse-somo`) |
| `phone` | E.164; unique per `(client_id, phone)` |
| `name` | Display; from booking or message |
| `email` | Optional |
| `preferred_language` | e.g. `en`, `de`, `es` |
| `first_seen_at` | From first message or first booking |
| `last_seen_at` | Last inbound WhatsApp or booking activity |
| `returning_guest` | Boolean or derived from booking count |
| `surf_level` | beginner / intermediate / advanced / unknown |
| `preferred_package` | `malibu` / `uluwatu` / `waimea` / accommodation-only |
| `room_preference` | From §3x.1 rooming vocabulary |
| `group_type` | solo, couple, friends, family, … |
| `special_requests` | Short text; ops-safe only |
| `staff_notes` | Staff-only; never exposed to guest bot path |
| `marketing_opt_in` | Separate from transactional WhatsApp |
| `data_source` | `whatsapp_import`, `booking`, `staff_ui`, `inbound_live` |
| `last_booking_id` | FK optional |
| `created_at` / `updated_at` | Audit |

**Fact provenance (recommended child pattern):** `customer_facts` with `{ key, value, source, source_message_at, extracted_at }` if we need history of changes without overwriting silently.

### Migration phases (planning only)

| Phase | Scope | Stage |
|-------|--------|-------|
| **M0** | Owner questionnaire + privacy policy alignment | 3x.2 |
| **M1** | Offline import script spec; Layer 1 ingest (off-repo) | 3x.3 |
| **M2** | Extraction rules → Layer 2 draft rows + Layer 3 fixtures | 3x.3 |
| **M3** | Schema migration + APIs (`getCustomerContext`) | Stage 5 |
| **M4** | Live path: inbound message updates Layer 2 incrementally | Stage 5–6 |
| **M5** | Staff UI: view/edit/delete customer memory | Stage 6 |
| **M6** | `privacy_requests` fulfillment | Stage 6–7 |

**Hard stop for 3x.1b:** No `database/migrations/*` files, no import jobs run, no real PII in repo.

### Safety / privacy boundaries

| Rule | Detail |
|------|--------|
| **Minimize** | Store only facts with clear operational value |
| **No by default** | Passport, government ID, full medical history, unrelated personal gossip |
| **Medical / legal / emergency** | Handoff only; do not persist clinical detail in `special_requests` |
| **Staff notes** | Never included in guest-facing LLM context |
| **Marketing** | `marketing_opt_in` separate from booking-support messages |
| **Retention** | Layer 1 TTL; Layer 2 retention limits — **owner decision** (see gaps doc) |
| **Subject rights** | Design for future delete/export/correct (table stub above) |
| **Separation** | Raw import ≠ structured facts ≠ anonymized fixtures |
| **Provenance** | `data_source` + timestamp on every extracted fact |
| **Multi-tenant** | All customer rows scoped by `client_id`; no cross-client joins in bot path |
| **Guest visibility** | Bot may say “I see you stayed with us in 2024” only if policy allows; no staff note leakage |

### Bot behavior with customer memory (target)

| Situation | Behavior |
|-----------|----------|
| Known returning phone | Warm greeting; use `preferred_language`; do not re-ask known package if still valid |
| Stale memory (>12 months — configurable) | Confirm before relying on prefs |
| Conflict with new message | New message wins; update Layer 2 |
| No memory | Same as today — collect required fields |
| Guest asks “what do you know about me?” | Summarize only guest-safe fields; offer correction |

### Relationship to §3x.4 mining

Single import pipeline, **dual extractors:**

1. **Knowledge extractor** → Layer 3 (anonymize, cluster, golden messages).
2. **Customer extractor** → Layer 2 (phone-keyed facts, booking linkage, staff review queue for uncertain rows).

Uncertain extractions → staff review before writing Layer 2 (Stage 6 UI or CSV queue in M2).

---

## Stage 3x sub-phase roadmap

| Sub-phase | Scope | Status |
|-----------|--------|--------|
| **3x.1** | Planning spec §3x.1–3x.10 | **Done** |
| **3x.1b** | Customer memory + WhatsApp migration plan (§3x.11) | **Done** |
| **3x.2** | Ale/Cami gap doc + draft `wolfhouse-somo.json` config | Planned |
| **3x.3** | WhatsApp mining (redacted) + golden fixtures + customer extract review | Planned |
| **3x.4** | Golden runner stub + Stage 4 reliability hooks | Planned |

---

## References

- [`ROADMAP.md`](ROADMAP.md) — stage order
- [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) — orchestration principle
- [`PROJECT-STATE.md`](PROJECT-STATE.md) — execution snapshot
- [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) — payment/confirmation proof
- [`current-system-map.md`](current-system-map.md) — package keys
