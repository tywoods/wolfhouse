# FORTRESS Slice 15G2 — Meta authority path design freeze (B02)

**Status:** design frozen (audit only; zero runtime change)
**Master basis:** `a684422903fec3093ac0bb7e13e50f674aec3b7a`
**Boundary:** `B02_meta_normalize_live_client_slug`
**Supersedes:** deferred `FORTRESS-15G` on `fortress/slice-15g-meta-ingress-authority-policy` @ `50f87a1` (do not merge / do not modify)

## Outcome

Freeze a complete, **source-anchor-driven** design for Meta WhatsApp POST tenant authority **before** any replacement implementation. Enumerate every real pre- and post-normalize branch, map `client_slug` / `location_id` through persistence → draft → send → idempotency → response → HTTP audit, and name the exact shared owner where authority must be enforced **before PostgreSQL acquisition**.

## Taxonomy (pre vs post normalize)

| Class | Meaning |
|-------|---------|
| **pre_normalize** | HTTP failures before `normalizeMetaWhatsAppWebhook` (body read / signature / invalid JSON). No live identity. `acquires_pg=false`. Outside the authority-identity surface except as contrast. |
| **post_normalize** | Everything after successful normalize on master today (incomplete identity, replay, unprocessed conflict continue, table-unavailable, owner, phone gate, open-demo ± validation failure, guest draft/send, terminal no-draft/send, PG/downstream errors). |

Completeness is proven by `source_anchors` in `slice15g2-branch-matrix.json` (pattern present in named source file → maps to a branch id), **not** by a self-authored ID checklist in the verifier.

## Current master path (vulnerable)

`handleMetaWhatsAppWebhookPost` (`scripts/staff-query-api.js:13468-13545`):

1. Read body → optional signature reject (no PG) — **pre_normalize**
2. `normalizeMetaWhatsAppWebhook(body)` — live `client_slug = options.client_slug || 'wolfhouse-somo'`; attaches observe-only `tenant_channel_shadow`; **no live `location_id`**
3. **Always** `withPgClient` → `processMetaWhatsAppWebhookInbound` (no try/catch around PG)
4. HTTP 200 audit logs that same `normalized` object (+ response)

Hard blocking is off. Shadow may resolve Sunset while live handling stays Wolfhouse default (`docs/MULTICLIENT-STAGING-ROUTING.md`).

## Branch matrix (corrected)

### Pre-normalize

| ID | Branch | PG |
|----|--------|----|
| BR_HTTP_ERROR_BODY_READ | body read throws | no |
| BR_HTTP_ERROR_SIGNATURE | signature reject | no |
| BR_HTTP_ERROR_INVALID_JSON | JSON.parse fails | no |

### Post-normalize

| ID | Branch | PG today | Notes |
|----|--------|----------|-------|
| BR_INCOMPLETE_IDENTITY | missing wa_message_id / client_slug | yes | |
| BR_DUPLICATE_REPLAY | processed event replay (guest or owner) | yes | lookup + response identity |
| BR_UNPROCESSED_DUPLICATE_CONFLICT_CONTINUE | unprocessed existing / ON CONFLICT → continue | yes | not replay |
| BR_GUEST_MESSAGE_EVENT_TABLE_UNAVAILABLE | table_missing on **find or insert** | yes | renamed from no-persistence; **other reads/writes may continue** |
| BR_OWNER_COMMAND_CENTER | staff phone → Command Center | yes | owner reads are **tenant-wide** (`client_slug` only) |
| BR_BLOCKED_PHONE_GATE | open-phone testing gate | yes | |
| BR_OPEN_DEMO | open-demo execute path | yes | request + execution identity |
| BR_OPEN_DEMO_VALIDATION_FAILURE | `validateOpenDemoInboundBody` fails | yes | no execute |
| BR_GUEST_PERSIST_DRAFT_SEND | supported+text → draft (±send) | yes | |
| BR_TERMINAL_NO_DRAFT_SEND | unsupported/empty → no draft/send | yes | still returns normalized |
| BR_PG_OR_DOWNSTREAM_ERROR | non-table_missing throw / uncaught PG | yes | no Meta success envelope |

Full machine-readable map + source anchors: `fixtures/fortress-tenant-identity/slice15g2-branch-matrix.json`.

## Shared owner (authority before PG)

**Exact shared owner:** `processMetaWhatsAppWebhookPostEntry` in `scripts/lib/luna-meta-whatsapp-inbound-process.js` (not present on master; required by replacement).

**HTTP must call only that entry:** `handleMetaWhatsAppWebhookPost` must not call `withPgClient` directly.

**Must return effective normalized:** PostEntry returns the post-authority `normalized` so HTTP `appendAuditLog` and response use that identity — not a stale pre-authority snapshot.

**Enforcement order:**

1. `normalizeMetaWhatsAppWebhook`
2. `applyMetaWhatsAppIngressAuthority` (planned module `scripts/lib/meta-whatsapp-ingress-authority.js`)
3. If blocked → authority-blocked envelope, `acquired_pg=false`, **zero** pool/client/persistence/draft/send/owner/demo
4. Else → `withPgClient` → existing inbound branches with authoritative `normalized.client_slug` + `normalized.location_id`

## Owner read scope (explicit decision)

**Tenant-wide** (`client_slug` only) — **not** location-scoped.

Basis: `lookupStaffPhoneAccess` and owner SQL filter only on `client_slug`. Replacement must keep that scope while still propagating `location_id` into stored normalized + idempotency when present.

## Why 15G is superseded (not modified)

Deferred 15G attempted remediation and needed corrective commits:

1. Gate Meta POST **before** `withPgClient` (blocked identities still acquired PG in the first tip)
2. Propagate trusted `location_id` through real draft/send/idempotency builders

15G2 does **not** amend that branch. It freezes the audited design so replacement `FORTRESS-15H` can implement cleanly from master.

## Replacement acceptance boundary (15H only)

Bounded slice `FORTRESS-15H` / `15H_meta_ingress_authority_enforce_before_pg`:

- Default-off policy; no deploy/activation/routing-file setup in-slice
- Known `phone_number_id` → resolver `client_slug`+`location_id` authoritative through persistence, draft, send, idempotency, response
- Unknown/missing/ambiguous/conflicting → block with `acquired_pg=false` and zero downstream calls
- PostEntry returns effective normalized; **HTTP audit** uses it
- Prove post-authority identity at: owner lookup/query/send/storage/replay; open-demo request/execution; blocked-phone gate; replay lookup/response; **both** table-missing entry points; terminal no-draft/send; open-demo validation failure + error handling posture
- Owner reads remain tenant-wide
- Do not merge deferred 15G; do not rewrite 15A historical B02 `vulnerable` verdict

## Residual risk / blockers

1. Live B02 remains `vulnerable` until 15H + separate operator activation
2. Registry Wolfhouse slug is `wolfhouse` while legacy default is `wolfhouse-somo` — replacement must document/handle alias when authority is active
3. Open-demo hardcoded `wolfhouse-somo` fallback conflicts with authoritative tenants if left unchanged under active authority
4. Deferred 15G tip must not be merged as “done”
5. Guest-message-event table absence still allows other PG reads/writes — authority cannot treat “no event table” as a full side-effect stop
