# Phase 19f — Hosted n8n Cloud → Staff API Luna Cutover Plan

**Status:** PASS — plan doc + static plan verifier (Phase 19f.1). **No n8n activation. No Meta webhook change. No live send.**
**Parent:** Phase 19e — gated WhatsApp provider + persistent idempotency + first live outbound proof (`35c3c23`, Phase 19e.5c rerun PASS).
**Prior audit:** Phase 19e.5c-blocker — Meta inbound owned by hosted n8n Cloud Main; Staff API outbound-capable only.
**Next:** Phase 19f.2 — repo JSON inactive pipe workflow + static workflow verifier.

**Non-negotiables (19f.1):** Planning/static only. No n8n Cloud activation/deactivation. No Meta webhook URL change. No live WhatsApp send. No DB writes. No booking/payment creation. No Stripe. No deploy. No migrations. No credential deletion.

**Product direction:**

- **n8n is the pipe** (Meta webhook ingress + optional debug respond).
- **Staff API is the brain and send gate** (intake preview, draft, gated send).
- Luna handles normal safe guest conversations automatically once cutover stages pass.
- Staff handles exceptions/risky cases.

**Architecture principle (unchanged):** Meta webhook stays on hosted n8n Cloud until Staff API has a verified inbound handler and an explicit approved cutover. Phase 19f moves **brain + send** off old Main without moving **Meta ownership** yet.

---

## 0. Go/No-Go framing (read first)

Phase 19e proved Staff API can send one real WhatsApp message through `POST /staff/bot/guest-reply-send` with `guest_message_sends` idempotency. Phase 19e.5c-blocker proved **inbound Meta webhook still points at hosted n8n Cloud Main**, which still acts as both brain and Graph API sender.

Phase 19f defines the **clean cutover path**: keep Meta on n8n, replace Main's decision/send logic with Staff API calls, then retire direct n8n Graph sends — without running two send paths at once.

Default posture: **default-deny send** on Staff API; n8n pipe calls send only when draft eligibility allows; old Main stays untouched until inactive pipe is proven.

---

## 1. Current live ownership

| Layer | Owner today | Notes |
|-------|-------------|-------|
| Meta WhatsApp webhook (inbound) | **Hosted n8n Cloud** `https://tywoods.app.n8n.cloud/webhook/booking-assistant` | Active; verify path `e22ec0ce-5f25-448d-beb2-f004aa992987` + token `wolfhouse_verify_token` |
| Inbound brain | **Old n8n Main** (`Wolfhouse Booking Assistant - Main`) | Router, LLM, Airtable session, booking logic |
| Outbound WhatsApp (production guests) | **Old n8n Main** | Direct `graph.facebook.com/v20.0/1152900101233109/messages` HTTP nodes |
| Staff API Luna brain | **`POST /staff/bot/message-intake-preview`**, **`POST /staff/bot/guest-reply-draft`** | Implemented; not Meta inbound owner |
| Staff API send gate | **`POST /staff/bot/guest-reply-send`** | Outbound-capable; idempotency proven; default env gates off |
| Azure staging n8n | **Inactive** (0 active workflows) | Not live Meta owner |
| Phone / Meta app | **+34 663 43 94 19**, ID `1152900101233109`, app **Wolfhouse** (`842343435599477`) | Same identity Staff API uses for outbound |

**Summary:** Meta inbound → hosted n8n Cloud Main. Old Main = brain + sender. Staff API = outbound-capable brain/send gate, **not** inbound owner.

---

## 2. Target near-term architecture

```
Meta WhatsApp inbound
        │
        ▼
Hosted n8n Cloud (pipe only — new inactive-then-active workflow)
        │  normalize inbound (same envelope as Main)
        │  stable idempotency_key
        ▼
POST /staff/bot/guest-reply-draft   ← Staff API brain
        │  suggested_reply, send_eligibility, next_action
        ▼
IF eligible (auto_send_ready + safe send_kind + not requires_staff)
        │
        ▼
POST /staff/bot/guest-reply-send    ← Staff API send gate
        │  guest_message_sends audit / idempotency
        ▼
Meta Graph API outbound (via Staff API provider only)
```

**n8n pipe responsibilities:** receive webhook, normalize, call Staff API, map response, debug/respond. **No** direct Graph API. **No** booking-create, payment-link, Stripe webhook, or confirmation send in the pipe workflow.

**Staff API responsibilities:** all reply logic, eligibility, pause checks, idempotency, audit, and WhatsApp send when gates pass.

Optional later: `POST /staff/bot/message-intake-preview` as a read-only pre-step for logging/shadow comparison — not required for first pipe MVP if draft route accepts normalized inbound directly.

---

## 3. What should change first (Phase 19f.2)

**Recommended first deliverable:** repo JSON inactive workflow (import to n8n Cloud **inactive**):

**Target file:** `n8n/Wolfhouse Booking Assistant - Luna Pipe Shadow.json`

**Workflow behavior:**

1. Webhook trigger (separate test path, **not** `booking-assistant`) — e.g. `luna-pipe-shadow-19f`.
2. Normalize WhatsApp inbound (reuse Main envelope shape: `entry[0].changes[0].value.messages[0]`).
3. Extract: `client_slug`, `from` phone, `whatsapp_message_id`, `message_text`, `language`.
4. Build stable `idempotency_key` (see §4).
5. `POST /staff/bot/guest-reply-draft` with bot token header auth credential.
6. Map draft: `suggested_reply`, `send_eligibility`, `next_action`, `allowed_send_kind`.
7. IF `send_eligibility.auto_send_ready === true` AND `requires_staff === false` AND safe `allowed_send_kind`:
   - `POST /staff/bot/guest-reply-send` with draft fields + idempotency_key.
8. ELSE: respond with draft-only debug (no send route call) OR call send route expecting `requires_staff` / gate block — **prefer skip send route** for risky/handoff to avoid unnecessary provider reach.
9. Respond with debug JSON: draft + send result flags.

**Settings:**

- `"active": false` — mandatory until manual execution proof.
- Do **not** touch production Main activation state.
- Do **not** change Meta webhook URL to this path until Stage E.

**Hosted import:** import inactive to `tywoods.app.n8n.cloud`; manual POST proof only.

---

## 4. Stable idempotency key design

Primary key (production):

```
luna:{client_slug}:{wa_message_id}:{send_kind}
```

| Field | Source |
|-------|--------|
| `client_slug` | Normalized inbound or default `wolfhouse-somo` |
| `wa_message_id` | Meta `messages[0].id` when present |
| `send_kind` | From draft `send_eligibility.allowed_send_kind` or mapped `next_action` |

**Rules:**

- One inbound WhatsApp message → one key per `(client_slug, wa_message_id, send_kind)`.
- Replays of same inbound must hit `guest_message_sends` idempotent replay (`duplicate: true`, `send_performed: false`).
- n8n must **not** mint random keys per execution.

**Fallback (manual/test only):**

```
luna:{client_slug}:{from}:{timestamp_or_hash}:{send_kind}
```

Use only when `wa_message_id` absent (editor test payloads). Never use fallback on live Meta inbound if `wa_message_id` exists.

**Alignment:** matches Staff API `guest_message_sends` unique `(client_slug, idempotency_key)`.

---

## 5. Send kind mapping

| Draft / next_action | `send_kind` for send route | Pipe behavior |
|---------------------|----------------------------|---------------|
| Missing dates/guests/package/payment choice | `ask_missing_field` | Call send when eligible |
| Safe quote / availability reply | `show_quote` | Call send when eligible |
| Check-in day message | `checkin_day` | **Reserved** — scheduled/check-in flow only; **not** inbound Main pipe |
| Handoff / risky / staff-required | — | **Do not call send route**; return draft + `requires_staff` debug |
| Unsupported / low confidence | — | **Do not call send route** |

**send_eligibility mapping into send route body:**

```json
{
  "send_eligibility": {
    "send_allowed_later": true,
    "requires_staff": false,
    "auto_send_ready": true,
    "allowed_send_kind": "ask_missing_field"
  }
}
```

Use values from draft response; do not invent eligibility in n8n.

**Handoff/risky:** cleaner to **skip** `guest-reply-send` and surface draft-only debug. Alternative (call send expecting block) is acceptable for hosted proof but wastes provider reach — default **skip**.

---

## 6. What remains blocked

Until explicitly approved in later phases:

| Capability | Status |
|------------|--------|
| Payment link automation | **Blocked** — no booking/payment draft flow wired in pipe |
| Confirmation send | **Blocked** |
| Check-in day scheduler | **Blocked** — `checkin_day` not for inbound Main pipe |
| Paid cancellations / refunds / date changes | **Blocked** — staff-required |
| Direct n8n Graph API sends | **Blocked** after pipe activation (Stage D) |
| Meta webhook cutover to Staff API | **Blocked** — Phase 19f keeps Meta on n8n Cloud |
| Automatic booking write | **Blocked** |
| Stripe calls / webhooks from pipe | **Blocked** |
| Azure staging n8n on production phone | **Blocked** |

---

## 7. Safe cutover stages

| Stage | Action | Send path | Meta webhook |
|-------|--------|-----------|--------------|
| **A — Inactive manual proof** | Import Luna Pipe Shadow **inactive**; manual POST test payloads | Staff API gates off / dry-run; no live send | Unchanged (Main still live) |
| **B — Active pipe, gates off** | Activate **new** pipe on **test webhook path only**; Main still owns `booking-assistant` | `LUNA_AUTO_SEND_ENABLED` unset; `WHATSAPP_DRY_RUN=true` | Unchanged |
| **C — Internal/test send** | Temp enable Staff API send gates for approved test recipient only | One live send + idempotency replay proof | Unchanged |
| **D — Retire old send nodes** | Switch Meta webhook from Main → pipe **OR** disable Main Graph HTTP nodes | **Only** Staff API send route may call Graph | Still n8n URL, new workflow path |
| **E — Production activation** | Pipe owns `booking-assistant`; Main deactivated | Staff API send with production gates + pause + rate limits | Still n8n-hosted URL |

**Critical rule:** never run **old Main Graph sends** and **Staff API send route** for the same inbound simultaneously.

**Stage D/E prerequisite checklist:**

- [ ] Pipe workflow PASS on manual + hosted inactive proofs
- [ ] Idempotency replay proven on hosted Staff API
- [ ] Bot pause gate tested
- [ ] Risky/handoff never calls send (draft-only)
- [ ] Audit rows only in `guest_message_sends` during proof
- [ ] Rollback plan: re-point webhook to Main or reactivate Main

---

## 8. What not to do

- **Do not** delete n8n WhatsApp credentials.
- **Do not** change Meta webhook URL in Phase 19f.1/19f.2 planning slices.
- **Do not** activate Azure staging n8n against production Wolfhouse phone.
- **Do not** run old Main direct send and Staff API send route in parallel for the same guest message.
- **Do not** let n8n call `graph.facebook.com` after Staff API send route is the approved sender.
- **Do not** auto-send `checkin_day`, confirmation, payment links, or booking writes from the pipe.
- **Do not** deactivate production Main until Stage D/E criteria met.

---

## 9. Static workflow requirements (Luna Pipe Shadow JSON)

When `n8n/Wolfhouse Booking Assistant - Luna Pipe Shadow.json` is created (Phase 19f.2):

| Requirement | Expected |
|-------------|----------|
| `active` | `false` |
| Direct `graph.facebook.com` | **None** |
| Stripe / `api.stripe.com` | **None** |
| booking-create / payment-link / stripe-webhook | **None** |
| Calls `POST /staff/bot/guest-reply-draft` | **Yes** |
| Calls `POST /staff/bot/guest-reply-send` | **Yes** (behind eligibility IF) |
| Includes `idempotency_key` on send | **Yes** |
| Maps send result fields | `send_performed`, `sends_whatsapp`, `duplicate`, `idempotent_replay`, `blocked_reasons`, `whatsapp_message_id` |
| Debug respond node | **Yes** — full draft + send flags in JSON response |
| Credentials | Header auth for `X-Luna-Bot-Token`; **no secrets hardcoded**; **no credentials deleted** |
| Webhook path | **Distinct** from `booking-assistant` until cutover |

Evolve from Phase 18e `Wolfhouse Booking Assistant - Message Intake Shadow.json` (draft-only) by adding send route call + idempotency + eligibility IF.

---

## 10. Staff API endpoints (pipe contract)

| Route | Role in pipe |
|-------|----------------|
| `POST /staff/bot/guest-reply-draft` | **Required** — brain |
| `POST /staff/bot/guest-reply-send` | **Required when eligible** — send gate |
| `POST /staff/bot/message-intake-preview` | Optional shadow/logging |

**Send route body (minimal):**

```json
{
  "client_slug": "wolfhouse-somo",
  "idempotency_key": "luna:wolfhouse-somo:wamid.xxx:ask_missing_field",
  "send_kind": "ask_missing_field",
  "to": "+49...",
  "suggested_reply": "...",
  "source": "guest_reply_draft",
  "send_eligibility": { }
}
```

Auth: `X-Luna-Bot-Token` (n8n credential, not hardcoded).

---

## 11. Verifiers that must protect this cutover

| Verifier | Role |
|----------|------|
| `verify:luna-agent-phase19-n8n-cutover-plan` | This plan doc (19f.1) |
| `verify:luna-agent-phase19-guest-reply-send-route` | Send route gates |
| `verify:luna-agent-phase19-guest-reply-send-idempotency` | DB idempotency |
| `verify:luna-agent-phase19-whatsapp-provider` | Provider isolation |
| `verify:luna-agent-phase18-n8n-draft-shadow` | Prior draft shadow pattern |
| Future: `verify:luna-agent-phase19-n8n-pipe-shadow` | Luna Pipe Shadow JSON (19f.2) |

**Non-recursive:** 19f.1 verifier does not run full downstream closeout trees.

---

## 12. Safety proof (19f.1 slice)

| Check | Status |
|-------|--------|
| Plan doc only — no runtime send code | ✓ |
| Meta webhook unchanged in plan | ✓ |
| n8n Cloud Main not deactivated in plan | ✓ |
| No parallel send paths in target architecture | ✓ |
| Idempotency key design documented | ✓ |
| Blocked capabilities listed | ✓ |
| Cutover stages A–E defined | ✓ |

---

## 13. Stop conditions

Stop and split if any slice:

- Changes Meta webhook URL without explicit approval
- Activates n8n Cloud Main deactivation before pipe proof
- Deletes or rotates WhatsApp credentials without rollback plan
- Sends live WhatsApp from pipe before Stage C approval
- Adds direct Graph API nodes to pipe workflow
- Runs booking-create, payment-link, or Stripe from pipe
- Activates Azure staging n8n on production phone alongside Cloud Main

---

## 14. Phase map

| Phase | Deliverable |
|-------|-------------|
| **19f.1** | This plan + static plan verifier (**current**) |
| **19f.2** | `Luna Pipe Shadow.json` + static workflow verifier |
| **19f.3** | Hosted n8n Cloud inactive import + manual POST proof |
| **19f.4** | Active pipe on test webhook, gates off, draft+send dry path |
| **19f.5** | Internal test recipient live send via pipe → Staff API |
| **19f.6** | Meta webhook switch Main → pipe; Main Graph sends disabled |
| **19g+** | Postgres message persistence, Airtable decoupling, Meta→Staff API inbound (future) |

---

## 15. References

- [docs/webhook-map.md](webhook-map.md) — production webhook paths
- [docs/current-system-map.md](current-system-map.md) — legacy Airtable + n8n Cloud architecture
- [docs/PHASE-19.1-LUNA-PRODUCTION-AUTO-SEND-GATES-PLAN.md](PHASE-19.1-LUNA-PRODUCTION-AUTO-SEND-GATES-PLAN.md) — auto-send gate plan
- `n8n/Wolfhouse Booking Assistant - Message Intake Shadow.json` — Phase 18e draft shadow pattern
- Phase 19e.5c-blocker audit — live webhook ownership proof
