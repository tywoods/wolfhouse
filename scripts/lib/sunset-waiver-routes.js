'use strict';

/**
 * Public Sunset waiver routes (unauthenticated).
 * GET/POST /forms/waiver/:token
 *
 * Tenant hard-scoped to sunset. No booking/customer ids in HTML.
 */

const querystring = require('querystring');
const {
  SUNSET_TENANT_ID,
  isValidWaiverPublicId,
  getWaiverRequestByPublicId,
  recordWaiverSubmission,
  loadWaiverFormConfig,
} = require('./sunset-waiver-model');
const {
  buildInvalidLinkHtml,
  buildUnavailableLinkHtml,
  buildAlreadySubmittedHtml,
  buildSuccessHtml,
  buildPendingFormHtml,
  collectAndValidateAnswers,
  buildFormSnapshot,
  normalizePrefill,
} = require('./sunset-waiver-form-page');

const WAIVER_PUBLIC_PATH_RE = /^\/forms\/waiver\/([^/]+)$/i;

function matchWaiverPublicPath(pathname) {
  const m = WAIVER_PUBLIC_PATH_RE.exec(String(pathname || ''));
  if (!m) return null;
  return decodeURIComponent(m[1]);
}

function clientIp(req) {
  const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  if (xf) return xf.slice(0, 80);
  const ra = req.socket && req.socket.remoteAddress;
  return ra ? String(ra).slice(0, 80) : null;
}

function userAgent(req) {
  const ua = req.headers && req.headers['user-agent'];
  return ua ? String(ua).slice(0, 500) : null;
}

function mergePrefill(request) {
  const fromReq = request && request.prefill_json && typeof request.prefill_json === 'object'
    ? request.prefill_json
    : {};
  const merged = { ...fromReq };
  if (!merged.phone && request && request.sent_to_phone) merged.phone = request.sent_to_phone;
  if (!merged.email && request && request.sent_to_email) merged.email = request.sent_to_email;
  return normalizePrefill(merged);
}

function sendWaiverHtml(res, statusCode, html, sendHTML) {
  if (typeof sendHTML === 'function') {
    return sendHTML(res, statusCode, html);
  }
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Powered-By': 'luna-sunset-staff-api/waiver-form',
  });
  return res.end(html);
}

async function handleWaiverGet(token, req, res, deps) {
  const d = deps || {};
  const withPgClient = d.withPgClient;
  const sendHTML = d.sendHTML;

  if (!isValidWaiverPublicId(token)) {
    return sendWaiverHtml(res, 404, buildInvalidLinkHtml(), sendHTML);
  }

  let looked;
  try {
    looked = await withPgClient((pg) => getWaiverRequestByPublicId(pg, token, SUNSET_TENANT_ID));
  } catch (err) {
    console.error('[sunset-waiver] GET lookup failed', err && err.message);
    return sendWaiverHtml(res, 500, buildInvalidLinkHtml(), sendHTML);
  }

  if (!looked.ok) {
    if (looked.error === 'expired') {
      return sendWaiverHtml(res, 410, buildUnavailableLinkHtml(), sendHTML);
    }
    return sendWaiverHtml(res, looked.status || 404, buildInvalidLinkHtml(), sendHTML);
  }

  const request = looked.request;
  if (request.status === 'revoked' || request.status === 'expired') {
    return sendWaiverHtml(res, 410, buildUnavailableLinkHtml(), sendHTML);
  }
  if (request.status === 'completed') {
    return sendWaiverHtml(res, 200, buildAlreadySubmittedHtml(), sendHTML);
  }
  if (request.status !== 'pending' && request.status !== 'needs_review') {
    return sendWaiverHtml(res, 410, buildUnavailableLinkHtml(), sendHTML);
  }

  const cfg = loadWaiverFormConfig();
  const html = buildPendingFormHtml({
    config: cfg,
    prefill: mergePrefill(request),
    actionPath: `/forms/waiver/${encodeURIComponent(token)}`,
  });
  return sendWaiverHtml(res, 200, html, sendHTML);
}

function parseFormBody(raw, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const text = String(raw || '');
  if (ct.includes('application/json')) {
    try {
      const obj = JSON.parse(text || '{}');
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) {
      return {};
    }
  }
  // application/x-www-form-urlencoded (default for HTML forms)
  return querystring.parse(text);
}

async function handleWaiverPost(token, req, res, deps) {
  const d = deps || {};
  const withPgClient = d.withPgClient;
  const sendHTML = d.sendHTML;
  const readBody = d.readBody;

  if (!isValidWaiverPublicId(token)) {
    return sendWaiverHtml(res, 404, buildInvalidLinkHtml(), sendHTML);
  }

  let raw = '';
  try {
    raw = await readBody(req);
  } catch (err) {
    return sendWaiverHtml(res, 400, buildInvalidLinkHtml(), sendHTML);
  }
  const body = parseFormBody(raw, req.headers && req.headers['content-type']);
  // Never accept client-supplied tenant_id.
  delete body.tenant_id;
  delete body.tenantId;

  let looked;
  try {
    looked = await withPgClient((pg) => getWaiverRequestByPublicId(pg, token, SUNSET_TENANT_ID));
  } catch (err) {
    console.error('[sunset-waiver] POST lookup failed', err && err.message);
    return sendWaiverHtml(res, 500, buildInvalidLinkHtml(), sendHTML);
  }

  if (!looked.ok) {
    if (looked.error === 'expired') {
      return sendWaiverHtml(res, 410, buildUnavailableLinkHtml(), sendHTML);
    }
    return sendWaiverHtml(res, looked.status || 404, buildInvalidLinkHtml(), sendHTML);
  }

  const request = looked.request;
  if (request.status === 'completed') {
    return sendWaiverHtml(res, 200, buildAlreadySubmittedHtml(), sendHTML);
  }
  if (request.status === 'revoked' || request.status === 'expired') {
    return sendWaiverHtml(res, 410, buildUnavailableLinkHtml(), sendHTML);
  }

  const cfg = loadWaiverFormConfig();
  const prefill = mergePrefill(request);
  const validated = collectAndValidateAnswers(cfg, prefill, body);
  if (!validated.ok) {
    const html = buildPendingFormHtml({
      config: cfg,
      prefill,
      posted: body,
      errors: validated.errors,
      actionPath: `/forms/waiver/${encodeURIComponent(token)}`,
    });
    return sendWaiverHtml(res, 400, html, sendHTML);
  }

  const snapshot = buildFormSnapshot(cfg);
  let result;
  try {
    result = await withPgClient((pg) => recordWaiverSubmission(pg, {
      tenantId: SUNSET_TENANT_ID,
      publicId: token,
      rawAnswersJson: {
        form_version: cfg._meta && cfg._meta.form_version,
        answers: validated.answers,
      },
      formSnapshotJson: snapshot,
      respondentName: validated.respondent.name,
      respondentEmail: validated.respondent.email,
      respondentPhone: validated.respondent.phone,
      ipAddress: clientIp(req),
      userAgent: userAgent(req),
      language: 'es',
    }));
  } catch (err) {
    console.error('[sunset-waiver] POST submit failed', err && err.message);
    return sendWaiverHtml(res, 500, buildInvalidLinkHtml(), sendHTML);
  }

  if (!result.ok) {
    if (result.error === 'expired' || result.error === 'revoked') {
      return sendWaiverHtml(res, result.status || 410, buildUnavailableLinkHtml(), sendHTML);
    }
    if (result.error === 'not_found' || result.error === 'invalid_token') {
      return sendWaiverHtml(res, 404, buildInvalidLinkHtml(), sendHTML);
    }
    console.error('[sunset-waiver] submit rejected', result.error, result.detail);
    return sendWaiverHtml(res, result.status || 500, buildInvalidLinkHtml(), sendHTML);
  }

  return sendWaiverHtml(res, 200, buildSuccessHtml(), sendHTML);
}

/**
 * Router hook: returns true if the request was handled.
 */
async function tryHandleSunsetWaiverPublicRoute(pathname, method, req, res, deps) {
  const token = matchWaiverPublicPath(pathname);
  if (!token) return false;
  const m = String(method || '').toUpperCase();
  if (m === 'GET') {
    await handleWaiverGet(token, req, res, deps);
    return true;
  }
  if (m === 'POST') {
    await handleWaiverPost(token, req, res, deps);
    return true;
  }
  res.writeHead(405, { Allow: 'GET, POST' });
  res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
  return true;
}

module.exports = {
  WAIVER_PUBLIC_PATH_RE,
  matchWaiverPublicPath,
  handleWaiverGet,
  handleWaiverPost,
  tryHandleSunsetWaiverPublicRoute,
  parseFormBody,
  mergePrefill,
};
