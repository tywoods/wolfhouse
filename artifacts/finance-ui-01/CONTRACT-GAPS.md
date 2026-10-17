# FINANCE-UI-01 contract gaps

Frozen contract: `3f43f179` `docs/WOLFHOUSE-FINANCE-CREATOR-CONTRACT.md`
WIP checkpoint (not the contract): `a62a699a`

These are not filled in the browser.

1. `arrival_date_report` has no field list (example `{}`). Arrival detail rows are not in the allowed row fields. The screen keeps the label "Booking value by arrival date" and the date basis `arrival_or_service_date`. It does not invent amounts or columns.
2. `full_cohort_totals` names only `gross_receipts_cents` and `deposits_received_cents` on the payments example. Other detail kinds do not name their complete-total keys. The screen shows those named keys and never sums a page into a total.
3. Summary `warnings` items have no schema. The screen shows metric `reason_codes`, which are specified.
4. `detail_queries` is an empty object. Detail requests use the documented query parameters.
5. Producer fixtures are not in the freeze commit. The WIP copies are stubs. They are not consumed.
