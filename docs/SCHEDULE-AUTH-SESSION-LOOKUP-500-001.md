# Schedule auth session lookup recovery

Task: `SCHEDULE-AUTH-SESSION-LOOKUP-500-001`

## Evidence and limits

- Reported on Wolfhouse staging, Schedule → Next 30 days; a normal refresh restored the page.
- The UI fetches `/staff/bed-calendar`. `auth session lookup failed` is emitted by shared authentication before calendar queries execute.
- Offline HTTP reproduction injected `ECONNRESET` during the actual session SELECT. Before this change the request returned that exact 500; after it, the same request returns a successful calendar response after a new pool checkout.
- This reproduces a connection-failure mechanism, **not the original staging exception**. Refresh recovery does not establish the exact incident cause. Schema errors and malformed cookies can produce the same old surface message; this change does not disguise them with retries.

## Change

Only `loadAuthSession` uses the recovery wrapper. It retries once (two attempts maximum), after 50 ms, for allowlisted connection codes or exact node-postgres connection-error messages. Recognized failed borrowed connections are marked for discard by the existing `withPgClient` release owner, including the final failed attempt. Checkout failures are also eligible for one retry.

Every retry reruns the existing parameterized, hashed-token SELECT with the same expiry/revocation/active-user filters. No cached identity, cookie extension, auth bypass or role/tenant ACL change. The existing best-effort last-seen update remains best-effort. Business handlers, booking/payment writes and other database operations are not retried.

Each failed DB attempt emits `staff_auth_session_lookup_error` with the existing request ID, connect/lookup stage, allowlisted error code (otherwise `other`), attempt and retry decision. No raw message, SQL, DSN, token, cookie, email or request URL is emitted. Join to `staff_api_request_completion` using `request_id` to see whether the request recovered or ultimately failed.

## Offline verification

```sh
npm run verify:staff-auth-session-recovery
node scripts/verify-staff-auth-api.js
node scripts/verify-inbox-clear-delete-auth.js
node scripts/verify-hermes-send-flags.js
npm run verify:luna-all
```

The regression starts the real HTTP router on loopback and uses real cookie hashing, session lookup SQL, existing ACL and pool-release code; only the PostgreSQL transport is replaced with fixture data and injected failures. It covers healthy reads, connection/query recovery, bounded persistent failures, non-transient failures, safe diagnostics, missing/no-longer-valid sessions, role and tenant denials after recovery, no cross-request auth cache, best-effort last-seen failure, and no retry of the calendar handler. It is registered in `verify:luna-all`.

## Deployment acceptance (operator-owned; not performed here)

1. After an independently approved staging deploy, open the existing signed-in Wolfhouse Schedule and choose Next 30 days. Confirm normal calendar rendering and date navigation.
2. If an auth failure recurs, capture the response's `X-Request-Id` and correlate the bounded diagnostic with the completion record. Do not copy cookies or session tokens into tickets.
3. Persistent failures must remain failures; expired/revoked sessions still require sign-in. A browser refresh alone is not evidence that this patch fixed the original incident.

No deployment, live database mutation, guest send, routing change or credential change is part of this patch.
