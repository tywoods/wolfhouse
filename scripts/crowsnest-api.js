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
  getCrowsnestAuthAccounts,
  getCrowsnestLoginBodyLimit,
  isCrowsnestAuthEnabled,
  isCrowsnestLoginAccepted,
  isCrowsnestRequestAuthorized,
  isCrowsnestSessionAuthorized,
  parseBasicAuthHeader,
  sendCrowsnestAuthMisconfigured,
} = require('./lib/crowsnest/crowsnest-auth');
const {
  createProspect,
  decideProspect,
  getCrmSyncPreview,
  getCurrentOutreachDraft,
  getLatestCrmReviewMark,
  getLatestQualification,
  getOutreachDraftWorkspace,
  getProspect,
  getResearchForProspect,
  listAuditEvents,
  listProspects,
  listQualificationsForProspect,
  listResearchForProspect,
  listReviewQueue,
  markReadyForCrmReview,
  normalizeReviewQueueFilter,
  recordManualEvidence,
  recordQualification,
  saveOutreachDraft,
} = require('./lib/crowsnest/crowsnest-sales');
const {
  isSalesStoreUnavailableError,
  isSalesUnavailableResult,
} = require('./lib/crowsnest/crowsnest-sales-store');

const PORT = Number(process.env.CROWSNEST_PORT) || 3040;
const HOST = process.env.CROWSNEST_HOST || '0.0.0.0';
const ASSETS = new Map([
  ['/crowsnest/assets/logo.png', {
    path: path.join(__dirname, '..', 'public', 'crowsnest', 'logo.png'),
    contentType: 'image/png',
  }],
  ['/images/luna-login-bg.jpg', {
    path: path.join(__dirname, '..', 'public', 'images', 'luna-login-bg.jpg'),
    contentType: 'image/jpeg',
  }],
]);
const BASE_BROWSER_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

for (const asset of ASSETS.values()) {
  try {
    asset.buffer = fs.readFileSync(asset.path);
  } catch {
    asset.buffer = null;
  }
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

function sendImage(res, status, buffer, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
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

/** Safe, retryable Sales-store outage response — never includes DSN/SQL/credentials. */
function sendSalesUnavailable(res) {
  return sendJSON(
    res,
    503,
    {
      success: false,
      code: 'sales_unavailable',
      error: 'Crowsnest Sales store is temporarily unavailable. Please retry.',
      retryable: true,
    },
    { 'Retry-After': '5' },
  );
}

function isSalesUnavailableFailure(value) {
  return isSalesUnavailableResult(value) || isSalesStoreUnavailableError(value);
}

function isSalesStoreFailure(value) {
  if (isSalesUnavailableFailure(value)) return true;
  return Boolean(
    value
      && value.ok === false
      && value.status === 503
      && (value.code === 'sales_store_misconfigured' || value.code === 'sales_unavailable'),
  );
}

function sendSalesStoreFailure(res, result) {
  if (isSalesUnavailableFailure(result) || (result && result.code === 'sales_unavailable')) {
    return sendSalesUnavailable(res);
  }
  return sendJSON(
    res,
    503,
    {
      success: false,
      code: (result && result.code) || 'sales_store_misconfigured',
      error: (result && result.error) || 'Crowsnest Sales durable store is not configured.',
    },
    { 'Cache-Control': 'no-store' },
  );
}

function getRequestMethod(req) {
  return (req.method || 'GET').toUpperCase();
}

function getRequestPath(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.pathname;
}

function getRequestSearchParams(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.searchParams;
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

function parseSalesFormBody(body) {
  const params = new URLSearchParams(String(body || ''));
  return {
    website_url: String(params.get('website_url') || ''),
    business_name: String(params.get('business_name') || ''),
    decision: String(params.get('decision') || ''),
    reason: String(params.get('reason') || ''),
    source_label: String(params.get('source_label') || ''),
    source_url: String(params.get('source_url') || ''),
    summary: String(params.get('summary') || ''),
    factual_notes: String(params.get('factual_notes') || ''),
    limitations: String(params.get('limitations') || ''),
    confidence: String(params.get('confidence') || ''),
    qualification_decision: String(params.get('qualification_decision') || ''),
    rationale: String(params.get('rationale') || ''),
    evidence_ids: params.getAll('evidence_ids').map((id) => String(id || '').trim()).filter(Boolean),
    subject: String(params.get('subject') || ''),
    body: String(params.get('body') || ''),
    channel: String(params.get('channel') || ''),
    next_step_note: String(params.get('next_step_note') || ''),
  };
}

function getSessionCookieHeader(token) {
  return buildCrowsnestSessionCookie(token, { secure: isProduction() });
}

function getClearedSessionCookieHeader() {
  return buildCrowsnestClearedSessionCookie({ secure: isProduction() });
}

function resolveOperatorActor(req) {
  const basic = parseBasicAuthHeader(req && req.headers && req.headers.authorization);
  if (basic && basic.username) return String(basic.username);
  // Session usernames are not exported from auth; MVP Admin label is enough for Slice 1 audit.
  if (isCrowsnestSessionAuthorized(req)) return 'Admin';
  return 'Admin';
}

function matchSalesProspectDetailPath(pathname) {
  const match = /^\/sales\/prospects\/([a-zA-Z0-9_-]+)$/.exec(String(pathname || ''));
  return match ? match[1] : null;
}

function matchSalesDecisionPath(pathname) {
  const match = /^\/sales\/prospects\/([a-zA-Z0-9_-]+)\/decision$/.exec(String(pathname || ''));
  return match ? match[1] : null;
}

function matchSalesEvidencePath(pathname) {
  const match = /^\/sales\/prospects\/([a-zA-Z0-9_-]+)\/evidence$/.exec(String(pathname || ''));
  return match ? match[1] : null;
}

function matchSalesQualificationPath(pathname) {
  const match = /^\/sales\/prospects\/([a-zA-Z0-9_-]+)\/qualification$/.exec(String(pathname || ''));
  return match ? match[1] : null;
}

function matchSalesCrmPreviewPath(pathname) {
  const match = /^\/sales\/prospects\/([a-zA-Z0-9_-]+)\/crm-preview$/.exec(String(pathname || ''));
  return match ? match[1] : null;
}

function matchSalesCrmReadyPath(pathname) {
  const match = /^\/sales\/prospects\/([a-zA-Z0-9_-]+)\/crm-ready$/.exec(String(pathname || ''));
  return match ? match[1] : null;
}

function matchSalesOutreachDraftPath(pathname) {
  const match = /^\/sales\/prospects\/([a-zA-Z0-9_-]+)\/outreach-draft$/.exec(String(pathname || ''));
  return match ? match[1] : null;
}

async function loadSalesDetailPageOptions(prospectId, extra = {}) {
  const prospect = await getProspect(prospectId);
  if (!prospect) {
    return { prospect: null };
  }
  const researchJobs = await listResearchForProspect(prospectId);
  const research = researchJobs.find((job) => job && job.source === 'fixture')
    || researchJobs[researchJobs.length - 1]
    || await getResearchForProspect(prospectId);
  const qualificationAssessments = await listQualificationsForProspect(prospectId);
  const latestQualification = await getLatestQualification(prospectId);
  const latestCrmReviewMark = await getLatestCrmReviewMark(prospectId);
  const currentOutreachDraft = await getCurrentOutreachDraft(prospectId);
  return {
    prospect,
    research,
    researchJobs,
    qualificationAssessments,
    latestQualification,
    latestCrmReviewMark,
    currentOutreachDraft,
    draftReady: Boolean(latestCrmReviewMark),
    draftPresent: Boolean(currentOutreachDraft),
    auditEvents: await listAuditEvents(prospectId),
    ...extra,
  };
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

function handleAsset(req, res, method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  const asset = ASSETS.get(pathname);
  if (!asset || !asset.buffer) {
    return sendJSON(res, 404, { success: false, error: 'not found' });
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200, {
      'Content-Type': asset.contentType,
      'Content-Length': asset.buffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }
  return sendImage(res, 200, asset.buffer, asset.contentType);
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

function resolveProtectedUiView(pathname) {
  if (pathname === '/clients') return 'clients';
  if (pathname === '/billing') return 'billing';
  if (pathname === '/communications') return 'communications';
  if (pathname === '/sales') return 'sales';
  // `/`, `/crowsnest`, `/crowsnest/ui` → Spyglass
  return 'spyglass';
}

async function handleProtectedUi(req, res, method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  const view = resolveProtectedUiView(pathname);
  const cspNonce = createBrowserCspNonce();
  const pageOptions = { cspNonce, view };
  try {
    if (view === 'sales') {
      pageOptions.prospects = await listProspects();
    }
    return sendHTML(res, 200, renderCrowsnestPage(pageOptions), { 'Cache-Control': 'no-store' }, cspNonce);
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }
}

async function handleSalesReviewQueue(req, res, method) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  const state = normalizeReviewQueueFilter(getRequestSearchParams(req).get('state'));
  try {
    const queue = await listReviewQueue({ state });
    if (isSalesStoreFailure(queue)) {
      return sendSalesStoreFailure(res, queue);
    }
    const cspNonce = createBrowserCspNonce();
    return sendHTML(
      res,
      200,
      renderCrowsnestPage({
        cspNonce,
        view: 'sales_review',
        reviewQueueFilter: (queue && queue.filter) || state,
        reviewQueueItems: (queue && queue.items) || [],
      }),
      { 'Cache-Control': 'no-store' },
      cspNonce,
    );
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }
}

async function handleSalesProspectDetail(req, res, method, prospectId) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  try {
    const pageOptions = await loadSalesDetailPageOptions(prospectId);
    const cspNonce = createBrowserCspNonce();
    if (!pageOptions.prospect) {
      return sendHTML(
        res,
        404,
        renderCrowsnestPage({ cspNonce, view: 'sales_detail', prospect: null }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    }
    return sendHTML(
      res,
      200,
      renderCrowsnestPage({
        cspNonce,
        view: 'sales_detail',
        ...pageOptions,
      }),
      { 'Cache-Control': 'no-store' },
      cspNonce,
    );
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }
}

async function handleSalesCreateProspect(req, res, method) {
  if (method !== 'POST') {
    return sendMethodNotAllowed(res, 'POST');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  if (!hasLoginFormContentType(req)) {
    try {
      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        400,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales',
          prospects: await listProspects(),
          intakeError: 'Provide a business website or a business name.',
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  let body;
  try {
    body = await readLimitedBody(req, getCrowsnestLoginBodyLimit());
  } catch (err) {
    if (err && err.message === 'body too large') {
      return sendPayloadTooLarge(res);
    }
    try {
      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        400,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales',
          prospects: await listProspects(),
          intakeError: 'Provide a business website or a business name.',
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    } catch (listErr) {
      if (isSalesUnavailableFailure(listErr)) {
        return sendSalesUnavailable(res);
      }
      throw listErr;
    }
  }

  const form = parseSalesFormBody(body);
  const actor = resolveOperatorActor(req);
  let result;
  try {
    result = await createProspect({
      website_url: form.website_url,
      business_name: form.business_name,
    }, actor);
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }

  if (!result.ok) {
    if (isSalesUnavailableFailure(result)) {
      return sendSalesUnavailable(res);
    }
    try {
      const status = result.status || 400;
      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        status,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales',
          prospects: await listProspects(),
          intakeError: result.error,
          intakeWebsiteUrl: form.website_url,
          intakeBusinessName: form.business_name,
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  return sendRedirect(res, `/sales/prospects/${result.prospect.id}`, { 'Cache-Control': 'no-store' });
}

async function handleSalesDecision(req, res, method, prospectId) {
  if (method !== 'POST') {
    return sendMethodNotAllowed(res, 'POST');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  const detailPath = `/sales/prospects/${prospectId}`;
  if (!hasLoginFormContentType(req)) {
    try {
      const pageOptions = await loadSalesDetailPageOptions(prospectId, {
        decisionError: 'A reason is required for Admin decisions.',
      });
      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        400,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales_detail',
          ...pageOptions,
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  let body;
  try {
    body = await readLimitedBody(req, getCrowsnestLoginBodyLimit());
  } catch (err) {
    if (err && err.message === 'body too large') {
      return sendPayloadTooLarge(res);
    }
    try {
      const pageOptions = await loadSalesDetailPageOptions(prospectId, {
        decisionError: 'A reason is required for Admin decisions.',
      });
      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        400,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales_detail',
          ...pageOptions,
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    } catch (listErr) {
      if (isSalesUnavailableFailure(listErr)) {
        return sendSalesUnavailable(res);
      }
      throw listErr;
    }
  }

  const form = parseSalesFormBody(body);
  const actor = resolveOperatorActor(req);
  let result;
  try {
    result = await decideProspect(prospectId, {
      decision: form.decision,
      reason: form.reason,
    }, actor);
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }

  if (!result.ok) {
    if (isSalesUnavailableFailure(result)) {
      return sendSalesUnavailable(res);
    }
    const status = result.status || 400;
    if (status === 404) {
      return sendJSON(res, 404, { success: false, error: 'not found' });
    }
    try {
      const pageOptions = await loadSalesDetailPageOptions(prospectId, {
        decisionError: result.error,
      });
      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        status,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales_detail',
          ...pageOptions,
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  return sendRedirect(res, detailPath, { 'Cache-Control': 'no-store' });
}

async function handleSalesEvidence(req, res, method, prospectId) {
  if (method !== 'POST') {
    return sendMethodNotAllowed(res, 'POST');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  const detailPath = `/sales/prospects/${prospectId}`;

  async function redisplay(status, error, form = {}) {
    const pageOptions = await loadSalesDetailPageOptions(prospectId, {
      evidenceError: error,
      evidenceSourceLabel: form.source_label || '',
      evidenceSourceUrl: form.source_url || '',
      evidenceSummary: form.summary || '',
      evidenceFactualNotes: form.factual_notes || '',
      evidenceLimitations: form.limitations || '',
      evidenceConfidence: form.confidence || '',
    });
    const cspNonce = createBrowserCspNonce();
    return sendHTML(
      res,
      status,
      renderCrowsnestPage({
        cspNonce,
        view: 'sales_detail',
        ...pageOptions,
      }),
      { 'Cache-Control': 'no-store' },
      cspNonce,
    );
  }

  if (!hasLoginFormContentType(req)) {
    try {
      return await redisplay(400, 'Source label is required.');
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  let body;
  try {
    body = await readLimitedBody(req, getCrowsnestLoginBodyLimit());
  } catch (err) {
    if (err && err.message === 'body too large') {
      return sendPayloadTooLarge(res);
    }
    try {
      return await redisplay(400, 'Source label is required.');
    } catch (listErr) {
      if (isSalesUnavailableFailure(listErr)) {
        return sendSalesUnavailable(res);
      }
      throw listErr;
    }
  }

  const form = parseSalesFormBody(body);
  const actor = resolveOperatorActor(req);
  let result;
  try {
    result = await recordManualEvidence(prospectId, {
      source_label: form.source_label,
      source_url: form.source_url,
      summary: form.summary,
      factual_notes: form.factual_notes,
      limitations: form.limitations,
      confidence: form.confidence,
    }, actor);
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }

  if (!result.ok) {
    if (isSalesUnavailableFailure(result)) {
      return sendSalesUnavailable(res);
    }
    const status = result.status || 400;
    if (status === 404) {
      return sendJSON(res, 404, { success: false, error: 'not found' });
    }
    try {
      return await redisplay(status, result.error, form);
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  return sendRedirect(res, detailPath, { 'Cache-Control': 'no-store' });
}

async function handleSalesQualification(req, res, method, prospectId) {
  if (method !== 'POST') {
    return sendMethodNotAllowed(res, 'POST');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  const detailPath = `/sales/prospects/${prospectId}`;

  async function redisplay(status, error, form = {}) {
    const pageOptions = await loadSalesDetailPageOptions(prospectId, {
      qualificationError: error,
      qualificationDecision: form.qualification_decision || '',
      qualificationRationale: form.rationale || '',
      qualificationEvidenceIds: Array.isArray(form.evidence_ids) ? form.evidence_ids : [],
    });
    const cspNonce = createBrowserCspNonce();
    return sendHTML(
      res,
      status,
      renderCrowsnestPage({
        cspNonce,
        view: 'sales_detail',
        ...pageOptions,
      }),
      { 'Cache-Control': 'no-store' },
      cspNonce,
    );
  }

  if (!hasLoginFormContentType(req)) {
    try {
      return await redisplay(400, 'A rationale is required for qualification assessments.');
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  let body;
  try {
    body = await readLimitedBody(req, getCrowsnestLoginBodyLimit());
  } catch (err) {
    if (err && err.message === 'body too large') {
      return sendPayloadTooLarge(res);
    }
    try {
      return await redisplay(400, 'A rationale is required for qualification assessments.');
    } catch (listErr) {
      if (isSalesUnavailableFailure(listErr)) {
        return sendSalesUnavailable(res);
      }
      throw listErr;
    }
  }

  const form = parseSalesFormBody(body);
  const actor = resolveOperatorActor(req);
  let result;
  try {
    result = await recordQualification(prospectId, {
      qualification_decision: form.qualification_decision,
      rationale: form.rationale,
      evidence_ids: form.evidence_ids,
    }, actor);
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }

  if (!result.ok) {
    if (isSalesUnavailableFailure(result)) {
      return sendSalesUnavailable(res);
    }
    const status = result.status || 400;
    if (status === 404) {
      return sendJSON(res, 404, { success: false, error: 'not found' });
    }
    try {
      return await redisplay(status, result.error, form);
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  return sendRedirect(res, detailPath, { 'Cache-Control': 'no-store' });
}

async function handleSalesCrmPreview(req, res, method, prospectId) {
  if (method !== 'GET' && method !== 'HEAD') {
    return sendMethodNotAllowed(res, 'GET, HEAD');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  if (method === 'HEAD') {
    return sendNoContentLike(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  try {
    const result = await getCrmSyncPreview(prospectId);
    if (isSalesStoreFailure(result)) {
      return sendSalesStoreFailure(res, result);
    }
    if (!result.ok) {
      const status = result.status || 400;
      if (status === 404) {
        return sendJSON(res, 404, { success: false, error: 'not found' });
      }
      const pageOptions = await loadSalesDetailPageOptions(prospectId, {
        crmReadyError: result.error,
      });
      if (!pageOptions.prospect) {
        return sendJSON(res, 404, { success: false, error: 'not found' });
      }
      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        status,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales_detail',
          ...pageOptions,
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    }

    const cspNonce = createBrowserCspNonce();
    return sendHTML(
      res,
      200,
      renderCrowsnestPage({
        cspNonce,
        view: 'sales_crm_preview',
        prospect: result.prospect,
        qualification: result.qualification,
        latestCrmReviewMark: result.latestCrmReviewMark,
        crmPreview: result.preview,
        auditEvents: await listAuditEvents(prospectId),
      }),
      { 'Cache-Control': 'no-store' },
      cspNonce,
    );
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }
}

async function handleSalesCrmReady(req, res, method, prospectId) {
  if (method !== 'POST') {
    return sendMethodNotAllowed(res, 'POST');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }
  const previewPath = `/sales/prospects/${prospectId}/crm-preview`;

  async function redisplay(status, error) {
    const pageOptions = await loadSalesDetailPageOptions(prospectId, {
      crmReadyError: error,
    });
    const cspNonce = createBrowserCspNonce();
    return sendHTML(
      res,
      status,
      renderCrowsnestPage({
        cspNonce,
        view: 'sales_detail',
        ...pageOptions,
      }),
      { 'Cache-Control': 'no-store' },
      cspNonce,
    );
  }

  const actor = resolveOperatorActor(req);
  let result;
  try {
    result = await markReadyForCrmReview(prospectId, actor);
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }

  if (!result.ok) {
    if (isSalesUnavailableFailure(result)) {
      return sendSalesUnavailable(res);
    }
    const status = result.status || 400;
    if (status === 404) {
      return sendJSON(res, 404, { success: false, error: 'not found' });
    }
    try {
      return await redisplay(status, result.error);
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  return sendRedirect(res, previewPath, { 'Cache-Control': 'no-store' });
}

async function handleSalesOutreachDraft(req, res, method, prospectId) {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return sendMethodNotAllowed(res, 'GET, HEAD, POST');
  }
  if (!isBrowserUiAuthorized(req)) {
    return sendRedirect(res, '/login', { 'Cache-Control': 'no-store' });
  }

  const draftPath = `/sales/prospects/${prospectId}/outreach-draft`;

  async function redisplay(status, error, formValues = {}) {
    const pageOptions = await loadSalesDetailPageOptions(prospectId, {
      outreachDraftError: error,
      ...formValues,
    });
    const cspNonce = createBrowserCspNonce();
    return sendHTML(
      res,
      status,
      renderCrowsnestPage({
        cspNonce,
        view: 'sales_detail',
        ...pageOptions,
      }),
      { 'Cache-Control': 'no-store' },
      cspNonce,
    );
  }

  if (method === 'GET' || method === 'HEAD') {
    if (method === 'HEAD') {
      return sendNoContentLike(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    try {
      const result = await getOutreachDraftWorkspace(prospectId);
      if (isSalesStoreFailure(result)) {
        return sendSalesStoreFailure(res, result);
      }
      if (!result.ok) {
        const status = result.status || 400;
        if (status === 404) {
          return sendJSON(res, 404, { success: false, error: 'not found' });
        }
        return redisplay(status, result.error);
      }

      const cspNonce = createBrowserCspNonce();
      return sendHTML(
        res,
        200,
        renderCrowsnestPage({
          cspNonce,
          view: 'sales_outreach_draft',
          prospect: result.prospect,
          latestCrmReviewMark: result.latestCrmReviewMark,
          currentOutreachDraft: result.currentDraft,
          outreachDraftRevisions: result.revisions,
          draftReady: result.draft_ready,
          draftPresent: result.draft_present,
          auditEvents: await listAuditEvents(prospectId),
        }),
        { 'Cache-Control': 'no-store' },
        cspNonce,
      );
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  // POST — create/edit current draft (append revision)
  if (!hasLoginFormContentType(req)) {
    try {
      return await redisplay(400, 'Subject is required.');
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  let body;
  try {
    body = await readLimitedBody(req, getCrowsnestLoginBodyLimit());
  } catch (err) {
    if (err && err.message === 'body too large') {
      return sendPayloadTooLarge(res);
    }
    try {
      return await redisplay(400, 'Subject is required.');
    } catch (listErr) {
      if (isSalesUnavailableFailure(listErr)) {
        return sendSalesUnavailable(res);
      }
      throw listErr;
    }
  }

  const fields = parseSalesFormBody(body);
  const actor = resolveOperatorActor(req);
  let result;
  try {
    result = await saveOutreachDraft(prospectId, {
      subject: fields.subject,
      body: fields.body,
      channel: fields.channel,
      next_step_note: fields.next_step_note,
    }, actor);
  } catch (err) {
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
    }
    throw err;
  }

  if (!result.ok) {
    if (isSalesUnavailableFailure(result)) {
      return sendSalesUnavailable(res);
    }
    const status = result.status || 400;
    if (status === 404) {
      return sendJSON(res, 404, { success: false, error: 'not found' });
    }
    try {
      // If CRM-ready, redisplay workspace with error; otherwise detail with gate error.
      const workspace = await getOutreachDraftWorkspace(prospectId);
      if (workspace && workspace.ok) {
        const cspNonce = createBrowserCspNonce();
        return sendHTML(
          res,
          status,
          renderCrowsnestPage({
            cspNonce,
            view: 'sales_outreach_draft',
            prospect: workspace.prospect,
            latestCrmReviewMark: workspace.latestCrmReviewMark,
            currentOutreachDraft: workspace.currentDraft,
            outreachDraftRevisions: workspace.revisions,
            draftReady: workspace.draft_ready,
            draftPresent: workspace.draft_present,
            outreachDraftError: result.error,
            outreachDraftSubject: fields.subject,
            outreachDraftBody: fields.body,
            outreachDraftChannel: fields.channel,
            outreachDraftNextStepNote: fields.next_step_note,
            auditEvents: await listAuditEvents(prospectId),
          }),
          { 'Cache-Control': 'no-store' },
          cspNonce,
        );
      }
      return await redisplay(status, result.error, {
        outreachDraftSubject: fields.subject,
        outreachDraftBody: fields.body,
        outreachDraftChannel: fields.channel,
        outreachDraftNextStepNote: fields.next_step_note,
      });
    } catch (err) {
      if (isSalesUnavailableFailure(err)) {
        return sendSalesUnavailable(res);
      }
      throw err;
    }
  }

  return sendRedirect(res, draftPath, { 'Cache-Control': 'no-store' });
}

async function router(req, res) {
  clearExpiredCrowsnestSessions();
  const pathname = getRequestPath(req);
  const method = getRequestMethod(req);
  const authEnabled = isCrowsnestAuthEnabled();
  const authConfig = getCrowsnestAuthAccounts();

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

  if (ASSETS.has(pathname)) {
    return handleAsset(req, res, method, pathname);
  }

  if (pathname === '/sales/prospects') {
    return handleSalesCreateProspect(req, res, method);
  }

  if (pathname === '/sales/review') {
    return handleSalesReviewQueue(req, res, method);
  }

  const decisionProspectId = matchSalesDecisionPath(pathname);
  if (decisionProspectId) {
    return handleSalesDecision(req, res, method, decisionProspectId);
  }

  const evidenceProspectId = matchSalesEvidencePath(pathname);
  if (evidenceProspectId) {
    return handleSalesEvidence(req, res, method, evidenceProspectId);
  }

  const qualificationProspectId = matchSalesQualificationPath(pathname);
  if (qualificationProspectId) {
    return handleSalesQualification(req, res, method, qualificationProspectId);
  }

  const crmPreviewProspectId = matchSalesCrmPreviewPath(pathname);
  if (crmPreviewProspectId) {
    return handleSalesCrmPreview(req, res, method, crmPreviewProspectId);
  }

  const crmReadyProspectId = matchSalesCrmReadyPath(pathname);
  if (crmReadyProspectId) {
    return handleSalesCrmReady(req, res, method, crmReadyProspectId);
  }

  const outreachDraftProspectId = matchSalesOutreachDraftPath(pathname);
  if (outreachDraftProspectId) {
    return handleSalesOutreachDraft(req, res, method, outreachDraftProspectId);
  }

  const detailProspectId = matchSalesProspectDetailPath(pathname);
  if (detailProspectId) {
    return handleSalesProspectDetail(req, res, method, detailProspectId);
  }

  if (
    pathname === '/'
    || pathname === '/crowsnest'
    || pathname === '/crowsnest/ui'
    || pathname === '/clients'
    || pathname === '/billing'
    || pathname === '/communications'
    || pathname === '/sales'
  ) {
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
    if (isSalesUnavailableFailure(err)) {
      return sendSalesUnavailable(res);
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

module.exports = { server, router, PORT, HOST, sendSalesUnavailable };
