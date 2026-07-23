# Spyglass Refresh all (Slice A)

Authenticated Spyglass action that **requests** a fresh client-metrics report from
each **server-configured**, tenant-owned manual reporter job. Coverage is always
honest and per-client: `started`, `not_configured`, or `unavailable`. Crowsnest
never claims every client refreshed, and never claims metrics are already
refreshed.

## Goal (Slice A)

- Fixed client allowlist: `wolfhouse-somo`, `sunset-somo`, `sunset-sardinero`.
- Server-owned configured targets only (browser cannot submit client IDs, job
  names, or Azure resource names).
- Today Sunset Somo staging may be configured to manual job
  `sunset-somo-stg-cn-metrics`. Wolfhouse has a manual job in Azure but is **not**
  auto-assumed configured until explicit runtime config. Sunset Sardinero is not
  configured.
- Injected job-start transport for tests; production Slice A uses an unavailable
  stub (no Azure calls yet).
- Authenticated `POST /spyglass/refresh-all` + Spyglass form/button with safe
  status/coverage copy.

## Non-goals (Slice A)

- No Azure ARM / Container Apps Job start HTTP.
- No managed-identity token acquisition.
- No `@azure/*` dependencies.
- No Crowsnest deployment or runtime secret changes.
- No automatic Wolfhouse or Sardinero reporter setup.
- No AI usage UI / runtime / API work.
- Crowsnest never queries tenant databases and never holds reporter DSNs/tokens.

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
```

## Slice B (next)

Slice B adds the **server-side managed-identity Azure Job-start adapter** and the
Azure **RBAC** needed for Crowsnest’s identity to start only the configured
manual reporter jobs. Prerequisites:

1. **Managed identity** on the Crowsnest Container App (user-assigned or
   system-assigned), used only server-side — never exposed to the browser.
2. **Azure RBAC** on each configured Container Apps Job (least privilege), for
   example permission to start jobs (`Microsoft.App/jobs/start/action` or an
   equivalent curated role) scoped to the specific job resource — not
   subscription-wide Owner.
3. **Server-owned target config** wiring for Sunset Somo staging
   (`sunset-somo-stg-cn-metrics`) and, only when explicitly approved, Wolfhouse’s
   manual job. Sardinero remains `not_configured` until a reporter exists.
4. **Token acquisition** via managed identity to Azure Resource Manager (no
   long-lived secrets in Crowsnest for job start; no `az` CLI from the app).
5. **Fail closed** to `unavailable` on ARM/RBAC/network errors without leaking
   raw errors, job execution IDs, tokens, or resource identifiers to the UI.
6. Keep **scheduled reporting** on its existing schedule; Refresh all stays an
   on-demand, authenticated operator action only.

Slice A’s domain contract (`requestSpyglassRefreshAll` + injected `startJob`) is
intentionally stable so Slice B can swap in the Azure adapter without changing
allowlist or UI honesty rules.
