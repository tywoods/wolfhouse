'use strict';

/**
 * Read-only post-deploy check for Wolfhouse staging or production.
 *
 * A human runs this after a deploy. It confirms health and a few readable
 * settings in under a minute. It never writes: the transport allows only
 * GET or HEAD.
 *
 *   node scripts/check-wolfhouse-post-deploy.js --env staging --expect-sha <sha>
 *   node scripts/check-wolfhouse-post-deploy.js --env prod --expect-sha <sha>
 *   node scripts/check-wolfhouse-post-deploy.js --env prod --expect-sha <sha> \
 *     --luna-health-url http://127.0.0.1:8090/health
 *
 * Staff origins (no other host is accepted for Staff reads):
 *   staging  https://staff-staging.lunafrontdesk.com
 *   prod     https://admin.wolf-house.com, then https://wh.lunafrontdesk.com
 *            when the primary does not answer. The output names the one that did.
 *
 * Reads that already exist:
 *   GET /healthz                         Staff liveness (service staff-api)
 *   GET /healthz/identity                public Staff identity, scanned for a sha
 *   GET /staff/bot/luna-intelligence     web search flag for the bot tenant
 *   GET /staff/ui                        guest-simulator tab flag
 *
 * Luna GET /health is not served on the public Staff hostname. That row is
 * SKIP ("not publicly exposed") and does not change the exit code, unless
 * --luna-health-url is set. That optional GET does not send Staff credentials.
 * HTTP 200 counts only when the body is JSON with ok true or status "ok".
 * HTML, including a login page, is FAIL.
 *
 * Web search uses LUNA_BOT_INTERNAL_TOKEN as X-Luna-Bot-Token.
 * The simulator flag uses LUNA_STAFF_SESSION as the luna_staff_session cookie.
 * The script prints those variable names and never their values.
 *
 * Offline: node --test scripts/check-wolfhouse-post-deploy.test.js
 */

const http = require('node:http');
const https = require('node:https');

const STAGING_ORIGIN = 'https://staff-staging.lunafrontdesk.com';
const PROD_PRIMARY_ORIGIN = 'https://admin.wolf-house.com';
const PROD_FALLBACK_ORIGIN = 'https://wh.lunafrontdesk.com';

const ORIGINS = Object.freeze({
  staging: Object.freeze([STAGING_ORIGIN]),
  prod: Object.freeze([PROD_PRIMARY_ORIGIN, PROD_FALLBACK_ORIGIN]),
});

const SHA_KEYS = Object.freeze([
  'git_sha',
  'git_sha_full',
  'commit_sha',
  'source_sha',
  'build_sha',
  'commit',
  'sha',
  'revision',
]);

const MAX_BODY = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const BOT_TOKEN_VAR = 'LUNA_BOT_INTERNAL_TOKEN';
const STAFF_SESSION_VAR = 'LUNA_STAFF_SESSION';
const WOLFHOUSE_SLUG = 'wolfhouse-somo';

function normalizeSha(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{7,64}$/.test(text) ? text : null;
}

function shaMatches(exposed, expected) {
  if (exposed === expected) return true;
  if (expected.length >= 7 && exposed.startsWith(expected)) return true;
  if (exposed.length >= 7 && expected.startsWith(exposed)) return true;
  return false;
}

function parseJsonObject(text) {
  if (text == null || !String(text).trim()) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function collectShas(bodies) {
  const found = [];
  for (const body of bodies) {
    if (!body) continue;
    for (const key of SHA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const sha = normalizeSha(body[key]);
      if (sha && found.indexOf(sha) === -1) found.push(sha);
    }
  }
  return found;
}

function credential(env, name) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, name) || env[name] == null) {
    return { state: 'missing' };
  }
  const value = String(env[name]);
  if (!value.trim()) return { state: 'missing' };
  if (value !== value.trim() || /[\s\u0000]/.test(value)) return { state: 'unusable' };
  return { state: 'ok', value };
}

function redact(text, env) {
  let out = String(text);
  for (const name of [BOT_TOKEN_VAR, STAFF_SESSION_VAR]) {
    const secret = credential(env, name);
    if (secret.state === 'ok' && secret.value.length >= 4) {
      out = out.split(secret.value).join('[redacted]');
    }
  }
  return out;
}

function allowedStaffOrigins() {
  return Object.values(ORIGINS).flat();
}

function parseLunaHealthUrl(value) {
  if (value == null || String(value).trim() === '' || String(value).startsWith('--')) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch (_) {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) {
    return null;
  }
  return `${url.origin}${url.pathname}${url.search}`;
}

function resolveTarget(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let envName = null;
  let expectSha = null;
  let lunaHealthUrl = null;
  let sawLunaFlag = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--env') {
      envName = args[i + 1];
      i += 1;
      if (envName == null) return { refused: true };
    } else if (arg === '--expect-sha') {
      expectSha = args[i + 1];
      i += 1;
      if (expectSha == null) return { usage: true };
    } else if (arg === '--luna-health-url') {
      sawLunaFlag = true;
      lunaHealthUrl = parseLunaHealthUrl(args[i + 1]);
      i += 1;
      if (!lunaHealthUrl) return { refused: true };
    } else {
      return { refused: true };
    }
  }
  if (!envName || !Object.prototype.hasOwnProperty.call(ORIGINS, envName)) {
    return { refused: true };
  }
  if (sawLunaFlag && !lunaHealthUrl) return { refused: true };
  const sha = normalizeSha(expectSha);
  if (!sha) return { usage: true };
  return {
    envName,
    origins: ORIGINS[envName],
    expectSha: sha,
    lunaHealthUrl,
  };
}

function bindRequest(origin, request) {
  if (!allowedStaffOrigins().includes(origin)) {
    const error = new Error('refused unknown origin');
    error.code = 'REFUSED_ORIGIN';
    throw error;
  }
  return async function checked(method, pathname, headers) {
    const verb = String(method || '').toUpperCase();
    if (verb !== 'GET' && verb !== 'HEAD') {
      const error = new Error('refused method');
      error.code = 'REFUSED_METHOD';
      throw error;
    }
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
      const error = new Error('refused unknown origin');
      error.code = 'REFUSED_ORIGIN';
      throw error;
    }
    const url = new URL(pathname, origin);
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password) {
      const error = new Error('refused unknown origin');
      error.code = 'REFUSED_ORIGIN';
      throw error;
    }
    return request(verb, url.toString(), headers || {});
  };
}

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createReadOnlyRequest(allowedOrigins, transports = {}) {
  const allowed = new Set(allowedOrigins);
  const httpsImpl = transports.httpsImpl || https;
  const httpImpl = transports.httpImpl || http;
  return async (method, urlString, headers) => {
    const verb = String(method || '').toUpperCase();
    if (verb !== 'GET' && verb !== 'HEAD') throw refuse('REFUSED_METHOD', 'refused method');
    let url;
    try {
      url = new URL(urlString);
    } catch (_) {
      throw refuse('REFUSED_ORIGIN', 'refused unknown origin');
    }
    if (!allowed.has(url.origin) || url.username || url.password) {
      throw refuse('REFUSED_ORIGIN', 'refused unknown origin');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw refuse('REFUSED_ORIGIN', 'refused unknown origin');
    }
    const impl = url.protocol === 'http:' ? httpImpl : httpsImpl;
    const port = url.port || (url.protocol === 'http:' ? 80 : 443);
    return new Promise((resolve, reject) => {
      const req = impl.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: verb,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_BODY) chunks.push(chunk);
          if (size > MAX_BODY) res.destroy();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  };
}

function createHttpsRequest(origin, httpsImpl = https) {
  return createReadOnlyRequest([origin], { httpsImpl });
}

function createDefaultRequest(origin, httpsImpl = https) {
  return bindRequest(origin, createHttpsRequest(origin, httpsImpl));
}

async function selectStaffOrigin(origins, request) {
  const misses = [];
  for (const origin of origins) {
    try {
      const response = await request('GET', `${origin}/healthz`, { Accept: 'application/json' });
      return { origin, response, misses };
    } catch (err) {
      if (err && (err.code === 'REFUSED_ORIGIN' || err.code === 'REFUSED_METHOD')) throw err;
      misses.push(origin);
    }
  }
  return { origin: null, response: null, misses };
}

function staffHealthRow(response, origin) {
  const status = response && response.status;
  const where = origin ? ` ${origin}` : '';
  const body = parseJsonObject(response && response.body);
  if (status === 200 && body && body.status === 'ok' && body.service === 'staff-api') {
    return { check: 'staff health', result: 'PASS', detail: `HTTP 200 staff-api${where}`, body };
  }
  return {
    check: 'staff health',
    result: 'FAIL',
    detail: `HTTP ${status || 0}${where}`,
    body,
  };
}

function lunaSkippedRow() {
  return { check: 'luna health', result: 'SKIP', detail: 'not publicly exposed' };
}

function looksLikeHtml(text) {
  const sample = String(text || '').replace(/^\uFEFF/, '').trim().slice(0, 512).toLowerCase();
  return sample.startsWith('<!doctype')
    || sample.startsWith('<html')
    || sample.startsWith('<head')
    || sample.startsWith('<body')
    || sample.includes('<html')
    || /<form[\s>]/.test(sample);
}

function lunaHealthRow(response) {
  const status = response && response.status;
  const raw = response && response.body;
  const body = parseJsonObject(raw);
  if (status !== 200) {
    return { check: 'luna health', result: 'FAIL', detail: `HTTP ${status || 0}`, body };
  }
  if (body && body.service === 'staff-api') {
    return { check: 'luna health', result: 'FAIL', detail: 'HTTP 200 served staff-api, not Luna', body };
  }
  if (body && (body.ok === false || (body.status && body.status !== 'ok'))) {
    return { check: 'luna health', result: 'FAIL', detail: 'HTTP 200 unhealthy', body };
  }
  if (body && (body.ok === true || body.status === 'ok')) {
    return { check: 'luna health', result: 'PASS', detail: 'HTTP 200', body };
  }
  if (looksLikeHtml(raw)) {
    return { check: 'luna health', result: 'FAIL', detail: 'HTTP 200 HTML, not a health payload' };
  }
  return { check: 'luna health', result: 'FAIL', detail: 'HTTP 200 not a health payload' };
}

function versionRow(bodies, expected) {
  const shas = collectShas(bodies);
  if (!shas.length) {
    return { check: 'version', result: 'PASS', detail: 'version not exposed' };
  }
  const mismatch = shas.find((sha) => !shaMatches(sha, expected));
  if (mismatch) return { check: 'version', result: 'FAIL', detail: `running ${mismatch}` };
  return { check: 'version', result: 'PASS', detail: `matches ${shas[0]}` };
}

function credentialRow(check, secret, variable) {
  if (secret.state === 'missing') {
    return { check, result: 'FAIL', detail: `credential required: ${variable}` };
  }
  if (secret.state !== 'ok') {
    return { check, result: 'FAIL', detail: `credential unusable: ${variable}` };
  }
  return null;
}

function webSearchRow(response, variable) {
  const check = 'luna web search (wolfhouse-somo)';
  const status = response && response.status;
  if (status === 401 || status === 403) {
    return { check, result: 'FAIL', detail: `credential rejected: ${variable}` };
  }
  const body = parseJsonObject(response && response.body);
  if (status !== 200 || !body || body.success !== true || typeof body.enabled !== 'boolean') {
    return { check, result: 'FAIL', detail: `HTTP ${status || 0} (${variable})` };
  }
  if (body.client_slug !== WOLFHOUSE_SLUG) {
    return { check, result: 'FAIL', detail: `client_slug is not ${WOLFHOUSE_SLUG} (${variable})` };
  }
  return {
    check,
    result: 'PASS',
    detail: `${body.enabled ? 'enabled' : 'disabled'} (${variable})`,
  };
}

function simulatorRow(response, variable) {
  const check = 'guest simulator';
  const status = response && response.status;
  if (status === 401 || status === 403) {
    return { check, result: 'FAIL', detail: `credential rejected: ${variable}` };
  }
  if (status !== 200) {
    return { check, result: 'FAIL', detail: `HTTP ${status || 0} (${variable})` };
  }
  const match = String(response.body || '').match(/window\.__STAFF_PORTAL_DEV_TABS__\s*=\s*(true|false)/);
  if (!match) {
    return { check, result: 'FAIL', detail: `flag not readable (${variable})` };
  }
  return {
    check,
    result: 'PASS',
    detail: `${match[1] === 'true' ? 'ON' : 'OFF'} (${variable})`,
  };
}

async function readOptional(request, pathname) {
  try {
    const response = await request('GET', pathname, { Accept: 'application/json' });
    if (!response || response.status !== 200) return null;
    return parseJsonObject(response.body);
  } catch (_) {
    return null;
  }
}

async function runChecks({ origin, healthzResponse, expectSha, env, request, lunaHealthUrl, lunaRequest }) {
  const checked = bindRequest(origin, request);
  const rows = [];
  const versionBodies = [];

  const staff = staffHealthRow(healthzResponse, origin);
  rows.push(staff);
  if (staff.body) versionBodies.push(staff.body);

  if (!lunaHealthUrl) {
    rows.push(lunaSkippedRow());
  } else {
    let luna;
    try {
      const response = await lunaRequest('GET', lunaHealthUrl, { Accept: 'application/json' });
      luna = lunaHealthRow(response);
    } catch (err) {
      if (err && (err.code === 'REFUSED_ORIGIN' || err.code === 'REFUSED_METHOD')) throw err;
      luna = { check: 'luna health', result: 'FAIL', detail: 'request failed' };
    }
    rows.push(luna);
    if (luna.body) versionBodies.push(luna.body);
  }

  versionBodies.push(await readOptional(checked, '/healthz/identity'));
  rows.push(versionRow(versionBodies, expectSha));

  const webCheck = 'luna web search (wolfhouse-somo)';
  const token = credential(env, BOT_TOKEN_VAR);
  const tokenRow = credentialRow(webCheck, token, BOT_TOKEN_VAR);
  if (tokenRow) {
    rows.push(tokenRow);
  } else {
    try {
      rows.push(webSearchRow(await checked('GET', '/staff/bot/luna-intelligence', {
        Accept: 'application/json',
        'X-Luna-Bot-Token': token.value,
      }), BOT_TOKEN_VAR));
    } catch (err) {
      if (err && (err.code === 'REFUSED_ORIGIN' || err.code === 'REFUSED_METHOD')) throw err;
      rows.push({ check: webCheck, result: 'FAIL', detail: `request failed (${BOT_TOKEN_VAR})` });
    }
  }

  const simCheck = 'guest simulator';
  const session = credential(env, STAFF_SESSION_VAR);
  const sessionRow = credentialRow(simCheck, session, STAFF_SESSION_VAR);
  if (sessionRow) {
    rows.push(sessionRow);
  } else if (!/^[A-Za-z0-9._~+-]{8,512}$/.test(session.value)) {
    rows.push({ check: simCheck, result: 'FAIL', detail: `credential unusable: ${STAFF_SESSION_VAR}` });
  } else {
    try {
      rows.push(simulatorRow(await checked('GET', '/staff/ui', {
        Accept: 'text/html',
        Cookie: `luna_staff_session=${session.value}`,
      }), STAFF_SESSION_VAR));
    } catch (err) {
      if (err && (err.code === 'REFUSED_ORIGIN' || err.code === 'REFUSED_METHOD')) throw err;
      rows.push({ check: simCheck, result: 'FAIL', detail: `request failed (${STAFF_SESSION_VAR})` });
    }
  }

  return rows.map((row) => ({
    check: row.check,
    result: row.result,
    detail: redact(row.detail, env),
  }));
}

function formatTable(rows) {
  const header = { check: 'check', result: 'result', detail: 'detail' };
  const all = [header].concat(rows);
  const checkWidth = Math.max.apply(null, all.map((row) => row.check.length));
  const resultWidth = Math.max.apply(null, all.map((row) => row.result.length));
  const line = (row) => `${row.check.padEnd(checkWidth)}  ${row.result.padEnd(resultWidth)}  ${row.detail}`;
  return [line(header)].concat(rows.map(line)).join('\n') + '\n';
}

function usageText() {
  return [
    'usage: node scripts/check-wolfhouse-post-deploy.js --env staging|prod --expect-sha <sha> [--luna-health-url <url>]',
    'expect-sha must be 7-64 hex characters. Staff reads accept only the configured origins.',
    '',
  ].join('\n');
}

async function execute(argv, deps = {}) {
  const target = resolveTarget(argv);
  if (target.refused) {
    const rows = [{ check: 'origin', result: 'FAIL', detail: 'refused unknown origin' }];
    return { exitCode: 1, output: formatTable(rows), rows };
  }
  if (target.usage) {
    const rows = [{ check: 'expect-sha', result: 'FAIL', detail: 'expect-sha must be 7-64 hex characters' }];
    return { exitCode: 1, output: `${usageText()}${formatTable(rows)}`, rows };
  }
  const env = deps.env || process.env;
  const request = deps.request || createReadOnlyRequest(target.origins, {
    httpsImpl: deps.httpsImpl,
    httpImpl: deps.httpImpl,
  });
  try {
    const selected = await selectStaffOrigin(target.origins, request);
    if (!selected.origin) {
      let luna = lunaSkippedRow();
      if (target.lunaHealthUrl) {
        try {
          const lunaRequest = deps.request || createReadOnlyRequest([new URL(target.lunaHealthUrl).origin], {
            httpsImpl: deps.httpsImpl,
            httpImpl: deps.httpImpl,
          });
          luna = lunaHealthRow(await lunaRequest('GET', target.lunaHealthUrl, { Accept: 'application/json' }));
        } catch (err) {
          if (err && (err.code === 'REFUSED_ORIGIN' || err.code === 'REFUSED_METHOD')) throw err;
          luna = { check: 'luna health', result: 'FAIL', detail: 'request failed' };
        }
      }
      const rows = [
        { check: 'staff health', result: 'FAIL', detail: 'request failed' },
        { check: luna.check, result: luna.result, detail: redact(luna.detail, env) },
        { check: 'version', result: 'PASS', detail: 'version not exposed' },
      ];
      const output = [
        `env ${target.envName}`,
        `origin none (${target.origins.join(', ')} did not answer)`,
        `expect-sha ${target.expectSha}`,
        '',
        formatTable(rows),
      ].join('\n');
      return { exitCode: 1, output, rows };
    }
    const lunaRequest = target.lunaHealthUrl
      ? (deps.request || createReadOnlyRequest([new URL(target.lunaHealthUrl).origin], {
        httpsImpl: deps.httpsImpl,
        httpImpl: deps.httpImpl,
      }))
      : null;
    const rows = await runChecks({
      origin: selected.origin,
      healthzResponse: selected.response,
      expectSha: target.expectSha,
      env,
      request,
      lunaHealthUrl: target.lunaHealthUrl,
      lunaRequest,
    });
    const failed = rows.some((row) => row.result === 'FAIL');
    const fallback = selected.misses.length
      ? ` (fallback; ${selected.misses.join(', ')} did not answer)`
      : '';
    const output = [
      `env ${target.envName}`,
      `origin ${selected.origin}${fallback}`,
      `expect-sha ${target.expectSha}`,
      '',
      formatTable(rows),
    ].join('\n');
    return { exitCode: failed ? 1 : 0, output, rows };
  } catch (err) {
    const detail = err && (err.code === 'REFUSED_ORIGIN' || err.code === 'REFUSED_METHOD')
      ? 'refused unknown origin'
      : 'request failed';
    const rows = [{ check: 'origin', result: 'FAIL', detail: redact(detail, env) }];
    return { exitCode: 1, output: formatTable(rows), rows };
  }
}

async function main(argv) {
  const result = await execute(argv);
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write('check  result  detail\norigin  FAIL    request failed\n');
    process.exitCode = 1;
  });
}

module.exports = {
  ORIGINS,
  STAGING_ORIGIN,
  PROD_PRIMARY_ORIGIN,
  PROD_FALLBACK_ORIGIN,
  BOT_TOKEN_VAR,
  STAFF_SESSION_VAR,
  resolveTarget,
  bindRequest,
  createReadOnlyRequest,
  createHttpsRequest,
  createDefaultRequest,
  execute,
  formatTable,
};
