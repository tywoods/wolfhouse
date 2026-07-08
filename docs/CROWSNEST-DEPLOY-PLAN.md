# Crowsnest — separate-app deploy plan

**Status:** PLANNING ONLY — **DO NOT RUN YET.** No deploy, no Azure resource creation, no domain move, no runtime config changes in this document.

Product: [`CROWSNEST.md`](CROWSNEST.md) · Location: [`CROWSNEST-LOCATION-PLAN.md`](CROWSNEST-LOCATION-PLAN.md)

Crowsnest is the internal dev/operator portal for **Monshies** and **Earthling**. It must not become a tenant staff portal or guest surface.

---

## 1. Current state

| Topic | Today |
|-------|--------|
| Code | Standalone skeleton in repo: `scripts/crowsnest-api.js`, `scripts/lib/crowsnest/`, `scripts/verify-crowsnest.js`, **`Dockerfile.crowsnest`** |
| Local run | `npm run crowsnest:start` → port **3040**, `writes_enabled: false` |
| Domain | `crowsnest.lunafrontdesk.com` is a **custom domain alias on Wolfhouse staff-staging** Container App `wh-staging-staff-api` |
| Staff staging | `staff-staging.lunafrontdesk.com` also points to **`wh-staging-staff-api`** (same app, same image, Staff API + portal) |
| Behavior | Hitting `crowsnest.lunafrontdesk.com` today serves **Wolfhouse Staff API**, not the Crowsnest skeleton |

Recent repo commits (Crowsnest slices): `b4bc09c`, `b0452ca`, `035899b`, `c807e10`.

---

## 2. Desired state

| Topic | Target |
|-------|--------|
| App | **Separate** Azure Container App running `scripts/crowsnest-api.js` only |
| Image | **Separate** image repo/tag: `whstagingacr.azurecr.io/crowsnest:<sha>` |
| Domain | `crowsnest.lunafrontdesk.com` → **Crowsnest Container App** (`crowsnest-internal`) |
| Staff staging | `staff-staging.lunafrontdesk.com` remains on **`wh-staging-staff-api`** — untouched |
| Behavior | No tenant/staff portal routing changes; Crowsnest is internal ops UI only |
| Writes | Remain off until explicit gated slices (`writes_enabled: false` in `/healthz`) |

---

## 3. Proposed Azure resources

**Proposed only — not created by this plan.**

### 3.1 Resource group

| Option | Name | Notes |
|--------|------|-------|
| **A (minimal)** | `wh-staging-rg` | Same RG as Wolfhouse staff-staging; fastest path; shared CAE possible |
| **B (cleaner)** | `luna-internal-rg` | Dedicated internal/ops RG; clearer blast radius |

**Recommendation for first deploy:** Option A (`wh-staging-rg`) unless operator prefers a new `luna-internal-rg` from day one. See [Open questions](#8-open-questions).

### 3.2 Container App

| Resource | Proposed value |
|----------|----------------|
| Container App name | `crowsnest-internal` |
| Container Apps environment | Reuse existing `wh-staging` CAE in `wh-staging-rg`, or new env in `luna-internal-rg` |
| Image | `whstagingacr.azurecr.io/crowsnest:<git-sha>` |
| Target port | **3040** |
| Ingress | External, HTTPS |
| Custom domain (after migration) | `crowsnest.lunafrontdesk.com` |
| Health probe | `GET /healthz` → `{ "status": "ok", "service": "crowsnest", "writes_enabled": false }` |

### 3.3 Environment variables

| Variable | First deploy | Later |
|----------|--------------|-------|
| `CROWSNEST_PORT` | `3040` | unchanged |
| `CROWSNEST_HOST` | `0.0.0.0` | unchanged |
| `NODE_ENV` | `production` | unchanged |
| `CROWSNEST_AUTH_REQUIRED` | `false` (skeleton) or `true` if auth slice lands first | **true** before broad exposure |
| `CROWSNEST_ALLOWED_USERS` | `Monshies,Earthling` | operator-maintained allow-list |

No database URL, Stripe, WhatsApp, or Staff API env vars in first deploy.

### 3.4 What stays on `wh-staging-staff-api`

| Hostname | Container App | Must not change |
|----------|---------------|-----------------|
| `staff-staging.lunafrontdesk.com` | `wh-staging-staff-api` | Yes |
| Wolfhouse tenant staff portal behavior | `wh-staging-staff-api` | Yes |

`crowsnest.lunafrontdesk.com` must be **detached** from `wh-staging-staff-api` before or when attached to `crowsnest-internal`.

---

## 4. Docker / build requirements

### 4.1 Root `Dockerfile` is not suitable

Root [`Dockerfile`](../Dockerfile) runs Staff API:

- `EXPOSE 3036`
- `CMD ["npm", "run", "staff:api"]`
- Copies `database/`, `public/`, full staff surface

Crowsnest needs port **3040**, no Staff API, no DB — **use a dedicated Dockerfile**.

### 4.2 `Dockerfile.crowsnest` (in repo)

Committed at repo root — local build only until operator approves deploy:

```bash
# Local smoke only — not Azure deploy
docker build -f Dockerfile.crowsnest -t crowsnest:local .
docker run --rm -p 3040:3040 crowsnest:local
curl -fsS http://127.0.0.1:3040/healthz
```

Contents match deploy requirements: `node:22-alpine`, port **3040**, `CMD node scripts/crowsnest-api.js`, no Staff API / DB / Stripe / WhatsApp env.

### 4.3 Proposed ACR build (DO NOT RUN YET)

---

## 5. Safe migration steps

All commands below are **DO NOT RUN YET** — planning reference only.

### Phase 0 — Preflight (repo / local)

```bash
# DO NOT RUN YET
cd /opt/wolfhouse/WH
git fetch origin && git checkout master && git pull --ff-only origin master
npm run verify:crowsnest
node --check scripts/crowsnest-api.js
git status --short   # must be clean before image build
SHA=$(git rev-parse --short HEAD)
```

### Phase 1 — Build and deploy Crowsnest app (no domain move yet)

```bash
# DO NOT RUN YET
az acr build --registry whstagingacr --image crowsnest:${SHA} --file Dockerfile.crowsnest .

az containerapp create \
  --name crowsnest-internal \
  --resource-group wh-staging-rg \
  --environment <wh-staging-cae-name> \
  --image whstagingacr.azurecr.io/crowsnest:${SHA} \
  --target-port 3040 \
  --ingress external \
  --env-vars CROWSNEST_PORT=3040 CROWSNEST_HOST=0.0.0.0 NODE_ENV=production

# Smoke on ACA default FQDN first (no custom domain yet)
curl -fsS "https://<crowsnest-internal-fqdn>/healthz"
curl -fsS "https://<crowsnest-internal-fqdn>/crowsnest/ui" | head
```

**Gate:** `/healthz` returns `service: crowsnest`, `writes_enabled: false`. UI renders Clients + onboarding mockup.

### Phase 2 — Domain migration (only after Phase 1 green)

```bash
# DO NOT RUN YET

# 1. Remove crowsnest custom domain from wh-staging-staff-api
az containerapp hostname delete \
  --resource-group wh-staging-rg \
  --name wh-staging-staff-api \
  --hostname crowsnest.lunafrontdesk.com

# 2. Bind crowsnest.lunafrontdesk.com to crowsnest-internal
az containerapp hostname add \
  --resource-group wh-staging-rg \
  --name crowsnest-internal \
  --hostname crowsnest.lunafrontdesk.com

# 3. Managed cert + bind (exact CLI varies by env — follow Azure docs)
```

### Phase 3 — Post-migration verification

```bash
# DO NOT RUN YET
curl -fsS https://crowsnest.lunafrontdesk.com/healthz
curl -fsS -o /dev/null -w "%{http_code}\n" https://crowsnest.lunafrontdesk.com/crowsnest/ui

# staff-staging must still be Wolfhouse Staff API
curl -fsS https://staff-staging.lunafrontdesk.com/healthz
# expect service wolfhouse-staff-query-api (or equivalent), NOT crowsnest
```

---

## 6. Rollback plan

If Crowsnest domain move fails or wrong app is served:

| Step | Action |
|------|--------|
| 1 | **Reattach** `crowsnest.lunafrontdesk.com` to `wh-staging-staff-api` (restores previous alias behavior), **or** leave domain unattached until fixed |
| 2 | Confirm `staff-staging.lunafrontdesk.com` still resolves to `wh-staging-staff-api` and `/healthz` is Staff API |
| 3 | Leave `crowsnest-internal` running on ACA default FQDN for debugging, or scale to 0 / delete app if abandoning |
| 4 | Do **not** change Sunset (`sunset-staging.lunafrontdesk.com`) or production hostnames |

Rollback does not require redeploying Staff API if `wh-staging-staff-api` was never modified except hostname detach/reattach.

---

## 7. Safety gates (before any real deploy)

| # | Gate | Pass when |
|---|------|-----------|
| 1 | `npm run verify:crowsnest` | All checks pass |
| 2 | `node --check scripts/crowsnest-api.js` | No syntax errors |
| 3 | Git tree | Clean; image tag = approved SHA |
| 4 | Routes | No POST/PUT/DELETE in `crowsnest-api.js` |
| 5 | Health | `/healthz` → `writes_enabled: false` |
| 6 | Auth | Auth story decided and implemented before exposing beyond Monshies/Earthling |
| 7 | Domain | Prefer ACA FQDN smoke **before** moving `crowsnest.lunafrontdesk.com` |
| 8 | Staff staging | Explicit check that `staff-staging.lunafrontdesk.com` unchanged after migration |
| 9 | Scope | No Sunset/prod deploy, no tenant writes, no Staff API coupling |

---

## 8. Open questions

| # | Question | Options |
|---|----------|---------|
| 1 | Resource group | `wh-staging-rg` vs new `luna-internal-rg` |
| 2 | First-deploy auth | Built-in Crowsnest auth env, basic auth at ingress, IP restriction, Azure Entra — **must decide before public hostname** |
| 3 | Domain timing | Move `crowsnest.lunafrontdesk.com` now vs test on ACA FQDN first (**recommend FQDN first**) |
| 4 | Dedicated CAE | Share Wolfhouse staging CAE vs dedicated internal CAE |
| 5 | Image repo name | `crowsnest` vs `crowsnest-internal` in ACR |
| 6 | Auth enforcement slice | Ship auth before domain move, or domain to FQDN only until auth lands |

---

## 9. Explicit non-goals (this plan)

- Creating or modifying Azure resources
- Moving `crowsnest.lunafrontdesk.com` (documented only)
- Changing `staff-staging.lunafrontdesk.com` routing or `wh-staging-staff-api` image
- Touching Sunset or production
- Enabling client creation, DB, Stripe, WhatsApp, or tenant writes
- Adding POST routes or live onboarding writes

---

## 10. Related docs

| Doc | Purpose |
|-----|---------|
| [`CROWSNEST.md`](CROWSNEST.md) | Product overview |
| [`CROWSNEST-LOCATION-PLAN.md`](CROWSNEST-LOCATION-PLAN.md) | Repo location + long-term isolation |
| [`MULTICLIENT-STAGING-ROUTING.md`](MULTICLIENT-STAGING-ROUTING.md) | Tenant channel routing (unchanged by Crowsnest deploy) |

**Next implementation slice (after operator approval):** add `Dockerfile.crowsnest`, preflight script, and deploy runbook checkbox packet — still no `az` execution until signed off.
