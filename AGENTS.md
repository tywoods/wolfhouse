# Wolfhouse (WH) — agent context

This repo is **Wolfhouse booking + Luna guest front desk** for a surf hostel in Somo, Spain.

You are helping the **team build and operate** this system. Read files with terminal/search tools when you need detail — this file is the map.

## Product

- **Wolfhouse** — surf hostel / guest house in Somo.
- **Guests** chat on **WhatsApp** (Meta Cloud API).
- **Staff** use the staff portal (`staff-staging.lunafrontdesk.com` on staging).
- **Luna** is the guest-facing host persona (warm WhatsApp tone, one clear question per message).

## Architecture (current direction)

```
Guest WhatsApp  →  Hermes Agent (staging: wh-staging-hermes on Azure Container Apps)
                    →  OpenAI (gpt-4o-mini on staging)
                    →  Staff API (booking brain, Postgres, Stripe)
```

- **Legacy path:** n8n workflows + Luna JS pipeline in this repo (`scripts/lib/luna-guest-*`).
- **Target path:** Hermes replaces n8n as the guest WhatsApp layer; Staff API stays the source of truth for availability, quotes, payments, bookings.
- **Staging Hermes URL:** `https://wh-staging-hermes.braveplant-5c685569.northeurope.azurecontainerapps.io` (API only — no web UI at `/`).

## Repo layout

| Area | Path | Notes |
|------|------|--------|
| Luna guest brain | `scripts/lib/luna-guest-*.js` | Planner, tools, composer, Cami voice, pipeline |
| Staff API | `scripts/staff-query-api.js` | Large staff + bot HTTP surface |
| Hermes staging deploy | `scripts/deploy-staging-hermes.js` | ACA deploy, `chat-test`, `chat` |
| Hermes local | `scripts/run-local-hermes.js`, `hermes-local/` | Docker-based local Hermes |
| Golden fixtures | `fixtures/luna-golden/` | Regression transcripts |
| Canonical guest rules | `docs/LUNA-GUEST-BEHAVIOR-SPEC.md` | **Read this** for Luna behavior |
| Guest journey | `docs/LUNA-GUEST-JOURNEY.md` | End-to-end flows |
| Hermes on Azure | `docs/HERMES-AZURE-CONTAINER-APPS.md` | Staging runbook |
| Hermes local | `docs/HERMES-LOCAL.md` | Talk to Hermes about this repo |
| DB migrations | `database/migrations/` | Postgres schema |
| Infra | `infra/` | Env examples, deployment notes |

## Luna behavior (summary)

Full spec: `docs/LUNA-GUEST-BEHAVIOR-SPEC.md`.

- **Facts** (prices, availability, payment URLs) come from **tools/DB only** — never model memory.
- **Planner** decides intent and next step (`luna-guest-frontdesk-planner.js`).
- **Composer** owns truth copy (amounts, links, confirmations); **Cami** only adds warmth.
- **One question per reply** on WhatsApp; explain package tiers before asking guests to pick.
- **No internal jargon** to guests (no “composer”, “staging”, “dry run”, etc.).
- **Handoff** only on explicit reasons — not on low confidence alone.

## Verification commands

```bash
npm run verify:luna-all          # fast Luna gate (no API key)
node scripts/deploy-staging-hermes.js chat-test   # staging Hermes smoke
node scripts/run-local-hermes.js chat             # local Hermes (this repo)
```

## Working conventions

- Node.js tooling; run scripts with `node scripts/...` (PowerShell may block `npm` scripts that shell out to npm.ps1).
- Minimize parallel layers — one owner file per Luna rule (see behavior spec).
- Staging Staff API: `https://staff-staging.lunafrontdesk.com`
- Local Hermes uses `hermes-local/.env` for `OPENAI_API_KEY` (gitignored).

When asked “what should we do next”, prefer: read relevant spec + owner file, propose a small scoped change, and mention which verify script proves it.
