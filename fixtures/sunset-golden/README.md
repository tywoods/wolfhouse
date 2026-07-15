# Sunset golden fixtures

**Status:** `active`  
**Tenant:** `sunset` (Luna Front Desk client 2)  
**Runner:** `scripts/run-sunset-golden.js` (wired via `_manifest.json`)  
**No-send guard:** `scripts/lib/sunset-golden-no-send-guard.js`

These fixtures define Sunset Luna guest behavior. They are **not** executed by `npm run verify:luna-golden` (Wolfhouse only). Use:

```bash
npm run verify:sunset-golden
# or
node scripts/run-sunset-golden.js
```

The runner is **review-only**. The central no-send guard blocks booking creation, Stripe/payment-link creation, WhatsApp, and email **even if** a fixture sets `allow_writes: true` or `whatsapp_suppressed: false`.

## Conventions

- Schema: `sunset-golden-manifest-v1` (see `_manifest.json`)
- Seed prices reference `config/clients/sunset.baseline.json` with `pricing_status: unverified_seed`
- Placeholders `{like_this}` in expected reply shapes mean config/tool-sourced values at runtime
- Fixture 09 is the active rapid-fire Spanish group-lesson quote path (coalesced input; quote-before-name)

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
| `sunset-golden-08-group-lessons-morning-mon-thu-spanish-whatsapp.json` | Group lessons Mon–Thu morning (Spanish) |
| `sunset-golden-09-rapid-group-lesson-quote-whatsapp.json` | Rapid-fire Spanish group quote (active, no-send) |
