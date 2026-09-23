'use strict';

/**
 * Staff portal deploy-age evidence for Crow's Nest Clients.
 *
 * Reads Azure Container Apps active-revision createdTime (plus short revision /
 * image tag) for admitted Staff portal origins. This is deploy/upload age —
 * never /healthz probe time.
 *
 * - Injected fetch only (no global fetch, Azure SDK, or Azure CLI)
 * - Managed-identity ARM token via IDENTITY_ENDPOINT / IDENTITY_HEADER
 * - Exact admitted RG/app locks; fail soft when config/identity/ARM unavailable
 */

const ARM_HOST = 'management.azure.com';
const ARM_RESOURCE = 'https://management.azure.com/';
const ARM_API_VERSION = '2024-03-01';
const MI_API_VERSION = '2019-08-01';
const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60000;
const AZURE_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Locked to measured public CNAMEs / known Staff ACA apps. Sunset production
// currently aliases the Sunset staging Container App (same FQDN family).
const PORTAL_DEPLOY_SOURCES = Object.freeze([
  Object.freeze({
    client: 'wolfhouse-somo',
    slug: 'wolfhouse-somo',
    environment: 'staging',
    origin: 'https://staff-staging.lunafrontdesk.com',
    resource_group: 'wh-staging-rg',
    container_app: 'wh-staging-staff-api',
  }),
  Object.freeze({
    client: 'sunset-somo',
    slug: 'sunset',
    environment: 'staging',
    origin: 'https://sunset-staging.lunafrontdesk.com',
    resource_group: 'luna-sunset-staging-rg',
    container_app: 'luna-sunset-staging-staff-api',
  }),
  Object.freeze({
    client: 'wolfhouse-somo',
    slug: 'wolfhouse-somo',
    environment: 'production',
    origin: 'https://wolfhouse.lunafrontdesk.com',
    resource_group: 'wh-prod-rg',
    container_app: 'wh-prod-staff-api',
  }),
  Object.freeze({
    client: 'sunset-somo',
    slug: 'sunset',
    environment: 'production',
    origin: 'https://sunset.lunafrontdesk.com',
    resource_group: 'luna-sunset-staging-rg',
    container_app: 'luna-sunset-staging-staff-api',
  }),
]);

function trimString(value) {
  return value == null ? '' : String(value).trim();
}

function emptyDeploy(reason = 'source_not_admitted') {
  return Object.freeze({
    updated_at: null,
    revision: null,
    revision_short: null,
    image_tag: null,
    source_kind: 'none',
    reason,
  });
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

function buildArmContainerAppUrl(subscriptionId, resourceGroup, containerApp) {
  return (
    `https://${ARM_HOST}/subscriptions/${encodeURIComponent(subscriptionId)}`
    + `/resourceGroups/${encodeURIComponent(resourceGroup)}`
    + `/providers/Microsoft.App/containerApps/${encodeURIComponent(containerApp)}`
    + `?api-version=${ARM_API_VERSION}`
  );
}

function buildArmRevisionUrl(subscriptionId, resourceGroup, containerApp, revisionName) {
  return (
    `https://${ARM_HOST}/subscriptions/${encodeURIComponent(subscriptionId)}`
    + `/resourceGroups/${encodeURIComponent(resourceGroup)}`
    + `/providers/Microsoft.App/containerApps/${encodeURIComponent(containerApp)}`
    + `/revisions/${encodeURIComponent(revisionName)}`
    + `?api-version=${ARM_API_VERSION}`
  );
}

function resolvePortalDeployRuntimeConfig(env = process.env) {
  const subscriptionId = trimString(env.CROWSNEST_PORTAL_DEPLOY_AZURE_SUBSCRIPTION_ID);
  const managedIdentityClientId = trimString(
    env.CROWSNEST_PORTAL_DEPLOY_AZURE_MANAGED_IDENTITY_CLIENT_ID,
  );
  if (!subscriptionId) {
    return Object.freeze({ ok: false, code: 'portal_deploy_config_absent' });
  }
  if (!AZURE_GUID_RE.test(subscriptionId)) {
    return Object.freeze({ ok: false, code: 'portal_deploy_config_invalid_subscription' });
  }
  if (managedIdentityClientId && !AZURE_GUID_RE.test(managedIdentityClientId)) {
    return Object.freeze({ ok: false, code: 'portal_deploy_config_invalid_managed_identity' });
  }
  const config = { subscription_id: subscriptionId };
  if (managedIdentityClientId) config.managed_identity_client_id = managedIdentityClientId;
  return Object.freeze({ ok: true, config: Object.freeze(config) });
}

function resolveManagedIdentityEndpointConfig(env = process.env) {
  const identityEndpoint = trimString(env.IDENTITY_ENDPOINT);
  const identityHeader = trimString(env.IDENTITY_HEADER);
  if (!identityEndpoint || !identityHeader) {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_absent' });
  }
  if (identityHeader.length > 4096 || /[\r\n]/.test(identityHeader)) {
    return Object.freeze({ ok: false, code: 'managed_identity_header_invalid' });
  }
  if (!assertExactIdentityEndpointBase(identityEndpoint)) {
    return Object.freeze({ ok: false, code: 'managed_identity_endpoint_invalid' });
  }
  return Object.freeze({
    ok: true,
    identity_endpoint: identityEndpoint,
    identity_header: identityHeader,
  });
}

async function timedJson(transport, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(url, { ...init, signal: controller.signal, redirect: 'error' });
    const status = Number(response && response.status) || 0;
    let body = null;
    try {
      body = typeof response.json === 'function' ? await response.json() : null;
    } catch {
      body = null;
    }
    return { status, body, ok: status >= 200 && status < 300 };
  } catch {
    return { status: 0, body: null, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function pickActiveRevisionName(appBody) {
  const props = appBody && typeof appBody === 'object' ? appBody.properties : null;
  if (!props || typeof props !== 'object') return '';
  const traffic = props.configuration
    && props.configuration.ingress
    && Array.isArray(props.configuration.ingress.traffic)
    ? props.configuration.ingress.traffic
    : [];
  const weighted = traffic
    .map((row) => ({
      name: trimString(row && row.revisionName),
      weight: Number(row && row.weight),
    }))
    .filter((row) => row.name && Number.isFinite(row.weight) && row.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  if (weighted.length === 1 && weighted[0].weight === 100) return weighted[0].name;
  if (weighted.length >= 1) return weighted[0].name;
  return trimString(props.latestReadyRevisionName || props.latestRevisionName);
}

function shortRevisionLabel(revisionName, containerApp) {
  const full = trimString(revisionName);
  if (!full) return null;
  const prefix = `${trimString(containerApp)}--`;
  if (prefix.length > 2 && full.startsWith(prefix)) {
    return `--${full.slice(prefix.length)}`;
  }
  const idx = full.lastIndexOf('--');
  if (idx >= 0 && idx < full.length - 2) return full.slice(idx);
  return full.length > 18 ? full.slice(-18) : full;
}

function imageTagFromRevision(revisionBody) {
  const containers = revisionBody
    && revisionBody.properties
    && revisionBody.properties.template
    && Array.isArray(revisionBody.properties.template.containers)
    ? revisionBody.properties.template.containers
    : [];
  const image = trimString(containers[0] && containers[0].image);
  if (!image) return null;
  const digestAt = image.lastIndexOf('@');
  const bare = digestAt >= 0 ? image.slice(0, digestAt) : image;
  const colon = bare.lastIndexOf(':');
  if (colon < 0) return null;
  const tag = bare.slice(colon + 1);
  if (!tag) return null;
  if (/^[a-f0-9]{40}$/i.test(tag)) return tag.slice(0, 8).toLowerCase();
  return tag.length > 16 ? tag.slice(0, 16) : tag;
}

function normalizeCreatedTime(value) {
  const raw = trimString(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function createCrowsnestClientPortalDeployCollector(options = {}) {
  const transport = options.transport || options.fetch || options.fetchImpl;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(options.timeoutMs, 15000))
    : DEFAULT_TIMEOUT_MS;
  const runtime = options.runtimeConfig
    || resolvePortalDeployRuntimeConfig(options.env || process.env);
  const identity = options.identityConfig
    || resolveManagedIdentityEndpointConfig(options.env || process.env);

  const cache = new Map();
  const inFlight = new Map();

  async function acquireToken() {
    if (typeof transport !== 'function') return null;
    if (!runtime || runtime.ok !== true) return null;
    if (!identity || identity.ok !== true) return null;
    const tokenUrl = buildManagedIdentityTokenUrl(
      identity.identity_endpoint,
      runtime.config.managed_identity_client_id || '',
    );
    if (!tokenUrl) return null;
    const tokenResult = await timedJson(transport, tokenUrl, {
      method: 'GET',
      headers: { 'X-IDENTITY-HEADER': identity.identity_header },
    }, timeoutMs);
    if (!tokenResult.ok || !tokenResult.body || typeof tokenResult.body !== 'object') return null;
    const accessToken = trimString(tokenResult.body.access_token);
    return accessToken || null;
  }

  async function readSource(source, accessToken) {
    if (!accessToken) return emptyDeploy('identity_token_failed');
    const subscriptionId = runtime.config.subscription_id;
    const appUrl = buildArmContainerAppUrl(
      subscriptionId,
      source.resource_group,
      source.container_app,
    );
    const appResult = await timedJson(transport, appUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }, timeoutMs);
    if (!appResult.ok) return emptyDeploy('arm_app_read_failed');
    const revisionName = pickActiveRevisionName(appResult.body);
    if (!revisionName) return emptyDeploy('active_revision_missing');
    if (!revisionName.startsWith(`${source.container_app}--`)
        && revisionName !== source.container_app) {
      // Accept only revision names owned by the locked app.
      if (!revisionName.includes(source.container_app)) {
        return emptyDeploy('active_revision_mismatch');
      }
    }
    const revUrl = buildArmRevisionUrl(
      subscriptionId,
      source.resource_group,
      source.container_app,
      revisionName,
    );
    const revResult = await timedJson(transport, revUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }, timeoutMs);
    if (!revResult.ok) return emptyDeploy('arm_revision_read_failed');
    const updatedAt = normalizeCreatedTime(
      revResult.body
      && revResult.body.properties
      && revResult.body.properties.createdTime,
    );
    if (!updatedAt) return emptyDeploy('revision_created_time_missing');
    return Object.freeze({
      updated_at: updatedAt,
      revision: revisionName,
      revision_short: shortRevisionLabel(revisionName, source.container_app),
      image_tag: imageTagFromRevision(revResult.body),
      source_kind: 'azure_aca_revision',
      reason: 'active_revision_ok',
    });
  }

  async function readCached(source, accessToken) {
    const key = `${source.client}|${source.environment}|${source.container_app}`;
    const time = now();
    const cached = cache.get(key);
    if (cached && time >= cached.startedAt && time < cached.expiresAt) return cached.evidence;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = readSource(source, accessToken).then((evidence) => {
      cache.set(key, { startedAt: time, expiresAt: time + CACHE_TTL_MS, evidence });
      return evidence;
    }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, promise);
    return promise;
  }

  return async function collect(clients = []) {
    const result = {};
    for (const client of clients) {
      result[client.id] = {
        staging: emptyDeploy('source_not_admitted'),
        production: emptyDeploy('source_not_admitted'),
      };
    }

    if (typeof transport !== 'function') {
      for (const id of Object.keys(result)) {
        result[id].staging = emptyDeploy('transport_required');
        result[id].production = emptyDeploy('transport_required');
      }
      return result;
    }
    if (!runtime || runtime.ok !== true) {
      const reason = (runtime && runtime.code) || 'portal_deploy_config_absent';
      for (const id of Object.keys(result)) {
        result[id].staging = emptyDeploy(reason);
        result[id].production = emptyDeploy(reason);
      }
      return result;
    }
    if (!identity || identity.ok !== true) {
      const reason = (identity && identity.code) || 'managed_identity_endpoint_absent';
      for (const id of Object.keys(result)) {
        result[id].staging = emptyDeploy(reason);
        result[id].production = emptyDeploy(reason);
      }
      return result;
    }

    const jobs = [];
    for (const client of clients) {
      if (client.status !== 'Live') continue;
      for (const source of PORTAL_DEPLOY_SOURCES.filter(
        (item) => item.client === client.id && item.slug === client.client_slug,
      )) {
        if (!(client.environments || []).some((row) => row.kind === 'staff_portal'
            && row.url === source.origin)) continue;
        jobs.push({ source, clientId: client.id });
      }
    }

    if (!jobs.length) return result;

    const accessToken = await acquireToken();
    const collected = await Promise.all(
      jobs.map(async ({ source, clientId }) => ({
        source,
        clientId,
        evidence: await readCached(source, accessToken),
      })),
    );
    for (const item of collected) {
      result[item.clientId][item.source.environment] = item.evidence;
    }
    return result;
  };
}

function mergePortalDeployIntoEvidence(portalEvidence, deployEvidence) {
  if (!portalEvidence || typeof portalEvidence !== 'object') return portalEvidence;
  if (!deployEvidence || typeof deployEvidence !== 'object') return portalEvidence;
  for (const clientId of Object.keys(deployEvidence)) {
    const byEnv = deployEvidence[clientId];
    if (!byEnv || typeof byEnv !== 'object') continue;
    if (!portalEvidence[clientId] || typeof portalEvidence[clientId] !== 'object') {
      portalEvidence[clientId] = {};
    }
    for (const environment of ['staging', 'production']) {
      const deploy = byEnv[environment];
      const row = portalEvidence[clientId][environment];
      const base = row && typeof row === 'object' ? { ...row } : {
        availability: 'unknown',
        checked_at: null,
        source_kind: 'none',
        reason: 'source_not_admitted',
      };
      base.deploy_updated_at = deploy && deploy.updated_at ? deploy.updated_at : null;
      base.deploy_revision = deploy && deploy.revision ? deploy.revision : null;
      base.deploy_revision_short = deploy && deploy.revision_short ? deploy.revision_short : null;
      base.deploy_image_tag = deploy && deploy.image_tag ? deploy.image_tag : null;
      base.deploy_source_kind = deploy && deploy.source_kind ? deploy.source_kind : 'none';
      base.deploy_reason = deploy && deploy.reason ? deploy.reason : 'source_not_admitted';
      portalEvidence[clientId][environment] = Object.freeze(base);
    }
  }
  return portalEvidence;
}

module.exports = {
  PORTAL_DEPLOY_SOURCES,
  resolvePortalDeployRuntimeConfig,
  resolveManagedIdentityEndpointConfig,
  createCrowsnestClientPortalDeployCollector,
  mergePortalDeployIntoEvidence,
  shortRevisionLabel,
  pickActiveRevisionName,
  imageTagFromRevision,
  buildArmContainerAppUrl,
  buildArmRevisionUrl,
  buildManagedIdentityTokenUrl,
};
