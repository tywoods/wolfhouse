# Fleet Orchestration Plan — Luna / Wolfhouse

Status: proposed (2026-08-12). Owner sign-off pending on the two open decisions at the end.

## Goal

Let the agents coordinate themselves through **one shared task board + one gate**, so
humans (Monshies / Earthling) **supervise instead of hand-carrying** specs, diffs, and
status between isolated agent chats. No platform change — we stay on Discord.

This is deliberately *not* a free-for-all where every bot talks to every bot. Last night
proved why: the failures (an uncommitted fix wiped by a reset, a dead tmpfiles diff link,
a parallel deploy clobbering merged work) were **coordination/state** failures. More chatter
makes those worse. A shared source-of-truth + a single referee makes them go away.

## Communication fabric (how they work together without a backchannel)

Captain is a **separate OpenClaw agent** on the Lunabox host (shell + Azure + docker),
**not** a Hermes container, and is **reactive** (wakes on a Discord message, not a daemon).
The Hermes agents (Skipper/Deckhand/Seadog/Luna) are separate gateways that talk via Discord
mentions. There is no private wire between Captain and the Hermes bots — and we don't need one.

**Everyone coordinates through shared state (the board), not direct chat.** Two bridges:

1. **Read/write the board** — one Postgres table + a tiny `task` CLI. Every container and the
   host reach the same staging DB, so all agents share one common ground. No backchannel needed.
2. **A "wake" poke** — Discord's only job here is to *nudge* the right agent, not carry content.
   A message in a watched channel wakes an agent; it then reads the board and acts.

### One front door (answers "do I have to @mention every bot?")

**No.** You never mention anyone. The rule:

- **Exactly one channel** is the front door (reuse Skipper's jobs thread, or a new `#fleet-ops`).
- In that channel **only Skipper listens without a mention** (`require_mention: false` for Skipper
  there, and nowhere else). You talk to Skipper like normal chat.
- **Workers stay mention-gated.** Skipper does the bot-to-bot @mentioning under the hood
  (the existing A2A-lite alias→mention rewrite). Those mentions are an implementation detail
  between bots — you never type them.
- Do **not** put multiple no-mention listeners in one channel — they'd all answer every message
  and loop. One listener-without-mention per channel, always.
- **Captain** is woken by a ping in `#Captain` (or the ops channel) when gate/deploy work is ready.
  Requires: bots allowed to post there (`DISCORD_ALLOW_BOTS=mentions`) and Captain allowed to wake
  on a bot message — verify this small config before relying on it.

## Roles (mostly who they already are)

- **Human (Monshies / Earthling)** — create a task (title + acceptance), approve deploys, set priority. Supervise, don't relay.
- **Skipper** (orchestrator) — read new tasks, split big ones, assign an owner, prioritize, nudge the owner. Does **not** implement or deploy.
- **Deckhand** (implementer) — claim a task, work in its `/opt/data` clone, push a branch, write the `tip_sha`, move to `in_review`.
- **Seadog** (reviewer) — review the actual commit **by SHA** (not a link), approve → `gated`, or reject → back to Skipper with a reason.
- **Captain** (gate + deploy) — the **only** one who merges to master and deploys. Verify SHA, run verifiers, build/deploy tagged with master SHA, record the revision, mark `done`.
- **Luna / sunset-luna** (guest-facing) — out of scope for this loop; untouched.

## The board — Slice 1 spec (what Deckhand builds first)

A single Postgres table on the shared staging DB, plus a small `task` CLI runnable from any
container and the host (all reach the same DB).

### Table `fleet_tasks`

```
id            bigserial primary key
title         text not null
spec          text not null                 -- the brief + what "done" means
created_by    text not null                 -- 'monshies' | 'earthling' | 'skipper' | ...
owner         text                          -- assigned agent: 'deckhand' | 'seadog' | 'captain' | null
status        text not null default 'queued'
priority      int  not null default 3       -- 1 highest .. 5 lowest
base_sha      text                          -- master SHA the work is based on
branch        text                          -- feature branch name
tip_sha       text                          -- REQUIRED before review: the committed work SHA (never a tmpfiles link)
pr_number     int
gate_result   text                          -- 'pass' | 'fail' | null (Seadog + Captain gate notes)
deploy_rev    text                          -- container-app revision after Captain deploys
bounces       int  not null default 0       -- reject/rework count (loop guard)
notes         text
created_at    timestamptz not null default now()
updated_at    timestamptz not null default now()
```

`status` state machine (enforced by the CLI, not just convention):
```
queued → assigned → claimed → in_progress → in_review → gated → deploying → done
                                     ↘ blocked        ↘ rejected → (back to assigned)
```

### `task` CLI (Slice 1)

- `task create --title T --spec S [--priority N]`  → prints new id, status=queued
- `task list [--status S] [--owner A]`             → board view
- `task show <id>`                                  → full row
- `task claim <id> --as <agent>`                    → assigned→claimed (owner set)
- `task update <id> --status S [--branch b --tip-sha SHA --notes ...]` → guarded transition
- `task gate <id> --result pass|fail --notes ...`   → in_review→gated (pass) or →rejected (fail, bounces++)
- `task next --as <agent>`                          → highest-priority task assignable to that agent
- `task block <id> --reason ...` / `task unblock <id>`

Guards the CLI enforces (this is where the doc becomes *real*, not just intentions):
1. Cannot enter `in_review` without a non-empty `tip_sha` (SHA, not a URL).
2. Only `owner='captain'` may set `deploying`/`done` + `deploy_rev`. **No other agent can mark deployed.**
3. Illegal state jumps are rejected.
4. `bounces >= 3` → auto-`blocked` + flag for human (loop guard).

## Hard rules (the guardrails — all lessons from last night)

1. **One gate, one deployer = Captain.** No agent self-ships. This is the rule that kept staging alive.
2. **Work referenced by committed SHA / PR only** — never tmpfiles, never a pasted diff.
3. **One owner per task** → two agents never touch the same file → no clobber.
4. **Loop cap** → after 3 reject bounces, auto-block + escalate to a human.
5. **Human STOP word** freezes Skipper's dispatch instantly.
6. **Every deploy tagged with the master SHA** (already standard practice).

## Who's the orchestrator (recommended: hybrid)

- Skipper does the fuzzy human-language part: read the request, split, prioritize, nudge.
- Captain does the deterministic dangerous part: dispatch to the gate, gate, deploy.
- LLM for judgment; plain code for the button that can break prod.

## Build order (each slice is useful on its own)

- **Slice 1 — the board.** `fleet_tasks` migration + `task` CLI (this doc). Skipper + Captain read/write it. Change nothing else. Outcome: a live board, no work living only in a human's head, hand-offs by SHA.
- **Slice 2 — wire the agents.** Skipper reads/writes via the CLI on assign/prioritize; Deckhand/Seadog on claim/review; Captain on gate/deploy. Drop tmpfiles entirely.
- **Slice 3 — Discord bridge.** Board status changes auto-post to the front-door channel; human "stop"/"approve"/"bump" in the channel writes back to the board.
- **Slice 4 — safety + visibility.** Loop caps, auto-escalation, a simple board view / metrics.

## Config changes needed

- Front-door channel: `require_mention:false` for **Skipper only**; workers mention-gated.
- Captain wake path: bots allowed to post to `#Captain`; Captain wakes on a bot message. Verify first.
- All engineering containers: DB connection to the staging DB for the board (most already have staging DB access).

## How this plan gets built (the first real use of the loop it describes)

- **Deckhand** builds Slice 1 (migration + CLI) from this spec → branch + PR.
- **Seadog** reviews the SHA.
- **Captain** gates + ships the migration/CLI.
- **Skipper** adopts this doc as its operating manual once the board exists.

## Open decisions for the owner

1. **Front door:** reuse Skipper's existing jobs thread, or spin up a fresh `#fleet-ops`?
2. **Deploy autonomy:** keep a human approving every deploy (recommended for now), or let Captain
   auto-deploy on `gated` for low-risk staging tasks later?
