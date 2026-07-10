'use strict';

/**
 * Sunset waiver form model helpers (requests + submissions).
 * Public URL: {base}/forms/waiver/waiv_<token>
 * Lookup uses sha256(token); booking ids never appear in public URLs.
 *
 * request_mode: single (one submission) | group (many submissions until target_count).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUNSET_TENANT_ID = 'sunset';
const DEFAULT_FORM_TYPE = 'sunset_lesson_waiver';
const DEFAULT_STAGING_BASE_URL = 'https://sunset-staging.lunafrontdesk.com';
const PUBLIC_ID_RE = /^waiv_[A-Za-z0-9_-]{6,64}$/;
const REQUEST_MODES = new Set(['single', 'group']);
const REQUEST_STATUSES = new Set(['pending', 'completed', 'expired', 'revoked', 'needs_review']);

const ROOT = path.join(__dirname, '..', '..');
const WAIVER_FORM_CONFIG_PATH = path.join(ROOT, 'config', 'clients', 'sunset.waiver-form.json');

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function normalizePublicBaseUrl(raw) {
  const v = trimStr(raw);
  if (!v) return null;
  try {
    const u = new URL(v.includes('://') ? v : `https://${v}`);
    return u.origin.replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
}

function resolveWaiverPublicBaseUrl(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const fromOverride = normalizePublicBaseUrl(o.baseUrl || o.base_url);
  if (fromOverride) return fromOverride;

  for (const key of [
    'PUBLIC_WAIVER_BASE_URL',
    'PUBLIC_GUEST_BASE_URL',
    'STAFF_PUBLIC_BASE_URL',
    'PUBLIC_PAYMENT_BASE_URL',
  ]) {
    const origin = normalizePublicBaseUrl(env[key]);
    if (origin) return origin;
  }

  return DEFAULT_STAGING_BASE_URL;
}

function loadWaiverFormConfig() {
  const raw = fs.readFileSync(WAIVER_FORM_CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function getWaiverFormVersionFromConfig(cfg) {
  const c = cfg || loadWaiverFormConfig();
  return trimStr(c && c._meta && c._meta.form_version) || null;
}

function generateWaiverPublicId() {
  const token = crypto.randomBytes(12).toString('base64url');
  return `waiv_${token}`;
}

function isValidWaiverPublicId(publicId) {
  return PUBLIC_ID_RE.test(trimStr(publicId));
}

function hashWaiverToken(publicId) {
  const id = trimStr(publicId);
  return crypto.createHash('sha256').update(id, 'utf8').digest('hex');
}

function buildWaiverPublicUrl(publicId, baseUrl) {
  const id = trimStr(publicId);
  if (!isValidWaiverPublicId(id)) {
    throw new Error('invalid waiver public_id');
  }
  const base = normalizePublicBaseUrl(baseUrl) || resolveWaiverPublicBaseUrl();
  return `${base}/forms/waiver/${encodeURIComponent(id)}`;
}

function normalizeRequestMode(raw) {
  const mode = trimStr(raw) || 'single';
  return REQUEST_MODES.has(mode) ? mode : 'single';
}

function normalizeTargetCount(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/**
 * Pure status from mode + counts (does not consider expired/revoked).
 */
function computeWaiverRequestStatus(input) {
  const src = input || {};
  const requestMode = normalizeRequestMode(src.requestMode || src.request_mode);
  const completedCount = Math.max(0, Number(src.completedCount != null ? src.completedCount : src.completed_count) || 0);
  const targetCount = normalizeTargetCount(src.targetCount != null ? src.targetCount : src.target_count);

  if (requestMode === 'single') {
    return completedCount >= 1 ? 'completed' : 'pending';
  }
  if (targetCount != null && completedCount >= targetCount) {
    return 'completed';
  }
  return 'pending';
}

function mapRequestRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    customer_id: row.customer_id || null,
    booking_id: row.booking_id || null,
    participant_key: row.participant_key || null,
    public_id: row.public_id,
    token_hash: row.token_hash,
    status: row.status,
    request_mode: normalizeRequestMode(row.request_mode),
    target_count: normalizeTargetCount(row.target_count),
    form_type: row.form_type,
    form_version: row.form_version,
    sent_to_phone: row.sent_to_phone || null,
    sent_to_email: row.sent_to_email || null,
    prefill_json: row.prefill_json || {},
    metadata: row.metadata || {},
    sent_at: row.sent_at || null,
    completed_at: row.completed_at || null,
    expires_at: row.expires_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapSubmissionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    request_id: row.request_id,
    customer_id: row.customer_id || null,
    booking_id: row.booking_id || null,
    participant_key: row.participant_key || null,
    form_type: row.form_type,
    form_version: row.form_version,
    submitted_at: row.submitted_at,
    ip_address: row.ip_address || null,
    user_agent: row.user_agent || null,
    language: row.language || null,
    respondent_name: row.respondent_name || null,
    respondent_email: row.respondent_email || null,
    respondent_phone: row.respondent_phone || null,
    raw_answers_json: row.raw_answers_json,
    form_snapshot_json: row.form_snapshot_json,
    accepted_terms_hash: row.accepted_terms_hash || null,
    pdf_url: row.pdf_url || null,
    created_at: row.created_at,
  };
}

function requestIsExpired(row, now) {
  if (!row || !row.expires_at) return false;
  const exp = new Date(row.expires_at).getTime();
  if (!Number.isFinite(exp)) return false;
  return exp <= (now || Date.now());
}

async function countSubmissionsForRequest(pg, tenantId, requestId) {
  const res = await pg.query(
    `SELECT COUNT(*)::int AS cnt
       FROM waiver_form_submissions
      WHERE tenant_id = $1 AND request_id = $2::uuid`,
    [tenantId, requestId],
  );
  return res.rows[0] ? Number(res.rows[0].cnt) || 0 : 0;
}

async function getWaiverSubmissionSummary(pg, requestId, tenantId) {
  const tid = trimStr(tenantId) || SUNSET_TENANT_ID;
  const rid = trimStr(requestId);
  if (!isUuid(rid)) {
    return null;
  }
  const reqRes = await pg.query(
    `SELECT id, request_mode, target_count, status
       FROM waiver_form_requests
      WHERE tenant_id = $1 AND id = $2::uuid
      LIMIT 1`,
    [tid, rid],
  );
  if (!reqRes.rows.length) return null;
  const row = reqRes.rows[0];
  const completedCount = await countSubmissionsForRequest(pg, tid, rid);
  const requestMode = normalizeRequestMode(row.request_mode);
  const targetCount = normalizeTargetCount(row.target_count);
  const remainingCount = targetCount != null
    ? Math.max(0, targetCount - completedCount)
    : null;
  const status = computeWaiverRequestStatus({
    requestMode,
    targetCount,
    completedCount,
  });
  return {
    request_id: row.id,
    request_mode: requestMode,
    target_count: targetCount,
    completed_count: completedCount,
    remaining_count: remainingCount,
    status,
  };
}

async function createWaiverRequest(pg, input) {
  const src = input || {};
  const tenantId = trimStr(src.tenantId || src.tenant_id) || SUNSET_TENANT_ID;
  if (tenantId !== SUNSET_TENANT_ID) {
    return { ok: false, status: 403, error: 'unsupported_tenant', tenant_id: tenantId };
  }

  const formVersion = trimStr(src.formVersion || src.form_version);
  if (!formVersion) {
    return { ok: false, status: 400, error: 'form_version is required' };
  }

  const requestMode = normalizeRequestMode(src.requestMode || src.request_mode);
  const targetCount = normalizeTargetCount(src.targetCount != null ? src.targetCount : src.target_count);
  if (requestMode === 'group' && targetCount == null) {
    return { ok: false, status: 400, error: 'target_count is required for group request_mode' };
  }
  if (requestMode === 'single' && targetCount != null) {
    return { ok: false, status: 400, error: 'target_count must be null for single request_mode' };
  }

  const customerId = src.customerId != null ? trimStr(src.customerId || src.customer_id) : '';
  const bookingId = src.bookingId != null ? trimStr(src.bookingId || src.booking_id) : '';
  if (customerId && !isUuid(customerId)) {
    return { ok: false, status: 400, error: 'invalid customer_id' };
  }
  if (bookingId && !isUuid(bookingId)) {
    return { ok: false, status: 400, error: 'invalid booking_id' };
  }

  const participantKey = trimStr(src.participantKey || src.participant_key) || null;
  const formType = trimStr(src.formType || src.form_type) || DEFAULT_FORM_TYPE;
  const sentToPhone = trimStr(src.sentToPhone || src.sent_to_phone) || null;
  const sentToEmail = trimStr(src.sentToEmail || src.sent_to_email) || null;
  const prefillJson = src.prefillJson && typeof src.prefillJson === 'object' ? src.prefillJson
    : (src.prefill_json && typeof src.prefill_json === 'object' ? src.prefill_json : {});
  const metadata = src.metadata && typeof src.metadata === 'object' ? src.metadata : {};
  const expiresAt = src.expiresAt || src.expires_at || null;

  const publicId = generateWaiverPublicId();
  const tokenHash = hashWaiverToken(publicId);

  const insertSql = `
    INSERT INTO waiver_form_requests (
      tenant_id, customer_id, booking_id, participant_key,
      public_id, token_hash, status, request_mode, target_count,
      form_type, form_version,
      sent_to_phone, sent_to_email, prefill_json, metadata, expires_at
    ) VALUES (
      $1, $2::uuid, $3::uuid, $4,
      $5, $6, 'pending', $7, $8,
      $9, $10,
      $11, $12, $13::jsonb, $14::jsonb, $15
    )
    RETURNING *
  `;

  try {
    const res = await pg.query(insertSql, [
      tenantId,
      customerId || null,
      bookingId || null,
      participantKey,
      publicId,
      tokenHash,
      requestMode,
      targetCount,
      formType,
      formVersion,
      sentToPhone,
      sentToEmail,
      JSON.stringify(prefillJson),
      JSON.stringify(metadata),
      expiresAt,
    ]);
    const request = mapRequestRow(res.rows[0]);
    const baseUrl = resolveWaiverPublicBaseUrl({
      baseUrl: src.baseUrl || src.base_url,
      env: src.env,
    });
    return {
      ok: true,
      status: 201,
      request,
      publicId,
      publicUrl: buildWaiverPublicUrl(publicId, baseUrl),
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: 'create_failed',
      detail: err && err.message,
      code: err && err.code,
    };
  }
}

async function getWaiverRequestByPublicId(pg, publicId, tenantId) {
  const tid = trimStr(tenantId) || SUNSET_TENANT_ID;
  if (tid !== SUNSET_TENANT_ID) {
    return { ok: false, status: 403, error: 'unsupported_tenant' };
  }
  const id = trimStr(publicId);
  if (!isValidWaiverPublicId(id)) {
    return { ok: false, status: 404, error: 'invalid_token' };
  }
  const tokenHash = hashWaiverToken(id);
  try {
    const res = await pg.query(
      `SELECT * FROM waiver_form_requests
       WHERE tenant_id = $1 AND token_hash = $2
       LIMIT 1`,
      [tid, tokenHash],
    );
    if (!res.rows.length) {
      return { ok: false, status: 404, error: 'not_found' };
    }
    const request = mapRequestRow(res.rows[0]);
    if (request.status === 'pending' && requestIsExpired(request)) {
      return { ok: false, status: 410, error: 'expired', request };
    }
    return { ok: true, status: 200, request };
  } catch (err) {
    return { ok: false, status: 500, error: 'lookup_failed', detail: err && err.message };
  }
}

async function getSubmissionByRequestId(pg, tenantId, requestId) {
  const res = await pg.query(
    `SELECT * FROM waiver_form_submissions
     WHERE tenant_id = $1 AND request_id = $2::uuid
     ORDER BY submitted_at ASC
     LIMIT 1`,
    [tenantId, requestId],
  );
  return res.rows[0] ? mapSubmissionRow(res.rows[0]) : null;
}

async function getLatestSubmissionForRequest(pg, tenantId, requestId) {
  const res = await pg.query(
    `SELECT * FROM waiver_form_submissions
     WHERE tenant_id = $1 AND request_id = $2::uuid
     ORDER BY submitted_at DESC
     LIMIT 1`,
    [tenantId, requestId],
  );
  return res.rows[0] ? mapSubmissionRow(res.rows[0]) : null;
}

/**
 * Record a submission (transaction-safe).
 * Single: one row only; duplicate submit is idempotent.
 * Group: multiple rows until target_count; public callers receive only their submission.
 */
async function recordWaiverSubmission(pg, input) {
  const src = input || {};
  const tenantId = trimStr(src.tenantId || src.tenant_id) || SUNSET_TENANT_ID;
  if (tenantId !== SUNSET_TENANT_ID) {
    return { ok: false, status: 403, error: 'unsupported_tenant' };
  }

  const publicId = trimStr(src.publicId || src.public_id);
  const requestId = trimStr(src.requestId || src.request_id);

  let request;
  if (publicId) {
    const looked = await getWaiverRequestByPublicId(pg, publicId, tenantId);
    if (!looked.ok && looked.error !== 'expired') {
      return { ok: false, status: looked.status, error: looked.error, detail: looked.detail };
    }
    request = looked.request;
    if (!request) {
      return { ok: false, status: looked.status || 404, error: looked.error || 'not_found' };
    }
  } else if (requestId) {
    if (!isUuid(requestId)) {
      return { ok: false, status: 400, error: 'invalid request_id' };
    }
    const res = await pg.query(
      `SELECT * FROM waiver_form_requests WHERE tenant_id = $1 AND id = $2::uuid LIMIT 1`,
      [tenantId, requestId],
    );
    if (!res.rows.length) {
      return { ok: false, status: 404, error: 'not_found' };
    }
    request = mapRequestRow(res.rows[0]);
  } else {
    return { ok: false, status: 400, error: 'public_id or request_id is required' };
  }

  if (request.status === 'revoked') {
    return { ok: false, status: 409, error: 'revoked', request };
  }
  if (request.status === 'expired' || (request.status === 'pending' && requestIsExpired(request))) {
    return { ok: false, status: 410, error: 'expired', request };
  }

  const rawAnswers = src.rawAnswersJson || src.raw_answers_json;
  const formSnapshot = src.formSnapshotJson || src.form_snapshot_json;
  if (!rawAnswers || typeof rawAnswers !== 'object') {
    return { ok: false, status: 400, error: 'raw_answers_json is required' };
  }
  if (!formSnapshot || typeof formSnapshot !== 'object') {
    return { ok: false, status: 400, error: 'form_snapshot_json is required' };
  }

  const formType = trimStr(src.formType || src.form_type) || request.form_type || DEFAULT_FORM_TYPE;
  const formVersion = trimStr(src.formVersion || src.form_version) || request.form_version;

  await pg.query('BEGIN');
  try {
    const lockRes = await pg.query(
      `SELECT * FROM waiver_form_requests
       WHERE tenant_id = $1 AND id = $2::uuid
       FOR UPDATE`,
      [tenantId, request.id],
    );
    if (!lockRes.rows.length) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 404, error: 'not_found' };
    }
    const locked = mapRequestRow(lockRes.rows[0]);
    const requestMode = locked.request_mode || 'single';
    const targetCount = locked.target_count;
    let completedCount = await countSubmissionsForRequest(pg, tenantId, locked.id);

    if (locked.status === 'revoked') {
      await pg.query('ROLLBACK');
      return { ok: false, status: 409, error: 'revoked', request: locked };
    }
    if (locked.status === 'expired' || (locked.status === 'pending' && requestIsExpired(locked))) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 410, error: 'expired', request: locked };
    }

    const computedStatus = computeWaiverRequestStatus({
      requestMode,
      targetCount,
      completedCount,
    });

    if (computedStatus === 'completed') {
      const existing = requestMode === 'group'
        ? await getLatestSubmissionForRequest(pg, tenantId, locked.id)
        : await getSubmissionByRequestId(pg, tenantId, locked.id);
      await pg.query('COMMIT');
      const summary = await getWaiverSubmissionSummary(pg, locked.id, tenantId);
      return {
        ok: true,
        status: 200,
        idempotent: true,
        request: { ...locked, status: computedStatus },
        submission: existing,
        summary,
      };
    }

    if (locked.status !== 'pending' && locked.status !== 'needs_review') {
      await pg.query('ROLLBACK');
      return { ok: false, status: 409, error: 'invalid_status', request: locked };
    }

    if (requestMode === 'single' && completedCount >= 1) {
      const existing = await getSubmissionByRequestId(pg, tenantId, locked.id);
      await pg.query('COMMIT');
      const summary = await getWaiverSubmissionSummary(pg, locked.id, tenantId);
      return {
        ok: true,
        status: 200,
        idempotent: true,
        request: locked,
        submission: existing,
        summary,
      };
    }

    const insertRes = await pg.query(
      `INSERT INTO waiver_form_submissions (
         tenant_id, request_id, customer_id, booking_id, participant_key,
         form_type, form_version, ip_address, user_agent, language,
         respondent_name, respondent_email, respondent_phone,
         raw_answers_json, form_snapshot_json, accepted_terms_hash, pdf_url
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13,
         $14::jsonb, $15::jsonb, $16, $17
       )
       RETURNING *`,
      [
        tenantId,
        locked.id,
        locked.customer_id,
        locked.booking_id,
        locked.participant_key,
        formType,
        formVersion,
        trimStr(src.ipAddress || src.ip_address) || null,
        trimStr(src.userAgent || src.user_agent) || null,
        trimStr(src.language) || null,
        trimStr(src.respondentName || src.respondent_name) || null,
        trimStr(src.respondentEmail || src.respondent_email) || null,
        trimStr(src.respondentPhone || src.respondent_phone) || null,
        JSON.stringify(rawAnswers),
        JSON.stringify(formSnapshot),
        trimStr(src.acceptedTermsHash || src.accepted_terms_hash) || null,
        trimStr(src.pdfUrl || src.pdf_url) || null,
      ],
    );

    const submission = mapSubmissionRow(insertRes.rows[0]);
    completedCount = await countSubmissionsForRequest(pg, tenantId, locked.id);
    const nextStatus = computeWaiverRequestStatus({
      requestMode,
      targetCount,
      completedCount,
    });
    const markCompleted = nextStatus === 'completed';

    const upd = await pg.query(
      `UPDATE waiver_form_requests
       SET status = $3,
           completed_at = CASE WHEN $4 THEN COALESCE(completed_at, NOW()) ELSE NULL END,
           updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2::uuid
       RETURNING *`,
      [tenantId, locked.id, nextStatus, markCompleted],
    );

    await pg.query('COMMIT');
    const summary = await getWaiverSubmissionSummary(pg, locked.id, tenantId);
    return {
      ok: true,
      status: 201,
      idempotent: false,
      request: mapRequestRow(upd.rows[0]),
      submission,
      summary,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return {
      ok: false,
      status: 500,
      error: 'submit_failed',
      detail: err && err.message,
      code: err && err.code,
    };
  }
}

module.exports = {
  SUNSET_TENANT_ID,
  DEFAULT_FORM_TYPE,
  DEFAULT_STAGING_BASE_URL,
  PUBLIC_ID_RE,
  REQUEST_MODES,
  REQUEST_STATUSES,
  WAIVER_FORM_CONFIG_PATH,
  generateWaiverPublicId,
  isValidWaiverPublicId,
  hashWaiverToken,
  buildWaiverPublicUrl,
  resolveWaiverPublicBaseUrl,
  loadWaiverFormConfig,
  getWaiverFormVersionFromConfig,
  normalizeRequestMode,
  normalizeTargetCount,
  computeWaiverRequestStatus,
  createWaiverRequest,
  getWaiverRequestByPublicId,
  getWaiverSubmissionSummary,
  countSubmissionsForRequest,
  recordWaiverSubmission,
};
