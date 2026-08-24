'use strict';

/**
 * Read-only Google Sheets adapter.
 * Errors keep their real class — never rewritten as empty_sheet.
 */

const crypto = require('crypto');
const https = require('https');
const { occupancyCellBooked, cellDisplayText } = require('./external-calendar-inventory');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_HOST = 'oauth2.googleapis.com';
const SHEETS_HOST = 'sheets.googleapis.com';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_DATA_ROWS = 5000;
const MAX_DATE_COLS = 366;
const MAX_GRID_COLS = MAX_DATE_COLS + 1; // column A is bed names
const GRID_FIELDS = [
  'sheets.properties.title',
  'sheets.merges',
  'sheets.data.rowData.values.formattedValue',
  'sheets.data.rowData.values.effectiveValue',
  'sheets.data.rowData.values.userEnteredFormat.backgroundColor',
  'sheets.data.rowData.values.userEnteredFormat.backgroundColorStyle',
  'sheets.data.rowData.values.effectiveFormat.backgroundColor',
  'sheets.data.rowData.values.effectiveFormat.backgroundColorStyle',
].join(',');

function colToA1(n) {
  let s = '';
  let x = Number(n);
  if (!Number.isFinite(x) || x < 1) return 'A';
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

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

function cellHasGridSignal(cell) {
  return cellDisplayText(cell).trim() !== '' || occupancyCellBooked(cell);
}

function detectOverflowRows(overflowRows) {
  const list = Array.isArray(overflowRows) ? overflowRows : [];
  const nonempty = list.some((row) => row && row.some((c) => cellHasGridSignal(c)));
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

function snapshotCell(cell) {
  if (!cell || typeof cell !== 'object') {
    return { formattedValue: cell == null ? '' : String(cell) };
  }
  const out = {};
  if (cell.formattedValue != null) out.formattedValue = String(cell.formattedValue);
  if (cell.effectiveValue && typeof cell.effectiveValue === 'object') {
    out.effectiveValue = {};
    if (cell.effectiveValue.stringValue != null) {
      out.effectiveValue.stringValue = String(cell.effectiveValue.stringValue);
    }
    if (typeof cell.effectiveValue.numberValue === 'number') {
      out.effectiveValue.numberValue = cell.effectiveValue.numberValue;
    }
    if (!Object.keys(out.effectiveValue).length) delete out.effectiveValue;
  }
  function copyFill(src) {
    if (!src || typeof src !== 'object') return undefined;
    const fmt = {};
    if (src.backgroundColor && typeof src.backgroundColor === 'object') {
      fmt.backgroundColor = {
        red: src.backgroundColor.red,
        green: src.backgroundColor.green,
        blue: src.backgroundColor.blue,
      };
      if (src.backgroundColor.alpha != null) fmt.backgroundColor.alpha = src.backgroundColor.alpha;
    }
    if (src.backgroundColorStyle && typeof src.backgroundColorStyle === 'object') {
      fmt.backgroundColorStyle = {};
      if (src.backgroundColorStyle.themeColor != null) {
        fmt.backgroundColorStyle.themeColor = String(src.backgroundColorStyle.themeColor);
      }
      if (src.backgroundColorStyle.rgbColor && typeof src.backgroundColorStyle.rgbColor === 'object') {
        fmt.backgroundColorStyle.rgbColor = {
          red: src.backgroundColorStyle.rgbColor.red,
          green: src.backgroundColorStyle.rgbColor.green,
          blue: src.backgroundColorStyle.rgbColor.blue,
        };
        if (src.backgroundColorStyle.rgbColor.alpha != null) {
          fmt.backgroundColorStyle.rgbColor.alpha = src.backgroundColorStyle.rgbColor.alpha;
        }
      }
      if (!Object.keys(fmt.backgroundColorStyle).length) delete fmt.backgroundColorStyle;
    }
    return Object.keys(fmt).length ? fmt : undefined;
  }
  const entered = copyFill(cell.userEnteredFormat);
  const effective = copyFill(cell.effectiveFormat);
  if (entered) out.userEnteredFormat = entered;
  if (effective) out.effectiveFormat = effective;
  return out;
}

function gridDataToRows(grid) {
  const rowData = (grid && grid.rowData) || [];
  return rowData.map((row) => {
    const values = (row && row.values) || [];
    return values.map(snapshotCell);
  });
}

function parseSpreadsheetSnapshot(json, sheetName) {
  const want = String(sheetName || 'inventory');
  if (!json || !Array.isArray(json.sheets) || json.sheets.length === 0) {
    return fail('sheet_snapshot_incomplete');
  }
  const tab = json.sheets.find((s) => s && s.properties && String(s.properties.title) === want);
  if (!tab) return fail('sheet_tab_missing', { tab: want });
  const merges = tab.merges || [];
  if (merges.length) return fail('merged_cells', { tab: want, count: merges.length });
  const data = Array.isArray(tab.data) ? tab.data : [];
  if (data.length < 2) return fail('sheet_snapshot_incomplete', { tab: want });
  const accepted = gridDataToRows(data[0]).map((r) => (r || []).slice(0, MAX_GRID_COLS));
  const overflow = gridDataToRows(data[1]);
  const colOverflow = data[2] ? gridDataToRows(data[2]) : [];
  const over = detectOverflowRows(overflow);
  const extraCols = detectOverflowRows(colOverflow);
  const extraInAccepted = detectExtraColumns(
    accepted.map((row) => (row || []).map((c) => cellDisplayText(c))),
    MAX_GRID_COLS
  );
  if (over.overflow || extraCols.overflow || extraInAccepted.extra || accepted.length > MAX_DATA_ROWS + 1) {
    return fail('sheet_over_limit', { max_data_rows: MAX_DATA_ROWS, max_date_cols: MAX_DATE_COLS });
  }
  return {
    ok: true,
    rows: accepted,
    mergeChecked: true,
    overflowChecked: true,
    extraColumnsChecked: true,
    snapshot: true,
  };
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
  const lastAccepted = colToA1(MAX_GRID_COLS);
  const overflowCol = colToA1(MAX_GRID_COLS + 1);
  const r1 = encodeURIComponent(sheetName + '!A1:' + lastAccepted + (MAX_DATA_ROWS + 1));
  const r2 = encodeURIComponent(sheetName + '!A' + (MAX_DATA_ROWS + 2) + ':' + lastAccepted);
  const r3 = encodeURIComponent(sheetName + '!' + overflowCol + '1:' + overflowCol + (MAX_DATA_ROWS + 1));
  const path = '/v4/spreadsheets/' + id
    + '?includeGridData=true'
    + '&ranges=' + r1
    + '&ranges=' + r2
    + '&ranges=' + r3
    + '&fields=' + encodeURIComponent(GRID_FIELDS);

  let res;
  try {
    res = await httpsRequest({
      hostname: SHEETS_HOST,
      method: 'GET',
      path,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      timeoutMs: deps.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, null, deps);
  } catch (err) {
    return fail(err.code || 'sheets_timeout');
  }
  const parsed = requireOkJson(res, 'spreadsheets.get');
  if (!parsed.ok) return parsed;
  return parseSpreadsheetSnapshot(parsed.json, sheetName);
}

module.exports = {
  SHEETS_SCOPE,
  MAX_DATA_ROWS,
  MAX_DATE_COLS,
  MAX_GRID_COLS,
  GRID_FIELDS,
  colToA1,
  parseServiceAccountJson,
  resolveSecretRef,
  signJwt,
  detectGridMergesForTab,
  detectExtraColumns,
  detectOverflowRows,
  parseSpreadsheetSnapshot,
  classifyHttp,
  fetchSheetRows,
};
