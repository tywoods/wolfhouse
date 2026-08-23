'use strict';

/**
 * Read-only Google Sheets adapter (service account JWT).
 * No write scopes. Timeout + inaccessible fail closed (no occupancy writes).
 */

const crypto = require('crypto');
const https = require('https');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_HOST = 'oauth2.googleapis.com';
const SHEETS_HOST = 'sheets.googleapis.com';
const DEFAULT_TIMEOUT_MS = 10000;

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
  const sig = b64url(sign.sign(serviceAccount.private_key));
  return input + '.' + sig;
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
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
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

function parseServiceAccountJson(raw) {
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (_) { return { ok: false, reason: 'secret_not_json' }; }
  if (!parsed || parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
    return { ok: false, reason: 'secret_not_service_account' };
  }
  return { ok: true, serviceAccount: parsed };
}

function resolveSecretRef(secretRef, env) {
  env = env || process.env;
  const name = String(secretRef || '').trim();
  if (!name) return { ok: false, reason: 'missing_secret_ref' };
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(name)) return { ok: false, reason: 'secret_ref_invalid' };
  const raw = env[name];
  if (!raw) return { ok: false, reason: 'secret_unresolved' };
  return parseServiceAccountJson(raw);
}

async function fetchAccessToken(serviceAccount, deps) {
  const jwt = signJwt(serviceAccount, Math.floor(Date.now() / 1000));
  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
    + '&assertion=' + encodeURIComponent(jwt);
  const res = await httpsRequest({
    hostname: TOKEN_HOST,
    method: 'POST',
    path: '/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form),
    },
    timeoutMs: (deps && deps.timeoutMs) || DEFAULT_TIMEOUT_MS,
  }, form, deps);
  if (res.status !== 200) {
    const err = new Error('sheets_token_denied');
    err.code = 'sheets_inaccessible';
    err.status = res.status;
    throw err;
  }
  const json = JSON.parse(res.body);
  if (!json.access_token) {
    const err = new Error('sheets_token_missing');
    err.code = 'sheets_inaccessible';
    throw err;
  }
  return json.access_token;
}

async function fetchSheetRows(connection, deps) {
  deps = deps || {};
  const secret = resolveSecretRef(connection.secret_ref, deps.env);
  if (!secret.ok) {
    return { ok: false, status: 'error', reason: secret.reason, keepLastBlocks: true, writes: [] };
  }
  let token;
  try {
    token = await fetchAccessToken(secret.serviceAccount, deps);
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      reason: err.code || 'sheets_inaccessible',
      keepLastBlocks: true,
      writes: [],
    };
  }
  const range = encodeURIComponent((connection.sheet_name || 'inventory') + '!A1:E5000');
  const path = '/v4/spreadsheets/' + encodeURIComponent(connection.spreadsheet_id)
    + '/values/' + range + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';
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
    return {
      ok: false,
      status: 'error',
      reason: err.code || 'sheets_inaccessible',
      keepLastBlocks: true,
      writes: [],
    };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { ok: false, status: 'error', reason: 'sheets_inaccessible', http: res.status, keepLastBlocks: true, writes: [] };
  }
  if (res.status !== 200) {
    return { ok: false, status: 'error', reason: 'sheets_http_' + res.status, keepLastBlocks: true, writes: [] };
  }
  let json;
  try { json = JSON.parse(res.body); }
  catch (_) {
    return { ok: false, status: 'error', reason: 'sheets_not_json', keepLastBlocks: true, writes: [] };
  }
  const rows = Array.isArray(json.values) ? json.values : [];
  return { ok: true, rows };
}

module.exports = {
  SHEETS_SCOPE,
  parseServiceAccountJson,
  resolveSecretRef,
  signJwt,
  fetchSheetRows,
};
