# Wolfhouse PROD release evidence — S0/S1

## Source
- Accepted master: `577a15e3726d40a5294ab65c4b427b62afbd38c4` (PR #1484 merge)
- Candidate SHA: pending commit
- Captain exact-head review: pending

## S0
- Target/hostname: `178.33.91.59` / `vps-c68bc58e`
- Captured: `2026-10-28T14:19:12Z`; independently re-verified over the approved SSH key path.
- Survey attachment SHA-256: `2c4c12f61a4b2f26c2be7bce7be1ec09514c8d3a7e54ed52278ab94a14bc1c44`.
- Capacity: 6 cores; 11671 MiB RAM total; 8427 MiB available at recheck; zero swap; 46 GiB disk free.
- Listener proof: `127.0.0.1:18080` returned no listener and is selected for private ingress. Existing localhost listeners remain untouched.
- Before-snapshot: running container IDs/names/images/ports/statuses captured read-only; no container mutation occurred.
- Encoded caps: Luna 1536m; Staff 768m; Postgres 1024m.

## S1 build
- Build host: Dev-01, off France; `BUILD_RC=0` from exact `git archive 577a15e3726d40a5294ab65c4b427b62afbd38c4`.
- Accepted-master Luna image: `luna-local/hermes-luna@sha256:2297ea44a273d109cb9afe2e2cf302b4bafbfb16dcc659a318d186bbfb3c050d`.
- Staff image: `luna-local/wh-staff-api@sha256:692913b42cddd55c1c6fe4f674055ec58adbb7a2909f1aee6005d11d3633dde3`; root `Dockerfile`, context `.`.
- PostgreSQL: `postgres@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab`.
- nginx: `nginx@sha256:a3554c0d0b48177b1413c26e01f695334428020d9df01243fbae3e11cfd17417`.
- Images remain on Dev-01; none copied to France. Host landing not started; Captain PASS is required before requesting image movement.

## Exact-release gate
- The gate renders the exact `compose.yaml` + `/etc/wolfhouse-prod/release.env` launch inputs internally; raw Compose stdout/stderr is never emitted because it can contain expanded secrets.
- Per-service checks bind resolved digest-pinned images to `release-manifest.json`, enforce exact memory/memswap caps, and require Staff/Luna outbound controls to fail closed before `up`.
- Offline verifier proof: `14/14 checks passed`, including negative manifest/image mismatch, missing Luna send-off flag, floating image override, and synthetic-secret non-leak checks on success and error receipts.

## Safety readback
No DNS edit, host write, container change, gateway restart, swap change, prune, WhatsApp webhook/number change, outbound send, booking, migration, TEST/Sunset/Lunabox/Oracle mutation, or secret output occurred.

## DNS for Chief/Ty
- `A admin.wolf-house.com -> 178.33.91.59`
- `A wh.lunafrontdesk.com -> 178.33.91.59`

`wh.lunafrontdesk.com` resolved to the target; `admin.wolf-house.com` did not resolve here. Ty owns DNS.
