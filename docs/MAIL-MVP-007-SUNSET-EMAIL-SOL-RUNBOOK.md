# MAIL-MVP-007 — Sunset email Hermes Sol runbook

Sunset staging only. Do not restart WhatsApp or Wolfhouse gateways. Do not enable auto-send. Do not set `LUNA_AI_MODEL=gpt-5.6-sol` on Staff API.

## Owners

| Piece | Path |
| --- | --- |
| Dedicated runtime | `hermes-sunset-email-luna` in `docker/hermes-sunset/docker-compose.vm.yml` |
| Role bootstrap | `HERMES_ROLE=sunset-email-luna` in `docker/hermes-staging/bootstrap.sh` |
| Draft HTTP contract | `docker/hermes-staging/wolfhouse/email_draft_server.py` |
| Staff client / author | `scripts/lib/email-luna-sunset-email-hermes-sol-*.js` |
| Create Draft + generate-on-open | `scripts/lib/staff-email-luna-draft-open.js` via Sunset runtime composition |
| Repo verifier | `npm run verify:mail-mvp-007` |
| Live WhatsApp Luna | `hermes-sunset-luna` — **do not recreate** |
| Wolfhouse Luna | `hermes-luna` — **do not recreate** |

## Credential boundary (one operator step)

The email runtime **must not** share a writable `auth.json` with WhatsApp Luna. Bootstrap fails closed if `auth.json` is missing, is a symlink, or `.auth-shared` is mounted.

Provision an isolated openai-codex credential **once**:

```bash
sudo install -d -m 0700 /var/lib/hermes-sunset-email-luna
sudo touch /var/lib/hermes-sunset-email-luna/auth.json
sudo chmod 0600 /var/lib/hermes-sunset-email-luna/auth.json
# uid 10000 is the image hermes user
sudo chown 10000:10000 /var/lib/hermes-sunset-email-luna/auth.json

IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:<full-master-sha>
docker run --rm -it \
  -v /var/lib/hermes-sunset-email-luna/auth.json:/opt/data/auth.json \
  "$IMAGE" hermes auth add openai-codex
```

Do not copy `/var/lib/hermes-shared/auth.json` while WhatsApp Luna is running. Do not invent or commit secret values.

Create `/etc/hermes-sunset-email-luna.env` with `API_SERVER_KEY` (opaque token). Put the **same** token on Sunset Staff API as `EMAIL_LUNA_HERMES_SOL_TOKEN`. Never print it.

## Start only the new service

```bash
cd /opt/wolfhouse/WH
git rev-parse HEAD
sudo HERMES_IMAGE=whstagingacr.azurecr.io/wh-hermes-staging:<full-master-sha> \
  docker compose -f docker/hermes-sunset/docker-compose.vm.yml \
  --profile sunset-email-luna \
  up -d --no-deps hermes-sunset-email-luna
```

Do **not** `up` `hermes-sunset-luna` or `hermes-luna`. Do not reload Caddy.

## Inspect live config (no secrets)

```bash
sudo docker exec hermes-sunset-email-luna sh -c 'sed -n "1,20p" "$HERMES_HOME/config.yaml"'
# Expect:
#   model:
#     default: gpt-5.6-sol
#     provider: openai-codex

sudo docker exec hermes-sunset-email-luna sh -c 'test -f "$HERMES_HOME/auth.json" && test ! -L "$HERMES_HOME/auth.json" && echo AUTH_ISOLATED_OK'
sudo docker exec hermes-sunset-email-luna sh -c 'grep -E "^(LUNA_TENANT_ID|LUNA_CLIENT_SLUG|EMAIL_LUNA_DRAFT_LISTEN_PORT)=" "$HERMES_HOME/.env"'
```

## No-send internal model probe

From Lunabox (localhost only; token from env, not from git):

```bash
TOKEN=$(sudo grep ^API_SERVER_KEY= /etc/hermes-sunset-email-luna.env | cut -d= -f2-)
curl -sS -m 25 -D - -o /tmp/mail-mvp-007-probe.json \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"schema":"sunset_email_luna_draft_plan_v1","tenant_id":"sunset","location_key":"sunset-somo","client_id":"<sunset-client-uuid>","location_id":"<sunset-somo-location-uuid>","conversation_id":"<conversation-uuid>","endpoint_id":"<endpoint-uuid>","inbound_message_id":"<inbound-event-uuid>","language":"en","untrusted_email":{"subject":"probe","body_text":"probe","quoted_history":"","from_display_name":"","from_address":""},"private_staff_goals":{"trust":"untrusted_private_staff_instructions_never_guest_copy_never_quoted_guest_history","goals":"Thank them for the msg and then ask them if they want to do a booking"},"request_id":"'"$(python3 -c 'import uuid; print(uuid.uuid4())')"'"}' \
  http://127.0.0.1:8093/v1/internal/email-draft-plan

python3 - <<'PY'
import json
p=json.load(open("/tmp/mail-mvp-007-probe.json"))
assert p["provenance"]["provider"]=="openai-codex"
assert p["provenance"]["model"]=="gpt-5.6-sol"
assert p["provenance"]["runtime"]=="sunset-email-luna"
print("PROBE_PROVENANCE_OK")
PY
```

Transport 200 without those three provenance fields is **not** proof.

## Update only Sunset Staff API

Set (no other tenants):

```
EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED=true
EMAIL_LUNA_HERMES_SOL_BASE_URL=http://<lunabox-reachability-as-operator-directs>
EMAIL_LUNA_HERMES_SOL_TOKEN=<same as API_SERVER_KEY>
```

Keep `LUNA_AUTO_SEND_ENABLED` and `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED` unset/false. Do not set `LUNA_AI_MODEL`. Redeploy **Sunset Staff API only**.

If Lunabox is not reachable from Azure Staff API on `127.0.0.1:8093`, the operator must add a private path **without** restarting the WhatsApp Caddy routes. This PR binds `127.0.0.1:8093` on purpose.

## Controlled Create Draft proof

Before click: count `tenant_email_reply_approvals`, outbound journal rows, and provider sends for the probe conversation (expect unchanged after).

Click **Create Draft** with notes `Thank them for the msg and then ask them if they want to do a booking`.

After:

- Standing draft is the natural thank-you + “Would you like to make a booking?”
- Staff diagnostics show secret-free marker `openai-codex` / `gpt-5.6-sol` / `sunset-email-luna`
- Approval count unchanged
- Journal count unchanged
- Provider send count unchanged
- WhatsApp `hermes-sunset-luna` still running, not recreated

Empty notes must still produce the safe thread-only draft.

## Rollback

```bash
# Staff API: unset EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED (Create Draft falls back to FIX-3 compile)
sudo docker compose -f docker/hermes-sunset/docker-compose.vm.yml \
  --profile sunset-email-luna stop hermes-sunset-email-luna
```

Do not stop `hermes-sunset-luna` or `hermes-luna`.
