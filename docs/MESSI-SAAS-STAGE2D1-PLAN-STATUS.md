# MESSI SaaS Stage 2D1 — synthetic plan / status (read-only)

PLAN/STATUS for `luna-<slug>-staging-rg`. Master gate → `verifiedDeploySha` archive (never HEAD) → snapshot worker via capability FD; digest binds tool hashes+Bicep; no `--expected-plan-digest`. Status uses exact live resource contract (foundation/bootstrap-active/runtime-prereqs/runtime) via targeted ARM GETs.

## Microsoft.AlertsManagement provider preflight (PLAN)

**Observed** (our current tenant-staging App Insights path — not a global Azure unavoidability claim without external authoritative evidence): creating Application Insights (`Microsoft.Insights/components` in repo Bicep) triggered Azure platform deployment `Failure-Anomalies-Alert-Rule-Deployment-<8hex>` under `Microsoft.AlertsManagement/smartDetectorAlertRules`. Live defect: that nested deploy failed with `MissingSubscriptionRegistration` when the fixed staging subscription had `registrationState=NotRegistered`. Repo Bicep only sets `Application_Type` + `WorkspaceResourceId` — no supported disable property for that platform smart-detection deploy exists in our template/repo.

**PLAN** therefore performs a **read-only** ARM GET on the exact fixed staging subscription:

`GET /subscriptions/<exact-sub>/providers/Microsoft.AlertsManagement?api-version=2021-04-01`

and requires `registrationState==Registered` plus `body.id` case-insensitively exact `/subscriptions/<exact-sub>/providers/Microsoft.AlertsManagement` (no query/suffix/child path; fixture has no trailing slash) before plan success. Fail-closed on `NotRegistered` / `Unregistered` / `Registering` / absent / malformed / 403 / 500 / wrong namespace / wrong subscription id / absent-null-empty-non-string id. Never self-registers (no provider POST; no `az provider register` in plan).

Azure-admin paste-ready (subscription write; not the executor):

```bash
az provider register --namespace Microsoft.AlertsManagement --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --wait
az provider show --namespace Microsoft.AlertsManagement --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --query registrationState -o tsv
```

```bash
node scripts/messi-saas-stage2d1-plan-status.js plan --slug synthdemo
node scripts/messi-saas-stage2d1-plan-status.js status --slug synthdemo
npm run verify:messi-saas-stage2d1-plan-status
```
