# MESSI SaaS Stage 2D2.1 — prepared-RG authorization (two-session)

Narrow grant so the executor UAI (`e3136eed-948b-4947-a26e-50a33b45a41a`) can run Stage 2D2 apply without subscription Contributor/Owner. Offline verify only — no live Azure writes in coding.

## Session 1 — Azure admin (write)

Read-only spec (rederives exact D1 authority; prints nonsecret JSON + paste-ready commands):

```bash
node scripts/messi-saas-stage2d2-apply-rollback.js prepare-spec \
  --slug messiproof \
  --ttl-hours 48 \
  --approve-max-total-usd 8
```

Admin pastes the printed commands to create exact empty `luna-messiproof-staging-rg` in `westeurope` with tags `preparedFor=messi-stage2d2`, `tenant`, `planDigest`, `deploySha`, then three deterministic named role assignments: RG Contributor + RG Role Based Access Control Administrator, plus temporary ACR Role Based Access Control Administrator on shared `whstagingacr`. Never grant subscription Contributor/Owner.

## Session 2 — executor UAI

```bash
node scripts/messi-saas-stage2d2-apply-rollback.js apply \
  --slug messiproof \
  --approve-max-total-usd 8 \
  --ttl-hours 48 \
  --adopt-prepared-rg
```

`--adopt-prepared-rg` validates prepared state (exact RG id/location/prepared tags; empty generic child inventory except RG-scope prep metadata; ARM `atScope()` direct RG roles exactly executor Contributor + RBAC Administrator; targeted GET bodies for all three prep assignments; executor direct ACR roles exactly existing AcrPush + named ACR Build Runner + deterministic temp RBAC Administrator, ignoring unrelated principals; active token `oid` = approved executor). Then If-Match retags to full drill tags and immediately re-reads RG tags/ETag and re-enumerates inventory, direct RG roles, targeted prep roles, executor ACR roles, and token oid before the first deployment PUT (TOCTOU fail-closed with nonsecret ACR cleanup receipt/commands and no phase write). Without the flag, APPLY still requires the RG absent.

Rollback deletes the RG (exact inventory), then deletes the exact temporary ACR RBAC-admin assignment only after an independent exact-GET identity match (body.id/name case-insensitive; properties principalId/roleDefinitionId/scope; principalType=ServicePrincipal), with If-Match only when Azure supplied an ETag, and post-delete 404 readback. `expiry-status` warns if that ACR grant remains. Failed apply receipts include paste-ready ACR cleanup (no secrets).

```bash
npm run verify:messi-saas-stage2d21-prepared-rg
```
