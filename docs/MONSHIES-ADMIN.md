# Monshies — isolated Sunset Admin agent

**Monshies** is a third Hermes container on Lunabox, dedicated to **Sunset Admin** development. It is isolated from **Luna** (guest WhatsApp) and **Skipper/orchestrator** (Luna training on Discord).

## Why a separate profile

| Profile | Container | Purpose |
|---------|-----------|---------|
| Luna | `hermes-luna` | Guest WhatsApp front desk |
| Skipper | `hermes-orchestrator` | Train/debug Luna SOUL and Hermes staging |
| Monshies | `hermes-monshies-admin` | Sunset Admin tab code, verifiers, extraction work |

Splitting Admin dev work into its own Hermes role prevents accidental Luna SOUL edits, guest tool use, and WhatsApp gateway patches on operator sessions.

## VM layout

| Path | Purpose |
|------|---------|
| `/var/lib/hermes-monshies-admin` | Monshies `HERMES_HOME` |
| `/etc/hermes-monshies-admin.env` | Discord token + allowlist (separate from orchestrator) |
| `docker/hermes-staging/monshies-admin-SOUL.md` | Git source for Monshies identity (baked into image) |

Compose service: `hermes-monshies-admin` in `docker/hermes-staging/docker-compose.vm.yml`.

Port **8643** — API server (Discord gateway). Orchestrator stays on **8642**, Luna WhatsApp webhook on **8090**.

## Bootstrap role

Set `HERMES_ROLE=monshies-admin`. Bootstrap (`docker/hermes-staging/bootstrap.sh`) then:

- Writes a config **without** `wolfhouse_staff_api` toolsets or Luna plugins
- Disables shared agent memory
- Sets terminal cwd to `/opt/wolfhouse/WH`
- Copies `monshies-admin-SOUL.md` → `$HERMES_HOME/SOUL.md`
- Does **not** run WhatsApp gateway patches (`apply_patches`)

## Guardrails (enforced in SOUL + verifier)

1. **Git is source of truth** — commit Admin changes; do not treat Lunabox live edits as durable.
2. **Verifier gate** — run `verify:sunset-admin` (+ i18n) before any deploy claim.
3. **Boundary gate** — run `node scripts/verify-monshies-boundaries.js` after Hermes staging edits.
4. **No guest booking** — Monshies must not enable Luna plugins or Staff API booking tools.
5. **No Staff API deploy** — operator deploys from laptop; Monshies edits code and runs offline verifiers only.

See also: [`SUNSET-ADMIN-DEVELOPMENT.md`](./SUNSET-ADMIN-DEVELOPMENT.md), [`SUNSET-DEVELOPMENT-WORKFLOW.md`](./SUNSET-DEVELOPMENT-WORKFLOW.md) (when merged).

## First-time VM setup (operator)

After merging this branch and rebuilding the Hermes staging image:

```bash
sudo mkdir -p /var/lib/hermes-monshies-admin
sudo chown 10000:10000 /var/lib/hermes-monshies-admin

# Separate Discord bot or channel recommended — copy orchestrator env as template:
sudo cp /etc/hermes-orchestrator.env /etc/hermes-monshies-admin.env
# Edit DISCORD_BOT_TOKEN / DISCORD_ALLOWED_USERS for Monshies

cd /opt/wolfhouse/WH
sudo docker compose -f docker/hermes-staging/docker-compose.vm.yml pull
sudo docker compose -f docker/hermes-staging/docker-compose.vm.yml up -d hermes-monshies-admin
```

## Verification

```bash
bash -n docker/hermes-staging/bootstrap.sh
node scripts/verify-monshies-boundaries.js
node scripts/verify-sunset-package-runtime.js
```

Image rebuild must include `COPY monshies-admin-SOUL.md` in `docker/hermes-staging/Dockerfile` (follow-up if not yet on the branch).
