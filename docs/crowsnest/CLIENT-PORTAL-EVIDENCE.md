# Clients portal evidence — Slice B

This is source wiring, not a deployment or a production-source admission.

## Renderer handoff (Slice A owns `crowsnest-page.js`)

The authenticated GET `/clients` passes:

- `options.portalEvidence[client.id][environment]`, where environment is `staging`
  or `production`, contains `{ availability, checked_at, source_kind, reason }`.
  Availability is `live` or `unknown`. `checked_at` is an ISO UTC observation
  timestamp, or `null` for a source that was not read. Reasons are bounded codes,
  never upstream diagnostics or response bodies.
- Compatibility with Slice A's URL-keyed seam: the **same**
  `portalEvidence[client.id][admittedOrigin]` contains the availability string.
  This alias is produced only from the admitted-source registry. Production
  does not get an alias; missing evidence must render Unknown.
- `options.directoryBuild` is a frozen `{ sha, built_at }` or `null`.
  `sha` is the full 40-character lowercase commit SHA; `built_at` is canonical
  ISO UTC. Both are required to consider the stamp available.

Renderer integration required before release (not implemented by B's allowlist):

- Use environment-keyed observations for **Last checked**, not **Last updated**.
- Show **Last updated: [UTC build timestamp] · Directory version [short SHA]**,
  qualified accessibly as **Crow's Nest directory build**. Null means unavailable;
  never substitute request time or another service's release time.
- Clients safety copy must acknowledge bounded public staging health reads:
  **Staff service reachable; not a check of login, bookings or integrations.**
  Do not retain the old claim that this route performs no health checks.
- Preserve staging connection evidence as a separate block. Portal liveness
  never upgrades Luna/WhatsApp/Email/Stripe integration states.

B is rebased on master after Slice A (#1131). No Slice A files are changed by B.
The B verifier proves acquisition, authorization and page-option handoff using
real local routing/rendering with mocked health transport. It does **not** claim
that the renderer displays directoryBuild, or prove authenticated deployed UI.

## Admitted sources and limits

Only `wolfhouse-somo` / staging / `https://staff-staging.lunafrontdesk.com`
and `sunset-somo` / staging / `https://sunset-staging.lunafrontdesk.com` are admitted.
Each must also match its directory client slug, Live lifecycle and portal URL.
The generic Staff health body is not proof of tenant identity.

**Wolfhouse production and Sunset production are disabled/Unknown.** There is
no environment-variable opt-in. Neither an old health observation nor URL
presence grants recurring production reads. A later source addition requires
Chief admission and a separately reviewed change. Planned/unrecognized clients
make no health requests.

Reads are unauthenticated HTTPS GET `/healthz`, redirects denied, TLS verification
unchanged, cookies omitted, no retries. Only HTTP 200 plus the exact canonical
Staff health schema is Live. All other outcomes are Unknown, not Offline.
Headers and streamed/decompressed bodies share a maximum three-second deadline;
body limit is 4 KiB. Two registered sources bound concurrency; simultaneous page
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
node scripts/verify-crowsnest.js
node scripts/verify-crowsnest-client-status-chips.js
node scripts/verify-crowsnest-auth.js
```

The auth gate explicitly installs the evidence verifier's fixture transport in
its local child server. No production test-mode switch is added to the API.
The evidence gate executes the Dockerfile's metadata-writing Node command in a
temporary directory; this is not a full Docker image build or deployment proof.
