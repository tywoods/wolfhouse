# Ale batch: post-deploy France Wolfhouse staging acceptance

**Deliverable: one operator-executed checklist, not an automated test or a PASS report.**
Prepared for #1672, #1673, #1674, #1675, #1676, #1677, #1678 and #1679.
Run only after the authorized operator confirms the integrated batch is deployed.
This file does not deploy, restart, change configuration, or execute any request by itself.

**Acceptance requires REAL saved staging bookings made through the live simulator.**
A preview, canned tool result, mocked Stripe adapter, offline unit test, or Luna saying
“saved” without an independent Staff readback is not acceptance. Do not manually create
bookings through Staff/API to rescue a failed simulator case.

## 1. Stop/go sheet — complete before any booking turn

- [ ] Deployment owner has supplied the France staging release SHA/digests and confirmed
  all eight PRs (including later fixes) are in the running Staff API **and** classic Luna.
  Record actual images and mounted source/guide identity, not just a merged Git SHA.
- [ ] Confirm the existing France staging host identity with the operator (expected
  `178.33.91.59`), existing classic `hermes-luna` / `ovh-wolfhouse-staff` lane, and
  `https://staff-staging.lunafrontdesk.com`. Host names alone are not deployment proof.
- [ ] Use the existing authenticated Live Simulator, tenant **Wolfhouse Luna** / `wolfhouse`.
  NOT `wolfhouse-prod`, `luna-v3`, Sunset, production `wh.lunafrontdesk.com`, retired
  Azure/Lunabox tooling, an ordinary WhatsApp phone, or the golden dry-run namespace.
- [ ] Staff tenant is `wolfhouse-somo`; operator can view Schedule, booking Invoice,
  Inbox **Lab**, Settings Rentals/Services/Packages, and simulator tool receipts.
- [ ] Record Staff Info's configured handoff name and current Intelligence setting.
  Do not change either to make a test pass.
- [ ] Confirm request-owned external WhatsApp/SMS/email suppression and existing
  no-notification protections; booking/payment writes are scoped to this fake identity.
  No real message, email, card charge, refund, cash receipt, or Stripe completion.
- [ ] Confirm **Stripe TEST**, never live. On the first Staff tool receipt capture
  `effective_capability`: `capability=wolfhouse_staging_booking_test_link`,
  `admitted=true`, `stripe_mode=test`, staging `staff_origin`, and
  `pay_origin=https://staff-staging.lunafrontdesk.com`. Missing/denied/conflicting
  evidence => **BLOCKED**, not permission to change env, credentials or routing.
- [ ] Reserve an unused run ID and fresh fake phone for each case below. Use
  `+999<10-digit run ID><2-digit case>` (15 digits; unassigned +999 namespace), never
  a real guest/tester's personal phone. First confirm each has no prior Lab thread.
  Record both entered phone and runtime-returned synthetic +999 identity: the protected
  door hashes the input, so the saved booking phone may differ from the entered phone.
  Do not guess the hash or look up someone else's booking when they differ.
- [ ] Identify available future dates and current Staff-priced fixture terms. Do not
  change inventory, prices, package defaults, flags, or global switches for this run.
  Book disjoint date/bed windows so one case does not invalidate another's availability.

### Important simulator contract — do not bypass it

The existing UI uses `POST /api/live-simulator/guest-turn` with
`{tenant: "wolfhouse", from_phone: "<fresh fake phone>", text: "<guest message>", lang: "en"}`.
The server forwards to `/wolfhouse/simulate-guest-turn` and owns write admission.
Browser `allow_writes` is NOT authority; the protected runtime deliberately ignores it.
The CLI wrapper's historical `--allow-writes` description is not a reason to use it here.
The generic proxy's legacy `writes_enabled=false` display is not conclusive either:
require the actual per-tool capability and independent saved-row readback above.

Send ordinary guest messages through the simulator, not raw booking/payment tools.
Do not use `messages: [...]` or the old burst endpoint: source explicitly returns
`legacy_burst_disabled_for_one_runner_safety`. For the timed pair in case B, use two
normal sends for the **same phone**, with captured timestamps. If the UI serializes
sends so the required gap cannot be achieved, mark that subcase BLOCKED; do not splice
text into one message, disable the send lock, or claim a timing pass from a helper test.

## 2. Evidence and independent readback — mandatory for EVERY booking

Create a private evidence directory outside this PR's tracked file. Each case gets:

`case / run ID / entered phone / synthetic phone / conversation ID / booking ID / booking code /
release identity / sent-turn timestamps / guest transcript / tool receipts /
before-context / after-context / Invoice screenshot / verdict + reason`.

Never publish auth cookies, internal tokens, environment dumps, or live Stripe secrets.
Save complete raw evidence privately; share redacted summaries, including actual numeric
amounts and test session IDs. Do not paste unrelated guest records into the report.

### R — readback procedure (repeat at every R checkpoint below)

1. Save the simulator's complete reply/tool receipt. Require successful create and
   `write_performed=true` plus a real booking ID/code. Capture any `payment_id`,
   `booking_guest_id`, per-person link and session identifiers. A booking is not proven
   by `ok=true` on the simulator envelope alone.
2. Independently open **France staging Staff → Schedule**, search the exact new booking
   code, open its drawer and Invoice, then refresh. Confirm the code and ID match the
   receipt, the synthetic phone, dates, guest count/names, package, assigned beds and
   saved services. It must not be just a pending in-chat quote.
3. From an authenticated tab on the exact staging origin, obtain a fresh read-only
   `GET /staff/bookings/<booking_code>/context?client=wolfhouse-somo`. Capture response
   JSON through the browser Network panel. Do not export authentication headers.
   The request must return 200, `success=true`, the correct client/code and booking ID.
4. Record `booking`, `booking_guests`, `guest_rooms`, `rooming`, `payments.rows`,
   `financials`, `service_records`, `addons`, `conversation` and `handoff` when present.
   Missing required data is BLOCKED/FAIL, never a zero default or assumed success.
   `booking.total_amount_cents` may be a display projection; preserve the full financial
   provenance rather than silently substituting stale raw totals for the Invoice total.
5. Record three DISTINCT amounts in cents: invoice total **T**, actual paid receipts
   **P**, and selected active link amount **L**. Also record current balance due **B**.
   For the eight NEW simulator bookings, P stays zero and B must equal T.
   The separately labelled read-only Gina fixture below already has P=32500; do not
   create a receipt or charge a card to manufacture that paid history. A link sent
   is NOT money received. “Remaining after paying this link” may be T−P−L, but must
   never replace actual current balance T−P. Compare against Staff's financial projection
   and Invoice, not arithmetic alone or Luna's wording.
6. Refresh after the next turn. Confirm the same booking ID remains and that no duplicate
   save, service, payment receipt, or bed assignment appeared. A missing link/handoff must
   not erase or roll back a successfully saved booking.

**Payment-status evidence:** ask in the simulator, “Have my payment links been sent, and
have I paid anything yet?” Capture the `get_payment_status` tool result. The existing
read-only bot operation is POST `/staff/bot/payments/status` (via Luna's authorized tool;
no new token/privileged runner). After a real TEST checkout is created, its projection
must not say `booking_payment_status=not_requested`: require the matching links-created
projection (`checkout_created`, or `waiting_payment` / `payment_link_sent` when that is
what the actual active row reports), while the saved paid amount stays zero and no
returned field claims paid/fully paid. #1679 preserves the actual link status; it does
not force one label. Preserve the exact returned status and raw payment rows: the fix
is read projection, not permission to
mark the booking paid or demand a raw-DB status migration. Reopening the Invoice must
show the unpaid balance and a sent/created link, not “paid”.

**Short-link evidence:** inspect the exact returned STAGING `/pay/<code>` or `/g1` URL
with a single no-follow HTTP GET (browser Network or `curl --max-redirs 0 -D ... -o ...`).
Require a redirect Location to `https://checkout.stripe.com/` with a TEST session;
verify its session ID and amount against the saved active payment row. Do not follow or
pay a live checkout. A 200 error page labelled inactive is a failure, not a working link.
No `-L`, payment confirmation, card data, or live-redirect enablement.

## 3. Fixture worksheet — use saved Staff facts, not historical prices

Fill before running. All money comparisons use integer cents.

| Fixture | Required current fact | If unavailable |
|---|---|---|
| Split | Two available women-only beds + one mixed bed, approved indexed allocation | Choose another future window; never displace guests |
| Amount switch | A valid two-person quote with total 41500 and deposit 20000 | Mark exact €200→€415 case BLOCKED; optionally record a separately labelled current-price variant, not a pass |
| Rental | Active Staff rental (e.g. FLIPFLOPS) at 1000 per person/day | Exact €100 case BLOCKED; do not alter price or hardcode a tool amount |
| Yoga | Active yoga service, ID, unit and current **unit** price U; #1675 fixture U=1500 per class | Record quantity separately; do not turn two €15 classes into one €30 class |
| Per-day Service | Staff **Services** item (`item_type=service`), configured `per_day` unit and 1000/day | Exact €50 case BLOCKED if absent; a Rental is not a substitute |
| Gina original | Operator-identified synthetic staging fixture: total 97500, paid ledger 32500, service sum 30000; original zero/bundled snapshots | Read-only; absent fixture is BLOCKED, not permission to copy production or seed money |
| Inactive links | Three synthetic staging payment fixtures: cancelled / expired / failed, each retaining a nonempty checkout_url | Read-only; absent fixture is BLOCKED, not permission to edit rows or cancel links |
| Half-day | Active rental option whose configured unit/label is half-day | BLOCKED rather than silently treating it as a full day |
| Shuttle | Package ID, current default nights N, minimum nights, Includes and full-stay-only flag | Pick an eligible package/window; do not confuse minimum nights with default nights |

For shuttle below-default testing choose a stay with minimum_nights ≤ N−1. If none
exists, the below-default scenario is BLOCKED. No config edits are authorized here.
For the €415 scenario select a fresh future window/quote, not protected historical
bookings `WH-20270615-14908309` or `WH-20271015-01957358`; those remain untouched.

## 4. Cases — live simulator saves, not replayed fixtures

Respond naturally to genuinely missing dates/names/package questions. After a clear
choice to book, do not answer an extra “shall I save?” to conceal a regression: record
that unnecessary confirmation as FAIL. Never feed internal API payloads as guest prose.

### A — person-bound split save, then warm handoff (#1672, #1673)

Fake phone suffix **01**. Names: Ale Test Ada, Ale Test Bea, Ale Test Cal.

1. Request the available dates/package for three people: “Ada and Bea are women and
   want the women-only shared room. Cal will take a mixed shared-room bed.” Leave Cal's
   gender unspecified. Let Staff check the actual indexed allocation and quote it.
2. Accept the quoted arrangement and choose deposit/together when needed. Require one
   REAL saved booking for all three, not three unrelated saves or a handoff instead.
3. **R-A1:** three named guests mapped to the approved distinct beds; Ada/Bea in women-only,
   Cal in mixed. No demand for Cal's gender as a prerequisite for the mixed bed; no false
   “no girls room” contradiction from whole-party metadata. Record actual payment row(s).
4. Only after R-A1, send: “My card was charged but I got nothing. Please ask your team
   to help me with the payment.” This is synthetic guest dialogue, not a real card claim.
5. Require Luna's warm note naming the **current Staff Info person**, in the guest language,
   BEFORE the persisted handoff/pause. Do not require one exact canned sentence.
6. **R-A2:** same booking/guests/beds/payment receipts; Inbox Lab Needs human=true, actual
   handoff ID and reason, pause state, and transcript/receipt ordering showing warm note
   before handoff. No replayed booking card, new booking or second payment operation.
   Check `GET /staff/bot/pause-state` via the existing Staff UI request if the context
   omits pause state; bind it to this tenant/conversation. Missing ordering evidence is
   BLOCKED, not a pass from the Needs human badge alone.

### A-H — explicit handoff reasons beyond payment complaints (#1673)

The payment complaint alone does NOT cover removal of reason-based vetoes. Keep two
separate evidence columns: **offline explicit-tool reason coverage** and **live simulator
behavior**. Never put internal reason strings into guest prose to force a model branch.

| Required reason family | Exact source regression inputs (not guest messages) |
|---|---|
| Human / safety | `human_requested`, `urgent_safety` |
| Saved-booking room diagnostics | `business_tool_error: private room mismatch`, `business_tool_error: bed_already_taken`, `post_save_room_check` |
| Other saved-booking diagnostics | `booking_create_failure_limit`, `misc_booking_check`, `unknown` |
| Unsaved clarification / saved-action redirect | `booking_create_failure_limit`, `low_confidence`, `missing_information`, `saved_booking_action: resend payment link` |
| Payment operation failure (not a complaint) | Both create and retry operation reasons from `test_payment_complaint_routed` / `prove-complaint-notice-sql.py` |

- [ ] At the integrated release source, run the existing offline
  `wolfhouse.test_create_failure_handoff` explicit-reason tests and
  `wolfhouse.test_payment_complaint_routed`; retain exact test/subtest results and reasons.
  Use their isolated fixture transport; no live credentials or guest calls. A timeout or
  baseline failure is reported by name, not relabelled a full-suite PASS. The existing
  `scripts/prove-complaint-notice-sql.py` additionally checks durable handoff SQL for the
  payment create/retry reasons. Offline proofs supplement, never replace, live readbacks.
- [ ] After E's final payment-status readback, use E's saved conversation: “Please let me
  speak with your team about my booking.” Require an actual explicit handoff tool call,
  warm configured-person note first, then one persisted handoff + Needs human + pause.
  **R-HO-human:** same booking, beds, totals and receipts; no create or payment-link replay.
- [ ] After C's final payment-status readback, use C's saved conversation: “I think the
  shared-room assignment is wrong. Please ask your team to check it with me.” Capture
  the actual explicit tool reason and **R-HO-room** with the same note/order/persistence
  checks. A warm reply without persisted handoff is FAIL when the explicit tool was called.
- [ ] For every exact reason above, require successful explicit-tool persistence in the
  offline trace: no `success=true` / `handoff_persisted=false` / `do_not_escalate=true`
  no-op because a saved receipt exists or a reason was classified as a diagnostic.
  Preserve the saved receipt; the unsaved controls must not create a booking as a side effect.
- [ ] Record live reasons actually observed, not reasons merely intended by a prompt.
  An unobserved reason is NOT EXERCISED live, even when its offline subtest passes.
  Do not make a real safety allegation, inject failures into shared staging, reset a
  paused conversation, or manually call handoff APIs to fill the matrix. This tests an
  explicit call being honored; it does not require every low-confidence reply to escalate.

### B — together-only draft, full/deposit switch and timed correction (#1674)

Fake phone suffix **02**. Names: Ale Test Dana and Ale Test Eli. Use verified 41500/20000 fixture.

1. Reach the explicit save decision, then answer only “pay together” to the payment
   distribution question. Do NOT also supply deposit/full yet.
2. Require the booking save to proceed without another save-consent gate. Luna must ask
   **deposit or full**, without issuing a guessed deposit link first.
3. **R-B1:** booking exists, unpaid draft amount 20000, no active checkout for that draft.
   If no draft exists, record the actual flow; the exact draft regression is NOT covered.
4. Reply “full ammount”. **R-B2:** same booking; real Stripe TEST session amount **41500**;
   saved link receipt and Luna's amount agree. `/pay/<code>` resolves to that session.
   A success receipt with 20000 is FAIL, even if Luna says €415.
5. After that response is complete, send “actually deposit please”. **R-B3:** same booking,
   selected TEST link amount **20000**, a replacement session rather than reuse of the
   wrong-amount full session, `/pay/<code>` selects 20000; saved amount and copy agree.
   T=41500, P=0, B=41500; conditional remainder after deposit=21500, not actual paid money.
6. Timed subcase on this saved booking: send **“full”**, then **“actually deposit”** as
   separate simulator bubbles **2–3 seconds apart**, before waiting for a final first
   response. Record actual server ingress times/turn IDs, not just UI click times.
   After both turns settle, **R-B4:** final choice/link/copy are **deposit / 20000** and
   there is no late full-payment reply overwriting the correction. No new booking.
   If arrival gap exceeds the configured 8-second window, this subcase is BLOCKED and
   needs a clean retry; do not report the slower sequential test as a timed pass.
7. Run payment-status evidence from section 2; **R-B5** again proves P=0 and no duplicate save.

### C — separate payment and person-bound active /g1 (#1674, #1679)

Fake phone suffix **03**. Names: Ale Test Fran and Ale Test Gus.

1. Save a two-person booking using “separate” only. Require deposit-or-full clarification,
   not a default guessed from distribution. Then choose deposit.
2. **R-C1:** actual person-bound payment records/guest IDs and distinct `/g1`, `/g2` links.
   Record each guest's saved share; do not assume the whole booking deposit per person.
3. No-follow GET `/g1` and `/g2`: each must remain active and redirect to its OWN TEST
   session and saved amount. A €100 person share must not be rejected for differing
   from the booking's €200 aggregate, or inflated to €200 by session replacement.
4. Ask to send Fran's existing deposit link again. **R-C2:** same guest binding, no
   whole-booking amount substitution, no additional booking/payment receipt; recheck `/g1`.
5. Capture payment-status tool result after links sent, then **R-C3**. Links-sent != paid.

### D — add yoga + two rentals after save; invoice and balance (#1675, #1677, #1679)

Fake phone suffix **04**. Names: Ale Test Hana and Ale Test Ivo. Stay exactly five nights.

1. Save the base booking first with chosen deposit; **R-D0** records base invoice total T0
   and paid amount P=0. Do not add the extras before this baseline snapshot.
2. Say: “Please add one yoga session for Hana.” Require a current Staff Services lookup,
   quoted live unit price U and quantity **1** (Y=U), one accepted service save, then
   **R-D1**: service row/guest/quantity match;
   Invoice total = T0+Y and current balance = T0+Y−P. Service appearing only under SERVICES
   with unchanged Invoice total is FAIL. It must not subtract yoga out of accommodation.
3. Say: “Please add flip-flop rentals for both of us for all five nights, one each.”
   If a different active €10/day rental was selected in the worksheet, name it instead.
   Require real catalog ID/unit/price evidence and acceptance through the ordinary flow.
4. **R-D2:** **2 rentals × 5 billable days × 1000 cents = 10000 cents (€100)**, not one
   rental, a one-off €20, ten days per person, or six days including checkout. The actual
   five-night date range and requested quantity must be bound to the saved charge.
   Invoice total = T0+Y+10000; current balance = that total−P. With the actual #1675
   fixture T0=41500 and **one class at 1500**, R-D1 is **43000 (€430)** and R-D2 is
   **53000 (€530)**. The previous €545 example assumed the wrong yoga quantity/price.
   Record actual configured prices; a changed catalog is a labelled price variant, not
   an exact-fixture PASS. See the source-executed comparison table below.
5. Reopen Invoice and ask Luna “What is the updated total, what is due now, and what
   will remain after I pay that link?” **R-D3:** match the fresh saved ledger/link, not
   the old quote. Record actual current balance separately from conditional remainder.
6. Existing rental/yoga already counted in T must not be billed a second time or described
   as another charge **“due at checkout”**. A truthful unpaid booking balance due on
   arrival is allowed; this is not a blanket ban on describing a remaining balance.

### D-S — per-day Staff Service, not a Rental (#1675)

Continue D only after R-D3, using the same five-night saved booking and synthetic phone.

1. In **Staff Settings → Services**, capture a configured item (fixture: Bike /
   `bike_rental_desk`) with `item_type=service`, rule `unit=per_day`, and price 1000.
   Capture the item UUID/code and lookup's `catalog_kind=service`, `price_unit=per_day`.
   Being called “Bike” is insufficient: a Rentals entry does not cover this path.
2. Ask Luna to add **one** of that Service for the whole five-night stay. Accept its
   Staff-backed quote. Require one ordinary service write, not another booking.
3. **R-D-S:** one saved service record bound to D, quantity=1, five billable days,
   unit=1000 and amount_due_cents=**5000 (€50)**. Neither 1000 per stay nor 10000 for
   both guests is correct. Invoice and current unpaid balance increase by exactly 5000.
   With D's exact 53000 baseline, new total/balance is **58000 (€580)**.
4. Reload and ask for the updated total: same booking/row, no duplicate charge and no
   rental substitution. Missing configured Service => BLOCKED; do not add/change pricing.

### Source-executed price controls — different quantities, not competing totals

These are **offline code outputs**, not proof of live staging acceptance. Run D/D-S
against current Staff facts and retain actual quantities; never silently select whichever
headline amount makes the run green.

| Fixture/input | Invoice total | Paid / current balance |
|---|---:|---:|
| #1675 one yoga: 41500 stay + 1 × 1500 | 43000 (€430) | 0 / 43000 |
| #1675 one yoga + 2 rentals × 5 days × 1000 | 53000 (€530) | 0 / 53000 |
| #1677 original yoga-only: 41500 + **2 × 1500** | 44500 (€445) | 0 / 44500 |
| #1677 same two yoga + **one** five-day rental (5000) | 49500 (€495) | 0 / 49500 |
| D-S adds one per-day Service (5000) to D | 58000 (€580) | 0 / 58000 |

Source: #1675 `75cbf43303db490b4885e39e72db37dac5829201` charge functions and
#1677 `648164decb482bc309ec1a1a6ce4242fc098005b` ledger/fixture. The #1677 yoga
control is explicitly two classes, not D's one-class request. Changing expected copy
alone does not fix a saved quantity, unit or invoice mismatch.

### E — half-day label and create-time included extra (#1675, #1679)

Fake phone suffix **05**. Names: Ale Test Jo and Ale Test Kim.

1. Before saving, request one configured **half-day** rental for Jo on a specific stay
   date plus the selected base stay. Require a quote that includes that extra in its total.
2. Accept and save. **R-E1:** actual rental/service ID, person/date, quantity, half-day unit,
   configured price and inclusion in the saved quote/Invoice. No hard-coded half-day price.
3. Transcript, confirmation and Invoice must say half-day (or natural equivalent in the
   guest language), not full day or an unexplained internal unit token. Do not demand
   a literal English label from a non-English conversation.
4. **R-E2** after reload: same total and balance, no duplicate extra charge. The included
   extra must not also be presented as a separate “due at checkout” amount. Capture the
   create-time quote snapshot to distinguish already-included vs later-added services.
5. Payment-status evidence after the link is sent; no invented payment receipt.

### F / G / H — shuttle boundary from CURRENT package default (#1676, #1677)

Fake phone suffixes **06 / 07 / 08**. Each case makes its own REAL saved booking.
Choose the same eligible package and read its current N/default_nights + Includes before
EACH quote. Capture actual stay length, package ID, default N, full-stay-only flag and
fresh stay-filtered `includes_line` / `package_includes`. Description is not authority.

| Case | Stay nights | Required spontaneous Luna behavior |
|---|---:|---|
| F | N−1 (and ≥ minimum nights) | No free-shuttle claim, proactive offer, upsell, contrast or shuttle question; continue and save |
| G | N | Qualifying shuttle included/offered from current Includes; one optional offer, not a save gate |
| H | N+1 | Same qualifying behavior, never a fixed “six nights” cutoff |

1. Request the package for the required date range. Initially do NOT mention shuttle:
   otherwise an answer to an explicit request would not test a proactive erroneous offer.
2. Accept the stay and payment choice. For G/H, answer any qualifying shuttle offer with
   “No shuttle needed”; that answer must stick, not cause repeated offers or block saving.
3. **R-F / R-G / R-H:** verify all three persisted booking/date/package identities, totals,
   payment state, transcript and absence of unintended transfer records. No free shuttle
   added on F. No created transfer for declined G/H; inclusion eligibility is not consent.
4. If default N changes during the run, re-read and reclassify/retry affected cases; do
   not compare against a stale N. A stored empty or contradictory Description must never
   override current Includes. Record its actual value; do not edit it during this test.

### W — real web-search answer without corrupting a saved booking (#1678)

Use H's saved booking/phone after R-H; no additional booking is required.

1. Ask: “Could you look up a pizza place near Wolfhouse in Somo for tonight and send me
   the source?” Require an actual `search_public_info` call and successful source evidence,
   not a plausible remembered restaurant. Staff Intelligence must already be ON.
2. Verify named place/location against the returned source URL, open that PUBLIC source,
   and compare answer facts. If current opening hours are not established, Luna must say
   so rather than invent them. Record fetch time, source and tool outcome. No fabricated
   URLs, `intelligence_off` with Intelligence ON, irrelevant-city answer, or unnecessary
   handoff masquerading as a successful web answer.
3. **R-W:** H's booking/guests/beds/services/total/payment state unchanged; no new booking,
   payment attempt or unexpected pause. A source/provider outage is BLOCKED with its real
   error, not a content PASS from model memory.
4. This proves France staging web-search behavior only. #1678's production-origin
   allowlist cannot be proven by a staging run; do NOT call production to expand coverage.

### I-GINA — original €975 / €650 controls (#1677, Lookout 648164de)

**Read-only historical-shape regression; NOT another newly paid simulator booking.**
Use only operator-identified, isolated synthetic fixtures already present on France
staging. Do not query, edit, import or replay the real Gina guest booking in production.
If either staging shape is unavailable, mark it BLOCKED and retain the offline result
separately. This checklist authorizes no fixture seeding or paid-receipt creation.

1. For BOTH original shapes, record `total_amount_cents=97500`,
   `deposit_required_cents=32500`, active service sum=30000, **actual paid ledger=32500**,
   no transfer charges, and the exact raw `metadata.quote_snapshot`:
   - **Zero snapshot:** `line_items=[{code: 'guest_package', total_cents: 0}]`.
   - **Bundled snapshot:** `line_items=[{code: 'guest_package', total_cents: 97500}]`.
   These original fixtures do **not** contain `quote_snapshot.total_cents`; do not
   normalize them into a stay-only quote or add an `additional` flag to rescue a result.
2. **R-GINA-zero / R-GINA-bundled:** independent booking context + refreshed Invoice
   must each show **invoice_total_cents=97500 (€975)**, **paid_total_cents=32500 (€325)**,
   **balance_due_cents=65000 (€650)**. Preserve original snapshot and service rows.
   The zero snapshot must not erase accommodation; the bundled services must not be
   charged again. A quote/receipt without the independent invoice readback is insufficient.
3. Refresh again: identical booking ID, paid ledger, service rows, total and balance;
   no write, link request, extra receipt, cancellation or guest message.
4. Retain the exact-source offline controls in
   `scripts/verify-luna-added-services-invoice-total.js` at `648164de` (or their preserved
   integrated equivalent). Both original assertions are required. Its **additional-combo**
   €1275 / €950 case is different and must NOT substitute for the original €975 / €650.

### I-DEAD — stale checkout_url is NOT an active checkout (#1679)

Read-only checks on THREE separate, isolated synthetic staging fixtures. Each must have
`booking_payment_status=not_requested` before projection, an unpaid latest payment in
one of the states below, and a **retained nonempty checkout_url**. Capture latest row,
all payment rows and paid receipts so an active/paid row cannot explain the result.
Do not cancel/expire/fail a payment or edit a DB row to construct this test. Absent safe
fixtures => BLOCKED; the exact-source offline matrix is separate, not a staging PASS.

| Fixture latest status | Required projected payment_status | Required booking_payment_status | Required latest_payment.payment_status |
|---|---|---|---|
| cancelled | cancelled | cancelled | cancelled |
| expired | expired | expired | expired |
| failed | failed | failed | failed |

1. Through each fixture's existing simulator conversation, ask “What is my payment
   status?” Capture the actual `get_payment_status` result from the deployed handler.
   The prompt is a status query only, not consent to issue or replace a link.
2. **R-DEAD-cancelled / R-DEAD-expired / R-DEAD-failed:** compare the returned fields
   against the matrix and the independent Staff booking/payment readback. None may be
   promoted to **checkout_created**, `waiting_payment` or `payment_link_sent` merely
   because checkout_url exists. Luna must not claim an active checkout or a paid booking.
3. Require paid amount still zero, same booking and payment IDs/status/URL before/after,
   and no new link/session, receipt or booking. Do **not** open the stale URL: section 2's
   redirect check applies to active TEST links only. Projection must not mutate rows.
4. Preserve the #1679 offline `verify-luna-payment-status-after-links.js` matrix at
   `c570d46db33f91f3b9a96a51350d97cedf14a2d2` or its integrated equivalent, including
   active-link, already-paid and no-link controls. Reading a stale URL alone is not proof.

## 5. Optional failure observation — never damage shared staging to induce it

If a real test-link write fails during any required case, immediately read the booking
back. It must still be saved, with a warm configured-person note and persisted Needs human
handoff, rather than a new save veto, fabricated success or false paid status. Capture
before/after receipt and note→handoff ordering as in A. Do not disable Stripe, change keys,
restart services, inject a global network failure, or alter another PR's code to cause it.
Without a failure occurrence or a separately approved request-local fault facility,
report link-failure coverage **NOT EXERCISED**. Case A is not a claim of injected Stripe-failure coverage.

## 6. Verdict and closeout — no inferred PASS

Use **PASS / FAIL / BLOCKED / NOT RUN**, with one evidence-backed row per subcase.
A failed assertion is FAIL; unmet safe preconditions, missing data, unavailable fixture,
untestable ingress timing or provider outage is BLOCKED. Neither is green. Do not skip
an exact-price case or one of the eight real booking readbacks to report “all passed”.
Gina and inactive-link fixtures are additional mandatory read-only staging controls;
missing fixtures block those rows and overall acceptance, even with green offline tests.
For A-H report exact-reason offline coverage separately from live human/room handoffs.

| Checkpoint | Saved booking code/ID | Evidence files + actual values | Verdict/reason |
|---|---|---|---|
| A split / payment-complaint handoff | | | NOT RUN |
| A-H exact-reason offline matrix + create/retry SQL | Offline evidence only | | NOT RUN |
| A-H live human request (E) / room check (C) | | | NOT RUN |
| B draft 20000→41500 | | | NOT RUN |
| B 41500→20000 / timed correction | | | NOT RUN |
| C /g1 and /g2 person amounts | | | NOT RUN |
| D one yoga / two rentals × five nights (43000→53000 fixture) | | | NOT RUN |
| D-S per-day Staff Service: 5000 increase | | | NOT RUN |
| E half-day / already-in-total extra | | | NOT RUN |
| F below current default | | | NOT RUN |
| G at current default | | | NOT RUN |
| H above current default | | | NOT RUN |
| W real search + unchanged H booking | | | NOT RUN |
| Payment-status evidence B/C/E | | | NOT RUN |
| I-GINA zero snapshot: 97500 total / 65000 balance | | | NOT RUN |
| I-GINA bundled snapshot: 97500 total / 65000 balance | | | NOT RUN |
| I-DEAD cancelled + retained checkout_url | | | NOT RUN |
| I-DEAD expired + retained checkout_url | | | NOT RUN |
| I-DEAD failed + retained checkout_url | | | NOT RUN |
| Observed link-failure preservation (optional) | | | NOT EXERCISED |

Final summary includes release identity, ALL eight new booking codes/IDs and fake phones,
additional read-only Gina/dead-link fixture IDs, actual financials/session IDs, exact
handoff reasons and offline/live coverage distinctions, ordering evidence, redirects, test start/end times and
failures/blockers. Confirm no real external transport, live payment or production operation.
Leave test bookings and evidence intact for inspection. Cleanup/cancellation/deletion
requires separate approval; do not use `--reset`, erase sessions, delete rows or silently
cancel inventory as part of this checklist.

## Source anchors used to prepare this checklist (read-only)

- `scripts/lib/crowsnest/crowsnest-live-simulator.js`: tenant mapping, guest-turn route.
- `docker/hermes-staging/wolfhouse/simulate_core.py`: protected route, disabled legacy burst.
- `docker/hermes-staging/wolfhouse/crowsnest_guest_door.py`: +999 binding, owned writes,
  request-owned external transport suppression, per-tool capability receipt.
- `docker/hermes-staging/wolfhouse/simulate_write_guards.py`: exact staging origins,
  TEST-only capability, no client-supplied write bypass.
- `scripts/staff-query-api.js`: booking context, read-only payment status, pause-state.
- PR #1672/#1673: split allocation, durable note-before-handoff, no save veto.
- PR #1674: saved amount, replacement session, distribution vs tier, timed answers.
- PR #1675/#1677: live rental/service lookup, later service invoice totals, shuttle default.
- PR #1676: Includes guidance, no hard-coded nights or added consent.
- PR #1678/#1679: public-search origin, included-extra copy and links-sent projection.
- #1675 `scripts/verify-luna-rental-service-addon-lookup.js`: €15/class, quantity,
  per-day **Service** (not Rental) fixture and real charge functions.
- #1677 `scripts/verify-luna-added-services-invoice-total.js` at `648164de`: two-yoga
  €445, one-rental €495, original Gina zero/bundled €975/€650 controls.
- #1679 `scripts/verify-luna-payment-status-after-links.js`: cancelled/expired/failed
  rows retain checkout_url but project their real inactive state.
- #1673 `wolfhouse/test_create_failure_handoff.py`, `test_payment_complaint_routed.py`
  and `scripts/prove-complaint-notice-sql.py`: explicit reason matrix, note-before-pause.

Implementation is intentionally confined to this ONE NEW Markdown file. Execution
requires the existing post-deploy operator/simulator; publication does not claim live acceptance.
