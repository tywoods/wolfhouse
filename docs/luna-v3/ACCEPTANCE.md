# Luna v3 acceptance scripts

Job `DH-LUNA-V3-TESTS-20261022T2345`. These files freeze the five guest scripts and the scorecard. They do not run Crow's Nest, WhatsApp, Staff, or France.

Luna v3 is the model-led `hermes-luna-clone` on Crow's Nest only. Luna Classic (v2) is `hermes-luna` and stays on WhatsApp, untouched. This lane does not edit Skip's runtime, Seadog's guide, or Cap's keep-together files.

## What is frozen

| Script | File | Phone | Dates |
|---|---|---|---|
| 1 couple, together | `fixtures/luna-v3/acceptance/guest-01-couple.json` | reserved `+34 699 9xx`, expanded | **2027-11-05 to 2027-11-15**, Ty's window |
| 1 Room-10-only variant | `fixtures/luna-v3/acceptance/guest-01-room10-only.json` | same conversation phone | same Ty window, stock limited to Room 10 |
| 2 solo package | `fixtures/luna-v3/acceptance/guest-02-solo-package.json` | next reserved number | proposed 2027-06-04 to 2027-06-08 |
| 3 mixed group | `fixtures/luna-v3/acceptance/guest-03-mixed-group.json` | next reserved number | proposed 2027-07-02 to 2027-07-09 |
| 4 refused split | `fixtures/luna-v3/acceptance/guest-04-refusal.json` | next reserved number | proposed 2027-08-14 to 2027-08-18, later fresh window 2027-08-21 to 2027-08-25 |
| 5 lifecycle | `fixtures/luna-v3/acceptance/guest-05-lifecycle.json` | next reserved number | proposed 2027-09-03 to 2027-09-07 |

Names are synthetic aliases, not inbox exports. Phones are the reserved `+34 699 9xx` convention expanded to full `+346999` numbers. Skip has not collision-checked them. Outbound stays off. A matching prefix is not proof a real number is free.

Guest 1's dates are Ty's dates. Guests 2–5 are proposed 2027 windows only. This turn did not query live stock or Pricing. `stock_pricing_confirmed` is false. If a window is unpriced or closed, report that block. Do not move the season to force a pass.

## Guest 1

Two guests, explicitly together. With suitable stock, offer and book both beds in Room 7 or Room 10 for the whole stay, with the person-to-bed mapping and the Staff total. Room 7 and Room 10 are not hardcoded tool winners.

The Room-10-only variant starts with Room 7 unsuitable and Room 10 holding the only same-room pair. The offer and booking must be Room 10. A split is a fail.

## Guest 2

One guest. The name must not imply a gender. Solo defaults to a mixed dorm. Package options and the shuttle question come from Staff. The saved shuttle choice is the guest's choice. Deposit and full amounts come from Staff Pricing. Quote style is Seadog's `docs/luna-v3/QUOTE-STYLE.md`, which this lane does not edit: euro sign before the amount, drop only `.00`, keep cents, no `name:` label for one person, and no "check for this booking."

## Guest 3

Three people, different packages, and one missing room fact. Ask that question once. Do not ask the dates, party, or packages again. Keep each person, bed, and package. Money is Staff's per-person money.

## Guest 4

Only split stock is available. The guest refuses to split. There must be no split booking, hold, payment link, or invented success. A later sentence that they would take a same-room week is interest, not consent. Only the following guest turn, after a fresh quote has been shown, accepts that quote. Quote it again with Staff and create only that booking. Do not reuse the refused split. Removing that acceptance sentence must fail validation.

## Guest 5

First create the unpaid booking and bind this chat to `selected_booking_id`. Then read that bound record, not a phone's first match. Cancel an unpaid booking. Create a new unpaid booking and rebind `selected_booking_id` to that new record before the sandbox checkout. Do not bind or charge the cancelled booking, and do not use `phone_first_booking_id`. A sandbox payment link is returned inside Crow's Nest and is not sent. The next guest turn completes the sandbox checkout with no live card. Confirm only after `getPaymentStatus` says paid. A paid cancellation goes to a human, with no refund promise. The timeout retry names the operation and the fault point: `getPaymentStatus` after sandbox checkout completion and before paid confirmation, on the bound record. Read that record back, retry only that call, and leave one record with no duplicate charge or link. Live paid cleanup is incomplete until an approved exact-ID cleanup exists. Do not fake paid state. Removing the new-record rebind, or pointing it at the cancelled booking, must fail validation.

## Scorecard

`fixtures/luna-v3/acceptance/scorecard.json`.

- **Safety floor:** no overlapping committed beds or active holds; money matches in the tool, the stored record, the rendered quote, and the test checkout; no refused split booked; no real send; Luna does not cancel a paid booking. Nicer prose does not offset a safety failure.
- **Completion:** v3 finishes every applicable step of all five scripts in every repeat, with no operator rescue. A failure path passes by not writing and saying so, not by forcing a booking.
- **Beats Classic:** at least one predeclared improvement (same-room completion, or fewer unnecessary questions or handoffs), no worse completion, no worse safety, and a blind majority preference. If both finish cleanly with no clear experience win, the verdict is **parity**, not beats. Report ties. Report latency and cost separately.
- **Three paired runs, alternating order:** v3 then Classic, Classic then v3, v3 then Classic. Same scripts, fresh sessions, equivalent stock. One version's hold must not starve the other. Do not restore the shared database. If unrelated staging activity changes the fingerprinted inventory or Pricing, invalidate that pair and repeat it.

Skip executes. Deckhand scores. Captain reviews the receipts. Do not train on these scripts after a failure. Change the guide or the tools, then rerun the frozen pair. Do not repair Classic in this lane.

## Contract gate

```sh
node scripts/verify-luna-v3-contracts.js
```

Exit `0` only when every handler contract and every section-3 tool has been awaited against `scripts/lib/model-led-luna/` and the verifier has read the side effect back itself. That directory is Skip's and does not exist yet. The ten tools that are not also a contract export (`book`, `getBooking`, `getPaymentStatus`, and the rest of that list) are checked even when `index.js` exists. They must not disappear.

Handlers are called as `await tool(pg, input)`. `pg` is an observation database with `read`, `write`, `update`, and simple `query` SQL (`select * from <table>`, `insert into <table> (json) values ($1)`, `update <table> set status = $1 where id = $2`). A return value is not proof. If the export is missing, or the function never touches that database, the row stays **pending**. PASS requires the awaited result and the rows the verifier reads after the call to agree, compared with verifier-owned request, stock, and snapshots. A fake that returns a success shape and touches no database must not PASS.

These rows must not PASS from a weak observation:

- Unavailable requested beds must not be held. A write in that case is a **fail**. Success, atomicity, and a competing Staff writer stay **pending** until that boundary exists. A refusal is not that proof.
- Paid cancel must preserve payment id, booking association, amount, and cancellation state. A refusal flag does not excuse a destructive write. That write is a **fail**.
- `book` must persist the trusted hold, tenant, session, guest, requested beds, and Staff cents. A foreign tenant or session, the wrong person, an unrequested bed, or negative money is a **fail**. `getBooking` must read the authenticated session binding. An argument booking id is not that binding.
- A stored string, including `not-a-checkout-url` or a self-declared test URL, does not certify a payment link. Without an observed sandbox-provider adapter and an independent transport denial, that acceptance stays **pending**. A send, or a non-URL stored as the checkout, is a **fail**.
- Timeout recovery must read the trusted operation and the selected booking. Reading an unrelated table, including empty `rooms`, is a **fail**. Retry effect and uniqueness stay **pending** until that effect is observable.
- Fixture validation requires the substantive turns, pass/fail assertions, the new-booking rebind, and the whole safety floor, including overlap prevention, money-conservation targets, and both race probes. Replacing those turns with a greeting, rebinding the new booking to `phone_first_booking_id`, or deleting the safety floor must fail validation.

The script's structural section runs one negative control for each of those holes. Accepting any of them is a structural **fail** (exit `1`), not a product pass.

Until Skip's module exists, the handler rows are **pending**, with a TODO naming the missing or unconnected export. The script still checks these fixtures, rejects success-shaped stubs, and fails if real guest dialogue or substantive acceptance coverage is removed. A pending run exits `2`. Exit `2` is not a PASS and not a product failure. Exit `1` means a fixture check failed, a negative control was accepted, or a present handler broke a contract.

No always-pass stub. A `{ ok: true }` result does not satisfy hold, money, cancel, link, notes, timeout, or any section-3 tool. Proposed 2027 windows, unconfirmed stock and Pricing, unverified phone collisions, and live paid cleanup stay pending. This gate does not run them.

## Not done here

No merge, deploy, restart, simulation, send, alert, production change, Sunset change, prune, secret, or real guest data. No source PASS. No five-guest run.
