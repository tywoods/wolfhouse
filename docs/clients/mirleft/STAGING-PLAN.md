# Mirleft Surf Camp — Isolated staging runtime plan

**Status:** PLAN ONLY — no Azure provisioning, no DNS edits, no deploy, no secrets.
**Tenant:** `mirleft` / `mirleft-main`
**Target hostname:** `mirleft-staging.lunafrontdesk.com`
**Related:** [`ONBOARDING.md`](ONBOARDING.md) · [`OWNER-QUESTIONS.md`](OWNER-QUESTIONS.md) · [`docs/MULTICLIENT-ARCHITECTURE.md`](../../MULTICLIENT-ARCHITECTURE.md) · Sunset pattern [`infra/azure/sunset-staging/`](../../../infra/azure/sunset-staging/) · [`docs/sunset/SUNSET-PORTAL-SLICE-1-INFRA-BUILD-PLAN.md`](../../sunset/SUNSET-PORTAL-SLICE-1-INFRA-BUILD-PLAN.md)

This document plans a **Mirleft-only** staging runtime, separate from Wolfhouse and Sunset. It does **not** authorize creation of resources.

---

## 1. Goal

Stand up an isolated Mirleft staging stack so operators can:

1. Run Staff API / portal against Mirleft tenant config and a Mirleft-only database.
2. Later attach a Mirleft-specific Luna (not Wolfhouse SOUL) on a dedicated runtime.
3. Enable staging auto-reply only after explicit go/no-go gates.

**Not in this plan:** production, live guest WhatsApp, Meta/Stripe/email wiring, DNS changes, or Azure `az` execution.

---

## 2. Isolation requirement

| Must be separate from Wolfhouse / Sunset | Why |
|------------------------------------------|-----|
| Resource group | Blast radius; no accidental deploys to `wh-staging-*` or `luna-sunset-staging-*` |
| Container Apps environment + Staff API app | Own ingress, revisions, env |
| Postgres server + database | No shared rows with Wolfhouse/Sunset |
| Key Vault + managed identity | Mirleft secrets never land in other tenants' vaults |
| Custom domain | `mirleft-staging.lunafrontdesk.com` only |
| Portal access config | Mirleft-scoped staff users (not `all_clients_emails` on shared Wolfhouse staging) |
| Luna / Hermes runtime (later) | Mirleft-specific identity/SOUL — **not** Wolfhouse `SOUL.md` |

**Forbidden targets (abort if any plan or command uses them):**

| Forbidden | Owner |
|-----------|--------|
| `wh-staging-rg`, `wh-staging-staff-api`, `staff-staging.lunafrontdesk.com` | Wolfhouse |
| `luna-sunset-staging-rg`, `luna-sunset-staging-staff-api`, `sunset-staging.lunafrontdesk.com` | Sunset |
| `wolfhouse_staging` / `sunset_staging` DB names | Other tenants |
| Shared live channel router before gates (§6) | Platform |

---

## 3. Proposed resource names

Mirror the Sunset isolated-staging naming (`luna-<tenant>-staging-*`). **Proposed only — not created.**

| Resource | Proposed name |
|----------|---------------|
| Resource group | `luna-mirleft-staging-rg` |
| Region | `westeurope` (match Sunset/Wolfhouse staging; confirm capacity) |
| Container Apps environment | `luna-mirleft-staging-env` |
| Container App (Staff API) | `luna-mirleft-staging-staff-api` |
| Managed identity | `luna-mirleft-staging-identity` |
| Key Vault | `luna-mirleft-staging-kv` |
| Postgres Flexible Server | `luna-mirleft-staging-pg-app` |
| Database | `mirleft_staging` |
| Log Analytics (optional) | `luna-mirleft-staging-logs` |
| Staff API image (shared repo) | `whstagingacr.azurecr.io/wh-staff-api:<master-sha>` — same image repo as Wolfhouse Staff API; tag = clean `master` commit SHA (`npm run deploy:preflight` / `assert-deploy-from-master`) |
| Custom domain (post-DNS, later) | `mirleft-staging.lunafrontdesk.com` |
| Health URL (post-deploy) | `https://mirleft-staging.lunafrontdesk.com/healthz` |
| Azure default FQDN (pre-custom-domain) | `luna-mirleft-staging-staff-api.<env-default-domain>` |

### 3.1 Secrets (Key Vault names — placeholders only)

Do **not** populate Meta, Stripe, or email secrets in the first infra pass.

| KV secret name (proposed) | Env mapping (typical) | First pass |
|---------------------------|------------------------|------------|
| `mirleft-database-url` | `WOLFHOUSE_DATABASE_URL` (generic PG env name; **value** = Mirleft DB only) | Required when app starts |
| `staff-session-secret` | session signing | Required when app starts |
| Stripe keys | Stripe env vars | **Deferred** — no secrets yet |
| Meta WhatsApp token / phone IDs | Meta env vars | **Deferred** — no secrets yet |
| Email credentials | email ingress | **Deferred** — no secrets yet |

Real values live only in Key Vault / operator secret stores — never in git.

### 3.2 Custom domain (plan only — no DNS edits here)

When operators later bind the domain (separate approval):

| Step | Notes |
|------|--------|
| CNAME `mirleft-staging.lunafrontdesk.com` → Container App FQDN | DNS provider for `lunafrontdesk.com` |
| TXT `asuid.mirleft-staging` for Azure domain verification | From Container Apps custom-domain verification ID |
| Managed certificate on `luna-mirleft-staging-staff-api` | After DNS propagates |

**This plan does not create or edit DNS records.**

### 3.3 Image strategy (shared Staff API image)

Tenant isolation is **runtime**, not a separate image repository:

| Layer | Strategy |
|-------|----------|
| **Image repo** | Shared `wh-staff-api` in `whstagingacr` (same codebase image as other Staff API runtimes) |
| **Image tag** | Immutable **master SHA** only — build from clean `origin/master` (`assert-deploy-from-master` / `npm run deploy:preflight`) |
| **Isolation** | Separate RG, CAE, Container App, Postgres, Key Vault, custom domain, env, and Mirleft-scoped config/access |
| **Config** | Shared image already carries `config/clients/mirleft.baseline.json` from master; Mirleft app selects tenant via env (`DEFAULT_CLIENT` / `staff_api_tenant_scope=mirleft`) and Mirleft DB/KV |
| **Portal access** | Mirleft-only staff access applied at **runtime** (env, secret mount, or deploy-time override) — not by forking the image repo |

**Do not** create `luna-mirleft-staff-api` (or other Mirleft-only image repos) by default.

**Later split (optional):** only introduce a separate image repository if build/deploy constraints require it (e.g. Mirleft-only bake of access files that cannot be mounted safely). Prefer shared `wh-staff-api:<master-sha>` until that constraint is proven.

---

## 4. Copy from Sunset isolated staging vs must be unique

Sunset is the template (`infra/azure/sunset-staging/`, portal slice infra plans). Mirleft should **copy patterns**, not resources.

| Can copy (pattern / approach) | Must be unique to Mirleft |
|-------------------------------|---------------------------|
| Dedicated RG + CAE + Staff API + Postgres + KV + identity layout | All resource names (`luna-mirleft-staging-*`) |
| Shared ACR `whstagingacr` + shared Staff API image repo `wh-staff-api` tagged by **master SHA** | Container App pulls the same image tag but runs with Mirleft-only env/DB/KV/config (not Wolfhouse or Sunset connection strings) |
| Safety flags pattern (`WHATSAPP_DRY_RUN=true`, staff auth required, no live actions until gates) | Tenant scope `DEFAULT_CLIENT` / `staff_api_tenant_scope` = `mirleft` |
| Mirleft-only portal access pattern (Sunset used a bake file; Mirleft prefers runtime mount/override on shared image) | Access list emails and `client_access: ["mirleft"]` only |
| Bicep structure forked from Sunset/Wolfhouse staging templates | Parameters: `appNamePrefix`, `appDbName`, identity, KV, domain; image = `wh-staff-api:<master-sha>` |
| Health check path `GET /healthz` | Hostname `mirleft-staging.lunafrontdesk.com` |
| Post-deploy Postgres firewall for CAE egress IPs | Firewall rules on `luna-mirleft-staging-pg-app` only |
| Migrations applied to tenant DB before use | Database `mirleft_staging` only |
| No n8n / Redis in first Staff API slice (Sunset Slice 1 deferral) | Same deferral unless Mirleft needs otherwise |

**Do not copy:** Sunset KV secrets, Sunset DB connection strings, Sunset portal access users, or any Wolfhouse/Sunset staging **runtime** env. Image **tags** may match a shared master SHA across tenants; isolation is still per-app env/DB/KV.

**Note vs Sunset:** Sunset historically used a separate image repo (`luna-sunset-staff-api`). Mirleft defaults to the **shared** `wh-staff-api:<master-sha>` strategy; split the image repo only if build/deploy constraints require it (§3.3).

---

## 5. Runtime components (phased)

### Phase A — Staff API + portal only (first infra)

- Container App `luna-mirleft-staging-staff-api`
- Image: `whstagingacr.azurecr.io/wh-staff-api:<master-sha>` (shared repo; not a Mirleft-only image)
- Postgres `mirleft_staging`
- Key Vault with DB URL + session secret only
- Runtime selects Mirleft: env/DB/KV + `config/clients/mirleft.baseline.json` (in shared image) + Mirleft-scoped staff portal access (runtime override/mount)
- `live_enabled` remains **false** in `clients.json`
- `deployment.enabled` remains **false** in baseline until go-live checklist

### Phase B — Mirleft Luna (later)

- Dedicated Hermes/Luna runtime (ACA or Lunabox profile — decide at implementation)
- **Mirleft-specific Luna identity / SOUL** — not Wolfhouse `/var/lib/hermes-luna/SOUL.md` or `docker/hermes-staging/SOUL.md`
- Staff API base URL points at Mirleft staging only
- Auto-reply **off** until §8 gates pass

### Phase C — Channels (later, after owner + operator approval)

- New WhatsApp number + Meta Cloud API (secrets in Mirleft KV only)
- Stripe test keys (Mirleft account only; migrate later)
- Email ingress (if required)

---

## 6. No shared live router before gates

Until Mirleft go/no-go gates pass:

| Rule | Detail |
|------|--------|
| No shared live channel router | Do not enable `CLIENT_CHANNEL_ROUTING_*` on Wolfhouse or Sunset runtimes for Mirleft live handling |
| No Mirleft traffic on Wolfhouse Luna | `hermes-luna` / `staff-staging.lunafrontdesk.com` stay Wolfhouse |
| No Mirleft traffic on Sunset staging | `sunset-staging.lunafrontdesk.com` stays Sunset |
| Sample routing IDs only in git | `*_SAMPLE` / `REPLACE_WITH_*` — never real Meta IDs in repo |
| Shadow-only observation | Platform multiclient shadow may exist; it must not switch live Mirleft guests onto another tenant |

See [`docs/MULTICLIENT-STAGING-ROUTING.md`](../../MULTICLIENT-STAGING-ROUTING.md).

---

## 7. Secrets policy (this plan)

| Category | Status |
|----------|--------|
| Meta Cloud API tokens / `phone_number_id` | **Not yet** — plan names only |
| Stripe keys / webhooks | **Not yet** — plan names only |
| Email credentials | **Not yet** |
| DB URL + staff session secret | Required only when Phase A app is created (operator-owned, not in git) |

Do not ask owners to paste secrets into docs or PRs.

---

## 8. Luna identity (later)

| Decision | Value |
|----------|--------|
| Assistant name | Luna (platform persona) |
| Brand | Mirleft Surf Camp |
| SOUL / identity config | **Mirleft-specific**, separate from Wolfhouse |
| Wolfhouse SOUL reuse | **Forbidden** as Mirleft identity |

SOUL work is a later slice. This staging plan only reserves a dedicated Luna runtime and forbids pointing Mirleft staging at Wolfhouse SOUL.

---

## 9. Health checks (after deploy — not run here)

When Phase A exists, operators should verify:

```bash
# Custom domain (after DNS + cert — not configured in this plan)
curl -fsS "https://mirleft-staging.lunafrontdesk.com/healthz"

# Azure default FQDN (available before custom domain)
curl -fsS "https://<luna-mirleft-staging-staff-api-fqdn>/healthz"

# Portal UI (auth required; expect login, not 5xx)
curl -sS -o /dev/null -w "%{http_code}\n" "https://mirleft-staging.lunafrontdesk.com/staff/ui"
```

| Check | Pass criteria |
|-------|----------------|
| `/healthz` | HTTP 200, healthy JSON body |
| Staff UI | HTTP 200 or redirect to login (not 5xx) |
| DB connectivity | App starts; health reflects DB ok if exposed |
| Tenant scope | Session / portal lists **mirleft** only for Mirleft-scoped users |
| No cross-tenant | Mirleft identity cannot load Wolfhouse/Sunset data |

Record results in a future deploy record (not this plan).

---

## 10. Go / no-go gates before auto-reply

Auto-reply (WhatsApp or email) on Mirleft staging must stay **off** until all of the following are **go**:

| # | Gate | Go when |
|---|------|---------|
| 1 | Isolated runtime exists | Phase A Staff API + Mirleft DB only; not on Wolfhouse/Sunset hosts |
| 2 | Health checks pass | §9 green on Mirleft hostname/FQDN |
| 3 | Owner inventory / prices | [`OWNER-QUESTIONS.md`](OWNER-QUESTIONS.md) answered; baseline no longer placeholder-only for rooms/prices used in replies |
| 4 | Mirleft Luna identity | Dedicated SOUL/config for Mirleft (not Wolfhouse) |
| 5 | Dry-run / staff approval mode | Outbound WhatsApp dry-run or staff-approve until proven |
| 6 | No live Meta/Stripe on wrong account | Mirleft KV only; test-mode Stripe if payment links tested |
| 7 | Explicit operator approval | Written go for staging auto-reply |
| 8 | `live_enabled` | Remains **false** until full go-live checklist (prod is a later gate) |

**No-go defaults:** any failed health check, shared-router enabled early, Wolfhouse SOUL used for Mirleft, or secrets missing/wrong tenant.

---

## 11. Costs and resources to check before creation

Before any Azure creation (future approval packet), operators should confirm:

| Item | Check |
|------|--------|
| Subscription quota | Container Apps environments, Postgres Flexible Servers, Key Vaults in target region |
| Region capacity | `westeurope` (or agreed fallback) for CAE + Postgres |
| Postgres SKU cost | Sunset used `Standard_B1ms` burstable — confirm Mirleft budget |
| Key Vault | Soft-delete / purge protection policy; name globally unique |
| ACR | Reuse `whstagingacr`; pull shared `wh-staff-api:<master-sha>` (no Mirleft-only image repo by default; dedicated ACR only if budget/policy requires) |
| Log Analytics | Optional; extra ingestion cost if enabled |
| Public Postgres | Firewall locked to CAE egress only (no `0.0.0.0`); private endpoint later if required |
| Idle cost | Staging apps can scale to zero if product allows; Postgres usually cannot |
| Overlap | Confirm no existing `luna-mirleft-staging-*` names in subscription |
| DNS ownership | Who can add `mirleft-staging.lunafrontdesk.com` (later; not this plan) |
| Image build pipeline | Who builds/pushes shared `wh-staff-api:<master-sha>` from clean master (laptop/CI — not Lunabox Staff API deploy unless approved); Mirleft app only **pulls** that tag |

Rough order-of-magnitude (operator to price in Azure calculator): one small CAE + one B-series Postgres + one KV + logs ≈ similar to Sunset isolated staging monthly cost.

---

## 12. Implementation sequence (future work — not this PR)

1. Captain/operator approval packet (checkboxes for RG, Bicep, secrets, DNS, deploy).
2. Fork `infra/azure/sunset-staging/` → `infra/azure/mirleft-staging/` with Mirleft names (review-only Bicep first); image parameter = `wh-staff-api:<master-sha>`.
3. Create Azure resources (separate approval).
4. Populate KV: DB URL + session secret only.
5. Ensure shared `wh-staff-api:<master-sha>` exists in `whstagingacr` (build from clean master if needed); configure Mirleft Container App env/access (no separate Mirleft image repo).
6. Deploy Container App to that tag; run §9 health checks.
7. Apply migrations to `mirleft_staging`.
8. Later: Mirleft Luna identity, then channels, then auto-reply gates (§10).


---

## 13. Out of scope (explicit)

- Creating or modifying Azure resources
- Editing DNS
- Deploying images or restarting runtimes
- Adding Meta / Stripe / email secrets
- Editing Luna SOUL (Wolfhouse or Mirleft)
- Enabling shared live channel routing
- Flipping `live_enabled` or production cutover

---

## 14. Sign-off (later)

| Role | Approves | Date |
|------|----------|------|
| Operator / Captain | Infra creation packet | |
| Operator / Captain | First Staff API deploy | |
| Operator / Captain | Staging auto-reply enable | |
