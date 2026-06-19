# Sunset Shared Inbox — Email + WhatsApp Foundation Plan

**Status:** approved planning doc (no runtime implementation in this commit)  
**Date:** 2026-06-19  
**Branch target:** `feat/sunset-shared-inbox-foundation`  
**Base:** `master` @ merge `6befd80` (Sunset portal demo home merged)  
**Parent docs:** `SUNSET-PORTAL-DEMO-PLAN.md`, `SUNSET-STAFF-PORTAL-V1-BUILD-PLAN.md`, `LUNA-SUNSET-OVERVIEW.md`, `SUNSET-GUEST-JOURNEY-DRAFT.md`

---

## Captain decisions (locked for this plan)

| Decision | Value |
|----------|-------|
| Product framing | **One shared Inbox** for guest email + WhatsApp |
| Channel priority | Email **slightly leads** (~55/45) in copy and sort affordances; both channels equal in the list |
| Thread model v1 | **Separate conversations per channel** — no auto-merge across email and WhatsApp |
| Cross-channel linking | **Later slice (3F)** — only when contact matching is safe and staff-visible |
| Wolfhouse | **No behavior change** when `client_slug=wolfhouse-somo` |
| Sunset staging | Continue isolated deploy (`luna-sunset-staging-staff-api` only) |
| This commit | **Docs only** — no migrations, seed execute, deploy, production, or Wolfhouse staging |

---

## Current state (post demo-home merge)

Sunset staff portal on staging (`https://sunset-staging.lunafrontdesk.com/staff/ui`):

| Surface | Status |
|---------|--------|
| Today dashboard | Live — demo cards, shared inbox copy |
| Inbox tab | Live — WhatsApp-shaped runtime |
| Day Schedule | Live — read-only surf schedule |
| bed-calendar / tour-operator | Hidden for Sunset (`is_surf_vertical`) |
| Profile-pending gate | Live — no Wolfhouse calendar flash |
| Demo copy | “Guest emails and WhatsApp messages…” |
| Email ingestion | **Not built** |
| Email in inbox list | **Not shown** |
| Channel badges / filters | **Not built** |

---

## 1. Product behavior

### v1 shared Inbox (Sunset)

1. **Single list** — Email and WhatsApp guest conversations appear in the same Inbox (`conversations` tab), sorted by recency and needs-attention signals.
2. **Channel badge on every row** — clearly labeled:
   - **Email**
   - **WhatsApp**
3. **Separate threads by default** — an email inquiry and a WhatsApp message from the same person remain **two conversations** until staff explicitly links them (3F) or a verified contact graph exists.
4. **No silent cross-channel merge** — do not infer “same guest” from name similarity, partial email, or phone digits alone.
5. **Email row shape** — show subject line (when present), guest email, last message preview, status/handoff pill.
6. **WhatsApp row shape** — show guest name/phone, last message preview, status/handoff pill (current behavior, plus badge).
7. **Filters** (Sunset/surf only):
   - All
   - Email
   - WhatsApp
   - Needs attention
8. **Empty state** — reuse surf copy already on master: “Guest emails and WhatsApp messages will appear here when they arrive.”
9. **Detail view** — opening a conversation shows channel-appropriate header (email: from + subject; WhatsApp: phone + display name), message thread, Luna draft, staff reply area.
10. **Wolfhouse unchanged** — Wolfhouse inbox remains WhatsApp-primary; no Email filter tab unless explicitly enabled for lodging tenants later.

### Later (explicitly not v1)

- Merged cross-channel thread view
- Automatic contact deduplication
- Email auto-send without staff action
- IMAP bi-directional sync with Sunset’s existing mailbox UI
- Booking sidebar join by email (today joins on `phone` only)

---

## 2. Current data model (inspected)

### Tables

| Table | Migration | Role |
|-------|-----------|------|
| `conversations` | `001_init.sql`, `003_rename_hostel_to_client.sql` | Inbox thread root |
| `messages` | `001_init.sql` | Thread messages |
| `staff_handoffs` | `008_add_staff_handoffs.sql` | Structured staff escalation |
| `guest_message_events` | `014_guest_message_events.sql` | WhatsApp ingress audit + dev handoff queue |
| `guest_message_sends` | `013_guest_message_sends.sql` | Outbound send log (`channel` default `whatsapp`) |
| `bot_pause_states` | (referenced in queries) | Luna pause per conversation |

### `conversations` — key columns today

| Column | Email relevance |
|--------|-----------------|
| `client_id` | Tenant scope — required |
| `phone` | **NOT NULL**, **`UNIQUE (client_id, phone)`** — blocks email-only threads |
| `email` | Nullable — populated rarely; **returned in detail API but not shown in UI** |
| `display_name` | Guest label |
| `status`, `bot_mode`, `needs_human` | Workflow |
| `last_message_preview`, `staff_reply_draft`, `last_bot_reply` | Inbox + reply |
| `metadata`, `session_state` | JSONB — Sunset seed puts `channel` here only |

**Gap:** No first-class `channel` column. Identity is phone-centric.

### `messages` — key columns today

| Column | Email relevance |
|--------|-----------------|
| `message_text` | Body |
| `direction` | `inbound` / `outbound` |
| `source` | TEXT, default **`whatsapp`** |
| `whatsapp_message_id` | Unique per client — WhatsApp-specific |
| `metadata` | JSONB — extensible |

**Gap:** No `email_message_id`, `subject`, or `thread_id`.

### `staff_handoffs` — key columns today

| Column | Email relevance |
|--------|-----------------|
| `source_channel` | CHECK **`whatsapp`, `staff`, `other`** — **no `email`** |
| `phone` | Present; no `email` column |
| `reason_code`, `status`, `priority` | Shared |

### Staff API — conversation endpoints (read)

| Route | Handler | Query module |
|-------|---------|--------------|
| `GET /staff/conversations?client=` | `handleConversationInbox` | `getConversationInboxQuery()` |
| `GET /staff/conversations/:id?client=` | `handleConversationDetail` | `getConversationDetailQuery()` |
| `GET /staff/conversations/:id/messages?client=` | `handleConversationMessages` | `getConversationMessagesQuery()` |
| `GET /staff/conversations/:id/context?client=` | `handleConversationContext` | bookings joined on **`conv.phone = b.phone`** |
| `GET /staff/conversations/:id/draft?client=` | `handleConversationDraft` | draft text |
| `GET /staff/inbox/message-events?client_slug=` | `handleInboxMessageEvents` | WhatsApp Meta audit |
| `GET /staff/inbox/handoffs?client_slug=` | `handleInboxHandoffs` | reads **`guest_message_events`**, not `staff_handoffs` |

**Inbox list API fields today:** `conversation_id`, `phone`, `guest_name`, `language`, `bot_mode`, `needs_human`, `conversation_status`, `conversation_stage`, `last_message_preview`, `pending_action`, `last_activity`, handoff fields, `booking_code`, `luna_paused`.

**Not exposed:** `channel`, `email`, `subject`.

### Staff API — write paths

| Route | Channel assumption |
|-------|-------------------|
| `POST /staff/inbox/send-reply` | Resolves **`conversations.phone`**; sends **WhatsApp only** (`sends_whatsapp`, `whatsapp_message_id`) |
| `POST /staff/conversations/:id/needs-human` | Channel-agnostic flag |

### Portal UI (`staff-query-api.js` embedded JS)

| Function / area | WhatsApp assumption |
|-----------------|---------------------|
| `loadInbox` / `renderInbox` | List shows **`conv-card-phone`** only |
| `loadConvDetail` | Header shows **`c.phone`**; **`c.email` ignored** |
| `setInboxFilter` | **`all` \| `needs-human`** only |
| `performInboxSend` | Success checks **`whatsapp_message_id`** |
| `loadHandoffsQueue` / `loadMessageEvents` | Filter by **phone** |
| Tab label | Wolfhouse: `nav.tab.whatsapp`; Sunset: `nav.tab.inbox` via `applySurfNavLabels` |

### Client profiles (`staff-portal-clients.js`)

Vertical gating only — **no channel gating**. Sunset profile: `is_surf_vertical`, hidden tabs, `portal-home` default, demo lesson slots.

### Tenant config (`config/clients/sunset.baseline.json`)

```json
"channels": {
  "whatsapp": { "status": "mvp", "enabled": false },
  "email": { "status": "planned_fast_follow", "enabled": false }
},
"deployment": { "email_inbox": null }
```

Golden fixture `fixtures/sunset-golden/sunset-golden-06-email-rental-inquiry.json` exists (`channel: "email"`, `active: false`) but is **not** in slice1 seed manifest.

---

## 3. Minimum v1 data shape

### Conversation (inbox list + detail)

| Field | Source (v1 recommendation) | Notes |
|-------|---------------------------|-------|
| `conversation_id` | `conversations.id` | existing |
| `channel` | **`conversations.metadata->>'channel'`** → migrate to column in 3B+ | `email` \| `whatsapp` |
| `guest_name` | `display_name` | existing |
| `guest_email` | `conversations.email` | required for email threads |
| `guest_phone` | `conversations.phone` | required for WhatsApp; nullable for email-only in 3B+ |
| `email_subject` | `conversations.metadata->>'email_subject'` or column | email rows only |
| `last_message_preview` | `last_message_preview` | existing |
| `last_activity` | `updated_at` | existing |
| `needs_human` | `needs_human` | existing |
| `handoff_status` | lateral join `staff_handoffs` | existing |
| `handoff_reason` | `staff_handoffs.reason_code` | existing |
| `luna_paused` | `bot_pause_states` | existing |
| `bot_mode` | `bot_mode` | existing |
| `unread` | **defer** — no read cursor today; optional badge in 3A mock | |
| `provider_thread_id` | metadata | Postmark/Mailgun/IMAP thread id — **store, don’t display v1** |
| `provider_message_id` | `messages.metadata` | dedupe key for inbound |

### Message (thread)

| Field | v1 |
|-------|-----|
| `message_id` | existing |
| `direction` | existing |
| `message_text` | existing |
| `source` | extend values: `whatsapp`, `email`, `staff` |
| `created_at` | existing |
| `subject` | metadata for email inbound/outbound |
| `from_email` / `to_email` | metadata |
| `whatsapp_message_id` | WhatsApp only |
| `email_message_id` | email only — dedupe |

### Identity rules (v1)

| Channel | Unique key per client | `phone` column | `email` column |
|---------|----------------------|----------------|----------------|
| WhatsApp | `(client_id, phone)` | required | optional |
| Email | `(client_id, email, email_thread_id)` or `(client_id, email)` for v1 simplicity | **sentinel or nullable** (schema decision in 3B) | required |

**Wolfhouse preservation:** Keep `(client_id, phone)` uniqueness for WhatsApp threads. Email threads use a parallel uniqueness strategy — do not relax Wolfhouse rows.

### Contact linking (3F — store only in v1)

Optional table or JSONB later:

| Field | Purpose |
|-------|---------|
| `contact_id` | Stable guest identity |
| `linked_conversation_ids[]` | Staff-confirmed links |
| `match_method` | `staff_manual` only in v1 of linking |
| `confidence` | never auto above threshold |

---

## 4. UI changes (Sunset / surf vertical)

### Inbox list row

```
┌─────────────────────────────────────────────────────────┐
│ [Email]  Elena Ruiz                    Needs attention  │
│          Subject: Rental and lesson enquiry             │
│          elena@example.com                              │
│          “We are visiting next month and would like…”   │
│          2h ago                                         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ [WhatsApp]  Marco                          Luna active  │
│             +34 612 345 678                             │
│             “Do you have boards for Friday?”             │
│             15m ago                                     │
└─────────────────────────────────────────────────────────┘
```

### Components to add (surf-gated)

| Element | Behavior |
|---------|----------|
| Channel badge | Pill: `Email` (dusty blue) / `WhatsApp` (green) |
| Subject line | Email rows only; truncate with ellipsis |
| Contact line | Email → `guest_email`; WhatsApp → `phone` |
| Preview | `last_message_preview` (strip subject prefix if duplicated) |
| Status pills | Existing: Needs Human, handoff, Luna paused |
| Filter bar | All · Email · WhatsApp · Needs attention |
| Empty state | Existing surf i18n keys |

### Detail panel

| Channel | Header |
|---------|--------|
| Email | From name, email address, **Subject:** line |
| WhatsApp | Display name, phone |

Reply composer:

| Channel | v1 behavior |
|---------|-------------|
| WhatsApp | Existing send-reply path |
| Email | **Read-only or draft-only** until 3E — show Luna draft, disable Send or label “Email send coming soon” |

### Wolfhouse

No new filters or badges unless `is_surf_vertical` — existing WhatsApp list unchanged.

---

## 5. Email ingestion strategy

### Options compared

| Approach | Pros | Cons | Sunset demo fit |
|----------|------|------|-----------------|
| **A. Forwarding to Luna inbound address** | Simple for owner; no mailbox credentials; works with any provider; easy staging (`inbox+sunset@…`) | Loses thread headers unless parsed; forwarding delays; SPF/DMARC on outbound separate | **Best for first real inbound demo** |
| **B. IMAP polling** | Reads real mailbox; thread-aware | Needs app password/credentials; polling lag; security burden; fragile with 2FA | Staging-only fallback if no webhook |
| **C. Provider webhook (Postmark / Mailgun / SendGrid Inbound)** | Structured JSON; message-id dedupe; reliable staging | DNS MX setup; vendor account; slightly more infra | **Best long-term production path** |

### Recommendation

**Phase 1 (3C staging):** Postmark or Mailgun **inbound parse webhook** → Luna Staff API route → normalize to conversation/message rows.

**Phase 0 (3A):** UI mock rows only — no ingress.

**Fallback if DNS blocked:** Single mailbox **auto-forward** to Luna inbound address while webhook is provisioned.

**Why not IMAP first:** Sunset’s provider is unknown; credential handling and 2FA friction are high for a demo. IMAP remains a documented fallback for “we already have info@sunsetsurf.com in Google Workspace.”

### Outbound (3E — separate from ingress)

| Concern | v1 stance |
|---------|-----------|
| SPF/DKIM | Required before live guest send; use provider domain or subdomain (`mail.lunafrontdesk.com` / `sunset.lunafrontdesk.com`) |
| From address | `Sunset Surf School <hello@…>` — confirm with owner |
| Reply-To | Inbound address for thread continuity |
| Auto-send | **Blocked** — staff must confirm send in portal |

### What to ask Sunset (Earthling checklist)

1. **Current email provider** — Google Workspace, Microsoft 365, Zoho, cPanel, other?
2. **Guest-facing address(es)** — e.g. `info@`, `bookings@`, `hello@`
3. **DNS access** — can they add MX / SPF / DKIM records for a subdomain?
4. **Forwarding** — can they forward/copy inbound mail to a Luna address?
5. **SMTP/API** — do they have API keys or app passwords available?
6. **Existing mailbox workflow** — do staff live in Gmail/Outlook today? (expectation setting)
7. **Outbound sender preference** — reply from their domain vs Luna subdomain?
8. **Languages** — English + Spanish email volume split?
9. **PII/consent** — any GDPR notes for storing guest email in Luna DB?

---

## 6. Staff workflow

### Expected employee flow (Sunset)

```
Today dashboard → Inbox card / tab
       ↓
Filter: All | Email | WhatsApp | Needs attention
       ↓
Select conversation
       ↓
Review thread + Luna draft (right panel)
       ↓
Staff: edit reply · Send (WhatsApp) · Mark needs human · Pause Luna
       ↓
(Optional) Open Day Schedule / booking context when linked
       ↓
Handoff resolved / reply sent / waiting on guest
```

| Step | Email v1 | WhatsApp v1 |
|------|----------|-------------|
| See new item in list | After 3D ingress | Existing |
| Read thread | Yes | Yes |
| See Luna draft | Yes | Yes |
| Staff edit draft | Yes | Yes |
| Staff send | **3E** — draft only or copy | Existing |
| Needs attention | `needs_human` + handoff pills | Same |
| Link to lesson/rental | Manual — staff uses Day Schedule | Same |
| Cross-channel “same guest” | **Not v1** — open two threads | |

---

## 7. Implementation slices

### Slice 3A — Inbox UI: channel badges + email-shaped mock rows

**Scope:** Surf vertical only. **No DB/API changes.** Mock email rows from client profile config (`portal_demo.inbox_threads`) or static fixture injected at session bootstrap.

| Deliverable | Detail |
|-------------|--------|
| Channel badge on list rows | Email / WhatsApp pills |
| Email row layout | subject, email, preview |
| Filter bar | All · Email · WhatsApp · Needs attention (client-side filter on mock + live WhatsApp) |
| Detail header | Show `email` + subject for mock email threads |
| Wolfhouse | Unchanged |
| Verifier | `verify:sunset-portal-v1` extended — badges, filters, no Wolfhouse regression |

**Risk:** Low. **Recommended first implementation slice.**

---

### Slice 3B — Store/import email fixture into conversations/messages (dry-run)

**Scope:** Extend seed manifest + guarded dry-run importer. Align seed column names with live schema (`message_text`, `reason_code`, `source_channel`).

| Deliverable | Detail |
|-------------|--------|
| Fixture | 1–2 email conversations from `sunset-golden-06` |
| Schema proposal | Doc-only migration draft: nullable `phone` for email threads OR sentinel phone; `metadata.channel`; optional `email_subject` |
| Import | Dry-run only — `ALLOW_SUNSET_DEMO_SEED` gates unchanged |
| API | Expose `channel`, `email`, `email_subject` on inbox list query |
| Identity | `(client_id, email, channel)` uniqueness for email |

**Risk:** Medium — schema touch requires careful Wolfhouse isolation.

---

### Slice 3C — Email provider decision + staging mailbox

**Scope:** Ops + config only on Sunset staging.

| Deliverable | Detail |
|-------------|--------|
| Provider choice | Postmark or Mailgun inbound |
| DNS | MX for staging subdomain |
| Config | `sunset.baseline.json` → `deployment.email_inbox`, `channels.email.enabled` |
| Secrets | Inbound webhook secret in Key Vault |
| Runbook | Earthling checklist answers documented |

**Risk:** Low code; blocked on Sunset DNS/provider answers.

---

### Slice 3D — Inbound email adapter

**Scope:** New route e.g. `POST /staff/inbound/email` or `/webhooks/email/inbound` (auth via webhook secret).

| Deliverable | Detail |
|-------------|--------|
| Normalize | Provider payload → conversation + message upsert |
| Dedupe | `email_message_id` / provider id |
| Threading | Match In-Reply-To / References → existing conversation |
| Tenant | Resolve `client_slug=sunset` from inbound address |
| Audit | Log to metadata; no auto-reply |

**Risk:** Medium — threading mistakes create duplicate conversations.

---

### Slice 3E — Outbound draft/send flow

**Scope:** Staff send email reply from portal.

| Deliverable | Detail |
|-------------|--------|
| API | Extend send-reply router with `channel=email` |
| Provider | Postmark/Mailgun outbound |
| UI | Send button enabled for email threads |
| Safety | Idempotency key; `live_send_allowed` gate; no auto-send |
| SPF/DKIM | Staging domain verified |

**Risk:** High — accidental guest email send; requires staging smoke + fail-closed gates.

---

### Slice 3F — Contact linking (later)

**Scope:** Staff-initiated link only.

| Deliverable | Detail |
|-------------|--------|
| UI | “Link with existing conversation” |
| Store | `contact_links` or metadata |
| Never | Auto-merge on fuzzy name match |

---

## 8. Verification

### Offline verifiers to add/extend

| Script | Checks |
|--------|--------|
| `verify:sunset-portal-v1` | Channel badges; email+WhatsApp copy; filters; Wolfhouse `nav.tab.whatsapp` preserved; surf-only gating |
| `verify:sunset-shared-inbox-ui` (new, 3A) | Mock email row markup; filter buttons; badge CSS; no bed-calendar regression |
| `verify:sunset-portal-slice1-seed` | Email fixture rows match schema (after 3B) |
| `verify:sunset-all` | Include new script when added |

### Wolfhouse preservation (every slice)

- `loadClientPortalProfile('wolfhouse-somo').default_tab === 'bed-calendar'`
- No Email filter tab on Wolfhouse
- Inbox list layout unchanged for non-surf vertical
- `(client_id, phone)` uniqueness unchanged for Wolfhouse rows

### Sunset staging browser smoke (after each slice)

| Check | |
|-------|---|
| Login Company=`sunset` | |
| Today dashboard loads | |
| Inbox shows Email + WhatsApp rows | |
| Channel badges visible | |
| Email filter works | |
| No Wolfhouse calendar flash | |
| bed-calendar / tour-operator hidden | |
| No Wolfhouse data in client list | |

### Security checks

| Check | |
|-------|---|
| Cross-tenant | Email webhook resolves tenant from **inbound address**, never from body |
| No accidental send | Email send requires explicit staff action + staging gate |
| Credential isolation | Webhook secrets in Key Vault; not in baseline JSON |
| Dedupe | Re-delivered webhooks do not duplicate messages |

---

## 9. Risks and open questions

| Risk | Mitigation |
|------|------------|
| Email provider unknown | Earthling checklist before 3C; mock UI in 3A unblocks demo |
| SPF/DKIM for sending | Use provider subdomain; no live send until verified (3E) |
| Duplicate imports / threading | Provider message-id dedupe; In-Reply-To match; idempotent upsert |
| Privacy / mailbox credentials | Prefer webhook over IMAP; no staff mailbox password in Luna |
| Cross-channel contact matching | Defer to 3F; manual link only |
| Staff approval before auto-send | Keep `live_send_allowed=false` for unverified pricing + email channel until Captain sign-off |
| Schema: `phone NOT NULL` | Migration must not break Wolfhouse; use channel-specific identity paths |
| `staff_handoffs.source_channel` CHECK | Add `email` value in migration when email handoffs go live |
| Handoff queue reads `guest_message_events` | Email handoffs may need parallel audit table or extend events schema |
| Copy ahead of plumbing | Already true — 3A mocks close the gap for Earthling demo |

### Open questions for Captain

1. Approve **Postmark vs Mailgun** as default inbound provider?
2. Approve **nullable phone** for email-only conversations vs sentinel phone value?
3. Should **Needs attention** filter include open `staff_handoffs` or only `needs_human`? (Today: `needs_human` only.)
4. Is **3A mock-only** acceptable for the next Earthling demo before real email ingress?

---

## Recommended first implementation slice

**Slice 3A — Inbox UI: channel badges + email-shaped mock rows**

Reasons:

- Matches merged demo copy immediately
- Zero migration / ingress / send risk
- Validates UX with Earthling before provider/DNS work
- Extends existing offline verifiers and surf gating patterns from demo-home merge
- Wolfhouse remains untouched via `is_surf_vertical` gate

---

## Files likely to change (by slice)

| Slice | Files |
|-------|-------|
| 3A | `scripts/staff-query-api.js`, `scripts/lib/staff-portal-i18n.js`, `scripts/lib/staff-portal-clients.js` (demo inbox threads config), `scripts/verify-sunset-portal-v1.js`, optional `config/clients/sunset.baseline.json` (`portal_demo.inbox_threads`) |
| 3B | `scripts/fixtures/sunset-portal-slice1-seed.js`, `fixtures/sunset-portal-slice1/seed-manifest.json`, `scripts/lib/staff-conversation-queries.js`, migration draft doc |
| 3C | `config/clients/sunset.baseline.json`, Key Vault secrets, `infra/azure/sunset-staging/` docs |
| 3D | New `scripts/lib/luna-email-inbound-*.js`, webhook route in `staff-query-api.js` |
| 3E | `scripts/lib/luna-staff-inbox-send-reply.js`, `scripts/lib/luna-guest-reply-send-route.js`, portal send UI |
| 3F | New contact-link module + UI |

### Files that must NOT change in 3A

| File | Reason |
|------|--------|
| `database/migrations/*` | No schema until 3B approved |
| Wolfhouse staging deploy | Isolated Sunset only |
| `docker/hermes-staging/SOUL.md` | Off limits |

---

## Appendix A — API field mapping (target)

```javascript
// GET /staff/conversations — per row (Sunset v1 target)
{
  conversation_id,
  channel,           // 'email' | 'whatsapp'
  guest_name,
  guest_email,       // nullable
  guest_phone,       // nullable for email-only
  email_subject,     // nullable
  last_message_preview,
  last_activity,
  needs_human,
  handoff_status,
  handoff_reason,
  luna_paused,
  bot_mode,
}
```

---

## Appendix B — Earthling → Sunset email discovery script

Use on intro call:

1. “What email address do guests use to contact you today?”
2. “Is that Google, Microsoft, or something else?”
3. “Who manages DNS for your domain?”
4. “Can you forward email to another address if we give you one?”
5. “Do you need replies to come **from** your existing address, or is a Luna subdomain OK for staging?”
6. “Roughly what share is email vs WhatsApp today?” (validate 55/45 assumption)

---

*End of plan — docs only; implementation begins with Slice 3A on a feature branch after Captain approval.*
