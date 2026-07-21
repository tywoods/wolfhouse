'use strict';

/**
 * Crowsnest auth — browser login portal plus legacy Basic Auth compatibility.
 * /healthz stays public. See docs/CROWSNEST.md.
 */

const crypto = require('crypto');

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';
const CROWSNEST_SESSION_COOKIE = 'crowsnest_session';
const CROWSNEST_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CROWSNEST_LOGIN_BODY_LIMIT = 1024;
const BASE_BROWSER_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const sessions = new Map();

function isCrowsnestAuthEnabled() {
  const raw = String(process.env.CROWSNEST_AUTH_REQUIRED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return false;
}

function getCrowsnestAllowedUsers() {
  const raw = String(process.env.CROWSNEST_ALLOWED_USERS || '').trim();
  if (!raw) {
    return ['Monshies', 'Earthling'];
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getCrowsnestBasicAuthConfig() {
  const usernameRaw = process.env.CROWSNEST_AUTH_USERNAME;
  const passwordRaw = process.env.CROWSNEST_AUTH_PASSWORD;
  const hasUsername = usernameRaw !== undefined;
  const hasPassword = passwordRaw !== undefined;

  if (hasUsername && !String(usernameRaw).trim()) {
    return { configured: false };
  }
  if (hasPassword && !String(passwordRaw).trim()) {
    return { configured: false };
  }

  if (!hasUsername || !hasPassword) {
    if (process.env.NODE_ENV === 'production') {
      return { configured: false };
    }
    return {
      configured: true,
      username: DEFAULT_USERNAME,
      password: DEFAULT_PASSWORD,
    };
  }

  return {
    configured: true,
    username: String(usernameRaw).trim(),
    password: String(passwordRaw).trim(),
  };
}

function parseBasicAuthHeader(req) {
  const header = req && req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return {
    username: decoded.slice(0, sep),
    password: decoded.slice(sep + 1),
  };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : String(cookieHeader || '');
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function timingSafeEqualString(a, b) {
  const digestA = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function isCrowsnestRequestAuthorized(req) {
  if (!isCrowsnestAuthEnabled()) return true;

  const config = getCrowsnestBasicAuthConfig();
  if (!config.configured) return false;

  const creds = parseBasicAuthHeader(req);
  if (!creds) return false;

  const usernameMatches = timingSafeEqualString(creds.username, config.username);
  const passwordMatches = timingSafeEqualString(creds.password, config.password);
  return usernameMatches && passwordMatches;
}

function isCrowsnestSessionAuthorized(req) {
  if (!isCrowsnestAuthEnabled()) return true;
  const cookies = parseCookies(req && req.headers && req.headers.cookie);
  const token = cookies[CROWSNEST_SESSION_COOKIE];
  if (!token) return false;
  const record = sessions.get(token);
  if (!record) return false;
  if (record.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function createCrowsnestSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, {
    username: String(username || '').trim(),
    expiresAt: Date.now() + CROWSNEST_SESSION_TTL_MS,
  });
  return token;
}

function destroyCrowsnestSession(token) {
  if (!token) return false;
  return sessions.delete(token);
}

function clearExpiredCrowsnestSessions() {
  const now = Date.now();
  for (const [token, record] of sessions.entries()) {
    if (!record || record.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function buildCrowsnestSessionCookie(token, options = {}) {
  const parts = [
    `${CROWSNEST_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.max(1, Math.floor(CROWSNEST_SESSION_TTL_MS / 1000))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function buildCrowsnestClearedSessionCookie(options = {}) {
  const parts = [
    `${CROWSNEST_SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function isCrowsnestLoginAccepted(username, password) {
  const config = getCrowsnestBasicAuthConfig();
  if (!config.configured) return false;
  const usernameMatches = timingSafeEqualString(username, config.username);
  const passwordMatches = timingSafeEqualString(password, config.password);
  return usernameMatches && passwordMatches;
}

function getCrowsnestLoginBodyLimit() {
  return CROWSNEST_LOGIN_BODY_LIMIT;
}

function sendText(res, status, body, extraHeaders) {
  const payload = String(body);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    ...extraHeaders,
    ...BASE_BROWSER_HEADERS,
  });
  res.end(payload);
}

function sendCrowsnestAuthRequired(res) {
  sendText(res, 401, 'Crowsnest access required', {
    'WWW-Authenticate': 'Basic realm="Crowsnest"',
  });
}

function sendCrowsnestAuthMisconfigured(res) {
  sendText(res, 503, 'Crowsnest auth is not configured');
}

/** @deprecated use getCrowsnestAllowedUsers */
function getAllowedCrowsnestUsers() {
  return getCrowsnestAllowedUsers();
}

module.exports = {
  CROWSNEST_SESSION_COOKIE,
  clearExpiredCrowsnestSessions,
  createCrowsnestSession,
  destroyCrowsnestSession,
  getAllowedCrowsnestUsers,
  getCrowsnestAllowedUsers,
  getCrowsnestBasicAuthConfig,
  getCrowsnestLoginBodyLimit,
  isCrowsnestAuthEnabled,
  isCrowsnestLoginAccepted,
  isCrowsnestRequestAuthorized,
  isCrowsnestSessionAuthorized,
  parseBasicAuthHeader,
  parseCookies,
  buildCrowsnestSessionCookie,
  buildCrowsnestClearedSessionCookie,
  sendCrowsnestAuthMisconfigured,
  sendCrowsnestAuthRequired,
  timingSafeEqualString,
};
