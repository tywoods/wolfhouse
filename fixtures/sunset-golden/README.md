# Sunset golden fixtures (draft)

**Status:** `draft` / **Active:** `false`  
**Tenant:** `sunset` (Luna Front Desk client 2)

These fixtures define desired Sunset Luna guest behavior for future regression testing. They are **not** executed by `npm run verify:luna-golden`, which only runs `fixtures/luna-golden/` (Wolfhouse tenant 1).

## Conventions

- Schema: `sunset-golden-draft-v1` (see `_manifest.json`)
- Seed prices reference `config/clients/sunset.baseline.json` with `pricing_status: unverified_seed`
- Placeholders `{like_this}` in expected reply shapes mean config/tool-sourced values at runtime
- Wire to a Sunset-specific runner when tenant runtime is implemented

## Scenarios

| File | Scenario |
|------|----------|
| `sunset-golden-01-rental-board-price-whatsapp.json` | Board rental price inquiry |
| `sunset-golden-02-rental-board-wetsuit-5day-whatsapp.json` | Board + wetsuit 5-day rental |
| `sunset-golden-03-adult-group-lesson-two-whatsapp.json` | Group lesson for 2 adults |
| `sunset-golden-04-kids-lesson-age-check-whatsapp.json` | Kids Surfpark age check |
| `sunset-golden-05-surf-accommodation-package-whatsapp.json` | Lessons + accommodation package |
| `sunset-golden-06-email-rental-inquiry.json` | Email-style rental + lessons inquiry |
| `sunset-golden-07-payment-link-guardrail-whatsapp.json` | Payment link without booking details |
