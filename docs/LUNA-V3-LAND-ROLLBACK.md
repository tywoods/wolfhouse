# Luna v3 landing and rollback

Status: **source-only foundation; HOLD until Captain PASS**.

This document covers Luna v3 (`hermes-luna-clone`) only. It does not authorize a Staff API land, WhatsApp routing, production, Sunset, or changes to Luna Classic.

## Pinned boundary

- Source base: `ccb364e4de3366042ca777c20661dbd20ce010c6`.
- Runtime identity: `hermes-luna-clone`, loopback host port `127.0.0.1:8097`, internal port `8090`.
- Classic identity: `hermes-luna`; frozen source/image label `ccb364e4`; must not be restarted or receive v3 files.
- Tenant: server-bound `wolfhouse-somo`; the model cannot choose it.
- Test identities: valid full numbers under reserved convention `+34 699 9xx xxx`; external sends remain physically disabled.
- Auth: clone-owned Hermes home and auth mount only. No Classic auth fallback or mount.

## Phase 0 readback (2026-10-22)

Read-only Wolfhouse staging evidence:

- active rooms: 13
- active sellable beds: 58
- active Pricing items: 18
- active Pricing rules: 28
- active bookable seasons: 1
- recurring season ranges: 8
- bookings under the reserved `346999…` test prefix: 0

The recurring season data establishes a configured Pricing surface for 2027, but does **not** prove that any particular date/package combination quotes successfully. Phase 4 must call Staff Pricing for each frozen scenario and stop on an unpriced/closed response.

Effective clone transport flags read back as:

- `CUSTOMER_OUTREACH_WHATSAPP_ENABLED=false`
- `STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED=false`
- `STAFF_WHATSAPP_NOTIFICATIONS_DRY_RUN=true`
- `STAFF_WHATSAPP_NOTIFICATIONS_ENABLED=false`

## Source contents

`docker/hermes-luna-v3/` is a fresh image context with:

- model-led SOUL; no Classic planner/composer rules;
- minimal `luna_v3_staff_api` adapter only;
- no import of the old Staff plugin or `accepted_quote`;
- no WhatsApp credential, adapter, webhook, email, SMS, shell, or alert surface;
- clone-only home/auth mounts and explicit CPU/memory limits in the compose template;
- fail-closed environment preflight.

`scripts/lib/model-led-luna/` owns the Staff tool contracts and client boundary. It rejects model-supplied money, tenant/host/provider selection, silent room relaxation, and transport inputs. Every mutation requires an operation key. Responses are facts/status/IDs, never guest copy.

The 15 proposed `/staff/bot/luna-v3/*` routes are registered through the isolated model-led dispatcher. Bot authentication, principal-tenant binding, request-bound `luna-v3:*` sessions, transport-off flags, and recursive authority checks run before an operation. Any operation not explicitly installed in `LUNA_V3_STAFF_OPERATIONS` fails closed with `503 luna_v3_tool_not_registered`; there is no Classic fallback.

Scoped notes are session/tenant-bound and idempotent in the adapter contract. Durable SQL persistence still belongs behind the queued Staff route. Shared General Notes replacement is rejected and remains read-only.

## Crow's Nest boundary

The server-side simulator target is:

- canonical key `luna-v3` (legacy installed alias `wolfhouse-clone` normalizes to it);
- exact response label `Luna v3`;
- clone origin/token environment names only;
- explicit origin **and** token required;
- no Classic token fallback;
- reserved phone prefix enforced;
- image-owned simulator bridge maps each reserved phone to a request-bound `luna-v3:*` Hermes/Staff session key;
- missing/unreachable clone returns an explicit error.

The browser selector is rendered in `scripts/lib/crowsnest/crowsnest-page.js` and contains the canonical `<option value="luna-v3">Luna v3</option>`. The option value reaches only the fail-closed clone target above.

## Pre-land gates

```bash
node scripts/lib/model-led-luna/test-contracts.js
node scripts/lib/model-led-luna/test-staff-routes.js
python3 docker/hermes-luna-v3/plugins/luna_v3_staff_api/test_plugin.py -v
python3 docker/hermes-luna-v3/tests/test_simulator_route.py -v
node scripts/verify-crowsnest-live-simulator.js
python3 docker/hermes-luna-v3/bootstrap.py
```

The aggregate Crow's Nest verifier has a pre-existing authentication-session failure on the pinned base in this operator environment: the test creates a session after importing the auth module and receives `401 unauthorized` at the legacy authenticated HTTP-route assertion. New Luna v3 assertions execute before that point and pass, but the aggregate gate is not green until the baseline issue is reconciled.

## Captain review requirements

Captain must verify the exact commit and confirm:

1. no old plugin, `accepted_quote`, WhatsApp, Classic auth/home, or fallback target;
2. model cannot supply money, tenant, destination, provider mode, or transport authority;
3. operation keys are mandatory on all writes;
4. exact `Luna v3` target is explicit-config-only and reserved-phone-only;
5. no modified file outside the approved list;
6. all 15 Staff routes are authenticated, principal-bound, transport-off, and fail closed until an operation is explicitly installed.

Do not land or deploy before Captain PASS.

## Clone-only land

After PASS, record before changing the clone:

```bash
docker inspect hermes-luna-clone > /root/luna-v3-preland-container.json
docker inspect hermes-luna > /root/luna-v3-classic-control.json
docker image inspect <reviewed-v3-image> > /root/luna-v3-image.json
```

Build/tag the reviewed exact commit, preserve the existing clone-owned data/auth directories, and recreate **only** `hermes-luna-clone`. Read back image ID, mounts, port binding, resource limits, health, transport flags, and auth isolation. Do not recreate Crow's Nest until its separate reviewed UI/source slice is approved.

Acceptance is a reserved-phone Crow's Nest hello plus Staff readback proving no booking, payment link, or send. Tool acceptance waits for the queued Staff route land.

## Rollback

For a v3 runtime fault:

1. stop only `hermes-luna-clone`;
2. restore its recorded pre-land image/config while preserving clone-owned auth/home;
3. recreate only `hermes-luna-clone`;
4. read back health and the current Classic control (same image/start/restarts);
5. revert only the `luna-v3` Crow's Nest option if separately landed.

For a Staff-tool fault, use the separately recorded Staff image/config rollback. Never roll back the shared database, restart Classic, or prune retained images/evidence.
