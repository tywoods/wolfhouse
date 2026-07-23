'use strict';

/**
 * Spyglass Refresh all — Azure Container Apps Job-start adapter (Slice B).
 *
 * Production path: acquire a managed-identity token via the Container Apps
 * IDENTITY_ENDPOINT / IDENTITY_HEADER contract, then POST the exact ARM
 * jobs/start URL for the fixed server-owned Sunset staging manual job.
 *
 * - Injected fetch only (never global fetch, never Azure SDK, never Azure CLI)
 * - No long-lived secrets
 * - Allow only exact ARM host / resource audience / MI token endpoint shapes
 * - Never return raw body, error text, tokens, or job execution IDs
 * - started (ok:true) means Azure accepted the job-start request only
 */

const ARM_HOST = 'management.azure.com';
const ARM_RESOURCE = 'https://management.azure.com/';
const ARM_API_VERSION = '2023-05-01';
const MI_API_VERSION = '2019-08-01';
const DEFAULT_TIMEOUT_MS = 10000;

const SAFE_CODES = Object.freeze({
  transport_required: 'transport_required',
  runtime_config_required: 'runtime_config_required',
  identity_required: 'identity_required',
  target_mismatch: 'target_mismatch',
  identity_token_failed: 'identity_token_failed',
  arm_start_failed: 'arm_start_failed',
  transport_failed: 'transport_failed',
});

function fail(code) {
  return Object.freeze({ ok: false, code: SAFE_CODES[code] || SAFE_CODES.transport_failed });
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function trimString(value) {
  return value == null ? '' : String(value).trim();
}

function assertExactIdentityEndpointBase(identityEndpoint) {
  let url;
  try {
    url = new URL(String(identityEndpoint || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = String(url.hostname || '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') return false;
  if (url.pathname !== '/msi/token') return false;
  if (url.search || url.hash) return false;
  return true;
}

function buildManagedIdentityTokenUrl(identityEndpoint, managedIdentityClientId) {
  if (!assertExactIdentityEndpointBase(identityEndpoint)) return null;
  const url = new URL(identityEndpoint);
  url.searchParams.set('api-version', MI_API_VERSION);
  url.searchParams.set('resource', ARM_RESOURCE);
  if (managedIdentityClientId) {
    url.searchParams.set('client_id', managedIdentityClientId);
  }
  return url.toString();
}

function buildArmJobStartUrl(runtimeConfig) {
  if (!isPlainObject(runtimeConfig)) return null;
  const subscriptionId = trimString(runtimeConfig.subscription_id);
  const resourceGroup = trimString(runtimeConfig.resource_group);
  const jobName = trimString(runtimeConfig.job_name);
  if (!subscriptionId || !resourceGroup || !jobName) return null;
  // Exact ARM host + path shape only.
  return (
    `https://${ARM_HOST}/subscriptions/${encodeURIComponent(subscriptionId)}`
    + `/resourceGroups/${encodeURIComponent(resourceGroup)}`
    + `/providers/Microsoft.App/jobs/${encodeURIComponent(jobName)}/start`
    + `?api-version=${ARM_API_VERSION}`
  );
}

function assertArmStartUrl(urlString, runtimeConfig) {
  const expected = buildArmJobStartUrl(runtimeConfig);
  return expected != null && urlString === expected;
}

async function readJsonSafe(response) {
  if (!response || typeof response.json !== 'function') return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Timed fetch helper. Never returns response bodies to callers.
 */
async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const status = Number(response && response.status) || 0;
    const body = await readJsonSafe(response);
    return { status, body, ok: status >= 200 && status < 300 };
  } catch {
    return { status: 0, body: null, ok: false, transportError: true };
  } finally {
    clearTimeout(timer);
  }
}

function targetMatchesRuntime(target, runtimeConfig) {
  if (!isPlainObject(target) || !isPlainObject(runtimeConfig)) return false;
  return (
    trimString(target.client_id) === trimString(runtimeConfig.client_id)
    && trimString(target.job_name) === trimString(runtimeConfig.job_name)
  );
}

/**
 * Create an injected startJob transport for requestSpyglassRefreshAll.
 *
 * @param {object} options
 * @param {Function} options.fetch required injected fetch
 * @param {object} options.runtimeConfig from resolveSpyglassRefreshRuntimeConfig().config
 * @param {string} options.identityEndpoint validated IDENTITY_ENDPOINT
 * @param {string} options.identityHeader validated IDENTITY_HEADER
 * @param {number} [options.timeoutMs]
 */
function createAzureContainerAppsJobStartTransport(options = {}) {
  const fetchImpl = options.fetch || options.fetchImpl;
  const runtimeConfig = options.runtimeConfig || options.runtime_config;
  const identityEndpoint = trimString(options.identityEndpoint || options.identity_endpoint);
  const identityHeader = trimString(options.identityHeader || options.identity_header);
  const timeoutMs = Number(options.timeoutMs || options.timeout_ms) > 0
    ? Number(options.timeoutMs || options.timeout_ms)
    : DEFAULT_TIMEOUT_MS;
  const managedIdentityClientId = trimString(
    (runtimeConfig && runtimeConfig.managed_identity_client_id)
      || options.managedIdentityClientId
      || options.managed_identity_client_id
      || '',
  );

  return async function azureContainerAppsJobStart(target) {
    if (typeof fetchImpl !== 'function') return fail('transport_required');
    if (!isPlainObject(runtimeConfig)) return fail('runtime_config_required');
    if (!identityEndpoint || !identityHeader) return fail('identity_required');
    if (!assertExactIdentityEndpointBase(identityEndpoint)) return fail('identity_required');
    if (!targetMatchesRuntime(target, runtimeConfig)) return fail('target_mismatch');

    const tokenUrl = buildManagedIdentityTokenUrl(identityEndpoint, managedIdentityClientId || null);
    if (!tokenUrl) return fail('identity_required');

    const tokenResult = await timedFetch(fetchImpl, tokenUrl, {
      method: 'GET',
      headers: {
        'X-IDENTITY-HEADER': identityHeader,
      },
    }, timeoutMs);

    if (!tokenResult.ok) return fail('identity_token_failed');
    const accessToken = tokenResult.body && typeof tokenResult.body === 'object'
      ? trimString(tokenResult.body.access_token)
      : '';
    if (!accessToken) return fail('identity_token_failed');

    const armUrl = buildArmJobStartUrl(runtimeConfig);
    if (!armUrl || !assertArmStartUrl(armUrl, runtimeConfig)) {
      return fail('runtime_config_required');
    }

    const armResult = await timedFetch(fetchImpl, armUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }, timeoutMs);

    // Discard ARM body intentionally — never surface execution name/id.
    void armResult.body;

    if (!armResult.ok) return fail('arm_start_failed');
    // ok:true means Azure accepted the job-start request — not that metrics updated.
    return Object.freeze({ ok: true });
  };
}

module.exports = {
  ARM_HOST,
  ARM_RESOURCE,
  ARM_API_VERSION,
  MI_API_VERSION,
  createAzureContainerAppsJobStartTransport,
  buildArmJobStartUrl,
  buildManagedIdentityTokenUrl,
};
