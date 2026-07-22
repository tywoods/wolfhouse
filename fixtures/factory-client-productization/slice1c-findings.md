# FACTORY Slice 1C findings

**Progress class:** `deterministic_disabled_dry_run_generator`
**Master basis:** `ce89a43ee1e2367a832255fec5ee4aefbfb4d2d8`
**Branch:** `factory/slice-1c-dry-run-generator`
**Delivery:** pure dry-run generator library + CLI `scripts/onboard-client.js` + independent verifier — **not** apply, registry edits, `config/clients` writes, runtime loading, IaC, DB, deploy, secret materialization, or live network.

## Verdict

Slice **1C** adds a deterministic disabled-by-default dry-run onboarding generator over the reviewed 1B templates for exactly:

| Archetype | Preview outputs |
|-----------|-----------------|
| `surf_house` | baseline, pricing, secrets.example, registry-entry, dry-run-manifest |
| `surf_school_shop` | baseline, secrets.example, registry-entry, dry-run-manifest |

Default and only mode is `dry-run`. `--apply` and any non-dry-run mode are rejected. Preview bytes are canonical key-sorted JSON with SHA-256 hashes. Materialization uses a private sibling staging directory + atomic rename into a nonexistent final output directory (exclusive file creates); `--stdout` is zero-write.

## Independent output truth

Golden rendered-byte fixtures under `fixtures/factory-client-productization/slice1c-golden/{archetype}/` plus locked hashes/output set in `slice1c-golden-lock.json`. The verifier compares generator bytes to these fixtures without importing generator expectation helpers (`expectedOutputPathSet` / `previewRelativePaths`).

## Output safety

- Final output directory must not exist (lstat; symlinked final rejected)
- Existing parent/ancestor chain is lstat-checked non-symlink and realpath-validated outside forbidden roots (`config/clients`, `config/archetypes`, `database`, `infra`, `.git`, repo root)
- Private sibling `.factory-1c-staging-*` directory; exclusive file flags; atomic rename staging → final
- Fail closed if final appears before rename; clean staging on every error
- Never traverse caller-controlled descendants; reject relativePath traversal / nested symlink attacks
- Swap/race coverage in verifier REDs (final mkdir/symlink injection before rename)

## Safety (generation)

- Strict kebab `client_slug` / `location_id` validation
- Required identity + full template substitution coverage; unresolved placeholders fail closed
- Path traversal / output path collision rejection
- Existing tenant/location conflicts vs `config/clients/clients.json` (+ baseline filenames)
- Secret / live-target shaped values rejected on input and output (reuses 1B forbidden patterns)
- All enablement forced false (`live_enabled`, deployment, channels, payment auto-link, lesson scheduling); confirmation send mode stays in `{dry_run, staff_approval}`
- Templates under `config/archetypes/` remain immutable (generator reads only)

## Verification

```bash
npm run verify:factory-slice1c-dry-run-generator
```

Independent verifier proves golden-byte truth, byte-determinism, template immutability, atomic materialization safety, stdout zero-write, and adversarial REDs for secrets, live hosts, Meta/Azure IDs, existing conflicts, symlink/race/swap, apply, unsafe output roots, and enablement flips.

## Ledger

1A gate ledger evidence for `G_DISABLED_BY_DEFAULT_GENERATION`, `G_SECRET_REJECTION`, and `G_NO_LIVE_TARGET_COPYING` is `1C_deterministic_disabled_dry_run_generator` **only when** the independent 1C validator passes (`completion_requires: verify:factory-slice1c-dry-run-generator`). Stage **1C** is marked `complete` under that gate. Apply / isolation wiring remains **1D**; dry-run packaging closeout remains **1E**.
