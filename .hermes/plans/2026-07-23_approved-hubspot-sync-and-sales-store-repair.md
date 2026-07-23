# Crowsnest Sales — durable-store repair + approved HubSpot sync

## Goal
Restore durable Sales intake, then add a human-approved, idempotent HubSpot Company/Contact sync for qualified prospects marked Ready for CRM review.

## Non-negotiable boundaries
- Fix the live Sales database path before enabling any HubSpot operation.
- Never expose/store connection strings or HubSpot tokens in code, tests, logs, pages, audit detail, or Git.
- No automatic/background HubSpot sync, batch backfill, Deal creation, outreach sending, workflows, or message delivery.
- One explicit authenticated operator action is required for every provider write.
- Preserve existing CRM preview and Sales lifecycle behavior.
- External responses are untrusted: normalize only required provider identifiers/statuses.

## Architecture
1. **Store repair first:** diagnose the live connection using a read-only `SELECT 1` from the running Crowsnest environment; determine whether TLS, schema/migration, role grant, or network access is at fault. Change the smallest correct layer; prove with a manual prospect create/read in the live app.
2. **Core sync contract:** provider-neutral `approved CRM sync` command accepts only a qualified prospect with a current CRM-review mark, operator identity, and stable idempotency key derived from prospect + current review mark.
3. **HubSpot adapter:** isolated module translates approved Company + manually recorded Contacts into HubSpot v3 requests. It uses a server-only secret configured at runtime, explicit timeouts, no automatic retry loop, and sanitized errors.
4. **Durable sync records:** persist only provider name, provider object kind/id, review-mark id, idempotency key, sync status, timestamp, and sanitized error category. Never persist a token or raw provider payload.
5. **UI:** CRM Preview remains read-only until the operator presses an explicit `Send to HubSpot` control. Show success/failure/retry state from durable sync records; never claim success until the adapter response is confirmed.
6. **Audit:** append one audit record per approved attempt and outcome; store IDs/status categories only.

## Vertical TDD slices
A. Add a deterministic TLS/store configuration regression that reproduces the live safe failure category, then implement the narrow fix only after live cause is verified.
B. Add an approved-sync domain contract and deterministic RED fixtures for eligibility/idempotency; implement the provider-neutral core.
C. Add the HubSpot HTTP adapter using recorded fixtures and injected transport; RED/GREEN for request mapping, timeout/error sanitization, and no token leakage.
D. Add persistence migration/repository operations for sync records, then server route/UI controls; verify all existing Sales contracts remain green.
E. Configure the runtime secret only after the code is merged and ready for an operator-led sandbox smoke. Verify one manually approved sandbox Company/Contact sync, then promote only with explicit approval.

## Blocking decisions / external prerequisites
- Initial target is the **production HubSpot portal**, explicitly approved by Earthling on 2026-07-23. The first live write remains a deliberately selected, operator-approved CRM-ready prospect after the store repair and controlled smoke plan are complete.
- HubSpot **Service Key** (not legacy Private App) stored only as an Azure Container App secret; least permissions: Companies + Contacts read/write. Use secret name `hubspot-service-key`; no legacy private-app token is needed.
- Production idempotency needs a stable Company correlation property (proposed `crowsnest_sales_prospect_id`) created in HubSpot before the first live write; never silently use domain/name matching as a substitute.
- Live Sales store diagnosis must establish the exact TLS/network/schema/permission issue before code or secret changes.

## Exit criteria
- A live Crowsnest operator can create and reopen a durable prospect without `sales_unavailable`.
- An authenticated operator can explicitly sync an eligible CRM-ready prospect once; repeated clicks do not create duplicates.
- Provider IDs and sanitized result are durably visible/audited.
- Full Sales, auth, migration-integrity, and new HubSpot sync contracts pass.
- No outbound outreach is sent and no automatic external writes occur.
