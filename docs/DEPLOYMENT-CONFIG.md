# Deployment Config — how we onboard a client (the portability contract)

**Status:** Spec / pattern (Stage 3x.2f, 2026-05-29). Docs/config only.
**Related:** [`config/clients/_deploy-config.template.json`](../config/clients/_deploy-config.template.json) · [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json) · [`ROADMAP.md` § Engine portability](ROADMAP.md#engine-portability--adding-a-new-vertical-surf-shop--lessons)

---

## The principle (never forget this)

**The engine is generic. Everything client- and surf-house-specific is just *values* in a per-client deploy config.**

There is **no surf-house knowledge hardcoded** in code or n8n workflows. Prices, seasons, gate code, phone numbers, packages, room map, check-in/out times, policies — all of it lives in **one deploy config per client** (plus a secret file for numbers/passwords). Deploying a new client (even a different vertical) does **not** mean rewriting logic; it means filling a new config.

```text
ENGINE (generic, built once)              DEPLOY CONFIG (per client)            SECRETS (per client, gitignored)
- routing, required fields                - prices, seasons, deposit            - handoff phone number
- payment link + webhook truth            - packages / offerings                - master-admin numbers
- confirmation, handoff, safety           - room/inventory map                  - admin password
- staff queries, add-on flow              - gate code, check-in/out, policies
- inventory PROVIDER interface            - which vertical + inventory model
```

---

## What you fill at deploy time

A new client = **3 things**:

1. **Deploy config** — copy [`_deploy-config.template.json`](../config/clients/_deploy-config.template.json) → `config/clients/<client-slug>.baseline.json` and fill the `<FILL>` values.
2. **Secret file** — copy `<client-slug>.secrets.example.json` → `<client-slug>.secrets.json` (gitignored) and put real phone numbers + admin password there.
3. **Inventory model** (only if the vertical differs) — pick `lodging` / `slots` / `rentals`; reuse the matching `InventoryProvider` (Stage 5). No new workflows.

### Deploy-time field inventory (client-specific)

| Area | Fields |
|------|--------|
| Identity | slug, name, vertical, timezone, languages, currency |
| Property | address, gate code, check-in/out times, closed months, housekeeping |
| Catalog | offerings/packages, seasons, prices, inclusions, room/unit-type modifiers, non-standard-duration pricing, recommendation map |
| Payment | deposit rule (flat or **tiered by booking type**) + scope, hold expiry, balance methods |
| Add-ons | service catalog (rentals/lessons/meals/yoga) + prices, **quantity-tiered prices**, **bundles**, lesson scheduling |
| Inventory | rooms/beds map (lodging) or slots/rentals; rooming rules (lodging only) |
| Policies | cancellation, no-show, bad-weather, **refund mechanism (voucher vs money)** |
| Handoff | channel, target (secret ref), emergency script |
| Staff | master-admin (secret ref), roles |
| **Secrets** | handoff number, master-admin numbers, admin password (in secret file) |

### Engine-default fields (rarely changed per client)

`llm_safety` · `pricing_policy` mechanism · `customer_memory_privacy` gate · `stage4_entry_gate` · the always-handoff base list · staff-query safety rules.

---

## pricing_status — provisional vs confirmed

Every priced item carries `pricing_status`:

- `provisional` — working value; safe in **dry-run / golden tests / shadow** only.
- `confirmed` / `confirmed_2026` — owner-verified; required before a **live autonomous charge** to a real guest.

Updating a price later = edit the value + flip the flag. No code change, no plumbing re-test.

---

## Wolfhouse as the worked example

`wolfhouse-somo.baseline.json` **is** a filled deploy config (vertical = `lodging_surf_house`):

- Packages Malibu/Uluwatu/Waimea, seasons (Mar–Jun/Oct/Nov shoulder, Jul/Sep high, Aug peak, Dec–Feb closed), prices **confirmed 2026**. Non-7-night = package total ÷ 7, round up to nearest €5/night.
- **Tiered deposit** (€200 standard package / €100 custom or short stay); add-ons **confirmed (3x.2g)**: wetsuit €5, soft top €15, hard board €20/day; **bundles** wetsuit+softtop €15, wetsuit+hardboard €20; lessons **tiered** (1 = €35, 2+ = €30 each); yoga €15 on site. Dinner €15 still provisional.
- Gate code, check-in 15:00 / check-out 11:00, rooming map R1–R10.
- Lessons scheduled manually (two daily slots); **refunds default to a 12-month voucher**, cash refund is the exception — all staff-handled.
- Handoff → WhatsApp (number in secret file); master-admin in secret file.

These four mechanisms are generalizable across surf houses and are **engine defaults** in the template (values per client): **tiered deposit**, **quantity-tiered add-on pricing**, **bundles**, **voucher-first refunds**.

A **surf shop** or **surf school** deploy config reuses every engine section above; it only swaps `catalog` (rental SKUs / lesson types) and `inventory` (`rentals` / `slots`) — validated cheaply by the paper-test samples `surf-shop-rental.sample.json` / `surf-school.sample.json`.

---

## Stage placement

| Work | Stage |
|------|-------|
| Deploy-config pattern + template + this guide | **3x.2f (now)** — done |
| Engine reads deploy config (vs hardcoded) | Stage 5 (logic extraction) |
| Split engine-default vs deploy vs secret formally | Stage 5 |
| Onboarding UI / form to generate a deploy config | Stage 6–7 |
| Second vertical via new deploy config + provider | Stage 7 |

Today the template is the **spec**; the engine still reads values from n8n/config as it's extracted in Stage 5. The contract is fixed now so Stage 5 produces a portable engine, not a tidied-up surf-house monolith.
