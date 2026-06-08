# Phase 26i — AeroDataBox flight lookup (provider switch)

**Status:** Active provider for Staff Portal transfer flight lookup  
**Replaces:** Aviationstack (deprecated for lookup — plan/endpoint restrictions on staging)

---

## Why switch

Aviationstack returned `function_access_restricted` / quota-plan issues on staging. AeroDataBox via [API.Market](https://api.market/store/aedbx/aerodatabox) is the active provider with official OpenAPI docs at [doc.aerodatabox.com](https://doc.aerodatabox.com/).

---

## Configuration

| Item | Value |
|------|-------|
| Env var | `AERODATABOX_API_KEY` |
| Key Vault secret | `aerodatabox-api-key` |
| API base (API.Market) | `https://prod.api.market/api/v1/aedbx/aerodatabox` |
| Auth header | `Ocp-Apim-Subscription-Key: <key>` |

Do **not** reuse `AVIATIONSTACK_API_KEY` for lookup. Old Aviationstack module remains in repo for rollback reference only.

---

## Staff Portal behavior (unchanged UX)

- **Route:** `POST /staff/bookings/:booking_id/transfers/lookup-flight`
- **Status:** `GET /staff/transfers/flight-lookup/status` → `provider: aerodatabox`
- Transfers tab **Lookup flight** button unchanged
- Lookup uses **flight_number + booking-derived date** (staff never enters lookup date):
  - Arrival → booking check-in date
  - Departure → booking check-out date
- Retry one day earlier on `flight_not_found`
- Response contract unchanged:
  ```json
  {
    "success": true,
    "lookup": { "provider": "aerodatabox", "best_match": { ... } },
    "suggested_transfer_patch": { ... },
    "no_transfer_write": true,
    "no_payment_write": true
  }
  ```

---

## Safety

- No raw AeroDataBox payload returned or stored
- Lookup route does **not** write `booking_transfers`
- No payment / Stripe / WhatsApp / Meta / n8n changes
- Status route is config-only (no live API call)

---

## Azure staging setup

```bash
az keyvault secret set --vault-name wh-staging-kv --name aerodatabox-api-key --value "<AERODATABOX_API_KEY>"

az containerapp update \
  --name wh-staging-staff-api \
  --resource-group wh-staging-rg \
  --set-env-vars AERODATABOX_API_KEY=secretref:aerodatabox-api-key
```

Keep: `STAFF_ACTIONS_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, `WHATSAPP_DRY_RUN=true`

---

## Verification

```bash
npm run verify:luna-agent-phase26-aerodatabox-provider
```
