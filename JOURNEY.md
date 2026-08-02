# JOURNEY — shared dev status (Monshies + Earthling)

**Keyword: "Journey".** *"pull up the Journey"* → Captain/Skipper reads this back + brings you current. *"update the Journey"* → we save the current state here. Keep it terse — a living board, not docs. Whoever picks up / ships / deploys updates the matching section. Say *"I'm deploying X"* before deploying to avoid parallel-deploy collisions (deploy only from clean `HEAD == origin/master`).

_Last updated: 2026-08-02 17:45 UTC by Captain_

---

## ✅ Recently done
- `f784311b` P0e — standalone rental label from `tenant_rental_offerings.label` → "Surfboard + Wetsuit" shows the "+" everywhere (Sunset staging live)
- `17326f3d` P0d — rental pickups per-record scope + friendly labels everywhere
- `d30acc4e` P0c — staff schedule-quote €0 stub fixed (unified canonical classification)
- `34e4b7f3` P0b — standalone rental exact-key price authority (no alias €0 borrow)
- `927f9043` P0 — combo pricing: merge generic lines before create fingerprint
- Slices A–E (`0afd4829`→`c79da8aa`) — canonical course-equipment chain (quote lane, included gear, policy, one all-day mechanism)
- `1ea342ba` — this JOURNEY board added

## 🍳 On the stove (in progress)
- **Sunset rental/equipment thread** (Captain + Skipper) — all fixes shipped; **awaiting owner drawer/pickups retest** to confirm the "+" label + Admin-rename proof. If clean, thread closes.
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
