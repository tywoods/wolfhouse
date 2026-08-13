# Luna send kill switch — what can stop a message reaching a guest

Two flags exist so that no real guest can receive an unintended message:

- `WHATSAPP_DRY_RUN` — anything other than the literal `false` means dry run is **on**.
- `LUNA_AUTO_SEND_ENABLED` — anything other than the literal `true` means auto-send is **off**.

Both are fail-closed: unset, empty or unparseable does not send.

They worked on the legacy JS path (32 files under `scripts/` read them) and appeared
**nowhere** in `docker/hermes-staging/**/*.py`. Hermes is what actually runs on staging, so
on the only path that reaches a real phone neither flag could stop anything. A kill switch
that only works on the path nobody uses is worse than no kill switch, because everyone
believes they are covered.

This document is the map of what blocks a send today, on each path, and of the four
decisions that came out of writing it down. `scripts/verify-hermes-send-flags.js` proves
every behavioural claim here by running the shipped code.

## What blocks a send, per path

| Gate | Legacy JS route | Hermes (staging) |
|------|-----------------|------------------|
| `bot_pause_states` global / conversation row | blocks (`gate_bot_paused`) | blocks (via the Staff API gate) |
| `conversations.needs_human` | never read — sends | blocks — divergence (a) |
| `LUNA_AUTO_SEND_ENABLED` | blocks unless `send_kind: 'staff_reply'` | blocks (this change) |
| `WHATSAPP_DRY_RUN` | blocks at the provider | blocks (this change) |
| Staff API unreachable / unusable | pause read failure does not block | blocks (fail closed) |
| Send-eligibility classifier (`requires_staff`, …) | blocks | no counterpart — Hermes has no classifier |

Owner files:

- Hermes flags: `docker/hermes-staging/wolfhouse/send_flags.py`, called from
  `_patched_whatsapp_cloud_send` in `docker/hermes-staging/apply_gateway_patches.py`.
- Hermes pause: `docker/hermes-staging/wolfhouse/pause_gate.py`.
- JS rules, all of them, in one place with a machine-generated truth table:
  `scripts/lib/luna-effective-mode.js`.

## The staff Inbox is not affected

The JS route exempts `send_kind: 'staff_reply'` from the auto-send gate — a human clicking
**Send** is not Luna auto-replying. That distinction does not reach the Hermes patch, and
does not need to: the staff Inbox posts to `POST /staff/inbox/send-reply` on the Staff API,
which calls the Meta Graph API from Node (`sendLunaWhatsAppMessage` in
`scripts/lib/luna-whatsapp-provider.js`). It never enters Hermes's WhatsApp adapter, whose
signature (`send(chat_id, content, reply_to, metadata)`) carries no `send_kind` to carve out
on. Hermes only ever sends Luna's own replies, so the guard applies to all of them.

Consequence worth stating plainly: with `WHATSAPP_DRY_RUN` on, **staff can still reply** from
the portal. Only Luna goes quiet.

## Nothing is protected until the image is rebuilt

These flags live in the Hermes image. Merging this changes nothing on staging until the
operator rebuilds and redeploys the Hermes image, per `CLAUDE.md`. After that deploy,
`hermes-luna` will be silent until both flags are set in `/etc/hermes-luna.env`:

```bash
# /etc/hermes-luna.env  — on Lunabox
WHATSAPP_DRY_RUN=false
LUNA_AUTO_SEND_ENABLED=true
```

then `docker compose -f docker/hermes-staging/docker-compose.vm.yml up -d hermes-luna`.

That silence is the intended failure mode, not an accident: Luna going quiet is recoverable,
an unintended send to a real guest is not. Every blocked send says exactly which flag stopped
it and what value would allow it:

```
[wolfhouse] send blocked (luna_auto_send_not_enabled) — LUNA_AUTO_SEND_ENABLED is unset;
set LUNA_AUTO_SEND_ENABLED=true in /etc/hermes-luna.env and restart hermes-luna to allow
sends (guest …0404, WHATSAPP_DRY_RUN=True, LUNA_AUTO_SEND_ENABLED=False)
```

with a matching structured `logger.warning` (`{"event": "guest_send_blocked_by_flag", …}`) in
the same shape `pause_gate.py` uses for a pause.

## Decision record

Four questions came out of this. Only the first is settled — fail-closed flags need no
ruling. The other three are real behaviour choices about whether a guest gets a reply, and
are pinned by the gate so they cannot resolve themselves quietly.

| id | question | status |
|----|----------|--------|
| `kill_switch_flags_unread_by_hermes` | Should the Hermes send path honour both kill-switch flags, fail-closed? | `resolved-in-this-pr` |
| `needs_human_blocks_on_hermes_not_js` | A thread flagged for a human with no pause row — does Luna keep talking (JS) or go quiet (Hermes)? | `awaiting-ruling` |
| `sunset_needs_human_carveout_defeated` | Sunset exempts needs_human from pausing, and Python overrides it — is the carve-out the intent, or dead code? | `awaiting-ruling` |
| `email_pause_advisory` | Off is off on WhatsApp but not on the staff email Luna draft — should Off mean off on both channels? | `awaiting-ruling` |

### (a) `needs_human` blocks on Hermes but not in JS

`scripts/lib/luna-guest-reply-send-route.js` never reads `conversations.needs_human`, so with
`bot_pause_states` clear it sends. The Staff API gate reports `needs_human` as an effective
pause (`source: 'conversations_needs_human'`) and `pause_gate.py` honours it, so Hermes stays
silent on the same thread.

What a guest experiences: they asked something a staff member flagged. On the legacy path
Luna keeps chatting. On staging she stops mid-conversation and waits for a human. Both are
defensible; they cannot both be right.

Recommendation: **Hermes**. A flag raised for a human is the clearest signal we have that the
thread is not Luna's, and silence is the recoverable failure. That makes the JS route the bug.

### (b) The Sunset `needs_human` carve-out is defeated in Python

`checkGuestAutomationPauseState` in `scripts/staff-query-api.js` deliberately exempts Sunset —
it returns `bot_paused: false` and `can_continue_guest_automation: true` while still reporting
the raw `needs_human` field. `pause_gate.py` then does:

```python
paused = bool(
    data.get("bot_paused")
    or data.get("live_send_blocked")
    or data.get("can_continue_guest_automation") is False
    or data.get("needs_human") is True       # ← overrides the carve-out
    or data.get("paused") is True
)
```

so Sunset Luna goes quiet anyway and the carve-out has no effect on staging.

What a guest experiences: at Sunset, a flagged thread either keeps getting Luna's answers
(the carve-out working) or goes silent (today). Either the carve-out is deliberate, in which
case `pause_gate.py` is the bug and should drop the `needs_human` OR in favour of the gate's
own verdict; or going quiet is correct, in which case the carve-out is dead code that should
be removed rather than left to mislead the next reader.

`scripts/staff-query-api.js` is operator-owned, so the Sunset half of this is described and
not made. If the ruling is "the carve-out is dead code", the change there is to stop
special-casing `sunset` in the `needs_human` branch of `checkGuestAutomationPauseState` so it
reports `bot_paused: true` like every other tenant; the Python side then needs no change.

Recommendation: **drop the carve-out** (align Sunset with (a)), and take the `needs_human` OR
out of `pause_gate.py` so the Staff API stays the single decider of what counts as a pause.

### (c) Pause is advisory on the email arm

`scripts/lib/staff-email-luna-draft-route.js` never reads `bot_pause_states`, so a paused
conversation can still get a Luna email draft. The gate proves this by driving the shipped
route with a paused conversation and recording every SQL statement it issues: it answers 200
with a draft and never mentions `bot_pause_states`.

What a guest experiences: nothing directly — the email arm is draft-only (`draft_only: true`,
`auto_send_allowed: false`), so a human always presses send. What changes is what staff see:
a thread they switched **Off** still offers Luna-written prose.

Recommendation: **make Off mean off on both channels**, but note it is a behaviour change to
the Inbox, so it belongs with the mode selector work in `docs/INBOX-PORTAL-REDESIGN.md`
rather than being slipped in here.

## Proving it

```bash
node scripts/verify-hermes-send-flags.js        # the kill switch, run for real
node scripts/verify-luna-effective-mode.js      # the JS rules + the truth table
python3 docker/hermes-staging/wolfhouse/test_send_flags.py
```

`verify-hermes-send-flags.js` asserts nothing about source text. It runs
`wolfhouse/send_flags.py` against the shipped JS predicates over the whole flag matrix, calls
the real `_patched_whatsapp_cloud_send` with a recording provider, runs `pause_gate.py`
against a loopback Staff API, and then applies three mutants to a throwaway copy of
`docker/hermes-staging/` — guard deleted, dry-run flag stops being read, auto-send read as
truthy — to prove each one is caught.
