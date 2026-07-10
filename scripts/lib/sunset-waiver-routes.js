'use strict';

/**
 * Public Sunset waiver routes (unauthenticated).
 * GET/POST /forms/waiver/:token
 *
 * Tenant hard-scoped to sunset. No booking/customer ids in HTML.
 * Group mode: same link accepts multiple student submissions until target_count.
 */

const querystring = require('querystring');
const {
  SUNSET_TENANT_ID,
  isValidWaiverPublicId,
  getWaiverRequestByPublicId,
  getWaiverSubmissionSummary,
  recordWaiverSubmission,
  loadWaiverFormConfig,
  normalizeRequestMode,
} = require('./sunset-waiver-model');
const {
  buildInvalidLinkHtml,
  buildUnavailableLinkHtml,
  buildAlreadySubmittedHtml,
  buildGroupFullHtml,
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

function isGroupRequest(request) {
  return normalizeRequestMode(request && request.request_mode) === 'group';
}

function groupIsFull(summary) {
  if (!summary || summary.request_mode !== 'group') return false;
  const target = summary.target_count;
  if (target == null || !Number.isFinite(Number(target)) || Number(target) < 1) return false;
  return Number(summary.completed_count || 0) >= Number(target);
}

/**
 * Public access decision — never exposes submission PII.
 * @returns {'form'|'already_submitted'|'group_full'|'unavailable'}
 */
function resolvePublicFormAccess(request, summary) {
  if (!request) return 'unavailable';
  if (request.status === 'revoked' || request.status === 'expired') return 'unavailable';

  if (isGroupRequest(request)) {
    if (groupIsFull(summary)) return 'group_full';
    const target = summary && summary.target_count;
    const completed = summary ? Number(summary.completed_count || 0) : 0;
    if (target != null && Number.isFinite(Number(target)) && completed < Number(target)) {
      return 'form';
    }
    if (request.status === 'pending' || request.status === 'needs_review') return 'form';
    return 'unavailable';
  }

  if (request.status === 'completed') return 'already_submitted';
  if (request.status === 'pending' || request.status === 'needs_review') return 'form';
  return 'unavailable';
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

function htmlForAccess(access) {
  if (access === 'already_submitted') return buildAlreadySubmittedHtml();
  if (access === 'group_full') return buildGroupFullHtml();
  if (access === 'unavailable') return buildUnavailableLinkHtml();
  return null;
}

async function loadRequestSummary(withPgClient, request) {
  if (!request || !request.id) return null;
  return withPgClient((pg) => getWaiverSubmissionSummary(pg, request.id, SUNSET_TENANT_ID));
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
  let summary = null;
  try {
    summary = await loadRequestSummary(withPgClient, request);
  } catch (err) {
    console.error('[sunset-waiver] GET summary failed', err && err.message);
    return sendWaiverHtml(res, 500, buildInvalidLinkHtml(), sendHTML);
  }

  const access = resolvePublicFormAccess(request, summary);
  const blockedHtml = htmlForAccess(access);
  if (blockedHtml) {
    const code = access === 'unavailable' ? 410 : 200;
    return sendWaiverHtml(res, code, blockedHtml, sendHTML);
  }

  const cfg = loadWaiverFormConfig();
  const groupMode = isGroupRequest(request);
  const html = buildPendingFormHtml({
    config: cfg,
    prefill: mergePrefill(request),
    actionPath: `/forms/waiver/${encodeURIComponent(token)}`,
    groupMode,
    groupSummary: summary,
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
  let summary = null;
  try {
    summary = await loadRequestSummary(withPgClient, request);
  } catch (err) {
    console.error('[sunset-waiver] POST summary failed', err && err.message);
    return sendWaiverHtml(res, 500, buildInvalidLinkHtml(), sendHTML);
  }

  const access = resolvePublicFormAccess(request, summary);
  const blockedHtml = htmlForAccess(access);
  if (blockedHtml) {
    const code = access === 'unavailable' ? 410 : 200;
    return sendWaiverHtml(res, code, blockedHtml, sendHTML);
  }

  const groupMode = isGroupRequest(request);
  const cfg = loadWaiverFormConfig();
  const prefill = mergePrefill(request);
  const validated = collectAndValidateAnswers(cfg, prefill, body, { groupMode });
  if (!validated.ok) {
    const html = buildPendingFormHtml({
      config: cfg,
      prefill,
      posted: body,
      errors: validated.errors,
      actionPath: `/forms/waiver/${encodeURIComponent(token)}`,
      groupMode,
      groupSummary: summary,
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

  if (result.idempotent) {
    const postSummary = result.summary || summary;
    const postAccess = resolvePublicFormAccess(result.request || request, postSummary);
    const idempotentHtml = htmlForAccess(postAccess);
    if (idempotentHtml) {
      return sendWaiverHtml(res, 200, idempotentHtml, sendHTML);
    }
  }

  return sendWaiverHtml(res, 200, buildSuccessHtml(result.summary || summary), sendHTML);
}

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
  resolvePublicFormAccess,
  isGroupRequest,
  groupIsFull,
};
