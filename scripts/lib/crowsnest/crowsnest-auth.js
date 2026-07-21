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

const MULTI_ACCOUNT_ENV_KEYS = [
  'CROWSNEST_AUTH_EARTHLING_USERNAME',
  'CROWSNEST_AUTH_EARTHLING_PASSWORD',
  'CROWSNEST_AUTH_MONSHIES_USERNAME',
  'CROWSNEST_AUTH_MONSHIES_PASSWORD',
];

function readEnvRaw(name) {
  return process.env[name];
}

function isMultiAccountEnvPresent() {
  for (const key of MULTI_ACCOUNT_ENV_KEYS) {
    if (readEnvRaw(key) !== undefined) return true;
  }
  return false;
}

function trimCredential(value) {
  return String(value || '').trim();
}

/**
 * Resolve configured operator accounts.
 * Multi-account mode wins whenever any of the four multi-account env vars are present
 * (never combined with legacy CROWSNEST_AUTH_USERNAME / CROWSNEST_AUTH_PASSWORD).
 */
function getCrowsnestAuthAccounts() {
  if (isMultiAccountEnvPresent()) {
    const earthlingUsername = trimCredential(readEnvRaw('CROWSNEST_AUTH_EARTHLING_USERNAME'));
    const earthlingPassword = trimCredential(readEnvRaw('CROWSNEST_AUTH_EARTHLING_PASSWORD'));
    const monshiesUsername = trimCredential(readEnvRaw('CROWSNEST_AUTH_MONSHIES_USERNAME'));
    const monshiesPassword = trimCredential(readEnvRaw('CROWSNEST_AUTH_MONSHIES_PASSWORD'));

    const earthlingUserPresent = readEnvRaw('CROWSNEST_AUTH_EARTHLING_USERNAME') !== undefined;
    const earthlingPassPresent = readEnvRaw('CROWSNEST_AUTH_EARTHLING_PASSWORD') !== undefined;
    const monshiesUserPresent = readEnvRaw('CROWSNEST_AUTH_MONSHIES_USERNAME') !== undefined;
    const monshiesPassPresent = readEnvRaw('CROWSNEST_AUTH_MONSHIES_PASSWORD') !== undefined;

    const complete =
      earthlingUserPresent
      && earthlingPassPresent
      && monshiesUserPresent
      && monshiesPassPresent
      && earthlingUsername
      && earthlingPassword
      && monshiesUsername
      && monshiesPassword
      && earthlingUsername !== monshiesUsername;

    if (!complete) {
      return { configured: false, mode: 'multi', accounts: [] };
    }

    return {
      configured: true,
      mode: 'multi',
      accounts: [
        { id: 'earthling', username: earthlingUsername, password: earthlingPassword },
        { id: 'monshies', username: monshiesUsername, password: monshiesPassword },
      ],
    };
  }

  const usernameRaw = readEnvRaw('CROWSNEST_AUTH_USERNAME');
  const passwordRaw = readEnvRaw('CROWSNEST_AUTH_PASSWORD');
  const hasUsername = usernameRaw !== undefined;
  const hasPassword = passwordRaw !== undefined;

  if (hasUsername || hasPassword) {
    const username = trimCredential(usernameRaw);
    const password = trimCredential(passwordRaw);
    if (!hasUsername || !hasPassword || !username || !password) {
      return { configured: false, mode: 'legacy', accounts: [] };
    }
    return {
      configured: true,
      mode: 'legacy',
      accounts: [{ id: 'legacy', username, password }],
    };
  }

  if (process.env.NODE_ENV === 'production') {
    return { configured: false, mode: 'default', accounts: [] };
  }

  return {
    configured: true,
    mode: 'default',
    accounts: [{ id: 'default', username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD }],
  };
}

/** @deprecated prefer getCrowsnestAuthAccounts — kept for existing callers/tests */
function getCrowsnestBasicAuthConfig() {
  const accountsConfig = getCrowsnestAuthAccounts();
  if (!accountsConfig.configured) {
    return { configured: false };
  }
  if (accountsConfig.accounts.length === 1) {
    return {
      configured: true,
      username: accountsConfig.accounts[0].username,
      password: accountsConfig.accounts[0].password,
    };
  }
  return {
    configured: true,
    accounts: accountsConfig.accounts.slice(),
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

function credentialsMatchConfiguredAccount(username, password, account) {
  const usernameMatches = timingSafeEqualString(username, account.username);
  const passwordMatches = timingSafeEqualString(password, account.password);
  return usernameMatches && passwordMatches;
}

/**
 * Constant-work credential check across every configured account.
 * Always evaluates username + password digests for each account (no short-circuit skip).
 */
function credentialsMatchAnyConfiguredAccount(username, password) {
  const accountsConfig = getCrowsnestAuthAccounts();
  if (!accountsConfig.configured) return false;
  let matched = false;
  for (let i = 0; i < accountsConfig.accounts.length; i += 1) {
    const accountMatched = credentialsMatchConfiguredAccount(
      username,
      password,
      accountsConfig.accounts[i],
    );
    matched = matched || accountMatched;
  }
  return matched;
}

function isCrowsnestRequestAuthorized(req) {
  if (!isCrowsnestAuthEnabled()) return true;

  const accountsConfig = getCrowsnestAuthAccounts();
  if (!accountsConfig.configured) return false;

  const creds = parseBasicAuthHeader(req);
  if (!creds) return false;

  return credentialsMatchAnyConfiguredAccount(creds.username, creds.password);
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
  return credentialsMatchAnyConfiguredAccount(username, password);
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
  getCrowsnestAuthAccounts,
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
