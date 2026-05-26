# Phase 2c checkpoint (frozen)

**Status:** Verified end-to-end locally. Do not change Phase 2c behavior without a new phase.

**Reference booking:** `WH-recSyn7QcPdVrYa1D` (May 2026)

---

## What passed

| Step | Outcome |
|------|---------|
| Main (local Stripe) fork | New booking through guest-details path |
| Ensure Booking In Postgres | Row created/found |
| Create Payment Session | Stripe Checkout URL |
| Airtable Payment Link | Updated with `checkout.stripe.com` |
| Checkout | €200.00, test payment succeeded |
| Success page | Worked |
| Stripe webhook | `checkout.session.completed` processed |
| Postgres final | `payment_status=deposit_paid`, `deposit_paid_cents=20000`, `send_confirmation=true`, `status=payment_pending` |

---

## Canonical artifacts (regenerate, do not hand-edit fork)

| File | Role |
|------|------|
| `scripts/build-main-local-stripe.js` | Source of truth for `__NULL__` Ensure Booking fix |
| `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` | Generated fork — import into **local** n8n only |
| `docs/PHASE-2c.md` | Runbook |
| `scripts/test-phase2c-stripe-branch.ps1` | Branch dependency test |

Regenerate fork:

```powershell
node scripts/build-main-local-stripe.js
```

---

## Ensure Booking fix (must stay)

n8n Postgres **drops empty** query parameters and shifts `$n`.

1. All 11 query params use sentinel `__NULL__` when empty.
2. SQL uses `NULLIF($n, '__NULL__')` throughout.
3. `airtable_record_id` is **`NULL`** in INSERT (not `$12`).

---

## Files that must NOT change for Phase 2c freeze

| Path | Rule |
|------|------|
| `n8n/Wolfhouse Booking Assistant  - Main.json` | Hosted export — **read-only** input to build script |
| `n8n/Wolfhouse - Send Confirmation.json` | Hosted export — untouched until Phase 2d fork |
| Phase 3 dual-write workflows | **Not started** |

---

## Regression coverage

See `docs/regression-test-plan.md` sections **7.8**, **7.8b**, **7.9**.

---

## Next phase

**Phase 2d** — local Send Confirmation from Postgres (`send_confirmation=true`). See `docs/PHASE-2d.md`.
