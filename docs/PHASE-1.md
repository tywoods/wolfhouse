# Phase 1 — Local Postgres mirror (read-only from exports)

**Scope:** Load your Airtable **CSV exports** into local Docker Postgres.  
**Does not:** Call hosted Airtable API, change hosted n8n, WhatsApp, or Azure.

## Prerequisites (Phase 0 done)

- Docker containers running (`wolfhouse-postgres`, etc.)
- `infra/.env` configured
- Hostel / rooms / beds seeded (docker init or `001_wolfhouse_seed.sql`)

## Step 1 — Fix package pricing migration

If your earlier run showed `ROLLBACK` / `missing FROM-clause entry for table "v"`, re-run the fixed file:

**Option A — Docker (no Node install on Windows):**

```powershell
cd C:\Users\tywoo\Desktop\WH
Get-Content database\migrations\002_package_pricing.sql | docker exec -i wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

**Option B — Node on PATH:**

```powershell
cd C:\Users\tywoo\Desktop\WH
npm install
npm run db:migrate:pricing
```

Verify:

```powershell
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT COUNT(*) FROM package_price_rules;"
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse -c "SELECT package_stay_total_per_person_eur(249, 3);"
```

Expect **9** rules and **110** for Malibu 3 nights.

## Step 2 — Sync CSVs → Postgres

Whenever you refresh exports from Airtable, copy CSVs into `database/` then:

**Option A — Docker tools container:**

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools sh -c "npm install && npm run db:sync"
```

**Option B — local npm:**

```powershell
npm run db:sync
```

Imports:

| CSV | Postgres table |
|-----|----------------|
| Bookings-Grid view.csv | bookings |
| Booking Beds-Active Bed Assignments.csv | booking_beds |
| Conversations-Grid view.csv | conversations |
| Messages-Grid view.csv | messages |

Also sets `airtable_record_id` from `WH-{id}` booking codes and logs `workflow_events`.

## Step 3 — Verify

```powershell
docker compose -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools sh -c "npm install && npm run db:verify"
```

(or `npm run db:verify` if Node is installed locally)

## Optional — Browse data

- **pgAdmin** or **DBeaver** → connect `localhost:5433`, db `wolfhouse`, user/password from `infra/.env`
- Or psql:

```powershell
docker exec -it wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

```sql
SELECT booking_code, status, check_in, check_out FROM bookings;
SELECT assignment_label, bed_code FROM booking_beds LIMIT 10;
```

## Phase 1 complete when

- [ ] `package_price_rules` has 9 rows  
- [ ] `npm run db:verify` passes  
- [ ] You can see bookings + bed assignments in Postgres  
- [ ] Hosted Airtable/n8n still unchanged  

## Next (Phase 2 — later)

Stripe test mode on **new** n8n only — still no hosted changes.
