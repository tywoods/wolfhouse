# FACTORY Slice 1C findings

**Progress class:** `deterministic_disabled_dry_run_generator`
**Master basis:** `ce89a43ee1e2367a832255fec5ee4aefbfb4d2d8`
**Branch:** `factory/slice-1c-dry-run-generator`
**Delivery:** pure dry-run generator library + CLI `scripts/onboard-client.js` + independent verifier — **not** apply, registry edits, `config/clients` writes, runtime loading, IaC, DB, deploy, secret materialization, live network, or disk publication.

## Verdict

Slice **1C** adds a deterministic disabled-by-default dry-run onboarding generator over the reviewed 1B templates for exactly:

| Archetype | Preview outputs |
|-----------|-----------------|
| `surf_house` | baseline, pricing, secrets.example, registry-entry, dry-run-manifest |
| `surf_school_shop` | baseline, secrets.example, registry-entry, dry-run-manifest |

Default and only mode is `dry-run`. `--apply` and any non-dry-run mode are rejected. Preview bytes are canonical key-sorted JSON with SHA-256 hashes.

**Emission is stdout / in-memory only.** The CLI defaults to stdout (optional `--stdout`), emits one canonical JSON envelope containing the exact preview files + manifest, and performs **zero writes**. `--output-dir` and all materialization/write flags are rejected.

**Safe disk materialization is unsupported in 1C** — not deferred proof and not claimed complete. There is no `writeDryRunPreview`, no mv publish subprocess, no directory-fd publish anchoring, and no other filesystem materialization path. FACTORY generation gates (`G_DISABLED_BY_DEFAULT_GENERATION`, `G_SECRET_REJECTION`, `G_NO_LIVE_TARGET_COPYING`) are satisfied by zero-write preview + independent golden byte comparison.

## Independent output truth

Golden rendered-byte fixtures under `fixtures/factory-client-productization/slice1c-golden/{archetype}/` plus locked hashes/output set in `slice1c-golden-lock.json`. The verifier compares generator bytes to these fixtures without importing generator expectation helpers (`expectedOutputPathSet` / `previewRelativePaths`).

## Output safety

- Stdout zero-write: library `generateDryRunPreview` + `emitStdout` and CLI emission create no files
- Static REDs: no `fs` write APIs, no `child_process`, no directory-fd publish hooks, no mv publish binary path, no `writeDryRunPreview` / output-dir materialization API
- Runtime REDs: fs write traps during generate+emit remain empty; CLI `--output-dir` / `--apply` / materialization flags reject without creating targets
- Still no apply path, network, DB, cloud, or runtime loading

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

Independent verifier proves golden-byte truth, byte-determinism, template immutability, stdout zero-write, unsupported disk materialization (static + runtime REDs), and adversarial REDs for secrets, live hosts, Meta/Azure IDs, existing conflicts, apply, and enablement flips.

## Ledger

1A gate ledger evidence for `G_DISABLED_BY_DEFAULT_GENERATION`, `G_SECRET_REJECTION`, and `G_NO_LIVE_TARGET_COPYING` is `1C_deterministic_disabled_dry_run_generator` **only when** the independent 1C validator passes (`completion_requires: verify:factory-slice1c-dry-run-generator`). Stage **1C** is marked `complete` under that gate via zero-write preview evidence. Apply / isolation wiring remains **1D**; dry-run packaging closeout remains **1E**. Safe disk materialization remains **unsupported** (out of scope), not a deferred 1C proof.
