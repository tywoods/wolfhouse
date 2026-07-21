# RADAR findings (16A freeze + 16B–16S partials + 16T correlation-drill harness)

**Master basis (16T):** `87121456db90a9f80ff8b3679596bc49c235cbfc`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16T progress class:** `source_partial_progress_only` (harness only; live E2E drill open / not executed).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16T)

1. **End-to-end Meta → Hermes → Staff API → Stripe correlation drill (live)** — harness is source-partial; live apply + evidence freeze remain open.
2. **Hermes X-Request-Id echo / forward on staging** — allowlisted hop must preserve the same ID without guest/payment mutation; live proof open.
3. **Concurrent isolation / abort-error LAW outcomes** — not claimed by the /healthz completion probe.
4. **Human inbox receipt** — AG test notification API Email Status=Succeeded is not inbox proof.
5. **Organic metric alert firing** — not observed / not claimed (5xx, restart, capacity).
6. **Abrupt Stripe webhook paths** — not claimed (only malformed/missing/oversize observed).
7. **Dependency failure** — healthy /readyz observed; failure traffic-shed drill open.
8. **Real-PG contention** — 16M concurrency drill open.
9. **Production** — staging-only; production forbidden.

## Gate progress after 16T (truthful)

| Gate | progress_class | Live-proven (bounded) | Still open |
|------|----------------|----------------------|------------|
| G01 | partial_live_proven (+ 16T source-partial harness) | SHA `1bf9695` @ WH `0000517` / Sunset `0000277`; LAW match_count=1; retention 30 | Live E2E Meta→Hermes→Staff→Stripe drill |
| G02 | partial_live_proven | health/ready after deploy + rollforward | dependency-failure drill |
| G03 | partial_live_proven | AG test API Email Status=Succeeded / Complete | human inbox; organic alert fire |
| G04 | partial | — | backlog metrics / DLQ |
| G05 | source_partial | — | real-PG contention; replay/DLQ |
| G06 | source_partial | — | organic capacity alert fire; load/SLO |
| G07 | partial_live_proven | WH 0000515→0000516; Sunset 0000275→0000276; final 594247f | PG restore drill |
| G08 | partial_live_proven | SHA 594247f @ 0000514/0000274; malformed/missing/oversize generic | abrupt; retention/search privacy extras |
| G09 | partial_live_proven | AG test API Email Status=Succeeded both tenants | human inbox; budget live-list; anomaly |

## Slice 16T

`16T_e2e_correlation_drill_harness` — staging-only dry-run-default correlation-drill harness for G01. Traces Wolfhouse (`staff-staging.lunafrontdesk.com` / `lunabox.lunafrontdesk.com` / `wh-staging-staff-api` / `wolfhouse-somo`) and Sunset (`sunset-staging.lunafrontdesk.com` / `hermes-sunset-luna:8092` / `luna-sunset-staging-staff-api` / `sunset`) boundaries: Meta-shaped Staff dual-ingress unsigned reject, Hermes synthetic Meta-shaped webhook, Staff `/healthz`, Stripe webhook pre-verify missing signature. Reuses 16J `X-Request-Id`, 16R completion logs, 16O public errors. CLI default dry-run; live requires `--apply` + `RADAR-16T-CORRELATION-DRILL`. Offline RED/GREEN covers wrong scope, production host, real Stripe mode, missing correlation, ID substitution, duplicate records, sensitive fields, unsupported ingress, mutation-capable paths. Does not execute live drill, deploy, or raise any gate to proven. G02–G09 unchanged.

## Prior slices (retained)

- **16S** completion-log delivery/search/retention live evidence — retained; E2E live drill still open
- **16R** completion logging source — retained
- **16P** live-drill evidence — partial/live-proven on G02/G03/G07/G08/G09
- **16O** webhook error minimization — retained
- **16M** event-id claim — source-partial; real-PG contention open
- **16L** capacity alerts — source-partial; organic fire open
- **16K** healthz — live health observed via 16P; retention open
- **16J** correlation — source-partial ALS; completion live via 16S
- **16I** readiness — healthy path live via 16P; failure drill open
- **16H** metric alerts — AG test API via 16P; organic fire + inbox open
- **16B** budget threshold — AG test API via 16P; budget live-list + anomaly open

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16T. No live drill execution. Staff API, Hermes, database, and staging IaC unchanged vs master `87121456`. Harness + ledger/matrix/findings/contract only.
