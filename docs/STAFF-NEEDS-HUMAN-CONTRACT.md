# Needs-human: Staff supervisor and guest plugin contracts

## Staff/supervisor caller

Use `POST /staff/conversations/<conversation UUID>/needs-human` with an
operator-or-higher Staff session. Supervisor accounts additionally require their
valid conversation-bound lease and the existing supervisor admission rules.

```http
Content-Type: application/json
X-Supervisor-Lease-Token: <lease from supervisor-claim>
```

```json
{"client_slug":"wolfhouse-somo","needs_human":true}
```

`needs_human` must be a JSON boolean, not omitted, null, or a string. `true`
sets the handoff; `false` clears it through the existing clear handler. A UUID
or lease alone does **not** express the requested state. The server must not
silently default an incomplete body to `true`.

The conversation identity comes from the URL and the authorized tenant. Do not
supply a guest phone or simulator capability in the body to influence lookup.
For a stored Wolfhouse Crowsnest simulator conversation, the authenticated Staff
handler derives the exact synthetic phone from that tenant/UUID and its stored
`simulator_synthetic=true` / `source_owner=crowsnest-guest-door` markers. The
handoff writer rechecks those markers and exact identity. Unmarked reserved
phones and wrong-tenant UUIDs remain denied. Synthetic conversations do not send
a guest notification.

## Guest plugin is a different contract

`wolfhouse_staff_api.flag_needs_human` calls
`POST /staff/bot/conversation/needs-human` using the trusted bot tenant and guest
identity. That tool means **set** needs-human; it is not the Staff toggle API.
Do not copy its body to the Staff endpoint without the explicit `needs_human`
boolean, or reroute the guest plugin to the Staff session endpoint. The guest
UUID path retains its simulator exclusion. Failed HTTP responses remain failed;
preserved `blocked_reasons` do not prove a persisted flag.

## November 2026 B4 evidence and verification

The supplied supervisor trace made two direct `requests.post` calls to the same
Staff route. The first omitted the boolean and correctly returned 400. The
second supplied `needs_human:true` but the handoff writer excluded the simulator
identity that staff-state could read. This patch fixes that authenticated Staff
lookup mismatch; it adds no retry, alternate route, or default-true body.

Offline regression: `node scripts/verify-staff-needs-human-simulator-sql.js`.
It executes the production handler and handoff/cause SQL in PGlite, checks the
staff-state readback, and keeps missing-boolean, lease-denial, wrong-tenant,
unmarked-simulator, and guest/bot exclusions. Authentication/lease admission is
an injected test boundary, not a live admission proof.

The external supervisor routine that produced the first malformed request is
not implemented by the guest plugin. Its next staging check must use the Staff
body above. Live post-deploy verification belongs to Lunabot; no live repair,
booking call, send, deploy, or claim that the external caller was changed is
part of this patch.
