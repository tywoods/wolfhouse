'use strict';

const STAFF_STATUS_READ_TIMEOUT_MS = 2000;
const HTTP_STAFF_STATUS_ORIGINS = Object.freeze({
  'wolfhouse-somo': 'http://ovh-wolfhouse-staff:3036',
  sunset: 'http://ovh-sunset-staff:3036',
});

const ENVIRONMENTS = Object.freeze([
  Object.freeze({
    client_slug: 'wolfhouse-somo',
    environment: 'staging',
    origin_env: 'CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN',
    token_env: 'CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN',
  }),
  Object.freeze({
    client_slug: 'sunset',
    environment: 'staging',
    origin_env: 'CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN',
    token_env: 'CROWSNEST_SUNSET_STAGING_STATUS_TOKEN',
  }),
]);

function admittedHttpStaffOrigin(clientSlug, url) {
  const expected = HTTP_STAFF_STATUS_ORIGINS[clientSlug];
  if (!expected || url.protocol !== 'http:') return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if ((url.pathname || '/') !== '/') return false;
  return url.hostname === new URL(expected).hostname
    && url.port === '3036'
    && url.origin === expected;
}

function resolveCrowsnestStaffStatusConfig(env = process.env) {
  const origins = {};
  const tokens = new Map();
  for (const item of ENVIRONMENTS) {
    const rawOrigin = String(env[item.origin_env] || '').trim();
    const token = String(env[item.token_env] || '');
    if (!rawOrigin || token.length < 32) continue;
    let url;
    try { url = new URL(rawOrigin); } catch (_) { continue; }
    const httpsOk = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    if (!httpsOk && !admittedHttpStaffOrigin(item.client_slug, url)) continue;
    const origin = url.origin;
    if (!origins[item.client_slug]) origins[item.client_slug] = {};
    origins[item.client_slug][item.environment] = origin;
    tokens.set(origin, token);
  }
  return Object.freeze({ origins, tokens });
}

function createCrowsnestStaffStatusReader(config, transport = fetch) {
  return async function requestJson(rawUrl) {
    const url = new URL(rawUrl);
    const token = config.tokens.get(url.origin);
    const httpOk = url.protocol === 'http:' && Object.values(HTTP_STAFF_STATUS_ORIGINS).includes(url.origin);
    if (!token || (url.protocol !== 'https:' && !httpOk)) throw new Error('status_origin_not_allowed');
    const response = await transport(url.href, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-crowsnest-status-token': token },
      redirect: 'error',
      signal: AbortSignal.timeout(STAFF_STATUS_READ_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`status_read_${response.status}`);
    return response.json();
  };
}

module.exports = {
  ENVIRONMENTS,
  HTTP_STAFF_STATUS_ORIGINS,
  STAFF_STATUS_READ_TIMEOUT_MS,
  resolveCrowsnestStaffStatusConfig,
  createCrowsnestStaffStatusReader,
};
