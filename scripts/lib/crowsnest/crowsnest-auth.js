'use strict';

/**
 * Crowsnest auth — HTTP Basic Auth gate for internal operator UI.
 * /healthz stays public. See docs/CROWSNEST.md.
 */

const crypto = require('crypto');

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

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

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isCrowsnestRequestAuthorized(req) {
  if (!isCrowsnestAuthEnabled()) return true;

  const config = getCrowsnestBasicAuthConfig();
  if (!config.configured) return false;

  const creds = parseBasicAuthHeader(req);
  if (!creds) return false;

  return timingSafeEqualString(creds.username, config.username)
    && timingSafeEqualString(creds.password, config.password);
}

function sendText(res, status, body, extraHeaders) {
  const payload = String(body);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    ...extraHeaders,
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
  isCrowsnestAuthEnabled,
  getCrowsnestAllowedUsers,
  getAllowedCrowsnestUsers,
  getCrowsnestBasicAuthConfig,
  parseBasicAuthHeader,
  isCrowsnestRequestAuthorized,
  sendCrowsnestAuthRequired,
  sendCrowsnestAuthMisconfigured,
};
