# Sunset Email Front Desk — Project Plan

**Owner of plan:** Captain. **Build lead:** Sea Dog (manages Deckhand). **Prior work:** Skipper.
**Status:** Slice 2 inbox bridge library landed offline (unwired); staging canary activation still open. **Last updated:** 2026-08-08.

This is the single reference for the Sunset email project. It reconciles Skipper's
"LIGHTHOUSE" plan and Deckhand's "reuse-first" plan against the **actual code on
`origin/master`**, and lays out the slices to ship.

---

## 1. Goal & guardrails

**Goal:** a safe, real email front desk for Sunset. Guests email the hostel; staff
see those emails in the **existing Inbox** next to WhatsApp, answer in **draft mode**
(compose/edit) and **live mode** (approve → send). "Connect your mailbox" is easy
(Microsoft sign-in). Luna drafting replies comes **last**.

**Scope discipline (from owner):**
- **Somo only** for the whole build. Sardinero is copied over at the very end.
- **Luna is wired in last** — after the staff-facing Inbox + draft/send loop is trusted.
- **Not overkill.** Reuse-first, thin vertical slices into the Inbox that already exists.
  No parallel "Email" app, no parallel message tables.
- **Draft + live** are both in scope; **no auto-send** before the send loop is proven.

**Non-negotiable guardrails on every slice:**
- **Tenant/location isolation** — `location_id` sticks to every conversation; never
  answer Sardinero mail in a Somo context.
- **Idempotent, exactly-once** on both ingest and send (crash/retry safe).
- **Secrets in Azure Key Vault only** (via `secret_ref`); never in Postgres product
  rows, never exposed to Luna, API responses, or logs.
- **Default-off + kill switches** (per-tenant and global) on every runtime path.
- **Email body is untrusted data, never instructions** (prompt-injection hardening) —
  matters once Luna reads mail.
- **No invented facts** — availability, prices, policies, booking confirmations,
  payment status/URLs come from the Staff API / DB only.

---

## 2. Ground truth — what is already built on `origin/master`

More is built than either source plan implies. This is Skipper's work.

### ANCHOR — identity & credentials (BUILT, default-off)
Microsoft **delegated OAuth** + encrypted grant custody, all as libraries + Sunset-staging
runtime compositions:
- Contracts: `email-connector-auth-mode-contract`, `email-channel-endpoint-identity-contract`,
  `email-microsoft-delegated-oauth-contract`, `email-grant-envelope-provider-contract`,
  `email-mailbox-adapter-contract`, `email-http-transport-contract`,
  `email-graph-app-only-readiness-contract`.
- Grants: `email-delegated-grant-custodian`, `-access-session`, `-read-health`,
  `-refresh-rotation`; KV envelope: `email-grant-envelope-azure-kv-provider`
  (+ `-sunset-staging-runtime-composition`), fake provider for tests.
- Microsoft: `email-microsoft-authorization-code-request`,
  `email-microsoft-delegated-{read,refresh,inbound}-...-runtime-composition`.
- Graph adapters: `email-microsoft-graph-adapter`,
  `-delegated-messages-transport`, `-immutableid-page-transport`,
  `-immutableid-bounded-catchup-transport`.

**Wired HTTP routes** (in `scripts/staff-query-api.js`, default-off):
- `staff-email-registry-routes` — locations/endpoints registry.
- `staff-email-settings-routes` — `GET /staff/admin/email-settings`.
- `staff-email-oauth-routes`:
  - `POST /staff/admin/email-settings/oauth/microsoft/start`
  - `POST /staff/admin/email-settings/oauth/microsoft/endpoint`
  - `.../oauth/microsoft/refresh-health`, `.../read-health`, `.../inbound-diagnostic`
- Admin UI started: `scripts/browser/sunset-admin-email-settings-ui.js`
  (Connect Microsoft button → the routes above).

### RADAR — reliable receive (BUILT, default-off; Skipper's active stage)
Durable delta ingest into email's **own** event store — not yet into the Inbox:
- Operations: `email-authority-bound-inbound-operation`,
  `-messages-delta-page-operation`, `-messages-delta-offline-composition`,
  `-bounded-catchup-offline-composition`.
- Stores: `email-inbound-event-store`, `email-inbound-delta-state-store`,
  `email-inbound-batch-processor`, `email-delta-recovery-operation-store`.
- Runtime + recovery: `email-delta-runtime-config`,
  `email-delta-sunset-staging-runtime-composition`,
  `email-delta-operator-recovery-{config,service}`,
  route: `staff-email-delta-operator-recovery-routes`
  (`.../delta/recovery/{status,restart-generation,reconcile}`).

### Migrations on master (email)
`057` tenant_locations_and_channel_endpoints · `058` channel_endpoint_identity ·
`059` email_delegated_grants · `060` email_oauth_transactions ·
`061` oauth_transaction_endpoint_binding · `062` channel_endpoint_secret_ref_nullable ·
`063` email_inbound_events · `064` email_inbound_delta_states ·
`065` email_delta_recovery_operations · `066` email_delta_page_commit_journal.

### Inbox
`scripts/staff-query-api.js` already understands `channel === 'email'` in conversation
list/needs-human/contact rendering — so the Inbox surface is partly ready to show email.

### Codename warning
The repo's `verify-radar-slice16*` scripts are **staff-API reliability hardening**
(readiness / Stripe claim / healthz / shutdown) — a *different* "RADAR" from Skipper's
email-receive stage. Don't conflate them.

---

## 3. The real gaps (what's NOT built)

1. **Bridge: `email_inbound_events` → `conversations`/`messages`.** The delta ingest
   writes to its own event store; nothing yet normalizes an inbound email into a
   channel-neutral `conversations`/`messages` row so it appears in the Inbox. *(No
   `INSERT INTO conversations/messages` exists in any `email-*.js`.)* **This is the
   money slice.**
2. **Activate ingest for one real Somo mailbox** (register endpoint, flip runtime
   flags on for a bounded canary).
3. **Outbound send.** No Graph `sendMail` transport, no email draft/approve/send
   composer, no exactly-once send journal, no send kill switch. *(Only contracts exist.)*
4. **Luna email brain.** Not built.

---

## 4. Execution — vertical slices (Somo only, Luna last)

Ship one slice at a time; each passes a **deployed** exit gate on Sunset staging before
the next. Parallel work only where file ownership doesn't overlap. Merges + deploys serial.

### Slice 1 — Connect email (Somo) — *mostly built; close it out*
- Verify the OAuth connect flow end-to-end on staging: `start` → Microsoft consent
  (Phase A read scope, e.g. `Mail.ReadBasic`) → `endpoint` binding → `read-health` green.
- Register the **real** sunset-somo `tenant_location` + `channel_endpoint` via the
  registry API (no invented addresses in git). Set `binding_status=verified`.
- Refresh-token stored in KV via `secret_ref`; `refresh-health` green.
- **No send scope yet.**
- **Exit gate:** staff open Email Settings, click Connect Microsoft for Somo, land on
  "Connected (read-only)", health checks pass on staging.

### Slice 2 — Mail appears in the Inbox (read-only) — *the core new build*
- Build the normalizer/bridge: inbound email (from `email-inbound-event-store` /
  Graph delta) → channel-neutral message → `INSERT` into `conversations`/`messages`
  with `channel='email'`, keyed by sender email + `client_id` + `location_id`
  (location must stick to the conversation).
  - **Offline owner landed:** `scripts/lib/email-inbound-inbox-bridge.js` + migration
    `067_tenant_email_inbound_inbox_projections` (exactly-once journal; tenant-consistent
    composite FKs; opaque `emailv1:` conversation identity; customer-sync skip;
    CASCADE deletion contract; fail-closed down). Gates:
    `verify:email-inbound-inbox-bridge`, `prove:email-inbound-inbox-bridge-pglite`.
    **Not** runtime-wired / not activated.
  - **Production WhatsApp send boundary (Staff Inbox path; bridge stays unwired):**
    `resolveAuthoritativeInboxSendTarget` on `POST /staff/inbox/send-reply` loads the
    owned conversation, rejects `channel=email` / `emailv1:` / `email:` before WhatsApp
    evaluation/audit/provider, and rejects forged caller `to`. Gate:
    `verify:staff-inbox-routes`.
- Turn the existing default-off delta ingest **on** for the single Somo mailbox
  (bounded canary; keep the kill switch and operator-recovery routes).
- Inbox UI: an **Email** channel pill alongside WhatsApp in the same Inbox — do not
  add a second tab. Reuse `staff-conversation-queries`, needs-human / pause patterns.
- Read-only first: **no auto-replies.**
- **Exit gate:** a real inbound Somo email shows as an Inbox thread with an Email badge
  and the correct location, on staging.

### Slice 3 — Staff can answer (draft + live)
- Upgrade consent to **Phase B** send scopes (separate outbound permission review).
- Email composer = same **Approve & Send** UX as WhatsApp; `draft_only` is the default
  (draft mode). Approve → send = live mode.
- Outbound send transport via Graph `sendMail` with: approved sender-mailbox
  enforcement, recipient + thread validation, a **durable exactly-once send journal**
  (survives retries/crashes, no duplicate sends), full audit trail, and a send **kill
  switch** (tenant + global).
- **Exit gate:** a staff-approved staging reply reaches a controlled test mailbox
  **exactly once**, stays in the correct thread, survives a forced-uncertainty retry
  test, and can be disabled immediately.

### Slice 4 — Luna speaks email (LAST)
- Luna email brain, same truth rules as WhatsApp (facts from tools/DB only), email
  tone/length. Email content treated as untrusted (prompt-injection hardening).
- Explicit handoff reasons (not low-confidence spam). **Draft-only first**; only later
  consider limited auto-send for boring deterministic templates, behind the kill switch.
- **Exit gate:** on a golden Sunset email corpus, Luna produces correct, grounded
  drafts and hands off uncertain identity/intent instead of guessing.

### Then — Sardinero
- Copy the Somo endpoint config for `sunset-sardinero` (second `channel_endpoint`),
  reconnect/health UX. Two beaches must never cross contexts.

---

## 5. Explicitly dropped as v1 overkill (defer to prod hardening)

From Skipper's LIGHTHOUSE, **not** required to ship staff-usable email:
- The 8 formal "deployed stage gates" as a product denominator.
- Seven-consecutive-day canary **per stage**.
- AUTOPILOT autonomy cohort / shadow-decision analysis.
- Full SLO / cost-ceiling / incident-runbook apparatus.

These are real, but they belong to the **production canary** conversation (Wolfhouse
prod is untouched here), not to getting Sunset staff answering email. Keep the *safety
mechanics* (idempotency, exactly-once, isolation, kill switches) — drop the *ceremony*.

---

## 6. Working conventions

- Sunset staging Staff API deploys from **`/opt/luna/Luna-Sunset`** on lunabox (shared
  `staff-query-api.js`), via `az acr build` + `containerapp update`. See the Sunset
  deploy runbooks.
- Run repo preflights before any build/deploy; tag images with the master SHA.
- Every slice: reviewed + merged → migration applied → exact image on Sunset staging →
  real deployed behavior exercised → isolation + failure/recovery proven → kill switch
  proven → verify script committed.
- Report each slice gate back to Captain: what merged, what deployed, what was verified,
  any blocker.

---

## 7. Source plans (for reference)
- Skipper "LIGHTHOUSE" (8-stage: ANCHOR→RADAR→COMPASS→QUARTERMASTER→COPILOT→GUARDIAN→
  AUTOPILOT→LIGHTHOUSE) — rigorous; we keep its safety spine, drop its ceremony.
- Deckhand "reuse-first" (Chapters A–E into the existing Inbox) — this plan's shape.
