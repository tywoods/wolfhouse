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
6. Only after PASS, create `/etc/wolfhouse-prod/{release,postgres,staff-api,luna}.env`, mode 0600, without printing values. Stripe is TEST.
7. Before any `up`, validate the exact launch inputs. The verifier invokes Compose internally, parses the resolved JSON in memory, and deliberately withholds raw stdout/stderr on both success and failure because expanded values may contain secrets:
   ```bash
   node scripts/verify-wolfhouse-prod-isolation.js \
     --release-env /etc/wolfhouse-prod/release.env \
     --compose-file deploy/wolfhouse-prod/compose.yaml \
     --manifest deploy/wolfhouse-prod/release-manifest.json
   ```
   A PASS proves each resolved service image is digest-pinned and exactly matches `release-manifest.json`, memory/memswap caps match, and Staff/Luna send controls fail closed. Do not use plain `docker compose config` and do not save or print its expanded output.
8. Start only this project with the exact same release file and compose file:
   ```bash
   docker compose --env-file /etc/wolfhouse-prod/release.env -f deploy/wolfhouse-prod/compose.yaml up -d
   ```
9. Read back names, image IDs/digests, limits, network, volumes, ports, health; prove every pre-existing TEST container unchanged.

No host landing before exact-head Captain PASS. Ingress binds loopback only. A later approved edge change may proxy to `127.0.0.1:18080`.

## DNS handoff to Ty
- `A admin.wolf-house.com -> 178.33.91.59`
- `A wh.lunafrontdesk.com -> 178.33.91.59`

Do not use `staff.lunafrontdesk.com`; do not edit DNS here.
