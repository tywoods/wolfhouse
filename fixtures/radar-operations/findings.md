# RADAR findings (16A freeze + 16B–16S partials + 16U provenance + 16V capability boundary freeze)

**Master basis (16V):** `d904481de6ef8e7ad65d84241577796cbb5ad1c4`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16V progress class:** `audit_only_capability_boundary_freeze` (no runtime; no live).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16V)

1. **Capability boundary runtime apply (16W)** — `decideCapability` shape + source-derived 43-adapter exact-set inventory frozen; owner modules not wired.
2. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen (16U); Hermes does not send `X-Request-Id` today.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — reserved (`RADAR-16U-CORRELATION-DRY-RUN`); **not implementable yet** (blocked on runtime boundary apply).
4. **Genuine Stripe on inbound ALS** — **not provable without mutation**; G01-B is tenant/payment/booking/session metadata only (16U retained).
5. **Independent same-ID probes are not E2E** — retained from 16U.
6. Concurrent isolation / abort-error LAW outcomes.
7. Human inbox receipt / organic metric alert firing.
8. Dependency-failure readiness drill / real-PG contention.
9. Production — forbidden.

## Gate progress after 16V (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U provenance + 16V boundary freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | via 16P |
| G03 | partial_live_proven | via 16P AG test |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16V

`16V_central_capability_boundary_audit_freeze` — audit-only. Identity rule `ADAPTER_IDENTITY_REGISTERED_TOOL_ROUTE_OR_UNIQUE_EXTERNAL_ACQUISITION` with **source_derived_exact_set_comparison**. Inventories **4** WhatsApp send + **21** Staff/DB/Stripe mutation + **18** read-dispatch adapters (total **43**) from registered Hermes tools/routes and unique external acquisition sites; collapses producer/path duplicates that converge before acquisition; adds Sunset full-day-addon / private-lesson / joinable-courses reads; removes unreachable booking-dry-run. Freezes fail-closed `decideCapability` that looks up inventory by adapter ID, binds exact allowed tenant, takes effect/class from the pinned entry, and returns an immutable frozen per-turn object; unknown/missing/cross-tenant deny. Verifier RED-rejects demonstrated omissions/extras, arbitrary read ID, missing/wrong tenant, caller effect spoofing, and post-decision mutation. Preserves all 16U provenance truth and G01 partial. Does not implement runtime or execute live.

## Prior slices (retained)

- **16U** correlation design freeze (live Caddy `/whatsapp/*`→`:8092`, `/wolfhouse/*`→`:8090`; tracked Caddy stale; provenance; G01-B metadata-only; dry-run **not implementable** yet; phrase `RADAR-16U-CORRELATION-DRY-RUN`) — retained
- **16S** completion-log LAW delivery/search/retention @ SHA `1bf9695` (WH `0000517` / Sunset `0000277`) — retained; Meta→Hermes E2E still open as G01-A
- **16R** / **16J** / **16P** / **16O** / **16M** / **16L** / **16K** / **16I** / **16H** / **16B** — retained

## Zero-mutation (this slice)

No deploy/live/runtime mutation vs master `d904481`. Fixtures + ledger only. Still open: capability runtime apply and G01-A live evidence (not claimed).
