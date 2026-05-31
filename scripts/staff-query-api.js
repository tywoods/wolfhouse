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
// Route: GET /staff/ui  (Stage 6.8 — read-only browser UI)
// ─────────────────────────────────────────────────────────────────────────────

function buildUiHtml(port) {
  // Inline self-contained HTML. No CDN, no framework, no write controls.
  // All data fetched from /staff/intents and /staff/query on this same origin.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wolfhouse Staff Query UI</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;font-size:14px;background:#f4f5f7;color:#1a1a2e}
  #banner{background:#c0392b;color:#fff;padding:10px 18px;font-weight:700;letter-spacing:.04em;text-align:center}
  #banner span{background:#fff;color:#c0392b;border-radius:4px;padding:1px 7px;margin-right:8px}
  #wrap{max-width:1100px;margin:24px auto;padding:0 16px}
  h1{font-size:18px;font-weight:700;margin-bottom:16px;color:#2c3e50}
  #form-card{background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:18px 20px;margin-bottom:18px}
  .row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:12px}
  label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:#5a6a85}
  input,select{border:1px solid #cdd5df;border-radius:5px;padding:6px 9px;font-size:13px;min-width:160px;background:#fff}
  input:focus,select:focus{outline:none;border-color:#3498db}
  #btn-run{background:#2980b9;color:#fff;border:none;border-radius:5px;padding:8px 22px;font-size:13px;font-weight:700;cursor:pointer}
  #btn-run:hover{background:#1f6fa3}
  #btn-run:disabled{background:#aab4c4;cursor:default}
  #params-row label{display:none}
  #params-row label.visible{display:flex}
  #results-card{background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:16px 20px}
  #meta{font-size:12px;color:#5a6a85;margin-bottom:10px}
  #error-panel{background:#fdf2f2;border:1px solid #e74c3c;color:#c0392b;border-radius:6px;padding:10px 14px;margin-bottom:12px;display:none}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#f0f2f5;text-align:left;padding:6px 9px;border-bottom:2px solid #dde1e7;font-weight:700;white-space:nowrap}
  td{padding:5px 9px;border-bottom:1px solid #eef0f3;vertical-align:top;word-break:break-word;max-width:280px}
  tr:hover td{background:#f7f9fb}
  #json-view{background:#f8f9fb;border:1px solid #dde1e7;border-radius:5px;padding:12px;font-size:12px;white-space:pre-wrap;max-height:400px;overflow:auto;display:none}
  #view-toggle{font-size:11px;color:#2980b9;cursor:pointer;margin-left:10px;text-decoration:underline}
  .mig-note{font-size:11px;color:#e67e22;background:#fef9ec;border:1px solid #f5cba7;border-radius:4px;padding:4px 8px;display:inline-block;margin-bottom:8px}
  #placeholder{color:#9aabb8;text-align:center;padding:32px 0;font-size:13px}
</style>
</head>
<body>
<div id="banner"><span>READ-ONLY</span>Local/dev staff query UI &mdash; no write actions &mdash; Stage 6.8</div>
<div id="wrap">
  <h1>Wolfhouse Staff Query</h1>
  <div id="form-card">
    <div class="row">
      <label>Client<input id="f-client" value="wolfhouse-somo" style="min-width:200px"></label>
      <label>Category<select id="f-cat"><option value="">-- loading --</option></select></label>
      <label>Intent<select id="f-intent" disabled><option value="">-- pick category --</option></select></label>
    </div>
    <div class="row" id="params-row">
      <label id="lbl-date">Date (YYYY-MM-DD)<input id="f-date" placeholder="2026-07-16"></label>
      <label id="lbl-start">Start date<input id="f-start" placeholder="2026-07-01"></label>
      <label id="lbl-end">End date<input id="f-end" placeholder="2026-07-31"></label>
      <label id="lbl-booking">Booking code<input id="f-booking" placeholder="WH-260528-1493"></label>
      <label id="lbl-reason">Reason code<input id="f-reason" placeholder="cancellation_request"></label>
      <label id="lbl-staff">Staff name<input id="f-staff" placeholder="Ana"></label>
      <label id="lbl-hours">Hours<input id="f-hours" placeholder="24" style="min-width:80px"></label>
    </div>
    <div class="row" style="margin-bottom:0">
      <button id="btn-run" disabled>Run query</button>
      <span id="status-txt" style="font-size:12px;color:#5a6a85;margin-left:8px"></span>
    </div>
  </div>
  <div id="results-card">
    <div id="error-panel"></div>
    <div id="meta"></div>
    <div id="table-wrap"><div id="placeholder">Select a category and intent, then click Run query.</div></div>
    <pre id="json-view"></pre>
  </div>
</div>
<script>
(function(){
  'use strict';
  const API = '';  // same origin
  let registry = {};  // category -> [{key,description,requiredParams,optionalParams}]
  const PARAM_MAP = {
    date: 'f-date', start_date: 'f-start', end_date: 'f-end',
    booking_code: 'f-booking', reason_code: 'f-reason',
    staff_name: 'f-staff', hours: 'f-hours',
  };
  const LABEL_MAP = {
    date: 'lbl-date', start_date: 'lbl-start', end_date: 'lbl-end',
    booking_code: 'lbl-booking', reason_code: 'lbl-reason',
    staff_name: 'lbl-staff', hours: 'lbl-hours',
  };

  function el(id){ return document.getElementById(id); }

  function showError(msg){
    const p = el('error-panel'); p.textContent = msg; p.style.display = 'block';
  }
  function clearError(){ el('error-panel').style.display = 'none'; }

  function showAllParamLabels(visible){
    Object.values(LABEL_MAP).forEach(id => {
      el(id).classList.toggle('visible', visible);
    });
  }
  function updateParamLabels(intentEntry){
    Object.values(LABEL_MAP).forEach(id => el(id).classList.remove('visible'));
    if (!intentEntry) return;
    const needed = new Set([
      ...intentEntry.requiredParams,
      ...intentEntry.optionalParams
    ]);
    needed.forEach(p => { if (LABEL_MAP[p]) el(LABEL_MAP[p]).classList.add('visible'); });
  }

  // Load intents
  fetch(API + '/staff/intents')
    .then(r => r.json())
    .then(data => {
      if (!data.success) { showError('Failed to load intents: ' + (data.error||'unknown')); return; }
      registry = data.intents;
      const catSel = el('f-cat');
      catSel.innerHTML = '<option value="">-- pick category --</option>';
      data.categories.forEach(cat => {
        const o = document.createElement('option'); o.value = cat; o.textContent = cat;
        catSel.appendChild(o);
      });
    })
    .catch(e => showError('Could not reach API: ' + e.message));

  el('f-cat').addEventListener('change', function(){
    const cat = this.value;
    const intentSel = el('f-intent');
    intentSel.innerHTML = '<option value="">-- pick intent --</option>';
    intentSel.disabled = !cat;
    el('btn-run').disabled = true;
    updateParamLabels(null);
    if (!cat) return;
    (registry[cat] || []).forEach(entry => {
      const o = document.createElement('option');
      o.value = entry.key;
      o.textContent = entry.key + ' — ' + entry.description;
      intentSel.appendChild(o);
    });
    intentSel.disabled = false;
  });

  el('f-intent').addEventListener('change', function(){
    const key = this.value;
    el('btn-run').disabled = !key;
    if (!key) { updateParamLabels(null); return; }
    const cat = el('f-cat').value;
    const entry = (registry[cat]||[]).find(e => e.key === key);
    updateParamLabels(entry);
  });

  el('btn-run').addEventListener('click', function(){
    clearError();
    const client = el('f-client').value.trim() || 'wolfhouse-somo';
    const intent = el('f-intent').value.trim();
    if (!intent){ showError('No intent selected.'); return; }

    const params = new URLSearchParams({ client, intent });
    const fieldMap = { date:'f-date', start:'f-start', end:'f-end',
      booking:'f-booking', reason:'f-reason', staff:'f-staff', hours:'f-hours' };
    Object.entries(fieldMap).forEach(([k, id]) => {
      const v = el(id).value.trim();
      if (v) params.set(k, v);
    });

    el('btn-run').disabled = true;
    el('status-txt').textContent = 'Running\u2026';
    el('meta').textContent = '';
    el('table-wrap').innerHTML = '';
    el('json-view').style.display = 'none';

    fetch(API + '/staff/query?' + params.toString())
      .then(r => r.json())
      .then(data => {
        el('btn-run').disabled = false;
        el('status-txt').textContent = '';
        if (!data.success){
          showError((data.error || 'Query failed') + (data.detail ? ' — ' + data.detail : ''));
          return;
        }
        let html = '';
        if (data.migration_note) {
          html += '<div class="mig-note">\u26a0 Migration advisory: ' + data.migration_note + '</div>';
        }
        html += '<span id="view-toggle" title="Toggle JSON view">JSON</span>';
        el('meta').innerHTML =
          '<strong>' + data.intent + '</strong> &mdash; ' + data.category +
          ' &mdash; ' + data.row_count + ' row(s) &mdash; ' + data.elapsed_ms + 'ms';

        if (!data.rows || data.rows.length === 0){
          el('table-wrap').innerHTML = html + '<div style="color:#9aabb8;padding:20px 0;text-align:center">No rows returned.</div>';
        } else {
          const cols = Object.keys(data.rows[0]);
          let tbl = '<table><thead><tr>' + cols.map(c => '<th>' + escHtml(c) + '</th>').join('') + '</tr></thead><tbody>';
          data.rows.forEach(row => {
            tbl += '<tr>' + cols.map(c => '<td>' + escHtml(row[c] == null ? '' : String(row[c])) + '</td>').join('') + '</tr>';
          });
          tbl += '</tbody></table>';
          el('table-wrap').innerHTML = html + tbl;
        }
        el('json-view').textContent = JSON.stringify(data, null, 2);
        el('table-wrap').querySelector('#view-toggle') &&
          el('table-wrap').querySelector('#view-toggle').addEventListener('click', function(){
            const jv = el('json-view');
            if (jv.style.display === 'none'){ jv.style.display = 'block'; this.textContent = 'Table'; }
            else { jv.style.display = 'none'; this.textContent = 'JSON'; }
          });
      })
      .catch(e => {
        el('btn-run').disabled = false;
        el('status-txt').textContent = '';
        showError('Network error: ' + e.message);
      });
  });

  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
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
    'X-Powered-By':  'wolfhouse-staff-api/6.8',
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
