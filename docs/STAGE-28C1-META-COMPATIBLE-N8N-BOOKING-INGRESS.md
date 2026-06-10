# Stage 28c.1 — Meta-Compatible n8n Booking-Write Ingress

**Status:** DESIGN + WORKFLOW EXPORT (2026-06-10) — repo only; **no hosted proof in this slice**.  
**Parent:** [STAGE-28A-REAL-PHONE-STAGING-REHEARSAL.md](STAGE-28A-REAL-PHONE-STAGING-REHEARSAL.md) · [STAGE-27DEMO-L-N8N-BOOKING-WRITE-CALENDAR.md](STAGE-27DEMO-L-N8N-BOOKING-WRITE-CALENDAR.md)  
**Verifier:** `npm run verify:stage28c1-meta-compatible-n8n-booking-ingress`  
**Next:** **Rerun Stage 28c** — real-handset booking-write rehearsal

---

## 0. Why this slice exists

**Stage 28c failed** because Meta could not point at the staging n8n booking-write URL:

| Observation | Detail |
|-------------|--------|
| **Symptom** | Graph API `#2200` — callback verification HTTP 404 |
| **Root cause** | `27demo-l` webhook was **POST-only**; Meta sends **GET** `hub.challenge` on subscribe/override |
| **After activation** | n8n responded: *"This webhook is not registered for GET requests"* |

Meta phone webhook today (unchanged): `https://staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook` — GET verify works there, but that path is **Staff API brain**, not the n8n open-demo booking-write pipe.

---

## 1. Rejected bandaid

**Do not implement:** Meta → Staff API `/staff/meta/whatsapp/webhook` → HTTP forward → staging n8n → Staff API again.

| Why rejected |
|--------------|
| Double hop; ugly ownership split |
| Staff API meta handler is draft/preview-oriented, not the 27demo-l write pipe |
| Violates product direction: **n8n is the WhatsApp pipe**, Staff API is the brain |

---

## 2. Accepted target architecture

```
Real phone → WhatsApp/Meta
           → staging n8n (GET verify + POST inbound)   ← pipe
           → Staff API /staff/bot/open-demo-whatsapp-inbound-dry-run   ← brain
           → hold + draft payment + demo bed assignment
           → Staff Portal Inbox + Bed Calendar
```

**n8n supports same-path GET + POST:** two Webhook nodes in **one workflow**, **same path**, different HTTP methods (n8n allows one registration per path+method). Matches the production Main pattern (separate GET verify + POST message triggers).

### Workflow shape (28c.1)

| Branch | Nodes |
|--------|--------|
| **GET** | `Webhook - Meta GET Hub Verify` → `Code - Meta Hub Verify` → `Respond - Meta Hub Challenge` (raw text) |
| **POST** | Existing 27demo-l chain unchanged |

| Field | Value |
|-------|-------|
| **Export** | `n8n/Luna Open Demo WhatsApp Booking Write Pipe.json` |
| **Path** | `open-demo-whatsapp-booking-write-27l` |
| **Verify token** | `wolfhouse_verify_token` |
| **Demo phone_number_id** | `1152900101233109` |
| **Staff API route** | `POST /staff/bot/open-demo-whatsapp-inbound-dry-run` |
| **Write flags** | `create_demo_hold_draft_confirmed`, `assign_demo_bed_confirmed` |
| **Repo default** | `active: false` |

### Must not include

- `send_live_reply_confirmed`
- `create_stripe_test_link_confirmed`
- `send_payment_link_whatsapp_confirmed`
- `graph.facebook.com` send nodes
- Staff API meta webhook forward

---

## 3. Staging activation note (for 28c rerun)

When importing/activating on staging n8n (`stage27demoLWrite01`), register **two** `webhook_entity` rows for the same path:

| method | node |
|--------|------|
| `GET` | `Webhook - Meta GET Hub Verify` |
| `POST` | `Webhook - Open Demo Booking Write Inbound` |

Prior 27demo-l proofs inserted POST only — 28c rerun must add GET registration or Meta override will keep failing.

---

## 4. Meta callback repoint (28c proof window)

1. Confirm staging n8n workflow active with **GET + POST** registrations.
2. Phone-level override (Graph API) to:
   `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/webhook/open-demo-whatsapp-booking-write-27l`
3. Expect GET verify **200** + raw challenge echo.
4. Human tester sends 3-turn script (see §5).
5. **Revert** Meta callback after proof (restore Staff API URL if that was the pre-proof baseline).

---

## 5. Rerun Stage 28c — proof plan

| Item | Value |
|------|--------|
| **Mode** | B — booking write |
| **Dates** | Check-in **2026-11-10**, check-out **2026-11-17** (4 free demo beds; avoid Oct 12–19) |
| **Guests / package** | 2 · Malibu · deposit |
| **Gates during window** | `OPEN_DEMO_BOOKING_WRITES_ENABLED=true`, `WHATSAPP_DRY_RUN=true`, Stripe/confirmation/live-reply off |
| **n8n** | `27demo-l` only — inactive after proof |

**Script:**

1. “Hi, we are 2 people interested in the Malibu package”
2. “November 10 to November 17”
3. “Deposit is fine”

**Success:** `booking_code`, `hold`, `waiting_payment`, payment draft, `booking_beds`, calendar visible — no Stripe link, no confirmation, no live outbound.

---

## 6. Rollback

```text
OPEN_DEMO_BOOKING_WRITES_ENABLED=false
OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false
WHATSAPP_DRY_RUN=true
LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST unset
n8n stage27demoLWrite01: active false
webhook_entity: delete rows for workflow
Meta callback: restore pre-proof URL
```

---

## 7. Clean alternative (if same-path GET+POST failed)

If n8n could not register GET+POST on one path cleanly, the architectural fallback is **Meta → Staff API directly** for inbound WhatsApp (retire n8n from inbound), **not** a Staff API→n8n→Staff API bridge. Stage 28c.1 export implements the n8n-first fix; static verifier confirms GET+POST shape in repo.
