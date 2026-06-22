# Sunset Channel Identifier Handoff Checklist

**Status:** runtime handoff prep (docs/checklist only — no env update in this commit)  
**Date:** 2026-06-22  
**Scope:** Sunset staging only (`luna-sunset-staging-staff-api` in `luna-sunset-staging-rg`)

---

## Current deployed baseline (do not change in this doc commit)

| Field | Value |
|-------|-------|
| Container App | `luna-sunset-staging-staff-api` |
| Resource group | `luna-sunset-staging-rg` |
| Active revision | `luna-sunset-staging-staff-api--0000068` |
| Commit | `27d0f7fe5c02b300bef3d50aa6e6bd9fbeca6bff` |
| Image tag | `27d0f7f-sunset-conversation-qa-fixtures` |
| Health | healthy, 100% traffic |
| Rollback revision | `luna-sunset-staging-staff-api--0000067` |
| Rollback image tag | `eccffb6-sunset-luna-school-context-hotfix` |

Channel env vars on staging are still **placeholders** until this handoff is executed with real Sunset staging identifiers.

---

## 1. Required six values

Collect these from Sunset staging operations (Meta WABA admin, mailbox admin). **Do not commit real values to git.**

| Env var | Purpose | School |
|---------|---------|--------|
| `SUNSET_SOMO_WHATSAPP_NUMBER` | E.164 receiving/display number for Sunset (Somo) | `sunset-somo` |
| `SUNSET_SARDINERO_WHATSAPP_NUMBER` | E.164 receiving/display number for elSardi | `sunset-sardinero` |
| `SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID` | Meta Graph API `phone_number_id` for Somo | `sunset-somo` |
| `SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID` | Meta Graph API `phone_number_id` for elSardi | `sunset-sardinero` |
| `SUNSET_SOMO_INBOX_EMAIL` | Shared inbox email for Sunset (Somo) | `sunset-somo` |
| `SUNSET_SARDINERO_INBOX_EMAIL` | Shared inbox email for elSardi | `sunset-sardinero` |

Resolver module: `scripts/lib/sunset-inbox-channel-config.js`  
Offline verifier coverage: `scripts/verify-sunset-portal-v1.js` section 31 (routing) + section 35 (this handoff doc).

---

## 2. Safety constraints (read before any runtime change)

- [ ] **Sunset staging app only:** `luna-sunset-staging-staff-api`
- [ ] **Resource group only:** `luna-sunset-staging-rg`
- [ ] **Do not borrow Wolfhouse WABA / phone IDs** — Sunset must use its own staging WABA assets
- [ ] **Do not use production WhatsApp numbers** — staging/test identifiers only
- [ ] **Do not alter live Meta webhook routing** unless separately approved (this handoff sets Container App env only)
- [ ] **Outbound WhatsApp/email remains disabled / not introduced** — inbound routing + dry-run QA only
- [ ] **No Wolfhouse / prod deploys** — Wolfhouse Container Apps and production tenants are out of scope
- [ ] **No SOUL edits** in this handoff
- [ ] **No migrations** in this handoff
- [ ] **No secrets in git** — store values in Key Vault / secure ops notes; paste only at deploy time

---

## 3. Azure update command template (placeholders only)

> **FILL PLACEHOLDERS MANUALLY — NEVER COMMIT REAL VALUES TO GIT**

Run only after the six values are confirmed and safety constraints above are checked.  
This command updates **only** the six channel identifier env vars (no image change, no other env mutation).

```bash
# FILL PLACEHOLDERS MANUALLY — NEVER COMMIT REAL VALUES TO GIT
#
# Prerequisites:
#   - az login with access to luna-sunset-staging-rg
#   - Real staging values exported in your shell (not written to repo files)
#
# Tip: avoid echoing values — set shell vars locally, then reference them:
#   export SUNSET_SOMO_WHATSAPP_NUMBER='...'   # etc. (never commit)

az containerapp update \
  -g luna-sunset-staging-rg \
  -n luna-sunset-staging-staff-api \
  --set-env-vars \
  SUNSET_SOMO_WHATSAPP_NUMBER="${SUNSET_SOMO_WHATSAPP_NUMBER:?set locally}" \
  SUNSET_SARDINERO_WHATSAPP_NUMBER="${SUNSET_SARDINERO_WHATSAPP_NUMBER:?set locally}" \
  SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID="${SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID:?set locally}" \
  SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID="${SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID:?set locally}" \
  SUNSET_SOMO_INBOX_EMAIL="${SUNSET_SOMO_INBOX_EMAIL:?set locally}" \
  SUNSET_SARDINERO_INBOX_EMAIL="${SUNSET_SARDINERO_INBOX_EMAIL:?set locally}"
```

**Post-update env presence check (redacted — no secret values printed):**

```bash
az containerapp show -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api -o json \
  | python3 -c "
import json,sys
app=json.load(sys.stdin)
want={
  'SUNSET_SOMO_WHATSAPP_NUMBER','SUNSET_SARDINERO_WHATSAPP_NUMBER',
  'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID','SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID',
  'SUNSET_SOMO_INBOX_EMAIL','SUNSET_SARDINERO_INBOX_EMAIL'}
seen={}
for e in app['properties']['template']['containers'][0]['env']:
    if e.get('name') in want:
        v=e.get('value') or '(secretRef)'
        seen[e['name']]='set' if v and v!='(secretRef)' else 'missing_or_secret'
for n in sorted(want):
    print(n, seen.get(n,'missing'))
"
```

---

## 4. Verification after env update

Execute in order. All QA paths use **dry-run / simulated inbound** — no outbound WhatsApp or email.

### 4.1 Confirm revision and health

```bash
az containerapp revision list \
  -g luna-sunset-staging-rg \
  -n luna-sunset-staging-staff-api \
  -o table
```

- [ ] Latest revision `healthState=Healthy`
- [ ] `trafficWeight=100` on the active revision
- [ ] Image unchanged unless a separate deploy was approved (`27d0f7f-sunset-conversation-qa-fixtures` or successor)

Shortcut script (redacted env output): `_work/verify-sunset-deploy-revision.sh`

### 4.2 Run simulated channel-routing QA

```bash
# Exports staging-safe test literals if channel env not already in shell
bash _work/run-sunset-channel-routing-qa.sh
```

Or directly:

```bash
node _work/probe-sunset-inbound-channel-routing-qa.js
```

- [ ] Somo WhatsApp number → `location_id=sunset-somo`
- [ ] elSardi WhatsApp number → `location_id=sunset-sardinero`
- [ ] Somo inbox email → `sunset-somo`
- [ ] elSardi inbox email → `sunset-sardinero`
- [ ] Uses `guest-inbound-review-dry-run` only (no send endpoints)

### 4.3 Run conversation fixture probe

```bash
export SUNSET_STAGING_PORTAL_PASSWORD='...'   # from Key Vault / ops — never commit
node _work/probe-sunset-customer-conversation-school-fixture-qa.js
```

- [ ] Somo fixture visible only under Somo school switch
- [ ] elSardi fixture visible only under elSardi school switch
- [ ] Fixture rows tagged `qa_fixture=true` with `qa_fixture_run_id`
- [ ] Teardown completes in `finally` (no orphaned fixture rows)

### 4.4 Unknown channel defaults to `sunset-somo` with fallback

Offline assertion (always): `npm run verify:sunset-portal-v1` section 31 —  
`unknown channel defaults to sunset-somo with fallback`.

Live spot-check (optional, after env update):

```bash
node -e "
const c=require('./scripts/lib/sunset-inbox-channel-config');
const r=c.resolveSunsetLocationFromInboundChannel({ channel:'whatsapp' }, process.env);
console.log(r.location_id, r.channel_location_source, r.fallback);
"
```

Expected: `sunset-somo default true`

### 4.5 Verify no outbound send

- [ ] QA scripts do not call `/staff/inbox/send-reply`, guest reply send, or Meta send APIs
- [ ] `scripts/lib/sunset-conversation-qa-fixture.js` uses dry-run only
- [ ] No new outbound feature flags enabled as part of channel ID handoff

### 4.6 Offline verifier gate (pre/post)

```bash
node scripts/verify-sunset-luna-school-context.js
node scripts/verify-sunset-portal-v1.js
node scripts/verify-tenant-business-config.js
```

---

## 5. Rollback

If routing misbehaves after env update, choose **one** path:

### 5.1 Revert env vars to placeholders

Re-run the Azure template from section 3 with placeholder literals (or unset values) **only on** `luna-sunset-staging-staff-api`.  
Do not touch Wolfhouse apps.

### 5.2 Roll back Container App revision

Known good pre-fixture revision at time of handoff:

| Revision | Image tag | Notes |
|----------|-----------|-------|
| `luna-sunset-staging-staff-api--0000067` | `eccffb6-sunset-luna-school-context-hotfix` | Pre conversation QA fixtures image |

```bash
az containerapp revision activate \
  -g luna-sunset-staging-rg \
  -n luna-sunset-staging-staff-api \
  --revision luna-sunset-staging-staff-api--0000067
```

Then re-run section 4.1 health check. Use the **previous healthy revision at handoff time** if `--0000067` is no longer available.

---

## 6. Direct DB metadata confirmation (optional)

If raw `qa_fixture` / `qa_fixture_run_id` metadata must be confirmed in Postgres:

1. **Preferred:** run SQL from inside the Container App execution context (no permanent firewall change).
2. **Alternative:** open a **temporary** Postgres firewall rule for the QA runner IP, query, then **delete the rule immediately**.

Example temporary rule pattern (used by `_work/run-sunset-channel-routing-qa.sh`):

```bash
FW=lunabox-channel-routing-qa-temp
LUNABOX_IP="$(curl -s ifconfig.me)"
az postgres flexible-server firewall-rule create \
  -g luna-sunset-staging-rg \
  -s luna-sunset-staging-pg-app \
  -n "$FW" \
  --start-ip-address "$LUNABOX_IP" \
  --end-ip-address "$LUNABOX_IP"

# ... run metadata query ...

az postgres flexible-server firewall-rule delete \
  -g luna-sunset-staging-rg \
  -s luna-sunset-staging-pg-app \
  -n "$FW" -y
```

**Do not make permanent DB firewall changes for QA.**

Example metadata query (redact output before sharing):

```sql
SELECT id, metadata->>'location_id' AS location_id,
       metadata->>'qa_fixture' AS qa_fixture,
       metadata->>'qa_fixture_run_id' AS qa_fixture_run_id
FROM conversations
WHERE client_slug = 'sunset'
  AND metadata->>'qa_fixture' = 'true'
ORDER BY created_at DESC
LIMIT 20;
```

---

## Handoff sign-off

| Step | Owner | Date | OK |
|------|-------|------|-----|
| Six values collected (not in git) | | | |
| Safety constraints acknowledged | | | |
| Azure env update (staging only) | | | |
| Revision health verified | | | |
| Channel-routing QA passed | | | |
| Conversation fixture probe passed | | | |
| Unknown channel fallback verified | | | |
| No outbound send confirmed | | | |

**Explicitly out of scope for this handoff:** Wolfhouse, production, SOUL, migrations, live Meta webhook routing changes, outbound WhatsApp/email enablement.
