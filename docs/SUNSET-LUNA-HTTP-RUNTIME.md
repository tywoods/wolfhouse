# Sunset Luna HTTP runtime — first shared-channel slice (sunset-staging only)

**Status:** Additive scaffolding. Live guest WhatsApp stays on `hermes-sunset-luna`.
**Does not:** cut over Meta WhatsApp, touch Caddy `/whatsapp/*`, n8n, Stripe, production, or guest send.

## Hypothesis (verified)

| Runtime | Pattern | Owns live WhatsApp? |
| --- | --- | --- |
| `hermes-sunset-luna` | `command: gateway run` on Lunabox `:8092` behind Caddy `/whatsapp/*` | **Yes** |
| `hermes-sunset-email-luna` / ACA `luna-sunset-staging-email-luna` | Python HTTP (`email_draft_server.py`), Sol, no gateway | No (Staff email drafts) |
| **`hermes-sunset-luna-http` / ACA `luna-sunset-staging-luna-http`** | Python HTTP (`luna_http_server.py`), Sol + Sunset SOUL + `wolfhouse_staff_api` | **No** (probe/inbound JSON only) |

Email-luna is the extraction template. WhatsApp remains `gateway run` until a later, explicit Meta cutover.

## What this slice adds

1. **HTTP service** — `GET /healthz`, `POST /v1/inbound` (Bearer `API_SERVER_KEY`).
2. **Bootstrap role** `HERMES_ROLE=sunset-luna-http` — isolated Sol home, Sunset SOUL, Staff plugin tree, no WhatsApp/Discord patches, no Meta tokens.
3. **ACA example** — `docker/hermes-staging/sunset-luna-http.aca.yaml.example` next to email-luna (internal TLS, port 8094).
4. **Compose profile** — `sunset-luna-http` on Lunabox loopback `127.0.0.1:8094` (opt-in; does not start with default compose).
5. **First-answer behavior** — fake inbound with `date` + `quantity` (no `slot_time`) calls `get_sunset_lesson_availability`, which short-circuits to joinable/course leftover (`scope: course_choices`, `has_fitting_course`, `do_not_claim_date_full`) — never daily-full invent (#844/#845).

Outbound, if requested (`outbound_mode=staff_draft`), posts draft-only to Staff API `/staff/bot/guest-reply-draft`. There is **no** Meta Graph client in this runtime.

## Prove offline

```bash
python3 -m unittest docker.hermes-staging.wolfhouse.test_luna_http_server -v
# or from repo root:
cd docker/hermes-staging && python3 -m unittest wolfhouse.test_luna_http_server -v
node scripts/verify-sunset-luna-http-runtime.js
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

## Later — Meta WhatsApp cutover (NOT this PR)

When (and only when) operators explicitly approve a cutover:

1. Prove ACA `luna-sunset-staging-luna-http` healthz + private inbound against Staff staging.
2. Add a **Meta Cloud webhook adapter** in front of `/v1/inbound` (or a sibling path) that verifies the Meta signature and maps webhook payloads → the private JSON contract. Still no parallel Graph send client — replies go through Staff `/staff/bot/guest-reply-send` (or existing send-reply helpers) under the same kill switches.
3. Point **staging** Meta app webhook from `https://lunabox.lunafrontdesk.com/whatsapp/webhook` (Caddy → `hermes-sunset-luna:8092`) to the new path **only after** dual-run / shadow proof. Prefer a temporary dual-receive or traffic-mirror step before flipping the Meta console URL.
4. Keep Caddy `/whatsapp/*` unchanged until that flip; do not half-wire Lunabox Caddy to the ACA while Meta still targets Lunabox.
5. Production and Wolfhouse WhatsApp numbers stay untouched.

Until that program, Hermes-sunset-luna owns live guests.
