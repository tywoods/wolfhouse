# Sunset Portal Slice 1 — Staging Approval Packet

**Status:** AWAITING CAPTAIN SIGN-OFF — no staging action until checkboxes below are approved in writing  
**Date:** 2026-06-19  
**Branch:** `feat/sunset-multitenant-luna`  
**Pinned SHA:** `25518554bcf635b59c594dae8f930c0190609209`  
**PR title:** Add isolated Sunset offline foundation and read-only portal slice  
**Merge policy:** PR approved; **do not merge** until staging validation passes.

---

## ⛔ Global gate

**Deckhand/Cursor/Ops must not deploy, seed, widen DB allowlist, or merge until Captain signs the relevant checkboxes in §10.**

This packet authorizes planning only. Performing any staging action without sign-off is forbidden.

---

## 1. Pinned branch / SHA

| Item | Value |
|------|-------|
| Branch | `feat/sunset-multitenant-luna` |
| Pinned SHA | `25518554bcf635b59c594dae8f930c0190609209` |
| Commit message | `feat(sunset): add dry-run portal seed runner` |
| Portal Slice 1 runtime minimum | `251b4095d49eec170de793f1b8a00edd9f4eb74c` (`feat(sunset): add read-only portal slice 1`) |
| Seed runner | `2551855` (this SHA) |
| PR title | Add isolated Sunset offline foundation and read-only portal slice |

**Captain:** confirm this SHA at deploy time and record it in the deploy log.

---

## 2. Exact services affected

| Service | Action |
|---------|--------|
| **Staff API (staging)** | **Deploy only** — new container image from pinned SHA |
| **URL** | `https://staff-staging.lunafrontdesk.com` |
| Azure Container App | `wh-staging-staff-api` (resource group `wh-staging-rg`) |
| Staging Postgres (app) | **Read for smoke; write only after separate seed approval** — `wh-staging-pg-app` / `wolfhouse_staging` |

**Explicitly NOT affected:**

| Service | Action |
|---------|--------|
| Production Staff API / production DB | **No touch** |
| Hermes gateway / `docker/hermes-staging/SOUL.md` | **No deploy, no edit** |
| WhatsApp / Meta runtime | **No change** (`WHATSAPP_DRY_RUN=true` on staging) |
| n8n workers | **No deploy** |
| Database migrations | **None for Slice 1** |

---

## 3. Preflight checks (run at pinned SHA before deploy)

Execute on deploy worktree `/opt/luna/Luna-Sunset` @ `2551855`:

```bash
npm run verify:sunset-all
npm run verify:sunset-portal-slice1
node scripts/fixtures/sunset-portal-slice1-seed.js          # dry-run
node scripts/fixtures/sunset-portal-slice1-cleanup.js       # dry-run
npm run verify:sunset-portal-slice1-seed-runner
git status --short   # tracked files only: no M on committed paths
```

| Check | Expected (2026-06-19) |
|-------|------------------------|
| `verify:sunset-all` | **7/7 PASS** |
| `verify:sunset-portal-slice1` | **25/25 PASS** |
| Seed dry-run | Prints `DRY-RUN`, planned counts, **no writes** |
| Cleanup dry-run | Prints `DRY-RUN`, **no deletes** |
| `verify:sunset-portal-slice1-seed-runner` | **37/37 PASS** |
| Tracked files clean | No modified tracked files; untracked agent files OK |
| `verify:luna-golden` | **Excluded** — documented Lunabox policy (`docs/sunset/VERIFY-LUNA-GOLDEN-DB-NOTE.md`); not a Slice 1 blocker |

**Post-deploy health (before smoke):**

```bash
curl -s https://staff-staging.lunafrontdesk.com/healthz
# expect: status ok
```

---

## 4. Staff API deploy step

### Known repo facts

- Staff API image built from root `Dockerfile` → `npm run staff:api` → `scripts/staff-query-api.js`
- Staging image name (IaC): `whstagingacr.azurecr.io/wh-staff-api:<tag>`
- Container App: `wh-staging-staff-api` in `wh-staging-rg`
- **No `npm run deploy:staff-staging` script exists** in this branch (only `deploy:hermes-staging` for Hermes)

### Candidate deploy sequence (Ops — **not run by this packet**)

Captain/Ops must confirm the live procedure against current Azure access. Candidate pattern from `infra/azure/staging/README.md`:

```bash
# 1. Checkout pinned SHA
git fetch origin feat/sunset-multitenant-luna
git checkout 25518554bcf635b59c594dae8f930c0190609209

# 2. Build and push Staff API image (confirm registry login + az context)
az acr build --registry whstagingacr \
  --image wh-staff-api:2551855-sunset-slice1 \
  --file Dockerfile .

# 3. Update staging Container App to new image
az containerapp update \
  --resource-group wh-staging-rg \
  --name wh-staging-staff-api \
  --image whstagingacr.azurecr.io/wh-staff-api:2551855-sunset-slice1

# 4. Verify revision + healthz
az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o table
curl -s https://staff-staging.lunafrontdesk.com/healthz
```

### Must be discovered before Captain approves deploy

- [ ] Confirmed Azure subscription + `az login` identity for Ops
- [ ] Confirmed `wh-staging-rg` / `wh-staging-staff-api` still active
- [ ] Confirmed ACR build context includes `config/clients/sunset.baseline.json` in image
- [ ] Confirmed canonical deploy command (may differ from candidate above)
- [ ] Recorded **pre-deploy image digest/revision** for rollback

**This packet does not perform deploy.**

---

## 5. Allowlist flip — separate explicit approval

### Current behavior (SHA `2551855`)

Seed/cleanup `--execute` is **fail-closed**:

- Requires `ALLOW_SUNSET_DEMO_SEED=1` **and** `--execute`
- **Rejects** staging DB hosts (`wh-staging-pg-app.postgres.database.azure.com`, `*staging*`, `*.azure.com`, `lunafrontdesk.com`)
- **Allows only** localhost/test hosts (`localhost`, `127.0.0.1`, `*.test`, etc.)

Therefore: **Staff API deploy alone does not enable staging seed.** A code or config change is required before `seed --execute` can target staging Postgres.

### Captain must approve ONE path (separate from deploy checkbox)

| Option | Description |
|--------|-------------|
| **A. Code allowlist patch** | Add explicit staging host allowlist entry in `scripts/fixtures/sunset-portal-slice1-guards.js` (e.g. `wh-staging-pg-app.postgres.database.azure.com` only) + new verifier assertions |
| **B. Env-gated override** | New env `SUNSET_DEMO_SEED_STAGING_DB_ALLOW=1` + fixed hostname match; still rejects production |

**This approval is separate from Staff API deploy.** Captain signs §10 checkbox #2 before any allowlist change or staging seed.

---

## 6. Config-only smoke (after deploy, **before** seed `--execute`)

Login: `https://staff-staging.lunafrontdesk.com/staff/login`  
Staff email: `tywoods@gmail.com` (`all_clients_emails` — sees Wolfhouse + Sunset)

### Sunset (`client=sunset`)

- [ ] Select **Sunset Surf School** in client dropdown
- [ ] **Default tab** is **WhatsApp** (`conversations`) — not Booking Calendar
- [ ] **Booking Calendar** tab is **hidden**
- [ ] **Tour Operator** tab is **hidden**
- [ ] **Day Schedule** tab is **visible**
- [ ] Day Schedule shows **demo lesson slot tiles** from `portal_demo.lesson_slots` (config; dates e.g. `2026-07-10`)
- [ ] Lessons/rentals **tables may be empty** (no seed yet) — OK at this stage
- [ ] WhatsApp inbox **may be empty** — OK before seed

### Wolfhouse regression (`client=wolfhouse-somo`)

- [ ] Switch to Wolfhouse
- [ ] **Default tab** is **Booking Calendar**
- [ ] Booking Calendar + Tour Operator tabs **visible**
- [ ] Day Schedule tab **hidden**
- [ ] Bed calendar loads normally

**Gate:** Config-only smoke must pass before seed `--execute` approval.

---

## 7. Seed `--execute` step (separate approval — not run yet)

### Command shape (after allowlist flip + Captain approval)

```bash
# From repo @ pinned SHA — STAGING ONLY after allowlist patch deployed
export ALLOW_SUNSET_DEMO_SEED=1
export WOLFHOUSE_DATABASE_URL='postgres://<user>:<pass>@wh-staging-pg-app.postgres.database.azure.com:5432/wolfhouse_staging?sslmode=require'

node scripts/fixtures/sunset-portal-slice1-seed.js --execute
```

### Required gates

| Gate | Required |
|------|----------|
| `ALLOW_SUNSET_DEMO_SEED=1` | Yes |
| `--execute` flag | Yes |
| DB URL allowlist | Staging host **only after §5 allowlist approval** |
| `NODE_ENV` | Must not be `production` |
| Production DB | **Refused by guard** |

### Expected row counts (from dry-run @ `2551855`)

| Table | Count |
|-------|-------|
| `conversations` | 2 |
| `messages` | 8 |
| `bookings` | 3 |
| `booking_service_records` | 4 |
| `staff_handoffs` | 1 |
| `payments` | 0 |
| `booking_beds` | 0 |
| accommodation (manifest) | 0 inserted (skipped v1) |

**Tag:** `metadata.source = sunset_demo_slice1` on all rows  
**No real Stripe links** — manifest verified offline; `payment_link: null`  
**Tenant:** every row `client_slug=sunset` / `tenant_id=sunset`

### Pre-seed staging prerequisite

- [ ] `clients.slug = 'sunset'` exists on staging DB (verify; do not auto-create without Captain approval)

---

## 8. Post-seed bidirectional zero-leakage smoke

After successful `seed --execute`:

### Sunset scope (`client=sunset`)

- [ ] WhatsApp inbox shows **Alex** + **Maria** demo conversations (`demo-conv-sunset-001/002`)
- [ ] No Wolfhouse room codes (R1–R7), bed calendar, or `wolfhouse-somo` data
- [ ] Day Schedule date `2026-07-10`: lessons + gear tables show Sunset rows
- [ ] Day Schedule date `2026-07-11` / `2026-07-12`: expected service rows
- [ ] Only `sunset_demo_slice1` tagged rows visible in Sunset context

### Wolfhouse scope (`client=wolfhouse-somo`)

- [ ] Inbox unchanged — **no** Sunset demo phones (`+34 611 000 101–105`)
- [ ] Bed calendar unchanged — **no** `SUNSET-DEMO-*` booking codes
- [ ] No `sunset_demo_slice1` tagged rows in Wolfhouse views

### SQL leakage checks (Ops)

```sql
-- Must be 0
SELECT COUNT(*) FROM booking_service_records
 WHERE client_slug = 'wolfhouse-somo' AND metadata->>'source' = 'sunset_demo_slice1';

SELECT COUNT(*) FROM conversations c
 JOIN clients cl ON cl.id = c.client_id
 WHERE cl.slug = 'wolfhouse-somo' AND c.metadata->>'source' = 'sunset_demo_slice1';
```

**Gate:** Bidirectional zero-leakage must pass before merge approval.

---

## 9. Cleanup and rollback

### Cleanup command shape

```bash
export ALLOW_SUNSET_DEMO_SEED=1
export WOLFHOUSE_DATABASE_URL='<staging-url-after-allowlist>'

node scripts/fixtures/sunset-portal-slice1-cleanup.js --execute
```

Deletes **only** rows tagged `sunset_demo_slice1`. Does **not** touch `stage8_demo` Wolfhouse rows.

Dry-run preview:

```bash
node scripts/fixtures/sunset-portal-slice1-cleanup.js
```

### Staff API rollback

Redeploy pre-Slice-1 Staff API image/revision:

- Rollback target: revision/image **before** `251b409` deploy (record in deploy log)
- Candidate:

```bash
az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o table
az containerapp ingress traffic set --name wh-staging-staff-api --resource-group wh-staging-rg \
  --revision-weight <previous-revision>=100
```

### Production

**No production rollback or action required** — Slice 1 does not touch production.

---

## 10. Captain approval checkboxes

Captain: check and initial each line in writing (Slack/doc/PR comment) before Ops proceeds.

```
[ ] 1. DEPLOY STAFF API STAGING
    Approve deploying SHA 25518554bcf635b59c594dae8f930c0190609209
    to wh-staging-staff-api @ staff-staging.lunafrontdesk.com only.
    Preflight §3 passed. Deploy command confirmed by Ops.

[ ] 2. ALLOWLIST FLIP FOR STAGING DB SEED (separate from deploy)
    Approve specific allowlist change (§5 Option A or B) so seed --execute
    can target wh-staging-pg-app / wolfhouse_staging.
    Production DB remains blocked.

[ ] 3. RUN SEED --execute ON STAGING
    Approve one-time seed run after §6 config smoke passes and §2 allowlist is live.
    ALLOW_SUNSET_DEMO_SEED=1 + --execute only.

[ ] 4. RUN CLEANUP IF NEEDED
    Approve cleanup --execute only if rollback of demo data required.
    Tag sunset_demo_slice1 only.

[ ] 5. PROCEED TO MERGE
    Approve merge of feat/sunset-multitenant-luna → master ONLY AFTER:
    - §6 config smoke PASS
    - §8 post-seed zero-leakage PASS (if seed was run)
    - OR documented decision to merge deploy-only without seed (Captain explicit)
```

**Default:** All boxes unchecked = **no staging action**.

---

## 11. Summary

| Phase | Blocked until |
|-------|----------------|
| Staff API staging deploy | Checkbox #1 |
| Staging DB allowlist change | Checkbox #2 (separate) |
| `seed --execute` | Checkboxes #2 + #3 + §6 smoke |
| Merge to master | Checkbox #5 + staging validation |
| Production | **Always forbidden** for Slice 1 |

Portal Slice 1 is code-complete @ `2551855`. Staging validation is a **Staff API image update** plus optional **seed run** (blocked by localhost-only allowlist until Captain approves §5).

---

*Packet version: 1.0 — 2026-06-19*
