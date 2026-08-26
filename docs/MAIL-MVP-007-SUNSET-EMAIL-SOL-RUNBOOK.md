# MAIL-MVP-007 — Sunset email Hermes Sol runbook

Sunset staging only. Do not restart WhatsApp or Wolfhouse gateways. Do not enable auto-send. Do not set `LUNA_AI_MODEL=gpt-5.6-sol` on Staff API. Do not merge/deploy from a feature branch.

Staff Create Draft reaches Sol through a **colocated Azure Container App** in the Sunset Staff ACA environment. Lunabox loopback `127.0.0.1:8093` is a Skipper-local probe only — it is not the Staff path.

YAML and this runbook are **one path**. Skipper queries Azure IDs, fills `docker/hermes-staging/sunset-email-luna.aca.yaml.example` into a temp file, then `az containerapp create|update --yaml` **without** `--environment` (`--yaml` ignores other create flags; `environmentId` must be in the YAML). Ingress is internal (`external: false`). Isolated Codex refresh state is a **dedicated Azure Files** mount of `/opt/data` with canonical Hermes home `/opt/data/.hermes`. The one durable credential is `/opt/data/.hermes/auth.json`. No Key Vault `auth.json` snapshot. No copies, hardlinks, or symlinks. No shared WhatsApp pool.

Use this exact Azure CLI executable:

```bash
AZ=/opt/data/home/.local/bin/az
# verified: azure-cli 2.88.0, containerapp extension 1.3.0b4
```

## Owners

| Piece | Path |
| --- | --- |
| Dedicated runtime (Lunabox probe) | `hermes-sunset-email-luna` in `docker/hermes-sunset/docker-compose.vm.yml` |
| Dedicated runtime (Staff-reachable) | ACA `luna-sunset-staging-email-luna` in `luna-sunset-staging-env` (internal ingress) |
| Isolated durable home | Azure Files account `lunasunsetemailst`, share `hermes-sunset-email-luna-home`, env storage `hermes-sunset-email-luna-home` → `/opt/data` |
| Role bootstrap | `HERMES_ROLE=sunset-email-luna` in `docker/hermes-staging/bootstrap.sh` |
| Draft HTTP contract | `docker/hermes-staging/wolfhouse/email_draft_server.py` |
| Hermes composition wrapper | `docker/hermes-staging/wolfhouse/email_draft_hermes.py` |
| Staff client / author | `scripts/lib/email-luna-sunset-email-hermes-sol-*.js` |
| Create Draft + generate-on-open | `scripts/lib/staff-email-luna-draft-open.js` via Sunset runtime composition |
| Repo verifier | `npm run verify:mail-mvp-007` |
| Live Create Draft proof | `scripts/prove-mail-mvp-007-create-draft.js` |
| Live WhatsApp Luna | `hermes-sunset-luna` — **do not recreate** |
| Wolfhouse Luna | `hermes-luna` — **do not recreate** |

## Credential boundary (one operator step)

The email runtime **must not** share a writable `auth.json` with WhatsApp Luna. Bootstrap fails closed if `.hermes/auth.json` is missing, is a symlink, or `.auth-shared` is mounted. A root-level `/opt/data/auth.json` is not the credential — do not copy or symlink it.

Provision an isolated openai-codex credential **once**. This is the only irreducible credential action. Use the image entrypoint with role bootstrap skipped so `hermes auth add` does not require WhatsApp/Staff env. ENTRYPOINT stays `/init` (s6 + venv + drop to uid 10000); `hermes auth add openai-codex` is CMD. `HOME=/opt/data` is required: installed Hermes writes `$HOME/.hermes/auth.json` (and `/init` may scrub `HERMES_HOME`). Set `HERMES_HOME=/opt/data/.hermes` so un-scrubbed env agrees with that same file.

```bash
sudo install -d -m 0700 /var/lib/hermes-sunset-email-luna
sudo chown 10000:10000 /var/lib/hermes-sunset-email-luna

IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:$(git -C /opt/wolfhouse/WH rev-parse origin/master)
docker run --rm -it \
  -e HERMES_SKIP_ROLE_BOOTSTRAP=1 \
  -e HOME=/opt/data \
  -e HERMES_HOME=/opt/data/.hermes \
  -v /var/lib/hermes-sunset-email-luna:/opt/data \
  --entrypoint /init \
  "$IMAGE" hermes auth add openai-codex
```

`--entrypoint /init` keeps s6 + bootstrap skip + the auth command. Do not pass `--entrypoint python`. Prove the command wrote a regular (non-symlink) host file at `.hermes/auth.json`:

```bash
sudo test -f /var/lib/hermes-sunset-email-luna/.hermes/auth.json
sudo test ! -L /var/lib/hermes-sunset-email-luna/.hermes/auth.json
sudo stat -c '%a %u:%g %F' /var/lib/hermes-sunset-email-luna/.hermes/auth.json
# hash/mtime only — never print the file
sudo sha256sum /var/lib/hermes-sunset-email-luna/.hermes/auth.json | awk '{print $1}'
sudo stat -c '%Y' /var/lib/hermes-sunset-email-luna/.hermes/auth.json
```

Do not copy `/var/lib/hermes-shared/auth.json` while WhatsApp Luna is running. Do not invent or commit secret values.

## Exact names (one consistent path)

```bash
RG=luna-sunset-staging-rg
ENV=luna-sunset-staging-env
APP=luna-sunset-staging-email-luna
STAFF_APP=luna-sunset-staging-staff-api
IDENTITY=luna-sunset-staging-identity
KV=luna-sunset-staging-kv
ACR=whstagingacr
HERMES_REPO=wh-hermes-staging
STAFF_REPO=luna-sunset-staff-api
STORAGE_ACCOUNT=lunasunsetemailst
SHARE=hermes-sunset-email-luna-home
ENV_STORAGE=hermes-sunset-email-luna-home
AZ=/opt/data/home/.local/bin/az
```

## Skipper path after the one credential action

All remaining steps are exact commands. Values come from `$AZ` / `git` queries only.

### 0. Sync exact `origin/master` (cloud-VM limitation)

`node scripts/assert-deploy-from-master.js` refuses any tree that is dirty or whose `HEAD != origin/master`. That is intentional. **Do not deploy this feature branch.** After the PR is merged:

```bash
cd /opt/wolfhouse/WH
git fetch origin master
git checkout master
git reset --hard origin/master
git rev-parse HEAD
git rev-parse origin/master
# both SHAs must match and the working tree must be clean
node scripts/assert-deploy-from-master.js
```

Cloud-VM limitation, handled honestly: on a feature-branch checkout (including this PR head) the assert **fails**. That is not a skip; it is the deploy gate. Images are built only from the merged master SHA.

### 1. Query subscription / env / identity / gates

```bash
SUB=$("$AZ" account show --query id -o tsv)
IDENTITY_ID=$("$AZ" identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
PRINCIPAL_ID=$("$AZ" identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)
ENV_ID=$("$AZ" containerapp env show -g "$RG" -n "$ENV" --query id -o tsv)
SHA=$(git -C /opt/wolfhouse/WH rev-parse origin/master)
ACR_ID=$("$AZ" acr show -n "$ACR" --query id -o tsv)
KV_ID=$("$AZ" keyvault show -n "$KV" -g "$RG" --query id -o tsv)

# Query current Staff Create Draft gates BEFORE changing anything (names/values only; no secrets)
"$AZ" containerapp show -g "$RG" -n "$STAFF_APP" --query "properties.template.containers[0].env[?name=='LUNA_DEPLOYMENT' || name=='EMAIL_STAFF_LUNA_DRAFT_ENABLED' || name=='EMAIL_LUNA_DRAFT_RUNTIME_ENABLED' || name=='LUNA_AUTO_SEND_ENABLED' || name=='LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED' || name=='LUNA_AI_MODEL' || name=='EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED' || name=='EMAIL_LUNA_HERMES_SOL_BASE_URL'].{name:name,value:value}" -o table
```

Expect `LUNA_DEPLOYMENT=sunset-staging`. Retain `EMAIL_STAFF_LUNA_DRAFT_ENABLED=true` and `EMAIL_LUNA_DRAFT_RUNTIME_ENABLED=true` if already set; set them if missing. Auto flags must be false or unset. `LUNA_AI_MODEL` must not be `gpt-5.6-sol` (do not set it).

### 2. Identity RBAC (idempotent)

```bash
# AcrPull on the shared ACR
"$AZ" role assignment list --assignee-object-id "$PRINCIPAL_ID" --scope "$ACR_ID" --role AcrPull --include-inherited --query "[].id" -o tsv
# if empty:
"$AZ" role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role AcrPull --scope "$ACR_ID" >/dev/null

# Key Vault Secrets User (bearer + HMAC secrets only — not auth.json)
"$AZ" role assignment list --assignee-object-id "$PRINCIPAL_ID" --scope "$KV_ID" --role "Key Vault Secrets User" --include-inherited --query "[].id" -o tsv
# if empty:
"$AZ" role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope "$KV_ID" >/dev/null
```

### 3. Dedicated Azure Files home (refresh-safe)

```bash
"$AZ" storage account show -g "$RG" -n "$STORAGE_ACCOUNT" --query name -o tsv 2>/dev/null \
  || "$AZ" storage account create -g "$RG" -n "$STORAGE_ACCOUNT" \
       --sku Standard_LRS --kind StorageV2 --https-only true \
       --min-tls-version TLS1_2 --allow-blob-public-access false \
       --location northeurope >/dev/null

set +o history
STORAGE_KEY=$("$AZ" storage account keys list -g "$RG" -n "$STORAGE_ACCOUNT" --query "[0].value" -o tsv)
"$AZ" storage share exists --account-name "$STORAGE_ACCOUNT" --name "$SHARE" --account-key "$STORAGE_KEY" --query exists -o tsv | grep -qx true \
  || "$AZ" storage share create --account-name "$STORAGE_ACCOUNT" --name "$SHARE" --account-key "$STORAGE_KEY" --quota 5 >/dev/null
unset STORAGE_KEY
set -o history
```

Register the share on the Container Apps environment without printing the storage key:

```bash
set +o history
STORAGE_KEY=$("$AZ" storage account keys list -g "$RG" -n "$STORAGE_ACCOUNT" --query "[0].value" -o tsv)
"$AZ" containerapp env storage set \
  -g "$RG" -n "$ENV" \
  --storage-name "$ENV_STORAGE" \
  --access-mode ReadWrite \
  --azure-file-account-name "$STORAGE_ACCOUNT" \
  --azure-file-share-name "$SHARE" \
  --azure-file-account-key "$STORAGE_KEY" >/dev/null
"$AZ" storage directory create \
  --account-name "$STORAGE_ACCOUNT" \
  --share-name "$SHARE" \
  --name .hermes \
  --account-key "$STORAGE_KEY" >/dev/null
"$AZ" storage file upload \
  --account-name "$STORAGE_ACCOUNT" \
  --share-name "$SHARE" \
  --source /var/lib/hermes-sunset-email-luna/.hermes/auth.json \
  --path .hermes/auth.json \
  --account-key "$STORAGE_KEY" >/dev/null
unset STORAGE_KEY
set -o history
```

Do not upload WhatsApp `/var/lib/hermes-shared/auth.json`. Do not print `$STORAGE_KEY`.

### 4. Build/push BOTH immutable images from exact master SHA

Hermes Dockerfile/context is `docker/hermes-staging`. Staff overlay assertions are the `Dockerfile.luna-sunset-staff-api` `RUN cp ... staff-portal-access.sunset-staging.json` plus the `all_clients_emails` fail-closed node check.

```bash
"$AZ" acr build -r "$ACR" -t "$HERMES_REPO:$SHA" -f docker/hermes-staging/Dockerfile docker/hermes-staging
"$AZ" acr build -r "$ACR" -t "$STAFF_REPO:$SHA" -f Dockerfile.luna-sunset-staff-api .
```

(`az acr build --help`: `-r/--registry` required, `-t/--image` is `repo/image:tag` or `repo:tag`, `-f/--file` Dockerfile relative to context, positional source location.)

### 5. Bearer + response HMAC secrets (not auth.json)

```bash
set +o history
TOKEN=$(openssl rand -hex 32)
HMAC=$(openssl rand -hex 32)
"$AZ" keyvault secret set --vault-name "$KV" --name email-luna-hermes-sol-token --file /dev/stdin --encoding utf-8 <<TOKEN_EOF >/dev/null
$TOKEN
TOKEN_EOF
"$AZ" keyvault secret set --vault-name "$KV" --name email-luna-hermes-sol-hmac --file /dev/stdin --encoding utf-8 <<HMAC_EOF >/dev/null
$HMAC
HMAC_EOF
# TOKEN is also Staff EMAIL_LUNA_HERMES_SOL_TOKEN; HMAC is EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET
unset HMAC
set -o history
```

Keep `$TOKEN` in memory only until the Staff secret set below, then `unset TOKEN`.

### 6. Fill YAML and create/update only `luna-sunset-staging-email-luna`

```bash
YAML=$(mktemp --suffix=.yaml)
python3 /opt/wolfhouse/WH/scripts/fill-sunset-email-luna-aca-yaml.py \
  --template /opt/wolfhouse/WH/docker/hermes-staging/sunset-email-luna.aca.yaml.example \
  --output "$YAML" \
  --environment-id "$ENV_ID" \
  --identity-id "$IDENTITY_ID" \
  --full-master-sha "$SHA"
grep -nE '<[^>]+>|managedEnvironmentId' "$YAML" && { echo 'refuse: placeholders or deprecated environment field remain'; exit 1; }
grep -n 'command:' "$YAML" && { echo 'refuse: YAML must not set command (would skip /init)'; exit 1; }
grep -F 'environmentId:' "$YAML"
grep -F '/opt/hermes/.venv/bin/python' "$YAML"
grep -F 'storageType: AzureFile' "$YAML"

if "$AZ" containerapp show -g "$RG" -n "$APP" >/dev/null 2>&1; then
  "$AZ" containerapp update -g "$RG" -n "$APP" --yaml "$YAML"
else
  "$AZ" containerapp create -g "$RG" -n "$APP" --yaml "$YAML"
fi
rm -f "$YAML"
```

Do **not** pass `--environment`. Installed `az containerapp create --help` (extension 1.3.0b4): when `--yaml` is set, other parameters are ignored; `environmentId` in YAML is required. Current schema field is `environmentId`, not deprecated `managedEnvironmentId`.

### 7. Internal FQDN + HTTPS health from inside the same environment

```bash
FQDN=$("$AZ" containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo "$FQDN"
# expect: luna-sunset-staging-email-luna.internal.<env-hash>.northeurope.azurecontainerapps.io

"$AZ" containerapp show -g "$RG" -n "$APP" --query "properties.runningStatus" -o tsv
# expect: Running / revision Healthy

# Temporary no-secret probe job in the same ACA environment (healthz is unauthenticated).
PROBE=sunset-email-luna-health-probe
"$AZ" containerapp job delete -g "$RG" -n "$PROBE" --yes >/dev/null 2>&1 || true
"$AZ" containerapp job create \
  -g "$RG" -n "$PROBE" \
  --environment "$ENV" \
  --trigger-type Manual \
  --replica-timeout 60 \
  --image mcr.microsoft.com/azure-cli:2.67.0 \
  --command "/bin/sh" \
  --args "-c" "curl -fsS https://${FQDN}/healthz" >/dev/null
"$AZ" containerapp job start -g "$RG" -n "$PROBE"
"$AZ" containerapp job execution list -g "$RG" -n "$PROBE" -o table
"$AZ" containerapp job delete -g "$RG" -n "$PROBE" --yes >/dev/null
```

Do not assume public reachability. Do not put the bearer or HMAC into the probe job.

Staff activation allowlists only that hostname pattern. No SPKI pin is required: ACA internal FQDN uses publicly trusted TLS. Staff validates CA + hostname, then the bearer token, then the response HMAC.

### 8. Sunset Staff API only — secrets, env, image

```bash
set +o history
"$AZ" containerapp secret set -g "$RG" -n "$STAFF_APP" --secrets \
  "hermes-sol-token=keyvaultref:https://${KV}.vault.azure.net/secrets/email-luna-hermes-sol-token,identityref:${IDENTITY_ID}" \
  "hermes-sol-hmac=keyvaultref:https://${KV}.vault.azure.net/secrets/email-luna-hermes-sol-hmac,identityref:${IDENTITY_ID}" \
  >/dev/null

"$AZ" containerapp update -g "$RG" -n "$STAFF_APP" \
  --image "${ACR}.azurecr.io/${STAFF_REPO}:${SHA}" \
  --set-env-vars \
    LUNA_DEPLOYMENT=sunset-staging \
    EMAIL_STAFF_LUNA_DRAFT_ENABLED=true \
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED=true \
    EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED=true \
    "EMAIL_LUNA_HERMES_SOL_BASE_URL=https://${FQDN}" \
    EMAIL_LUNA_HERMES_SOL_TOKEN=secretref:hermes-sol-token \
    EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET=secretref:hermes-sol-hmac \
  >/dev/null
unset TOKEN
set -o history
```

Do **not** set `LUNA_AI_MODEL`. Do **not** set auto-send flags true. Production, Caddy, WhatsApp, and Wolfhouse apps are out of scope.

Re-query auto flags and `LUNA_AI_MODEL` after update — still false/unset, never `gpt-5.6-sol`.

Optional pin (fail-closed if set and mismatched). Hostname/cert validation always runs first:

```bash
# Only if EMAIL_LUNA_HERMES_SOL_TLS_PIN is set.
FQDN=$("$AZ" containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo | openssl s_client -connect "${FQDN}:443" -servername "$FQDN" 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -hex
```

Create `/etc/hermes-sunset-email-luna.env` on Lunabox for the optional probe (`API_SERVER_KEY` and `EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET`). Never print it.

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

sudo docker exec hermes-sunset-email-luna sh -c 'test "$HERMES_HOME" = /opt/data/.hermes && test -f "$HERMES_HOME/auth.json" && test ! -L "$HERMES_HOME/auth.json" && echo AUTH_ISOLATED_OK'
```

Local HTTP probe is loopback-only. Transport 200 without live attempt provenance `openai-codex` / `gpt-5.6-sol` / `sunset-email-luna` **and** a Staff-verified response HMAC is **not** proof. Provider must be the actual Codex Responses transport (chatgpt.com `/backend-api/codex`) plus the terminal event model. Bearer authenticates the caller; HMAC authenticates the response.

## Controlled Create Draft proof

Use one existing eligible Sunset email conversation. Do not print guest identifiers, the conversation UUID, notes, tokens, or draft content. Operator supplies the conversation UUID via env; the script validates tenant `sunset` / location `sunset-somo` and redacts the value.

There is no safe Staff-session login helper that can obtain a cookie without credentials. The proof therefore execs into the deployed Staff container (disabled unless `MAIL_MVP_007_LIVE_PROOF=1` is passed on that exec) and invokes the production `createStaffEmailLunaDraftOpen` / `regenerateEmailLunaDraftOnStaffClick` owner — the same owner `POST /staff/inbox/email/create-draft` uses. Notes are exactly: `Thank them for the msg and then ask them if they want to do a booking`. Invoke Create Draft **once**. Never call approve/send/provider endpoints.

`az containerapp exec` on Azure CLI 2.88.0 is an interactive websocket/TTY. Node `spawnSync` pipes are invalid. The driver wraps exec with the host PTY helper `script -q -e -c … /dev/null` (quiet, child exit code, command, typescript discarded). The legal remote command is `az containerapp exec --command "sh -c '…'"` against `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` and an explicitly selected running replica/revision. Conversation UUID and the pre-generated attempt id are validated as UUIDs, then base64-encoded into a fixed env payload. Secrets, notes, and guest content are never interpolated into the shell.

Generate the opaque proof attempt id **before** exec and pass it as `MAIL_MVP_007_PROOF_ATTEMPT_ID` (the Staff Hermes client uses it as `request_id` when present). If PTY/exec disconnects after connecting, **do not** issue another Create Draft. Enter reconciliation-only (`MAIL_MVP_007_RECONCILE_ONLY=1`): query Staff owner state and Email Luna logs for that same attempt id. Completed / failed / indeterminate are decided from that correlation. If completion cannot be proven, exit nonzero with `indeterminate_no_retry`. Manual reconciliation only — never rerun blindly.

```bash
AZ=/opt/data/home/.local/bin/az
# conversation uuid stays in the env var; do not echo it
: "${EMAIL_LUNA_PROOF_CONVERSATION_ID:?set the existing conversation uuid}"
MAIL_MVP_007_LIVE_PROOF=1 \
LUNA_DEPLOYMENT=sunset-staging \
EMAIL_LUNA_PROOF_CONVERSATION_ID="$EMAIL_LUNA_PROOF_CONVERSATION_ID" \
AZ="$AZ" \
node scripts/prove-mail-mvp-007-create-draft.js
```

That command:

1. `script -q -e -c "$AZ containerapp exec -g $RG -n $STAFF_APP --replica $REPLICA --revision $REVISION --command \"sh -c 'printf %s <base64-env> | base64 -d > /tmp/mail-mvp-007-proof.env && set -a && . /tmp/mail-mvp-007-proof.env && set +a && exec node scripts/prove-mail-mvp-007-create-draft.js'\"" /dev/null` — Staff-side, default-off owner proof (the extra env is only on this exec; it is not a Staff container setting). Do not echo `$EMAIL_LUNA_PROOF_CONVERSATION_ID`.
2. Captures before/after aggregates from canonical tables. Persisted `conversations.staff_reply_draft` length must be `>0` and must change from baseline, or the standing-draft CAS `claim_id` / body hash must advance. Approval / outbound journal / provider-send / booking deltas must be `0`. Missing counts fail closed (never fake zeros).
3. Requires Staff-verified response HMAC: `authenticity.request_id` + `hmac_verified=true` + `provider=openai-codex` + `model=gpt-5.6-sol` + `runtime=sunset-email-luna`. A fake Staff HTTP 200 with only `message_text` cannot satisfy proof. The HMAC `request_id` must equal the pre-exec attempt id.
4. Correlates the same opaque high-entropy `request_id` to Email Luna console logs. Do **not** pass `--query` or `--format json` and then `JSON.parse` the whole stream — CLI 2.88 emits NDJSON/stream text. Capture stdout and parse each JSON line (or raw log line) locally. Require the service-side **post-completion** marker for that attempt id inside a bounded fresh window on the Email Luna app/revision:

```bash
"$AZ" containerapp logs show -g "$RG" -n "$EMAIL_LUNA_APP" --type console --tail 200 --revision "$EMAIL_LUNA_REVISION"
# expect one fresh NDJSON/raw line:
# email-draft-server attempt request_id=<opaque> provider=openai-codex model=gpt-5.6-sol runtime=sunset-email-luna hmac=ok
```

Reject empty logs, stale `request_id` lines, pre-completion/input-echo-only lines, wrong app/revision/deployment, and malformed NDJSON.

`REQUEST_ID` is the opaque id from the proof JSON (`request_id` / `request_id_prefix`). Do not put guest data in the command.

If exec fails after a possible mutation, the driver runs **reconciliation only** (no second Create Draft) and prints `PROOF_FAIL reason=indeterminate_no_retry attempt_id_prefix=…` when completion cannot be proven. Manual reconciliation: inspect Staff owner draft state and Email Luna logs for that same attempt id. Never rerun the mutation blindly.

Successful stdout is aggregate booleans/count deltas plus opaque `request_id` only. Nonzero exit on any missing proof. The previous fake in-process globals harness is removed.

## Restart persistence proof (hash/mtime only)

```bash
set +o history
STORAGE_KEY=$("$AZ" storage account keys list -g "$RG" -n "$STORAGE_ACCOUNT" --query "[0].value" -o tsv)
"$AZ" storage file download \
  --account-name "$STORAGE_ACCOUNT" --share-name "$SHARE" \
  --path .hermes/auth.json --dest /tmp/email-luna-auth-before.json \
  --account-key "$STORAGE_KEY" >/dev/null
BEFORE_HASH=$(sha256sum /tmp/email-luna-auth-before.json | awk '{print $1}')
BEFORE_MTIME=$(stat -c '%Y' /tmp/email-luna-auth-before.json)
"$AZ" containerapp revision restart -g "$RG" -n "$APP" --revision \
  $("$AZ" containerapp show -g "$RG" -n "$APP" --query properties.latestRevisionName -o tsv)
"$AZ" storage file download \
  --account-name "$STORAGE_ACCOUNT" --share-name "$SHARE" \
  --path .hermes/auth.json --dest /tmp/email-luna-auth-after.json \
  --account-key "$STORAGE_KEY" >/dev/null
AFTER_HASH=$(sha256sum /tmp/email-luna-auth-after.json | awk '{print $1}')
AFTER_MTIME=$(stat -c '%Y' /tmp/email-luna-auth-after.json)
echo "auth_hash_before=$BEFORE_HASH auth_hash_after=$AFTER_HASH"
echo "auth_mtime_before=$BEFORE_MTIME auth_mtime_after=$AFTER_MTIME"
# After a live refresh, hash/mtime may change and MUST persist across restart.
# File must remain a regular file (not a symlink).
rm -f /tmp/email-luna-auth-before.json /tmp/email-luna-auth-after.json
unset STORAGE_KEY
set -o history
"$AZ" containerapp show -g "$RG" -n "$APP" --query "{status:properties.runningStatus,ready:properties.latestReadyRevisionName}" -o json
```

## Rollback

```bash
# Staff API: unset EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED (Create Draft falls back to FIX-3 compile)
"$AZ" containerapp update -g "$RG" -n "$STAFF_APP" --remove-env-vars EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED
"$AZ" containerapp update -g "$RG" -n "$APP" --min-replicas 0
# optional Lunabox probe:
sudo docker compose -f docker/hermes-sunset/docker-compose.vm.yml \
  --profile sunset-email-luna stop hermes-sunset-email-luna
```

Do not stop `hermes-sunset-luna` or `hermes-luna`.
