# Sunset staging WhatsApp silence — +34 663 43 94 19

**Scope:** sunset-staging on Lunabox only. No production. No merge/deploy in this doc.  
**Date basis:** live read-only facts 2026-08-30.

## Verdict

Guests texting **+34 663 43 94 19** (Meta `phone_number_id` ending `…3109`) already hit
**Sunset Somo Luna** (`hermes-sunset-luna:8092` via Caddy `/whatsapp/*`). Tenant routing
already accepts that id when `SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID` ends `…3109`.

**Actual silence cause:** both WhatsApp kill switches are **unset** on
`/etc/hermes-sunset-luna.env`, so Hermes fail-closes every guest send:

1. `LUNA_AUTO_SEND_ENABLED` unset → `luna_auto_send_not_enabled` (decides first)
2. `WHATSAPP_DRY_RUN` unset → dry run stays **on** (would still block even if auto were open)

This is intentional fail-closed behaviour (`docker/hermes-staging/wolfhouse/send_flags.py`),
not a missing phone_number_id map and not broken Caddy.

## Ruled out (do not “fix” these first)

| Hypothesis | Live truth |
|------------|------------|
| Unknown `phone_number_id` fail-closed | `SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID` already ends `…3109` |
| Caddy still on Wolfhouse `:8090` | Live `/whatsapp/*` → `:8092` Sunset |
| Missing `SUNSET_SOMO_WHATSAPP_NUMBER` | Unset; Hermes routing/send use Meta id / process env — **not** this E.164 |
| `WHATSAPP_PHONE_NUMBER_ID` unset | Hermes outbound uses `WHATSAPP_CLOUD_PHONE_NUMBER_ID` (set, ends `…3109`) |
| Inbox Draft\|Auto alone | UI prefs do **not** set `LUNA_AUTO_SEND_ENABLED` (see `verify-autonomy-ui-001`) |

## Skipper — smallest sunset-safe fix (live env only)

On Lunabox, edit **`/etc/hermes-sunset-luna.env`** (do not print or commit secrets):

```bash
WHATSAPP_DRY_RUN=false
LUNA_AUTO_SEND_ENABLED=true
```

Optional (Staff API / Inbox channel label hygiene — **not** required for Hermes reply):

```bash
SUNSET_SOMO_WHATSAPP_NUMBER=+34663439419
```

Recreate **only** Sunset WhatsApp Luna:

```bash
cd /opt/wolfhouse/WH/docker/hermes-sunset
sudo docker compose -f docker-compose.vm.yml up -d --no-deps --force-recreate hermes-sunset-luna
```

Do **not** set these on production. Do **not** enable global auto-send on Staff API Azure
without a separate approval. Do **not** change Wolfhouse `/etc/hermes-luna.env` for this test.

### Before texting — staff portal gates (already wired)

After kill switches are open, a guest still gets silence if any of these block:

- Conversation **Luna On** off
- Conversation **needs_human**
- **Global Pause** on
- Inbox WhatsApp mode left on **Draft** (staff-facing; Hermes still needs kill switches open for Auto to mean anything)

Staff **Send** from the portal is a separate path and is not blocked by Hermes kill switches.

## Proof offline

```bash
python3 docker/hermes-staging/wolfhouse/test_send_flags.py
node scripts/verify-sunset-whatsapp-silence.js
node scripts/verify-hermes-send-flags.js
```

## Related

- `docs/LUNA-SEND-KILL-SWITCH.md` — flag semantics + Sunset section
- `docker/hermes-sunset/docker-compose.vm.yml` — `:8092`, env_file path
- `docker/hermes-staging/sunset_tenant_routing.py` — fail-closed on unknown Meta id
