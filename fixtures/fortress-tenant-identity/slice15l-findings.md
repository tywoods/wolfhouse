# FORTRESS Slice 15L — Meta WhatsApp signature fail-closed (B01 remediation)

**Status:** implemented (source + IaC + offline verifier; no live Meta/Azure/KV/deploy)
**Master basis:** `f703f3e07d3cd9214c661f169c23c7d5d5370709`
**Design freeze:** `fixtures/fortress-tenant-identity/slice15k-b01-remediation-contract.json`
**Branch:** `fortress/slice-15l-meta-signature-fail-closed`
**Boundary:** `B01_meta_whatsapp_signature_ingress`
**Outcome:** `15L_meta_signature_fail_closed`

## Outcome

Meta WhatsApp hub **POST** rejects before JSON parse / `processMetaWhatsAppWebhookPostEntry` / PG when `META_APP_SECRET` is missing, `X-Hub-Signature-256` is missing/malformed, or HMAC mismatches. Valid raw-body HMAC proceeds to PostEntry (B02 authority remains default-off). Hub **GET** has no hardcoded verify-token default and fails closed when `META_WHATSAPP_VERIFY_TOKEN` is absent or mismatched. Staging/sunset Staff API Bicep declare Key Vault secretRefs for `meta-app-secret` / `meta-whatsapp-verify-token` and pin `META_WEBHOOK_SKIP_VERIFY=false`.

Runtime profile classification is fail-closed across **both** `NODE_ENV` and `STAFF_RUNTIME_PROFILE`: if either signal is staging/production, Meta secrets are required and skip is refused; contradictory signals (including weaker preview/ci/local against staging/prod or against each other) refuse startup; unknown profiles remain fail-closed for skip; explicit local/test requires consistent signals. External HTTP failure bodies use frozen generic status semantics (`signature_verification_unavailable` / `signature_verification_failed` / `hub_verify_failed`); detailed reason codes stay on helpers + audit only.

## Guarded routes

| Method | Path | Control |
|--------|------|---------|
| GET | `/staff/meta/whatsapp/webhook` | `verifyMetaHubChallenge` — env token only |
| POST | `/staff/meta/whatsapp/webhook` | `readBodyRaw` → `verifyMetaHubSignature256` → `decideMetaWhatsAppWebhookPostAdmit` → reject or PostEntry |

## Config / IaC

| Artifact | Change |
|----------|--------|
| `scripts/lib/meta-whatsapp-signature-config.js` | Startup + admit decision |
| `scripts/lib/luna-meta-whatsapp-webhook.js` | Fail-closed helper; no default token |
| `scripts/staff-query-api.js` | Gate + startup apply |
| `infra/azure/staging/main.bicep` | Staff API secretRefs + skip=false |
| `infra/azure/sunset-staging/main.bicep` | Staff API secretRefs + skip=false |
| `infra/.env.example` | Meta placeholders (no secret values) |

## Historical artifacts unchanged

- **15A** matrix/doc: B01 remains `unproven`
- **15K** overlay/evidence/consumer matrix/attack-cases/design remediation contract: remain the vulnerable reaudit + design-only snapshot
- B02 default-off authority, B12 Stripe, n8n owners, Hermes sample token: untouched

## Activation gap

Code/IaC ready; live close still needs operator KV secret creation + Staff API deploy/revision so secretRefs mount. This slice performs **no** deploy, secret write, cloud, DB, or live Meta calls.

## Residual risk

- Until KV secrets exist and a revision mounts them, staging/sunset containers that pick up this image will refuse startup (intentional fail-closed)
- `META_WEBHOOK_SKIP_VERIFY=true` remains available for explicit local/test only
- Live secret **values** and Meta dashboard registration remain unproven offline

## Gates

- `npm run verify:fortress-slice15l-meta-signature-fail-closed`
- `npm run verify:fortress-slice15k-signature-control-audit`
- Meta / staff-auth / multiclient / migration / sunset Bicep preflight / `git diff --check`
