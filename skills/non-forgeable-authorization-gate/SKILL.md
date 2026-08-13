---
name: "non-forgeable-authorization-gate"
description: "Gating a privileged CLI/script action (e.g. deploy, close, ship) so callers cannot bypass the boundary."
version: 1
author: "captain"
license: "MIT"
metadata:
  repo: "github.com/tywoods/wolfhouse"
  tags: ["security", "authorization", "cli", "review"]
---

## When to use

Gating a privileged action in a CLI, script, or tool — deploy, ship, close,
merge, mark-done, admin ops — where only an authorized principal may proceed.
Use whenever you write or review an auth check for such an action.

## Core rule: presence != authorization

A value the caller can set is NOT an authorization check, no matter its name.
This includes:
- environment variables (`SECRET_TOKEN`, `IS_ADMIN`, `CAPTAIN_TOKEN`)
- CLI flags (`--as captain`, `--force`)
- request headers / body fields the caller controls

Checking that such a value is *non-empty* or *present* authorizes nothing: the
caller just sets it. A named "token" env var is still caller-supplied unless its
value is verified against a secret the caller cannot know or an identity the
caller cannot forge.

## Procedure

1. Identify the action's real principal (who is allowed) and the threat (who
   might call it improperly — e.g. worker containers with their own creds).
2. Find a signal the caller cannot forge:
   - identity the platform reports for the credential in use
     (e.g. `gh api user --jq .login`, cloud IAM caller identity, verified JWT
     `sub` from a trusted issuer)
   - a secret compared against a server-held value the caller lacks
   - a runtime/credential binding the threat principal cannot obtain
3. Make the check MANDATORY. If the expected-principal config is missing,
   REFUSE — never fall through to "allowed". Optional identity checks are
   bypassable by omitting the config.
4. Verify value, not presence: fetch the platform-reported identity and compare
   it to the expected principal; die on mismatch or empty.
5. Delete the fake gate (the presence check) so it can't be mistaken for real.

## Pitfalls (evidenced)

- "Sounds safe, isn't": a check named for security (`CAPTAIN_TOKEN` present)
  can authorize nothing. Judge by whether the caller controls the value.
- Optional actor check: `if (expectActor) { verify }` is bypassable by leaving
  `expectActor` unset. Require the config first, then verify.
- Scope honesty: an identity gate defends against callers with *their own*
  creds, not against a caller who already holds the privileged principal's
  credential. State this limit; don't over-claim.

## Verification

Add a regression test that exercises the bypass the reviewer named: caller
supplies an arbitrary non-empty token/flag but is NOT the authorized identity ->
assert the action is REFUSED and its side effect did not fire (e.g. no `issue
close` in the command log). Run the full suite and confirm the new refusal test
passes alongside the authorized-path test.

## Worked example: fleet-board `done` guard (3 bounces to get it right)

A privileged CLI action — `task done` marks an issue shipped and closes it —
took three review rejections before the guard was real. Each attempt failed the
same rule above, just wearing a different disguise:

1. **Flag.** `if (f.as !== 'captain') die(...)` — a `--as captain` CLI flag.
   Any caller supplies it. Authorizes nothing.
2. **Env-presence.** `if (!process.env.FLEET_CAPTAIN_TOKEN) die(...)` — checked
   only that a named "token" env var was non-empty. A worker just sets
   `FLEET_CAPTAIN_TOKEN=x`. Presence != authorization.
3. **Env-value / self-identity.** Required `FLEET_CAPTAIN_GH_LOGIN` and compared
   it to `gh api user`. But the *expected* login came from a caller-set env var,
   so a worker set it to their own login; their own creds resolved to it; match.
   This proves "you are who you say you are," not "you are the Captain."

**What finally held (with a stated prerequisite):** the expected principal became
a **committed constant** in the repo — `const CAPTAIN_GH_LOGIN = 'tywoods'` —
never read from env, and the guard compares the platform-reported actor
(`gh api user` / REST `GET /user`) to that literal.

**The committed literal is only a boundary if the code path is integrity-
protected.** "A worker can't change the constant without a PR through the gate"
is FALSE on its own: if the worker can merge to the branch the gate runs from
(no branch protection, no CODEOWNERS on this file, or they hold a merge/deploy
credential), they can just edit the literal. So the constant is a
**defense-in-depth policy check** layered on top of two real controls that must
exist independently:
1. **Code integrity** — the file defining `CAPTAIN_GH_LOGIN` (and the gate) is
   protected: branch protection + required review/CODEOWNERS, so a worker cannot
   land a change to it unilaterally.
2. **Runtime integrity** — the code the gate actually executes at ship time is
   the reviewed, protected version (not a worker-supplied local copy).
Without both, the literal is advisory, not enforcing. State which of these hold
in your environment; don't assume them.

**Trap caught mid-fix:** a first cut allowed `FLEET_CAPTAIN_GH_LOGIN` to override
the constant "only in tests" via `FLEET_TEST=1`. But `FLEET_TEST` is *also*
caller-settable — the same bypass in disguise. The test seam must not be a
production-readable env override; drive tests through the mockable identity
call (mock `gh`) instead, so no env var can lower the bar in production.

**Verify the actual credential identities — don't hardcode an assumption about
them.** The gate's strength depends entirely on *who the threat principals can
authenticate as*, which is environment-specific and changes over time. In this
repo it did change: an early note claimed the worker containers had no `gh` and
"could not authenticate as anyone," but the workers carry their own
`GITHUB_TOKEN` and the CLI was later made `gh`-free precisely so they could reach
GitHub. So before relying on the gate, **check the live facts**:
- What login does the Captain runtime authenticate as? (`gh api user` / `GET /user`)
- What login does each *threat* principal authenticate as with the creds it
  actually holds? If any worker can authenticate as the Captain login, the gate
  is void — fix the credentials, not the check.

**Residual scope (state it honestly):** an identity gate defends against callers
who authenticate as *their own* principal. It does NOT defend against a caller
who already holds the Captain principal's credential — and, per the code-
integrity note above, it only enforces at all when the gate's own code is
protected from unilateral change.
