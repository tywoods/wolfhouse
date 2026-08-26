# Email Luna controlled-drafting Sunset staging live execution (Chapter 4I)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — dedicated one-shot Sunset staging execution owner for a later downscope + staff-send continuity token-refresh proof. **BUILD/TEST/PR ONLY. Live proof is NOT EXECUTED in this builder.**

**Owner:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.js`

**Owned implementation:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned.js`

**One-shot authority:** `scripts/lib/email-luna-controlled-drafting-chapter-4i-one-shot-authority.js`

**Test-only seam:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support.js` (not imported by production)

**CLI:** `scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js`

**Verifier:** `npm run verify:email-luna-controlled-drafting-sunset-staging-live-execution`

Chapter 4E/4G/4H `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains frozen `false`. This chapter does **not** flip that broadly imported constant. Staff API startup and ordinary imports remain inert. The Chapter 4E CLI `--execute-once` path stays gated.

This chapter authorizes a **later** bounded one-shot Sunset staging live proof only. It does **not** authorize OAuth consent/grant broadening, credential rotation, Graph draft creation, Graph send, provider send, guest contact, flag flips, or production.

## Source ownership and one-shot authority

- Dedicated Chapter 4I execution owner / entrypoint with a closed, exact Sunset-only invocation. No generic `--target`.
- Process-local WeakSet one-shot brand, consumable exactly once. A second call in the same process fails before sensitive acquisition.
- Production `executeOnceSunsetStagingLiveProof` invokes the production Chapter 4H reader with zero caller input, then consumes the unexported brand through canonical `inspectIndependentLivePreflight(liveOwner, independent)` **before** Key Vault / token / JWKS / custody PG.
- No caller snapshot, callback, env JSON, args object, or file can provide 4H evidence.
- Image identity: proof target is the existing disabled deployed Staff API artifact (SHA / revision / digest pins below). Chapter 4I `source_sha` is the reviewed operator-script tree and **may differ** from `deploy_sha` (`chapter_4g_operator_cli_may_differ_from_deployed_app_sha`). Prefer executing the reviewed script from an authenticated operator runner against the existing disabled deployed artifact. Do not require the prover image to equal the old target.

## Exact live target pins (inherited; not re-measured here)

| Fact | Value |
| --- | --- |
| Subscription | `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` |
| Location | `northeurope` |
| RG / app | `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` |
| Revision | `luna-sunset-staging-staff-api--ch4f-f6ee5112` |
| Deployed source/image SHA | `f6ee511273160cb46c72e345137800878d4c6512` |
| Digest | `sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a` |
| Database | `sunset_staging` |
| Tenant slug | `sunset` |

## Exact future live operator sequence (NOT this builder)

Independent exact-head security / OAuth / live-operations review of this PR, then merge, then a separately gated bounded execution:

```text
node scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js execute-once \
  --deployment sunset-staging \
  --tenant sunset \
  --database sunset_staging \
  --resource-group luna-sunset-staging-rg \
  --app luna-sunset-staging-staff-api \
  --revision luna-sunset-staging-staff-api--ch4f-f6ee5112 \
  --deploy-sha f6ee511273160cb46c72e345137800878d4c6512 \
  --digest sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a \
  --source-sha <reviewed-chapter-4i-40-hex> \
  --confirm I_UNDERSTAND_SUNSET_STAGING_CHAPTER_4I_ONE_SHOT_LIVE_PROOF \
  --operator-nonce <64-lowercase-hex> \
  --confirm-issued-at <ISO-8601 now, 15-minute window>
```

Equals-form flags, `--target`, extra args, env aliases, production, Wolfhouse, other app/DB, HTTP(S) proxies, and duplicate flags fail closed before adapters.

### Sequence

1. Consume in-process one-shot authority (replay fails).
2. Owned Chapter 4H reader + brand + freshness.
3. Recheck zero 097 ops/transitions and zero 098 authorizations plus clean lease/grant/reconcile.
4. Install cleanup / final evidence (no Graph/send/097/098 writes; close token/client/PG).
5. Acquire existing sealed refresh-token custody through the canonical owner without exposing secrets.
6. Re-read branded preflight immediately before the downscope refresh (stable generation/target).
7. One downscoped refresh requesting the exact allowed draft-only scopes.
8. Signed JWKS validation and claims/account/mailbox binding. Prove `scp` excludes `Mail.Send` (boolean only in the machine record).
9. Re-read branded preflight immediately before the continuity refresh.
10. One subsequent ordinary staff-send continuity refresh through the same shared existing grant.
11. Signed validation. Prove continuity token includes the expected existing staff-send scope (boolean only).
12. Sanitized allowlisted terminal evidence. Refresh call count exactly 2. Graph/send/write counts zero.

No Graph API call and no send. If existing grant/authorization state is not exactly eligible, fail closed without manufacturing it.

### Stop / cleanup matrix

| Situation | Action |
| --- | --- |
| Missing/hostile args, production, Wolfhouse, extra env aliases | Refuse before adapters. `status=refused`. Refresh count 0. Do not retry as a different target. |
| One-shot already consumed / nonce replay | Fail before sensitive acquisition. |
| 4H reader missing, brand forgery, snapshot, stub predicate | Fail closed. Zero KV/token/JWKS/custody PG. |
| Flag / revision / digest / count / grant / lease / binding drift | Fail closed. Do not retry. |
| Grant not exactly eligible | Fail closed. Do not create/update/revoke consent, 098, or 097 rows. |
| First refresh throw/timeout/malformed/uncertain | `status=outcome_unknown`, `refresh_call_count=1`. Do not attempt continuity. Do not retry. |
| Continuity failure after successful downscope | Fail closed. Do not retry. Leave grant fail-closed if post-Microsoft uncertainty is unproven. |
| Success | `refresh_call_count=2`, Mail.Send absent on downscope, expected staff-send scope present on continuity, Graph/send/write 0. |
| Cleanup | Always drop token refs and close clients. Prove zero Graph/send/097/098 writes. Do not flip flags. |

Post-proof audit is **read-only**: re-read flags (all literal `false`), revision/digest pins, 097/098 counts remain zero, no mailbox/Graph mutation.

## Machine record

One strict allowlisted JSON object: `proof_version`, `ok`, `status`, target aliases (`deployment`, `tenant`, `database`, `resource_group`, `app_name`), `source_sha` / `deploy_sha` / `revision` / `digest`, preflight timestamps, `fence_generation`, `downscope_mail_send_absent`, `continuity_expected_scope_present`, `refresh_call_count`, `graph_call_count`, `send_call_count`, `write_count`, `compatibility_rule_id`. No raw scopes, tokens, DSNs, JWTs, mailbox, or tenant secrets.

## Non-goals

- No live proof, deploy, ACA/ACR/PG topology mutation, 098 consume, flag flip, send, or Graph in this builder
- No OAuth consent / delegated-grant create/update/revoke
- No Staff API import or route mutation
- No public adapter factory on the production owner
- Offline verifiers never reach network/live PG by filename tricks
