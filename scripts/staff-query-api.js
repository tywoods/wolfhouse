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
} = require('./lib/staff-booking-detail-queries');
const {
  reassignBookingBedSql,
} = require('./lib/staff-bed-reassignment-sql');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT               = parseInt(process.env.STAFF_QUERY_API_PORT || '3036', 10);
const DEFAULT_CLIENT     = 'wolfhouse-somo';
const MAX_ROWS           = 500;
const LOG_DIR            = path.join(__dirname, '..', 'logs');
const LOG_FILE           = path.join(LOG_DIR, 'staff-query-log.jsonl');

// Write endpoint config — disabled unless explicitly enabled
const STAFF_ACTIONS_ENABLED = process.env.STAFF_ACTIONS_ENABLED === 'true';
const STAFF_OPERATOR_TOKEN  = process.env.STAFF_OPERATOR_TOKEN || '';

// Only handoff.resolve is allowed in v1
const WRITE_ACTION_ALLOWLIST = ['handoff.resolve'];

// Matches: /staff/handoff/<uuid>/resolve
const WRITE_HANDOFF_RE = /^\/staff\/handoff\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resolve$/i;

// Stage 7.7b — conversation route regexes (read-only GET)
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
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
// Route: POST /staff/handoff/:id/resolve  (Stage 6.9 — token-gated write)
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
/* ── Inbox table ─────────────────────────────────────────────────────────── */
.inbox-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
.inbox-table th{background:var(--surface-soft);text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);font-weight:700;white-space:nowrap;font-size:10.5px;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em}
.inbox-table td{padding:11px 12px;border-bottom:1px solid var(--border-soft);vertical-align:middle;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inbox-table tr{transition:background .14s}
.inbox-table tr:hover td{background:var(--surface-soft);cursor:pointer}
.inbox-table tr.selected td{background:var(--teal)}
.guest-name{font-weight:600;color:var(--text)}
.phone-cell{color:var(--text-2);font-size:11.5px}
.preview-cell{color:var(--text-3);font-size:11.5px;max-width:280px}
.ts-cell{color:var(--text-3);font-size:11px;white-space:nowrap}
/* ── Detail pane ─────────────────────────────────────────────────────────── */
#conv-detail{display:none}
#conv-detail.visible{display:block}
.detail-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
.detail-name{font-size:18px;font-weight:700;color:var(--text);letter-spacing:.01em}
.detail-meta{font-size:12px;color:var(--text-2);margin-top:4px}
.detail-section{margin-top:18px;padding-top:18px;border-top:1px solid var(--border-soft)}
.detail-section h3{font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.kv{display:flex;flex-direction:column;gap:3px}
.kv .k{font-size:10.5px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.kv .v{font-size:13px;color:var(--text);font-weight:500}
.back-btn{background:none;border:none;color:var(--primary);cursor:pointer;font-size:13px;font-weight:600;padding:0;margin-bottom:14px;transition:color .15s}
.back-btn:hover{color:var(--primary-hover);text-decoration:underline}
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
/* ── Conversations sub-tabs ──────────────────────────────────────────────── */
#conv-subtabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:20px;background:transparent;padding:0 4px}
.sub-tab{padding:11px 18px;font-size:12.5px;font-weight:600;color:var(--text-2);border:none;border-bottom:3px solid transparent;background:none;cursor:pointer;margin-bottom:-1px;transition:color .15s,border-color .15s}
.sub-tab:hover{color:var(--text)}
.sub-tab.active{color:var(--primary);border-bottom-color:var(--sage)}
.sub-tab .hq-count{background:#9C5742;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:var(--radius-pill);margin-left:6px;display:none}
.sub-tab .hq-count.visible{display:inline}
.sub-panel{display:none}
.sub-panel.active{display:block}
/* ── Handoff queue ───────────────────────────────────────────────────────── */
.hq-note{font-size:11.5px;color:#A2743D;background:#F8F0E2;border:1px solid #ECDCC4;border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:14px;line-height:1.5}
.hq-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
.hq-table th{background:var(--surface-soft);text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);font-weight:700;white-space:nowrap;font-size:10.5px;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em}
.hq-table td{padding:10px 12px;border-bottom:1px solid var(--border-soft);vertical-align:middle;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hq-table tr{transition:background .14s}
.hq-table tr:hover td{background:var(--surface-soft);cursor:pointer}
.hq-table tr.selected td{background:#F5E6D2}
.hq-ro-label{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:var(--text-2);background:var(--sand);padding:3px 9px;border-radius:var(--radius-pill);margin-left:8px}
.since{font-size:11px;color:#A2743D;font-weight:600}
.since.stale{color:#9C5742}
/* ── Sidebar cards ───────────────────────────────────────────────────────── */
.sidebar-card{background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:14px}
.sidebar-card h3{font-size:10.5px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px}
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
.bc-block{height:24px;border-radius:7px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:3px;transition:filter .15s,box-shadow .15s;box-shadow:var(--shadow-soft)}
.bc-block:hover{filter:brightness(.97);box-shadow:0 2px 8px rgba(68,80,74,.12)}
.bc-block-confirmed{background:#DCEAD2;color:#5C7350;border-left:3px solid #AFC3A3}
.bc-block-hold{background:#F2E7D3;color:#8A6F4F;border-left:3px solid #DCC8B7}
.bc-block-payment_pending{background:#DDE7EC;color:#566F7C;border-left:3px solid #95B4C7}
.bc-block-needs_review{background:#F5E6D2;color:#A2743D;border-left:3px solid #E3B981}
.bc-block-cancelled{background:#E8E5DE;color:#83897F;border-left:3px solid #C9C5BB;text-decoration:line-through}
.bc-block-conflict{background:#EFD9D0;color:#9C5742;border-left:3px solid #C98B76}
.bc-marker{font-size:9px;font-weight:700;opacity:.85;margin-right:2px}
.bc-summary-strip{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--text-2);padding:10px 0 12px;border-bottom:1px solid var(--border-soft);margin-bottom:14px}
.bc-summary-strip b{color:var(--text)}
.bc-detail-note{font-size:11px;color:#A2743D;background:#F8F0E2;border:1px solid #ECDCC4;border-radius:var(--radius-sm);padding:9px 14px;margin-top:14px}
/* ── Booking context drawer (Stage 7.7i) ─────────────────────────────────── */
.ctx-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft)}
.ctx-section h3{font-size:10.5px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.ctx-loading{color:var(--text-3);font-size:12px;font-style:italic;padding:10px 0}
.ctx-none{color:var(--text-3);font-size:12px;font-style:italic}
.btn-open-conv{background:var(--olive);color:#fff;border:none;border-radius:var(--radius-sm);padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:background .18s}
.btn-open-conv:hover{background:#7C9079}
</style>
</head>
<body>

<!-- ── Top banner ─────────────────────────────────────────────────────────── -->
<div id="banner">
  <a href="/staff/ui" class="brand" style="text-decoration:none;color:inherit;">Luna Front Desk</a>
  <span class="badge-sm">Stage 7.7j</span>
  <span class="badge">READ-ONLY &bull; SHADOW MODE</span>
  <button class="btn-logout" id="btn-logout" onclick="doLogout()">Sign out</button>
</div>

<!-- ── Tabs ───────────────────────────────────────────────────────────────── -->
<div id="tabs">
  <button class="tab-btn active" data-tab="conversations">Conversations</button>
  <button class="tab-btn" data-tab="bed-calendar">Bed Calendar</button>
  <button class="tab-btn" data-tab="query-tools">Query Tools</button>
</div>

<!-- ── Conversations tab ──────────────────────────────────────────────────── -->
<div id="tab-conversations" class="tab-panel active">
<div id="wrap">

  <!-- Conversations sub-tab nav -->
  <div id="conv-subtabs">
    <button class="sub-tab active" data-subtab="inbox">Inbox</button>
    <button class="sub-tab" data-subtab="handoffs">Needs Human <span class="hq-count" id="hq-badge">0</span></button>
  </div>

  <!-- Sub-panel: Inbox -->
  <div class="sub-panel active" id="subtab-inbox">

  <!-- Inbox card -->
  <div class="card" id="inbox-card">
    <div class="toolbar">
      <h2>Conversation Inbox</h2>
      <span id="inbox-count" style="font-size:12px;color:#9aabb8"></span>
      <button class="btn btn-primary" id="btn-refresh">&#8635; Refresh</button>
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#5a6a85">
        Company
        <input id="c-client" value="wolfhouse-somo" style="min-width:160px;font-size:12px;padding:5px 8px">
      </label>
    </div>
    <div id="inbox-state" class="state-msg">Loading conversations&hellip;</div>
    <div id="inbox-table-wrap" style="display:none;overflow-x:auto">
      <table class="inbox-table">
        <thead>
          <tr>
            <th>Guest</th>
            <th>Phone</th>
            <th>Lang</th>
            <th>Status / Mode</th>
            <th>Handoff</th>
            <th>Booking</th>
            <th>Latest message</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody id="inbox-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- Conversation detail pane (shown when row is clicked) -->
  <div class="card" id="conv-detail">
    <button class="back-btn" id="btn-back">&#8592; Back to inbox</button>
    <div id="detail-content">
      <div class="state-msg">Loading&hellip;</div>
    </div>
  </div>

  </div><!-- /subtab-inbox -->

  <!-- Sub-panel: Handoff queue -->
  <div class="sub-panel" id="subtab-handoffs">
  <div class="card" id="handoff-card">
    <div class="toolbar">
      <h2>Needs Human &mdash; Handoff Queue <span class="hq-ro-label">READ-ONLY HANDOFF QUEUE</span></h2>
      <span id="hq-count-txt" style="font-size:12px;color:#9aabb8"></span>
      <button class="btn btn-primary" id="btn-refresh-hq">&#8635; Refresh</button>
    </div>
    <div class="hq-note">Resolve actions are disabled in the UI until production auth/TLS and write gates are approved. This is a read-only view only.</div>
    <div id="hq-state" class="state-msg">Loading&hellip;</div>
    <div id="hq-table-wrap" style="display:none;overflow-x:auto">
      <table class="hq-table">
        <thead>
          <tr>
            <th>Priority</th>
            <th>Guest</th>
            <th>Phone</th>
            <th>Reason</th>
            <th>Status</th>
            <th>Assigned</th>
            <th>Booking</th>
            <th>Opened</th>
            <th>Since opened</th>
          </tr>
        </thead>
        <tbody id="hq-tbody"></tbody>
      </table>
    </div>
  </div>
  </div><!-- /subtab-handoffs -->

</div><!-- /wrap -->
</div><!-- /tab-conversations -->

<!-- ── Query Tools tab ────────────────────────────────────────────────────── -->
<div id="tab-query-tools" class="tab-panel">
<div id="wrap-q" style="max-width:1100px;margin:0 auto;padding:20px 16px">
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
        Start&nbsp;<input id="bc-start" type="text" value="2026-07-16" placeholder="YYYY-MM-DD" style="min-width:110px;font-size:12px;padding:5px 8px">
      </label>
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#5a6a85;margin-bottom:0">
        End&nbsp;<input id="bc-end" type="text" value="2026-07-23" placeholder="YYYY-MM-DD" style="min-width:110px;font-size:12px;padding:5px 8px">
      </label>
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#5a6a85;margin-bottom:0">
        Company&nbsp;<input id="bc-client" value="wolfhouse-somo" style="min-width:140px;font-size:12px;padding:5px 8px">
      </label>
      <button class="btn btn-primary" id="bc-load">&#128197; Load Calendar</button>
    </div>

    <!-- Summary strip -->
    <div class="bc-summary-strip" id="bc-summary" style="display:none">
      <span><b id="bc-rooms-count">0 rooms</b></span>
      <span><b id="bc-beds-count">0 beds</b></span>
      <span><b id="bc-blocks-count">0 blocks</b></span>
    </div>

    <!-- Warnings -->
    <div id="bc-warnings" style="display:none;font-size:12px;color:#9C5742;background:#F6E7E1;border:1px solid #E6C7BC;border-radius:10px;padding:10px 14px;margin-bottom:12px"></div>

    <!-- State message -->
    <div id="bc-state" class="state-msg">Select a date range and click Load Calendar.</div>

    <!-- Grid -->
    <div id="bc-grid-wrap" style="display:none;overflow-x:auto;overflow-y:auto;max-height:600px;border:1px solid #EFE8DC;border-radius:12px"></div>
  </div>

  <!-- Block detail panel (read-only) -->
  <div class="card" id="bc-detail" style="display:none"></div>

</div>
</div><!-- /tab-bed-calendar -->

<script>
(function(){
'use strict';

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function el(id){ return document.getElementById(id); }
function escHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

/* ── Tabs ─────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(function(btn){
  btn.addEventListener('click', function(){
    const target = this.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
    this.classList.add('active');
    el('tab-' + target).classList.add('active');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CONVERSATIONS TAB — inbox + detail
   ═══════════════════════════════════════════════════════════════════════════ */

var selectedConvId = null;

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

/* Render inbox rows */
function renderInbox(convs){
  var tbody = el('inbox-tbody');
  if (!convs || convs.length === 0){
    el('inbox-state').textContent = 'No active conversations.';
    el('inbox-state').classList.remove('error');
    el('inbox-state').style.display = 'block';
    el('inbox-table-wrap').style.display = 'none';
    el('inbox-count').textContent = '';
    return;
  }
  el('inbox-state').style.display = 'none';
  el('inbox-table-wrap').style.display = 'block';
  el('inbox-count').textContent = convs.length + ' conversation' + (convs.length===1?'':'s');

  var rows = convs.map(function(c){
    return '<tr data-id="' + escHtml(c.conversation_id) + '">' +
      '<td><span class="guest-name">' + escHtml(c.guest_name || '—') + '</span>' +
        '<br>' + priorityPill(c) + '</td>' +
      '<td class="phone-cell">' + escHtml(c.phone) + '</td>' +
      '<td>' + escHtml(c.language || '—') + '</td>' +
      '<td>' + modePill(c.bot_mode) + '</td>' +
      '<td>' + escHtml(c.handoff_reason || (c.handoff_status ? c.handoff_status : '—')) + '</td>' +
      '<td>' + escHtml(c.booking_code || '—') + '</td>' +
      '<td class="preview-cell">' + escHtml((c.last_message_preview || '').slice(0,80)) + '</td>' +
      '<td class="ts-cell">' + fmtTs(c.last_activity) + '</td>' +
    '</tr>';
  }).join('');
  tbody.innerHTML = rows;

  /* Row click → detail */
  tbody.querySelectorAll('tr').forEach(function(row){
    row.addEventListener('click', function(){
      tbody.querySelectorAll('tr').forEach(function(r){ r.classList.remove('selected'); });
      this.classList.add('selected');
      loadConvDetail(this.dataset.id);
    });
  });
}

/* Load inbox */
function loadInbox(){
  el('inbox-state').textContent = 'Loading conversations\u2026';
  el('inbox-state').classList.remove('error');
  el('inbox-state').style.display = 'block';
  el('inbox-table-wrap').style.display = 'none';
  el('inbox-count').textContent = '';
  el('conv-detail').classList.remove('visible');
  selectedConvId = null;

  fetch('/staff/conversations?client=' + encodeURIComponent(getClient()))
    .then(function(r){
      if (r.status === 401){
        el('inbox-state').innerHTML = '\u26a0 Authentication required &mdash; <strong>POST /staff/auth/login</strong> first.';
        el('inbox-state').classList.add('error');
        el('inbox-table-wrap').style.display = 'none';
        return null;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (!data) return;
      if (!data.success) throw new Error(data.error || 'API error');
      renderInbox(data.conversations);
    })
    .catch(function(err){
      el('inbox-state').textContent = 'Error loading inbox: ' + err.message;
      el('inbox-state').classList.add('error');
      el('inbox-state').style.display = 'block';
      el('inbox-table-wrap').style.display = 'none';
    });
}

/* Load conversation detail — Stage 7.7d: fetches all 5 sub-endpoints */
function loadConvDetail(convId){
  selectedConvId = convId;
  el('conv-detail').classList.add('visible');
  el('detail-content').innerHTML = '<div class="state-msg">Loading\u2026</div>';

  var base = '/staff/conversations/' + encodeURIComponent(convId);
  var qs   = '?client=' + encodeURIComponent(getClient());

  function gjson(path){ return fetch(path).then(function(r){ return r.json(); }); }

  Promise.all([
    gjson(base + qs),
    gjson(base + '/messages' + qs),
    gjson(base + '/context'  + qs),
    gjson(base + '/draft'    + qs),
    gjson(base + '/staff-state' + qs),
  ]).then(function(results){
    var detailData = results[0];
    var msgsData   = results[1];
    var ctxData    = results[2];
    var draftData  = results[3];
    var stateData  = results[4];

    if (!detailData.success) throw new Error(detailData.error || 'detail error');

    var c     = detailData.conversation;
    var msgs  = (msgsData.success  && msgsData.messages)  ? msgsData.messages  : [];
    var ctx   = (ctxData.success   && ctxData.context)    ? ctxData.context    : null;
    var draft = (draftData.success && draftData.draft)     ? draftData.draft    : null;
    var state = (stateData.success && stateData.state)     ? stateData.state    : null;

    /* ── Header ── */
    var html = '<div class="detail-header">';
    html +=   '<div>';
    html +=     '<div class="detail-name">' + escHtml(c.guest_name || c.phone) + '</div>';
    html +=     '<div class="detail-meta">' + escHtml(c.phone) +
                (c.language ? ' &bull; ' + escHtml(c.language) : '') +
                ' &bull; Stage: ' + escHtml(c.conversation_stage || '—') + '</div>';
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

    /* Message thread */
    html += '<div class="thread-section">';
    html +=   '<h3>Message thread <span style="font-weight:400;font-size:10px;color:#9aabb8">' +
              msgs.length + ' message' + (msgs.length===1?'':'s') + '</span></h3>';
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
        if (m.route) html += ' &bull; ' + escHtml(m.route);
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

    /* Bot / staff state card */
    var ss = state || {};
    html += '<div class="sidebar-card">';
    html +=   '<h3>Bot state</h3>';
    html +=   '<div class="kv2">';
    html +=     kv('Mode',        ss.bot_mode   || c.bot_mode) +
                kv('Needs human', ss.needs_human != null ? String(ss.needs_human) : String(c.needs_human)) +
                kv('Pending',     ss.pending_action || c.pending_action || '—') +
                kv('Last reply',  fmtTs(ss.last_staff_reply_at || c.last_staff_reply_at) || '—');
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

    /* Booking + payment context card */
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
                kv('Check-in',    bctx.check_in) +
                kv('Check-out',   bctx.check_out) +
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

    el('detail-content').innerHTML = html;

    /* Wire copy button after DOM update */
    var copyBtn   = document.getElementById('btn-copy-draft');
    var confirmEl = document.getElementById('copy-confirm');
    var textaEl   = document.getElementById('draft-textarea');
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
    var threadEl = document.getElementById('thread-container');
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
  })
  .catch(function(err){
    el('detail-content').innerHTML = '<div class="state-msg error">Error loading conversation: ' + escHtml(err.message) + '</div>';
  });
}

function kv(label, val){
  return '<div class="kv"><span class="k">' + escHtml(label) + '</span><span class="v">' + escHtml(val==null?'—':String(val)) + '</span></div>';
}

/* Back button */
el('btn-back').addEventListener('click', function(){
  el('conv-detail').classList.remove('visible');
  el('inbox-tbody').querySelectorAll('tr').forEach(function(r){ r.classList.remove('selected'); });
  selectedConvId = null;
});

/* Refresh button */
el('btn-refresh').addEventListener('click', loadInbox);

/* Auto-load inbox on page load */
loadInbox();

/* ── Conversations sub-tabs ───────────────────────────────────────────────── */
document.querySelectorAll('.sub-tab').forEach(function(btn){
  btn.addEventListener('click', function(){
    document.querySelectorAll('.sub-tab').forEach(function(b){ b.classList.remove('active'); });
    document.querySelectorAll('.sub-panel').forEach(function(p){ p.classList.remove('active'); });
    this.classList.add('active');
    el('subtab-' + this.dataset.subtab).classList.add('active');
    if (this.dataset.subtab === 'handoffs' && !hqLoaded) loadHandoffQueue();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   HANDOFF QUEUE — Stage 7.7f
   Fetches GET /staff/handoffs (open + needs_human_without_handoff rows).
   Row click → opens linked conversation detail in Inbox sub-tab.
   NO resolve button. NO write actions.
   ═══════════════════════════════════════════════════════════════════════════ */

var hqLoaded = false;

/* Relative time with "stale" threshold */
function timeSince(ts){
  if (!ts) return '—';
  try {
    var ms = Date.now() - new Date(ts).getTime();
    var h = Math.floor(ms/3600000);
    var m = Math.floor((ms%3600000)/60000);
    if (h >= 24) return Math.floor(h/24) + 'd ' + (h%24) + 'h';
    if (h >= 1)  return h + 'h ' + m + 'm';
    return m + 'm';
  } catch(_){ return '?'; }
}
function isStale(ts){ return ts && (Date.now() - new Date(ts).getTime()) > 4*3600000; }

/* Priority pill */
function hqPriorityPill(p){
  if (p === 'urgent') return '<span class="pill pill-red">URGENT</span>';
  if (p === 'high')   return '<span class="pill pill-orange">HIGH</span>';
  if (p === 'normal') return '<span class="pill pill-blue">NORMAL</span>';
  return '<span class="pill pill-grey">' + escHtml(p||'—') + '</span>';
}

/* Render handoff queue table */
function renderHandoffQueue(handoffs){
  var tbody = el('hq-tbody');

  if (!handoffs || handoffs.length === 0){
    el('hq-state').textContent = 'No open handoffs right now.';
    el('hq-state').classList.remove('error');
    el('hq-state').style.display = 'block';
    el('hq-table-wrap').style.display = 'none';
    el('hq-count-txt').textContent = '';
    return;
  }

  el('hq-state').style.display = 'none';
  el('hq-table-wrap').style.display = 'block';
  el('hq-count-txt').textContent = handoffs.length + ' open handoff' + (handoffs.length===1?'':'s');

  /* Update badge */
  var badge = el('hq-badge');
  badge.textContent = handoffs.length;
  badge.classList.add('visible');

  var rows = handoffs.map(function(h){
    var since = timeSince(h.opened_at);
    var staleClass = isStale(h.opened_at) ? ' stale' : '';
    return '<tr data-conv-id="' + escHtml(h.conversation_id||'') + '" data-hid="' + escHtml(h.handoff_id) + '">' +
      '<td>' + hqPriorityPill(h.priority) + '</td>' +
      '<td class="guest-name">' + escHtml(h.guest_name || '—') + '</td>' +
      '<td class="phone-cell">' + escHtml(h.phone || '—') + '</td>' +
      '<td>' + escHtml(h.reason_code || '—') + '</td>' +
      '<td>' + escHtml(h.status || '—') + '</td>' +
      '<td>' + escHtml(h.assigned_staff || '—') + '</td>' +
      '<td>' + escHtml(h.booking_code || '—') + '</td>' +
      '<td class="ts-cell">' + escHtml(h.opened_at ? new Date(h.opened_at).toLocaleDateString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—') + '</td>' +
      '<td><span class="since' + staleClass + '">' + escHtml(since) + '</span></td>' +
    '</tr>';
  }).join('');
  tbody.innerHTML = rows;

  tbody.querySelectorAll('tr').forEach(function(row){
    row.addEventListener('click', function(){
      var convId = this.dataset.convId;
      tbody.querySelectorAll('tr').forEach(function(r){ r.classList.remove('selected'); });
      this.classList.add('selected');
      if (convId && convId !== 'null' && convId !== ''){
        /* Switch to Inbox sub-tab and open detail */
        document.querySelectorAll('.sub-tab').forEach(function(b){ b.classList.remove('active'); });
        document.querySelectorAll('.sub-panel').forEach(function(p){ p.classList.remove('active'); });
        document.querySelector('.sub-tab[data-subtab="inbox"]').classList.add('active');
        el('subtab-inbox').classList.add('active');
        loadConvDetail(convId);
      } else {
        el('conv-detail').classList.add('visible');
        el('detail-content').innerHTML = '<div class="state-msg" style="color:#9aabb8">No conversation linked to this handoff yet.</div>';
        document.querySelectorAll('.sub-tab').forEach(function(b){ b.classList.remove('active'); });
        document.querySelectorAll('.sub-panel').forEach(function(p){ p.classList.remove('active'); });
        document.querySelector('.sub-tab[data-subtab="inbox"]').classList.add('active');
        el('subtab-inbox').classList.add('active');
      }
    });
  });
}

/* Load handoff queue */
function loadHandoffQueue(){
  hqLoaded = true;
  el('hq-state').textContent = 'Loading\u2026';
  el('hq-state').classList.remove('error');
  el('hq-state').style.display = 'block';
  el('hq-table-wrap').style.display = 'none';

  fetch('/staff/handoffs?client=' + encodeURIComponent(getClient()))
    .then(function(r){
      if (r.status === 401){
        el('hq-state').innerHTML = '\u26a0 Authentication required &mdash; please log in first.';
        el('hq-state').classList.add('error');
        return null;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (!data) return;
      if (!data.success) throw new Error(data.error || 'API error');
      renderHandoffQueue(data.handoffs);
    })
    .catch(function(err){
      el('hq-state').textContent = 'Error loading handoff queue: ' + err.message;
      el('hq-state').classList.add('error');
      el('hq-state').style.display = 'block';
      el('hq-table-wrap').style.display = 'none';
    });
}

el('btn-refresh-hq').addEventListener('click', function(){
  hqLoaded = false; loadHandoffQueue();
});

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

function getBcClient(){ return (el('bc-client').value || 'wolfhouse-somo').trim(); }

function bcColorClass(ct){
  var c = (ct||'hold').toLowerCase();
  var valid = ['confirmed','hold','payment_pending','needs_review','cancelled','conflict'];
  return 'bc-block-' + (valid.indexOf(c) >= 0 ? c : 'hold');
}

function renderBedCalendar(data){
  bcData = data;
  var days   = data.days   || [];
  var rooms  = data.rooms  || [];
  var blocks = data.blocks || [];

  /* Summary strip */
  var totalBeds = 0;
  rooms.forEach(function(r){ totalBeds += (r.beds ? r.beds.length : 0); });
  el('bc-rooms-count').textContent  = rooms.length  + ' room'  + (rooms.length  === 1 ? '' : 's');
  el('bc-beds-count').textContent   = totalBeds      + ' bed'   + (totalBeds      === 1 ? '' : 's');
  el('bc-blocks-count').textContent = blocks.length  + ' booking block' + (blocks.length === 1 ? '' : 's');
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
    html += '<tr><td colspan="' + totalCols + '" class="bc-room-hdr">' +
      escHtml(room.room_code) +
      (room.room_name && room.room_name !== room.room_code ? ' \u2014 ' + escHtml(room.room_name) : '') +
      (room.room_type ? ' <span style="font-weight:400;opacity:.65;font-size:10px">(' + escHtml(room.room_type) + ')</span>' : '') +
      ' <span style="font-weight:400;opacity:.55;font-size:10px">cap:' + (room.capacity||0) + '</span>' +
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
      html += '<td class="bc-bed-cell">' + escHtml(bed.bed_label || bed.bed_code) + '</td>';

      var pos = 0;
      bedBlocks.forEach(function(entry){
        var blk = entry.blk;
        var gap = blk.start_offset - pos;
        for (var g = 0; g < gap; g++) html += '<td class="bc-day-cell"></td>';
        html += renderBookingBlock(blk, entry.idx);
        pos = blk.start_offset + blk.span_days;
      });
      for (var r = pos; r < N; r++) html += '<td class="bc-day-cell"></td>';
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
}

function renderBookingBlock(blk, idx){
  var colorCls = bcColorClass(blk.color_type);
  var markers = '';
  if (blk.is_arrival)   markers += '<span class="bc-marker" title="Arrival">A</span>';
  if (blk.is_departure) markers += '<span class="bc-marker" title="Departure">D</span>';
  var label = escHtml(blk.guest_name || blk.booking_code || '\u2014');
  var tip   = escHtml((blk.booking_code||'') + ' \u2014 ' + (blk.guest_name||'') +
              ' | ' + (blk.start_date||'') + '\u2192' + (blk.end_date||''));
  return '<td colspan="' + blk.span_days + '" class="bc-day-cell" style="padding:1px 2px">' +
    '<div class="bc-block ' + colorCls + '" data-bidx="' + idx + '" title="' + tip + '">' +
    markers + label + '</div></td>';
}

function kvBC(k, v){
  return '<div class="kv"><span class="k">' + escHtml(k) + '</span>' +
         '<span class="v">' + escHtml(String(v == null ? '\u2014' : v)) + '</span></div>';
}

function showBlockDetail(blk){
  if (!blk) return;
  el('bc-detail').innerHTML =
    '<div class="toolbar"><h2>Block &mdash; ' + escHtml(blk.booking_code||'\u2014') + '</h2>' +
    '<button class="btn btn-ghost" id="bc-close-detail">&times; Close</button></div>' +
    '<div class="kv-grid">' +
    kvBC('Booking code',      blk.booking_code)      +
    kvBC('Guest name',        blk.guest_name)         +
    kvBC('Phone',             blk.phone)              +
    kvBC('Room',              blk.room_code)          +
    kvBC('Bed',               blk.bed_code)           +
    kvBC('Status',            blk.status)             +
    kvBC('Payment status',    blk.payment_status)     +
    kvBC('Assignment status', blk.assignment_status)  +
    kvBC('Start date',        blk.start_date)         +
    kvBC('End date',          blk.end_date)           +
    kvBC('Span days',         blk.span_days)          +
    kvBC('Color type',        blk.color_type)         +
    kvBC('Needs review',      blk.needs_review ? 'YES' : 'No') +
    kvBC('Arrival',           blk.is_arrival  ? 'Yes' : 'No') +
    kvBC('Departure',         blk.is_departure? 'Yes' : 'No') +
    '</div>' +
    '<div id="bc-ctx-body"><div class="ctx-loading">Loading booking context\u2026</div></div>' +
    '<div class="bc-detail-note">Booking edits are disabled until the calendar write gates are approved.</div>';
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
      /* Wire "Open conversation" button */
      var btnConv = document.getElementById('bc-open-conv-btn');
      if (btnConv){
        btnConv.addEventListener('click', function(){
          var convId = this.dataset.convid;
          if (!convId) return;
          /* Switch to Conversations tab and open that conversation */
          document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
          document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
          var convTab = document.querySelector('.tab-btn[data-tab="conversations"]');
          if (convTab){ convTab.classList.add('active'); }
          var convPanel = el('tab-conversations');
          if (convPanel){ convPanel.classList.add('active'); }
          /* Switch to inbox sub-tab and load the conversation */
          document.querySelectorAll('.sub-tab').forEach(function(b){ b.classList.remove('active'); });
          document.querySelectorAll('.sub-panel').forEach(function(p){ p.classList.remove('active'); });
          var inboxTab = document.querySelector('.sub-tab[data-subtab="inbox"]');
          if (inboxTab) inboxTab.classList.add('active');
          var inboxPanel = el('subtab-inbox');
          if (inboxPanel) inboxPanel.classList.add('active');
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

/* Render the enriched booking context drawer sections */
function renderBookingContextDrawer(data){
  var html = '';
  var bk = data.booking || {};

  /* Booking section */
  html += '<div class="ctx-section"><h3>Booking Details</h3><div class="kv-grid">' +
    kvBC('Guest',         bk.guest_name)              +
    kvBC('Phone',         bk.phone)                   +
    kvBC('Email',         bk.email)                   +
    kvBC('Check-in',      bk.check_in)                +
    kvBC('Check-out',     bk.check_out)               +
    kvBC('Guests',        bk.guest_count)              +
    kvBC('Package',       bk.package_code)             +
    kvBC('Room pref',     bk.requested_room_type || bk.room_preference) +
    kvBC('Status',        bk.status)                  +
    kvBC('Payment',       bk.payment_status)           +
    kvBC('Assignment',    bk.assignment_status)        +
    kvBC('Total',         bk.total_amount_cents != null ? '\u20ac' + (bk.total_amount_cents/100).toFixed(2) : '\u2014') +
    kvBC('Paid',          bk.amount_paid_cents  != null ? '\u20ac' + (bk.amount_paid_cents/100).toFixed(2)  : '\u2014') +
    kvBC('Balance due',   bk.balance_due_cents  != null ? '\u20ac' + (bk.balance_due_cents/100).toFixed(2)  : '\u2014') +
    (bk.needs_rooming_review ? '<div class="kv" style="grid-column:1/-1"><span class="pill pill-orange">NEEDS ROOMING REVIEW</span></div>' : '') +
    '</div></div>';

  /* Payments section */
  var pmt = data.payments || {};
  html += '<div class="ctx-section"><h3>Payments</h3>';
  if (!pmt.rows || pmt.rows.length === 0){
    html += '<div class="ctx-none">No payment records found.</div>';
  } else {
    html += '<div class="kv-grid">' +
      kvBC('Records', pmt.rows.length) +
      kvBC('Latest status', pmt.latest_status) +
      kvBC('Amount paid', '\u20ac' + (pmt.amount_paid_cents/100).toFixed(2)) +
      kvBC('Balance due', '\u20ac' + (pmt.balance_due_cents/100).toFixed(2)) +
      '</div>';
  }
  html += '</div>';

  /* Rooming section */
  var rm = data.rooming || {};
  html += '<div class="ctx-section"><h3>Rooming / Beds</h3>';
  if (!rm.assignments || rm.assignments.length === 0){
    html += '<div class="ctx-none">No bed assignments found.</div>';
  } else {
    html += '<div class="kv-grid">' +
      kvBC('Rooms', (rm.assigned_room_codes||[]).join(', ') || '\u2014') +
      kvBC('Beds',  (rm.assigned_bed_codes||[]).join(', ')  || '\u2014') +
      '</div>';
    rm.assignments.forEach(function(a){
      html += '<div style="font-size:11px;color:#5a6a85;padding:3px 0">' +
        escHtml(a.room_code||'\u2014') + ' / ' + escHtml(a.bed_code||'\u2014') +
        ' &nbsp;&middot;&nbsp; ' + escHtml(a.assignment_start_date||'') +
        ' \u2192 ' + escHtml(a.assignment_end_date||'') +
        (a.assignment_label ? ' &nbsp;&middot;&nbsp; <em>' + escHtml(a.assignment_label) + '</em>' : '') +
        '</div>';
    });
  }
  html += '</div>';

  /* Conversation section */
  html += '<div class="ctx-section"><h3>Conversation</h3>';
  if (!data.conversation){
    html += '<div class="ctx-none">No linked conversation found.</div>';
  } else {
    var conv = data.conversation;
    html += '<div class="kv-grid">' +
      kvBC('Mode',           conv.bot_mode) +
      kvBC('Needs human',    conv.needs_human ? 'YES' : 'No') +
      kvBC('Pending action', conv.pending_action) +
      kvBC('Last message',   conv.last_message_preview) +
      '</div>' +
      '<div style="margin-top:8px">' +
      '<button class="btn-open-conv" id="bc-open-conv-btn" data-convid="' + escHtml(conv.conversation_id||'') + '">' +
      '&#128172; Open conversation</button>' +
      '<span style="font-size:11px;color:#7f8c8d;margin-left:8px">Switches to Conversations tab</span>' +
      '</div>';
  }
  html += '</div>';

  /* Handoff section */
  html += '<div class="ctx-section"><h3>Handoff</h3>';
  if (!data.handoff){
    html += '<div class="ctx-none">No open handoff found.</div>';
  } else {
    var hf = data.handoff;
    html += '<div class="kv-grid">' +
      kvBC('Reason',   hf.reason_code)   +
      kvBC('Priority', hf.priority)      +
      kvBC('Status',   hf.status)        +
      kvBC('Staff',    hf.assigned_staff)+
      kvBC('Opened',   hf.opened_at ? new Date(hf.opened_at).toLocaleString() : '\u2014') +
      '</div>';
  }
  html += '</div>';

  /* Add-ons section */
  var ao = data.addons || {};
  html += '<div class="ctx-section"><h3>Add-ons</h3>';
  if (!ao.rows || ao.rows.length === 0){
    html += '<div class="ctx-none">' + escHtml(ao.note || 'No add-on orders found.') + '</div>';
  } else {
    html += '<div class="kv-grid">';
    var seenOrders = {};
    ao.rows.forEach(function(r){
      if (!seenOrders[r.order_id]){
        seenOrders[r.order_id] = true;
        html += kvBC(r.order_code || r.order_id, (r.order_status||'') + ' / ' + (r.order_payment_status||''));
      }
    });
    html += '</div>';
  }
  html += '</div>';

  /* Warnings */
  if (data.warnings && data.warnings.length > 0){
    html += '<div class="ctx-section"><h3>Warnings</h3><div class="state-msg error">' +
      data.warnings.map(function(w){ return escHtml(w); }).join('<br>') + '</div></div>';
  }

  return html;
}

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
  if (s === 'cancelled')   return 'cancelled';
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

  let bookingRows, paymentRows, roomingRows, convRows, handoffRows, addonRows;
  try {
    [bookingRows, paymentRows, roomingRows, convRows, handoffRows, addonRows] =
      await withPgClient(async (pg) => {
        const [b, p, r, c, h, a] = await Promise.all([
          pg.query(getBookingDetailQuery(),             [clientSlug, bookingCode]),
          pg.query(getBookingPaymentsQuery(),           [clientSlug, bookingCode]),
          pg.query(getBookingRoomingAssignmentsQuery(), [clientSlug, bookingCode]),
          pg.query(getBookingConversationQuery(),       [clientSlug, bookingCode]),
          pg.query(getBookingHandoffQuery(),            [clientSlug, bookingCode]),
          pg.query(getBookingAddOnSummaryQuery(),       [clientSlug, bookingCode]).catch(() => ({ rows: [] })),
        ]);
        return [b.rows, p.rows, r.rows, c.rows, h.rows, a.rows];
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

  // ── Stage 7.7b — Conversation API (read-only) ─────────────────────────────
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
