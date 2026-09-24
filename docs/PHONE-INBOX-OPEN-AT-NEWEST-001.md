# PHONE-INBOX-OPEN-AT-NEWEST-001

## Scope

Phone Inbox long threads should open at their newest message, including switching
from another conversation through the ordinary list. Shared Wolfhouse/Sunset
portal only. No CSS, phone spacing/Guests chrome, money/payment/Create-link,
submit handlers, live services, push or deployment changes.

## Existing behavior and reproduced cause

`inboxStickThreadToLatest` already positions `#thread-container` immediately and
on two animation frames. The existing mobile-scroll gate checks this helper and
its CSS contract; it does not exercise the actual phone list-to-thread layout.

The production portal HTML at 390x844 expands the transcript to its content height.
With the synthetic 60-message fixture, its `scrollHeight` and `clientHeight` are
both 6808. The document is the actual scroll owner (7261 high, 844 viewport).
Scrolling the inner transcript cannot move it, leaving the document at 0 with the
oldest messages visible. Both tenants reproduce this through real row clicks.

## Minimal repair

- Retain the existing scroll helper and its animation-frame scheduling.
- Detail completion explicitly opts into its initial-open fallback.
- On phone, if the transcript is visible but has no own scroll range, follow the
  existing document scroll owner to the bottom.
- Composer/poll calls do not opt into this document fallback.
- Deferred callbacks ignore a detached old transcript.

No scroll layout or other screen is redesigned. Desktop does not enter the new
fallback. This is a detail-open correction, not a general scroll anchoring change.

## Verification

```sh
npm run verify:phone-inbox-open-at-newest-001
```

The new browser test emits actual production HTML for both tenant profiles and
intercepts all HTTP. Only synthetic GET fixtures are served; mutations are
rejected/recorded and external requests aborted. There is no fixture server or
live tenant access. Optional positional argument labels the output directory.

For Wolfhouse first, then Sunset, at phone 390x844 and desktop 1500x1000:

- Open 60-message thread A using its list row; require real overflow and newest
  message visible inside the viewport and clipping ancestors.
- Return to the list on phone and open thread B; repeat the newest assertion.
- Read older history and allow real unchanged-message polling; preserve position.
- Append a synthetic message through the polling endpoint; phone history reading
  remains at 400 rather than being forced to newest.
- Require no mutation attempts and no browser JavaScript errors.

Rebased onto master `cd3aa91c199bd2b45dd48e7eaca14efa9130beeb` before final proof.
The identical new verifier on that unchanged base fails both phone open cases
for each tenant; the candidate passes. All desktop measurements compare exactly
between base and candidate. Eleven existing focused gates pass on both.

**Existing limitation, not repaired:** on desktop, appended-message polling moves
history reading from 400 to 3978 on both base and candidate. The browser test logs
this observation rather than claiming it passes a no-yank assertion. This job
neither introduces nor repairs that separate desktop polling behavior.

Local evidence under `tmp/phone-inbox-open-at-newest/` includes original RED/GREEN,
current-base RED/current-candidate GREEN measurements, screenshots, request logs,
focused baseline comparisons and independent review. HTML byte parity changes
intentionally with the modified helper; no layout/CSS edit is part of the patch.
