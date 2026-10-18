# Luna routing controller: reviewed installation and operations

## Network/TLS model

Public clients (including Crow’s Nest) connect to the normal **HTTPS Caddy origin** and validate its public certificate normally. Caddy alone terminates TLS. It forwards only the exact path
`/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook` to plain HTTP
`127.0.0.1:8096/v1/routes/meta-whatsapp-verified-webhook`. The controller binds only
`127.0.0.1`; it has no certificate or private-key configuration. Request HMAC, timestamp,
and nonce validation remain mandatory. Configure Crow’s Nest with an `https://` origin.
There is no wildcard controller route.

For France TEST, the allowlisted site is `whatsapp-staging.lunafrontdesk.com`. Its
pre-cutover contract exposes only the exact controller and proof handles above; it does
**not** import the mutable webhook fragment and does not add a broad `/whatsapp/*`
fallback. Therefore `/whatsapp/webhook` remains absent until a separately authorized
single-receiver cutover. Effective-route readback accepts the exact route only when the
Caddy admin JSON binds it to this hostname.

Required DNS for the later authorized host phase:

```text
A  whatsapp-staging.lunafrontdesk.com  178.33.91.59
```

Do not publish an AAAA record unless the France host has an approved reachable IPv6
address. DNS/TLS preparation does not authorize a Meta callback change or webhook
activation.

The same reviewed contract sends exact `GET /whatsapp/routing-proof` directly to the
isolated Sunset staging runtime on `127.0.0.1:8094`, ahead of both the mutable webhook
route and the broad Wolfhouse `/whatsapp/*` fallback. Sunset signs a fresh no-store proof
with `LUNA_ROUTING_INGRESS_PROOF_KEY`; no other Hermes role registers this endpoint.

## Least-privilege Caddy contract

The root installer adds this marked routing contract in the unique
`lunabox.lunafrontdesk.com` site, immediately before its single broad
`reverse_proxy /whatsapp/* ...` anchor:

```caddyfile
# BEGIN luna-routing-contract
handle /_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook {
  rewrite * /v1/routes/meta-whatsapp-verified-webhook
  reverse_proxy 127.0.0.1:8096
}
handle /whatsapp/routing-proof {
  reverse_proxy 127.0.0.1:8094
}
import /var/lib/luna-routing/luna-number-route.caddy
# END luna-routing-contract
```

The unprivileged `luna-routing` controller can modify only that dedicated fragment. It
cannot read, write, rename, or chown `/etc/caddy/Caddyfile`. It accepts only the canonical
exact `/whatsapp/webhook` fragment, validates a minimal temporary wrapper importing the
candidate with fixed `/usr/bin/caddy`, preserves fragment uid/gid/mode, atomically replaces the
fragment, asks Caddy's localhost admin endpoint to reload the canonical root config, and verifies the
effective admin JSON.

## Installation

Review all files and prepare `/root/luna-routing.env` from `controller.env.example` with
real 32+ byte HMAC/proof keys and the HTTPS proof URL. Set `LUNA_ROUTING_SITE`
to the exact selected allowlisted site (`lunabox.lunafrontdesk.com` by default, or
`whatsapp-staging.lunafrontdesk.com` for France); the installer refuses a mismatch
between that value and its selected site. The installer also requires the exact
`LUNA_ROUTING_MUTATIONS_ENABLED=false` line; the controller also defaults to disabled
when the variable is absent. Authenticated POST flip, rollback, and recovery/replay calls
then return `403 mutations_disabled` before locks, journals, ledgers, fragment writes,
proof fetches, validation, or reloads. Put the same proof key in the
Sunset runtime secret file as `LUNA_ROUTING_INGRESS_PROOF_KEY`; never put it in compose or
git. Do not add TLS key/cert variables.
Then (legacy Lunabox example only):

```sh
sudo env CADDYFILE=/etc/caddy/Caddyfile CADDY_BIN=/usr/bin/caddy \
  deploy/luna-routing/install-luna-routing.sh --dry-run
sudo env CONTROLLER_ENV=/root/luna-routing.env CADDYFILE=/etc/caddy/Caddyfile \
  CADDY_BIN=/usr/bin/caddy deploy/luna-routing/install-luna-routing.sh --install
sudo deploy/luna-routing/install-luna-routing.sh --verify
```

`--dry-run` performs source/static checks without requiring host Caddy. `--install` is
root-only, validates a self-contained candidate importing the staged fragment before mutation, captures the prior unit's presence plus enabled/active state, creates the system user/group and directories, copies
the script/unit/environment/tmpfiles/initial Wolfhouse fragment, removes the obsolete controller sudoers rule, validates the canonical final candidate after its fragment exists, and metadata-preservingly patches the root Caddyfile last,
then daemon-reloads, enables/starts the controller, reloads Caddy, and verifies readback.
It traps partial failures and restores prior artifacts, daemon/Caddy runtime configuration, and
the prior controller enabled/active state while preserving the original failure. Rollback errors
are reported loudly. A newly created inert system identity/group and empty directories may remain;
no service, root Caddy configuration, installed runtime artifact, or active runtime drift may remain.
It fails closed on duplicate sites,
routes, markers, misleading comments, or partial contracts. Reinstall is idempotent and
repairs missing artifacts; use `--update-contract` for reviewed contract drift and `--verify`
for host/service-user read checks.

### France TEST staged-install sequence (requires a separate Chief dispatch)

This repository change is not permission to run these steps. Before applying, snapshot
and hash the Caddyfile, routing artifacts, unit/env files, ownership/modes, and controller
and Caddy enabled/active state. Create a fresh exact site block for
`whatsapp-staging.lunafrontdesk.com`, then prove the candidate without mutation:

```sh
sudo env LUNA_ROUTING_SITE=whatsapp-staging.lunafrontdesk.com \
  CADDYFILE=/etc/caddy/Caddyfile \
  deploy/luna-routing/install-luna-routing.sh --dry-run
```

After secrets and certificates are provisioned through the approved operator path, use a
Host/SNI override to `178.33.91.59` before DNS publication. Confirm the candidate has the
controller/proof handles but no `/whatsapp/webhook`, no broad `/whatsapp/*`, and no route
fragment import. Only then may the separately dispatched operator run `--install`, which
will restart only the loopback routing controller onto the installed read-only generation and perform one validated Caddy reload. Re-read the
service generation, loopback port, effective Caddy JSON, unrelated sites, and exact
authenticated GET plus safe health. The signed POST refusal/recovery matrix remains an
offline synthetic HMAC rejection test only; do not send any host POST or webhook probe.

On any partial failure, restore both files and the captured service/Caddy runtime state;
report `ROLLBACK INCOMPLETE` if any restoration command fails. Do not copy a prior host's
journal or ledger. Meta callback changes, webhook activation, Luna restarts, guest sends,
and a second active receiver remain separate prohibited operations.

## Database order (Azure PostgreSQL)

Azure live acceptance is a deployment prerequisite; static SQL checks cannot prove the
managed-service role policy. Run all three steps against the same database and through
the designated Azure admin principal:

1. `CROWSNEST_ADMIN_DSN=... scripts/bootstrap-crowsnest-comms-roles.sh` creates or
   validates NOLOGIN owner/API roles and establishes explicit membership/admin options.
2. Run canonical migration 103 with that admin/migration principal. It requires the
   roles, executes `SET LOCAL ROLE crowsnest_comms_owner`, creates objects directly under
   that owner, and grants only API privileges.
3. Create a distinct safe LOGIN using the platform process, then run
   `CROWSNEST_ADMIN_DSN=... CROWSNEST_RUNTIME_ROLE=... scripts/provision-crowsnest-comms-runtime-role.sh`.
   It validates LOGIN attributes, admin authority, API membership, and absence of direct
   schema/table/function ownership.
