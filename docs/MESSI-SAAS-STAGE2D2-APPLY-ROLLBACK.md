# MESSI SaaS Stage 2D2 — temporary apply / rollback / expiry-status

Executable owner for a **temporary** `luna-<slug>-staging-rg` drill. Plan authority is **only** Stage 2D1 `deriveAuthority` (exact-SHA snapshot, pinned tools, staging subscription, compiled Bicep bytes). Callers supply slug + approval flags — never manifest/names/sub/RG/state.

Approval is a hard total cap (not monthly): `--approve-max-total-usd 8 --ttl-hours 48`. TTL 1..48h; cap ≤ $8; monthly flags rejected. Drill tags (`createdAt`/`expiresAt`/`temporaryDrill`/`planDigest`/`deploySha`/tenant/stage/owner) flow via Bicep params (empty defaults preserve Sunset). ARM/job/RG polls use wall-clock `PHASE_MAX_MS` deadlines (RG delete ≥30m), 5s backoff capped 15s, honor numeric/date `Retry-After`, check abort+expiry each iteration, keep terminal body. Phase starts and C2 start/wait/delete (incl. every `waitTerminal` poll) call `assertActiveDrill`. SIGINT/SIGTERM abort; if RG was read present, write nonsecret `rollback_failed`/`rollback_aborted` receipt; lock always `finally`. Rollback fail-closes on any D1 inventory finding; only exact `empty`/`foundation`/`bootstrap-active`/`runtime-prereqs`/`runtime` after full `assertDrillTags` (`empty` = zero-resource, zero-deployment owned drill only). C2 uses pinned `/opt/data/.local/bin/az`. Success receipt requires exact live RG tag tuple. Offline verify only — no live Azure writes.

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
