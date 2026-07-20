# FORTRESS Slice 15E — Staff bot auth principal tenant bind

**Status:** remediated (B06 closed by runtime tenant bind on bot principal)
**Master basis:** `ff8c4ad4c19a8db2328760a65444319bcbd47532`
**Boundary:** `B06_staff_bot_auth_principal`
**Live mutation:** none (code + offline tests only)

## Outcome

Fail-closed bind of internal bot-token authentication to one authoritative deployment/runtime tenant slug. The authenticated bot principal carries that slug; email-less bot ACL no longer expands to all baseline clients. Staff-session email ACL and Sunset/Wolfhouse runtime isolation are preserved. Bot route body/query tenant handling is **not** changed (B07).

## Historical 15A

15A matrix/attack-cases/doc remain the frozen audit (B06 `vulnerable`). Status update is this overlay only — see `slice15e-b06-remediation-overlay.json`.

## API / config

| Surface | Behavior |
|---------|----------|
| `resolveStaffBotPrincipalClientSlug(env)` | `LUNA_BOT_CLIENT_SLUG` preferred; nonempty `DEFAULT_CLIENT_SLUG` compat; both conflict, neither, or invalid shape → fail closed. No hardcoded tenants. |
| `buildStaffBotAuthPrincipal(env, opts)` | Builds `{ role:operator, staff_user_id:luna-bot-internal, client_slug }`. Optional `knownClientSlugs` → `unknown_runtime_client_slug` fail closed. |
| `getAccessibleClientSlugs(user)` | For `luna-bot-internal`: only bound slug (or `[]` if unbound). Staff sessions with email: unchanged explicit / all-clients ACL. |
| `requireBotAuth` | On valid bot token: build principal; missing/invalid/conflict/unknown → **503** `bot_principal_tenant_unconfigured`. Session path unchanged. |

## Rollout (both tenant deployments)

Set **`LUNA_BOT_CLIENT_SLUG`** on each Staff API runtime that uses `LUNA_BOT_INTERNAL_TOKEN` to that deployment’s tenant slug. Optionally keep matching nonempty `DEFAULT_CLIENT_SLUG`. Missing or conflicting values fail closed on bot-token auth (session login still works).

## Residual B07 risk

Generic `/staff/bot/*` may still source `trustedClientSlug` from body/query (`DEFAULT_CLIENT` hardcoded on some paths). Sunset `/staff/bot/sunset/*` forces `sunset`. Principal bind does not by itself stop a handler that ignores `assertStaffClientAccess` / bound slug when choosing SQL scope. That is the next slice (B07).

## Gates

```bash
npm run verify:fortress-slice15e-bot-principal-tenant-bind
npm run verify:fortress-tenant-identity-boundary-matrix
npm run verify:staff-auth-api
npm run verify:multiclient
npm run verify:migration-integrity
git diff --check
```

## Explicit non-goals

- No B07 body/query tenant rewrite
- No live Stripe / DB / payment / deploy / guest / WhatsApp calls
- No PR/merge in this slice
