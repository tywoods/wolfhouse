# Luna Guest Runtime — program contract

**Status:** Phase 0 contract (planning only). Sunset-staging / Luna Front Desk.  
**Scope:** Client infrastructure program — not a leftover bugfix, not a SOUL rewrite.  
**Out of scope this phase:** product code, Caddy, Meta webhooks, Hermes live path, n8n, `inbox-thread.js`, deploy, production.

Related slice doc (do not duplicate): [`docs/SUNSET-LUNA-HTTP-RUNTIME.md`](./SUNSET-LUNA-HTTP-RUNTIME.md).

---

## Goal

One **tenant-scoped, channel-independent Luna Guest Runtime** on Azure Container Apps.

| Owns | Does not own |
| --- | --- |
| Guest inbound → decide → draft/send under gates | Open spots, prices, bookings, payments (**Staff API only**) |
| Conversation state in **Postgres** + transactional outbox | Hermes `state.db` as guest memory |
| WhatsApp + email adapters onto the **same** runtime | A second Luna On/Off; Inbox auto-draft stays the existing bottom-left switch |

**Hermes** stays for operators (Skipper / Deckhand / Seadog) and as WhatsApp rollback until cutover. **n8n stays out.**

---

## Current facts (do not pretend otherwise)

| Fact | Detail |
| --- | --- |
| Live WhatsApp | Meta → `lunabox.lunafrontdesk.com/whatsapp/webhook` → Caddy `/whatsapp/*` → `hermes-sunset-luna:8092`. **Do not cut over.** |
| Email Luna | Already ACA `luna-sunset-staging-email-luna` (`email_draft_server.py`). Different image than WhatsApp Luna — that split is the drift this program kills. |
| HTTP stub (PR #846, `f3b6a25`) | Additive `luna_http_server.py` + ACA example `luna-sunset-staging-luna-http` on **8094**, sending off. Judge it as a stub of **one** runtime, not a third Luna. See [`SUNSET-LUNA-HTTP-RUNTIME.md`](./SUNSET-LUNA-HTTP-RUNTIME.md). |
| Open spots | Remaining seats in a class (Thu 10:00 at 3/25 ⇒ **22 open**). First-answer pack PRs **#843 #844 #845** are on master. |
| Shadow mode | No bookings, no guest sends until explicitly enabled. |
| State | Postgres conversation state + transactional outbox. **Persist + enqueue before model; return 200.** Not Hermes `state.db`. |
| Existing gates | Channel Auto on · Global Pause off · conversation Luna On · Needs Human off. Reuse; do not invent a parallel switch. |
| Inbox auto-draft | Existing bottom-left switch only — no second Luna On/Off. |

---

## Runtime shape

```text
channel adapter (WhatsApp | email | probe)
  → persist + enqueue (Postgres + outbox) → 200
  → planner → policy → Staff API → frozen facts → voice
  → pre-send guardian → (shadow: no send | gated send)
```

Four intelligence layers plus **pre-send guardian**. Staff API is the only authority for inventory and money facts. Model voice never invents open spots, prices, booking codes, or payment URLs.

### Sunset taxonomy first

Map these before anything else: classes · leftover / open spots · kids vs adults · gear · Somo vs Sardi · payment.

Do **not** import Wolfhouse hotel `explore_stay` / check-in as the first capability map.

---

## Failure rule

A failure becomes one of:

1. better **state**,
2. executable **policy**,
3. Staff API **capability**, or
4. a **first-answer pack** case —

—not another `SOUL.md` paragraph.

---

## Build order

| Phase | Name | What ships | What does not |
| --- | --- | --- | --- |
| **0** | Contract | This file | Code, deploy |
| **1** | Foundation | Same HTTP ACA runtime; persist+enqueue; Postgres; outbox; existing gates; **sending off**; no Caddy/Meta change | Intelligence cutover, live WhatsApp flip |
| **2** | Intelligence | Planner → policy → Staff API → frozen facts → voice + guardian **on that same runtime** | Second service / second On/Off |
| **3** | Prove | First-answer pack · shadow · staging test number · then cutover: **WhatsApp first**, then **email** onto the same runtime; Hermes remains rollback | Production; n8n |
| **4** | After live | Ledger · replay · dashboards | Rewriting the contract mid-flight |

**Cutover gate:** shadow + first-answer pack + a live test conversation pass. Only then point WhatsApp; then move email onto the same runtime. Until then, live guests stay on `hermes-sunset-luna`.

---

## Explicit non-goals

- Cutting over Meta / Caddy / Lunabox WhatsApp in Phase 0–2
- Adding a second Luna On/Off or replacing Inbox auto-draft UI
- Running guest Luna through n8n
- Treating `luna-sunset-staging-luna-http` as a permanent third product Luna
- Production, Wolfhouse hotel explore path as the first map, or deploying from this PR
