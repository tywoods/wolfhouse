'use strict';

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

function resolveCrowsnestStaffStatusConfig(env = process.env) {
  const origins = {};
  const tokens = new Map();
  for (const item of ENVIRONMENTS) {
    const rawOrigin = String(env[item.origin_env] || '').trim();
    const token = String(env[item.token_env] || '');
    if (!rawOrigin || token.length < 32) continue;
    let url;
    try { url = new URL(rawOrigin); } catch (_) { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue;
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
    if (!token || url.protocol !== 'https:') throw new Error('status_origin_not_allowed');
    const response = await transport(url.href, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-crowsnest-status-token': token },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`status_read_${response.status}`);
    return response.json();
  };
}

module.exports = { ENVIRONMENTS, resolveCrowsnestStaffStatusConfig, createCrowsnestStaffStatusReader };
