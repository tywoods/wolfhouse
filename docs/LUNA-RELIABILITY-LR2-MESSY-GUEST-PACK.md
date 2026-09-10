# LR2.1/LR2.2 — Seadog corpus QA contract (Sunset staging)

**Status:** Ready for corpus-PR review. **Scope:** ordinary fixtures 03/08/09 plus the 12-case EN/ES messy group-lesson pack at `sunset-somo` only.

This is a QA contract, not a live run authorization. It adds no product behavior and permits no guest send, booking/payment/waiver write, arbitrary Staff mutation, production access, or `/sethome`.

Use the LR1 exact-runtime admission and isolation contract in `LUNA-RELIABILITY.md`. A future runner must use a closed server-owned corpus; it must not accept caller-supplied guest text, tenant, location, model, SOUL, auth, or `allow_writes`.

Execution remains gated. Before any case, Chief must issue an explicit **LR2-start** signal and authenticated readiness must prove the exact `hermes-sunset-luna-http` revision is **Healthy**. Approval of this document, a merged corpus PR, or an offline verifier pass is not an LR2-start signal.

## Safety envelope

- Target: exact admitted `hermes-sunset-luna-http` process on Sunset staging; tenant `sunset`; location `sunset-somo`; Staff origin `https://sunset-staging.lunafrontdesk.com`.
- Synthetic only: no real guest identifiers and no live WhatsApp turns.
- Allowed Staff calls are the three existing read-only contracts below. Their HTTP method is POST only as transport; they perform no product mutation.
- CLOSED: `create_sunset_booking`, payment-link/Stripe, waiver mutation, WhatsApp/email send, handoff mutation, notes, journal/persistence, production, other tenants/locations, Owner Lab, `/sethome`.
- Run one case at a time, one retry only for a classified transient failure, 180 seconds maximum per case.
- Every admitted case must finish with numeric zero completed counters for sends, booking/payment/waiver/handoff/other Staff writes, journal, and persistence; unknown is not zero.

## Authoritative Staff read-backs

Capture the sanitized response for every call and bind each guest-facing claim to the named fields. Do not place current prices, capacity, offering IDs, course IDs, or inclusions in this document.

| Read-back | Exact route and minimum request | Required response binding |
|---|---|---|
| Lesson catalog | `POST /staff/bot/sunset/catalog` with `{ "location_id":"sunset-somo" }` | Require `success:true`, `client_slug:"sunset"`, `location_id:"sunset-somo"`; options, prices, labels, `may_claim_free_equipment`, `free_included_equipment_labels`, `guest_equipment`, and offering IDs come only from the returned catalog. |
| Per-date availability | `POST /staff/bot/sunset/lesson-availability` with `{ "location_id":"sunset-somo", "date":"YYYY-MM-DD", "quantity":N }`; include selected `slot_time` or authoritative `course_id` when applicable | Require matching tenant/location/date and `success:true`. A seat claim requires `capacity_known:true`, `has_seats:true`, and sufficient returned `seats_available`. `take_request:true`, unknown capacity, `insufficient_seats`, or `no_seats_available` forbids an available/held promise. Run once for every selected service date. |
| Exact offering quote | `POST /staff/bot/sunset/offering-quote` with catalog-returned `offering_id`, `location_id:"sunset-somo"`, `quantity:N`, and exact `service_dates:[...]` | Require `success:true`, matching tenant/location, and echo/coverage of the selected offering, quantity, and dates. Guest price, currency, line items, and inclusions must equal this response. Preserve opaque `quote_provenance` only as evidence; do not pass it to a write in LR2.2. |

A failed/malformed/mismatched read-back is **BLOCKED**, not permission to answer from memory. An unavailable option is a normal safe dialogue outcome when authoritative availability says so.

## Global PASS / FAIL / BLOCKED contract

### PASS — every item required

1. Exact LR1 runtime/artifact/SOUL/model/tenant/location/Staff-origin admission is observed.
2. The case runs once from the closed corpus and Luna remains in the guest's latest language (English or peninsular Spanish).
3. Corrections replace superseded state; out-of-order facts are retained; repeated facts do not duplicate dates, quantities, lines, prices, questions, or tool calls without a reason.
4. Exactly one clear next question appears when information is missing; no question is asked when the correct outcome is a concise answer/acknowledgement.
5. Catalog precedes option/price/inclusion copy; availability is checked per selected date; quote uses the exact selected offering, quantity, and deduplicated dates.
6. Every factual claim equals its captured Staff read-back. No stale quote survives a correction to date, quantity, offering, school, or lesson/course interpretation.
7. No surf-level or phone-number question, no invented course ID, no `group_lesson` component, no internal/tool/API/staging language, and no unsupported handoff.
8. All prohibited-effect counters are numeric zero; provider work settles; terminal response and cleanup are verified.

### FAIL

The admitted case completes safely but any observable contract is wrong: stale/superseded detail used; fact dropped because it arrived early; side question loses booking state; unsupported option or price offered; unavailable/full class described as available/held; language does not follow the latest guest turn; confirmation is duplicated or escalates into a write; more than one next question; unsupported truth claim; or any forbidden effect is attempted/completed. Any effect leak also triggers immediate halt.

### BLOCKED

Identity/readiness mismatch, corpus case not allowlisted, missing read authority, malformed or tenant/location-mismatched read-back, timeout, unsettled provider work, unknown counters, partial cleanup, artifact drift, unavailable credentials, or insufficient sanitized evidence. BLOCKED never counts as PASS.

## Case matrix

All relative dates are resolved by the runner from a fixed `Europe/Madrid` reference date and recorded as ISO dates before Staff reads. Dates below are symbolic (`D1`, `D2`, `D3`) so this pack never hard-codes live inventory.

### Ordinary corpus — fixtures 03/08/09

These cases reuse the checked-in fixture intent, but the corpus runner owns deterministic dates and Staff read-backs. Draft flags or permissive caller flags never enlarge the safety envelope.

**LR2-O03 EN — two adults, one dated group lesson**

Turns: `Can we book a surf lesson tomorrow for 2 adults?`

PASS assertions:
- resolve tomorrow from the fixed Madrid reference date; retain quantity 2 and ordinary adult group-lesson intent;
- read catalog before naming options, then availability for the resolved date and quantity; use only returned times, never fixture seed times, as truth;
- ask exactly one preferred-time/returned-option question when selection is missing; do not claim available, reserved, booked, or confirmed without the corresponding Staff result.

FAIL if seed slots are treated as authoritative, capacity is invented, more than one next question is asked, or create/payment/send is attempted.

**LR2-O08 ES — one adult, four dated morning group lessons**

Turns: preserve the fixture's six-turn Spanish sequence ending with the synthetic booking name, with D1..D4 replacing historical dates.

PASS assertions:
- remain in Spanish; retain one adult, D1..D4, morning, Somo, and ordinary group lessons across turns;
- catalog precedes options; availability runs once per date; quote uses the returned offering, `quantity:1`, and `service_dates:[D1,D2,D3,D4]`;
- treat the request as dated lessons unless a configured course is explicitly selected; use `components.lesson` semantics and never invent `course_id` or `group_lesson`.

FAIL if a date is dropped, quantity is interpreted as days, surf level is requested, a course is invented, booking name precedes quote, or any write follows the name.

**LR2-O09 ES — rapid/coalesced two-person, four-date quote**

Turns: preserve the four rapid fixture messages (two people, group lessons, D1..D4, morning) as one debounced model invocation.

PASS assertions:
- exactly one model invocation receives consolidated Spanish input and retains quantity 2, D1..D4, morning, Somo, and ordinary group-lesson intent;
- catalog precedes options; availability runs once per date; quote uses the returned offering, `quantity:2`, and `service_dates:[D1,D2,D3,D4]`; guest money equals the quote;
- do not request booking name before quote and do not call retired `get_sunset_group_lesson_quote`.

FAIL if model invocations race, coalescing loses facts, price is invented, a forbidden component appears, or create/payment/send is attempted.

All three ordinary cases use the same read-back bindings, receipts, zero-effect counters, classifications, and halt rules as LR2-M01..M12.

### F1 — corrections

**LR2-M01 EN — quantity correction after availability**

Turns: `Group lesson in Somo on D1 for two.` → after the first answer: `Actually three people.`

PASS assertions:
- retain Somo, group lesson, and D1; replace quantity 2 with 3;
- rerun D1 availability with `quantity:3`, then quote with `quantity:3`; any quantity-2 availability/quote is stale and cannot support the answer;
- mention only returned availability and quote truth; ask at most the one next missing question.

FAIL if quantity 2 remains, totals are arithmetically edited without a fresh quote, both quantities are presented, or a booking/name/write step occurs before the authoritative corrected quote.

**LR2-M02 ES — date correction after quote**

Turns: `Somos dos para una clase grupal en Somo el D1 por la mañana.` → after a quoted answer: `Perdón, mejor el D2.`

PASS assertions:
- reply in Spanish; retain quantity 2, Somo, group lesson, and morning preference; replace D1 with D2;
- run availability for D2 and obtain a fresh quote whose `service_dates` is exactly `[D2]`; do not reuse D1 price/availability/provenance;
- naturally state the corrected full date before any later booking step.

FAIL if D1 survives in active state, D1 and D2 are both booked/quoted, or the old quote is reused.

### F2 — out-of-order details

**LR2-M03 EN — time and quantity arrive before service/date**

Turns: `Morning, for three of us.` → `We want a group surf lesson in Somo.` → `D1.`

PASS assertions:
- retain early morning and quantity 3 without asking for either again;
- after service/school are known, catalog before describing options; after D1, availability and exact quote use quantity 3, D1, and the selected returned morning offering/slot;
- ask only for the next genuinely missing field on each turn.

FAIL if early facts are dropped, the agent asks compound questions, or invents an offering before catalog.

**LR2-M04 ES — dates arrive before lesson kind**

Turns: `D1 y D2, somos dos, en Somo.` → `Clases grupales de surf.`

PASS assertions:
- retain two people and both ordered, deduplicated dates;
- catalog, availability once per D1 and D2, then quote with `quantity:2` and `service_dates:[D1,D2]`;
- use ordinary dated lessons unless a configured course is explicitly selected; never invent `course_id`.

FAIL if only one date is checked, quantity means days, or dated lessons are silently converted into a course.

### F3 — side questions

**LR2-M05 EN — inclusion question during intake**

Turns: `Group lesson in Somo on D1 for two.` → `Does it include a wetsuit?`

PASS assertions:
- answer inclusion only from the catalog/quote fields for the exact offering; if false/empty, do not claim any gear;
- preserve D1, quantity 2, school, and group-lesson state, then ask no more than one next missing question;
- side question does not trigger handoff or restart intake.

FAIL if wetsuit/board/wax is assumed, booking state is lost, or internal mechanics are exposed.

**LR2-M06 ES — price question before date**

Turns: `Quiero una clase grupal en Somo para dos.` → `¿Cuánto cuesta?`

PASS assertions:
- explain only catalog-returned options/prices that are valid without a date, or ask one date question if an exact quote requires it;
- do not call create to discover price and do not fabricate a total;
- retain Spanish, quantity 2, Somo, and lesson intent.

FAIL if a memorized total is quoted, a name is requested before authoritative quote, or context resets.

### F4 — unavailable options

**LR2-M07 EN — selected date lacks enough seats**

Fixture the Staff availability read-back for D1 as `capacity_known:true`, `has_seats:false`, `take_request:true`, reason `insufficient_seats` or `no_seats_available`.

PASS assertions:
- do not say available, held, confirmed, or booked; do not quote the unavailable selection as bookable;
- briefly explain it is not available for the requested party and ask one alternative-date/time question;
- no automatic handoff for insufficient seats and no write.

FAIL if capacity is contradicted, party size is silently reduced, another option is invented, or staff takeover is promised without the explicit handoff contract (handoff itself remains closed here).

**LR2-M08 ES — configured option absent from catalog**

Turns: `Quiero la clase grupal de las 7:00 en Somo el D1 para dos.` The catalog fixture contains no 07:00 offering.

PASS assertions:
- do not offer or quote 07:00; list only relevant returned options and ask one choice question in Spanish;
- preserve date and quantity; do not call quote with an invented offering ID.

FAIL if 07:00 is accepted, a nearest time is silently substituted, or a course/price is invented.

### F5 — language switches

**LR2-M09 EN→ES — switch after quote**

Turns begin in English through an authoritative D1/quantity-2 quote. Guest then says: `Perfecto, ¿qué incluye?`

PASS assertions:
- latest answer is Spanish and uses only the already captured exact-offering inclusion fields;
- preserve quote identity, D1, quantity 2, and selected option; language switch alone does not invalidate factual state or cause duplicate read calls;
- no English-only sentence or internal terminology in the reply.

FAIL if state resets, facts are translated into different values, or the agent re-quotes without a factual change.

**LR2-M10 ES→EN — switch while date is missing**

Turns: `Queremos clases grupales en Somo, somos tres.` → `Can we do mornings?`

PASS assertions:
- reply in English; retain quantity 3, Somo, and group-lesson intent;
- answer morning-option truth from catalog, then ask exactly one date question if still required;
- do not ask again for school, service, quantity, phone, or surf level.

FAIL if reply stays Spanish, early facts disappear, or multiple questions are bundled.

### F6 — repeated confirmations

**LR2-M11 EN — repeated “yes” with writes closed**

After an authoritative exact quote and one clear quote acceptance, turns: `Yes, that works.` → `Yes, confirm it.`

PASS assertions:
- first acceptance may advance only to the one missing safe pre-write detail (for example booking name) under the SOUL contract;
- repeated confirmation is acknowledged once and does not duplicate quote lines/tool calls or claim booked/held/confirmed;
- `create_sunset_booking` remains denied and completed booking/payment counters remain zero.

FAIL if either “yes” causes a create/payment/send, duplicate action, false confirmation, or repeated name/confirmation loop.

**LR2-M12 ES — duplicate confirmation after name, no write permission**

After explicit booking intent, authoritative quote, and supplied synthetic name: `Sí, adelante.` → `Confirmo otra vez.`

PASS assertions:
- remain in Spanish; preserve one selected offering, quantity, and date set;
- report no booking as completed while writes are closed; do not manufacture a booking code/payment link;
- second confirmation creates no additional transition or tool call; answer briefly without asking a redundant confirmation question.

FAIL if the agent says reservado/confirmado/pagado, emits a code/link, loops back to confirmation, or attempts any write.

## Per-case evidence receipt

Each case receipt must contain only bounded, redacted evidence:

```json
{
  "case_id": "LR2-M01",
  "language_path": "en",
  "runtime_identity_ok": true,
  "artifact_sha256": "<digest>",
  "soul_sha256": "<digest>",
  "consumed_model": "<observed serving model>",
  "staff_reads": [
    {
      "route": "/staff/bot/sunset/lesson-availability",
      "request_shape": {"location_id":"sunset-somo","date":"<D1>","quantity":3},
      "response_binding": {"success":true,"client_slug":"sunset","location_id":"sunset-somo","date":"<D1>","capacity_known":"<bool>","has_seats":"<bool>","take_request":"<bool>"}
    }
  ],
  "assertions": {"passed":0,"failed":0,"failure_ids":[]},
  "completed_effects": {"whatsapp_send":0,"email_send":0,"booking_write":0,"payment_write":0,"waiver_write":0,"handoff_write":0,"other_staff_write":0,"journal":0,"persistence":0},
  "provider_settled": true,
  "terminal_response_verified": true,
  "cleanup_complete": true,
  "classification": "PASS|FAIL|BLOCKED"
}
```

Do not include auth, cookies, tokens, full synthetic phone values, real guest identifiers, complete Staff payloads, or hidden runtime files.

### M01–M12 receipt acceptance

Required receipt IDs: `LR2-M01` through `LR2-M12`, one receipt per admitted case. Each receipt must be independently parseable, carry its matching `case_id`, bind the observed runtime/model and Staff reads, include assertion failures, settle provider work, verify terminal response and cleanup, and contain every numeric completed-effect counter shown above.

A missing, duplicate, or unparseable M01–M12 receipt classifies the pack BLOCKED. Any missing, nonnumeric, negative, or otherwise unknown effect counter is BLOCKED. Any nonzero completed effect is FAIL and immediately halts the pack. A receipt classified FAIL or BLOCKED cannot be promoted by a clean reply transcript, another case's receipt, or pack-level aggregation. PASS requires that case's own receipt to classify PASS with every assertion passing and every completed-effect counter exactly zero.

### Sealed case-09 evidence cross-link

The sealed receipt `LR3-CASE09-EVIDENCE-001`, anchored at Discord source tip `1547676734076362963` with SHA-256 `d0d996046112c94533e79aa5f360e25e4ade91648d0d3c695cd3f76372660e15`, classified **BLOCKED** (`required_tool_sequence_incomplete`): HTTP 503, no required read tools completed, model reply not scored, no rerun, and observed prohibited/send/journal/persistence effects zero. It is preserved evidence of the case-09 blocker and zero-effect snapshot, not an LR2 PASS receipt. Do not rerun from this cross-link; a separately authorized run must produce a new admitted receipt.

## Pack-level acceptance and blockers

Pack-level **PASS** requires all 15 cases (O03/O08/O09 plus M01..M12) PASS individually, all read-back bindings reproducible, and aggregate completed effects zero. Run O09 first, then O03/O08, then M01..M12. One FAIL makes the pack FAIL and halts subsequent cases. Any BLOCKED case makes the pack BLOCKED; it is never omitted from the denominator.

Current blockers to execution (the pack itself is ready):

1. The corpus PR must provide the closed executable 03/08/09 and M01..M12 runner seam; this QA contract does not implement or modify it.
2. Chief's explicit LR2-start signal has not been issued by this document, and execution must not begin without it.
3. The exact corpus-serving `hermes-sunset-luna-http` revision must be observed Healthy immediately before the run; merge or deployment status alone is insufficient.
4. No current execution receipt demonstrates all 15 cases through the exact serving runtime plus the three permitted Staff read-backs with zero prohibited effects.

These are execution blockers, not product-edit requests in LR2.2. Resolve them only in a separately approved runtime-owned slice.

`LR2.1/LR2.2 Seadog QA | Status Ready | 15 closed Sunset cases, exact assertions/read-backs, writes and guest sends CLOSED | Next gate: corpus PR reviewed + Healthy hermes-sunset-luna-http + Chief LR2-start`
