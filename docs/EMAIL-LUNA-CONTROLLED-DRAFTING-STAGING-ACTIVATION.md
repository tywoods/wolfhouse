# Email Luna controlled-drafting Sunset staging activation (Chapter 4A)

**Slice:** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A — source and deployment preflight

**Owner:** `scripts/lib/email-luna-controlled-drafting-sunset-staging-runtime-activation.js`

**Connections:** `scripts/lib/email-luna-controlled-drafting-principal-connection.js` (thin pair over Stage 1 `email-luna-automation-shadow-worker-connection.js`)

**Preflight:** `scripts/lib/email-luna-controlled-drafting-runtime-preflight.js`

**Session proof:** Chapter 3 `inspectEmailLunaControlledDraftingMappedPrincipal` plus canonical `schema_migration_ledger` / `current_database()='sunset_staging'`

**Staging test authorization:** `098_tenant_email_luna_controlled_drafting_staging_test_authorization.sql`

**Operator prepare:** `npm run prepare:email-luna-controlled-drafting-staging-test-authorization` (default dry-run). Operator-selected existing Sunset issuance; no server synthetic evidence. `--apply` requires `--recipient-address` matching the server-read issuance recipient.

**Verifier:** `npm run verify:email-luna-controlled-drafting-staging-activation`

**Stock PostgreSQL proof:** `npm run prove:email-luna-controlled-drafting-staging-activation-stock-pg` (SKIPs honestly when embedded PostgreSQL is unavailable)

This chapter wires the Chapter 3 reserve/tick composition into the existing Sunset staging Staff API process. It is default-off, import/start inert, and does not deploy, apply migration 097, change Azure, consent OAuth, invoke Graph, create a mailbox draft, or send.

## Architecture

Canonical process owner is Staff API (`luna-sunset-staging-staff-api` in `luna-sunset-staging-rg`). Stage 1 NIGHTWATCH shadow runtime already uses this process for a long-running worker. Chapter 4A follows that owner: no second worker, no timer in request handlers, no new Azure process or resource.

| Owner | Role |
| --- | --- |
| Stage 1 issuance / queue / principals / shadow runtime | Authentic 092/086 material; shadow remains provider-inert |
| Chapter 1 closed provider | `attest` / `createReplyDraft` / `reconcileDraft` only |
| Chapter 2 operation store | Producer reserve, worker claim/record/reconcile/load |
| Chapter 3 composition | Mapped producer/worker loaners + closed provider |
| Chapter 4A activation | Staff API start/stop loop, 097+098/LOGIN preflight, durable test authorization, status |

Producer and worker are dedicated PostgreSQL LOGIN roles. 092/097 authorize from `session_user`. Owner+`SET ROLE` is refused. Pre-connect DSN distinctness is not live session proof.

## Exact future target (not deployed by this slice)

| Item | Value |
| --- | --- |
| Resource group | `luna-sunset-staging-rg` |
| Container App | `luna-sunset-staging-staff-api` |
| Database | `sunset_staging` on `luna-sunset-staging-pg-app` |
| Tenant | `sunset` |
| Location | `sunset-somo` |
| Provider | `microsoft_graph` |
| Test mailbox | operator-controlled Sunset Somo test mailbox (identity in Key Vault / env; never commit the address) |

## Flags (all default off; exact string `true` only)

| Flag | Meaning |
| --- | --- |
| `EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED` | Start the Staff API loop |
| `EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED` | Chapter 3 composition |
| `EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED` | Reserve from authentic issuance |
| `EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED` | Claim/reconcile reserved operations |
| `EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED` | Invoke Chapter 1 Graph create/reconcile |
| `EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT` | Must be exact `1` |
| `LUNA_AUTO_SEND_ENABLED` | Hard-refuse if truthy |
| `CUSTOMER_OUTREACH_WHATSAPP_ENABLED` | Hard-refuse if truthy |
| `STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED` | Hard-refuse if truthy |

Near-miss / `TRUE` / `1` / unknown refuse. Wolfhouse, production, wildcard, and request-selected bindings refuse.

Controlled test scope is required before any queue work is consumed. Env may name the opaque authorization id; it does not confer authority. Preflight loads the durable 098 marker and exact binding.

- `EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_AUTHORIZATION_ID` (opaque id of a 098 row)
- `EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID`
- `EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_ISSUANCE_ID`
- `EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS` (must match the server-owned authorization)

Prepare with `npm run prepare:email-luna-controlled-drafting-staging-test-authorization` (default dry-run, refuses production, does not fabricate issuance). The command reads an operator-selected existing Sunset 092 issuance / 063 inbound. Dry-run JSON prints the server-read `recipient_address` and inbound `sender_address_normalized`, with `server_synthetic_evidence: false` and `authority: "queue_table_owner_session"`. Operator must inspect those values. `--apply` requires explicit `--recipient-address` equal to the server-read issuance recipient (ASCII lowercase+trim); the inbound sender is not a substitute. Missing or mismatched `--apply` performs zero 098 authorize SQL. Migration 098 authorization is queue-table-owner intent bound durably to that existing issuance — not send authority, not a fabricated row. Do not use manual SQL as the documented path.

Example (dry-run, then confirm recipient):

```
npm run prepare:email-luna-controlled-drafting-staging-test-authorization -- \
  --operation-id <uuid> --issuance-id <uuid>

npm run prepare:email-luna-controlled-drafting-staging-test-authorization -- \
  --operation-id <uuid> --issuance-id <uuid> \
  --recipient-address <server-read-issuance-recipient> --apply
```

Existing real guest 092 rows without a matching authorized 098 marker fail before reserve/tick/provider. Arbitrary existing eligible 086 rows are not scanned.

## Direct LOGIN secret refs (create later; not in this slice)

Existing app secret stays `sunset-database-url` → `WOLFHOUSE_DATABASE_URL`.

Future Key Vault names (existing vault `luna-sunset-staging-kv`, no new vault):

- `sunset-controlled-drafting-producer-database-url` → `EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL`
- `sunset-controlled-drafting-worker-database-url` → `EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL`

DSNs must have no query string (no `options` / `session_authorization` / SET ROLE overlay / sslmode escape). Database pathname must be exactly `sunset_staging`. Producer, worker, and app-owner identities must be pairwise distinct. TLS for Azure Flexible Server is `pg.Pool` `ssl: { rejectUnauthorized: true, ca, servername }` with bounded `connectionTimeoutMillis`. Missing CA fails preflight with `pg_ca_unproven`; loopback stock-PG is cleartext. Never `rejectUnauthorized: false`.

## Migration / principal readiness

- Canonical forward: `097_tenant_email_luna_controlled_draft_operations` then `098_tenant_email_luna_controlled_drafting_staging_test_authorization` (checksum `canonical_lf_v1`).
- Down files stay intact (ACCESS EXCLUSIVE; refuse while rows exist).
- 097/098 do not GRANT or CREATE ROLE.
- Apply 097 then 098 with the canonical runner on the operator laptop. Provision exact mapped producer+worker LOGINs with the existing principal provisioner:
  - worker: `allowSunsetStagingTrustedPrecreated`
  - producer: `allowSunsetStagingTrustedPrecreatedProducer`
  Both require `trustedPrecreated: true`, `apply: true`, owner session, no password, no CREATE ROLE. Option/kind swaps are refused.
- Prepare one 098 authorization through the operator command above after inspecting the server-read issuance recipient. Do not use manual SQL as the documented path.
- Code startup never applies migration. Preflight proves `current_database()='sunset_staging'` and exact ledger checksum/mode for 097 and 098.

## Live provider authority (blocked unless a later reviewed loan exists)

Sunset staff outbound already uses Phase B delegated grants (`User.Read Mail.ReadWrite Mail.Send`) through the Gate 3 send-capable reply-draft transport. Chapter 1 residual: an already-consented grant may still contain `Mail.Send`. Chapter 4A will not:

- mutate Phase A / Phase B consent
- request `Mail.Send`
- reuse Gate 3 send/sendMail/journal
- call Graph from `/healthz` or `/readyz`

Live provider-draft remains a separate exact gate. Chapter 4C owns the closed `Mail.ReadWrite` Graph-bound draft provider (`docs/EMAIL-LUNA-CONTROLLED-DRAFTING-TOKEN-LOAN.md`). Missing that closed Graph provider, or any send-capable adapter, yields `live_provider_block_reason=no_controlled_drafting_v1_token_loan` (or `send_like_capability_rejected`). Static attestation is `configured_contract_only` and does not imply grant/JWKS readiness. Offline preflight is separate from the later controlled live mailbox proof.

## Azure cost

Expected incremental Azure resource cost is **zero**. Reuse `luna-sunset-staging-staff-api`, `luna-sunset-staging-pg-app` / `sunset_staging`, and `luna-sunset-staging-kv`. Later operator work adds two LOGIN roles and two Key Vault secret names on existing resources — not a new Container App, Postgres server, Key Vault, or replica.

## Activation order (after source exact-head review and merge; orchestrator-controlled)

1. On the **operator laptop**, `node scripts/assert-repo-sync.js` (mandatory; **cannot pass in this cloud environment** — that is an environment limit, not a sync problem).
2. `npm run deploy:preflight` / `node scripts/assert-deploy-from-master.js` and tag the image with the master SHA.
3. Apply canonical migrations including 097 and 098 to `sunset_staging`. Capture ledger id/checksum/mode for both.
4. Provision exact producer+worker LOGINs through the trusted-precreated options above; store DSNs in Key Vault secret refs only.
5. Bind exact Sunset client/location/endpoint/mailbox ids. Set all drafting flags **false**. Replica count `1`.
6. Deploy the Staff API revision (still default-off). Confirm `/healthz` liveness and `/readyz` without Graph.
7. Run operator preflight against the dedicated LOGIN pair. Confirm `ok` with `activation_started=false`, `send_allowed=false`.
8. Enable runtime + composition only. Confirm status: enabled/configured/ready/running, no provider calls.
9. Prepare one-shot 098 authorization with the operator command (dry-run first). Inspect the server-read issuance recipient and inbound sender (`server_synthetic_evidence` is false). Then `--apply --recipient-address <exact-issuance-recipient>`. This is queue-table-owner intent bound durably to the existing issuance; it is not send authority. Enable producer intake, then worker tick, then live provider-draft **only** after the later live-proof review.
10. Capture DB operation state + Graph draft id (`isDraft=true`) for the test mailbox. Confirm send journal unused.

## Rollback / kill

1. Set `EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED` off (no new Graph create).
2. Set producer intake and worker tick off.
3. Set `EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED` off and restart Staff API, or scale as today.
4. `LUNA_AUTO_SEND_ENABLED` and campaign/outreach flags stay false.
5. 097 down remains refuse-if-rows-exist; do not drop evidence.

## Expected status / evidence (safe)

Status fields: `enabled`, `configured`, `ready`, `running`, `paused`, schema `097_tenant_email_luna_controlled_draft_operations`, principal `mapped_direct_login`, circuit, counts by safe state. Never subject, body, recipient, token, header, provider payload, or secret. No raw JSON dump in staff UI. Chapter 4A exposes `getStatus()` on the process runtime; it does not add a staff UI panel.

DB evidence to capture later: operation_id, issuance_id, state, create_dispatch_claimed, provider_draft_id, is_draft, state_generation. Provider evidence: Graph draft `id` + `isDraft=true` on the operator test mailbox. Never send.

## Repo-sync preflight

`node scripts/assert-repo-sync.js` reaches Lunabox over SSH. It exits 1 with `Could not read Lunabox repo` from this cloud environment. That remains mandatory on the operator laptop before any deployment.
