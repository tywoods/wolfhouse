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

Default and only mode is `dry-run`. `--apply` and any non-dry-run mode are rejected. Preview bytes are canonical key-sorted JSON with SHA-256 hashes. Writes are allowed only to an explicit safe `--output-dir` (never overwrite) or `--stdout`.

## Safety

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

Independent verifier proves byte-determinism, template immutability, exact output set, no side effects outside the explicit output directory, and adversarial REDs for secrets, live hosts, Meta/Azure IDs, existing conflicts, overwrite, apply, unsafe output roots, and enablement flips.

## Ledger

1A gate ledger evidence for `G_DISABLED_BY_DEFAULT_GENERATION`, `G_SECRET_REJECTION`, and `G_NO_LIVE_TARGET_COPYING` is `1C_deterministic_disabled_dry_run_generator` **only when** the independent 1C validator passes (`completion_requires: verify:factory-slice1c-dry-run-generator`). Stage **1C** is marked `complete` under that gate. Apply / isolation wiring remains **1D**; dry-run packaging closeout remains **1E**.
