# Stage 27u — Guest Automation Orchestrator (Dry-Run)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md](STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md)  
**Module:** `scripts/lib/luna-guest-automation-orchestrator-dry-run.js`  
**Verifier:** `npm run verify:stage27u-guest-automation-orchestrator-dry-run`

**Non-negotiables:** Orchestration only · **no public inbound WhatsApp wiring** · no live send · no DB writes · no holds/payment drafts · no Stripe · no payment links · no Meta · no n8n · no confirmation send (27r/27s not called).

---

## 1. Purpose

Stage **27t** locked the guest automation gate design. Stage **27u** adds a **dry-run orchestrator** that:

1. Applies the **27t entry gate** (`automation_gate_context`).
2. Routes allowed evaluations through the proven **27b–27m** helper chain.
3. Returns a unified response for staff review / future **27v** UI — **without** connecting public guest WhatsApp or performing writes.

---

## 2. API

```js
await runGuestAutomationOrchestratorDryRun(input, context)
```

### Input

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | e.g. `wolfhouse-somo` |
| `channel` | ✓ | `whatsapp`, `dry_run`, `harness`, `staff_review` |
| `message_text` | ✓ | Inbound guest message |
| `guest_phone` | | E.164 |
| `conversation_id` | | Thread id |
| `language_hint` | | Optional |
| `guest_context` | | Prior chain state (quote, lane) for multi-turn |
| `reference_date` | | Harness date anchor |
| `dry_run` | | `true` enables evaluation when public automation off |
| `automation_gate_context` | | See §3 |

### Output (summary)

| Field | Notes |
|-------|--------|
| `dry_run` | Always `true` |
| `public_guest_automation_enabled` | From gate context (default `false`) |
| `automation_gate.gate_status` | `allowed_dry_run` \| `blocked` \| `staff_handoff_required` |
| `result` | Router output (27b/27e) |
| `availability` | When booking lane / eligible |
| `quote` | When availability eligible |
| `payment_choice` | When quote / guest_context eligible |
| `hold_payment_draft_plan` | Optional when `payment_choice_ready` (27m planner, **no writes**) |
| `proposed_next_action` | See §5 |
| `proposed_luna_reply` | Draft only — **not sent** |
| `sends_whatsapp` | Always `false` |
| `live_send_blocked` | Always `true` |

---

## 3. Gate behavior (Stage 27t)

Evaluated **before** chain execution via `evaluateAutomationGate`.

| Condition | Result |
|-----------|--------|
| Missing / unsupported `client_slug` | `blocked` |
| Unsupported `channel` | `blocked` |
| `is_owner_or_staff: true` | `blocked` |
| `bot_paused: true` | `staff_handoff_required` |
| `human_takeover: true` | `staff_handoff_required` |
| `public_guest_automation_enabled !== true` and no dry-run flag | `blocked` |
| Live send requested without `live_send_allowed` | `blocked` |
| `unsafe_gate_context: true` | `blocked` |

### Dry-run exception

When `input.dry_run: true` or `context.dry_run: true`, evaluation proceeds even if `public_guest_automation_enabled` is `false`.

Output **always** keeps:

- `dry_run: true`
- `sends_whatsapp: false`
- `live_send_blocked: true`
- `public_guest_automation_enabled` reflects gate context (default `false`)

---

## 4. Reused helper chain

| Step | Helper | Stage |
|------|--------|-------|
| Router + readiness | `runLunaGuestMessageRouterDryRun` | 27b/27e |
| Availability | `runGuestAvailabilityDryRun` | 27g |
| Quote | `runGuestQuoteProposalDryRun` | 27i |
| Payment choice | `runGuestPaymentChoiceDryRun` | 27k |
| Hold/payment plan | `runGuestHoldPaymentDraftPlannerDryRun` | 27m (plan only) |

**Not called in 27u:**

- 27n hold/payment **write**
- 27o Stripe test link
- 27p payment truth
- 27q confirmation preview
- 27r/27s confirmation **send**

Multi-turn payment choice: pass prior `guest_context` with `quote.quote_status: ready` (same pattern as `POST /staff/bot/guest-intake-dry-run`).

---

## 5. `proposed_next_action` values

| Value | Meaning |
|-------|---------|
| `ask_missing_details` | Collect dates/guests/package/contact |
| `show_availability_quote` | Availability and/or quote step |
| `collect_payment_choice` | Quote ready; need deposit/full |
| `prepare_hold_payment_draft_plan` | Payment choice ready; 27m plan (no write) |
| `staff_handoff_required` | Pause, takeover, or handoff triggers |
| `automation_blocked` | Gate blocked (unsupported channel, staff route, etc.) |

---

## 6. Non-booking lanes

Preserves **27b** lane classification. Lanes such as `add_service_request`, `transfer_request`, `payment_question`, `checkin_house_info_question` receive a **safe draft reply** or staff handoff — **no** availability/quote/payment chain, **no writes**.

---

## 7. Safety limits

| Limit | Policy |
|-------|--------|
| Public guest automation | **Not wired** — orchestrator is library/harness only in 27u |
| WhatsApp send | **Never** |
| Meta / n8n | **Never** |
| Stripe / payment links | **Never** |
| DB / booking writes | **Never** |
| Confirmation send | **Never** (27r/27s not invoked) |
| Invented prices/availability | **Never** — engine helpers only |

---

## 8. Example

```js
const out = await runGuestAutomationOrchestratorDryRun(
  {
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: "Hi, we're 2 people June 15–22, Malibu package",
    dry_run: true,
    reference_date: '2026-06-08',
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
    },
  },
  {},
);
// out.automation_gate.gate_status === 'allowed_dry_run'
// out.sends_whatsapp === false
```

---

## 9. Verifier

```bash
npm run verify:stage27u-guest-automation-orchestrator-dry-run
```

---

## 10. Next slice

**Stage 27v** — Staff Portal guest automation review surface (proposed reply, state, handoff reasons). Still no public inbound loop until **27x** explicit GO.
