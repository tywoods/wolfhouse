# Phase 15.1 — Luna Guest Message Intake / Extraction Plan

**Status:** PASS — docs + static plan verifier (Phase 15a). **No extractor implementation in this slice.**
**Parent:** Phase 15 — Luna guest natural-language intake before dry-run
**Prior:** Phase 14 confirmation preview closeout (`d00abd1`), Phase 13 gated booking/payment, Phase 12 dry-run, Phase 11 Ask Luna read-only ops
**Next:** Phase 15b — read-only extractor helper + optional `message-intake-preview` route (no write, no send)

**Non-negotiables (15a):** No runtime extractor. No DB writes. No booking creation. No payment rows. No Stripe. No WhatsApp. No n8n activation. No migrations. No deploy.

**Architecture (unchanged):**

- **Staff API is the brain**; n8n is the WhatsApp message pipe only.
- Guest sends natural text → **intake/extraction** (Staff API) → **dry-run** (existing) → reply draft → n8n/manual review → (later) eligibility/write bridge (Phase 13 gates).
- AI may **extract structured fields**; AI may **not** write DB, send WhatsApp, generate SQL, or bypass dry-run.
- Live WhatsApp remains **NO_GO** (Stage 7.8 gate).

**Problem statement:** Phase 12–13 booking flow expects structured input (`check_in`, `check_out`, `guest_count`, `package_code`, `payment_choice`, `phone`/`from`, etc.). Real guests send natural text like: *“Hi, we are 2 people and want to come next Friday for 5 nights. Do you have a package with lessons?”* A safe intake layer must sit **before** `POST /staff/bot/booking-dry-run`.

---

## 0. Existing extraction code (map first — do not fork)

| Location | Role today | Staff API ownership |
|----------|------------|---------------------|
| **n8n Main — “Wolfhouse booking parser”** (`n8n/Wolfhouse Booking Assistant - Main.json`, `n8n/phase2/…`) | LLM chain extracts intent, dates, guest_count, package, room_type, room_preference, language, needs_human from guest message + session state | **Legacy** — logic lives in n8n prompts, not reusable Staff API module |
| **n8n Main — message router** (`Code - Parse Route`) | Routes to `booking_flow`, normalizes session, handles alternative-date picks | **Legacy** — pipe orchestration |
| **n8n Main — contact extractor** | Separate LLM for name/email/booking_id | **Legacy** |
| **`scripts/lib/luna-guest-booking-dry-run.js`** | `normalizeInput()`, `BOT_BOOKING_REQUIRED_FIELDS`, `runLunaGuestBookingDryRun()` — target downstream | **Staff API brain** — Phase 12c |
| **`POST /staff/bot/booking-dry-run`** | Read-only plan: quote, availability, gate, `reply_draft`, `missing_fields` | **Staff API** |
| **`scripts/lib/staff-ask-luna-ai-intent.js`** | AI classifier pattern: registry-only intents, JSON-only, no SQL, env-gated, confidence threshold | **Reuse pattern** for guest intake AI fallback (not staff intents) |
| **`scripts/staff-query-api.js` — `resolveNaturalLanguageIntent`** | Deterministic staff Ask Luna routing | **Staff-only** — not guest booking intake |
| **Phase 13 write bridge** | dry-run → eligibility → create (gated) | **Downstream** — intake must not skip |

**15a decision:** Phase 15b will **port extraction ownership into Staff API**, mirroring proven n8n field shapes but feeding `runLunaGuestBookingDryRun()` — n8n becomes HTTP caller, not prompt owner.

---

## 1. Intake extractor output shape

Primary envelope (read-only, no writes):

```json
{
  "success": true,
  "extraction_only": true,
  "no_write_performed": true,
  "sends_whatsapp": false,
  "calls_n8n": false,

  "intent": "booking_inquiry",
  "confidence": 0.82,
  "language": "en",
  "extraction_source": "deterministic|ai|hybrid",

  "guest_name": null,
  "phone": "+34…",
  "email": null,
  "check_in": "2026-09-12",
  "check_out": "2026-09-17",
  "nights": 5,
  "guests": 2,
  "package_code": "malibu",
  "room_type": "shared",
  "room_preference": "shared",
  "payment_choice": null,
  "add_ons": [],

  "missing_fields": ["payment_choice", "guest_name"],
  "ask_next": "whether you prefer to pay a deposit or the full amount",
  "handoff_required": false,
  "handoff_reason": null,

  "dry_run_input": {
    "client_slug": "wolfhouse-somo",
    "check_in": "2026-09-12",
    "check_out": "2026-09-17",
    "guest_count": 2,
    "package_code": "malibu",
    "room_type": "shared",
    "phone": "+34…",
    "message_text": "…original guest message…"
  },
  "dry_run_plan": null
}
```

### Allowed `intent` values (Staff API registry — map from n8n)

| Staff API intent | n8n legacy equivalent | Dry-run? |
|----------------|---------------------|----------|
| `booking_inquiry` | `booking_request` | Yes — when dates + guests known |
| `availability_question` | `availability_check` | Yes — partial fields OK |
| `price_question` | `package_question` | Preview/quote only |
| `addon_request` | custom_extras / addon mentions | Route to addon preview when typed |
| `payment_choice` | deposit/full reply turn | Merge into session; no new booking |
| `cancel_request` | `cancellation` | **Handoff** (no auto cancel in 15b) |
| `reschedule_request` | `reschedule` | **Handoff** |
| `complaint` | `complaint` | **Handoff** |
| `human_request` | `human_request`, `needs_human` | **Handoff** |
| `unknown` | `unknown` | Low confidence → handoff or clarify |

### Field mapping to dry-run (`normalizeInput` in `luna-guest-booking-dry-run.js`)

| Extractor field | Dry-run field | Notes |
|-----------------|---------------|-------|
| `guests` | `guest_count` | Also accepts `guest_count`, `adults` |
| `phone` | `phone` / `guest_phone` / `from` | `resolveDryRunPhone()` order preserved |
| `package_code` | `package_code` | Lowercased; must be in pricing catalog |
| `room_type` / `room_preference` | `room_type` | Default `shared` (matches n8n + dry-run) |
| `add_ons[]` | `add_ons` / `addon_request` | Service catalog codes only |
| `message_text` | `message_text` | Audit / reply context |

---

## 2. Deterministic parsing (before AI)

Handle **first** without LLM — fast, auditable, no token cost:

| Signal | Deterministic rule | Anchor |
|--------|-------------------|--------|
| **phone / from** | Use webhook `from` / session phone; E.164 normalize | n8n `Normalize Incoming Message`; dry-run `resolveDryRunPhone` |
| **Explicit ISO dates** | `\d{4}-\d{2}-\d{2}` in message | Regex + sanity |
| **Guest count** | `\b(\d{1,2})\s*(people|guests|persons|pax)\b`, `we are (\d+)`, lone reply `^\d{1,2}$` when `pending_action=collect_guest_count` | n8n parser rules |
| **Package codes** | Exact `malibu`, `uluwatu`, `waimea`, `custom` (word boundary, case-insensitive) | `wolfhouse-somo.pricing.json` packages |
| **Payment choice** | `\b(deposit|full|pay in full|pay deposit)\b` | Phase 13 `payment_choice` |
| **Language** | Session `Language` field if present; else simple keyword hints (`hola`→es, `ciao`→it) | n8n conversation |
| **Booking code** | `(?:WH|MB)-[A-Z0-9-]+` | Phase 13i lookup pattern |
| **Room type private** | `private room`, `own room`, `family room`, `matrimonial` | n8n room rules |
| **Gender rooming** | `female only`, `male only` → `room_preference`, keep `room_type=shared` | n8n rules — **never** infer private from gender |
| **Deposit/full after bot ask** | Last bot reply context (`pending_action`) | Session state from n8n/Staff API |

Deterministic pass sets `extraction_source: "deterministic"` and bumps confidence for matched fields.

---

## 3. AI extraction (gated fallback)

Use AI **only when** deterministic pass leaves critical gaps or ambiguous intent.

| AI handles | Examples |
|------------|----------|
| Relative dates | “next Friday”, “in two weeks”, “this summer” |
| Multilingual phrasing | IT/ES/DE/FR guest messages |
| Intent classification | booking vs price vs addon vs handoff |
| Package/add-on mentions | “package with lessons”, “yoga and meals” |
| Vague partial requests | “somewhere in September for a few nights” |
| Handoff-worthy tone | angry, refund dispute, explicit human request |

**Pattern:** reuse `staff-ask-luna-ai-intent.js` guardrails:

- Env gate: `LUNA_GUEST_INTAKE_AI_ENABLED` (default **false**)
- JSON-only output; reject SQL/tool patterns (`SQL_OR_TOOL_RE` style)
- Allowed intents + package codes + addon types from **config/registry only**
- `confidence < LUNA_GUEST_INTAKE_AI_CONFIDENCE_MIN` (default 0.75) → `handoff_required` or `ask_next`
- AI fills **only null fields** — deterministic wins on conflict
- `extraction_source: "ai"` or `"hybrid"`

AI must **not:** write DB, call dry-run write paths, send WhatsApp, generate SQL, invent package codes.

---

## 4. What must remain impossible

| Forbidden | Enforcement |
|-----------|-------------|
| DB writes (bookings, payments, holds) | Extractor + intake route: SELECT-only or no `pg` writes |
| Booking creation | No call to `runLunaGuestBookingWriteBridge` / `handleBotBookingCreate` |
| Payment row creation | No payment INSERT |
| Stripe link creation | No `create-stripe-link` / checkout |
| WhatsApp send | `sends_whatsapp: false`; no Graph API |
| SQL generation / execution | No SQL in AI prompt output; no ad-hoc queries from extraction |
| Confirmation send | Phase 14 send still NO_GO |
| Payment truth updates | No webhook / paid status mutation |
| Paid cancel / date-change automation | `cancel_request` / `reschedule_request` → handoff only |
| n8n workflow activation | No activation API in intake path |
| Skipping dry-run for writes | Phase 13 bridge still requires dry-run plan first |

---

## 5. Post-extraction validation

Run **after** deterministic + AI merge, **before** dry-run invoke:

| Validation | Rule | On failure |
|------------|------|------------|
| Date normalization | `check_in`/`check_out` → `YYYY-MM-DD`; resolve relative via anchor date (today in client TZ) | Clear field + add to `missing_fields` |
| Date range sanity | `check_out > check_in`; max stay policy; closed months (Dec–Feb) → warning not handoff | `warnings[]` in dry-run |
| Guests | `guests >= 1` | `missing_fields` |
| Package codes | Only `malibu`, `uluwatu`, `waimea`, `custom` per `wolfhouse-somo.pricing.json` | null package + `missing_fields` |
| Add-ons | Only `BOT_ADDON_SERVICE_TYPES` + pricing catalog (`yoga`, `meal`, `surf_lesson`, `wetsuit`, `surfboard`) | Strip unknown addons |
| Payment choice | Only `deposit` or `full` | `missing_fields` until guest answers |
| Confidence | `< threshold` → no auto dry-run for write-eligible intents | `handoff_required` or single `ask_next` |
| Missing fields | Compute from `BOT_BOOKING_REQUIRED_FIELDS` minus populated | One question via `ask_next` (n8n rule: one ask per turn) |
| Ambiguity | Conflicting dates/packages | `handoff_required: true` |
| Bed leak | N/A at intake — room_type only | — |

---

## 6. Pipeline connection

```
WhatsApp guest message
        │
        ▼
   n8n pipe (normalize phone, message_text, conversation_id, session snapshot)
        │
        ▼
 POST /staff/bot/message-intake-preview   ← Phase 15b (read-only)
        │
        ├─► deterministic extract
        ├─► optional AI extract (env-gated)
        ├─► validate + merge
        │
        ├─► if booking_inquiry|availability_question + enough fields:
        │       POST logic → runLunaGuestBookingDryRun(dry_run_input)
        │       attach dry_run_plan + reply_draft
        │
        └─► return extraction JSON (no write)
                │
                ▼
        n8n / staff reviews reply_draft
                │
                ▼ (later, Phase 13 gates unchanged)
        eligibility → write bridge → payment → Stripe link → webhook truth
```

**15b scope:** intake preview returns `extraction` + optional `dry_run_plan`. **No** eligibility, **no** create, **no** send.

**Auth:** `requireBotAuth` (same as `booking-dry-run`).

---

## 7. Recommended Phase 15b (first implementation slice)

| Deliverable | Scope |
|-------------|-------|
| `scripts/lib/luna-guest-message-intake.js` | `extractLunaGuestMessageIntake(input, context)` — deterministic-first, optional AI hook (stub or env-gated) |
| `scripts/lib/luna-guest-message-intake-validate.js` | Optional split: validation + `missing_fields` / `ask_next` |
| `POST /staff/bot/message-intake-preview` | Read-only; chains extract → validate → optional `runLunaGuestBookingDryRun` |
| Verifier | `verify:luna-agent-phase15-message-intake-preview` |
| Golden examples | EN/IT/ES messages in verifier mocks (no hosted proof required in 15b) |

**Not in 15b:** n8n prompt deletion, live WhatsApp, write bridge changes, AI training, conversation log tables.

---

## 8. Verifiers that must protect Phase 15

| Verifier | Protects |
|----------|----------|
| `verify:luna-agent-phase15-intake-plan` | This doc + anchors (15a) |
| `verify:luna-agent-phase15-message-intake-preview` | Helper + route read-only (15b) |
| `verify:luna-agent-phase14-closeout` | Confirmation preview regression |
| `verify:luna-agent-phase13-closeout` | Write gates unchanged |
| `verify:luna-agent-phase12-closeout` | Dry-run foundation |
| `verify:staff-ask-luna-phase11-closeout` | Staff ops regression |

**15b verifier must assert:**

- Structured JSON only; registered package/service codes only
- No SQL / tool output in extractor
- No INSERT/UPDATE/DELETE; no Stripe/WhatsApp/n8n
- Low confidence → `handoff_required`
- Missing fields → single `ask_next` question
- Multilingual fixture messages parse without write
- Phase 11/12/13/14 closeouts still pass

---

## 9. Explicit stop conditions

Stop and report (do not guess) if:

1. Extractor would write DB or skip dry-run for any write path
2. Package/add-on codes invented not in pricing catalog
3. Bed codes leak into guest-facing extraction output
4. AI enabled without env gate in staging/production
5. n8n prompt logic duplicated divergently without mapping table to dry-run fields
6. Live WhatsApp send introduced in intake route

---

## 10. Phase map

| Phase | Scope | Write? | Send? |
|-------|-------|--------|-------|
| **15a** | Intake/extraction plan (this doc) | No | No |
| **15b** | Read-only extractor + `message-intake-preview` | No | No |
| **15c** | n8n thin pipe: call Staff API intake instead of inline LLM parser | No | No |
| **15d** | Session merge + multi-turn `ask_next` orchestration | No | No |
| **16+** | (unchanged) Phase 13 writes, Phase 14c confirmation send — separate gates |

**Live WhatsApp:** remains **NO_GO** through 15a–15d.

---

## 11. Known gaps (reported, not fixed in 15a)

1. **Extraction lives in n8n today** — Staff API has dry-run but no guest message parser module.
2. **No `LUNA_GUEST_INTAKE_AI_ENABLED` env** — must add in 15b following Ask Luna pattern.
3. **Session / `pending_action` state** — n8n Airtable session vs future Staff API session store TBD in 15c/15d.
4. **Cancel/reschedule** — intake may detect intent but must hand off; no automated paid change path.
