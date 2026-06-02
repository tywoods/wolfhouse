# Stage 8.1 — Dashboard UX Cleanup Plan

**Status:** PLANNING DONE (2026-06-02). Planning/docs only — builds nothing, deploys nothing, changes no UI. Defines the information architecture, default landing view, hidden/admin-only surfaces, and Luna design tokens for the Stage 8.2 visual implementation.
**Parent:** [`STAGE-8-CLIENT-READY-STAGING-ROADMAP.md`](STAGE-8-CLIENT-READY-STAGING-ROADMAP.md) — slice 8.1.
**Builds on:** [`PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md`](PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md) (dashboard views), [`PHASE-7.3F-DNS-CUSTOM-DOMAIN-STAGING.md`](PHASE-7.3F-DNS-CUSTOM-DOMAIN-STAGING.md) (hosted at `staff-staging.lunafrontdesk.com`).
**Implements next:** Stage 8.2 (visual polish), 8.3 (bed calendar), 8.4 (booking drawer).

> **Safety scope.** This is a UX plan only. No live operation, no staff writes, no send, no workflow activation. All Stage 8 safety flags hold: `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true`, `STRIPE_WEBHOOK_SKIP_VERIFY=false`, workflows inactive.

---

## 0. Current UI (reference — `scripts/staff-query-api.js`, do not edit)

Today the staff UI (`buildUiHtml`) renders:

- **3 top-level tabs:** `Conversations` (default/active) · `Bed Calendar` · `Query Tools`.
- **Conversations sub-tabs:** `Inbox` · `Needs Human` (handoff queue, with count badge).
- **Bed Calendar:** read-only occupancy grid (Stage 7.7h).
- **Query Tools:** registry-based intent query interface (Stage 6.8), developer-facing.
- **Booking context drawer:** opened from a conversation (Stage 7.7i).
- **Banner:** Luna Front Desk brand, `READ-ONLY • SHADOW MODE` badge, Sign out.

A **design-token system already exists** in `:root` (cream/sand/sage/dusty-blue/teal palette, radii, shadows, primary deep-sage). Stage 8.1 formalizes and extends it; Stage 8.2 applies it consistently.

**Gap for a client demo:** Query Tools is a peer top-level tab (developer surface front-and-center); there is no "Today / Needs Attention" landing view; the default landing is the raw Inbox; technical fields (intent names, confidence, raw JSON) can surface in staff view.

---

## 1. UX objective

Make the dashboard feel **simple, calm, polished, and immediately understandable** to Cami/Ale — a **hospitality front-desk tool**, not a developer/admin console. A first-time user should land on something that tells them *what needs attention today*, navigate with plain hospitality vocabulary, and never see raw intents, JSON, or debug fields unless they are an admin who opts in.

---

## 2. Primary users

| User | Role | Needs |
|---|---|---|
| **Cami** | Daily operator / front desk / booking ops | Fast "what needs me now" view; conversation review + draft copy; booking context; bed calendar. The dashboard is optimized for her. |
| **Ale** | Owner / admin | Higher-level visibility (today's state, occupancy, handoffs); same review surface; light admin. |
| **Ty / admin** | Developer / admin / debug | Everything Cami/Ale see **plus** Developer Tools (Query Tools, raw intents, JSON, technical detail). |
| **Later: other staff** | Viewer / operator roles | Role-scoped subsets (read-only viewers; operators with future write gates). |
| **Later: Sunset (client #2)** | Inventory / rental operator | Same shell, different vocabulary ("inventory/rentals" not "beds/rooms") and different "Today" tiles. Keep nav labels and tile model **configurable**, not Wolfhouse-hardcoded, where cheap to do so. |

---

## 3. Default landing view (decision)

**Options considered:**
- **A. Today / Needs Attention dashboard** — a summary landing showing what needs action now.
- **B. Conversations / Needs Human** — straight into the inbox/handoff queue.
- **C. Bed Calendar** — straight into occupancy.

**Decision: Option A — "Today / Needs Attention" is the default landing view after login.** It orients Cami immediately, avoids dropping her into a raw list, and demos well (it makes the dashboard look like a product, not a tool). Inbox remains one click away and is where she spends working time.

**"Today" landing tiles (read-only in Stage 8):**

| Tile | Source (existing) | Notes |
|---|---|---|
| **Needs Human** | handoff queue (`/staff/conversations` handoffs) | Count + top few; click → Handoffs. The single most important tile. |
| **Arrivals today** | bookings with check-in = today | Derived from existing booking/bed data. |
| **Departures today** | bookings with check-out = today | Same. |
| **Pending payments / holds** | existing payment/hold queries | Count + link; read-only. |
| **Occupancy snapshot / quick link** | bed calendar | Small summary + "Open Bed Calendar". |
| *(later)* Activity notes | add-ons: lessons / rentals / yoga / dinner / transfers | Deferred — placeholder card, clearly "coming soon" or hidden until 8.6 demo data + add-on surfacing exists. |

> The "Today" view is **assembled from existing read-only data/endpoints**. If a tile needs an endpoint that doesn't exist yet, it is deferred or shown as a friendly empty/coming-soon state — Stage 8.2 must not invent write paths or risky queries to populate tiles.

---

## 4. Top-level navigation

**Proposed staff-facing nav (left sidebar or top tabs — 8.2 picks the pattern; sidebar recommended for scalability):**

| Nav item | Visible to | Purpose |
|---|---|---|
| **Today** | all staff | Default landing — needs-attention summary. |
| **Inbox** | all staff | Conversation list + thread + Luna draft review/copy. |
| **Bed Calendar** | all staff | Read-only occupancy grid. |
| **Bookings** | all staff | Booking list + booking detail (drawer/page). *(Create Booking added later — manual booking creation track.)* |
| **Add-ons / Activities** | all staff | Lessons / rentals / yoga / dinner / transfers. *(Later — placeholder/hidden until data exists.)* |
| **Handoffs** | all staff | Full Needs Human / handoff queue (also surfaced on Today). |
| **Settings / Admin** | admin/owner | Account, role display, company info. |
| **Developer Tools** | **admin/dev only** | Query Tools, raw intents, JSON, debug. **Hidden from normal staff.** |

**Current → future mapping:**

| Current UI | Future nav |
|---|---|
| Conversations tab (Inbox sub-tab) | **Inbox** |
| Needs Human sub-tab | **Today** (summary tile) + **Handoffs** (full queue) |
| Bed Calendar tab | **Bed Calendar** |
| Booking context drawer | **Bookings** → booking detail |
| Query Tools tab | **Developer Tools** (admin/dev-only; removed from default staff nav) |
| *(future)* manual booking creation | **Bookings → Create Booking** (later track) |

> Implementation note for 8.2: this can be delivered as a **navigation re-grouping over the existing single-page UI** (show/hide panels by role) — no backend routing changes required. "Today" is the only genuinely new view and is composed from existing read endpoints.

---

## 5. What to hide / move before the demo

| Item | Action |
|---|---|
| **Query Tools** | Move out of default staff nav → **Developer Tools (admin/dev-only)**. Not front-and-center for Cami/Ale. |
| **Raw intent names** (e.g. `payment_or_confirm_intent`) | Hidden or admin-only; show plain-language labels in staff view. |
| **Debug / confidence / technical fields** | Collapse under a "Details" / "Admin" expander; hidden by default. |
| **Raw `client_slug`** | Display as **Company** (label already fixed in 7.3e); never show raw slug in primary staff view. |
| **Raw JSON / error payloads / stack traces** | Never shown in staff view; admin/dev mode only. Staff see friendly messages. |
| **Unimplemented buttons** (send, approve, edit-calendar, create-booking) | **Hidden**, or clearly **disabled with plain language** ("Not available in staging", "Coming soon") — never a dead button that looks live. |

**Admin/dev gating model:** role-based visibility. `admin`/`owner` (and Ty) see Developer Tools + Details expanders; `viewer`/`operator` (Cami's working role) do not. Gating is **display-only** in Stage 8 (no new permissions/writes); enforcement of write actions stays at the API safety-flag layer.

---

## 6. Ideal Cami workflow (shadow mode, end-to-end)

1. **Login** at `staff-staging.lunafrontdesk.com`.
2. Land on **Today / Needs Attention** — sees what needs her.
3. Open a **guest conversation** needing review (from Today or Inbox).
4. **Read the thread** (WhatsApp-like).
5. **Review / edit the Luna draft.**
6. **Copy the reply** for manual WhatsApp send (no live send button).
7. **Check booking context** (guest / stay / payment / rooming / add-ons).
8. **Check the bed calendar** (read-only).
9. **No accidental send. No confusing technical tools.**
10. **Sign out.**

Every step maps to an existing surface; Stage 8 polishes presentation and removes friction/clutter — it adds no new write capability.

---

## 7. Bed calendar UX cleanup (for Stage 8.3)

- **Natural room sorting:** `R1, R2, R3 … R10` (numeric-aware, not lexical `R1, R10, R2`).
- **Booking blocks more visible:** stronger block fills, clear guest label, readable on the date span.
- **Cleaner room grouping:** group beds under their room; subtle separators.
- **Better date header:** clear day/date, weekend shading, today marker.
- **Sticky side labels:** room/bed labels stay pinned while scrolling dates.
- **Easier to click bookings:** larger hit target; click → booking detail.
- **Empty beds recede:** empty cells visually quiet so occupancy stands out.
- **Read-only for demo:** **no drag/drop, no edit buttons** unless a later gate (7.7k8 + Cami/Ale sign-off) explicitly approves. Keep a clear, non-scary "View only" affordance.
- **Vocabulary note (Sunset):** "beds/rooms" is lodging-specific; keep the grid's row model conceptually "resource rows × date columns" so a rental/inventory grid can reuse it later. Document as Sunset-readiness debt; do not abstract now.

---

## 8. Booking drawer UX cleanup (for Stage 8.4)

Group into readable cards, in this order:

1. **Guest** — name, contact (Company shown, not raw slug), language.
2. **Stay** — dates, nights, room/bed, status.
3. **Payment** — amount, deposit/balance, payment status (read-only).
4. **Rooming** — assignment / preferences.
5. **Add-ons** — lessons / rentals / yoga / dinner / transfers (or empty state).
6. **Conversation / Handoff** — link back to thread + handoff status.
7. **Admin details** — collapsed expander (IDs, raw fields, audit) — admin/dev only.

Keep **"Booking edits are disabled"** present but **calm, not alarming** (e.g. a quiet inline note, not a red warning), consistent with the read-only/shadow framing.

---

## 9. Conversation UI cleanup

- **WhatsApp-like thread:** guest messages **left**, Luna/staff **right**.
- **Soft bubble colors:** guest = pale neutral/sand; Luna/staff = pale sage/teal; comfortable spacing, timestamps.
- **Draft composer clearly marked:**
  - Header: **"Draft — not sent"**.
  - Primary action: **"Copy and send manually in WhatsApp"** (copy-to-clipboard).
  - Editable text area for staff edits before copying.
- **Disabled approve/send:** **hidden** in staging, or clearly marked **"Not available in staging (shadow mode)"** — never a live-looking send button.

---

## 10. Visual design tokens (for Stage 8.2)

The existing `:root` token set already matches the Luna palette; 8.1 **formalizes** it as the canonical token table and fills gaps (status colors, full spacing scale, table/badge styles). Stage 8.2 applies these consistently across all views.

### 10.1 Color tokens

| Token | Value | Use |
|---|---|---|
| `--cream` (background) | cream (existing) | App background |
| `--surface` / card | white/cream (existing) | Cards, panels |
| `--sand` | `#E9DDCF` | Subtle fills, guest bubbles |
| `--sage` | `#AFC3A3` | Accents, active states |
| `--primary` | `#7E947D` (deep sage) | Primary buttons/actions |
| `--primary-hover` | `#6C8268` | Primary hover |
| `--dusty-blue` | `#B7CAD6` | Secondary accents, info |
| `--teal` | `#C7DDD7` | Staff/Luna bubbles, highlights |
| `--warning` (new) | muted amber | Warnings / "coming soon" / disabled notices |
| `--error` (new) | soft red | Errors only (never decorative) |
| `--text` | `#44504A` | Primary text |
| `--text-2` | `#6B756F` | Secondary text |
| `--text-3` | `#97A09A` | Muted/tertiary text |

### 10.2 Status colors (new, semantic)

| State | Token direction |
|---|---|
| OK / confirmed / paid | sage/green family |
| Pending / hold / awaiting | amber/sand family |
| Needs human / urgent | soft red/amber accent (badge, not full red panels) |
| Info / neutral | dusty-blue family |
| Disabled / read-only | muted grey-green (`--text-3`) |

### 10.3 Shape & depth

| Token | Value |
|---|---|
| `--radius` | `14px` (cards) |
| `--radius-sm` | `10px` (buttons, inputs) |
| `--radius-pill` | `999px` (badges/pills) |
| Card shadow | soft, low-opacity (existing `--shadow`) |

### 10.4 Spacing scale (formalize)

`4 · 8 · 12 · 16 · 20 · 24 · 32` (px). Cards pad `20–24`; section gaps `20`; inline gaps `8–12`.

### 10.5 Buttons

- **Primary:** deep-sage fill, white text, soft shadow.
- **Secondary:** sand/outline, dark text.
- **Disabled:** muted, no shadow, plain "not available" affordance.
- **Destructive:** reserved/soft-red — none enabled in Stage 8.

### 10.6 Pills / badges

- Mode badge: `READ-ONLY • SHADOW MODE` (existing).
- Status pills use §10.2 semantic colors; uppercase, letter-spaced, pill radius.

### 10.7 Tables

- Light row separators, generous row height, sticky headers where lists are long, muted secondary columns, numeric-aware sorting (e.g. rooms).

### 10.8 Typography direction

- Inter (existing). Sizes: body `14`, secondary `12–13`, section titles `16` bold, page/landing title `18–20`. Calm weights (400/600/700), comfortable line-height `1.5`.

---

## 11. Responsive behavior

- **Desktop-first** for Cami (primary working environment).
- **Tablet usable** (nav collapses sensibly; cards reflow to 1–2 columns).
- **Mobile not a Stage 8 priority** but **must not be broken** (no horizontal overflow, nav reachable, thread/draft legible).

---

## 12. Stage 8.2 implementation boundaries

- **Visual / HTML / CSS refactor only** (plus role-based show/hide of nav items).
- **No API changes** unless strictly required for display; if a "Today" tile needs a read-only aggregate, prefer composing from existing endpoints; any new endpoint must be **read-only, audited, GET-only**.
- **No write actions. No send. No workflow activation. No live WhatsApp/Stripe.**
- **Maintain all existing verifiers** (auth-api, query-api, query-ui, conversation-ui, bed-calendar-ui, login-ui).
- **Add UI verifier checks** for: Query Tools removed from default staff nav / gated admin-only; no live send button; disabled actions clearly marked; Company (not raw slug) in primary view.
- Keep `READ-ONLY • SHADOW MODE` messaging visible at all times.

---

## 13. Demo-readiness impact (Stage 8.0 §5 checklist)

This plan directly supports:

| Stage 8.0 ready-to-show item | How 8.1/8.2 supports it |
|---|---|
| Dashboard visually polished enough | §10 tokens + §4 nav + §1 objective |
| No empty / confusing dashboard on first view | §3 "Today" landing + friendly empty states |
| Cami workflow works end-to-end in shadow mode | §6 workflow + §8/§9 cleanup |
| Staff writes disabled (unless approved) | §5 hide/disable + §12 boundaries |
| Ty has a walkthrough script | §6 workflow is the spine of the 8.11 script |

Does **not** by itself satisfy: Cami/Ale accounts (8.8), demo data (8.6), backups/monitoring (8.9/8.10).

---

## 14. Sunset (client #2) readiness debt — captured, not built

Document-only list of Wolfhouse-specific assumptions to revisit before Sunset:

- "Beds / rooms" vocabulary in nav, bed calendar, booking drawer → generalize to "resources / inventory".
- "Today" tiles (arrivals/departures, occupancy) assume lodging → rentals need "out today / due back / stock" tiles.
- Surf-house package names / rooming concepts → rental SKUs (boards, wetsuits) by size/quantity/time-window.
- Keep nav labels and tile definitions **config-driven** where cheap; do not abstract the engine now.

---

## 15. Next slice

**Stage 8.2 — dashboard visual polish implementation:** apply §10 tokens, build the **Today** landing view from existing read-only data, re-group navigation per §4, move Query Tools to admin/dev-only per §5, and add the UI verifier checks in §12. Visual/HTML/CSS only; no writes, no live paths.
