# Crowsnest — standalone app maintenance runbook

**Status: LIVE BASELINE.** The standalone app and custom domain are currently deployed. This runbook records the verified boundary and safe release sequence; it is not blanket approval to deploy or change infrastructure.

Product: [`CROWSNEST.md`](CROWSNEST.md) · Location: [`CROWSNEST-LOCATION-PLAN.md`](CROWSNEST-LOCATION-PLAN.md)

Crowsnest is the private Ship operator portal for **Monshies** and **Earthling**. It must remain separate from tenant staff portals and guest systems.

## VERIFIED CURRENT LIVE BASELINE

Standalone Crowsnest is deployed. The uncommitted login-portal work in this branch is **not** live until an approved release.

| Topic | Current live value |
|---|---|
| Code entry | `scripts/crowsnest-api.js` |
| Modules | `scripts/lib/crowsnest/` |
| Container definition | `Dockerfile.crowsnest` |
| Azure resource group | `wh-staging-rg` |
| Azure Container App | `crowsnest-internal` |
| Container Apps FQDN | `crowsnest-internal.braveplant-5c685569.northeurope.azurecontainerapps.io` |
| Image repository | `whstagingacr.azurecr.io/crowsnest` |
| Target port | `3040` |
| Public hostname | `crowsnest.lunafrontdesk.com` |
| Authentication | HTTP Basic Auth required on UI routes |
| Health route | Public `GET /healthz` |
| Health stage | `stage: skeleton` |
| Data writes | Disabled (`writes_enabled: false`) |

Verified on 2026-07-21:

- Azure provisioning state was `Succeeded`.
- The public hostname returned a Basic Auth challenge for `/`.
- `/healthz` returned `service: crowsnest`, `stage: skeleton`, `auth_enabled: true`, and `writes_enabled: false`.
- The ACR repository `crowsnest` was readable.

## EXPECTED AFTER THIS LOGIN-PORTAL RELEASE

These are **post-release** expectations for the approved login-portal image only. They are not evidence that the portal is already live.

| Topic | Expected after release |
|---|---|
| Browser UI auth | Unauthenticated `/` (and other protected UI routes) redirect to `/login` instead of a browser Basic challenge |
| Login portal | Branded session portal (`GET /login`, `POST /login` cookie, `POST /logout`) |
| Legacy Basic Auth | Still accepted on protected UI routes for compatibility |
| Health stage | `stage: portal` |
| Writes | Remain `writes_enabled: false` unless a later write slice is explicitly approved |

## Isolation contract

Crowsnest uses a **separate Container App**, image, entry point, and authentication configuration.

The following must remain true:

- `staff-staging.lunafrontdesk.com` remains on `wh-staging-staff-api` and is untouched by normal Crowsnest work.
- Crowsnest does not import or mount `scripts/staff-query-api.js`.
- Crowsnest feature work does not change Wolfhouse guest flows, Staff API behavior, Sunset, bookings, Stripe, WhatsApp, or tenant databases.
- Crowsnest remains read-only until a separately approved write slice defines authorization, audit, rollback, and tests.
- Skipper's shared-platform redesign remains separate from Crowsnest ownership.

## Runtime configuration

| Variable | Requirement |
|---|---|
| `CROWSNEST_PORT` | `3040` |
| `CROWSNEST_HOST` | `0.0.0.0` |
| `NODE_ENV` | `production` in Azure |
| `CROWSNEST_AUTH_REQUIRED` | `true` on the public app |
| `CROWSNEST_AUTH_USERNAME` | Azure secret; never commit |
| `CROWSNEST_AUTH_PASSWORD` | Azure secret; never commit |
| `CROWSNEST_ALLOWED_USERS` | `Monshies,Earthling` while access is limited to the initial operators |

Do not add database, Stripe, WhatsApp, or Staff API credentials merely to support the current read-only shell.

## Local verification

```bash
npm run verify:crowsnest
npm run verify:crowsnest-auth
node --check scripts/crowsnest-api.js

docker build -f Dockerfile.crowsnest -t crowsnest:local .
docker run --rm -p 3040:3040 crowsnest:local
curl -fsS http://127.0.0.1:3040/healthz
```

Expected health invariants:

```json
{
  "status": "ok",
  "service": "crowsnest",
  "writes_enabled": false
}
```

## Release preflight

A Crowsnest deployment must be its own explicitly approved task.

1. Work from a clean branch created from current `origin/master`.
2. Confirm the diff contains only intended Crowsnest files.
3. Run `node scripts/assert-repo-sync.js` before pushing or deploying.
4. Run both Crowsnest verifiers and syntax checks.
5. Confirm `Dockerfile.crowsnest` still launches only `scripts/crowsnest-api.js`.
6. Tag the image with the exact approved Git SHA; never reuse a floating tag as release identity.
7. Smoke the new revision on the Container App FQDN before changing traffic or hostnames.
8. Verify the public hostname and `staff-staging.lunafrontdesk.com` after promotion.

The old migration from `wh-staging-staff-api` is complete: the Crowsnest domain is separated from the Staff API. Do not detach or migrate either hostname during routine feature releases.

## Azure release shape

The exact command must be reviewed against the current Azure CLI and Container App state at release time. The intended operations are:

1. Build `Dockerfile.crowsnest` in `whstagingacr` as `crowsnest:<approved-git-sha>`.
2. Update only `crowsnest-internal` to that immutable image tag.
3. Preserve port 3040, external HTTPS ingress, auth secrets, and the custom hostname.
4. Wait for the new revision to become healthy.
5. Verify the default FQDN, then the public hostname.

Do not build or deploy the root Staff API `Dockerfile` for a Crowsnest-only release.

## Post-release verification

```bash
curl -fsS https://crowsnest.lunafrontdesk.com/healthz
curl -sS -o /dev/null -w "%{http_code}\n" https://crowsnest.lunafrontdesk.com/
curl -fsS https://staff-staging.lunafrontdesk.com/healthz
```

Expected **after this login-portal release**:

- Crowsnest health is `200`, reports `service: crowsnest`, `stage: portal`, and keeps writes disabled unless a later write slice was explicitly approved.
- Unauthenticated Crowsnest UI redirects to `/login` instead of emitting a browser Basic challenge; legacy Basic Auth still works when supplied.
- Staff staging still reports the Wolfhouse Staff API service, not Crowsnest.

Until that release is approved and deployed, the live checks above still match **VERIFIED CURRENT LIVE BASELINE** (`stage: skeleton`, Basic Auth challenge on `/`).

## Rollback

If a new Crowsnest revision fails:

1. Route traffic back to the last known-good `crowsnest-internal` revision.
2. Verify the Container App FQDN and public hostname.
3. Confirm auth and `/healthz` invariants for the revision in use (live baseline: Basic Auth + `stage: skeleton`; login-portal release: `/login` redirect/portal + `stage: portal`).
4. Leave `wh-staging-staff-api`, Sunset, production, DNS, and tenant services unchanged.
5. Record the failed image SHA and failure evidence before attempting another release.

Do not roll back by reattaching `crowsnest.lunafrontdesk.com` to `wh-staging-staff-api`; that would break the separation boundary.

## Deferred infrastructure decisions

These are not blockers for AI Usage Panel product work:

- whether to move Crowsnest into a future `luna-internal-rg`;
- whether to use a dedicated Container Apps environment;
- whether to replace Basic Auth (and, after the login-portal release, the branded portal plus legacy Basic compatibility) with a stronger Ship identity system;
- external DNS-provider ownership and access.

Each requires a separate plan and approval. DNS control is not currently visible through Azure DNS in this subscription.

## Next implementation point

The next safe product slice is a **read-only AI Usage Panel shell** with focused offline tests. It should define its UI and data contract before connecting to any live usage source. Client onboarding and the old unpushed `surf_house` archetype remain deferred reference work until Skipper's shared redesign is stable.
