# Clients portal evidence — Slice B

This is source wiring, not a deployment. CROWSNEST-CLIENTS-CARDS-005-PROD-HEALTH
explicitly admits both listed Staff production origins under the staging fences.

## Renderer handoff (Slice A owns `crowsnest-page.js`)

The authenticated GET `/clients` passes:

- `options.portalEvidence[client.id][environment]`, where environment is `staging`
  or `production`, contains `{ availability, checked_at, source_kind, reason, … }`.
  Availability is `live` or `unknown`. `checked_at` is an ISO UTC **healthz**
  observation timestamp (probe time), or `null` for a source that was not read.
  Reasons are bounded codes, never upstream diagnostics or response bodies.
- Deploy-age fields (merged from **stored deploy stamps**; never from healthz):
  - `deploy_updated_at` — stamp ISO time (deploy moment written by Skipper)
  - `deploy_revision` / `deploy_revision_short` — full and short revision / git id
  - `deploy_image_tag` — optional short image tag when present
  - `deploy_source_kind` — `deploy_stamp` or `none`
  - `deploy_reason` — bounded code (`stamp_ok`, `stamp_absent`, …)
- Compatibility with Slice A's URL-keyed seam: the **same**
  `portalEvidence[client.id][admittedOrigin]` contains the availability string.
  This alias is produced only from the admitted-source registry, including the
  two approved production origins. Missing or failed evidence renders Unknown.
- `options.directoryBuild` is a frozen `{ sha, built_at }` or `null`.
  `sha` is the full 40-character lowercase commit SHA; `built_at` is canonical
  ISO UTC. Both are required to consider the stamp available.

Renderer rules:

- Staff portal title row shows **Updated …** from `deploy_updated_at` (plus short
  revision / image tag when present). This is **last deploy / revision create**,
  not healthz probe time.
- **Do not** render healthz `checked_at` as “Checked …” next to Staff portal titles.
- Null deploy fields omit the Updated meta (fail soft when no stamp yet);
  never invent timestamps or substitute Crow’s Nest `directoryBuild` for a Staff
  portal’s deploy age.
- Clients safety copy may acknowledge bounded public Staff health reads for the
  Live/Unknown pill only.
- Preserve staging connection evidence as a separate block. Portal liveness
  never upgrades Luna/WhatsApp/Email/Stripe integration states.

## Staff portal deploy-age source

Crow’s Nest reads **stored deploy stamps** written after each successful Staff
deploy via `PUT|POST /api/portal-deploy-stamp` (Bearer
`CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN`). See
[`PORTAL-DEPLOY-STAMP.md`](PORTAL-DEPLOY-STAMP.md) for Skipper curl + env.

No Azure Container Apps Reader, ARM revision GETs, or
`CROWSNEST_PORTAL_DEPLOY_AZURE_SUBSCRIPTION_ID` are used. Missing stamps fail
soft (no Updated line).

B is rebased on master after Slice A (#1131). No Slice A files are changed by B.
The B verifier proves stamp write/read, merge into portalEvidence, and Clients
Updated render. It does **not** claim authenticated deployed UI.

## Admitted sources and limits

Only these exact client/environment/origin bindings are admitted:

| Client | Environment | Origin |
| --- | --- | --- |
| `wolfhouse-somo` | staging | `https://staff-staging.lunafrontdesk.com` |
| `sunset-somo` | staging | `https://sunset-staging.lunafrontdesk.com` |
| `wolfhouse-somo` | production | `https://wolfhouse.lunafrontdesk.com` |
| `sunset-somo` | production | `https://sunset.lunafrontdesk.com` |

Each must also match its directory client slug, Live lifecycle and portal URL.
The generic Staff health body is not proof of tenant identity.

Chief has admitted these two production readers; they use exactly the same
transport and cache policy as staging. Live requires a successful canonical
probe, never URL presence or another environment's status. A 404/unavailable
response is Unknown (not Live and not a new Down state). A later source addition
still requires Chief admission and a separately reviewed change. Planned or
unrecognized clients and absent/mismatched sources make no health requests.
This is not authorization to repair or deploy either Staff service.

Reads are unauthenticated HTTPS GET `/healthz`, redirects denied, TLS verification
unchanged, cookies omitted, no retries. Only HTTP 200 plus the exact canonical
Staff health schema is Live. All other outcomes are Unknown, not Offline.
Headers and streamed/decompressed bodies share a maximum three-second deadline;
body limit is 4 KiB. Four registered sources bound concurrency; simultaneous page
loads coalesce. Cache keys contain client + environment + exact origin, expire
at 60 seconds from request start, and invalidate on clock rollback. Failed
refreshes replace expired positives. No scheduler/background refresh exists.

## Immutable directory metadata

The approved release owner supplies Docker build args `CROWSNEST_BUILD_SHA` and
`CROWSNEST_BUILT_AT` for the exact directory image. The Dockerfile persists them
as `/app/crowsnest-build.json` (0444), not runtime environment variables. Server
startup reads and validates that file once. Missing, malformed, impossible or
future timestamps and invalid SHAs produce null, with no fallback.

Reloads/restarts of the same artifact keep its stamp; a newer artifact changes
it; rollback restores the older stamp. Runtime env overrides, request fields,
Staff/Luna-only releases and filesystem mtime are not metadata sources.

## Offline gates

```sh
node scripts/verify-crowsnest-client-portal-evidence.js
node scripts/verify-crowsnest-client-portal-deploy.js
node scripts/verify-crowsnest.js
node scripts/verify-crowsnest-client-status-chips.js
node scripts/verify-crowsnest-auth.js
```

The auth gate explicitly installs the evidence verifier's fixture transport in
its local child server. No production test-mode switch is added to the API.
Offline fixtures prove both production rows can render Live, Wolfhouse's
404 Azure Unavailable fixture cannot render Live, failed refreshes remove Live,
and recovery requires a successful new probe. Tests are not live observations.
The evidence gate executes the Dockerfile's metadata-writing Node command in a
temporary directory; this is not a full Docker image build or deployment proof.
