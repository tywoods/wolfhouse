# Email Luna controlled-drafting Sunset staging live execution (Chapter 4I)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — dedicated one-shot Sunset staging execution owner for a later downscope + staff-send continuity token-refresh proof. **BUILD/TEST/PR ONLY. Live proof is NOT EXECUTED in this builder.**

**Owner:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.js`

**Owned implementation:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned.js`

**Closed capabilities:** `scripts/lib/email-luna-controlled-drafting-chapter-4i-one-shot-authority.js` (public enumerable surface is error identity / chapter id only; mint/consume are not importable)

**Durable receipt:** `scripts/lib/email-luna-controlled-drafting-chapter-4i-durable-receipt.js`

**Test-only seam:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support.js` (not imported by production; fake constructor, temp receipt store, and closed git command runner live only here)

**CLI:** `scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js`

**Verifier:** `npm run verify:email-luna-controlled-drafting-sunset-staging-live-execution`

Chapter 4E/4G/4H `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains frozen `false`. This chapter does **not** flip that broadly imported constant and does **not** OR an ambient `isActive…` flag into 4H adapters or 4G compose. Direct production 4H `readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg()` stays chapter-disabled and fails before IMDS under every imported 4I state. Staff API startup and ordinary imports remain inert. The Chapter 4E CLI `--execute-once` path stays gated.

This chapter authorizes a **later** bounded one-shot Sunset staging live proof only. It does **not** authorize OAuth consent/grant broadening, credential rotation outside the intrinsic successful-refresh lease/rotation, Graph draft creation, Graph send, provider send, guest contact, flag flips, or production.

## Closed execution composition

The CLI validates exact invocation, the executing git checkout, and the durable receipt **before** any 4H/4G adapter work. Only then does the owned composition receive unexported lexical capabilities that authorize:

1. exactly one production 4H reader construction (that reader may re-read for TOCTOU)
2. exactly one canonical 4G compose, and only after authentic production-reader evidence passes `inspectIndependentLivePreflight(liveOwner, independent)` using the unexported 4H WeakSet predicate

Capabilities cannot be minted or consumed by importing any production module. There is no exported `consume` / `mark` / `isActive` shortcut. Fake construction, temp receipt paths, and git command runners are unavailable from production exports.

## Durable operator-owned one-shot receipt

Canonical absolute path (not caller-chosen, not the repo):

`/var/lib/wolfhouse/full-sail-chapter-4i/sunset-staging-one-shot.receipt`

Operator preparation: create `/var/lib/wolfhouse/full-sail-chapter-4i` as `0700` owned by the operator that will run the CLI. The process must be able to `O_CREAT|O_EXCL` the receipt file as `0600`. Do not place the receipt in the git tree. Do not use Postgres, OAuth grants, 097/098, or flags for this lease.

The receipt binds chapter id, reviewed source SHA, exact target pins, operator nonce, confirmation timestamp, allowlisted counters, and this state machine:

`claimed` → `refresh_1_started` / `refresh_1_completed` → `refresh_2_started` / `refresh_2_completed` → `terminal_success` | `terminal_unknown` | `terminal_refused`

Updates are temp+fsync+rename (directory fsync where supported). A pre-existing claimed, nonterminal, or terminal receipt refuses replay. There is no auto-retry. Post-audit: leave the receipt in place as the durable once-record; do not delete it to re-run.

Offline tests inject a temp store only through the test-support sibling.

## Source identity

`--source-sha` is the **exact merged Chapter 4I commit supplied after merge** and must equal `git rev-parse HEAD` of the executing checkout. The repository root is resolved from this module's `__dirname`. The tracked tree must be clean. The Chapter 4I CLI/lib files must be tracked with no symlink escape out of the repository. Git failure or mismatch refuses **before** receipt claim and before adapters. This chapter does **not** hardcode a pre-merge candidate SHA. Operator CLI SHA may differ from the deployed app SHA (`chapter_4g_operator_cli_may_differ_from_deployed_app_sha`).

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

Independent exact-head security / OAuth / live-operations review of this PR, then merge, then a separately gated bounded execution. After merge, pass the merged Chapter 4I commit as `--source-sha` (it must equal `HEAD`):

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
  --source-sha <merged-chapter-4i-40-hex-equal-to-HEAD> \
  --confirm I_UNDERSTAND_SUNSET_STAGING_CHAPTER_4I_ONE_SHOT_LIVE_PROOF \
  --operator-nonce <64-lowercase-hex> \
  --confirm-issued-at <ISO-8601 now, 15-minute window>
```

Equals-form flags, `--target`, extra args, env aliases, production, Wolfhouse, other app/DB, HTTP(S) proxies, and duplicate flags fail closed before adapters.

### Sequence

1. Validate exact invocation.
2. Bind `--source-sha` to the executing git checkout (`HEAD`, clean tracked tree, no symlink escape).
3. Claim the durable receipt (`O_CREAT|O_EXCL`). Replay refuses.
4. Mint the unexported 4H read capability; construct the production 4H reader; consume authentic branded evidence through `inspectIndependentLivePreflight`.
5. Mint the unexported 4G compose capability bound to that evidence/target; compose exactly once.
6. Re-read branded 4H evidence immediately before refresh #1. Require complete stable target/flags/replica/image/counts/binding/LOGIN/grant/lease/reconcile state and generation **G** (never compare `undefined`).
7. One downscoped refresh requesting the exact allowed draft-only scopes. Signed JWKS validation. Prove `scp` excludes `Mail.Send` (boolean only in the machine record). Persist only the intrinsic lease/rotation of a successful refresh.
8. Re-read branded 4H evidence immediately before refresh #2. After a successful rotation commit, prove generation **G+1**. If the response omitted a new refresh token, prove unchanged generation **G**. Any mismatch refuses with no subsequent refresh.
9. One subsequent ordinary staff-send continuity refresh through the same shared existing grant. Prove continuity token includes the expected existing staff-send scope (boolean only).
10. Sanitized allowlisted terminal evidence. After any Microsoft POST starts, `refresh_call_count` is 1 or 2 on every path. Graph/send/`operational_write_count` remain 0.

No Graph API call and no send. No consent/create/revoke, 097/098, flags, journal, or extra grant reauthorization/reconciliation marks. If existing grant/authorization state is not exactly eligible, fail closed without manufacturing it.

### Stop / cleanup matrix

| Situation | Action |
| --- | --- |
| Missing/hostile args, production, Wolfhouse, extra env aliases | Refuse before adapters. `status=refused`. Refresh count 0. Do not retry as a different target. |
| Source SHA / dirty tree / symlink escape / git failure | Refuse before receipt claim. |
| Receipt already claimed/nonterminal/terminal | Fail before adapters. Do not retry. |
| 4H reader missing, brand forgery, snapshot, stub predicate | Fail closed. Zero KV/token/JWKS/custody PG. |
| Flag / revision / digest / count / grant / lease / binding / LOGIN / generation drift | Fail closed. Do not retry. |
| Grant not exactly eligible | Fail closed. Do not create/update/revoke consent, 098, or 097 rows. No reauth/reconcile marks. |
| First refresh throw/timeout/malformed/uncertain | `status=outcome_unknown`, `refresh_call_count=1`. Do not attempt continuity. Do not retry. |
| Continuity / claims / JWKS / receipt-write / cleanup failure after a Microsoft POST | `status=outcome_unknown` with the true `refresh_call_count` (1 or 2). Do not reset to 0. Do not retry. |
| Success | `refresh_call_count=2`, Mail.Send absent on downscope, expected staff-send scope present on continuity, Graph/send/`operational_write_count` 0. |
| Cleanup | Installed before sensitive acquisition. Close/destroy/end acquired PG clients, HTTP agents/transports if owned, token/client refs, and provider handles. Cleanup failure → `terminal_unknown` while preserving call counts. |

Post-proof audit is **read-only**: re-read flags (all literal `false`), revision/digest pins, 097/098 counts remain zero, no mailbox/Graph mutation. Leave the receipt as the durable once-record.

## Machine record

One frozen null-prototype allowlisted JSON line: `proof_version`, `ok`, `status`, target aliases (`deployment`, `tenant`, `database`, `resource_group`, `app_name`), `source_sha` / `deploy_sha` / `revision` / `digest`, preflight timestamps, `fence_generation`, `downscope_mail_send_absent`, `continuity_expected_scope_present`, `refresh_call_count`, `graph_call_count`, `send_call_count`, `local_receipt_write_count`, `custody_write_count`, `operational_write_count`, `compatibility_rule_id`. No reason bodies, raw scopes, tokens, DSNs, JWTs, mailbox, email, stack/cause, or provider payload.

The receipt contains only allowlisted hashes/IDs/status/counters. No secrets.

## Non-goals

- No live proof, deploy, ACA/ACR/PG topology mutation, 098 consume, flag flip, send, or Graph in this builder
- No OAuth consent / delegated-grant create/update/revoke; no extra reauth/reconcile marks
- No Staff API import or route mutation
- No public adapter factory, mint, mark, predicate, or injectable constructor on any production export
- Offline verifiers never reach network/live PG by filename tricks
