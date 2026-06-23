# Sunset de-mess plan (operational + correctness)

**Created:** 2026-06-23, after a full day lost to "fixes that did nothing" + a recurring rental-price-save 500.
**Scope:** the *operational* and *correctness* messes. Complements `docs/SUNSET-ADMIN-EXTRACTION-PLAN.md`, which covers code structure (splitting the 40k-line `staff-query-api.js`) and is **not** duplicated here.

Wolfhouse and Sunset are one repo (`tywoods/wolfhouse`), one app, separated at runtime by `client_slug`. The DB layer is genuinely multi-tenant (`client_slug`/`tenant_id` everywhere). The app layer is not — it's ~200 `sunset`-named special-cases. Don't rewrite; de-mess incrementally. Build a generic multi-tenant framework only when a *third* client appears.

---

## P0 — Stop the bleeding ✅ DONE 2026-06-23
- Admin "+ add surf pack" fixed (misnamed `renderAdminPackEditForm` → `adminRenderPackEditForm`). `806bf72`.
- Rental price save 500 fixed: index-agnostic `SAVEPOINT` + retry-as-update in `upsertConfigPriceRule` (both create + update paths funnel through it). `6d6685a`.
- Added Postgres error logging + `code` in the response for price patch/create catches.
- `master` == staging image == `6d6685a`.

## P1 — Kill the "fixes that do nothing" trap (highest leverage)
1. **One canonical deploy source.** Staging Staff API builds **only** from `/opt/luna/Luna-Sunset` @ `master` on lunabox. `/opt/wolfhouse/WH` is Hermes/Luna scratch — never build Sunset from it. Delete the 3 stale duplicate modules there that load nothing: `scripts/tenant-admin-writes.js`, `scripts/lib/staff-query-api.js`, `scripts/sunset-admin-pack-rules.js`. _(destructive — needs go-ahead)_
2. **Laptop fresh clone** → `tywoods\luna\sunset`, work there only. Stops laptop-vs-deploy drift (the root cause of the lost day).
3. **Fix repo-sync tooling.** `scripts/check-repo-sync.js` false-fails when run on lunabox (it assumes it runs from the laptop and SSHes back). Make it environment-aware or document the lunabox-correct check (`git rev-list --left-right --count origin/master...HEAD`).

## P2 — Make failures visible (low risk, prevents blind debugging)
4. Add error logging to the remaining ~10 `error: 'write failed'` catches in `staff-query-api.js` (only the 2 price ones are done). Every swallowed 500 cost us guess-and-redeploy cycles.
5. Harden `scripts/verify-sunset-admin-render.js` to also scan `scripts/browser/sunset-admin-ui.js` for undefined-function calls — this exact gap let today's add-pack `ReferenceError` ship green.

## P3 — Retire the dual config/DB price path (the bug-breeding ground)
6. DB tables exist and `SUNSET_ADMIN_DB_READ_ENABLED=true`. Retire the config-file fallback (`cfg:` synthetic ids) for prices so every save targets a real DB row by UUID (in-place UPDATE), eliminating the find-then-insert collision class that caused today's 500.
7. **Resolve the index ambiguity.** Confirm whether the live unique index is `uq_tenant_price_rules_active_window` (021, client-wide) or the location-scoped variant (`023_..._PROPOSED`). Apply 023 properly or drop it — don't leave `_PROPOSED` ambiguity in production (it's why my first ON CONFLICT fix failed).

## P4 — Prune the branch graveyard (low risk after audit)
8. 43 stale `origin/captain/*` branches (12 sunset-admin/portal). Audit which are merged into `master`, delete the rest. _(destructive — needs go-ahead)_

## P5 — Modularize (big, separate track)
9. Execute `docs/SUNSET-ADMIN-EXTRACTION-PLAN.md` starting with PR1 (`sunset-admin-pure`). Defer until P1–P3 land.

## Deferred
- Generic multi-tenant abstraction — wait for client #3; premature at N=2.
