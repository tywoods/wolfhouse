---
name: "confirm-side-effect-before-reporting-done"
description: "Before reporting a git push, merge, close, or file write as done, confirm the actual remote/side-effect state instead of trusting command exit."
---

# Confirm side effect before reporting done

## When
Before telling the user a state-changing action succeeded — git push, PR
merge, issue close, file write, task marked done. Any claim of "pushed",
"merged", "landed", "closed", or "done".

## Why
A command exiting 0, or your own intent to run it, is not proof the side
effect landed. Reporting success from intent (not verified state) is a
repeated failure: it is easy to say "pushed" when the push was skipped,
partial, or went to the wrong ref.

## Rule
Do not report a state-changing action as complete until you have read back
the actual resulting state and it matches what you claim. Verify the effect,
not the exit code.

## Procedure
1. Run the action.
2. Query the authoritative state of the thing you changed.
3. Compare that state to the claim. Only then report done.
4. If they differ, report the discrepancy, not success.

## Verification recipes
Push landed (local tip == remote tip):

    echo "local:  $(git rev-parse HEAD)"
    echo "remote: $(git ls-remote origin refs/heads/<branch> | cut -f1)"

The two SHAs must be identical. `git push` printing success is not enough;
read the remote ref back.

File write landed: read the file (or grep the new marker) after writing;
confirm the changed content is present, not just that write returned ok.

Issue/PR closed or merged: query the object state
(`gh pr view <n> --json state,mergedAt` etc.) and confirm the terminal
state, not just that the command ran.

## Pitfall
Do not chain "did the action" and "reported done" without the read-back in
between. State partial completion honestly: e.g. "branch pushed (local ==
remote) but task not yet walked through the board / PR not opened" beats a
blanket "done" that overstates what happened.
