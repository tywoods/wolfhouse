# Booking-card body minimum — source handoff

Scope: selected #8/#9/#11/#16/#17/#18 only. Based on
`316025f2c9fe9addcf497dc81b55be66dc50d302` (including Per Guest #1244).
Local-only implementation and synthetic verification. Publication, landing and deployment require separate authorization. No live write, payment action, guest send, WABA or port 8094.

## Implementation

- Preserve number-first heroes, tenant-native navigation and Per Guest financial/name/link rendering.
- Reflow Wolfhouse contact/stay groups without changing the one-line guest/bed/payment rows; wrap long desktop contact values.
- Add Sunset's existing factual Details helper beneath its hero, before its native invoice.
- Mixed guest packages expand to existing guest assignments. Inclusion requires a factual inclusion marker **and an explicitly recorded finite zero**, never null/empty/boolean coercion, a package name or color. Charged add-ons retain their existing lines and owners.
- Separate existing formatted invoice amounts from descriptions; preserve signed adjustments and unknown text. Compact truly empty sections, not recorded-zero services.
- Keep same-booking disclosure state and focused disclosure during refresh; key state to calendar tenant and booking. Preserve active field editors until Save/Cancel. Existing Save reload is exercised locally.
- Scoped body label, control-boundary/focus, nested-card spacing and editor safe-area adjustments. No permanent action dock or new scrolling box.

## Reproduction

From this worktree:

```sh
node scripts/verify-booking-card-body.js /absolute/evidence/path full
git diff --check
```

`full` emits production HTML for both native profiles and runs:

1. Layout: 320/390/430/768/769/1440 × light/dark × EN/ES × both tenants.
2. Representative interactions: factual inclusion/mixed packages, unknown inclusion, collapses/focus, touch/tab controls, editor refresh/Save/Cancel, signed/zero/unknown invoice edges, Italian Details smoke.
3. An explicitly isolated VM check of the production disclosure function's calendar-tenant ownership/reset. This is **not** native cross-tenant navigation acceptance.

All browser requests are intercepted and recorded; unexpected requests fail. Only the contact-edit POST is fulfilled with a local synthetic response; it is never forwarded. Sunset Edit/Cancel uses the ordinary Bookings entrypoint and existing editor. No payment/link mutations are exercised.

## Evidence and limits

Durable evidence lives under `artifacts/BOOKING-CARD-BODY-MINIMUM-001/` in the parent repository. `writer-final/` is the initial writer release, **not final acceptance**. Independent `review/` rejected that candidate: desktop dirty-editor reentry could strand the drawer, and new package assignments closed on refresh. Parent `acceptance/` additionally caught squeezed guest names, fresh-open disclosure leakage and package/private-room ink overlap at 320px. Original failures remain retained.

`repair-1/` contains serial RED/GREEN proofs for those corrections. `acceptance-2/` and `review-2/` rejected that candidate: R3 allowed a delayed desktop Save context GET for A to replace B's shared body and action context while retaining B's title. The Spanish 320px name allocation was separately proven identical to base (24.828125px), not a new protected-row regression.

`repair-2/` contains this final bounded writer cycle. The next independent acceptance and review belong under `acceptance-3/` and `review-3/`; they are **pending**, not implied by writer GREEN. Only source-bound final acceptance/verdict receipts, followed by a separately authorized verified local commit and seal, establish LOCAL CLEAN. This writer neither stages nor commits.

### Repair contracts

- Native same-booking reentry preserves the dirty editor **before** replacing its mount. Contact Save uses the live desktop host and the existing payload; Cancel and switching to another booking remain usable.
- R3 completion ownership now requires the captured calendar tenant, booking/block identity, latest request generation, exact host child mount and editor session. Close, fresh booking mounts and create-panel replacement invalidate old requests. Both successful/HTTP-error and rejected-network completions are guarded before rendering or initializing action shells; successful payloads must also match booking code/id. A newly active same-booking editor cannot be overwritten by an older reload.
- The durable delayed **Save POST → A context GET → open B → release A** regression asserts body facts, mounted action-booking identity/generation and DOM identity without invoking a payment action. Same-booking close/reopen, deferred HTTP/network errors and a newly dirty editor run in both desktop themes. Direct native reentry followed immediately by Save (without Cancel first), then Cancel, remains covered on mobile and desktop.
- Ordinary refresh retains open History/Per Guest/Move Bed and mixed-package assignments. Explicit close/fresh native opens and different booking/tenant identity reset disclosures.
- Mobile touch sizing is limited to Contact/Dates/Package controls, excluding the protected one-line guest pencil row. Narrow package/private-room fields stack rather than overlap.
- At viewport widths ≤360px only the outer Details card's horizontal padding changes from 16px to 8px. The protected guest renderer/CSS and 40px allocation assertion remain unchanged. Full EN/ES light/dark verification measures 320px Spanish guest-name allocation at 40.828125px (English 65.140625px). Long names still use the inherited ellipsis; this is minimum allocation, not full-name display in that row.
- The prior Sunset summary assertion still requires an escaped factual booker name below the unchanged number-first hero, per selected #8. Exactly one additional legacy presentation assertion changes: the split-rental line now verifies the exact `5 rental days × 4 people` detail node and exact `€300.00` amount node (plus complete displayed text and five unchanged source quantity/6000-cent pairs), rather than requiring an inline equals sign. This is the intentional #11 amount-column contract, not a change to rental counts or financial checks. All other old assertions are unchanged.
- Three inherited baseline reds are recorded separately: Per Guest readable-share layout, rental-line verifier missing-element failure and equipment source-token assertion. These are not silently waived or repaired by this packet.

`full` now also runs native mobile/desktop dirty-editor reentry, Save/Cancel and booking switching; package refresh/different-booking reset; fresh desktop disclosure reset; protected guest-row geometry; and text-ink collision checks at 320/390/1440 in EN/ES and both themes. Some Wolfhouse-specific modes include Sunset setup/smoke cases, not equivalent Sunset interaction coverage.

Repair-2 writer results: `body-full-green/combined.json` has 48 layout cases plus all 14 representative modes passing; `section-green/` passes all 58 section-totals cases; `invoice-tab/` passes all 16 cases. The ten R3 cases were first observed RED before the ownership repair. The intermediate `density-red-full/` retains both Spanish-width failures and a mobile-switch timeout caused by an overly broad editor guard; the guard was narrowed to the current tenant/booking and direct reentry returned GREEN before the padding change. The obsolete inline-rental assertion's full RED is retained in `section-red/`. `handoff.json` binds all eight modified working files, commands/logs and limitations; the seven-file index is deliberately unchanged. Parent-owned entire-17 preservation and independent final review remain outstanding.

Browser geometry/contrast is automated synthetic evidence, not a live visual sign-off. Contrast covers representative touched labels and native controls, not every financial badge or disabled explanation. Most interactions run at 390px in both themes, with desktop reentry/Save at 1440px. Italian is a label smoke, not a full translated interaction matrix. Manual desktop resizing is not separately proven. The 360px editor viewport is a keyboard proxy, not physical keyboard or device safe-area acceptance.

The disclosure VM proves reset when the production initializer receives a different tenant; native cross-tenant navigation and a tenant excursion without mounting another booking are not covered. Unknown accommodation and absent inclusion prices are covered, but arbitrary corrupt commercial-line amounts remain with the existing financial renderer. No live guest/payment or deployment acceptance is claimed.