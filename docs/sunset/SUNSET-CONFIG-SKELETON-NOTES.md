# Sunset (tenant 2) config skeleton — Luna Front Desk platform

**Status:** Deckhand implementation slice (config skeleton only). No runtime changes.
**Branch:** `feat/sunset-multitenant-luna`

---

## Where the config lives

| File | Purpose |
|------|---------|
| `config/clients/sunset.baseline.json` | Main Sunset deploy config. Follows `_deploy-config.template.json`. This is the single file that parameterises Sunset Luna. |
| `config/clients/sunset.secrets.example.json` | Committed example of required secret keys (no real values). Copy → `sunset.secrets.json` (gitignored) and fill at deploy time. |
| `config/clients/sunset.secrets.json` | **NOT committed** (gitignored). Real Stripe keys, WhatsApp phone, admin numbers live here. |

**Naming convention:** same as Wolfhouse — `{slug}.{purpose}.json`. Extends to `sunset.messaging.json`, `sunset.knowledge.json`, `sunset.pricing.json` when needed, following existing files.

---

## What is seed / unverified

Every price, schedule, and policy value in `sunset.baseline.json` that came from the public Sunset website carries:

```json
"pricing_status": "unverified_seed",
"seed_source": "public_site",
"seed_source_url": "https://escueladesurfsunset.com/en/..."
```

**`unverified_seed` is stricter than `provisional`.** The `pricing_policy` block explicitly sets:

```json
"on_unverified_seed_in_live": "block_do_not_quote"
```

Meaning: until an owner verifies and flips `pricing_status` to `confirmed`, these values **must not be used for any live quote or charge to a real guest**, even in shadow/staff-approved mode. This is intentional — the Wolfhouse paper tests (e.g. `surf-school.sample.json`) already established that public-site data is a starting point, not authority.

### Items that are `null` / `owner_required` (not seed — genuinely unknown)

- Kids Surfpark lesson prices
- Private / coaching lesson price and duration
- Large-group lesson price and capacity threshold for handoff
- SUP 2-day, 5-day, 7-day prices (not on public site)
- Accommodation package price and hotel details
- Deposit rule (type, amounts, scope)
- Hold expiry duration
- Bad-weather / no-waves lesson refund policy
- Cancellation, no-show, refund policies
- Emergency handoff script

These are `owner_required` in the config. Luna must never invent them.

---

## What must be verified / filled before enabling

The config has an `owner_required_before_go_live` array listing every item as a checklist. Short version:

1. **All prices** — owner verifies each `unverified_seed` value and either confirms or corrects it → set `pricing_status: "confirmed"`.
2. **Lesson schedule** — confirm slot times (11:00–13:00 / 16:00–18:00) are the live Sunset schedule.
3. **Age rules** — exact min-age for kids Surfpark; guardian-consent policy.
4. **Materials / insurance** — confirm that board/wax/leash/wetsuit and insurance/civil-liability statements match current policy.
5. **Missing prices** — private lesson, large-group, kids, multi-day SUP, accommodation package.
6. **Deposit and hold** — deposit rule type and amounts; hold expiry.
7. **Secrets** — populate `sunset.secrets.json` (Stripe keys, staff handoff phone, master-admin numbers).
8. **WhatsApp** — set `deployment.whatsapp_phone_number_id`.
9. **Policies** — bad-weather, cancellation, no-show, refund mechanism.
10. **Flip `deployment.enabled: true`** only when all items above are resolved.

---

## What future code must consume from config (not from prompt memory)

This is the contract for whoever wires the engine to Sunset:

| What Luna says | Must come from |
|----------------|----------------|
| Any rental price | `catalog.rentals.offerings.{item}.prices_eur.{window}` — only when `pricing_status: "confirmed"` |
| Any lesson price | `catalog.lessons.offerings.{type}.prices_eur.{tier}` — only when `pricing_status: "confirmed"` |
| Lesson slot times | `catalog.lessons.scheduling.common_slot_times` |
| Arrive-early reminder | `catalog.lessons.scheduling.arrive_before_class_minutes` |
| Age eligibility | `catalog.lessons.age_rules.{group}.*` |
| Materials included | `catalog.lessons.materials_included` (and its `verification_status`) |
| Accommodation availability | Staff-API capacity check for `partner_confirmed` offerings — never from model memory |
| Payment links | Staff-API / payment tool output — never constructed by Luna |
| Booking confirmed | Stripe webhook truth — never from LLM |
| Handoff target | `handoff.handoff_whatsapp_target.phone_ref` → resolved from secret file |
| Stripe credentials | `deployment.stripe_context_ref` → resolved from secret file |

**Tenant isolation is mandatory:** every config read, Staff-API call, and Stripe call must carry `tenant_id = "sunset"` (from `deployment.staff_api_tenant_scope`). The engine must never fall through to Wolfhouse config for a missing Sunset key.

---

## Multi-offering inventory_model (Skipper Option A)

The template's `inventory.model` is a single string. Sunset uses a **per-offering `inventory_model`** field (Skipper decision, `MULTI-TENANT-PLAN.md` §4 Option A):

| Offering group | `inventory_model` | What it means |
|----------------|-------------------|---------------|
| Rentals | `unlimited` | No availability check for MVP; quote from config price only |
| Lessons | `capacity_limited` | Staff-API slot capacity check required before confirming a seat |
| Accommodation | `partner_confirmed` | Partner/hotel confirmation required; never promise availability |

The engine's InventoryProvider interface needs to read `inventory_model` per-offering and route accordingly. This is a small schema generalization on top of the current template (which only supports one model per config). **No code change is in scope for this slice** — this note documents what the implementation slice will need.

---

## Conventions followed

- File naming: `{slug}.{purpose}.json` — matches `wolfhouse-somo.*.json`.
- Secrets: same pattern as `wolfhouse-somo.secrets.example.json`; real file gitignored.
- `pricing_policy.live_autonomous_charge_requires: "pricing_status_confirmed"` — verbatim engine default.
- `deployment.enabled: false` — skeleton is not live; must be an explicit flip to enable.
- `llm_safety` stated explicitly (not just `"engine_default"` string) so the Sunset config is self-contained for review.
- Safety rules stated as an explicit `safety_rules` block for auditability.
