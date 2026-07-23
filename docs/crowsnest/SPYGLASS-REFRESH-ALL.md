# Spyglass Refresh all

Authenticated Spyglass action that **requests** a fresh client-metrics report from
each **server-configured**, tenant-owned manual reporter job. Coverage is always
honest and per-client: `started`, `not_configured`, or `unavailable`. Crowsnest
never claims every client refreshed, and never claims metrics are already
refreshed.

**Semantic honesty**

- `started` — Azure accepted a Container Apps **job-start** request for that
  client's configured manual job. It does **not** mean metrics snapshots are
  already updated in Spyglass.
- `not_configured` — only for clients with no server-owned configured reporter
  target (today: Wolfhouse and Sunset Sardinero in the runtime default).
- `unavailable` — configured target could not be started (missing runtime
  config, missing managed-identity endpoint, ARM/RBAC/network failure, or
  transport error). Never leaks raw errors, tokens, or resource identifiers.

## Goal

- Fixed client allowlist: `wolfhouse-somo`, `sunset-somo`, `sunset-sardinero`.
- Server-owned configured targets only (browser cannot submit client IDs, job
  names, subscription IDs, or Azure resource names).
- Sunset Somo staging may be configured to manual job
  `sunset-somo-stg-cn-metrics` in resource group `luna-sunset-staging-rg`.
  Wolfhouse has a manual job in Azure but is **not** auto-assumed configured
  until explicit runtime config. Sunset Sardinero is not configured.
- Slice A: injected job-start transport for tests; fail-closed unavailable stub
  when Azure is not wired.
- Slice B: server-side managed-identity Azure Job-start adapter + runtime
  config resolver (still fail-closed until Earthling binds identity/RBAC/env).
- Authenticated `POST /spyglass/refresh-all` + Spyglass form/button with safe
  status/coverage copy.

## Non-goals

- No `@azure/*` SDK dependencies and no `az` CLI from the app.
- No long-lived Azure secrets for job start (managed identity only).
- No automatic Wolfhouse or Sardinero reporter setup in the runtime default.
- No AI usage UI / runtime / API work in this feature.
- Crowsnest never queries tenant databases and never holds reporter DSNs/tokens.
- Refresh all does **not** change the existing **15-minute scheduled** reporter
  job. Manual on-demand start stays separate from the schedule.

## Operator UX

1. Sign in to Crowsnest.
2. On Spyglass, use **Refresh all**.
3. Crowsnest requests reports only from configured allowlisted clients.
4. The page shows per-client coverage (`Report requested` / `Not configured` /
   `Unavailable`). Partial coverage is expected.

Scheduled reporter runs (for example Sunset’s 15-minute schedule) remain
**separate** from this on-demand Refresh all action.

## Verify

```bash
node scripts/verify-crowsnest-spyglass-refresh-all.js
node scripts/verify-crowsnest-spyglass-refresh-azure-job-start.js
```

## Slice B application behavior (this branch)

| Module | Role |
|--------|------|
| `crowsnest-spyglass-refresh.js` | Pure domain allowlist + coverage statuses |
| `crowsnest-spyglass-refresh-runtime-config.js` | Validates env; fixed Sunset staging target only |
| `crowsnest-spyglass-refresh-azure-job-start.js` | Injected-fetch MI token + exact ARM `jobs/start` POST |

Production wiring in `crowsnest-api.js` enables the Azure adapter **only** when
both validated runtime config and Container Apps `IDENTITY_ENDPOINT` /
`IDENTITY_HEADER` are present. Otherwise the configured Sunset target maps to
`unavailable`. Non-production fixture transport
(`CROWSNEST_SPYGLASS_REFRESH_FIXTURE_TRANSPORT=1`) remains test-only.

### Safe runtime config names (no values in git)

Earthling sets these on the Crowsnest Container App (names only — never commit
values):

- `CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID` — Azure subscription GUID
- `CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP` — must be
  `luna-sunset-staging-rg`
- `CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME` — must be
  `sunset-somo-stg-cn-metrics` (manual job, not the scheduled twin)
- `CROWSNEST_SPYGLASS_REFRESH_AZURE_MANAGED_IDENTITY_CLIENT_ID` — optional
  user-assigned managed identity client UUID

Platform-injected (Container Apps):

- `IDENTITY_ENDPOINT`
- `IDENTITY_HEADER`

## Earthling Azure delivery requirements (after merge)

Do this on Azure after the application PR merges to master. This document is the
operator checklist — **not** an executable script in source.

1. **Deploy exact master** Crowsnest image/revision that contains Slice B (no
   divergent local tip).
2. **Managed identity on Crowsnest** (system-assigned or user-assigned). If
   user-assigned, set
   `CROWSNEST_SPYGLASS_REFRESH_AZURE_MANAGED_IDENTITY_CLIENT_ID` to that
   identity’s client UUID and ensure the identity is assigned to the Crowsnest
   Container App.
3. **RBAC least privilege** — assign a role that includes
   `Microsoft.App/jobs/start/action` **only** on the Sunset staging **manual**
   job resource
   (`…/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.App/jobs/sunset-somo-stg-cn-metrics`).
   Do not grant subscription-wide Owner/Contributor for this purpose. Do not
   bind Wolfhouse or Sardinero jobs unless explicitly approved later.
4. **Runtime config** — set the `CROWSNEST_SPYGLASS_REFRESH_AZURE_*` app
   settings listed above (values from Earthling’s Azure context; not stored in
   git). Confirm `IDENTITY_ENDPOINT` / `IDENTITY_HEADER` are present in the
   running revision.
5. **Proof** — sign in to Crowsnest, use **Refresh all**, and confirm Sunset
   Somo shows `Report requested` (`started`) while Wolfhouse/Sardinero stay
   `Not configured`, with no token/resource/error leak in the HTML. Confirm the
   **15-minute schedule** is unchanged.
6. Keep scheduled reporting on its existing schedule; Refresh all stays an
   on-demand, authenticated operator action only.
