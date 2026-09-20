# Harbor Switchboard — Crowsnest Communications Luna routing

## Goal
Give authenticated Crowsnest operators a narrow staging-only control for binding the registered staging WhatsApp number to Sunset or Wolfhouse Luna.

## Named slices
1. **Contract Hatch** — define and verify the fixed browser/API contract and authenticated controller proxy. Files: `scripts/verify-crowsnest-communications-routing.js`, `scripts/verify-crowsnest-communications-controller.js`, `scripts/crowsnest-api.js`. Gates: both focused verifiers.
2. **Route Panel** — replace the placeholder with current binding, allowlisted dropdowns, immutable explicit confirmation, verified readback, and correlated audit identity/time. Files: `scripts/lib/crowsnest/crowsnest-page.js`. Gate: focused verifiers plus `node scripts/verify-crowsnest.js`.
3. **Sea Trial** — render at desktop/mobile sizes and run Crowsnest auth/regression gates.

## Preserved boundaries
- Existing Crowsnest login/session and Communications route.
- Same-origin controller contract: targets, effective readback, confirm, apply, audit.
- Crowsnest proxies only those five exact routes to `CROWSNEST_LUNA_ROUTING_CONTROLLER_URL`; missing/invalid configuration fails closed.
- Browser and proxy both allow only `staging-es-34663439419`, `sunset`, and `wolfhouse`; Skipper's controller remains authoritative for token replay/expiry, optimistic concurrency, provider readback, and durable audit.
- A successful apply response must return `audit_event_id` (or `event_id`); the audit readback must contain that exact ID and matching route tuple before the UI reports success.

## Non-goals
- Production routing or production numbers.
- Arbitrary phone numbers, URLs, hosts, shell, Caddy, or webhook mutation.
- Deploying the controller or Crowsnest.
- Port 8094, `/sethome`, guest messaging, or tenant data writes.
