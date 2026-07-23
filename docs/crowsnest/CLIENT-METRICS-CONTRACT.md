# Crowsnest client metrics event contract (v1)

Secret-free, tenant-aware **event shape + pure validator** for the per-client
operational numbers shown on the Spyglass dashboard. This is **Pupil groundwork**
— the contract only. No storage, no DB reads, no network, no UI wiring.

Companion to the [AI usage event contract](AI-USAGE-EVENT-CONTRACT.md); same
discipline (closed schema, privacy-preserving, independent `client_slug` /
`tenant_id`, canonical-UTC timestamps).

## Goal

- Own a stable `crowsnest.client_metrics.v1` snapshot schema under Crowsnest.
- Validate snapshots offline with a closed, privacy-preserving schema.
- Give the Spyglass expandable client list a real, honest data shape to bind to
  (replacing the Iris sample data) once Pupil wires a source.

## Non-goals (this slice)

- No storage, ledger, table, or migration.
- No runtime wiring into the Staff API, Postgres, Hermes, or the Crowsnest UI.
- No network calls or provider SDKs.
- No inference or mapping between `client_slug` and `tenant_id`.

## Event = one per-client snapshot

Each event is a point-in-time snapshot of aggregate counts for **one** client.

| Field | Required | Notes |
|-------|----------|-------|
| `schema_version` | yes | Must be `crowsnest.client_metrics.v1` |
| `snapshot_id` | yes | Opaque safe identifier |
| `captured_at` | yes | UTC ISO-8601 with `Z`; optional 1–3 fractional digits; must be a real calendar instant |
| `client_slug` | yes | Non-empty safe identifier (independent of `tenant_id`) |
| `tenant_id` | yes | Non-empty safe identifier (independent of `client_slug`) |
| `source_service` | yes | Opaque service label |
| `window` | yes | Measurement window; see below |
| `metrics` | yes | See metric semantics |

Closed schema: unknown top-level or nested fields are rejected.

## Window

`window` is a closed object:

| Field | Required | Notes |
|-------|----------|-------|
| `kind` | yes | One of `rolling_24h`, `rolling_7d`, `today`, `all_time` |
| `days` | no | Non-negative integer, when a fixed span applies |

## Metric semantics

`metrics.availability` gates the shape (mirrors the AI-usage `tokens.availability`
pattern):

- `availability: "unavailable"` → **only** `availability` may be present. No
  numbers may ride along on an unavailable snapshot (a source that cannot produce
  a count must say so honestly rather than emit a misleading `0`).
- `availability: "measured"` → all of the following are required and validated:

| Field | Type | Source column (Pupil target) |
|-------|------|------------------------------|
| `conversations_total` | non-negative integer | `COUNT(*)` of `conversations` for the tenant |
| `conversations_active` | non-negative integer | `conversations.status = 'open'` |
| `conversations_needing_human` | non-negative integer | `conversations.needs_human = true` |
| `messages_last_24h` | non-negative integer | `messages` rows in the last 24h |
| `messages_per_day_avg` | non-negative number | rolling average message volume |
| `last_activity_at` | UTC ISO-8601 `Z` **or `null`** | `MAX(conversations.updated_at)`; `null` when the client has no activity yet |

### `needs_human` note

`conversations_needing_human` counts `conversations.needs_human = true`. Its
*operational* meaning varies by client — for most clients `needs_human = true`
pauses Luna automation, while for **Sunset** it is an inbox-only flag that does
**not** pause Luna — but the count itself is uniform across clients.

## Privacy policy

Snapshots carry aggregate counts and timestamps only. Never guest/operator
content, message text, phone/email/name, or secrets. Forbidden key names (any
nesting, case-insensitive, separators stripped) include: actor, guest, booking,
conversation, session, thread, prompt, response, message(s), transcript, phone,
email, name, api_key, secret, password, authorization, cookie(s), metadata,
payload, credential(s), and access/refresh/private key material. Secret-shaped
string values (`sk-…`, `sk-ant-…`, `Bearer …`, PEM private keys) are rejected.
Fixtures use only synthetic identifiers.

## Trusted tenant requirement

Emitters must supply **trusted** `client_slug` and `tenant_id` from an
authenticated tenant context. The contract treats both as required opaque fields
and does **not** derive one from the other.

## Verify

```bash
node scripts/verify-crowsnest-client-metrics-contract.js
```

(Pure offline: validates every fixture in `fixtures/crowsnest-client-metrics/`,
and asserts each invalid fixture fails with its characteristic error path/code.)

> Wiring `verify:crowsnest-client-metrics-contract` into `package.json` is a
> one-line follow-up deferred to merge time, to avoid touching a shared file
> while the Sales section is in flight.
