# GitHub container builds

This repository publishes **candidate artifacts only** from GitHub-hosted runners. Publication is not deployment acceptance and never changes OVH, lunabox, Azure Container Apps, Caddy, callers, bots, or live mounts.

## Current staging lane and release boundary

Read-only inventory on 2026-11-05 identified existing OVH France staging as
`hermes-luna` (classic Luna) and `ovh-wolfhouse-staff` (Staff API). Luna's resident
Compose path was `/srv/luna/wolfhouse/config/compose.yml`. Re-read the live service,
Compose labels, images and mounts for each separately approved release; do not infer
the target from an image tag, a tracked reference Compose file or a running candidate.
`hermes-luna-clone` / Luna v3 is a separate candidate, not implicit cutover approval.
Azure/ACA and Lunabox runbooks are historical/recovery references, not defaults.

The default path is **reviewed GitHub source → candidate artifact → separate host
approval → backup existing staging → replace only the approved service → verify
exact candidate → retain or use rollback**. Do not create another test deployment
or stop/delete existing candidates as part of source consolidation. Do not run the
legacy `deploy:hermes-staging` ACA alias or the dual-Luna VM deploy command as a
shortcut for a single-service OVH release. No deploy scripts are changed here.

### Evidence classes (not interchangeable)

| Evidence | What it proves | What it does not prove |
|---|---|---|
| Source/static and offline module checks | Source contracts and exercised fixture behavior | Current running image, model conversation or durable business write |
| Pinned-image checks | Candidate imports, patch composition, lifecycle/idempotency and exercised units | Approved routing or full guest journey |
| Existing-staging acceptance | Only the authorized scenarios actually run against the recorded candidate | Unsampled languages, all guest inputs or production acceptance |
| Receipt validator | Supplied evidence satisfies the validator | That the validator executed or collected the underlying business operation |

`verify:luna-all` mixes source/offline checks; `luna:nightly` currently runs offline
hygiene/pause checks, not a full agent conversation suite. The deterministic
`verify-luna-golden.js` tests the legacy composer and baseline deterioration, not
the current Hermes model. The real-agent `luna-golden-conversations.js --gate`
has its own no-mutation contract and requires a separately approved target;
skipped/incomplete runs are not passes. Additional booking/payment acceptance
requires explicit test scope and an authorized operator, not a guest send by an
engineering agent. Preserve existing test assertions; do not delete incident
regressions merely because their names are old.

### Release receipt and rollback

Record source SHA, immutable image digest, allowed services, resident overlay hashes,
effective non-secret send/admission settings and pre/post health. Keep protected
state/config backups and the previous compatible Staff/Luna image pair. Deploy
additive Staff responses before consumers require them. An unchanged image tag
does not establish unchanged runtime bytes when host overlays are mounted.

Roll back code to the compatible pair without discarding conversations or successful
bookings. Database/state/credential restore is a separate approval and is never an
automatic response to a failed chat. Report whether rollback was actually exercised;
a prepared script alone is not a completed drill. Production, host restarts, real
guest sends and business mutations retain their separate approval boundaries.

## Image build checks and replacement targets

| Stable check name | Approved replacement package | Dockerfile | Context |
|---|---|---|---|
| `wh-staff-api` | `ghcr.io/tywoods/wh-staff-api-private` | `Dockerfile` | repository root |
| `sunset-staff-api` | `ghcr.io/tywoods/sunset-staff-api-private` | `Dockerfile.luna-sunset-staff-api` | repository root |
| `crowsnest` | `ghcr.io/tywoods/crowsnest-private` | `Dockerfile.crowsnest` | repository root |
| `wh-hermes-staging` | `ghcr.io/tywoods/wh-hermes-staging-private` | `docker/hermes-staging/Dockerfile` | `docker/hermes-staging` |

The four stable check names do not select registry destinations. The workflow pins the accepted four-name `*-private` replacement map above. The repository owner must approve exactly those four package names in `owner_approved_new_packages_json`; missing, alternate, duplicate, or extra names fail before publication.

## Trust boundaries

- Pull requests run secretless validation plus `push: false` builds of all four images with `contents: read`; every PR triggers the workflow and no PR can publish.
- Publication requires a manual dispatch of `.github/workflows/container-images.yml` from `master` and the `container-publish` GitHub environment.
- The publisher runs `scripts/assert-deploy-from-master.js` unchanged, then scrubs checkout credentials before context upload.
- Before any push, the publisher proves the actual replacement package target is private. A missing package is not treated as safe: first creation requires a manual dispatch by the repository owner and exact membership in the validated four-name approval set. Immediately after the first push, the job must prove that same target is private and complete the anonymous bearer challenge flow against its exact pushed digest. A bound GHCR token-endpoint `401`/`403` or final exact-manifest `401`/`403` proves anonymous refusal. Anonymous `200`, missing manifest, unreadable visibility, redirects, malformed data, foreign issuer metadata, or network ambiguity fails closed and cancels later serialized matrix items.
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
2. Dispatch **Container images** on `master` as the repository owner. Set `owner_approved_new_packages_json` to exactly `["wh-staff-api-private","sunset-staff-api-private","crowsnest-private","wh-hermes-staging-private"]`. The workflow binds package metadata checks, image tags, post-push checks, anonymous verification, attestations, and receipts to that fixed accepted replacement map while the five existing required check names remain stable.
3. Confirm the run head equals current remote `master`.
4. Record all four `image@sha256:…` identities and the workflow run URL.
5. Query package visibility and require private ACLs. The workflow repeats this readback immediately after each push.
6. Run `python3 scripts/verify-ghcr-anonymous-denial.py IMAGE DIGEST`. The production client accepts only `ghcr.io`, exact realm `https://ghcr.io/token`, service `ghcr.io`, and exact repository pull scope. It never follows redirects. After a valid challenge, a token-endpoint or final exact-digest `401`/`403` proves refusal only when its `application/json` Registry v2 error body is non-empty, well formed, and contains exclusively recognized `DENIED` or `UNAUTHORIZED` codes. HTML policy blocks, empty or malformed JSON, unrelated error codes, missing manifests, foreign issuers, redirects, network errors, and any anonymous manifest `200` fail closed. The receipt identifies whether denial occurred at token issuance or final manifest authorization and records the recognized codes.
7. After separate token-use authorization, run `python3 scripts/pull-ghcr-digest-helper-free.py --username tywoods IMAGE DIGEST` once per image from an interactive TTY. If no-echo input is unavailable or `getpass` would fall back, the client refuses to continue. It binds the challenge to the exact GHCR realm/service/scope; token and manifest redirects are refused. Registry blob redirects are followed only through a bounded HTTPS-only path, with registry Authorization stripped before the redirected request. The client validates response `Content-Type`, cross-checks any JSON `mediaType`, validates OCI structure/descriptors, recursively fetches every index child, config and layer, and verifies every digest and declared size. Verified size and manifest media type remain cached; every repeated descriptor must agree before network deduplication. Unsupported, conflicting or malformed objects fail; manifest-only access is never reported as a finished pull. Process-owned temporary bytes are removed on success, failure, SIGINT, SIGTERM, SIGHUP and SIGQUIT.
8. Verify image labels, expected entrypoints and tenant modes. For Hermes, prove the approved runtime/SOUL/plugin overlay is preserved before any later runtime replacement.

Neither validation client executes the Docker CLI, reads `DOCKER_CONFIG`, uses `HOME` credential state, imports process-execution facilities, or invokes credential helpers. Do not replace them with an empty temporary Docker config: helper auto-discovery makes that construction unsafe. The authenticated pull is validation only; persistent login remains a separate approval and must not reuse temporary credentials.

Do not use a GitHub job token as a permanent host credential. Do not promote `latest`, deploy automatically, delete failed packages, or replace serving containers from this workflow.

## Resident-runtime preservation gate

Stage 2 OVH containers include reviewed mounted/runtime overlays. A successful source build does **not** prove those bytes are present in a replacement image. Before deployment is considered in a separately sealed stage:

- compare the resident overlay manifest and hashes with the candidate image inventory;
- reconcile any approved resident-only behavior through a bounded reviewed source patch;
- rerun in-image idempotency, continuity, auth, tenant-rejection and no-effect gates;
- retain approved historical Azure/lunabox artifacts without reactivating those targets; keep the actual previous compatible OVH image pair and resident overlays as the current staging rollback boundary.
