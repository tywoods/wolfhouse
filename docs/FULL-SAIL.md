# FULL SAIL

Chief-facing index for Luna Nightwatch (Stage 1) and controlled-drafting (Stage 2) on Sunset staging. Durable facts only. No process IDs, DSNs, tokens, or mailbox secrets.

## Current deployed Sunset Staff API artifact

| Fact | Value |
| --- | --- |
| Source / image SHA | `f6ee511273160cb46c72e345137800878d4c6512` |
| Revision | `luna-sunset-staging-staff-api--ch4f-f6ee5112` |
| Digest | `sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a` |
| App | `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` |
| Status | Disabled-by-construction for controlled-drafting live proof |

These pins were inherited from the Chapter 4F deploy / Chapter 4G live-target wiring. Chapter 4H is source-only and does not re-measure them. Treat them as current unless a later **read-only** measurement proves otherwise.

## Stage 2 CONTROLLED DRAFTING chapters

| Chapter | What it owns | Live proof? | Canonical doc |
| --- | --- | --- | --- |
| 1 | Draft-only provider contract | No | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-PROVIDER-CONTRACT.md` |
| 2 | Durable 097 operation store | No | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-OPERATION-STORE.md` |
| 3 | Disabled runtime composition | No | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-RUNTIME-COMPOSITION.md` |
| 4A | Staging activation / 097+098 LOGIN preflight | No | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-STAGING-ACTIVATION.md` |
| 4C | Token loan / draft `scp` / JWKS inspect | Offline simulation only | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-TOKEN-LOAN.md` |
| 4E | Operator downscope prover | Structurally disabled | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-DOWNSCOPE-PROVER.md` |
| 4F | Disabled Sunset Staff API deploy of the pinned SHA | Deployed; flags false | (artifact pins above) |
| 4G | Exact-SHA live-target wiring for the 4E prover | `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER=false` | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-DOWNSCOPE-PROVER.md` |
| 4H | Private server-owned Azure/ACR/PG preflight reader | Reader tested with fakes; live proof still not executed | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-PREFLIGHT-READER.md` |

Merged PRs of record for the live-target path: **#719** (Chapter 4E), **#720** (Chapter 4G). Chapter 4H is the next source-only PR on that path.

## Disabled / live-proof state

- Frozen `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = false` with load-time throws.
- Public compose, live `runProof`, and CLI `--execute-once` refuse before KV / token / JWKS / live PG / this reader execute.
- Eight controlled-drafting / send flags must stay literal `false` on the live app.
- Caller snapshots cannot mint an independent live-proof brand.
- Chapter 4H brands evidence only from the owned reader after measured Azure/PG facts.

## Threat boundaries

- Sunset staging is operator-only. Production / Wolfhouse / `--target live` / `--target azure` fail closed.
- No Graph client, send, journal handoff, or 098 consume in these chapters.
- No DSN, credentials, tokens, JWT, private keys, mailbox, or tenant secrets in evidence/errors.
- Direct producer/worker LOGIN; no `SET ROLE`; worker owns custody-style reads.
- Admin Staff API DSN is not the custody DSN.

## Canonical docs

- This index: `docs/FULL-SAIL.md`
- Live prover + 4G wiring: `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-DOWNSCOPE-PROVER.md`
- Preflight reader: `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-PREFLIGHT-READER.md`
- Token loan: `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-TOKEN-LOAN.md`
- Staging activation: `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-STAGING-ACTIVATION.md`
- Agent map: `AGENTS.md`

## Verification commands

```bash
npm run verify:email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader
npm run verify:email-luna-controlled-drafting-live-downscope-prover-live-target
npm run verify:email-luna-controlled-drafting-live-downscope-prover
npm run prove:email-luna-controlled-drafting-live-downscope-prover-offline-simulation
npm run verify:email-luna-controlled-drafting-token-loan
npm run verify:staff-query-api-startup-smoke
npm run verify:migration-integrity
```

Do not run live `--execute-once` against Sunset from this chapter.

## Next gate

A later separately authorized **execution** chapter may flip chapter live-execute authority, call the branded Chapter 4H reader, and run the downscope + staff-send continuity proof **once** against Sunset staging. It must still fail closed on reader absence, brand forgery, flag/replica/count drift, and must not send or flip flags.
