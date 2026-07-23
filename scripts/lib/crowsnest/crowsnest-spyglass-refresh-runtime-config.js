'use strict';

/**
 * Narrow server-owned Spyglass Refresh all runtime config (Slice B).
 *
 * Separate from the pure domain contract: reads environment only when invoked
 * by the API wiring layer. Resolves at most the fixed Sunset Somo staging
 * manual reporter job. Browser cannot supply subscription / RG / job / client.
 *
 * Fail closed unless every required field is present and validated.
 * Never log or return secret/materialized config dumps for UI echo.
 */

const AZURE_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SAFE_AZURE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/;

/** Fixed Sunset staging manual job — never Wolfhouse / Sardinero in this default. */
const FIXED_SUNSET_STAGING = Object.freeze({
  client_id: 'sunset-somo',
  job_name: 'sunset-somo-stg-cn-metrics',
  resource_group: 'luna-sunset-staging-rg',
});

const ENV = Object.freeze({
  subscriptionId: 'CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID',
  resourceGroup: 'CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP',
  jobName: 'CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME',
  managedIdentityClientId: 'CROWSNEST_SPYGLASS_REFRESH_AZURE_MANAGED_IDENTITY_CLIENT_ID',
});

function trimEnv(env, key) {
  if (!env || env[key] == null) return '';
  return String(env[key]).trim();
}

function isAzureGuid(value) {
  return typeof value === 'string' && AZURE_GUID_RE.test(value);
}

function isSafeAzureName(value) {
  return typeof value === 'string' && value === value.trim() && SAFE_AZURE_NAME_RE.test(value);
}

/**
 * Resolve server-owned Azure coordinates for the fixed Sunset staging manual job.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok:true, config:object}|{ok:false, code:string}}
 */
function resolveSpyglassRefreshRuntimeConfig(env = process.env) {
  const subscriptionId = trimEnv(env, ENV.subscriptionId);
  const resourceGroup = trimEnv(env, ENV.resourceGroup);
  const jobName = trimEnv(env, ENV.jobName);
  const managedIdentityClientId = trimEnv(env, ENV.managedIdentityClientId);

  if (!subscriptionId || !resourceGroup || !jobName) {
    return Object.freeze({ ok: false, code: 'refresh_runtime_config_absent' });
  }
  if (!isAzureGuid(subscriptionId)) {
    return Object.freeze({ ok: false, code: 'refresh_runtime_config_invalid_subscription' });
  }
  if (!isSafeAzureName(resourceGroup)) {
    return Object.freeze({ ok: false, code: 'refresh_runtime_config_invalid_resource_group' });
  }
  if (!isSafeAzureName(jobName)) {
    return Object.freeze({ ok: false, code: 'refresh_runtime_config_invalid_job_name' });
  }
  // Lock to the known Sunset staging manual job only.
  if (resourceGroup !== FIXED_SUNSET_STAGING.resource_group) {
    return Object.freeze({ ok: false, code: 'refresh_runtime_config_unsupported_resource_group' });
  }
  if (jobName !== FIXED_SUNSET_STAGING.job_name) {
    return Object.freeze({ ok: false, code: 'refresh_runtime_config_unsupported_job_name' });
  }
  if (managedIdentityClientId && !isAzureGuid(managedIdentityClientId)) {
    return Object.freeze({ ok: false, code: 'refresh_runtime_config_invalid_managed_identity_client_id' });
  }

  const config = {
    client_id: FIXED_SUNSET_STAGING.client_id,
    job_name: FIXED_SUNSET_STAGING.job_name,
    resource_group: FIXED_SUNSET_STAGING.resource_group,
    subscription_id: subscriptionId,
  };
  if (managedIdentityClientId) {
    config.managed_identity_client_id = managedIdentityClientId;
  }
  return Object.freeze({
    ok: true,
    config: Object.freeze(config),
  });
}

/**
 * Validate Container Apps IDENTITY_ENDPOINT / IDENTITY_HEADER shapes.
 * Allows only local http MSI token endpoints (no public hosts).
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveManagedIdentityEndpointConfig(env = process.env) {
  const identityEndpoint = trimEnv(env, 'IDENTITY_ENDPOINT');
  const identityHeader = trimEnv(env, 'IDENTITY_HEADER');

  if (!identityEndpoint || !identityHeader) {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_absent' });
  }
  if (identityHeader.length > 4096 || /[\r\n]/.test(identityHeader)) {
    return Object.freeze({ ok: false, code: 'managed_identity_header_invalid' });
  }

  let url;
  try {
    url = new URL(identityEndpoint);
  } catch {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }

  if (url.protocol !== 'http:') {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }
  if (url.username || url.password) {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }
  const host = String(url.hostname || '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }
  if (url.pathname !== '/msi/token') {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }
  if (url.search || url.hash) {
    // Base endpoint must be path-only; query is added by the adapter.
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }

  return Object.freeze({
    ok: true,
    identity_endpoint: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/msi/token`,
    identity_header: identityHeader,
  });
}

module.exports = {
  ENV,
  FIXED_SUNSET_STAGING,
  resolveSpyglassRefreshRuntimeConfig,
  resolveManagedIdentityEndpointConfig,
};
