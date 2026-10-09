# GitHub container builds

This repository publishes **candidate artifacts only** from GitHub-hosted runners. Publication is not deployment acceptance and never changes OVH, lunabox, Azure Container Apps, Caddy, callers, bots, or live mounts.

## Images

| Package | Dockerfile | Context |
|---|---|---|
| `ghcr.io/tywoods/wh-staff-api` | `Dockerfile` | repository root |
| `ghcr.io/tywoods/sunset-staff-api` | `Dockerfile.luna-sunset-staff-api` | repository root |
| `ghcr.io/tywoods/crowsnest` | `Dockerfile.crowsnest` | repository root |
| `ghcr.io/tywoods/wh-hermes-staging` | `docker/hermes-staging/Dockerfile` | `docker/hermes-staging` |

## Trust boundaries

- Pull requests run secretless validation plus `push: false` builds of all four images with `contents: read`; every PR triggers the workflow and no PR can publish.
- Publication requires a manual dispatch of `.github/workflows/container-images.yml` from `master` and the `container-publish` GitHub environment.
- The publisher runs `scripts/assert-deploy-from-master.js` unchanged, then scrubs checkout credentials before context upload.
- Before any push, the publisher allows a missing/new package or proves an existing package is private; any other visibility/API result fails closed.
- Each package receives only the full current-master commit SHA tag. There is no `latest` tag or deployment step.
- Every third-party action is pinned to a full commit SHA.
- The publisher uses only the job-scoped `GITHUB_TOKEN` with `contents: read`, `packages: write`, `attestations: write`, and `id-token: write`.
- Builds are serialized (`max-parallel: 1`), bounded by finite timeouts, and use versioned GitHub-hosted `ubuntu-24.04` runners.
- Root and Hermes contexts have separate `.dockerignore` files. Both exclude repository metadata, package-manager/auth files, SSH/Docker credential directories, private-key formats, environment files, state databases, dumps, archives, and local runtime directories.
- BuildKit emits an SBOM and max-mode provenance. GitHub records an attestation against the registry digest.
- Per-image JSON digest receipts are retained for 30 days. Tags are mutable pointers; the registry digest is the artifact identity.

## Validation

Run from a clean checkout:

```bash
node scripts/verify-container-build-workflow.js
npm run check:soul-clean
node scripts/verify-hermes-send-flags.js
npm run verify:crowsnest
```

`npm run verify:luna-all` additionally requires the pinned Hermes runtime and its Python modules. Run it in that environment; a source-only GitHub runner must not convert missing `agent`/runtime modules into a false product regression.

## Publish

1. Merge a reviewed PR into current `master` after required gates are green.
2. Dispatch **Container images** on `master`.
3. Confirm the run head equals current remote `master`.
4. Record all four `image@sha256:…` identities and the workflow run URL.
5. Query package visibility and require private ACLs.
6. Using a separate read-only package identity, pull each candidate by digest into an isolated no-effect environment. Anonymous pulls must fail.
7. Verify image labels, expected entrypoints and tenant modes. For Hermes, prove the approved runtime/SOUL/plugin overlay is preserved before any later runtime replacement.

Do not use a GitHub job token as a permanent host credential. Do not promote `latest`, deploy automatically, delete failed packages, or replace serving containers from this workflow.

## Resident-runtime preservation gate

Stage 2 OVH containers include reviewed mounted/runtime overlays. A successful source build does **not** prove those bytes are present in a replacement image. Before deployment is considered in a separately sealed stage:

- compare the resident overlay manifest and hashes with the candidate image inventory;
- reconcile any approved resident-only behavior through a bounded reviewed source patch;
- rerun in-image idempotency, continuity, auth, tenant-rejection and no-effect gates;
- keep Azure/lunabox and existing image digests as rollback artifacts.
