# RADAR findings (16A freeze + 16B–16P retained + 16Q readiness-failure drill harness source-partial)

**Master basis (16Q):** `06b7a3f2173863afa81bfc557cd31cbd3e80d6c1`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).
**16Q progress class:** `source_partial_progress_only` (this slice does not execute live).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps (still open — explicitly not claimed by 16Q)

1. **Live readiness-failure drill** — 16Q harness exists; `--apply` not executed; live dependency-failure traffic-shed still open.
2. **Human inbox receipt** — AG test notification API Email Status=Succeeded is not inbox proof.
3. **Organic metric alert firing** — not observed / not claimed.
4. **Abrupt Stripe webhook paths** — not claimed.
5. **Retention/search** — log retention / PII redaction / LAW search not claimed.
6. **Real-PG contention** — 16M concurrency drill open.
7. **Completion logging** — remains open.
8. **Production** — staging-only; production forbidden.

## Gate progress after 16Q (truthful)

| Gate | progress_class | Live-proven (bounded) | Still open |
|------|----------------|----------------------|------------|
| G01 | source_partial | — | completion logging, delivery/search/retention |
| G02 | partial_live_proven | health/ready after deploy + rollforward (16P) | **live** dependency-failure drill (16Q harness source-only) |
| G03 | partial_live_proven | AG test API Email Status=Succeeded / Complete | human inbox; organic alert fire |
| G04 | partial | — | backlog metrics / DLQ |
| G05 | source_partial | — | real-PG contention; replay/DLQ |
| G06 | source_partial | — | organic capacity alert fire; load/SLO |
| G07 | partial_live_proven | WH 0000515→0000516; Sunset 0000275→0000276; final 594247f | PG restore drill |
| G08 | partial_live_proven | SHA 594247f @ 0000514/0000274; malformed/missing/oversize generic | abrupt; retention/search |
| G09 | partial_live_proven | AG test API Email Status=Succeeded both tenants | human inbox; budget live-list; anomaly |

## Slice 16Q

`16Q_readiness_failure_drill_harness` — fail-closed operator harness for controlled ACA database-readiness failure + exact restoration. Default dry-run; `--apply` requires `--tenant wolfhouse|sunset` and exact confirm token. Pins staging RG/app/URL, `WOLFHOUSE_DATABASE_URL`, image SHA `594247f`. Captures template/revisions/image/probes outside repo; cleanup trap before mutation; narrow env-only failure template; observes failed revision Running/started=true/ready=false/restartCount=0 not latest-ready while public old health/ready stay 200; always restores exact original. Offline RED/GREEN covers refuse points + restoration. **Does not execute live** and does not claim live dependency-failure traffic-shed.

## Prior slices (retained)

- **16P** live-drill evidence reconciliation — partial/live-proven facts only; no overclaims
- **16O** webhook error minimization — live deploy + partial privacy via 16P
- **16M** event-id claim — source-partial; real-PG contention open
- **16L** capacity alerts — source-partial; organic fire open
- **16K** healthz — live health observed via 16P; retention open
- **16J** correlation — source-partial; completion logging open
- **16I** readiness — healthy path live via 16P; failure drill open (harness via 16Q)
- **16H** metric alerts — AG test API via 16P; organic fire + inbox open
- **16B** budget threshold — AG test API via 16P; budget live-list + anomaly open

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16Q. Staff API, Hermes, database, readiness lib, and staging IaC unchanged vs master `06b7a3f`. Harness + ledger/matrix only.
