# STAFF-OPEN-CUSTOMER-DEEPLINK-001

## Scope and ownership

Captain: local build and independent review only. Skipper owns any later publication/landing. No deployment, production access, guest send, gateway restart, WhatsApp/8094, Create-link, or conversation creation is part of this change.

Base: `8cda03244a99c061742146d9c969a150047552e8` (GitHub master fetched directly from `tywoods/wolfhouse`). Work isolated in a new worktree; unrelated staged Captain work left untouched.

## Reproduction and root cause

Read-only browser checks reproduced guest card **Open conversation** dropping to the empty Inbox detail pane on both reachable stagings:

- `https://sunset-staging.lunafrontdesk.com/staff/ui`, tenant `sunset`.
- `https://staff-staging.lunafrontdesk.com/staff/ui`, tenant `wolfhouse-somo`.
- The supplied `wolfhouse-staging.lunafrontdesk.com` hostname returned NXDOMAIN (also confirmed by public DNS lookup); it was not possible to test that nonexistent hostname. The repository-documented Staff staging host identifies itself as Wolfhouse/Somo.

Observed failure sequence: exact guest card → Open conversation → `inbox/list?view=all_people` → deferred Full preset switch → `inbox/list?view=all` → **“Select a conversation to review.”** No request for the intended `/staff/inbox/thread/<id>` occurred in the failed transition.

The links already pass the right customer/conversation identities. The shared preset wrapper defers Full/Guest changes into `document.startViewTransition`, but targeted navigation assumes the preset has changed synchronously. The subsequent folder reload increments the saved-view request generation and drops the earlier targeted request. Guest opening also invokes the preset through several existing layers, so overlapping delayed transitions can overwrite explicit navigation.

## Repair

- Add an explicit `immediate` preset option for navigation. Commit the destination surface before requesting the exact customer or thread.
- Ignore obsolete deferred preset callbacks after a newer preset request.
- Opt in from `openInboxToConversation`, both existing canonical `openCustomerCardForPhone` definitions (module and final template override), and the exposed People helper.
- Ordinary Full/Guest folder clicks retain the existing visual transition and readiness behavior.
- Require exact supplied customer ID, otherwise exact normalized phone; remove fuzzy singleton acceptance and list-render auto-selection on no match. Show an explicit not-found state.
- Validate phone-fetched customer context against the selected identity before accepting it. Pending, mismatched, unsuccessful, HTTP-error and network-error context leaves no identity-dependent controls available. Bind People-card conversation actions with `conv: null`, never the previously selected thread.
- No new standalone guest route, query protocol, API mutation or conversation creation.

Production changes are limited to `inbox-rows.js`, `inbox-thread.js`, `inbox-customers-profile.js`, `inbox-views.js`, `inbox-context.js`, and the matching one-line canonical opener in `staff-query-api.js`. No Schedule, payment-truth, or blocks-filter owner files changed. No import exception was needed.

## Entrypoint inventory

| Entrypoint | Existing owner → repaired shared destination |
| --- | --- |
| Bookings guest name | `adminBookingsOpenGuestInInbox` → customer opener, with customer ID |
| Sunset Bookings detail / Schedule drawer Open customer | `scheduleMountDrawerBody` → customer opener |
| Sunset Schedule existing conversation | `scheduleOpenOrStartConversationFromBooking` → conversation opener |
| Wolfhouse Bookings detail / Schedule drawer Open conversation | `bcOpenOrStartConversationFromBooking` → conversation opener |
| Wolfhouse older drawer Open customer toolbar, where mounted | `bcSyncCustomerCardButton` → customer opener |
| Inbox thread Open customer | `wireConvDetailHandlers` → customer opener |
| Inbox Guest card Open conversation | `inboxCustomerWireFullHeaderActions` / customer header → conversation opener |
| `/staff/ui?conversation=<id>` | `initInboxFromUrl` → conversation opener |

The old Customers-list `openInboxToPhone` callers are behind the retired `tab-customers` surface. This work does not revive that surface. Wolfhouse's current shared booking drawer exposes Open conversation in its footer; its old customer toolbar is not mounted there.

## Local verification

Run `npm run verify:staff-open-customer-deeplink` (Playwright/Chromium required). The test renders the actual production Staff HTML and clicks the real handlers; only HTTP data is explicitly fixture-backed. All nonlocal traffic is blocked. Every non-GET is rejected. Navigation cases assert none occurred; the unlinked-guest negative action test deliberately clicks Start conversation against this offline interceptor and asserts exactly one rejected request for that fixture guest, with no thread opened. No real API receives it.

The browser regression was **red on the base for both tenants**, reproducing the same empty-detail and request-generation failure as live staging. On the repair it covers:

- Bookings guest link resolves the intended customer, not the first People row.
- Guest card Open conversation resolves the intended thread even outside the current list page.
- URL conversation bootstrap survives a persisted Guest preset.
- Latest explicit destination wins over an older pending folder transition.
- Bookings detail/shared Schedule drawer: Sunset opens the exact customer card; Wolfhouse opens the exact thread through the existing footer action.
- Customer ID beats an earlier conflicting phone match; conflicting phone context fails closed.
- Deterministically held context responses expose no enabled sidebar controls before validation or after failure/mismatch.
- Fixture consistency checks keep conversation A owned by A while People/context/booking B are unlinked; customer-context fixtures require the requested phone.
- A singleton fuzzy result opens neither a card nor a thread.
- Previously selected conversation A → different unlinked guest B → Start conversation cannot reopen A; the offline interceptor rejects B's start request.
- No JavaScript errors or successful mutation requests. Identity cases were red on both tenants before their repairs (logs included).

Existing static gates were tightened to require `immediate: true` rather than their prior literal single-argument preset calls. Column-model and Wolfhouse transition/identity gates are also exercised.

`verify-inbox-ui-parity --save` ran before edits. A subsequent parity run correctly reports an intentional JavaScript change, not byte identity. The earlier navigation-only pass reproduced baseline bytes by substituting the changed owners back to their base versions. The final identity pass intentionally changes the People lookup/no-match behavior and conversation action binding too; byte identity is not claimed for the repaired UI.

`npm run verify:luna-all` is not globally green on this baseline. An untouched detached base worktree reproduces the existing `verify:inbox-shell-channel-defaults`, `verify:inbox-theme`, `verify:inbox-middle-column-fill` and `verify:luna-personality-live-eval` failures. Some historical tests also assert clean worktree state. The focused local gates and browser regressions are the acceptance gates for this bounded pass; the four known baseline failures remain explicitly out of scope. See the package evidence for actual exit codes and full logs. No unrelated failures are repaired or hidden by this task.

## Operator acceptance after a separately authorized landing

On each tenant, choose an existing guest with an existing conversation. Do not use Start conversation/Create-link or send a message.

1. Bookings → guest name: exact guest card, not bare Guests list.
2. Bookings → booking code/detail → available Open customer/Open conversation action: exact guest card/thread.
3. Schedule → that booking's drawer → Open customer/existing Open conversation: same identity.
4. Inbox → Guest card → Open conversation: exact thread, not “Select a conversation”.
5. With Guest view saved, open `/staff/ui?conversation=<existing-id>`: exact thread.
6. Repeat while an earlier Full/Guest switch is still in progress; the newest requested identity must remain selected.

Only pre-fix staging behavior and local fixed behavior have been verified. This package is **not deployed**, and no claim of a repaired live staging is made.
