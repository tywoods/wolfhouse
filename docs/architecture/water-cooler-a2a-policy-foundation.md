# Water-cooler A2A policy foundation

## Status

Implemented as a pure, fail-closed Python state machine plus a repository-owned **runtime bridge**, **controlled peer-envelope builder**, **controlled outbound action/plugin** (opt-in, default off), and **adapter-patch foundation** (inactive seams only). **Not** wired into the live Discord adapter at runtime, Hermes gateway apply path, Dockerfile apply path, bootstrap enablement, compose, SOUL, or any live hook. Production enablement remains off.

## Decision

Agent-to-agent (A2A) messages in the Discord Water-cooler **Navigation thread** (not the parent Water-cooler channel) are admitted only by an injected, deterministic policy. The policy classifies each message as ignore, reject, human-started task, peer handoff, or peer review. Configuration supplies parent channel ID, Navigation thread ID, human starter IDs, Seadog bot ID, Deckhand bot ID, **local bot ID** (exactly Seadog or Deckhand for this process), TTL, and enablement. Missing or invalid configuration fails closed (`enabled` default false).

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

Target exact message channel (Navigation thread): `1532167084618944734`.
Parent Water-cooler channel (thread parent must match): `1530209175861199019`.
Activation requires both `WATER_COOLER_A2A_PARENT_CHANNEL_ID` and `WATER_COOLER_A2A_THREAD_ID`.

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
| Runtime bridge | `docker/hermes-staging/wolfhouse/water_cooler_a2a_runtime.py` |
| Peer envelope builder | `docker/hermes-staging/wolfhouse/water_cooler_a2a_envelope.py` |
| Authorized outbound context | `docker/hermes-staging/wolfhouse/water_cooler_a2a_action_context.py` |
| Controlled outbound action | `docker/hermes-staging/wolfhouse/water_cooler_a2a_action.py` |
| Opt-in Hermes plugin | `docker/hermes-staging/plugins/water_cooler_a2a/` |
| Adapter hooks (inert) | `docker/hermes-staging/wolfhouse/water_cooler_a2a_adapter_hooks.py` |
| Adapter patch foundation | `docker/hermes-staging/apply_water_cooler_a2a_adapter_patch.py` |
| Admission-shape fixture | `docker/hermes-staging/wolfhouse/fixtures/water_cooler_a2a/discord_adapter_admission_shape.py` |
| Policy unit tests | `docker/hermes-staging/wolfhouse/test_water_cooler_a2a_policy.py` |
| Runtime unit tests | `docker/hermes-staging/wolfhouse/test_water_cooler_a2a_runtime.py` |
| Envelope unit tests | `docker/hermes-staging/wolfhouse/test_water_cooler_a2a_envelope.py` |
| Action unit tests | `docker/hermes-staging/wolfhouse/test_water_cooler_a2a_action.py` |
| Adapter patch unit tests | `docker/hermes-staging/wolfhouse/test_water_cooler_a2a_adapter_patch.py` |
| Verifier | `docker/hermes-staging/verify_water_cooler_a2a_pilot.py` |

### Runtime bridge contract

A later Hermes Discord adapter hook may construct `WaterCoolerA2ARuntime.from_mapping(explicit_map)` and call `handle_event(DiscordMessageEvent)`. The mapping uses neutral keys `WATER_COOLER_A2A_*` only (no ambient `os.environ` reads inside the bridge). The bridge returns a narrow action:

| Action | When |
|--------|------|
| `SUPPRESS` | Disabled/invalid config, casual/wrong-channel, reject paths, non-consumer peer echo, reviewer human-task mirror |
| `DISPATCH_HUMAN_TASK` | Named worker only; valid human `TASK` |
| `DISPATCH_PEER_HANDOFF` | Reviewer instance only; valid worker handoff |
| `DISPATCH_PEER_REVIEW` | Worker instance only; valid reviewer review |

The bridge never calls an LLM, Discord SDK, tools, network, filesystem, or logs message bodies. Action metadata never carries raw task/peer text. Caller owns all side effects (including reading the original event content when dispatching).

Policy evaluation still runs on every instance so local mirrors advance; only the expected consumer receives a `DISPATCH_*` action.

Future adapter hook may call `WaterCoolerA2ARuntime.handle_event` (preferred) or `WaterCoolerA2APolicy.evaluate`. This slice does not import or mutate Discord session routing.

## Adapter patch foundation (inactive)

Repository-owned `apply_water_cooler_a2a_adapter_patch.py` can unit-test / opt-in patch the Hermes Discord adapter. It is **not** invoked by `apply_gateway_patches.py`, Dockerfile, or bootstrap.

Guarded anchors encode the live admission shape (not assumptions):

1. inbound handler ignores self messages, then applies `DISCORD_ALLOW_BOTS` (`mentions` only admits a bot message that mentions the receiving bot);
2. multi-agent filter ends in `await self._handle_message(message, role_authorized=_role_authorized)`;
3. `_handle_message` separately enforces allowed/ignored/free/mention routing.

Two seams are injected when the patcher is explicitly applied (tests only today):

| Seam | Placement | Default |
|------|-----------|---------|
| Narrow mention bypass | inside `require_mention` gate when no mention | calls `a2a_allow_mention_bypass` → always False |
| Pre-model dispatch | after `MessageEvent` build, before `handle_message` / text batch | calls `a2a_pre_dispatch_intercept` → always False |

The mention bypass is the **only** path intended for a later activation that lets a valid human `TASK [target=seadog] [reviewer=deckhand]` reach A2A policy without a Discord mention. It must **not** be solved by globally changing `require_mention`, adding Water-cooler to free-response channels, or broadening bot admission.

Patcher rules: unique anchors required; unknown/ambiguous/partial source fails closed with no write; re-apply is idempotent.

## Controlled peer-envelope builder

`build_peer_envelope` accepts only an already-authorized runtime `BridgeAction`, exact channel ID, configured exact recipient bot mention, opaque task ID, and bounded body.

| Authorized action | Emitted envelope |
|-------------------|------------------|
| `DISPATCH_HUMAN_TASK` or `DISPATCH_PEER_REVIEW` | `A2A-HANDOFF v1` (worker outbound) |
| `DISPATCH_PEER_HANDOFF` | `A2A-REVIEW v1` (reviewer outbound) |
| `SUPPRESS` / other | rejected |

Leading exact recipient mention supports peer `DISCORD_ALLOW_BOTS=mentions` admission. `build_peer_envelope_from_model_reply` always rejects — envelopes are never auto-built from plain model text.

## Controlled outbound action (source only; default off)

Hermes plugins are **opt-in** (`plugins.enabled` allow-list). Luna config enables only `wolfhouse-staff-api`. Deckhand/orchestrator configs enable no plugins. Therefore a dedicated plugin can exist in-repo and load only when Seadog/Deckhand configs later enable `water-cooler-a2a` + toolset `water_cooler_a2a` — without registering on Luna/Sunset/orchestrator.

| Piece | Contract |
|-------|----------|
| Tool | `water_cooler_a2a_send` — model supplies **body text only** |
| Context | `establish_from_dispatch` after bridge `DISPATCH_*`; holds task_id, recipient, channel, action, envelope kind, scoped send callback |
| Sender | `WaterCoolerScopedSender` — rejects any channel other than the authorized Water-cooler channel |
| State | `policy.record_local_outbound` advances local mirror **only after successful send** (self-messages are ignored by Discord adapter) |
| Fail closed | no context, used context, disabled policy, wrong role/stage, expiry/terminal, missing adapter, send failure, oversize body, duplicate tool use |

Plain model replies never become A2A. Destination/channel/peer/round/task_id are never model parameters.

## Explicit non-goals (this slice)

- Activating adapter hooks, applying the patch in Docker/bootstrap, SOUL edits, compose/env changes, or enabling the plugin in any role config.
- Model or tool invocation inside the policy, bridge, hooks, or envelope builder (the plugin is registered only when explicitly enabled later).
- Persistence beyond the in-memory policy instance (per process).
- Shared volume, network service, signed token, or shared secret for A2A.
- Production enablement (`enabled` remains false until a later, separate change).
- Deploy, push, merge, restart, Azure, Discord configuration, or secrets.
