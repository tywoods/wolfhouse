# Crowsnest — location and infrastructure plan

**Status:** PLAN + skeleton in repo only — **no deploy, no Azure changes, no DNS move yet.**

Product overview: [`CROWSNEST.md`](CROWSNEST.md)

---

## Current state

| Topic | Today |
|-------|--------|
| Domain | `crowsnest.lunafrontdesk.com` is an **alias / custom domain on Wolfhouse staff-staging** (`wh-staging-staff-api`) |
| App | Same Staff API container and codebase path as Wolfhouse staging portal |
| Isolation | **None** — Crowsnest hostname does not yet mean a separate app |

This is acceptable for early operator access but is **not** the long-term architecture.

---

## Desired state

| Topic | Target |
|-------|--------|
| App | **Separate** Crowsnest HTTP server (`scripts/crowsnest-api.js`) |
| Domain | `crowsnest.lunafrontdesk.com` → **dedicated** Crowsnest Container App (later) |
| Auth | Separate internal auth/env — Monshies and Earthling only at first |
| Data | No tenant DB writes until explicit gated slices |

---

## Repo location (chosen)

| Path | Role |
|------|------|
| `scripts/crowsnest-api.js` | Standalone Node HTTP entry (not `staff-query-api.js`) |
| `scripts/lib/crowsnest/` | Page render, future auth, modules |
| `scripts/verify-crowsnest.js` | Static skeleton gate |
| `docs/CROWSNEST.md` | Product doc |
| `docs/CROWSNEST-LOCATION-PLAN.md` | This plan |

**Do not** fold Crowsnest into Staff API long-term. Staff API remains per-tenant staff portals; Crowsnest is platform-internal.

---

## Future Azure target (proposed — not created)

| Resource | Proposed name |
|----------|---------------|
| Resource group | `luna-crowsnest-staging-rg` (or shared ops RG — TBD) |
| Container Apps environment | `luna-crowsnest-staging-env` |
| Container App | `luna-crowsnest-staging-api` |
| Image repo | `crowsnest-api` or shared ops image — **TBD at deploy slice** |
| Key Vault | `luna-crowsnest-staging-kv` |
| Managed identity | `luna-crowsnest-staging-identity` |
| Custom domain | `crowsnest.lunafrontdesk.com` moved from `wh-staging-staff-api` → Crowsnest app |

**Out of scope for this document:** creating any of the above. Operator approval required per slice.

---

## Domain migration (later)

1. Deploy Crowsnest Container App with `/healthz` green.
2. Bind `crowsnest.lunafrontdesk.com` to Crowsnest app (remove from Wolfhouse staff-staging).
3. Confirm Staff API / Wolfhouse staging still serves `staff-staging.lunafrontdesk.com` only.
4. No Sunset or production hostname changes in Crowsnest slices unless explicitly planned.

**This plan does not move DNS or edit Azure.**

---

## Safety boundary

| Rule | Detail |
|------|--------|
| Users | Internal only — Monshies, Earthling (expand via explicit approval) |
| Writes | **Off by default** — skeleton has `writes_enabled: false` |
| Tenant writes | No client creation, config commits, or DB mutations until gated slices |
| Prod | No production writes by default; staging-only until go-live gates |
| Side effects | No WhatsApp, Stripe, email, or booking flows in skeleton |

---

## First implementation slice (done in repo)

- [x] Static placeholder portal HTML
- [x] `GET /healthz`, `/`, `/crowsnest`, `/crowsnest/ui`
- [x] `scripts/verify-crowsnest.js`
- [x] `npm run crowsnest:start` / `npm run verify:crowsnest`

## Next slices (not this task)

- Enforce auth (`CROWSNEST_AUTH_REQUIRED`, allowed users)
- Read-only client registry view (from `config/clients/clients.json`)
- Template picker UI (surf house / surf school) — still no writes
- Gated client-creation writes with approval packet
- Azure deploy + domain cutover

---

## Explicit non-goals (this phase)

- Deploy to Azure
- Change Azure resources
- Move `crowsnest.lunafrontdesk.com`
- Modify `staff-staging` routing or domain config
- Touch Sunset or production
- Real client-creation from frontend
