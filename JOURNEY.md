# JOURNEY — shared dev status (Monshies + Earthling)

**Keyword: "Journey".** Say *"pull up the Journey"* and Captain/Skipper reads this back to you. Say *"update the Journey"* and we save the current state here. Keep it short — this is a living board, not documentation. Both humans and agents keep it current: pick up an area → add a line to **Now**; deploy → update **Live where**; ship → add to **Recently shipped**.

_Last updated: 2026-08-02 by Captain_

---

## 🛠 Now (in progress)
- **Sunset rental/equipment pricing+display thread** (Captain + Skipper) — canonical chain A–E + combo pricing P0–P0e all shipped & live. **Open:** owner drawer/pickups retest to confirm "+" label + rename-proof. Files: `sunset-schedule-*`, `rental-offering-label.js`, `sunset-bookable-offerings.js`, browser day-ops/cockpit/drawer.
- **UI redesigns** (Captain, planning only) — mockups delivered for booking-drawer item selector, rentals admin panel, pickups tag cleanup. Awaiting owner's pick before any build.
- **Earthling** — _add what you're on here._

## 📋 Next
- Sunset D/E/H live gates (policy / lane-replay / non-contiguous stock) — offline-green, need a staff `luna_staff_session` cookie for live exercise.
- **Crowsnest favicon deploy** — image `crowsnest:34e4b7f3…` built & in ACR, but **blocked**: this host's identity has no write on `luna-crowsnest-rg`. Needs Earthling (or crowsnest-RG access) to run the `az containerapp update`.
- UI redesign build (after owner picks a direction).
- Staff-API decomposition — more slices when resumed (1–5 shipped).
- Finance tab — deeper items (real refund ledger / true net).
- Deep disk clean on Lunabox (~20G reclaimable: stale clones + `docker image prune -a`) when agents idle.

## 🚀 Live where
| Environment | Deployed SHA | Rev | Notes |
|---|---|---|---|
| Sunset staging staff-api | `f784311b` | rev 0000450 | current |
| Wolfhouse staging/prod | _verify_ | — | not changed in this thread |
| Crowsnest (crowsnest-internal) | `b7eaba09` (old) | — | favicon `34e4b7f3` built, **deploy pending** (RBAC) |

> Deploy rule (both devs): build/deploy only from a clean tree where `HEAD == origin/master`; run `assert-deploy-from-master` + tag image with the master SHA. Say "I'm deploying X" before you do, to avoid overwriting a parallel merge.

## ✅ Recently shipped (Sunset staging, 2026-08-02)
- `f784311b` P0e — standalone rental label from `tenant_rental_offerings.label` (fixes "Surfboard + Wetsuit" "+")
- `17326f3d` P0d — rental pickups per-record scope + friendly labels everywhere
- `d30acc4e` P0c — staff schedule-quote €0 stub fixed (unified canonical classification)
- `34e4b7f3` P0b — standalone rental exact-key price authority (no alias €0 borrow)
- `927f9043` P0 — combo pricing: merge generic lines before create fingerprint
- `c79da8aa`…`0afd4829` Slices A–E — canonical course-equipment chain (quote lane, included gear, policy, one all-day mechanism)
- `aa79c573` etc. — see `git log origin/master` for full detail
