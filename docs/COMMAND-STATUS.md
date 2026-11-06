# Command status index

This is an index, not an operating runbook. Use [`../AGENTS.md`](../AGENTS.md) for
the current repository map and [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md)
for current architecture ownership. A command name, documentation occurrence, or
zero exit code is not by itself proof that a supported check ran.

## Inventory at the S1a base

Base: `cec81ed407edfa0bf94912fe508c7fd42a1647ac`.

The literal `package.json` inventory contained:

- 1,253 script aliases;
- 1,281 tracked-path occurrences in those aliases;
- 387 occurrences pointing to absent paths;
- 380 unique absent targets.

Counts distinguish command occurrences from unique absent targets. They do not
claim 380 independently supported commands were lost. Most absent targets are
historical phase commands whose consumers and replacements have not been proven.
They remain unresolved rather than being mass-deleted. S5 must classify them
before treating any umbrella command as release proof.

## Confirmed dispositions

| Command | Status | Consumer / evidence | Disposition |
|---|---|---|---|
| `seed:generate` | Historical, target absent | Early local CSV/seed phase documentation | Alias removed. Do not recreate `scripts/generate-seed.js`; use a current, named data procedure only when one is documented and approved. |
| `db:sync` | Historical, target absent | Archived Phase 1–3 notes refer to CSV-to-Postgres rebuilds | Alias removed. Old notes remain historical recovery context, not current DB authority. No replacement is asserted. |
| `hermes:local` | Obsolete, target absent | `docs/HERMES-LOCAL.md` named the missing `scripts/run-local-hermes.js` helper | Alias removed. Hermes Desktop is the supported local repo-assistant path documented there. |
| `hermes:local:setup` | Obsolete, target absent | Same retired helper | Alias removed; no replacement CLI command is invented. |
| `hermes:local:ask` | Obsolete, target absent | Same retired helper | Alias removed; use a Hermes Desktop chat scoped to this repository. |
| `deploy:hermes-staging` | Current | `scripts/deploy-staging-hermes.js` exists | Retained. Follow the current runbook and approval gates. |
| `bootstrap:hermes-staging` | Current | `scripts/bootstrap-staging-hermes-runtime.js` exists | Retained. This index does not authorize execution. |
| `hermes:desktop:setup` | Current | `scripts/setup-hermes-desktop.js` exists | Retained; see `docs/HERMES-LOCAL.md`. |
| `verify:staff-prod-test-env-parity` | Present but NOT PROOF of parity | Script intentionally exits zero when required names are missing | Retained and labeled here. Its output must be read; a zero exit alone is not a pass. |

## Status meanings

- **Current:** target exists and the current map/runbook names its role. Execution
  can still require environment, secrets, or operational approval.
- **Historical:** retained documentation describes an old workflow. It does not
  authorize recreating missing scripts or infrastructure.
- **Externally/generated-dependent:** the command needs an artifact or approved
  executor not guaranteed by this repository. Missing execution is `BLOCKED` or
  `NOT RUN`, never `PASS`.
- **Unresolved:** target, consumer, or replacement has not been established.
  Keep it visible and do not delete it merely because its name looks old.
- **NOT PROOF:** a command can exist and exit zero while performing no assertions
  or while reporting a gap. Release evidence must record actual cases/assertions,
  failures, skips, environment, source SHA, and image identity where relevant.

## Operator rule

Before using an old command from architecture, phase, or recovery documentation:

1. Confirm its literal target exists in the checked-out revision.
2. Confirm the current map or runbook still names it.
3. Record what actually executed; do not infer coverage from its name.
4. If the target or approved executor is absent, report `BLOCKED`, `NOT RUN`, or
   `UNRESOLVED`. Do not revive retired infrastructure to make the command green.
