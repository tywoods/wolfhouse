# MESSI SaaS Stage 2D — synthetic staging plan / apply / status / rollback

Owner for exact dedicated `luna-<slug>-staging-rg` stacks. Plan authority is **only** the Stage1 materialized tenant manifest + repo tenant-staging Bicep + slug + active Azure subscription. Callers cannot supply a plan body.

Secrets (PG admin/app/session/bot + Stripe/Meta sentinels) are generated in memory and sent only inside Node HTTPS ARM deployment JSON bodies using a bearer token from `az account get-access-token`. They never enter argv, logs, stdout plans, local state, tags, or normal parameter files.

## Exact commands

```bash
# PLAN (read-only): clean synced master, compile Bicep, subscription check, RG ownership, Cost Management, SKU estimate
node scripts/messi-saas-stage2d-apply-owner.js plan \
  --slug synthdemo \
  --manifest-dir /path/to/stage1-materialized

# STATUS: rederive plan; compare ARM resources/tags/properties (do not trust local state alone)
node scripts/messi-saas-stage2d-apply-owner.js status \
  --slug synthdemo \
  --manifest-dir /path/to/stage1-materialized

# APPLY: rederive+digest compare; cost approval; ACR build from synced master; phased ARM deploy
node scripts/messi-saas-stage2d-apply-owner.js apply \
  --slug synthdemo \
  --manifest-dir /path/to/stage1-materialized \
  --confirm-cost-approval \
  --max-monthly-estimate 120

# Optional: on failure delete the owned RG instead of preserving it for diagnosis
node scripts/messi-saas-stage2d-apply-owner.js apply \
  --slug synthdemo \
  --manifest-dir /path/to/stage1-materialized \
  --confirm-cost-approval \
  --max-monthly-estimate 120 \
  --rollback-on-failure

# ROLLBACK: ownership tuple + resource ID/tag readback, delete exact RG, remove local state
node scripts/messi-saas-stage2d-apply-owner.js rollback \
  --slug synthdemo \
  --confirm-rollback
```

## Phases (apply)

1. Create/tag RG with `tenant` / `stage=saas-2d` / `owner=messi-stage2d` / `planDigest` / `deploySha`
2. Infra deployment (`runtimeDeploymentPhase=none`)
3. Bootstrap Job deployment → start → poll success
4. Redeploy without bootstrap Job → verify Job absent
5. `runtime-prereqs` → read back KV Secrets User + AcrPull → bounded wait
6. `runtime-app` → poll revision/replicas → HTTPS `/healthz` + tenant identity + disabled staff/Stripe/WhatsApp flags

Nonsecret state is written only after ARM readback to `tmp/messi-saas-stage2d/<slug>.local.json`.

## Verify (offline)

```bash
npm run verify:messi-saas-stage2d-apply-owner
```
