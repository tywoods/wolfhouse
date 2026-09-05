'use strict';
// Public design mockup only. No application imports, database, credentials or API routes.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const allowed = new Set(['/', '/staff/login', '/staff/login/', '/staff/ui', '/staff/ui/']);
const server = http.createServer((req, res) => {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { ...headers, 'Allow': 'GET, HEAD' }); return res.end();
  }
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { res.writeHead(400, headers); return res.end(); }
  if (pathname === '/healthz') {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
    return res.end(req.method === 'HEAD' ? undefined : 'sunset-coastal-mockup-ok');
  }
  if (!allowed.has(pathname)) { res.writeHead(404, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
  res.end(req.method === 'HEAD' ? undefined : html);
});
const port = Number(process.env.DESIGN_PREVIEW_PORT || 8710);
server.listen(port, '127.0.0.1', () => console.log(`Public static Sunset design mockup ready on loopback:${port}`));
