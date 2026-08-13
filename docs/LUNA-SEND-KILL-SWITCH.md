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
decisions that came out of writing it down — all four are settled. Hermes is the
staging source of truth for guest WhatsApp.
`scripts/verify-hermes-send-flags.js` proves every behavioural claim here by running
the shipped code, and pins each ruling so it cannot drift quietly.

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

Four questions came out of this. All four are settled. Hermes is the staging source of truth
for guest WhatsApp; the legacy JS path is left alone in this PR unless a ruling says otherwise.
The gate pins each ruling so the decided behaviour cannot drift without updating this table.

| id | question | status | ruling |
|----|----------|--------|--------|
| `kill_switch_flags_unread_by_hermes` | Should the Hermes send path honour both kill-switch flags, fail-closed? | `resolved-in-this-pr` | `honour-both-flags-fail-closed` |
| `needs_human_blocks_on_hermes_not_js` | A thread flagged for a human with no pause row — does Luna keep talking (JS) or go quiet (Hermes)? | `ruled` | `hermes-quiet` |
| `sunset_needs_human_carveout_defeated` | Sunset exempts needs_human from pausing, and Python overrides it — is the carve-out the intent, or dead code? | `ruled` | `keep-hermes-fail-closed` |
| `email_pause_advisory` | Off is off on WhatsApp but not on the staff email Luna draft — should Off mean off on both channels? | `ruled` | `fail-closed` |

### (a) `needs_human` blocks on Hermes but not in JS — **ruled: Hermes quiet**

`scripts/lib/luna-guest-reply-send-route.js` never reads `conversations.needs_human`, so with
`bot_pause_states` clear it sends. The Staff API gate reports `needs_human` as an effective
pause (`source: 'conversations_needs_human'`) and `pause_gate.py` honours it, so Hermes stays
silent on the same thread.

**Ruling:** Hermes is right. A flagged thread with no pause row → Luna goes quiet. Hermes is
the staging source of truth. The JS legacy path is **not** changed in this PR; aligning it is
separate work. The gate pins Hermes quiet on a `conversations_needs_human` response.

### (b) The Sunset `needs_human` carve-out is defeated in Python — **ruled: keep Hermes fail-closed**

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

**Ruling:** Keep Hermes fail-closed. Do **not** open the carve-out in Python — under (a) the
carve-out is contradictory (a flagged thread must go quiet). The gate pins that
`pause_gate.py` still returns paused for the Sunset carve-out response shape.

If the Staff API carve-out is wrong (dead code that misleads), that fix belongs in
operator-owned `scripts/staff-query-api.js`: stop special-casing `sunset` in the
`needs_human` branch of `checkGuestAutomationPauseState` so it reports `bot_paused: true`
like every other tenant. **Described here; not edited in this PR.**

### (c) Pause / kill switches on the email arm — **ruled: fail-closed**

`scripts/lib/staff-email-luna-draft-route.js` never reads `bot_pause_states`, so a paused
conversation can still get a Luna email draft. The gate still drives the shipped route with a
paused conversation today and records that it answers 200 with a draft — that is the unpaid
gap against this ruling, not the decided behaviour.

**Ruling:** Fail closed, not advisory. If the thread is paused, or dry-run / auto-send is
disabled, do **not** send (or offer a Luna draft that pretends Off is still On) on the email
arm either. Off means off on both channels. Implementing that Inbox alignment is separate
from the Hermes kill-switch wiring; the gate pins the ruling as `fail-closed` so the decision
cannot quietly revert to advisory.

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
