# Wolfhouse PROD release evidence — S0/S1

## Source
- Accepted master: `577a15e3726d40a5294ab65c4b427b62afbd38c4` (PR #1484 merge)
- Candidate SHA: pending commit
- Captain exact-head review: pending

## S0
- Target: `178.33.91.59`
- **BLOCKED:** runner SSH rejected (`Permission denied (publickey)`). No host mutation attempted.
- Headroom/listeners/zero-swap/before-snapshot: pending host-capable capture.
- Proposed private ingress: `127.0.0.1:18080`, subject to listener proof.
- Encoded caps: Luna 1536m; Staff 768m; Postgres 1024m.

## S1 build
- **BLOCKED:** off-host Docker daemon unavailable in this runner.
- Staff, Luna, PostgreSQL, nginx digests: pending.
- Host landing not started; Captain PASS required first.

## Safety readback
No DNS edit, host write, container change, gateway restart, swap change, prune, WhatsApp webhook/number change, outbound send, booking, migration, TEST/Sunset/Lunabox/Oracle mutation, or secret output occurred.

## DNS for Chief/Ty
- `A admin.wolf-house.com -> 178.33.91.59`
- `A wh.lunafrontdesk.com -> 178.33.91.59`

`wh.lunafrontdesk.com` resolved to the target; `admin.wolf-house.com` did not resolve here. Ty owns DNS.
