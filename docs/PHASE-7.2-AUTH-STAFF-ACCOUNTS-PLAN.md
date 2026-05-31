# Stage 7.2 — Auth Model + Staff Accounts Plan

**Status:** DESIGN DONE · **7.2b migration 009 APPLIED · 7.2c auth middleware scaffold APPLIED (local/dev, 2026-05-31)**. Production auth not built; staging NOT secure. See implementation log at bottom.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream B (auth and staff accounts).
**Depends on:** [`PHASE-7.1-ENV-SECRETS-INVENTORY.md`](PHASE-7.1-ENV-SECRETS-INVENTORY.md) (env separation, secrets manager, danger rules).
**Scope:** Design the production auth model for the staff API/UI before any staging/production write surface is enabled. Define staff users, roles, sessions/JWT, operator-token deprecation, action permissions, and go/no-go rules.

> This is a design document only. It builds nothing, enables nothing, and approves no live operation. The Stage 6.9 token (`STAFF_OPERATOR_TOKEN`) remains **local/dev only**. No production auth, roles, or TLS exist yet.

---

## 1. Objective

- **Replace** the local/dev operator token with a proper staging/production staff auth model.
- **Define** who can read (queries/reports/UI), who can act (resolve handoffs, mark tasks), and who can administer (manage users, edit config, flip write gates).
- **Define** exactly what must exist before any staff **write** surface is enabled in staging or production.

The current state (entering 7.2):
- Stage 6 staff API/UI is **local/dev only**, no auth.
- Stage 6.9 write endpoint (`POST /staff/handoff/:id/resolve`) is gated by a single shared `STAFF_OPERATOR_TOKEN` header + `STAFF_ACTIONS_ENABLED=true` flag — explicitly local/dev only ([`scripts/staff-query-api.js`](../scripts/staff-query-api.js) lines 66–74, 313–451).
- Audit log records `staff` (a free-text name) but **no authenticated identity** — there is no `staff_user_id`.

---

## 2. Auth model options + recommendation

| Option | What it is | Pros | Cons | Verdict for pilot |
|---|---|---|---|---|
| **A. Email/password + sessions** | Per-user account, `password_hash` (bcrypt/argon2), secure HTTP-only session cookie | Simple, self-contained, no external dependency, works offline/on-prem | Must store/rotate password hashes; build login/reset; CSRF handling | **RECOMMENDED for staging/pilot** |
| **B. Magic-link email login** | Email a one-time login link; no password | No password storage; low friction | Requires reliable transactional email; link interception risk; session still needed | Optional later; not pilot-critical |
| **C. Google OAuth / SSO** | Delegate identity to Google Workspace | No password handling; MFA via Google | External dependency; staff need Google accounts; more setup | Defer — overbuild for a 2–3 person pilot |
| **D. Managed auth provider** (Auth0/Clerk/Supabase Auth) | Hosted identity service | Battle-tested, MFA, social login | Cost, vendor lock-in, another secret to manage, data residency questions | Defer — overbuild for pilot |
| **E. Keep operator token** | Current Stage 6.9 shared header token | Already built | Shared secret, no per-user identity, no roles, not auditable per person | **Local/dev only** — never staging/prod |

### Recommendation (practical path)

1. **Local/dev:** keep `STAFF_OPERATOR_TOKEN` (Option E) **only** for local testing. It is never valid in staging/production.
2. **Staging / pilot:** real **per-user staff accounts** via **Option A** (email/password + hashed passwords + secure session cookies). Small fixed user set (Cami, Ale, optional staff). Server-side role enforcement.
3. **Production (later):** continue with Option A hardened (rate-limited login, lockout, optional MFA), or migrate to a **managed provider (D)** *only if* the operator count or compliance needs grow. Do **not** build enterprise SSO now.

**Guiding principle:** simplest safe path that gives per-user identity, server-side roles, and per-actor audit. Do not overbuild.

---

## 3. Staff roles

### Minimum roles (pilot)

| Role | Allowed reads | Allowed writes | Forbidden | Pilot default |
|---|---|---|---|---|
| **viewer** | All read-only reports/queries; staff UI dashboard | None | Any write action; config; user mgmt; enabling gates | Optional extra staff |
| **operator** | All viewer reads | Resolve handoffs; assign handoffs; mark tasks complete; (later) mark add-ons fulfilled / rentals returned / yoga redeemed | Edit client config; manage users; enable write gates; enable live WhatsApp/Stripe | Cami (operator + admin) |
| **admin** | All operator reads + audit logs | All operator writes + manage staff users + change client config + enable/disable staff write gate (`STAFF_ACTIONS_ENABLED` scope) | **Cannot** enable live WhatsApp/Stripe alone — that needs a separate owner-approval gate (Stage 7.8/7.9) | Cami, Ale |

### Optional later roles (deferred — design only)

| Role | Intent | Notes |
|---|---|---|
| **owner** | Ale — business owner; can record the owner-approval gate for live WhatsApp/Stripe enablement | Distinct from `admin`; owner approval is required to flip live-send/live-pay gates |
| **housekeeping** | Read rooms-to-clean; mark cleaning done | Scoped read + narrow write |
| **instructor** | Read lesson schedule; mark lessons delivered | Scoped to lesson/add-on domain |
| **finance** | Read payments/balances; export | Read-only financial scope; no message sends |

Roles are **additive**: a user may hold multiple (e.g. Cami = `operator` + `admin`). Authorization is the **union** of granted role permissions, except where an action explicitly requires an **owner-gate** record (live send/pay).

---

## 4. Permission matrix

`R` = allowed, `—` = forbidden, `G` = allowed only with a separate recorded gate/approval.

| Action | viewer | operator | admin | owner (later) |
|---|:--:|:--:|:--:|:--:|
| View dashboard | R | R | R | R |
| Query payments | R | R | R | R |
| Query rooming | R | R | R | R |
| Query add-ons | R | R | R | R |
| Query handoffs | R | R | R | R |
| Resolve handoff | — | R | R | R |
| Assign handoff | — | R | R | R |
| Mark task complete | — | R | R | R |
| Mark rental returned | — | R | R | R |
| Mark yoga redeemed | — | R | R | R |
| Edit lesson reminder settings | — | — | R | R |
| Edit client config | — | — | R | R |
| Enable staff write actions (`STAFF_ACTIONS_ENABLED` scope) | — | — | R | R |
| Enable live WhatsApp send | — | — | G | G |
| Enable live Stripe / payment links | — | — | G | G |
| Manage staff users | — | — | R | R |
| View audit logs | — | — | R | R |

**Notes:**
- "Enable live WhatsApp" and "Enable live Stripe" are **`G`** for everyone: even an admin/owner cannot flip them from the staff UI without the **separate Stage 7.8 / 7.9 gates** (owner approval + soak + monitoring). The UI must not offer a one-click toggle for these.
- Write actions beyond `handoff.resolve` (assign, mark task, add-on fulfilment) are **design-only** here; each gets its own slice + verifier when built, reusing this matrix.

---

## 5. Session / token model

### Mechanism
- **Session cookie (recommended for the browser UI):** opaque session ID stored server-side (in `auth_sessions`), set as an **HTTP-only, Secure, SameSite=Lax** cookie. Avoids exposing a bearer token to JS (XSS-resistant).
- **JWT (alternative / for service-to-service):** short-lived signed token. If used for the browser, must still be stored carefully; HTTP-only cookie storage preferred over `localStorage`.
- **Pilot choice:** server-side session cookie (simpler to revoke; no token-in-JS exposure).

### Lifecycle
| Concern | Rule |
|---|---|
| Expiration | Idle timeout (e.g. 30–60 min) + absolute max (e.g. 12 h); configurable |
| Refresh | Sliding renewal on activity up to the absolute max; no silent infinite refresh |
| Logout | Server deletes/invalidates the session row; cookie cleared |
| Revocation | Admin disabling a user (`disabled_at`) invalidates all their sessions |
| CSRF | Browser write actions (POST) require a CSRF token (double-submit cookie or per-session token header); `SameSite=Lax` is defense-in-depth, not sufficient alone for state-changing POSTs |
| XSS | No secrets in `localStorage`; HTTP-only cookies; inline UI keeps no token in JS (current Stage 6.8 UI has no auth and must gain it before staging) |
| Transport | Cookies `Secure` → **HTTPS required** in staging/production (Stage 7.3) |

### Audit actor linkage
- Every **write** action records `staff_user_id` **and** `role` (the role under which the action was authorized), plus existing fields (`ts`, `intent`, `client_slug`, `handoff_id`, `status_before/after`).
- The current audit log writes a free-text `staff` name only — this is **insufficient** for production: it is not tied to an authenticated identity and can be spoofed by anyone holding the shared token.

### Why the raw operator token is not enough for production
- **Shared secret:** one token for everyone → no individual accountability.
- **No identity:** audit cannot answer "who did this?" — only "someone with the token".
- **No roles:** cannot distinguish viewer vs operator vs admin.
- **No revocation per person:** rotating the token logs everyone out / requires redistributing the secret.
- **No session controls:** no expiry, no logout, no lockout.
- Therefore the operator token is **local/dev only** and must be rejected in staging/production (see go/no-go §9).

---

## 6. Database schema plan (migration 009 — DESIGN ONLY, not created)

Following the existing migration conventions (idempotent `CREATE TABLE IF NOT EXISTS`, `client_id UUID REFERENCES clients(id)`, `set_updated_at()` trigger, CHECK constraints for enums — see migrations 007/008). **Do not create migration 009 in this task.**

### `staff_users`
| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK DEFAULT gen_random_uuid()` | |
| `email` | `TEXT NOT NULL` | unique per deployment; login identifier |
| `display_name` | `TEXT` | shown in UI/audit |
| `password_hash` | `TEXT` | argon2/bcrypt; null if using magic-link/SSO later |
| `role` | `TEXT NOT NULL DEFAULT 'viewer'` | CHECK in (`viewer`,`operator`,`admin`,`owner`) — or use a join table (below) for multi-role |
| `last_login_at` | `TIMESTAMPTZ` | |
| `disabled_at` | `TIMESTAMPTZ` | non-null = account disabled, all sessions invalid |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | `updated_at` via trigger |

Unique index on `lower(email)`. Decision: single `role` column for the pilot (simplest); promote to a role join table only if multi-role per user is needed (Cami = operator+admin can be handled by an `admin`-implies-operator hierarchy).

### `auth_sessions` (a.k.a. `staff_sessions`)
| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | the opaque session id (or a hash of it) |
| `staff_user_id` | `UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |
| `last_seen_at` | `TIMESTAMPTZ` | for sliding expiry |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | absolute max |
| `revoked_at` | `TIMESTAMPTZ` | logout / admin revoke |
| `ip` / `user_agent` | `TEXT` | optional forensic metadata |

Index on `staff_user_id`; partial index on active (`revoked_at IS NULL AND expires_at > now()`).

### `staff_user_client_access` (optional — multi-client future)
| Column | Type | Notes |
|---|---|---|
| `staff_user_id` | `UUID REFERENCES staff_users(id) ON DELETE CASCADE` | |
| `client_id` | `UUID REFERENCES clients(id) ON DELETE CASCADE` | |
| `role` | `TEXT` | per-client role override |
| PK | `(staff_user_id, client_id)` | |

For the single-client Wolfhouse pilot this can be deferred; all users implicitly scope to `wolfhouse-somo`. Add when a second client onboards (pillar 8/14).

### Audit actor linkage
- Extend the audit record (today file-based JSONL) to include `staff_user_id` + `role`. Stage 7.1 already flagged promoting `logs/staff-query-log.jsonl` to durable storage; the auth fields land there. A future `staff_audit` table (or the durable audit store) references `staff_users(id)`.

---

## 7. API / auth changes required later (design — not implemented)

| Endpoint | Required in staging/production |
|---|---|
| `GET /staff/ui` | Requires authenticated session; unauthenticated → redirect to login |
| `GET /staff/intents` | Requires authenticated session (any role) |
| `GET /staff/query` | Requires authenticated session (any role ≥ viewer) |
| `POST /staff/handoff/:id/resolve` | Requires: (1) authenticated user, (2) `operator` or `admin` role, (3) `STAFF_ACTIONS_ENABLED=true`, (4) CSRF protection if browser-triggered, (5) audit records `staff_user_id` + `role` |
| Future write endpoints (assign, mark task, add-on) | Same shape: auth + role check (per matrix §4) + flag + CSRF + actor audit |

**Middleware shape (design):** a single auth middleware resolves the session cookie → `staff_user`; a `requireRole(...)` guard enforces the matrix; the existing feature-flag + allowlist guards remain. The operator-token path is compiled out / rejected unless `NODE_ENV`/env marks local-dev.

---

## 8. Security / go-no-go rules (hard blocks)

A staging/production deployment is **blocked** if any of the following is true:

1. **No HTTPS** for the staff UI/API (TLS is Stage 7.3; required before auth cookies).
2. **Write endpoint without an authenticated user** (no anonymous writes, ever).
3. **`STAFF_ACTIONS_ENABLED=true` without auth + TLS** both present.
4. **Shared operator token accepted in production** (`STAFF_OPERATOR_TOKEN` must be rejected outside local/dev).
5. **Admin config edits without `admin` role.**
6. **Live WhatsApp or live Stripe enabled from the staff UI** before the separate Stage 7.8 / 7.9 owner-approval gates.
7. **Any staff write not audited with an authenticated actor** (`staff_user_id` + `role` mandatory on writes).

These extend (not replace) the Stage 7.1 env danger rules.

---

## 9. Pilot staff model (Wolfhouse)

### Initial users
| Person | Role(s) | Can do | Cannot do |
|---|---|---|---|
| **Cami** | `admin` + `operator` | Review conversations (read), resolve/assign handoffs, use all reports, manage staff users, edit client config, view audit logs | Enable live Stripe/WhatsApp **alone** — requires recorded owner-approval gate |
| **Ale** | `admin` + `owner` | Everything Cami can, plus **record the owner-approval** that unlocks the live WhatsApp/Stripe gates (still subject to soak/monitoring gates) | Bypass the Stage 7.8/7.9 technical gates |
| Optional extra staff | `viewer` or `operator` | Reports (viewer) or reports + handoff resolution (operator) | Config, user mgmt, enabling gates |

**Default posture:** even with `admin`, no one flips live-send / live-pay from the UI. Those remain CLI/deploy-gated with an explicit owner-approval record (Stage 7.8/7.9). Enabling the **staff write surface** (`STAFF_ACTIONS_ENABLED` for handoff resolution) is an admin action **once auth + TLS exist**.

### Staff account onboarding checklist (per user)
- [ ] Admin creates `staff_users` row (email, display name, role).
- [ ] User receives a secure first-login (set password / magic link).
- [ ] User sets a strong password (if Option A); MFA later if adopted.
- [ ] Role verified against the permission matrix (§4).
- [ ] User confirmed in the pilot staff directory; access scoped to `wolfhouse-somo`.
- [ ] First login recorded (`last_login_at`); session policy explained.
- [ ] Offboarding path documented (set `disabled_at` → sessions invalidated).

---

## 10. Implementation slices (future — gated, not started)

| Slice | Name | Scope | Status |
|---|---|---|---|
| 7.2a | Auth design doc | This document | **DONE** |
| 7.2b | Migration 009 — `staff_users` / `auth_sessions` schema | Create + apply to dev DB; idempotent; verifier | PENDING |
| 7.2c | Local auth middleware static scaffold | Session/cookie middleware + `requireRole`; static verifier; no live enforcement | PENDING |
| 7.2d | Login / logout local proof | Local fixture users; login→session→logout cycle proven on dev | PENDING |
| 7.2e | API auth enforcement proof | `GET /staff/*` requires session in a staging-like mode; read paths gated | PENDING |
| 7.2f | Write endpoint role gate proof | `POST /staff/handoff/:id/resolve` requires operator/admin + flag + CSRF + actor audit; fixture-proven | PENDING |
| 7.2g | Staff user admin (deferral / plan) | Admin user-management surface; likely deferred to post-pilot | PLAN / DEFERRED |

Each implementation slice (7.2b+) is a separate approved task with its own static verifier and local proof, mirroring the Stage 6 discipline. None are started here.

---

## 11. Go / No-Go summary

**Stage 7.2 (design) PASS criteria — met by this doc:**
- Auth options evaluated; recommendation chosen (Option A for pilot; operator token local/dev only).
- Roles + permission matrix defined.
- Session/token model defined (cookie, expiry, CSRF/XSS, actor audit).
- Migration 009 schema designed (not created in design doc; **created in 7.2b**).
- API auth-enforcement changes specified.
- Hard go/no-go blocks defined.
- Pilot staff model + onboarding checklist defined.
- Implementation slices enumerated.

---

## Implementation log

### 7.2b — Migration 009 (PASS — 2026-05-31)

- **Created:** `database/migrations/009_auth_staff_users.sql`
- **Applied:** local/dev DB (localhost:5433 / wolfhouse)
- **Tables:** `staff_users` (6 indexes + 1 unique functional + 1 partial), `auth_sessions` (5 indexes + 1 unique + 2 partial)
- **Verifier:** `scripts/verify-auth-staff-migration.js` — 62 checks, PASS
- **DB proof:** `staff_users` 0 rows, `auth_sessions` 0 rows; protected tables unchanged (bookings 41, payments 25, payment_events 5, booking_beds 15, staff_handoffs 0)
- **Deferred (documented in migration):** `staff_user_client_access` join table; `NOW()` partial index (Postgres immutability constraint)
- **NOT done:** auth middleware, login/logout, password set, staff accounts, staging/production deployment

### 7.2c — Auth middleware scaffold (PASS — 2026-05-31)

- **Modified:** `scripts/staff-query-api.js` — added auth config, crypto helpers, cookie helpers, `loadAuthSession`, `requireAuth`, `handleLogin`, `handleLogout`; updated router with `/staff/auth/login`, `/staff/auth/logout`; added `STAFF_AUTH_REQUIRED` guards on all read routes; updated handoff.resolve gate to accept session (operator/admin) when `STAFF_AUTH_REQUIRED=true`, token when `false`
- **New env vars:** `STAFF_AUTH_REQUIRED`, `STAFF_SESSION_COOKIE_NAME`, `STAFF_SESSION_TTL_HOURS`, `STAFF_AUTH_HTTPS` (placeholders in `infra/.env.example`)
- **Verifier:** `scripts/verify-staff-auth-api.js` — 48 checks, PASS
- **Fixtures:** `scripts/fixtures/stage7.2c-auth-seed.sql` + `stage7.2c-auth-cleanup.sql` — viewer/operator/admin test users with scrypt-hashed passwords
- **Live proof (13 checks, PASS):** viewer login → query allowed → handoff.resolve 403 → logout → stale cookie 401; operator login → query allowed → handoff.resolve past auth gate (404, not 401/403); bad credentials 401; admin login; cleanup → 0 fixture rows, protected tables unchanged
- **Updated:** `scripts/verify-staff-query-api.js` (check 11 scoped to handleQuery; auth writes exempted)
- **Hash format:** `scrypt$N$r$p$<salt_hex>$<hash_hex>` (Node built-in crypto, zero new deps)
- **NOT done:** production auth; staging/prod TLS; real staff accounts; password reset; login UI; staging deployment

**NOT claimed:** production auth not implemented; staging/production not secure; no real staff credentials set; live operation not approved.
