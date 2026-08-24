'use strict';

/**
 * Read-only Google Sheets adapter.
 * Errors keep their real class — never rewritten as empty_sheet.
 */

const crypto = require('crypto');
const https = require('https');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_HOST = 'oauth2.googleapis.com';
const SHEETS_HOST = 'sheets.googleapis.com';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_DATA_ROWS = 5000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(serviceAccount, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: SHEETS_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const input = header + '.' + payload;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(input);
  return input + '.' + b64url(sign.sign(serviceAccount.private_key));
}

function httpsRequest(opts, body, deps) {
  const lib = (deps && deps.https) || https;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: 'https:',
      hostname: opts.hostname,
      method: opts.method || 'GET',
      path: opts.path,
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const err = new Error('sheets_timeout');
      err.code = 'sheets_timeout';
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

function classifyHttp(status) {
  if (status === 401 || status === 403 || status === 404) return 'sheets_inaccessible';
  if (status >= 500) return 'sheets_provider_5xx';
  return 'sheets_http_' + status;
}

function parseServiceAccountJson(raw) {
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (_) { return { ok: false, reason: 'secret_not_json', keepLastBlocks: true }; }
  if (!parsed || parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
    return { ok: false, reason: 'secret_not_service_account', keepLastBlocks: true };
  }
  return { ok: true, serviceAccount: parsed };
}

function resolveSecretRef(secretRef, env) {
  env = env || process.env;
  const name = String(secretRef || '').trim();
  if (!name) return { ok: false, reason: 'secret_missing', keepLastBlocks: true };
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(name)) return { ok: false, reason: 'secret_ref_invalid', keepLastBlocks: true };
  const raw = env[name];
  if (!raw) return { ok: false, reason: 'secret_unresolved', keepLastBlocks: true };
  return parseServiceAccountJson(raw);
}

function fail(reason, extra) {
  return Object.assign({ ok: false, status: 'error', reason, keepLastBlocks: true, writes: [] }, extra || {});
}

async function fetchAccessToken(serviceAccount, deps) {
  const jwt = signJwt(serviceAccount, Math.floor(Date.now() / 1000));
  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
    + '&assertion=' + encodeURIComponent(jwt);
  const res = await httpsRequest({
    hostname: TOKEN_HOST,
    method: 'POST',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    timeoutMs: (deps && deps.timeoutMs) || DEFAULT_TIMEOUT_MS,
  }, form, deps);
  if (res.status !== 200) {
    const err = new Error('sheets_token_denied');
    err.code = 'sheets_token_denied';
    err.status = res.status;
    throw err;
  }
  let json;
  try { json = JSON.parse(res.body); }
  catch (_) {
    const err = new Error('sheets_token_not_json');
    err.code = 'sheets_malformed_json';
    throw err;
  }
  if (!json.access_token) {
    const err = new Error('sheets_token_missing');
    err.code = 'sheets_token_denied';
    throw err;
  }
  return json.access_token;
}

function detectGridMergesForTab(spreadsheet, sheetName) {
  const want = String(sheetName || 'inventory');
  const sheets = (spreadsheet && spreadsheet.sheets) || [];
  for (let i = 0; i < sheets.length; i++) {
    const title = sheets[i] && sheets[i].properties && sheets[i].properties.title;
    if (String(title || '') !== want) continue;
    const merges = sheets[i].merges || [];
    if (merges.length) return { merged: true, count: merges.length, merge: merges[0], tab: want };
    return { merged: false, tab: want };
  }
  return { ok: false, reason: 'sheet_tab_missing', tab: want };
}

function detectExtraColumns(rows, maxContractCols) {
  const limit = maxContractCols || 5;
  const list = Array.isArray(rows) ? rows : [];
  for (let r = 0; r < list.length; r++) {
    const row = list[r] || [];
    for (let c = limit; c < row.length; c++) {
      if (String(row[c] == null ? '' : row[c]).trim() !== '') {
        return { extra: true, row: r + 1, col: c + 1 };
      }
    }
  }
  return { extra: false };
}

function detectOverflowRows(overflowRows) {
  const list = Array.isArray(overflowRows) ? overflowRows : [];
  const nonempty = list.some((row) => row && row.some((c) => String(c == null ? '' : c).trim() !== ''));
  return { overflow: nonempty };
}

function requireOkJson(res, label) {
  if (!res || res.status !== 200) {
    return fail(res ? classifyHttp(res.status) : 'sheets_inaccessible', { http: res && res.status, request: label });
  }
  try {
    return { ok: true, json: JSON.parse(res.body) };
  } catch (_) {
    return fail('sheets_malformed_json', { request: label });
  }
}

async function fetchSheetRows(connection, deps) {
  deps = deps || {};
  if (typeof deps.fetchSheetRows === 'function') {
    return deps.fetchSheetRows(connection, deps);
  }
  const secret = resolveSecretRef(connection.secret_ref, deps.env);
  if (!secret.ok) return fail(secret.reason);

  let token;
  try {
    token = await fetchAccessToken(secret.serviceAccount, deps);
  } catch (err) {
    return fail(err.code || 'sheets_token_denied');
  }

  const sheetName = connection.sheet_name || 'inventory';
  const id = encodeURIComponent(connection.spreadsheet_id);
  const valuesRange = encodeURIComponent(sheetName + '!A1:Z' + (MAX_DATA_ROWS + 1));
  const overflowRange = encodeURIComponent(sheetName + '!A' + (MAX_DATA_ROWS + 2) + ':Z');
  const valuesPath = '/v4/spreadsheets/' + id + '/values/' + valuesRange
    + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';
  const overflowPath = '/v4/spreadsheets/' + id + '/values/' + overflowRange
    + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';
  const metaPath = '/v4/spreadsheets/' + id
    + '?fields=' + encodeURIComponent('sheets.merges,sheets.properties.title,sheets.properties.gridProperties');

  let valuesRes;
  let metaRes;
  let overflowRes;
  try {
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
    valuesRes = await httpsRequest({ hostname: SHEETS_HOST, method: 'GET', path: valuesPath, headers, timeoutMs }, null, deps);
    metaRes = await httpsRequest({ hostname: SHEETS_HOST, method: 'GET', path: metaPath, headers, timeoutMs }, null, deps);
    overflowRes = await httpsRequest({ hostname: SHEETS_HOST, method: 'GET', path: overflowPath, headers, timeoutMs }, null, deps);
  } catch (err) {
    return fail(err.code || 'sheets_timeout');
  }

  const valuesOk = requireOkJson(valuesRes, 'values');
  if (!valuesOk.ok) return valuesOk;
  const metaOk = requireOkJson(metaRes, 'metadata');
  if (!metaOk.ok) return metaOk;
  const overflowOk = requireOkJson(overflowRes, 'overflow');
  if (!overflowOk.ok) return overflowOk;

  const tabMerges = detectGridMergesForTab(metaOk.json, sheetName);
  if (tabMerges.ok === false) return fail(tabMerges.reason, { tab: sheetName });
  if (tabMerges.merged) return fail('merged_cells', tabMerges);

  const rows = Array.isArray(valuesOk.json.values) ? valuesOk.json.values : [];
  const extra = detectExtraColumns(rows, 5);
  if (extra.extra) return fail('header_unknown_column', extra);

  const overflow = detectOverflowRows(overflowOk.json.values);
  if (overflow.overflow) return fail('sheet_over_limit', { max_data_rows: MAX_DATA_ROWS });
  if (rows.length > MAX_DATA_ROWS + 1) return fail('sheet_over_limit', { max_data_rows: MAX_DATA_ROWS });

  return {
    ok: true,
    rows: rows.map((r) => (r || []).slice(0, 5)),
    mergeChecked: true,
    overflowChecked: true,
    extraColumnsChecked: true,
  };
}

module.exports = {
  SHEETS_SCOPE,
  MAX_DATA_ROWS,
  parseServiceAccountJson,
  resolveSecretRef,
  signJwt,
  detectGridMergesForTab,
  detectExtraColumns,
  detectOverflowRows,
  classifyHttp,
  fetchSheetRows,
};
