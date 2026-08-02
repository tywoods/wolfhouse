# JOURNEY — shared dev status (Monshies + Earthling)

**Keyword: "Journey".** *"pull up the Journey"* → Captain/Skipper reads this back + brings you current. *"update the Journey"* → we save the current state here. Keep it terse — a living board, not docs. Whoever picks up / ships / deploys updates the matching section. Say *"I'm deploying X"* before deploying to avoid parallel-deploy collisions (deploy only from clean `HEAD == origin/master`).

_Last updated: 2026-08-02 17:52 UTC by Captain_

---

## ✅ Recently done (last ~5 days)

**Aug 02** — Sunset rental/equipment overhaul: canonical course-equipment chain (Slices A–E) + combo-pricing fixes (P0–P0e) → included gear attaches, one all-day mechanism, standalone pricing correct, pickups per-record scope, friendly labels everywhere. Crowsnest favicon (built). This JOURNEY board added.

**Aug 01** — Luna Sunset de-hardcoding (catalog-driven Slices 1–2, catalog tool v2, rental-create P1/P1b/P1c, course-equipment P2). Staff-API decomposition Slices 1–5 (notification-settings, whatsapp-numbers, customers CRM, inbox, automated-notifications). Staff-API perf (gzip + non-blocking reconcile). Finance tab Option B Slice 1. Group Course edit-drawer polish. Owl favicon.

**Jul 31** — Schedule Day Cockpit (P1–P3 + clock-freeze + Timeline/Cards toggle + dark-mode polish). Rentals: independent catalog stock + transactional availability. Cancelled-booking lifecycle (restore / delete wording / finance exclusion). Templatable external Google-Form waiver.

**Jul 30** — Seasonal + multi-stay accommodation bookings. Rental qty steppers + day-tier continuation pricing + qty/duration integrity guards. Invoice display cleanup. Course-owned equipment shown on course cards. Staff-API decomposition plan + templating audit. Deckhand↔Seadog A2A-lite on the navigation thread. Lunabox DNS-fallback fix.

**Jul 29** — (rolled into the Jul 30 accommodation/rentals batch.)

## 🍳 On the stove (in progress)
- **Sunset rental/equipment thread** (Captain + Skipper) — all fixes shipped; **awaiting owner drawer/pickups retest** (confirm the "+" label + Admin-rename proof). If clean, thread closes.
- **UI redesigns** (Captain, planning only) — mockups delivered for booking-drawer item selector, rentals admin panel, pickups tag cleanup. **Awaiting owner's pick** before any build.
- **Earthling** — _add what you're on here._

## 📋 To do
- Sunset D/E/H live gates (policy / lane-replay / non-contiguous stock) — offline-green; need a staff `luna_staff_session` cookie for live exercise.
- **Crowsnest favicon deploy** — image `crowsnest:34e4b7f3…` built & in ACR; **blocked** (this host has no write on `luna-crowsnest-rg`) → Earthling runs the `az containerapp update`.
- UI redesign build (after owner picks a direction).
- Staff-API decomposition — more slices (1–5 shipped).
- Finance tab — deeper items (real refund ledger / true net).
- Lunabox deep disk clean (~20G: stale clones + `docker image prune -a`) when agents idle.

---

## 🚀 Live where
| Surface | Env | Deployed | Last modified | Notes |
|---|---|---|---|---|
| Sunset · staff-api | staging | `f784311b` (rev 0000450) | 2026-08-02 17:44 | Captain |
| Sunset · Luna (Hermes plugin + SOUL) | staging | `c79da8aa` (Slice E) | 2026-08-02 05:17 | Captain — separate deploy from staff-api |
| Wolfhouse · staff-api | **PROD** | _verify_ | — | Earthling territory |
| Wolfhouse · Luna (guest WhatsApp) | prod | _verify_ | — | Earthling territory |
| Crowsnest (crowsnest-internal) | live | `b7eaba09` (old) | — | favicon `34e4b7f3` built, **deploy pending** (RBAC → Earthling) |
| Marketing site (lunafrontdesk.com) | prod | _verify_ | — | Static Web App `luna-marketing` |

> Sunset staff-api & Sunset Luna deploy **separately** and can drift (as now). Sunset is staging-only (no prod client yet); Wolfhouse carries the live prod hostel.
