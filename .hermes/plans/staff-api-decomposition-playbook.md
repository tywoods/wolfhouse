# Staff API Decomposition — Deckhand Playbook (standing brief)

Read this once. Each slice is then a 2-line pointer: "Slice N: extract `<vertical>` per the playbook; caveats: `<X>`." Proven on slices 1–3 (notification-settings, whatsapp-numbers, customers).

## Invariant recipe (every slice)
1. **Isolated worktree off current `origin/master`.** Behavior must be **byte-identical**.
2. **Extract** the vertical's `handle<Area>*` route handlers (+ their private helpers) out of `scripts/staff-query-api.js` into a new `scripts/lib/staff-<area>-routes.js`.
3. **DI factory:** export `create<Area>Routes({ ...deps })` — inject everything the handlers use (`sendJSON`, `send400`, `readBody`, `assertStaffClientAccess`, `appendAuditLog`, `withPgClient`, `DEFAULT_CLIENT`, `SQL_INJECT_RE`, plus any area-specific send/generate/query fns). **Zero reverse coupling** — the module must NOT `require('../staff-query-api')` or reach globals. Reuse existing `scripts/lib/*` helpers; never duplicate.
4. **Canonical route table** in the module: one row per route `{ id, method, path/regex, match, minRole }`. Export the paths/regexes for the router. Comment: "minRole must match router requireAuth exactly."
5. **Auth STAYS in the router.** `staff-query-api.js` keeps the `requireAuth(req, res, <role>)` call for each route, using the **exact same role per route as the base** (viewer/operator/admin — do NOT homogenize). Thin registration; preserve exact paths, methods, response body/status.
6. **Leave path-param sub-routes you didn't scope** inline (note it in a comment), like `whatsapp-numbers` DELETE `/:id` — partial extraction of a route family is fine.

## Verification (every slice — do not skip)
- New `verify-staff-<area>-routes.js` **contract test**: each route dispatches, **each route's exact role enforced** (viewer stays viewer, etc.), responses identical to base, no reverse coupling.
- Run existing adjacent suites for the area.
- `node --check` on the changed files. `/staff/ui` generated-page proof if the area has UI.

## Handoff
- **@Sea Dog on the thread** for direct review (auth-on-router, response contract byte-identical, no route drift, DI clean, per-route roles, area-specific caveats). Fix any BLOCK.
- Then hand Captain the **bundle + patch + sha256** at `/opt/data/workspace/patches/`. Captain gates (sha, clean-rebase, verifiers, adversarial), publishes to origin, deploys to Sunset with a rollback anchor. Deckhand can't push.

## Captain-side smoke (behavior-neutral extraction)
Unauth `GET/POST /staff/<route>` → **401** (route present + auth enforced), not 404 (route lost) or 500 (broken). Regex/`:id` routes need a matching-shaped id to reach auth. Confirm prior slices didn't regress.
