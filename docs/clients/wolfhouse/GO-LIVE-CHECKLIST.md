# Wolfhouse — Go-Live Checklist

Client: `wolfhouse` · Location: `wolfhouse-somo` (Wolfhouse Somo)
Flip `live_enabled: true` for `wolfhouse` in `config/clients/clients.json` **only**
after every box below is checked. See `docs/MULTICLIENT-ARCHITECTURE.md`.

## 1. Live database
- [ ] `wolfhouse_prod` Postgres provisioned, isolated, reachable from the Wolfhouse prod runtime only.
- [ ] Schema/migrations applied to prod (forward-only, reversible).
- [ ] No Sunset / other-client rows present; queries scoped by `client_slug`.

## 2. Live Staff API
- [ ] `wolfhouse-prod-staff-api` running the current `master` image tag.
- [ ] Started with Wolfhouse prod env: `DEFAULT_CLIENT=wolfhouse-somo`, prod DB creds, prod access config.
- [ ] `staff-portal-access.json` lists the real Wolfhouse owner/admin emails (no test accounts).

## 3. Live Hermes / Luna
- [ ] Wolfhouse prod Hermes/Luna agent up, bound to the Wolfhouse Staff API prod base URL.
- [ ] SOUL/config is the intended live persona (no staging/test copy).
- [ ] `LUNA_BOT_INTERNAL_TOKEN` set for prod; bot tools reach the prod Staff API.

## 4. Live WhatsApp number / phone_number_id
- [ ] Real Wolfhouse WhatsApp number provisioned (Meta Cloud API).
- [ ] Meta `phone_number_id` routes inbound to the Wolfhouse prod Hermes webhook.
- [ ] `phone_number_id → client_slug=wolfhouse` mapping recorded (no shared-number guessing).

## 5. Live Stripe context
- [ ] Wolfhouse's own Stripe account/keys wired (not a shared default).
- [ ] Webhook endpoint + signing secret configured for the prod runtime.
- [ ] A real (small) test charge + refund verified end-to-end.

## 6. Staff API health
- [ ] `/` and key `/staff/*` endpoints return 200 on prod.
- [ ] Owner/staff WhatsApp recognition resolves against prod `staff_phone_access`.
- [ ] Served portal JS parses clean (no in-page script error).

## 7. Luna golden / verifier gates
- [ ] `verify:luna-all` (and the golden conversation gate) green on the deployed build.
- [ ] `node scripts/verify-multiclient-isolation.js` passes.
- [ ] No red verifier in CI for the release commit.

## 8. Test booking / payment flow
- [ ] End-to-end: guest WhatsApp → availability → quote → hold → payment link → paid.
- [ ] Add-on / catalog service flow priced + paid correctly.
- [ ] Confirmation message + staff portal reflect the booking.

## 9. Rollback path
- [ ] Previous known-good image tag recorded; rollback = repoint runtime to it.
- [ ] Prior healthy revision retained until the new one is verified.
- [ ] Documented revert: set `live_enabled=false` for `wolfhouse`, restore prior tag.
- [ ] On-call owner knows how to trigger rollback.
