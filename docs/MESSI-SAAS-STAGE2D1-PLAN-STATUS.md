# MESSI SaaS Stage 2D1 — synthetic plan / status (read-only)

PLAN/STATUS for `luna-<slug>-staging-rg`. Master gate → `verifiedDeploySha` archive (never HEAD) → snapshot worker via capability FD; digest binds tool hashes+Bicep; no `--expected-plan-digest`. Status uses exact live resource contract (foundation/bootstrap-active/runtime-prereqs/runtime) via targeted ARM GETs.

```bash
node scripts/messi-saas-stage2d1-plan-status.js plan --slug synthdemo
node scripts/messi-saas-stage2d1-plan-status.js status --slug synthdemo
npm run verify:messi-saas-stage2d1-plan-status
```
