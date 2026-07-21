# Crowsnest — standalone app maintenance runbook

**Status: LIVE BASELINE.** The standalone app, branded login portal, and custom domain are currently deployed. This runbook records the verified boundary and safe release sequence; it is not blanket approval to deploy or change infrastructure.

Product: [`CROWSNEST.md`](CROWSNEST.md) · Location: [`CROWSNEST-LOCATION-PLAN.md`](CROWSNEST-LOCATION-PLAN.md)

Crowsnest is the private Ship operator portal for **Monshies** and **Earthling**. It must remain separate from tenant staff portals and guest systems.

## VERIFIED CURRENT LIVE BASELINE

Standalone Crowsnest with the branded login portal is deployed and verified live.

| Topic | Current live value |
|---|---|
| Code entry | `scripts/crowsnest-api.js` |
| Modules | `scripts/lib/crowsnest/` |
| Container definition | `Dockerfile.crowsnest` |
| Azure resource group | `wh-staging-rg` |
| Azure Container App | `crowsnest-internal` |
| Live revision | `crowsnest-internal--0000007` (provisioning Succeeded; 100% traffic) |
| Container Apps FQDN | `crowsnest-internal.braveplant-5c685569.northeurope.azurecontainerapps.io` |
| Image repository | `whstagingacr.azurecr.io/crowsnest` |
| Live image | `whstagingacr.azurecr.io/crowsnest:d8b52b452aa0535d242ac5fcf31077f62068ce4e` |
| Target port | `3040` |
| Public hostname | `crowsnest.lunafrontdesk.com` |
| Authentication | Branded session portal; unauthenticated `/` redirects `302` to `/login` with no Basic challenge; legacy Basic Auth still accepted for compatibility |
| Auth secrets | Live still binds legacy single-account refs `cn-auth-user` / `cn-auth-pass`. **Planned multi-account mapping (not deployed yet):** `cn-auth-user`/`cn-auth-pass` → Earthling (`CROWSNEST_AUTH_EARTHLING_*`); new `cn-monshies-user`/`cn-monshies-pass` → Monshies (`CROWSNEST_AUTH_MONSHIES_*`). Values never in docs; live operator credential distribution is out of scope for this runbook. |
| Health route | Public `GET /healthz` |
| Health stage | `stage: portal` |
| Allowed users (health) | Monshies, Earthling |
| Data writes | Disabled (`writes_enabled: false`) |
| Staff API (unchanged) | `wh-staging-staff-api--0000520` / image `458ed255e8a06b7b0557718031e57f4d7064fa62` |

Verified on 2026-07-21:

- Azure provisioning state was `Succeeded`; revision `crowsnest-internal--0000007` carried 100% traffic.
- The public hostname redirected unauthenticated `/` to `/login` (`302`) with no Basic challenge; `/login` rendered the branded portal.
- Legacy Basic Auth compatibility remained available when supplied.
- `/healthz` returned `service: crowsnest`, `stage: portal`, `auth_enabled: true`, `writes_enabled: false`, and allowed users Monshies/Earthling.
- Auth username/password were bound via Azure secret refs `cn-auth-user` and `cn-auth-pass`.
- Production login/session/logout and Secure cookie flow passed; CSP page rendered with no browser errors.
- Staff staging remained on `wh-staging-staff-api--0000520` / image `458ed255e8a06b7b0557718031e57f4d7064fa62` (unchanged by this release).

### History (pre-login-portal shell)

Earlier on 2026-07-21, before the login-portal image was promoted, the public hostname returned a Basic Auth challenge for `/` and `/healthz` reported `stage: skeleton`. That shell is **historical only** and is no longer the live baseline.

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
| `CROWSNEST_AUTH_EARTHLING_USERNAME` | Azure secret ref `cn-auth-user` (planned multi-account cutover; **not deployed yet**); never commit the value |
| `CROWSNEST_AUTH_EARTHLING_PASSWORD` | Azure secret ref `cn-auth-pass` (planned multi-account cutover; **not deployed yet**); never commit the value |
| `CROWSNEST_AUTH_MONSHIES_USERNAME` | Azure secret ref `cn-monshies-user` (**new; not deployed yet**); never commit the value |
| `CROWSNEST_AUTH_MONSHIES_PASSWORD` | Azure secret ref `cn-monshies-pass` (**new; not deployed yet**); never commit the value |
| `CROWSNEST_AUTH_USERNAME` | Legacy single-account fallback only when none of the four multi-account vars are present; live today still uses `cn-auth-user` |
| `CROWSNEST_AUTH_PASSWORD` | Legacy single-account fallback only; live today still uses `cn-auth-pass` |
| `CROWSNEST_ALLOWED_USERS` | `Monshies,Earthling` while access is limited to the initial operators |

Multi-account mode requires both complete Earthling and Monshies pairs. Missing/blank/duplicate usernames or blank passwords misconfigure auth (`503` when required). Never combine legacy fallback credentials with multi-account credentials. Do not put defaults in production.

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
  "stage": "portal",
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
3. Preserve port 3040, external HTTPS ingress, auth secrets (`cn-auth-user` / `cn-auth-pass` today; add `cn-monshies-user` / `cn-monshies-pass` only when multi-account cutover is approved — **not deployed yet**), and the custom hostname.
4. Wait for the new revision to become healthy.
5. Verify the default FQDN, then the public hostname.

Do not build or deploy the root Staff API `Dockerfile` for a Crowsnest-only release.

## Post-release verification

```bash
curl -fsS https://crowsnest.lunafrontdesk.com/healthz
curl -sS -o /dev/null -w "%{http_code}\n" https://crowsnest.lunafrontdesk.com/
curl -fsS https://staff-staging.lunafrontdesk.com/healthz
```

Expected against **VERIFIED CURRENT LIVE BASELINE**:

- Crowsnest health is `200`, reports `service: crowsnest`, `stage: portal`, and keeps writes disabled unless a later write slice was explicitly approved.
- Unauthenticated Crowsnest UI redirects to `/login` instead of emitting a browser Basic challenge; legacy Basic Auth still works when supplied.
- Staff staging still reports the Wolfhouse Staff API service, not Crowsnest.

## Rollback

If a new Crowsnest revision fails:

1. Route traffic back to the last known-good `crowsnest-internal` revision.
2. Verify the Container App FQDN and public hostname.
3. Confirm auth and `/healthz` invariants for the revision in use (live baseline: `/login` redirect/portal + `stage: portal` + legacy Basic compatibility; historical pre-portal shell used Basic Auth challenge + `stage: skeleton`).
4. Leave `wh-staging-staff-api`, Sunset, production, DNS, and tenant services unchanged.
5. Record the failed image SHA and failure evidence before attempting another release.

Do not roll back by reattaching `crowsnest.lunafrontdesk.com` to `wh-staging-staff-api`; that would break the separation boundary.

## Deferred infrastructure decisions

These are not blockers for AI Usage Panel product work:

- whether to move Crowsnest into a future `luna-internal-rg`;
- whether to use a dedicated Container Apps environment;
- whether to replace the branded portal plus legacy Basic compatibility with a stronger Ship identity system;
- external DNS-provider ownership and access.

Each requires a separate plan and approval. DNS control is not currently visible through Azure DNS in this subscription.

## Next implementation point

The next safe product slice is a **read-only AI Usage Panel shell** with focused offline tests. It should define its UI and data contract before connecting to any live usage source. Client onboarding and the old unpushed `surf_house` archetype remain deferred reference work until Skipper's shared redesign is stable.
