# Multi-client staging channel routing (shadow-only)

> **Status:** repo + runbook only. Routing env is **not** enabled on staging yet.
> Merged multiclient slices 1–10 (through `60be5b9`) ship the resolver and shadow
> attachment; live guest handling still uses legacy `DEFAULT_CLIENT` / `client_slug`
> defaults until a later slice flips outbound routing.

Related: [`MULTICLIENT-ARCHITECTURE.md`](MULTICLIENT-ARCHITECTURE.md) §5,
[`config/clients/channel-routing.sample.json`](../config/clients/channel-routing.sample.json)
(verifier fixtures), [`config/clients/channel-routing.staging.example.json`](../config/clients/channel-routing.staging.example.json)
(operator template).

---

## 1. Current safe state

| Layer | Behavior today |
|-------|----------------|
| **Resolver** | `scripts/lib/client-channel-resolver.js` maps `phone_number_id` / email inbox → `client_slug` + `location_id`. Unknown IDs are blocked — never Wolfhouse fallback. |
| **Meta ingress** | `scripts/lib/luna-meta-whatsapp-webhook.js` attaches `normalized.tenant_channel_shadow` on every webhook normalize. |
| **Staff/API SQL** | Tenant-scope SQL debt cleared; `verify:multiclient` passes. |
| **Live routing** | **Off** unless `CLIENT_CHANNEL_ROUTING_JSON` or `CLIENT_CHANNEL_ROUTING_FILE` is set at runtime. Without it, shadow reports `routing_config_absent` and legacy `normalized.client_slug` stays on the default (`wolfhouse`). |
| **Hard blocking** | **Not enabled.** Unknown `phone_number_id` values are recorded in shadow only; guests are not rejected at the edge. |
| **Outbound tenant switch** | **Not enabled.** Hermes/Staff API still process with legacy client defaults. |

No new Azure resources are required for shadow observation — only env + restart on existing apps.

---

## 2. How shadow routing works

Shadow mode is **observe-only**: it enriches persisted webhook metadata without changing which client handles the message.

### Env sources (priority)

1. **`CLIENT_CHANNEL_ROUTING_JSON`** — inline JSON string (use sparingly; awkward for multi-line maps).
2. **`CLIENT_CHANNEL_ROUTING_FILE`** — absolute path to a JSON file on the container/VM host (preferred for staging).

Loader: `loadRuntimeChannelRoutingConfig()` in `scripts/lib/client-channel-resolver.js`.

When **absent**:

- `routing_config_enabled: false`
- `channel_resolution_reason: "routing_config_absent"`
- `channel_resolution_blocked: false` (non-blocking)
- Legacy `normalized.client_slug` unchanged

When **present**:

- `routing_config_enabled: true`
- `routing_config_source`: `env_json` or `env_file`
- `tenant_channel_shadow` populated with resolved `client_slug` / `location_id` for known IDs
- Unknown `phone_number_id` → `channel_resolution_blocked: true`, `channel_resolution_reason: "unknown_channel_identity"`, shadow `client_slug: null`
- **Legacy `normalized.client_slug` still unchanged** (shadow does not override live handling)

### Where shadow is written

Staff API Meta webhook path (`scripts/staff-query-api.js` → `normalizeMetaWhatsAppWebhook`) persists inbound rows to `guest_message_events.normalized`, including `tenant_channel_shadow` when routing config is enabled.

Hermes Luna on Lunabox uses the same normalizer if/when it processes Meta payloads with this code path.

### Repo templates (fake IDs only)

| File | Purpose |
|------|---------|
| `config/clients/channel-routing.sample.json` | Committed fake `*_SAMPLE` IDs for verifiers and local tests. |
| `config/clients/channel-routing.staging.example.json` | Operator copy template with `REPLACE_WITH_*` placeholders. **Do not fill and commit.** |

---

## 3. Create the real staging routing file (outside git)

**Never** put real Meta `phone_number_id` values in the repo. Gitignore blocks `config/clients/channel-routing.staging.json` if copied locally by mistake.

### Recommended host paths

Pick one path per runtime; mount or reference consistently in env.

| Runtime | Suggested path |
|---------|----------------|
| Lunabox `hermes-luna` | `/var/lib/hermes-luna/channel-routing.staging.json` |
| Lunabox / shared operator dir | `/etc/luna-frontdesk/channel-routing.staging.json` |
| Staff API container (if file mount available) | Same pattern on ACA volume or bake via secret mount — prefer **file on host + `CLIENT_CHANNEL_ROUTING_FILE`** over huge inline JSON. |

### Steps (operator)

```bash
# On the staging host (Lunabox example)
sudo mkdir -p /etc/luna-frontdesk
sudo cp /opt/wolfhouse/WH/config/clients/channel-routing.staging.example.json \
  /etc/luna-frontdesk/channel-routing.staging.json
sudo chmod 600 /etc/luna-frontdesk/channel-routing.staging.json
sudo chown root:root /etc/luna-frontdesk/channel-routing.staging.json

# Edit: replace each REPLACE_WITH_* key with the real Meta phone_number_id from Meta Developer / Key Vault.
# Keys are the phone_number_id strings; values are client_slug + location_id only.
# Do NOT add access tokens, phone numbers, or secrets to this file.
sudo nano /etc/luna-frontdesk/channel-routing.staging.json
```

Validate JSON locally before enabling:

```bash
node -e "JSON.parse(require('fs').readFileSync('/etc/luna-frontdesk/channel-routing.staging.json','utf8')); console.log('ok')"
node scripts/verify-tenant-resolution.js
node scripts/verify-meta-whatsapp-tenant-shadow.js
```

---

## 4. Enable on staging (operator-run only — not done yet)

> **Do not run these until the operator explicitly enables shadow observation.**
> Examples below are templates; substitute real paths and confirm target app names.

### 4a. Lunabox `hermes-luna`

Add to `/etc/hermes-luna.env` (or equivalent):

```bash
CLIENT_CHANNEL_ROUTING_FILE=/etc/luna-frontdesk/channel-routing.staging.json
```

Restart Luna only:

```bash
sudo docker compose -f /opt/wolfhouse/WH/docker/hermes-staging/docker-compose.vm.yml up -d --force-recreate hermes-luna
```

Health check:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/health
# expect 200
```

### 4b. Staff API (`wh-staging-staff-api` on ACA)

Shadow on `guest_message_events` requires routing env on **Staff API** (Meta webhook persistence path).

**File-based (preferred)** — mount the JSON file into the container or use a platform file share, then:

```bash
# OPERATOR-RUN ONLY — example; adjust secret/mount strategy for your ACA setup
az containerapp update \
  -g wh-staging-rg \
  -n wh-staging-staff-api \
  --set-env-vars CLIENT_CHANNEL_ROUTING_FILE=/mnt/channel-routing/channel-routing.staging.json
```

**Inline JSON (small maps only)**:

```bash
# OPERATOR-RUN ONLY — escape carefully; prefer FILE for staging
az containerapp update \
  -g wh-staging-rg \
  -n wh-staging-staff-api \
  --set-env-vars CLIENT_CHANNEL_ROUTING_JSON='{"whatsapp_phone_number_ids":{...}}'
```

Restart / new revision is created automatically by `az containerapp update`. Wait for healthy revision:

```bash
az containerapp revision list -g wh-staging-rg -n wh-staging-staff-api -o table
curl -sS -o /dev/null -w "%{http_code}\n" https://staff-staging.lunafrontdesk.com/healthz
# expect 200
```

### 4c. Legacy ACA Hermes (`wh-staging-hermes`)

Only if Meta webhook still hits ACA Hermes instead of Lunabox. Same env vars; see [`HERMES-AZURE-CONTAINER-APPS.md`](HERMES-AZURE-CONTAINER-APPS.md). Primary staging WhatsApp path is Lunabox — see [`HERMES-AZURE-VM.md`](HERMES-AZURE-VM.md).

---

## 5. Verification

### Repo gates (no staging access needed)

```bash
node scripts/verify-tenant-resolution.js
node scripts/verify-meta-whatsapp-tenant-shadow.js
npm run verify:multiclient
npm run verify:luna-all
```

### After enabling routing on staging

1. **Health** — Staff API `https://staff-staging.lunafrontdesk.com/healthz` → 200; Lunabox Luna `http://<host>:8090/health` → 200.
2. **Send a test inbound** on a staging WhatsApp number (existing staging test flow).
3. **Inspect shadow** on latest `guest_message_events` row:

```sql
SELECT
  id,
  created_at,
  client_slug,
  normalized->'tenant_channel_shadow' AS shadow
FROM guest_message_events
ORDER BY created_at DESC
LIMIT 5;
```

Expect when routing is enabled:

- `shadow.routing_config_enabled` = `true`
- `shadow.routing_config_source` = `env_file` or `env_json`
- Known staging `phone_number_id` → `shadow.client_slug` / `shadow.location_id` match the map
- **Top-level `client_slug` column** may still show legacy default (`wolfhouse`) — that is expected in shadow-only mode

When routing is **disabled**:

- `shadow.routing_config_enabled` = `false`
- `shadow.channel_resolution_reason` = `routing_config_absent`

---

## 6. Rollback

Shadow-only rollback is safe and immediate:

1. Remove routing env from the affected runtime(s):
   - Unset `CLIENT_CHANNEL_ROUTING_JSON` and `CLIENT_CHANNEL_ROUTING_FILE`
2. Redeploy or restart the container app / `hermes-luna`.
3. Confirm new inbound events show `routing_config_absent` in shadow.
4. Legacy guest handling continues unchanged.

```bash
# OPERATOR-RUN ONLY — Staff API example
az containerapp update \
  -g wh-staging-rg \
  -n wh-staging-staff-api \
  --remove-env-vars CLIENT_CHANNEL_ROUTING_JSON CLIENT_CHANNEL_ROUTING_FILE
```

No DB migration or data change required.

---

## 7. Cost

- **No new Azure resources.**
- Only env var updates and container restarts on existing `wh-staging-staff-api`, Lunabox `hermes-luna`, and optionally legacy `wh-staging-hermes`.

---

## 8. Security

- **Never commit** real Meta `phone_number_id` values if treated as sensitive operational identifiers.
- **Never commit** WhatsApp tokens, inbox passwords, Stripe keys, or DB credentials.
- Routing JSON contains **only** `phone_number_id` → `{ client_slug, location_id }` mappings and optional fake email inboxes for future email routing tests.
- Real routing file: `chmod 600`, root-owned, outside git (`/etc/luna-frontdesk/…` or `/var/lib/hermes-luna/…`).
- `config/clients/channel-routing.staging.json` is gitignored; use `.staging.example.json` as the committed template.

---

## 9. Promotion gates (do not skip)

| Gate | Shadow-only (this doc) | Later slices |
|------|------------------------|--------------|
| Enable `CLIENT_CHANNEL_ROUTING_*` on staging | Yes — observation | — |
| Confirm shadow matches expected tenant per number | Required before any live switch | — |
| Hard-block unknown `phone_number_id` at ingress | **No** | Separate explicit slice |
| Switch outbound / `normalized.client_slug` to shadow tenant | **No** | Separate explicit slice |
| Prod routing | **No** | Per-client go-live checklists |

**Order of operations:** shadow observation → operator sign-off on shadow accuracy → hard-block slice (if desired) → outbound tenant routing slice → prod per [`docs/clients/<client>/GO-LIVE-CHECKLIST.md`](clients/wolfhouse/GO-LIVE-CHECKLIST.md).
