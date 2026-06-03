/**
 * Stage 6.6 / 6.8 — Read-only staff query HTTP API + thin staff UI.
 *
 * Minimal local/dev HTTP server wrapping the staff query registry.
 * Staff tools can GET safe, allowlisted Postgres queries without the terminal.
 *
 * Usage:
 *   node scripts/staff-query-api.js
 *   STAFF_QUERY_API_PORT=3036 node scripts/staff-query-api.js
 *
 * Endpoints:
 *   GET /staff/ui               — browser UI (Stage 6.8, read-only)
 *   GET /staff/intents          — list all allowlisted intents grouped by category
 *   GET /staff/query            — execute a single intent
 *
 * Query params for /staff/query:
 *   client    Client slug (default: wolfhouse-somo)
 *   intent    Intent key from the staff-query-registry
 *   date      YYYY-MM-DD
 *   start     YYYY-MM-DD (start_date for range queries)
 *   end       YYYY-MM-DD (end_date for range queries)
 *   booking   Booking code (e.g. WH-260528-1493)
 *   reason    Reason code (e.g. cancellation_request)
 *   staff     Staff name
 *   hours     Number of hours (e.g. 24)
 *   limit     Max rows to return (optional, server-side slice only)
 *
 * Safety constraints:
 *   - Read-only: only GET endpoints; no POST/PUT/PATCH/DELETE routes
 *   - Only registry-approved intents executed; no arbitrary SQL
 *   - All SQL from helperRef() only
 *   - No staff action runner
 *   - No workflow activation / no webhook POST
 *   - No Airtable writes / no Stripe calls
 *   - bookings, payments, payment_events, booking_beds, staff_handoffs
 *     never mutated
 *   - One audit log entry per query written to logs/staff-query-log.jsonl
 *
 * This is local/dev only — not production, no auth, no TLS.
 * Stage 6.6 is read-only. Write actions are Stage 6.5+ CLI only.
 */

'use strict';

const http   = require('http');
const url    = require('url');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Also load infra/.env as fallback (same pattern as pg-connect.js; root .env takes precedence)
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { withPgClient }       = require('./lib/pg-connect');
const { getEntry, REGISTRY, CATEGORIES } = require('./lib/staff-query-registry');
const { resolveHandoffSql }  = require('./lib/staff-handoff-write-sql');
const {
  getConversationInboxQuery,
  getConversationDetailQuery,
  getConversationMessagesQuery,
  getConversationContextQuery,
  getConversationDraftQuery,
  getConversationStaffStateQuery,
} = require('./lib/staff-conversation-queries');
const {
  getOpenHandoffsQuery,
  getNeedsHumanWithoutOpenHandoffQuery,
} = require('./lib/staff-handoff-queries');
const {
  getBedCalendarRoomsQuery,
  getBedCalendarBlocksQuery,
  getBedCalendarSummaryQuery,
} = require('./lib/staff-bed-calendar-queries');
const {
  getBookingDetailQuery,
  getBookingPaymentsQuery,
  getBookingRoomingAssignmentsQuery,
  getBookingConversationQuery,
  getBookingHandoffQuery,
  getBookingAddOnSummaryQuery,
  getBookingServiceRecordsQuery,
} = require('./lib/staff-booking-detail-queries');
const {
  reassignBookingBedSql,
} = require('./lib/staff-bed-reassignment-sql');
const {
  getManualBookingPreviewBedsQuery,
  getManualBookingPreviewAssignmentsQuery,
  getClientIdBySlugQuery,
} = require('./lib/staff-manual-booking-preview-queries');
const {
  previewManualBookingAvailability,
} = require('./lib/staff-manual-booking-availability');
const {
  buildManualBookingCreateSql,
  MANUAL_BOOKING_ALLOWED_ROLES,
} = require('./lib/staff-manual-booking-create-sql');
const {
  calculateWolfhouseQuote,
} = require('./lib/wolfhouse-quote-calculator');
const {
  getPauseState,
  pauseConversation,
  resumeConversation,
  formatPauseStateRow,
} = require('./lib/staff-bot-pause-sql');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT               = parseInt(process.env.STAFF_QUERY_API_PORT || '3036', 10);
const DEFAULT_CLIENT     = 'wolfhouse-somo';
const MAX_ROWS           = 500;
const LOG_DIR            = path.join(__dirname, '..', 'logs');
const LOG_FILE           = path.join(LOG_DIR, 'staff-query-log.jsonl');

// Write endpoint config — disabled unless explicitly enabled
const STAFF_ACTIONS_ENABLED  = process.env.STAFF_ACTIONS_ENABLED  === 'true';
const MANUAL_BOOKING_ENABLED = process.env.MANUAL_BOOKING_ENABLED === 'true';
// Stage 8.5.4 — Luna bot booking create via shared engine.
// BOT_BOOKING_ENABLED=false by default — must be explicitly set to true.
// Separate from MANUAL_BOOKING_ENABLED and WHATSAPP_DRY_RUN.
const BOT_BOOKING_ENABLED = process.env.BOT_BOOKING_ENABLED === 'true';
// Stage 8.8.27 — Luna bot guest add-on create (service row + optional payment + Stripe link).
const BOT_ADDON_REQUESTS_ENABLED = process.env.BOT_ADDON_REQUESTS_ENABLED === 'true';
// Phase 9.4b — Luna guest pause/resume writes (bot_pause_states SoT). Default OFF.
const BOT_PAUSE_CONTROLS_ENABLED = process.env.BOT_PAUSE_CONTROLS_ENABLED === 'true';
// Stage 8.4.9 — Stripe checkout link creation from draft payment records.
// STRIPE_LINKS_ENABLED must be explicitly set to 'true'; default false.
// STRIPE_SECRET_KEY must be a valid Stripe secret (sk_test_... or sk_live_...).
// Never hardcoded. Stripe test mode is the only supported mode in this slice.
const STRIPE_LINKS_ENABLED   = process.env.STRIPE_LINKS_ENABLED   === 'true';
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY      || null;
const STRIPE_SUCCESS_URL     = process.env.STRIPE_CHECKOUT_SUCCESS_URL || process.env.STRIPE_SUCCESS_URL || null;
const STRIPE_CANCEL_URL      = process.env.STRIPE_CHECKOUT_CANCEL_URL  || process.env.STRIPE_CANCEL_URL  || null;
// Stage 8.4.11 — Stripe webhook payment truth.
// STRIPE_WEBHOOK_SECRET: whsec_... from Stripe dashboard (or Stripe CLI for local testing).
//   Required unless STRIPE_WEBHOOK_SKIP_VERIFY=true.
// STRIPE_WEBHOOK_SKIP_VERIFY: ONLY for local/dev fixture testing. Never true in production.
//   Default false — production always verifies signatures.
const STRIPE_WEBHOOK_SECRET      = process.env.STRIPE_WEBHOOK_SECRET      || null;
const STRIPE_WEBHOOK_SKIP_VERIFY = process.env.STRIPE_WEBHOOK_SKIP_VERIFY === 'true';
const STAFF_OPERATOR_TOKEN   = process.env.STAFF_OPERATOR_TOKEN  || '';
// Stage 8.5.3 — Luna bot internal token for /staff/bot/* endpoints.
// Set LUNA_BOT_INTERNAL_TOKEN to a strong random secret (32+ chars) in infra/.env or Key Vault.
// When unset or empty: token auth path is disabled; /staff/bot/* falls through to normal session auth.
// Token auth ONLY applies to /staff/bot/* routes — never to normal staff endpoints.
const LUNA_BOT_INTERNAL_TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

// Stage 8.6.1 — Staff Ask Luna allowlist config path.
// File: config/clients/wolfhouse-somo.staff-whatsapp-allowlist.json
// Loaded lazily per-request so hot-edits take effect without restart.
const STAFF_ALLOWLIST_FILE = path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.staff-whatsapp-allowlist.json');

// Only handoff.resolve is allowed in v1
const WRITE_ACTION_ALLOWLIST = ['handoff.resolve'];

// Matches: /staff/handoff/<uuid>/resolve
const WRITE_HANDOFF_RE       = /^\/staff\/handoff\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resolve$/i;
// Stage 8.4.9 — POST /staff/payments/:payment_id/create-stripe-link
const PAYMENT_STRIPE_LINK_RE = /^\/staff\/payments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/create-stripe-link$/i;
// Stage 8.5.5 — POST /staff/bot/payments/:payment_id/create-stripe-link
const BOT_PAYMENT_STRIPE_LINK_RE = /^\/staff\/bot\/payments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/create-stripe-link$/i;

// Stage 7.7b — conversation route regexes (read-only GET)
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Stage 8.8.23 — POST /staff/bookings/:booking_id/service-records/create-payment-link
const BOOKING_SERVICE_RECORDS_PAYMENT_LINK_RE = new RegExp(
  `^/staff/bookings/(${UUID_RE})/service-records/create-payment-link$`, 'i',
);
const CONV_ID_RE  = new RegExp(`^/staff/conversations/(${UUID_RE})$`, 'i');
const CONV_SUB_RE = new RegExp(`^/staff/conversations/(${UUID_RE})/(messages|context|draft|staff-state)$`, 'i');

// Stage 7.7k3 — UUID validator for booking_bed_id query param
const UUID_VALIDATE_RE = new RegExp('^' + UUID_RE + '$', 'i');

// SQL for looking up booking_code from booking_bed_id (preview pre-flight)
// SELECT-only; no mutations.
const LOOKUP_BOOKING_CODE_SQL = `
  SELECT b.booking_code
  FROM booking_beds bb
  INNER JOIN bookings b  ON b.id        = bb.booking_id
  INNER JOIN clients  c  ON c.id        = bb.client_id
  WHERE bb.id = $1::uuid
    AND c.slug = $2
  LIMIT 1
`;

// ─────────────────────────────────────────────────────────────────────────────
// Auth config (Stage 7.2c scaffold)
//
// STAFF_AUTH_REQUIRED=false  ← local/dev default; set true to enforce sessions
// STAFF_SESSION_COOKIE_NAME  ← cookie name (default: luna_staff_session)
// STAFF_SESSION_TTL_HOURS    ← session lifetime (default: 12 h)
// STAFF_AUTH_HTTPS=true      ← adds Secure flag to cookie (staging/prod)
//
// When STAFF_AUTH_REQUIRED=false, all read routes are open (local/dev compat).
// When STAFF_AUTH_REQUIRED=true,  all routes require a valid session + role.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_AUTH_REQUIRED = process.env.STAFF_AUTH_REQUIRED === 'true';
const COOKIE_NAME         = process.env.STAFF_SESSION_COOKIE_NAME || 'luna_staff_session';
const SESSION_TTL_HOURS   = parseInt(process.env.STAFF_SESSION_TTL_HOURS || '12', 10);
const STAFF_AUTH_HTTPS    = process.env.STAFF_AUTH_HTTPS === 'true';

// Role hierarchy: higher rank = superset of permissions
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };
function hasRole(userRole, minRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers (Node built-in crypto — zero new dependencies)
// ─────────────────────────────────────────────────────────────────────────────

// Session tokens: 256-bit random, only stored as SHA-256 hash in DB.
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Password format: scrypt$<N>$<r>$<p>$<salt_hex>$<hash_hex>
// N=16384, r=8, p=1, keylen=32 — OWASP-acceptable minimums for scrypt.
// password_hash NULL means account is not yet activated (login will fail).
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hashHex] = parts;
  try {
    const expected = crypto.scryptSync(password, salt, SCRYPT_KEYLEN,
      { N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10) });
    const actual = Buffer.from(hashHex, 'hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookie helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const header  = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_HOURS * 3600}`,
    'Path=/staff',
  ];
  // Secure flag: only set when STAFF_AUTH_HTTPS=true (staging/prod with TLS).
  // Local/dev omits Secure intentionally to work over http://127.0.0.1.
  if (STAFF_AUTH_HTTPS) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/staff`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session loader — reads cookie, validates against auth_sessions + staff_users
// ─────────────────────────────────────────────────────────────────────────────

async function loadAuthSession(req) {
  const cookies  = parseCookies(req);
  const rawToken = cookies[COOKIE_NAME];
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);

  return withPgClient(async (pgClient) => {
    const result = await pgClient.query(
      `SELECT su.id::text        AS staff_user_id,
              su.email,
              su.role,
              su.status,
              su.display_name,
              su.client_id::text AS client_id,
              c.slug             AS client_slug,
              s.id::text         AS session_id,
              s.expires_at,
              s.revoked_at
         FROM auth_sessions s
         JOIN staff_users su ON su.id = s.staff_user_id
         JOIN clients    c  ON c.id  = su.client_id
        WHERE s.session_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > NOW()
          AND su.status    = 'active'`,
      [tokenHash]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    // Slide last_seen_at (fire and forget — no await to avoid blocking response)
    pgClient.query(
      'UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1::uuid',
      [row.session_id]
    ).catch(() => {});
    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// requireAuth — returns {ok, user} or sends 401/403 and returns {ok:false}
// When STAFF_AUTH_REQUIRED=false: always returns {ok:true, user:null} (no-auth mode)
// ─────────────────────────────────────────────────────────────────────────────

async function requireAuth(req, res, minRole) {
  if (!STAFF_AUTH_REQUIRED) return { ok: true, user: null };

  let user;
  try {
    user = await loadAuthSession(req);
  } catch (_) {
    sendJSON(res, 500, { success: false, error: 'auth session lookup failed' });
    return { ok: false };
  }

  if (!user) {
    sendJSON(res, 401, {
      success:  false,
      error:    'Authentication required. POST /staff/auth/login first.',
      auth_url: '/staff/auth/login',
    });
    return { ok: false };
  }

  if (minRole && !hasRole(user.role, minRole)) {
    sendJSON(res, 403, {
      success:      false,
      error:        `Role '${minRole}' or higher required.`,
      current_role: user.role,
    });
    return { ok: false };
  }

  return { ok: true, user };
}

// ─────────────────────────────────────────────────────────────────────────────
// requireBotAuth — auth for /staff/bot/* endpoints only (Stage 8.5.3)
//
// Extends requireAuth with an additional bot-token path:
//   1. STAFF_AUTH_REQUIRED=false → open (local/dev), auth_mode='open'
//   2. Valid X-Luna-Bot-Token or Authorization: Bearer header matching
//      LUNA_BOT_INTERNAL_TOKEN → auth_mode='bot_token'
//   3. Otherwise → delegate to normal session cookie auth → auth_mode='session'
//
// Safe defaults:
//   - If LUNA_BOT_INTERNAL_TOKEN is empty: token path is DISABLED.
//     The endpoint requires a normal staff session instead.
//   - Wrong token → 401, same as missing session.
//   - Token NEVER echoed in any response.
//   - Token auth ONLY called from /staff/bot/* router blocks.
//     Normal staff endpoints use requireAuth exclusively.
// ─────────────────────────────────────────────────────────────────────────────

async function requireBotAuth(req, res) {
  // 1. No-auth open mode (local/dev)
  if (!STAFF_AUTH_REQUIRED) return { ok: true, user: null, auth_mode: 'open' };

  // 2. Bot token path — only active when LUNA_BOT_INTERNAL_TOKEN is configured
  if (LUNA_BOT_INTERNAL_TOKEN) {
    const rawHeader = req.headers['x-luna-bot-token'] || '';
    const bearerHeader = req.headers['authorization'] || '';
    const bearerToken = bearerHeader.startsWith('Bearer ')
      ? bearerHeader.slice(7).trim()
      : '';
    const provided = rawHeader || bearerToken;

    if (provided) {
      // Constant-time comparison to prevent timing attacks
      const configBuf   = Buffer.from(LUNA_BOT_INTERNAL_TOKEN, 'utf8');
      const providedBuf = Buffer.from(provided, 'utf8');
      const match = configBuf.length === providedBuf.length &&
        crypto.timingSafeEqual(configBuf, providedBuf);
      if (match) {
        return { ok: true, user: { role: 'operator', staff_user_id: 'luna-bot-internal' }, auth_mode: 'bot_token' };
      }
      // Token provided but wrong → 401 immediately (do not fall through to session)
      sendJSON(res, 401, {
        success: false,
        error:   'Invalid bot token.',
      });
      return { ok: false };
    }
  }

  // 3. Fall through to normal session cookie auth
  let user;
  try {
    user = await loadAuthSession(req);
  } catch (_) {
    sendJSON(res, 500, { success: false, error: 'auth session lookup failed' });
    return { ok: false };
  }

  if (!user) {
    sendJSON(res, 401, {
      success:  false,
      error:    'Authentication required. Provide X-Luna-Bot-Token header or POST /staff/auth/login first.',
      auth_url: '/staff/auth/login',
    });
    return { ok: false };
  }

  return { ok: true, user, auth_mode: 'session' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/auth/login
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogin(req, res) {
  const started = Date.now();
  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }

  const clientSlug = String(body.client   || '').trim();
  const email      = String(body.email    || '').toLowerCase().trim();
  const password   = String(body.password || '');

  if (!clientSlug || !email || !password) {
    return send400(res, 'client, email, and password are required');
  }
  if (SQL_INJECT_RE.test(clientSlug) || SQL_INJECT_RE.test(email)) {
    return send400(res, 'invalid client or email');
  }

  let user;
  try {
    user = await withPgClient(async (pgClient) => {
      const r = await pgClient.query(
        `SELECT su.id::text        AS id,
                su.email,
                su.role,
                su.status,
                su.display_name,
                su.password_hash,
                su.client_id::text AS client_id,
                c.slug             AS client_slug
           FROM staff_users su
           JOIN clients c ON c.id = su.client_id
          WHERE c.slug         = $1
            AND lower(su.email) = $2
            AND su.status       = 'active'`,
        [clientSlug, email]
      );
      return r.rows[0] || null;
    });
  } catch (err) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'action:api:auth.login',
      category: 'staff_auth', client_slug: clientSlug, email,
      success: false, error: 'db_error', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, { success: false, error: 'auth lookup failed' });
  }

  // Constant-time comparison — no user-not-found vs wrong-password oracle.
  // If user not found, still run verifyPassword against a dummy hash.
  const hashToCheck = (user && user.password_hash)
    ? user.password_hash
    : `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$deadbeef00000000000000000000000000$` +
      '0'.repeat(64);
  const ok = user !== null && verifyPassword(password, hashToCheck);

  if (!ok) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'action:api:auth.login',
      category: 'staff_auth', client_slug: clientSlug, email,
      success: false, error: 'invalid_credentials', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 401, { success: false, error: 'Invalid credentials.' });
  }

  // Create session
  const rawToken  = generateSessionToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();

  try {
    await withPgClient(async (pgClient) => {
      await pgClient.query(
        `INSERT INTO auth_sessions
           (staff_user_id, client_id, session_token_hash, expires_at, last_seen_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, NOW())`,
        [user.id, user.client_id, tokenHash, expiresAt]
      );
      await pgClient.query(
        'UPDATE staff_users SET last_login_at = NOW() WHERE id = $1::uuid',
        [user.id]
      );
    });
  } catch (err) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'action:api:auth.login',
      category: 'staff_auth', client_slug: clientSlug, email,
      success: false, error: 'session_create_failed', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, { success: false, error: 'session creation failed' });
  }

  setSessionCookie(res, rawToken);
  appendAuditLog({
    ts: new Date().toISOString(), intent: 'action:api:auth.login',
    category: 'staff_auth', client_slug: clientSlug,
    email: user.email, role: user.role, success: true, elapsed_ms: Date.now() - started,
  });

  return sendJSON(res, 200, {
    success:      true,
    message:      'Logged in.',
    role:         user.role,
    email:        user.email,
    display_name: user.display_name || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/auth/logout
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogout(req, res) {
  const started  = Date.now();
  const cookies  = parseCookies(req);
  const rawToken = cookies[COOKIE_NAME];

  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    try {
      await withPgClient((pgClient) =>
        pgClient.query(
          `UPDATE auth_sessions SET revoked_at = NOW()
            WHERE session_token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash]
        )
      );
    } catch (_) {}
  }

  clearSessionCookie(res);
  appendAuditLog({
    ts: new Date().toISOString(), intent: 'action:api:auth.logout',
    category: 'staff_auth', success: true, elapsed_ms: Date.now() - started,
  });

  return sendJSON(res, 200, { success: true, message: 'Logged out.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Maps URL query param names → registry param names
// ─────────────────────────────────────────────────────────────────────────────

const PARAM_MAP = {
  date:    'date',
  start:   'start_date',
  end:     'end_date',
  booking: 'booking_code',
  reason:  'reason_code',
  staff:   'staff_name',
  hours:   'hours',
};

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

const SQL_INJECT_RE = /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i;

function guardParam(name, value) {
  if (SQL_INJECT_RE.test(String(value))) throw new Error(`unsafe chars in param '${name}'`);
  if (String(value).length > 300) throw new Error(`param '${name}' too long`);
  return String(value).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Param resolver
// ─────────────────────────────────────────────────────────────────────────────

function resolveParams(entry, clientSlug, query) {
  const params  = [clientSlug];
  const used    = {};
  const missing = [];

  const allSpecs = [
    ...entry.requiredParams.map((p) => ({ ...p, required: true })),
    ...entry.optionalParams.map((p) => ({ ...p, required: false })),
  ];

  for (const spec of allSpecs) {
    // Find the URL param name that maps to this registry param
    const urlKey = Object.entries(PARAM_MAP).find(([, v]) => v === spec.name)?.[0];
    let value = urlKey ? query[urlKey] : undefined;

    if (!value) {
      if (spec.required) { missing.push(spec.name); continue; }
      value = spec.default === 'TODAY'
        ? new Date().toISOString().slice(0, 10)
        : spec.default != null ? String(spec.default) : null;
      if (value == null) continue;
    }

    const cleaned = guardParam(spec.name, value);
    params.push(cleaned);
    used[spec.name] = cleaned;
  }

  return { params, used, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

function appendAuditLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON response helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendJSON(res, statusCode, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store',
    'X-Powered-By':  'wolfhouse-staff-api/6.6',
  });
  res.end(data);
}

function send400(res, message) {
  sendJSON(res, 400, { success: false, error: message });
}

function send404(res) {
  sendJSON(res, 404, { success: false, error: 'Not found' });
}

function send405(res) {
  res.writeHead(405, { Allow: 'GET' });
  res.end(JSON.stringify({ success: false, error: 'Method not allowed — this API is read-only (GET only)' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /staff/intents
// ─────────────────────────────────────────────────────────────────────────────

function handleIntents(res) {
  const grouped = {};
  for (const cat of CATEGORIES) {
    grouped[cat] = REGISTRY
      .filter((e) => e.category === cat)
      .map((e) => ({
        key:              e.key,
        description:      e.description,
        requiredParams:   e.requiredParams.map((p) => p.name),
        optionalParams:   e.optionalParams.map((p) => p.name),
        migrationRequired: e.migrationRequired || null,
      }));
  }
  sendJSON(res, 200, {
    success:    true,
    categories: CATEGORIES,
    intents:    grouped,
    total:      REGISTRY.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /staff/query
// ─────────────────────────────────────────────────────────────────────────────

async function handleQuery(query, res) {
  const started    = Date.now();
  const intentKey  = (query.intent || '').trim();
  const clientSlug = (query.client || DEFAULT_CLIENT).trim();

  // Validate client slug
  if (SQL_INJECT_RE.test(clientSlug)) {
    return send400(res, 'invalid client slug');
  }

  // Intent must be provided
  if (!intentKey) {
    return send400(res, 'missing required param: intent');
  }

  // Intent must be in registry
  const entry = getEntry(intentKey);
  if (!entry) {
    return send400(res, `unknown intent: '${intentKey}' — see GET /staff/intents for allowlist`);
  }

  // Safety guards
  if (entry.readOnly !== true || entry.clientSlugged !== true) {
    return send400(res, `intent '${intentKey}' is not safe for API execution`);
  }
  if (entry.missingHelper === true || typeof entry.helperRef !== 'function') {
    return send400(res, `intent '${intentKey}' has no query helper implemented yet`);
  }

  // Resolve params
  const { params, used, missing } = resolveParams(entry, clientSlug, query);
  if (missing.length > 0) {
    return send400(res, `missing required params: ${missing.join(', ')}`);
  }

  // Execute
  let rows = [];
  let success = true;
  let errorMsg = null;
  try {
    const sql = entry.helperRef();
    rows = await withPgClient(async (client) => {
      const result = await client.query(sql, params);
      return result.rows;
    });
  } catch (err) {
    success  = false;
    errorMsg = err.message;
    appendAuditLog({
      ts:          new Date().toISOString(),
      intent:      `api:${intentKey}`,
      category:    'staff_api',
      client_slug: clientSlug,
      params:      used,
      row_count:   0,
      success:     false,
      error:       errorMsg,
      elapsed_ms:  Date.now() - started,
    });
    return sendJSON(res, 500, { success: false, error: 'query execution failed', detail: null });
  }

  // Apply optional limit
  const limit = parseInt(query.limit, 10);
  const sliced = (!isNaN(limit) && limit > 0) ? rows.slice(0, Math.min(limit, MAX_ROWS)) : rows.slice(0, MAX_ROWS);

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts:          new Date().toISOString(),
    intent:      `api:${intentKey}`,
    category:    'staff_api',
    client_slug: clientSlug,
    params:      used,
    row_count:   rows.length,
    success:     true,
    error:       null,
    elapsed_ms:  elapsed,
  });

  sendJSON(res, 200, {
    success:         true,
    intent:          intentKey,
    category:        entry.category,
    client_slug:     clientSlug,
    params:          used,
    row_count:       rows.length,
    rows_returned:   sliced.length,
    rows:            sliced,
    elapsed_ms:      elapsed,
    migration_note:  entry.migrationRequired || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/ask-luna  (Stage 8.6.1 — staff operational query via text)
//
// Accepts a natural-language staff question, resolves it to a registry intent,
// executes the query read-only, and returns a concise WhatsApp-friendly answer.
//
// Auth:
//   source=staff_portal  → requireAuth session (viewer+)
//   source=staff_whatsapp → staff_phone must be in STAFF_ALLOWLIST_FILE
//                           AND staff_whatsapp_enabled:true in config
//                           AND entry.active:true
//
// Safety:
//   read_only: true
//   no_write_performed: true
//   sends_whatsapp: false
//   no INSERT / UPDATE / DELETE
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Ask Luna local intents (Stage 8.6.9) — read-only SQL, not in registry yet.
// Uses structured bookings + booking_beds only (no chat/conversation logs).
// ─────────────────────────────────────────────────────────────────────────────

function getAskLunaDeparturesTodayQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  bb.room_code,
  bb.bed_code,
  bb.planning_row_label
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN booking_beds bb ON bb.booking_id = b.id
WHERE c.slug = $1
  AND b.check_out = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY bb.room_code ASC NULLS LAST, bb.bed_code ASC NULLS LAST, b.booking_code ASC
`;
}

function getAskLunaRoomsNeedCleaningQuery() {
  return `
SELECT DISTINCT ON (bb.room_code, bb.bed_code)
  bb.room_code,
  bb.bed_code,
  bb.planning_row_label,
  b.booking_code,
  b.guest_name,
  b.check_out
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.check_out = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
  AND bb.room_code IS NOT NULL
  AND bb.bed_code IS NOT NULL
ORDER BY bb.room_code, bb.bed_code, b.booking_code
`;
}

/** Stage 8.8.2 — bookings.check_in on a resolved date (one row per booking). */
function getAskLunaCheckInsOnDateQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  COALESCE(
    (SELECT STRING_AGG(rm_bed, ', ' ORDER BY rm_bed)
     FROM (
       SELECT DISTINCT bb2.room_code || '/' || bb2.bed_code AS rm_bed
       FROM booking_beds bb2
       WHERE bb2.booking_id = b.id
         AND bb2.room_code IS NOT NULL
         AND bb2.bed_code IS NOT NULL
     ) beds),
    ''
  ) AS bed_summary
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.check_in = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY b.booking_code ASC
`;
}

/** Stage 8.8.2 — bookings.check_out on a resolved date (one row per booking). */
function getAskLunaCheckOutsOnDateQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  COALESCE(
    (SELECT STRING_AGG(rm_bed, ', ' ORDER BY rm_bed)
     FROM (
       SELECT DISTINCT bb2.room_code || '/' || bb2.bed_code AS rm_bed
       FROM booking_beds bb2
       WHERE bb2.booking_id = b.id
         AND bb2.room_code IS NOT NULL
         AND bb2.bed_code IS NOT NULL
     ) beds),
    ''
  ) AS bed_summary
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.check_out = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY b.booking_code ASC
`;
}

/** Stage 8.8.11 — booking_service_records SELECT columns for Ask Luna service intents. */
const ASK_LUNA_SERVICE_RECORD_COLUMNS = `
  guest_name,
  booking_code,
  service_type,
  service_date,
  quantity,
  status,
  payment_status,
  amount_due_cents,
  amount_paid_cents`;

function getAskLunaServiceYogaPaidQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'yoga'
  AND service_date = $2::date
  AND payment_status = 'paid'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceMealPaidQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'meal'
  AND service_date = $2::date
  AND payment_status = 'paid'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceSurfLessonQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'surf_lesson'
  AND service_date = $2::date
  AND status IN ('requested', 'confirmed', 'paid')
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceWetsuitQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'wetsuit'
  AND service_date = $2::date
  AND status <> 'cancelled'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceSurfboardQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'surfboard'
  AND service_date = $2::date
  AND status <> 'cancelled'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceWetsuitCountQuery() {
  return `
SELECT
  NULL::text AS guest_name,
  NULL::text AS booking_code,
  'wetsuit'::text AS service_type,
  $2::date AS service_date,
  COALESCE(SUM(quantity), 0)::int AS quantity,
  NULL::text AS status,
  NULL::text AS payment_status,
  0 AS amount_due_cents,
  0 AS amount_paid_cents
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'wetsuit'
  AND service_date = $2::date
  AND status <> 'cancelled'
`;
}

function getAskLunaServiceSurfboardCountQuery() {
  return `
SELECT
  NULL::text AS guest_name,
  NULL::text AS booking_code,
  'surfboard'::text AS service_type,
  $2::date AS service_date,
  COALESCE(SUM(quantity), 0)::int AS quantity,
  NULL::text AS status,
  NULL::text AS payment_status,
  0 AS amount_due_cents,
  0 AS amount_paid_cents
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'surfboard'
  AND service_date = $2::date
  AND status <> 'cancelled'
`;
}

const ASK_LUNA_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const ASK_LUNA_MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

function askLunaIsoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function askLunaTodayUTC(refDate = new Date()) {
  return askLunaIsoDateUTC(refDate);
}

/**
 * Normalize staff Ask Luna question text (Stage 8.8.4).
 * Lowercase, strip accents, collapse punctuation/contractions — deterministic only.
 */
function normalizeAskLunaQuestion(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/\bwho\s+s\b/g, 'who');
  q = q.replace(/\bwhat\s+s\b/g, 'what');
  q = q.replace(/\bit\s+s\b/g, 'it');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function askLunaHasTodayWord(q) {
  return /\b(today|tonight|hoy|oggi|heute|aujourdhui|aujourd hui)\b/.test(q);
}

function askLunaHasTomorrowWord(q) {
  return /\b(tomorrow|manana|domani|morgen|demain)\b/.test(q);
}

function askLunaIsCountQuestion(q) {
  return /\b(how many|cuantos|cuantas|quanti|wie viele|combien)\b/.test(q);
}

function askLunaMatchesCheckout(q) {
  return /\b(check(ing)?\s*out|checkout|leav(e|es|ing)|depart(ure|ures|ing)?|departs)\b/.test(q)
    || /\b(sale|salen|salida)\b/.test(q)
    || /\b(parte|partono|part|parts|uscita)\b/.test(q)
    || /\b(abreise|abreisen)\b/.test(q);
}

function askLunaMatchesCleaning(q) {
  if (/\b(clean(ed|ing)?|housekeep(ing)?|limpiar|limpieza|pulire|pulizia|reinigen|gereinigt|sauber|nettoyer|menage)\b/.test(q)) {
    return true;
  }
  return /\b(room|rooms|bed|beds|cuarto|cuartos|habitacion|habitaciones|camera|camere|zimmer|chambre|chambres)\b/.test(q)
    && /\b(clean|limpiar|pulire|reinigen|nettoyer|gereinigt|sauber|menage|needs?\s+to\s+be\s+cleaned)\b/.test(q);
}

function askLunaMatchesBalanceDue(q) {
  return /\b(owes?|owed|still\s+(needs?\s+to\s+)?pay|balance\s+due|still\s+ow)\b/.test(q)
    || /\b(debe|deben|saldo)\b/.test(q)
    || /\b(deve(\s+pagare)?)\b/.test(q)
    || /\b(schuldet|offen)\b/.test(q)
    || /\b(doit(\s+payer)?|solde)\b/.test(q)
    || (/\b(quien|who)\b/.test(q) && /\b(debe|owes?)\b/.test(q))
    || (/\b(quien|who)\b/.test(q) && /\bpagar\b/.test(q) && /\bdebe\b/.test(q));
}

function askLunaIsDeparturesTodayPhrase(q, dateInfo, today) {
  const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : null);
  if (!di || di.date !== today) return false;
  if (/\b(who leaves|leave.?today|leaving.?today|check.?out.?today|depart.*today)\b/.test(q)) {
    return true;
  }
  if (!askLunaMatchesCheckout(q)) return false;
  if (!askLunaHasTodayWord(q) && !(dateInfo && dateInfo.label === 'today')) return false;
  return /\b(quien|chi|qui|wer|who)\b/.test(q) || /\bwho\b/.test(q);
}

/**
 * Resolve a date phrase from a staff Ask Luna question (Stage 8.8.2 + 8.8.4 i18n).
 * tonight = today; tomorrow; ISO; named month/day; weekday; hoy/oggi/heute/aujourd'hui…
 * @returns {{ date: string, label: string } | null}
 */
function resolveAskLunaDatePhrase(question, refDate = new Date()) {
  const q = normalizeAskLunaQuestion(question);

  const isoMatch = q.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) return { date: isoMatch[1], label: isoMatch[1] };

  let monthIdx = null;
  let dayNum = null;
  let m = q.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    monthIdx = ASK_LUNA_MONTHS[m[1]];
    dayNum = parseInt(m[2], 10);
  } else {
    m = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/);
    if (m) {
      dayNum = parseInt(m[1], 10);
      monthIdx = ASK_LUNA_MONTHS[m[2]];
    }
  }
  if (monthIdx != null && dayNum >= 1 && dayNum <= 31) {
    const y = refDate.getUTCFullYear();
    const d = new Date(Date.UTC(y, monthIdx, dayNum));
    return { date: askLunaIsoDateUTC(d), label: askLunaIsoDateUTC(d) };
  }

  if (/\btonight\b/.test(q) || /\bhoy\b/.test(q) || /\boggi\b/.test(q) || /\bheute\b/.test(q)
      || /\baujourdhui\b/.test(q) || /\baujourd hui\b/.test(q)) {
    return { date: askLunaTodayUTC(refDate), label: 'today' };
  }
  if (/\btomorrow\b/.test(q) || /\bmanana\b/.test(q) || /\bdomani\b/.test(q)
      || /\bmorgen\b/.test(q) || /\bdemain\b/.test(q)) {
    const d = new Date(refDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date: askLunaIsoDateUTC(d), label: 'tomorrow' };
  }
  if (/\btoday\b/.test(q) || /\bhoy\b/.test(q) || /\boggi\b/.test(q) || /\bheute\b/.test(q)
      || /\baujourdhui\b/.test(q) || /\baujourd hui\b/.test(q)) {
    return { date: askLunaTodayUTC(refDate), label: 'today' };
  }

  for (let i = 0; i < ASK_LUNA_WEEKDAYS.length; i++) {
    const name = ASK_LUNA_WEEKDAYS[i];
    if (new RegExp(`\\b${name}\\b`).test(q)) {
      const refDay = refDate.getUTCDay();
      let delta = i - refDay;
      if (delta < 0) delta += 7;
      const d = new Date(refDate);
      d.setUTCDate(d.getUTCDate() + delta);
      return { date: askLunaIsoDateUTC(d), label: name };
    }
  }

  return null;
}

function askLunaDatePhraseLabel(ctx) {
  const label = ctx.dateLabel || 'today';
  if (label === 'today') return 'today';
  if (label === 'tomorrow') return 'tomorrow';
  if (ASK_LUNA_WEEKDAYS.includes(label)) {
    return `on ${label.charAt(0).toUpperCase() + label.slice(1)}`;
  }
  if (/^20\d{2}-\d{2}-\d{2}$/.test(label)) return `on ${label}`;
  return ctx.date ? `on ${ctx.date}` : 'today';
}

function askLunaTotalGuestCount(rows) {
  return rows.reduce((sum, r) => {
    const gc = Number(r.guest_count);
    return sum + (gc > 0 ? gc : 1);
  }, 0);
}

function isBlockedAddOnServiceQuestion(q) {
  return /\b(yoga|meal|meals|surf\s*lesson|lessons?|wetsuit|surfboard|surf\s*board|board\s*rental)\b/.test(q);
}

function askLunaMatchesServiceYogaPaid(q) {
  return /\byoga\b/.test(q) && /\b(paid|paid for|pay for|who paid)\b/.test(q);
}

function askLunaMatchesServiceMealPaid(q) {
  return /\b(meal|meals)\b/.test(q) && /\b(paid|paid for|pay for|who paid)\b/.test(q);
}

function askLunaMatchesServiceLesson(q) {
  return /\b(surf\s*lesson|surf\s*lessons)\b/.test(q)
    || (/\blesson/.test(q) && /\b(surf|has|who|need)\b/.test(q));
}

function askLunaMatchesServiceWetsuit(q) {
  return /\bwetsuit/.test(q);
}

function askLunaMatchesServiceSurfboard(q) {
  return /\b(surfboard|surf\s*board|surf\s*boards)\b/.test(q)
    || (/\bboards?\b/.test(q) && /\b(surf|need|many|ready)\b/.test(q));
}

function askLunaServiceDateParams(question, today) {
  const dateInfo = resolveAskLunaDatePhrase(question);
  return dateInfo || { date: today, label: 'today' };
}

function resolveAskLunaServiceIntent(question, q, today, isCountQ) {
  const di = askLunaServiceDateParams(question, today);
  const extraParams = { date: di.date, dateLabel: di.label };

  if (isCountQ && askLunaMatchesServiceWetsuit(q)) {
    return { intentKey: 'services.wetsuit.count_on_date', extraParams };
  }
  if (isCountQ && askLunaMatchesServiceSurfboard(q)) {
    return { intentKey: 'services.surfboard.count_on_date', extraParams };
  }
  if (askLunaMatchesServiceYogaPaid(q)) {
    return { intentKey: 'services.yoga.paid_on_date', extraParams };
  }
  if (askLunaMatchesServiceMealPaid(q)) {
    return { intentKey: 'services.meal.paid_on_date', extraParams };
  }
  if (askLunaMatchesServiceLesson(q)) {
    return { intentKey: 'services.surf_lesson.on_date', extraParams };
  }
  if (askLunaMatchesServiceWetsuit(q)) {
    return { intentKey: 'services.wetsuit.on_date', extraParams };
  }
  if (askLunaMatchesServiceSurfboard(q)) {
    return { intentKey: 'services.surfboard.on_date', extraParams };
  }
  return null;
}

const ASK_LUNA_LOCAL_QUERY = {
  departures_today:              getAskLunaDeparturesTodayQuery,
  rooms_or_beds_need_cleaning:   getAskLunaRoomsNeedCleaningQuery,
  'check_ins.on_date':           getAskLunaCheckInsOnDateQuery,
  'check_ins.count':             getAskLunaCheckInsOnDateQuery,
  'check_outs.on_date':          getAskLunaCheckOutsOnDateQuery,
  'check_outs.count':            getAskLunaCheckOutsOnDateQuery,
  'services.yoga.paid_on_date':  getAskLunaServiceYogaPaidQuery,
  'services.meal.paid_on_date':  getAskLunaServiceMealPaidQuery,
  'services.surf_lesson.on_date': getAskLunaServiceSurfLessonQuery,
  'services.wetsuit.on_date':    getAskLunaServiceWetsuitQuery,
  'services.surfboard.on_date':  getAskLunaServiceSurfboardQuery,
  'services.wetsuit.count_on_date': getAskLunaServiceWetsuitCountQuery,
  'services.surfboard.count_on_date': getAskLunaServiceSurfboardCountQuery,
};

/**
 * Keyword-based natural-language → registry intent resolver.
 * Returns { intentKey, extraParams } or null for unsupported questions.
 */
function resolveNaturalLanguageIntent(question) {
  const q = normalizeAskLunaQuestion(question);
  const today = askLunaTodayUTC();

  // Direct registry key passthrough (e.g. "payments.balance_due")
  const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');
  if (REGISTRY_BY_KEY.has(q)) return { intentKey: q, extraParams: {} };

  const dateInfo = resolveAskLunaDatePhrase(question);
  const isCountQ = askLunaIsCountQuestion(q);

  // ── Cleaning (8.8.4 i18n) — before checkout/payment to avoid false routes ──
  if (askLunaMatchesCleaning(q)) {
    const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : { date: today, label: 'today' });
    return { intentKey: 'rooms_or_beds_need_cleaning', extraParams: { date: di.date, dateLabel: di.label } };
  }

  // ── Balance due (8.8.4 i18n) ──
  if (askLunaMatchesBalanceDue(q) && !/\bpayment.?link|checkout.?link|pending.?link|waiting.?for.?pay\b/.test(q)) {
    return { intentKey: 'payments.balance_due', extraParams: {} };
  }

  // ── Check-in / check-out date queries (8.8.2 + 8.8.4) ──
  if (isCountQ && /\b(check.?in|checking in|arriv|arrival)\b/.test(q)) {
    const di = dateInfo || { date: today, label: 'today' };
    return { intentKey: 'check_ins.count', extraParams: { date: di.date, dateLabel: di.label } };
  }
  if (isCountQ && askLunaMatchesCheckout(q)) {
    const di = dateInfo || { date: today, label: 'today' };
    return { intentKey: 'check_outs.count', extraParams: { date: di.date, dateLabel: di.label } };
  }
  if (/\b(check.?in|checking in)\b/.test(q)) {
    const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : null);
    if (di) {
      return { intentKey: 'check_ins.on_date', extraParams: { date: di.date, dateLabel: di.label } };
    }
  }
  if (askLunaMatchesCheckout(q)) {
    const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : null);
    if (di) {
      if (askLunaIsDeparturesTodayPhrase(q, dateInfo, today)) {
        return { intentKey: 'departures_today', extraParams: { date: today, dateLabel: 'today' } };
      }
      return { intentKey: 'check_outs.on_date', extraParams: { date: di.date, dateLabel: di.label } };
    }
  }

  // ── Service / add-on records (8.8.11) — booking_service_records only ──
  const serviceIntent = resolveAskLunaServiceIntent(question, q, today, isCountQ);
  if (serviceIntent) return serviceIntent;

  // Natural language → intent mapping (English fallbacks)
  if (/payment.?link|checkout.?link|pending.?link|waiting.?for.?pay/.test(q))   return { intentKey: 'payments.waiting',            extraParams: {} };
  if (/arriv|check.?in.?today|arriving.?today/.test(q))                         return { intentKey: 'rooming.arrivals',            extraParams: { date: today } };
  if (/needs?.human|needs?.staff|handoff|who.?needs.?help/.test(q))             return { intentKey: 'handoffs.open',               extraParams: {} };
  if (/urgent.?handoff|high.?priority.?handoff/.test(q))                        return { intentKey: 'handoffs.urgent',             extraParams: {} };
  if (/deposit.paid|paid.?deposit/.test(q))                                     return { intentKey: 'payments.deposit',            extraParams: {} };
  if (/confirm|confirmation.?need/.test(q))                                     return { intentKey: 'payments.confirmation_needed', extraParams: {} };
  if (/fully.?paid|paid.?in.?full/.test(q))                                     return { intentKey: 'payments.fully_paid',         extraParams: {} };
  if (/no.?payment.?record|missing.?payment/.test(q))                           return { intentKey: 'payments.no_record',          extraParams: {} };
  if (/active.?hold|holds?.active/.test(q))                                     return { intentKey: 'holds.active',                extraParams: {} };
  if (/unassign|no.?bed.?assign/.test(q))                                       return { intentKey: 'rooming.unassigned',          extraParams: {} };
  if (/addon.?action|add.?on.?action|staff.?action/.test(q))                    return { intentKey: 'addons.action_required',      extraParams: {} };

  if (/depart|check.?out.?today|leaving.?today|leave.?today|who leaves/.test(q)) return { intentKey: 'departures_today',            extraParams: { date: today, dateLabel: 'today' } };

  if (isBlockedAddOnServiceQuestion(q)) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: 'Add-on or service queries (yoga, meals, lessons, wetsuit/board rentals)',
    };
  }

  return null;
}

/**
 * Formats query rows into a concise WhatsApp-friendly answer string.
 */
function formatAnswer(intentKey, rows, ctx = {}) {
  const n = rows.length;
  const when = askLunaDatePhraseLabel(ctx);

  if (n === 0) {
    const empty = {
      'payments.balance_due':         'No guests currently owe a remaining balance. ✅',
      'payments.waiting':             'No payment links are pending right now. ✅',
      'payments.deposit':             'No guests are in deposit-paid state.',
      'payments.fully_paid':          'No guests have paid in full yet.',
      'payments.confirmation_needed': 'No paid bookings awaiting confirmation.',
      'payments.no_record':           'No bookings missing a payment record.',
      'rooming.arrivals':             'No arriving guests need a bed assignment today. ✅',
      'rooming.unassigned':           'All bookings have a bed assigned. ✅',
      'departures_today':             'No guests are checking out today. ✅',
      'rooms_or_beds_need_cleaning':  'No beds need cleaning after today\'s departures. ✅',
      'check_ins.on_date':            `No guests are checking in ${when}.`,
      'check_ins.count':              `0 guests checking in ${when}.`,
      'check_outs.on_date':           `No guests are checking out ${when}.`,
      'check_outs.count':             `0 guests checking out ${when}.`,
      'handoffs.open':                'No open handoffs — all conversations handled. ✅',
      'handoffs.urgent':              'No urgent handoffs right now. ✅',
      'holds.active':                 'No active holds at the moment.',
      'addons.action_required':       'No add-ons require staff action.',
      'addons.lessons':               'No surf lessons found for that date.',
      'addons.yoga':                  'No yoga sessions found for that date.',
      'addons.rentals':               'No active rentals found for that date.',
      'services.yoga.paid_on_date':   `No yoga payments recorded ${when}.`,
      'services.meal.paid_on_date':   `No meal payments recorded ${when}.`,
      'services.surf_lesson.on_date': `No surf lessons scheduled ${when}.`,
      'services.wetsuit.on_date':     `No wetsuits needed ${when}.`,
      'services.surfboard.on_date':   `No surfboards needed ${when}.`,
    };
    return empty[intentKey] || `No results for ${intentKey}.`;
  }

  const MAX_SUMMARY = 5;
  const extra = n > MAX_SUMMARY ? ` (+${n - MAX_SUMMARY} more)` : '';

  const nameLine = (r) => r.guest_name ? `${r.guest_name} (${r.booking_code || ''})` : (r.booking_code || r.id || '?');
  const serviceNameLine = (r) => {
    const qty = Number(r.quantity) > 1 ? ` ×${r.quantity}` : '';
    return `${nameLine(r)}${qty}`;
  };
  const centsStr = (c) => c != null ? `€${(Math.round(c) / 100).toFixed(0)}` : '';
  const stayLine = (r) => {
    const beds = r.bed_summary ? ` — ${r.bed_summary}` : (
      r.room_code && r.bed_code ? ` — ${r.room_code}/${r.bed_code}` : ''
    );
    const gc = r.guest_count > 0 ? `, ${r.guest_count} guest${r.guest_count !== 1 ? 's' : ''}` : '';
    return `${nameLine(r)}${gc}${beds}`;
  };

  switch (intentKey) {
    case 'payments.balance_due':
    case 'payments.deposit': {
      const list = rows.slice(0, MAX_SUMMARY).map(r =>
        `${nameLine(r)} — balance ${centsStr(r.balance_due_cents)}`
      ).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} still owe${n !== 1 ? '' : 's'} a balance: ${list}${extra}`;
    }
    case 'payments.waiting': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} ha${n !== 1 ? 've' : 's'} a payment link pending: ${list}${extra}`;
    }
    case 'payments.fully_paid': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} paid in full: ${list}${extra}`;
    }
    case 'payments.confirmation_needed': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} still need${n !== 1 ? '' : 's'} a confirmation sent: ${list}${extra}`;
    }
    case 'payments.no_record': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} booking${n !== 1 ? 's' : ''} ha${n !== 1 ? 've' : 's'} no payment record: ${list}${extra}`;
    }
    case 'rooming.arrivals': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} arrival${n !== 1 ? 's' : ''} still need${n !== 1 ? '' : 's'} a bed assignment today: ${list}${extra}`;
    }
    case 'rooming.unassigned': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} booking${n !== 1 ? 's' : ''} ha${n !== 1 ? 've' : 's'} no bed assigned yet: ${list}${extra}`;
    }
    case 'departures_today': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => {
        const bed = r.room_code && r.bed_code ? ` — ${r.room_code}/${r.bed_code}` : '';
        return `${nameLine(r)}${bed}`;
      }).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} leaving today: ${list}${extra}`;
    }
    case 'check_ins.on_date': {
      const list = rows.slice(0, MAX_SUMMARY).map(stayLine).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} checking in ${when}: ${list}${extra}`;
    }
    case 'check_ins.count': {
      const people = askLunaTotalGuestCount(rows);
      return `${people} guest${people !== 1 ? 's' : ''} checking in ${when}.`;
    }
    case 'check_outs.on_date': {
      const list = rows.slice(0, MAX_SUMMARY).map(stayLine).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} checking out ${when}: ${list}${extra}`;
    }
    case 'check_outs.count': {
      const people = askLunaTotalGuestCount(rows);
      return `${people} guest${people !== 1 ? 's' : ''} checking out ${when}.`;
    }
    case 'rooms_or_beds_need_cleaning': {
      const list = rows.slice(0, MAX_SUMMARY).map(r =>
        `${r.room_code}/${r.bed_code}${r.guest_name ? ` (${r.guest_name} checked out)` : ''}`
      ).join('; ');
      return `${n} bed${n !== 1 ? 's' : ''} need cleaning after today's departures: ${list}${extra}`;
    }
    case 'handoffs.open':
    case 'handoffs.urgent': {
      const list = rows.slice(0, MAX_SUMMARY).map(r =>
        r.guest_phone || r.booking_code || r.id || '?'
      ).join('; ');
      const label = intentKey === 'handoffs.urgent' ? 'urgent handoff' : 'open handoff';
      return `${n} ${label}${n !== 1 ? 's' : ''} need${n !== 1 ? '' : 's'} a human reply: ${list}${extra}`;
    }
    case 'holds.active': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} active hold${n !== 1 ? 's' : ''}: ${list}${extra}`;
    }
    case 'services.yoga.paid_on_date':
    case 'services.meal.paid_on_date': {
      const svc = intentKey.includes('meal') ? 'meal' : 'yoga';
      const list = rows.slice(0, MAX_SUMMARY).map(serviceNameLine).join('; ');
      return `${n} paid ${svc}${n !== 1 ? 's' : ''} ${when}: ${list}${extra}`;
    }
    case 'services.surf_lesson.on_date': {
      const list = rows.slice(0, MAX_SUMMARY).map(serviceNameLine).join('; ');
      return `${n} surf lesson${n !== 1 ? 's' : ''} ${when}: ${list}${extra}`;
    }
    case 'services.wetsuit.on_date':
    case 'services.surfboard.on_date': {
      const gear = intentKey.includes('wetsuit') ? 'wetsuit' : 'surfboard';
      const list = rows.slice(0, MAX_SUMMARY).map(serviceNameLine).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} need${n !== 1 ? '' : 's'} a ${gear} ${when}: ${list}${extra}`;
    }
    case 'services.wetsuit.count_on_date': {
      const total = Number(rows[0]?.quantity ?? 0);
      return `${total} wetsuit${total !== 1 ? 's' : ''} needed ${when}.`;
    }
    case 'services.surfboard.count_on_date': {
      const total = Number(rows[0]?.quantity ?? 0);
      return `${total} surfboard${total !== 1 ? 's' : ''} needed ${when}.`;
    }
    default: {
      return `${n} result${n !== 1 ? 's' : ''} for ${intentKey}${extra}.`;
    }
  }
}

async function handleAskLuna(req, res) {
  const started = Date.now();

  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const source     = String(body.source      || 'staff_portal').trim();
  const staffPhone = body.staff_phone ? String(body.staff_phone).trim() : null;
  const clientSlug = String(body.client_slug || DEFAULT_CLIENT).trim();
  const question   = String(body.question    || '').trim();

  // ── Auth ──────────────────────────────────────────────────────────────────
  let staffAccess;

  if (source === 'staff_whatsapp') {
    // Phone-based auth: check allowlist config
    if (!staffPhone) {
      return sendJSON(res, 403, {
        success: false, error: 'staff_phone_required',
        detail:  'staff_phone is required for source=staff_whatsapp',
        sends_whatsapp: false,
      });
    }

    let allowlist;
    try {
      allowlist = JSON.parse(fs.readFileSync(STAFF_ALLOWLIST_FILE, 'utf8'));
    } catch (_) {
      return sendJSON(res, 403, {
        success: false, error: 'allowlist_not_configured',
        detail:  'staff_whatsapp allowlist config not found',
        sends_whatsapp: false,
      });
    }

    if (!allowlist.staff_whatsapp_enabled) {
      return sendJSON(res, 403, {
        success: false, error: 'staff_whatsapp_disabled',
        detail:  'staff_whatsapp_enabled is false in allowlist config',
        sends_whatsapp: false,
      });
    }

    const entry = (allowlist.staff_numbers || []).find(
      (n) => n.phone === staffPhone && n.active === true
    );
    if (!entry) {
      return sendJSON(res, 403, {
        success: false, error: 'phone_not_allowlisted',
        detail:  'staff_phone is not in the active staff allowlist',
        sends_whatsapp: false,
      });
    }

    staffAccess = 'allowlisted_phone';

  } else {
    // Session auth for staff_portal (or any non-whatsapp source)
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    staffAccess = 'session';
  }

  // ── Input validation ──────────────────────────────────────────────────────
  if (!question) return send400(res, 'question is required');
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client_slug');

  // ── Resolve intent ────────────────────────────────────────────────────────
  const resolution = resolveNaturalLanguageIntent(question);

  if (!resolution || resolution.intentKey === 'unsupported_intent') {
    const hint = resolution ? resolution.intentHint : null;
    const supportedList = [
      'who owes money (payments.balance_due)',
      'payment links pending (payments.waiting)',
      'arrivals today (rooming.arrivals)',
      'who is checking in today/tomorrow/Saturday (check_ins.on_date)',
      'how many check in tomorrow (check_ins.count)',
      'departures today (departures_today)',
      'who is checking out tomorrow/Saturday (check_outs.on_date)',
      'how many check out tomorrow (check_outs.count)',
      'rooms/beds needing cleaning (rooms_or_beds_need_cleaning)',
      'who paid for yoga/meals (services.yoga/meal.paid_on_date)',
      'surf lessons / wetsuits / surfboards (services.*)',
      'who needs human reply (handoffs.open)',
      'deposit paid (payments.deposit)',
      'confirmation needed (payments.confirmation_needed)',
      'active holds (holds.active)',
      'unassigned beds (rooming.unassigned)',
    ].join(', ');
    const answer = hint
      ? `"${hint}" is not yet in the query registry. You can ask: ${supportedList}`
      : `I don't know how to answer that yet. You can ask about: ${supportedList}`;
    return sendJSON(res, 200, {
      success:           true,
      client_slug:       clientSlug,
      source,
      staff_access:      staffAccess,
      intent:            'unsupported_intent',
      intent_hint:       hint || null,
      answer,
      rows:              [],
      row_count:         0,
      read_only:         true,
      no_write_performed: true,
      sends_whatsapp:    false,
      elapsed_ms:        Date.now() - started,
    });
  }

  const { intentKey, extraParams } = resolution;

  if (ASK_LUNA_LOCAL_QUERY[intentKey]) {
    const today = extraParams.date || askLunaTodayUTC();
    const fmtCtx = { date: today, dateLabel: extraParams.dateLabel || 'today' };
    let localRows = [];
    try {
      const sql = ASK_LUNA_LOCAL_QUERY[intentKey]();
      localRows = await withPgClient(async (pgClient) => {
        const result = await pgClient.query(sql, [clientSlug, today]);
        return result.rows;
      });
    } catch (err) {
      console.error('[ask-luna] DB error:', err.message);
      return sendJSON(res, 500, {
        success: false, error: 'query_error', detail: err.message,
      });
    }
    const answer = formatAnswer(intentKey, localRows, fmtCtx);
    const category = intentKey.startsWith('services.') ? 'services'
      : intentKey.startsWith('check_ins') ? 'arrivals'
      : (intentKey.startsWith('check_outs') || intentKey === 'departures_today') ? 'departures'
      : 'rooming';
    return sendJSON(res, 200, {
      success:            true,
      client_slug:        clientSlug,
      source,
      staff_access:       staffAccess,
      intent:             intentKey,
      category,
      query_date:         today,
      answer,
      rows:               localRows.slice(0, MAX_ROWS),
      row_count:          localRows.length,
      read_only:          true,
      no_write_performed: true,
      sends_whatsapp:     false,
      elapsed_ms:         Date.now() - started,
    });
  }

  const registryEntry = getEntry(intentKey);

  if (!registryEntry || registryEntry.missingHelper === true || typeof registryEntry.helperRef !== 'function') {
    return sendJSON(res, 200, {
      success:           true,
      client_slug:       clientSlug,
      source,
      staff_access:      staffAccess,
      intent:            intentKey,
      answer:            `The "${intentKey}" query helper is not yet available (migration or implementation pending).`,
      rows:              [],
      row_count:         0,
      read_only:         true,
      no_write_performed: true,
      sends_whatsapp:    false,
      elapsed_ms:        Date.now() - started,
    });
  }

  // ── Execute (SELECT only, no writes) ──────────────────────────────────────
  const queryObj   = { client: clientSlug, ...extraParams };
  const { params } = resolveParams(registryEntry, clientSlug, queryObj);

  let rows = [];
  try {
    const sql = registryEntry.helperRef();
    rows = await withPgClient(async (pgClient) => {
      const result = await pgClient.query(sql, params);
      return result.rows;
    });
  } catch (err) {
    console.error('[ask-luna] DB error:', err.message);
    return sendJSON(res, 500, {
      success: false, error: 'query_error', detail: err.message,
    });
  }

  const answer = formatAnswer(intentKey, rows);
  const elapsed = Date.now() - started;

  sendJSON(res, 200, {
    success:            true,
    client_slug:        clientSlug,
    source,
    staff_access:       staffAccess,
    intent:             intentKey,
    category:           registryEntry.category,
    answer,
    rows:               rows.slice(0, MAX_ROWS),
    row_count:          rows.length,
    read_only:          true,
    no_write_performed: true,
    sends_whatsapp:     false,
    elapsed_ms:         elapsed,
  });
}
// ─────────────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 10240) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
// Stage 8.4.11 — Raw Buffer variant required for Stripe webhook signature verification.
// Stripe's constructEvent() needs the exact raw bytes, not a parsed/re-serialised string.
function readBodyRaw(req, maxBytes) {
  const limit = maxBytes || 102400; // 100KB default
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) { req.destroy(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleResolveHandoff(handoffId, req, res) {
  const started = Date.now();

  // ── Feature flag gate ──────────────────────────────────────────────────────
  if (!STAFF_ACTIONS_ENABLED) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'action:api:handoff.resolve',
      category: 'staff_write', handoff_id: handoffId,
      success: false, error: 'feature_flag_disabled', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, {
      success: false,
      error: 'Staff write actions are disabled. Set STAFF_ACTIONS_ENABLED=true to enable.',
    });
  }

  // ── Auth gate (session when STAFF_AUTH_REQUIRED=true, else operator token) ──
  // Session path: requires authenticated session with role operator or admin.
  // Token path: local/dev backward compat (STAFF_AUTH_REQUIRED=false only).
  if (STAFF_AUTH_REQUIRED) {
    let sessionUser;
    try { sessionUser = await loadAuthSession(req); } catch (_) { sessionUser = null; }
    if (!sessionUser) {
      appendAuditLog({
        ts: new Date().toISOString(), intent: 'action:api:handoff.resolve',
        category: 'staff_write', handoff_id: handoffId,
        success: false, error: 'invalid_token', elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 401, {
        success: false,
        error: 'Authentication required for write actions when STAFF_AUTH_REQUIRED=true.',
      });
    }
    if (!hasRole(sessionUser.role, 'operator')) {
      appendAuditLog({
        ts: new Date().toISOString(), intent: 'action:api:handoff.resolve',
        category: 'staff_write', handoff_id: handoffId,
        success: false, error: 'insufficient_role', elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 403, {
        success:      false,
        error:        `Role 'operator' or higher required for handoff.resolve.`,
        current_role: sessionUser.role,
      });
    }
  } else {
    // Token gate (local/dev only — never used in staging/prod)
    const providedToken = (req.headers['x-staff-operator-token'] || '').trim();
    if (!STAFF_OPERATOR_TOKEN || !providedToken || providedToken !== STAFF_OPERATOR_TOKEN) {
      appendAuditLog({
        ts: new Date().toISOString(), intent: 'action:api:handoff.resolve',
        category: 'staff_write', handoff_id: handoffId,
        success: false, error: 'invalid_token', elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 401, { success: false, error: 'Missing or invalid x-staff-operator-token header.' });
    }
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug     = (String(body.client     || DEFAULT_CLIENT)).trim();
  const resolutionRaw  = String(body.resolution  || '').trim();
  const staffName      = String(body.staff       || 'Staff').trim().slice(0, 200);
  const confirmFlag    = body.confirm;

  // ── Validate body ──────────────────────────────────────────────────────────
  if (confirmFlag !== true) {
    return send400(res, 'confirm: true is required in request body');
  }
  if (!resolutionRaw) {
    return send400(res, 'resolution is required and must be non-empty');
  }
  if (SQL_INJECT_RE.test(resolutionRaw) || SQL_INJECT_RE.test(clientSlug)) {
    return send400(res, 'unsafe characters in request body');
  }
  const resolutionText = resolutionRaw.slice(0, 1000);

  const auditBase = {
    ts:          new Date().toISOString(),
    intent:      'action:api:handoff.resolve',
    category:    'staff_write',
    client_slug: clientSlug,
    handoff_id:  handoffId,
    staff:       staffName,
  };

  // ── Lookup target row ──────────────────────────────────────────────────────
  let handoff;
  try {
    handoff = await withPgClient(async (pgClient) => {
      const result = await pgClient.query(
        `SELECT h.id::text, h.status, h.reason_code, h.phone
         FROM staff_handoffs h
         JOIN clients c ON c.id = h.client_id
         WHERE h.id = $1::uuid AND c.slug = $2`,
        [handoffId, clientSlug]
      );
      return result.rows[0] || null;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: 'lookup_failed: ' + err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'handoff lookup failed' });
  }

  if (!handoff) {
    appendAuditLog({ ...auditBase, success: false, error: 'not_found', elapsed_ms: Date.now() - started });
    return sendJSON(res, 404, {
      success: false,
      error:   `handoff ${handoffId} not found or client mismatch`,
    });
  }

  // ── Idempotency: already resolved/cancelled ────────────────────────────────
  if (handoff.status === 'resolved' || handoff.status === 'cancelled') {
    const elapsed = Date.now() - started;
    appendAuditLog({ ...auditBase, success: true, already_resolved: true, status_before: handoff.status, elapsed_ms: elapsed });
    return sendJSON(res, 200, {
      success:          true,
      action:           'handoff.resolve',
      handoff_id:       handoffId,
      already_resolved: true,
      status_before:    handoff.status,
      status_after:     handoff.status,
      elapsed_ms:       elapsed,
    });
  }

  // ── Execute write ──────────────────────────────────────────────────────────
  let updated;
  try {
    const sql = resolveHandoffSql();
    updated = await withPgClient(async (pgClient) => {
      const result = await pgClient.query(sql, [clientSlug, handoffId, resolutionText]);
      return result.rows[0] || null;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: 'write_failed: ' + err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ...auditBase,
    success:       true,
    already_resolved: false,
    status_before: handoff.status,
    status_after:  'resolved',
    elapsed_ms:    elapsed,
  });

  return sendJSON(res, 200, {
    success:          true,
    action:           'handoff.resolve',
    handoff_id:       handoffId,
    status_before:    handoff.status,
    status_after:     'resolved',
    already_resolved: false,
    resolution:       resolutionText,
    staff:            staffName,
    resolved_at:      updated ? updated.resolved_at : null,
    elapsed_ms:       elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/manual-bookings/preview  (Stage 8.3h — read-only preview)
//
// Preview-only: no booking creation, no DB writes, no Stripe, no WhatsApp.
// Does NOT require STAFF_ACTIONS_ENABLED or MANUAL_BOOKING_ENABLED.
// Requires auth (operator/admin/owner when STAFF_AUTH_REQUIRED=true).
// ─────────────────────────────────────────────────────────────────────────────

async function handleManualBookingPreview(req, res, user) {
  const started = Date.now();

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  // ── Extract and sanitise input ─────────────────────────────────────────────
  const clientSlug   = String(body.client || body.client_slug || DEFAULT_CLIENT).trim();
  const checkIn      = String(body.check_in  || '').trim();
  const checkOut     = String(body.check_out || '').trim();
  const guestCount   = parseInt(body.guest_count, 10) || 0;

  // selected_bed_codes: accept array or comma-separated string
  let rawBedCodes = body.selected_bed_codes;
  if (typeof rawBedCodes === 'string') {
    rawBedCodes = rawBedCodes.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (!Array.isArray(rawBedCodes)) {
    rawBedCodes = [];
  }
  const selectedBedCodes = rawBedCodes.map(String).slice(0, 20); // max 20 beds

  // Optional fields (informational only — stored in audit, not used for query)
  const packageOrStayType   = String(body.package_or_stay_type   || '').trim().slice(0, 200);
  const roomPreference      = String(body.room_preference        || '').trim().slice(0, 200);
  const paymentStatus       = String(body.payment_status         || '').trim().slice(0, 50);
  const depositAmountCents  = parseInt(body.deposit_amount_cents,  10) || 0;
  const totalAmountCents    = parseInt(body.total_amount_cents,    10) || 0;

  // ── Input guards ───────────────────────────────────────────────────────────
  if (SQL_INJECT_RE.test(clientSlug))
    return send400(res, 'invalid client slug');
  if (!checkIn || !checkOut)
    return send400(res, 'check_in and check_out are required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut))
    return send400(res, 'check_in and check_out must be YYYY-MM-DD');
  if (selectedBedCodes.some((c) => SQL_INJECT_RE.test(c)))
    return send400(res, 'invalid character in selected_bed_codes');

  // ── Actor info ─────────────────────────────────────────────────────────────
  const actorId   = user ? user.staff_user_id : 'dev-preview-local';
  const actorRole = user ? user.role          : 'operator';

  const auditBase = {
    ts:                  new Date().toISOString(),
    intent:              'api:manual_booking_preview',
    category:            'manual_booking_preview',
    preview_only:        true,
    creates_booking:     false,
    no_write_performed:  true,
    client_slug:         clientSlug,
    check_in:            checkIn,
    check_out:           checkOut,
    selected_bed_codes:  selectedBedCodes,
    guest_count:         guestCount,
    staff_user_id:       actorId,
    staff_role:          actorRole,
  };

  // ── Load data from DB (SELECT only) ────────────────────────────────────────
  let clientRow, bedRows, assignmentRows;
  try {
    const result = await withPgClient(async (pg) => {
      // C. Verify client exists
      const clientResult = await pg.query(
        getClientIdBySlugQuery(),
        [clientSlug]
      );

      // A. Load bed metadata for selected beds
      const bedsResult = await pg.query(
        getManualBookingPreviewBedsQuery(),
        [clientSlug, selectedBedCodes.length > 0 ? selectedBedCodes : ['']]
      );

      // B. Load existing assignments overlapping the proposed range
      // If selected_bed_codes is empty the query will return zero rows safely.
      const assignmentsResult = await pg.query(
        getManualBookingPreviewAssignmentsQuery(),
        [
          clientSlug,
          checkIn,
          checkOut,
          selectedBedCodes.length > 0 ? selectedBedCodes : [''],
        ]
      );

      return {
        clientRow:       clientResult.rows[0]    || null,
        bedRows:         bedsResult.rows,
        assignmentRows:  assignmentsResult.rows,
      };
    });
    clientRow       = result.clientRow;
    bedRows         = result.bedRows;
    assignmentRows  = result.assignmentRows;
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'preview data load failed', detail: err.message });
  }

  // ── Client not found ───────────────────────────────────────────────────────
  if (!clientRow) {
    appendAuditLog({ ...auditBase, success: false, error: 'client_not_found', elapsed_ms: Date.now() - started });
    return sendJSON(res, 404, {
      success:            false,
      error:              'client not found',
      client_slug:        clientSlug,
      preview_only:       true,
      creates_booking:    false,
      no_write_performed: true,
    });
  }

  // ── Map DB rows to availability helper shapes ──────────────────────────────
  const beds = bedRows.map((row) => ({
    bed_code:  row.bed_code,
    room_code: row.room_code,
    active:    row.active,
    sellable:  row.sellable   != null ? row.sellable   : true,
    capacity:  row.capacity,
  }));

  const existingAssignments = assignmentRows.map((row) => ({
    booking_code:          row.booking_code,
    booking_status:        row.booking_status,
    assignment_status:     row.assignment_status,
    bed_code:              row.bed_code,
    room_code:             row.room_code,
    assignment_start_date: row.assignment_start_date,
    assignment_end_date:   row.assignment_end_date,
    guest_name:            row.guest_name || row.bed_guest_name,
  }));

  // ── Call pure availability helper ──────────────────────────────────────────
  let availability;
  try {
    availability = previewManualBookingAvailability({
      client_id:            clientRow.client_id,
      check_in:             checkIn,
      check_out:            checkOut,
      selected_bed_codes:   selectedBedCodes,
      guest_count:          guestCount,
      existing_assignments: existingAssignments,
      beds:                 beds,
      options: {
        today: new Date().toISOString().slice(0, 10),
      },
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: 'availability_helper_error: ' + err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'availability calculation failed' });
  }

  // ── Build audit entry ──────────────────────────────────────────────────────
  const elapsed = Date.now() - started;
  appendAuditLog({
    ...auditBase,
    success:         true,
    is_valid:        availability.is_valid,
    has_conflict:    availability.has_conflict,
    blocker_count:   availability.blockers.length,
    warning_count:   availability.warnings.length,
    proposed_nights: availability.proposed_nights,
    elapsed_ms:      elapsed,
  });

  // ── Build response ─────────────────────────────────────────────────────────
  return sendJSON(res, 200, {
    success:                 true,
    preview_only:            true,
    creates_booking:         false,
    no_write_performed:      true,
    staff_actions_enabled:   STAFF_ACTIONS_ENABLED,
    manual_booking_enabled:  MANUAL_BOOKING_ENABLED,
    client_slug:             clientSlug,
    input_summary: {
      check_in:             checkIn,
      check_out:            checkOut,
      selected_bed_codes:   selectedBedCodes,
      guest_count:          guestCount,
      package_or_stay_type: packageOrStayType || null,
      room_preference:      roomPreference    || null,
      payment_status:       paymentStatus     || null,
      deposit_amount_cents: depositAmountCents || null,
      total_amount_cents:   totalAmountCents  || null,
    },
    availability,
    next_step: MANUAL_BOOKING_ENABLED
      ? 'Manual booking creation is enabled. POST /staff/manual-bookings/create to create.'
      : 'Manual booking creation is disabled. Set MANUAL_BOOKING_ENABLED to true to enable.',
    elapsed_ms: elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/quote-preview  (Stage 8.4.4 — pure quote preview, no DB)
//
// Calls calculateWolfhouseQuote() with the request body. No DB reads or writes.
// No Stripe. No WhatsApp. No n8n.
// Does NOT require STAFF_ACTIONS_ENABLED or MANUAL_BOOKING_ENABLED.
// Requires auth (viewer+ when STAFF_AUTH_REQUIRED=true).
// ─────────────────────────────────────────────────────────────────────────────

async function handleQuotePreview(req, res, user) {
  const started = Date.now();

  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug    = String(body.client_slug || body.client || DEFAULT_CLIENT).trim();
  const checkIn       = String(body.check_in    || '').trim();
  const checkOut      = String(body.check_out   || '').trim();
  const guestCount    = body.guest_count;
  const packageCode   = body.package_code   != null ? String(body.package_code).trim()  : undefined;
  const roomType      = String(body.room_type      || 'shared').trim();
  const paymentChoice = String(body.payment_choice || 'deposit').trim();
  const addOns        = Array.isArray(body.add_ons) ? body.add_ons : [];

  if (!checkIn || !checkOut) {
    return send400(res, 'check_in and check_out are required (YYYY-MM-DD)');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    return send400(res, 'check_in and check_out must be YYYY-MM-DD');
  }

  const actorId   = user ? user.staff_user_id : 'dev-quote-preview-local';
  const actorRole = user ? user.role          : 'viewer';

  let quote;
  try {
    quote = calculateWolfhouseQuote({
      client_slug:    clientSlug,
      check_in:       checkIn,
      check_out:      checkOut,
      guest_count:    guestCount,
      package_code:   packageCode,
      room_type:      roomType,
      payment_choice: paymentChoice,
      add_ons:        addOns,
    });
  } catch (err) {
    appendAuditLog({
      ts:            new Date().toISOString(),
      intent:        'api:quote_preview',
      preview_only:  true,
      no_write_performed: true,
      success:       false,
      error:         err.message,
      elapsed_ms:    Date.now() - started,
      staff_user_id: actorId,
      staff_role:    actorRole,
    });
    return sendJSON(res, 500, { success: false, error: 'quote calculation failed' });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts:                 new Date().toISOString(),
    intent:             'api:quote_preview',
    preview_only:       true,
    no_write_performed: true,
    creates_booking:    false,
    creates_payment:    false,
    creates_stripe_link: false,
    success:            true,
    client_slug:        clientSlug,
    check_in:           checkIn,
    check_out:          checkOut,
    package_code:       packageCode || null,
    quote_success:      quote.success,
    total_cents:        quote.total_cents,
    elapsed_ms:         elapsed,
    staff_user_id:      actorId,
    staff_role:         actorRole,
  });

  return sendJSON(res, 200, {
    success:             true,
    preview_only:        true,
    no_write_performed:  true,
    creates_booking:     false,
    creates_payment:     false,
    creates_stripe_link: false,
    quote,
    elapsed_ms:          elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/bot/availability-check  (Stage 8.5.8 — Luna bot bed availability)
//
// Read-only endpoint for Luna/n8n to discover available bed_codes before calling
// /staff/bot/bookings/create.  Closes the Stage 8.5.7 selected_bed_codes gap.
//
// Behavior:
//   1. Validates check_in / check_out / guest_count.
//   2. Loads all active/sellable beds for the client from Postgres.
//   3. Loads overlapping booking_beds rows using the standard half-open interval:
//        assignment_start_date < check_out  AND  assignment_end_date > check_in
//      Rows with booking status cancelled/expired are excluded by query.
//   4. Optionally filters by room_type if rooms metadata provides it.
//   5. Returns first-fit selected_bed_codes[] for guest_count, has_enough_beds,
//      available_beds[], blockers[], warnings[].
//
// Safety:
//   preview_only: true
//   no_write_performed: true
//   creates_booking: false
//   creates_payment: false
//   creates_stripe_link: false
//   sends_whatsapp: false
//
// Auth: requireBotAuth() — bot token or staff session.
// ─────────────────────────────────────────────────────────────────────────────

async function handleBotAvailabilityCheck(req, res, user, authMode) {
  const started = Date.now();

  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug    = String(body.client_slug  || DEFAULT_CLIENT).trim();
  const checkIn       = String(body.check_in     || '').trim();
  const checkOut      = String(body.check_out    || '').trim();
  const guestCount    = parseInt(body.guest_count || '1', 10);
  const roomType      = String(body.room_type    || 'shared').trim().toLowerCase();
  const genderPref    = body.gender_preference ? String(body.gender_preference).trim() : null;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!clientSlug) return send400(res, 'client_slug is required');
  if (!checkIn)    return send400(res, 'check_in is required');
  if (!checkOut)   return send400(res, 'check_out is required');
  if (!guestCount || guestCount < 1) return send400(res, 'guest_count must be >= 1');

  const ciDate = new Date(checkIn + 'T00:00:00Z');
  const coDate = new Date(checkOut + 'T00:00:00Z');
  if (isNaN(ciDate.getTime()) || isNaN(coDate.getTime())) return send400(res, 'invalid date format — use YYYY-MM-DD');
  if (coDate <= ciDate) return send400(res, 'check_out must be after check_in');

  // ── DB queries (SELECT only — no writes) ────────────────────────────────────
  const warnings  = [];
  const blockers  = [];

  let bedRows, blockRows;
  try {
    await withPgClient(async (pg) => {
      // Query A: all active/sellable beds for client
      const bedsRes = await pg.query(getBedCalendarRoomsQuery(), [clientSlug]);
      bedRows = bedsRes.rows;

      // Query B: overlapping booking_beds blocks (half-open, excludes cancelled/expired)
      const blocksRes = await pg.query(getBedCalendarBlocksQuery(), [clientSlug, checkIn, checkOut]);
      blockRows = blocksRes.rows;
    });
  } catch (err) {
    console.error('[bot/availability-check] DB error:', err.message);
    sendJSON(res, 500, { success: false, error: 'db_error', detail: err.message });
    return;
  }

  // ── Build bed metadata list (active + sellable only) ───────────────────────
  const allBeds = bedRows
    .filter(r => r.bed_code && r.bed_active !== false && r.bed_sellable !== false)
    .map(r => ({
      bed_code:  r.bed_code,
      room_code: r.room_code,
      room_type: r.room_type || null,
      bed_label: r.bed_label || r.bed_code,
      active:    r.bed_active !== false,
      sellable:  r.bed_sellable !== false,
    }));

  // ── Room-type filter ────────────────────────────────────────────────────────
  // "shared" → prefer beds in shared/non-private rooms.
  // "private" / "double" → prefer private/double rooms.
  // If room_type metadata is absent or ambiguous, return all and add warning.
  const hasRoomTypeMeta = allBeds.some(b => b.room_type !== null);
  let filteredBeds = allBeds;
  if (hasRoomTypeMeta && roomType && roomType !== 'any') {
    const privateTypes = ['private', 'double', 'matrimonial'];
    const sharedTypes  = ['shared', 'dorm'];
    if (roomType === 'shared') {
      const sharedBeds = allBeds.filter(b => b.room_type && sharedTypes.includes(String(b.room_type).toLowerCase()));
      filteredBeds = sharedBeds.length > 0 ? sharedBeds : allBeds;
      if (sharedBeds.length === 0) warnings.push('room_type_filter_not_strict');
    } else if (privateTypes.includes(roomType)) {
      const privateBeds = allBeds.filter(b => b.room_type && privateTypes.includes(String(b.room_type).toLowerCase()));
      filteredBeds = privateBeds.length > 0 ? privateBeds : allBeds;
      if (privateBeds.length === 0) warnings.push('room_type_filter_not_strict');
    } else {
      warnings.push('room_type_filter_not_strict');
    }
  } else if (!hasRoomTypeMeta && roomType && roomType !== 'any') {
    warnings.push('room_type_filter_not_strict');
  }

  // ── Find occupied bed codes for the date range ─────────────────────────────
  // getBedCalendarBlocksQuery already excludes cancelled/expired booking statuses.
  const occupiedBedCodes = new Set(blockRows.map(r => r.bed_code).filter(Boolean));

  // ── Available beds ─────────────────────────────────────────────────────────
  const availableBeds = filteredBeds.filter(b => !occupiedBedCodes.has(b.bed_code));

  const availableCount = availableBeds.length;
  const hasEnoughBeds  = availableCount >= guestCount;

  // ── First-fit selection ────────────────────────────────────────────────────
  const selectedBedCodes = hasEnoughBeds
    ? availableBeds.slice(0, guestCount).map(b => b.bed_code)
    : [];

  if (!hasEnoughBeds) {
    blockers.push('not_enough_available_beds');
  }

  const nextAction = hasEnoughBeds ? 'ready_for_bot_create' : 'ask_staff_or_alternate_dates';

  const elapsed = Date.now() - started;

  sendJSON(res, 200, {
    success:             true,
    preview_only:        true,
    no_write_performed:  true,
    creates_booking:     false,
    creates_payment:     false,
    creates_stripe_link: false,
    sends_whatsapp:      false,
    auth_mode:           authMode,
    client_slug:         clientSlug,
    check_in:            checkIn,
    check_out:           checkOut,
    guest_count:         guestCount,
    room_type:           roomType,
    selected_bed_codes:  selectedBedCodes,
    has_enough_beds:     hasEnoughBeds,
    available_count:     availableCount,
    available_beds:      availableBeds.map(b => ({ bed_code: b.bed_code, room_code: b.room_code, room_type: b.room_type })),
    occupied_count:      occupiedBedCodes.size,
    warnings,
    blockers,
    next_action:         nextAction,
    elapsed_ms:          elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/bot/addon-request-preview  (Stage 8.8.25 — Luna guest add-on dry-run)
//
// Parses structured mid-stay add-on request fields, validates booking/service/date/qty,
// and returns what would be created. Read-only booking lookup; no service rows,
// payments, Stripe links, WhatsApp, or n8n.
//
// Auth: requireBotAuth() — same as other /staff/bot/* endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const BOT_ADDON_SERVICE_TYPES = new Set(['yoga', 'meal', 'surf_lesson', 'wetsuit', 'surfboard']);
const BOT_ADDON_PRICING_PATH = path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

function loadWolfhousePricingConfigForBotAddon() {
  return JSON.parse(fs.readFileSync(BOT_ADDON_PRICING_PATH, 'utf8'));
}

function previewGuestAddonPricing(serviceType, quantity, clientSlug) {
  const warnings = [];
  if (clientSlug !== 'wolfhouse-somo') {
    return {
      amount_due_cents: null,
      pricing_addon_code: null,
      unit_cents: null,
      payment_required: false,
      warnings: [`pricing config not loaded for client "${clientSlug}" — staff review required`],
    };
  }

  if (serviceType === 'meal') {
    return {
      amount_due_cents: 0,
      pricing_addon_code: null,
      unit_cents: null,
      payment_required: false,
      reason: 'meal_on_site_only',
      warnings: ['Meals are recorded on-site only for MVP — no payment link.'],
    };
  }

  let config;
  try {
    config = loadWolfhousePricingConfigForBotAddon();
  } catch (err) {
    return {
      amount_due_cents: null,
      pricing_addon_code: null,
      unit_cents: null,
      payment_required: false,
      warnings: [`pricing config unavailable: ${err.message}`],
    };
  }

  const addOns = config.add_ons || {};

  if (serviceType === 'wetsuit') {
    const cfg = addOns.wetsuit_rental;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return { amount_due_cents: null, pricing_addon_code: 'wetsuit_rental', unit_cents: null, payment_required: false, warnings: ['Wetsuit rental price not safely available — staff review required.'] };
    }
    const days = quantity;
    const total = cfg.price_cents * days;
    if (cfg.charge_timing === 'REQUIRED_FROM_STAFF') {
      warnings.push('Wetsuit charge timing not confirmed (with booking or on site?) — staff may need to confirm.');
    }
    return { amount_due_cents: total, pricing_addon_code: 'wetsuit_rental', unit_cents: cfg.price_cents, payment_required: true, pricing_unit: 'per_day', warnings };
  }

  if (serviceType === 'surfboard') {
    const cfg = addOns.soft_top_rental;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return { amount_due_cents: null, pricing_addon_code: 'soft_top_rental', unit_cents: null, payment_required: false, warnings: ['Surfboard rental price not safely available — staff review required.'] };
    }
    const days = quantity;
    warnings.push('Surfboard preview defaults to soft-top rental pricing — confirm board type with guest.');
    if (cfg.charge_timing === 'REQUIRED_FROM_STAFF') {
      warnings.push('Surfboard charge timing not confirmed — staff may need to confirm.');
    }
    return { amount_due_cents: cfg.price_cents * days, pricing_addon_code: 'soft_top_rental', unit_cents: cfg.price_cents, payment_required: true, pricing_unit: 'per_day', warnings };
  }

  if (serviceType === 'surf_lesson') {
    if (quantity === 1) {
      const cfg = addOns.surf_lesson_single;
      if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
        return { amount_due_cents: null, pricing_addon_code: 'surf_lesson_single', unit_cents: null, payment_required: false, warnings: ['Surf lesson price not safely available — staff review required.'] };
      }
      return { amount_due_cents: cfg.price_cents, pricing_addon_code: 'surf_lesson_single', unit_cents: cfg.price_cents, payment_required: true, pricing_unit: 'per_lesson', warnings };
    }
    const cfg = addOns.surf_lesson_multi;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents_each) {
      return { amount_due_cents: null, pricing_addon_code: 'surf_lesson_multi', unit_cents: null, payment_required: false, warnings: ['Multi-lesson price not safely available — staff review required.'] };
    }
    return { amount_due_cents: cfg.price_cents_each * quantity, pricing_addon_code: 'surf_lesson_multi', unit_cents: cfg.price_cents_each, payment_required: true, pricing_unit: 'per_lesson', warnings };
  }

  if (serviceType === 'yoga') {
    const cfg = addOns.yoga_class;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return { amount_due_cents: null, pricing_addon_code: 'yoga_class', unit_cents: null, payment_required: false, warnings: ['Yoga class price not safely available — staff review required.'] };
    }
    if (cfg.on_site) {
      warnings.push('Yoga is normally booked and paid on site — prepayment only when staff/policy enables it.');
    }
    return { amount_due_cents: cfg.price_cents * quantity, pricing_addon_code: 'yoga_class', unit_cents: cfg.price_cents, payment_required: true, pricing_unit: 'per_class', warnings };
  }

  return {
    amount_due_cents: null,
    pricing_addon_code: null,
    unit_cents: null,
    payment_required: false,
    warnings: [`unsupported service_type "${serviceType}" for pricing preview`],
  };
}

async function lookupBotAddonBooking(bookingCode, clientSlug) {
  return withPgClient(async (pg) => {
    const r = await pg.query(
      `SELECT b.id AS booking_id, b.booking_code, b.guest_name, b.check_in, b.check_out,
              b.status AS booking_status, b.client_id, cl.slug AS client_slug
         FROM bookings b
         JOIN clients cl ON cl.id = b.client_id
        WHERE b.booking_code = $1 AND cl.slug = $2`,
      [bookingCode, clientSlug],
    );
    return r.rows[0] || null;
  });
}

function buildBotAddonDryRunFlags(extra = {}) {
  return {
    preview_only: true,
    no_write_performed: true,
    creates_service_record: false,
    creates_payment: false,
    creates_stripe_link: false,
    sends_whatsapp: false,
    ...extra,
  };
}

async function resolveBotAddonRequestContext(body) {
  const clientSlug    = String(body.client_slug || DEFAULT_CLIENT).trim();
  const bookingCode   = String(body.booking_code || '').trim();
  const guestPhone    = body.guest_phone != null ? String(body.guest_phone).trim() : null;
  const serviceType   = String(body.service_type || '').trim().toLowerCase();
  const serviceDate   = body.service_date != null ? String(body.service_date).trim() : '';
  const paymentChoice = String(body.payment_choice || 'pay_now').trim().toLowerCase();
  const source        = String(body.source || 'luna_whatsapp').trim().slice(0, 50);
  const rawQuantity   = body.quantity;

  if (!serviceType || !BOT_ADDON_SERVICE_TYPES.has(serviceType)) {
    return {
      kind: 'handoff_to_staff',
      status: 422,
      payload: buildBotAddonDryRunFlags({
        success: false,
        next_action: 'handoff_to_staff',
        reply_draft: "I'll have the team help with that add-on request.",
        error: `service_type must be one of: ${[...BOT_ADDON_SERVICE_TYPES].join(', ')}`,
      }),
    };
  }

  if (!bookingCode) {
    return {
      kind: 'booking_not_found',
      status: 200,
      payload: buildBotAddonDryRunFlags({
        success: true,
        next_action: 'booking_not_found',
        reply_draft: "I couldn't find that booking — could you share your booking code?",
        booking_code: null,
        source,
      }),
    };
  }

  if (!serviceDate) {
    return {
      kind: 'ask_service_date',
      status: 200,
      payload: buildBotAddonDryRunFlags({
        success: true,
        next_action: 'ask_service_date',
        reply_draft: 'Which date would you like that for? (YYYY-MM-DD)',
        booking_code: bookingCode,
        service_type: serviceType,
        source,
      }),
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || isNaN(new Date(serviceDate + 'T00:00:00Z').getTime())) {
    return {
      kind: 'ask_service_date',
      status: 200,
      payload: buildBotAddonDryRunFlags({
        success: true,
        next_action: 'ask_service_date',
        reply_draft: 'Please send the date in YYYY-MM-DD format (for example 2026-09-01).',
        booking_code: bookingCode,
        service_type: serviceType,
        source,
      }),
    };
  }

  if (rawQuantity == null || rawQuantity === '' || Number(rawQuantity) <= 0 || !Number.isFinite(Number(rawQuantity))) {
    return {
      kind: 'ask_quantity',
      status: 200,
      payload: buildBotAddonDryRunFlags({
        success: true,
        next_action: 'ask_quantity',
        reply_draft: serviceType === 'wetsuit' || serviceType === 'surfboard'
          ? 'How many days do you need that for?'
          : 'How many would you like?',
        booking_code: bookingCode,
        service_type: serviceType,
        service_date: serviceDate,
        source,
      }),
    };
  }

  const quantity = Math.max(1, parseInt(rawQuantity, 10) || 1);
  const svcDate = new Date(serviceDate + 'T00:00:00Z');

  let booking;
  try {
    booking = await lookupBotAddonBooking(bookingCode, clientSlug);
  } catch (err) {
    return { kind: 'db_error', status: 500, payload: { success: false, error: 'DB lookup failed: ' + err.message } };
  }

  if (!booking) {
    return {
      kind: 'booking_not_found',
      status: 200,
      payload: buildBotAddonDryRunFlags({
        success: true,
        next_action: 'booking_not_found',
        reply_draft: "I couldn't find a booking with that code — I'll ask the team to help.",
        booking_code: bookingCode,
        client_slug: clientSlug,
        source,
      }),
    };
  }

  if (booking.booking_status === 'cancelled' || booking.booking_status === 'expired') {
    return {
      kind: 'handoff_to_staff',
      status: 200,
      payload: buildBotAddonDryRunFlags({
        success: true,
        next_action: 'handoff_to_staff',
        reply_draft: "That booking isn't active anymore — I'll have the team take a look.",
        booking_code: bookingCode,
        booking_id: booking.booking_id,
        source,
      }),
    };
  }

  const pricing = previewGuestAddonPricing(serviceType, quantity, clientSlug);
  const warnings = [...(pricing.warnings || [])];
  const ci = booking.check_in ? new Date(booking.check_in) : null;
  const co = booking.check_out ? new Date(booking.check_out) : null;
  if (ci && co && (svcDate < ci || svcDate >= co)) {
    warnings.push('service_date is outside the booking stay window — staff may need to confirm.');
  }

  const isMeal = serviceType === 'meal';
  const isRecordOnly = isMeal || paymentChoice === 'record_only' || pricing.reason === 'meal_on_site_only';
  const canPay = !isRecordOnly && pricing.payment_required && pricing.amount_due_cents != null && pricing.amount_due_cents > 0;

  let nextAction;
  if (isMeal) {
    nextAction = 'ready_for_record_only';
  } else if (!canPay && pricing.amount_due_cents == null) {
    nextAction = 'handoff_to_staff';
  } else if (canPay) {
    nextAction = 'ready_for_addon_create_dry_run';
  } else {
    nextAction = 'ready_for_record_only';
  }

  return {
    kind: 'ready',
    clientSlug,
    bookingCode,
    guestPhone,
    serviceType,
    serviceDate,
    paymentChoice,
    source,
    quantity,
    svcDate,
    booking,
    pricing,
    warnings,
    isMeal,
    isRecordOnly,
    canPay,
    nextAction,
  };
}

function buildBotAddonServiceMetadata(ctx, idempotencyKey) {
  const meta = {
    source: ctx.source,
    pricing_addon_code: ctx.pricing.pricing_addon_code,
    payment_choice: ctx.paymentChoice,
    needs_scheduling: ctx.serviceType === 'yoga' || ctx.serviceType === 'surf_lesson',
  };
  if (ctx.guestPhone) meta.guest_phone = ctx.guestPhone;
  if (idempotencyKey) meta.idempotency_key = idempotencyKey;
  if (ctx.serviceType === 'wetsuit' || ctx.serviceType === 'surfboard') {
    meta.rental_days = ctx.quantity;
  }
  return meta;
}

async function findBotAddonIdempotentMatch(clientSlug, bookingId, idempotencyKey) {
  return withPgClient(async (pg) => {
    const svc = await pg.query(
      `SELECT id, booking_id, booking_code, service_type, service_date, quantity,
              status, amount_due_cents, amount_paid_cents, payment_status, payment_id
         FROM booking_service_records
        WHERE client_slug = $1
          AND booking_id = $2::uuid
          AND source = 'luna_guest'
          AND metadata->>'idempotency_key' = $3
        LIMIT 1`,
      [clientSlug, bookingId, idempotencyKey],
    );
    if (!svc.rows[0]) return null;
    const serviceRow = svc.rows[0];
    let payment = null;
    if (serviceRow.payment_id) {
      const pm = await pg.query(
        `SELECT id, status, payment_kind, checkout_url, stripe_checkout_session_id, amount_due_cents
           FROM payments
          WHERE id = $1`,
        [serviceRow.payment_id],
      );
      payment = pm.rows[0] || null;
    }
    return { serviceRow, payment };
  });
}

function buildBotAddonCreateReplyDraft(ctx, { checkoutUrl, dbAmountDueCents, servicePaymentStatus }) {
  if (ctx.isMeal) {
    return `Got it — I've noted ${ctx.quantity} meal${ctx.quantity !== 1 ? 's' : ''} for ${ctx.serviceDate}. Meals are handled on site.`;
  }
  if (servicePaymentStatus === 'paid') {
    const eur = (dbAmountDueCents / 100).toFixed(2);
    return `Your ${ctx.serviceType.replace('_', ' ')} add-on for ${ctx.serviceDate} is already paid (€${eur}).`;
  }
  if (checkoutUrl) {
    const eur = (dbAmountDueCents / 100).toFixed(2);
    return `Your ${ctx.serviceType.replace('_', ' ')} add-on for ${ctx.serviceDate} is €${eur}. Here's your payment link: ${checkoutUrl}`;
  }
  return `I've noted your ${ctx.serviceType.replace('_', ' ')} request for ${ctx.serviceDate}.`;
}

async function handleBotAddonRequestPreview(req, res, user, authMode) {
  const started = Date.now();

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }

  const resolvedAuthMode = authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open');
  const ctx = await resolveBotAddonRequestContext(body);

  if (ctx.kind !== 'ready') {
    return sendJSON(res, ctx.status, { ...ctx.payload, auth_mode: resolvedAuthMode });
  }

  let replyDraft;
  if (ctx.nextAction === 'ready_for_record_only' && ctx.isMeal) {
    replyDraft = `Got it — I'll note ${ctx.quantity} meal${ctx.quantity !== 1 ? 's' : ''} for ${ctx.serviceDate}. Meals are handled on site.`;
  } else if (ctx.nextAction === 'handoff_to_staff') {
    replyDraft = "I'll have the team confirm that add-on and get back to you.";
  } else if (ctx.canPay) {
    const eur = (ctx.pricing.amount_due_cents / 100).toFixed(2);
    replyDraft = `For ${ctx.serviceType.replace('_', ' ')} on ${ctx.serviceDate}, the total would be €${eur}. I can send a payment link when you're ready.`;
  } else {
    replyDraft = `I'll note your ${ctx.serviceType.replace('_', ' ')} request for ${ctx.serviceDate}.`;
  }

  const serviceRecordPreview = {
    booking_id: ctx.booking.booking_id,
    booking_code: ctx.booking.booking_code,
    guest_name: ctx.booking.guest_name,
    guest_phone: ctx.guestPhone,
    service_type: ctx.serviceType,
    service_date: ctx.serviceDate,
    quantity: ctx.quantity,
    status: 'confirmed',
    payment_status: ctx.isMeal ? 'not_requested' : (ctx.canPay ? 'pending' : 'not_requested'),
    amount_due_cents: ctx.isMeal ? 0 : (ctx.pricing.amount_due_cents ?? 0),
    source: ctx.source,
    metadata: buildBotAddonServiceMetadata(ctx),
  };

  let paymentPreview = null;
  if (ctx.canPay) {
    paymentPreview = {
      payment_kind: 'addon_service',
      currency: 'EUR',
      amount_due_cents: ctx.pricing.amount_due_cents,
      payment_required: true,
      would_create_payment: true,
      would_create_stripe_link: true,
      metadata_source: 'luna_guest_addon',
    };
  } else if (ctx.isMeal) {
    paymentPreview = {
      payment_required: false,
      reason: 'meal_on_site_only',
      would_create_payment: false,
      would_create_stripe_link: false,
    };
  } else {
    paymentPreview = {
      payment_required: false,
      would_create_payment: false,
      would_create_stripe_link: false,
      ...(ctx.pricing.reason ? { reason: ctx.pricing.reason } : {}),
    };
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts: new Date().toISOString(),
    intent: 'api:bot_addon_request_preview',
    category: 'bot_addon_request_preview',
    preview_only: true,
    no_write_performed: true,
    creates_service_record: false,
    creates_payment: false,
    creates_stripe_link: false,
    sends_whatsapp: false,
    success: true,
    client_slug: ctx.clientSlug,
    booking_code: ctx.bookingCode,
    service_type: ctx.serviceType,
    service_date: ctx.serviceDate,
    quantity: ctx.quantity,
    next_action: ctx.nextAction,
    elapsed_ms: elapsed,
    auth_mode: resolvedAuthMode,
  });

  return sendJSON(res, 200, {
    success: true,
    preview_only: true,
    no_write_performed: true,
    creates_service_record: false,
    creates_payment: false,
    creates_stripe_link: false,
    sends_whatsapp: false,
    client_slug: ctx.clientSlug,
    booking_id: ctx.booking.booking_id,
    booking_code: ctx.booking.booking_code,
    guest_name: ctx.booking.guest_name,
    guest_phone: ctx.guestPhone,
    service_type: ctx.serviceType,
    service_date: ctx.serviceDate,
    quantity: ctx.quantity,
    payment_choice: ctx.paymentChoice,
    source: ctx.source,
    auth_mode: resolvedAuthMode,
    next_action: ctx.nextAction,
    reply_draft: replyDraft,
    service_record_preview: serviceRecordPreview,
    payment_preview: paymentPreview,
    pricing_addon_code: ctx.pricing.pricing_addon_code || null,
    unit_cents: ctx.pricing.unit_cents ?? null,
    amount_due_cents: ctx.pricing.amount_due_cents ?? null,
    warnings: ctx.warnings,
    elapsed_ms: elapsed,
  });
}

async function handleBotAddonRequestCreate(req, res, user, authMode) {
  const started = Date.now();
  const whatsappDryRun = process.env.WHATSAPP_DRY_RUN !== 'false';

  if (!BOT_ADDON_REQUESTS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error: 'Bot add-on request create is disabled. Set BOT_ADDON_REQUESTS_ENABLED=true to enable.',
      bot_addon_requests_enabled: false,
    });
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }

  if (body.confirm !== true) {
    return sendJSON(res, 400, {
      success: false,
      error: 'confirm:true is required to create an add-on request. Call /staff/bot/addon-request-preview first.',
      next_action: 'call_preview_first',
    });
  }

  const resolvedAuthMode = authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open');
  const ctx = await resolveBotAddonRequestContext(body);

  if (ctx.kind !== 'ready') {
    const status = ctx.kind === 'db_error' ? 500 : 422;
    return sendJSON(res, status, { success: false, write_performed: false, ...ctx.payload, auth_mode: resolvedAuthMode });
  }

  if (ctx.isMeal && ctx.paymentChoice !== 'record_only') {
    return sendJSON(res, 422, {
      success: false,
      write_performed: false,
      payment_required: false,
      reason: 'meal_on_site_only',
      error: 'Meals are on-site only — use payment_choice record_only.',
      reply_draft: 'Meals are handled on site — I can note your request without a payment link.',
      auth_mode: resolvedAuthMode,
    });
  }

  if (ctx.nextAction === 'handoff_to_staff') {
    return sendJSON(res, 422, {
      success: false,
      write_performed: false,
      next_action: 'handoff_to_staff',
      reply_draft: "I'll have the team confirm that add-on and get back to you.",
      warnings: ctx.warnings,
      auth_mode: resolvedAuthMode,
    });
  }

  const idempotencyKey = body.idempotency_key
    ? String(body.idempotency_key).trim().slice(0, 120)
    : null;
  const idempotencyKeyMissing = !idempotencyKey;

  if (idempotencyKey) {
    let existingMatch;
    try {
      existingMatch = await findBotAddonIdempotentMatch(
        ctx.clientSlug,
        ctx.booking.booking_id,
        idempotencyKey,
      );
    } catch (err) {
      if (isMissingBookingServiceRecordsTable(err)) {
        return sendJSON(res, 503, {
          success: false,
          error: 'booking_service_records table not available',
          service_records_available: false,
          write_performed: false,
        });
      }
      return sendJSON(res, 500, {
        success: false,
        error: 'Idempotency lookup failed: ' + err.message,
        write_performed: false,
      });
    }

    if (existingMatch) {
      const { serviceRow, payment } = existingMatch;
      const svcPaymentStatus = serviceRow.payment_status;
      const dbAmountDueCents = Number(serviceRow.amount_due_cents || 0);
      let checkoutUrl = null;
      let stripeSessionId = null;

      if (
        payment
        && payment.status === 'checkout_created'
        && payment.checkout_url
        && svcPaymentStatus !== 'paid'
      ) {
        checkoutUrl = payment.checkout_url;
        stripeSessionId = payment.stripe_checkout_session_id;
      }

      const replyDraft = buildBotAddonCreateReplyDraft(ctx, {
        checkoutUrl,
        dbAmountDueCents,
        servicePaymentStatus: svcPaymentStatus,
      });
      const elapsed = Date.now() - started;

      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:bot_addon_request_create',
        category: 'bot_addon_request_create',
        success: true,
        idempotent_duplicate: true,
        client_slug: ctx.clientSlug,
        booking_code: ctx.bookingCode,
        service_record_id: serviceRow.id,
        payment_id: payment?.id || null,
        service_type: ctx.serviceType,
        elapsed_ms: elapsed,
        auth_mode: resolvedAuthMode,
      });

      const idempotentResponse = {
        success: true,
        idempotent: true,
        write_performed: false,
        service_record_id: serviceRow.id,
        booking_id: ctx.booking.booking_id,
        booking_code: ctx.booking.booking_code,
        service_type: serviceRow.service_type,
        service_date: ctx.serviceDate,
        quantity: serviceRow.quantity,
        amount_due_cents: dbAmountDueCents,
        payment_status: svcPaymentStatus,
        no_payment_truth_recorded: true,
        sends_whatsapp: false,
        whatsapp_dry_run: whatsappDryRun,
        no_n8n: true,
        reply_draft: replyDraft,
        auth_mode: resolvedAuthMode,
        elapsed_ms: elapsed,
        message: svcPaymentStatus === 'paid'
          ? 'Add-on request already fulfilled (idempotent — already paid).'
          : 'Add-on request already exists for this idempotency key (idempotent).',
      };

      if (payment?.id) {
        idempotentResponse.payment_id = payment.id;
        idempotentResponse.payment_kind = payment.payment_kind || 'addon_service';
      }
      if (checkoutUrl) {
        idempotentResponse.checkout_url = checkoutUrl;
        idempotentResponse.stripe_checkout_session_id = stripeSessionId;
      }
      if (ctx.isMeal) {
        idempotentResponse.payment_required = false;
        idempotentResponse.reason = 'meal_on_site_only';
      }

      return sendJSON(res, 200, idempotentResponse);
    }
  }

  if (ctx.canPay) {
    if (!STRIPE_LINKS_ENABLED) {
      return sendJSON(res, 403, {
        success: false,
        error: 'Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable.',
        stripe_links_enabled: false,
        write_performed: false,
      });
    }
    if (!STRIPE_SECRET_KEY) {
      return sendJSON(res, 503, { success: false, error: 'STRIPE_SECRET_KEY not configured.', write_performed: false });
    }
    if (!STRIPE_SUCCESS_URL || !STRIPE_CANCEL_URL) {
      return sendJSON(res, 503, {
        success: false,
        error: 'STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL must be set in env.',
        write_performed: false,
      });
    }
  }

  const amountDueCents = ctx.isMeal ? 0 : (ctx.pricing.amount_due_cents ?? 0);
  const paymentStatus = ctx.canPay ? 'pending' : 'not_requested';
  const serviceMeta = buildBotAddonServiceMetadata(ctx, idempotencyKey);

  let writeResult;
  try {
    writeResult = await withPgClient(async (pg) => {
      await pg.query('BEGIN');
      try {
        const ins = await pg.query(
          `INSERT INTO booking_service_records (
             client_slug, booking_id, booking_code, guest_name,
             service_type, service_date, quantity, status,
             amount_due_cents, amount_paid_cents, payment_status,
             source, notes, metadata
           ) VALUES (
             $1, $2::uuid, $3, $4,
             $5, $6::date, $7, 'confirmed',
             $8, 0, $9,
             'luna_guest', $10, $11::jsonb
           ) RETURNING id`,
          [
            ctx.clientSlug,
            ctx.booking.booking_id,
            ctx.booking.booking_code,
            ctx.booking.guest_name,
            ctx.serviceType,
            ctx.serviceDate,
            ctx.quantity,
            amountDueCents,
            paymentStatus,
            null,
            JSON.stringify(serviceMeta),
          ],
        );
        const svcId = ins.rows[0].id;

        if (ctx.canPay) {
          const pmMeta = {
            source: 'luna_guest_addon_request',
            service_record_ids: [svcId],
            booking_code: ctx.booking.booking_code,
            service_type: ctx.serviceType,
            service_date: ctx.serviceDate,
            quantity: ctx.quantity,
            service_record_allocation_cents: { [svcId]: amountDueCents },
          };
          if (idempotencyKey) pmMeta.idempotency_key = idempotencyKey;
          const pmIns = await pg.query(
            `INSERT INTO payments (
               client_id, booking_id, status, payment_kind, currency,
               amount_due_cents, amount_paid_cents, metadata
             ) VALUES (
               $1, $2, 'draft'::payment_record_status, 'addon_service'::payment_kind, 'EUR',
               $3, 0, $4::jsonb
             ) RETURNING id, amount_due_cents`,
            [ctx.booking.client_id, ctx.booking.booking_id, amountDueCents, JSON.stringify(pmMeta)],
          );
          const newPaymentId = pmIns.rows[0].id;
          await pg.query(
            `UPDATE booking_service_records
                SET payment_id = $1, payment_status = 'pending', updated_at = NOW()
              WHERE id = $2`,
            [newPaymentId, svcId],
          );
          await pg.query('COMMIT');
          return {
            serviceRecordId: svcId,
            paymentId: newPaymentId,
            amountDueCents: Number(pmIns.rows[0].amount_due_cents),
          };
        }

        await pg.query('COMMIT');
        return { serviceRecordId: svcId, paymentId: null, amountDueCents };
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
    });
  } catch (err) {
    if (isMissingBookingServiceRecordsTable(err)) {
      return sendJSON(res, 503, {
        success: false,
        error: 'booking_service_records table not available',
        service_records_available: false,
        write_performed: false,
      });
    }
    return sendJSON(res, 500, { success: false, error: 'Failed to create add-on service record: ' + err.message, write_performed: false });
  }

  const serviceRecordId = writeResult.serviceRecordId;
  const paymentId = writeResult.paymentId;
  const dbAmountDueCents = writeResult.amountDueCents;
  let checkoutUrl = null;
  let stripeSessionId = null;

  if (ctx.canPay && paymentId) {
    let stripe;
    try {
      stripe = require('stripe')(STRIPE_SECRET_KEY);
    } catch (e) {
      return sendJSON(res, 500, {
        success: false,
        error: 'Failed to load Stripe SDK: ' + e.message,
        service_record_id: serviceRecordId,
        payment_id: paymentId,
        write_performed: true,
      });
    }

    const productName = `Add-ons — ${ctx.booking.booking_code || ctx.booking.booking_id}`;
    const productDesc = `Luna guest add-on | ${ctx.serviceType} | ${ctx.booking.guest_name || 'Guest'}`;

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        currency: 'eur',
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: productName, description: productDesc },
            unit_amount: dbAmountDueCents,
          },
          quantity: 1,
        }],
        metadata: {
          client_slug: ctx.clientSlug,
          booking_id: ctx.booking.booking_id,
          booking_code: ctx.booking.booking_code || '',
          payment_id: paymentId,
          payment_kind: 'addon_service',
          service_record_ids: JSON.stringify([serviceRecordId]),
          source: 'luna_guest_addon_request',
        },
        success_url: STRIPE_SUCCESS_URL,
        cancel_url: STRIPE_CANCEL_URL,
      });
    } catch (stripeErr) {
      return sendJSON(res, 500, {
        success: false,
        error: 'Stripe session creation failed: ' + stripeErr.message,
        service_record_id: serviceRecordId,
        payment_id: paymentId,
        no_payment_truth_recorded: true,
        write_performed: true,
      });
    }

    checkoutUrl = session.url;
    stripeSessionId = session.id;
    const expiresAt = session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null;

    try {
      await withPgClient(async (pg) => {
        await pg.query(
          `UPDATE payments
              SET status = 'checkout_created'::payment_record_status,
                  stripe_checkout_session_id = $1,
                  checkout_url = $2,
                  expires_at = $3,
                  metadata = metadata || $4::jsonb
            WHERE id = $5`,
          [
            session.id,
            session.url,
            expiresAt,
            JSON.stringify({ stripe_session_id: session.id, stripe_livemode: session.livemode, source: 'luna_guest_addon_request' }),
            paymentId,
          ],
        );
      });
    } catch (dbErr) {
      return sendJSON(res, 500, {
        success: false,
        error: 'Stripe session created but DB update failed: ' + dbErr.message,
        service_record_id: serviceRecordId,
        payment_id: paymentId,
        checkout_url: checkoutUrl,
        no_payment_truth_recorded: true,
        write_performed: true,
      });
    }
  }

  let replyDraft = buildBotAddonCreateReplyDraft(ctx, {
    checkoutUrl,
    dbAmountDueCents,
    servicePaymentStatus: paymentStatus,
  });

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts: new Date().toISOString(),
    intent: 'api:bot_addon_request_create',
    category: 'bot_addon_request_create',
    success: true,
    client_slug: ctx.clientSlug,
    booking_code: ctx.bookingCode,
    service_record_id: serviceRecordId,
    payment_id: paymentId,
    service_type: ctx.serviceType,
    amount_due_cents: dbAmountDueCents,
    stripe_called: !!checkoutUrl,
    whatsapp_called: false,
    n8n_called: false,
    idempotency_key_missing: idempotencyKeyMissing,
    elapsed_ms: elapsed,
    auth_mode: resolvedAuthMode,
  });

  const response = {
    success: true,
    write_performed: true,
    service_record_id: serviceRecordId,
    booking_id: ctx.booking.booking_id,
    booking_code: ctx.booking.booking_code,
    service_type: ctx.serviceType,
    service_date: ctx.serviceDate,
    quantity: ctx.quantity,
    amount_due_cents: dbAmountDueCents,
    payment_status: paymentStatus,
    no_payment_truth_recorded: true,
    sends_whatsapp: false,
    whatsapp_dry_run: whatsappDryRun,
    no_n8n: true,
    reply_draft: replyDraft,
    auth_mode: resolvedAuthMode,
    elapsed_ms: elapsed,
  };

  if (idempotencyKeyMissing) {
    response.idempotency_key_missing = true;
  }

  if (paymentId) {
    response.payment_id = paymentId;
    response.payment_kind = 'addon_service';
  }
  if (checkoutUrl) {
    response.checkout_url = checkoutUrl;
    response.stripe_checkout_session_id = stripeSessionId;
  }
  if (ctx.isMeal) {
    response.payment_required = false;
    response.reason = 'meal_on_site_only';
  }

  return sendJSON(res, 201, response);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9.4b — Luna guest bot pause/resume (bot_pause_states source of truth)
// Does NOT mutate conversations.bot_mode, bookings, payments, or service records.
// ─────────────────────────────────────────────────────────────────────────────

function botPauseControlsDisabledResponse() {
  return {
    success:           false,
    enabled:           false,
    error:             'bot_pause_controls_disabled',
    paused:            false,
    bot_paused:        false,
    live_send_blocked: false,
  };
}

function buildDefaultActivePauseResponse(extra) {
  return Object.assign({
    success:           true,
    paused:            false,
    bot_paused:        false,
    live_send_blocked: false,
    source:            'default_active',
  }, extra || {});
}

function buildPausedStateResponse(pauseStateRow, extra) {
  const pauseState = formatPauseStateRow(pauseStateRow);
  return Object.assign({
    success:           true,
    paused:            true,
    bot_paused:        true,
    live_send_blocked: true,
    source:            'bot_pause_states',
    pause_state:       pauseState,
    client_slug:       pauseState ? pauseState.client_slug : undefined,
    guest_phone:       pauseState ? pauseState.guest_phone : undefined,
    conversation_id:   pauseState ? pauseState.conversation_id : undefined,
    booking_id:        pauseState ? pauseState.booking_id : undefined,
    booking_code:      pauseState ? pauseState.booking_code : undefined,
    pause_reason:      pauseState ? pauseState.pause_reason : undefined,
    paused_by:         pauseState ? pauseState.paused_by : undefined,
    paused_at:         pauseState ? pauseState.paused_at : undefined,
    resumed_by:        pauseState ? pauseState.resumed_by : undefined,
    resumed_at:        pauseState ? pauseState.resumed_at : undefined,
    updated_at:        pauseState ? pauseState.updated_at : undefined,
  }, extra || {});
}

function resolveStaffActorId(user, body, fallback) {
  if (user && user.staff_user_id) return user.staff_user_id;
  if (body && body.staff_user) return String(body.staff_user).trim().slice(0, 200);
  return fallback || 'unknown-staff';
}

async function handleBotPauseStateGet(query, res, user) {
  const started = Date.now();
  const clientSlug = String(query.client_slug || query.client || DEFAULT_CLIENT).trim();
  const conversationId = query.conversation_id != null
    ? String(query.conversation_id).trim() || null
    : null;
  const guestPhone = query.guest_phone != null
    ? String(query.guest_phone).trim() || null
    : null;
  const bookingCode = query.booking_code != null
    ? String(query.booking_code).trim() || null
    : null;

  if (!clientSlug || SQL_INJECT_RE.test(clientSlug)) {
    return send400(res, 'client_slug is required');
  }
  if (!conversationId && !guestPhone && !bookingCode) {
    return send400(res, 'conversation_id, guest_phone, or booking_code is required');
  }

  try {
    const result = await withPgClient((pg) => getPauseState(pg, {
      client_slug:     clientSlug,
      conversation_id: conversationId,
      guest_phone:     guestPhone,
      booking_code:    bookingCode,
    }));

    appendAuditLog(Object.assign({
      ts: new Date().toISOString(),
      intent: 'api:bot.pause-state',
      category: 'bot_pause_api',
      client_slug: clientSlug,
      success: true,
      paused: !!result.row,
      source: result.row ? 'bot_pause_states' : 'default_active',
      table_missing: !!result.table_missing,
      elapsed_ms: Date.now() - started,
    }, user ? { staff_user_id: user.staff_user_id } : {}));

    if (result.row) {
      return sendJSON(res, 200, buildPausedStateResponse(result.row));
    }

    return sendJSON(res, 200, buildDefaultActivePauseResponse({
      client_slug: clientSlug,
      guest_phone: guestPhone,
      conversation_id: conversationId,
      booking_code: bookingCode,
      table_missing: result.table_missing || false,
    }));
  } catch (err) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot.pause-state',
      category: 'bot_pause_api',
      client_slug: clientSlug,
      success: false,
      error: err.message,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 200, buildDefaultActivePauseResponse({
      client_slug: clientSlug,
      guest_phone: guestPhone,
      conversation_id: conversationId,
      booking_code: bookingCode,
      lookup_error: true,
    }));
  }
}

async function handleBotPausePost(req, res, user) {
  const started = Date.now();

  if (!BOT_PAUSE_CONTROLS_ENABLED) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot.pause',
      category: 'bot_pause_api',
      success: false,
      error: 'bot_pause_controls_disabled',
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, botPauseControlsDisabledResponse());
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }

  const clientSlug = String(body.client_slug || DEFAULT_CLIENT).trim();
  const conversationId = body.conversation_id != null
    ? String(body.conversation_id).trim() || null
    : null;
  const guestPhone = body.guest_phone != null
    ? String(body.guest_phone).trim() || null
    : null;

  if (!clientSlug || SQL_INJECT_RE.test(clientSlug)) {
    return send400(res, 'client_slug is required');
  }
  if (!conversationId && !guestPhone) {
    return send400(res, 'conversation_id or guest_phone is required');
  }

  const pausedBy = resolveStaffActorId(user, body, 'pause-local-dev');

  try {
    const result = await withPgClient((pg) => pauseConversation(pg, {
      client_slug:     clientSlug,
      conversation_id: conversationId,
      guest_phone:     guestPhone,
      booking_id:      body.booking_id,
      booking_code:    body.booking_code,
      pause_reason:    body.pause_reason,
      paused_by:       pausedBy,
    }));

    if (result.table_missing) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:bot.pause',
        category: 'bot_pause_api',
        client_slug: clientSlug,
        success: false,
        error: 'bot_pause_states_table_missing',
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 503, {
        success: false,
        error: 'bot_pause_states_table_missing',
        paused: false,
        bot_paused: false,
        live_send_blocked: false,
      });
    }

    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot.pause',
      category: 'bot_pause_api',
      client_slug: clientSlug,
      staff_user_id: pausedBy,
      success: true,
      idempotent: !!result.idempotent,
      elapsed_ms: Date.now() - started,
    });

    return sendJSON(res, 200, buildPausedStateResponse(result.row, {
      idempotent: !!result.idempotent,
    }));
  } catch (err) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot.pause',
      category: 'bot_pause_api',
      client_slug: clientSlug,
      success: false,
      error: err.message,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, { success: false, error: 'pause write failed' });
  }
}

async function handleBotResumePost(req, res, user) {
  const started = Date.now();

  if (!BOT_PAUSE_CONTROLS_ENABLED) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot.resume',
      category: 'bot_pause_api',
      success: false,
      error: 'bot_pause_controls_disabled',
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, botPauseControlsDisabledResponse());
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }

  const clientSlug = String(body.client_slug || DEFAULT_CLIENT).trim();
  const conversationId = body.conversation_id != null
    ? String(body.conversation_id).trim() || null
    : null;
  const guestPhone = body.guest_phone != null
    ? String(body.guest_phone).trim() || null
    : null;

  if (!clientSlug || SQL_INJECT_RE.test(clientSlug)) {
    return send400(res, 'client_slug is required');
  }
  if (!conversationId && !guestPhone) {
    return send400(res, 'conversation_id or guest_phone is required');
  }

  const resumedBy = resolveStaffActorId(user, body, 'resume-local-dev');

  try {
    const result = await withPgClient((pg) => resumeConversation(pg, {
      client_slug:     clientSlug,
      conversation_id: conversationId,
      guest_phone:     guestPhone,
      resumed_by:      resumedBy,
    }));

    if (result.table_missing) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:bot.resume',
        category: 'bot_pause_api',
        client_slug: clientSlug,
        success: false,
        error: 'bot_pause_states_table_missing',
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 503, {
        success: false,
        error: 'bot_pause_states_table_missing',
        paused: false,
        bot_paused: false,
        live_send_blocked: false,
      });
    }

    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot.resume',
      category: 'bot_pause_api',
      client_slug: clientSlug,
      staff_user_id: resumedBy,
      success: true,
      idempotent: !!result.idempotent,
      elapsed_ms: Date.now() - started,
    });

    if (!result.row) {
      return sendJSON(res, 200, Object.assign(buildDefaultActivePauseResponse({
        client_slug: clientSlug,
        guest_phone: guestPhone,
        conversation_id: conversationId,
        idempotent: true,
      }), { pause_state: null }));
    }

    const pauseState = formatPauseStateRow(result.row);
    return sendJSON(res, 200, {
      success:           true,
      paused:            false,
      bot_paused:        false,
      live_send_blocked: false,
      source:            'bot_pause_states',
      pause_state:       pauseState,
      idempotent:        !!result.idempotent,
    });
  } catch (err) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot.resume',
      category: 'bot_pause_api',
      client_slug: clientSlug,
      success: false,
      error: err.message,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, { success: false, error: 'resume write failed' });
  }
}

// Route: POST /staff/bot/booking-preview  (Stage 8.5.2 — Luna bot bridge)
//
// Receives parsed Luna/n8n booking details and returns a safe read-only preview:
//   - missing_fields list (required before booking create)
//   - quote preview from calculateWolfhouseQuote() if dates/guests/package present
//   - availability.status = "not_checked" (DB availability requires bed codes)
//   - next_action: ask_missing_fields | ready_for_create_dry_run |
//                  staff_review_required | show_quote
//   - reply_draft: suggested WhatsApp reply text (NOT sent by this endpoint)
//
// Safety: no DB write, no Stripe, no WhatsApp, no n8n, no booking creation.
//   preview_only: true
//   no_write_performed: true
//   creates_booking: false
//   creates_payment: false
//   creates_stripe_link: false
//   sends_whatsapp: false
//
// Auth: viewer+ (same as /staff/quote-preview).
//   STAFF_AUTH_REQUIRED=false (local/dev): open.
//   STAFF_AUTH_REQUIRED=true: requires session cookie with role >= viewer.
//   n8n auth gap: n8n will need a staff session token or a pre-shared internal
//   token. Auth model for n8n calls is documented in §7 of
//   STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md and addressed later.
// ─────────────────────────────────────────────────────────────────────────────

// Required fields for a bot booking to proceed to create.
// Email is recommended (Stripe receipt) but not hard-blocked here.
const BOT_BOOKING_REQUIRED_FIELDS = [
  'check_in',
  'check_out',
  'guest_count',
  'package_code',
  'room_type',
  'guest_name',
  'phone',
  'payment_choice',
];

// Human-readable labels for missing-field messages
const BOT_FIELD_LABELS = {
  check_in:       'your check-in date',
  check_out:      'your check-out date',
  guest_count:    'how many guests',
  package_code:   'which package (Malibu, Uluwatu, or Waimea)',
  room_type:      'your room preference (shared or private)',
  guest_name:     'your name',
  phone:          'your WhatsApp number',
  payment_choice: 'whether you prefer to pay a deposit or the full amount',
};

async function handleBotBookingPreview(req, res, user, authMode) {
  const started = Date.now();

  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  // ── Extract input fields ──────────────────────────────────────────────────
  const clientSlug    = String(body.client_slug || DEFAULT_CLIENT).trim();
  const phone         = String(body.phone        || '').trim();
  const guestName     = String(body.guest_name   || '').trim();
  const email         = String(body.email        || '').trim();
  const checkIn       = String(body.check_in     || '').trim();
  const checkOut      = String(body.check_out    || '').trim();
  const guestCount    = body.guest_count != null ? Number(body.guest_count) : null;
  const packageCode   = body.package_code != null
    ? String(body.package_code).trim().toLowerCase() : null;
  const roomType      = String(body.room_type     || 'shared').trim();
  const paymentChoice = String(body.payment_choice || '').trim();
  const addOns        = Array.isArray(body.add_ons) ? body.add_ons : [];
  const language      = String(body.language || 'en').trim().slice(0, 10);
  const source        = String(body.source   || 'luna_whatsapp').trim().slice(0, 50);

  const actorId   = user ? user.staff_user_id : 'dev-bot-preview-local';
  const actorRole = user ? user.role          : 'viewer';
  const resolvedAuthMode = authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open');

  // ── Detect missing required fields ────────────────────────────────────────
  const fieldValues = {
    check_in:       checkIn     || null,
    check_out:      checkOut    || null,
    guest_count:    (guestCount != null && guestCount > 0) ? guestCount : null,
    package_code:   packageCode || null,
    room_type:      roomType    || null,
    guest_name:     guestName   || null,
    phone:          phone       || null,
    payment_choice: paymentChoice || null,
  };

  const missingFields = BOT_BOOKING_REQUIRED_FIELDS.filter((f) => !fieldValues[f]);

  // ── Quote preview ─────────────────────────────────────────────────────────
  // Attempt if core quote fields are present: dates, guest count, package.
  // room_type defaults to 'shared' and payment_choice to 'deposit' if absent.
  const canQuote = !!(checkIn && checkOut && guestCount && guestCount > 0 && packageCode);
  let quote = null;
  let quoteError = null;
  if (canQuote) {
    try {
      quote = calculateWolfhouseQuote({
        client_slug:    clientSlug,
        check_in:       checkIn,
        check_out:      checkOut,
        guest_count:    guestCount,
        package_code:   packageCode,
        room_type:      roomType || 'shared',
        payment_choice: paymentChoice || 'deposit',
        add_ons:        addOns,
      });
    } catch (err) {
      quoteError = err.message;
    }
  }

  // ── next_action ───────────────────────────────────────────────────────────
  let nextAction;
  if (missingFields.length > 0) {
    nextAction = 'ask_missing_fields';
  } else if (quoteError) {
    nextAction = 'staff_review_required';
  } else if (quote && !quote.success) {
    nextAction = quote.staff_review_required ? 'staff_review_required' : 'ask_missing_fields';
  } else if (quote && quote.success) {
    nextAction = 'ready_for_create_dry_run';
  } else {
    nextAction = 'show_quote';
  }

  // ── reply_draft ───────────────────────────────────────────────────────────
  let replyDraft;
  if (nextAction === 'ask_missing_fields') {
    const readable = missingFields.map((f) => BOT_FIELD_LABELS[f] || f);
    const shown    = readable.slice(0, 3);
    const extra    = readable.length > 3 ? ` and ${readable.length - 3} more` : '';
    replyDraft = `Great, I can help you book. Could you also share: ${shown.join(', ')}${extra}?`;
  } else if (nextAction === 'staff_review_required') {
    replyDraft = "I'm going to have the team check this and get back to you shortly.";
  } else if ((nextAction === 'ready_for_create_dry_run' || nextAction === 'show_quote') && quote) {
    const totalEur   = (quote.total_cents / 100).toFixed(2);
    const depositEur = (quote.deposit_required_cents / 100).toFixed(2);
    replyDraft = `For those dates, the estimated total is \u20ac${totalEur}. You can pay a \u20ac${depositEur} deposit now or the full amount.`;
  } else {
    replyDraft = 'Let me check those dates and get back to you.';
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  const elapsed = Date.now() - started;
  appendAuditLog({
    ts:                  new Date().toISOString(),
    intent:              'api:bot_booking_preview',
    category:            'bot_booking_preview',
    preview_only:        true,
    no_write_performed:  true,
    creates_booking:     false,
    creates_payment:     false,
    creates_stripe_link: false,
    sends_whatsapp:      false,
    success:             true,
    client_slug:         clientSlug,
    source,
    check_in:            checkIn  || null,
    check_out:           checkOut || null,
    guest_count:         guestCount,
    package_code:        packageCode,
    missing_fields:      missingFields,
    next_action:         nextAction,
    quote_success:       quote ? quote.success : null,
    elapsed_ms:          elapsed,
    staff_user_id:       actorId,
    staff_role:          actorRole,
  });

  return sendJSON(res, 200, {
    success:             true,
    preview_only:        true,
    no_write_performed:  true,
    creates_booking:     false,
    creates_payment:     false,
    creates_stripe_link: false,
    sends_whatsapp:      false,
    source,
    missing_fields:      missingFields,
    has_missing_fields:  missingFields.length > 0,
    next_action:         nextAction,
    reply_draft:         replyDraft,
    quote,
    quote_error:         quoteError || null,
    availability: {
      status:  'not_checked',
      message: 'Availability requires specific bed codes. Call /staff/manual-bookings/preview with selected_bed_codes for a full conflict check.',
    },
    email_recommended: !email,
    auth_mode:         resolvedAuthMode,
    elapsed_ms:        elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/stripe/webhook  (Stage 8.4.11 — Stripe payment truth)
//
// Receives Stripe webhook events and applies payment truth to matching records.
// This is the ONLY path that marks a payment paid.
//
// Auth model:
//   No session auth — Stripe sends the webhook, not a staff user.
//   Identity verified by HMAC signature (stripe-signature header).
//
// Verification:
//   STRIPE_WEBHOOK_SKIP_VERIFY=true  → skip sig check (local fixture testing ONLY)
//   STRIPE_WEBHOOK_SKIP_VERIFY=false → always verify (production default)
//   Missing STRIPE_WEBHOOK_SECRET + verify required → 503, no DB write
//
// Supported events:
//   checkout.session.completed → marks payment paid, updates booking amounts
//   All others → 200 ignored:true (no error)
//
// Idempotency:
//   Already-paid payment → returns 200 idempotent:true, no double-count
//
// Safety:
//   No WhatsApp. No email. No n8n. No confirmation send.
//   No new Stripe checkout session created here.
//   Booking status NOT changed to confirmed here (payment truth only slice).
//   Stage 8.5.14: returns confirmation_draft (dry-run) when payment_status
//   becomes deposit_paid or paid — no send, no confirmation_sent write.
//   Stage 8.5.16: persists confirmation_draft to bookings.metadata.
//   Stage 8.8.21: payment_kind=addon_service → marks linked booking_service_records
//   paid only; does NOT update booking payment amounts or confirmation_draft.
// ─────────────────────────────────────────────────────────────────────────────

function loadClientConfirmationArrival(clientSlug) {
  try {
    const cfgPath = path.join(__dirname, '..', 'config', 'clients', `${clientSlug}.baseline.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      gate_code:  cfg.confirmation?.gate_code || cfg.property?.gate_code || null,
      address:    cfg.confirmation?.address   || cfg.property?.address   || null,
    };
  } catch (_) {
    return { gate_code: null, address: null };
  }
}

function buildPaymentConfirmationDraft(pm, bkPayStatus, bkPaidCents, bkBalanceCents) {
  if (bkPayStatus !== 'deposit_paid' && bkPayStatus !== 'paid') return null;
  const arrival = loadClientConfirmationArrival(pm.client_slug || DEFAULT_CLIENT);
  return {
    booking_code:      pm.booking_code,
    guest_name:        pm.guest_name || null,
    payment_status:    bkPayStatus,
    amount_paid_cents: bkPaidCents,
    balance_due_cents: bkBalanceCents,
    room_number:       pm.primary_room_code || null,
    address:           arrival.address || null,
    gate_code:         arrival.gate_code || null,
    sends_whatsapp:    false,
    whatsapp_dry_run:  true,
  };
}

async function handleStripeWebhook(req, res) {
  const started = Date.now();

  // ── 1. Read raw body (must be Buffer for Stripe signature verification) ────
  let rawBody;
  try {
    rawBody = await readBodyRaw(req, 102400);
  } catch (e) {
    return sendJSON(res, 400, { success: false, error: 'Failed to read request body: ' + e.message });
  }

  // ── 2. Signature verification ─────────────────────────────────────────────
  let event;
  if (STRIPE_WEBHOOK_SKIP_VERIFY) {
    // Local/dev fixture testing only — NEVER enable in production.
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      return sendJSON(res, 400, { success: false, error: 'Invalid JSON payload' });
    }
  } else {
    if (!STRIPE_WEBHOOK_SECRET) {
      return sendJSON(res, 503, {
        success: false,
        error:   'STRIPE_WEBHOOK_SECRET not configured. Set it in env before enabling webhook verification.',
        no_db_write: true,
      });
    }
    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return sendJSON(res, 400, { success: false, error: 'Missing stripe-signature header' });
    }
    let stripe;
    try { stripe = require('stripe')(STRIPE_SECRET_KEY || 'sk_test_placeholder'); }
    catch (e) { return sendJSON(res, 500, { success: false, error: 'Stripe SDK load failed: ' + e.message }); }
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      return sendJSON(res, 400, { success: false, error: 'Webhook signature verification failed: ' + e.message });
    }
  }

  // ── 3. Route event type ───────────────────────────────────────────────────
  const eventType = event && event.type;
  if (eventType !== 'checkout.session.completed') {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'webhook:stripe:ignored',
      category: 'stripe_webhook', event_type: eventType || 'unknown',
    });
    return sendJSON(res, 200, { success: true, ignored: true, event_type: eventType || 'unknown' });
  }

  const session = event.data && event.data.object;
  if (!session) {
    return sendJSON(res, 400, { success: false, error: 'missing event data.object' });
  }

  const sessionId      = session.id;
  const metaPaymentId  = session.metadata && session.metadata.payment_id;
  const metaBookingId  = session.metadata && session.metadata.booking_id;

  // ── 4. Look up payment + booking from DB ──────────────────────────────────
  let pm;
  try {
    pm = await withPgClient(async (pg) => {
      const q = `
        SELECT p.id                     AS payment_id,
               p.booking_id,
               p.client_id,
               p.status                 AS payment_status,
               p.payment_kind,
               p.currency,
               p.amount_due_cents,
               p.amount_paid_cents      AS pm_amount_paid,
               p.stripe_checkout_session_id,
               p.metadata                 AS payment_metadata,
               b.booking_code,
               b.total_amount_cents     AS bk_total,
               b.amount_paid_cents      AS bk_amount_paid,
               b.balance_due_cents      AS bk_balance,
               b.deposit_required_cents AS bk_deposit,
               b.guest_name,
               b.primary_room_code,
               cl.slug                  AS client_slug
          FROM payments p
          JOIN bookings b  ON b.id  = p.booking_id
          JOIN clients  cl ON cl.id = p.client_id
         WHERE ${metaPaymentId ? 'p.id = $1' : 'p.stripe_checkout_session_id = $1'}`;
      const r = await pg.query(q, [metaPaymentId || sessionId]);
      return r.rows[0] || null;
    });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'DB fetch failed: ' + err.message });
  }

  // No matching payment — log and return 200 (don't error; Stripe retries on non-2xx)
  if (!pm) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'webhook:stripe:no_match',
      category: 'stripe_webhook', event_type: eventType,
      session_id: sessionId, meta_payment_id: metaPaymentId || null,
    });
    return sendJSON(res, 200, {
      success: true, ignored: true,
      reason:  'no matching payment found for this session',
      session_id: sessionId,
    });
  }

  // ── 5. Idempotency — already paid ─────────────────────────────────────────
  if (pm.payment_status === 'paid') {
    if (pm.payment_kind === 'addon_service') {
      let svcPaidCount = 0;
      try {
        svcPaidCount = await withPgClient(async (pg) => {
          const r = await pg.query(
            `SELECT COUNT(*)::int AS n FROM booking_service_records
              WHERE payment_id = $1 AND payment_status = 'paid'`,
            [pm.payment_id],
          );
          return r.rows[0].n;
        });
      } catch (_) { /* count optional on idempotent replay */ }
      appendAuditLog({
        ts: new Date().toISOString(), intent: 'webhook:stripe:idempotent',
        category: 'stripe_webhook', payment_id: pm.payment_id, booking_id: pm.booking_id,
        addon_service: true,
      });
      return sendJSON(res, 200, {
        success:                        true,
        idempotent:                     true,
        addon_service_payment:          true,
        service_records_paid_count:     svcPaidCount,
        no_booking_payment_status_change: true,
        no_confirmation_sent:           true,
        no_whatsapp:                    true,
        no_n8n:                         true,
        event_type:                     eventType,
        payment_id:                     pm.payment_id,
        booking_id:                     pm.booking_id,
        booking_code:                   pm.booking_code,
        amount_paid_cents:              Number(pm.pm_amount_paid || 0),
        payment_status:                 'paid',
        message:                        'Add-on payment already marked paid (idempotent — no double-count)',
      });
    }
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'webhook:stripe:idempotent',
      category: 'stripe_webhook', payment_id: pm.payment_id, booking_id: pm.booking_id,
    });
    return sendJSON(res, 200, {
      success:                   true,
      idempotent:                true,
      event_type:                eventType,
      payment_id:                pm.payment_id,
      booking_id:                pm.booking_id,
      booking_code:              pm.booking_code,
      amount_paid_cents:         Number(pm.pm_amount_paid || 0),
      booking_amount_paid_cents: Number(pm.bk_amount_paid || 0),
      booking_balance_due_cents: Number(pm.bk_balance    || 0),
      payment_status:            'paid',
      message:                   'Payment already marked paid (idempotent — no double-count)',
    });
  }

  // ── 6. Validate currency ──────────────────────────────────────────────────
  if ((pm.currency || '').toUpperCase() !== 'EUR') {
    return sendJSON(res, 422, {
      success: false,
      error:   `Currency mismatch: payment currency is '${pm.currency}', expected EUR`,
    });
  }

  // ── 6b. Add-on service payment (Stage 8.8.21) ─────────────────────────────
  // Separate Checkout for mid-stay / Luna add-ons. Marks payment + linked service
  // rows only — never mutates booking deposit/full payment truth.
  if (pm.payment_kind === 'addon_service') {
    const stripePaidCents = Number(session.amount_total || pm.amount_due_cents || 0);
    const newPmPaidCents  = stripePaidCents;
    let serviceRecordsPaidCount = 0;
    let addonWarning = null;

    const pmMeta = (() => {
      const raw = pm.payment_metadata;
      if (raw && typeof raw === 'object') return raw;
      try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
    })();
    const allocationMap = pmMeta.service_record_allocation_cents || {};

    try {
      await withPgClient(async (pg) => {
        await pg.query('BEGIN');
        try {
          await pg.query(
            `UPDATE payments
               SET status                   = 'paid'::payment_record_status,
                   amount_paid_cents        = $1,
                   paid_at                  = NOW(),
                   stripe_payment_intent_id = $2,
                   metadata                 = metadata || $3::jsonb
             WHERE id = $4`,
            [
              newPmPaidCents,
              session.payment_intent || null,
              JSON.stringify({
                stripe_event_id:   event.id,
                stripe_event_type: event.type,
                stripe_session_id: sessionId,
                stripe_livemode:   event.livemode || false,
                skip_verify_used:  STRIPE_WEBHOOK_SKIP_VERIFY,
                source:            'staff_portal_webhook_addon_service_stage8821',
              }),
              pm.payment_id,
            ],
          );

          const linked = await pg.query(
            `SELECT id, amount_due_cents, payment_status
               FROM booking_service_records
              WHERE payment_id = $1`,
            [pm.payment_id],
          );

          for (const row of linked.rows) {
            const dueCents = Number(row.amount_due_cents || 0);
            if (dueCents <= 0) continue;
            if (row.payment_status === 'paid') {
              serviceRecordsPaidCount++;
              continue;
            }
            const allocRaw = allocationMap[row.id];
            const paidCents = allocRaw != null
              ? Math.min(Number(allocRaw), dueCents)
              : dueCents;
            if (paidCents <= 0) continue;

            const upd = await pg.query(
              `UPDATE booking_service_records
                  SET payment_status    = 'paid',
                      amount_paid_cents = $1,
                      status            = 'paid',
                      updated_at        = NOW()
                WHERE id = $2
                  AND payment_id = $3
                  AND payment_status IS DISTINCT FROM 'paid'`,
              [paidCents, row.id, pm.payment_id],
            );
            if (upd.rowCount > 0) serviceRecordsPaidCount++;
          }

          await pg.query('COMMIT');
        } catch (e) {
          try { await pg.query('ROLLBACK'); } catch (_) {}
          throw e;
        }
      });
    } catch (dbErr) {
      appendAuditLog({
        ts: new Date().toISOString(), intent: 'webhook:stripe:db_error',
        category: 'stripe_webhook', payment_id: pm.payment_id, error: dbErr.message,
        addon_service: true,
      });
      return sendJSON(res, 500, { success: false, error: 'DB update failed: ' + dbErr.message });
    }

    if (serviceRecordsPaidCount === 0) {
      addonWarning = 'payment marked paid but no linked payable service records found for payment_id';
    }

    const elapsed = Date.now() - started;
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'webhook:stripe:addon_service_payment_truth',
      category: 'stripe_webhook', event_type: eventType,
      payment_id: pm.payment_id, booking_id: pm.booking_id,
      booking_code: pm.booking_code, amount_paid_cents: newPmPaidCents,
      service_records_paid_count: serviceRecordsPaidCount,
      elapsed_ms: elapsed,
      whatsapp_called: false, n8n_called: false, email_sent: false,
    });

    const addonBody = {
      success:                        true,
      idempotent:                     false,
      addon_service_payment:          true,
      service_records_paid_count:     serviceRecordsPaidCount,
      no_booking_payment_status_change: true,
      no_confirmation_sent:           true,
      no_whatsapp:                    true,
      no_n8n:                         true,
      event_type:                     eventType,
      payment_id:                     pm.payment_id,
      booking_id:                     pm.booking_id,
      booking_code:                   pm.booking_code,
      amount_paid_cents:              newPmPaidCents,
      payment_status:                 'paid',
      elapsed_ms:                     elapsed,
    };
    if (addonWarning) addonBody.warning = addonWarning;
    return sendJSON(res, 200, addonBody);
  }

  // ── 7. Derive amounts (deposit_only / full_amount package payments) ───────
  // Stripe session.amount_total is in smallest currency unit (cents for EUR)
  const stripePaidCents    = Number(session.amount_total || pm.amount_due_cents || 0);
  const newPmPaidCents     = stripePaidCents;   // This payment record
  const prevBkPaid         = Number(pm.bk_amount_paid || 0);
  const bkTotal            = Number(pm.bk_total        || 0);
  const newBkPaid          = Math.min(prevBkPaid + stripePaidCents, bkTotal > 0 ? bkTotal : prevBkPaid + stripePaidCents);
  const newBkBalance       = bkTotal > 0 ? Math.max(bkTotal - newBkPaid, 0) : 0;

  // ── 8. Determine new booking payment_status ───────────────────────────────
  // Use existing payment_status enum values from schema inspection:
  //   not_requested, waiting_payment, payment_link_sent, deposit_paid, paid,
  //   refunded, failed, expired
  let newBkPayStatus;
  if (newBkBalance === 0 && bkTotal > 0) {
    newBkPayStatus = 'paid';
  } else if (pm.payment_kind === 'deposit_only') {
    newBkPayStatus = 'deposit_paid';
  } else {
    newBkPayStatus = 'waiting_payment';
  }

  const confirmationDraft = buildPaymentConfirmationDraft(pm, newBkPayStatus, newBkPaid, newBkBalance);

  // ── 9. Atomic DB update: payment + booking ────────────────────────────────
  try {
    await withPgClient(async (pg) => {
      await pg.query('BEGIN');
      try {
        await pg.query(
          `UPDATE payments
             SET status                   = 'paid'::payment_record_status,
                 amount_paid_cents        = $1,
                 paid_at                  = NOW(),
                 stripe_payment_intent_id = $2,
                 metadata                 = metadata || $3::jsonb
           WHERE id = $4`,
          [
            newPmPaidCents,
            session.payment_intent || null,
            JSON.stringify({
              stripe_event_id:   event.id,
              stripe_event_type: event.type,
              stripe_session_id: sessionId,
              stripe_livemode:   event.livemode || false,
              skip_verify_used:  STRIPE_WEBHOOK_SKIP_VERIFY,
              source:            'staff_portal_webhook_stage8411',
            }),
            pm.payment_id,
          ]
        );
        await pg.query(
          confirmationDraft
            ? `UPDATE bookings
                 SET amount_paid_cents = $1,
                     balance_due_cents = $2,
                     payment_status    = $3::payment_status,
                     metadata          = COALESCE(metadata, '{}'::jsonb)
                                         || jsonb_build_object('confirmation_draft', $5::jsonb)
               WHERE id = $4`
            : `UPDATE bookings
                 SET amount_paid_cents = $1,
                     balance_due_cents = $2,
                     payment_status    = $3::payment_status
               WHERE id = $4`,
          confirmationDraft
            ? [newBkPaid, newBkBalance, newBkPayStatus, pm.booking_id, JSON.stringify(confirmationDraft)]
            : [newBkPaid, newBkBalance, newBkPayStatus, pm.booking_id]
        );
        await pg.query('COMMIT');
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
    });
  } catch (dbErr) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'webhook:stripe:db_error',
      category: 'stripe_webhook', payment_id: pm.payment_id, error: dbErr.message,
    });
    return sendJSON(res, 500, { success: false, error: 'DB update failed: ' + dbErr.message });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts: new Date().toISOString(), intent: 'webhook:stripe:payment_truth',
    category: 'stripe_webhook', event_type: eventType,
    payment_id: pm.payment_id, booking_id: pm.booking_id,
    booking_code: pm.booking_code, amount_paid_cents: newPmPaidCents,
    new_bk_payment_status: newBkPayStatus, elapsed_ms: elapsed,
    whatsapp_called: false, n8n_called: false, email_sent: false,
  });

  // ── 10. Success response ──────────────────────────────────────────────────
  return sendJSON(res, 200, {
    success:                   true,
    idempotent:                false,
    event_type:                eventType,
    payment_id:                pm.payment_id,
    booking_id:                pm.booking_id,
    booking_code:              pm.booking_code,
    amount_paid_cents:         newPmPaidCents,
    booking_amount_paid_cents: newBkPaid,
    booking_balance_due_cents: newBkBalance,
    payment_status:            newBkPayStatus,
    no_whatsapp:               true,
    no_email:                  true,
    no_n8n:                    true,
    no_confirmation_sent:      true,
    confirmation_draft:        confirmationDraft,
    elapsed_ms:                elapsed,
  });
}

// Route: POST /staff/payments/:payment_id/create-stripe-link  (Stage 8.4.9)
//
// Creates a Stripe Checkout Session from an existing draft payment record.
// Booking-first flow: booking exists + draft payment exist before this runs.
// This is the first Stripe integration point; payment truth via webhook is next.
//
// Gates (all must pass):
//   1. STAFF_ACTIONS_ENABLED=true
//   2. STRIPE_LINKS_ENABLED=true   (dedicated flag, default false)
//   3. STRIPE_SECRET_KEY present in env  (sk_test_... test mode only in this slice)
//   4. STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL present in env
//   5. payment exists, status=draft, amount_due_cents>0, currency=EUR
//   6. payment has a booking (booking_id not null, booking belongs to client)
//   7. auth role operator+
//
// Safety:
//   - No payment truth: does NOT set status=paid, does NOT update booking paid amounts.
//   - Sets payment.status = 'checkout_created' (schema enum value).
//   - Sets payment.stripe_checkout_session_id and payment.checkout_url.
//   - Sets payment.expires_at from Stripe session (if available).
//   - Stripe test mode only (key from env; sk_live_ keys produce a config error
//     if STRIPE_LINKS_ENABLED is true — document for prod hardening).
//   - Idempotent check: if session already created, return existing URL (no new session).
//   - No WhatsApp. No n8n. No confirmation send.
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaymentCreateStripeLink(paymentId, req, res, user) {
  const started = Date.now();

  // ── 1. Feature flag gates ─────────────────────────────────────────────────
  if (!STAFF_ACTIONS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error:   'Staff write actions are disabled. Set STAFF_ACTIONS_ENABLED=true to enable.',
      staff_actions_enabled: false,
    });
  }
  if (!STRIPE_LINKS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error:   'Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable.',
      stripe_links_enabled: false,
    });
  }

  // ── 2. Config guards (friendly, never crashes server) ─────────────────────
  if (!STRIPE_SECRET_KEY) {
    return sendJSON(res, 503, {
      success: false,
      error:   'STRIPE_SECRET_KEY not configured. Set it in env before enabling Stripe links.',
      no_db_write: true,
    });
  }
  if (!STRIPE_SUCCESS_URL || !STRIPE_CANCEL_URL) {
    return sendJSON(res, 503, {
      success: false,
      error:   'STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL must be set in env.',
      no_db_write: true,
    });
  }

  // ── 3. Load Stripe SDK lazily (never crashes if require fails) ─────────────
  let stripe;
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch (e) {
    return sendJSON(res, 500, {
      success: false,
      error:   'Failed to load Stripe SDK: ' + e.message,
      no_db_write: true,
    });
  }

  // ── 4. Fetch payment + booking from DB ────────────────────────────────────
  let pm, clientSlug;
  try {
    pm = await withPgClient(async (pg) => {
      const r = await pg.query(
        `SELECT p.id              AS payment_id,
                p.client_id,
                p.booking_id,
                p.status          AS payment_status,
                p.payment_kind,
                p.currency,
                p.amount_due_cents,
                p.stripe_checkout_session_id,
                p.checkout_url,
                b.booking_code,
                b.guest_name,
                b.check_in,
                b.check_out,
                b.status          AS booking_status,
                cl.slug           AS client_slug
           FROM payments p
           JOIN bookings b  ON b.id  = p.booking_id
           JOIN clients  cl ON cl.id = p.client_id
          WHERE p.id = $1`, [paymentId]
      );
      return r.rows[0] || null;
    });
    clientSlug = pm ? pm.client_slug : null;
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'DB fetch failed: ' + err.message });
  }

  // ── 5. Validate payment record ────────────────────────────────────────────
  if (!pm) {
    return sendJSON(res, 404, { success: false, error: 'Payment record not found.' });
  }
  if (pm.payment_status !== 'draft') {
    // Idempotency: already has a session — return existing URL rather than creating a new one
    if (pm.payment_status === 'checkout_created' && pm.checkout_url) {
      return sendJSON(res, 200, {
        success:               true,
        idempotent:            true,
        payment_id:            pm.payment_id,
        booking_id:            pm.booking_id,
        booking_code:          pm.booking_code,
        amount_due_cents:      pm.amount_due_cents,
        currency:              pm.currency,
        stripe_checkout_session_id: pm.stripe_checkout_session_id,
        checkout_url:          pm.checkout_url,
        status:                pm.payment_status,
        no_payment_truth_recorded: true,
        message:               'Stripe session already created (idempotent response).',
      });
    }
    return sendJSON(res, 409, {
      success: false,
      error:   `Payment is in status '${pm.payment_status}'; only 'draft' payments can create a Stripe link.`,
    });
  }
  if (!pm.amount_due_cents || pm.amount_due_cents <= 0) {
    return sendJSON(res, 422, { success: false, error: 'amount_due_cents must be > 0.' });
  }
  if ((pm.currency || '').toUpperCase() !== 'EUR') {
    return sendJSON(res, 422, { success: false, error: `Currency '${pm.currency}' not supported (EUR only).` });
  }

  // ── 6. Create Stripe Checkout Session ─────────────────────────────────────
  const productName = `Booking ${pm.booking_code || paymentId} \u2014 ${pm.guest_name || 'Guest'}`;
  const productDesc = `${pm.payment_kind === 'full_amount' ? 'Full payment' : 'Deposit'} | ` +
    `${pm.check_in || ''} \u2013 ${pm.check_out || ''} | ${clientSlug}`;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode:     'payment',
      currency: 'eur',
      line_items: [{
        price_data: {
          currency:     'eur',
          product_data: {
            name:        productName,
            description: productDesc,
          },
          unit_amount:  pm.amount_due_cents,
        },
        quantity: 1,
      }],
      metadata: {
        client_slug:   clientSlug,
        booking_id:    pm.booking_id,
        booking_code:  pm.booking_code  || '',
        payment_id:    paymentId,
        payment_kind:  pm.payment_kind  || '',
        source:        'staff_portal_manual_booking',
      },
      success_url: STRIPE_SUCCESS_URL,
      cancel_url:  STRIPE_CANCEL_URL,
    });
  } catch (stripeErr) {
    return sendJSON(res, 500, {
      success:     false,
      error:       'Stripe session creation failed: ' + stripeErr.message,
      no_db_write: true,
    });
  }

  // ── 7. Update payment row — checkout_created, session ID, URL, expires_at ─
  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : null;

  try {
    await withPgClient(async (pg) => {
      await pg.query(
        `UPDATE payments
           SET status                      = 'checkout_created'::payment_record_status,
               stripe_checkout_session_id  = $1,
               checkout_url                = $2,
               expires_at                  = $3,
               metadata                    = metadata || $4::jsonb
         WHERE id = $5`,
        [
          session.id,
          session.url,
          expiresAt,
          JSON.stringify({
            stripe_session_id:     session.id,
            stripe_livemode:       session.livemode,
            stripe_payment_status: session.payment_status,
            created_by:            user ? user.staff_user_id : 'manual-local',
            source:                'staff_portal_stage849',
          }),
          paymentId,
        ]
      );
    });
  } catch (dbErr) {
    // Session was created in Stripe but DB update failed — log it, return partial error
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:payment_create_stripe_link',
      category: 'stripe_link_create', success: false,
      error: 'stripe_session_created_but_db_update_failed: ' + dbErr.message,
      payment_id: paymentId, session_id: session.id, elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, {
      success:     false,
      error:       'Stripe session created but DB update failed: ' + dbErr.message,
      session_id:  session.id,
      checkout_url: session.url,
    });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts: new Date().toISOString(), intent: 'api:payment_create_stripe_link',
    category: 'stripe_link_create', success: true,
    payment_id: paymentId, booking_id: pm.booking_id, booking_code: pm.booking_code,
    stripe_session_id: session.id, amount_due_cents: pm.amount_due_cents,
    elapsed_ms: elapsed,
    stripe_called: true, whatsapp_called: false, n8n_called: false,
  });

  // ── 8. Success ─────────────────────────────────────────────────────────────
  return sendJSON(res, 200, {
    success:                   true,
    payment_id:                paymentId,
    booking_id:                pm.booking_id,
    booking_code:              pm.booking_code,
    amount_due_cents:          pm.amount_due_cents,
    currency:                  pm.currency,
    stripe_checkout_session_id: session.id,
    checkout_url:              session.url,
    status:                    'checkout_created',
    no_payment_truth_recorded: true,
    no_whatsapp:               true,
    no_n8n:                    true,
    message:                   'Stripe Checkout Session created. Payment not marked paid until webhook confirms.',
    elapsed_ms:                elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/bookings/:booking_id/service-records/create-payment-link
// (Stage 8.8.23)
//
// Creates addon_service payment + Stripe Checkout for selected service rows.
// Links booking_service_records.payment_id; webhook marks rows paid (8.8.21).
//
// Gates: STAFF_ACTIONS_ENABLED + STRIPE_LINKS_ENABLED + operator auth.
// Safety: no payment truth, no booking payment mutation, no WhatsApp/n8n.
// ─────────────────────────────────────────────────────────────────────────────

async function handleBookingServiceRecordsCreatePaymentLink(bookingId, req, res, user) {
  const started = Date.now();

  if (!STAFF_ACTIONS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error: 'Staff write actions are disabled. Set STAFF_ACTIONS_ENABLED=true to enable.',
      staff_actions_enabled: false,
    });
  }
  if (!STRIPE_LINKS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error: 'Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable.',
      stripe_links_enabled: false,
    });
  }
  if (!STRIPE_SECRET_KEY) {
    return sendJSON(res, 503, {
      success: false,
      error: 'STRIPE_SECRET_KEY not configured.',
      no_db_write: true,
    });
  }
  if (!STRIPE_SUCCESS_URL || !STRIPE_CANCEL_URL) {
    return sendJSON(res, 503, {
      success: false,
      error: 'STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL must be set in env.',
      no_db_write: true,
    });
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }

  const rawIds = body.service_record_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return send400(res, 'service_record_ids must be a non-empty array of UUIDs');
  }
  const serviceRecordIds = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (serviceRecordIds.length === 0) {
    return send400(res, 'service_record_ids must contain at least one UUID');
  }
  for (const id of serviceRecordIds) {
    if (!UUID_VALIDATE_RE.test(id)) {
      return send400(res, `invalid service_record_id: ${id}`);
    }
  }

  let stripe;
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: 'Failed to load Stripe SDK: ' + e.message, no_db_write: true });
  }

  let booking;
  let rows;
  try {
    const result = await withPgClient(async (pg) => {
      const bk = await pg.query(
        `SELECT b.id AS booking_id, b.booking_code, b.guest_name, b.client_id,
                cl.slug AS client_slug
           FROM bookings b
           JOIN clients cl ON cl.id = b.client_id
          WHERE b.id = $1`,
        [bookingId],
      );
      if (!bk.rows[0]) return { booking: null, rows: [] };

      if (user && user.client_id && bk.rows[0].client_id !== user.client_id) {
        return { booking: bk.rows[0], rows: [], forbidden: true };
      }

      const svc = await pg.query(
        `SELECT id, booking_id, service_type, service_date, status, payment_status,
                amount_due_cents, amount_paid_cents, payment_id
           FROM booking_service_records
          WHERE id = ANY($1::uuid[])`,
        [serviceRecordIds],
      );
      return { booking: bk.rows[0], rows: svc.rows, forbidden: false };
    });
    booking = result.booking;
    rows = result.rows;
    if (result.forbidden) {
      return sendJSON(res, 403, { success: false, error: 'Booking not accessible for this staff client.' });
    }
  } catch (err) {
    if (isMissingBookingServiceRecordsTable(err)) {
      return sendJSON(res, 503, {
        success: false,
        error: 'booking_service_records table not available',
        service_records_available: false,
      });
    }
    return sendJSON(res, 500, { success: false, error: 'DB fetch failed: ' + err.message });
  }

  if (!booking) {
    return sendJSON(res, 404, { success: false, error: 'Booking not found.' });
  }
  if (rows.length !== serviceRecordIds.length) {
    return sendJSON(res, 404, {
      success: false,
      error: 'One or more service_record_ids were not found.',
    });
  }

  for (const row of rows) {
    if (row.booking_id !== bookingId) {
      return sendJSON(res, 422, {
        success: false,
        error: `Service record ${row.id} does not belong to booking ${bookingId}.`,
      });
    }
    if (row.status === 'cancelled') {
      return sendJSON(res, 422, {
        success: false,
        error: `Service record ${row.id} is cancelled.`,
      });
    }
    if (row.payment_status === 'paid') {
      return sendJSON(res, 422, {
        success: false,
        error: `Service record ${row.id} is already paid.`,
      });
    }
    if (Number(row.amount_due_cents || 0) <= 0) {
      return sendJSON(res, 422, {
        success: false,
        error: `Service record ${row.id} has no payable amount (amount_due_cents must be > 0).`,
      });
    }
  }

  const linkedPaymentIds = [...new Set(rows.map((r) => r.payment_id).filter(Boolean))];
  if (linkedPaymentIds.length > 1) {
    return sendJSON(res, 409, {
      success: false,
      error: 'Selected service records are linked to different payments.',
    });
  }

  let paymentId;
  let amountDueCents = rows.reduce((sum, r) => sum + Number(r.amount_due_cents || 0), 0);
  const allocation = {};
  for (const row of rows) {
    allocation[row.id] = Number(row.amount_due_cents || 0);
  }

  if (linkedPaymentIds.length === 1) {
    let existingPm;
    try {
      existingPm = await withPgClient(async (pg) => {
        const r = await pg.query(
          `SELECT id, status, payment_kind, amount_due_cents, stripe_checkout_session_id,
                  checkout_url, metadata
             FROM payments WHERE id = $1`,
          [linkedPaymentIds[0]],
        );
        return r.rows[0] || null;
      });
    } catch (err) {
      return sendJSON(res, 500, { success: false, error: 'Payment lookup failed: ' + err.message });
    }

    if (!existingPm) {
      return sendJSON(res, 409, { success: false, error: 'Linked payment record not found.' });
    }
    if (existingPm.payment_kind !== 'addon_service') {
      return sendJSON(res, 409, {
        success: false,
        error: 'Service records are linked to a non-addon payment.',
      });
    }
    if (existingPm.status === 'paid') {
      return sendJSON(res, 409, {
        success: false,
        error: 'Linked add-on payment is already paid.',
      });
    }
    if (existingPm.status === 'checkout_created' && existingPm.checkout_url) {
      return sendJSON(res, 200, {
        success: true,
        idempotent: true,
        payment_id: existingPm.id,
        booking_id: bookingId,
        booking_code: booking.booking_code,
        payment_kind: 'addon_service',
        amount_due_cents: existingPm.amount_due_cents,
        stripe_checkout_session_id: existingPm.stripe_checkout_session_id,
        checkout_url: existingPm.checkout_url,
        service_record_ids: serviceRecordIds,
        no_payment_truth_recorded: true,
        no_whatsapp: true,
        no_n8n: true,
        message: 'Stripe session already created for these service records (idempotent).',
      });
    }
    if (existingPm.status === 'draft') {
      paymentId = existingPm.id;
      amountDueCents = Number(existingPm.amount_due_cents || amountDueCents);
    } else {
      return sendJSON(res, 409, {
        success: false,
        error: `Linked payment is in status '${existingPm.status}'; cannot create checkout link.`,
      });
    }
  }

  if (!paymentId) {
    const paymentMetadata = {
      source: 'staff_portal_addon_service',
      service_record_ids: serviceRecordIds,
      service_record_allocation_cents: allocation,
      booking_code: booking.booking_code,
    };
    try {
      paymentId = await withPgClient(async (pg) => {
        await pg.query('BEGIN');
        try {
          const ins = await pg.query(
            `INSERT INTO payments (
               client_id, booking_id, status, payment_kind, currency,
               amount_due_cents, amount_paid_cents, metadata
             ) VALUES (
               $1, $2, 'draft'::payment_record_status, 'addon_service'::payment_kind, 'EUR',
               $3, 0, $4::jsonb
             ) RETURNING id`,
            [booking.client_id, bookingId, amountDueCents, JSON.stringify(paymentMetadata)],
          );
          const newPaymentId = ins.rows[0].id;
          await pg.query(
            `UPDATE booking_service_records
                SET payment_id = $1,
                    payment_status = 'pending',
                    updated_at = NOW()
              WHERE id = ANY($2::uuid[])`,
            [newPaymentId, serviceRecordIds],
          );
          await pg.query('COMMIT');
          return newPaymentId;
        } catch (e) {
          try { await pg.query('ROLLBACK'); } catch (_) {}
          throw e;
        }
      });
    } catch (err) {
      if (isMissingBookingServiceRecordsTable(err)) {
        return sendJSON(res, 503, {
          success: false,
          error: 'booking_service_records table not available',
          service_records_available: false,
        });
      }
      return sendJSON(res, 500, { success: false, error: 'Failed to create add-on payment: ' + err.message });
    }
  }

  const productName = `Add-ons — ${booking.booking_code || bookingId}`;
  const productDesc = `Service add-ons | ${booking.guest_name || 'Guest'} | ${booking.client_slug}`;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: productName, description: productDesc },
          unit_amount: amountDueCents,
        },
        quantity: 1,
      }],
      metadata: {
        client_slug: booking.client_slug,
        booking_id: bookingId,
        booking_code: booking.booking_code || '',
        payment_id: paymentId,
        payment_kind: 'addon_service',
        service_record_ids: JSON.stringify(serviceRecordIds),
      },
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
    });
  } catch (stripeErr) {
    return sendJSON(res, 500, {
      success: false,
      error: 'Stripe session creation failed: ' + stripeErr.message,
      payment_id: paymentId,
      no_payment_truth_recorded: true,
    });
  }

  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : null;

  try {
    await withPgClient(async (pg) => {
      await pg.query(
        `UPDATE payments
            SET status                     = 'checkout_created'::payment_record_status,
                stripe_checkout_session_id = $1,
                checkout_url               = $2,
                expires_at                 = $3,
                metadata                   = metadata || $4::jsonb
          WHERE id = $5`,
        [
          session.id,
          session.url,
          expiresAt,
          JSON.stringify({
            stripe_session_id: session.id,
            stripe_livemode: session.livemode,
            source: 'staff_portal_addon_service',
            service_record_ids: serviceRecordIds,
            service_record_allocation_cents: allocation,
          }),
          paymentId,
        ],
      );
    });
  } catch (dbErr) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:addon_service_create_payment_link',
      category: 'stripe_link_create',
      success: false,
      error: 'stripe_session_created_but_db_update_failed: ' + dbErr.message,
      payment_id: paymentId,
      session_id: session.id,
    });
    return sendJSON(res, 500, {
      success: false,
      error: 'Stripe session created but DB update failed: ' + dbErr.message,
      payment_id: paymentId,
      checkout_url: session.url,
    });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts: new Date().toISOString(),
    intent: 'api:addon_service_create_payment_link',
    category: 'stripe_link_create',
    success: true,
    payment_id: paymentId,
    booking_id: bookingId,
    booking_code: booking.booking_code,
    service_record_ids: serviceRecordIds,
    amount_due_cents: amountDueCents,
    elapsed_ms: elapsed,
    stripe_called: true,
    whatsapp_called: false,
    n8n_called: false,
  });

  return sendJSON(res, 200, {
    success: true,
    payment_id: paymentId,
    booking_id: bookingId,
    booking_code: booking.booking_code,
    payment_kind: 'addon_service',
    amount_due_cents: amountDueCents,
    stripe_checkout_session_id: session.id,
    checkout_url: session.url,
    service_record_ids: serviceRecordIds,
    status: 'checkout_created',
    no_payment_truth_recorded: true,
    no_whatsapp: true,
    no_n8n: true,
    message: 'Add-on Stripe Checkout Session created. Service rows marked pending until webhook confirms.',
    elapsed_ms: elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/bot/payments/:payment_id/create-stripe-link  (Stage 8.5.5)
//
// Bot-authenticated Stripe Checkout Session creation for Luna/n8n.
// Reuses the same Stripe + DB logic as Stage 8.4.9 (handlePaymentCreateStripeLink).
//
// Gates:
//   1. BOT_BOOKING_ENABLED=true  (STAFF_ACTIONS_ENABLED NOT required for bot path)
//   2. STRIPE_LINKS_ENABLED=true
//   3. STRIPE_SECRET_KEY / STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL in env
//
// Safety:
//   - Does NOT mark payment paid. Does NOT update booking paid amounts.
//   - Sets payment.status = 'checkout_created'. Sets checkout_url / session ID.
//   - No WhatsApp. No n8n. No confirmation send.
//   - Idempotent: if session already exists, returns existing URL.
//   - Amount from payments.amount_due_cents — never from request body.
// ─────────────────────────────────────────────────────────────────────────────

async function handleBotPaymentCreateStripeLink(paymentId, req, res, user, authMode) {
  const started = Date.now();

  // ── 1. Feature flag gates ─────────────────────────────────────────────────
  if (!BOT_BOOKING_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error:   'Bot booking is disabled. Set BOT_BOOKING_ENABLED=true to enable.',
      bot_booking_enabled: false,
    });
  }
  if (!STRIPE_LINKS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error:   'Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable.',
      stripe_links_enabled: false,
    });
  }

  // ── 2. Config guards ──────────────────────────────────────────────────────
  if (!STRIPE_SECRET_KEY) {
    return sendJSON(res, 503, {
      success: false,
      error:   'STRIPE_SECRET_KEY not configured.',
      no_db_write: true,
    });
  }
  if (!STRIPE_SUCCESS_URL || !STRIPE_CANCEL_URL) {
    return sendJSON(res, 503, {
      success: false,
      error:   'STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL must be set in env.',
      no_db_write: true,
    });
  }

  // ── 3. Load Stripe SDK lazily ─────────────────────────────────────────────
  let stripe;
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: 'Failed to load Stripe SDK: ' + e.message, no_db_write: true });
  }

  // ── 4. Fetch payment + booking from DB ────────────────────────────────────
  let pm;
  try {
    pm = await withPgClient(async (pg) => {
      const r = await pg.query(
        `SELECT p.id              AS payment_id,
                p.client_id,
                p.booking_id,
                p.status          AS payment_status,
                p.payment_kind,
                p.currency,
                p.amount_due_cents,
                p.stripe_checkout_session_id,
                p.checkout_url,
                b.booking_code,
                b.guest_name,
                b.check_in,
                b.check_out,
                b.status          AS booking_status,
                cl.slug           AS client_slug
           FROM payments p
           JOIN bookings b  ON b.id  = p.booking_id
           JOIN clients  cl ON cl.id = p.client_id
          WHERE p.id = $1`, [paymentId]
      );
      return r.rows[0] || null;
    });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'DB fetch failed: ' + err.message });
  }

  // ── 5. Validate payment record ────────────────────────────────────────────
  if (!pm) {
    return sendJSON(res, 404, { success: false, error: 'Payment record not found.' });
  }
  if (pm.payment_status !== 'draft') {
    if (pm.payment_status === 'checkout_created' && pm.checkout_url) {
      return sendJSON(res, 200, {
        success:                    true,
        idempotent:                 true,
        source:                     'luna_whatsapp',
        payment_id:                 pm.payment_id,
        booking_id:                 pm.booking_id,
        booking_code:               pm.booking_code,
        amount_due_cents:           pm.amount_due_cents,
        currency:                   pm.currency,
        stripe_checkout_session_id: pm.stripe_checkout_session_id,
        checkout_url:               pm.checkout_url,
        payment_status:             pm.payment_status,
        next_action:                'draft_payment_link_reply',
        sends_whatsapp:             false,
        whatsapp_dry_run:           true,
        no_payment_truth_recorded:  true,
        message: 'Stripe session already created (idempotent response).',
      });
    }
    return sendJSON(res, 409, {
      success: false,
      error:   `Payment status '${pm.payment_status}'; only 'draft' payments can create a Stripe link.`,
    });
  }
  if (!pm.amount_due_cents || pm.amount_due_cents <= 0) {
    return sendJSON(res, 422, { success: false, error: 'amount_due_cents must be > 0.' });
  }
  if ((pm.currency || '').toUpperCase() !== 'EUR') {
    return sendJSON(res, 422, { success: false, error: `Currency '${pm.currency}' not supported (EUR only).` });
  }

  // ── 6. Create Stripe Checkout Session ─────────────────────────────────────
  const productName = `Booking ${pm.booking_code || paymentId} \u2014 ${pm.guest_name || 'Guest'}`;
  const productDesc = `${pm.payment_kind === 'full_amount' ? 'Full payment' : 'Deposit'} | ` +
    `${pm.check_in || ''} \u2013 ${pm.check_out || ''} | ${pm.client_slug}`;
  const actorId = user ? user.staff_user_id : 'luna-bot-internal';

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode:     'payment',
      currency: 'eur',
      line_items: [{
        price_data: {
          currency:     'eur',
          product_data: { name: productName, description: productDesc },
          unit_amount:  pm.amount_due_cents,
        },
        quantity: 1,
      }],
      metadata: {
        client_slug:  pm.client_slug,
        booking_id:   pm.booking_id,
        booking_code: pm.booking_code  || '',
        payment_id:   paymentId,
        payment_kind: pm.payment_kind  || '',
        source:       'bot_stage855',
      },
      success_url: STRIPE_SUCCESS_URL,
      cancel_url:  STRIPE_CANCEL_URL,
    });
  } catch (stripeErr) {
    return sendJSON(res, 500, {
      success:     false,
      error:       'Stripe session creation failed: ' + stripeErr.message,
      no_db_write: true,
    });
  }

  // ── 7. Update payment row ─────────────────────────────────────────────────
  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : null;
  try {
    await withPgClient(async (pg) => {
      await pg.query(
        `UPDATE payments
           SET status                      = 'checkout_created'::payment_record_status,
               stripe_checkout_session_id  = $1,
               checkout_url                = $2,
               expires_at                  = $3,
               metadata                    = metadata || $4::jsonb
         WHERE id = $5`,
        [
          session.id, session.url, expiresAt,
          JSON.stringify({
            stripe_session_id:     session.id,
            stripe_livemode:       session.livemode,
            stripe_payment_status: session.payment_status,
            created_by:            actorId,
            source:                'bot_stage855',
          }),
          paymentId,
        ]
      );
    });
  } catch (dbErr) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bot_payment_create_stripe_link',
      category: 'bot_stripe_link_create', success: false,
      error: 'stripe_session_created_but_db_update_failed: ' + dbErr.message,
      payment_id: paymentId, session_id: session.id, elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, {
      success:     false,
      error:       'Stripe session created but DB update failed: ' + dbErr.message,
      session_id:  session.id,
      checkout_url: session.url,
    });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts: new Date().toISOString(), intent: 'api:bot_payment_create_stripe_link',
    category: 'bot_stripe_link_create', success: true,
    payment_id: paymentId, booking_id: pm.booking_id, booking_code: pm.booking_code,
    stripe_session_id: session.id, amount_due_cents: pm.amount_due_cents,
    auth_mode: authMode, elapsed_ms: elapsed,
    stripe_called: true, whatsapp_called: false, n8n_called: false,
  });

  // ── 8. Success ─────────────────────────────────────────────────────────────
  return sendJSON(res, 200, {
    success:                    true,
    source:                     'luna_whatsapp',
    auth_mode:                  authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
    payment_id:                 paymentId,
    booking_id:                 pm.booking_id,
    booking_code:               pm.booking_code,
    amount_due_cents:           pm.amount_due_cents,
    currency:                   pm.currency,
    stripe_checkout_session_id: session.id,
    checkout_url:               session.url,
    payment_status:             'checkout_created',
    next_action:                'draft_payment_link_reply',
    sends_whatsapp:             false,
    whatsapp_dry_run:           true,
    no_payment_truth_recorded:  true,
    no_n8n:                     true,
    message:                    'Stripe Checkout Session created. Bot can share checkout_url. Payment truth via webhook.',
    elapsed_ms:                 elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/bot/bookings/create  (Stage 8.5.4 — Luna bot booking create)
//
// Creates a booking via the shared engine (same SQL/quote path as Stage 8.4).
// Uses requireBotAuth — accepts X-Luna-Bot-Token or Authorization: Bearer.
// Gated by BOT_BOOKING_ENABLED=true (default false → 403).
//
// Writes: booking + booking_beds + quote_snapshot in metadata + draft payments row.
// Does NOT create a Stripe link. Does NOT send WhatsApp. Does NOT call n8n.
// No Stripe API calls. WHATSAPP_DRY_RUN remains honored throughout.
//
// Returns payment_id for next slice (create_stripe_link).
// ─────────────────────────────────────────────────────────────────────────────

async function handleBotBookingCreate(req, res, user, authMode) {
  const started = Date.now();

  // ── 1. Feature flag gate ──────────────────────────────────────────────────
  if (!BOT_BOOKING_ENABLED) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bot_booking_create',
      category: 'bot_booking_create', success: false,
      error: 'feature_flag_disabled', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, {
      success: false,
      error:   'Bot booking creation is disabled. Set BOT_BOOKING_ENABLED=true to enable.',
      bot_booking_enabled: false,
    });
  }

  // ── 2. Parse body ────────────────────────────────────────────────────────
  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  // ── 3. Extract + sanitise input ──────────────────────────────────────────
  const clientSlug    = String(body.client_slug || DEFAULT_CLIENT).trim();
  const checkIn       = String(body.check_in   || '').trim();
  const checkOut      = String(body.check_out  || '').trim();
  const guestName     = String(body.guest_name || '').trim().slice(0, 200);
  const phone         = String(body.phone      || '').trim().slice(0, 50);
  const email         = String(body.email      || '').trim().slice(0, 200) || null;
  const language      = String(body.language   || 'en').trim().slice(0, 10);
  const guestCount    = parseInt(body.guest_count, 10) || 0;
  const packageCode   = String(body.package_code || '').trim().slice(0, 50) || null;
  const roomType      = String(body.room_type  || 'shared').trim().slice(0, 20);
  const addOns        = Array.isArray(body.add_ons) ? body.add_ons : [];
  const paymentChoice = String(body.payment_choice || 'deposit').trim().toLowerCase();
  const paymentKind   = paymentChoice === 'full' ? 'full_amount' : 'deposit_only';
  const confirmFlag   = body.confirm === true;
  const source        = String(body.source || 'luna_whatsapp').trim().slice(0, 50);
  const notes         = String(body.notes  || '').trim().slice(0, 2000) || null;
  const reason        = String(body.reason || 'Luna bot booking via /staff/bot/bookings/create').trim().slice(0, 500);
  const bookingStatus = 'confirmed';
  const paymentStatus = 'not_requested';

  // selected_bed_codes: required for this slice (auto-assign is next slice)
  let rawBedCodes = body.selected_bed_codes;
  if (typeof rawBedCodes === 'string') {
    rawBedCodes = rawBedCodes.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (!Array.isArray(rawBedCodes)) {
    rawBedCodes = [];
  }
  const selectedBedCodes = rawBedCodes.map(String).slice(0, 20);

  // ── 4. Actor ──────────────────────────────────────────────────────────────
  // For bot token auth, actorId is 'luna-bot-internal'. Role must be 'operator'
  // because buildManualBookingCreateSql enforces MANUAL_BOOKING_ALLOWED_ROLES.
  const actorId   = user ? user.staff_user_id : 'luna-bot-internal';
  const actorRole = (user && user.staff_user_id !== 'luna-bot-internal' && user.role)
    ? user.role
    : 'operator'; // bot token or open-mode actor treated as operator for booking SQL
  const resolvedAuthMode = authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open');

  // ── 5. Validate ───────────────────────────────────────────────────────────
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  if (!phone)         return send400(res, 'phone is required');
  if (!guestName)     return send400(res, 'guest_name is required');
  if (!checkIn || !checkOut) return send400(res, 'check_in and check_out are required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut))
    return send400(res, 'check_in and check_out must be YYYY-MM-DD');
  if (checkOut <= checkIn)  return send400(res, 'check_out must be after check_in');
  if (guestCount < 1)       return send400(res, 'guest_count must be at least 1');
  if (!packageCode || packageCode === 'manual_override')
    return send400(res, 'package_code is required (manual_override not supported)');
  if (!paymentChoice)       return send400(res, 'payment_choice is required (deposit or full)');
  if (!confirmFlag)         return send400(res, 'confirm: true is required in request body');
  if (selectedBedCodes.length === 0)
    return send400(res, 'selected_bed_codes is required for this slice (auto-assign is next slice)');
  if (selectedBedCodes.some((c) => SQL_INJECT_RE.test(c)))
    return send400(res, 'invalid character in selected_bed_codes');

  // ── 5b. Server-side quote (amounts never trusted from client) ─────────────
  const quote = calculateWolfhouseQuote({
    client_slug:    clientSlug,
    check_in:       checkIn,
    check_out:      checkOut,
    guest_count:    guestCount,
    package_code:   packageCode,
    room_type:      roomType,
    payment_choice: paymentChoice,
    add_ons:        addOns,
  });
  if (!quote.success || quote.blockers.length > 0) {
    return send400(res, 'Quote calculation failed: ' + (quote.blockers[0] || 'check pricing config'));
  }
  const depositCents           = quote.deposit_required_cents;
  const totalCents             = quote.total_cents;
  const paymentLinkAmountCents = quote.payment_link_amount_cents;

  // ── 6. Idempotency key ────────────────────────────────────────────────────
  const idempotencyKey = body.idempotency_key
    ? String(body.idempotency_key).slice(0, 120)
    : 'bot-' + crypto.createHash('md5').update([
        clientSlug, checkIn, checkOut, selectedBedCodes.slice().sort().join('_'),
        guestName.toLowerCase(), phone,
      ].join('|')).digest('hex');

  const auditBase = {
    ts: new Date().toISOString(), intent: 'api:bot_booking_create',
    category: 'bot_booking_create',
    client_slug: clientSlug, check_in: checkIn, check_out: checkOut,
    selected_bed_codes: selectedBedCodes, guest_count: guestCount,
    staff_user_id: actorId, staff_role: actorRole,
    idempotency_key: idempotencyKey, source,
    stripe_called: false, whatsapp_called: false, n8n_called: false,
  };

  // ── 7. Execute create inside transaction ──────────────────────────────────
  let row;
  try {
    row = await withPgClient(async (pg) => {
      await pg.query('BEGIN');
      try {
        const r = await pg.query(buildManualBookingCreateSql(), [
          clientSlug,        // $1
          actorId,           // $2
          actorRole,         // $3
          idempotencyKey,    // $4
          null,              // $5 booking_code (auto-generate)
          guestName,         // $6
          phone,             // $7
          email,             // $8
          language,          // $9
          checkIn,           // $10
          checkOut,          // $11
          guestCount,        // $12
          selectedBedCodes,  // $13 text[]
          packageCode,       // $14
          null,              // $15 room_preference
          bookingStatus,     // $16
          paymentStatus,     // $17
          depositCents,      // $18
          totalCents,        // $19
          source,            // $20
          reason,            // $21
          notes,             // $22
          true,              // $23 confirm
          false,             // $24 warnings_acknowledged
        ]);
        const result = r.rows[0] || null;
        if (!result) { await pg.query('ROLLBACK'); return null; }
        if (result.is_duplicate === true) { await pg.query('ROLLBACK'); result._duplicate = true; return result; }
        if (result.is_blocked   === true) { await pg.query('ROLLBACK'); result._blocked   = true; return result; }
        const bedsInserted = Number(result.beds_inserted || 0);
        if (!result.booking_id || bedsInserted < 1 || bedsInserted !== selectedBedCodes.length) {
          await pg.query('ROLLBACK');
          result._safety_violation = true;
          return result;
        }

        // Update booking with quote-derived amounts + quote_snapshot
        await pg.query(
          `UPDATE bookings
             SET total_amount_cents     = $1,
                 deposit_required_cents = $2,
                 balance_due_cents      = $3,
                 requested_room_type    = $4,
                 metadata               = metadata || $5::jsonb
           WHERE id = $6`,
          [
            totalCents, depositCents, quote.balance_due_cents, roomType,
            JSON.stringify({
              quote_snapshot:    quote,
              payment_choice:    paymentChoice,
              add_ons_at_create: addOns,
              bot_source:        source,
            }),
            result.booking_id,
          ]
        );

        // Update draft payment row with quote-driven amounts
        const pmUpdate = await pg.query(
          `UPDATE payments
             SET payment_kind     = $1::payment_kind,
                 amount_due_cents = $2,
                 metadata         = metadata || $3::jsonb
           WHERE booking_id = $4
           RETURNING id AS payment_id`,
          [
            paymentKind, paymentLinkAmountCents,
            JSON.stringify({
              payment_choice:            paymentChoice,
              quote_total_cents:         totalCents,
              payment_link_amount_cents: paymentLinkAmountCents,
              source:                    'bot_booking_stage854',
            }),
            result.booking_id,
          ]
        );
        result._payment_id = pmUpdate.rows.length > 0 ? pmUpdate.rows[0].payment_id : null;

        await pg.query('COMMIT');
        return result;
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: 'write_failed: ' + err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'bot booking create failed', detail: err.message });
  }

  if (!row) {
    appendAuditLog({ ...auditBase, success: false, error: 'no_result_row', elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'no result row returned from helper' });
  }

  const elapsed = Date.now() - started;

  // ── 8. Idempotency duplicate ──────────────────────────────────────────────
  if (row._duplicate) {
    appendAuditLog({ ...auditBase, success: true, idempotent_duplicate: true,
      booking_id: row.duplicate_booking_id, elapsed_ms: elapsed });
    return sendJSON(res, 200, {
      success: true, duplicate: true, idempotent: true,
      booking_id:   row.duplicate_booking_id,
      booking_code: row.duplicate_booking_code,
      message:      'Booking already exists for this request (idempotent).',
      creates_stripe_link: false, sends_whatsapp: false, whatsapp_dry_run: true,
    });
  }

  // ── 9. Blocked ────────────────────────────────────────────────────────────
  if (row._blocked) {
    appendAuditLog({ ...auditBase, success: false, blocked: true,
      block_reason: row.block_reason, elapsed_ms: elapsed });
    const isConflict = row.block_reason === 'overlap_conflict';
    return sendJSON(res, isConflict ? 409 : 422, {
      success: false, blocked: true, block_reason: row.block_reason,
      error: isConflict
        ? 'These dates/beds conflict with an existing booking. Nothing was created.'
        : 'Booking blocked: ' + row.block_reason,
      no_write_performed: true,
      creates_stripe_link: false, sends_whatsapp: false,
    });
  }

  // ── 10. Safety violation ──────────────────────────────────────────────────
  if (row._safety_violation) {
    appendAuditLog({ ...auditBase, success: false,
      error: 'SAFETY_VIOLATION_bed_count_mismatch', beds_inserted: row.beds_inserted, elapsed_ms: elapsed });
    return sendJSON(res, 409, {
      success: false,
      error:   'Booking could not be safely created (bed availability changed). Transaction rolled back.',
      beds_inserted: Number(row.beds_inserted || 0), no_write_performed: true,
    });
  }

  // ── 11. Success ───────────────────────────────────────────────────────────
  appendAuditLog({ ...auditBase, success: true,
    booking_id: row.booking_id, booking_code: row.booking_code,
    payment_id: row._payment_id, beds_inserted: row.beds_inserted,
    audit_event_id: row.audit_event_id, elapsed_ms: elapsed });

  return sendJSON(res, 201, {
    success:             true,
    created:             true,
    source,
    auth_mode:           resolvedAuthMode,
    booking_id:          row.booking_id,
    booking_code:        row.booking_code,
    payment_id:          row._payment_id || null,
    payment_status:      'draft',
    beds_inserted:       Number(row.beds_inserted || 0),
    client_slug:         clientSlug,
    check_in:            checkIn,
    check_out:           checkOut,
    selected_bed_codes:  selectedBedCodes,
    quote: {
      total_cents:               quote.total_cents,
      deposit_required_cents:    quote.deposit_required_cents,
      payment_link_amount_cents: paymentLinkAmountCents,
      payment_kind:              paymentKind,
      formula_summary:           quote.formula_summary,
    },
    next_action:         'create_stripe_link',
    creates_stripe_link: false,
    sends_whatsapp:      false,
    whatsapp_dry_run:    true,
    no_stripe:           true,
    no_n8n:              true,
    message:             'Bot booking created. Draft payment record created. No Stripe link. No WhatsApp.',
    elapsed_ms:          elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 8.8.16 — Manual booking create → booking_service_records
// ─────────────────────────────────────────────────────────────────────────────

/** Map priced add-on codes to operational service_type values (meals excluded). */
const MANUAL_BOOKING_ADDON_SERVICE_MAP = {
  wetsuit_rental:            'wetsuit',
  soft_top_rental:           'surfboard',
  hard_board_rental:         'surfboard',
  wetsuit_soft_top_combo:    null, // expands to wetsuit + surfboard
  wetsuit_hard_board_combo:  null,
  surf_lesson_single:        'surf_lesson',
  surf_lesson_multi:         'surf_lesson',
  yoga_class:                'yoga',
};

const MANUAL_BOOKING_COMBO_REPLACES = {
  wetsuit_soft_top_combo:   ['wetsuit_rental', 'soft_top_rental'],
  wetsuit_hard_board_combo: ['wetsuit_rental', 'hard_board_rental'],
};

function quoteLineItemAmount(quote, code) {
  const items = (quote && Array.isArray(quote.line_items)) ? quote.line_items : [];
  const li = items.find((x) => x.code === code);
  if (!li || li.total_cents == null) return null;
  return Number(li.total_cents);
}

/**
 * Build booking_service_records rows for manual booking create.
 * Amounts come from quote line_items when safely matchable; otherwise 0 + metadata.
 */
function buildManualBookingServiceRecordRows({
  addOns, quote, clientSlug, bookingId, bookingCode, guestName, checkIn, guestCount,
}) {
  const rows = [];
  const addOnList = Array.isArray(addOns) ? addOns : [];
  if (addOnList.length === 0) return rows;

  const replaced = new Set();
  for (const addon of addOnList) {
    const reps = MANUAL_BOOKING_COMBO_REPLACES[addon.code];
    if (reps) for (const r of reps) replaced.add(r);
  }

  function servicePaymentStatus(amountDueCents) {
    return Number(amountDueCents) > 0 ? 'pending' : 'not_requested';
  }

  function pushRow({
    serviceType, quantity, amountDueCents, sourceAddonCode, metadataExtra, needsScheduling,
  }) {
    const meta = {
      source_addon_code: sourceAddonCode,
      ...(metadataExtra || {}),
    };
    if (needsScheduling) meta.needs_scheduling = true;
    const amt = Math.max(0, Number(amountDueCents) || 0);
    rows.push({
      client_slug:        clientSlug,
      booking_id:         bookingId,
      booking_code:       bookingCode,
      guest_name:         guestName,
      service_type:       serviceType,
      service_date:       checkIn,
      quantity:           Math.max(1, Number(quantity) || 1),
      status:             'confirmed',
      amount_due_cents:   amt,
      amount_paid_cents:  0,
      payment_status:     servicePaymentStatus(amt),
      source:             'staff_manual',
      notes:              null,
      metadata:           meta,
    });
  }

  // Combo add-ons → wetsuit + surfboard (amount not split across rows)
  for (const addon of addOnList) {
    if (addon.code !== 'wetsuit_soft_top_combo' && addon.code !== 'wetsuit_hard_board_combo') continue;
    const days = Math.max(1, parseInt(addon.days, 10) || 1);
    const liAmt = quoteLineItemAmount(quote, addon.code);
    const comboMeta = {
      rental_days: days,
      source_quote_line_code: addon.code,
      combo_line_total_cents: liAmt,
      quote_amount_unsplit: true,
    };
    pushRow({
      serviceType: 'wetsuit', quantity: guestCount, amountDueCents: 0,
      sourceAddonCode: addon.code, metadataExtra: { ...comboMeta, combo_part: 'wetsuit' },
    });
    pushRow({
      serviceType: 'surfboard', quantity: guestCount, amountDueCents: 0,
      sourceAddonCode: addon.code, metadataExtra: { ...comboMeta, combo_part: 'surfboard' },
    });
  }

  // Individual rental add-ons
  for (const addon of addOnList) {
    if (replaced.has(addon.code)) continue;
    if (addon.code === 'wetsuit_soft_top_combo' || addon.code === 'wetsuit_hard_board_combo') continue;
    if (addon.code === 'surf_lesson_single' || addon.code === 'surf_lesson_multi') continue;
    if (addon.code === 'yoga_class') continue;
    if (/meal/i.test(addon.code)) continue;

    const serviceType = MANUAL_BOOKING_ADDON_SERVICE_MAP[addon.code];
    if (!serviceType) continue;

    const days = Math.max(1, parseInt(addon.days, 10) || 1);
    const liAmt = quoteLineItemAmount(quote, addon.code);
    pushRow({
      serviceType,
      quantity: guestCount,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: addon.code,
      metadataExtra: {
        rental_days: days,
        source_quote_line_code: addon.code,
        ...(liAmt == null ? { quote_line_not_matched: true } : {}),
      },
    });
  }

  // Surf lessons — pooled quantity (matches quote calculator)
  let totalLessons = 0;
  for (const addon of addOnList) {
    if (addon.code === 'surf_lesson_single' || addon.code === 'surf_lesson_multi') {
      totalLessons += Math.max(1, parseInt(addon.quantity, 10) || 1);
    }
  }
  if (totalLessons > 0) {
    const lessonCode = totalLessons === 1 ? 'surf_lesson_single' : 'surf_lesson_multi';
    const liAmt = quoteLineItemAmount(quote, lessonCode);
    pushRow({
      serviceType: 'surf_lesson',
      quantity: totalLessons,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: lessonCode,
      needsScheduling: true,
      metadataExtra: {
        source_quote_line_code: lessonCode,
        ...(liAmt == null ? { quote_line_not_matched: true } : {}),
      },
    });
  }

  // Yoga classes
  for (const addon of addOnList) {
    if (addon.code !== 'yoga_class') continue;
    const qty = Math.max(1, parseInt(addon.quantity, 10) || 1);
    const liAmt = quoteLineItemAmount(quote, 'yoga_class');
    pushRow({
      serviceType: 'yoga',
      quantity: qty,
      amountDueCents: liAmt != null ? liAmt : 0,
      sourceAddonCode: 'yoga_class',
      needsScheduling: true,
      metadataExtra: {
        source_quote_line_code: 'yoga_class',
        ...(liAmt == null ? { quote_line_not_matched: true } : {}),
      },
    });
  }

  return rows;
}

async function insertManualBookingServiceRecords(pg, rows) {
  if (!rows.length) return { created: 0, available: true, warning: null };
  let created = 0;
  for (const row of rows) {
    await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name,
         service_type, service_date, quantity, status,
         amount_due_cents, amount_paid_cents, payment_status,
         source, notes, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4,
         $5, $6::date, $7, $8,
         $9, $10, $11,
         $12, $13, $14::jsonb
       )`,
      [
        row.client_slug,
        row.booking_id,
        row.booking_code,
        row.guest_name,
        row.service_type,
        row.service_date,
        row.quantity,
        row.status,
        row.amount_due_cents,
        row.amount_paid_cents,
        row.payment_status,
        row.source,
        row.notes,
        JSON.stringify(row.metadata || {}),
      ]
    );
    created++;
  }
  return { created, available: true, warning: null };
}

async function tryInsertManualBookingServiceRecords(pg, rows) {
  if (!rows.length) return { created: 0, available: true, warning: null };
  try {
    return await insertManualBookingServiceRecords(pg, rows);
  } catch (err) {
    if (isMissingBookingServiceRecordsTable(err)) {
      return {
        created:  0,
        available: false,
        warning:  'booking_service_records table not available — service records skipped',
      };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /staff/manual-bookings/create  (Stage 8.4 — PROVISIONAL / DISABLED)
//
// Stage 8.4.8: Booking-first flow, quote-driven amounts.
// calculateWolfhouseQuote() runs server-side; amounts are NEVER trusted from
// the client. quote_snapshot stored in booking.metadata. Draft payment record
// created from quote.payment_link_amount_cents. No Stripe. No WhatsApp. No n8n.
// Stage 8.8.16: When add_ons present, inserts booking_service_records in the
// same transaction (source=staff_manual). Meals excluded. Table-missing → warning.
//
// Required flags (both env vars must be true to use from UI):
//   MANUAL_BOOKING_ENABLED=true  — gates this route (returns 403 if false)
//   STAFF_ACTIONS_ENABLED=true   — UI enablement signal (not checked server-side here)
//
// When enabled, gates (all must pass):
//   1. MANUAL_BOOKING_ENABLED is true         (dedicated feature flag)
//   2. Authenticated session, role operator+  (when STAFF_AUTH_REQUIRED=true)
//   3. confirm: true in request body
//   4. Required fields present and valid
//
// Safety (already enforced in this stub):
//   - Calls buildManualBookingCreateSql() with confirm=true inside BEGIN/COMMIT.
//   - Server re-checks overlap at save time (overlap_check + defense-in-depth
//     NOT EXISTS guard inside the SQL, after row locks are held).
//   - If blocked OR no beds inserted → ROLLBACK, never commits.
//   - Idempotency duplicate → ROLLBACK, returns existing booking (200, idempotent).
//   - Writes one workflow_events audit row on success (inside the txn).
//   - NO Stripe. NO WhatsApp. NO n8n. NO confirmation send. NO bot events.
//   - NO Stripe session, invoice, or payment link is ever created here.
// ─────────────────────────────────────────────────────────────────────────────

// Map UI payment-status values to payment_status enum values.
const MANUAL_BOOKING_PAYMENT_STATUS_MAP = Object.freeze({
  unpaid:          'not_requested',
  not_requested:   'not_requested',
  waiting_payment: 'waiting_payment',
  deposit_paid:    'deposit_paid',
  paid:            'paid',
});

async function handleManualBookingCreate(req, res, user) {
  const started = Date.now();

  // ── 1. Feature flag gate ────────────────────────────────────────────────────
  if (!MANUAL_BOOKING_ENABLED) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:manual_booking_create',
      category: 'manual_booking_create', success: false,
      error: 'feature_flag_disabled', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, {
      success: false,
      error:   'Manual booking creation is disabled. Set MANUAL_BOOKING_ENABLED to true to enable.',
      manual_booking_enabled: false,
    });
  }

  // ── 2. Parse body ────────────────────────────────────────────────────────────
  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  // ── 3. Extract + sanitise input ──────────────────────────────────────────────
  const clientSlug  = String(body.client || body.client_slug || DEFAULT_CLIENT).trim();
  const checkIn     = String(body.check_in  || '').trim();
  const checkOut    = String(body.check_out || '').trim();
  const guestName   = String(body.guest_name || '').trim().slice(0, 200);
  const phone       = String(body.phone || '').trim().slice(0, 50);
  const email       = String(body.email || '').trim().slice(0, 200) || null;
  const language    = String(body.language || 'en').trim().slice(0, 10) || 'en';
  const guestCount  = parseInt(body.guest_count, 10) || 0;
  const roomPref    = String(body.room_preference || '').trim().slice(0, 200) || null;
  const notes       = String(body.notes || '').trim().slice(0, 2000) || null;
  const reason      = String(body.reason || 'Manual booking via Staff Portal Bed Calendar').trim().slice(0, 500);
  const source      = String(body.source || 'staff_manual').trim().slice(0, 50) || 'staff_manual';
  // Stage 8.4.8: quote-driven fields — amounts derived from calculateWolfhouseQuote(), NOT from body
  const packageCode   = String(body.package_code || body.package_or_stay_type || '').trim().slice(0, 50) || null;
  const roomType      = String(body.room_type || 'shared').trim().slice(0, 20) || 'shared';
  const addOns        = Array.isArray(body.add_ons) ? body.add_ons : [];
  const paymentChoice = String(body.payment_choice || 'deposit').trim().toLowerCase();
  const paymentKind   = paymentChoice === 'full' ? 'full_amount' : 'deposit_only';
  const confirmFlag   = body.confirm === true;
  const warningsAck  = body.warnings_acknowledged === true;
  const bookingCode  = body.booking_code ? String(body.booking_code).trim().slice(0, 60) : null;

  // payment_status: map UI value → enum; default not_requested
  const rawPayStatus = String(body.payment_status || 'unpaid').trim().toLowerCase();
  const paymentStatus = MANUAL_BOOKING_PAYMENT_STATUS_MAP[rawPayStatus] || 'not_requested';
  // booking_status: manual staff bookings are confirmed by default
  const bookingStatus = 'confirmed';

  // selected_bed_codes: accept array or comma-separated string
  let rawBedCodes = body.selected_bed_codes;
  if (typeof rawBedCodes === 'string') {
    rawBedCodes = rawBedCodes.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (!Array.isArray(rawBedCodes)) {
    rawBedCodes = [];
  }
  const selectedBedCodes = rawBedCodes.map(String).slice(0, 20);

  // ── 4. Actor (auth) ───────────────────────────────────────────────────────────
  // requireAuth ran in the router. In local open mode (STAFF_AUTH_REQUIRED=false)
  // user is null — use a deterministic local actor; the SQL stores it in audit only.
  const actorId   = user ? user.staff_user_id : 'manual-booking-local';
  const actorRole = user ? user.role          : 'operator';

  // ── 5. Validate ────────────────────────────────────────────────────────────────
  if (SQL_INJECT_RE.test(clientSlug))
    return send400(res, 'invalid client slug');
  if (!checkIn || !checkOut)
    return send400(res, 'check_in and check_out are required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut))
    return send400(res, 'check_in and check_out must be YYYY-MM-DD');
  if (checkOut <= checkIn)
    return send400(res, 'check_out must be after check_in');
  if (selectedBedCodes.length === 0)
    return send400(res, 'selected_bed_codes is required (select empty calendar cells)');
  if (selectedBedCodes.some((c) => SQL_INJECT_RE.test(c)))
    return send400(res, 'invalid character in selected_bed_codes');
  if (!guestName)
    return send400(res, 'guest_name is required');
  if (guestCount < 1)
    return send400(res, 'guest_count must be at least 1');
  if (!confirmFlag)
    return send400(res, 'confirm: true is required in request body');
  if (!MANUAL_BOOKING_ALLOWED_ROLES.includes(actorRole))
    return sendJSON(res, 403, { success: false, error: `Role '${actorRole}' may not create manual bookings.` });

  // ── 5b. Server-side quote calculation (Stage 8.4.8) ──────────────────────────
  // Amounts are never trusted from the client. calculateWolfhouseQuote() is the
  // single source of truth for total, deposit, and payment_link amounts.
  if (!packageCode || packageCode === 'manual_override')
    return send400(res, 'package_code is required for quote-driven booking (manual_override not supported here)');
  const quote = calculateWolfhouseQuote({
    client_slug:    clientSlug,
    check_in:       checkIn,
    check_out:      checkOut,
    guest_count:    guestCount,
    package_code:   packageCode,
    room_type:      roomType,
    payment_choice: paymentChoice,
    add_ons:        addOns,
  });
  if (!quote.success || quote.blockers.length > 0) {
    return send400(res, 'Quote calculation failed: ' + (quote.blockers[0] || 'check pricing config'));
  }
  const depositCents           = quote.deposit_required_cents;
  const totalCents             = quote.total_cents;
  const paymentLinkAmountCents = quote.payment_link_amount_cents;

  // ── 6. Idempotency key ───────────────────────────────────────────────────────
  // Accept caller-provided key; otherwise build a deterministic key from the
  // booking-defining fields so a double-click (identical payload) de-duplicates.
  const idempotencyKey = body.idempotency_key
    ? String(body.idempotency_key).slice(0, 120)
    : 'mb-' + crypto.createHash('md5').update([
        clientSlug, checkIn, checkOut, selectedBedCodes.slice().sort().join('_'),
        guestName.toLowerCase(), phone,
      ].join('|')).digest('hex');

  const auditBase = {
    ts:                 new Date().toISOString(),
    intent:             'api:manual_booking_create',
    category:           'manual_booking_create',
    client_slug:        clientSlug,
    check_in:           checkIn,
    check_out:          checkOut,
    selected_bed_codes: selectedBedCodes,
    guest_count:        guestCount,
    staff_user_id:      actorId,
    staff_role:         actorRole,
    idempotency_key:    idempotencyKey,
    // Side-effect transparency: this path never triggers external systems.
    stripe_called:      false,
    whatsapp_called:    false,
    n8n_called:         false,
  };

  // ── 7. Execute create inside a transaction ────────────────────────────────────
  let row;
  try {
    row = await withPgClient(async (pg) => {
      await pg.query('BEGIN');
      try {
        const r = await pg.query(buildManualBookingCreateSql(), [
          clientSlug,        // $1
          actorId,           // $2
          actorRole,         // $3
          idempotencyKey,    // $4
          bookingCode,       // $5 (nullable → auto-generate)
          guestName,         // $6
          phone,             // $7
          email,             // $8
          language,          // $9
          checkIn,           // $10
          checkOut,          // $11
          guestCount,        // $12
          selectedBedCodes,  // $13 text[]
          packageCode,       // $14  (Stage 8.4.8: from quote, not package_or_stay_type)
          roomPref,          // $15
          bookingStatus,     // $16
          paymentStatus,     // $17
          depositCents,      // $18
          totalCents,        // $19
          source,            // $20
          reason,            // $21
          notes,             // $22
          true,              // $23 confirm
          warningsAck,       // $24
        ]);
        const result = r.rows[0] || null;

        if (!result) {
          await pg.query('ROLLBACK');
          return null;
        }

        // Idempotency duplicate → no new row was inserted; roll back and signal.
        if (result.is_duplicate === true) {
          await pg.query('ROLLBACK');
          result._duplicate = true;
          return result;
        }

        // Any other blocker (validation / overlap conflict) → roll back.
        if (result.is_blocked === true) {
          await pg.query('ROLLBACK');
          result._blocked = true;
          return result;
        }

        // Safety: booking row must exist and bed assignments must match selection.
        const bedsInserted = Number(result.beds_inserted || 0);
        if (!result.booking_id || bedsInserted < 1 || bedsInserted !== selectedBedCodes.length) {
          await pg.query('ROLLBACK');
          result._safety_violation = true;
          return result;
        }

        // Stage 8.4.8: Update booking with quote-derived amounts + quote_snapshot in metadata
        await pg.query(
          `UPDATE bookings
             SET total_amount_cents      = $1,
                 deposit_required_cents  = $2,
                 balance_due_cents       = $3,
                 requested_room_type     = $4,
                 metadata                = metadata || $5::jsonb
           WHERE id = $6`,
          [
            totalCents,
            depositCents,
            quote.balance_due_cents,
            roomType,
            JSON.stringify({
              quote_snapshot:   quote,
              payment_choice:   paymentChoice,
              add_ons_at_create: addOns,
            }),
            result.booking_id,
          ]
        );

        // Stage 8.4.8: Update payment record — payment_kind from payment_choice + correct amount
        // Stage 8.4.10: RETURNING id so payment_id can be included in the API response
        const pmUpdate = await pg.query(
          `UPDATE payments
             SET payment_kind     = $1::payment_kind,
                 amount_due_cents = $2,
                 metadata         = metadata || $3::jsonb
           WHERE booking_id = $4
           RETURNING id AS payment_id`,
          [
            paymentKind,
            paymentLinkAmountCents,
            JSON.stringify({
              payment_choice:            paymentChoice,
              quote_total_cents:         totalCents,
              payment_link_amount_cents: paymentLinkAmountCents,
              source:                    'quote_driven_stage848',
            }),
            result.booking_id,
          ]
        );
        result._payment_id = pmUpdate.rows.length > 0 ? pmUpdate.rows[0].payment_id : null;

        // Stage 8.8.16: booking_service_records for priced add-ons (same transaction)
        const serviceRecordRows = buildManualBookingServiceRecordRows({
          addOns,
          quote,
          clientSlug,
          bookingId:   result.booking_id,
          bookingCode: result.booking_code,
          guestName,
          checkIn,
          guestCount,
        });
        const svcInsert = await tryInsertManualBookingServiceRecords(pg, serviceRecordRows);
        result._service_records_created   = svcInsert.created;
        result._service_records_available = svcInsert.available;
        result._service_records_warning   = svcInsert.warning;

        await pg.query('COMMIT');
        return result;
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: 'write_failed: ' + err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'manual booking create failed', detail: err.message });
  }

  if (!row) {
    appendAuditLog({ ...auditBase, success: false, error: 'no_result_row', elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'no result row returned from helper' });
  }

  const elapsed = Date.now() - started;

  // ── 8. Idempotency duplicate (idempotent success) ─────────────────────────────
  if (row._duplicate) {
    appendAuditLog({ ...auditBase, success: true, idempotent_duplicate: true,
      booking_id: row.duplicate_booking_id, elapsed_ms: elapsed });
    return sendJSON(res, 200, {
      success:        true,
      duplicate:      true,
      idempotent:     true,
      booking_id:     row.duplicate_booking_id,
      booking_code:   row.duplicate_booking_code,
      message:        'Booking already exists for this request (idempotent).',
      no_stripe:      true, no_whatsapp: true, no_n8n: true,
    });
  }

  // ── 9. Blocked (validation / overlap conflict) ────────────────────────────────
  if (row._blocked) {
    appendAuditLog({ ...auditBase, success: false, blocked: true,
      block_reason: row.block_reason, elapsed_ms: elapsed });
    const isConflict = row.block_reason === 'overlap_conflict';
    return sendJSON(res, isConflict ? 409 : 422, {
      success:      false,
      blocked:      true,
      block_reason: row.block_reason,
      error:        isConflict
        ? 'These dates/beds conflict with an existing booking. Nothing was created.'
        : 'Manual booking blocked: ' + row.block_reason,
      no_write_performed: true,
      no_stripe: true, no_whatsapp: true, no_n8n: true,
    });
  }

  // ── 10. Safety violation ───────────────────────────────────────────────────────
  if (row._safety_violation) {
    appendAuditLog({ ...auditBase, success: false,
      error: 'SAFETY_VIOLATION_bed_count_mismatch',
      beds_inserted: row.beds_inserted, elapsed_ms: elapsed });
    return sendJSON(res, 409, {
      success: false,
      error:   'Booking could not be safely created (bed availability changed). Transaction rolled back.',
      beds_inserted: Number(row.beds_inserted || 0),
      no_write_performed: true,
    });
  }

  // ── 11. Success ────────────────────────────────────────────────────────────────
  appendAuditLog({ ...auditBase, success: true,
    booking_id: row.booking_id, booking_code: row.booking_code,
    beds_inserted: row.beds_inserted, payments_inserted: row.payments_inserted,
    audit_event_id: row.audit_event_id, elapsed_ms: elapsed });

  return sendJSON(res, 201, {
    success:           true,
    booking_id:        row.booking_id,
    booking_code:      row.booking_code,
    payment_id:        row._payment_id || null,   // Stage 8.4.10: for Stripe link creation
    beds_inserted:     Number(row.beds_inserted || 0),
    payments_inserted: Number(row.payments_inserted || 0),
    audit_event_id:    row.audit_event_id,
    client_slug:       clientSlug,
    check_in:          checkIn,
    check_out:         checkOut,
    selected_bed_codes: selectedBedCodes,
    payment_status:    paymentStatus,
    booking_status:    bookingStatus,
    // Stage 8.4.8: quote summary from server-side calculation
    quote_summary: {
      total_cents:               quote.total_cents,
      deposit_required_cents:    quote.deposit_required_cents,
      payment_link_amount_cents: paymentLinkAmountCents,
      payment_kind:              paymentKind,
      formula_summary:           quote.formula_summary,
      no_stripe_link:            true,
    },
    no_stripe:         true,
    no_whatsapp:       true,
    no_n8n:            true,
    service_records_created:   Number(row._service_records_created || 0),
    service_records_available: row._service_records_available !== false,
    service_records_warning:   row._service_records_warning || null,
    message:           'Manual booking created. Draft payment record created. No Stripe link yet.',
    elapsed_ms:        elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /staff/ui  (Stage 7.7c — Cami dashboard + query tools)
//
// Two-tab self-contained HTML UI. No CDN, no framework, no write controls.
//   Tab 1 (default): Conversations — Cami inbox from GET /staff/conversations
//   Tab 2: Query Tools — existing registry-based staff query interface
//
// Safety constraints (same as Stage 6.8):
//   - All data via GET fetch to same-origin endpoints only
//   - GET-only fetch calls from JS (no mutation methods)
//   - No external scripts, no write form controls, no dynamic code execution
//   - No handoff.resolve, no approve-send, no reply composer, no send button
//   - READ-ONLY / SHADOW MODE banner visible at all times
// ─────────────────────────────────────────────────────────────────────────────

function buildUiHtml(port) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luna Front Desk</title>
<style>
/* ── Palette (soft boutique-hospitality) ────────────────────────────────── */
:root{
  --cream:#F7F3EC;        /* page background */
  --surface:#FFFDFA;      /* card surface */
  --surface-soft:#FBF7F0; /* inset / muted surface */
  --sand:#E9DDCF;         /* light sand */
  --tan:#DCC8B7;          /* soft tan */
  --sage:#AFC3A3;         /* sage green */
  --olive:#8FA58E;        /* muted olive/sage */
  --dusty-blue:#B7CAD6;   /* dusty blue */
  --ocean:#95B4C7;        /* soft ocean blue */
  --teal:#C7DDD7;         /* pale teal */
  --text:#44504A;         /* main text */
  --text-2:#6B756F;       /* secondary text */
  --text-3:#97A09A;       /* muted/tertiary text */
  --border:#E6DCCD;       /* soft warm border */
  --border-soft:#EFE8DC;  /* subtle divider */
  --radius:14px;
  --radius-sm:10px;
  --radius-pill:999px;
  --shadow:0 1px 2px rgba(68,80,74,.05),0 6px 18px rgba(68,80,74,.06);
  --shadow-soft:0 1px 2px rgba(68,80,74,.04),0 3px 10px rgba(68,80,74,.04);
  --primary:#7E947D;      /* primary action (deep sage) */
  --primary-hover:#6C8268;
  --focus:#95B4C7;        /* focus ring (ocean) */
}
/* ── Reset + base ───────────────────────────────────────────────────────── */
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;background:var(--cream);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased}
::selection{background:var(--teal);color:var(--text)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
/* ── Top banner ─────────────────────────────────────────────────────────── */
#banner{background:linear-gradient(120deg,#8FA58E 0%,#95B4C7 100%);color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 12px rgba(68,80,74,.10)}
#banner .brand{font-size:16px;font-weight:700;letter-spacing:.02em;flex:1;display:flex;align-items:center;gap:10px}
.btn-logout{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.45);color:#fff;border-radius:20px;padding:5px 16px;font-size:12px;font-weight:600;cursor:pointer;transition:background .18s;letter-spacing:.03em;margin-left:auto}
.btn-logout:hover{background:rgba(255,255,255,.32)}
#banner .brand::before{content:"";width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#FFFDFA 0%,#E9DDCF 55%,#DCC8B7 100%);box-shadow:0 1px 4px rgba(68,80,74,.25);flex-shrink:0}
#banner .brand em{color:#FBF7F0;font-style:normal;font-weight:500;opacity:.92}
#banner .badge{background:rgba(255,253,250,.22);color:#fff;font-size:10.5px;font-weight:700;letter-spacing:.10em;padding:4px 12px;border-radius:var(--radius-pill);white-space:nowrap;backdrop-filter:blur(2px);border:1px solid rgba(255,255,255,.28)}
#banner .badge-sm{background:rgba(68,80,74,.18);color:#FBF7F0;font-size:10px;padding:3px 10px;border-radius:var(--radius-pill);letter-spacing:.04em}
/* ── Tabs ───────────────────────────────────────────────────────────────── */
#tabs{background:var(--surface);border-bottom:1px solid var(--border);display:flex;padding:0 28px;box-shadow:var(--shadow-soft)}
.tab-btn{padding:14px 22px;font-size:13px;font-weight:600;color:var(--text-2);border:none;border-bottom:3px solid transparent;background:none;cursor:pointer;margin-bottom:-1px;transition:color .18s,border-color .18s}
.tab-btn:hover{color:var(--text)}
.tab-btn.active{color:var(--primary);border-bottom-color:var(--sage)}
/* ── Layout ─────────────────────────────────────────────────────────────── */
#wrap{max-width:1200px;margin:0 auto;padding:26px 20px}
.tab-panel{display:none}
.tab-panel.active{display:block}
/* ── Cards ──────────────────────────────────────────────────────────────── */
.card{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:22px 24px;margin-bottom:20px;box-shadow:var(--shadow)}
/* ── Toolbar ─────────────────────────────────────────────────────────────── */
.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap}
.toolbar h2{font-size:16px;font-weight:700;color:var(--text);flex:1;letter-spacing:.01em}
.btn{border:none;border-radius:var(--radius-sm);padding:9px 18px;font-size:12px;font-weight:600;cursor:pointer;transition:background .18s,box-shadow .18s,transform .04s;letter-spacing:.01em}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--primary);color:#fff;box-shadow:0 1px 3px rgba(68,80,74,.14)}
.btn-primary:hover{background:var(--primary-hover)}
.btn-primary:disabled{background:#C9CFC8;color:#F2F1EC;cursor:default;box-shadow:none}
.btn-ghost{background:var(--surface);border:1px solid var(--border);color:var(--text-2)}
.btn-ghost:hover{background:var(--surface-soft);border-color:var(--tan)}
/* ── Status pills ───────────────────────────────────────────────────────── */
.pill{display:inline-block;font-size:10.5px;font-weight:700;padding:3px 10px;border-radius:var(--radius-pill);white-space:nowrap;letter-spacing:.03em;border:1px solid transparent}
.pill-red{background:#EFD9D0;color:#9C5742;border-color:#E6C7BC}      /* urgent — soft terracotta */
.pill-orange{background:#F5E6D2;color:#A2743D;border-color:#ECD7BC}   /* needs review — peach/amber */
.pill-blue{background:#DCE7EE;color:#4E6A7B;border-color:#CBDBE5}      /* neutral — dusty blue */
.pill-green{background:#DCEAD2;color:#5C7350;border-color:#CADCBE}     /* confirmed — sage */
.pill-grey{background:#E8E5DE;color:#83897F;border-color:#DDD8CE}      /* cancelled — pale warm gray */
/* ── Inbox two-column layout (WhatsApp Web style) ─────────────────────────── */
.inbox-two-col{display:flex;border:1px solid var(--border-soft);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;min-height:600px;max-height:calc(100vh - 160px)}
.inbox-left{width:300px;flex-shrink:0;border-right:1px solid var(--border-soft);display:flex;flex-direction:column;background:var(--surface);overflow:hidden}
.inbox-left-toolbar{padding:12px 14px;border-bottom:1px solid var(--border-soft);display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex-shrink:0;background:var(--surface-soft)}
.inbox-left-toolbar h2{font-size:14px;font-weight:700;color:var(--text);flex:1;letter-spacing:.01em}
.conv-list{flex:1;overflow-y:auto}
/* ── Conversation cards (left list) ──────────────────────────────────────── */
.conv-card{padding:13px 16px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .14s;position:relative}
.conv-card:hover{background:var(--surface-soft)}
.conv-card.selected{background:var(--teal);border-left:3px solid var(--sage)}
.conv-card-name{font-size:13.5px;font-weight:700;color:var(--text);margin-bottom:3px}
.conv-card-phone{font-size:11.5px;color:var(--text-2);margin-bottom:6px}
.conv-card-pills{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.conv-card-handoff{font-size:11px;color:var(--text-2);margin-top:5px;font-style:italic}
.conv-list-empty{padding:24px 16px;color:var(--text-3);font-size:13px;text-align:center;font-style:italic}
/* ── Inbox right panel ───────────────────────────────────────────────────── */
.inbox-right{flex:1;overflow-y:auto;padding:24px;background:var(--surface)}
.inbox-empty-right{display:flex;flex-direction:column;align-items:center;justify-content:center;padding-top:80px;color:var(--text-3);text-align:center;gap:10px}
.inbox-empty-right .main-msg{font-size:14px;font-weight:600;color:var(--text-2)}
.inbox-empty-right .sub-msg{font-size:12.5px}
/* Preserve helper classes used in detail JS */
.guest-name{font-weight:600;color:var(--text)}
/* ── Detail pane (right column of inbox two-column layout) ─────────────────── */
#conv-detail{flex:1;overflow-y:auto;padding:24px;background:var(--surface)}
/* .visible no longer toggles display — kept for JS compat, no visual effect */
.detail-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
.detail-name{font-size:18px;font-weight:700;color:var(--text);letter-spacing:.01em}
.detail-meta{font-size:12px;color:var(--text-2);margin-top:4px}
.detail-section{margin-top:18px;padding-top:18px;border-top:1px solid var(--border-soft)}
.detail-section h3{font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.kv{display:flex;flex-direction:column;gap:3px}
.kv .k{font-size:10.5px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.kv .v{font-size:13px;color:var(--text);font-weight:500}
/* .back-btn removed — inbox is persistent two-column (no back navigation needed) */
/* ── Detail two-column layout ────────────────────────────────────────────── */
.detail-layout{display:flex;gap:16px;align-items:flex-start;margin-top:14px}
.detail-main{flex:1;min-width:0}
.detail-sidebar{width:280px;flex-shrink:0}
@media(max-width:860px){.detail-layout{flex-direction:column}.detail-sidebar{width:100%}}
/* ── Message thread ──────────────────────────────────────────────────────── */
.thread-section h3{font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.thread{display:flex;flex-direction:column;gap:12px;max-height:420px;overflow-y:auto;padding:18px;background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius)}
.msg{display:flex;flex-direction:column;max-width:78%}
.msg.inbound{align-self:flex-start}
.msg.outbound{align-self:flex-end}
.msg-bubble{padding:10px 14px;border-radius:16px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;box-shadow:var(--shadow-soft)}
.msg.inbound .msg-bubble{background:#DCE7EE;color:#3D5360;border-bottom-left-radius:5px}
.msg.outbound .msg-bubble{background:#DCEAD2;color:#4C6048;border-bottom-right-radius:5px}
.msg-meta{font-size:10px;color:var(--text-3);margin-top:5px;padding:0 4px}
.msg.outbound .msg-meta{text-align:right}
.thread-empty{color:var(--text-3);text-align:center;padding:28px;font-size:13px;font-style:italic}
/* ── Luna draft panel ────────────────────────────────────────────────────── */
.draft-panel{margin-top:18px;padding-top:16px;border-top:1px solid var(--border-soft)}
.draft-label{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.draft-label h3{font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin:0}
.draft-not-sent{background:#EFD9D0;color:#9C5742;font-size:9.5px;font-weight:700;letter-spacing:.06em;padding:3px 9px;border-radius:var(--radius-pill);white-space:nowrap}
#draft-textarea{width:100%;min-height:104px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;font-size:13px;line-height:1.55;font-family:inherit;resize:vertical;background:var(--surface);color:var(--text);transition:border-color .15s,box-shadow .15s}
#draft-textarea:focus{outline:none;border-color:var(--ocean);box-shadow:0 0 0 3px rgba(149,180,199,.18)}
.draft-actions{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.draft-warning{font-size:11px;color:#A2743D;flex:1;min-width:180px}
.btn-copy{background:var(--ocean);color:#fff;border:none;border-radius:var(--radius-sm);padding:9px 16px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .18s}
.btn-copy:hover{background:#7FA3B8}
.btn-send-disabled{background:#D5D2CA;color:#FBF7F0;border:none;border-radius:var(--radius-sm);padding:9px 16px;font-size:12px;font-weight:600;cursor:not-allowed;opacity:.8;white-space:nowrap}
.copy-confirm{font-size:11px;color:#5C7350;font-weight:700}
/* ── Shadow-mode workflow checklist (Stage 7.7j) ─────────────────────────── */
.shadow-checklist{background:#EBF1E5;border:1px solid #CFDFC3;border-radius:var(--radius-sm);padding:12px 16px;margin-top:12px}
.shadow-checklist-title{font-size:10.5px;font-weight:700;color:#5C7350;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.shadow-checklist-steps{margin:0;padding-left:18px;font-size:12px;color:var(--text);line-height:1.75}
.shadow-checklist-gate{color:#9C5742;font-size:11px;margin-top:5px}
.draft-instructions{font-size:12px;color:var(--text-2);margin-bottom:10px;font-style:italic}
/* ── Inbox filter chips (Stage 8.7.13 — Needs Human as Inbox filter) ─────── */
.inbox-filters{display:flex;gap:4px;width:100%;flex-wrap:wrap}
.inbox-filter-btn{padding:5px 11px;font-size:11.5px;font-weight:600;color:var(--text-2);border:1px solid var(--border-soft);border-radius:var(--radius-pill);background:var(--surface);cursor:pointer;transition:background .14s,color .14s,border-color .14s}
.inbox-filter-btn:hover{color:var(--text);border-color:var(--border)}
.inbox-filter-btn.active{color:var(--primary);background:var(--teal);border-color:var(--sage)}
.inbox-filter-btn .hq-count{background:#9C5742;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:var(--radius-pill);margin-left:6px;display:none}
.inbox-filter-btn .hq-count.visible{display:inline}
.inbox-ro-note{font-size:11px;color:var(--text-3);padding:6px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface-soft);display:none;line-height:1.45}
.inbox-ro-note.visible{display:block}
.inbox-ro-note .hq-ro-label{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--text-2);background:var(--sand);padding:3px 9px;border-radius:var(--radius-pill);margin-left:6px}
.since{font-size:11px;color:#A2743D;font-weight:600}
.since.stale{color:#9C5742}
/* ── Sidebar cards ───────────────────────────────────────────────────────── */
.sidebar-card{background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:14px}
.sidebar-card h3{font-size:10.5px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px}
.luna-auto-status{margin-bottom:12px;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--border-soft);background:var(--surface)}
.luna-auto-status-paused{border-color:#E8C9A8;background:#FBF3EA}
.luna-auto-status-label{font-size:12.5px;font-weight:700;color:var(--text)}
.luna-auto-status-paused .luna-auto-status-label{color:#9C5742}
.luna-auto-status-help{font-size:11px;color:var(--text-3);margin-top:4px;line-height:1.45}
.kv2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.kv2 .kv{font-size:12px}
/* ── Empty / loading / error ─────────────────────────────────────────────── */
.state-msg{text-align:center;padding:44px 0;color:var(--text-3);font-size:13px}
.state-msg.error{color:#9C5742;background:#F6E7E1;border:1px solid #E6C7BC;border-radius:var(--radius-sm);padding:16px 20px;text-align:left}
/* ── Query tools (existing) ──────────────────────────────────────────────── */
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:14px}
label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:var(--text-2)}
input,select{border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 11px;font-size:13px;min-width:160px;background:var(--surface);color:var(--text);transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{outline:none;border-color:var(--ocean);box-shadow:0 0 0 3px rgba(149,180,199,.18)}
#q-error{background:#F6E7E1;border:1px solid #E6C7BC;color:#9C5742;border-radius:var(--radius-sm);padding:12px 16px;margin-bottom:14px;display:none}
#q-meta{font-size:12px;color:var(--text-2);margin-bottom:12px}
#q-table-wrap table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
#q-table-wrap th{background:var(--surface-soft);text-align:left;padding:9px 11px;border-bottom:1px solid var(--border);font-weight:700;white-space:nowrap;color:var(--text-2);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
#q-table-wrap td{padding:8px 11px;border-bottom:1px solid var(--border-soft);vertical-align:top;word-break:break-word;max-width:280px}
#q-table-wrap tr:hover td{background:var(--surface-soft)}
#q-json{background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:14px;font-size:12px;white-space:pre-wrap;max-height:400px;overflow:auto;display:none}
#q-params label{display:none}
#q-params label.visible{display:flex}
.mig-note{font-size:11px;color:#A2743D;background:#F8F0E2;border:1px solid #ECDCC4;border-radius:var(--radius-sm);padding:5px 10px;display:inline-block;margin-bottom:8px}
.view-toggle{font-size:11px;color:var(--primary);cursor:pointer;margin-left:10px;text-decoration:underline}
/* ── Bed calendar (Stage 7.7h) ──────────────────────────────────────────── */
.bc-grid{border-collapse:separate;border-spacing:0;font-size:12px;min-width:100%}
.bc-grid th,.bc-grid td{border-right:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);padding:0}
.bc-grid thead th{background:var(--surface-soft);padding:7px 8px;font-size:10px;font-weight:700;color:var(--text-2);text-align:center;position:sticky;top:0;z-index:2;white-space:nowrap;letter-spacing:.03em}
.bc-grid thead th.bc-bed-head{left:0;z-index:3;text-align:left;min-width:130px;background:var(--sand)}
.bc-room-hdr{background:var(--olive);color:#fff;font-weight:700;font-size:11px;padding:6px 10px;letter-spacing:.02em}
.bc-bed-cell{background:var(--surface-soft);color:var(--text-2);font-size:11px;padding:6px 10px;min-width:120px;position:sticky;left:0;z-index:1;border-right:2px solid var(--tan);white-space:nowrap;font-weight:500}
.bc-day-cell{height:30px;min-width:46px;vertical-align:middle;padding:2px 3px}
.bc-block{height:28px;border-radius:7px;padding:3px 9px;font-size:11px;font-weight:600;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px;transition:filter .15s,box-shadow .15s;box-shadow:var(--shadow-soft)}
.bc-block:hover{filter:brightness(.95);box-shadow:0 2px 10px rgba(68,80,74,.15)}
.bc-block-confirmed{background:#CEDFBF;color:#45673A;border-left:3px solid #87A87C}
.bc-block-hold{background:#F2E7D3;color:#8A6F4F;border-left:3px solid #DCC8B7}
.bc-block-payment_pending{background:#D5E5EF;color:#3F6070;border-left:3px solid #7AAABB}
.bc-block-needs_review{background:#F3DCC1;color:#9B6320;border-left:3px solid #D9A057}
.bc-block-cancelled{background:#E4E0D9;color:#7A8078;border-left:3px solid #BDB9B0;text-decoration:line-through;opacity:.7}
.bc-block-conflict{background:#EFD9D0;color:#9C5742;border-left:3px solid #C98B76}
.bc-block-operator{background:#D5E3EE;color:#3A5A72;border-left:3px solid #85A8C0;font-style:italic}
.bc-block-manual{background:#D5EAE3;color:#3A6657;border-left:3px solid #7ABFAD}
.bc-day-cell:not(:has(.bc-block)){background:rgba(240,236,228,.28)}
.bc-summary-strip{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--text-2);padding:10px 0 12px;border-bottom:1px solid var(--border-soft);margin-bottom:14px}
.bc-summary-strip b{color:var(--text)}
.bc-detail-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;font-size:16px;font-weight:700}
.bc-detail-meta{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;font-weight:400}
.bc-detail-note{font-size:11px;color:#A2743D;background:#F8F0E2;border:1px solid #ECDCC4;border-radius:var(--radius-sm);padding:9px 14px;margin-top:14px}
/* ── Bed calendar shortcut chips (Stage 8.3a) ────────────────────────────── */
.bc-chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px}
.bc-chip{font-size:11px;font-weight:600;padding:4px 12px;border-radius:999px;border:1px solid var(--border-soft);background:var(--surface-soft);color:var(--text-2);cursor:pointer;transition:background .12s,color .12s,border-color .12s;white-space:nowrap}
.bc-chip:hover{background:var(--sage);color:#fff;border-color:var(--sage)}
.bc-chip.bc-chip-active{background:var(--primary);color:#fff;border-color:var(--primary)}
/* ── Bed calendar legend (Stage 8.3a) ─────────────────────────────────────── */
.bc-legend{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;font-size:11px;color:var(--text-2);padding:10px 12px;background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius-sm);margin-bottom:14px}
.bc-legend-item{display:flex;align-items:center;gap:5px;white-space:nowrap}
.bc-legend-swatch{display:inline-block;width:12px;height:12px;border-radius:3px;border-left:2px solid transparent;flex-shrink:0}
.bc-legend-sw-confirmed{background:#CEDFBF;border-left-color:#87A87C}
.bc-legend-sw-hold{background:#F2E7D3;border-left-color:#DCC8B7}
.bc-legend-sw-payment{background:#D5E5EF;border-left-color:#7AAABB}
.bc-legend-sw-review{background:#F3DCC1;border-left-color:#D9A057}
.bc-legend-sw-operator{background:#D5E3EE;border-left-color:#85A8C0}
.bc-legend-sw-cancelled{background:#E4E0D9;border-left-color:#BDB9B0;opacity:.7}
.bc-legend-sw-manual{background:#D5EAE3;border-left-color:#7ABFAD}
/* ── Date picker styling (Stage 8.3a) ─────────────────────────────────────── */
input[type="date"].bc-date-input{font-size:12px;padding:5px 8px;border:1px solid var(--border-soft);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);cursor:pointer;min-width:130px}
input[type="date"].bc-date-input:focus{outline:none;border-color:var(--sage);box-shadow:0 0 0 2px rgba(175,195,163,.25)}
/* ── Today / Needs Attention panel (Stage 8.2) ───────────────────────────── */
.today-section-hdr{font-size:13px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--border-soft)}
.today-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:28px}
.today-tile{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:22px 20px 18px;box-shadow:var(--shadow);transition:box-shadow .18s,transform .12s;display:flex;flex-direction:column;gap:6px}
.today-tile:hover{box-shadow:0 4px 16px rgba(68,80,74,.11);transform:translateY(-1px)}
.today-tile-urgent{border-color:#E6C7BC;background:linear-gradient(135deg,#FBF7F0 0%,#F6E7E1 100%)}
.today-tile-number{font-size:38px;font-weight:800;color:var(--text);line-height:1;letter-spacing:-.02em}
.today-tile-urgent .today-tile-number{color:#9C5742}
.today-tile-label{font-size:13px;font-weight:700;color:var(--text);margin-top:2px}
.today-tile-sub{font-size:11.5px;color:var(--text-3);line-height:1.4}
.today-tile-icon{font-size:28px;line-height:1}
.today-hero-card{background:linear-gradient(135deg,#EBF1E5 0%,#DCE7EE 100%);border:1px solid #C9D9BE;border-radius:var(--radius);padding:18px 22px;margin-bottom:26px;display:flex;align-items:flex-start;gap:14px}
.today-hero-icon{font-size:22px;flex-shrink:0;margin-top:1px}
.today-hero-title{font-size:13px;font-weight:700;color:#4C6048;letter-spacing:.01em;margin-bottom:4px}
.today-hero-body{font-size:12.5px;color:#5C7350;line-height:1.55}
/* ── Developer Tools tab (deprioritized) ─────────────────────────────────── */
.tab-btn.dev-tab{color:var(--text-3);font-size:12px;font-weight:500;letter-spacing:.01em;border-left:1px solid var(--border-soft);margin-left:8px;padding-left:20px}
.tab-btn.dev-tab:hover{color:var(--text-2)}
.tab-btn.dev-tab.active{color:var(--text-2);border-bottom-color:var(--tan)}
.dev-panel-note{font-size:11.5px;color:#A2743D;background:#F8F0E2;border:1px solid #ECDCC4;border-radius:var(--radius-sm);padding:11px 16px;margin-bottom:16px;display:flex;align-items:center;gap:8px}
/* ── Booking context drawer (Stage 7.7i) ─────────────────────────────────── */
.ctx-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft)}
.ctx-section:first-of-type{margin-top:4px;padding-top:0;border-top:none}
.ctx-section h3{font-size:10.5px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.ctx-loading{color:var(--text-3);font-size:12px;font-style:italic;padding:10px 0}
.ctx-none{color:var(--text-3);font-size:12px;font-style:italic}
.btn-open-conv{background:var(--olive);color:#fff;border:none;border-radius:var(--radius-sm);padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:background .18s}
.btn-open-conv:hover{background:#7C9079}
/* ── Booking detail drawer extras (Stage 8.3b) ────────────────────────────── */
.ctx-status-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;align-items:center}
.ctx-nights-badge{display:inline-flex;align-items:center;font-size:11px;font-weight:600;color:var(--text-2);background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius-pill);padding:3px 10px}
.ctx-pay-block{margin:8px 0}
.ctx-pay-box{max-width:340px;width:100%;padding:10px 12px;background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius-sm);margin-top:2px;box-sizing:border-box}
.ctx-pay-record{margin-top:8px;padding:8px 10px;border:1px solid var(--border-soft);border-radius:6px;font-size:12px;background:var(--bg-1,#f8f9fa)}
.ctx-pay-record-paid{background:#F3FAF1;border-color:#B5D3AD}
.ctx-pay-record-checkout{border-color:#B5C7D3}
.ctx-pay-record-badge{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:4px}
.ctx-pay-record-badge-paid{background:#DCEAD2;color:#3d6130}
.ctx-pay-record-badge-checkout{background:#D0E4EE;color:#1d5570}
.ctx-pay-record-badge-default{background:#E8E8E8;color:var(--text-2)}
.ctx-pay-record-wait{font-size:11px;color:#1d5570;padding:4px 0;border-top:1px solid var(--border-soft);margin-top:4px}
.ctx-pay-record-meta{margin-top:6px;font-size:10px;color:var(--text-3);border-top:1px solid var(--border-soft);padding-top:4px}
.ctx-pay-record-url{margin-top:8px;border-top:1px solid var(--border-soft);padding-top:6px}
.ctx-pay-row{display:grid;grid-template-columns:108px minmax(0,1fr);gap:4px 10px;align-items:baseline;padding:4px 0;font-size:12px;border-bottom:1px solid var(--border-soft)}
.ctx-pay-row:last-child{border-bottom:none}
.ctx-pay-label{color:var(--text-2);font-size:11px;text-align:left}
.ctx-pay-amount{font-weight:600;color:var(--text);text-align:left;justify-self:start;max-width:100%}
.ctx-pay-amount.owing{color:#9C5742}
.ctx-pay-amount.paid{color:#5C7350}
.ctx-addon-row{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border-soft);color:var(--text)}
.ctx-addon-row:last-child{border-bottom:none}
.ctx-svc-record{padding:8px 10px;margin-bottom:6px;border:1px solid var(--border-soft);border-radius:6px;background:var(--surface-2,#f8f9fa);font-size:12px}
.ctx-svc-record:last-child{margin-bottom:0}
.ctx-svc-date-label{font-size:11px;font-weight:600;color:var(--text-2);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.03em}
.ctx-svc-date-label:first-child{margin-top:0}
.ctx-bed-row{font-size:11px;color:var(--text-2);padding:3px 0;display:flex;gap:14px;align-items:baseline}
.ctx-bed-row b{color:var(--text);font-weight:600}
.ctx-planned{margin-top:16px;padding:10px 12px;background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius-sm)}
.ctx-planned-title{font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px;color:var(--text-3)}
.ctx-planned-action{display:inline-block;padding:4px 10px;border:1px dashed var(--border-soft);border-radius:var(--radius-sm);font-size:11px;color:var(--text-3);margin:0 5px 4px 0;cursor:not-allowed;user-select:none}
/* ── Cell selection model (Stage 8.3c) ───────────────────────────────────── */
.bc-day-cell[data-date]{cursor:cell}
.bc-day-cell[data-date]:hover{background:rgba(108,165,140,.10)}
.bc-day-cell.bc-sel{background:rgba(108,165,140,.22);outline:1px solid rgba(108,165,140,.6);outline-offset:-1px;position:relative;z-index:1}
.bc-day-cell.bc-sel-anchor{outline:2px solid #6CA58C;outline-offset:-1px}
.bc-sel-title{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.bc-sel-notice{font-size:11px;color:var(--text-3);font-style:italic;margin:10px 0 12px}
.bc-sel-warn{font-size:11px;color:#A2743D;background:#F8F0E2;border:1px solid #ECDCC4;border-radius:var(--radius-sm);padding:7px 10px;margin:8px 0}
.bc-sel-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bc-sel-create-btn{opacity:.42;cursor:not-allowed !important}
.bc-sel-create-btn:hover{opacity:.42}
/* ── Manual booking form skeleton (Stage 8.3d) ───────────────────────────── */
.bk-form-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft)}
.bk-form-section-title{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2);margin-bottom:10px}
.bk-form-row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.bk-label{font-size:11.5px;color:var(--text-2);min-width:148px;flex-shrink:0;text-align:right}
.bk-notes-block{display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:420px}
.bk-notes-block .bk-label{min-width:0;text-align:left}
.bk-notes-block textarea.bk-input{width:100%;max-width:420px;box-sizing:border-box;margin:0}
/* Stage 8.7.18 — compact left-aligned guest/payment fields (matches add-ons) */
.bk-compact-grid{display:flex;flex-direction:column;gap:6px;margin-top:4px;max-width:440px}
.bk-compact-row{display:grid;grid-template-columns:minmax(0,128px) minmax(0,280px);align-items:center;gap:4px 10px;min-height:28px}
.bk-compact-row .bk-label{min-width:0;text-align:left;flex-shrink:1}
.bk-compact-row .bk-input{width:100%;max-width:280px;box-sizing:border-box}
.bk-compact-row .bk-input.bk-input-sm{max-width:220px}
.bk-compact-hint{font-size:11px;color:var(--text-3);font-style:italic;margin:2px 0 4px;max-width:440px;line-height:1.45}
.bk-form-section .bc-sel-beds-section{max-width:440px;margin-top:4px}
.bk-input{border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:5px 9px;font-size:12px;color:var(--text);background:#fff;width:100%;box-sizing:border-box;font-family:inherit;line-height:1.4}
.bk-input.bk-input-sm{max-width:200px;width:auto}
.bk-input[readonly]{background:var(--surface-soft);color:var(--text-2);border-style:dashed;cursor:default}
select.bk-input{cursor:pointer}
textarea.bk-input{resize:vertical;min-height:60px}
.bk-form-hint{font-size:11px;color:var(--text-3);font-style:italic;padding-left:158px;margin-top:-3px;margin-bottom:5px}
.bk-safety-notice{margin-top:16px;padding:10px 14px;background:#F8F0E2;border:1px solid #ECDCC4;border-radius:var(--radius-sm);font-size:11px;color:#A2743D;line-height:1.7}
.bk-avail-placeholder{font-size:11px;color:var(--text-3);font-style:italic;padding:8px 0}
/* Stage 8.3l — preview result states */
.bk-preview-not-run{font-size:11px;color:var(--text-3);font-style:italic;padding:8px 0}
.bk-preview-loading{font-size:12px;color:var(--text-2);padding:8px 0}
.bk-preview-valid{background:#f0f5f0;border-left:3px solid #5a8a5a;padding:10px 12px;border-radius:4px;font-size:12px;margin-top:4px}
.bk-preview-blocked{background:#fff4e0;border-left:3px solid #d4830e;padding:10px 12px;border-radius:4px;font-size:12px;margin-top:4px}
.bk-preview-error{background:#fef2f0;border-left:3px solid #c0392b;padding:10px 12px;border-radius:4px;font-size:12px;margin-top:4px}
.bk-preview-badge{font-weight:600;font-size:13px;margin-bottom:5px}
.bk-preview-list{margin:4px 0 0;padding-left:14px;font-size:11px;opacity:.85}
.bk-preview-list li{margin:2px 0}
.bk-preview-meta{margin-top:4px;font-size:11px;opacity:.8}
.bk-preview-warn{background:#fffbe6;border-left:3px solid #e6c200;padding:8px 12px;border-radius:4px;margin-top:8px;font-size:11px}
.bk-preview-create-note{font-size:11px;color:var(--text-3);font-style:italic;margin-top:4px;padding:0 4px}
/* Stage 8.4.5 — quote preview + multi-bed selection */
.bc-sel-beds-section{margin-top:8px;min-height:24px}
.bc-sel-bed-count{font-size:11px;color:var(--text-2);margin-bottom:4px}
.bc-sel-bed-tag{display:inline-block;background:#e8f4fd;color:#2474a1;border:1px solid #90c8e8;border-radius:12px;padding:2px 10px;font-size:11px;margin:2px 3px 2px 0;white-space:nowrap}
.bk-quote-banner{background:#fffbe6;border-left:3px solid #e6c200;padding:8px 12px;border-radius:4px;font-size:11px;color:#7a6a00;margin-bottom:10px;font-style:italic}
.bk-quote-items{font-size:12px;margin-top:6px}
.bk-quote-item{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:1px solid #e8eef4}
.bk-quote-item:last-child{border-bottom:none}
.bk-quote-item-label{color:var(--text-2);flex:1}
.bk-quote-item-amount{font-variant-numeric:tabular-nums;padding-left:12px;white-space:nowrap}
.bk-quote-item-note{font-size:10px;color:var(--text-3);font-style:italic;padding:0 0 4px 0}
.bk-quote-divider{border:none;border-top:1px solid #d0dbe4;margin:6px 0}
.bk-quote-subtotal{font-weight:500}
.bk-quote-total{font-weight:700;font-size:13px;padding:6px 0!important}
.bk-quote-formula{font-size:10px;color:var(--text-3);font-style:italic;margin-top:8px;line-height:1.5}
/* Stage 8.4.7 / 8.7.15 — add-ons selector (qty-only, no checkboxes) */
.bk-ao-grid{display:flex;flex-direction:column;gap:5px;margin-top:4px;max-width:440px}
.bk-ao-row{display:grid;grid-template-columns:minmax(0,168px) 56px minmax(44px,auto);align-items:center;gap:4px 8px;min-height:28px}
.bk-ao-label{font-size:12px;color:var(--text-1);display:block;line-height:1.35;justify-self:start;text-align:left;padding-right:4px}
.bk-ao-qty{width:56px!important;min-width:56px;max-width:56px;text-align:center;padding:3px 4px!important;font-size:12px!important;justify-self:start;box-sizing:border-box}
.bk-ao-unit{font-size:11px;color:var(--text-3);white-space:nowrap;justify-self:start;padding-left:2px}
.bk-ao-note{font-size:11px;color:var(--text-3);font-style:italic;margin-top:6px;line-height:1.45;max-width:440px}
.bk-ao-meals-note{font-size:11px;color:#A2743D;margin-top:2px;max-width:440px}
/* Stage 8.3q — tour operator block skeleton */
.bc-op-divider{border:none;border-top:2px solid var(--border-1,#e0e8ef);margin:20px 0 16px}
.bc-op-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.bc-op-title{font-weight:600;font-size:14px;color:var(--text-1,#1a2a3a)}
.bc-op-badge{font-size:10px;background:#f0f4f8;color:var(--text-3,#8a9aaa);padding:2px 8px;border-radius:10px;font-weight:500;border:1px solid #dde4ea;white-space:nowrap}
.bc-op-locked{background:#f7f9fb !important;color:#8a9aaa;font-style:italic}
.bc-op-no-sel{font-size:11px;color:var(--text-3);font-style:italic;padding:4px 0 8px}
/* Stage 8.3r — operator room release skeleton */
.bc-rr-no-sel{font-size:11px;color:var(--text-3);font-style:italic;padding:4px 0 8px}
.bc-rr-purpose{font-size:11px;color:var(--text-2);background:#f7f9fb;border-left:3px solid #b8ccd8;padding:8px 10px;border-radius:4px;margin-bottom:10px;line-height:1.5}
.to-form-hint{font-size:11px;color:var(--text-3);font-style:italic;margin:2px 0 6px;max-width:480px;line-height:1.45}
/* Stage 8.6.2 — Ask Luna panel */
#al-wrap{max-width:720px;margin:0 auto;padding:26px 20px}
.al-hero{background:linear-gradient(135deg,#EBF1E5 0%,#E3EEF4 100%);border:1px solid #C9D9BE;border-radius:var(--radius);padding:18px 22px;margin-bottom:24px;display:flex;align-items:flex-start;gap:14px}
.al-hero-icon{font-size:28px;line-height:1;flex-shrink:0}
.al-hero-title{font-size:15px;font-weight:700;color:var(--text)}
.al-hero-sub{font-size:12px;color:var(--text-2);margin-top:3px;line-height:1.4}
.al-form-row{display:flex;gap:8px;align-items:flex-end;margin-bottom:4px}
#al-input{flex:1;font-size:13.5px;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);min-width:0}
#al-input:focus{outline:2px solid #7AAB6E;outline-offset:1px}
#al-btn{flex-shrink:0;padding:10px 22px;font-size:13px;font-weight:700}
#al-btn:disabled{opacity:.5;cursor:default}
.al-hint{font-size:11px;color:var(--text-3);margin-bottom:18px}
#al-status{font-size:12px;color:var(--text-2);padding:6px 0;min-height:22px}
#al-error{font-size:12.5px;color:#A0392A;background:#FDF4F2;border:1px solid #F0C9C1;border-radius:var(--radius-sm);padding:10px 14px;margin:8px 0;display:none}
.al-answer-box{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:18px 20px;margin:12px 0 0}
.al-answer-intent{font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.al-answer-text{font-size:14px;font-weight:600;color:var(--text);line-height:1.5;margin-bottom:10px}
.al-answer-unsupported{font-size:13px;color:var(--text-2);line-height:1.5}
.al-answer-rowcount{font-size:11.5px;color:var(--text-3);margin-bottom:8px}
.al-rows-table{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:8px}
.al-rows-table th{text-align:left;padding:5px 8px;background:#F5F0E8;border-bottom:1px solid var(--border-soft);color:var(--text-2);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
.al-rows-table td{padding:5px 8px;border-bottom:1px solid #F2EDE4;vertical-align:top;color:var(--text)}
.al-rows-table tr:last-child td{border-bottom:none}
.al-suggestions{font-size:12px;color:var(--text-2);margin-top:8px;line-height:1.6;background:var(--surface-soft);border-radius:var(--radius-sm);padding:10px 14px}
</style>
</head>
<body>

<!-- ── Top banner ─────────────────────────────────────────────────────────── -->
<div id="banner">
  <a href="/staff/ui" class="brand" style="text-decoration:none;color:inherit;">Luna Front Desk</a>
  <span class="badge">READ-ONLY &bull; SHADOW MODE</span>
  <button class="btn-logout" id="btn-logout" onclick="doLogout()">Sign out</button>
</div>

<!-- ── Tabs ───────────────────────────────────────────────────────────────── -->
<div id="tabs">
  <button class="tab-btn active" data-tab="today">Today</button>
  <button class="tab-btn" data-tab="conversations">Inbox</button>
  <button class="tab-btn" data-tab="bed-calendar">Bed Calendar</button>
  <button class="tab-btn" data-tab="ask-luna">Luna</button>
  <button class="tab-btn" data-tab="tour-operator">Tour Operator</button>
  <button class="tab-btn dev-tab" data-tab="query-tools">&#128736; Developer Tools</button>
</div>

<!-- ── Today / Needs Attention tab (Stage 8.2) ────────────────────────────── -->
<div id="tab-today" class="tab-panel active">
<div id="wrap-today" style="max-width:1100px;margin:0 auto;padding:26px 20px">

  <!-- Shadow-mode hero card -->
  <div class="today-hero-card">
    <div class="today-hero-icon">&#128274;</div>
    <div>
      <div class="today-hero-title">Read-only &mdash; Shadow Mode active</div>
      <div class="today-hero-body">Luna Front Desk is running in staging. No messages are sent. No operations affect live guest data. Staff actions are disabled.</div>
    </div>
  </div>

  <!-- Needs Attention tiles -->
  <div class="today-section-hdr">Needs Attention</div>
  <div class="today-grid">
    <div class="today-tile today-tile-urgent" id="tile-needs-human" style="cursor:pointer" onclick="switchToTab('conversations','handoffs')">
      <div class="today-tile-number" id="tile-nh-count">—</div>
      <div class="today-tile-label">Needs Human</div>
      <div class="today-tile-sub">Open handoffs waiting for staff review</div>
    </div>
    <div class="today-tile" id="tile-inbox-tile" style="cursor:pointer" onclick="switchToTab('conversations','inbox')">
      <div class="today-tile-number" id="tile-inbox-count">—</div>
      <div class="today-tile-label">Open Conversations</div>
      <div class="today-tile-sub">Active guest conversations in inbox</div>
    </div>
    <div class="today-tile" style="cursor:pointer" onclick="switchToTabOnly('bed-calendar')">
      <div class="today-tile-icon">&#128197;</div>
      <div class="today-tile-label">Bed Calendar</div>
      <div class="today-tile-sub">View room availability and bookings</div>
    </div>
  </div>
  <div id="today-load-state" style="display:none;font-size:12px;color:var(--text-3);padding:6px 0"></div>

</div>
</div><!-- /tab-today -->

<!-- ── Conversations / Inbox tab ──────────────────────────────────────────── -->
<div id="tab-conversations" class="tab-panel">
<div id="wrap">

  <div class="inbox-two-col">

    <!-- LEFT: conversation list + filters -->
    <div class="inbox-left" id="inbox-card">
      <div class="inbox-left-toolbar">
        <h2>Inbox</h2>
        <div class="inbox-filters">
          <button type="button" class="inbox-filter-btn active" data-inbox-filter="all" id="inbox-filter-all">All conversations</button>
          <button type="button" class="inbox-filter-btn" data-inbox-filter="needs-human" id="inbox-filter-needs-human">Needs human <span class="hq-count" id="hq-badge">0</span></button>
        </div>
        <span id="inbox-count" style="font-size:11px;color:var(--text-3)"></span>
        <button class="btn btn-primary" id="btn-refresh" style="padding:6px 12px;font-size:11px">&#8635;</button>
        <input id="c-client" value="wolfhouse-somo" title="Company slug" style="width:100%;font-size:11px;padding:4px 7px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
      </div>
      <div id="inbox-ro-note" class="inbox-ro-note">Resolve actions are disabled &mdash; read-only view. <span class="hq-ro-label">READ-ONLY HANDOFF QUEUE</span></div>
      <div id="inbox-state" class="state-msg" style="padding:16px;display:none">Loading conversations&hellip;</div>
      <div id="conv-list"></div>
    </div>

    <!-- RIGHT: conversation detail (always visible) -->
    <div id="conv-detail">
      <div id="detail-content">
        <div class="inbox-empty-right">
          <p class="main-msg">Select a conversation to review.</p>
          <p class="sub-msg">Luna drafts and booking context will appear here.</p>
        </div>
      </div>
    </div>

  </div><!-- /inbox-two-col -->

</div><!-- /wrap -->
</div><!-- /tab-conversations -->

<!-- ── Query Tools tab ────────────────────────────────────────────────────── -->
<div id="tab-query-tools" class="tab-panel">
<div id="wrap-q" style="max-width:1100px;margin:0 auto;padding:20px 16px">
  <div class="dev-panel-note">
    <span>&#128736;</span>
    <span><b>Developer / Admin tools</b> &mdash; not for normal staff use. Query Tools are read-only. No write actions.</span>
  </div>
  <div style="font-size:11px;color:#6B756F;margin-bottom:14px;padding:7px 14px;background:#FBF7F0;border:1px solid #EFE8DC;border-radius:999px;display:inline-block;letter-spacing:.03em">
    READ-ONLY &mdash; no write actions &mdash; Query Tools (Stage 6.8)
  </div>
  <div class="card">
    <div class="row">
      <label>Company<input id="f-client" value="wolfhouse-somo" style="min-width:200px"></label>
      <label>Category<select id="f-cat"><option value="">-- loading --</option></select></label>
      <label>Intent<select id="f-intent" disabled><option value="">-- pick category --</option></select></label>
    </div>
    <div class="row" id="q-params">
      <label id="lbl-date">Date (YYYY-MM-DD)<input id="f-date" placeholder="2026-07-16"></label>
      <label id="lbl-start">Start date<input id="f-start" placeholder="2026-07-01"></label>
      <label id="lbl-end">End date<input id="f-end" placeholder="2026-07-31"></label>
      <label id="lbl-booking">Booking code<input id="f-booking" placeholder="WH-260528-1493"></label>
      <label id="lbl-reason">Reason code<input id="f-reason" placeholder="cancellation_request"></label>
      <label id="lbl-staff">Staff name<input id="f-staff" placeholder="Ana"></label>
      <label id="lbl-hours">Hours<input id="f-hours" placeholder="24" style="min-width:80px"></label>
    </div>
    <div class="row" style="margin-bottom:0">
      <button class="btn btn-primary" id="btn-run" disabled>Run query</button>
      <span id="status-txt" style="font-size:12px;color:#5a6a85;margin-left:8px"></span>
    </div>
  </div>
  <div class="card">
    <div id="q-error"></div>
    <div id="q-meta"></div>
    <div id="q-table-wrap"><div style="color:#9aabb8;text-align:center;padding:28px 0;font-size:13px">Select a category and intent, then click Run query.</div></div>
    <pre id="q-json"></pre>
  </div>
</div>
</div><!-- /tab-query-tools -->

<!-- ── Bed Calendar tab (Stage 7.7h) ──────────────────────────────────────── -->
<div id="tab-bed-calendar" class="tab-panel">
<div id="wrap-bc" style="max-width:100%;padding:16px 20px">

  <!-- Controls card -->
  <div class="card">
    <div class="toolbar">
      <h2>Bed Calendar</h2>
      <span class="hq-ro-label">READ-ONLY BED CALENDAR &mdash; edits disabled</span>
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#5a6a85;margin-bottom:0">
        From&nbsp;<input id="bc-start" type="date" class="bc-date-input" placeholder="YYYY-MM-DD">
      </label>
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#5a6a85;margin-bottom:0">
        To&nbsp;<input id="bc-end" type="date" class="bc-date-input" placeholder="YYYY-MM-DD">
      </label>
      <label style="display:none"><input id="bc-client" value="wolfhouse-somo"></label>
      <button class="btn btn-primary" id="bc-load">&#128197; Load</button>
    </div>

    <!-- Date shortcut chips (Stage 8.3a) -->
    <div class="bc-chips" id="bc-chips">
      <span class="bc-chip" data-chip="week">This week</span>
      <span class="bc-chip bc-chip-active" data-chip="30days">Next 30 days</span>
      <span class="bc-chip" data-chip="jul-aug">Jul &ndash; Aug</span>
    </div>

    <!-- Color legend (Stage 8.3a) -->
    <div class="bc-legend" id="bc-legend">
      <span style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-right:4px">Legend:</span>
      <span class="bc-legend-item"><span class="bc-legend-swatch bc-legend-sw-confirmed"></span>Confirmed</span>
      <span class="bc-legend-item"><span class="bc-legend-swatch bc-legend-sw-hold"></span>Hold</span>
      <span class="bc-legend-item"><span class="bc-legend-swatch bc-legend-sw-payment"></span>Payment pending</span>
      <span class="bc-legend-item"><span class="bc-legend-swatch bc-legend-sw-review"></span>Needs review</span>
      <span class="bc-legend-item"><span class="bc-legend-swatch bc-legend-sw-operator"></span>Operator block</span>
      <span class="bc-legend-item"><span class="bc-legend-swatch bc-legend-sw-manual"></span>Manual / staff</span>
      <span class="bc-legend-item"><span class="bc-legend-swatch bc-legend-sw-cancelled"></span>Cancelled</span>
    </div>

    <!-- Summary strip -->
    <div class="bc-summary-strip" id="bc-summary" style="display:none">
      <span><b id="bc-rooms-count">0 rooms</b></span>
      <span><b id="bc-beds-count">0 beds</b></span>
      <span><b id="bc-blocks-count">0 blocks</b></span>
      <span id="bc-free-count" style="color:var(--text-3)"></span>
    </div>

    <!-- Warnings -->
    <div id="bc-warnings" style="display:none;font-size:12px;color:#9C5742;background:#F6E7E1;border:1px solid #E6C7BC;border-radius:10px;padding:10px 14px;margin-bottom:12px"></div>

    <!-- State message -->
    <div id="bc-state" class="state-msg">Select a date range and click Load.</div>

    <!-- Grid -->
    <div id="bc-grid-wrap" style="display:none;overflow-x:auto;overflow-y:auto;max-height:620px;border:1px solid #EFE8DC;border-radius:12px"></div>
  </div>

  <!-- Manual booking preview skeleton (Stage 8.3d / 8.4.5, read-only) -->
  <div class="card" id="bc-sel-panel" style="display:none;margin-top:16px">
    <div class="bc-sel-title">
      &#128203; New Booking Preview
      <span class="hq-ro-label">PREVIEW ONLY &mdash; NO BOOKING CREATED</span>
    </div>

    <div id="bc-sel-warn" class="bc-sel-warn" style="display:none"></div>

    <!-- Section: Selected Stay (pre-filled from selection, read-only) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Selected Stay</div>
      <div class="bk-compact-grid">
        <div class="bk-compact-row">
          <label class="bk-label" for="bc-sel-cin">Check-in</label>
          <input type="date" id="bc-sel-cin" class="bk-input bk-input-sm" readonly>
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bc-sel-cout">Check-out</label>
          <input type="date" id="bc-sel-cout" class="bk-input bk-input-sm" readonly>
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bc-sel-nights">Nights</label>
          <input type="text" id="bc-sel-nights" class="bk-input bk-input-sm" readonly>
        </div>
      </div>
      <!-- Multi-bed selection list (Stage 8.4.5) -->
      <div class="bc-sel-beds-section">
        <div id="bc-sel-bed-count" class="bc-sel-bed-count"></div>
        <div id="bc-sel-beds-list"></div>
      </div>
    </div>

    <!-- Section: Guest (Stage 8.7.18 — compact left-aligned) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Guest</div>
      <div class="bk-compact-grid">
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-guest-name">Guest name</label>
          <input type="text" id="bk-guest-name" class="bk-input bk-input-sm" placeholder="Full name">
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-phone">Phone</label>
          <input type="tel" id="bk-phone" class="bk-input bk-input-sm" placeholder="+34 600 000 000">
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-email">Email</label>
          <input type="email" id="bk-email" class="bk-input bk-input-sm" placeholder="guest@example.com">
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-guest-count">Guest count</label>
          <input type="number" id="bk-guest-count" class="bk-input bk-input-sm" value="1" min="1" max="20">
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-package">Package</label>
          <select id="bk-package" class="bk-input bk-input-sm">
            <option value="">&mdash; select package &mdash;</option>
            <option value="malibu">Malibu</option>
            <option value="uluwatu">Uluwatu</option>
            <option value="waimea">Waimea</option>
            <option value="package_none">No package / accommodation only</option>
            <option value="manual_override">Manual price override</option>
          </select>
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-source">Source / channel</label>
          <input type="text" id="bk-source" class="bk-input bk-input-sm" value="manual_staff" readonly>
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-room-type">Room type</label>
          <select id="bk-room-type" class="bk-input bk-input-sm">
            <option value="shared" selected>Shared</option>
            <option value="private">Private (+&euro;10/person/night)</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Section: Payment (Stage 8.7.18 — compact left-aligned) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Payment</div>
      <div class="bk-compact-grid">
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-payment-choice">Payment choice</label>
          <select id="bk-payment-choice" class="bk-input bk-input-sm">
            <option value="deposit">Deposit only</option>
            <option value="full">Full payment</option>
            <option value="pay_on_arrival">Pay on arrival</option>
          </select>
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-payment-status">Payment status</label>
          <select id="bk-payment-status" class="bk-input bk-input-sm">
            <option value="unpaid">Unpaid</option>
            <option value="deposit_paid">Deposit paid</option>
            <option value="paid">Paid in full</option>
          </select>
        </div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-deposit">Deposit amount paid (&euro;)</label>
          <input type="number" id="bk-deposit" class="bk-input bk-input-sm" placeholder="0.00" step="0.01" min="0">
        </div>
        <div class="bk-compact-hint">For manual records only &mdash; no Stripe charge is created.</div>
        <div class="bk-compact-row">
          <label class="bk-label" for="bk-total">Total amount (&euro;)</label>
          <input type="number" id="bk-total" class="bk-input bk-input-sm" placeholder="0.00" step="0.01" min="0">
        </div>
      </div>
    </div>

    <!-- Section: Notes -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Notes</div>
      <div class="bk-notes-block">
        <label class="bk-label" for="bk-notes">Staff notes</label>
        <textarea id="bk-notes" class="bk-input" rows="3" placeholder="Internal booking notes..."></textarea>
      </div>
    </div>

    <!-- Section: Add-ons (Stage 8.4.7 — qty &gt; 0 selects add-on; Stage 8.7.15) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Add-ons</div>
      <div class="bk-ao-grid">
        <div class="bk-ao-row">
          <span class="bk-ao-label">Wetsuit + Soft top combo</span>
          <input type="number" id="bk-ao-ws-combo-days" class="bk-input bk-ao-qty" value="0" min="0" max="30" aria-label="Wetsuit + Soft top combo days">
          <span class="bk-ao-unit">days</span>
        </div>
        <div class="bk-ao-row">
          <span class="bk-ao-label">Wetsuit + Hard board combo</span>
          <input type="number" id="bk-ao-wb-combo-days" class="bk-input bk-ao-qty" value="0" min="0" max="30" aria-label="Wetsuit + Hard board combo days">
          <span class="bk-ao-unit">days</span>
        </div>
        <div class="bk-ao-row">
          <span class="bk-ao-label">Wetsuit rental</span>
          <input type="number" id="bk-ao-wetsuit-days" class="bk-input bk-ao-qty" value="0" min="0" max="30" aria-label="Wetsuit rental days">
          <span class="bk-ao-unit">days</span>
        </div>
        <div class="bk-ao-row">
          <span class="bk-ao-label">Soft top rental</span>
          <input type="number" id="bk-ao-softtop-days" class="bk-input bk-ao-qty" value="0" min="0" max="30" aria-label="Soft top rental days">
          <span class="bk-ao-unit">days</span>
        </div>
        <div class="bk-ao-row">
          <span class="bk-ao-label">Hard board rental</span>
          <input type="number" id="bk-ao-hardboard-days" class="bk-input bk-ao-qty" value="0" min="0" max="30" aria-label="Hard board rental days">
          <span class="bk-ao-unit">days</span>
        </div>
        <div class="bk-ao-row">
          <span class="bk-ao-label">Surf lessons</span>
          <input type="number" id="bk-ao-surf-lessons" class="bk-input bk-ao-qty" value="0" min="0" max="20" aria-label="Surf lessons quantity">
          <span class="bk-ao-unit">lessons</span>
        </div>
        <div class="bk-ao-row">
          <span class="bk-ao-label">Yoga classes</span>
          <input type="number" id="bk-ao-yoga" class="bk-input bk-ao-qty" value="0" min="0" max="30" aria-label="Yoga classes quantity">
          <span class="bk-ao-unit">classes</span>
        </div>
        <div class="bk-ao-row">
          <span class="bk-ao-label">Meals</span>
          <input type="number" id="bk-ao-meals" class="bk-input bk-ao-qty" value="0" min="0" max="60" aria-label="Meals quantity" title="On-site only — not priced in quote yet">
          <span class="bk-ao-unit">meals</span>
        </div>
      </div>
      <div class="bk-ao-note">Combos replace individual rentals. 1 surf lesson = single rate; 2+ = bundle rate. Enter a quantity &gt; 0 to include an add-on.</div>
      <div class="bk-ao-meals-note">Meals: on-site / not priced in quote yet.</div>
    </div>

    <!-- Section: Quote Preview (Stage 8.4.5 — calls /staff/quote-preview, no writes) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Quote Preview</div>
      <div id="bc-quote-result">
        <div class="bk-preview-not-run">Select beds, dates, and package, then click Calculate Quote.</div>
      </div>
    </div>

    <!-- Section: Availability / Conflicts (Stage 8.3l — wired to read-only preview) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Availability / Conflicts</div>
      <div id="bc-preview-result">
        <div class="bk-preview-not-run">Availability and conflict preview will appear here before booking creation is enabled.</div>
      </div>
    </div>

    <!-- Safety notice -->
    <div class="bk-safety-notice" id="bc-safety-notice">
      &#128274; Preview only &mdash; no booking will be created.<br>
      Staff writes are disabled in staging.<br>
      No WhatsApp message or Stripe payment link will be sent.
    </div>

    <!-- Actions -->
    <div class="bc-sel-actions" style="margin-top:16px">
      <button class="btn btn-ghost" id="bc-sel-clear">Clear selection</button>
      <button class="btn bc-sel-create-btn" disabled id="bc-sel-create"
        title="Calculate Quote first, then Create Manual Booking becomes available when both flags are enabled.">
        Create Manual Booking
      </button>
      <button class="btn" disabled id="bc-sel-conflicts"
        title="Select empty cells to enable conflict preview">
        Preview Conflicts
      </button>
      <button class="btn" disabled id="bc-sel-quote"
        title="Select beds, dates, and package to calculate quote">
        Calculate Quote
      </button>
    </div>
    <!-- Stage 8.4.8: Create result panel -->
    <div id="bc-create-result" style="margin-top:12px"></div>
    <div class="bk-preview-create-note" id="bc-create-note">Set MANUAL_BOOKING_ENABLED=true and STAFF_ACTIONS_ENABLED=true to enable booking creation.</div>
  </div>

  <!-- Tour Operator Block skeleton (Stage 8.3q — moved to Tour Operator tab in Stage 8.3u) -->

  <!-- Operator Room Release skeleton (Stage 8.3r — moved to Tour Operator tab in Stage 8.3u) -->

  <!-- Block detail panel (read-only) -->
  <div class="card" id="bc-detail" style="display:none"></div>

</div>
</div><!-- /tab-bed-calendar -->

<!-- ── Tour Operator tab (Stage 8.3u — preview only, no writes) ───────────── -->
<div id="tab-tour-operator" class="tab-panel">
<div id="wrap-to" style="max-width:900px;margin:0 auto;padding:16px 20px">

  <!-- Intro card -->
  <div class="card" style="margin-bottom:0">
    <div class="toolbar">
      <h2>&#128274; Tour Operator</h2>
      <span class="hq-ro-label">READ-ONLY &mdash; writes disabled in staging</span>
    </div>
    <p style="font-size:13px;color:var(--text-2);margin:6px 0 0">Use these forms to preview upcoming operator operations before they are enabled. No records will be created or modified.</p>
  </div>

  <!-- ── Tour Operator Block (Stage 8.3u) ─────────────────────────────────── -->
  <div class="card" id="to-op-panel" style="margin-top:16px">
    <div class="bc-op-header">
      <span class="bc-op-title">&#128274; Tour Operator Block</span>
      <span class="bc-op-badge">Preview only &mdash; coming soon</span>
    </div>

    <!-- Section: Operator contact -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Operator</div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-name">Operator name</label>
        <input type="text" id="to-op-name" class="bk-input bk-input-sm" placeholder="Tour operator or company name">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-manager">Manager / contact</label>
        <input type="text" id="to-op-manager" class="bk-input bk-input-sm" placeholder="Contact person">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-phone">Phone</label>
        <input type="text" id="to-op-phone" class="bk-input bk-input-sm" placeholder="+34...">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-email">Email</label>
        <input type="email" id="to-op-email" class="bk-input bk-input-sm" placeholder="operator@...">
      </div>
    </div>

    <!-- Section: Block Dates &amp; Rooms (Stage 8.7.17 — simplified) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Block Dates &amp; Rooms</div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-cin">Start date</label>
        <input type="date" id="to-op-cin" class="bk-input bk-input-sm bc-date-input">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-cout">End date</label>
        <input type="date" id="to-op-cout" class="bk-input bk-input-sm bc-date-input">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-room">Room</label>
        <select id="to-op-room" class="bk-input bk-input-sm">
          <option value="">— select room —</option>
          <option value="" disabled>Load Bed Calendar for room list</option>
        </select>
      </div>
      <div class="to-form-hint">Rooms populate from loaded Bed Calendar data; dedicated room API later if needed.</div>
    </div>

    <!-- Section: Notes -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Notes</div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-notes">Operator notes</label>
        <textarea id="to-op-notes" class="bk-input" rows="2" placeholder="Notes from operator..."></textarea>
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-op-staff-note">Internal staff note</label>
        <textarea id="to-op-staff-note" class="bk-input" rows="2" placeholder="Internal staff note..."></textarea>
      </div>
    </div>

    <!-- Safety notice -->
    <div class="bk-safety-notice">
      &#128274; Preview only &mdash; no operator block will be created.<br>
      No guest message, Stripe payment link, or n8n workflow will run.<br>
      Operator booking writes require approval gates before they can be enabled.
    </div>

    <!-- Disabled actions -->
    <div class="bc-sel-actions" style="margin-top:16px">
      <button class="btn bc-sel-create-btn" disabled id="to-op-preview-btn"
        title="Operator block preview coming soon.">
        Preview Operator Block
      </button>
      <button class="btn bc-sel-create-btn" disabled id="to-op-create-btn"
        title="Operator block creation requires write-gate approval.">
        Create Operator Block
      </button>
    </div>
    <div class="bk-preview-create-note">Operator booking writes require approval gates before they can be enabled.</div>
  </div>

  <!-- ── Operator Room Release (Stage 8.3u) ───────────────────────────────── -->
  <div class="card" id="to-rr-panel" style="margin-top:16px">
    <div class="bc-op-header">
      <span class="bc-op-title">&#128477; Operator Room Release</span>
      <span class="bc-op-badge">Preview only &mdash; coming soon</span>
    </div>
    <div class="bc-rr-purpose">
      Use this when an operator has blocked a room for a long period but releases specific dates back to normal availability.
      This will eventually split the operator booking and release selected dates back to regular availability.
      <strong>Preview only &mdash; no room will be released.</strong>
    </div>

    <!-- Section: Operator Block (Stage 8.7.17 — simplified) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Operator Block</div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-block-select">Operator block</label>
        <select id="to-rr-block-select" class="bk-input bk-input-sm">
          <option value="">— select operator block —</option>
          <option value="" disabled>Dynamic operator block list — coming soon</option>
        </select>
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-orig-cin">Block start date</label>
        <input type="date" id="to-rr-orig-cin" class="bk-input bk-input-sm bc-date-input bc-op-locked" readonly aria-readonly="true">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-orig-cout">Block end date</label>
        <input type="date" id="to-rr-orig-cout" class="bk-input bk-input-sm bc-date-input bc-op-locked" readonly aria-readonly="true">
      </div>
      <div class="to-form-hint">Block dates fill when an operator block is selected (dynamic list later).</div>
    </div>

    <!-- Section: Release Dates -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Release Dates</div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-start">Release start</label>
        <input type="date" id="to-rr-start" class="bk-input bk-input-sm bc-date-input">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-end">Release end</label>
        <input type="date" id="to-rr-end" class="bk-input bk-input-sm bc-date-input">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-nights">Release nights</label>
        <input type="text" id="to-rr-nights" class="bk-input bk-input-sm bc-op-locked" readonly placeholder="Calculated from release dates">
      </div>
    </div>

    <!-- Section: Release Scope (Stage 8.7.17) -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Release Scope</div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-room">Room to release</label>
        <select id="to-rr-room" class="bk-input bk-input-sm">
          <option value="">— select room —</option>
          <option value="" disabled>Load Bed Calendar for room list</option>
        </select>
      </div>
      <div class="to-form-hint">Rooms populate from loaded Bed Calendar data; dedicated room API later if needed.</div>
    </div>

    <!-- Section: Notes -->
    <div class="bk-form-section">
      <div class="bk-form-section-title">Notes</div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-reason">Reason for release</label>
        <input type="text" id="to-rr-reason" class="bk-input bk-input-sm" placeholder="e.g. operator cancelled these nights">
      </div>
      <div class="bk-form-row">
        <label class="bk-label" for="to-rr-staff-note">Internal staff note</label>
        <textarea id="to-rr-staff-note" class="bk-input" rows="2" placeholder="Internal note..."></textarea>
      </div>
    </div>

    <!-- Safety notice -->
    <div class="bk-safety-notice">
      &#128274; Preview only &mdash; no dates will be released.<br>
      No guest message, Stripe action, or n8n workflow will run.<br>
      Room release writes require approval gates, conflict checks, audit, and rollback proof before they can be enabled.
    </div>

    <!-- Disabled actions -->
    <div class="bc-sel-actions" style="margin-top:16px">
      <button class="btn bc-sel-create-btn" disabled id="to-rr-preview-btn"
        title="Release preview coming soon.">
        Preview Release
      </button>
      <button class="btn bc-sel-create-btn" disabled id="to-rr-release-btn"
        title="Room release requires write-gate approval.">
        Release Dates
      </button>
    </div>
    <div class="bk-preview-create-note">Room release writes require approval gates before they can be enabled.</div>
  </div>

</div>
</div><!-- /tab-tour-operator -->

<!-- ── Ask Luna tab (Stage 8.6.2) ─────────────────────────────────────────── -->
<div id="tab-ask-luna" class="tab-panel">
<div id="al-wrap">

  <div class="al-hero">
    <div>
      <div class="al-hero-title">Luna</div>
      <div class="al-hero-sub">Ask operational questions answered from structured booking and payment data. Read-only &mdash; no writes, no WhatsApp sends.</div>
    </div>
  </div>

  <div class="card">
    <div class="al-form-row">
      <input id="al-input" type="text" placeholder="Who still owes money?"
             autocomplete="off" spellcheck="false"
             onkeydown="if(event.key==='Enter')alAsk()">
      <button class="btn btn-primary" id="al-btn" onclick="alAsk()">Ask</button>
    </div>
    <div class="al-hint">
      Try: &ldquo;Who still owes money?&rdquo; &bull; &ldquo;Any payment links pending?&rdquo; &bull; &ldquo;Who needs human help?&rdquo; &bull; &ldquo;Any urgent handoffs?&rdquo; &bull; &ldquo;Who&rsquo;s arriving today?&rdquo;
    </div>
    <div id="al-error"></div>
    <div id="al-status"></div>
    <div id="al-result"></div>
  </div>

</div>
</div><!-- /tab-ask-luna -->

<script>
(function(){
'use strict';

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function el(id){ return document.getElementById(id); }
function escHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* Stage 8.4.10 — shared clipboard helper for dynamically-rendered copy buttons */
function bcCopyUrl(btn){
  var u = btn && btn.dataset && btn.dataset.url;
  if (!u) return;
  var orig = btn.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(u)
      .then(function(){ btn.textContent = '\u2713 Copied!'; setTimeout(function(){ btn.textContent = orig; }, 2000); })
      .catch(function(){ prompt('Payment link:', u); });
  } else {
    prompt('Payment link:', u);
  }
}
function fmtTs(ts){
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    if (diffMs < 60000) return 'just now';
    if (diffMs < 3600000) return Math.floor(diffMs/60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs/3600000) + 'h ago';
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  } catch(_){ return String(ts); }
}

/* Format date-only (no time) from ISO string or date value */
function fmtDateOnly(d){
  if (!d) return '—';
  try { return String(d).slice(0, 10); } catch(_){ return String(d || '—'); }
}

/* ── Tab utilities ────────────────────────────────────────────────────────── */
function switchToTab(tab, subtab){
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
  var btn = document.querySelector('.tab-btn[data-tab="' + tab + '"]');
  if (btn) btn.classList.add('active');
  var panel = el('tab-' + tab);
  if (panel) panel.classList.add('active');
  if (tab === 'conversations' && subtab){
    if (subtab === 'handoffs') setInboxFilter('needs-human');
    else if (subtab === 'inbox') setInboxFilter('all');
  }
  if (tab === 'bed-calendar') bcOnBedCalendarTabOpen();
}
function switchToTabOnly(tab){ switchToTab(tab, null); }

// Tab helpers must be global for Today tile onclick handlers (Stage 8.7.4)
window.switchToTab = switchToTab;
window.switchToTabOnly = switchToTabOnly;

/* ── Tabs ─────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(function(btn){
  btn.addEventListener('click', function(){
    const target = this.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
    this.classList.add('active');
    el('tab-' + target).classList.add('active');
    if (target === 'today') loadTodaySummary();
    if (target === 'bed-calendar') bcOnBedCalendarTabOpen();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CONVERSATIONS TAB — inbox + detail
   ═══════════════════════════════════════════════════════════════════════════ */

var selectedConvId = null;
var inboxFilter = 'all'; /* 'all' | 'needs-human' — Stage 8.7.13 */
var inboxConversationsCache = null;

function conversationNeedsHuman(c){
  return !!(c && c.needs_human);
}

function filterInboxConversations(convs){
  if (inboxFilter === 'needs-human'){
    return (convs || []).filter(conversationNeedsHuman);
  }
  return convs || [];
}

function updateInboxFilterUI(){
  document.querySelectorAll('.inbox-filter-btn').forEach(function(btn){
    btn.classList.toggle('active', btn.dataset.inboxFilter === inboxFilter);
  });
  var roNote = el('inbox-ro-note');
  if (roNote) roNote.classList.toggle('visible', inboxFilter === 'needs-human');
}

function setInboxFilter(mode){
  inboxFilter = (mode === 'needs-human') ? 'needs-human' : 'all';
  updateInboxFilterUI();
  if (inboxConversationsCache) applyInboxFilter();
  else loadInbox();
}

function applyInboxFilter(){
  renderInbox(filterInboxConversations(inboxConversationsCache || []));
}

function getClient(){
  return (el('c-client').value || 'wolfhouse-somo').trim();
}

/* Priority badge */
function priorityPill(conv){
  if (conv.needs_human && conv.handoff_priority === 'urgent')
    return '<span class="pill pill-red">URGENT</span>';
  if (conv.needs_human)
    return '<span class="pill pill-orange">NEEDS HUMAN</span>';
  if (conv.handoff_status === 'open')
    return '<span class="pill pill-blue">HANDOFF</span>';
  return '<span class="pill pill-grey">BOT</span>';
}

/* Mode badge */
function modePill(mode){
  if (mode === 'staff') return '<span class="pill pill-orange">STAFF</span>';
  if (mode === 'paused') return '<span class="pill pill-grey">PAUSED</span>';
  return '<span class="pill pill-green">BOT</span>';
}

/* Friendly handoff reason labels (hides raw codes from normal staff UI) */
function handoffLabel(code){
  if (!code) return '';
  var labels = {
    'date_change_requested':  'Date change request',
    'date_change_request':    'Date change request',
    'payment_inquiry':        'Payment question',
    'cancel_refund':          'Cancellation / refund',
    'needs_human':            'Needs staff reply',
    'rooming_issue':          'Rooming issue',
    'payment_claimed':        'Payment claimed',
    'booking_question':       'Booking question',
    'refund_request':         'Refund request',
    'guest_angry':            'Upset guest',
    'date_change':            'Date change request',
  };
  return labels[code] || 'Needs review';
}

/* Phase 9.3 — read-only Luna guest automation pause signal from API payloads */
function isLunaGuestAutomationPaused(sources){
  var list = sources || [];
  for (var i = 0; i < list.length; i++){
    var o = list[i];
    if (!o || typeof o !== 'object') continue;
    if (o.bot_paused === true) return true;
    if (o.paused === true) return true;
    if (o.pause_state && o.pause_state.paused === true) return true;
    if (o.pauseState && o.pauseState.paused === true) return true;
  }
  return false;
}

/* Phase 9.5 — live pause lookup via GET /staff/bot/pause-state; failure → default active */
function fetchBotPauseState(client, convId){
  var qs = '?client_slug=' + encodeURIComponent(client) + '&conversation_id=' + encodeURIComponent(convId);
  return fetch('/staff/bot/pause-state' + qs)
    .then(function(r){ return r.ok ? r.json() : { success: false }; })
    .catch(function(){ return { success: false }; });
}

/* Render inbox conversation cards (left column) */
function renderInbox(convs){
  var list = el('conv-list');
  if (!convs || convs.length === 0){
    var emptyMsg = inboxFilter === 'needs-human'
      ? 'No conversations need staff review right now.'
      : 'No conversations need review right now.';
    el('inbox-state').textContent = emptyMsg;
    el('inbox-state').classList.remove('error');
    el('inbox-state').style.display = 'block';
    if (list) list.innerHTML = '<div class="conv-list-empty">' + escHtml(emptyMsg) + '</div>';
    el('inbox-count').textContent = '';
    selectedConvId = null;
    el('detail-content').innerHTML = '<div class="inbox-empty-right">' +
      '<p class="main-msg">Select a conversation to review.</p>' +
      '<p class="sub-msg">Luna drafts and booking context will appear here.</p>' +
      '</div>';
    return;
  }
  el('inbox-state').style.display = 'none';
  el('inbox-count').textContent = convs.length + ' conversation' + (convs.length===1?'':'s');

  var cards = convs.map(function(c){
    var handoff = c.handoff_reason ? handoffLabel(c.handoff_reason) : '';
    return '<div class="conv-card" data-id="' + escHtml(c.conversation_id) + '">' +
      '<div class="conv-card-name">' + escHtml(c.guest_name || '—') + '</div>' +
      '<div class="conv-card-phone">' + escHtml(c.phone) + '</div>' +
      '<div class="conv-card-pills">' + priorityPill(c) + '</div>' +
      (handoff ? '<div class="conv-card-handoff">' + escHtml(handoff) + '</div>' : '') +
    '</div>';
  }).join('');

  if (list) {
    list.innerHTML = cards;
    list.querySelectorAll('.conv-card').forEach(function(card){
      card.addEventListener('click', function(){
        list.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
        this.classList.add('selected');
        loadConvDetail(this.dataset.id);
      });
    });
    /* Auto-select top conversation (or keep current if still in filtered list) */
    var pickId = null;
    if (selectedConvId && convs.some(function(c){ return c.conversation_id === selectedConvId; })){
      pickId = selectedConvId;
    } else {
      pickId = convs[0].conversation_id;
    }
    if (pickId){
      var pickCard = list.querySelector('.conv-card[data-id="' + pickId + '"]');
      if (pickCard){
        list.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
        pickCard.classList.add('selected');
        loadConvDetail(pickId);
      }
    }
  }
}

/* Load inbox */
function loadInbox(){
  el('inbox-state').textContent = 'Loading conversations\u2026';
  el('inbox-state').classList.remove('error');
  el('inbox-state').style.display = 'block';
  if (el('conv-list')) el('conv-list').innerHTML = '';
  el('inbox-count').textContent = '';
  selectedConvId = null;
  /* Reset right panel to empty state */
  el('detail-content').innerHTML = '<div class="inbox-empty-right">' +
    '<p class="main-msg">Select a conversation to review.</p>' +
    '<p class="sub-msg">Luna drafts and booking context will appear here.</p>' +
    '</div>';

  fetch('/staff/conversations?client=' + encodeURIComponent(getClient()))
    .then(function(r){
      if (r.status === 401){
        el('inbox-state').innerHTML = '\u26a0 Authentication required &mdash; <strong>POST /staff/auth/login</strong> first.';
        el('inbox-state').classList.add('error');
        el('inbox-state').style.display = 'block';
        return null;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (!data) return;
      if (!data.success) throw new Error(data.error || 'API error');
      inboxConversationsCache = data.conversations || [];
      var nhCount = inboxConversationsCache.filter(conversationNeedsHuman).length;
      var badge = el('hq-badge');
      if (badge){ badge.textContent = nhCount; badge.classList.toggle('visible', nhCount > 0); }
      applyInboxFilter();
    })
    .catch(function(err){
      el('inbox-state').textContent = 'Error loading inbox: ' + err.message;
      el('inbox-state').classList.add('error');
      el('inbox-state').style.display = 'block';
    });
}

/* Load conversation detail — Stage 7.7d: fetches all 5 sub-endpoints.
   targetEl: optional DOM element to render into (defaults to el('detail-content')). */
function loadConvDetail(convId, targetEl){
  targetEl = targetEl || el('detail-content');
  selectedConvId = convId;
  if (targetEl === el('detail-content')) el('conv-detail').classList.add('visible');
  targetEl.innerHTML = '<div class="state-msg">Loading\u2026</div>';

  var base = '/staff/conversations/' + encodeURIComponent(convId);
  var qs   = '?client=' + encodeURIComponent(getClient());
  var client = getClient();

  function gjson(path){ return fetch(path).then(function(r){ return r.json(); }); }

  Promise.all([
    gjson(base + qs),
    gjson(base + '/messages' + qs),
    gjson(base + '/context'  + qs),
    gjson(base + '/draft'    + qs),
    gjson(base + '/staff-state' + qs),
    fetchBotPauseState(client, convId),
  ]).then(function(results){
    var detailData = results[0];
    var msgsData   = results[1];
    var ctxData    = results[2];
    var draftData  = results[3];
    var stateData  = results[4];
    var pauseData  = results[5];

    if (!detailData.success) throw new Error(detailData.error || 'detail error');

    var c     = detailData.conversation;
    var msgs  = (msgsData.success  && msgsData.messages)  ? msgsData.messages  : [];
    var ctx   = (ctxData.success   && ctxData.context)    ? ctxData.context    : null;
    var draft = (draftData.success && draftData.draft)     ? draftData.draft    : null;
    var state = (stateData.success && stateData.state)     ? stateData.state    : null;
    var lunaGuestPaused = isLunaGuestAutomationPaused([pauseData, detailData, c, stateData, state]);

    /* ── Header ── */
    var html = '<div class="detail-header">';
    html +=   '<div>';
    html +=     '<div class="detail-name">' + escHtml(c.guest_name || c.phone) + '</div>';
    html +=     '<div class="detail-meta">' + escHtml(c.phone);
    if (c.handoff_reason) html += ' &bull; ' + escHtml(handoffLabel(c.handoff_reason));
    html +=     '</div>';
    html +=   '</div>';
    html +=   '<div style="margin-left:auto;display:flex;gap:6px;align-items:flex-start">';
    html +=     modePill(c.bot_mode);
    if (c.needs_human) html += '<span class="pill pill-orange">NEEDS HUMAN</span>';
    html +=   '</div>';
    html += '</div>';

    /* ── Two-column layout ── */
    html += '<div class="detail-layout">';

    /* ═══ LEFT — thread + draft panel ═══ */
    html += '<div class="detail-main">';

    /* Message thread — no title per Stage 8.3y */
    html += '<div class="thread-section">';
    html +=   '<div class="thread" id="thread-container">';
    if (msgs.length === 0){
      html += '<div class="thread-empty">No message history yet &mdash; messages appear here once the guest contacts via WhatsApp.</div>';
    } else {
      msgs.forEach(function(m){
        var dir = (m.direction === 'inbound') ? 'inbound' : 'outbound';
        var sender = dir === 'inbound' ? 'Guest' : (m.source || 'Luna');
        html += '<div class="msg ' + dir + '">';
        html +=   '<div class="msg-bubble">' + escHtml(m.message_text || '') + '</div>';
        html +=   '<div class="msg-meta">' + escHtml(sender) + ' &bull; ' + escHtml(fmtTs(m.created_at));
        html +=   '</div>';
        html += '</div>';
      });
    }
    html +=   '</div>'; /* /thread */
    html += '</div>'; /* /thread-section */

    /* Luna draft panel — editable textarea for copy, NOT for saving/sending */
    var draftText = (draft && draft.draft_text) ? draft.draft_text : (c.staff_reply_draft || '');
    var draftAvail = draftText && draftText.trim().length > 0;

    html += '<div class="draft-panel">';
    html +=   '<div class="draft-label">';
    html +=     '<h3>Luna draft reply</h3>';
    html +=     '<span class="draft-not-sent">NOT SENT</span>';
    html +=     '<span style="font-size:11px;color:#7f8c8d">— copy for manual WhatsApp send (shadow mode)</span>';
    html +=   '</div>';
    html +=   '<div class="draft-instructions">Review and edit the draft below, then copy it and send manually in WhatsApp during shadow mode.</div>';
    if (!draftAvail){
      html += '<div style="color:#9aabb8;font-size:12px;font-style:italic;margin-bottom:8px">No Luna draft available yet &mdash; type a manual reply below to copy.</div>';
    }
    html += '<textarea id="draft-textarea" placeholder="No Luna draft \u2014 type a manual reply here to copy">' +
            escHtml(draftText) + '</textarea>';
    html += '<div class="draft-actions">';
    html +=   '<button class="btn-copy" id="btn-copy-draft">Copy to clipboard</button>';
    html +=   '<span class="copy-confirm" id="copy-confirm" style="display:none">Copied &mdash; send manually in WhatsApp</span>';
    html +=   '<button class="btn-send-disabled" disabled>Approve &amp; Send &mdash; disabled (live-send gate required)</button>';
    html +=   '<span class="draft-warning">Shadow mode: copy this reply and send it manually in WhatsApp. No live sends from this dashboard.</span>';
    html += '</div>';
    html += '</div>'; /* /draft-panel */

    /* Shadow-mode workflow checklist (Stage 7.7j) */
    html += '<div class="shadow-checklist">';
    html +=   '<div class="shadow-checklist-title">Shadow-mode workflow</div>';
    html +=   '<ol class="shadow-checklist-steps">';
    html +=     '<li>Read the guest message thread above</li>';
    html +=     '<li>Review and edit the Luna draft in the text area</li>';
    html +=     '<li>Click <strong>Copy to clipboard</strong></li>';
    html +=     '<li>Paste and send manually in WhatsApp</li>';
    html +=     '<li class="shadow-checklist-gate">Do <strong>not</strong> use this dashboard for live sends yet &mdash; live-send gate required</li>';
    html +=   '</ol>';
    html += '</div>';

    /* Read-only footer */
    html += '<div style="margin-top:12px;padding:10px 14px;background:#FBF7F0;border:1px solid #EFE8DC;border-radius:10px;font-size:11px;color:#6B756F">';
    html +=   'READ-ONLY VIEW &mdash; SHADOW MODE. No live sends from this dashboard. ';
    html +=   'Draft is not sent automatically.';
    html += '</div>';

    html += '</div>'; /* /detail-main */

    /* ═══ RIGHT — context sidebar ═══ */
    html += '<div class="detail-sidebar">';

    /* ── 1. Booking + payment context card (shown first) ── */
    var bctx = ctx || {};
    html += '<div class="sidebar-card">';
    html +=   '<h3>Booking</h3>';
    if (!bctx.booking_code){
      html += '<div style="color:#9aabb8;font-size:12px;font-style:italic">No booking linked yet.</div>';
    } else {
      html += '<div class="kv2">';
      html +=   kv('Code',        bctx.booking_code) +
                kv('Status',      bctx.booking_status) +
                kv('Payment',     bctx.booking_payment_status) +
                kv('Stay',        fmtDateOnly(bctx.check_in) + ' \u2192 ' + fmtDateOnly(bctx.check_out)) +
                kv('Guests',      bctx.guest_count) +
                kv('Package',     bctx.package_code) +
                kv('Room pref',   bctx.room_preference || bctx.requested_room_type || '—') +
                kv('Assigned',    (bctx.assigned_room_code || '—') + (bctx.assigned_bed_code ? ' / ' + bctx.assigned_bed_code : '')) +
                kv('Confirm',     bctx.confirmation_sent_at ? fmtTs(bctx.confirmation_sent_at) : '—');
      html += '</div>';
      if (bctx.payment_amount_due_cents != null){
        html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #eef0f3">';
        html +=   '<div style="font-size:11px;font-weight:700;color:#5a6a85;margin-bottom:6px">Payment</div>';
        html +=   '<div class="kv2">';
        html +=     kv('Due',    '\u20ac' + (bctx.payment_amount_due_cents/100).toFixed(2)) +
                    kv('Paid',   '\u20ac' + ((bctx.payment_amount_paid_cents||0)/100).toFixed(2)) +
                    kv('Status', bctx.payment_record_status || '—');
        html +=   '</div>';
        html += '</div>';
      }
    }
    html += '</div>'; /* /sidebar-card */

    /* ── 2. Bot / staff state card (shown second, simplified) ── */
    var ss = state || {};
    html += '<div class="sidebar-card">';
    html +=   '<h3>Bot state</h3>';
    html +=   '<div class="luna-auto-status' + (lunaGuestPaused ? ' luna-auto-status-paused' : '') + '">';
    html +=     '<div class="luna-auto-status-label">' + (lunaGuestPaused ? 'Luna paused' : 'Luna active') + '</div>';
    html +=     '<div class="luna-auto-status-help">' + (lunaGuestPaused
      ? 'Automated guest replies should stay blocked while paused.'
      : 'Automation status: active.') + '</div>';
    html +=   '</div>';
    html +=   '<div class="kv2">';
    html +=     kv('Mode',        ss.bot_mode   || c.bot_mode) +
                kv('Needs human', ss.needs_human != null ? String(ss.needs_human) : String(c.needs_human));
    html +=   '</div>';
    if (ss.handoff_id){
      html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #eef0f3">';
      html +=   '<div style="font-size:11px;font-weight:700;color:#e67e22;margin-bottom:6px">OPEN HANDOFF</div>';
      html +=   '<div class="kv2">';
      html +=     kv('Reason',   ss.handoff_reason) +
                  kv('Priority', ss.handoff_priority) +
                  kv('Assigned', ss.assigned_staff || '—') +
                  kv('Opened',   fmtTs(ss.handoff_opened_at));
      html +=   '</div>';
      html += '</div>';
    }
    html += '</div>'; /* /sidebar-card */

    /* Notes / summary */
    if (c.human_notes || c.conversation_summary){
      html += '<div class="sidebar-card">';
      html +=   '<h3>Notes</h3>';
      if (c.human_notes)          html += '<div style="font-size:12px;color:#2c3e50;white-space:pre-wrap;margin-bottom:6px">' + escHtml(c.human_notes) + '</div>';
      if (c.conversation_summary) html += '<div style="font-size:11px;color:#7f8c8d;white-space:pre-wrap">' + escHtml(c.conversation_summary) + '</div>';
      html += '</div>';
    }

    html += '</div>'; /* /detail-sidebar */
    html += '</div>'; /* /detail-layout */

    targetEl.innerHTML = html;

    /* Wire copy button after DOM update */
    var copyBtn   = targetEl.querySelector('#btn-copy-draft');
    var confirmEl = targetEl.querySelector('#copy-confirm');
    var textaEl   = targetEl.querySelector('#draft-textarea');
    if (copyBtn && textaEl){
      copyBtn.addEventListener('click', function(){
        var text = textaEl.value;
        var doConfirm = function(){
          if (confirmEl){ confirmEl.style.display='inline'; setTimeout(function(){ confirmEl.style.display='none'; }, 2500); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(text).then(doConfirm).catch(function(){
            textaEl.select(); document.execCommand('copy'); doConfirm();
          });
        } else {
          textaEl.select(); document.execCommand('copy'); doConfirm();
        }
      });
    }

    /* Scroll thread to bottom */
    var threadEl = targetEl.querySelector('#thread-container');
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
  })
  .catch(function(err){
    targetEl.innerHTML = '<div class="state-msg error">Error loading conversation: ' + escHtml(err.message) + '</div>';
  });
}

function kv(label, val){
  return '<div class="kv"><span class="k">' + escHtml(label) + '</span><span class="v">' + escHtml(val==null?'—':String(val)) + '</span></div>';
}

/* Back button (preserved as no-op guard — inbox is now persistent two-column) */
var btnBack = el('btn-back');
if (btnBack) {
  btnBack.addEventListener('click', function(){
    var convList = el('conv-list');
    if (convList) convList.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
    el('detail-content').innerHTML = '<div class="inbox-empty-right">' +
      '<p class="main-msg">Select a conversation to review.</p>' +
      '<p class="sub-msg">Luna drafts and booking context will appear here.</p>' +
      '</div>';
    selectedConvId = null;
  });
}

/* Refresh button */
el('btn-refresh').addEventListener('click', function(){
  inboxConversationsCache = null;
  loadInbox();
});

/* Inbox filter chips (Stage 8.7.13) */
document.querySelectorAll('.inbox-filter-btn').forEach(function(btn){
  btn.addEventListener('click', function(){
    setInboxFilter(this.dataset.inboxFilter || 'all');
  });
});
updateInboxFilterUI();

/* Auto-load inbox on page load */
loadInbox();

/* ═══════════════════════════════════════════════════════════════════════════
   ASK LUNA TAB — Stage 8.6.2
   Calls POST /staff/ask-luna (session auth, source=staff_portal).
   Read-only: no writes, no WhatsApp, no n8n, no Stripe.
   ═══════════════════════════════════════════════════════════════════════════ */

function alClearState(){
  el('al-error').style.display = 'none';
  el('al-error').textContent   = '';
  el('al-status').textContent  = '';
  el('al-result').innerHTML    = '';
}

function alShowError(msg){
  el('al-error').textContent  = msg;
  el('al-error').style.display = 'block';
}

function alSetLoading(on){
  el('al-btn').disabled       = on;
  el('al-status').textContent = on ? 'Asking Luna\u2026' : '';
}

function alRenderResult(data){
  var html = '';
  if (data.intent === 'unsupported_intent'){
    html += '<div class="al-answer-box">';
    html += '<div class="al-answer-intent">unsupported intent</div>';
    html += '<div class="al-answer-text">&#129300; ' + escHtml(data.answer || 'Unsupported question.') + '</div>';
    if (data.intent_hint){
      html += '<div class="al-answer-unsupported">Intent hint: <strong>' + escHtml(data.intent_hint) + '</strong></div>';
    }
    html += '</div>';
  } else {
    html += '<div class="al-answer-box">';
    html += '<div class="al-answer-intent">' + escHtml(data.intent || '') + (data.category ? ' &bull; ' + escHtml(data.category) : '') + '</div>';
    html += '<div class="al-answer-text">&#10004;&#65038; ' + escHtml(data.answer || '') + '</div>';
    var n = data.row_count != null ? data.row_count : (data.rows ? data.rows.length : 0);
    if (n > 0){
      html += '<div class="al-answer-rowcount">' + n + ' row' + (n !== 1 ? 's' : '') + ' returned</div>';
      var rows = data.rows || [];
      if (rows.length > 0){
        var cols = Object.keys(rows[0]).filter(function(c){
          return ['booking_id','payment_id'].indexOf(c) === -1;
        });
        html += '<div style="overflow-x:auto"><table class="al-rows-table"><thead><tr>';
        cols.forEach(function(c){ html += '<th>' + escHtml(c) + '</th>'; });
        html += '</tr></thead><tbody>';
        rows.slice(0, 20).forEach(function(row){
          html += '<tr>';
          cols.forEach(function(c){
            var v = row[c] == null ? '' : String(row[c]);
            html += '<td>' + escHtml(v) + '</td>';
          });
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        if (rows.length > 20){
          html += '<div style="font-size:11px;color:var(--text-3);text-align:right;margin-top:4px">Showing first 20 of ' + rows.length + '</div>';
        }
      }
    } else {
      html += '<div class="al-answer-rowcount" style="color:#6B9B5A">No rows &mdash; all clear.</div>';
    }
    html += '</div>';
  }
  el('al-result').innerHTML = html;
}

function alAsk(){
  alClearState();
  var question = (el('al-input').value || '').trim();
  if (!question){ alShowError('Please type a question first.'); return; }

  alSetLoading(true);

  fetch('/staff/ask-luna', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_slug: 'wolfhouse-somo',
      question:    question,
      source:      'staff_portal'
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    alSetLoading(false);
    if (!data.success && data.error){
      alShowError((data.error || 'Query failed') + (data.detail ? ' \u2014 ' + data.detail : ''));
      return;
    }
    alRenderResult(data);
  })
  .catch(function(e){
    alSetLoading(false);
    alShowError('Network error: ' + e.message);
  });
}

// alAsk must be global so onclick/onkeydown in Ask Luna HTML resolve it (Stage 8.7.4)
window.alAsk = alAsk;

/* ═══════════════════════════════════════════════════════════════════════════
   QUERY TOOLS TAB — existing staff query interface (unchanged)
   ═══════════════════════════════════════════════════════════════════════════ */

var registry = {};
var LABEL_MAP = {
  date:'lbl-date', start_date:'lbl-start', end_date:'lbl-end',
  booking_code:'lbl-booking', reason_code:'lbl-reason',
  staff_name:'lbl-staff', hours:'lbl-hours',
};

function qShowError(msg){
  var p = el('q-error'); p.textContent = msg; p.style.display = 'block';
}
function qClearError(){ el('q-error').style.display = 'none'; }

function updateParamLabels(entry){
  Object.values(LABEL_MAP).forEach(function(id){ el(id).classList.remove('visible'); });
  if (!entry) return;
  var needed = new Set(entry.requiredParams.concat(entry.optionalParams));
  needed.forEach(function(p){ if (LABEL_MAP[p]) el(LABEL_MAP[p]).classList.add('visible'); });
}

/* Load intents */
fetch('/staff/intents')
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (!data.success){ qShowError('Failed to load intents: ' + (data.error||'unknown')); return; }
    registry = data.intents;
    var catSel = el('f-cat');
    catSel.innerHTML = '<option value="">-- pick category --</option>';
    data.categories.forEach(function(cat){
      var o = document.createElement('option'); o.value = cat; o.textContent = cat;
      catSel.appendChild(o);
    });
  })
  .catch(function(e){ qShowError('Could not reach API: ' + e.message); });

el('f-cat').addEventListener('change', function(){
  var cat = this.value;
  var intentSel = el('f-intent');
  intentSel.innerHTML = '<option value="">-- pick intent --</option>';
  intentSel.disabled = !cat;
  el('btn-run').disabled = true;
  updateParamLabels(null);
  if (!cat) return;
  (registry[cat]||[]).forEach(function(entry){
    var o = document.createElement('option');
    o.value = entry.key; o.textContent = entry.key + ' \u2014 ' + entry.description;
    intentSel.appendChild(o);
  });
  intentSel.disabled = false;
});

el('f-intent').addEventListener('change', function(){
  var key = this.value;
  el('btn-run').disabled = !key;
  if (!key){ updateParamLabels(null); return; }
  var cat = el('f-cat').value;
  var entry = (registry[cat]||[]).find(function(e){ return e.key === key; });
  updateParamLabels(entry);
});

el('btn-run').addEventListener('click', function(){
  qClearError();
  var client = el('f-client').value.trim() || 'wolfhouse-somo';
  var intent = el('f-intent').value.trim();
  if (!intent){ qShowError('No intent selected.'); return; }
  var params = new URLSearchParams({ client: client, intent: intent });
  var fieldMap = {date:'f-date',start:'f-start',end:'f-end',booking:'f-booking',
                  reason:'f-reason',staff:'f-staff',hours:'f-hours'};
  Object.entries(fieldMap).forEach(function(kv){
    var v = el(kv[1]).value.trim(); if (v) params.set(kv[0], v);
  });

  el('btn-run').disabled = true;
  el('status-txt').textContent = 'Running\u2026';
  el('q-meta').textContent = '';
  el('q-table-wrap').innerHTML = '';
  el('q-json').style.display = 'none';

  fetch('/staff/query?' + params.toString())
    .then(function(r){ return r.json(); })
    .then(function(data){
      el('btn-run').disabled = false;
      el('status-txt').textContent = '';
      if (!data.success){
        qShowError((data.error||'Query failed') + (data.detail ? ' \u2014 ' + data.detail : ''));
        return;
      }
      var html = '';
      if (data.migration_note)
        html += '<div class="mig-note">\u26a0 Migration advisory: ' + data.migration_note + '</div>';
      html += '<span class="view-toggle" id="q-toggle">JSON</span>';
      el('q-meta').innerHTML = '<strong>' + data.intent + '</strong> &mdash; ' + data.category +
                               ' &mdash; ' + data.row_count + ' row(s) &mdash; ' + data.elapsed_ms + 'ms';
      if (!data.rows || data.rows.length === 0){
        el('q-table-wrap').innerHTML = html + '<div style="color:#9aabb8;padding:20px 0;text-align:center">No rows returned.</div>';
      } else {
        var cols = Object.keys(data.rows[0]);
        var tbl = '<table><thead><tr>' + cols.map(function(c){ return '<th>' + escHtml(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        data.rows.forEach(function(row){
          tbl += '<tr>' + cols.map(function(c){ return '<td>' + escHtml(row[c]==null?'':String(row[c])) + '</td>'; }).join('') + '</tr>';
        });
        tbl += '</tbody></table>';
        el('q-table-wrap').innerHTML = html + tbl;
      }
      el('q-json').textContent = JSON.stringify(data, null, 2);
      var tog = el('q-toggle');
      if (tog) tog.addEventListener('click', function(){
        var jv = el('q-json');
        if (jv.style.display==='none'){ jv.style.display='block'; this.textContent='Table'; }
        else { jv.style.display='none'; this.textContent='JSON'; }
      });
    })
    .catch(function(e){
      el('btn-run').disabled = false;
      el('status-txt').textContent = '';
      qShowError('Network error: ' + e.message);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
   BED CALENDAR TAB — Stage 7.7h
   Read-only Excel-style grid. Fetches GET /staff/bed-calendar.
   NO edits. NO drag/drop. NO drag events. NO write actions.
   ═══════════════════════════════════════════════════════════════════════════ */

var bcData = null;
/* Selection model state (Stage 8.3c) — read-only, no writes */
var bcSel = null;        /* { anchor_date, cursor_date } — shared date range */
var bcSelectedBeds = []; /* [{ room_code, bed_code }] — beds in current selection (Stage 8.4.5) */
/* Stage 8.4.8 — server-reported feature flags (interpolated at render time) */
var BC_STAFF_ACTIONS  = ${STAFF_ACTIONS_ENABLED};
var BC_MANUAL_BOOKING = ${MANUAL_BOOKING_ENABLED};
/* Stage 8.4.9/10 — Stripe link flag */
var BC_STRIPE_LINKS   = ${STRIPE_LINKS_ENABLED};
/* Last successful quote (required for create) */
var bcLastQuote = null;
/* Stage 8.4.10 — payment_id from last successful manual booking create */
var bcLastPaymentId = null;
var bcLastOpenedBlock = null;

function getBcClient(){ return (el('bc-client').value || 'wolfhouse-somo').trim(); }

/* ── Cell selection model (Stage 8.3c, read-only) ─────────────────────────── */
function bcClearSelection(){
  bcSel = null;
  bcSelectedBeds = [];
  document.querySelectorAll('.bc-day-cell.bc-sel, .bc-day-cell.bc-sel-anchor').forEach(function(td){
    td.classList.remove('bc-sel', 'bc-sel-anchor');
  });
  /* Reset pre-filled stay fields (Stage 8.3d) */
  ['bc-sel-cin','bc-sel-cout','bc-sel-nights'].forEach(function(id){
    var inp = el(id); if (inp) inp.value = '';
  });
  /* Reset beds list (Stage 8.4.5) */
  var _blEl = el('bc-sel-beds-list'); if (_blEl) _blEl.innerHTML = '';
  var _bcEl = el('bc-sel-bed-count'); if (_bcEl) _bcEl.textContent = '';
  /* Reset guest/payment/notes fields */
  ['bk-guest-name','bk-phone','bk-email','bk-notes','bk-deposit','bk-total'].forEach(function(id){
    var inp = el(id); if (inp) inp.value = '';
  });
  var gc = el('bk-guest-count'); if (gc) gc.value = '1';
  var ps = el('bk-payment-status'); if (ps) ps.value = 'unpaid';
  var pc = el('bk-payment-choice'); if (pc) pc.value = 'deposit';
  var pk = el('bk-package'); if (pk) pk.value = '';
  var rt = el('bk-room-type'); if (rt) rt.value = 'shared';
  /* Reset quote state and create panel (Stage 8.4.8/10) */
  bcLastQuote = null;
  bcLastPaymentId = null;
  var _crEl = el('bc-create-result'); if (_crEl) _crEl.innerHTML = '';
  var _slEl = el('bc-stripe-link-result'); if (_slEl) _slEl.innerHTML = '';
  bcUpdateCreateButton();
  /* Reset add-on qty inputs (Stage 8.7.15 — qty-only, default 0) */
  ['bk-ao-ws-combo-days','bk-ao-wb-combo-days','bk-ao-wetsuit-days','bk-ao-softtop-days','bk-ao-hardboard-days',
   'bk-ao-surf-lessons','bk-ao-yoga','bk-ao-meals'].forEach(function(id){
    var inp = el(id); if (inp) inp.value = '0';
  });
  var warnEl = el('bc-sel-warn');
  if (warnEl){ warnEl.textContent = ''; warnEl.style.display = 'none'; }
  var panel = el('bc-sel-panel');
  if (panel) panel.style.display = 'none';
  /* Reset preview result and disable conflicts button (Stage 8.3l) */
  var _prClear = el('bc-preview-result');
  if (_prClear) _prClear.innerHTML = '<div class="bk-preview-not-run">Availability and conflict preview will appear here before booking creation is enabled.</div>';
  var _cBtnClear = el('bc-sel-conflicts');
  if (_cBtnClear){ _cBtnClear.disabled = true; _cBtnClear.title = 'Select empty cells to enable conflict preview'; }
  /* Reset quote result and disable Calculate Quote button (Stage 8.4.5) */
  var _qrClear = el('bc-quote-result');
  if (_qrClear) _qrClear.innerHTML = '<div class="bk-preview-not-run">Select beds, dates, and package, then click Calculate Quote.</div>';
  var _qBtnClear = el('bc-sel-quote');
  if (_qBtnClear){ _qBtnClear.disabled = true; _qBtnClear.title = 'Select beds, dates, and package to calculate quote'; }
}

function bcApplySelectionHighlight(){
  /* Remove previous highlight */
  document.querySelectorAll('.bc-day-cell.bc-sel, .bc-day-cell.bc-sel-anchor').forEach(function(td){
    td.classList.remove('bc-sel', 'bc-sel-anchor');
  });
  if (!bcSel || bcSelectedBeds.length === 0) return;
  var a = bcSel.anchor_date;
  var b = bcSel.cursor_date;
  var selStart = a <= b ? a : b;
  var selEnd   = a <= b ? b : a;

  /* Compute check-out = day after last selected cell */
  var coDate = new Date(selEnd + 'T00:00:00Z');
  coDate.setUTCDate(coDate.getUTCDate() + 1);
  var checkOut = coDate.toISOString().slice(0, 10);

  /* Compute nights */
  var nights = Math.round((new Date(checkOut + 'T00:00:00Z') - new Date(selStart + 'T00:00:00Z')) / 86400000);

  /* Highlight cells for ALL selected beds (Stage 8.4.5 multi-bed) */
  bcSelectedBeds.forEach(function(bedEntry, bidx){
    document.querySelectorAll('.bc-day-cell[data-date]').forEach(function(td){
      if (td.dataset.room !== bedEntry.room_code || td.dataset.bed !== bedEntry.bed_code) return;
      var d = td.dataset.date;
      if (d >= selStart && d <= selEnd){
        td.classList.add('bc-sel');
        if (bidx === 0 && d === bcSel.anchor_date) td.classList.add('bc-sel-anchor');
      }
    });
  });

  /* Update form skeleton pre-filled fields (Stage 8.3d) */
  var cinInp    = el('bc-sel-cin');    if (cinInp)    cinInp.value    = selStart;
  var coutInp   = el('bc-sel-cout');   if (coutInp)   coutInp.value   = checkOut;
  var nightsInp = el('bc-sel-nights'); if (nightsInp) nightsInp.value = String(nights);

  /* Update selected beds list (Stage 8.4.5) */
  var _blEl = el('bc-sel-beds-list');
  if (_blEl){
    _blEl.innerHTML = bcSelectedBeds.map(function(b){
      return '<span class="bc-sel-bed-tag">' + escHtml(b.room_code) + '&thinsp;/&thinsp;' + escHtml(b.bed_code) + '</span>';
    }).join('');
  }
  var _bcEl = el('bc-sel-bed-count');
  if (_bcEl) _bcEl.textContent = bcSelectedBeds.length + ' bed' + (bcSelectedBeds.length === 1 ? '' : 's') + ' selected';

  /* Auto-update guest count to match bed count if still at default (Stage 8.4.5) */
  var gcEl = el('bk-guest-count');
  if (gcEl && bcSelectedBeds.length > 1) gcEl.value = String(bcSelectedBeds.length);

  var warnEl = el('bc-sel-warn');
  if (warnEl) warnEl.style.display = 'none';
  var panel = el('bc-sel-panel');
  if (panel) panel.style.display = 'block';

  /* Enable/disable Preview Conflicts based on selection (Stage 8.3l) */
  var _cBtnSel = el('bc-sel-conflicts');
  if (_cBtnSel) {
    _cBtnSel.disabled = (nights < 1);
    _cBtnSel.title = nights >= 1 ? 'Check availability for selected dates and beds' : 'Select empty cells to enable conflict preview';
  }
  /* Clear stale previews when selection changes (Stage 8.3l + 8.4.5) */
  var _prSel = el('bc-preview-result');
  if (_prSel) _prSel.innerHTML = '<div class="bk-preview-not-run">Availability and conflict preview will appear here before booking creation is enabled.</div>';
  var _qrSel = el('bc-quote-result');
  if (_qrSel) _qrSel.innerHTML = '<div class="bk-preview-not-run">Select beds, dates, and package, then click Calculate Quote.</div>';
  /* Update Calculate Quote button enabled state (Stage 8.4.5) */
  bcUpdateQuoteButton();
}

/* ── Preview Conflicts (Stage 8.3l — read-only, no writes) ─────────────────── */
/* Posts ONLY to /staff/manual-bookings/preview — no booking created, no writes. */
function runPreviewConflicts() {
  if (!bcSel) return;
  var pr = el('bc-preview-result');
  if (!pr) return;
  var cinEl = el('bc-sel-cin');
  var coutEl = el('bc-sel-cout');
  var checkIn = cinEl ? cinEl.value : '';
  var checkOut = coutEl ? coutEl.value : '';
  if (!checkIn || !checkOut) {
    pr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Missing dates</div>Select a date range to preview.</div>';
    return;
  }
  var client = getBcClient();
  var gcEl = el('bk-guest-count');
  var guestCount = parseInt(gcEl ? gcEl.value : '1', 10) || 1;
  var pkgEl = el('bk-package');
  var depositEl = el('bk-deposit');
  var totalEl = el('bk-total');
  var psEl = el('bk-payment-status');
  var payload = {
    client_slug: client,
    check_in: checkIn,
    check_out: checkOut,
    selected_bed_codes: [bcSel.bed_code],
    guest_count: guestCount
  };
  if (pkgEl && pkgEl.value) payload.package_or_stay_type = pkgEl.value;
  if (depositEl && parseFloat(depositEl.value) > 0)
    payload.deposit_amount_cents = Math.round(parseFloat(depositEl.value) * 100);
  if (totalEl && parseFloat(totalEl.value) > 0)
    payload.total_amount_cents = Math.round(parseFloat(totalEl.value) * 100);
  if (psEl && psEl.value) payload.payment_status = psEl.value;
  /* Loading state */
  pr.innerHTML = '<div class="bk-preview-loading">Checking availability\u2026</div>';
  /* POST to read-only preview endpoint — preview_only=true, creates_booking=false */
  fetch('/staff/manual-bookings/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload)
  })
  .then(function(r) {
    if (r.status === 401 || r.status === 403) {
      pr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Could not run preview</div>Please refresh or log in again.</div>';
      return null;
    }
    return r.json().then(function(d) { return { ok: r.ok, status: r.status, data: d }; });
  })
  .then(function(res) {
    if (!res) return;
    var d = res.data;
    if (!res.ok || !d || !d.success) {
      pr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Preview error</div>' +
        escHtml((d && d.error) || 'Request failed. Please try again.') + '</div>';
      return;
    }
    var avail = d.availability || {};
    var isValid = avail.is_valid;
    var blockers = avail.blockers || [];
    var warnings = avail.warnings || [];
    var nights = avail.proposed_nights || 0;
    var bedCount = avail.selected_bed_count || 0;
    var conflictBeds = avail.conflict_beds || [];
    var conflictAssignments = avail.conflict_assignments || [];
    var html = '';
    if (isValid && blockers.length === 0) {
      html = '<div class="bk-preview-valid">' +
        '<div class="bk-preview-badge">\u2714 Available</div>' +
        '<div>' + nights + ' night' + (nights === 1 ? '' : 's') + ' \u00b7 ' +
        bedCount + ' bed' + (bedCount === 1 ? '' : 's') + ' selected</div>';
      if (avail.summary) html += '<div class="bk-preview-meta">' + escHtml(avail.summary) + '</div>';
      html += '</div>';
    } else {
      html = '<div class="bk-preview-blocked">' +
        '<div class="bk-preview-badge">\u26a0 Not available</div>';
      if (blockers.length > 0) {
        html += '<ul class="bk-preview-list">';
        blockers.forEach(function(b) {
          html += '<li>' + escHtml(b.code || String(b)) +
            (b.detail ? ': ' + escHtml(b.detail) : '') + '</li>';
        });
        html += '</ul>';
      }
      if (conflictBeds.length > 0) {
        html += '<div class="bk-preview-meta">Conflict beds: ' +
          conflictBeds.map(function(cb) { return escHtml(cb.bed_code || String(cb)); }).join(', ') +
          '</div>';
      }
      if (conflictAssignments.length > 0) {
        html += '<div class="bk-preview-meta">Conflicting: ' +
          conflictAssignments.map(function(ca) {
            return escHtml(ca.booking_code || ca.booking_id || '?');
          }).join(', ') + '</div>';
      }
      html += '</div>';
    }
    if (warnings.length > 0) {
      html += '<div class="bk-preview-warn">' +
        warnings.map(function(w) {
          return escHtml(w.code || String(w)) + (w.detail ? ': ' + escHtml(w.detail) : '');
        }).join('<br>') + '</div>';
    }
    pr.innerHTML = html;
  })
  .catch(function() {
    pr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Could not run preview</div>Please refresh or log in again.</div>';
  });
}

function bcHandleCellClick(td){
  var date = td && td.dataset && td.dataset.date;
  var room = td && td.dataset && td.dataset.room;
  var bed  = td && td.dataset && td.dataset.bed;
  if (!date || !room || !bed) return;
  /* Close booking detail panel if open (Stage 8.4.5) */
  var _detail = el('bc-detail');
  if (_detail && _detail.style.display !== 'none') _detail.style.display = 'none';
  /* Toggle deselect — clicking a highlighted empty cell removes it (Stage 8.7.8) */
  if (td.classList.contains('bc-sel')){
    var selCells = document.querySelectorAll('.bc-day-cell.bc-sel');
    if (selCells.length <= 1 || !bcSel){
      bcClearSelection();
      return;
    }
    var a = bcSel.anchor_date;
    var b = bcSel.cursor_date;
    var selStart = a <= b ? a : b;
    var selEnd   = a <= b ? b : a;
    if (date === selStart && date === selEnd){
      bcClearSelection();
      return;
    }
    if (date === selStart){
      bcSel.anchor_date = bcAddDaysISO(selStart, 1);
      if (bcSel.anchor_date > selEnd){ bcClearSelection(); return; }
    } else if (date === selEnd){
      bcSel.cursor_date = bcAddDaysISO(selEnd, -1);
      if (bcSel.cursor_date < selStart){ bcClearSelection(); return; }
    } else {
      bcSel.cursor_date = bcAddDaysISO(date, -1);
      if (bcSel.cursor_date < selStart){
        bcSel.anchor_date = bcAddDaysISO(date, 1);
        if (bcSel.anchor_date > selEnd){ bcClearSelection(); return; }
      }
    }
    bcApplySelectionHighlight();
    return;
  }
  /* Multi-bed selection (Stage 8.4.5) */
  if (!bcSel){
    /* Start new selection */
    bcSel = { anchor_date: date, cursor_date: date };
    bcSelectedBeds = [{ room_code: room, bed_code: bed }];
  } else {
    /* Check if this bed is already in the selection */
    var _exists = false;
    for (var _i = 0; _i < bcSelectedBeds.length; _i++){
      if (bcSelectedBeds[_i].room_code === room && bcSelectedBeds[_i].bed_code === bed){
        _exists = true; break;
      }
    }
    if (_exists){
      /* Same bed clicked again — extend/adjust the date range */
      bcSel.cursor_date = date;
    } else {
      /* New bed — add to selection sharing the existing date range */
      bcSelectedBeds.push({ room_code: room, bed_code: bed });
    }
  }
  bcApplySelectionHighlight();
}

/* ── Add-ons payload builder (Stage 8.4.7 / 8.7.15 qty &gt; 0) ─────────────── */
function aoQtyInput(id){
  return parseInt((el(id) || {}).value || '0', 10) || 0;
}

function buildAddOns(){
  var result = [];
  var wsComboDays = aoQtyInput('bk-ao-ws-combo-days');
  var wbComboDays = aoQtyInput('bk-ao-wb-combo-days');
  /* Combos first — they replace individual rentals */
  if (wsComboDays > 0) result.push({ code: 'wetsuit_soft_top_combo', days: wsComboDays });
  if (wbComboDays > 0) result.push({ code: 'wetsuit_hard_board_combo', days: wbComboDays });
  var wsActive = wsComboDays > 0;
  var wbActive = wbComboDays > 0;
  var wetDays  = aoQtyInput('bk-ao-wetsuit-days');
  var stDays   = aoQtyInput('bk-ao-softtop-days');
  var hbDays   = aoQtyInput('bk-ao-hardboard-days');
  if (wetDays > 0 && !wsActive && !wbActive) result.push({ code: 'wetsuit_rental', days: wetDays });
  if (stDays > 0 && !wsActive) result.push({ code: 'soft_top_rental', days: stDays });
  if (hbDays > 0 && !wbActive) result.push({ code: 'hard_board_rental', days: hbDays });
  /* Surf lessons — send as surf_lesson_single; calculator auto-selects single vs multi */
  var slQty = aoQtyInput('bk-ao-surf-lessons');
  if (slQty > 0) result.push({ code: 'surf_lesson_single', quantity: slQty });
  /* Yoga classes */
  var ygQty = aoQtyInput('bk-ao-yoga');
  if (ygQty > 0) result.push({ code: 'yoga_class', quantity: ygQty });
  /* Meals: visual-only in UI (Stage 8.7.11) — not in pricing.json add_ons yet; do not send to quote */
  return result;
}

/* ── Quote button state helper (Stage 8.4.5) ─────────────────────────────── */
function bcUpdateQuoteButton(){
  var btn = el('bc-sel-quote');
  if (!btn) return;
  var hasSelection = bcSel && bcSelectedBeds.length > 0;
  var cin  = el('bc-sel-cin')       ? el('bc-sel-cin').value       : '';
  var cout = el('bc-sel-cout')      ? el('bc-sel-cout').value      : '';
  var gc   = parseInt(el('bk-guest-count') ? el('bk-guest-count').value : '0', 10) || 0;
  var pkg  = el('bk-package')        ? el('bk-package').value        : '';
  var pc   = el('bk-payment-choice') ? el('bk-payment-choice').value : '';
  btn.disabled = !(hasSelection && cin && cout && gc >= 1 && pkg && pc);
}

/* ── Create button state helper (Stage 8.4.8) ────────────────────────────── */
function bcUpdateCreateButton(){
  var btn = el('bc-sel-create');
  if (!btn) return;
  var note = el('bc-create-note');
  /* Flags must both be true (server-interpolated at page render) */
  if (!BC_STAFF_ACTIONS || !BC_MANUAL_BOOKING){
    btn.disabled = true;
    btn.title    = 'Manual booking creation disabled. Set MANUAL_BOOKING_ENABLED=true and STAFF_ACTIONS_ENABLED=true.';
    if (note) note.textContent = 'Manual booking creation disabled in this environment.';
    return;
  }
  var hasSelection = bcSel && bcSelectedBeds.length > 0;
  var cin          = el('bc-sel-cin')        ? el('bc-sel-cin').value        : '';
  var cout         = el('bc-sel-cout')       ? el('bc-sel-cout').value       : '';
  var gc           = parseInt(el('bk-guest-count')   ? el('bk-guest-count').value   : '0', 10) || 0;
  var pkg          = el('bk-package')        ? el('bk-package').value        : '';
  var pc           = el('bk-payment-choice') ? el('bk-payment-choice').value : '';
  var gname        = el('bk-guest-name')     ? (el('bk-guest-name').value||'').trim() : '';
  var phone        = el('bk-phone')          ? (el('bk-phone').value||'').trim()      : '';
  var quoteOk      = !!bcLastQuote;
  var ready        = hasSelection && cin && cout && gc >= 1 && pkg && pc && gname && phone && quoteOk;
  btn.disabled = !ready;
  btn.title    = ready
    ? 'Create manual booking with calculated quote'
    : (!quoteOk ? 'Calculate Quote first' : 'Fill all required fields first');
  if (note){
    note.textContent = ready
      ? 'Booking creation enabled \u2014 flags active. No Stripe link will be created.'
      : (!quoteOk ? 'Click Calculate Quote first to enable booking creation.' : 'Complete all required fields.');
  }
}

/* ── Manual booking create (Stage 8.4.8 — posts to /staff/manual-bookings/create) */
function runManualBookingCreate(){
  var cr = el('bc-create-result');
  if (!cr) return;
  if (!BC_STAFF_ACTIONS || !BC_MANUAL_BOOKING){
    cr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Disabled</div>Manual booking creation is disabled in this environment.</div>';
    return;
  }
  if (!bcLastQuote){
    cr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">No quote</div>Calculate Quote first.</div>';
    return;
  }
  var checkIn      = el('bc-sel-cin')        ? el('bc-sel-cin').value        : '';
  var checkOut     = el('bc-sel-cout')       ? el('bc-sel-cout').value       : '';
  var client       = getBcClient();
  var gcEl         = el('bk-guest-count');
  var guestCount   = parseInt(gcEl ? gcEl.value : '1', 10) || 1;
  var packageCode  = el('bk-package')        ? el('bk-package').value        : '';
  var payChoice    = el('bk-payment-choice') ? el('bk-payment-choice').value : 'deposit';
  var roomType     = el('bk-room-type')      ? el('bk-room-type').value      : 'shared';
  var guestName    = el('bk-guest-name')     ? (el('bk-guest-name').value||'').trim()     : '';
  var phone        = el('bk-phone')          ? (el('bk-phone').value||'').trim()          : '';
  var email        = el('bk-email')          ? (el('bk-email').value||'').trim()||null    : null;
  var source       = el('bk-source')         ? (el('bk-source').value||'staff_manual')    : 'staff_manual';
  var notes        = el('bk-notes')          ? (el('bk-notes').value||'').trim()||null    : null;
  var payload = {
    client_slug:        client,
    check_in:           checkIn,
    check_out:          checkOut,
    selected_bed_codes: bcSelectedBeds.map(function(b){ return b.bed_code; }),
    guest_count:        guestCount,
    guest_name:         guestName,
    phone:              phone,
    email:              email,
    package_code:       packageCode,
    room_type:          roomType,
    payment_choice:     payChoice,
    add_ons:            buildAddOns(),
    booking_source:     source,
    notes:              notes,
    confirm:            true,
  };
  cr.innerHTML = '<div class="bk-preview-loading">Creating booking\u2026</div>';
  var createBtn = el('bc-sel-create');
  if (createBtn) createBtn.disabled = true;
  fetch('/staff/manual-bookings/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload)
  })
  .then(function(r){
    return r.json().then(function(d){ return { ok: r.ok, status: r.status, data: d }; });
  })
  .then(function(res){
    /* Stage 8.4.10: capture payment_id before rendering */
    if (res.ok && res.data && res.data.success && res.data.payment_id) {
      bcLastPaymentId = res.data.payment_id;
    } else {
      bcLastPaymentId = null;
    }
    cr.innerHTML = renderCreateResult(res);
    /* Wire the Stripe link button if rendered */
    var slBtn = document.getElementById('bc-sel-stripe-link');
    if (slBtn && !slBtn.disabled) {
      slBtn.addEventListener('click', runCreateStripeLink);
    }
    if (res.ok && res.data && res.data.success) {
      /* Reload calendar to show new booking */
      loadBedCalendar();
    } else {
      /* Re-enable create button on failure */
      bcUpdateCreateButton();
    }
  })
  .catch(function(e){
    cr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Network error</div>' + escHtml(String(e)) + '</div>';
    bcUpdateCreateButton();
  });
}

function renderCreateResult(res){
  var d = res.data || {};
  var fmtEur = function(c){ return c == null ? '\u2014' : '\u20ac'+(Number(c)/100).toFixed(2); };
  if (!res.ok || !d.success){
    var msg = d.error || ('HTTP ' + res.status);
    return '<div class="bk-preview-blocked"><div class="bk-preview-badge">\u26a0 Create failed</div>' +
      '<div class="bk-preview-meta">' + escHtml(msg) + '</div>' +
      (d.block_reason ? '<div class="bk-preview-meta">Reason: ' + escHtml(d.block_reason) + '</div>' : '') +
      '</div>';
  }
  var qs = d.quote_summary || {};
  var html = '<div class="bk-quote-banner" style="background:var(--green-bg,#d4edda);border-color:var(--green-border,#c3e6cb);color:var(--green-text,#155724)">' +
    '\u2705 Booking created: <strong>' + escHtml(d.booking_code || '\u2014') + '</strong></div>';
  html += '<div class="bk-quote-items">';
  html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Booking code</span><span class="bk-quote-item-amount">' + escHtml(d.booking_code||'\u2014') + '</span></div>';
  html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Beds assigned</span><span class="bk-quote-item-amount">' + escHtml(String(d.beds_inserted||0)) + '</span></div>';
  if (d.payment_id)
    html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Payment ID</span><span class="bk-quote-item-amount" style="font-size:10px;font-family:monospace">' + escHtml(d.payment_id) + '</span></div>';
  html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Payment status</span><span class="bk-quote-item-amount"><span class="pill pill-blue" style="font-size:10px">draft</span></span></div>';
  if (qs.total_cents != null)
    html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Total</span><span class="bk-quote-item-amount">' + fmtEur(qs.total_cents) + '</span></div>';
  if (qs.payment_link_amount_cents != null)
    html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Payment amount (' + escHtml(qs.payment_kind||'') + ')</span><span class="bk-quote-item-amount">' + fmtEur(qs.payment_link_amount_cents) + '</span></div>';
  html += '</div>';
  if (qs.formula_summary)
    html += '<div class="bk-quote-formula">' + escHtml(qs.formula_summary) + '</div>';
  /* Stage 8.4.10: Stripe link button area */
  var canCreateLink = BC_STRIPE_LINKS && BC_STAFF_ACTIONS && !!d.payment_id;
  html += '<div style="margin-top:12px">';
  if (canCreateLink){
    html += '<button class="btn btn-primary" id="bc-sel-stripe-link" style="margin-right:8px">' +
      '&#128279; Create Stripe Payment Link</button>';
  } else {
    html += '<button class="btn btn-primary" id="bc-sel-stripe-link" disabled title="' +
      (!BC_STRIPE_LINKS ? 'Set STRIPE_LINKS_ENABLED=true to enable' : (!BC_STAFF_ACTIONS ? 'Set STAFF_ACTIONS_ENABLED=true to enable' : 'No payment ID available')) +
      '" style="opacity:.45;cursor:not-allowed">&#128279; Create Stripe Payment Link</button>';
    html += '<div style="font-size:11px;color:var(--text-3);margin-top:4px">' +
      (BC_STRIPE_LINKS ? '' : 'Set STRIPE_LINKS_ENABLED=true to enable.') + '</div>';
  }
  html += '<div id="bc-stripe-link-result" style="margin-top:8px"></div>';
  html += '</div>';
  return html;
}

/* ── Stripe payment link creation (Stage 8.4.10) ─────────────────────────── */
/* Calls POST /staff/payments/:payment_id/create-stripe-link (Stage 8.4.9 backend). */
/* Does NOT call Stripe directly. Browser calls Staff API only.                     */
/* Does NOT send via WhatsApp, email, or n8n.                                       */
function runCreateStripeLink(){
  var slEl = el('bc-stripe-link-result');
  if (!slEl) return;
  if (!BC_STRIPE_LINKS || !BC_STAFF_ACTIONS){
    slEl.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Disabled</div>Set STRIPE_LINKS_ENABLED=true and STAFF_ACTIONS_ENABLED=true to enable Stripe link creation.</div>';
    return;
  }
  var pmId = bcLastPaymentId;
  if (!pmId){
    slEl.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">No payment</div>Create a booking first to generate a payment record.</div>';
    return;
  }
  var btn = el('bc-sel-stripe-link');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating link\u2026'; }
  slEl.innerHTML = '<div class="bk-preview-loading">Creating Stripe Checkout Session\u2026</div>';
  fetch('/staff/payments/' + encodeURIComponent(pmId) + '/create-stripe-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  })
  .then(function(r){
    return r.json().then(function(d){ return { ok: r.ok, status: r.status, data: d }; });
  })
  .then(function(res){
    slEl.innerHTML = renderStripeLinkResult(res);
    /* Wire copy button after rendering */
    var cpBtn = document.getElementById('bc-copy-payment-link');
    if (cpBtn){
      cpBtn.addEventListener('click', function(){
        var url = this.dataset.url;
        if (!url) return;
        if (navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(url).then(function(){
            cpBtn.textContent = '\u2713 Copied!';
            setTimeout(function(){ cpBtn.textContent = '\uD83D\uDCCB Copy Payment Link'; }, 2000);
          }).catch(function(){
            prompt('Copy this Stripe payment link:', url);
          });
        } else {
          prompt('Copy this Stripe payment link:', url);
        }
      });
    }
    /* Re-enable create-link button (stays visible for idempotent re-use) */
    if (btn){
      btn.disabled = false;
      btn.textContent = '\uD83D\uDD17 Create Stripe Payment Link';
    }
  })
  .catch(function(e){
    slEl.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Network error</div>' + escHtml(String(e)) + '</div>';
    if (btn){ btn.disabled = false; btn.textContent = '\uD83D\uDD17 Create Stripe Payment Link'; }
  });
}

function renderStripeLinkResult(res){
  var d = res.data || {};
  if (!res.ok || !d.success){
    var msg = (d.error || 'HTTP ' + res.status);
    return '<div class="bk-preview-blocked"><div class="bk-preview-badge">\u26a0 Stripe link failed</div>' +
      '<div class="bk-preview-meta">' + escHtml(msg) + '</div>' +
      '</div>';
  }
  var url = d.checkout_url || '';
  var sessionId = d.stripe_checkout_session_id || '';
  var html = '<div class="bk-quote-banner" style="background:var(--green-bg,#d4edda);border-color:var(--green-border,#c3e6cb);color:var(--green-text,#155724)">' +
    '\u2705 Stripe test link created' + (d.idempotent ? ' (existing session)' : '') + '</div>';
  html += '<div class="bk-quote-items">';
  html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Status</span>' +
    '<span class="bk-quote-item-amount"><span class="pill pill-blue" style="font-size:10px">' + escHtml(d.status || 'checkout_created') + '</span></span></div>';
  if (sessionId)
    html += '<div class="bk-quote-item"><span class="bk-quote-item-label">Session ID</span>' +
      '<span class="bk-quote-item-amount" style="font-size:10px;font-family:monospace">' + escHtml(sessionId.slice(0,24)) + '\u2026</span></div>';
  html += '</div>';
  if (url){
    html += '<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
    html += '<a href="' + escHtml(url) + '" target="_blank" rel="noopener" ' +
      'style="font-size:12px;word-break:break-all;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block">' +
      escHtml(url.slice(0,60)) + '\u2026</a>';
    html += '<button class="btn" id="bc-copy-payment-link" data-url="' + escHtml(url) + '" ' +
      'style="font-size:12px;padding:4px 10px">\uD83D\uDCCB Copy Payment Link</button>';
    html += '</div>';
  }
  html += '<div class="bk-preview-warn" style="margin-top:8px">' +
    '&#128274; Stripe test link created \u2014 payment is NOT marked paid until webhook confirms.' +
    (d.no_whatsapp ? ' No WhatsApp.' : '') + ' No email sent.</div>';
  return html;
}

/* ── Quote preview (Stage 8.4.5 — posts to /staff/quote-preview, no writes) ─ */
function runQuotePreview(){
  var qr = el('bc-quote-result');
  if (!qr) return;
  var checkIn  = el('bc-sel-cin')  ? el('bc-sel-cin').value  : '';
  var checkOut = el('bc-sel-cout') ? el('bc-sel-cout').value : '';
  if (!checkIn || !checkOut || bcSelectedBeds.length === 0){
    qr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Missing input</div>Select beds and a date range first.</div>';
    return;
  }
  var client = getBcClient();
  var gcEl = el('bk-guest-count');
  var guestCount = parseInt(gcEl ? gcEl.value : '1', 10) || 1;
  var pkgEl = el('bk-package');
  var packageCode = pkgEl ? pkgEl.value : '';
  var pcEl = el('bk-payment-choice');
  var paymentChoice = (pcEl && pcEl.value) ? pcEl.value : 'deposit';
  var payload = {
    client_slug: client,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    room_type: (el('bk-room-type') ? el('bk-room-type').value : 'shared') || 'shared',
    payment_choice: paymentChoice,
    add_ons: []
  };
  /* add_ons overwritten below by buildAddOns() */
  if (packageCode) payload.package_code = packageCode;
  payload.selected_bed_codes = bcSelectedBeds.map(function(b){ return b.bed_code; });
  payload.add_ons = buildAddOns();
  qr.innerHTML = '<div class="bk-preview-loading">Calculating quote\u2026</div>';
  fetch('/staff/quote-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload)
  })
  .then(function(r){
    if (r.status === 401 || r.status === 403){
      qr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Auth error</div>Please refresh or log in again.</div>';
      return null;
    }
    return r.json().then(function(d){ return { ok: r.ok, status: r.status, data: d }; });
  })
  .then(function(res){
    if (!res) return;
    qr.innerHTML = renderQuoteResult(res.data);
    /* Stage 8.4.8: track successful quote and update create button */
    var q = res.data && res.data.quote;
    bcLastQuote = (q && q.success) ? q : null;
    bcUpdateCreateButton();
  })
  .catch(function(){
    qr.innerHTML = '<div class="bk-preview-error"><div class="bk-preview-badge">Network error</div>Please try again.</div>';
    bcLastQuote = null;
    bcUpdateCreateButton();
  });
}

function renderQuoteResult(resp){
  if (!resp){ return '<div class="bk-preview-error"><div class="bk-preview-badge">No response</div>Quote request failed.</div>'; }
  var q = resp.quote || {};
  var fmtEur = function(cents){
    if (cents == null || isNaN(Number(cents))) return '\u2014';
    return '\u20ac' + (Number(cents)/100).toFixed(2);
  };
  var html = '<div class="bk-quote-banner">Quote preview only \u2014 no booking created. No Stripe link created.</div>';
  if (!q.success){
    html += '<div class="bk-preview-blocked"><div class="bk-preview-badge">\u26a0 Quote not available</div>';
    (q.blockers||[]).forEach(function(b){ html += '<div class="bk-preview-meta">' + escHtml(String(b)) + '</div>'; });
    html += '</div>';
    if (q.missing_config) html += '<div class="bk-preview-warn">Missing config \u2014 staff review required.</div>';
    else if (q.staff_review_required) html += '<div class="bk-preview-warn">Staff review required before booking.</div>';
    return html;
  }
  html += '<div class="bk-quote-items">';
  (q.line_items||[]).forEach(function(li){
    html += '<div class="bk-quote-item"><span class="bk-quote-item-label">' + escHtml(li.label||li.code||'') + '</span>' +
      '<span class="bk-quote-item-amount">' + escHtml(fmtEur(li.total_cents)) + '</span></div>';
    if (li.note) html += '<div class="bk-quote-item-note">' + escHtml(li.note) + '</div>';
  });
  html += '<hr class="bk-quote-divider">';
  html += '<div class="bk-quote-item bk-quote-subtotal"><span>Subtotal</span><span>' + escHtml(fmtEur(q.subtotal_cents)) + '</span></div>';
  if (q.discount_cents > 0) html += '<div class="bk-quote-item"><span>Discount</span><span>\u2212' + escHtml(fmtEur(q.discount_cents)) + '</span></div>';
  html += '<div class="bk-quote-item bk-quote-total"><span><b>Total</b></span><span><b>' + escHtml(fmtEur(q.total_cents)) + '</b></span></div>';
  html += '<div class="bk-quote-item"><span>Deposit required</span><span>' + escHtml(fmtEur(q.deposit_required_cents)) + '</span></div>';
  html += '<div class="bk-quote-item"><span>Payment link amount</span><span>' + escHtml(fmtEur(q.payment_link_amount_cents)) + '</span></div>';
  html += '<div class="bk-quote-item"><span>Balance due</span><span>' + escHtml(fmtEur(q.balance_due_cents)) + '</span></div>';
  html += '</div>';
  if (q.formula_summary) html += '<div class="bk-quote-formula">' + escHtml(q.formula_summary) + '</div>';
  if (q.warnings && q.warnings.length > 0){
    html += '<div class="bk-preview-warn">';
    q.warnings.forEach(function(w){ html += '<div>' + escHtml(String(w)) + '</div>'; });
    html += '</div>';
  }
  if (q.staff_review_required) html += '<div class="bk-preview-warn">\u26a0 Staff review required before creating this booking.</div>';
  return html;
}

function bcColorClass(ct){
  var c = (ct||'hold').toLowerCase();
  var valid = ['confirmed','hold','payment_pending','needs_review','cancelled','conflict','operator','manual'];
  return 'bc-block-' + (valid.indexOf(c) >= 0 ? c : 'hold');
}

function renderBedCalendar(data){
  bcData = data;
  var days   = data.days   || [];
  var rooms  = data.rooms  || [];
  var blocks = data.blocks || [];

  /* Natural numeric room sort: R1, R2, R3 … R10 (not R1, R10, R2) */
  rooms = rooms.slice().sort(function(a, b){
    var ao = a.sort_order != null ? a.sort_order : 999;
    var bo = b.sort_order != null ? b.sort_order : 999;
    if (ao !== bo) return ao - bo;
    return (a.room_name || a.room_code || '').localeCompare(b.room_name || b.room_code || '', undefined, { numeric: true, sensitivity: 'base' });
  });

  /* Summary strip */
  var totalBeds = 0;
  rooms.forEach(function(r){ totalBeds += (r.beds ? r.beds.length : 0); });
  /* Count beds that have at least one block in this range */
  var bedsWithBlocks = {};
  blocks.forEach(function(blk){ bedsWithBlocks[blk.room_code + '|' + blk.bed_code] = true; });
  var occupiedBeds = Object.keys(bedsWithBlocks).length;
  var freeBeds = totalBeds - occupiedBeds;
  el('bc-rooms-count').textContent  = rooms.length  + ' room'  + (rooms.length  === 1 ? '' : 's');
  el('bc-beds-count').textContent   = totalBeds      + ' bed'   + (totalBeds      === 1 ? '' : 's');
  el('bc-blocks-count').textContent = blocks.length  + ' booking block' + (blocks.length === 1 ? '' : 's');
  var freeEl = el('bc-free-count');
  if (freeEl) freeEl.textContent = freeBeds > 0 ? freeBeds + ' free' : (totalBeds > 0 ? 'fully booked' : '');
  el('bc-summary').style.display = 'flex';

  /* Warnings */
  if (data.warnings && data.warnings.length > 0){
    el('bc-warnings').innerHTML = data.warnings.map(function(w){ return escHtml(w); }).join('<br>');
    el('bc-warnings').style.display = 'block';
  } else {
    el('bc-warnings').style.display = 'none';
  }

  /* Block lookup keyed by room_code + bed_code */
  var blocksByBed = {};
  blocks.forEach(function(blk, idx){
    var key = (blk.room_code||'') + '|' + (blk.bed_code||'');
    if (!blocksByBed[key]) blocksByBed[key] = [];
    blocksByBed[key].push({ blk: blk, idx: idx });
  });

  var N = days.length;
  var html = '<table class="bc-grid">';

  /* Date header row */
  html += '<thead><tr>';
  html += '<th class="bc-bed-head">Room / Bed</th>';
  days.forEach(function(day){
    html += '<th style="min-width:44px">' + escHtml(day.label) + '</th>';
  });
  html += '</tr></thead>';

  html += '<tbody>';
  var totalCols = N + 1;

  rooms.forEach(function(room){
    /* Room header spanning all columns */
    var roomLabel = escHtml(room.room_code);
    if (room.room_name && room.room_name !== room.room_code) roomLabel += ' &mdash; ' + escHtml(room.room_name);
    var roomMeta = [];
    if (room.room_type) roomMeta.push(escHtml(room.room_type));
    if (room.capacity)  roomMeta.push(room.capacity + ' beds');
    html += '<tr><td colspan="' + totalCols + '" class="bc-room-hdr">' + roomLabel +
      (roomMeta.length ? ' <span style="font-weight:400;opacity:.65;font-size:10px;margin-left:6px">' + roomMeta.join(' &middot; ') + '</span>' : '') +
      '</td></tr>';

    var beds = room.beds || [];
    if (beds.length === 0){
      html += '<tr><td class="bc-bed-cell" style="color:#9aabb8;font-style:italic">no beds</td>';
      for (var e = 0; e < N; e++) html += '<td class="bc-day-cell"></td>';
      html += '</tr>';
    }

    beds.forEach(function(bed){
      var key = room.room_code + '|' + bed.bed_code;
      var bedBlocks = (blocksByBed[key] || []).slice().sort(function(a, b){
        return a.blk.start_offset - b.blk.start_offset;
      });

      html += '<tr>';
      /* Prefer bed_code as the primary label; show bed_label as subtitle only if different */
      var bedLabelHtml = escHtml(bed.bed_code);
      if (bed.bed_label && bed.bed_label !== bed.bed_code) {
        bedLabelHtml += '<span style="font-weight:400;font-size:10px;color:var(--text-3);display:block;line-height:1.2">' + escHtml(bed.bed_label) + '</span>';
      }
      html += '<td class="bc-bed-cell">' + bedLabelHtml + '</td>';

      /* Selectable empty cells carry data-date/room/bed for Stage 8.3c selection model */
      var _rc = room.room_code;
      var _bc = bed.bed_code;
      var pos = 0;
      bedBlocks.forEach(function(entry){
        var blk = entry.blk;
        var gap = blk.start_offset - pos;
        for (var g = 0; g < gap; g++){
          var _di = (days[pos + g] || {}).date || '';
          html += '<td class="bc-day-cell" data-date="' + _di + '" data-room="' + escHtml(_rc) + '" data-bed="' + escHtml(_bc) + '"></td>';
        }
        html += renderBookingBlock(blk, entry.idx);
        pos = blk.start_offset + blk.span_days;
      });
      for (var r = pos; r < N; r++){
        var _di2 = (days[r] || {}).date || '';
        html += '<td class="bc-day-cell" data-date="' + _di2 + '" data-room="' + escHtml(_rc) + '" data-bed="' + escHtml(_bc) + '"></td>';
      }
      html += '</tr>';
    });
  });

  html += '</tbody></table>';

  var wrap = el('bc-grid-wrap');
  wrap.innerHTML = html;
  wrap.style.display = 'block';
  el('bc-state').style.display = 'none';

  /* Wire block clicks */
  wrap.querySelectorAll('.bc-block').forEach(function(bEl){
    bEl.addEventListener('click', function(){
      var idx = parseInt(this.dataset.bidx, 10);
      showBlockDetail(blocks[idx]);
    });
  });

  /* Wire empty-cell clicks for selection model (Stage 8.3c, read-only) */
  wrap.querySelectorAll('.bc-day-cell[data-date]').forEach(function(td){
    td.addEventListener('click', function(){ bcHandleCellClick(this); });
  });

  /* Wire selection panel clear button (re-wired each render) */
  var _clearBtn = el('bc-sel-clear');
  if (_clearBtn) _clearBtn.onclick = bcClearSelection;
  /* Wire Preview Conflicts button (Stage 8.3l — re-wired each render) */
  var _conflBtn = el('bc-sel-conflicts');
  if (_conflBtn) _conflBtn.onclick = runPreviewConflicts;
  /* Wire Calculate Quote button (Stage 8.4.5 — re-wired each render) */
  var _quoteBtn = el('bc-sel-quote');
  if (_quoteBtn) _quoteBtn.onclick = runQuotePreview;
  /* Wire Create Manual Booking button (Stage 8.4.8 — gated by flags + quote) */
  var _createBtn = el('bc-sel-create');
  if (_createBtn) _createBtn.onclick = runManualBookingCreate;
  /* Wire form field listeners for quote + create button enable/disable */
  ['bk-package','bk-payment-choice','bk-guest-count','bk-guest-name','bk-phone'].forEach(function(fId){
    var fEl = el(fId); if (fEl) fEl.onchange = function(){ bcUpdateQuoteButton(); bcUpdateCreateButton(); };
  });
  /* Update create button state and safety notice on each calendar load */
  bcUpdateCreateButton();
  var _notice = el('bc-safety-notice');
  if (_notice){
    if (BC_STAFF_ACTIONS && BC_MANUAL_BOOKING){
      _notice.innerHTML = '&#128994; Booking creation enabled \u2014 MANUAL_BOOKING_ENABLED=true, STAFF_ACTIONS_ENABLED=true.<br>Calculate Quote, then Create Manual Booking. No Stripe link will be sent.';
      _notice.style.background = 'var(--green-bg, #d4edda)';
      _notice.style.borderColor = 'var(--green-border, #c3e6cb)';
      _notice.style.color = 'var(--green-text, #155724)';
    }
  }
  if (typeof toRefreshRoomSelects === 'function') toRefreshRoomSelects();
}

function renderBookingBlock(blk, idx){
  var colorCls = bcColorClass(blk.color_type);
  /* No inline A/D markers — arrival/departure shown in tooltip (Stage 8.3a) */
  var arrDep = [];
  if (blk.is_arrival)   arrDep.push('Arrives ' + (blk.start_date||''));
  if (blk.is_departure) arrDep.push('Departs ' + (blk.end_date||''));
  var statusHint = blk.color_type ? ' [' + blk.color_type.replace(/_/g,' ') + ']' : '';
  var tip = escHtml(
    (blk.booking_code||'\u2014') + ' \u2013 ' + (blk.guest_name||'') +
    ' | ' + (blk.start_date||'') + ' \u2192 ' + (blk.end_date||'') + statusHint +
    (arrDep.length ? ' | ' + arrDep.join(' \u00b7 ') : '')
  );
  /* Show booking_code prefix + guest name if span wide enough; code-only for narrow blocks */
  var codeShort = (blk.booking_code||'').replace(/^(DEMO-|WH-|OP-)/, '');
  var label = blk.span_days >= 3
    ? escHtml((blk.guest_name || blk.booking_code || '\u2014'))
    : escHtml(codeShort || blk.guest_name || '\u2014');
  return '<td colspan="' + blk.span_days + '" class="bc-day-cell" style="padding:2px 3px">' +
    '<div class="bc-block ' + colorCls + '" data-bidx="' + idx + '" title="' + tip + '">' +
    label + '</div></td>';
}

function kvBC(k, v){
  return '<div class="kv"><span class="k">' + escHtml(k) + '</span>' +
         '<span class="v">' + escHtml(String(v == null ? '\u2014' : v)) + '</span></div>';
}

function bcHeaderNights(start, end){
  if (!start || !end) return null;
  try {
    var n = Math.round((new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 86400000);
    return n > 0 ? n : null;
  } catch(_){ return null; }
}
function bcDrawerStatusPillCls(s){
  var v = (s||'').toLowerCase().replace(/ /g,'_');
  if (v === 'confirmed' || v === 'paid' || v === 'deposit_paid') return 'pill-green';
  if (v === 'cancelled') return 'pill-grey';
  if (v === 'needs_review' || v === 'needs_human') return 'pill-orange';
  return 'pill-blue';
}
function bcDetailHeaderMetaHtml(blk, bk){
  bk = bk || {};
  blk = blk || {};
  var html = '';
  var bkPay = bk.payment_status || null;
  if (bkPay === 'deposit_paid' || bkPay === 'paid'){
    html += '<span class="pill pill-green">' + escHtml(bkPay === 'deposit_paid' ? 'Deposit paid \u2713' : 'Paid in full \u2713') + '</span>';
  } else if (bk.status){
    html += '<span class="pill ' + bcDrawerStatusPillCls(bk.status) + '">' + escHtml(String(bk.status).replace(/_/g,' ')) + '</span>';
  } else if (blk.color_type){
    var pillMap = {confirmed:'pill-green',hold:'pill-blue',payment_pending:'pill-orange',needs_review:'pill-orange',cancelled:'pill-grey',operator:'pill-blue',manual:'pill-blue'};
    html += '<span class="pill ' + (pillMap[(blk.color_type||'').toLowerCase()] || 'pill-blue') + '">' + escHtml(String(blk.color_type).replace(/_/g,' ')) + '</span>';
  }
  var nights = bcHeaderNights(bk.check_in, bk.check_out) || bcHeaderNights(blk.start_date, blk.end_date);
  if (nights) html += '<span class="ctx-nights-badge">' + nights + (nights === 1 ? ' night' : ' nights') + '</span>';
  if (bk.needs_rooming_review) html += '<span class="pill pill-orange">Rooming review</span>';
  return html;
}
function updateBcDetailHeader(data){
  var meta = el('bc-detail-meta');
  if (!meta) return;
  meta.innerHTML = bcDetailHeaderMetaHtml(bcLastOpenedBlock, (data && data.booking) || {});
}

function showBlockDetail(blk){
  if (!blk) return;
  bcClearSelection();
  bcLastOpenedBlock = blk;
  el('bc-detail').innerHTML =
    '<div class="toolbar"><h2 class="bc-detail-title">' + escHtml(blk.booking_code||'\u2014') +
    '<span class="bc-detail-meta" id="bc-detail-meta">' + bcDetailHeaderMetaHtml(blk, null) + '</span></h2>' +
    '<button class="btn btn-ghost" id="bc-close-detail">&times; Close</button></div>' +
    '<div id="bc-ctx-body"><div class="ctx-loading">Loading booking details\u2026</div></div>' +
    '<div class="bc-detail-note">&#128274; Bed calendar is read-only \u2014 booking edits disabled until write gates approved.</div>';
  el('bc-detail').style.display = 'block';
  el('bc-close-detail').addEventListener('click', function(){ el('bc-detail').style.display = 'none'; });
  if (blk.booking_code) loadBlockDetail(blk.booking_code);
}

/* Load enriched booking context from API */
function loadBlockDetail(bookingCode){
  var client = getBcClient();
  var url = '/staff/bookings/' + encodeURIComponent(bookingCode) + '/context?client=' + encodeURIComponent(client);
  fetch(url)
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
    .then(function(res){
      var ctxEl = el('bc-ctx-body');
      if (!ctxEl) return;
      if (!res.ok || !res.data.success){
        ctxEl.innerHTML = '<div class="state-msg error">Context load failed: ' + escHtml((res.data && res.data.error) || 'error') + '</div>';
        return;
      }
      ctxEl.innerHTML = renderBookingContextDrawer(res.data);
      updateBcDetailHeader(res.data);
      /* Wire "Open conversation" button */
      var btnConv = document.getElementById('bc-open-conv-btn');
      if (btnConv){
        btnConv.addEventListener('click', function(){
          var convId = this.dataset.convid;
          if (!convId) return;
          /* Switch to Inbox tab and open that conversation */
          switchToTab('conversations', 'inbox');
          /* Load conversation detail */
          loadConvDetail(convId);
        });
      }
    })
    .catch(function(e){
      var ctxEl = el('bc-ctx-body');
      if (ctxEl) ctxEl.innerHTML = '<div class="state-msg error">Network error: ' + escHtml(e.message) + '</div>';
    });
}

/* Render the enriched booking context drawer sections (Stage 8.3b) */
function renderBookingContextDrawer(data){
  var html = '';
  var bk = data.booking || {};

  /* ── Local helpers ─────────────────────────────────────────────────────── */
  var eur = function(cents){
    if (cents == null || isNaN(Number(cents))) return '\u2014';
    return '\u20ac' + (Number(cents) / 100).toFixed(2);
  };
  var statusPillCls = function(s){
    var v = (s||'').toLowerCase().replace(/ /g,'_');
    if (v === 'confirmed' || v === 'paid') return 'pill-green';
    if (v === 'cancelled') return 'pill-grey';
    if (v === 'needs_review' || v === 'needs_human') return 'pill-orange';
    return 'pill-blue';
  };

  /* ── Guest (no section label — Stage 8.7.6) ─────────────────────────────── */
  html += '<div class="ctx-section">';
  html += '<div class="kv-grid">';
  html += kvBC('Name',  bk.guest_name);
  html += kvBC('Phone', bk.phone);
  html += kvBC('Email', bk.email);
  if (bk.language)       html += kvBC('Language', bk.language);
  if (bk.booking_source && bk.booking_source !== 'manual_staff') html += kvBC('Source', bk.booking_source);
  html += '</div></div>';

  /* ── Stay details (no section label; status/nights in drawer header — 8.7.6) */
  html += '<div class="ctx-section">';
  html += '<div class="kv-grid">';
  html += kvBC('Check-in',  bk.check_in);
  html += kvBC('Check-out', bk.check_out);
  /* Room/Beds — summary only; no per-bed duplicate rows */
  var rm = data.rooming || {};
  if ((rm.assigned_room_codes||[]).length) html += kvBC('Room', (rm.assigned_room_codes||[]).join(', '));
  else if (bk.room_code)                  html += kvBC('Room', bk.room_code);
  if (rm.assignments && rm.assignments.length > 0){
    var bedList = rm.assignments.map(function(a){ return a.bed_code; }).filter(Boolean);
    if (bedList.length) html += kvBC('Beds', bedList.join(', '));
  } else {
    if ((rm.assigned_bed_codes||[]).length) html += kvBC('Beds', (rm.assigned_bed_codes||[]).join(', '));
    else if (bk.bed_code)                   html += kvBC('Bed',  bk.bed_code);
  }
  if (bk.assignment_status)              html += kvBC('Assignment', bk.assignment_status);
  if (bk.guest_count)  html += kvBC('Guests', bk.guest_count);
  if (bk.package_code) html += kvBC('Package', bk.package_code);
  var roomPref = bk.requested_room_type || bk.room_preference;
  if (roomPref) html += kvBC('Room pref', roomPref);
  html += '</div></div>';

  /* ── 4. Payment ────────────────────────────────────────────────────────── */
  /* Stage 8.4.12: full payment truth panel — shows webhook result, paid_at,
     checkout URL, session/intent IDs, deposit vs. full-paid labels.
     Read-only. No writes, no Stripe calls, no WhatsApp/email/n8n. */
  var pmt = data.payments || {};

  /* Helper: human-readable label for payment_record_status enum */
  var pmtStatusLabel = function(s){
    var m = {
      draft:             'Draft payment',
      checkout_created:  'Checkout link created',
      pending:           'Pending',
      paid:              'Paid \u2713',
      expired:           'Expired',
      cancelled:         'Cancelled',
      failed:            'Failed',
    };
    return m[s] || (s ? s.replace(/_/g,' ') : '\u2014');
  };
  /* Helper: human-readable label for booking payment_status enum */
  var bkPayLabel = function(s){
    var m = {
      not_requested:    'Not requested',
      waiting_payment:  'Waiting for payment',
      payment_link_sent:'Payment link sent',
      deposit_paid:     'Deposit paid \u2713',
      paid:             'Paid in full \u2713',
      refunded:         'Refunded',
      failed:           'Failed',
      expired:          'Expired',
    };
    return m[s] || (s ? s.replace(/_/g,' ') : '\u2014');
  };
  /* Helper: short ID display (first 12 chars + …) */
  var shortId = function(v){ return v ? (v.length > 14 ? v.slice(0, 14) + '\u2026' : v) : null; };
  /* Helper: format ISO date-time to local readable */
  var fmtDate = function(v){
    if (!v) return null;
    try {
      var d = new Date(v);
      return d.toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' });
    } catch(_){ return String(v).slice(0, 19); }
  };

  html += '<div class="ctx-section"><h3>Payment</h3>';
  html += '<div class="ctx-pay-box">';

  /* ── 4a. Booking-level payment status — header shows primary pill (8.7.6) ─ */
  var bkPayStatus = bk.payment_status || pmt.latest_status || null;
  var isDepositPaid = bkPayStatus === 'deposit_paid';
  var isFullyPaid   = bkPayStatus === 'paid';

  if (!isDepositPaid && !isFullyPaid && bkPayStatus) {
    html += '<div class="ctx-status-row"><span class="pill ' + statusPillCls(bkPayStatus) + '">' + escHtml(bkPayLabel(bkPayStatus)) + '</span></div>';
  }

  /* ── 4b. Booking totals ───────────────────────────────────────────────── */
  var hasBookingAmts = bk.total_amount_cents != null || bk.amount_paid_cents != null || bk.balance_due_cents != null;
  if (hasBookingAmts){
    html += '<div class="ctx-pay-block">';
    if (bk.total_amount_cents    != null) html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Total</span><span class="ctx-pay-amount">' + escHtml(eur(bk.total_amount_cents)) + '</span></div>';
    if (bk.deposit_required_cents != null && bk.deposit_required_cents > 0)
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Deposit required</span><span class="ctx-pay-amount">' + escHtml(eur(bk.deposit_required_cents)) + '</span></div>';
    if (bk.amount_paid_cents     != null) html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Booking paid</span><span class="ctx-pay-amount paid">' + escHtml(eur(bk.amount_paid_cents)) + '</span></div>';
    if (bk.balance_due_cents     != null){
      var balCls = Number(bk.balance_due_cents) > 0 ? ' owing' : ' paid';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Balance due</span><span class="ctx-pay-amount' + balCls + '">' + escHtml(eur(bk.balance_due_cents)) + '</span></div>';
    }
    html += '</div>';
  }

  /* ── 4c. Payment record row(s) ───────────────────────────────────────── */
  if (!pmt.rows || pmt.rows.length === 0){
    html += '<div class="ctx-none" style="margin-top:6px">No payment record yet.</div>';
  } else {
    pmt.rows.forEach(function(pr){
      var isPaid    = pr.payment_status === 'paid';
      var isCreated = pr.payment_status === 'checkout_created';
      var recCls = 'ctx-pay-record';
      if (isPaid) recCls += ' ctx-pay-record-paid';
      else if (isCreated) recCls += ' ctx-pay-record-checkout';

      html += '<div class="' + recCls + '">';

      /* Status badge row */
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">';
      var badgeCls = isPaid ? 'ctx-pay-record-badge ctx-pay-record-badge-paid' :
                     isCreated ? 'ctx-pay-record-badge ctx-pay-record-badge-checkout' :
                     'ctx-pay-record-badge ctx-pay-record-badge-default';
      html += '<span class="' + badgeCls + '">' + escHtml(pmtStatusLabel(pr.payment_status)) + '</span>';
      if (pr.payment_kind){
        var kindLabel = pr.payment_kind === 'deposit_only' ? 'Deposit only' :
                        pr.payment_kind === 'full_payment'  ? 'Full payment'  :
                        pr.payment_kind.replace(/_/g,' ');
        html += '<span style="font-size:10px;color:var(--text-3)">' + escHtml(kindLabel) + '</span>';
      }
      html += '</div>';

      /* Amount rows */
      html += '<div class="ctx-pay-block" style="margin:0 0 4px">';
      if (pr.amount_due_cents  != null) html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Amount due</span><span class="ctx-pay-amount">' + escHtml(eur(pr.amount_due_cents)) + '</span></div>';
      if (pr.amount_paid_cents != null && Number(pr.amount_paid_cents) > 0)
        html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Amount paid</span><span class="ctx-pay-amount paid">' + escHtml(eur(pr.amount_paid_cents)) + '</span></div>';
      if (pr.paid_at)
        html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Paid at</span><span class="ctx-pay-amount" style="font-weight:400;font-size:11px">' + escHtml(fmtDate(pr.paid_at)) + '</span></div>';
      html += '</div>';

      /* Stripe webhook waiting banner */
      if (isCreated && !isPaid){
        html += '<div class="ctx-pay-record-wait">' +
          '\u23F3 Payment link created \u2014 waiting for Stripe webhook.' +
          '</div>';
      }

      /* Stripe ID details (collapsed, small) */
      var hasIds = pr.stripe_checkout_session_id || pr.stripe_payment_intent_id;
      if (hasIds){
        html += '<div class="ctx-pay-record-meta">';
        if (pr.stripe_checkout_session_id)
          html += '<div>Session: <code>' + escHtml(shortId(pr.stripe_checkout_session_id)) + '</code></div>';
        if (pr.stripe_payment_intent_id)
          html += '<div>Intent: <code>' + escHtml(shortId(pr.stripe_payment_intent_id)) + '</code></div>';
        html += '</div>';
      }

      /* Checkout URL + copy button */
      if (pr.checkout_url){
        html += '<div class="ctx-pay-record-url">';
        html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
        html += '<a href="' + escHtml(pr.checkout_url) + '" target="_blank" rel="noopener" ' +
          'style="word-break:break-all;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;color:var(--accent)">' +
          escHtml(pr.checkout_url.slice(0, 50)) + '\u2026</a>';
        html += '<button class="btn" data-url="' + escHtml(pr.checkout_url) + '" ' +
          'style="font-size:11px;padding:2px 8px" onclick="bcCopyUrl(this)">\uD83D\uDCCB Copy</button>';
        html += '</div></div>';
      }

      html += '</div>'; /* end ctx-pay-record */
    });
  }
  html += '</div>'; /* end ctx-pay-box */
  html += '</div>'; /* end Payment section */

  /* ── 4c. Services & add-ons (Stage 8.8.14) — booking_service_records only ─ */
  var svcRows = data.service_records || [];
  html += '<div class="ctx-section ctx-service-records" id="bc-service-records">';
  html += '<h3>Services &amp; Add-ons</h3>';
  var svcTypeLabel = function(t){
    if (!t) return '\u2014';
    var m = { yoga: 'Yoga', meal: 'Meal', surf_lesson: 'Surf lesson', wetsuit: 'Wetsuit', surfboard: 'Surfboard' };
    return m[t] || String(t).replace(/_/g, ' ');
  };
  if (svcRows.length === 0){
    html += '<div class="ctx-none">No services/add-ons recorded for this booking.</div>';
  } else {
    var lastSvcDate = null;
    svcRows.forEach(function(sr){
      if (sr.service_date !== lastSvcDate){
        html += '<div class="ctx-svc-date-label">' + escHtml(sr.service_date || '\u2014') + '</div>';
        lastSvcDate = sr.service_date;
      }
      html += '<div class="ctx-svc-record">';
      html += '<div class="ctx-pay-block" style="margin:0">';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Service</span><span class="ctx-pay-amount" style="font-weight:500">' + escHtml(svcTypeLabel(sr.service_type)) + '</span></div>';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Date</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(sr.service_date || '\u2014') + '</span></div>';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Qty</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(sr.quantity != null ? String(sr.quantity) : '\u2014') + '</span></div>';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Status</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(sr.status || '\u2014') + '</span></div>';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Payment</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(sr.payment_status || '\u2014') + '</span></div>';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Due</span><span class="ctx-pay-amount">' + escHtml(eur(sr.amount_due_cents)) + '</span></div>';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Paid</span><span class="ctx-pay-amount paid">' + escHtml(eur(sr.amount_paid_cents)) + '</span></div>';
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Source</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(sr.source || '\u2014') + '</span></div>';
      if (sr.notes) html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Notes</span><span class="ctx-pay-amount" style="font-weight:400;white-space:normal">' + escHtml(sr.notes) + '</span></div>';
      html += '</div></div>';
    });
  }
  html += '</div>';

  /* ── 4d. Luna confirmation draft (Stage 8.5.18) — read-only, no send ───── */
  var confDraft = (data.booking && data.booking.confirmation_draft) ||
                  (data.booking && data.booking.metadata && data.booking.metadata.confirmation_draft) ||
                  null;
  if (confDraft && typeof confDraft === 'object'){
    html += '<div class="ctx-section ctx-luna-confirmation-draft" id="bc-luna-confirmation-draft">';
    html += '<h3>Luna confirmation draft</h3>';
    html += '<div style="padding:8px 10px;background:#E8F0FA;border:1px solid #B5C7D3;border-radius:6px;font-size:12px">';
    html += '<div style="font-weight:600;margin-bottom:6px;color:#1d5570">Luna confirmation draft ready</div>';
    html += '<div class="ctx-pay-block" style="margin:0">';
    if (confDraft.booking_code)      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Booking</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(confDraft.booking_code) + '</span></div>';
    if (confDraft.guest_name)        html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Guest</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(confDraft.guest_name) + '</span></div>';
    if (confDraft.payment_status)    html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Payment status</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(bkPayLabel(confDraft.payment_status)) + '</span></div>';
    if (confDraft.amount_paid_cents != null)
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Amount paid</span><span class="ctx-pay-amount paid">' + escHtml(eur(confDraft.amount_paid_cents)) + '</span></div>';
    if (confDraft.balance_due_cents != null)
      html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Balance due</span><span class="ctx-pay-amount' + (Number(confDraft.balance_due_cents) > 0 ? ' owing' : ' paid') + '">' + escHtml(eur(confDraft.balance_due_cents)) + '</span></div>';
    if (confDraft.room_number)       html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Room</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(confDraft.room_number) + '</span></div>';
    if (confDraft.gate_code)         html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Gate code</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(confDraft.gate_code) + '</span></div>';
    if (confDraft.address)           html += '<div class="ctx-pay-row"><span class="ctx-pay-label">Address</span><span class="ctx-pay-amount" style="font-weight:400">' + escHtml(confDraft.address) + '</span></div>';
    html += '</div>';
    html += '<div style="margin-top:6px;font-size:11px;color:var(--text-3);border-top:1px solid #B5C7D3;padding-top:4px">';
    html += 'sends_whatsapp: <code>false</code> &middot; whatsapp_dry_run: <code>true</code>';
    html += '<br><span style="font-style:italic">Draft only — not sent. No WhatsApp in this slice.</span>';
    html += '</div></div></div>';
  }

  /* ── 5. Add-ons / Activities ───────────────────────────────────────────── */
  var ao = data.addons || {};
  html += '<div class="ctx-section"><h3>Add-ons / Activities</h3>';
  if (!ao.rows || ao.rows.length === 0){
    html += '<div class="ctx-none">' + escHtml(ao.note || 'No add-on orders recorded.') + '</div>';
  } else {
    var seenOrders = {};
    ao.rows.forEach(function(r){
      if (!seenOrders[r.order_id]){
        seenOrders[r.order_id] = true;
        var statusLabel = [r.order_status, r.order_payment_status].filter(Boolean).join(' / ');
        html += '<div class="ctx-addon-row"><span>' + escHtml(r.order_code || 'Order') + '</span>' +
          '<span style="font-size:11px;color:var(--text-2)">' + escHtml(statusLabel) + '</span></div>';
      }
    });
  }
  html += '</div>';

  /* ── 6. Conversation / Handoff ─────────────────────────────────────────── */
  html += '<div class="ctx-section"><h3>Conversation / Handoff</h3>';
  if (!data.conversation && !data.handoff){
    html += '<div class="ctx-none">No linked conversation or open handoff.</div>';
  } else {
    if (data.conversation){
      var conv = data.conversation;
      if (conv.needs_human) html += '<div class="ctx-status-row"><span class="pill pill-orange">NEEDS HUMAN REVIEW</span></div>';
      html += '<div class="kv-grid">';
      html += kvBC('Bot mode', conv.bot_mode);
      if (conv.pending_action)        html += kvBC('Pending', conv.pending_action);
      if (conv.last_message_preview)  html += kvBC('Last message', conv.last_message_preview);
      html += '</div>';
      html += '<div style="margin-top:8px">' +
        '<button class="btn-open-conv" id="bc-open-conv-btn" data-convid="' + escHtml(conv.conversation_id||'') + '">' +
        '&#128172; Open conversation</button>' +
        '<span style="font-size:11px;color:var(--text-3);margin-left:8px">Switches to Inbox tab</span>' +
        '</div>';
    }
    if (data.handoff){
      var hf = data.handoff;
      html += '<div class="kv-grid" style="margin-top:' + (data.conversation ? '12' : '0') + 'px">';
      html += kvBC('Handoff reason', hf.reason_code);
      html += kvBC('Priority', hf.priority);
      html += kvBC('Status', hf.status);
      if (hf.assigned_staff) html += kvBC('Assigned to', hf.assigned_staff);
      if (hf.opened_at)      html += kvBC('Opened', new Date(hf.opened_at).toLocaleString());
      html += '</div>';
    }
  }
  html += '</div>';

  /* ── Warnings ──────────────────────────────────────────────────────────── */
  if (data.warnings && data.warnings.length > 0){
    html += '<div class="ctx-section"><h3>Warnings</h3><div class="state-msg error">' +
      data.warnings.map(function(w){ return escHtml(w); }).join('<br>') + '</div></div>';
  }

  /* ── Planned operations (disabled — read-only staging) ─────────────────── */
  html += '<div class="ctx-planned">' +
    '<div class="ctx-planned-title">Planned operations (not enabled in staging)</div>' +
    '<span class="ctx-planned-action" title="Not enabled — write gates not approved">Move room / bed</span>' +
    '<span class="ctx-planned-action" title="Not enabled — write gates not approved">Change dates</span>' +
    '<span class="ctx-planned-action" title="Not enabled — write gates not approved">Cancel booking</span>' +
    '</div>';

  return html;
}

/* ── Tour Operator forms (Stage 8.7.17 — simplified skeleton, no writes) ─── */
/* Internal defaults — not shown to staff; for future write path only */
var TO_OP_BLOCK_DEFAULTS = {
  source: 'operator',
  payment_status: 'not_requested',
  guest_messaging: false,
  stripe_enabled: false,
  n8n_trigger: false,
  block_type: 'whole_room'
};

function toRefreshRoomSelects(){
  var rooms = (bcData && bcData.rooms) ? bcData.rooms : [];
  var sorted = rooms.slice().sort(function(a, b){
    var ao = a.sort_order != null ? a.sort_order : 999;
    var bo = b.sort_order != null ? b.sort_order : 999;
    if (ao !== bo) return ao - bo;
    return (a.room_name || a.room_code || '').localeCompare(b.room_name || b.room_code || '', undefined, { numeric: true, sensitivity: 'base' });
  });
  ['to-op-room', 'to-rr-room'].forEach(function(selId){
    var sel = el(selId);
    if (!sel || sel.tagName !== 'SELECT') return;
    var html = '<option value="">— select room —</option>';
    if (sorted.length){
      sorted.forEach(function(r){
        var label = escHtml(r.room_code);
        if (r.room_name && r.room_name !== r.room_code) label += ' — ' + escHtml(r.room_name);
        html += '<option value="' + escHtml(r.room_code) + '">' + label + '</option>';
      });
    } else {
      html += '<option value="" disabled>Load Bed Calendar for room list</option>';
    }
    sel.innerHTML = html;
  });
}

function toCalcReleaseNights(){
  var rs = el('to-rr-start');
  var re = el('to-rr-end');
  var rn = el('to-rr-nights');
  if (!rs || !re || !rn) return;
  var a = rs.value;
  var b = re.value;
  if (a && b && b > a){
    var ms = new Date(a + 'T00:00:00').getTime();
    var me = new Date(b + 'T00:00:00').getTime();
    rn.value = String(Math.max(0, Math.round((me - ms) / 86400000)));
  } else {
    rn.value = '';
  }
}

function toOnBlockSelectChange(){
  var sel = el('to-rr-block-select');
  var cin = el('to-rr-orig-cin');
  var cout = el('to-rr-orig-cout');
  if (!sel) return;
  var opt = sel.options[sel.selectedIndex];
  var cIn = opt && opt.dataset ? opt.dataset.cin : '';
  var cOut = opt && opt.dataset ? opt.dataset.cout : '';
  if (cin) cin.value = cIn || '';
  if (cout) cout.value = cOut || '';
}

function toInitForms(){
  toRefreshRoomSelects();
  var blockSel = el('to-rr-block-select');
  if (blockSel) blockSel.onchange = toOnBlockSelectChange;
  var rs = el('to-rr-start');
  var re = el('to-rr-end');
  if (rs) rs.addEventListener('change', toCalcReleaseNights);
  if (re) re.addEventListener('change', toCalcReleaseNights);
}

(function initTourOperatorForms(){
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', toInitForms);
  } else {
    toInitForms();
  }
})();

function loadBedCalendar(){
  var start  = (el('bc-start').value||'').trim();
  var end    = (el('bc-end').value||'').trim();
  var client = getBcClient();

  el('bc-grid-wrap').style.display = 'none';
  el('bc-detail').style.display    = 'none';
  el('bc-summary').style.display   = 'none';
  el('bc-state').className         = 'state-msg';
  el('bc-state').textContent       = 'Loading bed calendar\u2026';
  el('bc-state').style.display     = 'block';
  el('bc-load').disabled           = true;
  /* Clear selection on new load (Stage 8.3c) */
  bcSel = null;
  var _sp = el('bc-sel-panel'); if (_sp) _sp.style.display = 'none';

  var url = '/staff/bed-calendar?client=' + encodeURIComponent(client) +
            '&start=' + encodeURIComponent(start) +
            '&end='   + encodeURIComponent(end);

  fetch(url)
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, status: r.status, data: d }; }); })
    .then(function(res){
      el('bc-load').disabled = false;
      if (!res.ok || !res.data.success){
        el('bc-state').className   = 'state-msg error';
        el('bc-state').textContent = 'Error ' + res.status + ': ' + (res.data.error || 'Request failed');
        return;
      }
      if (!res.data.rooms || res.data.rooms.length === 0){
        el('bc-state').textContent = 'No rooms found for this client.';
        return;
      }
      if (!res.data.days || res.data.days.length === 0){
        el('bc-state').textContent = 'No days in range.';
        return;
      }
      renderBedCalendar(res.data);
    })
    .catch(function(e){
      el('bc-load').disabled     = false;
      el('bc-state').className   = 'state-msg error';
      el('bc-state').textContent = 'Network error: ' + e.message;
    });
}

el('bc-load').addEventListener('click', loadBedCalendar);

/* ── Bed calendar date shortcuts (Stage 8.3a) ────────────────────────────── */
function bcIso(d){ return d.toISOString().slice(0,10); }
function bcAddDaysISO(iso, delta){
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return bcIso(d);
}

var bcInitialLoadDone = false;
function bcOnBedCalendarTabOpen(){
  var sEl = el('bc-start');
  var eEl = el('bc-end');
  if ((sEl && !sEl.value) || (eEl && !eEl.value)){
    var today = new Date();
    var end30 = new Date(today.getTime() + 30 * 86400000);
    bcInitialLoadDone = true;
    bcSetRange(bcIso(today), bcIso(end30), '30days');
    return;
  }
  if (!bcInitialLoadDone){
    bcInitialLoadDone = true;
    document.querySelectorAll('.bc-chip').forEach(function(c){ c.classList.remove('bc-chip-active'); });
    var chip30 = document.querySelector('.bc-chip[data-chip="30days"]');
    if (chip30) chip30.classList.add('bc-chip-active');
    loadBedCalendar();
  }
}

function bcSetRange(start, end, chipKey){
  var s = el('bc-start'); var e = el('bc-end');
  if (s) s.value = start;
  if (e) e.value = end;
  /* Update active chip */
  document.querySelectorAll('.bc-chip').forEach(function(c){ c.classList.remove('bc-chip-active'); });
  if (chipKey){
    var activeChip = document.querySelector('.bc-chip[data-chip="' + chipKey + '"]');
    if (activeChip) activeChip.classList.add('bc-chip-active');
  }
  loadBedCalendar();
}

/* Initialise date inputs dynamically (next 30 days default) */
(function initBcDates(){
  var today = new Date();
  var plus30 = new Date(today.getTime() + 30 * 86400000);
  var s = el('bc-start'); var e = el('bc-end');
  if (s && !s.value) s.value = bcIso(today);
  if (e && !e.value) e.value = bcIso(plus30);
})();

document.querySelectorAll('.bc-chip').forEach(function(chip){
  chip.addEventListener('click', function(){
    var key = this.dataset.chip;
    var today = new Date();
    var t = bcIso(today);
    if (key === 'week'){
      var end = new Date(today.getTime() + 6 * 86400000);
      bcSetRange(t, bcIso(end), 'week');
    } else if (key === '30days'){
      var end30 = new Date(today.getTime() + 30 * 86400000);
      bcSetRange(t, bcIso(end30), '30days');
    } else if (key === 'jul-aug'){
      bcSetRange('2026-07-01', '2026-08-31', 'jul-aug');
    } else if (key === 'demo'){
      bcSetRange('2026-07-16', '2026-07-22', 'demo');
    }
  });
});

/* ── Today / Needs Attention (Stage 8.2) ─────────────────────────────────── */
function loadTodaySummary(){
  var stEl = el('today-load-state');
  var nhEl = el('tile-nh-count');
  var inEl = el('tile-inbox-count');
  if (nhEl) nhEl.textContent = '…';
  if (inEl) inEl.textContent = '…';
  var client = (el('c-client') && el('c-client').value) || 'wolfhouse-somo';

  fetch('/staff/conversations?client=' + encodeURIComponent(client))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.success || !Array.isArray(d.conversations)){
        if (inEl) inEl.textContent = '?';
        if (nhEl) nhEl.textContent = '?';
        return;
      }
      var convs = d.conversations;
      var nh = convs.filter(function(c){ return c.needs_human; }).length;
      if (inEl) inEl.textContent = convs.length;
      if (nhEl) nhEl.textContent = nh;
      /* keep handoff badge in sync */
      var badge = el('hq-badge');
      if (badge){ badge.textContent = nh; if (nh > 0) badge.classList.add('visible'); }
      if (stEl){ stEl.style.display = 'none'; }
    })
    .catch(function(){
      if (inEl) inEl.textContent = '?';
      if (nhEl) nhEl.textContent = '?';
      if (stEl){ stEl.style.display = 'block'; stEl.textContent = 'Could not load conversation data.'; }
    });
}

/* Load Today summary on initial page load (Today is default tab) */
loadTodaySummary();

// doLogout must be global so onclick="doLogout()" in the banner HTML resolves it
window.doLogout = function doLogout(){
  var x = new XMLHttpRequest();
  x.open('POST', '/staff/auth/logout', true);
  x.withCredentials = true;
  x.onload = function(){ window.location.href='/staff/login'; };
  x.onerror = function(){ window.location.href='/staff/login'; };
  x.send();
};

})();
</script>
</body>
</html>`;
}

function handleUI(res, port) {
  const html = buildUiHtml(port);
  res.writeHead(200, {
    'Content-Type':  'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Powered-By':  'wolfhouse-staff-api/7.7c',
  });
  res.end(html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /staff/login  (Stage 7.3e — Luna Front Desk login page)
// ─────────────────────────────────────────────────────────────────────────────

function buildLoginHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luna Front Desk — Sign in</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --cream:#F7F3EC;
  --surface:#FFFDFA;
  --sand:#E9DDCF;
  --tan:#DCC8B7;
  --sage:#AFC3A3;
  --olive:#8FA58E;
  --dusty-blue:#B7CAD6;
  --ocean:#95B4C7;
  --text:#44504A;
  --text-2:#7A8C82;
  --text-3:#A8B5AE;
  --border:#D8CEBF;
  --radius:14px;
  --radius-sm:8px;
}
body{
  background:linear-gradient(135deg,var(--cream) 0%,#EBF0ED 60%,#E8EFF5 100%);
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  color:var(--text);
}
.card{
  background:var(--surface);
  border:1px solid var(--sand);
  border-radius:var(--radius);
  box-shadow:0 4px 32px rgba(68,80,74,.10),0 1px 4px rgba(68,80,74,.06);
  padding:40px 40px 36px;
  width:100%;
  max-width:400px;
}
.logo{
  text-align:center;
  margin-bottom:28px;
}
.logo-mark{
  width:48px;height:48px;border-radius:50%;
  background:linear-gradient(135deg,var(--sage) 0%,var(--ocean) 100%);
  display:inline-flex;align-items:center;justify-content:center;
  font-size:22px;font-weight:800;color:#fff;letter-spacing:-.02em;
  margin-bottom:12px;
}
.logo h1{
  font-size:20px;font-weight:700;letter-spacing:.01em;color:var(--text);
}
.logo .sub{
  font-size:12px;color:var(--text-2);margin-top:4px;letter-spacing:.04em;text-transform:uppercase;
}
.field{margin-bottom:16px;}
.field label{
  display:block;font-size:12px;font-weight:600;color:var(--text-2);
  margin-bottom:5px;letter-spacing:.04em;text-transform:uppercase;
}
.field input{
  width:100%;padding:10px 13px;
  border:1px solid var(--border);
  border-radius:var(--radius-sm);
  background:var(--cream);
  font-size:14px;color:var(--text);
  transition:border-color .18s,box-shadow .18s;
  outline:none;
}
.field input:focus{
  border-color:var(--olive);
  box-shadow:0 0 0 3px rgba(143,165,142,.18);
}
.btn-signin{
  width:100%;padding:11px 0;margin-top:6px;
  background:linear-gradient(120deg,var(--olive) 0%,var(--ocean) 100%);
  border:none;border-radius:var(--radius-sm);
  color:#fff;font-size:14px;font-weight:700;letter-spacing:.04em;
  cursor:pointer;transition:opacity .18s;
}
.btn-signin:hover{opacity:.88}
.btn-signin:disabled{opacity:.55;cursor:default}
.msg{
  margin-top:14px;padding:10px 13px;border-radius:var(--radius-sm);
  font-size:13px;display:none;
}
.msg.error{background:#FEF1EC;border:1px solid #F2C4AC;color:#9B4020;}
.msg.ok{background:#EFF5EE;border:1px solid #BACEA4;color:#3A6035;}
.safety-strip{
  margin-top:22px;padding-top:16px;border-top:1px solid var(--sand);
  display:flex;gap:8px;flex-wrap:wrap;
}
.safety-badge{
  font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;
  padding:3px 9px;border-radius:10px;
}
.safety-badge.staging{background:#EBF0F5;color:#5C7A90;border:1px solid #C5D6E3;}
.safety-badge.disabled{background:#F3F6F1;color:#6B8469;border:1px solid #BFCFB9;}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-mark">L</div>
    <h1>Luna Front Desk</h1>
    <div class="sub">Staff sign in</div>
  </div>

  <form id="login-form" autocomplete="on">
    <div class="field">
      <label for="client">Company</label>
      <input id="client" name="client" type="text" value="wolfhouse-somo" autocomplete="organization" spellcheck="false">
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" placeholder="staff@example.com" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button class="btn-signin" id="btn-signin" type="button">Sign in</button>
    <div class="msg" id="msg"></div>
  </form>

  <div class="safety-strip">
    <span class="safety-badge staging">Staging / shadow mode</span>
    <span class="safety-badge disabled">Staff actions disabled</span>
  </div>
</div>

<script>
(function(){
  'use strict';
  var btn   = document.getElementById('btn-signin');
  var msg   = document.getElementById('msg');

  function showMsg(text, isError){
    msg.className = 'msg ' + (isError ? 'error' : 'ok');
    msg.textContent = text;
    msg.style.display = 'block';
  }

  function doSignIn(){
    btn.disabled = true;
    msg.style.display = 'none';

    var client   = document.getElementById('client').value.trim();
    var email    = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;

    if (!client || !email || !password){
      showMsg('All fields are required.', true);
      btn.disabled = false;
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/staff/auth/login', true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function(){
      var d = {};
      try { d = JSON.parse(xhr.responseText); } catch(_){}
      if (xhr.status === 200 && d.success){
        showMsg('Signed in \u2014 redirecting\u2026', false);
        window.location.href = '/staff/ui';
      } else {
        showMsg(d.error || 'Login failed. Please check your credentials.', true);
        btn.disabled = false;
      }
    };
    xhr.onerror = function(){
      showMsg('Network error. Please try again.', true);
      btn.disabled = false;
    };
    xhr.send(JSON.stringify({ client: client, email: email, password: password }));
  }

  btn.addEventListener('click', doSignIn);
  document.getElementById('password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') doSignIn();
  });
  document.getElementById('email').addEventListener('keydown', function(e){
    if (e.key === 'Enter') doSignIn();
  });
})();
</script>
</body>
</html>`;
}

function handleLoginPage(res) {
  const html = buildLoginHtml();
  res.writeHead(200, {
    'Content-Type':  'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Powered-By':  'wolfhouse-staff-api/7.3e',
  });
  res.end(html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7.7b — Conversation API handlers (read-only)
//
// All six handlers share the same safety contract:
//   • SELECT-only via staff-conversation-queries.js helpers
//   • client-scoped ($1 = client slug, $2 = UUID for per-conversation routes)
//   • audit entry per call with intent prefix api:conversation.*
//   • requireAuth enforced when STAFF_AUTH_REQUIRED=true (viewer minimum)
//   • no writes to any table (conversations / bookings / payments / handoffs / etc.)
//   • last_seen_at slide on auth_sessions is the only DB write (via loadAuthSession)
// ─────────────────────────────────────────────────────────────────────────────

async function handleConversationInbox(query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const auditBase = {
    ts:            new Date().toISOString(),
    intent:        'api:conversation.inbox',
    category:      'conversation_api',
    client_slug:   clientSlug,
    staff_user_id: user ? user.staff_user_id : null,
  };

  let rows;
  try {
    rows = await withPgClient(async (pg) => {
      const r = await pg.query(getConversationInboxQuery(), [clientSlug]);
      return r.rows;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed' });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({ ...auditBase, success: true, row_count: rows.length, elapsed_ms: elapsed });
  return sendJSON(res, 200, { success: true, conversations: rows, count: rows.length, elapsed_ms: elapsed });
}

async function handleConversationDetail(convId, query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const auditBase = {
    ts:              new Date().toISOString(),
    intent:          'api:conversation.detail',
    category:        'conversation_api',
    client_slug:     clientSlug,
    conversation_id: convId,
    staff_user_id:   user ? user.staff_user_id : null,
  };

  let rows;
  try {
    rows = await withPgClient(async (pg) => {
      const r = await pg.query(getConversationDetailQuery(), [clientSlug, convId]);
      return r.rows;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed' });
  }

  const elapsed = Date.now() - started;
  if (!rows.length) {
    appendAuditLog({ ...auditBase, success: false, error: 'not_found', elapsed_ms: elapsed });
    return send404(res);
  }

  appendAuditLog({ ...auditBase, success: true, row_count: 1, elapsed_ms: elapsed });
  return sendJSON(res, 200, { success: true, conversation: rows[0], elapsed_ms: elapsed });
}

async function handleConversationMessages(convId, query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const auditBase = {
    ts:              new Date().toISOString(),
    intent:          'api:conversation.messages',
    category:        'conversation_api',
    client_slug:     clientSlug,
    conversation_id: convId,
    staff_user_id:   user ? user.staff_user_id : null,
  };

  let rows;
  try {
    rows = await withPgClient(async (pg) => {
      const r = await pg.query(getConversationMessagesQuery(), [clientSlug, convId]);
      return r.rows;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed' });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({ ...auditBase, success: true, row_count: rows.length, elapsed_ms: elapsed });
  return sendJSON(res, 200, { success: true, messages: rows, count: rows.length, elapsed_ms: elapsed });
}

async function handleConversationContext(convId, query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const auditBase = {
    ts:              new Date().toISOString(),
    intent:          'api:conversation.context',
    category:        'conversation_api',
    client_slug:     clientSlug,
    conversation_id: convId,
    staff_user_id:   user ? user.staff_user_id : null,
  };

  let rows;
  try {
    rows = await withPgClient(async (pg) => {
      const r = await pg.query(getConversationContextQuery(), [clientSlug, convId]);
      return r.rows;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed' });
  }

  const elapsed = Date.now() - started;
  if (!rows.length) {
    appendAuditLog({ ...auditBase, success: false, error: 'not_found', elapsed_ms: elapsed });
    return send404(res);
  }

  appendAuditLog({ ...auditBase, success: true, row_count: 1, elapsed_ms: elapsed });
  return sendJSON(res, 200, { success: true, context: rows[0], elapsed_ms: elapsed });
}

async function handleConversationDraft(convId, query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const auditBase = {
    ts:              new Date().toISOString(),
    intent:          'api:conversation.draft',
    category:        'conversation_api',
    client_slug:     clientSlug,
    conversation_id: convId,
    staff_user_id:   user ? user.staff_user_id : null,
  };

  let rows;
  try {
    rows = await withPgClient(async (pg) => {
      const r = await pg.query(getConversationDraftQuery(), [clientSlug, convId]);
      return r.rows;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed' });
  }

  const elapsed = Date.now() - started;
  if (!rows.length) {
    appendAuditLog({ ...auditBase, success: false, error: 'not_found', elapsed_ms: elapsed });
    return send404(res);
  }

  appendAuditLog({ ...auditBase, success: true, draft_available: rows[0].draft_available, elapsed_ms: elapsed });
  return sendJSON(res, 200, { success: true, draft: rows[0], elapsed_ms: elapsed });
}

async function handleConversationStaffState(convId, query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const auditBase = {
    ts:              new Date().toISOString(),
    intent:          'api:conversation.staff-state',
    category:        'conversation_api',
    client_slug:     clientSlug,
    conversation_id: convId,
    staff_user_id:   user ? user.staff_user_id : null,
  };

  let rows;
  try {
    rows = await withPgClient(async (pg) => {
      const r = await pg.query(getConversationStaffStateQuery(), [clientSlug, convId]);
      return r.rows;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed' });
  }

  const elapsed = Date.now() - started;
  if (!rows.length) {
    appendAuditLog({ ...auditBase, success: false, error: 'not_found', elapsed_ms: elapsed });
    return send404(res);
  }

  appendAuditLog({ ...auditBase, success: true, row_count: 1, elapsed_ms: elapsed });
  return sendJSON(res, 200, { success: true, staff_state: rows[0], elapsed_ms: elapsed });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7.7f — Handoff queue handler (read-only)
//
// GET /staff/handoffs?client=<slug>
//   Returns all open/active staff_handoffs rows plus conversations that have
//   needs_human=true but no structured handoff row yet.
//
// Safety: SELECT-only. No mutations. Viewer auth minimum. Fully audited.
// ─────────────────────────────────────────────────────────────────────────────

async function handleHandoffQueue(query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const auditBase = {
    ts:            new Date().toISOString(),
    intent:        'api:handoffs.open',
    category:      'handoff_api',
    client_slug:   clientSlug,
    staff_user_id: user ? user.staff_user_id : null,
  };

  let handoffs = [];
  let needsHumanUnlinked = [];
  try {
    [handoffs, needsHumanUnlinked] = await withPgClient(async (pg) => {
      const [hRows, nhRows] = await Promise.all([
        pg.query(getOpenHandoffsQuery(), [clientSlug]),
        pg.query(getNeedsHumanWithoutOpenHandoffQuery(), [clientSlug]),
      ]);
      return [hRows.rows, nhRows.rows];
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed', detail: err.message });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ...auditBase,
    success:                true,
    handoff_count:          handoffs.length,
    needs_human_unlinked:   needsHumanUnlinked.length,
    elapsed_ms:             elapsed,
  });

  return sendJSON(res, 200, {
    success:              true,
    count:                handoffs.length,
    needs_human_unlinked: needsHumanUnlinked.length,
    handoffs,
    needs_human_without_handoff: needsHumanUnlinked,
    elapsed_ms:           elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7.7g — Bed calendar handler (read-only)
//
// GET /staff/bed-calendar?client=<slug>&start=YYYY-MM-DD&end=YYYY-MM-DD
//   Returns rooms/beds hierarchy + booking_beds blocks overlapping the range.
//   Date-span arithmetic (start_offset, span_days, is_arrival, is_departure)
//   and color_type classification are computed in JS after the DB read.
//
// Safety: SELECT-only. No mutations. Viewer auth minimum. Fully audited.
// ─────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CALENDAR_DAYS = 90;

function parseCalendarDate(str) {
  if (!str || !DATE_RE.test(str)) return null;
  const d = new Date(str + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return d;
}

function generateCalendarDays(startDate, endDate) {
  const DAY_MS = 86400000;
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [];
  let cur = new Date(startDate.getTime());
  while (cur < endDate) {
    const iso = cur.toISOString().slice(0, 10);
    days.push({ date: iso, label: DAY_LABELS[cur.getUTCDay()] + ' ' + String(cur.getUTCDate()).padStart(2, '0') });
    cur = new Date(cur.getTime() + DAY_MS);
  }
  return days;
}

function bedCalendarColorType(row) {
  const s  = (row.booking_status   || '').toLowerCase();
  const p  = (row.payment_status   || '').toLowerCase();
  const a  = (row.assignment_status || '').toLowerCase();
  const src = (row.booking_source   || '').toLowerCase();
  if (s === 'cancelled')   return 'cancelled';
  if (src === 'operator')  return 'operator';
  if (src === 'manual_staff') return 'manual';
  if (a === 'needs_review' || row.needs_rooming_review) return 'needs_review';
  if (s === 'confirmed' && p === 'paid') return 'confirmed';
  if (s === 'confirmed')   return 'confirmed';
  if (p === 'payment_pending' || s === 'payment_pending') return 'payment_pending';
  if (s === 'hold')        return 'hold';
  return 'hold';
}

function computeBlockSpan(row, startDate, endDate) {
  const DAY_MS = 86400000;
  const bStart = new Date(row.assignment_start_date + 'T00:00:00Z');
  const bEnd   = new Date(row.assignment_end_date   + 'T00:00:00Z');
  const clipStart = bStart < startDate ? startDate : bStart;
  const clipEnd   = bEnd   > endDate   ? endDate   : bEnd;
  return {
    start_offset: Math.round((clipStart - startDate) / DAY_MS),
    span_days:    Math.max(0, Math.round((clipEnd - clipStart) / DAY_MS)),
    is_arrival:   bStart >= startDate && bStart < endDate,
    is_departure: bEnd   >  startDate && bEnd   <= endDate,
  };
}

function buildRoomHierarchy(roomRows) {
  const rooms   = [];
  const roomMap = {};
  for (const row of roomRows) {
    if (!roomMap[row.room_code]) {
      roomMap[row.room_code] = {
        room_code:   row.room_code,
        room_name:   row.room_name  || row.room_code,
        house:       row.house      || null,
        room_type:   row.room_type  || null,
        capacity:    row.capacity   || 0,
        sort_order:  row.room_sort_order != null ? Number(row.room_sort_order) : 999,
        beds: [],
      };
      rooms.push(roomMap[row.room_code]);
    }
    if (row.bed_code) {
      roomMap[row.room_code].beds.push({
        bed_code:  row.bed_code,
        bed_label: row.bed_label || row.bed_code,
        sort_order: row.bed_number != null ? Number(row.bed_number) : 0,
      });
    }
  }
  return rooms;
}

function buildCalendarBlocks(blockRows, startDate, endDate) {
  return blockRows.map(row => {
    const span = computeBlockSpan(row, startDate, endDate);
    return {
      booking_id:        row.booking_id,
      booking_code:      row.booking_code,
      guest_name:        row.guest_name || row.bed_guest_name || '—',
      phone:             row.phone || null,
      status:            row.booking_status,
      payment_status:    row.payment_status,
      assignment_status: row.assignment_status,
      booking_source:    row.booking_source || null,
      room_code:         row.room_code,
      bed_code:          row.bed_code,
      start_date:        row.assignment_start_date,
      end_date:          row.assignment_end_date,
      start_offset:      span.start_offset,
      span_days:         span.span_days,
      label:             (row.booking_code || '') + (row.guest_name ? ' \u2014 ' + row.guest_name : ''),
      color_type:        bedCalendarColorType(row),
      needs_review:      !!(row.needs_rooming_review || (row.assignment_status || '').toLowerCase() === 'needs_review'),
      is_arrival:        span.is_arrival,
      is_departure:      span.is_departure,
    };
  }).filter(b => b.span_days > 0);
}

async function handleBedCalendar(query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');

  const startDate = parseCalendarDate(query.start);
  const endDate   = parseCalendarDate(query.end);
  if (!startDate) return send400(res, 'start is required and must be YYYY-MM-DD');
  if (!endDate)   return send400(res, 'end is required and must be YYYY-MM-DD');
  if (endDate <= startDate) return send400(res, 'end must be after start');

  const daysDiff = Math.round((endDate - startDate) / 86400000);
  if (daysDiff > MAX_CALENDAR_DAYS) {
    return send400(res, `date range too large (max ${MAX_CALENDAR_DAYS} days)`);
  }

  const startISO = query.start;
  const endISO   = query.end;

  const auditBase = {
    ts:            new Date().toISOString(),
    intent:        'api:bed_calendar',
    category:      'bed_calendar_api',
    client_slug:   clientSlug,
    params_start:  startISO,
    params_end:    endISO,
    staff_user_id: user ? user.staff_user_id : null,
  };

  let roomRows = [], blockRows = [], summaryRows = [];
  try {
    [roomRows, blockRows, summaryRows] = await withPgClient(async (pg) => {
      const [rr, br, sr] = await Promise.all([
        pg.query(getBedCalendarRoomsQuery(),   [clientSlug]),
        pg.query(getBedCalendarBlocksQuery(),  [clientSlug, startISO, endISO]),
        pg.query(getBedCalendarSummaryQuery(), [clientSlug, startISO, endISO]),
      ]);
      return [rr.rows, br.rows, sr.rows];
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed', detail: err.message });
  }

  const rooms  = buildRoomHierarchy(roomRows);
  const days   = generateCalendarDays(startDate, endDate);
  const blocks = buildCalendarBlocks(blockRows, startDate, endDate);

  const elapsed = Date.now() - started;
  appendAuditLog({
    ...auditBase,
    success:     true,
    room_count:  rooms.length,
    day_count:   days.length,
    block_count: blocks.length,
    elapsed_ms:  elapsed,
  });

  return sendJSON(res, 200, {
    success:      true,
    client_slug:  clientSlug,
    start:        startISO,
    end:          endISO,
    days,
    rooms,
    blocks,
    summary:      summaryRows,
    warnings:     [],
    elapsed_ms:   elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7.7k3 — Bed reassignment preview handler (proposal-only, no write)
//
// GET /staff/bed-calendar/reassign/preview
//   ?client=<slug>&booking_bed_id=<uuid>&target_bed_code=<bed>
//   &booking_code=<optional>&reason=<optional>
//
// Calls reassignBookingBedSql() with confirm=false ($8=false).
// The UPDATE CTE is gated by confirm, so rows_updated is always 0.
// Wrapped in BEGIN/ROLLBACK — absolutely no booking_beds change can persist.
// The audit_written CTE only fires when updated ran, so no workflow_events row.
// Only the API's own audit log file is written on every call.
//
// Auth: operator/admin/owner minimum. Viewers get 403 when STAFF_AUTH_REQUIRED=true.
// NOT gated by STAFF_ACTIONS_ENABLED — preview is read-only; no write gate needed.
// Does NOT import or call reassign-booking-beds-pg-sql.js (bot reset path).
//
// Safety: booking_beds · bookings · payments · payment_events · staff_handoffs
//         all remain untouched. Protected table delta = 0 guaranteed.
// ─────────────────────────────────────────────────────────────────────────────

async function handleBedReassignPreview(query, res, user) {
  const started = Date.now();

  // ── Extract params ─────────────────────────────────────────────────────────
  const clientSlug    = String(query.client           || DEFAULT_CLIENT).trim();
  const bookingBedId  = String(query.booking_bed_id   || '').trim();
  const targetBedCode = String(query.target_bed_code  || '').trim();
  const reasonNote    = String(query.reason           || 'preview only').trim().slice(0, 500);
  const bookingCodeQ  = String(query.booking_code     || '').trim();

  // ── Input validation ───────────────────────────────────────────────────────
  if (SQL_INJECT_RE.test(clientSlug))
    return send400(res, 'invalid client slug');
  if (!bookingBedId)
    return send400(res, 'booking_bed_id is required');
  if (!UUID_VALIDATE_RE.test(bookingBedId))
    return send400(res, 'booking_bed_id must be a valid UUID');
  if (!targetBedCode)
    return send400(res, 'target_bed_code is required');
  if (SQL_INJECT_RE.test(targetBedCode))
    return send400(res, 'invalid target_bed_code');
  if (SQL_INJECT_RE.test(reasonNote))
    return send400(res, 'invalid reason');

  // ── Audit baseline ─────────────────────────────────────────────────────────
  const actorId   = user ? user.staff_user_id : 'dev-preview-local';
  const actorRole = user ? user.role          : 'operator';

  const auditBase = {
    ts:             new Date().toISOString(),
    intent:         'api:bed_reassign_preview',
    category:       'bed_reassign_api',
    client_slug:    clientSlug,
    booking_bed_id: bookingBedId,
    target_bed_code: targetBedCode,
    staff_user_id:  actorId,
    staff_role:     actorRole,
  };

  let previewRow;
  try {
    previewRow = await withPgClient(async (pg) => {
      // Step 1: resolve booking_code if not supplied by caller
      let bookingCode = bookingCodeQ;
      if (!bookingCode) {
        const lkup = await pg.query(LOOKUP_BOOKING_CODE_SQL, [bookingBedId, clientSlug]);
        if (lkup.rows.length === 0) {
          // Return null to signal not-found (handled below after try/catch)
          return null;
        }
        bookingCode = lkup.rows[0].booking_code;
      }

      // Step 2: run SQL inside BEGIN/ROLLBACK — always rolled back for preview.
      // The helper's UPDATE is already gated by confirm=false, giving rows_updated=0.
      // The ROLLBACK is defence-in-depth: no write can accidentally persist.
      await pg.query('BEGIN');
      let result;
      try {
        result = await pg.query(
          reassignBookingBedSql(),
          [
            clientSlug,   // $1 client_slug
            bookingCode,  // $2 booking_code
            bookingBedId, // $3 booking_bed_id (UUID)
            targetBedCode,// $4 target_bed_code
            actorId,      // $5 staff_user_id
            actorRole,    // $6 staff_role
            reasonNote,   // $7 reason_note
            false,        // $8 confirm = FALSE — preview only, never write
            false,        // $9 manual_operator_lock_override = FALSE (never override in preview)
          ]
        );
      } finally {
        // Always rollback — this is a preview; no writes should persist.
        try { await pg.query('ROLLBACK'); } catch (_) {}
      }
      return result.rows[0] || null;
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'preview query failed', detail: err.message });
  }

  // ── Not-found ──────────────────────────────────────────────────────────────
  if (previewRow === null) {
    appendAuditLog({ ...auditBase, success: false, error: 'assignment_not_found', elapsed_ms: Date.now() - started });
    return sendJSON(res, 404, {
      success: false,
      error:   'booking_bed_id not found for this client',
      note:    'The assignment may not exist or may belong to a different client.',
    });
  }

  // ── Safety assertion: rows_updated must be 0 for a preview call ───────────
  const rowsUpdated = Number(previewRow.rows_updated || 0);
  if (rowsUpdated !== 0) {
    // This should never happen (confirm=false + ROLLBACK), but log and surface it.
    appendAuditLog({
      ...auditBase, success: false,
      error: 'SAFETY_VIOLATION_rows_updated_nonzero', rows_updated: rowsUpdated,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, {
      success: false,
      error:   'Safety check failed: preview returned rows_updated != 0. No changes were committed (transaction was rolled back). Report this immediately.',
      rows_updated: rowsUpdated,
    });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ...auditBase,
    success:      true,
    blocked:      previewRow.blocked,
    block_reason: previewRow.block_reason,
    rows_updated: rowsUpdated,
    elapsed_ms:   elapsed,
  });

  return sendJSON(res, 200, {
    success:              true,
    preview:              true,
    note:                 'Proposal only — confirm=false. No booking_beds row was changed. Transaction was rolled back.',
    action:               previewRow.action,
    booking_code:         previewRow.booking_code,
    old_room_code:        previewRow.old_room_code,
    old_bed_code:         previewRow.old_bed_code,
    new_room_code:        previewRow.new_room_code,
    new_bed_code:         previewRow.new_bed_code,
    assignment_start_date: previewRow.assignment_start_date,
    assignment_end_date:   previewRow.assignment_end_date,
    blocked:              previewRow.blocked,
    block_reason:         previewRow.block_reason,
    conflict_count:       previewRow.conflict_count,
    rows_updated:         rowsUpdated,
    audit_payload:        previewRow.audit_payload,
    rollback_payload:     previewRow.rollback_payload,
    elapsed_ms:           elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7.7k5 — Bed reassignment confirmed write endpoint (staff-only, gated)
//
// POST /staff/bed-calendar/reassign/confirm
//
// Request body (JSON):
//   { client, booking_bed_id, target_bed_code, reason, confirm: true,
//     manual_operator_lock_override: false }
//
// Gates (all must pass):
//   1. STAFF_ACTIONS_ENABLED=true (env flag)
//   2. STAFF_AUTH_REQUIRED=true (env flag)
//   3. Authenticated session with role operator/admin/owner
//   4. confirm: true in request body (explicit acknowledgement)
//
// manual_operator_lock_override:
//   Intentionally NOT implemented in this slice (7.7k5).
//   If the current booking_beds row has assignment_type='manual', the helper
//   will block with block_reason='manual_operator_lock' → 409 returned.
//   Override is deferred to a later admin-only slice (7.7k6).
//
// Safety:
//   - Calls reassignBookingBedSql() with confirm=true inside BEGIN/COMMIT.
//   - If blocked OR rows_updated != 1 → ROLLBACK, never commits.
//   - rows_updated safety assertion: if helper returns any value other than 0
//     (blocked) or 1 (success), ROLLBACK and 500.
//   - Does NOT call reassign-booking-beds-pg-sql.js (bot reset path).
//   - Does NOT mutate: payments, payment_events, staff_handoffs, conversations.
//   - Does NOT expose a UI control; NOT wired to any calendar edit button.
// ─────────────────────────────────────────────────────────────────────────────

async function handleBedReassignConfirm(req, res) {
  const started = Date.now();

  // ── 1. Feature flag gate ────────────────────────────────────────────────────
  if (!STAFF_ACTIONS_ENABLED) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bed_reassign_confirm',
      category: 'bed_reassignment_api',
      success: false, error: 'feature_flag_disabled', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, {
      success: false,
      error:   'Bed reassignment write is disabled. Set STAFF_ACTIONS_ENABLED=true to enable.',
    });
  }

  // ── 2. Auth gate (session + role) ──────────────────────────────────────────
  // Requires STAFF_AUTH_REQUIRED=true. Token-only path is NOT accepted for
  // confirmed bed reassignment writes — session auth is mandatory.
  if (!STAFF_AUTH_REQUIRED) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bed_reassign_confirm',
      category: 'bed_reassignment_api',
      success: false, error: 'auth_not_enabled', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, {
      success: false,
      error:   'STAFF_AUTH_REQUIRED must be true for confirmed bed reassignment writes.',
    });
  }

  let sessionUser;
  try { sessionUser = await loadAuthSession(req); } catch (_) { sessionUser = null; }
  if (!sessionUser) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bed_reassign_confirm',
      category: 'bed_reassignment_api',
      success: false, error: 'unauthenticated', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 401, {
      success: false,
      error:   'Authentication required for confirmed bed reassignment.',
    });
  }
  if (!hasRole(sessionUser.role, 'operator')) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bed_reassign_confirm',
      category: 'bed_reassignment_api',
      staff_user_id: sessionUser.staff_user_id, staff_role: sessionUser.role,
      success: false, error: 'insufficient_role', elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, {
      success:      false,
      error:        `Role 'operator' or higher required for bed reassignment.`,
      current_role: sessionUser.role,
    });
  }

  // ── 3. Parse body ───────────────────────────────────────────────────────────
  let body = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug    = String(body.client          || DEFAULT_CLIENT).trim();
  const bookingBedId  = String(body.booking_bed_id  || '').trim();
  const targetBedCode = String(body.target_bed_code || '').trim();
  const reasonRaw     = String(body.reason          || '').trim();
  const confirmFlag   = body.confirm;
  // manual_operator_lock_override: must be an explicit boolean true to activate.
  // Any other value (undefined, false, null, string) is treated as false.
  const overrideRaw   = body.manual_operator_lock_override;
  const overrideFlag  = overrideRaw === true;

  // ── 4. Validate body ────────────────────────────────────────────────────────
  if (SQL_INJECT_RE.test(clientSlug))
    return send400(res, 'invalid client slug');
  if (!bookingBedId)
    return send400(res, 'booking_bed_id is required');
  if (!UUID_VALIDATE_RE.test(bookingBedId))
    return send400(res, 'booking_bed_id must be a valid UUID');
  if (!targetBedCode)
    return send400(res, 'target_bed_code is required');
  if (SQL_INJECT_RE.test(targetBedCode))
    return send400(res, 'invalid target_bed_code');
  if (!reasonRaw)
    return send400(res, 'reason is required and must be non-empty');
  if (SQL_INJECT_RE.test(reasonRaw))
    return send400(res, 'unsafe characters in reason');
  if (confirmFlag !== true)
    return send400(res, 'confirm: true is required in request body');

  const reasonNote    = reasonRaw.slice(0, 500);
  const actorId       = sessionUser.staff_user_id;
  const actorRole     = sessionUser.role;

  // ── 4b. Override role gate ──────────────────────────────────────────────────
  // Operators may NOT use manual_operator_lock_override even if they pass true.
  // This is enforced here at the API layer before the SQL is called.
  if (overrideFlag && !hasRole(actorRole, 'admin')) {
    appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bed_reassign_confirm',
      category: 'bed_reassignment_api',
      client_slug: clientSlug, booking_bed_id: bookingBedId,
      target_bed_code: targetBedCode, staff_user_id: actorId, staff_role: actorRole,
      success: false, error: 'insufficient_override_role',
      manual_operator_lock_override_requested: true,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 403, {
      success:        false,
      error:          'manual_operator_lock_override requires admin or owner role.',
      current_role:   actorRole,
      block_reason:   'insufficient_override_role',
    });
  }

  const auditBase = {
    ts:              new Date().toISOString(),
    intent:          'api:bed_reassign_confirm',
    category:        'bed_reassignment_api',
    client_slug:     clientSlug,
    booking_bed_id:  bookingBedId,
    target_bed_code: targetBedCode,
    staff_user_id:   actorId,
    staff_role:      actorRole,
    manual_operator_lock_override_requested: overrideFlag,
  };

  // ── 5. Look up booking_code ─────────────────────────────────────────────────
  let bookingCode;
  try {
    const lkup = await withPgClient(async (pg) =>
      pg.query(LOOKUP_BOOKING_CODE_SQL, [bookingBedId, clientSlug])
    );
    if (lkup.rows.length === 0) {
      appendAuditLog({ ...auditBase, success: false, error: 'assignment_not_found', elapsed_ms: Date.now() - started });
      return sendJSON(res, 404, {
        success: false,
        error:   'booking_bed_id not found for this client',
      });
    }
    bookingCode = lkup.rows[0].booking_code;
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: 'lookup_failed: ' + err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'booking lookup failed' });
  }

  // ── 6. Execute confirmed reassignment inside transaction ────────────────────
  let resultRow;
  try {
    resultRow = await withPgClient(async (pg) => {
      await pg.query('BEGIN');
      let row;
      try {
        const r = await pg.query(
          reassignBookingBedSql(),
          [
            clientSlug,   // $1 client_slug
            bookingCode,  // $2 booking_code
            bookingBedId, // $3 booking_bed_id (UUID)
            targetBedCode,// $4 target_bed_code
            actorId,      // $5 staff_user_id
            actorRole,    // $6 staff_role
            reasonNote,   // $7 reason_note
            true,         // $8 confirm = TRUE — confirmed write
            overrideFlag, // $9 manual_operator_lock_override (admin/owner only)
          ]
        );
        row = r.rows[0] || null;

        if (!row) {
          await pg.query('ROLLBACK');
          return null;
        }

        const rowsUpdated = Number(row.rows_updated || 0);

        // Blocked by safety gate → rollback, return row for 409 response
        if (row.blocked === true || rowsUpdated === 0) {
          await pg.query('ROLLBACK');
          row._rolled_back = true;
          return row;
        }

        // Unexpected: more than one row updated → safety rollback
        if (rowsUpdated !== 1) {
          await pg.query('ROLLBACK');
          row._safety_violation = true;
          row._rolled_back = true;
          return row;
        }

        // Success: commit
        await pg.query('COMMIT');
        return row;
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
    });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: 'write_failed: ' + err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'bed reassignment write failed' });
  }

  if (!resultRow) {
    appendAuditLog({ ...auditBase, success: false, error: 'no_result_row', elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'no result row returned from helper' });
  }

  const rowsUpdated = Number(resultRow.rows_updated || 0);
  const elapsed     = Date.now() - started;

  // ── 7. Safety violation ─────────────────────────────────────────────────────
  if (resultRow._safety_violation) {
    appendAuditLog({
      ...auditBase, success: false,
      error: 'SAFETY_VIOLATION_rows_updated_not_1', rows_updated: rowsUpdated,
      elapsed_ms: elapsed,
    });
    return sendJSON(res, 500, {
      success:      false,
      error:        `Safety check failed: rows_updated=${rowsUpdated} (expected 1). Transaction rolled back.`,
      rows_updated: rowsUpdated,
    });
  }

  // ── 8. Blocked ──────────────────────────────────────────────────────────────
  if (resultRow.blocked === true) {
    appendAuditLog({
      ...auditBase, success: false,
      blocked: true, block_reason: resultRow.block_reason,
      rows_updated: rowsUpdated,
      manual_operator_lock_override_applied: false,
      elapsed_ms: elapsed,
    });
    return sendJSON(res, 409, {
      success:        false,
      blocked:        true,
      block_reason:   resultRow.block_reason,
      note:           resultRow.block_reason === 'manual_operator_lock'
        ? 'Assignment is manually locked. Use manual_operator_lock_override:true with admin/owner role to bypass.'
        : 'Reassignment blocked — see block_reason.',
      rows_updated:   rowsUpdated,
      old_bed_code:   resultRow.old_bed_code,
      new_bed_code:   resultRow.new_bed_code,
      conflict_count: resultRow.conflict_count,
      manual_operator_lock_override_requested: overrideFlag,
      elapsed_ms:     elapsed,
    });
  }

  // ── 9. Success ──────────────────────────────────────────────────────────────
  const auditPayload = resultRow.audit_payload || {};
  const overrideApplied = !!(auditPayload.manual_operator_lock_override_applied);
  appendAuditLog({
    ...auditBase,
    success:         true,
    rows_updated:    rowsUpdated,
    booking_code:    resultRow.booking_code,
    old_bed_code:    resultRow.old_bed_code,
    new_bed_code:    resultRow.new_bed_code,
    audit_event_id:  resultRow.audit_event_id,
    manual_operator_lock_override_applied: overrideApplied,
    elapsed_ms:      elapsed,
  });

  return sendJSON(res, 200, {
    success:               true,
    action:                'bed_reassignment',
    booking_code:          resultRow.booking_code,
    booking_bed_id:        bookingBedId,
    old_room_code:         resultRow.old_room_code,
    old_bed_code:          resultRow.old_bed_code,
    new_room_code:         resultRow.new_room_code,
    new_bed_code:          resultRow.new_bed_code,
    assignment_start_date: resultRow.assignment_start_date,
    assignment_end_date:   resultRow.assignment_end_date,
    rows_updated:          rowsUpdated,
    audit_event_id:        resultRow.audit_event_id,
    audit_payload:         resultRow.audit_payload,
    rollback_payload:      resultRow.rollback_payload,
    manual_operator_lock_override_requested: overrideFlag,
    manual_operator_lock_override_applied:   overrideApplied,
    elapsed_ms:            elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7.7i — Booking context handler (read-only)
//
// GET /staff/bookings/:bookingCode/context?client=<slug>
//   Returns full booking detail: booking, payments, rooming, conversation,
//   handoff state, and add-on summary for the Cami dashboard drawer.
//
// Safety: SELECT-only. No mutations. Viewer auth minimum. Fully audited.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKING_CONTEXT_RE = /^\/staff\/bookings\/([A-Za-z0-9_\-]+)\/context$/;

/** Stage 8.8.14 — safe when migration 010 not applied yet. */
function isMissingBookingServiceRecordsTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /booking_service_records/.test(msg) && /does not exist|undefined table/i.test(msg);
}

async function loadBookingServiceRecords(pg, clientSlug, bookingCode) {
  try {
    const r = await pg.query(getBookingServiceRecordsQuery(), [clientSlug, bookingCode]);
    return { rows: r.rows, available: true };
  } catch (err) {
    if (isMissingBookingServiceRecordsTable(err)) {
      return { rows: [], available: false };
    }
    throw err;
  }
}

async function handleBookingContext(bookingCode, query, res, user) {
  const started    = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  if (!bookingCode || bookingCode.length > 64 || SQL_INJECT_RE.test(bookingCode)) {
    return send400(res, 'invalid booking code');
  }

  const auditBase = {
    ts:            new Date().toISOString(),
    intent:        'api:booking_context',
    category:      'booking_context_api',
    client_slug:   clientSlug,
    booking_code:  bookingCode,
    staff_user_id: user ? user.staff_user_id : null,
  };

  let bookingRows, paymentRows, roomingRows, convRows, handoffRows, addonRows, metaRows;
  let serviceRecordRows = [];
  let serviceRecordsAvailable = false;
  try {
    [bookingRows, paymentRows, roomingRows, convRows, handoffRows, addonRows, metaRows, serviceRecordRows, serviceRecordsAvailable] =
      await withPgClient(async (pg) => {
        const [b, p, r, c, h, a, m, svc] = await Promise.all([
          pg.query(getBookingDetailQuery(),             [clientSlug, bookingCode]),
          pg.query(getBookingPaymentsQuery(),           [clientSlug, bookingCode]),
          pg.query(getBookingRoomingAssignmentsQuery(), [clientSlug, bookingCode]),
          pg.query(getBookingConversationQuery(),       [clientSlug, bookingCode]),
          pg.query(getBookingHandoffQuery(),            [clientSlug, bookingCode]),
          pg.query(getBookingAddOnSummaryQuery(),       [clientSlug, bookingCode]).catch(() => ({ rows: [] })),
          pg.query(
            `SELECT b.metadata
               FROM bookings b
               INNER JOIN clients c ON c.id = b.client_id
              WHERE c.slug = $1 AND b.booking_code = $2
              LIMIT 1`,
            [clientSlug, bookingCode]
          ),
          loadBookingServiceRecords(pg, clientSlug, bookingCode),
        ]);
        return [b.rows, p.rows, r.rows, c.rows, h.rows, a.rows, m.rows, svc.rows, svc.available];
      });
  } catch (err) {
    appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
    return sendJSON(res, 500, { success: false, error: 'query failed', detail: err.message });
  }

  if (bookingRows.length === 0) {
    appendAuditLog({ ...auditBase, success: false, error: 'not_found', elapsed_ms: Date.now() - started });
    return sendJSON(res, 404, { success: false, error: 'booking not found', booking_code: bookingCode });
  }

  const bk = bookingRows[0];
  const bkMetadata = (metaRows[0] && metaRows[0].metadata) || {};
  const confirmationDraft = bkMetadata.confirmation_draft || null;

  // Payments aggregate
  const totalPaid = paymentRows.reduce((s, r) => s + Number(r.amount_paid_cents || 0), 0);
  const latestStatus = paymentRows.length > 0 ? paymentRows[0].payment_status : null;

  // Rooming
  const assignedRooms = [...new Set(roomingRows.map(r => r.room_code).filter(Boolean))];
  const assignedBeds  = [...new Set(roomingRows.map(r => r.bed_code).filter(Boolean))];

  const elapsed = Date.now() - started;
  appendAuditLog({
    ...auditBase,
    success:          true,
    payment_rows:     paymentRows.length,
    rooming_rows:     roomingRows.length,
    conv_linked:      convRows.length > 0,
    handoff_open:     handoffRows.length > 0,
    addon_rows:       addonRows.length,
    service_records:  serviceRecordRows.length,
    service_records_available: serviceRecordsAvailable,
    elapsed_ms:       elapsed,
  });

  return sendJSON(res, 200, {
    success:      true,
    client_slug:  clientSlug,
    booking_code: bookingCode,
    booking: {
      booking_id:          bk.booking_id,
      booking_code:        bk.booking_code,
      guest_name:          bk.guest_name,
      phone:               bk.phone,
      email:               bk.email,
      guest_count:         bk.guest_count,
      package_code:        bk.package_code,
      check_in:            bk.check_in,
      check_out:           bk.check_out,
      status:              bk.status,
      payment_status:      bk.payment_status,
      assignment_status:   bk.assignment_status,
      requested_room_type: bk.requested_room_type,
      room_preference:     bk.room_preference,
      primary_room_code:   bk.primary_room_code,
      needs_rooming_review:bk.needs_rooming_review,
      rooming_notes:       bk.rooming_notes,
      total_amount_cents:  bk.total_amount_cents,
      deposit_required_cents: bk.deposit_required_cents,
      amount_paid_cents:   bk.amount_paid_cents,
      balance_due_cents:   bk.balance_due_cents,
      metadata:            bkMetadata,
      confirmation_draft:  confirmationDraft,
    },
    payments: {
      rows:                  paymentRows,
      amount_paid_cents:     totalPaid,
      total_amount_cents:    Number(bk.total_amount_cents || 0),
      deposit_required_cents:Number(bk.deposit_required_cents || 0),
      balance_due_cents:     Number(bk.balance_due_cents || 0),
      latest_status:         latestStatus,
    },
    rooming: {
      assignments:       roomingRows,
      assigned_room_codes: assignedRooms,
      assigned_bed_codes:  assignedBeds,
      notes:             bk.rooming_notes || null,
    },
    conversation: convRows.length > 0 ? {
      conversation_id:     convRows[0].conversation_id,
      needs_human:         convRows[0].needs_human,
      bot_mode:            convRows[0].bot_mode,
      pending_action:      convRows[0].pending_action,
      conversation_status: convRows[0].conversation_status,
      last_message_preview:convRows[0].last_message_preview,
    } : null,
    handoff: handoffRows.length > 0 ? {
      handoff_id:    handoffRows[0].handoff_id,
      reason_code:   handoffRows[0].reason_code,
      priority:      handoffRows[0].priority,
      status:        handoffRows[0].status,
      assigned_staff:handoffRows[0].assigned_staff,
      opened_at:     handoffRows[0].opened_at,
    } : null,
    addons: {
      rows: addonRows,
      note: addonRows.length === 0
        ? 'No add-on orders found for this booking'
        : null,
    },
    service_records: serviceRecordRows,
    service_records_available: serviceRecordsAvailable,
    warnings: [],
    elapsed_ms: elapsed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Request router
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Browser redirect helper for /staff/ui (Stage 7.3e)
// Returns true if a redirect was sent, false otherwise.
// Only redirects browser requests (no Accept: application/json).
// ─────────────────────────────────────────────────────────────────────────────
async function browserLoginRedirect(req, res) {
  if (!STAFF_AUTH_REQUIRED) return false;
  const accept = req.headers['accept'] || '';
  if (accept.includes('application/json')) return false;
  let session;
  try { session = await loadAuthSession(req); } catch (_) { session = null; }
  if (!session) {
    res.writeHead(302, { Location: '/staff/login', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  return false;
}

async function router(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const method   = req.method.toUpperCase();

  // ── POST /staff/auth/login  (Stage 7.2c — session auth) ──────────────────
  if (pathname === '/staff/auth/login') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST' }));
    }
    return handleLogin(req, res);
  }

  // ── POST /staff/auth/logout  (Stage 7.2c — session revocation) ───────────
  if (pathname === '/staff/auth/logout') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST' }));
    }
    return handleLogout(req, res);
  }

  // ── POST /staff/handoff/:id/resolve (Stage 6.9 — write endpoint) ──────────
  const writeMatch = WRITE_HANDOFF_RE.exec(pathname);
  if (writeMatch) {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for write endpoint' }));
    }
    return handleResolveHandoff(writeMatch[1], req, res);
  }

  // ── Stage 7.7k5 — Bed reassignment confirmed write ───────────────────────
  if (pathname === '/staff/bed-calendar/reassign/confirm') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for reassign/confirm' }));
    }
    return handleBedReassignConfirm(req, res);
  }

  // ── Stage 8.3h — Manual booking preview (read-only, no writes) ───────────
  // POST accepted to carry the JSON payload; this route NEVER writes.
  // Does NOT require STAFF_ACTIONS_ENABLED or MANUAL_BOOKING_ENABLED.
  if (pathname === '/staff/manual-bookings/preview') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for manual-bookings/preview' }));
    }
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handleManualBookingPreview(req, res, auth.user);
  }

  // ── Stage 8.4 — Manual booking creation (write; gated by MANUAL_BOOKING_ENABLED) ──
  if (pathname === '/staff/manual-bookings/create') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for manual-bookings/create' }));
    }
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handleManualBookingCreate(req, res, auth.user);
  }

  // ── Stage 8.4.11 — Stripe webhook payment truth ───────────────────────────
  // POST /staff/stripe/webhook
  // No session auth — identity via Stripe HMAC signature (or SKIP_VERIFY for local dev).
  if (pathname === '/staff/stripe/webhook') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for stripe/webhook' }));
    }
    return handleStripeWebhook(req, res);
  }

  // ── Stage 8.8.23 — addon_service payment link for service records ───────────
  const svcPayMatch = BOOKING_SERVICE_RECORDS_PAYMENT_LINK_RE.exec(pathname);
  if (svcPayMatch) {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({
        success: false,
        error: 'Method not allowed — use POST for service-records/create-payment-link',
      }));
    }
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handleBookingServiceRecordsCreatePaymentLink(svcPayMatch[1], req, res, auth.user);
  }

  // ── Stage 8.4.9 — Stripe checkout link from draft payment ────────────────
  // POST /staff/payments/:payment_id/create-stripe-link
  // Gated by STAFF_ACTIONS_ENABLED + STRIPE_LINKS_ENABLED + STRIPE_SECRET_KEY.
  const stripeMatch = PAYMENT_STRIPE_LINK_RE.exec(pathname);
  if (stripeMatch) {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for create-stripe-link' }));
    }
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handlePaymentCreateStripeLink(stripeMatch[1], req, res, auth.user);
  }

  // ── Stage 8.5.2 — Luna bot booking preview (pure read-only, no DB writes) ──
  // POST to carry JSON payload. No DB writes, no Stripe, no WhatsApp, no n8n.
  // Does NOT require STAFF_ACTIONS_ENABLED or MANUAL_BOOKING_ENABLED.
  // Stage 8.5.3: requireBotAuth — accepts bot token OR normal staff session.
  //   Token: X-Luna-Bot-Token header or Authorization: Bearer header.
  //   Token auth ONLY applies to /staff/bot/* routes.
  if (pathname === '/staff/bot/booking-preview') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/booking-preview' }));
    }
    const auth = await requireBotAuth(req, res);
    if (!auth.ok) return;
    return handleBotBookingPreview(req, res, auth.user, auth.auth_mode);
  }

  // ── Stage 8.5.8 — Luna bot availability check (read-only, no writes) ────────
  // POST /staff/bot/availability-check
  // Returns available bed_codes for guest_count from Postgres — no writes.
  // Closes Stage 8.5.7 selected_bed_codes gap.
  if (pathname === '/staff/bot/availability-check') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/availability-check' }));
    }
    const auth = await requireBotAuth(req, res);
    if (!auth.ok) return;
    return handleBotAvailabilityCheck(req, res, auth.user, auth.auth_mode);
  }

  // ── Stage 8.8.25 — Luna bot guest add-on request preview (dry-run) ─────────
  // POST /staff/bot/addon-request-preview
  // Validates booking/service/date/qty; returns previews only — no writes.
  if (pathname === '/staff/bot/addon-request-preview') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/addon-request-preview' }));
    }
    const auth = await requireBotAuth(req, res);
    if (!auth.ok) return;
    return handleBotAddonRequestPreview(req, res, auth.user, auth.auth_mode);
  }

  // ── Stage 8.8.27 — Luna bot guest add-on create (service row + payment + Stripe) ──
  // POST /staff/bot/addon-requests/create
  if (pathname === '/staff/bot/addon-requests/create') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/addon-requests/create' }));
    }
    const auth = await requireBotAuth(req, res);
    if (!auth.ok) return;
    return handleBotAddonRequestCreate(req, res, auth.user, auth.auth_mode);
  }

  // ── Phase 9.4b — Luna guest bot pause/resume (bot_pause_states SoT) ─────────
  // GET pause-state: read-only; defaults active when table missing.
  // POST pause/resume: gated by BOT_PAUSE_CONTROLS_ENABLED (default OFF).
  // Staff session auth (operator+ for writes). Does NOT touch conversations.bot_mode.
  if (pathname === '/staff/bot/pause-state') {
    if (method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use GET for bot/pause-state' }));
    }
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleBotPauseStateGet(parsed.query, res, auth.user);
  }

  if (pathname === '/staff/bot/pause') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/pause' }));
    }
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handleBotPausePost(req, res, auth.user);
  }

  if (pathname === '/staff/bot/resume') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/resume' }));
    }
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handleBotResumePost(req, res, auth.user);
  }

  // ── Stage 8.5.4 — Luna bot booking create (shared engine, BOT_BOOKING_ENABLED gate) ──
  // POST — creates booking + booking_beds + draft payment via shared SQL/quote path.
  // No Stripe. No WhatsApp. No n8n. Bot token auth (requireBotAuth).
  // BOT_BOOKING_ENABLED=false by default → 403.
  if (pathname === '/staff/bot/bookings/create') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/bookings/create' }));
    }
    const auth = await requireBotAuth(req, res);
    if (!auth.ok) return;
    return handleBotBookingCreate(req, res, auth.user, auth.auth_mode);
  }

  // ── Stage 8.5.5 — Luna bot Stripe link from draft payment ─────────────────
  // POST /staff/bot/payments/:payment_id/create-stripe-link
  // Gated by BOT_BOOKING_ENABLED + STRIPE_LINKS_ENABLED.
  // Creates Stripe Checkout Session; does NOT mark paid; no WhatsApp; no n8n.
  const botStripeMatch = BOT_PAYMENT_STRIPE_LINK_RE.exec(pathname);
  if (botStripeMatch) {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for bot/payments/create-stripe-link' }));
    }
    const auth = await requireBotAuth(req, res);
    if (!auth.ok) return;
    return handleBotPaymentCreateStripeLink(botStripeMatch[1], req, res, auth.user, auth.auth_mode);
  }

  // ── Stage 8.4.4 — Quote preview (pure, no DB, no writes) ─────────────────
  // POST to carry JSON payload; never touches DB, Stripe, or any external service.
  // Does NOT require STAFF_ACTIONS_ENABLED or MANUAL_BOOKING_ENABLED.
  if (pathname === '/staff/quote-preview') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for quote-preview' }));
    }
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleQuotePreview(req, res, auth.user);
  }

  // ── Stage 8.6.1 — Staff Ask Luna (read-only operational query via text) ───
  // POST with JSON body — must be before the GET-only guard below.
  if (pathname === '/staff/ask-luna') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use POST for ask-luna' }));
    }
    return handleAskLuna(req, res);
  }

  // ── All other routes: GET only ────────────────────────────────────────────

  // ── All other routes: GET only ────────────────────────────────────────────
  if (method !== 'GET') {
    return send405(res);
  }

  // ── Stage 7.7f — Handoff queue (read-only) ────────────────────────────────
  if (pathname === '/staff/handoffs') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleHandoffQueue(parsed.query, res, auth.user);
  }

  // ── Stage 7.7g — Bed calendar (read-only) ─────────────────────────────────
  if (pathname === '/staff/bed-calendar') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleBedCalendar(parsed.query, res, auth.user);
  }

  // ── Stage 7.7k3 — Bed reassignment preview (proposal-only, no write) ───────
  // Requires operator/admin/owner — viewer gets 403 when STAFF_AUTH_REQUIRED=true.
  if (pathname === '/staff/bed-calendar/reassign/preview') {
    const auth = await requireAuth(req, res, 'operator');
    if (!auth.ok) return;
    return handleBedReassignPreview(parsed.query, res, auth.user);
  }

  // ── Stage 7.7i — Booking context drawer (read-only) ───────────────────────
  const bookingCtxMatch = BOOKING_CONTEXT_RE.exec(pathname);
  if (bookingCtxMatch) {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleBookingContext(bookingCtxMatch[1], parsed.query, res, auth.user);
  }

  // ── GET /staff/login  (Stage 7.3e — Luna Front Desk login page) ─────────────
  if (pathname === '/staff/login') {
    if (method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      return res.end(JSON.stringify({ success: false, error: 'Method not allowed — use GET' }));
    }
    return handleLoginPage(res);
  }

  if (pathname === '/staff/ui') {
    if (await browserLoginRedirect(req, res)) return;
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleUI(res, PORT);
  }

  if (pathname === '/staff/intents') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleIntents(res);
  }

  if (pathname === '/staff/query') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleQuery(parsed.query, res);
  }

  if (pathname === '/staff/conversations') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleConversationInbox(parsed.query, res, auth.user);
  }

  const convSubMatch = CONV_SUB_RE.exec(pathname);
  if (convSubMatch) {
    const [, convId, sub] = convSubMatch;
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    switch (sub) {
      case 'messages':    return handleConversationMessages(convId, parsed.query, res, auth.user);
      case 'context':     return handleConversationContext(convId, parsed.query, res, auth.user);
      case 'draft':       return handleConversationDraft(convId, parsed.query, res, auth.user);
      case 'staff-state': return handleConversationStaffState(convId, parsed.query, res, auth.user);
      default:            return send404(res);
    }
  }

  const convIdMatch = CONV_ID_RE.exec(pathname);
  if (convIdMatch) {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleConversationDetail(convIdMatch[1], parsed.query, res, auth.user);
  }

  if (pathname === '/healthz' || pathname === '/') {
    return sendJSON(res, 200, {
      status:       'ok',
      service:      'wolfhouse-staff-query-api',
      stage:        '7.7b',
      auth_enabled: STAFF_AUTH_REQUIRED,
      note:         'read-only staff API + UI + conversation endpoints (shadow-mode review)',
    });
  }

  return send404(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (err) {
    // Do not expose stack trace to client
    sendJSON(res, 500, { success: false, error: 'internal server error' });
  }
});

server.listen(PORT, process.env.STAFF_QUERY_API_HOST || '127.0.0.1', () => {
  console.log(`\nWolfhouse staff query API + UI (Stage 7.7b) running on http://${process.env.STAFF_QUERY_API_HOST || '127.0.0.1'}:${PORT}`);
  console.log(`  Auth: ${STAFF_AUTH_REQUIRED ? 'REQUIRED (session cookie)' : 'OPTIONAL (STAFF_AUTH_REQUIRED=false — local/dev open mode)'}`);
  console.log(`  Write actions: ${STAFF_ACTIONS_ENABLED ? 'ENABLED (STAFF_ACTIONS_ENABLED=true)' : 'DISABLED'}`);
  console.log('  Endpoints:');
  console.log(`    POST http://127.0.0.1:${PORT}/staff/auth/login    <- login`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/auth/logout   <- revoke session`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/ui            <- read-only query UI`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/intents`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/query?intent=...`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/conversations  <- inbox (Stage 7.7b)`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/conversations/:id`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/conversations/:id/messages`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/conversations/:id/context`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/conversations/:id/draft`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/conversations/:id/staff-state`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/manual-bookings/preview   <- 8.3h read-only preview (no writes)`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/manual-bookings/create    <- 8.4 PROVISIONAL stub (${MANUAL_BOOKING_ENABLED ? 'ENABLED — pricing engine prerequisite NOT met' : 'DISABLED — not wired to UI; do not enable until pricing engine exists'})`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/quote-preview             <- 8.4.4 pure quote preview (no DB, no writes)`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/availability-check      <- 8.5.8 Luna bot availability check (read-only, no writes)`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/addon-request-preview  <- 8.8.25 Luna bot guest add-on preview (dry-run, no writes)`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/addon-requests/create   <- 8.8.27 Luna bot guest add-on create (${BOT_ADDON_REQUESTS_ENABLED && STRIPE_LINKS_ENABLED ? 'ENABLED' : 'DISABLED — needs BOT_ADDON_REQUESTS_ENABLED+STRIPE_LINKS_ENABLED'})`);
  console.log(`    GET  http://127.0.0.1:${PORT}/staff/bot/pause-state            <- 9.4b Luna guest pause lookup (read-only; table may be missing)`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/pause                  <- 9.4b Luna guest pause write (${BOT_PAUSE_CONTROLS_ENABLED ? 'ENABLED' : 'DISABLED — set BOT_PAUSE_CONTROLS_ENABLED=true'})`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/resume                 <- 9.4b Luna guest resume write (${BOT_PAUSE_CONTROLS_ENABLED ? 'ENABLED' : 'DISABLED — set BOT_PAUSE_CONTROLS_ENABLED=true'})`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/ask-luna                  <- 8.6.1 Staff Ask Luna (session or allowlisted phone, read-only)`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/booking-preview      <- 8.5.2 Luna bot booking preview (no DB, no writes)`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/bookings/create      <- 8.5.4 Luna bot booking create (${BOT_BOOKING_ENABLED ? 'ENABLED' : 'DISABLED — set BOT_BOOKING_ENABLED=true'})`);
  console.log(`    POST http://127.0.0.1:${PORT}/staff/bot/payments/:id/create-stripe-link <- 8.5.5 Luna bot Stripe link (${BOT_BOOKING_ENABLED && STRIPE_LINKS_ENABLED ? 'ENABLED' : 'DISABLED — needs BOT_BOOKING_ENABLED+STRIPE_LINKS_ENABLED'})`);
  if (STAFF_ACTIONS_ENABLED) {
    console.log(`    POST http://127.0.0.1:${PORT}/staff/handoff/:id/resolve`);
    console.log(`         <- ${STAFF_AUTH_REQUIRED ? 'requires session with role operator/admin' : 'requires x-staff-operator-token header (local/dev)'}`);
  }
  console.log('\nCtrl+C to stop.\n');
});

server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});
