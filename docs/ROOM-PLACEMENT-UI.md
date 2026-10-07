# Room Placement UI — House Pack

Wolfhouse Staff → Admin → Luna Staff → Room placement.

## What changed

The existing placement controls now use Staff overview-style cards in light/dark mode. The obsolete disconnected-preview banner is removed. Fill House/Fill Room, saved room priority, reset/cancel/save, and the read-only placement preview remain on their existing contracts.

The same page now has a room builder. **Add room & save** creates the room and its beds in inventory, appends that room to the current priority order, and asks the Schedule to reload. It is not a local draft. Female, Male and Mixed are saved as the existing room types. Existing rooms show those labels from their stored room type. Unknown or conflicting metadata shows Unspecified / Needs review and is not guessed as Mixed. Private/couple and Operator restrictions stay visible beside the gender label.

**This writes Wolfhouse room inventory only.** It does not change the booking allocator, guest tools, payments, or Sunset. Preview remains read-only. Cancel does not delete a room that was already saved.

Preview fields survive mode/order changes. A changed input or repaint invalidates earlier preview responses, preventing stale results from appearing. Selected beds use readable chips; reasons and failures remain visible.

## Verification

From the repository root:

```sh
node --test scripts/verify-staff-room-fill-policy.js scripts/verify-staff-room-fill-routes.js
node scripts/verify-staff-room-fill-inventory.js
node scripts/verify-staff-room-fill-browser.js /absolute/evidence/module
node scripts/verify-staff-room-fill-page.js /absolute/evidence/page
node scripts/verify-hermes-send-flags.js
```

The module browser test covers builder validation and editing, draft isolation, cancel/reset/save/error behavior, button/keyboard/drag priority changes, preserved fields, stale preview suppression, reload warning and draft lifetime. All HTTP operations there are intercepted synthetic fixtures.

The page browser test emits actual Staff HTML/CSS through `buildUiHtmlForOfflineTest`, enters via the ordinary menu, and tests light/dark at 390px and 1280px. Network access is denied except explicit intercepted fixture responses and a local production image. Unknown requests fail the gate; fonts are deliberately blocked. Card tokens, compact gender controls, builder add, unchanged preview contract and overflow are checked. Screenshot evidence is offline, not proof of staging deployment or live persistence.

Desktop Staff uses a nested scroll panel: tall locator screenshots can capture the wrong region when Chromium resizes the viewport. The gate takes normal desktop viewport shots of the workspace and preview separately, without changing CSS/DOM; mobile uses a full module crop. Inspect actual pixels, not just the screenshot filename.

The route verifier's old one-line allocator diff against a machine-local `github/master` ref was replaced with assertions on the shipped export and absence of a room-fill policy connection. This removes dependence on a stale ref while retaining all auth, tenant, revision and read-only-preview checks. The allocator itself is unchanged.

No deployment is performed by these commands. Land only this slice, following the repository sync/master-SHA preflights and current Chief dispatch.
