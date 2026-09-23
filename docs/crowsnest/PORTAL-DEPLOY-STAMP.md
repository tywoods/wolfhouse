# Staff portal deploy stamps (Clients “Updated”)

Crow’s Nest Clients shows **Updated … ago · rev** next to Staff staging /
production from a **stored deploy stamp**, not from Azure Container Apps
revision APIs. No Reader RBAC on Staff apps is required.

## Why

PR #1149 originally read ACA active-revision `createdTime` via managed
identity. Crow’s Nest MI cannot get Reader on Staff apps (`AuthorizationFailed`).
Deploy stamps replace that: after each successful Staff deploy, Skipper (or the
deploy script) writes the deploy moment + short rev into Crow’s Nest storage.

## Endpoint

| | |
|---|---|
| **URL** | `https://crowsnest.lunafrontdesk.com/api/portal-deploy-stamp` |
| **Methods** | `PUT` or `POST` |
| **Auth** | `Authorization: Bearer $CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN` |
| **Visibility** | Route returns **404** until the token env is set on `crowsnest-internal` |

### Example payload

```json
{
  "client": "wolfhouse-somo",
  "environment": "staging",
  "revision": "4de7069",
  "updated_at": "2026-09-23T05:10:00.000Z"
}
```

| Field | Required | Notes |
|---|---|---|
| `client` | yes | Directory id: `wolfhouse-somo` or `sunset-somo` |
| `environment` | yes | `staging` or `production` |
| `revision` | yes | Short git SHA, ACA `--0000525`, or full revision name |
| `updated_at` | no | ISO UTC; defaults to Crow’s Nest server time |
| `image_tag` | no | Optional short image tag for tooltip only |

### Curl (Skipper handoff)

After a successful Staff **staging** deploy for Wolfhouse:

```bash
curl -sS -X PUT 'https://crowsnest.lunafrontdesk.com/api/portal-deploy-stamp' \
  -H "Authorization: Bearer ${CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"client\":\"wolfhouse-somo\",\"environment\":\"staging\",\"revision\":\"${GIT_SHA:0:7}\",\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
```

Sunset staging:

```bash
curl -sS -X PUT 'https://crowsnest.lunafrontdesk.com/api/portal-deploy-stamp' \
  -H "Authorization: Bearer ${CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"client\":\"sunset-somo\",\"environment\":\"staging\",\"revision\":\"${GIT_SHA:0:7}\"}"
```

Wolfhouse production:

```bash
curl -sS -X PUT 'https://crowsnest.lunafrontdesk.com/api/portal-deploy-stamp' \
  -H "Authorization: Bearer ${CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"client\":\"wolfhouse-somo\",\"environment\":\"production\",\"revision\":\"${GIT_SHA:0:7}\"}"
```

Call this **once per portal environment** after that Staff deploy succeeds. Do not
redeploy Staff solely to refresh the stamp.

## Crow’s Nest env

| Env | Purpose |
|---|---|
| `CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN` | Bearer token for the write path (required to enable the route) |
| `CROWSNEST_PORTAL_DEPLOY_STAMP_PATH` | Optional JSON file path for persistence across process restarts |

Without a file path, stamps live in process memory (survive until Crow’s Nest
restarts; next Staff deploy re-stamps). Missing stamps omit the Updated line —
Clients and status dots still render.

**Removed / unused:** `CROWSNEST_PORTAL_DEPLOY_AZURE_SUBSCRIPTION_ID`,
`CROWSNEST_PORTAL_DEPLOY_AZURE_MANAGED_IDENTITY_CLIENT_ID`, and any ACA Reader
role assignment for this UI.

## Admitted portals

| Client | Environment | Origin |
|---|---|---|
| `wolfhouse-somo` | staging | `https://staff-staging.lunafrontdesk.com` |
| `sunset-somo` | staging | `https://sunset-staging.lunafrontdesk.com` |
| `wolfhouse-somo` | production | `https://wolfhouse.lunafrontdesk.com` |
| `sunset-somo` | production | `https://sunset.lunafrontdesk.com` |

## Verify

```bash
node scripts/verify-crowsnest-client-portal-deploy.js
npm run verify:crowsnest-client-portal-deploy
```

## Seed (optional one-shot)

Stamps start blank until the first POST after merge. To backfill:

```bash
# Example — replace revision/time with the known Staff image SHA / deploy moment
curl -sS -X PUT 'https://crowsnest.lunafrontdesk.com/api/portal-deploy-stamp' \
  -H "Authorization: Bearer ${CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"client":"wolfhouse-somo","environment":"staging","revision":"REPLACE_ME","updated_at":"2026-09-22T12:00:00.000Z"}'
```

Repeat for `sunset-somo` staging and `wolfhouse-somo` production as needed.
