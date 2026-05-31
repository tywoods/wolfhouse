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
<title>Luna Front Desk — Cami Dashboard</title>
<style>
/* ── Reset + base ───────────────────────────────────────────────────────── */
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;background:#f4f5f7;color:#1a1a2e}
/* ── Top banner ─────────────────────────────────────────────────────────── */
#banner{background:#1a1a2e;color:#fff;padding:10px 18px;display:flex;align-items:center;gap:12px}
#banner .brand{font-size:15px;font-weight:700;letter-spacing:.03em;flex:1}
#banner .brand em{color:#7ecbff;font-style:normal}
#banner .badge{background:#c0392b;color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em;padding:3px 10px;border-radius:20px;white-space:nowrap}
#banner .badge-sm{background:#2c3e50;color:#aab4c4;font-size:10px;padding:2px 8px;border-radius:20px}
/* ── Tabs ───────────────────────────────────────────────────────────────── */
#tabs{background:#fff;border-bottom:2px solid #dde1e7;display:flex;padding:0 24px}
.tab-btn{padding:12px 20px;font-size:13px;font-weight:600;color:#5a6a85;border:none;border-bottom:3px solid transparent;background:none;cursor:pointer;margin-bottom:-2px;transition:color .15s}
.tab-btn:hover{color:#2c3e50}
.tab-btn.active{color:#2980b9;border-bottom-color:#2980b9}
/* ── Layout ─────────────────────────────────────────────────────────────── */
#wrap{max-width:1200px;margin:0 auto;padding:20px 16px}
.tab-panel{display:none}
.tab-panel.active{display:block}
/* ── Cards ──────────────────────────────────────────────────────────────── */
.card{background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:16px 20px;margin-bottom:16px}
/* ── Toolbar ─────────────────────────────────────────────────────────────── */
.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.toolbar h2{font-size:15px;font-weight:700;color:#2c3e50;flex:1}
.btn{border:none;border-radius:5px;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer}
.btn-primary{background:#2980b9;color:#fff}
.btn-primary:hover{background:#1f6fa3}
.btn-primary:disabled{background:#aab4c4;cursor:default}
.btn-ghost{background:none;border:1px solid #cdd5df;color:#5a6a85}
.btn-ghost:hover{background:#f0f2f5}
/* ── Status pills ───────────────────────────────────────────────────────── */
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap}
.pill-red{background:#fdecea;color:#c0392b}
.pill-orange{background:#fef3e2;color:#e67e22}
.pill-blue{background:#ebf5fb;color:#2980b9}
.pill-green{background:#eafaf1;color:#1e8449}
.pill-grey{background:#f0f2f5;color:#7f8c8d}
/* ── Inbox table ─────────────────────────────────────────────────────────── */
.inbox-table{width:100%;border-collapse:collapse;font-size:12px}
.inbox-table th{background:#f0f2f5;text-align:left;padding:7px 10px;border-bottom:2px solid #dde1e7;font-weight:700;white-space:nowrap;font-size:11px;color:#5a6a85;text-transform:uppercase;letter-spacing:.04em}
.inbox-table td{padding:8px 10px;border-bottom:1px solid #eef0f3;vertical-align:middle;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inbox-table tr:hover td{background:#f7f9fb;cursor:pointer}
.inbox-table tr.selected td{background:#ebf5fb}
.guest-name{font-weight:600;color:#2c3e50}
.phone-cell{color:#5a6a85;font-size:11px}
.preview-cell{color:#7f8c8d;font-size:11px;max-width:280px}
.ts-cell{color:#9aabb8;font-size:11px;white-space:nowrap}
/* ── Detail pane ─────────────────────────────────────────────────────────── */
#conv-detail{display:none}
#conv-detail.visible{display:block}
.detail-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
.detail-name{font-size:16px;font-weight:700;color:#2c3e50}
.detail-meta{font-size:12px;color:#5a6a85;margin-top:3px}
.detail-section{margin-top:14px;padding-top:14px;border-top:1px solid #eef0f3}
.detail-section h3{font-size:12px;font-weight:700;color:#7f8c8d;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.kv{display:flex;flex-direction:column;gap:2px}
.kv .k{font-size:11px;color:#9aabb8;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.kv .v{font-size:13px;color:#2c3e50;font-weight:500}
.back-btn{background:none;border:none;color:#2980b9;cursor:pointer;font-size:13px;padding:0;margin-bottom:12px}
.back-btn:hover{text-decoration:underline}
/* ── Detail two-column layout ────────────────────────────────────────────── */
.detail-layout{display:flex;gap:16px;align-items:flex-start;margin-top:14px}
.detail-main{flex:1;min-width:0}
.detail-sidebar{width:280px;flex-shrink:0}
@media(max-width:860px){.detail-layout{flex-direction:column}.detail-sidebar{width:100%}}
/* ── Message thread ──────────────────────────────────────────────────────── */
.thread-section h3{font-size:12px;font-weight:700;color:#7f8c8d;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.thread{display:flex;flex-direction:column;gap:8px;max-height:400px;overflow-y:auto;padding:12px;background:#f8f9fb;border:1px solid #eef0f3;border-radius:8px}
.msg{display:flex;flex-direction:column;max-width:82%}
.msg.inbound{align-self:flex-start}
.msg.outbound{align-self:flex-end}
.msg-bubble{padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg.inbound .msg-bubble{background:#ebf5fb;color:#1a2e3e;border-bottom-left-radius:3px}
.msg.outbound .msg-bubble{background:#eafaf1;color:#1a3a2a;border-bottom-right-radius:3px}
.msg-meta{font-size:10px;color:#9aabb8;margin-top:3px}
.msg.outbound .msg-meta{text-align:right}
.thread-empty{color:#9aabb8;text-align:center;padding:24px;font-size:13px;font-style:italic}
/* ── Luna draft panel ────────────────────────────────────────────────────── */
.draft-panel{margin-top:16px;padding-top:14px;border-top:1px solid #eef0f3}
.draft-label{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.draft-label h3{font-size:12px;font-weight:700;color:#7f8c8d;text-transform:uppercase;letter-spacing:.06em;margin:0}
.draft-not-sent{background:#fdecea;color:#c0392b;font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 7px;border-radius:3px;white-space:nowrap}
#draft-textarea{width:100%;min-height:100px;border:1px solid #cdd5df;border-radius:6px;padding:10px 12px;font-size:13px;line-height:1.5;font-family:inherit;resize:vertical;background:#fff;color:#2c3e50}
#draft-textarea:focus{outline:none;border-color:#f39c12}
.draft-actions{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
.draft-warning{font-size:11px;color:#e67e22;flex:1;min-width:180px}
.btn-copy{background:#f39c12;color:#fff;border:none;border-radius:5px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
.btn-copy:hover{background:#d68910}
.btn-send-disabled{background:#bdc3c7;color:#fff;border:none;border-radius:5px;padding:7px 14px;font-size:12px;font-weight:700;cursor:not-allowed;opacity:.7;white-space:nowrap}
.copy-confirm{font-size:11px;color:#27ae60;font-weight:700}
/* ── Conversations sub-tabs ──────────────────────────────────────────────── */
#conv-subtabs{display:flex;gap:0;border-bottom:2px solid #dde1e7;margin-bottom:16px;background:#fff;border-radius:8px 8px 0 0;padding:0 12px}
.sub-tab{padding:10px 16px;font-size:12px;font-weight:600;color:#5a6a85;border:none;border-bottom:3px solid transparent;background:none;cursor:pointer;margin-bottom:-2px}
.sub-tab:hover{color:#2c3e50}
.sub-tab.active{color:#2980b9;border-bottom-color:#2980b9}
.sub-tab .hq-count{background:#c0392b;color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;margin-left:5px;display:none}
.sub-tab .hq-count.visible{display:inline}
.sub-panel{display:none}
.sub-panel.active{display:block}
/* ── Handoff queue ───────────────────────────────────────────────────────── */
.hq-note{font-size:11px;color:#e67e22;background:#fef9ec;border:1px solid #f5cba7;border-radius:5px;padding:7px 12px;margin-bottom:12px}
.hq-table{width:100%;border-collapse:collapse;font-size:12px}
.hq-table th{background:#f0f2f5;text-align:left;padding:6px 10px;border-bottom:2px solid #dde1e7;font-weight:700;white-space:nowrap;font-size:11px;color:#5a6a85;text-transform:uppercase;letter-spacing:.04em}
.hq-table td{padding:7px 10px;border-bottom:1px solid #eef0f3;vertical-align:middle;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hq-table tr:hover td{background:#fff8f0;cursor:pointer}
.hq-table tr.selected td{background:#fef3e2}
.hq-ro-label{font-size:10px;font-weight:700;letter-spacing:.08em;color:#7f8c8d;background:#f0f2f5;padding:2px 7px;border-radius:3px;margin-left:8px}
.since{font-size:11px;color:#e67e22;font-weight:600}
.since.stale{color:#c0392b}
/* ── Sidebar cards ───────────────────────────────────────────────────────── */
.sidebar-card{background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:12px 14px;margin-bottom:12px}
.sidebar-card h3{font-size:11px;font-weight:700;color:#7f8c8d;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
.kv2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.kv2 .kv{font-size:12px}
/* ── Empty / loading / error ─────────────────────────────────────────────── */
.state-msg{text-align:center;padding:40px 0;color:#9aabb8;font-size:13px}
.state-msg.error{color:#c0392b;background:#fdf2f2;border:1px solid #e74c3c;border-radius:6px;padding:14px 18px;text-align:left}
/* ── Query tools (existing) ──────────────────────────────────────────────── */
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:#5a6a85}
input,select{border:1px solid #cdd5df;border-radius:5px;padding:6px 9px;font-size:13px;min-width:160px;background:#fff}
input:focus,select:focus{outline:none;border-color:#3498db}
#q-error{background:#fdf2f2;border:1px solid #e74c3c;color:#c0392b;border-radius:6px;padding:10px 14px;margin-bottom:12px;display:none}
#q-meta{font-size:12px;color:#5a6a85;margin-bottom:10px}
#q-table-wrap table{width:100%;border-collapse:collapse;font-size:12px}
#q-table-wrap th{background:#f0f2f5;text-align:left;padding:6px 9px;border-bottom:2px solid #dde1e7;font-weight:700;white-space:nowrap}
#q-table-wrap td{padding:5px 9px;border-bottom:1px solid #eef0f3;vertical-align:top;word-break:break-word;max-width:280px}
#q-table-wrap tr:hover td{background:#f7f9fb}
#q-json{background:#f8f9fb;border:1px solid #dde1e7;border-radius:5px;padding:12px;font-size:12px;white-space:pre-wrap;max-height:400px;overflow:auto;display:none}
#q-params label{display:none}
#q-params label.visible{display:flex}
.mig-note{font-size:11px;color:#e67e22;background:#fef9ec;border:1px solid #f5cba7;border-radius:4px;padding:4px 8px;display:inline-block;margin-bottom:8px}
.view-toggle{font-size:11px;color:#2980b9;cursor:pointer;margin-left:10px;text-decoration:underline}
</style>
</head>
<body>

<!-- ── Top banner ─────────────────────────────────────────────────────────── -->
<div id="banner">
  <div class="brand">Luna Front Desk &mdash; <em>Cami Dashboard</em></div>
  <span class="badge-sm">Stage 7.7f</span>
  <span class="badge">READ-ONLY &bull; SHADOW MODE</span>
</div>

<!-- ── Tabs ───────────────────────────────────────────────────────────────── -->
<div id="tabs">
  <button class="tab-btn active" data-tab="conversations">Conversations</button>
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
        Client
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
  <div style="font-size:11px;color:#9aabb8;margin-bottom:12px;padding:6px 10px;background:#f0f2f5;border-radius:5px;display:inline-block">
    READ-ONLY &mdash; no write actions &mdash; Query Tools (Stage 6.8)
  </div>
  <div class="card">
    <div class="row">
      <label>Client<input id="f-client" value="wolfhouse-somo" style="min-width:200px"></label>
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
    if (!draftAvail){
      html += '<div style="color:#9aabb8;font-size:12px;font-style:italic;margin-bottom:8px">No Luna draft available yet &mdash; type a manual reply below to copy.</div>';
    }
    html += '<textarea id="draft-textarea" placeholder="No Luna draft \u2014 type a manual reply here to copy">' +
            escHtml(draftText) + '</textarea>';
    html += '<div class="draft-actions">';
    html +=   '<button class="btn-copy" id="btn-copy-draft">Copy to clipboard</button>';
    html +=   '<span class="copy-confirm" id="copy-confirm" style="display:none">Copied!</span>';
    html +=   '<button class="btn-send-disabled" disabled>Approve &amp; Send &mdash; disabled (live-send gate required)</button>';
    html +=   '<span class="draft-warning">Shadow mode: copy this reply and send it manually in WhatsApp. No live sends from this dashboard.</span>';
    html += '</div>';
    html += '</div>'; /* /draft-panel */

    /* Read-only footer */
    html += '<div style="margin-top:12px;padding:8px 12px;background:#f0f2f5;border-radius:6px;font-size:11px;color:#7f8c8d">';
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
// Request router
// ─────────────────────────────────────────────────────────────────────────────

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

  if (pathname === '/staff/ui') {
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nWolfhouse staff query API + UI (Stage 7.7b) running on http://127.0.0.1:${PORT}`);
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
