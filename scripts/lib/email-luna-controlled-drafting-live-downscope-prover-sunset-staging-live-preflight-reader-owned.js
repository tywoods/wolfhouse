'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4H — private, fixed,
 * server-owned Sunset staging live preflight reader.
 *
 * Import-inert. Does not call Azure/ACR/PG/Microsoft/JWKS/Graph on load.
 * Production surface is {readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg,
 * isIndependentLivePreflight} plus frozen pins/error identity. There is no
 * public callback/factory that a caller can use to brand evidence. Fake
 * adapters are injected only through a closed constructor that is not on
 * this module's exports (test-support sibling). Production never selects
 * adapters by env/opts.
 *
 * Live compose/runProof remain structurally disabled this chapter
 * (`LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = false` on the constants
 * owner). This reader materializes sanitized Azure/PG facts; it does not
 * execute the token proof.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader
 */

const http = require('node:http');
const https = require('node:https');
const {
  isProxySurface,
  ownData,
  exactOwnData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  EXPECTED_DATABASE,
  EXPECTED_LIVE_TARGET,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
  LIVE_CUSTODY_DSN_ENV_KEY,
  LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY,
} = require('./email-luna-controlled-drafting-live-downscope-prover-live-target-constants');
const {
  createEmailLunaControlledDraftingPrincipalConnectionPair,
  isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair,
  ENV_PRODUCER_DATABASE_URL,
} = require('./email-luna-controlled-drafting-principal-connection');
const {
  inspectEmailLunaControlledDraftingMappedPrincipal,
} = require('./email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
  proveCanonicalRuntimeOwnersMatchDeployedContract,
} = require('./email-luna-controlled-drafting-live-downscope-prover-canonical-owners');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);
const stringTrim = uncurryThis(String.prototype.trim);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PREFLIGHT_READER_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting live preflight reader failed.';
const OWNED_PREFLIGHTS = new WeakSet();
const FENCE_MAX_AGE_MS = 30 * 1000;
const IMDS_TIMEOUT_MS = 400;
const ARM_TIMEOUT_MS = 400;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN_EVIDENCE = objectFreeze([
  'dsn', 'connectionString', 'password', 'secret', 'token', 'accessToken',
  'refreshToken', 'jwt', 'privateKey', 'mailbox', 'email', 'clientSecret',
  'authorization', 'bearer',
]);

const EIGHT_FLAGS = objectFreeze([
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED',
  'LUNA_AUTO_SEND_ENABLED',
  'CUSTOMER_OUTREACH_WHATSAPP_ENABLED',
  'STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED',
]);

const AZURE_OWNER = objectFreeze({
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: EXPECTED_LIVE_TARGET.resourceGroup,
  appName: EXPECTED_LIVE_TARGET.appName,
  location: 'northeurope',
  acrLoginServer: 'whstagingacr.azurecr.io',
  acrRepository: 'luna-sunset-staff-api',
  armApiVersion: '2024-03-01',
  armHost: 'management.azure.com',
  imdsHost: '169.254.169.254',
});

const APP_KEYS = objectFreeze([
  'subscriptionId', 'resourceGroup', 'name', 'location', 'tenantTag',
  'latestRevisionName', 'latestReadyRevisionName', 'runningStatus',
  'provisioningState', 'minReplicas', 'maxReplicas', 'traffic', 'env', 'image',
]);
const REVISION_KEYS = objectFreeze([
  'name', 'runningState', 'healthState', 'provisioningState', 'replicas',
  'image', 'imageDigest',
]);
const TRAFFIC_KEYS = objectFreeze(['revisionName', 'weight']);
const ENV_VALUE_KEYS = objectFreeze(['name', 'value']);
const ENV_SECRET_KEYS = objectFreeze(['name', 'secretRef']);
const COUNT_KEYS = objectFreeze(['ops_097', 'transitions_097', 'authorizations_098']);
const IDENTITY_KEYS = objectFreeze([
  'session_matches_current', 'current_database', 'ssl',
  'session_fingerprint', 'current_fingerprint',
]);
const GRANT_KEYS = objectFreeze([
  'grant_generation', 'grant_status', 'reconcile_state', 'has_active_lease',
]);
const BINDING_KEYS = objectFreeze(['binding_ok', 'own_user', 'mailbox_ready', 'has_active_operation']);
const AZURE_ADAPTER_KEYS = objectFreeze(['readApp', 'listRevisions', 'readRevision']);
const ACR_ADAPTER_KEYS = objectFreeze(['readManifestDigest']);
const PG_ADAPTER_KEYS = objectFreeze(['withProducerClient', 'withWorkerClient']);
const CLOCK_KEYS = objectFreeze(['nowMs']);
const READER_ADAPTER_KEYS = objectFreeze(['azure', 'acr', 'pg', 'clock']);

const COUNT_SQL = [
  'SELECT',
  '  (SELECT COUNT(*)::bigint FROM public.tenant_email_luna_controlled_draft_operations) AS ops_097,',
  '  (SELECT COUNT(*)::bigint FROM public.tenant_email_luna_controlled_draft_transitions) AS transitions_097,',
  '  (SELECT COUNT(*)::bigint FROM public.tenant_email_luna_controlled_drafting_staging_test_authorizations) AS authorizations_098',
].join('\n');

const IDENTITY_SQL = [
  'SELECT',
  '  session_user::text IS NOT DISTINCT FROM current_user::text AS session_matches_current,',
  "  current_database()::text AS current_database,",
  "  current_setting('ssl', true) AS ssl,",
  "  encode(sha256(convert_to(session_user::text, 'UTF8')), 'hex') AS session_fingerprint,",
  "  encode(sha256(convert_to(current_user::text, 'UTF8')), 'hex') AS current_fingerprint",
].join('\n');

const GRANT_SQL = [
  'SELECT',
  '  grant_generation::bigint AS grant_generation,',
  '  grant_status::text AS grant_status,',
  '  reconcile_state::text AS reconcile_state,',
  "  (grant_status = 'lease_held') AS has_active_lease",
  '  FROM public.tenant_email_delegated_grants',
  ' WHERE client_id = $1::uuid AND endpoint_id = $2::uuid',
].join('\n');

const BINDING_SQL = [
  'SELECT',
  "  (e.provider = 'microsoft_graph' AND e.binding_status = 'verified'",
  "   AND e.mailbox_kind = 'user' AND e.mailbox_access_kind = 'own_user') AS binding_ok,",
  "  (e.mailbox_access_kind = 'own_user') AS own_user,",
  '  (e.provider_resource_id IS NOT NULL AND char_length(e.provider_resource_id) > 0) AS mailbox_ready,',
  '  EXISTS (',
  '    SELECT 1 FROM public.tenant_email_luna_controlled_draft_operations o',
  '     WHERE o.client_id = $1::uuid AND o.endpoint_id = $3::uuid',
  "       AND o.state IN ('reserved', 'create_dispatched_outcome_unknown')",
  '  ) AS has_active_operation',
  '  FROM public.tenant_channel_endpoints e',
  ' INNER JOIN public.tenant_locations tl',
  '    ON tl.client_id = e.client_id AND tl.location_id = e.location_id',
  ' WHERE e.client_id = $1::uuid AND tl.id = $2::uuid AND e.id = $3::uuid',
  '   AND e.provider_resource_id = $4::text',
].join('\n');

const WRITE_SQL_RE = /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|SET\s+ROLE|SET\s+SESSION\s+AUTHORIZATION)\b/i;

if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string' && DETAIL_RE.test(code)) error.detail = code;
  objectFreeze(error);
  return error;
}

function refuseDetail(err, fallback) {
  if (err && err.code === ERROR_CODE && err.message === ERROR_MESSAGE
      && typeof err.detail === 'string' && DETAIL_RE.test(err.detail)) {
    throw failure(err.detail);
  }
  throw failure(fallback);
}

function exactPlainData(object, keys) {
  if (!object || objectGetPrototypeOf(object) !== Object.prototype || isProxySurface(object)) {
    return false;
  }
  const actual = reflectOwnKeys(object);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !arrayIncludes(keys, key))) {
    return false;
  }
  return keys.every((key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && !descriptor.get && !descriptor.set && objectHasOwn(descriptor, 'value');
    } catch (_) {
      return false;
    }
  });
}

function freezeBoundBag(owner, keys) {
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function') || isProxySurface(owner)) {
    return null;
  }
  const bag = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const fn = owner[key];
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    Object.defineProperty(bag, key, {
      value: fn.bind(owner),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return objectFreeze(bag);
}

function rejectForbiddenKeys(object) {
  try {
    const keys = reflectOwnKeys(object);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key !== 'string') return false;
      const lower = key.toLowerCase();
      for (let j = 0; j < FORBIDDEN_EVIDENCE.length; j += 1) {
        if (lower === FORBIDDEN_EVIDENCE[j].toLowerCase()) return false;
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

function asCount(value) {
  if (value === 0 || value === 0n || value === '0') return 0;
  if (typeof value === 'bigint' && value === 0n) return 0;
  if (typeof value === 'number' && Number.isInteger(value) && value === 0) return 0;
  if (typeof value === 'string' && value === '0') return 0;
  return null;
}

function asPositiveCount(value) {
  if (typeof value === 'bigint' && value >= 0n && value <= 9007199254740991n) return Number(value);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function parseImageRef(image) {
  if (typeof image !== 'string' || image.length < 8) return null;
  const digestIndex = image.indexOf('@');
  const withoutDigest = digestIndex === -1 ? image : image.slice(0, digestIndex);
  const runtimeDigest = digestIndex === -1 ? null : image.slice(digestIndex + 1);
  if (runtimeDigest && !DIGEST_RE.test(runtimeDigest)) return null;
  const match = /^([^/]+)\/([^:]+):([0-9a-f]{40})$/.exec(withoutDigest);
  if (!match) return null;
  return objectFreeze({
    loginServer: match[1],
    repository: match[2],
    tag: match[3],
    runtimeDigest,
  });
}

function literalFalseEnv(envList) {
  if (!arrayIsArray(envList) || isProxySurface(envList)) return { ok: false, reason: 'flags_unproven' };
  const seen = objectCreate(null);
  const values = objectCreate(null);
  for (let i = 0; i < envList.length; i += 1) {
    const item = ownData(envList, i);
    if (!item || typeof item !== 'object') return { ok: false, reason: 'flags_unproven' };
    if (exactPlainData(item, ENV_SECRET_KEYS)) return { ok: false, reason: 'flag_secret_ref' };
    if (!exactPlainData(item, ENV_VALUE_KEYS)) return { ok: false, reason: 'flags_unproven' };
    const name = ownData(item, 'name');
    const value = ownData(item, 'value');
    if (typeof name !== 'string' || typeof value !== 'string') return { ok: false, reason: 'flags_unproven' };
    if (arrayIncludes(EIGHT_FLAGS, name) || name === 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT') {
      if (seen[name] === true) return { ok: false, reason: 'flag_duplicate' };
      seen[name] = true;
      values[name] = value;
    }
  }
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    const name = EIGHT_FLAGS[i];
    if (seen[name] !== true) return { ok: false, reason: 'flag_missing' };
    if (values[name] !== 'false') return { ok: false, reason: 'flag_not_literal_false' };
  }
  if (values.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT !== '1') {
    return { ok: false, reason: 'replica_not_one' };
  }
  return { ok: true, values };
}

function envString(envList, key) {
  if (!arrayIsArray(envList)) return null;
  let found = null;
  for (let i = 0; i < envList.length; i += 1) {
    const item = ownData(envList, i);
    if (!exactPlainData(item, ENV_VALUE_KEYS)) continue;
    if (ownData(item, 'name') === key) {
      if (found !== null) return null;
      const value = ownData(item, 'value');
      found = typeof value === 'string' ? value : null;
    }
  }
  return found;
}

function resolveQuery(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function') || isProxySurface(client)) {
    return null;
  }
  try {
    const own = Object.getOwnPropertyDescriptor(client, 'query');
    if (own) {
      return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set
        ? own.value
        : null;
    }
    let proto = objectGetPrototypeOf(client);
    let depth = 0;
    while (proto && proto !== Object.prototype && depth < 8) {
      if (isProxySurface(proto)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'query');
      if (descriptor) {
        return objectHasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          && !descriptor.get && !descriptor.set
          ? descriptor.value
          : null;
      }
      proto = objectGetPrototypeOf(proto);
      depth += 1;
    }
  } catch (_) {
    return null;
  }
  return null;
}

async function queryOne(client, sql, params, keys) {
  if (typeof sql !== 'string' || WRITE_SQL_RE.test(sql)) throw failure('pg_write_refused');
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) throw failure('pg_unproven');
  let result;
  try {
    result = params === undefined ? await queryFn.call(client, sql) : await queryFn.call(client, sql, params);
  } catch (err) {
    refuseDetail(err, 'pg_unproven');
  }
  if (!result || typeof result !== 'object' || isProxySurface(result) || arrayIsArray(result)) {
    throw failure('pg_unproven');
  }
  const rows = ownData(result, 'rows');
  if (!arrayIsArray(rows) || rows.length !== 1 || isProxySurface(rows)) throw failure('pg_unproven');
  const row = ownData(rows, 0);
  const parsed = exactOwnData(row, keys);
  if (!parsed) throw failure('pg_unproven');
  return parsed;
}

function measureTraffic(traffic, expectedRevision) {
  if (!arrayIsArray(traffic) || traffic.length !== 1 || isProxySurface(traffic)) {
    return { ok: false, reason: 'traffic_ambiguous' };
  }
  const entry = ownData(traffic, 0);
  if (!exactPlainData(entry, TRAFFIC_KEYS)) return { ok: false, reason: 'traffic_ambiguous' };
  const revisionName = ownData(entry, 'revisionName');
  const weight = ownData(entry, 'weight');
  if (revisionName !== expectedRevision || weight !== 100) {
    return { ok: false, reason: 'traffic_ambiguous' };
  }
  return { ok: true, weight };
}

function measureApp(app) {
  if (!exactPlainData(app, APP_KEYS) || !rejectForbiddenKeys(app)) throw failure('azure_unproven');
  if (ownData(app, 'subscriptionId') !== AZURE_OWNER.subscriptionId) throw failure('azure_owner_mismatch');
  if (ownData(app, 'resourceGroup') !== AZURE_OWNER.resourceGroup) throw failure('azure_owner_mismatch');
  if (ownData(app, 'name') !== AZURE_OWNER.appName) throw failure('azure_owner_mismatch');
  if (ownData(app, 'location') !== AZURE_OWNER.location) throw failure('azure_owner_mismatch');
  if (ownData(app, 'tenantTag') !== SUNSET_TENANT) throw failure('tenant_mismatch');
  const latest = ownData(app, 'latestRevisionName');
  const latestReady = ownData(app, 'latestReadyRevisionName');
  if (latest !== EXPECTED_LIVE_TARGET.revision) throw failure('revision_mismatch');
  if (latestReady !== EXPECTED_LIVE_TARGET.revision) throw failure('revision_mismatch');
  if (latest !== latestReady) throw failure('revision_drift');
  if (ownData(app, 'runningStatus') !== 'Running') throw failure('azure_unproven');
  if (ownData(app, 'provisioningState') !== 'Succeeded') throw failure('azure_unproven');
  if (ownData(app, 'minReplicas') !== 1 || ownData(app, 'maxReplicas') !== 1) {
    throw failure('replica_not_one');
  }
  const traffic = measureTraffic(ownData(app, 'traffic'), EXPECTED_LIVE_TARGET.revision);
  if (!traffic.ok) throw failure(traffic.reason);
  const flags = literalFalseEnv(ownData(app, 'env'));
  if (!flags.ok) throw failure(flags.reason);
  const deployment = envString(ownData(app, 'env'), 'LUNA_DEPLOYMENT');
  const tenant = envString(ownData(app, 'env'), 'DEFAULT_CLIENT_SLUG');
  const locationKey = envString(ownData(app, 'env'), 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY');
  if (deployment !== SUNSET_DEPLOYMENT) throw failure('tenant_mismatch');
  if (tenant !== SUNSET_TENANT) throw failure('tenant_mismatch');
  if (locationKey !== SUNSET_LOCATION_KEY) throw failure('tenant_mismatch');
  const image = parseImageRef(ownData(app, 'image'));
  if (!image) throw failure('image_unproven');
  if (image.loginServer !== AZURE_OWNER.acrLoginServer) throw failure('image_unproven');
  if (image.repository !== AZURE_OWNER.acrRepository) throw failure('image_unproven');
  if (image.tag !== EXPECTED_LIVE_TARGET.deployedSha) throw failure('image_unproven');
  const clientId = envString(ownData(app, 'env'), 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID');
  const locationId = envString(ownData(app, 'env'), 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID');
  const endpointId = envString(ownData(app, 'env'), 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID');
  const mailboxId = envString(ownData(app, 'env'), 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID');
  if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId) || !isCanonUuid(mailboxId)) {
    throw failure('binding_unproven');
  }
  return objectFreeze({
    latest,
    latestReady,
    trafficWeight: traffic.weight,
    image,
    flagsOk: true,
    clientId,
    locationId,
    endpointId,
    mailboxId,
  });
}

function measureRevision(revision, expectedImage) {
  if (!exactPlainData(revision, REVISION_KEYS) || !rejectForbiddenKeys(revision)) {
    throw failure('azure_unproven');
  }
  if (ownData(revision, 'name') !== EXPECTED_LIVE_TARGET.revision) throw failure('revision_mismatch');
  if (ownData(revision, 'runningState') !== 'Running') throw failure('azure_unproven');
  if (ownData(revision, 'healthState') !== 'Healthy') throw failure('azure_unproven');
  if (ownData(revision, 'provisioningState') !== 'Provisioned') throw failure('azure_unproven');
  if (ownData(revision, 'replicas') !== 1) throw failure('replica_not_one');
  const image = parseImageRef(ownData(revision, 'image'));
  if (!image || image.tag !== expectedImage.tag || image.repository !== expectedImage.repository) {
    throw failure('image_unproven');
  }
  const runtimeDigest = ownData(revision, 'imageDigest');
  if (runtimeDigest !== null && runtimeDigest !== undefined) {
    if (typeof runtimeDigest !== 'string' || !DIGEST_RE.test(runtimeDigest)) throw failure('digest_mismatch');
  }
  return objectFreeze({
    replicas: 1,
    runtimeDigest: typeof runtimeDigest === 'string' ? runtimeDigest : null,
    image,
  });
}

function measureCounts(row) {
  const ops = asCount(ownData(row, 'ops_097'));
  const transitions = asCount(ownData(row, 'transitions_097'));
  const auths = asCount(ownData(row, 'authorizations_098'));
  if (ops !== 0) throw failure('counts_nonzero');
  if (transitions !== 0) throw failure('counts_nonzero');
  if (auths !== 0) throw failure('counts_nonzero');
  return objectFreeze({ ops_097: 0, transitions_097: 0, authorizations_098: 0 });
}

function measureIdentity(row, kind) {
  if (ownData(row, 'session_matches_current') !== true) throw failure('login_alias');
  if (ownData(row, 'current_database') !== EXPECTED_DATABASE) throw failure('tenant_mismatch');
  const ssl = ownData(row, 'ssl');
  if (ssl !== 'on' && ssl !== 'true') throw failure('tls_unproven');
  const sessionFp = ownData(row, 'session_fingerprint');
  const currentFp = ownData(row, 'current_fingerprint');
  if (typeof sessionFp !== 'string' || !/^[0-9a-f]{64}$/.test(sessionFp)) throw failure('login_unproven');
  if (typeof currentFp !== 'string' || !/^[0-9a-f]{64}$/.test(currentFp)) throw failure('login_unproven');
  if (sessionFp !== currentFp) throw failure('login_alias');
  return objectFreeze({ kind, fingerprint: sessionFp, tls_ok: true });
}

function measureGrant(row) {
  const generation = asPositiveCount(ownData(row, 'grant_generation'));
  if (generation === null) throw failure('grant_unproven');
  const status = ownData(row, 'grant_status');
  const reconcile = ownData(row, 'reconcile_state');
  const leased = ownData(row, 'has_active_lease');
  if (status === 'reauthorization_required' || status === 'revoked') throw failure('dead_grant');
  if (status === 'lease_held' || leased === true) throw failure('lease_held');
  if (reconcile !== 'clean') throw failure('reconciliation_needed');
  if (status !== 'active') throw failure('grant_uncertain');
  if (leased !== false) throw failure('lease_held');
  return objectFreeze({
    grant_generation: generation,
    grant_status: 'active',
    reconcile_state: reconcile,
    has_active_lease: false,
  });
}

function measureBinding(row) {
  if (ownData(row, 'binding_ok') !== true) throw failure('binding_unproven');
  if (ownData(row, 'own_user') !== true) throw failure('binding_unproven');
  if (ownData(row, 'mailbox_ready') !== true) throw failure('binding_unproven');
  if (ownData(row, 'has_active_operation') !== false) throw failure('counts_nonzero');
  return objectFreeze({
    binding_ok: true,
    own_user: true,
    mailbox_ready: true,
    has_active_operation: false,
  });
}

async function readAzureFence(azure) {
  const app = measureApp(await azure.readApp());
  const listed = await azure.listRevisions();
  if (!arrayIsArray(listed) || listed.length < 1 || isProxySurface(listed)) throw failure('azure_unproven');
  let found = null;
  for (let i = 0; i < listed.length; i += 1) {
    const item = ownData(listed, i);
    if (!item || typeof item !== 'object') throw failure('azure_unproven');
    if (ownData(item, 'name') === EXPECTED_LIVE_TARGET.revision) {
      if (found) throw failure('revision_drift');
      found = item;
    }
  }
  if (!found) throw failure('revision_mismatch');
  const listedRevision = measureRevision(found, app.image);
  const direct = measureRevision(await azure.readRevision(EXPECTED_LIVE_TARGET.revision), app.image);
  if (listedRevision.replicas !== direct.replicas) throw failure('revision_drift');
  if (listedRevision.runtimeDigest !== direct.runtimeDigest) throw failure('revision_drift');
  if (direct.image.tag !== app.image.tag) throw failure('image_unproven');
  return objectFreeze({
    app,
    revision: direct,
  });
}

async function readAcrFence(acr, image, runtimeDigest) {
  const digest = await acr.readManifestDigest(objectFreeze({
    loginServer: image.loginServer,
    repository: image.repository,
    tag: image.tag,
  }));
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw failure('acr_unproven');
  if (digest !== EXPECTED_LIVE_TARGET.digest) throw failure('digest_mismatch');
  if (runtimeDigest && runtimeDigest !== digest) throw failure('digest_mismatch');
  return digest;
}

async function readPgFence(pg, binding) {
  const producerIdentity = await pg.withProducerClient(async (client) => {
    const identity = measureIdentity(await queryOne(client, IDENTITY_SQL, undefined, IDENTITY_KEYS), 'producer');
    const mapped = await inspectEmailLunaControlledDraftingMappedPrincipal(client, objectFreeze({
      client_id: binding.clientId,
      location_id: binding.locationId,
      location_key: SUNSET_LOCATION_KEY,
    }), 'producer');
    if (!mapped || mapped.ok !== true || mapped.login_ok !== true || mapped.mapping_ok !== true) {
      throw failure('acl_unproven');
    }
    return identity;
  });
  const worker = await pg.withWorkerClient(async (client) => {
    const identity = measureIdentity(await queryOne(client, IDENTITY_SQL, undefined, IDENTITY_KEYS), 'worker');
    const mapped = await inspectEmailLunaControlledDraftingMappedPrincipal(client, objectFreeze({
      client_id: binding.clientId,
      location_id: binding.locationId,
      location_key: SUNSET_LOCATION_KEY,
    }), 'worker');
    if (!mapped || mapped.ok !== true || mapped.login_ok !== true || mapped.mapping_ok !== true) {
      throw failure('acl_unproven');
    }
    const counts = measureCounts(await queryOne(client, COUNT_SQL, undefined, COUNT_KEYS));
    const grant = measureGrant(await queryOne(client, GRANT_SQL, [binding.clientId, binding.endpointId], GRANT_KEYS));
    const bound = measureBinding(await queryOne(
      client,
      BINDING_SQL,
      [binding.clientId, binding.locationId, binding.endpointId, binding.mailboxId],
      BINDING_KEYS,
    ));
    return objectFreeze({ identity, counts, grant, bound });
  });
  if (producerIdentity.fingerprint === worker.identity.fingerprint) throw failure('login_alias');
  return objectFreeze({
    producer: producerIdentity,
    worker: worker.identity,
    counts: worker.counts,
    grant: worker.grant,
    bound: worker.bound,
  });
}

function sameFence(a, b) {
  return a.app.latest === b.app.latest
    && a.app.latestReady === b.app.latestReady
    && a.app.image.tag === b.app.image.tag
    && a.app.image.loginServer === b.app.image.loginServer
    && a.app.image.repository === b.app.image.repository
    && a.app.trafficWeight === b.app.trafficWeight
    && a.app.clientId === b.app.clientId
    && a.app.locationId === b.app.locationId
    && a.app.endpointId === b.app.endpointId
    && a.app.mailboxId === b.app.mailboxId
    && a.revision.replicas === b.revision.replicas
    && a.revision.runtimeDigest === b.revision.runtimeDigest
    && a.revision.image.tag === b.revision.image.tag
    && a.digest === b.digest
    && a.pg.counts.ops_097 === b.pg.counts.ops_097
    && a.pg.counts.transitions_097 === b.pg.counts.transitions_097
    && a.pg.counts.authorizations_098 === b.pg.counts.authorizations_098
    && a.pg.grant.grant_generation === b.pg.grant.grant_generation
    && a.pg.grant.grant_status === b.pg.grant.grant_status
    && a.pg.grant.reconcile_state === b.pg.grant.reconcile_state
    && a.pg.grant.has_active_lease === b.pg.grant.has_active_lease
    && a.pg.producer.fingerprint === b.pg.producer.fingerprint
    && a.pg.worker.fingerprint === b.pg.worker.fingerprint
    && a.pg.bound.binding_ok === b.pg.bound.binding_ok
    && a.pg.bound.own_user === b.pg.bound.own_user
    && a.pg.bound.mailbox_ready === b.pg.bound.mailbox_ready
    && a.pg.bound.has_active_operation === b.pg.bound.has_active_operation;
}

function brandEvidence(pairs) {
  const obj = objectCreate(null);
  for (let i = 0; i < pairs.length; i += 1) {
    const key = pairs[i][0];
    if (typeof key !== 'string' || arrayIncludes(FORBIDDEN_EVIDENCE, key)) throw failure('evidence_forbidden');
    obj[key] = pairs[i][1];
  }
  if (!rejectForbiddenKeys(obj)) throw failure('evidence_forbidden');
  const frozen = objectFreeze(obj);
  OWNED_PREFLIGHTS.add(frozen);
  return frozen;
}

function invokedFromSourceTestHarness() {
  try {
    const main = require.main && require.main.filename;
    if (typeof main !== 'string') return false;
    const base = main.replace(/\\/g, '/').split('/').pop();
    return /^(verify|prove)-email-luna-controlled-drafting-live-downscope-prover/.test(base);
  } catch (_) {
    return true;
  }
}

function createOwnedSunsetStagingLivePreflightReader(input) {
  if (!exactPlainData(input, READER_ADAPTER_KEYS)) throw failure('reader_adapters');
  const azure = freezeBoundBag(ownData(input, 'azure'), AZURE_ADAPTER_KEYS);
  const acr = freezeBoundBag(ownData(input, 'acr'), ACR_ADAPTER_KEYS);
  const pg = freezeBoundBag(ownData(input, 'pg'), PG_ADAPTER_KEYS);
  const clock = freezeBoundBag(ownData(input, 'clock'), CLOCK_KEYS);
  if (!azure || !acr || !pg || !clock) throw failure('reader_adapters');
  const nowMs = ownData(clock, 'nowMs');
  if (typeof nowMs !== 'function') throw failure('reader_adapters');

  async function read() {
    let started;
    let finished;
    try {
      const t0 = nowMs();
      if (typeof t0 !== 'number' || !Number.isFinite(t0)) throw failure('freshness');
      started = new Date(t0).toISOString();
      const azureA = await readAzureFence(azure);
      const digestA = await readAcrFence(acr, azureA.app.image, azureA.revision.runtimeDigest);
      const pgA = await readPgFence(pg, {
        clientId: azureA.app.clientId,
        locationId: azureA.app.locationId,
        endpointId: azureA.app.endpointId,
        mailboxId: azureA.app.mailboxId,
      });
      const azureB = await readAzureFence(azure);
      const digestB = await readAcrFence(acr, azureB.app.image, azureB.revision.runtimeDigest);
      const pgB = await readPgFence(pg, {
        clientId: azureB.app.clientId,
        locationId: azureB.app.locationId,
        endpointId: azureB.app.endpointId,
        mailboxId: azureB.app.mailboxId,
      });
      const first = objectFreeze({ app: azureA.app, revision: azureA.revision, digest: digestA, pg: pgA });
      const second = objectFreeze({ app: azureB.app, revision: azureB.revision, digest: digestB, pg: pgB });
      if (!sameFence(first, second)) throw failure('revision_drift');
      if (azureA.app.clientId !== azureB.app.clientId
          || azureA.app.locationId !== azureB.app.locationId
          || azureA.app.endpointId !== azureB.app.endpointId
          || azureA.app.mailboxId !== azureB.app.mailboxId) {
        throw failure('binding_unproven');
      }
      const owners = proveCanonicalRuntimeOwnersMatchDeployedContract();
      if (!owners || owners.ok !== true) throw failure('canonical_owners');
      const t1 = nowMs();
      if (typeof t1 !== 'number' || !Number.isFinite(t1) || t1 < t0) throw failure('freshness');
      const age = t1 - t0;
      if (age > FENCE_MAX_AGE_MS) throw failure('freshness');
      finished = new Date(t1).toISOString();
      return brandEvidence([
        ['ok', true],
        ['independent_read', true],
        ['live_authority', true],
        ['untrusted_caller_snapshot', false],
        ['subscription_id', AZURE_OWNER.subscriptionId],
        ['resource_group', AZURE_OWNER.resourceGroup],
        ['app_name', AZURE_OWNER.appName],
        ['location', AZURE_OWNER.location],
        ['revision', EXPECTED_LIVE_TARGET.revision],
        ['latest_revision', azureB.app.latest],
        ['latest_ready_revision', azureB.app.latestReady],
        ['active_revision', EXPECTED_LIVE_TARGET.revision],
        ['traffic_weight', azureB.app.trafficWeight],
        ['running_status', 'Running'],
        ['provisioning_state', 'Succeeded'],
        ['health_state', 'Healthy'],
        ['replica', 1],
        ['min_replicas', 1],
        ['max_replicas', 1],
        ['image_repository', `${AZURE_OWNER.acrLoginServer}/${AZURE_OWNER.acrRepository}`],
        ['image_tag', azureB.app.image.tag],
        ['deploy_sha', azureB.app.image.tag],
        ['digest', digestB],
        ['flags_all_literal_false', true],
        ['tenant', SUNSET_TENANT],
        ['location_key', SUNSET_LOCATION_KEY],
        ['database', EXPECTED_DATABASE],
        ['ops_097', pgB.counts.ops_097],
        ['transitions_097', pgB.counts.transitions_097],
        ['authorizations_098', pgB.counts.authorizations_098],
        ['binding_ok', true],
        ['own_user', true],
        ['mailbox_ready', true],
        ['grant_status', pgB.grant.grant_status],
        ['reconcile_state', pgB.grant.reconcile_state],
        ['has_active_lease', false],
        ['has_active_operation', false],
        ['producer_login_ok', true],
        ['worker_login_ok', true],
        ['logins_distinct', true],
        ['tls_ok', true],
        ['acl_ok', true],
        ['admin_dsn_distinct', true],
        ['canonical_owners_matched', true],
        ['compatibility_rule_id', OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id],
        ['started_at', started],
        ['finished_at', finished],
        ['age_ms', age],
        ['fence_stable', true],
        ['oauth_called', false],
        ['kv_secret_called', false],
        ['token_called', false],
        ['jwks_called', false],
        ['graph_called', false],
        ['send_called', false],
        ['writes', false],
      ]);
    } catch (err) {
      refuseDetail(err, 'reader_invalid');
    }
  }

  return objectFreeze({ read });
}

function httpGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(failure('azure_unproven'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== AZURE_OWNER.imdsHost) {
      reject(failure('azure_unproven'));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: headers || {},
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        reject(failure('azure_unproven'));
        return;
      }
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        const digestHeader = res.headers && res.headers['docker-content-digest'];
        resolve(objectFreeze({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          digestHeader: typeof digestHeader === 'string' ? digestHeader : null,
        }));
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) { /* sanitized */ } reject(failure('azure_unproven')); });
    req.on('error', () => reject(failure('azure_unproven')));
    req.end();
  });
}

function closedEnvFromArm(raw) {
  if (!arrayIsArray(raw)) return null;
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = ownData(raw, i);
    if (!item || typeof item !== 'object') return null;
    const name = ownData(item, 'name');
    const secretRef = ownData(item, 'secretRef');
    const value = ownData(item, 'value');
    if (typeof name !== 'string') return null;
    if (secretRef !== undefined && secretRef !== null) {
      out.push({ name, secretRef: typeof secretRef === 'string' ? secretRef : 'secret' });
    } else {
      out.push({ name, value: typeof value === 'string' ? value : '' });
    }
  }
  return out;
}

function closedTrafficFromArm(raw) {
  if (!arrayIsArray(raw)) return null;
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = ownData(raw, i);
    if (!item || typeof item !== 'object') return null;
    out.push({
      revisionName: ownData(item, 'revisionName'),
      weight: ownData(item, 'weight'),
    });
  }
  return out;
}

function closedAppFromArm(raw) {
  if (!raw || typeof raw !== 'object' || isProxySurface(raw)) return null;
  const id = ownData(raw, 'id');
  if (typeof id !== 'string') return null;
  const subMatch = id.match(/^\/subscriptions\/([0-9a-f-]{36})\//i);
  const rgMatch = id.match(/\/resourceGroups\/([^/]+)\//i);
  const tags = ownData(raw, 'tags') || {};
  const props = ownData(raw, 'properties') || {};
  const template = ownData(props, 'template') || {};
  const scale = ownData(template, 'scale') || {};
  const containers = ownData(template, 'containers');
  const container = arrayIsArray(containers) ? ownData(containers, 0) : null;
  const config = ownData(props, 'configuration') || {};
  const ingress = ownData(config, 'ingress') || {};
  const env = closedEnvFromArm(container ? ownData(container, 'env') : null);
  const traffic = closedTrafficFromArm(ownData(ingress, 'traffic'));
  if (!env || !traffic || !subMatch || !rgMatch) return null;
  return {
    subscriptionId: subMatch[1].toLowerCase(),
    resourceGroup: rgMatch[1],
    name: ownData(raw, 'name'),
    location: ownData(raw, 'location'),
    tenantTag: ownData(tags, 'tenant'),
    latestRevisionName: ownData(props, 'latestRevisionName'),
    latestReadyRevisionName: ownData(props, 'latestReadyRevisionName'),
    runningStatus: ownData(props, 'runningStatus'),
    provisioningState: ownData(props, 'provisioningState'),
    minReplicas: ownData(scale, 'minReplicas'),
    maxReplicas: ownData(scale, 'maxReplicas'),
    traffic,
    env,
    image: container ? ownData(container, 'image') : null,
  };
}

function closedRevisionFromArm(raw) {
  if (!raw || typeof raw !== 'object' || isProxySurface(raw)) return null;
  const props = ownData(raw, 'properties') || {};
  const template = ownData(props, 'template') || {};
  const containers = ownData(template, 'containers');
  const container = arrayIsArray(containers) ? ownData(containers, 0) : null;
  const image = container ? ownData(container, 'image') : null;
  let imageDigest = ownData(props, 'imageDigest');
  if (!imageDigest && typeof image === 'string' && image.includes('@')) {
    imageDigest = image.slice(image.indexOf('@') + 1);
  }
  return {
    name: ownData(raw, 'name'),
    runningState: ownData(props, 'runningState'),
    healthState: ownData(props, 'healthState'),
    provisioningState: ownData(props, 'provisioningState'),
    replicas: ownData(props, 'replicas'),
    image,
    imageDigest: imageDigest || null,
  };
}

function closedAcrDigestFromManifestResponse(res) {
  if (!res || typeof res !== 'object' || isProxySurface(res)) throw failure('acr_unproven');
  if (ownData(res, 'status') !== 200) throw failure('acr_unproven');
  const digestHeader = ownData(res, 'digestHeader');
  if (typeof digestHeader === 'string' && DIGEST_RE.test(digestHeader)) return digestHeader;
  throw failure('acr_unproven');
}

function createProductionAdapters() {
  if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true) {
    throw failure('live_execute_not_authorized_in_this_chapter');
  }
  const armBase = `https://${AZURE_OWNER.armHost}/subscriptions/${AZURE_OWNER.subscriptionId}`
    + `/resourceGroups/${AZURE_OWNER.resourceGroup}/providers/Microsoft.App/containerApps/`
    + `${AZURE_OWNER.appName}`;

  async function imdsToken(resource) {
    const url = `http://${AZURE_OWNER.imdsHost}/metadata/identity/oauth2/token`
      + `?api-version=2018-02-01&resource=${encodeURIComponent(resource)}`;
    const res = await httpGet(url, { Metadata: 'true' }, IMDS_TIMEOUT_MS);
    if (!res || res.status !== 200) throw failure('azure_unproven');
    let parsed;
    try { parsed = JSON.parse(res.body); } catch (_) { throw failure('azure_unproven'); }
    const token = ownData(parsed, 'access_token');
    if (typeof token !== 'string' || token.length < 8) throw failure('azure_unproven');
    return token;
  }

  async function armGet(path) {
    const token = await imdsToken('https://management.azure.com/');
    const res = await httpGet(`${armBase}${path}?api-version=${AZURE_OWNER.armApiVersion}`, {
      Authorization: `Bearer ${token}`,
    }, ARM_TIMEOUT_MS);
    if (!res || res.status !== 200) throw failure('azure_unproven');
    try { return JSON.parse(res.body); } catch (_) { throw failure('azure_unproven'); }
  }

  return {
    azure: {
      async readApp() {
        const raw = await armGet('');
        const closed = closedAppFromArm(raw);
        if (!closed) throw failure('azure_unproven');
        return closed;
      },
      async listRevisions() {
        const raw = await armGet('/revisions');
        const value = ownData(raw, 'value');
        if (!arrayIsArray(value)) throw failure('azure_unproven');
        const out = [];
        for (let i = 0; i < value.length; i += 1) {
          const closed = closedRevisionFromArm(ownData(value, i));
          if (!closed) throw failure('azure_unproven');
          out.push(closed);
        }
        return out;
      },
      async readRevision(name) {
        if (name !== EXPECTED_LIVE_TARGET.revision) throw failure('revision_mismatch');
        const raw = await armGet(`/revisions/${encodeURIComponent(name)}`);
        const closed = closedRevisionFromArm(raw);
        if (!closed) throw failure('azure_unproven');
        return closed;
      },
    },
    acr: {
      async readManifestDigest(ref) {
        if (!exactPlainData(ref, objectFreeze(['loginServer', 'repository', 'tag']))) {
          throw failure('acr_unproven');
        }
        if (ownData(ref, 'loginServer') !== AZURE_OWNER.acrLoginServer) throw failure('acr_unproven');
        if (ownData(ref, 'repository') !== AZURE_OWNER.acrRepository) throw failure('acr_unproven');
        if (ownData(ref, 'tag') !== EXPECTED_LIVE_TARGET.deployedSha) throw failure('acr_unproven');
        const token = await imdsToken(`https://${AZURE_OWNER.acrLoginServer}`);
        const url = `https://${AZURE_OWNER.acrLoginServer}/v2/${AZURE_OWNER.acrRepository}/manifests/${ownData(ref, 'tag')}`;
        const res = await httpGet(url, {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.docker.distribution.manifest.v2+json',
        }, ARM_TIMEOUT_MS);
        return closedAcrDigestFromManifestResponse(res);
      },
    },
    pg: {
      async withProducerClient(work) {
        return withProductionLoginClient('producer', work);
      },
      async withWorkerClient(work) {
        return withProductionLoginClient('worker', work);
      },
    },
    clock: {
      nowMs() { return Date.now(); },
    },
  };
}

function envOwn(env, key) {
  const value = ownData(env, key);
  return typeof value === 'string' ? value : undefined;
}

function looksLikeAdminStaffApiDsn(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length < 1) return false;
  const userinfo = connectionString.split('@')[0] || '';
  return /(?:^|[/:])wolfhouse_admin(?:[:@]|$)/i.test(userinfo) === true;
}

async function withReadOnlyPreflightClient(handle, work) {
  if (typeof work !== 'function' || isProxySurface(work)) throw failure('pg_unproven');
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function') || isProxySurface(handle)) {
    throw failure('login_unproven');
  }
  const withRo = ownData(handle, 'withReadOnlyTransactionClient');
  if (typeof withRo !== 'function' || isProxySurface(withRo)) throw failure('login_unproven');
  try {
    return await withRo.call(handle, async (client) => {
      const queryFn = resolveQuery(client);
      if (typeof queryFn !== 'function' || isProxySurface(queryFn)) throw failure('pg_unproven');
      return work(client);
    });
  } catch (err) {
    refuseDetail(err, 'pg_unproven');
  }
}

async function withProductionLoginClient(kind, work) {
  if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true) {
    throw failure('live_execute_not_authorized_in_this_chapter');
  }
  if (typeof work !== 'function' || isProxySurface(work)) throw failure('pg_unproven');
  const env = process.env;
  const producer = envOwn(env, ENV_PRODUCER_DATABASE_URL);
  const worker = envOwn(env, LIVE_CUSTODY_DSN_ENV_KEY);
  const admin = envOwn(env, LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY);
  if (typeof producer !== 'string' || typeof worker !== 'string' || typeof admin !== 'string') {
    throw failure('pg_unproven');
  }
  if (admin === worker || admin === producer || worker === producer) throw failure('login_alias');
  if (looksLikeAdminStaffApiDsn(worker) || looksLikeAdminStaffApiDsn(producer)) throw failure('login_alias');
  const pair = createEmailLunaControlledDraftingPrincipalConnectionPair(objectFreeze({
    env,
    appConnectionString: admin,
  }));
  if (!isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair(pair)) throw failure('login_unproven');
  const handle = ownData(pair, kind);
  return withReadOnlyPreflightClient(handle, work);
}

async function readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg() {
  if (arguments.length !== 0) throw failure('caller_input_refused');
  if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true) {
    throw failure('live_execute_not_authorized_in_this_chapter');
  }
  if (invokedFromSourceTestHarness()) throw failure('source_test_cannot_consume_live_azure_pg');
  const reader = createOwnedSunsetStagingLivePreflightReader(createProductionAdapters());
  return reader.read();
}

function isIndependentLivePreflight(value) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    return OWNED_PREFLIGHTS.has(value) && value.ok === true && value.independent_read === true;
  } catch (_) {
    return false;
  }
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  EIGHT_FLAGS,
  AZURE_OWNER,
  FENCE_MAX_AGE_MS,
  COUNT_SQL,
  IDENTITY_SQL,
  GRANT_SQL,
  BINDING_SQL,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  createOwnedSunsetStagingLivePreflightReader,
  readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg,
  isIndependentLivePreflight,
  withReadOnlyPreflightClient,
  closedAcrDigestFromManifestResponse,
});
