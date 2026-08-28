# EMAIL-IMAP-001 — IMAP/SMTP scaffolding boundary

**Status:** scaffolding only. New files, no live mailbox, no production wiring.

This slice adds a **provider-neutral IMAP inbound** helper and a **provider-neutral
SMTP outbound** helper for the generic `imap_smtp` provider. It is deliberately
minimal: config resolution, validation, idempotency keying, and a single-reply
send path — all behind **injected transports** so nothing here can open a socket
on its own.

## What ships

| File | Role |
|------|------|
| `scripts/lib/email-imap-inbound-scaffold.js` | Resolve IMAP config, map inbound messages, dedupe by Message-ID, fetch via injected transport |
| `scripts/lib/email-smtp-outbound-scaffold.js` | Resolve SMTP config, validate one staff reply, send via injected transport |
| `scripts/verify-email-imap-smtp-scaffold.js` | Offline gate; PASS on fixtures, SKIP live IMAP/SMTP when secrets absent |

## Fail-closed contract

- **IMAP inbound** requires `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`. Any missing →
  `{ configured:false, missing:[...] }` and `fetchInbound` refuses with
  `imap_not_configured`. Optional: `IMAP_PORT` (default 993), `IMAP_TLS` (default
  true), `IMAP_MAILBOX` (default `INBOX`).
- **SMTP outbound** requires `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`. Any missing →
  `{ configured:false, missing:[...] }` and `sendStaffReply` refuses with
  `smtp_not_configured`. Optional: `SMTP_PORT` (default 587), `SMTP_STARTTLS`
  (default true), `SMTP_FROM` (default = `SMTP_USER`).

Secrets are never logged, returned upward, or committed. They live only inside the
frozen config object the injected transport reads at connect time.

## No live connect

Neither module ships a default transport. Network I/O is an injected function
(`transportFetch` / `transportSend`). With no transport injected the helpers
return `no_transport_injected`. This makes "no live mailbox tonight" a structural
property, not a promise. The verify script never injects a real transport.

## Idempotency

Inbound messages are keyed by normalized RFC 5322 Message-ID as
`imap_smtp:<mailbox>:<message-id>`. Re-fetching the same message yields the same
`dedupeKey`; `fetchInbound` drops in-batch duplicates and reports the count.

## Auto-send stays OFF

`sendStaffReply` sends exactly one explicitly-provided staff reply. There is no
queue, no loop, no automatic guest reply, and no flag that enables automatic
sending. Automatic outbound is out of scope for this slice by construction.

## Explicitly out of scope (untouched)

Microsoft Graph, Gmail API (PR #594), `inbox-thread.js`, `inbox-context.js`,
Mailbridge (#544), Azure Key Vault, and the Skipper send path. This slice imports
none of them and wires nothing into production or any runtime composition.

## Env Ty must add in the morning (staging only, when going live)

IMAP inbound:
- `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` (required)
- `IMAP_PORT` (optional, default 993), `IMAP_TLS` (optional, default true), `IMAP_MAILBOX` (optional, default INBOX)

SMTP outbound:
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` (required)
- `SMTP_PORT` (optional, default 587), `SMTP_STARTTLS` (optional, default true), `SMTP_FROM` (optional, default = SMTP_USER)

Until those are present the verify SKIPs the live checks and the helpers fail
closed. No deploy is required for this slice.
