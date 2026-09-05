# Sunset Coastal Workspace — design preview

Standalone, public, fictional-data prototype. This is not the Staff API and does not import application code, secrets, Postgres, Stripe, WhatsApp or email integrations.

## Serving

`node server.cjs` serves the bundled `index.html` on `127.0.0.1:8710`. Optional `DESIGN_PREVIEW_PORT` supports isolated local testing. `/`, `/staff/login` and `/staff/ui` intentionally open the same mockup with no authentication. Only GET/HEAD are accepted; unknown routes return 404 and writes return 405. CSP disables network connections, external scripts, frames and form submissions. No indexing.

## Deployment scope

Only the existing `design-sandbox.service` on Lunabox, behind the existing `design-sunset.lunafrontdesk.com` Caddy host, may be switched to these artifacts. No Caddy changes, new Azure resources or staging/production Staff API changes are required.

Publish the exact source files to a SHA-qualified directory under `/opt/wolfhouse/design-previews/`. Add a `coastal-preview.conf` drop-in to `design-sandbox.service`, overriding WorkingDirectory/ExecStart and clearing inherited EnvironmentFile. Restart only `design-sandbox.service`. Verify localhost health, the exact public path, unauthenticated access, CSP, rejected write/API routes and a rendered browser screenshot.

## Rollback

Remove only the task-created `/etc/systemd/system/design-sandbox.service.d/coastal-preview.conf`, run `systemctl daemon-reload`, and restart `design-sandbox.service`. The original unit, environment file and original `/opt/wolfhouse/wh-design-sandbox` checkout are preserved. Confirm the old design sandbox login returns. Do not delete shared worktrees or original design assets.

## Acceptance

This is a visual concept, not a feature release. Navigation/drawers/local editing are illustrative only. Sample content must be visibly labelled; sending, payments and real persistence are unavailable. User approval is required before applying any of this redesign to Sunset staging.
