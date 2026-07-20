# FORTRESS Slice 15F — Bot request tenant bind (B07)

**Status:** remediated (offline)
**Master basis:** `11926ad855105a93e85cfd5645ff6bd226129edb`
**Boundary:** `B07_staff_bot_body_client_slug`

## Outcome

Generic `/staff/bot/*` routes derive effective `client_slug` from the authenticated bot principal (`user.client_slug` from 15E). Body, query, and alias fields (`client_slug`, `client`) cannot override it. Explicit conflicts and empty aliases fail closed with `403 client_access_denied` **before** handler/DB/provider work. Omission is allowed when the principal supplies the tenant.

## Controls

- `resolveStaffBotRequestEffectiveTenant` / `dispatchStaffBotRouteWithPrincipalRequestTenant`
- HTTP wrapper `dispatchBotRouteBoundToPrincipalTenant` (cached body read → pin → handler)
- 40 generic bot entry points wired through principal bind dispatch
- Force-tenant Sunset routes unchanged (15E `dispatchBotRouteWithEffectiveTenant`)
- Staff-session `/staff/bot/pause*` routes remain `requireAuth` (not bot-token bind)

## Residual risk

Staff-session pause routes under /staff/bot/* still use requireAuth + query/body DEFAULT_CLIENT (not bot principal). Non-bot staff portal handlers retain hardcoded DEFAULT_CLIENT. Shared-runtime multi-tenant Staff API still requires correct LUNA_BOT_CLIENT_SLUG per deploy.
