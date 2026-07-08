'use strict';

/**
 * Crowsnest — internal dev/operator control portal (skeleton).
 * Standalone HTTP server; separate from staff-query-api.js.
 * No DB, no writes, no Staff API calls. See docs/CROWSNEST.md.
 */

const http = require('http');
const { renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');
const { isCrowsnestAuthEnabled, getAllowedCrowsnestUsers } = require('./lib/crowsnest/crowsnest-auth');

const PORT = Number(process.env.CROWSNEST_PORT) || 3040;
const HOST = process.env.CROWSNEST_HOST || '0.0.0.0';

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHTML(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html, 'utf8'),
  });
  res.end(html);
}

function router(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    return sendJSON(res, 405, { success: false, error: 'method not allowed' });
  }

  if (pathname === '/healthz') {
    if (method === 'HEAD') {
      res.writeHead(200);
      return res.end();
    }
    return sendJSON(res, 200, {
      status: 'ok',
      service: 'crowsnest',
      stage: 'skeleton',
      writes_enabled: false,
      auth_enabled: isCrowsnestAuthEnabled(),
      allowed_users: getAllowedCrowsnestUsers(),
    });
  }

  if (pathname === '/' || pathname === '/crowsnest' || pathname === '/crowsnest/ui') {
    if (method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end();
    }
    return sendHTML(res, 200, renderCrowsnestPage());
  }

  return sendJSON(res, 404, { success: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  try {
    router(req, res);
  } catch (err) {
    sendJSON(res, 500, { success: false, error: 'internal server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Crowsnest skeleton running on http://${HOST}:${PORT}`);
    console.log('  writes_enabled: false');
    console.log(`  auth: ${isCrowsnestAuthEnabled() ? 'required (env)' : 'not enforced (skeleton)'}`);
  });
}

module.exports = { server, router, PORT, HOST };
