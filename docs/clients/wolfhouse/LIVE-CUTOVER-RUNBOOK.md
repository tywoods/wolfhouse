# Wolfhouse — Live Cutover Runbook

Client: `wolfhouse` · Location: `wolfhouse-somo`

> Step-by-step procedure to bring Wolfhouse live. **Do not run any step from a
> docs/readiness branch.** Every live action requires the named approval gate.
> Companion docs: `GO-LIVE-CHECKLIST.md`, `LIVE-ENV-INVENTORY.md`,
> `LIVE-ROLLBACK-RUNBOOK.md`, `docs/MULTICLIENT-ARCHITECTURE.md`.

Architecture assumptions: separate runtime/env/secrets/database per client,
shared code/image. **No dirty-tree deploys. No live Meta webhook change without
explicit approval. No live Stripe action without explicit approval.**

---

## 0. Preflight checks

- [ ] Operator + approver identified and available for the cutover window.
- [ ] `LIVE-ENV-INVENTORY.md` fully provisioned: all Key Vault secret *names*
      exist and hold real values; DB, runtimes, hostnames, DNS, TLS ready.
- [ ] `config/clients/clients.json`: `wolfhouse` present, `wolfhouse-somo`
      present, `live_enabled` still **false** (flipped only after success).
- [ ] Git tree is **clean** and on the exact commit to be released.
- [ ] `node scripts/assert-repo-sync.js` passes (local == origin, no drift).
- [ ] Rollback runbook reviewed; previous known-good image tag recorded.

## 1. Required verifiers (all must pass)

Run on the release commit; **stop if any fail**:

- [ ] `node scripts/verify-multiclient-isolation.js`
- [ ] `node scripts/verify-wolfhouse-live-readiness-static.js`
- [ ] `npm run verify:luna-all`
- [ ] `npm run verify:luna-golden` (note any *pre-existing* failure explicitly)

## 2. Build from clean git SHA only

- [ ] Capture the release SHA: `git rev-parse HEAD` (must match `origin/master`).
- [ ] Build the image from that committed SHA (no local uncommitted changes):
      `az acr build --registry whstagingacr --image wh-staff-api:<sha> .`
      (and the Hermes image as applicable). **Never** build from a dirty tree;
      **never** use `--no-cache` (it silently fails the build).
- [ ] Record the immutable image tag(s) built.

## 3. Deploy Staff API

- [ ] Deploy `wolfhouse-prod-staff-api` to the built image tag.
- [ ] Started with Wolfhouse prod env: `DEFAULT_CLIENT=wolfhouse-somo`, prod DB
      creds, prod access config, `LUNA_BOT_INTERNAL_TOKEN`.
- [ ] Keep the prior healthy revision available (do not delete it).

## 4. Deploy Hermes/Luna

- [ ] Deploy `wolfhouse-prod-hermes` to the matching image tag.
- [ ] Bound to the Wolfhouse prod Staff API base URL.
- [ ] Live persona/SOUL confirmed (no staging/test copy).

## 5. Confirm health

- [ ] Staff API `GET /` and key `GET /staff/*` return 200 on prod.
- [ ] Served portal JS parses clean (no in-page script error).
- [ ] Hermes/Luna agent reports healthy; bot tools reach the prod Staff API.
- [ ] Owner/staff WhatsApp recognition resolves against prod `staff_phone_access`.

## 6. Controlled WhatsApp smoke test (approved number only)

- [ ] **Approval gate:** approver confirms the smoke test may run.
- [ ] Use only a **pre-approved internal test number** — never a real guest.
- [ ] Send a scripted message; confirm Luna responds via the prod path.
- [ ] Verify availability → quote → hold flow end-to-end on the test number.
- [ ] **Stripe is in scope only with explicit approval** (see step 7); otherwise
      stop before any live charge.

## 7. Explicit approval gate — live Meta webhook change

> **Do not change the live Meta webhook without explicit approver sign-off.**

- [ ] Approver explicitly authorizes pointing the Wolfhouse Meta
      `phone_number_id` webhook to the prod Hermes webhook URL.
- [ ] (If payments in scope) approver explicitly authorizes the live Stripe
      context + a single small test charge + refund.
- [ ] Record who approved, when, and exactly what was changed.
- [ ] Flip `live_enabled: true` for `wolfhouse` in `config/clients/clients.json`
      only after the above succeed.

## 8. Post-cutover monitoring

- [ ] Watch logs, 5xx rate, and webhook delivery (Meta + Stripe) for the first
      30–60 min, then through the first real bookings.
- [ ] Confirm a real guest message routes correctly (`phone_number_id → wolfhouse`).
- [ ] Confirm a real booking + payment reflects in the portal and DB.
- [ ] Keep the prior revision + image tag retained until verified stable.

## 9. Stop-if conditions (abort + roll back)

Stop the cutover and execute `LIVE-ROLLBACK-RUNBOOK.md` if **any** occur:

- Any required verifier fails.
- Git tree is dirty or SHA ≠ `origin/master` at build time.
- Staff API or Hermes health check fails after deploy.
- WhatsApp smoke test does not get a correct Luna reply.
- Wrong-client data appears (any non-Wolfhouse rows visible).
- Stripe/Meta webhook errors or signature failures.
- Any unapproved live Meta or Stripe change would be required to proceed.
- Approver is unavailable when an approval gate is reached.
