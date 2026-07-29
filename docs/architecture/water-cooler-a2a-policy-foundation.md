# Water-cooler A2A policy foundation

## Status

Implemented as a pure, fail-closed Python state machine only. **Not** wired into the Discord adapter, Hermes gateway, or any runtime hook.

## Decision

Agent-to-agent (A2A) messages in the Discord Water-cooler channel are admitted only by an injected, deterministic policy. The policy classifies each message as ignore, reject, human-started task, peer handoff, or peer review. Configuration supplies human starter IDs, Seadog bot ID, Deckhand bot ID, TTL, and enablement. Missing or invalid configuration fails closed (`enabled` default false).

## Protocol (markers only)

- Human: `TASK [target=seadog] [reviewer=deckhand]` plus arbitrary task text (text is never stored).
- Peer worker: first line `A2A-HANDOFF v1`, with a `task_id:` line.
- Peer reviewer: first line `A2A-REVIEW v1`, with a `task_id:` line.

Target channel: `1530209175861199019`.

## Lifecycle

```text
human TASK → awaiting Seadog handoff
  → Seadog A2A-HANDOFF → awaiting Deckhand review
  → Deckhand A2A-REVIEW → (repeat up to MAX_ROUNDS=3) → terminal
```

Self-bot, unknown bot/human, wrong channel, casual chat, malformed or duplicate events, forged task IDs, expiry, and a fourth round do not advance state.

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
- Persistence beyond the in-memory policy instance.
- Production enablement (`enabled` remains false until a later, separate change).
