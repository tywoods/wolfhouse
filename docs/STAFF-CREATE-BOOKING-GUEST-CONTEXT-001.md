# STAFF-CREATE-BOOKING-GUEST-CONTEXT-001

## Scope

Local-only shared Staff portal repair. Start base was `528c5ef0dc8e5ac9675aaa974639c2ec443cc565`;
rebased onto GitHub master `a4207e90f23dc89735d944105c30fd049ff681a1` after
Skipper's open-customer landing. No edits to Skipper's worktree or unlanded files.
No push, deployment, production access, Hermes changes, WhatsApp, booking submission,
payment, Create-link, Oracle, or guest sends.

## Existing capability and defect

Both tenants already have a contact-prefill owner: `openCreateBookingFromContact`.
Sunset fills its existing Schedule create drawer (name/phone); Wolfhouse fills its
existing bed-calendar create panel (first guest name/phone/email). No new form,
API, identity lookup, or booking engine is introduced.

The Inbox card renders merged customer identity but its Create booking handler
passed raw conversation fields. A named customer whose conversation lacked a name
therefore opened a blank name field. Linked email conversations could pass their
opaque channel key instead of the displayed contact phone. The Chat guest overlay
had the same mismatch. Wolfhouse additionally populated a panel still hidden by
its desktop CSS because contact-prefill did not dock it into the existing rail.

## Repair

- `inboxCustomerPaint` and `inboxChatPaintGuest` pass their rendered customer model
  to the action wiring, which closes over that model rather than reading a mutable
  global selection at click time.
- The action snapshots the card's resolved name/email/language and contact phone
  at wiring time. Full/condensed renderers and the action share the existing
  precedence through `inboxCustomerContact`, including same-phone cache fallbacks.
  Later cache/model/selection changes cannot rewrite that captured contact.
  The existing conversation-to-customer adapter remains the missing-model fallback.
- Staff-note prefill keeps its prior `conv.internal_staff_notes` source, irrespective
  of whether customer notes are empty, null, missing, or nonempty.
- `bcApplyCreatePrefill` uses the existing `bcDockCreatePanel` owner. Mobile's
  existing no-dock behavior remains; dates/beds and financial logic are unchanged.
- The new browser verifier is registered as
  `npm run verify:staff-create-booking-guest-context`.
- The existing Inbox context static guard now checks the booking opener's
  arguments instead of an 80-character window that could falsely include the
  subsequent, unrelated sidebar wiring. Its ban on passing the sidebar remains.

### Bounded independent-review repair

The first independent reviews blocked acceptance on two findings: empty customer
notes suppressed existing conversation notes, and the action omitted cache-backed
email displayed by the guest card. Chief authorized one repair cycle for these
findings only. Notes must retain the prior conversation source; this remains an
identity-only change. Contact resolution must retain the card's existing precedence
and be captured before the click, not re-resolved from mutable selection then.
Regression and fresh-review evidence for that cycle is recorded separately from
the original green cases; the original green cases alone did not establish acceptance.

## Evidence and limitations

`verify-staff-create-booking-guest-context.js` builds real production HTML for
`sunset` and `wolfhouse-somo`, runs it in Chromium, and clicks actual Inbox buttons.
All HTTP is intercepted at `http://staff.test`; fixture identities are synthetic.
Only GETs and the existing read-only POST catalog lookup are served. Other
non-GET requests are blocked and cause assertions to fail. No submit or send is
clicked. This is offline behavioral proof, not a deployed staging claim.

Covered on each tenant:

1. Raw conversation has no name/email, but its rendered customer card does:
   Create booking must use that displayed identity.
2. Chat guest overlay uses the same identity.
3. Linked email thread uses the real contact phone, never its opaque email key.
4. Missing customer-context response retains known conversation name/phone;
   unknown email remains empty.
5. A-to-B real thread-row selection uses B's identity and cannot borrow A's email.
6. Wolfhouse's filled name field is visible in the existing drawer; special
   characters in names remain literal input values.

The two review findings additionally have isolated browser-DOM regressions loading
unmodified `inbox-context.js`: real full/condensed renderers and click handlers run,
with only the booking-open boundary captured. These check conversation notes
against empty/null/nonempty customer notes, same-phone cached name/email/language,
identity-over-cache precedence, and contact snapshot stability after mutating the
cache, model, and current selection. They do not pretend to submit a booking or
prove a deployed tenant. The original integrated portal cases above still run.

The initial red run reproduced a blank Sunset name and hidden Wolfhouse name
input. The Chat regression separately reproduced the generic raw-row name.
Logs, screenshots, synthetic request ledger, review verdict, and baseline
comparisons accompany the transfer package.

### Focused gates

Passing local gates:

- `verify-staff-create-booking-guest-context.js` (both tenants)
- `verify-staff-open-customer-deeplink.js` (both tenants; landed navigation retained)
- `verify-inbox-context.js`
- `verify-inbox-selection-safety.js`
- `verify-inbox-email-match-ui.js`
- `verify-inbox-thread-mockup.js`
- `verify-inbox-conv-detail-passthrough.js`
- `verify-inbox-guest-finish-001.js`
- `verify-inbox-customers-destination-retired.js`
- `verify-staff-customers-crm.js`

Two extra legacy gates were compared against a detached copy of the exact base
and fail there as well: `verify-sunset-portal-customers.js` and
`verify-sunset-booking-create-draft-defaults.js`. These are not counted as passing
and are not repaired here. The latter's isolated contact-prefill assertion passes
on both trees, but unrelated course-selection assertions and its rejected-promise
fixture fail. No claim of a green full Inbox/Luna suite.

The HTML parity harness is used to emit production HTML and capture baselines;
byte equality to base is not expected for this intentional behavior change.

### Adjacent observation, not included

On a fresh offline Sunset Inbox entry without first visiting Schedule, clicking
the create drawer's close button did not dismiss it; its Schedule-only control
wiring had not run. This pre-existing lifecycle issue is separate from identity
prefill. This patch does not change broad Schedule/submit/payment wiring. Browser
prefill cases use fresh navigation between drawer openings rather than pretending
the close control passed. Chief can separately scope that follow-up.

## Operator browser check after an approved landing/deploy

For both staging tenants, choose a test guest whose Inbox card already has contact
information. Open that thread and click Create booking. Confirm the name/phone
(and Wolfhouse email) match the card and remain editable. Repeat through Chat's
guest card, then with a second test guest whose email is missing. Do not submit,
create a payment link, or send anything. Deployment/live acceptance is a separate
operator lane.
