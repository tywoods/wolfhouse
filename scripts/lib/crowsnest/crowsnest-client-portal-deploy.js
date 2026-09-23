'use strict';

/**
 * Staff portal deploy stamps for Crow's Nest Clients.
 *
 * Skipper (or deploy scripts) POST/PUT a stamp after each successful Staff
 * staging/prod deploy. Clients renders "Updated … ago · --rev" from the stored
 * stamp. No Azure Container Apps Reader / ARM revision APIs.
 *
 * - Admitted portals only (exact client + environment + origin locks)
 * - Memory store by default; optional JSON file via CROWSNEST_PORTAL_DEPLOY_STAMP_PATH
 * - Fail soft: missing stamp => null deploy_* fields (no Updated line)
 */

const fs = require('fs');
const path = require('path');

const STAMP_TOKEN_ENV = 'CROWSNEST_PORTAL_DEPLOY_STAMP_TOKEN';
const STAMP_PATH_ENV = 'CROWSNEST_PORTAL_DEPLOY_STAMP_PATH';
const STAMP_SOURCE_KIND = 'deploy_stamp';

// Locked to measured public Staff portal origins. Azure RG/app names are not
// required — stamps are written by deploy scripts, not read from ACA.
const PORTAL_DEPLOY_SOURCES = Object.freeze([
  Object.freeze({
    client: 'wolfhouse-somo',
    slug: 'wolfhouse-somo',
    environment: 'staging',
    origin: 'https://staff-staging.lunafrontdesk.com',
  }),
  Object.freeze({
    client: 'sunset-somo',
    slug: 'sunset',
    environment: 'staging',
    origin: 'https://sunset-staging.lunafrontdesk.com',
  }),
  Object.freeze({
    client: 'wolfhouse-somo',
    slug: 'wolfhouse-somo',
    environment: 'production',
    origin: 'https://wolfhouse.lunafrontdesk.com',
  }),
  Object.freeze({
    client: 'sunset-somo',
    slug: 'sunset',
    environment: 'production',
    origin: 'https://sunset.lunafrontdesk.com',
  }),
]);

function trimString(value) {
  return value == null ? '' : String(value).trim();
}

function stampKey(client, environment) {
  return `${trimString(client)}|${trimString(environment)}`;
}

function emptyDeploy(reason = 'stamp_absent') {
  return Object.freeze({
    updated_at: null,
    revision: null,
    revision_short: null,
    image_tag: null,
    source_kind: 'none',
    reason,
  });
}

function findAdmittedSource(client, environment) {
  const c = trimString(client);
  const e = trimString(environment);
  return PORTAL_DEPLOY_SOURCES.find((row) => row.client === c && row.environment === e) || null;
}

/**
 * Normalize a short display revision for the Clients "· --rev" suffix.
 * Accepts full ACA revision names, short "--0000525", or git SHAs.
 */
function shortRevisionLabel(revision, _containerApp) {
  const full = trimString(revision);
  if (!full) return null;
  if (/^--[A-Za-z0-9._-]{1,32}$/.test(full)) return full;
  if (/^[a-f0-9]{40}$/i.test(full)) return full.slice(0, 7).toLowerCase();
  if (/^[a-f0-9]{7,12}$/i.test(full)) return full.toLowerCase();
  const idx = full.lastIndexOf('--');
  if (idx >= 0 && idx < full.length - 2) {
    const tail = full.slice(idx);
    return tail.length > 18 ? tail.slice(0, 18) : tail;
  }
  return full.length > 18 ? full.slice(0, 18) : full;
}

function normalizeUpdatedAt(value, nowMs) {
  const raw = trimString(value);
  if (!raw) {
    return new Date(nowMs).toISOString();
  }
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  if (time > nowMs + 60_000) return null; // reject far-future stamps
  return new Date(time).toISOString();
}

function validateStampInput(input, options = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['body_must_be_object'] };
  }
  const client = trimString(input.client);
  const environment = trimString(input.environment);
  if (!client) errors.push('client_required');
  if (environment !== 'staging' && environment !== 'production') {
    errors.push('environment_must_be_staging_or_production');
  }
  const source = findAdmittedSource(client, environment);
  if (client && (environment === 'staging' || environment === 'production') && !source) {
    errors.push('portal_not_admitted');
  }
  const revisionRaw = trimString(input.revision || input.revision_short || input.rev);
  if (!revisionRaw) errors.push('revision_required');
  if (revisionRaw.length > 128) errors.push('revision_too_long');
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const updatedAt = normalizeUpdatedAt(input.updated_at, nowMs);
  if (input.updated_at != null && input.updated_at !== '' && !updatedAt) {
    errors.push('updated_at_invalid');
  }
  if (errors.length) return { ok: false, errors };

  const revisionShort = shortRevisionLabel(revisionRaw);
  return {
    ok: true,
    stamp: Object.freeze({
      client,
      environment,
      origin: source.origin,
      updated_at: updatedAt,
      revision: revisionRaw,
      revision_short: revisionShort,
      image_tag: trimString(input.image_tag) || null,
      source_kind: STAMP_SOURCE_KIND,
      reason: 'stamp_ok',
      stamped_at: new Date(nowMs).toISOString(),
    }),
  };
}

function stampToDeployEvidence(stamp) {
  if (!stamp) return emptyDeploy('stamp_absent');
  return Object.freeze({
    updated_at: stamp.updated_at || null,
    revision: stamp.revision || null,
    revision_short: stamp.revision_short || null,
    image_tag: stamp.image_tag || null,
    source_kind: stamp.source_kind || STAMP_SOURCE_KIND,
    reason: stamp.reason || 'stamp_ok',
  });
}

function readStampFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const map = new Map();
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const client = trimString(value.client);
      const environment = trimString(value.environment);
      if (!findAdmittedSource(client, environment)) continue;
      if (!value.updated_at || !value.revision) continue;
      map.set(key || stampKey(client, environment), Object.freeze({ ...value }));
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeStampFile(filePath, map) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const obj = {};
  for (const [key, value] of map.entries()) {
    obj[key] = value;
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function createPortalDeployStampStore(options = {}) {
  const env = options.env || process.env;
  const filePath = trimString(options.filePath || env[STAMP_PATH_ENV]);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const map = filePath ? readStampFile(filePath) : new Map();

  // Optional in-process seed (tests / one-shot operator seed).
  if (Array.isArray(options.seed)) {
    for (const row of options.seed) {
      const validated = validateStampInput(row, { now });
      if (validated.ok) {
        map.set(stampKey(validated.stamp.client, validated.stamp.environment), validated.stamp);
      }
    }
  }

  function persist() {
    if (!filePath) return;
    try {
      writeStampFile(filePath, map);
    } catch {
      // Fail soft on disk errors — in-memory stamp still serves this process.
    }
  }

  return {
    backend: filePath ? 'file' : 'memory',
    filePath: filePath || null,

    putStamp(input) {
      const validated = validateStampInput(input, { now });
      if (!validated.ok) {
        return { ok: false, code: 'invalid_stamp', errors: validated.errors };
      }
      const key = stampKey(validated.stamp.client, validated.stamp.environment);
      map.set(key, validated.stamp);
      persist();
      return { ok: true, stamp: validated.stamp };
    },

    getStamp(client, environment) {
      return map.get(stampKey(client, environment)) || null;
    },

    listStamps() {
      return [...map.values()];
    },

    collectForClients(clients = []) {
      const result = {};
      for (const client of clients) {
        result[client.id] = {
          staging: emptyDeploy('stamp_absent'),
          production: emptyDeploy('stamp_absent'),
        };
      }
      for (const client of clients) {
        if (!result[client.id]) continue;
        for (const environment of ['staging', 'production']) {
          const source = PORTAL_DEPLOY_SOURCES.find(
            (item) => item.client === client.id
              && item.slug === client.client_slug
              && item.environment === environment,
          );
          if (!source) continue;
          if (client.status !== 'Live') {
            result[client.id][environment] = emptyDeploy('client_not_live');
            continue;
          }
          if (!(client.environments || []).some((row) => row.kind === 'staff_portal'
              && row.url === source.origin)) {
            result[client.id][environment] = emptyDeploy('origin_not_in_directory');
            continue;
          }
          result[client.id][environment] = stampToDeployEvidence(
            map.get(stampKey(client.id, environment)),
          );
        }
      }
      return result;
    },

    _reset() {
      map.clear();
      if (filePath) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    },
  };
}

let defaultStore = null;

function getPortalDeployStampStore(options = {}) {
  if (options.store) return options.store;
  if (options.fresh || !defaultStore) {
    defaultStore = createPortalDeployStampStore(options);
  }
  return defaultStore;
}

function _resetPortalDeployStampStoreForTests() {
  if (defaultStore && typeof defaultStore._reset === 'function') defaultStore._reset();
  defaultStore = null;
}

/**
 * Collector used by GET /clients — reads stored stamps only (no Azure).
 */
function createCrowsnestClientPortalDeployCollector(options = {}) {
  const store = getPortalDeployStampStore(options);
  return async function collect(clients = []) {
    try {
      return store.collectForClients(clients);
    } catch {
      const result = {};
      for (const client of clients) {
        result[client.id] = {
          staging: emptyDeploy('stamp_read_failed'),
          production: emptyDeploy('stamp_read_failed'),
        };
      }
      return result;
    }
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
      base.deploy_reason = deploy && deploy.reason ? deploy.reason : 'stamp_absent';
      portalEvidence[clientId][environment] = Object.freeze(base);
    }
  }
  return portalEvidence;
}

module.exports = {
  STAMP_TOKEN_ENV,
  STAMP_PATH_ENV,
  STAMP_SOURCE_KIND,
  PORTAL_DEPLOY_SOURCES,
  shortRevisionLabel,
  validateStampInput,
  createPortalDeployStampStore,
  getPortalDeployStampStore,
  _resetPortalDeployStampStoreForTests,
  createCrowsnestClientPortalDeployCollector,
  mergePortalDeployIntoEvidence,
  emptyDeploy,
  findAdmittedSource,
};
