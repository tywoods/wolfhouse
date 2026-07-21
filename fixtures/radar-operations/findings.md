# RADAR findings (16A freeze + 16B–16S partials + 16U correlation design freeze)

**Master basis (16U):** `87121456db90a9f80ff8b3679596bc49c235cbfc`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16U progress class:** `audit_only_design_freeze` (no runtime; no live).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16U)

1. **G01-A live Meta → Hermes → Staff correlated read path** — design frozen; Hermes does not send `X-Request-Id` today; end-to-end G01-A evidence remains open.
2. **Central capability boundary (16V)** — audit/freeze deny WhatsApp send + Staff/DB/Stripe mutation while permitting real read dispatch; prerequisite before dry-run.
3. **Hard-disabled `G01_CORRELATION_DRY_RUN`** — reserved (`RADAR-16U-CORRELATION-DRY-RUN`); **not implementable yet**.
4. **Genuine Stripe on inbound ALS** — **not provable without mutation**; G01-B is tenant/payment/booking/session metadata only (no inbound trace/wamid today).
5. **Independent same-ID probes are not E2E** — `/healthz` + Stripe pre-verify sharing a UUID must not close G01.
6. Concurrent isolation / abort-error LAW outcomes.
7. Human inbox receipt / organic metric alert firing.
8. Dependency-failure readiness drill / real-PG contention.
9. Production — forbidden.

## Gate progress after 16U (truthful)

| Gate | progress_class | Notes |
|------|----------------|-------|
| G01 | partial_live_proven + 16U design freeze | 16S LAW retained; G01-A live open |
| G02 | partial_live_proven | via 16P |
| G03 | partial_live_proven | via 16P AG test |
| G04 | partial | backlog open |
| G05 | source_partial | 16M event-id claim |
| G06 | source_partial | 16L capacity-pressure |
| G07 | partial_live_proven | via 16P rollback |
| G08 | partial_live_proven | via 16P/16O webhook error minimization |
| G09 | partial_live_proven | via 16P AG test |

## Slice 16U

`16U_correlation_design_freeze` — audit-only. Freezes **live** Lunabox Caddy authority: `/whatsapp/*` → `:8092` (`hermes-sunset-luna`), `/wolfhouse/*` → `:8090` (`hermes-luna`); tracked Caddy reference is stale evidence, not authority. Documents `_post_bot` header gap (no `X-Request-Id`). Defines provenance: single-message `wamid`; coalesced Sunset burst = ordered immutable source-wamid set (no invented single parent). Redefines G01-A (Meta→Hermes→Staff non-mutating) vs G01-B (tenant/payment/booking/session metadata only; no inbound trace/wamid). Dry-run **not implementable yet** — next slice is central capability boundary audit/freeze (no trace/deploy/evidence). Verifier RED-rejects stale Caddy authority, invented burst parent, dispersed suppression lists, incomplete mutation-adapter inventories, trace/wamid payment overclaims, and independent same-ID probes. Does not implement runtime or execute live. Replaces deferred independent multi-ingress same-ID harness concept. Does not claim human inbox, organic metric fire, or production. G01 partial/runtime unchanged.

## Prior slices (retained)

- **16S** completion-log LAW delivery/search/retention @ SHA `1bf9695` (WH `0000517` / Sunset `0000277`) — retained; Meta→Hermes E2E still open as G01-A
- **16R** / **16J** — retained
- **16P** / **16O** / **16M** / **16L** / **16K** / **16I** / **16H** / **16B** — retained

## Zero-mutation (this slice)

No deploy/live/runtime mutation vs master `87121456`. Fixtures + ledger only. Still open: G01-A live evidence (not claimed).
