# Wolfhouse (WH) — agent context

This repo is **Wolfhouse booking + Luna guest front desk** for a surf hostel in Somo, Spain.

You are helping the **team build and operate** this system. Read files with terminal/search tools when you need detail — this file is the map.

## Product

- **Wolfhouse** — surf hostel / guest house in Somo.
- **Guests** chat on **WhatsApp** (Meta Cloud API).
- **Staff** use the staff portal (`staff-staging.lunafrontdesk.com` on staging).
- **Luna** is the guest-facing host persona (warm WhatsApp tone, one clear question per message).

## Architecture (current operating lane)

```
Guest WhatsApp  →  classic Luna / Hermes (existing OVH France staging)
                    →  configured conversation model
                    →  Staff API (commercial authority, Postgres, payments)
```

- **Operating lane:** `hermes-luna` and `ovh-wolfhouse-staff` on OVH France. The staging Luna Compose file is `/srv/luna/wolfhouse/config/compose.yml` (read-only inventory checked 2026-11-05). Re-read service/image/mount identity before each approved change; a tracked Compose reference is not proof of live wiring.
- **Classic source:** `docker/hermes-staging/plugins/wolfhouse_staff_api/` and `docker/hermes-staging/wolfhouse/`. The model owns intent and wording; Staff owns availability, quotes, payments and booking writes. See the current owner table in `docs/ARCHITECTURE-NORTH-STAR.md`.
- **Candidate:** Luna v3 (`docker/hermes-luna-v3/`, `hermes-luna-clone`) is a separate comparison/migration lane, not an approved replacement merely because its container is running. No implicit cutover or extra live ingress.
- **Legacy compatibility:** n8n workflows and `scripts/lib/luna-guest-*` are not the classic operating brain. Some JS routes remain reachable; inventory consumers before disabling or deleting them.
- **Historical deployment targets:** Azure ACA and Lunabox instructions remain historical/recovery references, not the default operator path. Do not deploy to Azure or revive a retired target from an old runbook.
- **Release boundary:** GitHub is source of truth; image publication is not deployment. Use `docs/GITHUB-CONTAINER-BUILDS.md` for candidate checks and the existing-staging identity/backup/approval gates. Production, host restarts, guest sends and business mutations require their respective explicit approvals.

## Repo layout

| Area | Path | Notes |
|------|------|--------|
| Classic Luna guest runtime | `docker/hermes-staging/plugins/wolfhouse_staff_api/`, `docker/hermes-staging/wolfhouse/` | Registered tools, draft lifecycle, reply integration |
| Legacy JS guest surfaces | `scripts/lib/luna-guest-*.js` | Compatibility/demo callers; inventory before retirement |
| Staff API | `scripts/staff-query-api.js` | Large staff + bot HTTP surface |
| Staff portal front-end | `scripts/browser/*.js` | Browser modules injected into `/staff/ui` |
| Candidate build/release gates | `docs/GITHUB-CONTAINER-BUILDS.md` | SHA/digest identity, mounted overlays, separate staging approval |
| Historical ACA deploy | `scripts/deploy-staging-hermes.js` | Not the current staging release/smoke entrypoint |
| Historical local Hermes notes | `docs/HERMES-LOCAL.md` | The documented `scripts/run-local-hermes.js` entrypoint is absent; not an executable current workflow |
| Golden fixtures | `fixtures/luna-golden/` | Regression transcripts |
| Canonical guest rules | `docs/LUNA-GUEST-BEHAVIOR-SPEC.md` | **Read this** for Luna behavior |
| Inbox redesign spec | `docs/INBOX-PORTAL-REDESIGN.md` | **Read this** before Inbox/portal work |
| Guest journey | `docs/LUNA-GUEST-JOURNEY.md` | End-to-end flows |
| Hermes on Azure (historical) | `docs/HERMES-AZURE-CONTAINER-APPS.md` | Archive/recovery reference, not current operator instructions |
| Hermes local | `docs/HERMES-LOCAL.md` | Talk to Hermes about this repo |
| DB migrations | `database/migrations/` | Postgres schema |
| Infra | `infra/` | Env examples, deployment notes |
| Multiclient staging routing (shadow) | `docs/MULTICLIENT-STAGING-ROUTING.md` | Operator runbook; not enabled in Azure yet |

## Luna behavior (summary)

Full spec: `docs/LUNA-GUEST-BEHAVIOR-SPEC.md`.

- **Facts** (prices, availability, payment URLs) come from **tools/DB only** — never model memory.
- **Classic Luna model** decides intent/acceptance and authors guest wording from trusted tool facts; Staff validates commercial facts and commits booking/payment operations.
- **Transitional code remains:** classic draft/finalizer and diagnostic paths still have legacy responsibilities. Follow the canonical behavior spec and executable regression evidence; do not assume the transition is complete. The JS planner/composer/Cami split describes legacy callers, not a second authority to add to classic.
- **One question per reply** on WhatsApp; explain package tiers before asking guests to pick.
- **No internal jargon** to guests (no “composer”, “staging”, “dry run”, etc.).
- **Handoff** only on explicit reasons — not on low confidence alone.

## Verification commands

```bash
npm run verify:luna-all          # mixed source/offline gate; requires pinned Hermes dependencies
node scripts/verify-hermes-send-flags.js          # WhatsApp kill switches, run for real
node scripts/verify-inbox-ui-parity.js            # staff portal UI byte parity

# Staging acceptance: separately approved operator run against the exact candidate.
# Do not use the historical ACA chat-test alias as evidence for OVH staging.
```

**Staff portal UI parity:** the Inbox front-end lives in `scripts/browser/inbox-*.js`, injected
into `/staff/ui` at `/* INJECT:... */` markers. When moving that code around, capture a baseline
**before editing** with `node scripts/verify-inbox-ui-parity.js --save`, then re-run without
`--save` after each step to prove the rendered HTML is byte-identical. The baseline lives in
`tmp/` (gitignored), so a fresh clone has none — save one first or you are refactoring blind.

Static gates that assert on portal UI strings must read `scripts/lib/staff-portal-ui-source.js`
(template **plus** injected modules), not `staff-query-api.js` alone.

## Working conventions

- **Git (mandatory):** GitHub is source of truth — `docs/GITHUB-REPO-SETUP.md`.
  - **Before `git push` or any Hermes/Staff API deploy:** run `node scripts/assert-repo-sync.js` (also runs automatically via `.githooks/pre-push` after `node scripts/setup-git-hooks.js`).
    - **This check cannot pass from a cloud VM or sandbox.** It reaches Lunabox over SSH, so it exits 1 with `Could not read Lunabox repo` anywhere without that access. That is an environment limit, not a sync problem — do not try to "fix" it, and do not treat it as a blocker. It remains mandatory on the operator's laptop before any deploy.
  - **Before ANY staff-api image build (`az acr build`) for staging or prod:** run `node scripts/assert-deploy-from-master.js` (`npm run deploy:preflight`) and **tag the image with the master SHA**. It refuses to build unless the tree is clean **and** `HEAD == origin/master`. This prevents two machines/agents building images from divergent local tips and silently overwriting each other's merged work (which has happened — a parallel deploy reverted the owner-agent fix on staging).
  - **After merging Captain's work:** update the authorized development checkout from GitHub. Lunabox pull/start instructions are historical; do not update any runtime host without verifying the current target and obtaining separate host-change approval. A merge is not deployment permission.
  - **Confirm the side effect before reporting it done.** Never claim "pushed", "merged", "closed", "committed", or "done" without verifying the actual remote/side-effect state first — a command starting is not a command finishing. For a push: after `git push`, read the remote tip (`git ls-remote origin <branch>`) and confirm it equals the local `HEAD` before saying "pushed". For a merge/close: read back the PR/issue state. This is not optional politeness — reporting "shipped" when nothing shipped is worse than being slow, and it has happened here (a "pushed" claim on a commit that was only in the working tree; an `edit` reported applied that had failed). See skill `confirm-side-effect-before-reporting-done`.
- Node.js tooling; run scripts with `node scripts/...` (PowerShell may block `npm` scripts that shell out to npm.ps1).
- Minimize parallel layers — one owner file per Luna rule (see behavior spec).
- Staging Staff API: `https://staff-staging.lunafrontdesk.com`
- Local Hermes uses `hermes-local/.env` for `OPENAI_API_KEY` (gitignored).

When asked “what should we do next”, prefer: read relevant spec + owner file, propose a small scoped change, and mention which verify script proves it.

## Before you merge: check how stale the branch is, not just the PR diff

GitHub shows a PR's diff against the commit it **branched from**, so a months-old branch can
present as a tidy one-line fix while being thousands of commits behind. Before merging, always run
both diffs and read the second one:

```bash
git fetch origin
git diff --stat origin/master...<branch> # three dots: what the PR page shows
git diff --stat origin/master..<branch> # two dots: how far behind the branch is
git merge-tree --write-tree origin/master <branch> # does it conflict, and where
```

The two-dot diff is not what merging does — git's three-way merge leaves files the branch never
touched alone. It tells you something more useful: **every deletion in it is newer work the branch
does not have.** Where that overlaps a file the branch *did* edit, you get a conflict, and that is
the moment the damage happens.

PR #416 is the worked example. The page reads **+4 −1** in a single verify script. Two-dot says the
branch is ~73,000 deletions behind master, and `merge-tree` says the one file it edits conflicts.
Resolving that conflict the way a "+4 −1" PR invites you to — take the branch's version, it is only
four lines — deletes the migration-071 intent-disjoint assertions and the Phase A/Phase B rejection
test that landed in that file afterwards. The fix itself was real and worth having; taking it the
easy way would have quietly reverted someone else's gate.

So: a conflict on a stale branch is not a formality to clear. **Resolve toward master and re-apply
the author's change on top**, or ask the author to rebase and re-run their gates. Never resolve a
conflict by taking a stale branch wholesale, however small its stated diff. Small diffs against a
stale base are the dangerous ones, because nobody reads them carefully.

## Worktrees: never point a recursive delete at one

`node_modules` is commonly shared into a worktree as a **directory junction** (`mklink /J`) to avoid
reinstalling it per branch. On Windows, `Remove-Item -Recurse -Force` **follows junctions and
deletes the target's contents** — so deleting a worktree this way empties the main repo's
`node_modules`, and every other worktree breaks at once with `Cannot find module`.

Remove a worktree with git, which knows about the links:

```bash
git worktree remove <path> --force
```

If you must delete by hand, unlink the junction first — this removes the link, not the target:

```powershell
cmd /c rmdir "<path>\node_modules"
```

Recovery is `npm ci` in the main repo, but only after every stray junction is gone, or the reinstall
races the very links that caused the problem.

## Asking questions (cloud agents especially)

Someone monitors the agent conversation and answers questions there, so a blocked agent gets
unblocked only if it actually asks. End every turn in one of two states: the work is done and a
PR is open, or you have asked a specific question and are waiting. Stopping quietly with the work
unfinished is a question you failed to ask.

- **Ask early.** If a decision changes the shape of the code, ask before writing it.
- **Ask so it can be answered in one word:** state the decision, list the options with the
  tradeoff of each, and give your recommendation. Quote the relevant code or payload inline so
  the answer does not require opening the repo.
- Do not poll or idle waiting for a reply — end the turn; you will be resumed with the answer.
