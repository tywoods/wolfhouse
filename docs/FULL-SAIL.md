# FULL SAIL

Chief-facing index for Luna Nightwatch (Stage 1), controlled drafting (Stage 2), and the remaining email launch lifecycle. Durable facts only. No process IDs, DSNs, tokens, or mailbox secrets.

## Revised FULL SAIL sequence and completion contract

The approved sequence is:

1. **Stage 2 — CONTROLLED DRAFTING:** finish the bounded Sunset proof and independent post-proof audit.
2. **Stage 3 — SIGNAL FLEET:** **deferred**. Campaigns, broadcasts, and real customer outreach are not prerequisites for ordinary front-desk email.
3. **Stage 4 — HARBORMASTER:** deploy ordinary front-desk email to one exact production tenant without campaign capability, then canary, observe, and prove rollback.
4. **Stage 5 — OPEN CHANNEL:** complete generic IMAP/SMTP as required launch scope because it is the expected path for most clients. Microsoft Graph may launch first, but FULL SAIL does not close until the generic connector passes staging and production acceptance.
5. **Luna email readiness:** configure policy, train the email behavior, evaluate it in shadow and staff-reviewed modes, then activate one proven low-risk intent at a time.

Deferring Stage 3 excludes campaign audience selection, bulk scheduling, outreach, and campaign canaries from Stage 4 acceptance. `CUSTOMER_OUTREACH_EMAIL_ENABLED` remains off. No real-recipient outreach is authorized by this plan.

### Email is not complete when code is merely built

Every applicable stage must pass all six lifecycle gates:

| Gate | Required evidence |
| --- | --- |
| 1. Source acceptance | Exact reviewed head, focused/composed gates, clean merge-tree, and accepted PR. |
| 2. Immutable integration | Reviewed head preserved through the documented merge procedure; remote state and ancestry read back. |
| 3. Deployment | Exact clean-master SHA/digest deployed to the named target with schema/config compatibility and no unintended traffic. |
| 4. Live validation | Real controlled mailbox journey proves ingest, grounded draft, approval/send behavior, threading, exactly-once handling, and safe uncertainty behavior. |
| 5. Policy configuration | Server-owned intent allowlist, fact/freshness requirements, handoff rules, rate caps, kill switches, and tenant/location/provider scope are explicit and read back. |
| 6. Rollout acceptance | Shadow results, staff correction/rejection rates, canary evidence, monitoring, cost, incident response, rollback, and operator sign-off meet the stage exit contract. |

Source/tests may establish implementation readiness, but only deployed behavioral evidence closes an operational stage.

### Luna email training and acceptance workstream

Training is a product workstream, not a substitute for deployment or operations. It includes:

- **Behavior specification:** email-specific voice, language matching, greeting/sign-off, concise complete answers, one clear next step, and no internal jargon.
- **Authority policy:** closed autonomous-intent allowlist; draft-only and mandatory-handoff classes; fresh Staff API/DB facts for prices, availability, booking, payment, and policy claims.
- **Golden corpus:** English/Spanish, date ambiguity, group requests, existing bookings, cancellations/refunds, payments, attachments, quoted-thread injection, cross-tenant/location attempts, stale facts, and provider/database failure.
- **Shadow evaluation:** compare Luna's proposed action and draft with expected decisions without sending.
- **Staff-reviewed rollout:** Luna drafts while staff approves every send; measure factual corrections, policy overrides, rejected drafts, handoffs, duplicates, and language/tone failures.
- **Bounded autonomy:** enable one low-risk intent at a time only after its deployed corpus and controlled mailbox canary pass; retain global/tenant/location/provider/intent kill switches.
- **Ongoing acceptance:** regression gates, sampled audit, queue/provider health, duplicate and uncertainty counters, spend, rollback drills, and explicit operator sign-off.

### Product milestones

| Milestone | Exit condition |
| --- | --- |
| Infrastructure complete | Applicable connector stages are merged, deployed, and proven end to end. |
| Luna draft-ready | Golden and hostile cases pass; deployed Luna creates grounded drafts; staff approves every send. |
| Luna production-ready | One exact production tenant passes controlled inbound and staff-reviewed reply canaries with monitoring and rollback. |
| Luna autonomous-ready | Explicit low-risk intents pass shadow metrics and controlled canaries, then are enabled at bounded scope. |
| Campaign-ready | Deferred Stage 3 is separately implemented and accepted; real outreach still requires its exact business packet. |

### Stage 5 reuse boundary

Stage 5 is a **partial-foundation completion**, not a greenfield email rebuild. Reuse the canonical tenant/location registry, inbound event store, Inbox bridge, approval table, outbound journal, IMAP transport/cursor canary, SMTP STARTTLS health transport, Email Settings shell, and Key Vault secret-reference patterns. Do not create a second Inbox, approval table, outbound journal, tenant registry, campaign-based sender, or OAuth grant envelope for IMAP passwords.

The critical remaining generic-connector delta is: per-endpoint identity and secret binding; an activatable default-off IMAP worker; `imap_smtp` Inbox/approval authority; SMTP DATA and RFC reply headers; widening the canonical journal with a legal SMTP state graph; pre-DATA versus post-DATA uncertainty; settings health/pause controls; controlled Sunset mailbox proof; and a production-specific connector profile. Existing source-only register, health, cursor, MIME/plain-text, disconnect, and poll components are not live Stage 5 acceptance evidence.

## Current deployed Sunset Staff API artifact

| Fact | Value |
| --- | --- |
| Source / image SHA | `a4188eea71a92b7361818e024cde0f810d6ee018` |
| Revision | `luna-sunset-staging-staff-api--0000682` |
| Digest | `sha256:820f302e8f59cfe8636eb0267c6f15bc0750f300b76735f511f3dde9c031dc39` |
| App | `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` |
| Status | Disabled-by-construction for controlled-drafting live proof |

These pins are the currently serving disabled Sunset artifact, retargeted in Chapter 4J from a read-only ARM/ACR remeasurement. Historical Chapter 4F pins (`luna-sunset-staging-staff-api--ch4f-f6ee5112` / `f6ee511273160cb46c72e345137800878d4c6512` / `sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a`) are refused. Do not claim live PASS.

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
| 4I | One-shot Sunset staging downscope + staff-send continuity execution owner | Source-only; live proof still not executed | `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-SUNSET-STAGING-LIVE-EXECUTION.md` |
| 4J | Pre-execution unblock: retarget serving pins + authentic ARM 2024-03-01 mapping | Source-only; live proof still not executed | this index + 4E/4H/4I runbooks |

Merged PRs of record for the live-target path: **#719** (Chapter 4E), **#720** (Chapter 4G), **#735** (Chapter 4H, merge `82a9eb9ae647d13e7ef11629fc87a44b94d067c6`), and **#745** (Chapter 4I, reviewed candidate `874bcde642d7eb4838529f84246c1c011db9861a`, true merge commit `1efe1b131bc97a12174f07b25e20daf3a8a9668f`). Chapter 4I does not authorize OAuth consent, grant broadening, Graph draft/send, flag flips, or production.

## Disabled / live-proof state

- Frozen `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = false` with load-time throws on the Chapter 4E/4G/4H owners. Do not flip that broadly imported constant. Chapter 4I does not OR an ambient mint into 4H adapters or 4G compose and does not open those gated constructors.
- Public compose, live `runProof`, and CLI `--execute-once` refuse before KV / token / JWKS / live PG / this reader execute.
- Chapter 4I is a pure offline proof-core plus an import-inert, export-empty CLI-only production driver. The driver is guarded only by `require.main === module`, exact local arguments, reviewed candidate SHA **and** tree, canonical receipt, and complete pre/post refresh fencing. Staff API startup and ordinary imports remain inert. Direct 4H production reads still fail before IMDS after any 4I import.
- Eight controlled-drafting / send flags must stay literal `false` on the live app.
- Caller snapshots cannot mint an independent live-proof brand.
- Chapter 4H brands evidence only from the owned reader after measured Azure/PG facts. Chapter 4I consumes that unexported brand through `inspectIndependentLivePreflight` on the proof-core path before Key Vault / token / JWKS / custody PG.
- Eventual accepted merge of Chapter 4I **must** use a true merge commit preserving the reviewed candidate as a parent. Never squash/rebase merge.

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
- Chapter 4I execution owner: `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-SUNSET-STAGING-LIVE-EXECUTION.md`
- Token loan: `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-TOKEN-LOAN.md`
- Staging activation: `docs/EMAIL-LUNA-CONTROLLED-DRAFTING-STAGING-ACTIVATION.md`
- Agent map: `AGENTS.md`

## Verification commands

```bash
npm run verify:email-luna-controlled-drafting-sunset-staging-live-execution
npm run verify:email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader
npm run verify:email-luna-controlled-drafting-live-downscope-prover-live-target
npm run verify:email-luna-controlled-drafting-live-downscope-prover
npm run prove:email-luna-controlled-drafting-live-downscope-prover-offline-simulation
npm run verify:email-luna-controlled-drafting-token-loan
npm run verify:staff-query-api-startup-smoke
npm run verify:migration-integrity
```

Do not run live Chapter 4I `execute-once` against Sunset from this builder.

## Next gate

Chapter 4J retargets the singleton pins to the currently serving disabled Sunset artifact and corrects ARM API `2024-03-01` mapping without weakening authority. Live execution must occur from the new reviewed candidate SHA/tree after exact-head review and true merge — not from `874bcde642d7eb4838529f84246c1c011db9861a`. Operator CLI SHA may differ from deploy SHA; see `chapter_4g_operator_cli_may_differ_from_deployed_app_sha`. The proof must fail closed on reader absence, brand forgery, flag/replica/traffic/login-server/repository/count/grant/lease drift; it must not send, flip flags, broaden OAuth consent, or retry an `outcome_unknown` result. Post-proof audit is independent and read-only. Stage 2 closes only after that live evidence passes all applicable lifecycle gates above. This builder does not execute the one-shot proof.
