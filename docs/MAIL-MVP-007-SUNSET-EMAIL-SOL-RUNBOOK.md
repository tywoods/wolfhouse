# MAIL-MVP-007 — Sunset email Hermes Sol runbook

Sunset staging only. Do not restart WhatsApp or Wolfhouse gateways. Do not enable auto-send. Do not set `LUNA_AI_MODEL=gpt-5.6-sol` on Staff API.

Staff Create Draft reaches Sol through a **colocated Azure Container App** in the Sunset Staff ACA environment. Lunabox loopback `127.0.0.1:8093` is a Skipper-local probe only — it is not the Staff path.

## Owners

| Piece | Path |
| --- | --- |
| Dedicated runtime (Lunabox probe) | `hermes-sunset-email-luna` in `docker/hermes-sunset/docker-compose.vm.yml` |
| Dedicated runtime (Staff-reachable) | ACA `luna-sunset-staging-email-luna` in `luna-sunset-staging-env` (internal ingress) |
| Role bootstrap | `HERMES_ROLE=sunset-email-luna` in `docker/hermes-staging/bootstrap.sh` |
| Draft HTTP contract | `docker/hermes-staging/wolfhouse/email_draft_server.py` |
| Hermes composition wrapper | `docker/hermes-staging/wolfhouse/email_draft_hermes.py` |
| Staff client / author | `scripts/lib/email-luna-sunset-email-hermes-sol-*.js` |
| Create Draft + generate-on-open | `scripts/lib/staff-email-luna-draft-open.js` via Sunset runtime composition |
| Repo verifier | `npm run verify:mail-mvp-007` |
| Live WhatsApp Luna | `hermes-sunset-luna` — **do not recreate** |
| Wolfhouse Luna | `hermes-luna` — **do not recreate** |

## Credential boundary (one operator step)

The email runtime **must not** share a writable `auth.json` with WhatsApp Luna. Bootstrap fails closed if `auth.json` is missing, is a symlink, or `.auth-shared` is mounted.

Provision an isolated openai-codex credential **once**. Use the image entrypoint with role bootstrap skipped so `hermes auth add` does not require WhatsApp/Staff env:

```bash
sudo install -d -m 0700 /var/lib/hermes-sunset-email-luna
sudo chown 10000:10000 /var/lib/hermes-sunset-email-luna

IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:<full-master-sha>
docker run --rm -it \
  -e HERMES_SKIP_ROLE_BOOTSTRAP=1 \
  -e HOME=/opt/data \
  -e HERMES_HOME=/opt/data \
  -v /var/lib/hermes-sunset-email-luna:/opt/data \
  "$IMAGE" hermes auth add openai-codex
```

This keeps ENTRYPOINT `/init` (s6 + venv + drop to uid 10000) and runs `hermes auth add openai-codex` as CMD. It does **not** take the `sunset-email-luna` / `luna` role branches.

Do not copy `/var/lib/hermes-shared/auth.json` while WhatsApp Luna is running. Do not invent or commit secret values.

Create `/etc/hermes-sunset-email-luna.env` with `API_SERVER_KEY` (opaque token). Put the **same** token on Sunset Staff API as `EMAIL_LUNA_HERMES_SOL_TOKEN` and on the email ACA as `API_SERVER_KEY`. Never print it.

## Staff-reachable path (canonical)

Sunset Staff API runs in Azure Container Apps (`luna-sunset-staging-staff-api` in `luna-sunset-staging-env`, northeurope). It cannot use Lunabox `127.0.0.1:8093`. Do not expose the draft contract on public plaintext HTTP. Do not add a route to WhatsApp Caddy.

Deploy a **separate** Container App in the same environment with **internal** HTTPS ingress. Staff reaches it on the `.internal.` FQDN. Azure terminates TLS. The app still speaks the closed `/v1/internal/email-draft-plan` schema, Sunset-bound, bearer-authenticated. No public arbitrary-prompt endpoint.

Do **not** apply `infra/azure/sunset-staging/main.bicep` for this. Exact create (operator/Skipper with Azure access; do not run from this PR):

```bash
SHA=<full-master-sha>
IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:$SHA
RG=luna-sunset-staging-rg
ENV=luna-sunset-staging-env
APP=luna-sunset-staging-email-luna
IDENTITY=luna-sunset-staging-identity
SHARE=hermes-sunset-email-luna
# Persist isolated HERMES_HOME (auth.json refresh) on Azure Files in the Sunset RG.
# Create the share once. Upload the isolated auth.json from Lunabox; never the WhatsApp pool.

az containerapp create \
  --name "$APP" \
  --resource-group "$RG" \
  --environment "$ENV" \
  --image "$IMAGE" \
  --user-assigned "/subscriptions/<sub>/resourceGroups/$RG/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$IDENTITY" \
  --registry-server whstagingacr.azurecr.io \
  --registry-identity "/subscriptions/<sub>/resourceGroups/$RG/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$IDENTITY" \
  --ingress internal \
  --target-port 8093 \
  --transport http \
  --min-replicas 1 --max-replicas 1 \
  --cpu 1 --memory 2Gi \
  --command python \
  --args /etc/hermes-staging/wolfhouse/email_draft_server.py \
  --secrets api-server-key=<same opaque token as Staff EMAIL_LUNA_HERMES_SOL_TOKEN> \
  --bind-env-vars \
    HERMES_HOME=/opt/data \
    HERMES_ROLE=sunset-email-luna \
    LUNA_TENANT_ID=sunset \
    LUNA_CLIENT_SLUG=sunset \
    LUNA_ALLOWED_LOCATION_IDS=sunset-somo \
    EMAIL_LUNA_DRAFT_LISTEN_HOST=0.0.0.0 \
    EMAIL_LUNA_DRAFT_LISTEN_PORT=8093 \
    API_SERVER_KEY=secretref:api-server-key \
    GENERIC_TIMEZONE=Europe/Madrid \
  --volume-mounts \
    name=hermes-home,storageName=<sunset-email-luna-files>,mountPath=/opt/data \
  --health-probe-kind http --health-probe-path /healthz --health-probe-port 8093
```

Read the internal FQDN (Staff-only; not public):

```bash
az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv
# expect: luna-sunset-staging-email-luna.internal.<env-hash>.northeurope.azurecontainerapps.io
```

Pin server identity (SPKI SHA-256, hex). Capture once after the app is up; never log the token:

```bash
FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo | openssl s_client -connect "${FQDN}:443" -servername "$FQDN" 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -hex
```

Staff API env (Sunset staging only):

```
EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED=true
EMAIL_LUNA_HERMES_SOL_BASE_URL=https://<internal-fqdn>
EMAIL_LUNA_HERMES_SOL_TLS_PIN=<64-char lowercase hex SPKI SHA-256>
EMAIL_LUNA_HERMES_SOL_TOKEN=<same as API_SERVER_KEY>
```

`http://` is rejected except loopback. Remote HTTPS without the pin is rejected. Bearer over public plaintext HTTP is forbidden.

Keep `LUNA_AUTO_SEND_ENABLED` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED` unset/false. Do not set `LUNA_AI_MODEL`. Redeploy **Sunset Staff API only**.

## Optional Lunabox probe (not Staff)

Skipper-local only. Do **not** `up` `hermes-sunset-luna` or `hermes-luna`. Do not reload Caddy.

```bash
cd /opt/wolfhouse/WH
git rev-parse HEAD
sudo HERMES_IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:<full-master-sha> \
  docker compose -f docker/hermes-sunset/docker-compose.vm.yml \
  --profile sunset-email-luna \
  up -d --no-deps hermes-sunset-email-luna
```

Inspect live config (no secrets):

```bash
sudo docker exec hermes-sunset-email-luna sh -c 'sed -n "1,20p" "$HERMES_HOME/config.yaml"'
# Expect:
#   model:
#     default: gpt-5.6-sol
#     provider: openai-codex

sudo docker exec hermes-sunset-email-luna sh -c 'test -f "$HERMES_HOME/auth.json" && test ! -L "$HERMES_HOME/auth.json" && echo AUTH_ISOLATED_OK'
```

Local HTTP probe is loopback-only. Transport 200 without live attempt provenance `openai-codex` / `gpt-5.6-sol` / `sunset-email-luna` is **not** proof.

## Controlled Create Draft proof

Before click: count `tenant_email_reply_approvals`, outbound journal rows, and provider sends for the probe conversation (expect unchanged after).

Click **Create Draft** with notes `Thank them for the msg and then ask them if they want to do a booking`.

After:

- Standing draft is the natural thank-you + “Would you like to make a booking?”
- Staff diagnostics show secret-free marker `openai-codex` / `gpt-5.6-sol` / `sunset-email-luna`
- Exact-attempt provider/model came from the Hermes composition terminal response, not from config text
- Approval count unchanged
- Journal count unchanged
- Provider send count unchanged
- WhatsApp `hermes-sunset-luna` still running, not recreated

Empty notes must still produce the safe thread-only draft.

## Rollback

```bash
# Staff API: unset EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED (Create Draft falls back to FIX-3 compile)
az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-email-luna --min-replicas 0
# optional Lunabox probe:
sudo docker compose -f docker/hermes-sunset/docker-compose.vm.yml \
  --profile sunset-email-luna stop hermes-sunset-email-luna
```

Do not stop `hermes-sunset-luna` or `hermes-luna`.
