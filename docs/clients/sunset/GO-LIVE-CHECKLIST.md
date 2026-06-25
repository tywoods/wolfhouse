# Sunset — Go-Live Checklist

Client: `sunset` · Locations: `sunset-somo` (Sunset), `sunset-sardinero` (**elSardi**)
Flip `live_enabled: true` for `sunset` in `config/clients/clients.json` **only**
after every box below is checked. See `docs/MULTICLIENT-ARCHITECTURE.md`.

## 1. Live database
- [ ] `sunset_prod` Postgres provisioned, isolated, reachable from the Sunset prod runtime only.
- [ ] Schema/migrations applied (forward-only, reversible).
- [ ] Both locations represented and correctly tagged by `location_id`.

## 2. Channel identifiers (per location, one client)
- [ ] WhatsApp number(s) provisioned; Meta `phone_number_id`(s) route inbound to the Sunset prod Hermes webhook.
- [ ] Location resolution correct: messages map to `sunset-somo` vs `sunset-sardinero` as intended.
- [ ] Email inbox(es) for Sunset route to the Sunset runtime.

## 3. Admin location switch
- [ ] Staff portal location switcher toggles `sunset-somo` ↔ `sunset-sardinero` cleanly.
- [ ] Each location's config (schedule, courses, prices) loads for the selected location only.
- [ ] "Sunset" and "elSardi" display names render correctly (elSardi exactly, no underscores).

## 4. Lesson capacity per location
- [ ] Daily lesson capacity set for `sunset-somo`.
- [ ] Daily lesson capacity set for `sunset-sardinero`.
- [ ] Capacity is enforced independently per location.

## 5. Price owner confirmation
- [ ] Course/pack prices confirmed by the owner for each location.
- [ ] Rental prices confirmed; durations ordered shortest→longest.
- [ ] No leftover test/placeholder prices.

## 6. Inbox split
- [ ] Conversations are scoped per client; Sunset staff see only Sunset inbox.
- [ ] Location filtering in the inbox works (Somo vs elSardi).

## 7. No Wolfhouse data visible
- [ ] Sunset runtime/DB contains no Wolfhouse (or other-client) rows.
- [ ] Owner Insights / Ask-Luna return only Sunset data; queries scoped by `client_slug`.
- [ ] Staff access config lists only Sunset emails/numbers.

## 8. Luna / verifier gates
- [ ] `node scripts/verify-multiclient-isolation.js` passes.
- [ ] `node scripts/verify-sunset-luna-school-context.js` passes.
- [ ] `npm run verify:sunset-portal-v1` passes.
- [ ] `node scripts/verify-tenant-business-config.js` passes.

## 9. Test booking / payment flow
- [ ] End-to-end lesson/course booking + payment on each location.
- [ ] Sunset's own Stripe context used (no shared default); test charge verified.

## 10. Rollback path
- [ ] Previous known-good image tag recorded; rollback = repoint runtime to it.
- [ ] Documented revert: set `live_enabled=false` for `sunset`, restore prior tag.
- [ ] Prior healthy revision retained until the new one is verified.
