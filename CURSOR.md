# Cursor agent guide — Wolfhouse (`WH`)

Read this at the start of a session. **Current state:** [docs/PROJECT-STATE.md](docs/PROJECT-STATE.md). **Direction:** [docs/ARCHITECTURE-NORTH-STAR.md](docs/ARCHITECTURE-NORTH-STAR.md).

---

## What this repo is

**Wolfhouse Booking Assistant** — hospitality booking automation: WhatsApp guest AI, holds, Stripe, confirmations, bed ops, manual entries, operator room release. Migrating from **Airtable-primary + n8n** to **Postgres-first** with n8n as integration glue.

**You are in:** Phase **3c** (Main Postgres integration). Phase **3c.c.4 is complete** (`8abfd4d`). Phase **3c.c CLI/script work is nearly done.**

**Preferred next task:** **3c.d** — conversation / `current_hold_booking_id` plan (read-only discovery first). **Not** 3c.c.4. **Not** 3c.e workflow injection unless owner explicitly skips 3c.d.

---

## Evolution order (do not skip)

1. Correct and safe ← **now**
2. Reliable
3. Clean
4. Beautiful
5. Scalable (includes Azure/production)

**Do not** treat Azure deployment, production cutover, or product UI as the immediate next step.

---

## Session checklist

```powershell
cd C:\Users\tywoo\Desktop\WH
git log -1 --oneline
git status --short
```

Before recommending a commit:

```powershell
git diff --stat
git diff --cached --name-status
```

Only commit when the user explicitly asks and tests passed.

---

## Behavior rules

| Rule | Detail |
|------|--------|
| Small verified steps | Plan → run → evidence → then change |
| Verify before fixing | Read code/docs; don’t guess schema or workflow wiring |
| Short outputs | Files changed, commands, pass/fail, key evidence, git status, one recommendation |
| Full replacements | If giving code, provide complete file or block — not “…” snippets |
| n8n nodes | If adding nodes: type, name, credentials, query/body, exact wiring |
| Generated workflows | Edit **build script** → regenerate JSON → `--verify-targets` → import **inactive** only if allowed |
| No hand-editing | Don’t hand-edit generated `n8n/phase2/*.json` unless explicitly told |
| Hosted exports | Don’t modify `n8n/Wolfhouse*.json` hosted copies |
| Failed tests | Stop and report; no guess-fix chains unless fix is trivial and re-verified |

---

## Stop without explicit approval

- Workflow **activation** or publishing  
- **Webhook** tests against live paths  
- Postgres **writes** (except approved `--execute` CLIs / fixtures)  
- **Airtable** or **Google Sheets** writes  
- **`payments`** / **`payment_events`** changes  
- **Stripe Webhook Handler** or **Send Confirmation** changes  
- **Cleanup/deletion** of real data  
- **`build-main-local-stripe.js`** / Main workflow JSON ( **3c.e** )  
- **Azure** / deployment / DNS / production URLs  
- Starting **3c.f**, **3c.g**, or **Phase 4** cutover  

---

## Safe to combine when the prompt allows

- Docs-only changes  
- Read-only scripts and inventory reports  
- Reversible local SQL fixtures  
- SELECT-only reports  
- Generated workflow JSON (inactive) + verify-targets  
- Commits after explicit pass + user request  

---

## Protected policies

### Payments

Only **Stripe Webhook Handler** writes payment truth. Main, Manual Entries, Operator Room Release, Assign, Reassign, Cancel must **not** write `payments` / `payment_events`.

### Airtable

Temporary mirror/reference only — never deepen as source of truth.

### Main local fork

- Path: `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json`  
- Build: `npm run build:main:local-stripe` / `scripts/build-main-local-stripe.js`  
- **Do not run Main** until targets neutralized and testing approved  

### 3c.c CLIs (bookings only)

| Script | Role |
|--------|------|
| `db:report:main-availability` | SELECT availability |
| `db:report:main-hold-plan` | Hold plan |
| `db:main-hold:postgres` | Hold upsert (`--execute`) |
| `db:report:main-ensure-booking-plan` | Ensure promote plan |
| `db:main-ensure-booking:postgres` | Ensure promote (`--execute`) |

Default: **dry-run**. No `booking_beds`. Never set `send_confirmation=true` in these paths.

---

## Docker tools profile

When host `npm`/`node` is missing or env must match containers:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run <script> -- <args>
```

Postgres fixtures:

```powershell
Get-Content scripts/fixtures/<file>.sql | docker compose -f infra/docker-compose.local.yml exec -T wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

---

## Phase map (short)

| Phase | Status |
|-------|--------|
| 2 local | Frozen |
| 3b bed-ops, manual, ORR | Frozen (`de26bd4`) |
| 3c.a–b | Done |
| 3c.c.1–4 | Done (`8abfd4d`) |
| **3c.d** | **Next (preferred)** |
| 3c.e | Main PG inject + regenerate fork |
| 3c.f–g | Contract checks + E2E sign-off |
| Azure / Phase 4 | After 3c + reliability + cleanup |

---

## Key files

| Path | Role |
|------|------|
| `scripts/build-main-local-stripe.js` | Main fork generator (3c.e) |
| `scripts/lib/main-booking-hold-pg-sql.js` | Hold SQL |
| `scripts/lib/main-ensure-booking-pg-sql.js` | Ensure promote SQL |
| `docs/PHASE-3c-c.md` | 3c.c runbook |
| `docs/PHASE-3b-FREEZE.md` | Prior phase sign-off |
| `infra/docker-compose.local.yml` | Local stack |

---

## Report template (end of task)

1. Files changed  
2. Commands run + pass/fail  
3. Key evidence  
4. `git status` / `git diff --stat`  
5. One recommended next step  
