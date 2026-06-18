# Luna Front Desk multi-tenant plan — wolfhouse + sunset (tenants)

**Platform framing:** Luna Front Desk is the platform. Wolfhouse is tenant 1; Sunset is tenant 2. Shared code stays generic; tenant-specific behavior lives in config.

**Status:** Planning draft (docs-only). No code, config, env, or deploy changes are made or implied here. Authored by Deckhand for Skipper architecture review.

**Goal:** onboard **Sunset Surf School** (`tenant_id = sunset`) as **tenant/client 2** on the Luna Front Desk platform — same shared codebase as tenant 1 Wolfhouse (`tenant_id = wolfhouse`), **not** a copy-pasted fork. Sunset is not a Wolfhouse feature. Wolfhouse (tenant 1) behavior must remain unchanged; Sunset must be fully isolated via tenant config.

**This plan leans on patterns the repo already has** rather than inventing new ones:
- `config/clients/_deploy-config.template.json` — the per-client deploy-config template with a **vertical seam** (`catalog` + `inventory`).
- `config/clients/wolfhouse-somo.*.json` — a *filled* deploy config (the worked example) + a messaging playbook.
- `config/clients/surf-shop-rental.sample.json` and `surf-school.sample.json` — paper-test samples proving the `rentals` and `lessons` verticals fit the spine.
- `docs/DEPLOYMENT-CONFIG.md` — the portability contract ("engine is generic; everything client-specific is values in a per-client deploy config").

---

## 1. How the Luna Front Desk platform serves multiple tenants

The platform engine is designed to be client-generic (`docs/DEPLOYMENT-CONFIG.md`). The portability contract:

```
LUNA FRONT DESK PLATFORM (generic)    DEPLOY CONFIG (per tenant)            SECRETS (per tenant, gitignored)
- routing, required fields            - prices, seasons, deposit            - handoff phone / email
- payment link + webhook truth        - catalog (packages|rentals|lessons)  - master-admin numbers
- confirmation, handoff, safety       - inventory model + map               - admin password
- staff queries, add-on flow          - which vertical(s)                   - Stripe / channel creds (per tenant)
- InventoryProvider interface         - persona / messaging playbook
```

**Each tenant's Luna** is the same **Luna Front Desk platform code** parameterized by a `tenant_id` and its deploy config. Nothing Sunset-specific (or Wolfhouse-specific) should be hardcoded in `scripts/lib/luna-guest-*.js`. Where Wolfhouse facts are currently read from `config/clients/wolfhouse-somo.*.json`, Sunset reads from `config/clients/sunset-*.json` selected by `tenant_id`.

**Non-negotiable:** the only way any tenant's behavior changes is if shared platform code changes. So Sunset onboarding must be **additive config + additive tenant resolution**, with every Wolfhouse (tenant 1) golden fixture and `npm run verify:luna-all` staying green as the regression proof.

---

## 2. Tenant config

### 2.1 Files (proposed — not created in this doc)

Mirror the Wolfhouse layout under a `sunset` slug:

| Purpose | Wolfhouse file (exists) | Sunset file (proposed) |
|---------|-------------------------|------------------------|
| Deploy/baseline | `wolfhouse-somo.baseline.json` | `sunset.baseline.json` |
| Pricing | `wolfhouse-somo.pricing.json` | `sunset.pricing.json` |
| Messaging playbook | `wolfhouse-somo.messaging.json` | `sunset.messaging.json` |
| Knowledge / FAQ | `wolfhouse-somo.knowledge.json` | `sunset.knowledge.json` |
| Secrets (gitignored) | `wolfhouse-somo.secrets.json` | `sunset.secrets.json` |
| Secrets example | `wolfhouse-somo.secrets.example.json` | `sunset.secrets.example.json` |

Created later in an implementation slice — **not** in this docs-only task.

### 2.2 What goes in the Sunset deploy config

Following `_deploy-config.template.json`:
- `_meta`: `client_slug: "sunset"`, `client_name`, `vertical` (see §4 re: multi-vertical), `timezone`, `languages` (`en`, `es`, …), `currency: EUR`.
- `catalog`: Sunset rentals + lesson types + accommodation package (seed prices from `LUNA-SUNSET-OVERVIEW.md` §3.4, each item `pricing_status: provisional` until owner-confirmed).
- `inventory`: `rentals` (unlimited for MVP) + `slots`/`lessons` (capacity-limited).
- `payment`: deposit rule, link options, hold expiry — reuse engine-default mechanisms.
- `confirmation`, `cancellation`, `handoff`, `llm_safety`, `customer_memory_privacy`: reuse the spine **unchanged** (these "fit unchanged" per both paper-test samples' `_portability_findings`).
- `handoff.handoff_whatsapp_target` + an **email** handoff target → secret refs.

### 2.3 Tenant resolution (engine)

A `tenant_id` must be resolvable at the very start of message handling, from the inbound channel identity:
- WhatsApp: which business phone-number ID / WABA the message arrived on → `tenant_id`.
- Email: which inbox / address the email arrived to → `tenant_id`.

Tenant resolution then selects the deploy config, messaging playbook, Stripe account/keys, and Staff-API tenant scope for the rest of the turn. **This is the single most important isolation seam** — get it wrong and tenants cross-contaminate.

---

## 3. Routing by channel (WhatsApp / email)

Both channels feed the same per-tenant Luna brain; they differ only in **ingress** and **output formatting**.

```
WhatsApp (Sunset number)  ─┐
                           ├─►  resolve tenant_id=sunset  ─►  Sunset Luna brain  ─►  channel-shaped reply
Email (Sunset inbox)      ─┘        (config + Staff API tenant scope)                 (WhatsApp: short/1-question
                                                                                       email: structured)
```

- **Inbound → tenant.** The channel adapter maps the inbound identity (WA phone-number ID, or email recipient) to a `tenant_id`. No tenant guessing from message content.
- **Channel flag on the turn.** Carry a `channel ∈ {whatsapp, email}` alongside `tenant_id`. The brain/planner is channel-agnostic for *truth*; only the composer/voice layer varies length & structure:
  - WhatsApp → existing short, one-question-per-reply contract (`MAX_REPLY_CHARS`, rule 1.4/9.1).
  - Email → a structured variant: subject + greeting + sectioned body + optional small quote table, still truth-from-tools-only.
- **Same thread state across a channel**, keyed by `(tenant_id, channel, contact_identity)`. (Cross-channel identity stitching — same human on WA *and* email — is **out of scope for MVP**; treat them as separate threads unless a later slice links them.)

> Email ingress may be net-new plumbing (the platform's current WhatsApp channel adapter serves tenant 1 Wolfhouse only). Flagged as Open Question #3 in `LUNA-SUNSET-OVERVIEW.md`. If email is not yet wired, MVP can ship WhatsApp-only Sunset and add email behind the same brain later.

---

## 4. Service catalog

Sunset spans **three offering shapes** that the engine currently models as separate verticals:
- `rentals` (board/wetsuit/board+suit/SUP) — see `surf-shop-rental.sample.json`.
- `lessons` (group/kids/private/large-group) — see `surf-school.sample.json`.
- partner `accommodation` (hotel package) — a confirmation workflow, closest to lodging but **not** Sunset-owned beds.

The baseline schema today is **one vertical per config**. Two ways forward:

**Option A — single Sunset config with a multi-entry catalog (recommended for MVP).**
Extend `catalog.offerings` to carry a per-offering `inventory_model` (`rentals` | `slots` | `partner_accommodation`) so one Sunset tenant exposes all three. The engine routes each offering to the matching **InventoryProvider** (the Stage-5 interface already anticipated in `DEPLOYMENT-CONFIG.md`). Pricing stays per-offering with `pricing_status`.

**Option B — three sub-configs under one tenant.**
`sunset.rentals.json`, `sunset.lessons.json`, `sunset.accommodation.json`, merged at load. More files, cleaner separation, but heavier tenant wiring.

Recommendation: **Option A** — fewer moving parts, matches the existing single-`baseline.json`-per-client habit, and the per-offering `inventory_model` field is a small, well-contained schema generalization (exactly the kind the paper-test `_portability_findings` already call for).

**Catalog price source rule:** every quote pulls the price + `pricing_status` from this catalog. Provisional prices → dry-run / shadow / staff-approved only; live autonomous charge requires `pricing_status: confirmed` (engine-default `pricing_policy`).

---

## 5. Staff API as source of truth

Unchanged principle, tenant-scoped:
- **Availability** — lessons & partner accommodation availability come from the Staff API (or staff confirmation when the API can't answer). Rentals are unlimited for MVP, so no availability call — but the *price* still comes from config.
- **Quotes** — totals are computed from tenant config + Staff-API data, never model memory.
- **Payment status** — Stripe webhook truth, surfaced via Staff API. Never `paid`/`confirmed` from the LLM.
- **Bookings/orders** — written through the Staff-API write path, scoped to `tenant_id = sunset`.

**Every Staff-API call must carry `tenant_id`** so reads/writes are partitioned. A Sunset query must never return Wolfhouse rows and vice-versa. (How the Staff API enforces tenant partitioning — column, schema, or separate DB — is an Open Question for Captain; this plan assumes a `tenant_id` scoping column at minimum.)

---

## 6. Payment links — tenant-scoped

- Payment links are created **only** by the Staff API / payment tool, **per tenant** (`PHASE-13/14/20` payment-truth spine, reused).
- Each tenant has its **own Stripe context** (account or restricted keys) in its secret file — a Sunset checkout must settle into Sunset's Stripe, a Wolfhouse checkout into Wolfhouse's. Tenant resolution (§2.3) selects which.
- The public payment base URL is per-tenant config (`messaging.public_urls.public_payment_base_url`, as the Wolfhouse tenant config already does).
- Luna **never** constructs, edits, or guesses a URL — it relays the tool-returned link verbatim (composer-owned, Cami/voice-frozen — rule 6.3).

---

## 7. Deployment options

### 7.1 Safe MVP — separate Luna/Hermes process per tenant (recommended first)

Run **one Hermes/Luna process per tenant**, each pinned to a single `tenant_id` via env/config, each with its own channel credentials and Stripe context.

```
wh-staging-hermes      → tenant_id=wolfhouse  (unchanged, keeps running)
sunset-staging-hermes  → tenant_id=sunset     (new, isolated process)
```

**Pros:** strongest isolation; Wolfhouse process is literally untouched (best guarantee that Wolfhouse behavior doesn't change); a Sunset bug can't take down Wolfhouse; tenant resolution is trivial (process is the tenant). Matches the current "one ACA app per environment" deploy shape (`docs/HERMES-AZURE-CONTAINER-APPS.md`, `HERMES-AZURE-VM.md`).
**Cons:** config/catalog duplication across processes; two deploys to operate; no shared in-memory state (fine — state is in Postgres).

### 7.2 Later — shared multi-tenant router (single process, many tenants)

One process resolves `tenant_id` per inbound message (§2.3) and loads the right config/Stripe/Staff-API scope per turn.

**Pros:** one deploy, cheaper at scale, single place to ship engine improvements.
**Cons:** tenant resolution becomes a **safety-critical** path — a routing bug leaks one tenant's prices/links/confirmations into another's chat; harder to guarantee tenant 1 (Wolfhouse) is unchanged. Requires the isolation guardrails in §8 to be airtight first.

**Recommendation:** ship **7.1** for Sunset MVP. Move to **7.2** only after tenant isolation has fixture coverage and a Sunset shadow period.

---

## 8. Risks & guardrails

| Risk | Guardrail |
|------|-----------|
| **Cross-tenant fact leak** (Sunset quote/link/availability bleeds into Wolfhouse or vice-versa) | `tenant_id` resolved once at ingress; threaded through every config read, Staff-API call, Stripe call, and reply. Separate-process MVP (7.1) makes leakage structurally impossible. Add cross-tenant isolation fixtures. |
| **Regressing tenant 1 (Wolfhouse)** | Sunset is additive config + tenant resolution only. `npm run verify:luna-all` + all Wolfhouse golden fixtures must stay green; treat any Wolfhouse golden diff as a blocker. Do not edit `docker/hermes-staging/SOUL.md` or Wolfhouse runtime files. |
| **Invented Sunset facts** | All prices/policies are config with `pricing_status`; provisional → dry-run/shadow only. Public-site numbers are seeds, not authority. Owner must confirm before live charge. |
| **Wrong Stripe account** | Per-tenant Stripe creds in per-tenant secret file; tenant resolution selects them; never a shared default. |
| **Lesson overbooking** | Lessons are capacity-limited — never quote a seat as available without a Staff-API capacity check; otherwise collect-then-staff-schedule. |
| **Partner-hotel overpromise** | Accommodation = confirmation workflow; never confirm a hotel room/price without Staff-API/partner confirmation. |
| **Minors (kids lessons)** | Guardian consent + extra privacy gate; hand off where consent or a minor's data is in question (`surf-school.sample.json` minor gate). |
| **Email is new surface** | If email ingress is net-new, ship WhatsApp-first; add email behind the same brain once plumbed. Don't block MVP on it. |
| **Multi-vertical schema creep** | Keep the spine unchanged; confine Sunset's shape to `catalog` + `inventory_model` (the seam the paper tests already validated). |

---

## 9. Open questions for Skipper / Captain

1. **Tenant partitioning in the Staff API/DB** — `tenant_id` column, separate schema, or separate database? Determines the isolation guarantee.
2. **Multi-vertical config** — adopt Option A (single config, per-offering `inventory_model`) or Option B (sub-configs)?
3. **Stripe** — one Stripe account with metadata per tenant, or fully separate Sunset Stripe account/keys?
4. **Email ingress** — does the stack already accept email, or is that new work?
5. **Process model** — confirm separate-process MVP (7.1) before any shared-router work (7.2).
6. **Where does `tenant_id` resolution live** — Hermes channel adapter, Staff API, or a shared resolver? Whichever owns it owns the top isolation risk.
