# Sunset Luna HTTP runtime — first shared-channel slice (sunset-staging only)

**Status:** SUNSET-LUNA-CARRY-001 source-ready; not deployed or cut over.
**Does not:** change Meta/Caddy, n8n, Stripe, production, or send a guest message.

## Hypothesis (verified)

| Runtime | Pattern | Owns live WhatsApp? |
| --- | --- | --- |
| `hermes-sunset-luna` | `command: gateway run` on Lunabox `:8092` behind Caddy `/whatsapp/*` | **Yes** |
| `hermes-sunset-email-luna` / ACA `luna-sunset-staging-email-luna` | Python HTTP (`email_draft_server.py`), Sol, no gateway | No (Staff email drafts) |
| **`hermes-sunset-luna-http` / ACA `luna-sunset-staging-luna-http`** | Existing Hermes `gateway run`, role `sunset-luna`, port 8094 | Source-capable; no ownership until a separately approved Meta cutover |

The audit found direct reuse is possible at the gateway-owner boundary. Hermes' Meta adapter and turn runner live in the upstream image, while this repo owns its tested Sunset patch bundle. Luna-http therefore selects the same `sunset-luna` role and `gateway run` command rather than teaching the private JSON server a parallel bot.

## Carry contract

1. **Same owner** — upstream Hermes Meta webhook adapter (including verification/signature handling) and agent turn runner.
2. **Same role** — `HERMES_ROLE=sunset-luna` installs the Sunset SOUL, `wolfhouse_staff_api`, GPT-5.6 Sol config, first-answer/voice patches, and shared Staff gate behavior.
3. **ACA example** — `docker/hermes-staging/sunset-luna-http.aca.yaml.example` next to email-luna (internal TLS, port 8094).
4. **Compose profile** — `sunset-luna-http` on Lunabox loopback `127.0.0.1:8094` (opt-in; does not start with default compose).
5. **Same controls** — `WHATSAPP_DRY_RUN` and `LUNA_AUTO_SEND_ENABLED` remain literal-string kill switches; Staff Pause/Luna Off/Auto Off stop sending. Sunset Needs Human remains advisory and does not mute Luna.

The old Python shadow tests remain legacy regression coverage only. They are not proof of the carried gateway and neither `/healthz` nor `/v1/inbound` is configured for this service.

## Required runtime mappings

The dedicated `/opt/data` Azure Files mount must contain a real (not symlinked) `/opt/data/.hermes/auth.json`, with no `.auth-shared` topology. `SUNSET_LUNA_REQUIRE_ISOLATED_AUTH=true` enforces that contract while retaining `HERMES_ROLE=sunset-luna`; this instance never calls `link_shared_auth`. The ordinary live `hermes-sunset-luna` does not set the flag and remains unchanged.

Every other required input is explicit in the ACA manifest:

| Runtime input | Key Vault secret / purpose |
| --- | --- |
| `API_SERVER_KEY` | `luna-http-api-server-key` (gateway bootstrap requirement) |
| `LUNA_BOT_INTERNAL_TOKEN` | `luna-bot-internal-token` (Sunset Staff bot auth) |
| `LUNA_HTTP_DATABASE_URL` | `sunset-database-url` (existing staged mapping; not a replacement send path) |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | `meta-whatsapp-token` (Meta Graph auth) |
| `WHATSAPP_CLOUD_APP_SECRET` | `meta-app-secret` (webhook signature verification) |
| `WHATSAPP_CLOUD_VERIFY_TOKEN` | `meta-whatsapp-verify-token` (webhook challenge verification) |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | `sunset-somo-whatsapp-phone-number-id` (canonical outbound sender; same repo-proven Somo secret) |
| `SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID` | `sunset-somo-whatsapp-phone-number-id` (inbound tenant/location routing) |
| `SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID` | `sunset-sardinero-whatsapp-phone-number-id` (routing uniqueness/fail-closed contract) |
| `WHATSAPP_DRY_RUN` | `whatsapp-dry-run` (must literally be `false` to permit send) |
| `LUNA_AUTO_SEND_ENABLED` | `luna-auto-send-enabled` (must literally be `true` to permit send) |

The gateway uses the existing configured `pause_gate`/Staff `check-guest-automation-gate` path. Staff Pause, Luna Off, or Auto Off blocks guest send; Sunset `Needs Human` is advisory and does not substitute a pause.

## Prove offline

```bash
# Legacy Python shadow regression (29 tests; not carried-gateway proof):
cd docker/hermes-staging && python3 -m unittest \
  wolfhouse.test_luna_http_server \
  wolfhouse.test_luna_http_phase1 \
  wolfhouse.test_luna_http_shadow -v
# Carried gateway/source contract:
node ../../scripts/verify-sunset-luna-http-runtime.js
```

## Deploy (Skipper, sunset-staging only)

Same shape as MAIL-MVP-007:

1. Provision isolated Azure Files share + `/opt/data/.hermes/auth.json` (openai-codex).
2. Put bearer + bot token in Key Vault; never commit.
3. Fill YAML:

```bash
python3 scripts/fill-sunset-luna-http-aca-yaml.py \
  --template docker/hermes-staging/sunset-luna-http.aca.yaml.example \
  --output /tmp/luna-http.aca.yaml \
  --environment-id <env-resource-id> \
  --identity-id <identity-resource-id> \
  --full-master-sha <40-hex-master-sha>
az containerapp create|update -g luna-sunset-staging-rg -n luna-sunset-staging-luna-http --yaml /tmp/luna-http.aca.yaml
```

Do **not** pass `--environment` with `--yaml`. Do **not** recreate `hermes-sunset-luna`.

## Gateway ownership and cutover boundary

Meta currently targets `https://lunabox.lunafrontdesk.com/whatsapp/webhook`; Caddy routes that to the ordinary `hermes-sunset-luna:8092`, which remains the sole live Sunset gateway owner. This source change neither edits that callback nor Caddy. A separately approved operator cutover would move the **same existing gateway webhook owner** to the ACA endpoint after credential, signature/challenge, routing, pause/Needs Human, and both kill-switch checks. It must not add a Meta adapter, route through the Python shadow, or substitute a Staff-send implementation. Production and Wolfhouse numbers remain outside this boundary.
