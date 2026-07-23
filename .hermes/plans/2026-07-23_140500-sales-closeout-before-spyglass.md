# Crowsnest Sales Closeout Before Spyglass — Implementation Plan

> **For Hermes:** Execute sequentially with TDD and a review after each slice. Do not run Sales and Spyglass changes in the same branch or release.

**Goal:** Reach a stable stopping point for Sales: an operator can create/qualify/review a prospect and deliberately send one CRM-ready prospect to production HubSpot exactly once, with durable evidence and no automatic outreach.

**Architecture:** Keep the already-built pure approval contract and HubSpot v3 adapter separate from route/UI orchestration. The Sales domain assembles an eligible explicit command, persists a pending attempt keyed by review mark, invokes the adapter using a runtime-only Service Key, persists only sanitized outcome/provider IDs, and appends audit events. HubSpot is production-targeted, but each provider write remains an operator POST with no background worker.

**Tech stack:** Node server-rendered Crowsnest UI, native Node `fetch` injected into the adapter, PostgreSQL `luna_sales` schema, Azure Container Apps secret reference, HubSpot CRM v3 Companies/Contacts.

---

## Fixed boundaries

- No Deals, email/outreach sending, workflows, webhooks, batch sync, backfill, or retries in a loop.
- Never store or display the HubSpot Service Key, raw request/response payloads, emails, phone numbers, or arbitrary JSON in sync records/audit/UI.
- A HubSpot write requires an authenticated operator, explicit POST command, qualified prospect, and matching CRM-review mark.
- Repeat action for the same prospect + review mark must return the durable prior attempt or safely block; it must not create a duplicate Company.
- Do not weaken the Crowsnest Sales DB role. Structural migrations run only through the table-owner path.
- Sales stops after Slice 2. The next branch/workstream is Spyglass only.

## Current verified starting point

- Live migration `043_luna_sales_research_evidence.sql` was applied by `whadmin`; `research_jobs.source_url` and `confidence` now exist.
- Live UI create confirmation is still outstanding because no authenticated browser session was available.
- Local branch `feat/crowsnest-hubspot-approved-sync` has uncommitted, verified slices:
  - pure approval/idempotency contract + HubSpot adapter;
  - un-applied `049_luna_sales_approved_crm_sync_attempts.sql` + repository primitives.
- Current remote baseline is `origin/master` at `1ad6ef98`; the HubSpot branch must be rebased before release.
- Production HubSpot has a Service Key and must have Company properties `crowsnest_sales_prospect_id` (unique text) and `luna_sales_status` (dropdown option `Qualified Prospect`).

---

# Slice 1 — Finish the Sales release candidate in code

**Outcome:** A fully tested but not yet deployed Sales flow exposes an explicit `Send to HubSpot` action only for eligible prospects and persists/audits safe results. This slice contains no live HubSpot request.

### Task 1: Prove the repaired live intake path

**Files:** no code changes.

1. Sign in to the live Crowsnest portal as an existing operator.
2. Create one deliberately named real test prospect via **Sales → Add prospect**.
3. Open its detail page and confirm it can be read back.
4. Record only success/failure code and booking-free test prospect ID/name; do not read credentials or secrets.

**Pass condition:** no `sales_unavailable`. If this fails, stop Slice 1 and reopen durable-store diagnosis.

### Task 2: Rebase the isolated HubSpot work on current master

**Files:** all current uncommitted HubSpot files only, as required by conflict resolution.

1. Create a temporary safety patch or local commit only after `git diff --check` and focused tests are green.
2. `git fetch origin` and rebase `feat/crowsnest-hubspot-approved-sync` onto `origin/master` (`1ad6ef98` or newer fetched master).
3. Resolve only mechanically necessary conflicts; preserve the newer master behavior in unrelated Messi/Spyglass/Foundation areas.
4. Run existing new focused suites before making integration edits:
   ```bash
   npm run verify:crowsnest-sales-approved-crm-sync
   npm run verify:crowsnest-sales-approved-crm-sync-attempts
   npm run verify:migration-integrity
   npm run verify:crowsnest
   npm run verify:crowsnest-auth
   ```

**Pass condition:** rebased branch has the exact previous contracts green and no unrelated behavioral diff.

### Task 3: Add RED route/domain integration tests

**Files:**
- Modify: `scripts/verify-crowsnest-sales-approved-crm-sync.js`
- Modify: `scripts/verify-crowsnest-sales-approved-crm-sync-attempts.js`
- Modify/create only if needed: `scripts/verify-crowsnest-sales.js`
- Modify: `scripts/verify-crowsnest-auth.js`

1. Add deterministic tests that initially fail for:
   - unauthenticated sync POST redirects/rejects safely;
   - ineligible prospect/mark cannot invoke adapter;
   - eligible explicit POST creates a `pending` attempt before adapter invocation;
   - existing idempotency key cannot invoke HubSpot a second time;
   - adapter success records only Company/Contact IDs and `succeeded` outcome;
   - adapter failure records only sanitized category and `failed` outcome;
   - no raw provider data or Service Key appears in output/audit/HTML;
   - UI has no sync control for ineligible prospects and has an accurately labelled explicit control for eligible ones.
2. Run the focused commands and capture expected RED failures.

**Pass condition:** failures name missing orchestration/UI only, not weakened old contracts.

### Task 4: Add the minimal Sales orchestration

**Files:**
- Modify: `scripts/lib/crowsnest/crowsnest-sales.js`
- Modify: `scripts/crowsnest-api.js`
- Modify: `scripts/lib/crowsnest/crowsnest-page.js`
- Modify: `scripts/lib/crowsnest/crowsnest-sales-store.js` only for already-designed attempt/audit primitives
- Reuse: `scripts/lib/crowsnest/crowsnest-sales-approved-crm-sync-contract.js`
- Reuse: `scripts/lib/crowsnest/crowsnest-sales-hubspot-v3-adapter.js`

1. Add one narrow domain operation that receives an explicit operator command, the prospect/review data, an injected repository, and an injected adapter/runtime dependency.
2. Persist pending attempt first; handle unique-key replay by returning the existing durable attempt without provider call.
3. Invoke adapter once only for a new pending attempt.
4. Persist sanitized success/failure outcome and append existing audit event conventions without raw provider material.
5. Add one authenticated, exact allowlisted POST route for the chosen prospect/review mark; do not add broad generic mutation routes.
6. Render an explicit form/button only when eligible, with clear copy: **Send to HubSpot** and **This creates/updates a Company and optional Contacts. It does not send outreach.**
7. Render safe attempt status/retry guidance; do not claim success until confirmed IDs exist.

**Pass condition:** every Task 3 test turns green, old CRM preview remains preview-only, and no automatic behavior exists.

### Task 5: Add runtime configuration as an injected boundary

**Files:**
- Modify: `scripts/crowsnest-api.js` or a new narrowly named runtime-config helper under `scripts/lib/crowsnest/`
- Modify: focused verifiers only
- Do not modify: adapter to read global environment directly.

1. Add a single server-only configuration boundary that reads `HUBSPOT_SERVICE_KEY` only at request execution time.
2. Keep the adapter transport/token injected; do not export credentials or include them in error paths.
3. If absent/misconfigured, leave the action unavailable or return a safe configuration error without creating a provider request.
4. Add deterministic tests for configured/unconfigured behavior and token non-leakage.

**Pass condition:** no token reference reaches page renderer, store, audit, test output, or client-visible response.

### Task 6: Full release-candidate verification and review

1. Run all focused Sales/HubSpot/migration gates plus:
   ```bash
   npm run verify:crowsnest
   npm run verify:crowsnest-auth
   node --check scripts/crowsnest-api.js
   node --check scripts/lib/crowsnest/crowsnest-sales.js
   node --check scripts/lib/crowsnest/crowsnest-sales-store.js
   git diff --check
   ```
2. Start a local authenticated smoke server using existing safe test credentials/configuration only; use injected fixture transport, never live HubSpot.
3. Verify locally: ineligible UI has no button; eligible approved prospect shows button; submit success/failure fixtures; repeated submission remains idempotent.
4. Commit only the reviewed Sales files on the dedicated branch with a focused commit message.

**Slice 1 stop condition:** branch is committed, rebased, fully green, and ready for review. It is still not merged, not deployed, and has made no live HubSpot call.

---

# Slice 2 — Controlled production release, one smoke sync, then stop Sales

**Outcome:** Merge/deploy the reviewed release, apply only migration 049 with the DB owner, configure the Service Key server-side, and perform exactly one consciously selected production smoke sync.

### Task 1: Pre-release checks and PR review

**Files:** no code changes unless review finds a defect.

1. Re-run `node scripts/assert-repo-sync.js` from the release checkout; use the documented VM-skip flag only if the runner cannot access the VM and this is documented in the release note.
2. Create/push a PR from `feat/crowsnest-hubspot-approved-sync` to current `master`.
3. Review diff for prohibited material: any literal Service Key, token, DSN, raw payload, Deal endpoint, email send endpoint, background scheduler, or unrelated Spyglass/Messi edits blocks release.
4. Verify the branch is clean and rebased immediately before merge.

**Pass condition:** focused PR contains only Sales/HubSpot contract, persistence, route/UI, migration 049, docs, and tests.

### Task 2: Apply migration 049 as table owner

**Files:** use the committed `database/migrations/049_luna_sales_approved_crm_sync_attempts.sql`; do not edit it in production.

1. Use the owner-capable `whadmin` database path, not `CROWSNEST_SALES_DATABASE_URL`.
2. First read-only verify 049 is absent and confirm the current table owner.
3. Apply exactly migration 049 in one transaction; do not apply unrelated 044–048 or modify migration ledger history.
4. Verify table, unique idempotency constraint, indexes, and unchanged existing prospect count.
5. Verify runtime Sales role has only the required `SELECT`, `INSERT`, and `UPDATE` on this new table. If missing, grant only those privileges via the table owner and record the exact grant; no DDL privilege for app runtime.

**Pass condition:** migration/permissions are proven without secret exposure.

### Task 3: Configure the Service Key as a runtime-only secret

**Files:** Azure Container App secret/config only; no repository secret file.

1. Add the already-created HubSpot Service Key to `crowsnest-internal` as secret `hubspot-service-key`.
2. Bind it only to runtime environment variable `HUBSPOT_SERVICE_KEY` for the Crowsnest container.
3. Do not print the key, use a browser, put it in GitHub Actions, or place it in a developer `.env` file.
4. Confirm only secret name and env binding name, not value.

**Pass condition:** revised container starts healthy and logs do not reveal the secret.

### Task 4: Deploy and verify the new revision

1. From clean current `master`, run `node scripts/assert-deploy-from-master.js`.
2. Build the Crowsnest image tagged with the merged `master` SHA.
3. Update only `crowsnest-internal` to that image; do not touch Staff API or other services.
4. Verify a new ready revision receives intended traffic, `/healthz` stays healthy, and auth redirects to `/login` unauthenticated.
5. Sign in as an operator and verify the Sales lifecycle/review pages render and that no Service Key content appears anywhere.

**Pass condition:** new revision/image/traffic and normal Sales health are evidenced.

### Task 5: One deliberate production HubSpot smoke sync

1. Select one deliberately named, non-customer test prospect in Sales.
2. Add manual research, mark it Qualified, and add CRM review mark using the normal UI.
3. Inspect CRM Preview against the agreed Company mapping and Contacts; confirm expected `crowsnest_sales_prospect_id` / `luna_sales_status` values before clicking.
4. As a named authenticated operator, click **Send to HubSpot** once.
5. Confirm in both systems:
   - exactly one HubSpot Company exists and holds the correlation property;
   - optional Contacts are associated only if deliberately present;
   - Crowsnest attempt is `succeeded` with safe provider IDs;
   - audit trail has safe attempt/outcome records;
   - no Deal, email, workflow, or second automatic request occurred.
6. Click again only if the UI is designed to show prior attempt; prove it does not create a duplicate provider Company.

**Pass condition:** one controlled production Company/Contact sync is successful and idempotent.

### Task 6: Sales closeout handoff

1. Record the released master SHA, Container App revision, migration 049 confirmation, secret binding name, and smoke-test result — never values/secrets.
2. Mark the Sales/HuSpot release tasks completed.
3. Do not add Sales features after this point without a new scoped decision.
4. Start Spyglass in a fresh branch/worktree based on the released current `origin/master`.

**Final Sales stop condition:** prospect intake, lifecycle, CRM preview, human-approved HubSpot Company/Contact sync, audit, and idempotency are live and evidenced. Sales is then frozen for this phase; next work is Spyglass.

---

## Risks and decisions

- **Production portal:** approved by Earthling. Smoke only with a clearly named test prospect and an explicit operator click.
- **HubSpot properties:** before release, confirm the internal names exactly match `crowsnest_sales_prospect_id` and `luna_sales_status`; unknown properties cause a safe HubSpot validation failure, not a fallback mapping.
- **Sales store:** schema repair is done, but live UI test remains the first gate. Do not apply migration 049 or deploy HubSpot work until it passes.
- **Current master drift:** rebase immediately before merge; do not drag the separate unmerged AI-usage branch into this release.
