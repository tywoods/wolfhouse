# Wolfhouse PROD Staff UI acceptance

Job: `CAP-PROD-BUILD-GO-20261028T1406`. Classic Staff portal only. No Crow's Nest.

## What this document covers

`node scripts/verify-wolfhouse-prod-staff-ui.js` proves the **composed Classic Staff portal** (rooms / prices / packages / rules chrome, empty operational lists, locale, cookie/origin host-only session, Wolfhouse identity) against **isolated fixtures** plus the committed staging catalog (not TEST bookings).

It does **not** prove Skip has landed an image, that DNS is live, or that `178.33.91.59` already serves Staff. Source checks are not deployed acceptance.

## Exclusive files

- `scripts/verify-wolfhouse-prod-staff-ui.js`
- `fixtures/wolfhouse-prod-ui/`
- `docs/prod/wolfhouse-staff-ui-acceptance.md`

Browser modules, Staff API, `package.json`, and migrations stay read-only. Escalate any real root fix with its owner file.

## Frozen contract

`fixtures/wolfhouse-prod-ui/frozen-config-contract.json` is a **draft** until Seadog sets `"frozen": true`. Final Host/SNI checks against `178.33.91.59` run only when that flag is true **and** `WH_PROD_UI_LIVE=1`.

Draft identity (not DNS):

| | |
|---|---|
| Client | `wolfhouse-somo` |
| Pre-DNS IPv4 | `178.33.91.59` (Host/SNI; no DNS mutation) |
| Prod hostname | `wolfhouse.lunafrontdesk.com` |
| Forbidden TEST origin | `staff-staging.lunafrontdesk.com` |
| Cookie | `luna_staff_session` (or `STAFF_SESSION_COOKIE_NAME`), `Path=/staff`, host-only, no `Domain=` |
| Stripe | TEST (`sk_live_` blocked in Staff API) |
| Caps | Luna 1536m, Staff 768m, PG 1024m; no swap; no prune |

## Positive / negative

**Positive (source/composed):** Wolfhouse Admin Pricing, Room Setup, packages/seasons from committed catalog, empty Bookings/Inbox/calendar shells, EN/ES/IT locale chrome, host-only session cookie.

**Negative:** no Crow's Nest chrome, no Sunset ACL as prod identity, no `staff-staging` cookie Domain, no TEST booking ids (`WH-202611…`) in fixtures, no DNS/nsupdate/`az network dns` in this verifier, no WhatsApp webhook or outbound send.

## Land / DNS

Skip lands accepted artifacts. Chief/Ty own DNS. This verifier never publishes DNS.

## Reviews

Seadog: UI/frozen contract. Captain: composed integration. Skip: land.
