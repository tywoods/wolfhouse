# Crowsnest — location and infrastructure plan

**Status:** LIVE BASELINE — the standalone Crowsnest app, branded login portal, and custom domain are deployed. This document records the current boundary; it is not authority to change production, Sunset, Staff API, DNS, or tenant systems.

Product overview: [`CROWSNEST.md`](CROWSNEST.md)

---

## VERIFIED CURRENT LIVE BASELINE

| Topic | Today (live) |
|-------|--------|
| Domain | `crowsnest.lunafrontdesk.com` serves the standalone Crowsnest app |
| App | Azure Container App `crowsnest-internal` in `wh-staging-rg` (revision `crowsnest-internal--0000007`, 100% traffic) |
| Image | `whstagingacr.azurecr.io/crowsnest:d8b52b452aa0535d242ac5fcf31077f62068ce4e` |
| Runtime | `scripts/crowsnest-api.js` on port 3040; separate from `staff-query-api.js` |
| Live safety | Branded login portal enabled; unauthenticated UI redirects to `/login`; legacy Basic Auth retained for compatibility; `/healthz` public; `stage: portal`; `writes_enabled: false`; auth secrets via Azure refs `cn-auth-user` / `cn-auth-pass` |
| Staff API | Unchanged at `wh-staging-staff-api--0000520` / image `458ed255e8a06b7b0557718031e57f4d7064fa62` |

Verified live on 2026-07-21: the app reported `service: crowsnest`, `stage: portal`, `auth_enabled: true`, and `writes_enabled: false` with allowed users Monshies/Earthling. Unauthenticated `/` redirected `302` to `/login` with no Basic challenge; `/login` rendered the branded portal; production login/session/logout and Secure cookie flow passed with CSP and no browser errors. Live operator credential distribution is out of scope for this plan.

### History (pre-login-portal shell)

Earlier on 2026-07-21, before the login-portal image was promoted, live safety was legacy Basic Auth challenge on `/` with `/healthz` `stage: skeleton`. That shell is **historical only** and is no longer the live baseline.

---

## Required boundary

| Topic | Target |
|-------|--------|
| App | Keep the **separate** Crowsnest HTTP server (`scripts/crowsnest-api.js`) |
| Domain | Keep `crowsnest.lunafrontdesk.com` on `crowsnest-internal` |
| Auth | Separate internal auth/env — Monshies and Earthling only at first |
| Data | No tenant DB writes until explicit gated slices |

---

## Repo location (chosen)

| Path | Role |
|------|------|
| `scripts/crowsnest-api.js` | Standalone Node HTTP entry (not `staff-query-api.js`) |
| `scripts/lib/crowsnest/` | Page render, auth, modules |
| `scripts/verify-crowsnest.js` | Static skeleton gate |
| `docs/CROWSNEST.md` | Product doc |
| `docs/CROWSNEST-LOCATION-PLAN.md` | This plan |

**Do not** fold Crowsnest into Staff API long-term. Staff API remains per-tenant staff portals; Crowsnest is platform-internal.

---

## Current Azure placement

| Resource | Proposed name |
|----------|---------------|
| Resource group | `wh-staging-rg` |
| Container App | `crowsnest-internal` |
| Image repo | `whstagingacr.azurecr.io/crowsnest` |
| Target port | `3040` |
| Custom domain | `crowsnest.lunafrontdesk.com` |

Moving to a dedicated internal resource group/environment can be considered later, but is not required for product work and must be handled as a separate infrastructure slice.

---

## Domain safety

1. Do not detach or rebind `crowsnest.lunafrontdesk.com` during normal feature work.
2. Confirm `/healthz` on the default Container App FQDN before any future image promotion.
3. Keep `staff-staging.lunafrontdesk.com` on the Wolfhouse Staff API and untouched by Crowsnest changes.
4. Do not change Sunset or production hostnames in Crowsnest slices.

DNS is not managed in the visible Azure DNS zones, so external DNS-provider access must be verified before any DNS change is proposed.

---

## Safety boundary

| Rule | Detail |
|------|--------|
| Users | Internal only — Monshies, Earthling (expand via explicit approval) |
| Writes | **Off by default** — live portal keeps `writes_enabled: false` |
| Tenant writes | No client creation, config commits, or DB mutations until gated slices |
| Prod | No production writes by default; staging-only until go-live gates |
| Side effects | No WhatsApp, Stripe, email, or booking flows in the current shell |

---

## First implementation slice (done in repo)

- [x] Static placeholder portal HTML
- [x] `GET /healthz`, `/`, `/crowsnest`, `/crowsnest/ui`
- [x] Branded login portal (`GET/POST /login`, `POST /logout`) with legacy Basic compatibility
- [x] `scripts/verify-crowsnest.js`
- [x] `npm run crowsnest:start` / `npm run verify:crowsnest`

## Next product slices

- Build the read-only AI Usage Panel shell as the first real module.
- Define the usage-event contract and approved read-only source.
- Add focused offline verification before wiring any live data.
- Keep client onboarding and the old `surf_house` archetype deferred until Skipper's shared redesign is stable.

---

## Explicit non-goals (this phase)

- Redeploy or change Azure resources as part of ordinary feature coding
- Move or rebind `crowsnest.lunafrontdesk.com`
- Modify `staff-staging` routing or domain config
- Touch Sunset or production
- Real client-creation from frontend
