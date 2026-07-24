# MESSI SaaS Stage 2D2 — temporary apply / rollback / expiry-status

Executable owner for a **temporary** `luna-<slug>-staging-rg` drill. **Apply** plan authority is **only** Stage 2D1 `deriveAuthority` at current clean master HEAD (exact-SHA snapshot, pinned tools, staging subscription, compiled Bicep bytes). **Rollback** may use Stage 2D1 `deriveHistoricalRollbackAuthority` from immutable live RG tags when `deploySha` is a prior master ancestor (full 40-hex commit, ancestor of HEAD and `origin/master`, not side-branch-only): snapshot that exact SHA, rederive names/contract/`planDigest`, require rederived digest equals live `planDigest` and full drill tuple match. Receipt is never authority. Callers supply slug + approval flags — never manifest/names/sub/RG/state.

**Provider preflight (before any RG mutation):** Observed for our current App Insights path (not a global unavoidability claim): App Insights creation triggered Azure platform `Failure-Anomalies-Alert-Rule-Deployment-<8hex>` and the live drill failed MissingSubscriptionRegistration when the fixed staging subscription lacked `Microsoft.AlertsManagement` Registered; no supported disable property exists in our template/repo. Apply performs the same read-only provider GET as Stage 2D1 PLAN and refuses closed (no RG PUT/adopt retag, no self-register, no subscription Contributor/Owner) unless `registrationState==Registered` and `body.id` is case-insensitively exact `/subscriptions/<exact-sub>/providers/Microsoft.AlertsManagement`. `prepare-spec` remains read-only but prints the explicit Azure-admin `az provider register --namespace Microsoft.AlertsManagement --subscription <exact-sub> --wait` plus readback first among `azureAdminCommands`.

Approval is a hard total cap (not monthly): `--approve-max-total-usd 8 --ttl-hours 48`. TTL 1..48h; cap ≤ $8; monthly flags rejected. Drill tags (`createdAt`/`expiresAt`/`temporaryDrill`/`planDigest`/`deploySha`/tenant/stage/owner) flow via Bicep params (empty defaults preserve Sunset). ARM/job/RG polls use wall-clock `PHASE_MAX_MS` deadlines (RG delete ≥30m), 5s backoff capped 15s, honor numeric/date `Retry-After`, check abort+expiry each iteration, keep terminal body. Phase starts and C2 start/wait/delete (incl. every `waitTerminal` poll) call `assertActiveDrill`. SIGINT/SIGTERM abort; if RG was read present, write nonsecret `rollback_failed`/`rollback_aborted` receipt; lock always `finally`. Rollback order: clean master `HEAD==origin/master` → resolve exact slug RG under fixed staging sub → probe live full drill tag tuple → exclusive lock → re-read RG requiring same ETag + full tag tuple (no TOCTOU) → historical authority from live tags → inventory/phase gates → whole-RG delete. Fail-closes on any D1 inventory finding; only exact `empty`/`infra-partial`/`foundation`/`bootstrap-active`/`runtime-prereqs`/`runtime` after full `assertDrillTags` (`empty` = zero-resource, zero-deployment owned drill only; `infra-partial` = exact owned subset of rederived foundation/nested contract with every resource ID present and equal expected, plus deployment rows with exact id/name/type/safe state under this subscription/RG path — plan-owned names and the narrow Azure-generated `Failure-Anomalies-Alert-Rule-Deployment-<8hex>` only via exact platform SHOW signature (`Failed`, pinned `templateHash`, singleton `Microsoft.AlertsManagement`/`smartDetectorAlertRules`/`global`, top error `DeploymentFailed` with exactly one `details[]` row `MissingSubscriptionRegistration` + `target` absent-or-null (CLI materializes null; ARM REST omits null keys; non-null/empty/forged refuse) and no nested detail children) after GET readback, with the expected App Insights component present in live inventory). Refuse zero mutation for nonancestor SHA, missing object, digest mismatch, tag drift, wrong sub/RG/tenant, dirty/non-master checkout, or snapshot/tar/compiler mismatch. Apply never accepts historical authority. Stale op.lock recovers only after recorded PID is proven dead and no competing process (never steal live lock). C2 uses pinned `/opt/data/.local/bin/az`. Success receipt requires exact live RG tag tuple. Offline verify only — no live Azure writes.

```bash
node scripts/messi-saas-stage2d2-apply-rollback.js apply \
  --slug messiproof \
  --approve-max-total-usd 8 \
  --ttl-hours 48

node scripts/messi-saas-stage2d2-apply-rollback.js expiry-status --slug messiproof

node scripts/messi-saas-stage2d2-apply-rollback.js rollback \
  --slug messiproof \
  --confirm-delete luna-messiproof-staging-rg

npm run verify:messi-saas-stage2d2-apply-rollback
```

No background expiry daemon — `expiry-status` prints the paste-ready rollback command.
