---
name: "non-forgeable-authorization-gate"
description: "Gating a privileged CLI/script action (e.g. deploy, close, ship) so callers cannot bypass the boundary."
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

**What finally held:** the expected principal became a **committed constant** in
the repo — `const CAPTAIN_GH_LOGIN = 'tywoods'` — never read from env, and the
guard compares the platform-reported actor (`gh api user`) to that literal. A
worker cannot change the constant without a PR through the very gate it protects.

**Trap caught mid-fix:** a first cut allowed `FLEET_CAPTAIN_GH_LOGIN` to override
the constant "only in tests" via `FLEET_TEST=1`. But `FLEET_TEST` is *also*
caller-settable — the same bypass in disguise. The test seam must not be a
production-readable env override; drive tests through the mockable identity
call (mock `gh`) instead, so no env var can lower the bar in production.

**Boundary verified, not assumed:** confirmed the Captain host authenticates as
`tywoods` and the threat principals (worker containers `hermes-deckhand`,
`hermes-seadog`) have no `gh` at all — they cannot authenticate as anyone. State
the residual scope honestly: this defends against workers with their own creds,
not against someone already holding the Captain's token (who could push to
master directly anyway).
