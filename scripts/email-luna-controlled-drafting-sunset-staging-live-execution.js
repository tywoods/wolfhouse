#!/usr/bin/env node
'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — CLI-only production
 * driver. Import-inert: requiring this file performs no action and exposes
 * no callable live factory (`module.exports` stays the empty object).
 *
 * Live composition exists only as unexported lexical functions reached from
 * `require.main === module` after exact local arguments, reviewed candidate
 * SHA/tree validation, and canonical receipt claim. 4H/4G public owners stay
 * frozen-disabled; this file does not open those gated constructors.
 */

Object.freeze(module.exports);

if (require.main === module) {
  /* eslint-disable global-require */
  const http = require('node:http');
  const https = require('node:https');
  const path = require('node:path');
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const nodeCrypto = require('node:crypto');
  const nodeTimers = require('node:timers');
  const {
    isProxySurface,
    ownData,
    isCanonUuid,
  } = require('./lib/email-luna-controlled-drafting-closed-data');
  const core = require('./lib/email-luna-controlled-drafting-chapter-4i-proof-core');
  const chapter4IReceipt = require('./lib/email-luna-controlled-drafting-chapter-4i-durable-receipt');
  const readerOwned = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned');
  const {
    LIVE_CUSTODY_DSN_ENV_KEY,
    LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY,
    SUNSET_LOCATION_KEY,
  } = require('./lib/email-luna-controlled-drafting-live-downscope-prover-live-target-constants');
  const {
    createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
    SUNSET_STAGING_TRUSTED_HOST,
    SUNSET_STAGING_VERSIONED_KEY_ID,
  } = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
  const {
    validateEmailGrantEnvelopeProvider,
  } = require('./lib/email-grant-envelope-provider-contract');
  const {
    createSunsetMicrosoftOAuthClientSecretProvider,
  } = require('./lib/sunset-microsoft-oauth-provider');
  const {
    createMicrosoftTokenHttpTransport,
  } = require('./lib/email-microsoft-token-http-transport');
  const {
    createMicrosoftOidcJwksSignatureVerifier,
    isCanonicalMicrosoftOidcJwksSignatureVerifier,
  } = require('./lib/email-microsoft-oidc-jwks-verifier');
  const {
    createEmailLunaControlledDraftingPrincipalConnectionPair,
    isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair,
    ENV_PRODUCER_DATABASE_URL,
  } = require('./lib/email-luna-controlled-drafting-principal-connection');
  const {
    proveCanonicalRuntimeOwnersMatchDeployedContract,
  } = require('./lib/email-luna-controlled-drafting-live-downscope-prover-canonical-owners');
  const {
    withSunsetStagingLiveTargetConnectedPgClient,
  } = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');

  const objectFreeze = Object.freeze;
  const objectCreate = Object.create;
  const objectGetPrototypeOf = Object.getPrototypeOf;
  const objectHasOwn = Object.hasOwn;
  const reflectOwnKeys = Reflect.ownKeys;
  const arrayIsArray = Array.isArray;
  const arrayIncludes = Function.prototype.call.bind(Array.prototype.includes);
  const AZURE_OWNER = readerOwned.AZURE_OWNER;
  const EXPECTED_LIVE_TARGET = core.EXPECTED_LIVE_TARGET;
  const IMDS_TIMEOUT_MS = 400;
  const ARM_TIMEOUT_MS = 400;
  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
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

  function failure(code) {
    const error = new Error(core.ERROR_MESSAGE);
    error.code = core.ERROR_CODE;
    if (typeof code === 'string') error.detail = code;
    objectFreeze(error);
    return error;
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

  function envString(env, key) {
    const value = ownData(env, key);
    return typeof value === 'string' ? value : undefined;
  }

  function envOwn(env, key) {
    const value = ownData(env, key);
    return typeof value === 'string' ? value : undefined;
  }

  function flagsAllLiteralFalse(env) {
    for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
      const raw = ownData(env, EIGHT_FLAGS[i]);
      if (raw !== false && raw !== 'false') return false;
    }
    return true;
  }

  function looksLikeAdminStaffApiDsn(connectionString) {
    if (typeof connectionString !== 'string' || connectionString.length < 1) return false;
    const userinfo = connectionString.split('@')[0] || '';
    return /(?:^|[/:])wolfhouse_admin(?:[:@]|$)/i.test(userinfo) === true;
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
      req.on('timeout', () => {
        try { req.destroy(); } catch (_) { /* sanitized */ }
        reject(failure('azure_unproven'));
      });
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

  function createLexicalCommandRunner() {
    return objectFreeze({
      execFileSync,
    });
  }

  async function withLexicalProductionLoginClient(kind, work) {
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
    return readerOwned.withReadOnlyPreflightClient(handle, work);
  }

  function createLexicalSunsetStagingMeasurementAdapters() {
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

    async function armGet(armPath) {
      const token = await imdsToken('https://management.azure.com/');
      const res = await httpGet(`${armBase}${armPath}?api-version=${AZURE_OWNER.armApiVersion}`, {
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
          const digest = readerOwned.closedAcrDigestFromManifestResponse(res);
          if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw failure('acr_unproven');
          return digest;
        },
      },
      pg: {
        async withProducerClient(work) {
          return withLexicalProductionLoginClient('producer', work);
        },
        async withWorkerClient(work) {
          return withLexicalProductionLoginClient('worker', work);
        },
      },
      clock: {
        nowMs() { return Date.now(); },
      },
    };
  }

  function composeLexicalSunsetStagingExecutionDependencies(env) {
    if (!env || typeof env !== 'object' || isProxySurface(env) || arrayIsArray(env)) {
      throw failure('env');
    }
    if (envString(env, 'LUNA_DEPLOYMENT') !== core.SUNSET_DEPLOYMENT) throw failure('deployment');
    if (envString(env, 'DEFAULT_CLIENT_SLUG') !== core.SUNSET_TENANT) throw failure('tenant');
    if (!flagsAllLiteralFalse(env)) throw failure('flags');
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT') !== '1') {
      throw failure('replica');
    }
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY') !== SUNSET_LOCATION_KEY) {
      throw failure('location');
    }
    if (envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER') !== 'microsoft_graph') {
      throw failure('provider');
    }
    const applicationClientId = envString(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (!isCanonUuid(applicationClientId)) throw failure('application_client');
    const clientId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID');
    const locationId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID');
    const endpointId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID');
    const mailboxId = envString(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID');
    if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId) || !isCanonUuid(mailboxId)) {
      throw failure('binding');
    }
    if (typeof envString(env, ENV_PRODUCER_DATABASE_URL) !== 'string') throw failure('producer_dsn_missing');
    const workerDsn = envString(env, LIVE_CUSTODY_DSN_ENV_KEY);
    if (typeof workerDsn !== 'string') throw failure('worker_dsn_missing');
    const adminDsn = envString(env, LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY);
    if (typeof adminDsn !== 'string') throw failure('app_dsn_missing');
    if (adminDsn === workerDsn) throw failure('admin_dsn_alias');
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_SUNSET_STAGING_RUNTIME_ACTIVATION_ENABLED') !== 'true') {
      throw failure('kv_activation');
    }
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED') !== 'true') {
      throw failure('kv_composition');
    }
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST') !== SUNSET_STAGING_TRUSTED_HOST) {
      throw failure('kv_host');
    }
    if (envString(env, 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID') !== SUNSET_STAGING_VERSIONED_KEY_ID) {
      throw failure('kv_key');
    }
    const owners = proveCanonicalRuntimeOwnersMatchDeployedContract();
    if (!owners.ok) throw failure('canonical_owners');

    const httpsPinned = freezeBoundBag(https, ['request']);
    const cryptoPinned = freezeBoundBag(nodeCrypto, ['createPublicKey', 'verify']);
    const timersPinned = freezeBoundBag(nodeTimers, ['setTimeout', 'clearTimeout']);
    if (!httpsPinned || !cryptoPinned || !timersPinned) throw failure('node_owners');

    const kv = createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env);
    const validated = kv && validateEmailGrantEnvelopeProvider(kv.provider);
    if (!kv || kv.ok !== true || !validated || validated.ok !== true) throw failure('kv');

    const transport = createMicrosoftTokenHttpTransport(objectFreeze({
      httpsImpl: ownData(httpsPinned, 'request'),
      timers: timersPinned,
    }));
    if (!transport || typeof ownData(transport, 'postTokenForm') !== 'function') throw failure('transport');

    function createSignatureVerifier() {
      const verifier = createMicrosoftOidcJwksSignatureVerifier(objectFreeze({
        https: httpsPinned,
        crypto: cryptoPinned,
        timers: timersPinned,
      }));
      if (!isCanonicalMicrosoftOidcJwksSignatureVerifier(verifier)) throw failure('jwks');
      return verifier;
    }

    async function withPgClient(work) {
      if (typeof work !== 'function' || isProxySurface(work)) throw failure('with_pg');
      let pg;
      try {
        pg = require('pg');
      } catch (_) {
        throw failure('pg_module');
      }
      const Client = pg && pg.Client;
      if (typeof Client !== 'function') throw failure('pg_module');
      return withSunsetStagingLiveTargetConnectedPgClient(objectFreeze({
        Client,
        connectionString: workerDsn,
        work,
      }));
    }

    return objectFreeze({
      applicationClientId: applicationClientId.toLowerCase(),
      withPgClient,
      envelopeProvider: validated.value,
      createSecretProvider: () => createSunsetMicrosoftOAuthClientSecretProvider(objectFreeze({
        deployment: core.SUNSET_DEPLOYMENT,
        env,
      })),
      transport,
      createSignatureVerifier,
      binding: objectFreeze({
        clientId: clientId.toLowerCase(),
        locationId: locationId.toLowerCase(),
        endpointId: endpointId.toLowerCase(),
        mailboxId: mailboxId.toLowerCase(),
      }),
    });
  }

  function assertThisExactCli() {
    let abs;
    try {
      abs = fs.realpathSync(__filename);
    } catch (_) {
      throw failure('source_symlink_escape');
    }
    const root = path.dirname(path.dirname(abs));
    const expected = path.join(root, core.PRODUCTION_DRIVER_REL);
    let expectedAbs;
    try {
      expectedAbs = fs.realpathSync(expected);
    } catch (_) {
      throw failure('source_symlink_escape');
    }
    if (abs !== expectedAbs) throw failure('source_symlink_escape');
  }

  async function runProductionMain(argv, env) {
    const parsed = core.parseArgs(argv);
    if (parsed.invalid === true) {
      return core.refusedRecord(parsed.invalidReason || 'unknown_or_hostile_arg');
    }
    if (core.refusedProduction(env || {})) return core.refusedRecord('production_or_wolfhouse_refused');
    if (core.proxyPresent(env || {})) return core.refusedRecord('proxy_refused');
    if (core.envAliasPresent(env || {})) return core.refusedRecord('env_alias_refused');
    const runner = createLexicalCommandRunner();
    if (parsed.command === core.PREFLIGHT_COMMAND) {
      return core.runLocalPreflight(parsed, env, runner);
    }
    const gate = core.validateExactInvocation(parsed);
    if (gate) {
      return core.refusedRecord(gate, {
        source_sha: parsed.sourceSha,
        source_tree: parsed.sourceTree,
      });
    }
    try {
      assertThisExactCli();
      core.assertExecutingSource(parsed.sourceSha, parsed.sourceTree, runner, env);
    } catch (err) {
      const detail = err && err.detail ? err.detail : 'source_sha_mismatch';
      return core.refusedRecord(detail, {
        source_sha: parsed.sourceSha,
        source_tree: parsed.sourceTree,
      });
    }

    const store = chapter4IReceipt.createCanonicalOperatorReceiptStore();
    const claimedAt = new Date().toISOString();
    try {
      store.claim(objectFreeze({
        chapter_id: chapter4IReceipt.CHAPTER_ID,
        source_sha: parsed.sourceSha,
        source_tree: parsed.sourceTree,
        deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
        revision: EXPECTED_LIVE_TARGET.revision,
        digest: EXPECTED_LIVE_TARGET.digest,
        deployment: core.SUNSET_DEPLOYMENT,
        tenant: core.SUNSET_TENANT,
        database: core.EXPECTED_DATABASE,
        resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
        app_name: EXPECTED_LIVE_TARGET.appName,
        operator_nonce: parsed.operatorNonce,
        confirm_issued_at: parsed.confirmIssuedAt,
        status: chapter4IReceipt.RECEIPT_STATES.claimed,
        refresh_call_count: 0,
        local_receipt_write_count: 1,
        custody_write_count: 0,
        operational_write_count: 0,
        claimed_at: claimedAt,
        updated_at: claimedAt,
      }));
    } catch (err) {
      const detail = err && err.detail ? err.detail : 'operator_receipt_unproven';
      return core.refusedRecord(detail, {
        source_sha: parsed.sourceSha,
        source_tree: parsed.sourceTree,
        local_receipt_write_count: 0,
      });
    }

    let deps;
    let reader;
    try {
      const measurement = createLexicalSunsetStagingMeasurementAdapters();
      reader = readerOwned.createOwnedSunsetStagingLivePreflightReader(measurement);
      deps = composeLexicalSunsetStagingExecutionDependencies(env);
    } catch (err) {
      try {
        store.advance(chapter4IReceipt.RECEIPT_STATES.terminal_unknown, {
          refresh_call_count: 0,
          custody_write_count: 0,
          operational_write_count: 0,
        });
      } catch (_) { /* sanitized */ }
      const detail = err && err.detail ? err.detail : 'outcome_unknown';
      return core.refusedRecord(detail, {
        source_sha: parsed.sourceSha,
        source_tree: parsed.sourceTree,
        status: 'outcome_unknown',
        local_receipt_write_count: 2,
      });
    }

    const owner = core.createOwnedSunsetStagingLiveExecutionOwner(objectFreeze({
      readIndependentLivePreflight: () => ownData(reader, 'read').call(reader),
      envelopeProvider: ownData(deps, 'envelopeProvider'),
      createSecretProvider: ownData(deps, 'createSecretProvider'),
      transport: ownData(deps, 'transport'),
      createSignatureVerifier: ownData(deps, 'createSignatureVerifier'),
      withPgClient: ownData(deps, 'withPgClient'),
      binding: ownData(deps, 'binding'),
      applicationClientId: ownData(deps, 'applicationClientId'),
      clock: objectFreeze({ nowMs() { return Date.now(); } }),
      receiptStore: store,
      commandRunner: runner,
    }));
    let record;
    try {
      record = await owner.executeOnce(core.invocationFromParsed(parsed));
    } catch (err) {
      const extra = objectCreate(null);
      extra.source_sha = parsed.sourceSha;
      extra.source_tree = parsed.sourceTree;
      try {
        const current = store.read();
        extra.refresh_call_count = current && typeof current.refresh_call_count === 'number'
          ? current.refresh_call_count
          : 0;
        extra.local_receipt_write_count = current && typeof current.local_receipt_write_count === 'number'
          ? current.local_receipt_write_count
          : 0;
        extra.custody_write_count = current && typeof current.custody_write_count === 'number'
          ? current.custody_write_count
          : 0;
      } catch (_) { /* sanitized */ }
      void err;
      return core.recordFromThrownCliError(null, extra);
    }
    if (record && record.ok === true) {
      return core.machineRecord(Object.assign(objectCreate(null), record, { status: 'pass' }));
    }
    return record;
  }

  runProductionMain(process.argv.slice(2), process.env).then((record) => {
    const emitted = core.emitCliMachineRecord(record, process.stdout);
    if (!emitted || emitted.ok !== true) process.exitCode = 1;
  }).catch(() => {
    core.emitCliMachineRecord(core.sanitizedUnexpectedCliRecord(), process.stdout);
    process.exitCode = 1;
  });
  /* eslint-enable global-require */
}
