# Wolfhouse production isolated runtime — S0/S1

## Boundary
Classic only. No Crow's Nest, migrations, test bookings, WhatsApp webhook/number changes, outbound sends, DNS edits, gateway restarts, swap, cleanup, or prune. Existing TEST, Sunset, Lunabox, and Oracle are read-only.

## S0 — read-only host survey
```bash
ssh root@178.33.91.59 'set -eu; hostname; free -m; swapon --show; ss -ltnp; docker ps --no-trunc --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Ports}}|{{.Status}}"; docker inspect $(docker ps -q) --format "{{.Name}}|memory={{.HostConfig.Memory}}|memory_swap={{.HostConfig.MemorySwap}}"'
```
Save the before-snapshot. Confirm zero swap, headroom, and a free private port (default `127.0.0.1:18080`). Caps: Luna 1536m, Staff 768m, Postgres 1024m. Equal memory/memory-swap limits prohibit additional swap allocation.

## S1 — build and gate
1. Start at accepted source `577a15e3726d40a5294ab65c4b427b62afbd38c4`.
2. Build Staff and Luna off-host; push immutable images and record registry digests in `release-manifest.json`.
3. Resolve immutable Postgres/nginx digests. Never land floating tags.
4. Run the verifier self-tests (including leak and negative release cases):
   ```bash
   node scripts/verify-wolfhouse-prod-isolation.js --self-test
   ```
5. Obtain Captain PASS on the exact candidate SHA; amendments invalidate PASS.
6. Only after PASS, create `/etc/wolfhouse-prod/{release,postgres,staff-api,staff-meta,luna}.env`, mode 0600, without printing values. Stripe is TEST.
   `staff-meta.env` is required (Compose `env_file` for staff-api). Populate it secret-safe from the prod-owned store / Key Vault. Required keys, names only:
   ```dotenv
   META_APP_SECRET=
   META_WHATSAPP_VERIFY_TOKEN=
   ```
   Never commit values. Never embed those credentials in Compose or Git. A missing file or missing key fail-closes at process start; do not make the file optional.
   The Luna file must include the public Wolfhouse phone-number ID alongside the
   selected `WA_*` credentials:
   ```dotenv
   WA_PHONE_NUMBER_ID=1383127691556412
   WHATSAPP_DRY_RUN=true
   LUNA_AUTO_SEND_ENABLED=false
   CUSTOMER_OUTREACH_WHATSAPP_ENABLED=false
   ```
   If any selected `WA_*` key is present while `WA_PHONE_NUMBER_ID` is absent or
   malformed, Luna fails closed with `identity_malformed` and does not bind its
   private internal port. These values do not expose a webhook or enable outbound.
7. Before any `up`, validate the exact launch inputs. The verifier invokes Compose internally, parses the resolved JSON in memory, and deliberately withholds raw stdout/stderr on both success and failure because expanded values may contain secrets:
   ```bash
   node scripts/verify-wolfhouse-prod-isolation.js \
     --release-env /etc/wolfhouse-prod/release.env \
     --compose-file deploy/wolfhouse-prod/compose.yaml \
     --manifest deploy/wolfhouse-prod/release-manifest.json
   ```
   A PASS proves each resolved service image is digest-pinned and exactly matches `release-manifest.json`, memory/memswap caps match, and Staff/Luna send controls fail closed. Do not use plain `docker compose config` and do not save or print its expanded output.
7b. **Existing-network preflight (read-only). Stop on mismatch.** Do not add IPAM to Compose. Do not recreate or delete the current France network.
   ```bash
   docker network inspect wolfhouse-prod-private --format '{{json .}}' > /tmp/wolfhouse-prod-private.inspect.json
   node scripts/verify-wolfhouse-prod-network-preflight.js --inspect-json /tmp/wolfhouse-prod-private.inspect.json
   ```
   PASS means the owned internal network is `wolfhouse-prod-private`, `Internal=true`, subnet `172.29.0.0/16`, and `172.29.0.4` / `172.29.0.5` are free or owned by `wolfhouse-prod-luna` / `wolfhouse-prod-ingress`. Missing network, wrong subnet, not internal, or a foreign owner is **stop on mismatch** — do not `up`, do not `docker network rm`, do not edit IPAM on the live network.

8. Start only this project with the exact same release file and compose file:
   ```bash
   docker compose --env-file /etc/wolfhouse-prod/release.env -f deploy/wolfhouse-prod/compose.yaml up -d
   ```
9. Read back names, image IDs/digests, limits, network, volumes, ports, health; prove every pre-existing TEST container unchanged.

No host landing before exact-head Captain PASS. Ingress still publishes loopback `127.0.0.1:18080`. Because `wolfhouse-prod-private` is `internal: true`, host Caddy cannot rely on that publish; pin ingress `ipv4_address: 172.29.0.5` and Luna `ipv4_address: 172.29.0.4` so the host proxy can reach nginx and the Classic webhook on the existing private subnet. Do not add ipam to a live network (compose will try to recreate it).

## Fresh-host / recovery network bootstrap (explicitly approved; does not replace a live network)

Use this **only** when `wolfhouse-prod-private` does not exist. Never on a host where the preflight already found that network. Never docker network rm. Never `compose down` to rebuild the network. This path creates the required subnet without replacing a live network:

```bash
docker network create --driver bridge --internal --subnet 172.29.0.0/16 --gateway 172.29.0.1 wolfhouse-prod-private
docker network inspect wolfhouse-prod-private --format '{{json .}}' > /tmp/wolfhouse-prod-private.inspect.json
node scripts/verify-wolfhouse-prod-network-preflight.js --inspect-json /tmp/wolfhouse-prod-private.inspect.json
```

Run inspect + preflight immediately after create. If the create is rejected because the name exists, **stop on mismatch** and return to the read-only preflight. Do not add `ipam:` to `compose.yaml`.

## Host Caddy (prod WhatsApp hostname)

`whatsapp.lunafrontdesk.com` routes **only** `/whatsapp/webhook` to prod Luna Classic at `172.29.0.4:8090`. Everything else on that host is 404. `wh.lunafrontdesk.com` 404s `/staff/meta/whatsapp/webhook` so Meta has one public address. Backup `/etc/caddy/Caddyfile`, `caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy` (reload only). Do not edit TEST site blocks.

## Later dry-run flip (Ty GO only — do not do this in this slice)

Compose `environment` currently hard-sets `WHATSAPP_DRY_RUN: 'true'` on **luna** and **staff-api**, which overrides env files. After a prod System User token exists:

1. Recreate **prod Luna first**: change only the luna service line to `WHATSAPP_DRY_RUN: 'false'`, then `docker compose --env-file /etc/wolfhouse-prod/release.env -f compose.yaml up -d --no-deps --force-recreate luna`.
2. Then recreate **prod Staff**: same one-line change on staff-api, then `up -d --no-deps --force-recreate staff-api`.

Keep `LUNA_AUTO_SEND_ENABLED: 'false'`, `CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false'`, and Staff alerts off. Stripe stays test until a later job. Do not flip dry-run in this PR.

## Encrypted blob recovery proof

The nightly timer invokes `/usr/local/sbin/wolfhouse-prod-backup`. Backups are
encrypted before upload to the private Azure blob container; they are not stored
under `/opt/wolfhouse-prod/backups`. Never print `/etc/wolfhouse-prod/backup.env`
or pass its expanded values on a command line.

Run the supported proof as root:

```bash
sudo /usr/local/sbin/wolfhouse-prod-restore-proof
```

The proof downloads the last successful encrypted blob, verifies its recorded
size and SHA-256, decrypts to a mode-0600 temporary file, validates the archive,
and restores it into a uniquely named temporary database inside
`wolfhouse-prod-postgres`. It compares every non-system table count with live
`wolfhouse_prod` and succeeds only with `RESTORE_OK`. Its exit trap drops only
the temporary recovery database. It must never restore over the live database.

For evidence, record the blob object name, recorded size, recorded SHA-256,
temporary database name, number of matched tables, and final `RESTORE_OK` line.
Do not record SAS values, encryption keys, database passwords, or decrypted dump
content. A missing state file, checksum mismatch, decrypt failure, archive error,
or table-count mismatch is a failed recovery proof; stop and investigate rather
than bypassing the check.

## DNS handoff to Ty
- `A admin.wolf-house.com -> 178.33.91.59`
- `A wh.lunafrontdesk.com -> 178.33.91.59`

Do not use `staff.lunafrontdesk.com`; do not edit DNS here.
