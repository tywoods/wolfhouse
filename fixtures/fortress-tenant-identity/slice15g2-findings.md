# FORTRESS Slice 15G2 — Meta authority path design freeze (B02)

**Status:** design frozen (audit only; zero runtime change)
**Master basis:** `a684422903fec3093ac0bb7e13e50f674aec3b7a`
**Boundary:** `B02_meta_normalize_live_client_slug`
**Supersedes:** deferred `FORTRESS-15G` on `fortress/slice-15g-meta-ingress-authority-policy` @ `50f87a1` (do not merge / do not modify)

## Outcome

Freeze a complete, code-grounded source design for Meta WhatsApp POST tenant authority **before** any replacement implementation. Enumerate every real branch after normalization, map `client_slug` / `location_id` through persistence → draft → send → idempotency → response, and name the exact shared owner where authority must be enforced **before PostgreSQL acquisition**.

## Current master path (vulnerable)

`handleMetaWhatsAppWebhookPost` (`scripts/staff-query-api.js:13468-13545`):

1. Read body → optional signature reject (no PG)
2. `normalizeMetaWhatsAppWebhook(body)` — live `client_slug = options.client_slug || 'wolfhouse-somo'`; attaches observe-only `tenant_channel_shadow`; **no live `location_id`**
3. **Always** `withPgClient` → `processMetaWhatsAppWebhookInbound`
4. HTTP 200 with processed envelope (+ audit)

Hard blocking is off. Shadow may resolve Sunset while live handling stays Wolfhouse default (`docs/MULTICLIENT-STAGING-ROUTING.md`).

## Post-normalize branches

| ID | Branch | PG today | Live client_slug | Live location_id |
|----|--------|----------|------------------|------------------|
| BR_INCOMPLETE_IDENTITY | missing wa_message_id / client_slug | yes | default / options | absent |
| BR_DUPLICATE_REPLAY | processed event replay (guest or owner) | yes | lookup by live slug | absent (shadow only in stored JSON) |
| BR_NO_PERSISTENCE_FALLBACK | table_missing → processWithoutPersistence | yes | live default | absent |
| BR_OWNER_COMMAND_CENTER | staff phone → Command Center | yes | staff lookup + send body | not propagated |
| BR_BLOCKED_PHONE_GATE | open-phone testing gate | yes | gate inspects live slug | absent |
| BR_OPEN_DEMO | staging open-demo adapter | yes | normalized or hardcoded `wolfhouse-somo` | not mapped |
| BR_GUEST_PERSIST_DRAFT_SEND | seed + draft + gated send | yes | seed/draft/send/SQL | absent; idempotency `luna:{client}:{wamid}:{kind}` |

Pre-normalize HTTP errors (body read / signature / invalid JSON) never acquire PG and are out of the authority-policy surface except as contrast.

Full machine-readable map: `fixtures/fortress-tenant-identity/slice15g2-branch-matrix.json`.

## Shared owner (authority before PG)

**Exact shared owner:** `processMetaWhatsAppWebhookPostEntry` in `scripts/lib/luna-meta-whatsapp-inbound-process.js` (not present on master; required by replacement).

**HTTP must call only that entry:** `handleMetaWhatsAppWebhookPost` must not call `withPgClient` directly.

**Enforcement order:**

1. `normalizeMetaWhatsAppWebhook`
2. `applyMetaWhatsAppIngressAuthority` (planned module `scripts/lib/meta-whatsapp-ingress-authority.js`)
3. If blocked → authority-blocked envelope, `acquired_pg=false`, **zero** pool/client/persistence/draft/send/owner/demo
4. Else → `withPgClient` → existing inbound branches with authoritative `normalized.client_slug` + `normalized.location_id`

All post-normalize success branches share this choke point; gating inside a single nested branch is insufficient.

## Why 15G is superseded (not modified)

Deferred 15G attempted remediation and needed corrective commits:

1. Gate Meta POST **before** `withPgClient` (blocked identities still acquired PG in the first tip)
2. Propagate trusted `location_id` through real draft/send/idempotency builders

15G2 does **not** amend that branch. It freezes the audited design so replacement `FORTRESS-15H` can implement cleanly from master.

## Replacement acceptance boundary (15H only)

Bounded slice `FORTRESS-15H` / `15H_meta_ingress_authority_enforce_before_pg`:

- Default-off policy; no deploy/activation/routing-file setup in-slice
- Known `phone_number_id` (enabled+routing) → resolver `client_slug`+`location_id` authoritative through persistence, draft, send, idempotency, response
- Unknown/missing/ambiguous/conflicting → block with `acquired_pg=false` and zero downstream calls
- Disabled / routing-absent → exact current shadow-only behavior
- Do not merge deferred 15G; do not rewrite 15A historical B02 `vulnerable` verdict

## Residual risk / blockers

1. Live B02 remains `vulnerable` until 15H + separate operator activation
2. Registry Wolfhouse slug is `wolfhouse` while legacy default is `wolfhouse-somo` — replacement must document/handle alias when authority is active
3. Open-demo hardcoded `wolfhouse-somo` fallback conflicts with authoritative tenants if left unchanged under active authority
4. Deferred 15G tip must not be merged as “done”
