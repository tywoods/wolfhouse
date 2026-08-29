# Sunset Surf School — guest journey v2

**Status:** Current product contract for Sunset staging. This document describes the intended guest journey across WhatsApp, email, Luna, the Staff portal, Staff API, Postgres, and Stripe. It does not enable outbound automation or production behavior.

**Tenant:** `sunset` (`sunset-somo`) · **Environment:** Sunset staging · **Channels:** WhatsApp and email.

**Canonical spine:**

```text
question → identify guest need → grounded availability/quote → guest accepts
→ Staff API creates payment link → Stripe payment truth → booking/order confirmed
```

Every actionable fact—offering, price, stock, capacity, availability, payment URL, balance, or booking state—comes from tenant-scoped Admin configuration, Staff API, Postgres, or Stripe. Luna never supplies those facts from model memory.

---

## 1. One guest, two channels

WhatsApp and email are two entrances to the same Sunset front desk, not separate products.

1. An inbound message is normalized and associated with the Sunset tenant.
2. The system resolves the guest/contact without crossing tenant boundaries.
3. The conversation appears in the Staff Inbox with channel, guest, booking, lesson, waiver, and payment context where available.
4. Luna may prepare the next safe response from the same grounded business state.
5. Staff can review, edit, approve, or take over according to channel controls.
6. The reply and subsequent guest message remain visible in the guest's conversation history.

A guest may use more than one channel. Contact linking must be evidence-based; uncertain identities remain separate rather than being silently merged.

### Channel presentation

| Contract | WhatsApp | Email |
|---|---|---|
| Truth source | Identical grounded state | Identical grounded state |
| Shape | Short, conversational | Structured; paragraphs/lists allowed |
| Questions | One clear next step per reply | One or two grouped asks when useful |
| Confirmation | Only after durable truth | Only after durable truth |

---

## 2. Control and intervention model

Channel automation is tenant-global; conversation handling is local.

### Tenant-global controls

- **Channel mode:** Draft / Auto for each supported channel.
- **Global Pause:** stops automated handling across the tenant.
- **Auto-send:** a distinct activation boundary. Building email or drafting email does not imply automatic sending.

### Conversation-scoped controls

- **Luna On/Off:** whether Luna handles that conversation.
- **Needs Human / Requiere personal:** explicit staff ownership for that conversation.

For WhatsApp, automatic reply is allowed only when global mode is Auto, Global Pause is off, Luna is on for the conversation, and Needs Human is off. Email follows its own separately activated outbound policy. On Sunset staging, automatic outbound behavior remains off unless a separately approved activation changes it.

---

## 3. Rental journey

Sunset rentals mirror the live Admin catalog. Luna must not rely on a hardcoded list of bundles, prices, or durations.

```text
guest asks for rental
→ resolve live enabled offering
→ collect start + duration/tier + quantity
→ check configured stock/eligibility where required
→ Staff API returns exact quote
→ guest accepts
→ payment link from Staff API
→ Stripe truth
→ rental confirmed with grounded pickup details
```

Rules:

- Only enabled offerings may be presented or quoted.
- Quantity follows the configured/product limit; UI support for 1–99 is not permission to exceed stock or server rules.
- Daily requests use the exact configured tier when available; otherwise use the longest valid shorter tier according to the canonical quote owner.
- Hourly requests require an exact configured hourly tier.
- Luna never reconstructs a price from an old public-site table or prose prompt.
- A changed date, duration, offering, or quantity invalidates the old quote and requires a new one.
- Pickup location/instructions are stated only from current tenant configuration.

---

## 4. Lesson journey

Lessons are capacity- and schedule-sensitive.

```text
guest asks about lessons
→ explain the live lesson types before asking the guest to choose
→ collect/infer date + participants + relevant age/eligibility facts
→ resolve configured course/slot
→ Staff API checks season coverage and capacity
→ quote exact lesson and configured add-ons/equipment
→ guest accepts
→ payment link
→ Stripe truth
→ lesson confirmed with grounded arrival/meeting details
```

Rules:

- Course names, times, ages, capacities, beaches, included equipment, and add-ons come from live Sunset configuration.
- Private and group lessons follow their distinct quote paths.
- If a date is outside configured season coverage, Luna does not invent a price or silently use another season.
- If capacity or scheduling cannot be confirmed, Luna collects the request and routes it to staff without promising a place.
- Minors, guardian consent, custom groups, and eligibility exceptions follow explicit handoff policy.
- Arrival time and meeting point are stated only when configured.

---

## 5. Accommodation journey

Accommodation uses the inventory and package truth configured for Sunset. It is not automatically treated as unlimited inventory, nor automatically promised as a partner booking.

```text
guest asks for surf + stay
→ collect dates + party size + surf needs
→ resolve configured accommodation/package
→ Staff API checks authoritative inventory/coverage
→ confirmed inventory: exact quote → payment → confirmation
→ partner/manual inventory: request sent for confirmation; no promise or final quote
```

Rules:

- A room/package is quoted only when the source of truth covers the full requested stay.
- Uncovered nights, inventory gaps, or partner-controlled availability become an explicit manual-confirmation path.
- Luna never presents a partial-coverage quote as a complete stay.
- Special requests and changes remain staff-owned unless a canonical tool explicitly supports them.

---

## 6. Shared payment and confirmation journey

```text
verified quote
→ guest accepts
→ tenant-scoped payment link created
→ guest pays
→ Stripe webhook / canonical payment ledger records truth
→ booking balance and Finance agree
→ confirmation may be sent
```

Non-negotiable rules:

- No constructed or guessed payment URL.
- No `paid`, `held`, `reserved`, or `confirmed` language before durable payment/booking truth.
- A guest claiming payment without a matching record is a payment mismatch and requires staff.
- Staff-created Paid bookings must create canonical payment/collection truth; a visual status chip alone is insufficient.
- Refunds, cancellations, and paid booking changes are staff-owned and must use the canonical ledger paths.

---

## 7. Email journey

Email is part of Sunset's shared Inbox journey.

```text
inbound email
→ normalize sender and suppress system/noreply noise
→ bind to Sunset guest/conversation when evidence permits
→ show in Inbox
→ Luna prepares a grounded draft when enabled
→ staff reviews/edits/approves
→ approved outbound owner sends
→ sent message and later replies remain in conversation history
```

Email-specific rules:

- System senders such as noreply/mailer-daemon shapes do not become guest conversations.
- Drafting, approval, sending, and automatic sending are separate authorities.
- Operator notes are instructions, not guest-facing copy.
- Email may use sections or a compact quote summary, but prices, links, and confirmations retain the same deterministic truth ownership as WhatsApp.
- Generic IMAP/SMTP and provider-specific integrations must preserve the same tenant, identity, custody, and send gates.
- Campaigns/broadcasts and automatic outbound email are outside this journey unless separately approved and activated.

---

## 8. Staff handoff cases

Luna hands off for an explicit reason, not merely because model confidence is low.

| Trigger | Required behavior |
|---|---|
| Refund, cancellation, or paid booking change | Acknowledge safely; route to staff; promise no outcome |
| Complaint or angry guest | Brief empathy and staff ownership |
| Discount, custom deal, or unsupported group | Route for staff pricing |
| Capacity/inventory cannot be confirmed | Collect request; no availability promise |
| Minor/guardian or eligibility exception | Use safeguarding handoff |
| Guest claims paid but no canonical payment exists | Treat as payment mismatch |
| Partner accommodation exception | Route to staff/partner confirmation |
| Tool/API/parse failure | Safe fallback; invent nothing |
| Needs Human set or Luna switched off | Do not continue autonomous handling |

---

## 9. Cross-cutting behavior

- Explain live options before asking the guest to choose.
- Preserve known dates, party size, preferences, and prior answers across turns.
- Infer ordinary date expressions when safely resolvable; ask only for the missing ambiguity.
- Keep WhatsApp low-friction and ask one clear next question.
- Never expose internal language such as tenant, Staff API, composer, staging, dry run, or tool failure.
- Never leak Wolfhouse facts, inventory, prices, links, or voice into Sunset.
- Disabled offerings disappear from both staff-assisted and Luna-assisted sales paths.
- Staff portal labels and Luna-facing names should resolve from the same canonical item/course configuration.

---

## 10. Acceptance journeys

The maintained regression suite should cover at least:

1. Enabled rental → exact tier/quantity quote → payment → confirmation.
2. Disabled rental is neither offered nor quoted.
3. Rental duration/quantity correction invalidates and replaces the quote.
4. Group lesson with season coverage and capacity → exact quote → confirmation.
5. Private lesson uses its dedicated quote path.
6. Uncovered season date and full-capacity slot fail closed without invented alternatives.
7. Configured accommodation inventory quotes only fully covered nights.
8. Partner/manual accommodation requests do not claim availability.
9. Staff-created Paid booking produces matching invoice, balance, and Finance truth.
10. Inbound email → guest conversation → reviewed draft → approved send record.
11. System/noreply email is excluded from guest views.
12. Global Pause, channel mode, Luna Off, and Needs Human each block autonomous handling correctly.
13. No price, payment link, availability, or confirmation can be produced without its authoritative result.
14. Sunset and Wolfhouse facts remain isolated.

---

## 11. Activation boundaries

This journey document does not authorize:

- production deployment;
- automatic WhatsApp or email sending;
- customer outreach or campaigns;
- OAuth/grant mutations;
- payment, booking, refund, or inventory writes outside an approved test;
- real-customer contact.

Those remain separate reviewed and explicitly approved operations.
