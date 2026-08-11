'use strict';

/**
 * Design sandbox server — design-sunset.lunafrontdesk.com
 *
 * Serves the REAL staff portal HTML (via the production buildUiHtml builder)
 * backed by MOCK data, so UI changes can be reviewed in situ before they go
 * anywhere near staging.
 *
 * Hard guarantees:
 *   - no Postgres, no Stripe, no WhatsApp, no Azure
 *   - every data endpoint answers from scripts/lib/design-sandbox-fixtures.js
 *   - writes are accepted and thrown away (so drawers don't error mid-demo)
 *
 * Run:  node scripts/design-sandbox-server.js
 * Env:  DESIGN_SANDBOX_PORT, DESIGN_SANDBOX_EMAIL, DESIGN_SANDBOX_PASSWORD,
 *       DESIGN_SANDBOX_SESSION_SECRET
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const { buildScheduleDayPayload, DEFAULT_LOCATION_ID } = require('./lib/design-sandbox-fixtures');

const PORT = Number(process.env.DESIGN_SANDBOX_PORT || 8710);
const HOST = process.env.DESIGN_SANDBOX_HOST || '127.0.0.1';
const EMAIL = String(process.env.DESIGN_SANDBOX_EMAIL || '').trim().toLowerCase();
const PASSWORD = String(process.env.DESIGN_SANDBOX_PASSWORD || '');
const SECRET = String(process.env.DESIGN_SANDBOX_SESSION_SECRET || '').trim();
// Which tenant's portal to render. 'sunset' gives the Luna Sunset surf-shop
// screens (schedule board, drawers); 'wolfhouse-somo' gives the booking side.
const CLIENT_SLUG = String(process.env.DESIGN_SANDBOX_CLIENT || 'sunset').trim();
const COOKIE = 'design_sandbox_session';
const ASSET_DIR = path.join(__dirname, '..', 'config', 'staff-portal');

if (!EMAIL || !PASSWORD || !SECRET) {
  console.error('Design sandbox refused startup: DESIGN_SANDBOX_EMAIL, '
    + 'DESIGN_SANDBOX_PASSWORD and DESIGN_SANDBOX_SESSION_SECRET are all required.');
  process.exit(1);
}

// ── Load the production UI builder through its offline seam ──────────────────
// buildUiHtml is pure string assembly; it never touches the DB.
process.env.NODE_ENV = 'test';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.STAFF_AUTH_REQUIRED = process.env.STAFF_AUTH_REQUIRED || 'true';
process.env.STAFF_AUTH_HTTPS = process.env.STAFF_AUTH_HTTPS || 'false';
process.env.STAFF_RUNTIME_PROFILE = 'test';
process.env.LUNA_BOT_INTERNAL_TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN
  || crypto.randomBytes(24).toString('hex');
// Drives which tenant's tab set the portal builds.
process.env.DEFAULT_CLIENT_SLUG = CLIENT_SLUG;

const staffApi = require('./staff-query-api.js');
const buildUiHtml = staffApi.buildUiHtmlForOfflineTest;
if (typeof buildUiHtml !== 'function') {
  console.error('Design sandbox refused startup: buildUiHtmlForOfflineTest seam unavailable.');
  process.exit(1);
}

// ── Session ──────────────────────────────────────────────────────────────────

function signSession(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 14,
  })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || Number(data.exp) < Date.now()) return null;
    return data;
  } catch (_e) { return null; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function isAuthed(req) {
  return Boolean(verifySession(readCookie(req, COOKIE)));
}

// ── Responses ────────────────────────────────────────────────────────────────

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendHtml(res, code, html) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

function loginHtml(error) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Luna Front Desk — Design Sandbox</title>
<link rel="icon" href="/staff/assets/luna-favicon.png">
<style>
  :root { --teal:#1d8681; --teal-dark:#2c5f56; --cream:#fff8e9; --terracotta:#ca6d45; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:'Nunito',system-ui,sans-serif; min-height:100vh; display:grid;
         place-items:center; background:linear-gradient(160deg,#2c5f56,#101b21); padding:1.5rem; }
  .card { width:min(420px,100%); background:#fffdf8; border-radius:18px; padding:2rem;
          box-shadow:0 18px 50px rgba(10,40,45,.35); }
  .banner { width:100%; border-radius:10px; margin-bottom:1.4rem; display:block; }
  h1 { font-size:1.1rem; color:var(--teal-dark); margin-bottom:.35rem; }
  p.sub { font-size:.85rem; color:#8a7a63; margin-bottom:1.4rem; }
  label { display:block; font-size:.78rem; font-weight:800; color:var(--teal-dark);
          text-transform:uppercase; letter-spacing:.04em; margin:0 0 .35rem; }
  input { width:100%; padding:.7rem .85rem; font:inherit; border:1.5px solid #e8e1d3;
          border-radius:10px; margin-bottom:1rem; background:#fff; }
  input:focus { outline:none; border-color:var(--teal); }
  button { width:100%; padding:.8rem; font:inherit; font-weight:800; color:#fff; border:none;
           border-radius:999px; background:var(--terracotta); cursor:pointer; }
  button:hover { background:#b45c37; }
  .err { background:#fdecea; color:#a4362c; font-size:.85rem; padding:.6rem .8rem;
         border-radius:8px; margin-bottom:1rem; }
  .flag { margin-top:1.4rem; font-size:.74rem; color:#8a7a63; text-align:center; line-height:1.5; }
</style></head>
<body>
  <form class="card" method="POST" action="/staff/login">
    <img class="banner" src="/staff/assets/luna-header-banner.png" alt="Luna Front Desk">
    <h1>Design sandbox</h1>
    <p class="sub">Mock data only — not staging, not production.</p>
    ${error ? `<div class="err">${error}</div>` : ''}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <div class="flag">Every booking shown in here is invented.<br>Nothing you click reaches a real guest.</div>
  </form>
</body></html>`;
}

/** Banner strip injected into the portal so nobody mistakes this for staging. */
function designSandboxBadge() {
  return `<style>
  #design-sandbox-flag { position:fixed; left:0; right:0; bottom:0; z-index:99999;
    background:#ca6d45; color:#fff8e9; font:700 12px/1 'Nunito',system-ui,sans-serif;
    letter-spacing:.06em; text-transform:uppercase; text-align:center; padding:7px 10px;
    box-shadow:0 -2px 10px rgba(10,40,45,.25); pointer-events:none; }
  body { padding-bottom:30px !important; }
</style>
<div id="design-sandbox-flag">Design sandbox — mock data</div>`;
}

/**
 * Sandbox-only header variants, switchable live with ?header=…
 * Lets us compare banner heights side by side without a redeploy. None of this
 * ships — the branch itself only carries the `compact` values.
 */
function headerVariantCss(variant) {
  if (variant === 'full') {
    // The banner art at its intended full aspect (1989x329).
    return `<style>.luna-header-ui #banner{height:auto;flex:0 0 auto;min-height:0;aspect-ratio:1989/329;background-size:100% auto;background-position:center}</style>`;
  }
  if (variant === 'compact') {
    return `<style>.luna-header-ui{--luna-banner-h:104px}</style>`;
  }
  if (variant === 'off') {
    return `<script>document.addEventListener('DOMContentLoaded',function(){document.body.classList.remove('luna-header-ui');});</script>`;
  }
  return '';
}

function portalHtml(req) {
  let html = buildUiHtml(PORT, CLIENT_SLUG);
  const variant = String(url.parse(req.url, true).query.header || '').trim();
  const variantCss = headerVariantCss(variant);
  if (variantCss) {
    html = html.includes('</head>')
      ? html.replace('</head>', `${variantCss}\n</head>`)
      : variantCss + html;
  }
  const badge = designSandboxBadge();
  html = html.includes('</body>')
    ? html.replace('</body>', `${badge}\n</body>`)
    : html + badge;
  return html;
}

// ── Static assets ────────────────────────────────────────────────────────────

const ASSETS = {
  '/staff/assets/luna-favicon.png': 'luna-favicon.png',
  '/favicon.ico': 'luna-favicon.png',
  '/staff/assets/luna-front-desk-logo.png': 'luna-front-desk-logo.png',
  '/staff/assets/luna-login-signin-btn.png': 'luna-login-signin-btn.png',
  '/staff/assets/luna-header-banner.png': 'luna-header-banner.png',
};

function serveAsset(res, file) {
  const full = path.join(ASSET_DIR, file);
  fs.readFile(full, (err, buf) => {
    if (err) return sendJson(res, 404, { success: false, error: 'not found' });
    res.writeHead(200, {
      'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/png',
      'Cache-Control': 'public, max-age=300',
      'Content-Length': buf.length,
    });
    return res.end(buf);
  });
}

// ── Request body ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 512) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// ── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  const method = (req.method || 'GET').toUpperCase();

  // Public assets
  if (ASSETS[pathname]) return serveAsset(res, ASSETS[pathname]);

  // Health (used by the systemd unit / Caddy)
  if (pathname === '/healthz') return sendJson(res, 200, { status: 'ok', sandbox: true });

  // Login
  if (pathname === '/staff/login' && method === 'GET') {
    if (isAuthed(req)) return redirect(res, '/staff/ui');
    return sendHtml(res, 200, loginHtml(null));
  }
  if (pathname === '/staff/login' && method === 'POST') {
    const body = await readBody(req);
    const form = new url.URLSearchParams(body);
    const email = String(form.get('email') || '').trim().toLowerCase();
    const password = String(form.get('password') || '');
    const emailOk = email === EMAIL;
    const passBuf = Buffer.from(password);
    const wantBuf = Buffer.from(PASSWORD);
    const passOk = passBuf.length === wantBuf.length && crypto.timingSafeEqual(passBuf, wantBuf);
    if (!emailOk || !passOk) {
      return sendHtml(res, 401, loginHtml('Wrong email or password.'));
    }
    res.writeHead(302, {
      Location: '/staff/ui',
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(signSession(email))}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${60 * 60 * 24 * 14}`,
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  if (pathname === '/staff/logout') {
    res.writeHead(302, {
      Location: '/staff/login',
      'Set-Cookie': `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0`,
    });
    return res.end();
  }

  // Everything below needs a session
  if (!isAuthed(req)) {
    if (pathname.startsWith('/staff/') && !pathname.endsWith('/ui') && method !== 'GET') {
      return sendJson(res, 401, { success: false, error: 'unauthorized' });
    }
    return redirect(res, '/staff/login');
  }

  if (pathname === '/' || pathname === '/staff' || pathname === '/staff/ui') {
    return sendHtml(res, 200, portalHtml(req));
  }

  // ── Mock data endpoints ────────────────────────────────────────────────────
  if (pathname === '/staff/schedule/day' && method === 'GET') {
    const date = String(parsed.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendJson(res, 400, { success: false, error: 'invalid date' });
    }
    const loc = String(parsed.query.location || DEFAULT_LOCATION_ID).trim();
    return sendJson(res, 200, buildScheduleDayPayload(date, loc));
  }

  // The portal keeps its tabs behind a full-page gate until this resolves, and
  // the tab set / default tab come from the real per-client profile loader.
  if (pathname === '/staff/auth/session') {
    const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
    return sendJson(res, 200, {
      success: true,
      auth_required: true,
      role: 'admin',
      db_role: 'admin',
      email: EMAIL,
      display_name: 'Design Sandbox',
      active_client: CLIENT_SLUG,
      clients: [{ slug: CLIENT_SLUG, name: 'Luna Sunset (sandbox)' }],
      client_profiles: { [CLIENT_SLUG]: loadClientPortalProfile(CLIENT_SLUG) },
      can_use_owner_insights: true,
      design_sandbox: true,
    });
  }

  if (pathname === '/staff/admin/config/rental-offerings') {
    return sendJson(res, 200, { success: true, offerings: [], design_sandbox: true });
  }

  if (pathname === '/staff/conversations') {
    return sendJson(res, 200, { success: true, rows: [], conversations: [], design_sandbox: true });
  }

  // Writes are swallowed — the sandbox has nothing to write to.
  if (method !== 'GET') {
    return sendJson(res, 200, {
      success: true,
      design_sandbox: true,
      note: 'write ignored — design sandbox has no database',
    });
  }

  // Unmodelled GETs answer empty rather than 404 so the portal boots clean.
  return sendJson(res, 200, { success: true, rows: [], design_sandbox: true });
});

server.listen(PORT, HOST, () => {
  console.log(`Design sandbox listening on http://${HOST}:${PORT}`);
  console.log('  MOCK DATA ONLY — no Postgres, no Stripe, no WhatsApp.');
  console.log(`  Sign in as ${EMAIL}`);
});

server.on('error', (err) => {
  console.error(`Design sandbox server error: ${err.message}`);
  process.exit(1);
});
