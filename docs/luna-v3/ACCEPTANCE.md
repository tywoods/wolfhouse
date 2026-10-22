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

Only split stock is available. The guest refuses to split. There must be no split booking, hold, payment link, or invented success. If the guest later accepts a fresh same-room option from a new tool result, quote that option again and create only that booking. Do not reuse the refused split.

## Guest 5

Read the selected booking. Cancel an unpaid booking. A sandbox payment link is returned inside Crow's Nest and is not sent. Confirm only after Staff says paid. A paid cancellation goes to a human, with no refund promise. A timeout is unknown: read back, retry the same operation, and leave one record with no duplicate charge or link. Live paid cleanup is incomplete until an approved exact-ID cleanup exists. Do not fake paid state.

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

Exit `0` only when every handler contract has run against `scripts/lib/model-led-luna/` and passed. That directory is Skip's and does not exist yet.

Until then the handler rows are **pending**, with a TODO naming the missing export. The script still checks these fixtures and rejects success-shaped stubs. A pending run exits `2`. Exit `2` is not a PASS and not a product failure. Exit `1` means a fixture check failed or a present handler broke a contract.

No always-pass stub. A `{ ok: true }` result does not satisfy hold, money, cancel, link, notes, or timeout.

## Not done here

No merge, deploy, restart, simulation, send, alert, production change, Sunset change, prune, secret, or real guest data. No source PASS. No five-guest run.
