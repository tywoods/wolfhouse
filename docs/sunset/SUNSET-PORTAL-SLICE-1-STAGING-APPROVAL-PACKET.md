# Sunset Portal Slice 1 — Staging Approval Packet (Isolated Sunset Staging)

**Status:** AWAITING CAPTAIN SIGN-OFF — no staging action until checkboxes below are approved in writing  
**Date:** 2026-06-19 (revised)  
**Packet version:** 2.0 — isolated Sunset staging  
**Branch:** `feat/sunset-multitenant-luna`  
**Pinned SHA (portal code):** `25518554bcf635b59c594dae8f930c0190609209`  
**PR title:** Add isolated Sunset offline foundation and read-only portal slice  
**Merge policy:** PR approved; **merge held** until **isolated** Sunset staging validation passes.

---

## Why this changed (v2.0)

The v1.0 packet **incorrectly targeted Wolfhouse Staff API staging** (`wh-staging-staff-api`, `wh-staging-rg`, `staff-staging.lunafrontdesk.com`). Captain ruled:

- **Do NOT** deploy Sunset to `wh-staging-staff-api`
- **Do NOT** use `staff-staging.lunafrontdesk.com` for Sunset validation
- Wolfhouse staging must **not** be overwritten by Sunset work

This packet **intentionally isolates** Sunset into its own staging environment. Wolfhouse staging remains unchanged and is out of scope for Sunset Portal Slice 1 deploy/seed.

---

## ⛔ Global gate

**Deckhand/Cursor/Ops must not create Azure resources, deploy, seed, widen DB allowlist, or merge until Captain signs the relevant checkboxes in §11.**

This packet authorizes planning only. Performing any staging action without sign-off is forbidden.

---

## ⛔ Anti-Wolfhouse guard (mandatory — abort if violated)

**Any Ops runbook, script, or manual command MUST abort before making changes if any of the following are true:**

| Guard | Action |
|-------|--------|
| Deploy target Container App is `wh-staging-staff-api` | **ABORT** — forbidden for Sunset |
| Validation URL is `https://staff-staging.lunafrontdesk.com` (Sunset deploy/smoke/seed) | **ABORT** — Wolfhouse staging only |
| Resource group is `wh-staging-rg` for Sunset deploy/update | **ABORT** — unless Captain explicitly changes ruling |
| DB URL host is `wh-staging-pg-app` or database `wolfhouse_staging` | **ABORT** for Sunset seed/cleanup |
| DB URL points to Wolfhouse production or Wolfhouse staging Postgres | **ABORT** |
| Command would `az containerapp update` / revise traffic on Wolfhouse Staff API staging | **ABORT** |
| Seed manifest or row has `client_slug` / `tenant_id` ≠ `sunset` | **ABORT** (script-enforced) |

**Allowed Sunset targets only** (see §2). Wolfhouse staging smoke/regression stays on `staff-staging.lunafrontdesk.com` — **not** re-run as part of this packet.

---

## 1. Pinned branch / SHA

| Item | Value |
|------|-------|
| Branch | `feat/sunset-multitenant-luna` |
| Pinned SHA (portal + seed runner) | `25518554bcf635b59c594dae8f930c0190609209` |
| Portal Slice 1 runtime minimum | `251b4095d49eec170de793f1b8a00edd9f4eb74c` |
| PR title | Add isolated Sunset offline foundation and read-only portal slice |

**Captain:** confirm SHA at deploy time; record in Sunset staging deploy log (separate from Wolfhouse logs).

---

## 2. Isolated Sunset staging target (only valid deploy surface)

| Item | Value |
|------|-------|
| **Resource group** | `luna-sunset-staging-rg` |
| **Container App** | `luna-sunset-staging-staff-api` *(or `sunset-staging-staff-api` — confirm at infra setup)* |
| **Portal URL** | `https://sunset-staging.lunafrontdesk.com` |
| **Staff API health** | `https://sunset-staging.lunafrontdesk.com/healthz` |
| **Postgres** | **Dedicated Sunset staging DB** (own server/database; name TBD at infra setup) |
| **Tenant scope** | `client_slug=sunset` / `tenant_id=sunset` only |

### Explicitly NOT Sunset deploy targets (forbidden)

| Item | Status |
|------|--------|
| `wh-staging-staff-api` | **FORBIDDEN** for Sunset |
| `wh-staging-rg` | **FORBIDDEN** for Sunset deploy |
| `staff-staging.lunafrontdesk.com` | **FORBIDDEN** for Sunset validation |
| `wh-staging-pg-app` / `wolfhouse_staging` | **FORBIDDEN** for Sunset seed DB |
| Production hosts | **FORBIDDEN** |

### Explicitly NOT affected by this packet

| Service | Action |
|---------|--------|
| Wolfhouse Staff API staging (`wh-staging-staff-api`) | **No deploy, no update, no overwrite** |
| `staff-staging.lunafrontdesk.com` | **No Sunset validation here** |
| Production | **No touch** |
| Hermes / Luna SOUL | **No deploy, no edit** |
| WhatsApp runtime | **No change** |
| n8n (Wolfhouse staging) | **No deploy** |
| DB migrations (Slice 1) | **None** |

---

## 3. Preflight checks (code — run before any infra/deploy)

On worktree `/opt/luna/Luna-Sunset` @ pinned SHA:

```bash
npm run verify:sunset-all
npm run verify:sunset-portal-slice1
node scripts/fixtures/sunset-portal-slice1-seed.js          # dry-run
node scripts/fixtures/sunset-portal-slice1-cleanup.js       # dry-run
npm run verify:sunset-portal-slice1-seed-runner
git status --short   # no M on tracked paths
```

| Check | Expected |
|-------|----------|
| `verify:sunset-all` | **7/7 PASS** |
| `verify:sunset-portal-slice1` | **25/25 PASS** |
| Seed/cleanup dry-run | **No writes/deletes** |
| `verify:sunset-portal-slice1-seed-runner` | **37/37 PASS** |
| `verify:luna-golden` | **Excluded** (`VERIFY-LUNA-GOLDEN-DB-NOTE.md`) |

**Post-deploy health (Sunset staging only — after §4 infra exists):**

```bash
curl -s https://sunset-staging.lunafrontdesk.com/healthz
# expect: status ok
```

---

## 4. New infra required before deploy (discovery/setup — not run by this packet)

**There is no existing repo script for Sunset isolated staging.** Infra must be created/confirmed **before** Staff API deploy. Captain signs checkbox §11 #1 first.

### Required setup items (Ops discovery checklist)

- [ ] **Resource group:** create/confirm `luna-sunset-staging-rg`
- [ ] **ACR / image strategy:** dedicated image repo or tagged images (e.g. `lunastagingacr.azurecr.io/luna-sunset-staff-api:<tag>`) — confirm naming with Captain
- [ ] **Container Apps environment:** create/confirm env within `luna-sunset-staging-rg`
- [ ] **Container App:** create/confirm `luna-sunset-staging-staff-api` (or `sunset-staging-staff-api`)
- [ ] **Sunset staging Postgres:** create/confirm dedicated server + database (not `wolfhouse_staging`)
- [ ] **Key Vault / secrets:** Sunset DB URL, `staff-session-secret`, Stripe test keys (if needed), `WHATSAPP_DRY_RUN=true`, `STAFF_ACTIONS_ENABLED=false`
- [ ] **DNS / TLS:** CNAME + managed cert for `sunset-staging.lunafrontdesk.com`
- [ ] **Health endpoint:** `GET /healthz` returns 200 on Sunset URL
- [ ] **Config in image:** `config/clients/sunset.baseline.json`, `staff-portal-access.json` (Sunset-scoped access)
- [ ] **Migrations:** apply required schema to **Sunset DB only** (Captain approval; resolve migration-015 gap per `VERIFY-LUNA-GOLDEN-DB-NOTE.md` if fresh DB)
- [ ] **`clients.slug=sunset` row** on Sunset DB (before seed)

### Candidate deploy sequence (placeholder — **after infra exists**)

Ops must author a Sunset-specific runbook. Illustrative pattern only — **do not run without checkbox #2**:

```bash
git checkout 25518554bcf635b59c594dae8f930c0190609209

# Build image (ACR name TBD at infra setup)
# az acr build --registry <SUNSET_ACR> \
#   --image luna-sunset-staff-api:2551855-slice1 \
#   --file Dockerfile .

# Deploy ONLY to Sunset Container App — verify RG/name before run
# az containerapp update \
#   --resource-group luna-sunset-staging-rg \
#   --name luna-sunset-staging-staff-api \
#   --image <SUNSET_ACR>.azurecr.io/luna-sunset-staff-api:2551855-slice1

curl -s https://sunset-staging.lunafrontdesk.com/healthz
```

**This packet does not run `az` create/update commands.**

---

## 5. Allowlist flip — Sunset staging DB only (separate approval)

### Current seed runner behavior (SHA `2551855`)

- Dry-run by default; `--execute` requires `ALLOW_SUNSET_DEMO_SEED=1`
- **Rejects** Wolfhouse staging DB (`wh-staging-pg-app`), production, and generic `*staging*` / `*.azure.com` hosts
- **Allows only** localhost/test until patched

### Captain must approve ONE path (checkbox §11 #3 — separate from deploy)

| Option | Description |
|--------|-------------|
| **A. Sunset hostname allowlist** | Add **only** the dedicated Sunset Postgres host (e.g. `luna-sunset-staging-pg.postgres.database.azure.com`) to `sunset-portal-slice1-guards.js` + verifier |
| **B. Env-gated override** | `SUNSET_DEMO_SEED_STAGING_DB_ALLOW=1` + exact Sunset DB hostname match; still rejects `wh-staging-pg-app` and production |

**Must NOT allowlist `wh-staging-pg-app` or `wolfhouse_staging`.**

---

## 6. Config-only smoke — `sunset-staging.lunafrontdesk.com` (before seed)

Login: `https://sunset-staging.lunafrontdesk.com/staff/login`  
Use Sunset-scoped staff access (configure at infra setup; may differ from Wolfhouse `all_clients_emails`).

### Sunset portal (`client=sunset`)

- [ ] Portal loads; auth succeeds
- [ ] **Default tab** is **WhatsApp** (`conversations`)
- [ ] **Booking Calendar** tab **hidden**
- [ ] **Tour Operator** tab **hidden**
- [ ] **Day Schedule** tab **visible**
- [ ] Demo lesson slot tiles from `portal_demo.lesson_slots` (e.g. `2026-07-10`)
- [ ] Lessons/rentals tables **may be empty** (pre-seed) — OK
- [ ] Inbox **may be empty** (pre-seed) — OK
- [ ] **No Wolfhouse leakage:** no bed calendar, room codes, `wolfhouse-somo` data on Sunset URL

### Wolfhouse regression

**Not required on Sunset isolated URL.** Wolfhouse staging on `staff-staging.lunafrontdesk.com` must remain **unchanged** — spot-check separately if desired; **out of scope** for this packet.

**Gate:** §6 must pass on `sunset-staging.lunafrontdesk.com` before seed `--execute` approval.

---

## 7. Seed `--execute` — Sunset staging DB only (separate approval)

```bash
export ALLOW_SUNSET_DEMO_SEED=1
export WOLFHOUSE_DATABASE_URL='postgres://<user>:<pass>@<SUNSET_PG_HOST>:5432/<SUNSET_DB>?sslmode=require'
# <SUNSET_PG_HOST> = dedicated Sunset staging host ONLY (after §5 allowlist)

node scripts/fixtures/sunset-portal-slice1-seed.js --execute
```

### Pre-flight abort checks (Ops)

- [ ] DB host is **Sunset staging** — not `wh-staging-pg-app`
- [ ] Database name is **not** `wolfhouse_staging`
- [ ] Anti-Wolfhouse guard § passes

### Expected row counts (dry-run)

| Table | Count |
|-------|-------|
| `conversations` | 2 |
| `messages` | 8 |
| `bookings` | 3 |
| `booking_service_records` | 4 |
| `staff_handoffs` | 1 |
| `payments` | 0 |

**Tag:** `sunset_demo_slice1` · **No Stripe links** · **tenant `sunset` only**

---

## 8. Post-seed smoke — Sunset isolated staging

On `https://sunset-staging.lunafrontdesk.com`:

- [ ] Inbox: Alex + Maria demo conversations
- [ ] Day Schedule `2026-07-10`–`12`: lessons + gear rows
- [ ] No Wolfhouse room/bed/package UI
- [ ] Only `sunset_demo_slice1` demo content

### Sunset DB leakage SQL (Sunset DB only)

```sql
-- All sunset_demo_slice1 rows must be sunset-scoped
SELECT COUNT(*) FROM booking_service_records
 WHERE metadata->>'source' = 'sunset_demo_slice1' AND client_slug <> 'sunset';
-- must be 0

SELECT COUNT(*) FROM booking_service_records
 WHERE client_slug = 'wolfhouse-somo';
-- expect 0 on isolated Sunset DB (no Wolfhouse tenant)
```

**Wolfhouse staging DB:** must receive **zero** Sunset seed writes (isolated DB — verify host before execute).

**Gate:** Post-seed smoke passes before merge checkbox.

---

## 9. Cleanup and rollback (Sunset staging only)

```bash
export ALLOW_SUNSET_DEMO_SEED=1
export WOLFHOUSE_DATABASE_URL='<SUNSET_STAGING_DB_URL_AFTER_ALLOWLIST>'

node scripts/fixtures/sunset-portal-slice1-cleanup.js --execute
```

Deletes **only** `sunset_demo_slice1` tagged rows on **Sunset DB**.

### Staff API rollback (Sunset Container App only)

```bash
# az containerapp revision list \
#   --name luna-sunset-staging-staff-api \
#   --resource-group luna-sunset-staging-rg -o table
# Roll traffic to previous revision — NEVER wh-staging-staff-api
```

### Wolfhouse staging rollback

**Not applicable** — Sunset deploy must not have touched Wolfhouse staging.

### Production

**No action.**

---

## 10. Validation sequence (retargeted)

| Step | Target | Approval |
|------|--------|----------|
| 1. Preflight | Lunabox worktree | Automatic |
| 2. Create/confirm infra | `luna-sunset-staging-rg` | Checkbox #1 |
| 3. Deploy Staff API | `sunset-staging.lunafrontdesk.com` only | Checkbox #2 |
| 4. Config-only smoke | Sunset URL | Before seed |
| 5. Allowlist flip | Sunset DB host only | Checkbox #3 |
| 6. Seed `--execute` | Sunset DB only | Checkbox #4 |
| 7. Post-seed smoke | Sunset URL + Sunset DB | Before merge |
| 8. Cleanup (if needed) | Sunset DB only | Checkbox #5 |
| 9. Merge | `feat/sunset-multitenant-luna` → master | Checkbox #6 |

---

## 11. Captain approval checkboxes

```
[ ] 1. CREATE / CONFIRM ISOLATED SUNSET STAGING INFRA
    Approve provisioning luna-sunset-staging-rg, Sunset Container App,
    dedicated Sunset Postgres, Key Vault secrets, DNS for
    sunset-staging.lunafrontdesk.com.
    MUST NOT use wh-staging-rg or wh-staging-staff-api.

[ ] 2. DEPLOY STAFF API TO SUNSET STAGING ONLY
    Approve deploying SHA 25518554bcf635b59c594dae8f930c0190609209
    to luna-sunset-staging-staff-api (luna-sunset-staging-rg) only.
    URL: https://sunset-staging.lunafrontdesk.com
    Preflight §3 passed. Anti-Wolfhouse guard § verified.

[ ] 3. APPROVE SUNSET STAGING DB ALLOWLIST
    Approve allowlist change (§5) for dedicated Sunset Postgres host ONLY.
    MUST NOT allowlist wh-staging-pg-app or wolfhouse_staging.

[ ] 4. RUN SEED --execute AGAINST SUNSET STAGING DB
    Approve after §6 config smoke on sunset-staging.lunafrontdesk.com.
    ALLOW_SUNSET_DEMO_SEED=1 + --execute. Sunset DB only.

[ ] 5. RUN CLEANUP IF NEEDED
    Approve cleanup --execute on Sunset DB only (sunset_demo_slice1 tag).

[ ] 6. PROCEED TO MERGE
    Approve merge ONLY AFTER isolated Sunset staging smoke passes (§6 + §8).
    Merge remains held until this box is checked.
```

**Default:** All unchecked = **no staging action**.

---

## 12. Summary

| Phase | Blocked until |
|-------|----------------|
| Sunset infra setup | Checkbox #1 |
| Sunset Staff API deploy | Checkbox #2 |
| Sunset DB allowlist | Checkbox #3 |
| `seed --execute` | #3 + #4 + §6 smoke |
| Merge | Checkbox #6 |
| Wolfhouse staging | **Never targeted by this packet** |
| Production | **Always forbidden** |

Portal Slice 1 code is ready @ `2551855`. **New isolated infra is required** before any deploy to `sunset-staging.lunafrontdesk.com`. Wolfhouse staging (`staff-staging.lunafrontdesk.com`) must remain untouched.

---

*Packet version: 2.0 — 2026-06-19 — isolated Sunset staging*
