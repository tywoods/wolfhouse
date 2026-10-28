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
- Accepted-master Luna image: `luna-local/hermes-luna@sha256:2297ea44a273d109cb9afe2e2cf302b4bafbfb16dcc659a318d186bbfb3c050d` (image ID read back on France).
- Staff build requested from Dev-01 at source `577a15e3726d40a5294ab65c4b427b62afbd38c4`, root `Dockerfile`, context `.`; digest pending.
- PostgreSQL and nginx immutable digests: pending Dev-01 response.
- Host landing not started; Captain PASS required first.

## Safety readback
No DNS edit, host write, container change, gateway restart, swap change, prune, WhatsApp webhook/number change, outbound send, booking, migration, TEST/Sunset/Lunabox/Oracle mutation, or secret output occurred.

## DNS for Chief/Ty
- `A admin.wolf-house.com -> 178.33.91.59`
- `A wh.lunafrontdesk.com -> 178.33.91.59`

`wh.lunafrontdesk.com` resolved to the target; `admin.wolf-house.com` did not resolve here. Ty owns DNS.
