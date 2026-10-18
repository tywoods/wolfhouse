# FINANCE-UI-01 contract gaps

Contract head: `3d77117f4c111f3d31e5fb8a816d7fdc973be087`
Schema: `wolfhouse.creator-finance.v1`
Addendum A closed the five parked gaps. None remain for this screen.

1. `arrival_date_report.date_basis` is `arrival_or_service_date`. Arrival rows use `booking_id`, `check_in`, `check_out`, `current_saved_total_cents`, `creator`.
2. `full_cohort_totals` keys are named per detail kind. The screen shows only those keys and never sums a page.
3. Summary `warnings[]` items are reason-code strings. Warning rows use `row_id`, `component`, `reason_code`, plus the named optional ids.
4. `detail_queries` booleans gate drill-down. A false kind is not a link.
5. Producer fixtures in `fixtures/wolfhouse-finance-creator-data/` are consumed. The presentation stub is not.
