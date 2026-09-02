# SUNSET-LUNA-LIVE-TEST-001 — proof

Target: sunset-staging only. No production, no guest send, no deploy.

## Defects

| # | Live failure | Owner | Proof |
|---|--------------|-------|-------|
| 1 | Draft mode inbound stayed silent with no Inbox draft | Hermes send path: `pause_gate.outbound_disposition_from_gate` + `mirror_whatsapp_outbound_as_draft` (Staff API already stages `luna_outbound_approvals`) | Durable Staff `thread_message.draft_staged`, no Meta wamid, `_orig_whatsapp_cloud_send` not reached. Staging exception/false is a typed BLOCK, never `draft_staged: true`. |
| 2 | 15-person booking handed off instead of using remaining seats | `get_sunset_lesson_availability` plugin + Sunset SOUL | 15-fit proceeds; 15-shortfall states Staff API `seats_available` and offers another slot |
| 3 | Unclear / large party auto-set Needs human | `flag_needs_human` auto-escalation guard | Unclear/large_party reasons do not POST `/conversation/needs-human`; one clarifying question |
| 4 | Needs human muted Luna | `pause_gate` no longer ORs raw `needs_human` | Sunset later inbound is not paused; Wolfhouse still pauses via Staff `bot_paused` |

## TDD

1. **Draft persist** — RED: `outbound_disposition_from_gate` missing (`AttributeError`). GREEN: `test_draft_mode_inbox_persist.py` **45/45**.
2. **15-person capacity** — RED: take_request handoff copy, no remaining-seat number. GREEN: `test_sunset_party_capacity.py` 20/20.
3. **Clarify first** — RED: `flag_needs_human(unclear)` POSTed needs_human. GREEN: `test_sunset_clarify_before_escalate.py` 30/30.
4. **needs_human not mute** — GREEN after pause_gate disposition owner: `test_needs_human_not_mute.py` 12/12.

## Correction (PR #838 independent-review BLOCK)

Draft mode caught every `mirror_whatsapp_outbound_as_draft` failure, then unconditionally returned `success` with `draft_staged: true`. The helper returned enqueue acceptance, not durable Staff API draft creation — silent no-Inbox-draft, the live incident.

- **RED:** `test_draft_mode_inbox_persist.py` **32 passed, 13 failed**. Staging exception / `False` / typed `{staged: false}` / bare enqueue `True` all claimed `draft_staged: true`. Helper treated `enqueue_mirror_payload` as success even when `_post_mirror_sync` returned `None` / `draft_staged: false` / raised.
- **GREEN:** same file **45/45**. Exception and false results return `success=False`, `draft_staged: false`, `blocked_reason`, no wamid, zero provider calls. Helper `staged` is true only when Staff API `thread_message.draft_staged` is true (existing `POST /staff/bot/whatsapp-thread-mirror`). Enqueue is not a durability substitute. No new endpoint or toggle.

## Gates

- `node scripts/verify-sunset-luna-live-test-001.js` — **11/11**
- `node scripts/verify-hermes-send-flags.js` — 53/53
- `node scripts/verify-luna-effective-mode.js` — 54/54
- `node scripts/verify-luna-pause-handoff-controls.js` — 36/36
- `node scripts/verify-sunset-luna-inbox-mirror.js` — 63/63

Local `.grok-*.md` prompt is gitignored and not committed.

## Semantics preserved

- Tenant-global WhatsApp Auto / Draft / Off is still the only channel toggle.
- Conversation-scoped Luna / Needs Human is review state on Sunset, not a second mute switch.
- Facts/capacity remain Staff API/DB. Remaining-seat copy uses `seats_available` from the tool.
- Draft persist is a Staff Inbox side effect (`luna_outbound_approvals` via the existing thread-mirror POST), not a provider send. Zero Meta sends. If Staff API does not confirm `draft_staged`, Hermes BLOCKs rather than claiming a draft exists.
