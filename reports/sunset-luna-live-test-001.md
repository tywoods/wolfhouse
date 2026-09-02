# SUNSET-LUNA-LIVE-TEST-001 — proof

Target: sunset-staging only. No production, no guest send, no deploy.

## Defects

| # | Live failure | Owner | Proof |
|---|--------------|-------|-------|
| 1 | Draft mode inbound stayed silent with no Inbox draft | Hermes send path: `pause_gate.outbound_disposition_from_gate` + `mirror_whatsapp_outbound_as_draft` (Staff API already stages `luna_outbound_approvals`) | Draft persist, no Meta wamid, `_orig_whatsapp_cloud_send` not reached |
| 2 | 15-person booking handed off instead of using remaining seats | `get_sunset_lesson_availability` plugin + Sunset SOUL | 15-fit proceeds; 15-shortfall states Staff API `seats_available` and offers another slot |
| 3 | Unclear / large party auto-set Needs human | `flag_needs_human` auto-escalation guard | Unclear/large_party reasons do not POST `/conversation/needs-human`; one clarifying question |
| 4 | Needs human muted Luna | `pause_gate` no longer ORs raw `needs_human` | Sunset later inbound is not paused; Wolfhouse still pauses via Staff `bot_paused` |

## TDD

1. **Draft persist** — RED: `outbound_disposition_from_gate` missing (`AttributeError`). GREEN: `test_draft_mode_inbox_persist.py` 22/22.
2. **15-person capacity** — RED: take_request handoff copy, no remaining-seat number. GREEN: `test_sunset_party_capacity.py` 20/20.
3. **Clarify first** — RED: `flag_needs_human(unclear)` POSTed needs_human. GREEN: `test_sunset_clarify_before_escalate.py` 30/30.
4. **needs_human not mute** — GREEN after pause_gate disposition owner: `test_needs_human_not_mute.py` 12/12.

## Gates

- `node scripts/verify-sunset-luna-live-test-001.js` — 9/9
- `node scripts/verify-hermes-send-flags.js` — 53/53
- `node scripts/verify-luna-effective-mode.js` — 54/54
- `node scripts/verify-luna-pause-handoff-controls.js` — 36/36
- `node scripts/verify-luna-explicit-human-handoff.js` — 31/31
- `node scripts/verify-sunset-luna-inbox-mirror.js` — 63/63
- `node scripts/verify-sunset-luna-needs-human-send-fix.js` — 26/26
- `python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_luna_tool_guards.py` — 84/84
- `npm run verify:luna-all` — 41/48 in this sandbox. Unrelated reds vs exact base: missing `pg`/`dotenv` (`luna-add-guest-*`, `luna-golden`, `sunset-luna-school-context`) and pre-existing `inbox-theme` CSS scope. Related reds (`hermes-send-flags`, `luna-pause-handoff-controls`) were fixed in this PR.

## Semantics preserved

- Tenant-global WhatsApp Auto / Draft / Off is still the only channel toggle.
- Conversation-scoped Luna / Needs Human is review state on Sunset, not a second mute switch.
- Facts/capacity remain Staff API/DB. Remaining-seat copy uses `seats_available` from the tool.
- Draft persist is a Staff Inbox side effect (`luna_outbound_approvals`), not a provider send.
