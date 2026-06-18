# Cursor spec — "no silent-wrong-defaults" on the add-on / booking-modify paths

**Lane:** Staff API + Hermes plugin (Cursor). **Author:** Captain. **Status:** spec for relay — do not build until owner confirms.
**Robustness plan:** step 3 (server-side half of the whack-a-mole cure).

## The disease

Luna builds tool args from natural language; the server is strict. When a required arg is
missing or ambiguous on the add-on / booking-modify paths, the server today does one of two
bad things:

1. **Silent wrong default** — e.g. surf-lesson `quantity` omitted → priced as 1 lesson
   (the "lesson=1" bug, live session `20260618_074816`). Produces a wrong-but-plausible quote
   the guest is never asked to confirm.
2. **Bare 422 → needless handoff** — e.g. `add_service_to_booking(yoga)` with no quantity →
   `resolveBotAddonRequestContext` returns the soft kind `ask_quantity`, but the **create**
   handler flattens *any* non-`ready` kind into HTTP 422, which the Hermes plugin maps to
   `staff_review_needed` → `flag_needs_human` → staff handoff (the "yoga-422" bug).

Both defeat the goal: the system should ask one clear question, not guess wrong or punt to staff.

## The rule

> On any add-on / booking-modify entry point, a **missing or ambiguous required arg** must
> return a structured, **guest-relayable clarifying question** — never a silent wrong default,
> and never a bare 422 that the plugin turns into a staff handoff.

`ask_*` (need more info from the guest) and `handoff_to_staff` (genuinely needs a human) are
**different outcomes** and must not collapse into the same 422.

## Concrete changes

### 1. Stop the create handler flattening `ask_*` into 422
`scripts/staff-query-api.js` ~**L9079-9081** (addon create handler):

```js
if (ctx.kind !== 'ready') {
  const status = ctx.kind === 'db_error' ? 500 : 422;   // ← flattens ask_quantity/ask_service_date/ask_board_type
  return sendJSON(res, status, { success: false, write_performed: false, ...ctx.payload, ... });
}
```

The **preview** handler (~L8944-8946) already returns these soft kinds gracefully with their
`next_action`. The create handler should do the same: return the `ask_*` kinds as **200** (or a
dedicated non-error status the plugin reads as "relay this question"), carrying
`next_action: 'ask_quantity' | 'ask_service_date' | 'ask_board_type'` + a localized
`question` string, with `write_performed:false`. Keep `db_error → 500` and
`handoff_to_staff → 422` (or its own field) as today. Only the **soft ask_* kinds** change.

### 2. Plugin: relay the question, don't hand off
Hermes `add_service_to_booking` (and the addon-request mapping) must treat a `next_action: 'ask_*'`
response as a normal Luna turn — relay `question` to the guest and await the answer — **distinct**
from `staff_review_needed`. Only `handoff_to_staff` / real errors set `staff_review_needed`.

### 3. Sensible defaults where 1 is the only reading
For single-instance add-ons (one yoga class, one lesson on a given date) default `quantity = 1`
server-side so the common case doesn't even need a round-trip. Where quantity is genuinely
multi-valued (N lessons across guests×days, N boards), **ask** — never assume.

### 4. Localize the question strings
`ask_*` `question` text in en/it/de/es per existing i18n parity (`check-i18n-guest-copy.js` gate).

### 5. Audit the other entry points
Sweep every add-on / modify path (`resolveBotAddonRequestContext` callers, board-type, service-date,
meal qty, yoga qty) for the same "missing arg → wrong default or 422" pattern. Each soft-missing
arg becomes a relayable question; each impossible arg (already covered by Captain's `input_guard`
on availability/quote) stays rejected.

## Boundary / pairing
- **Captain (Luna SOUL) already shipped** `55149fb` — lessons/yoga/meals bill per `quantity` =
  total count (guests × lesson-days); Luna now passes quantity. This server rule is **defense in
  depth**: even if Luna omits or mis-guesses, the server asks rather than mis-prices.
- Captain's `input_guard` fail-opens on `check_availability` / `quote_booking` only; the
  write/charge add-on path is deliberately **server-owned** (guessing on a charging path is the
  wrong layer for the client guard). This spec is that server-owned half.

## Acceptance
- `add_service_to_booking(yoga, no quantity)` → guest sees "how many / which date?" relayed by
  Luna, **no** `flag_needs_human`. (This flips golden fixture `fix1b-post-booking-yoga-alias`
  from XFAIL → green — the live signal that it's fixed.)
- Surf-lesson quote with omitted quantity → clarifying question, never a silent 1-lesson price.
