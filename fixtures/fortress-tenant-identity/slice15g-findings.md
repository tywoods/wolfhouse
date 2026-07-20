# FORTRESS Slice 15G — Meta WhatsApp ingress authority policy (B02)

**Status:** remediated in source (default-off); live activation not performed

**Master basis:** `a684422903fec3093ac0bb7e13e50f674aec3b7a`

**Boundary:** `B02_meta_normalize_live_client_slug`

## Outcome

Adds a source-only Meta WhatsApp ingress authority policy. When
`META_WHATSAPP_INGRESS_AUTHORITY` is explicitly enabled **and** channel routing
config is present, a known `phone_number_id` makes the resolver’s
`client_slug` + `location_id` live-authoritative. Unknown, missing, ambiguous,
or conflicting channel identities fail closed **before** pool/client
acquisition, draft, send, or DB work. When the policy is disabled (default),
shadow-only behavior is preserved exactly.

## Controls

- `scripts/lib/meta-whatsapp-ingress-authority.js` — resolve / apply / block gate
- `normalizeMetaWhatsAppWebhook` applies policy after shadow attachment
- `processMetaWhatsAppWebhookPostEntry` evaluates authority before `withPgClient`
- `handleMetaWhatsAppWebhookPost` delegates to that entry (blocked → HTTP envelope
  with zero pool/client/persistence/draft/send/owner/demo calls)
- `processMetaWhatsAppWebhookInbound` still returns authority-blocked envelope
  before find/insert/draft/send when invoked with a blocked normalized payload
- Activation env default-off; no compose/Bicep/ACA env edits in this slice

## Activation gap (explicit)

15G does **not** enable the policy on any runtime and does **not** set up a live
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
the policy is off.
