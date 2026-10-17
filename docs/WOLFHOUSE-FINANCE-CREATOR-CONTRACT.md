# Wolfhouse Finance Creator Projection — API Contract v1

Status: **frozen v1 handoff contract**  
Owner: Skip / server data path  
Route: `GET /staff/admin/finance/summary`  
Scope: Wolfhouse (`client=wolfhouse-somo`) only  
Timezone: `Europe/Madrid`

This contract is additive. Existing success-envelope keys (`success`, `client`, `location_id`, `summary`, `elapsed_ms`) and the existing legacy `summary` fields remain unchanged. Sunset responses MUST NOT contain or derive this projection.

## 1. Summary request

```http
GET /staff/admin/finance/summary?client=wolfhouse-somo&granularity=month&anchor=2026-10-17
GET /staff/admin/finance/summary?client=wolfhouse-somo&granularity=custom&start=2026-10-01&end=2026-10-31
```

The existing authenticated owner/admin, client and location checks apply. Existing `granularity`, `anchor`, `start`, and `end` normalization continues to resolve one inclusive Europe/Madrid calendar range.

On Wolfhouse success, the envelope adds:

```json
{
  "wolfhouse_creator_finance": { "schema_version": "wolfhouse.creator-finance.v1" }
}
```

`wolfhouse_creator_finance` is absent on Sunset. Consumers MUST require the exact schema version and MUST NOT infer v1 from field presence.

## 2. Common types

### Metric

```json
{
  "state": "complete",
  "amount_cents": 12500,
  "count": null,
  "date_basis": "receipt_paid_at_madrid",
  "reason_codes": [],
  "coverage": { "assessed_count": 4, "included_count": 4, "excluded_count": 0, "unknown_count": 0 }
}
```

- `state`: `complete`, `partial`, or `unavailable`.
- Money is a JSON safe integer in cents or `null`; counts are safe integers or `null`.
- A metric exposes only the applicable value key (`amount_cents` and/or `count`).
- `complete` means the whole in-scope cohort was assessed. Only `complete` may represent an authoritative zero.
- `partial` means a known subtotal exists but excluded/unreadable/unknown rows prevent completeness.
- `unavailable` means no truthful value can be produced; its value is `null`, never `0`.
- `reason_codes` are stable, staff-safe codes. v1 codes: `malformed_money`, `unsafe_integer`, `unknown_currency`, `mixed_currency`, `creator_unresolved`, `refund_ledger_unavailable`, `refund_row_unreadable`, `payment_identity_missing`, `creation_date_missing`, `saved_total_unreadable`, `balance_reconciliation_unavailable`, `stale_generation`.
- Coverage counts rows/identities, never guest PII.

### Creator category

Exactly: `luna`, `staff`, `other_imported`, `unattributed`, `total`.

Creator means booking creator. It does not change when staff later edits a Luna booking, Luna later assists a staff booking, a payment is recorded, or a link is sent. Canonical Luna evidence includes `metadata.bot_source='luna_whatsapp'`. Staff requires positive creation evidence. Known imported/other is not `unattributed`; missing history is never inferred as staff.

### Currency

v1 reports one verified `currency` group per projection. No cross-currency sum is allowed. Unknown or different currencies appear in coverage/reason codes and cannot be silently combined.

## 3. Projection shape

```json
{
  "schema_version": "wolfhouse.creator-finance.v1",
  "scope": {
    "client": "wolfhouse-somo",
    "location_id": "",
    "timezone": "Europe/Madrid",
    "currency": "EUR",
    "range": { "start": "2026-10-01", "end": "2026-10-31", "granularity": "month", "anchor": "2026-10-17" }
  },
  "generated_at": "2026-10-17T21:30:00.000Z",
  "as_of": "2026-10-17T21:30:00.000Z",
  "cohort_id": "whcf1_<opaque digest>",
  "metrics": {},
  "creators": [],
  "trend": [],
  "detail_queries": {},
  "warnings": [],
  "arrival_date_report": {}
}
```

`cohort_id` is an opaque digest of schema version, authenticated tenant/location, normalized range, reporting currency, and the repeatable-read cohort fingerprint. It binds every detail page to this summary generation.

### Headline metrics

`metrics` contains:

- `gross_receipts`: eligible paid receipts, once per stable payment identity, receipt `paid_at` in selected Madrid range, before refunds.
- `recorded_refunds`: recorded refund rows, bucketed by recorded `effective_date`.
- `net_receipts`: gross receipts less recorded refunds. If refund data is unreadable/unavailable, this metric is `unavailable` even when gross receipts remains usable.
- `deposits_received`: verified-purpose subset of gross receipts. Manual deposits represented by `payment_kind='full_amount'` plus `paid_amount_type='deposit'` metadata count as deposits. Size/current pricing never infers purpose. Unknown purpose remains visible in coverage.
- `new_booking_count`: eligible bookings created in the selected Madrid range.
- `new_booking_value`: current authoritative saved totals for the same created-date cohort. Historic values can change after booking edits.
- `outstanding_today`: nonnegative current authoritative balances for all eligible active bookings, independent of selected range; includes its own `as_of`.

Every metric carries its date basis. `outstanding_today` uses `current_active_snapshot`; it MUST NOT subtract only selected-period receipts or invent overdue dates.

### Creator reconciliation

`creators` is ordered: `luna`, `staff`, `other_imported`, `unattributed`, `total`.

Each row:

```json
{
  "creator": "luna",
  "gross_receipts": { "state": "complete", "amount_cents": 10000, "date_basis": "receipt_paid_at_madrid", "reason_codes": [], "coverage": {} },
  "deposits_received": { "state": "complete", "amount_cents": 3000, "date_basis": "receipt_paid_at_madrid", "reason_codes": [], "coverage": {} },
  "new_booking_count": { "state": "complete", "count": 2, "date_basis": "booking_created_at_madrid", "reason_codes": [], "coverage": {} },
  "new_booking_value": { "state": "complete", "amount_cents": 40000, "date_basis": "booking_created_at_madrid_current_saved_total", "reason_codes": [], "coverage": {} },
  "receipt_share_bps": 6250
}
```

Shares are server-computed basis points (`0..10000`) or `null`. They are `null` whenever the relevant total/category coverage is not complete. All categories, including unattributed, reconcile to `total`.

### Trend

`trend` contains stable ascending selected-range buckets from the same deduplicated receipt cohort as `metrics.gross_receipts`:

```json
{
  "date": "2026-10-03",
  "gross_receipts_cents": 7500,
  "recorded_refunds_cents": 1000,
  "net_receipts_cents": 6500,
  "state": "complete",
  "reason_codes": []
}
```

When refunds are unavailable, gross remains populated but refund/net values are `null` and state is not `complete`. Trend currency and coverage match the headline.

### Preserved arrival-date report

`arrival_date_report` carries the existing arrival/service-date Finance report separately and labels its date basis as `arrival_or_service_date`. It is never relabelled as the created-date cohort.

## 4. Contributor details

Details use the same route with additive query parameters:

```http
GET /staff/admin/finance/summary?client=wolfhouse-somo&granularity=month&anchor=2026-10-17&creator_detail=payments&creator=luna&currency=EUR&cohort_id=whcf1_...&cursor=<opaque>&limit=100
```

`creator_detail` is one of:

- `payments` — contributors to gross/deposit receipt totals
- `bookings` — contributors to created-date booking count/value
- `outstanding` — all-active current unpaid balances
- `refunds` — recorded refunds
- `products` — preserved saved-quote allocations, deduplicated attached services and signed adjustments
- `warnings` — sanitized diagnostics
- `arrival` — preserved arrival-date report contributors

`creator` is optional and one of the four non-total categories. `currency`, `cohort_id`, and `limit` are required; `cursor` is omitted on the first page. `limit` is an integer `1..200` (default `100`). Unknown/repeated/invalid parameters return the existing invalid-input `400` form.

A successful detail response keeps the normal envelope and replaces `wolfhouse_creator_finance` with:

```json
{
  "schema_version": "wolfhouse.creator-finance.v1",
  "cohort_id": "whcf1_<same digest>",
  "detail": {
    "kind": "payments",
    "creator": "luna",
    "currency": "EUR",
    "rows": [],
    "page": {
      "limit": 100,
      "next_cursor": null,
      "complete": true,
      "matched_count": 0,
      "returned_count": 0
    },
    "full_cohort_totals": {
      "gross_receipts_cents": 0,
      "deposits_received_cents": 0
    }
  }
}
```

Rows have stable identities and deterministic order (date ascending, then stable identity ascending). There is no silent SQL/page cap. Summing every page reconciles exactly to `full_cohort_totals` and the selected headline metric.

Allowed staff-safe row fields:

- payment: `payment_id`, `booking_id`, `receipt_date`, `amount_cents`, `purpose`, `creator`
- booking: `booking_id`, `created_date`, `current_saved_total_cents`, `creator`
- outstanding: `booking_id`, `current_balance_cents`, `as_of`, `creator`
- refund: `refund_id`, `booking_id`, `effective_date`, `amount_cents`, `creator`
- product: `row_id`, `booking_id`, `product_code`, `product_label`, `service_date`, `quantity`, `amount_cents`, `creator`
- warning: stable safe identifiers, `reason_code`, and component only

Guest names, phone numbers, email addresses and raw metadata are forbidden.

## 5. Refresh consistency

A detail request is served only when its tenant, location, normalized range, currency and current cohort fingerprint equal the supplied `cohort_id`. Any mismatch or underlying-data change returns:

```json
{
  "success": false,
  "error": "finance summary refresh required",
  "code": "FINANCE_COHORT_STALE"
}
```

HTTP status is `409`. The browser must fetch a fresh summary; the server never mixes detail generations. No analytics database/service is introduced.

## 6. Error behavior

- Existing unauthenticated/role/client/location denials remain unchanged and apply to summary and every detail request.
- Invalid date/detail/cursor/limit input: HTTP `400`, existing invalid-request envelope.
- Wolfhouse success without the exact projection version is a consumer-visible missing projection; the UI must not infer it.
- Recoverable component defects are represented by metric `partial`/`unavailable` states and safe reason codes.
- Unrecoverable structure/overflow remains whole-response HTTP `503`, `code=FINANCE_DATA_QUALITY`.
- Unexpected read failure remains HTTP `500`, `error=read failed`.
- Stale generation is HTTP `409`, `code=FINANCE_COHORT_STALE`.
- No error may leak cross-tenant rows, guest PII or raw metadata.

## 7. Accounting invariants

1. Deduplicate stable identities before any sum or join expansion.
2. Gross receipt total equals creator total equals sum of trend gross buckets equals sum of all `payments` detail pages.
3. Created-date count/value equals creator totals and all `bookings` detail pages.
4. Deposits are a verified-purpose receipt subset; unknown purpose is not silently deposit or non-deposit complete coverage.
5. Current outstanding is independent of selected range and uses saved-total/paid-ledger authority plus drift diagnostics.
6. Refund-read failure never means zero refunds; net becomes unavailable.
7. Saved-quote allocations, attached-service deduplication and signed adjustments are preserved; no accommodation remainder is invented.
8. Different/unknown currencies are never combined.
9. All arithmetic uses checked safe integer cents.
10. Complete zero is valid only for a completely assessed empty cohort.

## 8. Frozen examples and producer gate

Canonical labelled fixtures live in `fixtures/wolfhouse-finance-creator-data/`:

- `success.json`
- `complete-empty.json`
- `partial.json`
- `unavailable-refunds.json`
- `multi-page.json`

The producer-side executable contract/reconciliation gate is `scripts/verify-wolfhouse-finance-creator-data.js`. Fixtures and gate are Skip-owned and frozen with v1; consumers may read/import but not edit them. Any wire-shape change requires a new schema version and explicit Captain/Deckhand coordination.
