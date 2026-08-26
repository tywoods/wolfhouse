# MAIL-MVP-007 — Sunset email Hermes Sol runbook

Sunset staging only. Do not restart WhatsApp or Wolfhouse gateways. Do not enable auto-send. Do not set `LUNA_AI_MODEL=gpt-5.6-sol` on Staff API.

Staff Create Draft reaches Sol through a **colocated Azure Container App** in the Sunset Staff ACA environment. Lunabox loopback `127.0.0.1:8093` is a Skipper-local probe only — it is not the Staff path.

YAML and this runbook are **one path**: Skipper queries Azure IDs, fills `docker/hermes-staging/sunset-email-luna.aca.yaml.example`, then `az containerapp create --yaml`. Ingress is internal (`external: false`). Do not mix a second flag-only create. Do not use Azure Files.

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

Provision an isolated openai-codex credential **once**. This is the only irreducible credential action. Use the image entrypoint with role bootstrap skipped so `hermes auth add` does not require WhatsApp/Staff env. ENTRYPOINT stays `/init` (s6 + venv + drop to uid 10000); `hermes auth add openai-codex` is CMD.

```bash
sudo install -d -m 0700 /var/lib/hermes-sunset-email-luna
sudo chown 10000:10000 /var/lib/hermes-sunset-email-luna

IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:$(git -C /opt/wolfhouse/WH rev-parse origin/master)
docker run --rm -it \
  -e HERMES_SKIP_ROLE_BOOTSTRAP=1 \
  -e HOME=/opt/data \
  -e HERMES_HOME=/opt/data \
  -v /var/lib/hermes-sunset-email-luna:/opt/data \
  --entrypoint /init \
  "$IMAGE" hermes auth add openai-codex
```

`--entrypoint /init` keeps s6 + bootstrap skip + the auth command. Do not pass `--entrypoint python`. Prove the command ran:

```bash
sudo test -f /var/lib/hermes-sunset-email-luna/auth.json
sudo test ! -L /var/lib/hermes-sunset-email-luna/auth.json
sudo stat -c '%a %u:%g' /var/lib/hermes-sunset-email-luna/auth.json
```

Do not copy `/var/lib/hermes-shared/auth.json` while WhatsApp Luna is running. Do not invent or commit secret values.

## Skipper path after the one credential action

All remaining steps are exact commands. Values come from `az` / `git` queries only.

```bash
RG=luna-sunset-staging-rg
ENV=luna-sunset-staging-env
APP=luna-sunset-staging-email-luna
IDENTITY=luna-sunset-staging-identity
KV=luna-sunset-staging-kv
ACR=whstagingacr
REPO=wh-hermes-staging

SUB=$(az account show --query id -o tsv)
IDENTITY_ID=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
ENV_ID=$(az containerapp env show -g "$RG" -n "$ENV" --query id -o tsv)
SHA=$(git -C /opt/wolfhouse/WH rev-parse origin/master)
IMAGE="$ACR.azurecr.io/$REPO:$SHA"
```

Bearer token (generated, not committed). Same value becomes Staff `EMAIL_LUNA_HERMES_SOL_TOKEN` and ACA `API_SERVER_KEY`:

```bash
TOKEN=$(openssl rand -hex 32)
az keyvault secret set --vault-name "$KV" --name email-luna-hermes-sol-token --file /dev/stdin --encoding utf-8 <<TOKEN_EOF >/dev/null
$TOKEN
TOKEN_EOF
```

Upload the isolated auth.json as base64. Do not print it. Do not use the WhatsApp pool file.

```bash
AUTH_FILE=$(mktemp)
sudo python3 -c 'import base64,pathlib,sys; sys.stdout.buffer.write(base64.standard_b64encode(pathlib.Path("/var/lib/hermes-sunset-email-luna/auth.json").read_bytes()))' > "$AUTH_FILE"
chmod 0600 "$AUTH_FILE"
az keyvault secret set --vault-name "$KV" --name hermes-sunset-email-luna-auth-json-b64 --file "$AUTH_FILE" --encoding utf-8 >/dev/null
shred -u "$AUTH_FILE" 2>/dev/null || rm -f "$AUTH_FILE"
```

Fill the YAML (subscription / identity / env / SHA only) and create. Args only — never set a container command (that replaces `/init`).

```bash
YAML=$(mktemp --suffix=.yaml)
sed \
  -e "s|<subscription-id>|$SUB|g" \
  -e "s|<full-master-sha>|$SHA|g" \
  /opt/wolfhouse/WH/docker/hermes-staging/sunset-email-luna.aca.yaml.example > "$YAML"
grep -n 'command:' "$YAML" && { echo 'refuse: YAML must not set command (would skip /init)'; exit 1; }
grep -F '/opt/hermes/.venv/bin/python' "$YAML"
az containerapp create \
  -g "$RG" \
  -n "$APP" \
  --environment "$ENV" \
  --yaml "$YAML"
rm -f "$YAML"
```

Authoritative CLI surface used by the create (from `az containerapp create --help`): `--name`/`-n`, `--resource-group`/`-g`, `--environment`, `--yaml`. Do not override container command (that replaces `/init`), and do not attach Azure Files volumes. `--yaml` ignores other create flags.

Read the internal FQDN after create (Staff-only; not public):

```bash
FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo "$FQDN"
# expect: luna-sunset-staging-email-luna.internal.<env-hash>.northeurope.azurecontainerapps.io
```

Staff activation allowlists only that hostname pattern. No SPKI pin is required: ACA internal FQDN uses publicly trusted TLS. Staff validates CA + hostname, then the bearer token.

Staff API env (Sunset staging only):

```
EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED=true
EMAIL_LUNA_HERMES_SOL_BASE_URL=https://$FQDN
EMAIL_LUNA_HERMES_SOL_TOKEN=<same value as email-luna-hermes-sol-token>
```

Do not set `EMAIL_LUNA_HERMES_SOL_TLS_PIN` unless a later policy demands leaf pinning. `http://` is rejected except loopback. Arbitrary HTTPS hosts, IPs, and non-internal ACA names are rejected. Bearer over public plaintext HTTP is forbidden.

Keep `LUNA_AUTO_SEND_ENABLED` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED` unset/false. Do not set `LUNA_AI_MODEL`. Redeploy **Sunset Staff API only**.

Optional pin (fail-closed if set and mismatched). Hostname/cert validation always runs first. After an ACA-managed cert rotation, a stale pin refuses the connection:

```bash
# Only if EMAIL_LUNA_HERMES_SOL_TLS_PIN is set. Rotation: unset the pin (CA+hostname
# remains) or replace it with the new SPKI and restart Staff API.
FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo | openssl s_client -connect "${FQDN}:443" -servername "$FQDN" 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -hex
```

Create `/etc/hermes-sunset-email-luna.env` on Lunabox for the optional probe (`API_SERVER_KEY` = the same token). Never print it.

## Optional Lunabox probe (not Staff)

Skipper-local only. Do **not** `up` `hermes-sunset-luna` or `hermes-luna`. Do not reload Caddy. Interpreter is `/opt/hermes/.venv/bin/python` after `/init`.

```bash
cd /opt/wolfhouse/WH
git rev-parse HEAD
sudo HERMES_IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:$(git rev-parse origin/master) \
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

Local HTTP probe is loopback-only. Transport 200 without live attempt provenance `openai-codex` / `gpt-5.6-sol` / `sunset-email-luna` is **not** proof. Provider must be the actual Codex Responses transport (chatgpt.com `/backend-api/codex`) plus the terminal event model.

## Controlled Create Draft proof

Before click: count `tenant_email_reply_approvals`, outbound journal rows, and provider sends for the probe conversation (expect unchanged after).

Click **Create Draft** with notes `Thank them for the msg and then ask them if they want to do a booking`.

After:

- Standing draft is the natural thank-you + “Would you like to make a booking?”
- Staff diagnostics show secret-free marker `openai-codex` / `gpt-5.6-sol` / `sunset-email-luna`
- Exact-attempt provider/model came from the Hermes Codex transport + terminal response, not from config text
- Approval count unchanged
- Journal count unchanged
- Provider send count unchanged
- WhatsApp `hermes-sunset-luna` still running, not recreated

Empty notes must still produce the safe thread-only draft unless generate-on-open has a classified grounded intent; then Hermes template author + Staff renderer persist that result.

## Rollback

```bash
# Staff API: unset EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED (Create Draft falls back to FIX-3 compile)
az containerapp update -g luna-sunset-staging-rg -n luna-sunset-staging-email-luna --min-replicas 0
# optional Lunabox probe:
sudo docker compose -f docker/hermes-sunset/docker-compose.vm.yml \
  --profile sunset-email-luna stop hermes-sunset-email-luna
```

Do not stop `hermes-sunset-luna` or `hermes-luna`.
