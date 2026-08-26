# Email Luna controlled-drafting Sunset staging live execution (Chapter 4I)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — dedicated one-shot Sunset staging execution owner for a later downscope + staff-send continuity token-refresh proof. **BUILD/TEST/PR ONLY. Live proof is NOT EXECUTED in this builder.**

**Pure offline proof-core:** `scripts/lib/email-luna-controlled-drafting-chapter-4i-proof-core.js` (importable; accepts already-created adapters/evidence readers only; no production adapter constructors, no env-selected live composition)

**Public constants owner:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.js` (parse/validate/constants only; no production constructor, mint, capability, or execute-once seam)

**CLI-only production driver:** `scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js` (`module.exports` remains the empty object; `require()` is a no-op; live composition is lexical and reachable only from `require.main === module`)

**Durable receipt:** `scripts/lib/email-luna-controlled-drafting-chapter-4i-durable-receipt.js`

**Test-only seam:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support.js` (not imported by production; fake adapters, temp receipt store, and closed git command runner live only here)

**Verifier:** `npm run verify:email-luna-controlled-drafting-sunset-staging-live-execution`

Chapter 4E/4G/4H `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains frozen `false`. This chapter does **not** flip that broadly imported constant and does **not** open 4H/4G gated production constructors. Direct production 4H `readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg()` stays chapter-disabled and fails before IMDS under every imported 4I state. Staff API startup and ordinary imports remain inert. The Chapter 4E CLI `--execute-once` path stays gated.

There is **no** callsite/stack/filename/capability authorization. The security boundary is: only executing the exact CLI file as `require.main === module` with exact local arguments, the reviewed candidate SHA **and** tree, and a canonical receipt claim can reach lexical live composition. `require()` under any filename, VM, symlink, or copy exports nothing callable and performs no action.

This chapter authorizes a **later** bounded one-shot Sunset staging live proof only. It does **not** authorize OAuth consent/grant broadening, credential rotation outside the intrinsic successful-refresh lease/rotation, Graph draft creation, Graph send, provider send, guest contact, flag flips, or production.

## Merge model (required)

PR **#745 must be merged with a true merge commit** that preserves this reviewed candidate SHA as a parent. **Never squash-merge. Never rebase-merge.** Squash/rebase would mint an unreviewed SHA and break the `--source-sha` / `--source-tree` bind.

After merge, the later operator runs from a **clean detached checkout/worktree at the exact reviewer-approved candidate SHA**. That SHA must be:

1. an ancestor of current `origin/master` (`git merge-base --is-ancestor HEAD origin/master`)
2. exactly the PR's preserved merge parent
3. equal to `git rev-parse HEAD`
4. equal in tree to the reviewer-approved `--source-tree` (`git rev-parse 'HEAD^{tree}'`)

No post-merge code is executed. Live execution must occur from the new reviewed candidate SHA/tree after exact-head review and true merge — not from `874bcde642d7eb4838529f84246c1c011db9861a`. The currently serving disabled Staff API artifact is independently pinned (`a4188eea71a92b7361818e024cde0f810d6ee018`, revision `luna-sunset-staging-staff-api--0000682`). Operator CLI SHA may differ from the deployed app SHA (`chapter_4g_operator_cli_may_differ_from_deployed_app_sha`). If GitHub cannot preserve the reviewed parent, **do not merge and do not execute**.

## Durable operator-owned one-shot receipt

Canonical absolute path (not caller-chosen, not the repo):

`/var/lib/wolfhouse/full-sail-chapter-4i/sunset-staging-one-shot.receipt`

Operator preparation: create `/var/lib/wolfhouse/full-sail-chapter-4i` as `0700` owned by the operator that will run the CLI. The process must be able to `O_CREAT|O_EXCL` the receipt file as `0600`. Do not place the receipt in the git tree. Do not use Postgres, OAuth grants, 097/098, or flags for this lease.

The receipt binds chapter id, reviewed source SHA, reviewed source tree, exact target pins, operator nonce, confirmation timestamp, allowlisted counters, and this state machine:

`claimed` → `refresh_1_started` / `refresh_1_completed` → `refresh_2_started` / `refresh_2_completed` → `terminal_success` | `terminal_unknown` | `terminal_refused`

Updates are temp+fsync+rename (directory fsync where supported). A pre-existing claimed, nonterminal, or terminal receipt refuses replay. There is no auto-retry. Post-audit: leave the receipt in place as the durable once-record; do not delete it to re-run.

**Honest boundary:** `O_CREAT|O_EXCL` plus fsync is an accidental/concurrent replay guard. It does **not** stop a malicious same-UID operator who deletes or replaces the receipt. Deletion/replacement is a prohibited manual override and requires **fresh explicit user authorization**. The actual no-retry authority is the operator's one-run authorization plus the terminal uncertainty policy.

Offline tests inject a temp store only through the test-support sibling.

## Source identity

`--source-sha` is the **exact reviewed candidate commit** (the preserved merge parent after a true merge). `--source-tree` is that commit's `HEAD^{tree}` (40 hex). Both are independently approved by the exact-head reviewer.

The CLI resolves the repository root from the realpath of this driver file, sanitizes Git env (`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / replace-refs / config injection removed; `--no-replace-objects`; explicit cwd), and requires:

- clean tracked tree (staged, unstaged, and untracked)
- `git rev-parse HEAD` equals `--source-sha`
- `git rev-parse 'HEAD^{tree}'` equals `--source-tree`
- `git merge-base --is-ancestor HEAD origin/master`
- required Chapter 4I files tracked and realpath-contained (no symlink escape)

Git failure or mismatch refuses **before** receipt claim and before adapters. This chapter does **not** accept an unknown post-squash SHA.

## Exact live target pins (Chapter 4J retarget of the currently serving disabled artifact)

| Fact | Value |
| --- | --- |
| Subscription | `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` |
| Location | `northeurope` (ARM display `North Europe` closed-mapped; unrelated locations fail closed) |
| RG / app | `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` |
| Revision | `luna-sunset-staging-staff-api--0000682` |
| Deployed source/image SHA | `a4188eea71a92b7361818e024cde0f810d6ee018` |
| Digest | `sha256:820f302e8f59cfe8636eb0267c6f15bc0750f300b76735f511f3dde9c031dc39` (ACR `Docker-Content-Digest` authority; ARM runtime digest may be typed `arm_runtime_digest_unavailable` when the revision omits `properties.imageDigest` and the image is tag-only) |
| Database | `sunset_staging` |
| Tenant slug | `sunset` |

## Exact future live operator sequence (NOT this builder)

Independent exact-head security / OAuth / live-operations review of this PR, then a **true merge commit** preserving this candidate, then a separately gated bounded execution from a clean detached checkout at that candidate:

```text
node scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js preflight \
  --deployment sunset-staging \
  --tenant sunset \
  --database sunset_staging \
  --resource-group luna-sunset-staging-rg \
  --app luna-sunset-staging-staff-api \
  --revision luna-sunset-staging-staff-api--0000682 \
  --deploy-sha a4188eea71a92b7361818e024cde0f810d6ee018 \
  --digest sha256:820f302e8f59cfe8636eb0267c6f15bc0750f300b76735f511f3dde9c031dc39 \
  --source-sha <reviewed-candidate-40-hex-equal-to-HEAD> \
  --source-tree <reviewed-candidate-tree-40-hex>

node scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js execute-once \
  --deployment sunset-staging \
  --tenant sunset \
  --database sunset_staging \
  --resource-group luna-sunset-staging-rg \
  --app luna-sunset-staging-staff-api \
  --revision luna-sunset-staging-staff-api--0000682 \
  --deploy-sha a4188eea71a92b7361818e024cde0f810d6ee018 \
  --digest sha256:820f302e8f59cfe8636eb0267c6f15bc0750f300b76735f511f3dde9c031dc39 \
  --source-sha <reviewed-candidate-40-hex-equal-to-HEAD> \
  --source-tree <reviewed-candidate-tree-40-hex> \
  --confirm I_UNDERSTAND_SUNSET_STAGING_CHAPTER_4I_ONE_SHOT_LIVE_PROOF \
  --operator-nonce <64-lowercase-hex> \
  --confirm-issued-at <ISO-8601 now, 15-minute window>
```

`preflight` is local source/receipt-path validation and target-pin display only. It does **not** claim the receipt, does **not** touch the network, and is **not** live PASS. `execute-once` remains a separate explicit command. Do not silently prepare or delete receipts.

Equals-form flags, `--target`, extra args, env aliases, production, Wolfhouse, other app/DB, HTTP(S) proxies, Git env injection, and duplicate flags fail closed before adapters.

### Sequence

1. Validate exact invocation (`require.main === module` plus exact args).
2. Bind `--source-sha` / `--source-tree` to the executing git checkout as specified above.
3. Claim the durable receipt (`O_CREAT|O_EXCL`) **before** any adapter/network. Replay refuses.
4. Lexically construct the production 4H measurement adapters and 4G execution dependencies from shared low-level primitives. Do not call gated 4H/4G public owners. Consume authentic branded evidence through `inspectIndependentLivePreflight`.
5. Re-read branded 4H evidence immediately before refresh #1. Require complete stable target / `traffic_weight` / `image_login_server` / `image_repository` / image tag / deploy SHA / digest / revision / replica / flags / counts / tenant / database / LOGIN fingerprints / binding IDs / grant status / reconcile / lease and generation **G** (never compare `undefined`; no tautological generation-only check).
6. One downscoped refresh requesting the exact allowed draft-only scopes. Signed JWKS validation. Prove `scp` excludes `Mail.Send` (boolean only in the machine record). Persist only the intrinsic lease/rotation of a successful refresh.
7. Re-read branded 4H evidence immediately before refresh #2. After a successful rotation commit, prove generation **G+1**. If the response omitted a new refresh token, prove unchanged generation **G**. Any mismatch refuses with no subsequent refresh.
8. One subsequent ordinary staff-send continuity refresh through the same shared existing grant. Prove continuity token includes the expected existing staff-send scope (boolean only).
9. Sanitized allowlisted terminal evidence. After any Microsoft POST starts, `refresh_call_count` is 1 or 2 on every path. Graph/send/`operational_write_count` remain 0. Bounded async close/end/destroy is awaited; cleanup failure → `terminal_unknown` with preserved counts.

Exactly two POSTs on success, fixed order, no retry. No Graph API call and no send. No consent/create/revoke, 097/098, flags, journal, or extra grant reauthorization/reconciliation marks. If existing grant/authorization state is not exactly eligible, fail closed without manufacturing it.

### Stop / cleanup matrix

| Situation | Action |
| --- | --- |
| Missing/hostile args, production, Wolfhouse, extra env aliases | Refuse before adapters. `status=refused`. Refresh count 0. Do not retry as a different target. |
| Source SHA/tree / dirty tree / symlink escape / Git env / not an ancestor of origin/master | Refuse before receipt claim. |
| Receipt already claimed/nonterminal/terminal | Fail before adapters. Do not retry. |
| Fake/plain evidence, stub predicate, module-cache attack | Fail closed on the proof-core path. Production compose is not importable. |
| Flag / revision / digest / traffic_weight / login-server / repository / count / grant / lease / binding / LOGIN / generation drift | Fail closed. Do not retry. |
| Grant not exactly eligible | Fail closed. Do not create/update/revoke consent, 098, or 097 rows. No reauth/reconcile marks. |
| First refresh throw/timeout/malformed/uncertain | `status=outcome_unknown`, `refresh_call_count=1`. Do not attempt continuity. Do not retry. |
| Continuity / claims / JWKS / receipt-write / cleanup failure after a Microsoft POST | `status=outcome_unknown` with the true `refresh_call_count` (1 or 2). Do not reset to 0. Do not retry. Await bounded close/end/destroy. Cleanup failure preserves counts. |
| Success | `refresh_call_count=2`, Mail.Send absent on downscope, expected staff-send scope present on continuity, Graph/send/`operational_write_count` 0. |
| Receipt deletion by same-UID operator | Prohibited manual override. Not claimed impossible. Requires fresh explicit user authorization. |

Post-proof audit is **read-only**: re-read flags (all literal `false`), revision/digest pins, 097/098 counts remain zero, no mailbox/Graph mutation. Leave the receipt as the durable once-record.

## Machine record

One frozen null-prototype allowlisted JSON line: `proof_version`, `ok`, `status`, target aliases (`deployment`, `tenant`, `database`, `resource_group`, `app_name`), `source_sha` / `source_tree` / `deploy_sha` / `revision` / `digest`, preflight timestamps, `fence_generation`, `downscope_mail_send_absent`, `continuity_expected_scope_present`, `refresh_call_count`, `graph_call_count`, `send_call_count`, `local_receipt_write_count`, `custody_write_count`, `operational_write_count`, `compatibility_rule_id`. No reason bodies, raw scopes, tokens, DSNs, JWTs, mailbox, email, stack/cause, or provider payload.

The receipt contains only allowlisted hashes/IDs/status/counters. No secrets.

`status=preflight_ok` is local source/receipt-path/pin validation only. It is **not** live PASS. Only the exact production CLI main path may return it, and only after `assertExecutingSource` and canonical receipt-path inspection. Imported refuse-only `runCli` returns `cli_main_required` for preflight and cannot claim that validation.

## Non-goals

- No live proof, deploy, ACA/ACR/PG topology mutation, 098 consume, flag flip, send, or Graph in this builder
- No OAuth consent / delegated-grant create/update/revoke; no extra reauth/reconcile marks
- No Staff API import or route mutation
- No public adapter factory, mint, mark, predicate, capability, or injectable production constructor on any production export
- No squash/rebase merge of this PR
- Offline verifiers never reach network/live PG by filename tricks
