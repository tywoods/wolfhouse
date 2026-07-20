# FORTRESS Slice 15H — Meta WhatsApp ingress authority enforce before PG (B02)

**Status:** remediated in source (default-off); live activation not performed

**Master basis:** `9a09f479f1a65fec45557cf2c94c5e9628b902dc` (clean master after 15G2 design freeze)

**Boundary:** `B02_meta_normalize_live_client_slug`

**Design freeze:** `FORTRESS-15G2` contract + branch matrix

**Deferred 15G:** `fortress/slice-15g-meta-ingress-authority-policy` @ `50f87a1` — do not merge / do not modify

## Outcome

Implements the frozen 15G2 acceptance boundary. When
`META_WHATSAPP_INGRESS_AUTHORITY` is explicitly enabled **and** channel routing
config is present, a known `phone_number_id` makes the resolver’s
`client_slug` + `location_id` live-authoritative through persistence, draft,
send, idempotency, response, owner, open-demo, phone gate, replay, and
terminal paths. Unknown, missing, ambiguous, or conflicting channel identities
fail closed **before** `withPgClient` via `processMetaWhatsAppWebhookPostEntry`
(`acquired_pg=false`). When the policy is disabled (default) or routing is
absent, shadow-only behavior is preserved exactly.

## Controls

- `scripts/lib/meta-whatsapp-ingress-authority.js` — resolve / apply / block gate;
  `REPLAY_IDENTITY_COMPARE_REJECT_FILL`; `ERROR_IDENTITY_STRUCTURED_EFFECTIVE_NORMALIZED`
- `processMetaWhatsAppWebhookPostEntry` applies authority after normalize and
  **before** `withPgClient`; returns effective post-authority normalized for HTTP audit
- Trusted `normalized.location_id` reaches real draft/send/owner/open-demo builders;
  location-scoped idempotency when present; legacy keys unchanged when absent
- Historical replay looks up candidates by `wa_message_id` only (does not trust the
  requested tenant). Ambiguous or nonempty client/location conflicts are rejected
  with `event_row=null` and non-sensitive replay metadata only (no cross-tenant row
  content). Legacy-missing location is filled in the **response** only; history is
  never rewritten for processed or unprocessed historical candidates; no duplicate
  event is inserted
- Cross-tenant `wa_message_id` claim uses PostgreSQL session advisory locks
  (`pg_advisory_lock(hashtext(ns), hashtext(wa_message_id))`) so concurrent
  cross-slug inserts cannot both win without requiring an unapplied
  `UNIQUE(wa_message_id)` schema constraint at code rollout
- Enabled-without-routing is byte/shape-compatible with default shadow (no
  `ingress_authority` metadata)
- Owner reads remain **tenant-wide** (`client_slug` only)
- Open-demo skips conflicting hardcoded `wolfhouse-somo` fallback when authority is active
- Activation env default-off; no compose/Bicep/ACA env edits in this slice
- Offline verifier uses a real HTTP/`withPgClient` harness (not helper-only) across
  guest, owner, open-demo, phone-gate, table-unavailable, terminal, processed
  replay, unprocessed conflict, audit, send, response, and structured-error branches

## Activation gap (explicit)

15H does **not** enable the policy on any runtime and does **not** set up a live
routing file. Closing live B02 still requires a later operator step:

1. Verified `CLIENT_CHANNEL_ROUTING_*` map on the target runtime
2. `META_WHATSAPP_INGRESS_AUTHORITY=1` (or `true`/`yes`/`on`)
3. Restart / new revision — outside this slice

Until then, historical 15A B02 remains the live posture (`vulnerable` /
shadow-only).

## Residual risk

Enabling authority without an accurate routing map will hard-block unknown
`phone_number_id` values. Resolver `client_slug` for Wolfhouse is `wolfhouse`
(location `wolfhouse-somo`); legacy Meta default remains `wolfhouse-somo` when
the policy is off. Do not merge deferred 15G.
