# Crowsnest

**Crowsnest** is the internal dev/operator control portal for Luna Front Desk.

| | |
|---|---|
| **Audience** | Humans who build and operate the platform — initially **Monshies** and **Earthling** only |
| **Not** | Guest-facing, tenant staff portal, or Wolfhouse-specific |
| **Future** | Client onboarding and control: add new Luna Front Desk clients from a frontend |

## What it is

- Internal tooling for platform operators
- Long-term home for onboarding and managing clients (tenants)
- Separate from per-tenant staff portals (Wolfhouse, Sunset, Mirleft, etc.)

## What it is not

- Not a guest WhatsApp or booking surface
- Not the Wolfhouse staff portal (`staff-staging.lunafrontdesk.com`)
- Not Sunset admin or tenant runtime

## Product direction

The first real Crowsnest module is the **AI Usage Panel** for internal Ship operators. Client onboarding remains a later Crowsnest capability; it is not part of Skipper's current platform redesign.

Later, operators may also:

1. Choose a **template** — surf house or surf school
2. Fill in new client information
3. Create the new client/tenant setup from the portal (gated slices; no blind writes)

## VERIFIED CURRENT LIVE BASELINE

**VERIFIED CURRENT LIVE BASELINE** (deployed standalone app with branded login portal): `https://crowsnest.lunafrontdesk.com` on `crowsnest-internal`; browser UI auth via branded session portal (`/login`); legacy Basic Auth retained for compatibility; `/healthz` reports `service: crowsnest`, `stage: portal`, `auth_enabled: true`, `writes_enabled: false`. See [`CROWSNEST-LOCATION-PLAN.md`](CROWSNEST-LOCATION-PLAN.md) and [`CROWSNEST-DEPLOY-PLAN.md`](CROWSNEST-DEPLOY-PLAN.md).

| Item | Status |
|------|--------|
| Dedicated location | `scripts/crowsnest-api.js` + `scripts/lib/crowsnest/` |
| Azure app | Standalone `crowsnest-internal` Container App in `wh-staging-rg` |
| Public URL | `https://crowsnest.lunafrontdesk.com` |
| Static placeholder UI | Skeleton + read-only **Clients** overview + **New client onboarding** form mockup |
| Onboarding mockup | Draft form only — surf house / surf school templates; all fields and buttons disabled; no submit |
| `GET /healthz` (live) | `service: crowsnest`, `stage: portal`, `writes_enabled: false`, `auth_enabled: true`; allowed users Monshies/Earthling |
| Login portal (live) | `GET /login` renders the branded operator sign-in page; `POST /login` issues an in-memory session cookie; `POST /logout` clears it |
| Browser access (live) | Unauthenticated UI requests to `/`, `/crowsnest`, and `/crowsnest/ui` redirect `302` to `/login` with no Basic challenge; legacy Basic Auth still works if supplied |
| Asset route (live) | `/crowsnest/assets/logo.png` serves the bundled logo as `image/png` with long-lived cache headers |
| Writes / DB / Stripe / WhatsApp | **None** |
| Deploy / Azure / domain | Live standalone app with login portal promoted — see location/deploy plans |

The current UI is only a safe shell. The AI Usage Panel has not been implemented yet.

### Slice 3 (adapter only — not integrated)

Offline **AI usage adapter**: maps native OpenAI / Anthropic technical usage fields into validated `crowsnest.ai_usage.v1` events with explicit trusted `client_slug` / `tenant_id`. Pure module + synthetic fixtures + `npm run verify:crowsnest-ai-usage-adapter`. See [`docs/crowsnest/AI-USAGE-ADAPTER.md`](crowsnest/AI-USAGE-ADAPTER.md). No storage, no provider runtime/call-site wiring, no UI panel.

### Slice 2 (contract only — not integrated)

Offline **AI usage event contract** (`crowsnest.ai_usage.v1`): pure validator, sanitized fixtures, and `npm run verify:crowsnest-ai-usage-contract`. See [`docs/crowsnest/AI-USAGE-EVENT-CONTRACT.md`](crowsnest/AI-USAGE-EVENT-CONTRACT.md). No storage, provider wiring, or UI panel in this slice.

### Slice 1 (merged and deployed)

**Slice 1 is merged and deployed** — PR [#128](https://github.com/wolfhouse-somo/WH/pull/128); master/image SHA `14a7e3f7f656dd8a7dc11b528b8a645d3feb1210`; ACR build `cb11e`; active healthy revision `crowsnest-internal--0000010` at **100% traffic**. Protected routes: `/` (Spyglass default), `/clients`, `/billing`, `/communications` (aliases `/crowsnest` and `/crowsnest/ui` still render Spyglass). Honest read-only Spyglass shell from in-memory static client data; Billing/Communications placeholders stay **not connected**. No live writes or integrations. Staff API remained `wh-staging-staff-api--0000520` (untouched).

### History (pre-login-portal live shell)

Before the login-portal image was promoted, the public hostname used a browser Basic Auth challenge on `/` and `/healthz` reported `stage: skeleton`. That shell is **historical only** and is no longer the live baseline.

## Ownership boundary

- Crowsnest work stays in `scripts/crowsnest-api.js`, `scripts/lib/crowsnest/`, Crowsnest-specific tests/docs, and its dedicated image/runtime configuration.
- Do not modify Wolfhouse guest flows, tenant Staff API behavior, Sunset, Stripe, WhatsApp, or booking logic for a Crowsnest feature.
- Skipper's redesign is separate. Crowsnest may read stable contracts later, but should not copy or pre-empt Skipper's in-progress architecture.
- The old unpushed `surf_house` archetype branch is reference material only. Revalidate it after the shared redesign settles before reusing any part of it.

Run locally:

```bash
npm run crowsnest:start
# or: CROWSNEST_PORT=3040 node scripts/crowsnest-api.js
curl http://127.0.0.1:3040/healthz
```

### Auth (operator accounts)

Live and local browser access (when auth is enabled) use the branded login portal. Legacy Basic Auth remains accepted for compatibility. **`GET /healthz` is always public** and never includes credentials. Live operator credential distribution is out of scope for this doc.

Preferred configuration is **two independent operator accounts** (Earthling + Monshies). Do not put defaults in production.

| Variable | Default | Notes |
|----------|---------|-------|
| `CROWSNEST_AUTH_REQUIRED` | `false` | Set `true` to require login for normal browser UI access |
| `CROWSNEST_AUTH_EARTHLING_USERNAME` | _(none)_ | Earthling operator username; Azure secret ref `cn-auth-user` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_EARTHLING_PASSWORD` | _(none)_ | Earthling operator password; Azure secret ref `cn-auth-pass` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_MONSHIES_USERNAME` | _(none)_ | Monshies operator username; Azure secret ref `cn-monshies-user` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_MONSHIES_PASSWORD` | _(none)_ | Monshies operator password; Azure secret ref `cn-monshies-pass` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_USERNAME` | `admin` (non-production only) | **Legacy single-account fallback only** when none of the four multi-account variables are present. Never combined with multi-account mode. Compatibility behavior only — live production uses the four-variable pairs above. |
| `CROWSNEST_AUTH_PASSWORD` | `admin` (non-production only) | Legacy single-account fallback password (same isolation rules as username). Compatibility behavior only. |
| `CROWSNEST_ALLOWED_USERS` | `Monshies,Earthling` | Informational allow-list in `/healthz` only |

Multi-account rules:

- If **any** of the four `CROWSNEST_AUTH_EARTHLING_*` / `CROWSNEST_AUTH_MONSHIES_*` variables are present, multi-account mode is selected and legacy `CROWSNEST_AUTH_USERNAME` / `CROWSNEST_AUTH_PASSWORD` are ignored.
- Both complete account pairs are required. Missing, blank, or **duplicate** usernames → auth misconfigured (`503` when auth is required). Passwords may not be blank.
- Non-production `admin`/`admin` remains only when neither multi-account nor legacy variables are present.

When `CROWSNEST_AUTH_REQUIRED=true`:

- `GET /login` shows the branded login form
- Valid credentials for **either** operator on `POST /login` → `302` to `/` with an independent opaque `HttpOnly`, `SameSite=Strict` session cookie (`Secure` in production)
- Invalid credentials → the same login page with a generic error and no credential leak
- `POST /logout` clears **that** session cookie/token only and returns to `/login`
- Unauthenticated browser access to protected UI routes redirects to `/login`
- Auth required but credentials empty/missing/invalidly configured → `503` (`Crowsnest auth is not configured`)
- Legacy Basic Auth requests are still accepted on the protected UI routes for compatibility (either configured operator)

Local auth-enabled smoke (multi-account):

```bash
CROWSNEST_AUTH_REQUIRED=true \
CROWSNEST_AUTH_EARTHLING_USERNAME=earthling \
CROWSNEST_AUTH_EARTHLING_PASSWORD=earth-secret \
CROWSNEST_AUTH_MONSHIES_USERNAME=monshies \
CROWSNEST_AUTH_MONSHIES_PASSWORD=mon-secret \
npm run crowsnest:start
curl -i http://127.0.0.1:3040/                      # 302 -> /login
curl -i http://127.0.0.1:3040/login                 # branded form
curl -i -u earthling:earth-secret http://127.0.0.1:3040/crowsnest/ui  # 200
curl -i -u monshies:mon-secret http://127.0.0.1:3040/crowsnest/ui     # 200
curl http://127.0.0.1:3040/healthz                  # 200, auth_enabled:true, no password
```

Legacy single-account smoke (fallback only):

```bash
CROWSNEST_AUTH_REQUIRED=true CROWSNEST_AUTH_USERNAME=admin CROWSNEST_AUTH_PASSWORD=admin npm run crowsnest:start
```

Verify:

```bash
npm run verify:crowsnest
npm run verify:crowsnest-auth
npm run verify:crowsnest-ai-usage-contract
npm run verify:crowsnest-ai-usage-adapter
```
