# Water-cooler A2A policy foundation

## Status

Implemented as a pure, fail-closed Python state machine only. **Not** wired into the Discord adapter, Hermes gateway, or any runtime hook.

## Decision

Agent-to-agent (A2A) messages in the Discord Water-cooler channel are admitted only by an injected, deterministic policy. The policy classifies each message as ignore, reject, human-started task, peer handoff, or peer review. Configuration supplies human starter IDs, Seadog bot ID, Deckhand bot ID, **local bot ID** (exactly Seadog or Deckhand for this process), TTL, and enablement. Missing or invalid configuration fails closed (`enabled` default false).

## Cross-process mirror (required)

Seadog and Deckhand run in **separate processes**. There is no shared writable volume, database, or secret.

- When an allowed human `TASK` arrives, **both** role-local policy instances deterministically create the same `task_id` / state from the same inbound Discord message (`derive_task_id(channel_id, message_id)`).
- The **worker** instance (`local_bot_id == seadog_bot_id`) returns `HUMAN_TASK` so only the named worker is dispatched to its model.
- The **reviewer** instance records the same mirror state but returns `IGNORE` / `mirrored_task_non_dispatch` so it never independently works the task.
- Both processes receive and validate controlled peer envelopes against **local** mirrored state. Worker emits handoffs; reviewer emits reviews.
- **Restart fail-closed:** a restart empties local in-memory task state; subsequent peer envelopes are rejected (`unknown_or_forged_task_id`), never replayed from Discord history.

## Protocol (markers only)

- Human: `TASK [target=seadog] [reviewer=deckhand]` plus arbitrary task text (text is never stored).
- Peer worker: first line `A2A-HANDOFF v1`, with a `task_id:` line.
- Peer reviewer: first line `A2A-REVIEW v1`, with a `task_id:` line.

Target channel: `1530209175861199019`.

## Lifecycle

```text
human TASK → both instances mirror state
  worker: HUMAN_TASK (dispatch) | reviewer: IGNORE (mirror only)
  → Seadog A2A-HANDOFF → both validate → awaiting Deckhand review
  → Deckhand A2A-REVIEW → both validate → (repeat up to MAX_ROUNDS=3) → terminal
```

Self-bot, unknown bot/human, wrong channel, casual chat, malformed or duplicate events, forged task IDs, wrong `local_bot_id`, empty/restarted mirror, expiry, and a fourth round do not advance state.

## State (allowed facts only)

Opaque task ID, expected worker/reviewer bot IDs, stage, timestamps, source channel/message ID, round count. **Never** task body, peer notes, or model output.

## Module boundary

| Role | Path |
|------|------|
| Policy | `docker/hermes-staging/wolfhouse/water_cooler_a2a_policy.py` |
| Unit tests | `docker/hermes-staging/wolfhouse/test_water_cooler_a2a_policy.py` |
| Verifier | `docker/hermes-staging/verify_water_cooler_a2a_pilot.py` |

Future adapter hook may call `WaterCoolerA2APolicy.evaluate` only. This slice does not import or mutate Discord session routing.

## Explicit non-goals (this slice)

- Runtime Discord adapter wiring, SOUL edits, Docker/compose changes.
- Model or tool invocation inside the policy.
- Persistence beyond the in-memory policy instance (per process).
- Shared volume, network service, signed token, or shared secret for A2A.
- Production enablement (`enabled` remains false until a later, separate change).
