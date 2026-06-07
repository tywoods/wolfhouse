# Phase 24 — OpenAI Ask Luna AI provider foundation (closeout)

**Status:** PASS (local verifiers + staging functional + health proofs)  
**Closeout commits:** `f75acb0` (24a) · `48ee8a4` (24b) · `b5b4a2e` (24d) · `2dbcbcd` (24e)  
**Staging anchor revision:** `wh-staging-staff-api--stage24e-ai-health`  
**Staging anchor image:** `whstagingacr.azurecr.io/wh-staff-api:2dbcbcd-stage24e-ai-health`  
**Key fingerprint (staging proof):** `fd617f34`  
**Date:** 2026-06-07

## 1. Scope

Phase 24 delivers the **Staff Ask Luna AI provider foundation**: a shared OpenAI/Anthropic provider module and refactors so intent classification, answer formatting, and multi-tool planning all route through one resolver — with safe diagnostics and health visibility.

**In scope:**

- `scripts/lib/luna-ai-provider.js` — shared provider resolution and HTTP wrapper
- `scripts/lib/staff-ask-luna-ai-intent.js` — AI intent classifier
- `scripts/lib/staff-ask-luna-ai-answer-format.js` — balance-due answer formatter
- `scripts/lib/staff-ask-luna-multi-tool-planner.js` — ops multi-tool planner
- Staging OpenAI functional proof (24c / 24d.1)
- Provider diagnostics + `/staff/ask-luna/ai-status` (24d)
- Public-safe `/healthz` `luna_ai` summary (24e / 24e.1)

**Out of scope (explicitly unchanged):**

- **Guest WhatsApp reply path remains deterministic/template-based** — no generative guest replies
- Guest AI intake / extraction (deferred to Stage 25)
- Arbitrary SQL generation from LLM
- WhatsApp sends, Stripe, Meta webhook changes, **no n8n**

## 2. Architecture

```
Staff question
    │
    ├─► staff-ask-luna-ai-intent.js      (call_label: classifier)
    ├─► staff-ask-luna-ai-answer-format.js (call_label: answer_formatter)
    └─► staff-ask-luna-multi-tool-planner.js (call_label: multi_tool_planner)
              │
              ▼
        luna-ai-provider.js
              │
              ├─► OpenAI  (default when OPENAI_API_KEY configured)
              └─► Anthropic (explicit LUNA_AI_PROVIDER=anthropic or fallback when only Anthropic key)
```

All Ask Luna AI modules use **`callLunaAiJsonChat`** from the shared provider. Duplicated OpenAI/Anthropic fetch code was removed in 24b.

**Resolution precedence (24d):**

- Provider: `LUNA_AI_PROVIDER` → `STAFF_ASK_LUNA_AI_PROVIDER` → auto from key presence
- Model: `LUNA_AI_MODEL` → `STAFF_ASK_LUNA_AI_MODEL` → `OPENAI_MODEL` / `ANTHROPIC_MODEL` → default
- OpenAI key: `OPENAI_API_KEY` → `STAFF_ASK_LUNA_OPENAI_API_KEY` (trimmed; whitespace-only treated as missing)

## 3. Environment (staging)

| Variable | Staging value |
|----------|----------------|
| `OPENAI_API_KEY` | Key Vault secret ref `openai-api-key` |
| `LUNA_AI_PROVIDER` | `openai` (`LUNA_AI_PROVIDER=openai`) |
| `LUNA_AI_MODEL` | `gpt-4o-mini` (`LUNA_AI_MODEL=gpt-4o-mini`) |
| `STAFF_ASK_LUNA_AI_ENABLED` | unset (AI on when key present); **`false` remains explicit off switch** |

## 4. Phase chain + commits

| Phase | Commit | Summary |
|-------|--------|---------|
| **24a** | `f75acb0` | Added `luna-ai-provider.js`; refactored `staff-ask-luna-ai-intent.js`; centralized OpenAI/Anthropic resolution |
| **24b** | `48ee8a4` | Refactored `staff-ask-luna-ai-answer-format.js` + `staff-ask-luna-multi-tool-planner.js`; removed duplicate provider code |
| **24c / 24d.1** | (deploy on `48ee8a4` / `b5b4a2e` images) | Staging OpenAI functional proof — classifier, formatter, planner all PASS |
| **24d** | `b5b4a2e` | Safe diagnostics (`key_source`, `key_fingerprint`, `call_label` errors); `GET /staff/ask-luna/ai-status` |
| **24e** | `2dbcbcd` | `/healthz` includes public-safe `luna_ai` summary (no `key_length`) |
| **24e.1** | (deploy `2dbcbcd`) | Hosted health proof on `wh-staging-staff-api--stage24e-ai-health` |

### Hosted functional proof anchors (24c / 24d.1)

| Test | Question | Expected | Result |
|------|----------|----------|--------|
| **A** | Who hasn't settled up yet? | `payments.balance_due`, `intent_source` **ai** | PASS |
| **B** | Who still owes money? | `payments.balance_due`, `answer_format_source` **ai** | PASS |
| **C** | What should I prepare for tomorrow? | `ops.multi_tool_summary`, `intent_source` **ops_planner_ai** | PASS |

Earlier 401 failures were traced to invalid/stale Key Vault secret + container secret reload — not env-resolution bugs (same `key_fingerprint` across call sites after fix).

### Hosted health proof anchors (24e.1)

| Check | Result |
|-------|--------|
| `GET /healthz` → `luna_ai.configured: true` | PASS |
| `luna_ai.provider`: `openai`, `luna_ai.model`: `gpt-4o-mini` | PASS |
| `luna_ai.key_source`: `OPENAI_API_KEY` | PASS |
| `luna_ai.key_fingerprint`: `fd617f34` | PASS |
| `key_length` absent on public `/healthz` | PASS |
| Authenticated `GET /staff/ask-luna/ai-status` — same fingerprint; `key_length` present | PASS |
| No `sk-` in responses | PASS |

## 5. Observability endpoints

| Endpoint | Auth | Fields |
|----------|------|--------|
| `GET /healthz` | none | `luna_ai`: `configured`, `provider`, `model`, `key_present`, `key_source`, `key_fingerprint` — **no OpenAI call**, **no raw key**, **no key_length** |
| `GET /staff/ask-luna/ai-status` | staff session viewer+ | Richer: adds `key_length`, `provider_source`, `model_source` — **no OpenAI call**, **no raw key** |

## 6. Safety (proven across 24c–24e.1)

- **No WhatsApp sends** during proof windows
- **No Stripe** calls from Ask Luna AI paths
- **No booking/payment writes** from Ask Luna AI paths
- **No Meta webhook changes**
- **no n8n** activation
- **No raw key leakage** — fingerprint is SHA-256 first 8 hex chars only; no prefix/suffix/full hash in API responses
- Guest WhatsApp reply path **untouched** — deterministic/template-based

## 7. Caveats

1. **Guest-facing Luna AI intake not implemented yet** — Stage 25 scope only.
2. **Generative guest replies not implemented** — guest path stays template/deterministic.
3. **Ask Luna reads/answers from registry/data tools, not arbitrary SQL** — classifiers/formatters/planners are constrained to allowlisted intents and validated outputs.
4. **OpenAI billing and keys must stay valid** — 429/401 fall back safely but degrade AI quality to deterministic paths.
5. **Public `/healthz` exposes configuration metadata** (not secrets) — acceptable for ops smoke; richer detail requires session auth.

## 8. Focused verifiers (closeout gate)

| Verifier | Role |
|----------|------|
| `verify:luna-ai-provider` | Shared provider wiring + resolution |
| `verify:luna-ai-provider-diagnostics` | 24d diagnostics + call_label + ai-status route |
| `verify:luna-ai-health-status` | 24e `/healthz` luna_ai + no secret leak |
| `verify:staff-ask-luna-ai-intent-fallback` | Intent classifier |
| `verify:staff-ask-luna-ai-answer-formatter` | Answer formatter |
| `verify:staff-ask-luna-multi-tool-planner` | Multi-tool planner |
| `verify:luna-agent-phase24-closeout` | This doc + downstream gate |

## 9. Recommended Stage 25 (first slice)

**Guest AI intake/extraction only** — behind normal dev/staging testability gates:

- AI fills **structured fields only** (dates, guest count, package hints) from inbound messages
- **Deterministic engine remains source of truth** for availability, pricing, and writes
- **No generative guest replies yet** — outbound WhatsApp stays template/draft-only until explicitly scoped
- Reuse `luna-ai-provider.js` patterns (shared resolver, diagnostics, no raw key in logs/responses)
- Do not conflate Stage 25 with Phase 24 closeout — staff Ask Luna and guest intake are separate surfaces
