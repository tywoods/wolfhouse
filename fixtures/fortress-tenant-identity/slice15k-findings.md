# FORTRESS Slice 15K — Signature control reaudit (B01 / B12)

**Status:** reaudit complete (audit only; zero runtime change)
**Master basis:** `9a734fa8e989e10800afbdde0ac722187f6db2d5`
**Branch:** `fortress/slice-15k-signature-control-audit`
**Boundaries:** `B01_meta_whatsapp_signature_ingress`, `B12_stripe_webhook_signature`

## Outcome

Re-audit frozen Meta hub signature/verify and Stripe webhook signature controls across source, deployment manifests/scripts, and committed safe config examples. Trace raw-body handling, secret selection, signature comparison, route ordering, skip/disable flags, runtime profile guards, startup validation, and failure responses before any DB/Stripe/booking side effect. Distinguish committed source guarantees from live activation evidence.

## Historical 15A

15A matrix/attack-cases/doc remain the frozen audit (B01 `unproven`, B12 `proven_isolated_by_runtime`). Status update is this overlay only — see `slice15k-b01-b12-audit-overlay.json`.

## Verdicts

| Boundary | 15A (historical) | 15K overlay | Severity |
|----------|------------------|-------------|----------|
| B01 Meta signature / hub verify | `unproven` | `vulnerable` | high |
| B12 Stripe webhook signature | `proven_isolated_by_runtime` | `proven_isolated_by_runtime` | high |

### B01 — vulnerable (source-proven)

`verifyMetaHubSignature256` returns `skipped:true` when `META_APP_SECRET` is absent **and** when the secret is present but `X-Hub-Signature-256` is missing. `handleMetaWhatsAppWebhookPost` rejects only when `!skipped && !verified`, so skipped results are admitted into `processMetaWhatsAppWebhookPostEntry` (normalize → optional PG). Staging/sunset Bicep wire Meta send token/phone id but **not** `META_APP_SECRET`. GET hub verify falls back to hardcoded `DEFAULT_META_WHATSAPP_VERIFY_TOKEN`.

Live presence/correctness of `META_APP_SECRET` remains **unproven** offline (and IaC does not declare it).

### B12 — proven_isolated_by_runtime (source + IaC)

When `STRIPE_WEBHOOK_SKIP_VERIFY` is not exactly `true`, missing `STRIPE_WEBHOOK_SECRET` → **503** `no_db_write` before tenant bind / payment DB. Raw `readBodyRaw` + `constructEvent` ordering is correct. Staging/sunset **Staff API** Bicep pin `STRIPE_WEBHOOK_SKIP_VERIFY=false` and `secretRef` the webhook secret.

**Consumer split (source-derived inventory):**
- **Staff API** — B12 HTTP HMAC owner (`constructEvent` / skip / 503).
- **n8n-main** — staging Bicep pins skip=`false` without `STRIPE_WEBHOOK_SECRET`; local compose carries both vars for Code nodes (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true` on Azure).
- **n8n-worker** — local compose mirrors Stripe webhook env; Azure staging worker omits both vars.

**Residual (non-blocking):** `STRIPE_WEBHOOK_SKIP_VERIFY=true` has no `NODE_ENV`/profile startup refuse (docs + IaC pin only). Live secret **value** and Stripe endpoint registration are unproven in this slice.

## Signature config-owner completeness

Completeness method: `source_derived_scoped_occurrence_inventory` in `slice15k-consumer-matrix.json`. Verifier derives occurrences of the five signature symbols from scoped paths, requires every mapped owner, rejects unmapped/stale entries, and executes/binds every attack case by id. 15L owner list is reconciled to B01 Staff API + Bicep + `.env.example` only (n8n/Hermes/preflight/inventory remain inventoried, out of 15L).

## Source vs live activation

| Boundary | Committed source/IaC guarantee | Live activation evidence |
|----------|--------------------------------|--------------------------|
| B01 | Fail-open skip paths are source-proven; no fail-closed admit guarantee | unproven (no IaC secret; no offline secret proof) |
| B12 | Fail-closed without secret when skip false; IaC pins skip false + secretRef | skip=false recorded historically for sunset-staging (15D); secret value unproven here |

## Remediation contract (design only)

Bounded next slice: **FORTRESS-15L** / `15L_meta_signature_fail_closed` — fail-closed Meta POST (missing secret + missing header), remove hardcoded GET default under staging/production profiles, wire `META_APP_SECRET` / verify token in Bicep secretRefs. **Not implemented in 15K.**

B12 residual skip footgun is optional follow-up — not the 15L outcome.

## Artifacts

| Path | Role |
|------|------|
| `slice15k-contract.json` | Slice contract |
| `slice15k-b01-b12-audit-overlay.json` | Overlay (preserves 15A) |
| `slice15k-consumer-matrix.json` | Control/config consumer inventory |
| `slice15k-attack-cases.json` | RED/GREEN cases |
| `slice15k-b01-remediation-contract.json` | Design-only remediation |
| `slice15k-findings.md` | This findings doc |
| `slice15k-evidence.json` | Committed verifier evidence |
| `scripts/verify-fortress-slice15k-signature-control-audit.js` | Deterministic read-only verifier |

## Gates

- `npm run verify:fortress-slice15k-signature-control-audit`
- `npm run verify:fortress-tenant-identity-boundary-matrix`
- Meta / Stripe / staff-auth / multiclient / migration / `git diff --check`

## Must not

- Rewrite 15A historical B01/B12 verdicts
- Read live secrets / call Azure / deploy / edit runtime
- Implement 15L in this slice
