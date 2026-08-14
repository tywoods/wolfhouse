# Fleet Board — Slice 2b Plan (wire Deckhand/Seadog to the board)

Status: PLAN ONLY — not executed. Requires human go/no-go before any container/env change.
Owner sign-off pending. Nothing here is applied yet.

## Update 2026-08-14 (owner decisions folded in)

- **Skipper is the gate**, not Captain. Skipper (`hermes-orchestrator`) authenticates
  to GitHub as **`tywoods`** (HTTPS credential, `repo` scope — confirmed by Skipper,
  token not revealed). That is the SAME login the `done` gate is already hardcoded to
  (`CAPTAIN_GH_LOGIN = 'tywoods'`), so **no gate code change is needed** — Skipper can
  run `task done` today and pass the identity check.
- **Captain (Opus) drops out of the routine loop.** 2b-3 below: Skipper merges/deploys/
  `done`, not Captain. This is the main cost win (Opus was the expensive part, not the
  worker models).
- **Caveat (record, don't fix now):** Captain and Skipper both authenticate as `tywoods`,
  so the gate proves "an authorized `tywoods` credential," NOT which agent. It is a
  `tywoods`-credential gate, not per-agent. Fine for "Skipper is the gate for now."
- **Deckhand-deploys-on-dev-request: DEFERRED** ("just Skipper as gate for now").
- **Nav channel:** Skipper + Deckhand + Seadog are all present in the-cellar. Deckhand +
  Seadog are mention-gated (`WH_REQUIRE_MENTION`). No home-channel/no-mention change made;
  if Skipper should auto-listen later, MOVE the single no-mention slot to Skipper — do not
  stack two no-mention listeners (loop risk per the fleet plan).
- **Cost lesson:** build 2b as ONE scoped change, reviewed once — do not re-grind the
  shelved half-finished 2b-1 branch (it re-walks the three-bounce loop that burned quota).
- **Skipper board access — PROVEN LIVE 2026-08-14.** Skipper drives the board from its
  OWN writable clone `/opt/data/workspace/sandbox-repos/WH-orchestrator` (NOT the
  read-only `/opt/wolfhouse/WH` mount, which its uid 10000 cannot read). Auth is the
  `gh` at `/opt/data/home/.local/bin/gh`, logged in as `tywoods` (`repo` scope) — the
  gh path, not `GITHUB_TOKEN`. Verified end-to-end: `node .../WH-orchestrator/scripts/fleet/task.js list`
  returned the board.
- **DURABILITY (bake into Skipper's operating instructions):** Skipper's clone does NOT
  auto-update, so it drifts (it was stale on a pre-fleet-board commit until refreshed).
  **Before any board work each session, Skipper must run, in that clone:**
  `git fetch github && git reset --hard github/master` — otherwise `scripts/fleet/task.js`
  may be missing or stale. This is a required step in whatever SOUL/instruction block
  wires Skipper to the board.

## What 2b is (and what it is NOT)

2b teaches the worker agents to **use** the board on their turns: Deckhand claims a
task + opens a PR + sets `in-review`; Seadog reviews by SHA + `gate`s. It does NOT
touch Skipper (`hermes-orchestrator`) and does NOT change the Captain gate/deploy end.

**2a already shipped the prerequisite** (once merged): the `task` CLI is gh-free, so it
runs in the containers with their existing `GITHUB_TOKEN`. 2b is instruction + a tiny
config nudge, not new tooling.

## Ground truth (verified read-only, 2026-08-13)

- Workers are Docker containers on lunabox: `hermes-deckhand`, `hermes-seadog`,
  `hermes-orchestrator` (Skipper — off-limits). All up.
- Each mounts `/opt/wolfhouse/WH:ro` (read-only) and has its own `GITHUB_TOKEN`,
  `DISCORD_BOT_TOKEN`, and `WH_REQUIRE_MENTION`.
- Because the repo mount is read-only, `99z-wh-vm-post-bootstrap.sh` already seeds a
  **writable clone per engineering role** at
  `$HERMES_HOME/workspace/sandbox-repos/WH-<role>` with a `github` remote. Deckhand
  uses this pattern today; Seadog/orchestrator get one seeded too.
- Role behavior + per-role `config.yaml` is written at container init by
  `HERMES_ROLE` branches in `bootstrap.sh` / `99z-wh-vm-post-bootstrap.sh`.
- Seadog already has `DISCORD_HOME_CHANNEL` / `DISCORD_HOME_CHANNEL_THREAD_ID` set to
  the Navigation thread; workers are mention-gated (`WH_REQUIRE_MENTION`) with
  `DISCORD_ALLOW_BOTS` + `DISCORD_ALLOW_MENTION_REPLIED_USER` (loop breaker) already on.

## The change (smallest thing that works)

Per worker role, add board instructions to the agent's workspace + ensure the
writable clone can run `task`. Concretely:

1. **Deckhand** — append a short operating note to its workspace instructions
   (written at init, same mechanism as the existing role blocks): on being handed a
   task id, `cd` to `WH-deckhand`, `git fetch github`, `node scripts/fleet/task.js
   claim <id> --as deckhand`, branch, push to `github`, open PR, then
   `task review <id> --tip-sha <sha> --pr <n>`. Uses its own `GITHUB_TOKEN` (gh-free).
2. **Seadog** — same shape: on a review request, `task show <id>`, review the PR by
   SHA, then `task gate <id> --result pass|fail --notes …`.
3. **No new secrets.** Deckhand + Seadog use their own GitHub creds (they authenticate
   as themselves, not `tywoods`), so they can push/PR but the `done` gate rejects them.
   `done` is gated to the committed `tywoods` literal — which **Skipper** matches, so
   Skipper is the one that ships. Deckhand/Seadog physically cannot.

## What this does NOT change (guardrails)

- Skipper / `hermes-orchestrator`: its container config is untouched by 2b. Skipper's
  NEW role is to run the gate (`task gate`/`done`) as `tywoods` — that needs no code or
  env change (it already authenticates as `tywoods`).
- `done` remains identity-gated to the committed `tywoods` literal; now exercised by
  Skipper instead of Captain.
- No image rebuild (2a is gh-free; the CLI is already in the read-only mount).
- No new Discord listeners; workers stay mention-gated (no new no-mention listener,
  which is the loop-risk the fleet plan warns about).

## Risk + rollback (this is the picasso-outage class — treat it that way)

The dangerous part is **editing container init / env and restarting**. Rules:
- **Inspect + back up first.** Copy the current `99z-wh-vm-post-bootstrap.sh` and any
  touched env file before editing; keep the exact prior bytes.
- **One container at a time.** Change Deckhand, restart ONLY `hermes-deckhand`,
  verify it comes up healthy and still answers, before touching Seadog.
- **Never touch `hermes-orchestrator`** in this slice.
- **Validate before restart.** `sh -n` the bootstrap script; confirm no YAML/JSON
  config is malformed.
- **Rollback = restore the backed-up file + restart that one container.** No
  multi-container blast radius because changes are per-role and applied singly.
- **Captain gateway is separate** from these Hermes containers, so a worker restart
  cannot take Captain (me) down — unlike the picasso edit, which hit the OpenClaw
  gateway config directly.

## Build order

- **2b-1:** Deckhand instructions only. Change, restart `hermes-deckhand`, verify,
  hand it a real throwaway task end-to-end (claim → PR → in-review). No Seadog yet.
- **2b-2:** Seadog instructions. Same single-container discipline.
- **2b-3:** One full live loop — human files a task, Deckhand claims+PRs, Seadog
  reviews+`task gate pass`, **Skipper** merges+deploys+`done` (as `tywoods`). Captain
  (Opus) is NOT in this loop. Proves the loop without hand-carrying and without the
  expensive model.

## Open decisions for the owner (need answers before 2b-1)

1. **Where do worker board-instructions live** — appended to the per-role block in
   `99z-wh-vm-post-bootstrap.sh` (versioned, reviewable, my recommendation), or a
   workspace `AGENTS.md`/note under each `HERMES_HOME`? The bootstrap script is
   git-tracked and goes through the gate; a hand-edited workspace file does not.
2. **Restart cadence** — is a brief Deckhand/Seadog restart during a quiet window OK,
   or must it be scheduled? (Each restart is seconds, one container, but it drops any
   in-flight turn for that worker.)
3. **Scope of Deckhand's autonomy** — may it `git push` + open PRs unattended on being
   handed a task id, or should it stop for human confirm before the first push while
   we build trust? (I lean: unattended push to a branch is fine — it can't merge or
   deploy; only Captain can, and that's identity-gated.)
