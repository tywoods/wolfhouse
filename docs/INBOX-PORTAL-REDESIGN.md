# Unified Luna Inbox — redesign spec

Collapse the redundant **Conversations** and **Customers** tabs into a single person-centric
Inbox with one filter engine, one Luna mode control, a unified approve-before-send queue for
WhatsApp and email, live "watch Luna" activity, and email-first segment broadcasts.

This is the canonical spec for the Inbox rework. Read it before touching `scripts/browser/inbox-*.js`
or any `/staff/inbox/*` route.

## Status

| Phase | Work | State |
|---|---|---|
| 0 | Extract the Inbox front-end into `scripts/browser/inbox-*.js` | **done** (#499) |
| 0 | Fix escapes eaten by the `buildUiHtml` template literal — Inbox sites | **done** (#499, 7 sites) |
| 0 | Same bug class outside the Inbox — 16 sites, 9 functions | **done** (#502) |
| 0 | `GET /staff/inbox/thread/:id` composite endpoint | **done** (#506, #507, #509) — one snapshot; six original routes stay for polling. Inbox UI does not fetch `/staff-state`. |
| 1 | Unified shell, saved-view rail, merged context panel | API reads **done** (#510); UI rail not on master (layout is #511, do not merge) |
| 1 | Column layout model and presets | **PR #511 open, waiting operator** — do not merge, do not duplicate |
| 1 | One `Auto \| Draft \| Off` Luna mode control | **PR #524** — WhatsApp Auto\|Off, Email Draft\|Off; no migration 079; WhatsApp Draft is Phase 2 / 078 |
| 1 | Handoff state gap — Luna promises a takeover that never sets `needs_human` | **done** (detector + corpus gate) |
| 2 | Channel-agnostic approvals; WhatsApp draft parity (migration 078) | not started |
| 3 | SSE live activity, replacing 5s/3s polling | not started |
| 4 | Segments and broadcasts (migrations 080, 081) | not started |
| 5 | Identity linking across channels (optional) | not started |

## Why it feels bulky and redundant

The two tabs are two separate codebases describing the same thing: a person, their messages,
their bookings, their tags. Everything below is duplicated once per tab.

- Two lists, two row renderers.
- Two filter systems with different vocabularies: channel chips vs. the CRM `ALLOWED_FILTERS`
  in `scripts/lib/staff-customer-queries.js`.
- Two person cards: the Conversations right rail "BOOKINGS" and the Customers detail card.
- Two duplicated pill switchers, one per tab panel.
- Cross-links that exist only because the split is wrong: `openCustomerCardForPhone()` and
  `openInboxToPhone()`.
- Three overlapping Luna controls in one header — the "Luna" badge, "Pause Luna"
  (`bot_pause_states`), "Needs human" (`conversations.needs_human`) — plus legacy
  `conversations.bot_mode` and a separate global "Pause Luna Globally".
- Testing controls ("Reset Luna session", "Full Wipe") sit in the primary UI.
- The BOOKINGS rail renders every booking as a full card. A guest with three bookings fills the
  column and creates a nested scroll region inside an already-scrolling page.
- Luna's long messages print raw payment and waiver URLs inline, twice in some cases.
- The reply placeholder says "Edit reply before sending" but the box is empty, because WhatsApp
  has no draft to edit. The UI promises a flow that does not exist.

## Target UI

One Inbox. The left rail holds **saved views** — the single device that unifies conversations and
CRM. A view is just a filter over people; a Conversations-style view sorts by recency, a
People-style view enables multi-select and Broadcast. Same list component, same row component,
one server filter.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Sunset Surf School ▾   WhatsApp: Auto ▾   Email: Draft ▾   ⌘K Search        ● Live   + New   │
├───────────────────┬──────────────────────┬─────────────────────────────┬─────────────────────┤
│ NEEDS YOU         │ ⌕ filter this view   │  Marea Wolf                 │  Marea Wolf         │
│  Approvals    3 ▸ │ ─────────────────────│  +34600000404 · WhatsApp    │  Hot lead · Courses │
│  Needs human  1   │ ▸ Marea Wolf     wa  │  Luna: Auto (inherited) ▾   │                     │
│  Unassigned   2   │   "is the 10am free" │ ─────────────────────────── │  Checked in         │
│                   │   2m · ● unread      │                             │  Room 4 · 7–10 Aug  │
│ INBOX             │                      │  guest  is the 10am free?   │  Paid €130          │
│  All         24   │   Hernan         wa  │                        2m   │                     │
│  WhatsApp    18   │   "payment link…"    │                             │  ▸ Bookings      2  │
│  Email        6   │   1h                 │  ┌ Luna draft ──────────┐   │  ▸ Lessons       2  │
│  Snoozed          │                      │  │ Yes! 10am has 2 spo… │   │  ▸ Waivers       0  │
│                   │   Monshies      ✉    │  │ ▸ used availability  │   │  ▸ Notes            │
│ PEOPLE            │   "test message…"    │  │ [Approve ⏎] [Edit e] │   │                     │
│  Checked in  12   │   3h                 │  └──────────────────────┘   │  ▸ Broadcasts    1  │
│  Arriving today 4 │                      │                             │                     │
│  Hot leads   38   │   GoDaddy       ✉    │ ─────────────────────────── │  Create booking     │
│  Warm leads  91   │   "Monday 3PM…"      │  Write a reply…       [↵]   │  Edit profile       │
│  Unpaid       3   │   5h                 │                             │                     │
│  Waiver due   7   │                      │                             │                     │
│  + New segment    │  ☐ select  ·  38 rows│                             │                     │
└───────────────────┴──────────────────────┴─────────────────────────────┴─────────────────────┘
```

Concrete redundancy kills:

- Customers stops being a tab and becomes the PEOPLE views in the same rail. One list, one row
  renderer, one server endpoint.
- The Conversations right rail and the Customer detail card merge into the single right context
  panel. Collapsible sections already exist in `renderCustomerProfileSection()` — reuse that markup.
- Three Luna controls collapse to **one** three-state control: `Auto | Draft | Off`, inherited from
  the channel default and overridable per thread. `needs_human` becomes a status label and a view,
  not a competing toggle. "Pause Luna Globally" becomes `Off` on both channel selectors.
- The reply box merges with drafts: a Luna draft renders as a ghost bubble **inside the timeline**
  with Approve / Edit / Discard, instead of today's detached textarea.
- "Reset Luna session" and "Full Wipe" move behind a dev-only overflow menu.

Approvals queue for batch work (`J/K` navigate, `E` edit, `Enter` approve, `X` discard):

```
Approvals  3          [Approve all safe (2)]  [WhatsApp ▾]
┌────────────────────────────────────────────────────────┐
│ Marea Wolf · WhatsApp · 2m                             │
│ guest: is the 10am free?                               │
│ Luna: Yes! 10am has 2 spots left — want me to hold…    │
│ ▸ tools: availability(2 spots), price(€130)            │
│ [Approve & send ⏎]  [Edit e]  [Discard x]  [Handoff h] │
└────────────────────────────────────────────────────────┘
```

Broadcast composer, reached from any segment via multi-select (email-first):

```
Broadcast → Segment: Checked in now (12)
Channel:  ( • ) Email        ( ) WhatsApp  — operational only
Suppressed: 1 do-not-contact, 0 unsubscribed, 2 no email  →  9 recipients
Subject: BBQ tonight at 8pm 🔥
Body:    Hey {{first_name}} — we're firing up the grill…   [Luna: draft this]
[Preview recipients]  [Send test to me]  [Schedule ▾]  [Send to 9 →]
```

## Corrections to the operator's mockup

The mockup lives outside the repo, in the operator's chat assets. It confirmed pill-shaped
per-channel mode selectors with channel icons, the tool trace inside the draft card, initials
avatars in the list, counts on every view, and no per-row "Luna" pill. Apply these corrections
when building it:

- Delete "Pause Luna Globally" from the nav. The two channel selectors own that state.
- Drafts get no timestamp and no delivery ticks. The mockup showed `10:43 AM` with double checks
  on an unsent draft, which reads as already delivered.
- Align the draft card to the outbound side of the timeline, where Luna's sent messages sit.
- Add a needs-human status chip plus a raise action to the thread header. The rail has a Needs
  human view with nothing in the thread to feed it.
- Add date separators in the timeline. Threads routinely span days.
- Keep both search inputs (global command search, filter-this-view) but style them distinctly.

## Column layout model

Columns are referred to by number throughout: **1** views rail, **2** list, **3** chat,
**4** guest card.

Only column 3 is elastic. Columns 1, 2 and 4 snap between fixed widths and 3 absorbs the
remainder, so any combination of collapses yields a sane layout with no width arithmetic.

- **1** — `full` (240px) or `icons` (56px). Never fully hidden; it is navigation and the counts matter.
- **2** — `comfortable` (360px), `compact` (280px), or `hidden`.
- **3** — flexible, 480px minimum.
- **4** — `wide` (460px), `peek` (300px), or `hidden`.

Three presets on a top-bar segmented control. `Ctrl+1..4` is unusable because Chrome binds it to
tab switching, so use Alt.

- **All four** (`Alt+0`), the default: 1 full, 2 comfortable, 4 peek.
- **Chat** (`Alt+3`): 1 icons, 2 hidden, 4 peek. Column 3 roughly doubles.
- **Guest** (`Alt+4`): 1 icons, 2 hidden, 4 wide.

Individual toggles `Alt+1`, `Alt+2`, `Alt+4` collapse or restore a single column; Escape exits any
zoom. **No drag-to-resize**, by decision.

**Peek-on-demand** is what keeps focus modes usable: a collapsed column slides in as an overlay
above 3 on edge hover or its own shortcut, without changing the layout, and slides away on
selection. Without it, staff collapse column 2 for a big chat, immediately need the list, and
abandon focus mode within a day.

Automatic behavior:

- Viewport buckets drive the same mechanism rather than separate CSS: under roughly 1280px column
  4 auto-collapses, under roughly 900px column 2 auto-hides. A manual override wins until the
  viewport crosses a bucket boundary, then state is re-derived.
- Multi-selecting people for a broadcast auto-zooms 3 into the composer.

Implementation: one CSS grid on the shell with `grid-template-columns` built from custom
properties. JS only flips `data-col1` / `data-col2` / `data-col4` attributes on the container, so
there is no layout math in JavaScript and no framework. Preset state persists in `localStorage`
per user, keyed by viewport bucket.

## Density rules for the context panel

The right panel is where the current bulk lives, so it gets explicit rules rather than
"make it smaller".

- Two zones, not one uniform list. A compact current-stay block at the top carries plain facts with
  no chevrons (checked in, room and dates, outstanding balance); the collapsible collections
  (bookings, lessons, waivers, notes, broadcasts) sit below it.
- Dim or hide zero-count rows. `Waivers 0` should not compete with `Checked in: Yes`.
- Lead with one summary line per section, e.g. `3 bookings · €225 due`.
- Each booking is one row: dates, amount, payment state, chevron. Labels like STATUS, DATES,
  GUESTS, CONFIRM appear only inside the expanded row.
- Exactly one scroll region in the panel.
- Sections remember their expanded state per user, and default to collapsed except the one with an
  outstanding action.
- In the timeline, payment and waiver URLs collapse to named chips (`→ payment €130`, `→ waiver`)
  carrying the real link, instead of printing the URL twice.
- The panel is **strictly read-only for bookings**. Every row deep-links into the existing Bookings
  tab, which stays the single owner of booking edits. "Create booking" deep-links there prefilled,
  rather than opening a form in the panel. This is what stops the panel drifting into a second
  booking UI.

## Architecture

Front-end lives in browser modules injected at `/* INJECT:... */` markers by
`scripts/lib/inbox-browser-source.js`, mirroring the Schedule tab's
`scripts/lib/sunset-schedule-browser-source.js`.

Existing after Phase 0:

- `inbox-list.js` — conversation list filtering, live polling, bubble rendering
- `inbox-thread.js` — thread detail, Luna pause controls, WhatsApp send, email draft/approve
- `inbox-customers-filters.js`, `inbox-customers-outreach.js`, `inbox-customers-profile.js`

Still to build:

- `inbox-shell.js` — layout, top bar, view rail, routing, keyboard shortcuts
- `inbox-context.js` — right panel (person, bookings, lessons, waivers, notes)
- `inbox-approvals.js` — approvals queue
- `inbox-broadcast.js` — segment builder and broadcast composer

## API consolidation

Existing endpoints stay for back-compat during migration.

- `GET /staff/inbox/views` — shipped (#510): saved views with counts, replacing both
  filter-chip systems. The UI rail that consumes this is not on master.
- `GET /staff/inbox/list?view=&q=&cursor=` — shipped (#510): one list endpoint returning
  person-rows; unifies `/staff/conversations` and `/staff/customers`
- `GET /staff/inbox/thread/:id` — shipped (#506, #507, #509): one snapshot for thread
  open. The six original conversation sub-routes stay routed for polling and
  back-compat. The Inbox UI does not fetch `/staff-state`; the composite does not
  carry a `staff_state` section.
- `PUT /staff/inbox/luna-mode` — scope `global | channel | conversation`, value `auto | draft | off`
- `GET /staff/inbox/approvals` and `POST /staff/inbox/approvals/:id/{approve,edit,reject}` —
  channel-agnostic, generalizing today's email-only `/staff/inbox/email/approve-send`
- `GET /staff/inbox/stream` — SSE for live activity, replacing `INBOX_LIST_POLL_MS` /
  `INBOX_THREAD_POLL_MS` polling, with polling kept as fallback
- `POST /staff/broadcasts`, `POST /staff/broadcasts/:id/send`, `GET /staff/broadcasts/:id`

## Data model

Next free migration number is 078 (077 is the pricing pair).

- `078_luna_outbound_approvals.sql` — channel-agnostic approvals: `client_id`, `conversation_id`,
  `channel`, `draft_text`, `edited_text`, `status` (pending/approved/rejected/sent/expired),
  `tool_trace` JSONB, `created_by_run_id`. Today only email has this, via
  `tenant_email_reply_approvals` (migration 070). WhatsApp has no approval step at all.
- `079_luna_channel_modes.sql` — persisted mode per `(client_id, location_id, channel)` plus a
  per-conversation override. Replaces env-only `LUNA_AUTO_SEND_ENABLED` / `WHATSAPP_DRY_RUN`
  control and retires `conversations.bot_mode`.
- `080_inbox_saved_views.sql` — saved views and segments; seed with the existing `ALLOWED_FILTERS`
  presets so nothing regresses.
- `081_broadcasts.sql` — `broadcasts`, `broadcast_recipients` (per-recipient status and reply
  attribution), `contact_suppressions` (unsubscribe). `do_not_contact` suppression already exists
  in `scripts/lib/staff-customer-outreach-send.js` — reuse it.
- `082_conversation_read_state.sql` — `last_read_at` and `assigned_to`, needed for the unread and
  Unassigned views. Neither is stored today.

## Draft mode for WhatsApp — the real work

Email already generates a draft without sending (`POST /staff/inbox/email/generate-luna-draft`).
WhatsApp does not: on staging, Hermes auto-replies straight through
`_patched_whatsapp_cloud_send` in `docker/hermes-staging/apply_gateway_patches.py`, with no staff
click.

Draft mode needs a new decision point in Hermes's send patch: before sending, ask the Staff API for
the effective mode. If `draft`, write an approval row and return without sending — exactly as
`pause_gate.py` already does for pauses. The JS-side equivalent is
`evaluateGuestReplySendRouteWithPause` in `scripts/lib/luna-guest-reply-send-route.js` for the
legacy webhook path.

## The template-literal escape bug class

The inline portal script lives inside the `buildUiHtml` template literal, which **consumes
single-backslash escapes** before the JS reaches the browser: source `/\s+/` ships as `/s+/`, and
`/[^\d]/` ships as `/[^d]/`. Nothing throws; the regex just silently matches the wrong thing.
Moving code into `scripts/browser/` modules fixes this implicitly, because module files are not
template-evaluated.

Four bugs this shipped, all fixed in #499 by executing the emitted functions before and after:

- `customerProfileInitials` returned `"SL"` for "SliceB AllDay One" instead of `"SO"`.
- `normalizeCustomerPhoneClient` returned an empty string for any phone not already starting with
  `+`, because it stripped everything except the letter `d`.
- `inboxHumanizeStatus` rendered `waiting_on_guest` as `"waiting on gue t"`.
- `openInboxToPhone` compared phone digits with `/D/` instead of `/\D/`, so the
  Customers-to-Conversations cross-link matched on the wrong string.

The remaining 16 metacharacters across nine functions outside the Inbox were restored in #502 by
doubling the backslash in the template. In the emitted `/staff/ui` HTML those regexes now keep
their shorthands: `scheduleAddIsoDays` guards ISO dates with `/^\d{4}-\d{2}-\d{2}$/`,
`scheduleNormalizePhoneDigits` strips with `/\D/g`, and the money-touching quote parsers
(`bcQuoteDigitsBeforeCent`, `bcQuoteParseTrailingInt`, `bcQuoteAccommodationNote`) strip
non-digits with `/[^\d]/g`. `scripts/verify-portal-template-escapes.js` (`npm run
verify:portal-template-escapes`) renders both tenants through `buildUiHtmlForOfflineTest` and
fails if a regex reaches the browser missing its backslash.

## Handoff state gap

In a live thread, Luna's reply said "a teammate will take over and sort those for you", yet
`Needs human` stayed off on that conversation and no attention pill showed in the list. Two paths
can set the flag and both missed: Luna wrote handoff copy without calling `flag_needs_human`, and
the outbound-text fallback in `docker/hermes-staging/wolfhouse_whatsapp_mirror.py` matched none of
its five hardcoded phrases.

Fixed by keeping the copy and the state on one rule:

- `docker/hermes-staging/SOUL.md` (and the Sunset SOUL) carry a hard rule — promising that a
  person will take over, get back to the guest, follow up, review or sort something out **requires**
  `flag_needs_human` in the same turn, and the phrasing is banned when she is not handing off.
- `scripts/lib/luna-guest-handoff-promise.js` is the single owner of "does this outbound reply
  promise a human?". The Hermes Python mirror carries byte-identical pattern sources; the legacy JS
  reply path, the Cami `handoff_copy_without_handoff_flag` guard and the coach evaluator all call it
  instead of their own phrase lists.
- `fixtures/luna-handoff-promise-corpus.json` holds the phrasings (positives from real repo copy,
  SOUL rules, the live thread and review probes; negatives that merely mention the team), and
  `scripts/verify-luna-handoff-promise-detection.js` runs it through both engines inside
  `verify:luna-all`. A new phrasing that slips through fails CI instead of stranding a guest — add
  the phrasing to the corpus when it does.

The SOUL rule is the guarantee; the detector is the safety net. Luna's wording is generated, so no
corpus can enumerate it — a detector miss only strands a guest when Luna also skipped
`flag_needs_human`. Read corpus coverage as "how much slack the net has", not as the promise that
handoffs get flagged.

Still open for Phase 1: the needs-human status chip and raise action in the thread header, and the
Needs-you rail itself.

## Constraints

- **Broadcasts are email-only for promotions.** WhatsApp broadcast is restricted to operational
  messages to currently checked-in guests, and each recipient is still checked against Meta's
  24-hour window. Nothing in the repo handles that window or message templates today, so the
  composer must show the reachable count honestly rather than fail at the Graph API.
- Email inbound is built but default-off (`EMAIL_INBOUND_INBOX_BRIDGE_RUNTIME_WIRED = false`). The
  unified inbox shows email threads only once that composition is enabled; the UI should degrade
  cleanly, not appear broken.
- Person identity is phone-keyed (`customers` unique on `(client_id, phone)`) and email threads use
  synthetic `emailv1:<hash>` phones with no email uniqueness. One person with both channels shows
  as two rows until the identity-linking phase.
- `scripts/staff-query-api.js`, `database/` and `infra/` are operator-owned per `CODEOWNERS`.
- Gate every phase with `npm run verify:luna-all` and `node scripts/verify-inbox-ui-parity.js`
  (capture a baseline with `--save` **before** editing). `scripts/verify-sunset-luna-inbox-mirror.js`
  asserts the poll intervals and will need updating when SSE lands.
