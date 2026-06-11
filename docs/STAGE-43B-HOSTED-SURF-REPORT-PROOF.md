# Stage 43b — Hosted Surf Report Proof

Hosted staging proof for client-facing Somo surf report via `POST /staff/bot/guest-inbound-review-dry-run`.

## Deploy

| Field | Value |
|-------|-------|
| **Commit** | `0c74150` |
| **Image tag** | `0c74150-stage43b-surf-report-proof` |
| **Image** | `whstagingacr.azurecr.io/wh-staff-api:0c74150-stage43b-surf-report-proof` |
| **Revision** | `wh-staging-staff-api--stage43b-surf-report` |
| **Prior revision** | `wh-staging-staff-api--0000222` (`1d8a6d3-stage35b-messy-flow-proof`) |
| **healthz** | `200` |

## Gates (before / during / after)

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | unset |
| n8n workflow active | `false` |

## Stormglass / live API

| Check | Result |
|-------|--------|
| `healthz.stormglass.configured` | **true** (key present server-side; value never printed) |
| Guest path `used_live_api` | **false** (all proofs) |
| Guest path `used_fallback` | **true** (upstream unavailable/quota/timeout on hosted) |
| **Overall live API proof** | **PARTIAL** — routing + fallback verified; live forecast data not returned |

## Proof transcripts

### A — English
**Q:** How are the waves today?  
**Route:** `explain_surf_report` · `luna_reply_composer`  
**Reply:** I can't see the live surf report right this second, but Somo usually works with a nice range of conditions. The team can confirm the best window closer to the day 🌊

### B — Italian
**Q:** Come sono le onde oggi?  
**Route:** `explain_surf_report`  
**Reply:** In questo momento non riesco a vedere il report live, ma a Somo di solito ci si trova bene con tante condizioni diverse. Il team confermerà la finestra migliore più vicino al giorno 🌊

### C — Spanish
**Q:** Qué tal las olas hoy?  
**Route:** `explain_surf_report`  
**Reply:** Ahora mismo no puedo ver el reporte en vivo, pero en Somo suele haber buenas ventanas con muchas condiciones. El equipo confirmará el mejor momento más cerca del día 🌊

### D — German
**Q:** Wie sind die Wellen heute?  
**Route:** `explain_surf_report`  
**Reply:** Gerade kann ich den Live-Surfbericht nicht abrufen, aber in Somo gibt es meistens schöne Fenster bei vielen Bedingungen. Das Team bestätigt das beste Timing näher am Tag 🌊

### E — Mid-booking context
1. **July 1-5 for 1** → quote ready €180, dates/guest_count set  
2. **How are the waves today?** → surf fallback + addons tail; **check_in** 2026-07-01 · **check_out** 2026-07-05 · **guest_count** 1 · **quote_status** ready · **stale_quote** false

## Safety proof

| Check | Result |
|-------|--------|
| API key in responses/logs | **none** (`secret_leak: false`) |
| Hard safety calls | **none** |
| Raw metric dump | **none** |
| `sends_whatsapp` | **false** all turns |
| `no_write_performed` | **true** all turns |
| Stripe links in replies | **none** |

## Run commands

```bash
npm run proof:stage43b-hosted-surf-report
npm run proof:stage43b-hosted-surf-report -- --deploy   # deploy 0c74150 if needed
npm run verify:stage43b-hosted-surf-report-proof
```

Report JSON: `tmp/stage43b-hosted-surf-report-proof.json`

## Post-run verifier (43a / 41b / booking-core / hammer)

- `verify:stage43a-client-facing-surf-report` — **64/64 PASS**
- `verify:stage41b-multilingual-faq-knowledge` — **PASS**
- `booking-core` — **26/26 PASS**
- hammer 40402 — **81/16/3** (unchanged)
- `verify:stage40e-final-hammer-cleanup` — **PASS**

## Remaining gaps

- Live Stormglass forecast data on hosted (key configured; upstream returns error → safe fallback works)
- Staff surf forecast UI/charts (out of scope)
- Production deploy (not done)

## Next stage

**Stage 44a** — Ale/Cami manual hammer mode/runbook (fallback is safe; live API can be wired/renewed separately if ops renews Stormglass quota).

Optional follow-up: verify Stormglass quota/key validity on staging and re-run proof for full **PASS** on live data.
