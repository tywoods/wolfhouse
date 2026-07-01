# Luna Front Desk — Multi-Client Architecture

> Foundation document. Describes how Luna Front Desk serves multiple clients
> (tenants) from one shared codebase while keeping each live client isolated.
> This is a **plan + registry**, not a runtime router — see "What not to do".

Canonical registry: [`config/clients/clients.json`](../config/clients/clients.json),
guarded by `scripts/verify-multiclient-isolation.js`.

---

## 1. Client (tenant) vs Location

- **Client (tenant)** — a business that runs on Luna Front Desk. Identified by
  `client_slug`. Owns its own live runtime, database, secrets, WhatsApp number,
  Stripe context, and staff users. Examples: `wolfhouse`, `sunset`, `mirleft`.
- **Location** — a physical site/branch *within* one client. Identified by a
  globally-unique `location_id` and a guest-facing `display_name`. A client may
  have several locations that share the same runtime/DB/channels but differ in
  schedule, capacity, prices, and branding.

| Client | Locations | Display |
|--------|-----------|---------|
| `wolfhouse` | `wolfhouse-somo` | Wolfhouse Somo |
| `sunset` | `sunset-somo`, `sunset-sardinero` | Sunset, **elSardi** |
| `mirleft` | `mirleft-main` | Mirleft |

Rule of thumb: **new business → new client**; **new site for an existing business → new location**.
`location_id` is unique across the whole platform (never reused between clients).

---

## 2. Environment distinction: staging vs prod

- **staging** — shared test plumbing; safe to break; no real guests/charges.
  Today both Wolfhouse and Sunset run on staging container apps with Stripe-TEST.
- **prod (live)** — real guests, real money. Per-client, isolated (see below).
  A client only serves real guests once its **go-live gates** pass and
  `live_enabled` is flipped true for that client.

`live_enabled` defaults **false** for every client in `clients.json`. Flipping it
is a deliberate, gated step, not a code default.

---

## 3. Recommended Azure layout (early live model)

One shared image, **separate runtime + DB + secrets per live client**:

```
Azure subscription
├── shared
│   └── ACR (whstagingacr)  ── one image: wh-staff-api, wh-hermes-staging, luna-sunset-staff-api
├── <client>-staging-rg
│   ├── <client>-staging-staff-api   (Container App)
│   ├── <client>-staging-hermes       (Hermes/Luna agent, or Lunabox VM)
│   └── staging Postgres (shared test DB acceptable)
└── <client>-prod-rg                  (created at go-live, per client)
    ├── <client>-prod-staff-api       (Container App)
    ├── <client>-prod-hermes
    ├── <client>_prod  Postgres        (isolated DB)
    └── Key Vault / secrets            (per-client Stripe, Meta, DB creds)
```

The **image/codebase is shared**; what differs per live client is the runtime
instance, the env/secrets it's started with, and the database it points at.

---

## 4. Cost-smart isolation model

Isolate what carries risk; share what's cheap and stateless.

- **Share:** the Docker image, the Git repo, ACR, CI, and (acceptably) the
  *staging* Postgres, scoped by `client_slug`/`location_id`.
- **Isolate per live client:** the **database**, the **Staff API runtime**, the
  **Hermes/Luna runtime**, and all **secrets** (Stripe, Meta/WhatsApp, DB).
- Locations within a client **share** that client's runtime/DB/channels and are
  separated by `location_id` (schedule, capacity, prices, branding).

This keeps the live blast radius per-client (a Wolfhouse incident can't touch
Sunset data, money, or guests) without paying for full per-location infra.

### 4a. Separate DB per live client (at first)
Each live client gets its own Postgres (`<client>_prod`). No cross-client rows,
no shared connection string. Locations live inside that client's DB, tagged by
`location_id`.

### 4b. Separate Staff API runtime per live client (at first)
Each live client runs its own Staff API container app, started with that client's
`DEFAULT_CLIENT`, DB creds, and access config. No shared live Staff API.

### 4c. Separate Hermes/Luna runtime per live client (at first)
Each live client runs its own Hermes/Luna agent (its own SOUL config + WhatsApp
binding + Staff API base URL). No shared live agent guessing which client a
message belongs to.

### 4d. Shared codebase and shared image
All of the above run the **same image** built from `master`. Differences are
config/env/secrets, never forked code.

---

## 5. Channel routing

Inbound is mapped to a client/location by a stable channel identifier — never by
guessing from message content:

- **WhatsApp:** route by Meta **`phone_number_id`** (each client's live number maps
  to exactly one `client_slug`). The guest's sender number identifies the guest,
  not the tenant.
- **Email:** route by the destination **inbox address** for that client.

Each live client owns its own number/inbox; routing is a lookup, not inference.

Staging shadow-only enablement (env + runbook, not live switch): [`MULTICLIENT-STAGING-ROUTING.md`](MULTICLIENT-STAGING-ROUTING.md).

---

## 6. Payment / Stripe isolation

- Each live client uses its **own Stripe account/context** and its own webhook
  secret. No shared default Stripe key across clients.
- Payment links, checkout sessions, and webhooks are scoped to the originating
  client's runtime + secrets, so money never crosses tenants.
- Staging uses Stripe-TEST only.

---

## 7. Go-live gates (per client)

A client flips `live_enabled` only after its checklist passes
(`docs/clients/<client>/GO-LIVE-CHECKLIST.md`). Common gates:

1. Isolated live DB provisioned and reachable from that client's runtime only.
2. Live Staff API healthy on its own runtime.
3. Live Hermes/Luna agent up, bound to the client's live WhatsApp number/inbox.
4. Live Stripe context wired (keys + webhook secret), test charge verified.
5. Luna golden/verifier gates green on the deployed build.
6. End-to-end test booking + payment on the live stack.
7. Rollback path written and rehearsed.

---

## 8. Rollback principles

- Deploy by **immutable image tag**; rollback = point the runtime back at the
  previous known-good tag (no rebuild needed).
- Keep the previous healthy revision available until the new one is verified.
- DB changes are forward-only + reversible; never destructive in a go-live step.
- A failed go-live is reverted by flipping `live_enabled` back to false and
  restoring the prior image tag — guests fall back to the prior channel handling.
- Never roll forward through a red verifier gate.

---

## 9. What not to do

- **No repo forks per client.** One codebase, one `master`. Per-client = config.
- **No shared live multi-tenant WhatsApp router yet.** Don't build one agent that
  guesses the tenant from a shared number — route by `phone_number_id`, one live
  number per client.
- **No dirty-tree deploys.** Build live images only from committed, pushed
  `master`; assert repo sync first.
- **No shared default Stripe secret.** Each live client has its own Stripe
  context + webhook secret; never fall back to a global key.
- **No cross-client data access.** Queries are scoped by `client_slug`; a live
  client's runtime can only see its own DB.
- **No flipping `live_enabled` without the go-live checklist passing.**
