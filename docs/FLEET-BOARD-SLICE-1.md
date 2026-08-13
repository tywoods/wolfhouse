# Fleet Board — Slice 1 (GitHub-as-board)

Status: implemented. Owner-approved 2026-08-13 (human-approved job-start + deploy).

## What this is

The fleet coordination loop, built on GitHub instead of a custom Postgres board.
Every Hermes worker container and the host share `/opt/wolfhouse/WH` and can run
`gh`/`git`, so GitHub is the one common ground — no new DB, no backchannel.

- **Tasks = GitHub Issues.** Status carried by `fleet:*` labels.
- **Work = branch + PR**, referenced by committed SHA. Never a tmpfiles link, never a pasted diff.
- **One gate + one deployer = Captain** (the `main` OpenClaw agent on lunabox).
- **Front door = the Navigation thread** on Discord. Discord only wakes the right agent.

## Status labels (state machine)

```
fleet:queued -> fleet:claimed -> fleet:in-review -> fleet:gated -> fleet:done
                       \-> fleet:blocked (needs human; incl. loop cap)
```

## Roles

- **Human (Monshies / Earthling)** — create tasks, approve deploys, set priority. Supervise, don't relay.
- **Skipper** (`hermes-orchestrator`) — orchestrator. NOT wired in this slice (busy). Adopts the board later.
- **Deckhand** (`hermes-deckhand`) — implementer: claim, branch, PR, set tip SHA -> in-review.
- **Seadog** (`hermes-seadog`) — reviewer: review by SHA, approve -> gated, or reject (bounce).
- **Captain** (`main` on lunabox) — the ONLY merge+deploy. Verify SHA, run gates, deploy tagged with master SHA, mark done.

## The `task` CLI

Thin wrapper over `gh issue` / `gh pr` / `gh api`. Runnable from any container/host.

- `task create --title T --body B [--priority N]`  -> new issue, label `fleet:queued`
- `task list [--status S]`                          -> board view
- `task show <id>`                                  -> full issue
- `task claim <id> --as <agent>`                    -> queued -> claimed (assignee set if FLEET_GH_LOGIN_<AGENT> maps a login; else comment-only, and it says so)
- `task review <id> --tip-sha SHA [--pr N]`         -> claimed -> in-review (REQUIRES a real SHA)
- `task gate <id> --result pass|fail [--notes ...]` -> in-review -> gated (pass) or bounce (fail)
- `task done <id> --deploy-rev REV`                 -> gated -> done (CAPTAIN ONLY — verified GitHub actor identity, not a flag or env-presence)
- `task block <id> --reason ...` / `task unblock <id>`

### Guards (enforced by the CLI, not just convention)

1. Cannot enter `in-review` without a non-empty 7+ hex `tip-sha` (a SHA, not a URL).
2. `done` (gated -> done + deploy-rev) is gated on **verified GitHub actor identity**, not env-presence: `FLEET_CAPTAIN_GH_LOGIN` is **mandatory** and the CLI verifies it against `gh api user` (the login GitHub reports for the credential in use). A worker cannot forge this without the Captain account's actual gh token — setting any `FLEET_CAPTAIN_TOKEN` value does nothing. This is an identity/capability boundary, NOT a caller-supplied flag or a mere env-var presence check.
3. Illegal state jumps are rejected (must follow the state machine).
4. 3rd reject bounce -> auto `fleet:blocked` + a comment flagging a human (loop guard).

## Not in this slice (flagged, blocked on Skipper free / Hermes wiring)

- Skipper auto-dispatch (assign/prioritize/nudge from issues).
- Deckhand/Seadog auto-claim/review behavior inside their containers.
- Discord status-change auto-posts + "stop/approve/bump" write-back.

Until then, Captain runs the gate/deploy end by hand on human approval. Fully reversible.
