# P1 audit: Luna asks, the guest answers, and the answer does not stick

Audit of classic Luna at `2ee8f8e8ba81ad35ec1f56f71fd753dd08c0dda5`.
Read-only. No runtime was changed and nothing was deployed.

The owner's complaint is that the smallest loop is not solid: Luna asks one
question, the guest answers, and Luna understands that answer. On staging that
loop fails for group payment, a bare shuttle "yes", and a payment choice that
is asked before the booking exists. A solo booking can still get a payment
link while `bookings.payment_status` stays `not_requested`.

## Verdict on the hypothesis

Partly confirmed.

A `pending_question` descriptor is often written into the Hermes session ledger
and, for three kinds, is handed to the model on the next turn. It is not an
answer binding. Nothing matches the next guest message to that descriptor and
writes the selected field before the model speaks.

Several questions Luna actually asks are not that descriptor at all. A shuttle
"yes" and a Spanish "sí" match no parser. English words such as `full` and
`together` are scanned only as a side effect of a later tool call, and they
are not checked against the question that was open. One stored question cannot
represent "deposit or full, and together or separate" asked in the same
message. Re-quoting with `present_payment_options` returns a `payment_choice`
question before any booking row exists.

Separately, the solo `not_requested` status is a swallowed SQL error:
`booking_guests.payment_status` is `text` and the link writer compares it to
the `payment_status` enum.

## Path the next reply actually takes

```
WhatsApp webhook
  → gateway patches (burst coalesce is off unless explicitly enabled)
  → one model turn
  → observe_owner_turn stores the raw text and does not interpret it
  → pre_llm_call may attach the previous pending_question descriptor
  → the model calls tools, or it does not
  → only quote / create / saved-payment preparation scans English payment words
  → the end-of-turn finalizer may overwrite pending_question with whatever it just asked
```

1. Meta's webhook is acknowledged by the gateway. `install_runtime_whatsapp_patches` in `docker/hermes-staging/apply_gateway_patches.py` (around 1927–1973) installs the burst coalescer. `coalesce_enabled()` in `docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py` (65–70) is false unless `WHATSAPP_BURST_COALESCE_ENABLED` is on. When it is on, messages in the quiet window are joined with newlines (`whatsapp_burst_coalesce.py` 450) and become one turn. When it is off, "full" and "together" a few seconds apart are two model turns. The first turn can re-ask before the second bubble exists.

2. `install_owner_hook` wraps `conversation_loop.run_conversation` (`accepted_quote.py` 6571–6686). It consumes the original inbound text and calls `observe_owner_turn` before the model runs.

3. `observe_owner_turn` (`accepted_quote.py` 1907–1965) stores `current_turn.raw`. Bubbles inside 8 seconds are concatenated (`pending_question.py` 26–60, called at `accepted_quote.py` 1945–1957). The comment at 1964–1965 is the policy: raw text is provenance and locale only. Observation never selects an offer, a shuttle, or a payment option.

4. `pre_llm_call` calls `_pending_question_model_context` (`plugins/wolfhouse_staff_api/__init__.py` 6286–6319 and 6399). The descriptor is copied into the prompt only when `kind` is `add_on`, `payment_choice`, or `go_ahead` (6305–6307). `names` is stored and then omitted. If that read throws, the `except` at 6292–6293 returns `None` and the model is given no question.

5. `interpret_owner_turn` (`accepted_quote.py` 1881–1904) is read-only. A model "accept" payload, including `shuttle_choice: accepted`, changes nothing. The tests in `test_pending_question.py` (92–108 and 50–68) lock that in: "Yes" and "Sí" are provenance, not authority.

6. The only writer from guest wording onto payment fields is `_with_inferred_guest_payment` (`accepted_quote.py` 2439–2486), and it runs only from `prepare_quote` (2499), `prepare_create` (3404 and 3481), and `prepare_saved_payment` (4051). If the model answers in prose and calls none of those tools, the reply dies with the turn. `recent_guest_turns` keeps the text, but the next inference reads only the new `current_turn.raw`.

7. After the model reply, `finalize_offer_response` may persist a new descriptor (`accepted_quote.py` 6480–6509). That records the question just asked. It does not record the guest's answer.

The ledger key is `wolfhouse.accepted_quote.v1:` in SessionDB `state_meta` (`accepted_quote.py` 55, 481).

## Root causes

### 1. There is no answer binding

`pending_question.persist` (`pending_question.py` 250–257) writes `{kind}` and, only when the list length is exactly 2, `options`. It does not store the message id, the sentence that was sent, or a place for the answer.

`quote_question_kind` (`pending_question.py` 214–235) returns one kind:

- `go_ahead` immediately when `create_ready` is true, even if the shuttle is still unresolved (216).
- `add_on` when a package shuttle is unresolved and the stay qualifies (230–232).
- otherwise `go_ahead`.

Deposit/full and together/separate are comments at 233–235: they belong after the booking exists. `rendered_options` (238–247) returns `None` unless the kind is `payment_choice` and the booking is not create-ready, so `go_ahead` and `add_on` are stored with no options. A later "yes" has no option list to select.

The prompt tells the model to "use these facts and the conversation to understand the guest's reply" (`__init__.py` 6312–6315). Understanding is a model choice. The owner then ignores that choice unless a tool happens to carry a typed field.

### 2. Group payment: two questions, one slot, English side-scanner, then the same question again

What the guest hears is not one stored question.

- Soul step 5 tells Luna to ask together or separate before create, and step 8 says to save first and ask deposit or full after (`docker/hermes-staging/soul-guides/07-payment-choice-booking.md` 28–33). The shuttle guide repeats both instructions (`08-shuttle.md` 12, 25–26, 37–38).
- `saved_payment_question` (`pending_question.py` 89–95) returns only one of those decisions: deposit/full if the amount is unresolved, otherwise together/separate. Both use `kind: payment_choice`.
- `_quote_question_descriptor` (`accepted_quote.py` 4918–4921) runs before that policy. If the quote carries `_present_payment_options == ['deposit', 'full']`, it returns `payment_choice` / `['deposit', 'full']` and never looks at `create_ready`. `record_quote` puts that flag on the quote response when the declaration is valid (2948–2949) and returns the descriptor to the tool (3268–3272). The plugin copies it onto the tool result the model sees in the same turn (`__init__.py` 6196–6201), before any booking insert.

So a group turn can ask deposit-or-full and together-or-separate in one message, while the only stored question is pre-save `payment_choice: [deposit, full]`. The guest's answer has one slot, and that slot is the wrong moment (before save).

If a tool does run, `infer_payment_completions` (`pending_question.py` 12–25, 129–174) matches English `full`, `deposit`, `together`, `separate`, and `each`. Checked at this commit:

| Reply | Result |
| --- | --- |
| `yes`, `Yes`, `sí`, `si`, `completo`, `juntos`, `por separado`, `sí, el total`, `oui`, `ja` | `{}` |
| `full` | `payment_choice=full` |
| `together` / `separate` | distribution only |
| `full together` | both |

`together` alone does not set a tier (`test_pending_question.py` 199–202). `_with_inferred_guest_payment` then keeps `ask_payment_amount` true (2458–2465) unless an earlier plan already had a real choice. A model-supplied `payment_choice: full` is also stamped `ask_payment_amount: true` when the raw text did not match the English regex (2466–2478). That flag means "not consent".

`withhold_payment_link` (`pending_question.py` 63–78) returns true while distribution is missing or `ask_payment_amount` is set, so no Stripe link is created (`__init__.py` 2281–2288, 2349–2351; receipt copy at `accepted_quote.py` 1320–1323). `prepare_saved_payment` then persists the same single question again (4056–4058). The guest is asked once more.

A re-quote that still passes `present_payment_options` while the stay is only `offered` returns that pre-save `payment_choice` again and refreshes the offer message (`accepted_quote.py` 3174–3180). If the computed question differs from the stored one, the stored question is deleted first (3154–3159) and only the finalizer may write the next one. A turn that does not reach the finalizer leaves nothing open, and the answer was never applied.

Staff handoff is a later exit, not the question mechanism. `record_create_attempt` calls for a handoff after two failed creates only when `always_save_accepted_booking` is unset (`accepted_quote.py` 3998; plugin 6267–6274). The Wolfhouse accept path sets that flag (`accepted_quote.py` 3459), so the budget itself does not hand off. The handoff operators see is the model calling `flag_needs_human` after the re-ask loop, or quote-card exhaustion when a payment-options repair fails (`accepted_quote.py` 6377–6390).

The plugin also swallows every error from `withhold_payment_link` and then creates a link anyway (`__init__.py` 2289–2290). That is the opposite failure, on the same path, and it is silent.

### 3. Shuttle "yes" is never registered

Two askers, neither of which binds "yes":

- `shuttle_offer_context` (`accepted_quote.py` 2006–2056) injects "ask one shuttle question" on every turn while `shuttle_choice` is empty. It writes no `pending_question`. A thrown read returns `None` (2014–2015), so the prompt disappears and the field stays empty.
- When a quote is not yet create-ready, the finalizer can persist `{kind: add_on}` with no options (`pending_question.py` 230–232 and 250–255; `accepted_quote.py` 6480–6483). Once `create_ready` is true, the stored kind becomes `go_ahead` even if the shuttle is still open (`pending_question.py` 216). A "yes" then sits on a save question, not a shuttle question.

No function maps `yes` / `sí` / `oui` / `ja` / `sì` to `shuttle_choice`. `infer_payment_completions` does not look at shuttle. `observe_owner_turn` will not. `interpret_owner_turn` will not. The field changes only when a later tool argument includes `shuttle_choice`. Until then `shuttle_offer_context` still says the question is required, so Luna can offer it again, and create proceeds without the answer.

`shuttle_choice: 'wanted'` counts as resolved in `shuttle_offer_context` (2028) and in the quote renderer `_styled_quote_copy` (`accepted_quote.py` 1122–1127) but not in `quote_question_kind` (226–227), which looks for `requested` / `needed` instead. The same word is resolved in one place and still a question in another.

### 4. `quote_booking` + `present_payment_options` asks for payment before the save

`_quote_question_descriptor` (`accepted_quote.py` 4918–4921) returns `payment_choice` as soon as `_present_payment_options` is `['deposit', 'full']`. It does not consult `quote_question_kind`, which would have returned `go_ahead` or `add_on` and whose comment says the amount question is post-save (`pending_question.py` 233–235).

`record_quote` attaches that declaration on a successful checked quote (2922–2949) and the plugin surfaces it as `pending_question` on the `quote_booking` result (`__init__.py` 6196–6201). The quote guide tells the model to ask the returned `pending_question` (`docker/hermes-staging/soul-guides/05-quote.md`, the `present_payment_options` paragraph). The booking row does not exist yet. The guest answers a question that cannot finish payment, and the next quote can return the same descriptor (3174–3180).

This is failure 4. It is also why failure 1 starts before save: the group is asked to pick a tier, and often a distribution, while the only durable slot is that pre-save descriptor.

### 5. Solo link created, `payment_status` stays `not_requested`

The payment link and the booking status are different writes. The link write commits. The status write throws, and the throw is discarded.

`bookings.payment_status` is the enum `payment_status` (`database/migrations/001_init.sql` 21–28 and 279). `booking_guests.payment_status` is `text` (`database/migrations/024_booking_guests.sql` 17). Nothing later alters the guest column to the enum.

After Stripe returns a URL, `luna-front-desk-payment-link-service.js` updates `payments` and then calls `markGuestsPaymentLinkRequested` before `COMMIT` (893–899). The same call sits on the idempotent replay (770–784) and the booking-link reuse path (1130–1136, 1155–1159).

`markGuestsPaymentLinkRequested` (`scripts/lib/booking-guest-payment-status.js` 46–70) runs two statements inside `withGuestStatusSavepoint` (14–33). The first is:

```sql
UPDATE booking_guests
   SET payment_status = 'payment_link_sent'::payment_status
 WHERE payment_status = 'not_requested'::payment_status
```

The column is `text`. The literal is the enum. Postgres rejects the statement with `operator does not exist: text = payment_status`. The second statement, which would set `bookings.payment_status`, never runs. The `catch` at 28–32 rolls back to the savepoint, returns `0`, and does not log the error. The caller commits the `payments` row.

Reproduced with PGlite against those column types and that SQL: the guest update throws `operator does not exist: text = payment_status`; the booking update by itself succeeds; with the savepoint, commit leaves `payments.status = checkout_created` and both `bookings.payment_status` and `booking_guests.payment_status` at `not_requested`.

`markGuestsPaidForBookingPayment` (86–97) has the same comparison (`text NOT IN (payment_status, ...)`), so a later paid receipt can fail the same way and be swallowed.

`scripts/verify-checkout-status-postgres.js` 26–34 creates `booking_guests.payment_status` as the enum, not as `text`. The comparison then succeeds, `errors` stays empty, and the comment "real booking/guest enum" is false for the guest column. That is why the regression stayed green.

`scripts/lib/luna-payment-status-after-links.js` 1–8 is a read-only JSON overlay so Luna's status payload need not say `not_requested`. It does not update the column the teammate read.

`scripts/lib/staff-bot-v2-routes.js` 2261–2268 writes the string `checkout_created` onto the guest text column, which matches that column, and does not update `bookings.payment_status`. The solo Luna path uses the payment-id Stripe route above, not this statement.

## Where an answer is parsed, stored, or dropped

| What happens | Where | Result |
| --- | --- | --- |
| Raw reply stored, not interpreted | `accepted_quote.py` 1945–1965 | Text exists for this turn only as authority. |
| "Accept" / shuttle completion ignored | `accepted_quote.py` 1881–1904 | Diagnostic. No plan write. |
| English payment words copied onto the plan | `accepted_quote.py` 2439–2486 | Only if quote, create, or saved-payment prep runs. Not checked against the open question. |
| `yes` / `sí` / `completo` / `juntos` | `pending_question.py` 129–174 | Parsed to nothing. |
| Model `payment_choice` without an English match | `accepted_quote.py` 2466–2478 | Kept as a value and marked `ask_payment_amount`, so it is not consent. |
| Pending question deleted on re-quote | `accepted_quote.py` 2980, 3071, 3154–3159 | Answer not applied first. |
| Pending question replaced by the question just asked | `accepted_quote.py` 6480–6509 | The reply that arrived is not the thing persisted. |
| Prompt read of the question throws | `__init__.py` 6292–6293 | Model sees no question. |
| Shuttle prompt read throws | `accepted_quote.py` 2014–2015 | Model is not told to stop asking. |
| Withhold check throws | `__init__.py` 2289–2290 | Treated as "do not withhold". |
| Guest status SQL throws | `booking-guest-payment-status.js` 28–32 | Treated as "zero rows updated". Link commit continues. |

## Question catalog

One open question is the target. This is what the code does today.

| Question | Who asks the guest | Stored? | How the next reply is matched | What clears it |
| --- | --- | --- | --- | --- |
| Dates and party size | Soul step 1, model prose | No question row. Later tool args land on the plan. | Model must call a tool. | A later plan write. A bare yes fills nothing. |
| Contact name | `booking_names.name_intake_state` (`booking_names.py` 513–536), injected at `__init__.py` 6367–6383 | Names live in the name ledger, not in `pending_question`. `kind: names` is excluded from the model prompt (`__init__.py` 6305–6307). A name-intake read that throws reports the contact as still needed (`booking_names.py` 524–525). | Model must call `capture_booking_names`. | `guest_name` present. |
| Companion names | Same name-intake state (`missing_occupant_count`) | Same. `pending_question` kind `names` can be persisted (`pending_question.py` 250–255) and is not shown to the model. | Model must pass `guests`. | Roster covers the count. |
| Package choice | Soul shuttle step 2; quote `package_choice_needed` | Quote response only. Not a `pending_question` kind. | Model must pass `package_code`. | A selected package on the plan. |
| Board, days, lessons, yoga, meals | Soul step 3, one missing input per reply | No question row. Add-ons live on the plan when a tool sends them. | Model must pass `add_ons` / `catalog_selections`. | The plan field. |
| Room, keep-together, gendered room | Soul step 3B; `update_booking_plan` | Plan fields and internal `pending_eligibility_*` completions (`accepted_quote.py` 1574–1590). Not the guest question. | Model must pass the field. | The plan field, or a superseding revision. |
| Shuttle yes/no | `shuttle_offer_context` every unresolved turn (`accepted_quote.py` 2049–2056), and sometimes finalizer kind `add_on` | Prompt always. Descriptor only before create-ready, with no options. | Nothing matches yes/sí. Only a tool argument `shuttle_choice` writes it. | `shuttle_choice` or `needs_shuttle` set to a resolved token, and the token lists disagree (see root cause 3). |
| Save / go ahead | Finalizer kind `go_ahead` (`pending_question.py` 216, 235) | `{kind: go_ahead}`, no options (`accepted_quote.py` 6495–6509) | Model must call `create_booking_from_plan`. "Yes" / "Sí" are not parsed (`test_pending_question.py` 50–68). | Create acceptance, or a re-quote that pops the descriptor. |
| Deposit or full | Soul after save; also `present_payment_options` before save (`accepted_quote.py` 4918–4921); receipt line `deposit_choice` (`accepted_quote.py` 1324–1329) | One `payment_choice` descriptor, options `deposit`/`full`, and only if the list length is 2. | English regex inside a later tool. Not "yes". Not "sí". Not "completo". | `ask_payment_amount` cleared, which the regex does and a model argument alone does not. |
| Together or separate | Soul before save for groups; `saved_payment_question` after the tier (`pending_question.py` 93–94); receipt line `group_payment_choice` (`accepted_quote.py` 1324–1325) | Same kind, different options. Cannot be open beside deposit/full. | English `together` / `separate` / `each` inside a later tool. "juntos" and "por separado" match nothing. | `payment_link_distribution` set. |
| Flight number and transfer times | Soul shuttle step 4, after a yes | `pending_transfers` on the plan when a tool sends them. Not `pending_question`. | Model must pass the fields. The shuttle yes that should start this step is the unbound question above. | A transfer result with `success` and `write_performed`. |
| Post-save payment question | Receipt renderer plus `prepare_saved_payment` (`accepted_quote.py` 4029–4060) | Overwrites `pending_question` with whichever single payment decision is still missing. | Same English regex, only when the next payment tool runs. | `saved_payment_question` returns `None`, then `persist(state, None)`. |

## One structural fix

One open question per conversation, written and answered in the owner ledger, before the model speaks.

Do not add retries, another SOUL paragraph, or another handoff. Those leave the model as the binder. The side regex and the shuttle prompt are the same class of patch: they guess from text without a question id.

### The record

One row in the existing session ledger (`state_meta`, same owner transaction as today):

- `question_id`, increasing, so a late bubble cannot answer a replaced question.
- `kind` and the single plan field it writes (`shuttle_choice`, `payment_choice`, `payment_link_distribution`, `package_code`, `guests`, and so on).
- `options`, the exact choices just sent, always present, including yes/no.
- `asked_message_id` and a digest of the outbound text.
- `status`: `open` or `answered`.
- `answer`: the selected option, the raw merged text, and the inbound message id. Empty while open.

There is at most one `open` row. Asking a second question in the same guest message is a bug in the asker, not something the guest is expected to unpack.

### When it is written

The finalizer and the post-save receipt renderer write the row in the same transaction as the outbound message. A tool result must not be the only copy. `quote_booking` stops returning `payment_choice` before the booking insert. `present_payment_options` records which prices were shown. It does not open a question. The order is code:

1. Shuttle, only when `shuttle_question_applies` is true and no answer is stored.
2. Save the booking. Missing tier and missing distribution do not open a question yet, and they do not block the insert.
3. Deposit or full, only after the booking row exists, and only when the deposit is below the total and no answer is stored.
4. Together or separate, only after the tier is stored, and only for a party of two or more.

### When it is answered

`observe_owner_turn` runs after burst merge and before `pre_llm_call`. If a question is open, match the merged text to that question's options and nothing else.

- Yes/no questions accept the affirmative and negative tokens of the languages Luna already speaks (en/es/fr/de/it), including `yes` and `sí`, and only because those options are the open ones.
- `full` selects `full` only when `full` is an open option. `together` selects `together` only when that option is open. A shuttle "yes" cannot become a payment choice, and "together" cannot become a deposit.
- The selected option is written to the plan field in that same transaction, `status` becomes `answered`, and `ask_payment_amount` is cleared when the field is `payment_choice`.
- Text that selects no open option leaves the question open. The model may clarify that same question. It may not open a different one.

`prepare_quote`, `prepare_create`, and `prepare_saved_payment` read the bound answer. They do not scan the raw turn again, and they do not treat an unbound model argument as consent.

### What the model is given

`pre_llm_call` receives either the open question (kind, options, field) or the answer as a fact ("shuttle_choice is accepted"). It does not receive a second shuttle prompt that re-asks while the field is empty: emptiness is the open question, or it is a fact already bound. `names` uses this same row, so it is no longer a descriptor the prompt filter drops. A read failure is a failed turn, not an empty prompt and not a swallowed success.

### What clears it

- Answered and the plan field written.
- Superseded because the offer changed in a way that makes the option meaningless. The previous answer stays on the plan when the field is still valid, so a shuttle yes survives a payment question.
- `persist(None)` and the pops at `accepted_quote.py` 2980, 3071, and 3154–3159 go away. Closing a question without an answer or an explicit supersede is not allowed.

### What is removed once the row exists

- `infer_payment_completions` as a hidden writer inside prepare.
- `shuttle_offer_context` as a parallel asker.
- `interpret_owner_turn` as a place answers are submitted and discarded.
- The pre-save return in `_quote_question_descriptor` (4918–4921).
- The `except` that turns a withhold failure into "create the link" (`__init__.py` 2289–2290).
- The savepoint that turns a status-write failure into `0` (`booking-guest-payment-status.js` 28–32).

The status bug is not a second question design. It is the same class of defect: a result the operator needed was thrown away. The guest column is `text`, so the comparison has to be text to text (or the column has to become the enum, including every existing value such as `checkout_created`, which is not in the booking enum). The bookings update has to run even when the guest update fails, and a failed status write has to surface on the link result. The read-only overlay in `luna-payment-status-after-links.js` is not that write.

## Test plan

Offline. No Stripe, no WhatsApp send, no Staff deploy. Script the guest text into the owner the way `test_save_before_payment_question_sql.py` already drives a turn. Do not call a live model. The assertions are on the ledger and on SQL after each reply, before any assistant prose.

The payment-status case uses PGlite with the real types: `bookings.payment_status` as the enum from `001_init.sql` plus `004_payment_schema_phase2.sql`, `booking_guests.payment_status` as `text` from `024_booking_guests.sql`. Do not recreate the guest column as the enum the way `verify-checkout-status-postgres.js` 32–34 does.

### Ask, then the guest replies

For a solo stay and for a two-guest stay, drive: quote shown, one question sent, then one inbound.

| Open question | Inbound | Ledger after `observe`, before the model |
| --- | --- | --- |
| Shuttle yes/no | `yes` | `shuttle_choice=accepted`, question `answered`. Not a create. |
| Shuttle yes/no | `sí` | Same. |
| Shuttle yes/no | `no` | `shuttle_choice=declined`, question `answered`. |
| Deposit or full, after the booking row exists | `full` | `payment_choice=full`, `ask_payment_amount` clear. |
| Deposit or full | `sí` while the asked options were deposit/full and the reply does not name one | Question stays `open`. No tier written. No second question opened. |
| Together or separate, after the tier is stored | `together` | `payment_link_distribution=together`. |
| Together or separate | `separate` | `payment_link_distribution=separate`, `per_guest_payment_links=true`. |
| Together or separate | `juntos` / `por separado` | Those select the open option, once the matcher is option-aware. Today they parse to `{}` and the test must fail on current code. |
| Any open question | `full` when `full` is not an open option | Question unchanged. `payment_choice` unchanged. |

Also send `full` and `together` as two bubbles. With coalesce off, each bubble is its own turn and only the open question may change. With coalesce on, the joined text may answer only the one open question; the other choice waits until that question is the open one. The 8-second concatenator must not apply "together" to a deposit question.

### The four staging failures

1. Group, deposit or full and together or separate. After the fix, the first outbound payment question is only one of them, and it is sent only after the booking insert. Reply `full`. Assert one booking row, `payment_choice=full`, no link yet, next open question `together`/`separate`. Reply `together`. Assert one link request, not a second booking, and no `flag_needs_human`. Reply `separate` on a fresh stay and assert one link per guest. A second copy of the same answer does not open another question and does not create another booking.

2. Solo, link created, status stays `not_requested`. Insert a booking at `not_requested` and one guest row with `payment_status text`. Run the real `markGuestsPaymentLinkRequested` inside a transaction that also marks the payment `checkout_created`. Assert the SQL error is not swallowed: on current code the commit leaves `bookings.payment_status = not_requested` (reproduced: `operator does not exist: text = payment_status`). After the fix, `bookings.payment_status` is `payment_link_sent` and the guest text column is the same status string. A thrown comparison must not return success or row count 0.

3. Shuttle. Qualifying package, question sent, inbound `yes` and, on a second stay, `sí`. Assert `plan.shuttle_choice` is `accepted` before any tool call. The next prompt contains the bound fact and does not contain `shuttle_offer_required: true`. Create without a further shuttle question. `no` stores `declined` and does not save a transfer.

4. `quote_booking` with `present_payment_options: ['deposit', 'full']` on a checked stay that is not yet saved. Assert the tool result and the ledger do not open `payment_choice`. The open question is shuttle or go-ahead, then the booking insert, then deposit/full. `present_payment_options` is still the list of prices that were shown.

### Negative controls

- `interpret_owner_turn` with `shuttle_choice: accepted` still writes nothing. The binder is the observer, not the diagnostic.
- A model tool argument `payment_choice: full` while the raw text does not select the open option does not clear `ask_payment_amount` and does not create a link.
- Re-quoting the same stay does not pop an open question and does not return a new `payment_choice` before save.
- Wrong tenant, ended session, and a superseded `question_id` do not accept the answer.
- The create-failure budget is not what ends the group script. The script must finish with a booking and the selected links, and `flag_needs_human` must not have been called.
