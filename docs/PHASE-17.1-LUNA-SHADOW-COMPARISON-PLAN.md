# Phase 17.1 — Luna Shadow vs Main Bot Comparison Plan

**Status:** PASS — plan doc + static plan verifier (Phase 17a). **No comparison logic implemented in this slice.**
**Parent:** Phase 17 — prove the Staff API intake brain matches/improves the legacy n8n parser before thinning it.
**Prior:** Phase 16c n8n intake shadow closeout (`bc20e9a`), Phase 16a–16b.3 inactive shadow + manual proofs, Phase 15 deterministic multilingual intake.
**Next:** Phase 17b — static/local comparison harness with fixtures (no live n8n, no writes, no sends).

**Non-negotiables (17a):** No runtime code changes (beyond this doc + verifier). No n8n activation. No WhatsApp sends. No DB writes. No booking creation. No payment rows. No Stripe. No migrations. No deploy. No production data.

**Architecture (unchanged):**

- **Staff API is the brain**; n8n is only the WhatsApp message pipe.
- The legacy **n8n "Wolfhouse booking parser"** LLM chain should eventually be **replaced/thinned** once the Staff API intake output is proven equal-or-better.
- Live WhatsApp remains **NO_GO** (Stage 7.8 gate) until explicit go-live gates.

---

## 0. Legacy parser access problem (read this first)

The old/main parser output is **hard to access deterministically**:

| Concern | Detail |
|---------|--------|
| LLM chain | `n8n/Wolfhouse Booking Assistant  - Main.json` — `Parser Node` is an LLM prompt ("You are the Wolfhouse booking parser"), non-deterministic across runs |
| Session-coupled | Merges prior `Session State`, `Last Bot Reply`, conversation summary from Airtable — output depends on live conversation context, not message alone |
| Side-effectful pipe | Main workflow performs Airtable lookups/holds and is wired to live WhatsApp; running it for comparison risks writes/sends |
| Cost | Each parser run is an LLM call + Airtable I/O; a fixture sweep is expensive and flaky |

**17a decision: canonical expected-output comparison FIRST.**

- Phase 17b compares **Staff API intake output → a hand-authored canonical expected output** per fixture (the "should be" contract).
- Old n8n parser outputs are captured **manually and optionally** (paste/pin a few real parser JSONs as reference rows), never by live execution in the harness.
- This keeps the harness deterministic, offline, write-free, and send-free.

---

## 1. What exactly is being compared?

| Source | Role in comparison |
|--------|--------------------|
| **Old/main n8n parser output** | Legacy reference only — captured manually, optional, non-authoritative |
| **New Staff API intake output** (`POST /staff/bot/message-intake-preview`) | Primary subject under test |
| **Canonical expected output** | Authoritative target the Staff API output must match-or-improve |
| **dry_run_plan output** | Compare chaining decision + quote/availability when present |
| **ask_next / handoff behavior** | Compare partials prompt + refund/cancel/human handoff |
| **Safety flags** | `no_write_performed`, `creates_booking`, `creates_payment`, `creates_stripe_link`, `sends_whatsapp`, `calls_n8n`, `preview_only`, `extraction_only`, `whatsapp_sent`, `live_send_blocked` |

Comparison axis: **canonical vs Staff API** is blocking; **legacy parser vs Staff API** is advisory (detects regressions vs old behavior, but old parser is not the source of truth).

---

## 2. Input fixture set

Minimum fixture set for Phase 17b (each is a guest `message_text` + `language` + `from` + `client_slug`):

| # | Fixture | Expectation summary |
|---|---------|---------------------|
| 1 | **EN complete booking** | full extraction, dry-run chains |
| 2 | **IT partial availability** | missing field(s) → localized ask_next, no chain |
| 3 | **ES native complete** | native date parse (24 de septiembre…), dry-run chains |
| 4 | **DE native complete** | native date parse (24. September…), dry-run chains |
| 5 | **Add-on request** | add_ons populated, no write |
| 6 | **Refund / handoff** | `handoff_required: true`, no booking intent chain |
| 7 | **Invalid / unknown package** | package not chained, blocker/ask, no dry-run write path |
| 8 | **Missing dates** | `missing_fields` includes dates → ask_next, no chain |
| 9 | **Payment choice deposit / full** | `payment_choice` parsed both ways |
| 10 | **Multilingual guest count** | guest count parsed across languages (dos/drei/2/two) |

These map onto the already-proven shadow executions: EN (#10), IT partial (#11), refund/handoff (#12), ES native (#13), DE native (#14).

---

## 3. Fields to compare (per fixture)

- `intent`
- `language`
- `phone` / `from`
- `guest_name`
- `guests`
- `check_in` / `check_out`
- `package_code`
- `payment_choice`
- `add_ons`
- `missing_fields`
- `ask_next`
- `handoff_required` / `handoff_reason`
- `can_chain_dry_run` (validation)
- `dry_run` quote / availability **when present**
- safety flags (section 1)

---

## 4. PASS criteria

A fixture PASSES when **all** hold:

- Staff API output **matches or improves** the canonical expected output (no required booking field lost vs legacy).
- **No writes / no sends** — every safety flag for write/send is false; `no_write_performed: true`.
- **Dry-run only when enough fields** — `can_chain_dry_run` true only when required fields present.
- **Handoff** for refunds / cancellations / explicit human requests (`handoff_required: true`).
- **Localized ask_next** for partials (ask in guest's language).
- Safety flags `sends_whatsapp` / `creates_*` are **false**; `whatsapp_sent: false`, `live_send_blocked: true`.

---

## 5. Mismatch criteria

A fixture is a MISMATCH when **any** hold:

- Old parser extracts a **required booking field** the Staff API misses.
- Staff API **chains dry-run when it should not** (missing fields / handoff case).
- Old parser **handoffs but Staff API does not** (refund/cancel/human).
- Staff API **misses package / payment_choice / add_ons** the message clearly states.
- Staff API **reply_draft language is wrong** (not the guest's language).
- Either path **would write or send** (any write/send safety flag true).

---

## 6. Mismatch handling

- **Categorize** each mismatch as **blocking** vs **cosmetic**:
  - *Blocking:* lost required field, wrong chain decision, missing handoff, would-write/would-send.
  - *Cosmetic:* reply_draft wording/language polish, optional field nicety, formatting.
- **Fix parser gaps one at a time** (Staff API intake helper), re-run the harness after each fix.
- **Do not activate the workflow** while any blocking mismatch exists.
- **Keep live WhatsApp NO_GO** throughout.

---

## 7. Phase 17b — recommended implementation

- **Static / local comparison harness** driven by the section-2 fixtures.
- **Does not call live n8n** and does not execute the legacy parser.
- Compares **Staff API intake output → canonical expected output** first (authoritative).
- **Optionally** stores hand-captured old n8n parser outputs as advisory reference rows (manual paste, never live execution) — only if cheaply available.
- **No writes / no sends / no Stripe / no activation.**
- Emits PASS/MISMATCH per fixture with blocking-vs-cosmetic categorization.
- Add npm script `verify:luna-agent-phase17-shadow-comparison` when implemented.

---

## 8. Phase 17c / 17d — eventual

- **17c:** import/update an **inactive** comparison workflow in n8n; manual shadow comparison run only (no activation, no send).
- **17d:** **thin the legacy parser branch** only **after** comparison passes with zero blocking mismatches — Staff API becomes the sole intake brain, n8n stays the pipe.

---

## 9. Safety proof (17a)

- This slice adds only a **doc** + a **static verifier**. No runtime/route/helper change.
- No n8n activation; shadow workflow stays `active: false`.
- No WhatsApp send, no Stripe, no DB write, no booking/payment rows, no migration, no deploy.
- Live WhatsApp remains **NO_GO** (Stage 7.8).

---

## 10. Explicit stop conditions

Stop and report before proceeding if:

- Any harness step would **execute the live legacy parser** with side effects.
- Any step would **activate** the shadow/main workflow.
- Any step would **write** DB rows, **create** bookings/payments, **call Stripe**, or **send WhatsApp**.
- A **blocking mismatch** is found — fix the parser gap first; do not thin/activate.
- Canonical expected output is ambiguous — define it before comparing.

---

## 11. Phase map

| Phase | Deliverable | State |
|-------|-------------|-------|
| 15 | Deterministic multilingual intake in Staff API | DONE |
| 16a–16b.3 | Inactive n8n Message Intake Shadow + manual proofs (#10–#14) | DONE |
| 16c | Aggregate intake shadow closeout verifier | DONE (`bc20e9a`) |
| **17a** | **Shadow vs main comparison plan + static verifier** | **THIS SLICE** |
| 17b | Static/local comparison harness (canonical first) | NEXT |
| 17c | Inactive comparison workflow + manual shadow comparison | LATER |
| 17d | Thin legacy parser after comparison passes | LATER |

**Live WhatsApp:** NO_GO until explicit go-live gates.
