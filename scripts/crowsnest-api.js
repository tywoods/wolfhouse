'use strict';

/**
 * Crowsnest — internal dev/operator control portal.
 * Standalone HTTP server; separate from staff-query-api.js.
 * No DB, no writes, no Staff API calls. See docs/CROWSNEST.md.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { renderCrowsnestLoginPage, renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');
const {
  buildCrowsnestClearedSessionCookie,
  buildCrowsnestSessionCookie,
  clearExpiredCrowsnestSessions,
  createCrowsnestSession,
  destroyCrowsnestSession,
  getCrowsnestAllowedUsers,
  getCrowsnestBasicAuthConfig,
  getCrowsnestLoginBodyLimit,
  isCrowsnestAuthEnabled,
  isCrowsnestLoginAccepted,
  isCrowsnestRequestAuthorized,
  isCrowsnestSessionAuthorized,
  sendCrowsnestAuthMisconfigured,
} = require('./lib/crowsnest/crowsnest-auth');

const PORT = Number(process.env.CROWSNEST_PORT) || 3040;
const HOST = process.env.CROWSNEST_HOST || '0.0.0.0';
const ASSET_PATH = path.join(__dirname, '..', 'public', 'crowsnest', 'logo.png');
const ASSET_ROUTE = '/crowsnest/assets/logo.png';
const BASE_BROWSER_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

let logoAsset = null;
try {
  logoAsset = fs.readFileSync(ASSET_PATH);
} catch {
  logoAsset = null;
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function createBrowserCspNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function getBrowserSecurityHeaders(cspNonce = '') {
  const headers = { ...BASE_BROWSER_HEADERS };
  if (cspNonce) {
    headers['Content-Security-Policy'] = [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "img-src 'self'",
      "script-src 'none'",
      `style-src 'nonce-${cspNonce}'`,
    ].join('; ');
  }
  return headers;
}

function sendJSON(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
    ...getBrowserSecurityHeaders(),
  });
  res.end(payload);
}

function sendHTML(res, status, html, extraHeaders = {}, cspNonce = '') {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html, 'utf8'),
    ...extraHeaders,
    ...getBrowserSecurityHeaders(cspNonce),
  });
  res.end(html);
}

function sendImage(res, status, buffer, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'image/png',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...extraHeaders,
    ...getBrowserSecurityHeaders(),
  });
  res.end(buffer);
}

function sendRedirect(res, location, extraHeaders = {}) {
  const body = `Redirecting to ${location}`;
  res.writeHead(302, {
    Location: location,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    ...extraHeaders,
    ...getBrowserSecurityHeaders(),
  });
  res.end(body);
}

function sendNoContentLike(res, status, extraHeaders = {}) {
  res.writeHead(status, {
    ...extraHeaders,
    ...getBrowserSecurityHeaders(),
  });
  res.end();
}

function sendMethodNotAllowed(res, allow) {
  return sendJSON(res, 405, { success: false, error: 'method not allowed' }, { Allow: allow });
}

function getRequestMethod(req) {
  return (req.method || 'GET').toUpperCase();
}

function getRequestPath(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.pathname;
}

function isBrowserUiAuthorized(req) {
  if (!isCrowsnestAuthEnabled()) return true;
  return isCrowsnestSessionAuthorized(req) || isCrowsnestRequestAuthorized(req);
}

function hasLoginFormContentType(req) {
  const header = String(req.headers['content-type'] || '').toLowerCase();
  return header.startsWith('application/x-www-form-urlencoded');
}

function readLimitedBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }
      total += chunk.length;
      if (total > limitBytes) {
        tooLarge = true;
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendPayloadTooLarge(res) {
  return sendHTML(res, 413, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payload Too Large</title></head><body>Payload Too Large</body></html>', {
    'Cache-Control': 'no-store',
  }, createBrowserCspNonce());
}

function parseFormBody(body) {
  const params = new URLSearchParams(String(body || ''));
  return {
    username: String(params.get('username') || ''),
    password: String(params.get('password') || ''),
  };
}

function getSessionCookieHeader(token) {
  return buildCrowsnestSessionCookie(token, { secure: isProduction() });
}

function getClearedSessionCookieHeader() {
  return buildCrowsnestClearedSessionCookie({ secure: isProduction() });
}

async function handleLogin(req, res, method) {
  if (method === 'GET' || method === 'HEAD') {
    if (isBrowserUiAuthorized(req)) {
      return sendRedirect(res, '/', { 'Cache-Control': 'no-store' });
    }
    if (method === 'HEAD') {
      return sendNoContentLike(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    const cspNonce = createBrowserCspNonce();
    return sendHTML(res, 200, renderCrowsnestLoginPage({ cspNonce }), { 'Cache-Control': 'no-store' }, cspNonce);
  }

  if (method !== 'POST') {
    return sendMethodNotAllowed(res, 'GET, HEAD, POST');
  }

  if (!hasLoginFormContentType(req)) {
    const cspNonce = createBrowserCspNonce();
    const html = renderCrowsnestLoginPage({ invalidCredentials: true, cspNonce });
    return sendHTML(res, 200, html, { 'Cache-Control': 'no-store' }, cspNonce);
  }

  let body;
  try {
    body = await readLimitedBody(req, getCrowsnestLoginBodyLimit());
  } catch (err) {
    if (err && err.message === 'body too large') {
      return sendPayloadTooLarge(res);
    }
    const cspNonce = createBrowserCspNonce();
    const html = renderCrowsnestLoginPage({ invalidCredentials: true, cspNonce });
    return sendHTML(res, 200, html, { 'Cache-Control': 'no-store' }, cspNonce);
  }

  const { username, password } = parseFormBody(body);
  if (!isCrowsnestLoginAccepted(username, password)) {
    const cspNonce = createBrowserCspNonce();
    const html = renderCrowsnestLoginPage({ invalidCredentials: true, cspNonce });
    return sendHTML(res, 200, html, { 'Cache-Control': 'no-store' }, cspNonce);
  }

  const token = createCrowsnestSession(username);
  return sendRedirect(res, '/', {
    'Set-Cookie': getSessionCookieHeader(token),
    'Cache-Control': 'no-store',
  });
}

async function handleLogout(req, res, method) {
  if (method !== 'POST') {
    return sendMethodNotAllowed(res, 'POST');
  }
  const cookies = new URLSearchParams('');
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    cookies.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  const token = cookies.get('crowsnest_session');
  if (token) destroyCrowsnestSession(token);
  return sendRedirect(res, '/login', {
    'Set-Cookie': getClearedSessionCookieHeader(),
    'Cache-Control': 'no-store',
  });
}

function handleAsset(req, res, method) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  if (!logoAsset) {
    return sendJSON(res, 404, { success: false, error: 'not found' });
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200, {
      'Content-Type': 'image/png',
      'Content-Length': logoAsset.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }
  return sendImage(res, 200, logoAsset);
}

function handleHealthz(req, res, method) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200);
  }
  return sendJSON(res, 200, {
    status: 'ok',
    service: 'crowsnest',
    stage: 'portal',
    writes_enabled: false,
    auth_enabled: isCrowsnestAuthEnabled(),
    allowed_users: getCrowsnestAllowedUsers(),
  });
}

function handleProtectedUi(req, res, method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  const cspNonce = createBrowserCspNonce();
  return sendHTML(res, 200, renderCrowsnestPage({ cspNonce }), { 'Cache-Control': 'no-store' }, cspNonce);
}

async function router(req, res) {
  clearExpiredCrowsnestSessions();
  const pathname = getRequestPath(req);
  const method = getRequestMethod(req);
  const authEnabled = isCrowsnestAuthEnabled();
  const authConfig = getCrowsnestBasicAuthConfig();

  if (authEnabled && !authConfig.configured && pathname !== '/healthz') {
    return sendCrowsnestAuthMisconfigured(res);
  }

  if (pathname === '/healthz') {
    return handleHealthz(req, res, method);
  }

  if (pathname === '/login') {
    return handleLogin(req, res, method);
  }

  if (pathname === '/logout') {
    return handleLogout(req, res, method);
  }

  if (pathname === ASSET_ROUTE) {
    return handleAsset(req, res, method);
  }

  if (pathname === '/' || pathname === '/crowsnest' || pathname === '/crowsnest/ui') {
    return handleProtectedUi(req, res, method, pathname);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }

  return sendJSON(res, 404, { success: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  Promise.resolve(router(req, res)).catch((err) => {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // ignore
      }
      return;
    }
    sendJSON(res, 500, { success: false, error: 'internal server error' });
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Crowsnest portal running on http://${HOST}:${PORT}`);
    console.log('  writes_enabled: false');
    console.log(`  auth: ${isCrowsnestAuthEnabled() ? 'required' : 'not required'}`);
  });
}

module.exports = { server, router, PORT, HOST };
