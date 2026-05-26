# Azure n8n Hosting Plan (Queue Mode)

## Goals

- Self-host n8n on Azure with **queue mode** (Redis + worker containers)
- Separate **n8n system Postgres** from **Wolfhouse app Postgres**
- Keep webhook paths stable for WhatsApp, Stripe, Apps Script
- Secrets only in Key Vault / Container Apps secret refs

## Container Apps — n8n main container

| Variable | Value |
|----------|-------|
| `EXECUTIONS_MODE` | `queue` |
| `DB_TYPE` | `postgresdb` |
| `DB_POSTGRESDB_HOST` | `<n8n-postgres-fqdn>` |
| `DB_POSTGRESDB_SSL` | `true` |
| `QUEUE_BULL_REDIS_HOST` | `<redis-host>` |
| `QUEUE_BULL_REDIS_PORT` | `6380` (TLS port for Azure Cache) |
| `QUEUE_BULL_REDIS_PASSWORD` | from Key Vault |
| `N8N_ENCRYPTION_KEY` | from Key Vault — **set once** |
| `WEBHOOK_URL` | `https://automation.wolf-house.com/` (example) |
| `N8N_PROTOCOL` | `https` |
| `GENERIC_TIMEZONE` | `Europe/Madrid` |
| `WOLFHOUSE_DATABASE_URL` | app DB connection string (for Postgres nodes) |

**Ingress:** HTTPS only, min 1 replica, health probe on `/healthz` if enabled.

## Container Apps — n8n worker

Same image, command override: `worker`

| Setting | Recommendation |
|---------|------------------|
| Min replicas | 2 (production) |
| Max replicas | 5 |
| CPU / memory | 1 vCPU / 2 GiB per worker (tune from execution metrics) |
| Scale rule | Redis queue depth or CPU > 70% |

Workers do **not** need public ingress.

## PostgreSQL

### Server A — `n8n-system`

- Database: `n8n`
- Used for: workflows, credentials (encrypted), execution data
- Backup: 7–35 day PITR per compliance

### Server B — `wolfhouse-app` (or database on same server)

- Database: `wolfhouse`
- Schema from `database/migrations/001_init.sql`
- Seed: `database/seeds/001_wolfhouse_seed.sql`
- App connections: n8n Postgres nodes, future read-only BI

**Firewall:** deny public access; allow Container Apps outbound IPs or VNet integration.

## Redis

Azure Cache for Redis with:

- TLS enabled
- `maxmemory-policy` = `noeviction` (queue integrity)
- Private endpoint where possible

## Networking & domains

| Endpoint | Points to |
|----------|-----------|
| `automation.wolf-house.com` | n8n Container App ingress |
| `api.stripe.com` | outbound from n8n |
| `graph.facebook.com` | outbound WhatsApp |

Update Meta WhatsApp webhook URL when DNS cutover completes.

## Local development steps

1. Install Docker Desktop.
2. `cp infra/.env.example infra/.env` and set passwords + `N8N_ENCRYPTION_KEY`.
3. From repo root:
   ```bash
   docker compose -f infra/docker-compose.local.yml up -d
   ```
4. Open http://localhost:5678 — create owner account.
5. Import workflows from `n8n/` (copy, do not edit originals).
6. Configure credentials (Airtable, Anthropic, WhatsApp, Google).
7. Apply migrations if initdb did not run:
   ```bash
   docker exec -i wolfhouse-postgres psql -U wolfhouse -d wolfhouse < database/migrations/001_init.sql
   docker exec -i wolfhouse-postgres psql -U wolfhouse -d wolfhouse < database/seeds/001_wolfhouse_seed.sql
   ```
8. Test webhook locally with ngrok:
   ```bash
   ngrok http 5678
   ```
   Set `N8N_WEBHOOK_URL` to ngrok HTTPS URL.

## Production deployment checklist

- [ ] Postgres migrated + seeded
- [ ] Redis reachable from main + workers
- [ ] `N8N_ENCRYPTION_KEY` backed up securely
- [ ] Workflows imported; credentials mapped
- [ ] Webhook paths match `docs/webhook-map.md`
- [ ] Stripe webhook signing secret configured
- [ ] Meta WhatsApp verify token + signature check
- [ ] Apps Script URL updated to Azure domain
- [ ] Airtable automations updated (dual-write phase)
- [ ] Error handler workflow writes `automation_errors`
- [ ] Application Insights alert on failed executions
- [ ] Regression tests passed (`docs/regression-test-plan.md`)

## Rollback

Keep n8n Cloud instance **inactive but exportable** for 2 weeks. DNS flip back to `tywoods.app.n8n.cloud` if Azure fails.

## Operations cadence

| Task | Frequency |
|------|-----------|
| Postgres backup verify | Weekly |
| Review `automation_errors` open rows | Daily (season) |
| n8n version upgrade | Monthly (staging first) |
| Redis memory check | Weekly |
