'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — pure proof-state core.
 *
 * Import-inert. Accepts already-created adapters/evidence readers only.
 * Contains no production adapter constructors, no env-selected live
 * composition, and no network modules. Cannot create live capabilities.
 * Graph/send/098/097-create surfaces are absent. Staff API does not
 * import this module.
 *
 * @module email-luna-controlled-drafting-chapter-4i-proof-core
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  isProxySurface,
  ownData,
  isCanonUuid,
  digestUtf8,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  tryAcquireDelegatedGrantLease,
  openDelegatedGrantUnderLease,
  commitDelegatedGrantRotation,
  abortDelegatedGrantLease,
  getDelegatedGrantPublicStatus,
  resolveDelegatedReadAuthorityBinding,
} = require('./email-delegated-grant-custodian');
const {
  buildGrantEnvelopeAadV1,
  validateEmailGrantEnvelopeProvider,
  validateGrantEnvelopeRecordV1,
} = require('./email-grant-envelope-provider-contract');
const {
  createMicrosoftRefreshTokenRequestService,
  SUNSET_DEPLOYMENT: REQUEST_SUNSET,
  readTrustedMicrosoftRefreshTokenRequestStage,
  CONTROLLED_DRAFTING_SCOPE_VERSION,
} = require('./email-microsoft-refresh-token-request');
const {
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');
const {
  createDelegatedGrantAccessSession,
} = require('./email-delegated-grant-access-session');
const {
  createControlledDraftingAccessTokenClaimsInspector,
  createStaffSendPhaseBAccessTokenClaimsInspector,
  REQUIRED_SCP,
  STAFF_SEND_REQUIRED_SCP,
} = require('./email-luna-controlled-drafting-access-token-claims');
const {
  inspectIndependentLivePreflight,
  EXPECTED_DOWNSCOPE_SCP,
  EXPECTED_STAFF_SEND_SCP,
} = require('./email-luna-controlled-drafting-live-downscope-prover');
const readerOwner = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const {
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  EXPECTED_LIVE_TARGET,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
} = require('./email-luna-controlled-drafting-live-downscope-prover-live-target-constants');
const {
  AZURE_OWNER,
} = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const chapter4IReceipt = require('./email-luna-controlled-drafting-chapter-4i-durable-receipt');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_CHAPTER_4I_LIVE_EXECUTION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting Chapter 4I live execution failed.';
const PROOF_VERSION = 'chapter_4i_v1';
const CONFIRMATION_PHRASE = 'I_UNDERSTAND_SUNSET_STAGING_CHAPTER_4I_ONE_SHOT_LIVE_PROOF';
const COMMAND = 'execute-once';
const PREFLIGHT_COMMAND = 'preflight';
const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CLOSE_TIMEOUT_MS = 2000;
const OPERATOR_NONCE_RE = /^[0-9a-f]{64}$/;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM_FUTURE_SKEW_MS = 60 * 1000;
const USED_OPERATOR_NONCES = new Set();
const DOWNSCOPE_WORKER_ID = 'email-luna-controlled-drafting-chapter-4i-downscope';
const CONTINUITY_WORKER_ID = 'email-luna-controlled-drafting-chapter-4i-continuity';
const SCOPE_PROFILE_ID = CONTROLLED_DRAFTING_SCOPE_VERSION;

const INVOCATION_KEYS = objectFreeze([
  'deployment', 'tenant', 'database', 'resourceGroup', 'appName',
  'revision', 'deploySha', 'digest', 'sourceSha', 'sourceTree', 'confirm',
  'operatorNonce', 'confirmIssuedAt',
]);
const ADAPTER_KEYS = objectFreeze([
  'readIndependentLivePreflight', 'envelopeProvider', 'createSecretProvider',
  'transport', 'createSignatureVerifier', 'withPgClient', 'binding',
  'applicationClientId', 'clock', 'receiptStore', 'commandRunner',
]);
const SOURCE_TRACKED_FILES = objectFreeze([
  'scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js',
  'scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.js',
  'scripts/lib/email-luna-controlled-drafting-chapter-4i-proof-core.js',
  'scripts/lib/email-luna-controlled-drafting-chapter-4i-durable-receipt.js',
]);
const PRODUCTION_DRIVER_REL = 'scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js';
const FORBIDDEN_GIT_ENV = objectFreeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_PREFIX', 'GIT_REPLACE_REF_BASE', 'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
]);
const IDENTITY_FIELDS = objectFreeze([
  'deploy_sha', 'revision', 'digest', 'replica', 'traffic_weight',
  'image_login_server', 'image_repository', 'image_tag',
  'ops_097', 'transitions_097', 'authorizations_098',
  'grant_status', 'reconcile_state', 'has_active_lease',
  'flags_all_literal_false', 'subscription_id', 'resource_group',
  'app_name', 'tenant', 'database',
  'client_id', 'location_id', 'endpoint_id', 'mailbox_id',
  'producer_login_fingerprint', 'worker_login_fingerprint',
]);
const RECEIPT_STORE_KEYS = objectFreeze(['path', 'claim', 'read', 'advance']);
const COMMAND_RUNNER_KEYS = objectFreeze(['execFileSync']);
const BINDING_KEYS = objectFreeze(['clientId', 'locationId', 'endpointId', 'mailboxId']);
const FORBIDDEN_ADAPTER_KEYS = objectFreeze([
  'consumer', 'callback', 'runClosed', 'withToken', 'getAccessToken',
  'accessToken', 'fetch', 'request', 'client', 'graph', 'graphClient',
  'httpsImpl', 'createReplyDraft', 'reconcileDraft', 'sendMail',
  'journal', 'journalStore', 'liveOwner', 'isIndependentLivePreflight',
]);
const ENV_ALIAS_KEYS = objectFreeze([
  'CHAPTER_4I_TARGET',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_CHAPTER_4I_TARGET',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_TARGET',
  'LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER',
]);
const PROXY_ENV_KEYS = objectFreeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
]);
const PRODUCTION_MARKERS = objectFreeze([
  'production', 'prod', 'luna_prod', 'wolfhouse_prod', 'sunset_prod', 'wolfhouse',
]);
const MACHINE_RECORD_KEYS = objectFreeze([
  'proof_version', 'ok', 'status', 'deployment', 'tenant', 'database',
  'resource_group', 'app_name', 'source_sha', 'source_tree', 'deploy_sha', 'revision', 'digest',
  'preflight_started_at', 'preflight_finished_at', 'fence_generation',
  'downscope_mail_send_absent', 'continuity_expected_scope_present',
  'refresh_call_count', 'graph_call_count', 'send_call_count',
  'local_receipt_write_count', 'custody_write_count', 'operational_write_count',
  'compatibility_rule_id',
]);
const RECEIPT_STATES = chapter4IReceipt.RECEIPT_STATES;
const CLAIMS_SUMMARY_KEYS = objectFreeze([
  'ok', 'scope_profile_id', 'scp', 'mail_send', 'mail_readwrite', 'app_only',
  'kid', 'alg', 'iss_matches', 'aud_matches', 'oid_matches', 'tid_matches',
  'ver_matches', 'exp_window_ok', 'token_lifetime_seconds',
]);
const ROTATING_RESPONSE_UNCERTAINTY_DETAILS = objectFreeze({
  binding: 'post_ms_binding',
  claims: 'post_ms_claims',
  reseal: 'post_ms_pre_seal',
  commit: 'post_ms_cas_conflict',
  token: 'ms_refresh_transport',
  response: 'ms_refresh_uncertain',
  uncertainty_persistence: 'persistence_unproven',
});


if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}
if (REQUEST_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('controlled_drafting_live_downscope_prover_sunset_deployment_mismatch');
}
if (EXPECTED_DOWNSCOPE_SCP !== REQUIRED_SCP.join(' ')) {
  throw new Error('controlled_drafting_chapter_4i_downscope_scp_mismatch');
}
if (EXPECTED_STAFF_SEND_SCP !== STAFF_SEND_REQUIRED_SCP.join(' ')) {
  throw new Error('controlled_drafting_chapter_4i_staff_send_scp_mismatch');
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

function exactSealedTransport(object) {
  return object
    && Object.isFrozen(object)
    && objectGetPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['postTokenForm'])
    && typeof ownData(object, 'postTokenForm') === 'function';
}

function snapshotBinding(raw) {
  if (!exactPlainData(raw, BINDING_KEYS)) return null;
  const clientId = ownData(raw, 'clientId');
  const locationId = ownData(raw, 'locationId');
  const endpointId = ownData(raw, 'endpointId');
  const mailboxId = ownData(raw, 'mailboxId');
  if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId)) return null;
  if (!isCanonUuid(mailboxId)) return null;
  return objectFreeze({
    clientId: stringTrim(clientId),
    locationId: stringTrim(locationId),
    endpointId: stringTrim(endpointId),
    mailboxId: stringTrim(mailboxId),
  });
}

function sha40(value) {
  return typeof value === 'string' && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
}

function validOperatorNonce(value) {
  return typeof value === 'string' && OPERATOR_NONCE_RE.test(value);
}

function validConfirmIssuedAt(value, nowMs) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (ms > now + CONFIRM_FUTURE_SKEW_MS) return false;
  if (now - ms > CONFIRM_WINDOW_MS) return false;
  return true;
}

function refusedProduction(env) {
  const deployment = ownData(env, 'LUNA_DEPLOYMENT');
  const tenant = ownData(env, 'DEFAULT_CLIENT_SLUG');
  if (typeof deployment === 'string' && arrayIncludes(PRODUCTION_MARKERS, stringToLowerCase(deployment))) {
    return true;
  }
  if (typeof tenant === 'string' && arrayIncludes(PRODUCTION_MARKERS, stringToLowerCase(tenant))) {
    return true;
  }
  return false;
}

function proxyPresent(env) {
  if (!env || typeof env !== 'object' || isProxySurface(env)) return true;
  for (let i = 0; i < PROXY_ENV_KEYS.length; i += 1) {
    const value = ownData(env, PROXY_ENV_KEYS[i]);
    if (typeof value === 'string' && value.length > 0) return true;
  }
  return false;
}

function envAliasPresent(env) {
  if (!env || typeof env !== 'object' || isProxySurface(env)) return true;
  for (let i = 0; i < ENV_ALIAS_KEYS.length; i += 1) {
    const value = ownData(env, ENV_ALIAS_KEYS[i]);
    if (value !== undefined && value !== null && value !== '') return true;
  }
  return false;
}

function valueContainsSecret(value, token) {
  if (typeof token !== 'string' || token.length < 1) return false;
  try {
    if (typeof value === 'string') return value.includes(token);
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      return JSON.stringify(value).includes(token);
    }
  } catch (_) {
    return true;
  }
  return false;
}

function copyClaimsSummary(raw) {
  if (!raw || typeof raw !== 'object' || isProxySurface(raw) || arrayIsArray(raw)) return null;
  const out = objectCreate(null);
  for (let i = 0; i < CLAIMS_SUMMARY_KEYS.length; i += 1) {
    const key = CLAIMS_SUMMARY_KEYS[i];
    out[key] = ownData(raw, key);
  }
  if (out.ok !== true) return null;
  if (typeof out.scp !== 'string') return null;
  return objectFreeze(out);
}

function acceptedGrantScope(version) {
  return version === EMAIL_MS_DELEGATED_SCOPE_VERSION
    || version === EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION;
}

function machineRecord(fields) {
  const obj = objectCreate(null);
  for (let i = 0; i < MACHINE_RECORD_KEYS.length; i += 1) {
    const key = MACHINE_RECORD_KEYS[i];
    obj[key] = fields[key] === undefined ? null : fields[key];
  }
  return objectFreeze(obj);
}

function refusedRecord(detail, extra) {
  const refresh = extra && typeof extra.refresh_call_count === 'number' ? extra.refresh_call_count : 0;
  return machineRecord({
    proof_version: PROOF_VERSION,
    ok: false,
    status: extra && extra.status ? extra.status : 'refused',
    deployment: SUNSET_DEPLOYMENT,
    tenant: SUNSET_TENANT,
    database: EXPECTED_DATABASE,
    resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
    app_name: EXPECTED_LIVE_TARGET.appName,
    source_sha: extra && extra.source_sha ? extra.source_sha : null,
    source_tree: extra && extra.source_tree ? extra.source_tree : null,
    deploy_sha: extra && extra.deploy_sha ? extra.deploy_sha : EXPECTED_LIVE_TARGET.deployedSha,
    revision: extra && extra.revision ? extra.revision : EXPECTED_LIVE_TARGET.revision,
    digest: extra && extra.digest ? extra.digest : EXPECTED_LIVE_TARGET.digest,
    preflight_started_at: extra && extra.preflight_started_at ? extra.preflight_started_at : null,
    preflight_finished_at: extra && extra.preflight_finished_at ? extra.preflight_finished_at : null,
    fence_generation: extra && extra.fence_generation !== undefined ? extra.fence_generation : null,
    downscope_mail_send_absent: extra && extra.downscope_mail_send_absent !== undefined
      ? extra.downscope_mail_send_absent
      : null,
    continuity_expected_scope_present: extra && extra.continuity_expected_scope_present !== undefined
      ? extra.continuity_expected_scope_present
      : null,
    refresh_call_count: refresh,
    graph_call_count: 0,
    send_call_count: 0,
    local_receipt_write_count: extra && typeof extra.local_receipt_write_count === 'number'
      ? extra.local_receipt_write_count
      : 0,
    custody_write_count: extra && typeof extra.custody_write_count === 'number'
      ? extra.custody_write_count
      : 0,
    operational_write_count: 0,
    compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
    reason: detail,
  });
}

function forbiddenGitEnvPresent(env) {
  if (!env || typeof env !== 'object' || isProxySurface(env)) return true;
  for (let i = 0; i < FORBIDDEN_GIT_ENV.length; i += 1) {
    const value = ownData(env, FORBIDDEN_GIT_ENV[i]);
    if (value !== undefined && value !== null && value !== '') return true;
  }
  const keys = reflectOwnKeys(env);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key !== 'string') continue;
    if (/^GIT_CONFIG_(KEY|VALUE)_[0-9]+$/.test(key)) return true;
  }
  return false;
}

function resolveRepositoryRoot() {
  const libDir = fs.realpathSync(__dirname);
  const scriptsDir = path.dirname(libDir);
  const root = path.dirname(scriptsDir);
  let gitPath;
  try {
    gitPath = fs.realpathSync(path.join(root, '.git'));
  } catch (_) {
    throw failure('source_sha_mismatch');
  }
  if (typeof gitPath !== 'string' || gitPath.length < 1) throw failure('source_sha_mismatch');
  return root;
}

function sanitizedGitEnv() {
  const env = objectCreate(null);
  const src = process.env;
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === 'GIT_CONFIG_NOSYSTEM') continue;
    if (key.startsWith('GIT_')) continue;
    env[key] = src[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function runGit(runner, root, args) {
  if (!runner || typeof ownData(runner, 'execFileSync') !== 'function') {
    throw failure('source_sha_mismatch');
  }
  const gitArgs = arrayIsArray(args) ? ['--no-replace-objects', '-c', 'core.useReplaceRefs=false'].concat(args) : args;
  let out;
  try {
    out = ownData(runner, 'execFileSync').call(runner, 'git', gitArgs, objectFreeze({
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedGitEnv(),
    }));
  } catch (err) {
    if (err && err.detail === 'source_not_merged_ancestor') throw err;
    throw failure('source_sha_mismatch');
  }
  if (typeof out !== 'string') throw failure('source_sha_mismatch');
  return stringTrim(out);
}

function assertExecutingSource(expectedSha, expectedTree, runner, env) {
  if (!sha40(expectedSha)) throw failure('source_sha_invalid');
  if (!sha40(expectedTree)) throw failure('source_tree_invalid');
  if (forbiddenGitEnvPresent(env || process.env)) throw failure('git_env_refused');
  const root = resolveRepositoryRoot();
  const head = runGit(runner, root, ['rev-parse', 'HEAD']);
  if (head !== expectedSha) throw failure('source_sha_mismatch');
  const tree = runGit(runner, root, ['rev-parse', 'HEAD^{tree}']);
  if (tree !== expectedTree) throw failure('source_tree_mismatch');
  try {
    ownData(runner, 'execFileSync').call(runner, 'git', [
      '--no-replace-objects', '-c', 'core.useReplaceRefs=false',
      'merge-base', '--is-ancestor', 'HEAD', 'origin/master',
    ], objectFreeze({
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedGitEnv(),
    }));
  } catch (_) {
    throw failure('source_not_merged_ancestor');
  }
  const status = runGit(runner, root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.length > 0) throw failure('source_tree_dirty');
  for (let i = 0; i < SOURCE_TRACKED_FILES.length; i += 1) {
    const rel = SOURCE_TRACKED_FILES[i];
    runGit(runner, root, ['ls-files', '--error-unmatch', rel]);
    const joined = path.join(root, rel);
    let lstat;
    try {
      lstat = fs.lstatSync(joined);
    } catch (_) {
      throw failure('source_symlink_escape');
    }
    if (lstat.isSymbolicLink()) throw failure('source_symlink_escape');
    let abs;
    try {
      abs = fs.realpathSync(joined);
    } catch (_) {
      throw failure('source_symlink_escape');
    }
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (abs !== joined && abs.indexOf(rootPrefix) !== 0) {
      throw failure('source_symlink_escape');
    }
    if (abs.indexOf(rootPrefix) !== 0 && abs !== root) {
      throw failure('source_symlink_escape');
    }
  }
  return objectFreeze({ head, tree });
}

function snapshotReceiptStore(raw) {
  if (!raw || typeof raw !== 'object' || isProxySurface(raw) || arrayIsArray(raw)) return null;
  const pathValue = ownData(raw, 'path');
  const claim = ownData(raw, 'claim');
  const read = ownData(raw, 'read');
  const advance = ownData(raw, 'advance');
  const claimedInThisHandle = ownData(raw, 'claimedInThisHandle');
  if (typeof pathValue !== 'string' || !path.isAbsolute(pathValue)) return null;
  if (typeof claim !== 'function' || typeof read !== 'function' || typeof advance !== 'function') return null;
  void claimedInThisHandle;
  return raw;
}

function snapshotCommandRunner(raw) {
  if (!raw || typeof raw !== 'object' || isProxySurface(raw)) return null;
  const exec = ownData(raw, 'execFileSync');
  if (typeof exec !== 'function') return null;
  return objectFreeze({
    execFileSync: exec,
  });
}

async function closeHandle(handle) {
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) return;
  const methods = ['end', 'destroy', 'close'];
  for (let i = 0; i < methods.length; i += 1) {
    let fn = ownData(handle, methods[i]);
    if (typeof fn !== 'function' && typeof handle[methods[i]] === 'function') {
      fn = handle[methods[i]];
    }
    if (typeof fn !== 'function') continue;
    let result;
    try {
      result = fn.call(handle);
    } catch (_) {
      throw failure('cleanup_unproven');
    }
    if (result && typeof result.then === 'function') {
      let timeoutId;
      try {
        await Promise.race([
          Promise.resolve(result),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(failure('cleanup_unproven')), CLOSE_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        if (err && err.code === ERROR_CODE) throw err;
        throw failure('cleanup_unproven');
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    return;
  }
}

function sameGeneration(actual, expected) {
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) return false;
  if (typeof actual !== 'number' || !Number.isInteger(actual) || actual < 0) return false;
  return actual === expected;
}

function parseArgs(argv) {
  const args = arrayIsArray(argv) ? argv.slice() : [];
  const seen = objectCreate(null);
  const flags = objectCreate(null);
  flags.command = null;
  flags.deployment = null;
  flags.tenant = null;
  flags.database = null;
  flags.resourceGroup = null;
  flags.appName = null;
  flags.revision = null;
  flags.deploySha = null;
  flags.digest = null;
  flags.sourceSha = null;
  flags.sourceTree = null;
  flags.confirm = null;
  flags.operatorNonce = null;
  flags.confirmIssuedAt = null;
  flags.invalid = false;
  flags.invalidReason = null;
  function markSeen(name) {
    if (seen[name] === true) {
      flags.invalid = true;
      flags.invalidReason = 'duplicate_arg';
      return false;
    }
    seen[name] = true;
    return true;
  }
  function takeValue(name, i) {
    const value = args[i + 1];
    if (typeof value !== 'string' || value.length < 1 || value.startsWith('--')) {
      flags.invalid = true;
      flags.invalidReason = 'missing_arg_value';
      return i;
    }
    if (!markSeen(name)) return i + 1;
    flags[name] = value;
    return i + 1;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'unknown_or_hostile_arg';
      continue;
    }
    if (arg.includes('=')) {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'equals_form_refused';
      continue;
    }
    if (arg === '--target' || arg === '--execute-once') {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'target_refused';
      continue;
    }
    if (arg === COMMAND) {
      if (!markSeen('command')) continue;
      flags.command = COMMAND;
    } else if (arg === PREFLIGHT_COMMAND) {
      if (!markSeen('command')) continue;
      flags.command = PREFLIGHT_COMMAND;
    } else if (arg === '--deployment') {
      i = takeValue('deployment', i);
    } else if (arg === '--tenant') {
      i = takeValue('tenant', i);
    } else if (arg === '--database') {
      i = takeValue('database', i);
    } else if (arg === '--resource-group') {
      i = takeValue('resourceGroup', i);
    } else if (arg === '--app') {
      i = takeValue('appName', i);
    } else if (arg === '--revision') {
      i = takeValue('revision', i);
    } else if (arg === '--deploy-sha') {
      i = takeValue('deploySha', i);
    } else if (arg === '--digest') {
      i = takeValue('digest', i);
    } else if (arg === '--source-sha') {
      i = takeValue('sourceSha', i);
    } else if (arg === '--source-tree') {
      i = takeValue('sourceTree', i);
    } else if (arg === '--confirm') {
      i = takeValue('confirm', i);
    } else if (arg === '--operator-nonce') {
      i = takeValue('operatorNonce', i);
    } else if (arg === '--confirm-issued-at') {
      i = takeValue('confirmIssuedAt', i);
    } else {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'unknown_or_hostile_arg';
    }
  }
  if (flags.command !== COMMAND && flags.command !== PREFLIGHT_COMMAND && flags.invalid !== true) {
    flags.invalid = true;
    flags.invalidReason = 'unknown_or_hostile_arg';
  }
  return objectFreeze({
    command: flags.command,
    deployment: flags.deployment,
    tenant: flags.tenant,
    database: flags.database,
    resourceGroup: flags.resourceGroup,
    appName: flags.appName,
    revision: flags.revision,
    deploySha: flags.deploySha,
    digest: flags.digest,
    sourceSha: flags.sourceSha,
    sourceTree: flags.sourceTree,
    confirm: flags.confirm,
    operatorNonce: flags.operatorNonce,
    confirmIssuedAt: flags.confirmIssuedAt,
    invalid: flags.invalid === true,
    invalidReason: flags.invalidReason,
  });
}

function validatePinnedTarget(parsed) {
  if (parsed.deployment !== SUNSET_DEPLOYMENT) return 'deployment_mismatch';
  if (parsed.tenant !== SUNSET_TENANT) return 'tenant_mismatch';
  if (parsed.database !== EXPECTED_DATABASE) return 'database_mismatch';
  if (parsed.resourceGroup !== EXPECTED_LIVE_TARGET.resourceGroup) return 'azure_owner_mismatch';
  if (parsed.appName !== EXPECTED_LIVE_TARGET.appName) return 'azure_owner_mismatch';
  if (parsed.revision !== EXPECTED_LIVE_TARGET.revision) return 'revision_mismatch';
  if (parsed.deploySha !== EXPECTED_LIVE_TARGET.deployedSha) return 'deploy_sha_mismatch';
  if (parsed.digest !== EXPECTED_LIVE_TARGET.digest) return 'digest_mismatch';
  if (!sha40(parsed.sourceSha)) return 'source_sha_invalid';
  if (!sha40(parsed.sourceTree)) return 'source_tree_invalid';
  return null;
}

function validateExactInvocation(parsed, nowMs) {
  if (!parsed || parsed.invalid === true) {
    return parsed && parsed.invalidReason ? parsed.invalidReason : 'unknown_or_hostile_arg';
  }
  if (parsed.command !== COMMAND) return 'unknown_or_hostile_arg';
  const pins = validatePinnedTarget(parsed);
  if (pins) return pins;
  if (parsed.confirm !== CONFIRMATION_PHRASE) return 'confirmation_required';
  if (!validOperatorNonce(parsed.operatorNonce)) return 'operator_nonce_invalid';
  if (!validConfirmIssuedAt(parsed.confirmIssuedAt, nowMs)) return 'confirm_window_invalid';
  if (USED_OPERATOR_NONCES.has(parsed.operatorNonce)) return 'operator_nonce_replay';
  return null;
}

function validatePreflightInvocation(parsed) {
  if (!parsed || parsed.invalid === true) {
    return parsed && parsed.invalidReason ? parsed.invalidReason : 'unknown_or_hostile_arg';
  }
  if (parsed.command !== PREFLIGHT_COMMAND) return 'unknown_or_hostile_arg';
  return validatePinnedTarget(parsed);
}

function invocationFromParsed(parsed) {
  const obj = {};
  for (let i = 0; i < INVOCATION_KEYS.length; i += 1) {
    obj[INVOCATION_KEYS[i]] = parsed[INVOCATION_KEYS[i]];
  }
  return objectFreeze(obj);
}

function requirePinnedLiveOwner() {
  const resolved = require.resolve('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
  if (!resolved.replace(/\\/g, '/').endsWith('email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js')) {
    throw failure('independent_reader_absent');
  }
  if (typeof readerOwner.isIndependentLivePreflight !== 'function') {
    throw failure('independent_preflight_predicate_absent');
  }
  return readerOwner;
}

function sameIdentityFields(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < IDENTITY_FIELDS.length; i += 1) {
    const key = IDENTITY_FIELDS[i];
    if (ownData(a, key) !== ownData(b, key)) return false;
  }
  if (ownData(a, 'ops_097') !== 0 || ownData(b, 'ops_097') !== 0) return false;
  if (ownData(a, 'transitions_097') !== 0 || ownData(b, 'transitions_097') !== 0) return false;
  if (ownData(a, 'authorizations_098') !== 0 || ownData(b, 'authorizations_098') !== 0) return false;
  if (ownData(a, 'grant_status') !== 'active' || ownData(b, 'grant_status') !== 'active') return false;
  if (ownData(a, 'reconcile_state') !== 'clean' || ownData(b, 'reconcile_state') !== 'clean') return false;
  if (ownData(a, 'has_active_lease') !== false || ownData(b, 'has_active_lease') !== false) return false;
  if (ownData(a, 'flags_all_literal_false') !== true || ownData(b, 'flags_all_literal_false') !== true) {
    return false;
  }
  if (ownData(a, 'subscription_id') !== AZURE_OWNER.subscriptionId) return false;
  if (ownData(b, 'subscription_id') !== AZURE_OWNER.subscriptionId) return false;
  if (ownData(a, 'resource_group') !== EXPECTED_LIVE_TARGET.resourceGroup) return false;
  if (ownData(b, 'resource_group') !== EXPECTED_LIVE_TARGET.resourceGroup) return false;
  if (ownData(a, 'app_name') !== EXPECTED_LIVE_TARGET.appName) return false;
  if (ownData(b, 'app_name') !== EXPECTED_LIVE_TARGET.appName) return false;
  if (ownData(a, 'tenant') !== SUNSET_TENANT || ownData(b, 'tenant') !== SUNSET_TENANT) return false;
  if (ownData(a, 'database') !== EXPECTED_DATABASE || ownData(b, 'database') !== EXPECTED_DATABASE) {
    return false;
  }
  if (!isCanonUuid(ownData(a, 'client_id')) || !isCanonUuid(ownData(b, 'mailbox_id'))) return false;
  if (typeof ownData(a, 'producer_login_fingerprint') !== 'string') return false;
  if (typeof ownData(b, 'worker_login_fingerprint') !== 'string') return false;
  if (typeof ownData(a, 'traffic_weight') !== 'number') return false;
  if (typeof ownData(a, 'image_login_server') !== 'string') return false;
  if (typeof ownData(a, 'image_repository') !== 'string') return false;
  if (typeof ownData(a, 'image_tag') !== 'string') return false;
  return true;
}

function sameProofTarget(a, b, expectedGenerationA, expectedGenerationB) {
  if (!a || !b) return false;
  if (!sameGeneration(ownData(a, 'grant_generation'), expectedGenerationA)) return false;
  if (!sameGeneration(ownData(b, 'grant_generation'), expectedGenerationB)) return false;
  return sameIdentityFields(a, b);
}

function recheckBrandedEligibility(independent) {
  if (ownData(independent, 'ops_097') !== 0
      || ownData(independent, 'transitions_097') !== 0
      || ownData(independent, 'authorizations_098') !== 0) {
    throw failure('counts_nonzero');
  }
  if (ownData(independent, 'grant_status') !== 'active') throw failure('grant_ineligible');
  if (ownData(independent, 'reconcile_state') !== 'clean') throw failure('grant_ineligible');
  if (ownData(independent, 'has_active_lease') === true) throw failure('lease_held');
  if (ownData(independent, 'has_active_operation') === true) throw failure('counts_nonzero');
  if (ownData(independent, 'flags_all_literal_false') !== true) throw failure('flag_drift');
  if (ownData(independent, 'deploy_sha') !== EXPECTED_LIVE_TARGET.deployedSha) throw failure('deploy_sha_mismatch');
  if (ownData(independent, 'revision') !== EXPECTED_LIVE_TARGET.revision) throw failure('revision_mismatch');
  if (ownData(independent, 'digest') !== EXPECTED_LIVE_TARGET.digest) throw failure('digest_mismatch');
  if (ownData(independent, 'replica') !== 1) throw failure('replica_not_one');
  if (ownData(independent, 'traffic_weight') !== 100) throw failure('revision_drift');
  if (typeof ownData(independent, 'image_login_server') !== 'string'
      || ownData(independent, 'image_login_server').length < 1) {
    throw failure('image_unproven');
  }
  if (typeof ownData(independent, 'image_repository') !== 'string'
      || ownData(independent, 'image_repository').length < 1) {
    throw failure('image_unproven');
  }
  if (ownData(independent, 'image_tag') !== EXPECTED_LIVE_TARGET.deployedSha) {
    throw failure('deploy_sha_mismatch');
  }
  if (ownData(independent, 'subscription_id') !== AZURE_OWNER.subscriptionId) throw failure('azure_owner_mismatch');
  if (ownData(independent, 'resource_group') !== EXPECTED_LIVE_TARGET.resourceGroup) {
    throw failure('azure_owner_mismatch');
  }
  if (ownData(independent, 'app_name') !== EXPECTED_LIVE_TARGET.appName) throw failure('azure_owner_mismatch');
  if (ownData(independent, 'database') !== EXPECTED_DATABASE) throw failure('database_mismatch');
  if (ownData(independent, 'tenant') !== SUNSET_TENANT) throw failure('tenant_mismatch');
  const generation = ownData(independent, 'grant_generation');
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw failure('grant_unproven');
  }
  if (!isCanonUuid(ownData(independent, 'client_id'))
      || !isCanonUuid(ownData(independent, 'location_id'))
      || !isCanonUuid(ownData(independent, 'endpoint_id'))
      || !isCanonUuid(ownData(independent, 'mailbox_id'))) {
    throw failure('binding');
  }
  const producerFp = ownData(independent, 'producer_login_fingerprint');
  const workerFp = ownData(independent, 'worker_login_fingerprint');
  if (typeof producerFp !== 'string' || !/^[0-9a-f]{64}$/.test(producerFp)) throw failure('login_unproven');
  if (typeof workerFp !== 'string' || !/^[0-9a-f]{64}$/.test(workerFp)) throw failure('login_unproven');
  if (producerFp === workerFp) throw failure('login_alias');
}

async function inspectClosedClaims(createInspector, createSignatureVerifierFn, token, expected, counters) {
  if (typeof token !== 'string' || !token) throw failure('claims');
  counters.jwks += 1;
  const verifier = createSignatureVerifierFn();
  if (!verifier || typeof ownData(verifier, 'verify') !== 'function') throw failure('claims');
  const inspector = createInspector(objectFreeze({ signatureVerifier: verifier }));
  let summary;
  try {
    summary = await inspector.inspect(objectFreeze({
      accessToken: token,
      expectedTenantId: expected.expectedTenantId,
      expectedClientId: expected.expectedClientId,
      expectedPrincipalOid: expected.expectedPrincipalOid,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    }));
  } catch (err) {
    if (valueContainsSecret(err, token)) throw failure('claims');
    throw failure('claims');
  }
  const closed = copyClaimsSummary(summary);
  if (!closed || valueContainsSecret(closed, token) || valueContainsSecret(summary, token)) {
    throw failure('claims');
  }
  return closed;
}

function createOwnedSunsetStagingLiveExecutionOwner(input) {
  if (input && typeof input === 'object') {
    const depKeys = reflectOwnKeys(input);
    for (let i = 0; i < depKeys.length; i += 1) {
      if (arrayIncludes(FORBIDDEN_ADAPTER_KEYS, depKeys[i])) throw failure('caller_input_refused');
    }
  }
  if (!exactPlainData(input, ADAPTER_KEYS)) throw failure('reader_adapters');
  const readIndependentLivePreflight = ownData(input, 'readIndependentLivePreflight');
  const envelopeProviderInput = ownData(input, 'envelopeProvider');
  const createSecretProvider = ownData(input, 'createSecretProvider');
  const transport = ownData(input, 'transport');
  const createSignatureVerifier = ownData(input, 'createSignatureVerifier');
  const withPgClient = ownData(input, 'withPgClient');
  const binding = snapshotBinding(ownData(input, 'binding'));
  const applicationClientId = ownData(input, 'applicationClientId');
  const clock = ownData(input, 'clock');
  const receiptStore = snapshotReceiptStore(ownData(input, 'receiptStore'));
  const commandRunner = snapshotCommandRunner(ownData(input, 'commandRunner'));
  if (typeof readIndependentLivePreflight !== 'function' || isProxySurface(readIndependentLivePreflight)) {
    throw failure('reader_adapters');
  }
  if (typeof createSecretProvider !== 'function' || isProxySurface(createSecretProvider)) {
    throw failure('reader_adapters');
  }
  if (typeof createSignatureVerifier !== 'function' || isProxySurface(createSignatureVerifier)) {
    throw failure('reader_adapters');
  }
  if (typeof withPgClient !== 'function' || isProxySurface(withPgClient)) throw failure('reader_adapters');
  if (!binding) throw failure('binding');
  if (typeof applicationClientId !== 'string' || !isCanonUuid(applicationClientId)) {
    throw failure('application_client');
  }
  if (!clock || typeof ownData(clock, 'nowMs') !== 'function') throw failure('reader_adapters');
  if (!receiptStore) throw failure('reader_adapters');
  if (!commandRunner) throw failure('reader_adapters');
  const prov = validateEmailGrantEnvelopeProvider(envelopeProviderInput);
  if (!prov.ok) throw failure('reader_adapters');
  const envelopeProvider = prov.value;
  if (!exactSealedTransport(transport)) throw failure('reader_adapters');

  const counters = {
    reader: 0,
    kv: 0,
    token: 0,
    jwks: 0,
    custodyPg: 0,
    graph: 0,
    send: 0,
    receiptWrites: 0,
    custodyWrites: 0,
  };
  const acquiredHandles = [];
  let used = false;
  const liveOwner = requirePinnedLiveOwner();

  const countedTransport = objectFreeze({
    async postTokenForm(arg) {
      counters.token += 1;
      return ownData(transport, 'postTokenForm').call(transport, arg);
    },
  });
  acquiredHandles.push(transport);

  function wrapEnvelope(provider) {
    return objectFreeze({
      async sealGrantPayload(arg) {
        counters.kv += 1;
        return provider.sealGrantPayload(arg);
      },
      openGrantPayload(...args) {
        counters.kv += 1;
        return provider.openGrantPayload(...args);
      },
      rewrapGrantDek(...args) {
        counters.kv += 1;
        return provider.rewrapGrantDek(...args);
      },
    });
  }
  const countedEnvelope = wrapEnvelope(envelopeProvider);

  function countedSecretProvider() {
    const secretProvider = createSecretProvider();
    if (!secretProvider
        || objectGetPrototypeOf(secretProvider) !== Object.prototype
        || typeof ownData(secretProvider, 'getClientSecret') !== 'function') {
      throw failure('secret');
    }
    const inner = ownData(secretProvider, 'getClientSecret');
    return objectFreeze({
      async getClientSecret() {
        counters.kv += 1;
        return inner.call(secretProvider);
      },
    });
  }

  async function readBranded() {
    counters.reader += 1;
    let independent;
    try {
      independent = await readIndependentLivePreflight();
    } catch (err) {
      refuseDetail(err, 'live_preflight_unproven');
    }
    const branded = inspectIndependentLivePreflight(liveOwner, independent);
    if (!branded || branded.ok !== true) {
      throw failure((branded && branded.reason) || 'live_preflight_unproven');
    }
    return independent;
  }

  function trackHandle(handle) {
    if (handle && (typeof handle === 'object' || typeof handle === 'function')) {
      acquiredHandles.push(handle);
    }
    return handle;
  }

  function terminalRecord(status, ok, extra) {
    const refresh = counters.token;
    const fields = {
      proof_version: PROOF_VERSION,
      ok: ok === true,
      status,
      deployment: SUNSET_DEPLOYMENT,
      tenant: SUNSET_TENANT,
      database: EXPECTED_DATABASE,
      resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
      app_name: EXPECTED_LIVE_TARGET.appName,
      source_sha: extra && extra.source_sha ? extra.source_sha : null,
      source_tree: extra && extra.source_tree ? extra.source_tree : null,
      deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
      revision: EXPECTED_LIVE_TARGET.revision,
      digest: EXPECTED_LIVE_TARGET.digest,
      preflight_started_at: extra && extra.preflight_started_at ? extra.preflight_started_at : null,
      preflight_finished_at: extra && extra.preflight_finished_at ? extra.preflight_finished_at : null,
      fence_generation: extra && extra.fence_generation !== undefined ? extra.fence_generation : null,
      downscope_mail_send_absent: extra && extra.downscope_mail_send_absent !== undefined
        ? extra.downscope_mail_send_absent
        : null,
      continuity_expected_scope_present: extra && extra.continuity_expected_scope_present !== undefined
        ? extra.continuity_expected_scope_present
        : null,
      refresh_call_count: refresh,
      graph_call_count: 0,
      send_call_count: 0,
      local_receipt_write_count: counters.receiptWrites,
      custody_write_count: counters.custodyWrites,
      operational_write_count: 0,
      compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
    };
    return machineRecord(fields);
  }

  async function executeOnce(parsed) {
    if (used) throw failure('one_shot_already_consumed');
    used = true;
    const gate = validateExactInvocation(parsed, ownData(clock, 'nowMs')());
    if (gate) throw failure(gate);
    assertExecutingSource(parsed.sourceSha, parsed.sourceTree, commandRunner);
    const alreadyClaimed = typeof receiptStore.claimedInThisHandle === 'function'
      && receiptStore.claimedInThisHandle() === true;
    if (alreadyClaimed !== true) {
      const existingReceipt = receiptStore.read();
      if (existingReceipt) throw failure('operator_receipt_replay');
      const claimedAt = new Date(ownData(clock, 'nowMs')()).toISOString();
      receiptStore.claim(objectFreeze({
        chapter_id: chapter4IReceipt.CHAPTER_ID,
        source_sha: parsed.sourceSha,
        source_tree: parsed.sourceTree,
        deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
        revision: EXPECTED_LIVE_TARGET.revision,
        digest: EXPECTED_LIVE_TARGET.digest,
        deployment: SUNSET_DEPLOYMENT,
        tenant: SUNSET_TENANT,
        database: EXPECTED_DATABASE,
        resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
        app_name: EXPECTED_LIVE_TARGET.appName,
        operator_nonce: parsed.operatorNonce,
        confirm_issued_at: parsed.confirmIssuedAt,
        status: RECEIPT_STATES.claimed,
        refresh_call_count: 0,
        local_receipt_write_count: 1,
        custody_write_count: 0,
        operational_write_count: 0,
        claimed_at: claimedAt,
        updated_at: claimedAt,
      }));
      counters.receiptWrites += 1;
    } else {
      const existingReceipt = receiptStore.read();
      if (!existingReceipt || ownData(existingReceipt, 'status') !== RECEIPT_STATES.claimed) {
        throw failure('operator_receipt_replay');
      }
      counters.receiptWrites += typeof ownData(existingReceipt, 'local_receipt_write_count') === 'number'
        ? ownData(existingReceipt, 'local_receipt_write_count')
        : 1;
    }
    USED_OPERATOR_NONCES.add(parsed.operatorNonce);

    let independent;
    try {
      independent = await readBranded();
    } catch (err) {
      refuseDetail(err, 'live_preflight_unproven');
    }
    recheckBrandedEligibility(independent);
    const initialGeneration = ownData(independent, 'grant_generation');
    if (typeof initialGeneration !== 'number' || !Number.isInteger(initialGeneration) || initialGeneration < 0) {
      throw failure('grant_unproven');
    }
    const startedAt = ownData(independent, 'started_at');

    let downscopeMailSendAbsent = null;
    let continuityExpectedScopePresent = null;
    let cleanupInstalled = false;
    let cleanupFailed = false;
    let tokensDropped = false;
    let secretProviderHandle = null;
    let verifierHandle = null;

    function dropTokens() {
      tokensDropped = true;
      secretProviderHandle = null;
      verifierHandle = null;
    }

    function installCleanup() {
      cleanupInstalled = true;
      return async function runCleanup() {
        dropTokens();
        for (let i = 0; i < acquiredHandles.length; i += 1) {
          try {
            await closeHandle(acquiredHandles[i]);
          } catch (_) {
            cleanupFailed = true;
          }
        }
        acquiredHandles.length = 0;
      };
    }

    const runCleanup = installCleanup();

    function advanceReceipt(status, extra) {
      const next = receiptStore.advance(status, Object.assign({
        refresh_call_count: counters.token,
        custody_write_count: counters.custodyWrites,
        operational_write_count: 0,
      }, extra || {}));
      counters.receiptWrites += 1;
      return next;
    }

    try {
      if (cleanupInstalled !== true) throw failure('cleanup_unproven');

      const toctouBeforeDownscope = await readBranded();
      recheckBrandedEligibility(toctouBeforeDownscope);
      if (!sameProofTarget(independent, toctouBeforeDownscope, initialGeneration, initialGeneration)) {
        throw failure('revision_drift');
      }

      const result = await withPgClient(async (client) => {
        counters.custodyPg += 1;
        trackHandle(client);
        if (!client || typeof client !== 'object' || typeof client.query !== 'function') {
          throw failure('grant_ineligible');
        }
        const ids = objectFreeze({
          clientId: binding.clientId,
          endpointId: binding.endpointId,
        });
        const prior = await getDelegatedGrantPublicStatus({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
        }, { client });
        if (!prior.ok) throw failure('grant_ineligible');
        const priorDto = prior.value;
        if (!priorDto.grant_present) throw failure('grant_ineligible');
        if (priorDto.grant_status === 'reauthorization_required' || priorDto.grant_status === 'revoked') {
          throw failure('grant_ineligible');
        }
        if (priorDto.grant_status === 'lease_held' || priorDto.has_active_lease === true) {
          throw failure('lease_held');
        }
        if (priorDto.reconcile_state && priorDto.reconcile_state !== 'clean') {
          throw failure('grant_ineligible');
        }
        if (priorDto.grant_status !== 'active') throw failure('grant_ineligible');

        const bound = await resolveDelegatedReadAuthorityBinding({
          clientId: binding.clientId,
          locationId: binding.locationId,
          endpointId: binding.endpointId,
        }, { client });
        if (!bound.ok
            || !bound.value
            || bound.value.provider !== 'microsoft_graph'
            || bound.value.providerMailboxId !== binding.mailboxId
            || bound.value.bindingStatus !== 'verified'
            || !isCanonUuid(bound.value.providerPrincipalOid)) {
          throw failure('binding');
        }

        advanceReceipt(RECEIPT_STATES.refresh_1_started);
        let downscope;
        try {
          downscope = await runDownscope(client, ids, bound.value, countedSecretProvider, countedEnvelope, countedTransport, counters);
        } catch (err) {
          if (counters.token >= 1) {
            throw failure('outcome_unknown');
          }
          refuseDetail(err, 'token');
        }
        if (!downscope || downscope.claims.mail_send !== false) throw failure('claims');
        downscopeMailSendAbsent = true;
        advanceReceipt(RECEIPT_STATES.refresh_1_completed, {
          fence_generation: downscope.generation,
        });

        const expectedContinuityGeneration = downscope.rotated === true
          ? initialGeneration + 1
          : initialGeneration;
        if (typeof expectedContinuityGeneration !== 'number'
            || !Number.isInteger(expectedContinuityGeneration)) {
          throw failure('grant_unproven');
        }
        const toctouBeforeContinuity = await readBranded();
        recheckBrandedEligibility(toctouBeforeContinuity);
        if (!sameProofTarget(independent, toctouBeforeContinuity, initialGeneration, expectedContinuityGeneration)
            || !sameProofTarget(toctouBeforeDownscope, toctouBeforeContinuity, initialGeneration, expectedContinuityGeneration)) {
          throw failure('revision_drift');
        }

        advanceReceipt(RECEIPT_STATES.refresh_2_started);
        let continuity;
        try {
          continuity = await runContinuity(client, ids, bound.value, countedSecretProvider, countedEnvelope, countedTransport, counters);
        } catch (err) {
          if (counters.token >= 1) {
            throw failure('outcome_unknown');
          }
          refuseDetail(err, 'continuity');
        }
        if (!continuity || continuity.claims.mail_send !== true) throw failure('claims');
        if (continuity.claims.scp !== EXPECTED_STAFF_SEND_SCP) throw failure('claims');
        continuityExpectedScopePresent = true;
        advanceReceipt(RECEIPT_STATES.refresh_2_completed);

        if (counters.token !== 2) throw failure('refresh_call_count');
        if (counters.graph !== 0) throw failure('graph_forbidden');
        if (counters.send !== 0) throw failure('send_forbidden');

        return objectFreeze({
          downscope,
          continuity,
          finishedAt: ownData(toctouBeforeContinuity, 'finished_at'),
        });
      });

      dropTokens();
      try {
        await runCleanup();
      } catch (_) {
        cleanupFailed = true;
      }
      if (cleanupFailed === true) {
        try {
          advanceReceipt(RECEIPT_STATES.terminal_unknown);
        } catch (_) {
          counters.receiptWrites += 0;
        }
        return terminalRecord('outcome_unknown', false, {
          source_sha: parsed.sourceSha,
          source_tree: parsed.sourceTree,
          preflight_started_at: startedAt,
          fence_generation: initialGeneration,
          downscope_mail_send_absent: downscopeMailSendAbsent,
          continuity_expected_scope_present: continuityExpectedScopePresent,
        });
      }
      advanceReceipt(RECEIPT_STATES.terminal_success);
      return terminalRecord('offline_fake_pass', true, {
        source_sha: parsed.sourceSha,
        source_tree: parsed.sourceTree,
        preflight_started_at: startedAt,
        preflight_finished_at: result.finishedAt,
        fence_generation: initialGeneration,
        downscope_mail_send_absent: true,
        continuity_expected_scope_present: true,
      });
    } catch (err) {
      try {
        await runCleanup();
      } catch (_) {
        cleanupFailed = true;
      }
      const postToken = counters.token >= 1;
      const status = (postToken || (err && err.detail === 'outcome_unknown') || cleanupFailed === true)
        ? 'outcome_unknown'
        : 'fail_closed';
      try {
        advanceReceipt(status === 'outcome_unknown'
          ? RECEIPT_STATES.terminal_unknown
          : RECEIPT_STATES.terminal_refused);
      } catch (_) {
        cleanupFailed = true;
      }
      if (postToken || (err && err.code === ERROR_CODE && err.detail === 'outcome_unknown') || cleanupFailed === true) {
        return terminalRecord('outcome_unknown', false, {
          source_sha: parsed.sourceSha,
          source_tree: parsed.sourceTree,
          preflight_started_at: startedAt,
          fence_generation: initialGeneration,
          downscope_mail_send_absent: downscopeMailSendAbsent,
          continuity_expected_scope_present: continuityExpectedScopePresent,
        });
      }
      if (err && err.code === ERROR_CODE) throw err;
      throw failure('reader_invalid');
    } finally {
      try {
        await runCleanup();
      } catch (_) {
        cleanupFailed = true;
      }
      dropTokens();
      void tokensDropped;
      void secretProviderHandle;
      void verifierHandle;
    }
  }

  async function runDownscope(client, ids, boundValue, secretFactory, envelope, transportOwner, countBag) {
    let lease = null;
    let openedOwner = null;
    let refreshToken = null;
    let accessCandidate = null;
    let accessTokenOwner = null;
    let refreshToSeal = null;
    let classified = null;
    let selectedOwner = null;
    let sealedOwner = null;
    let refreshTokenOmitted = false;
    let receivedRotatingRefresh = false;
    let suppressLeaseAbort = false;
    let claimsSummary = null;
    let generationAfter = null;

    function dropTokenRefs() {
      accessCandidate = null;
      accessTokenOwner = null;
      refreshToken = null;
      refreshToSeal = null;
      classified = null;
      selectedOwner = null;
      sealedOwner = null;
      openedOwner = null;
    }

    async function safeAbort(held) {
      if (!held) return;
      try {
        await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: held.lease_token,
          expectedGeneration: held.grant_generation,
        }, { client });
        counters.custodyWrites += 1;
      } catch (_) { /* sanitized */ }
    }

    async function refuseAfterRotatingMicrosoftResponse(stage, detailCode) {
      const held = lease;
      lease = null;
      suppressLeaseAbort = true;
      dropTokenRefs();
      void stage;
      void detailCode;
      if (!held) throw failure('outcome_unknown');
      try {
        await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: held.lease_token,
          expectedGeneration: held.grant_generation,
        }, { client });
        counters.custodyWrites += 1;
      } catch (_) { /* sanitized */ }
      throw failure('outcome_unknown');
    }

    async function refuseBeforeCommit(stage) {
      if (receivedRotatingRefresh === true) {
        await refuseAfterRotatingMicrosoftResponse(stage, ROTATING_RESPONSE_UNCERTAINTY_DETAILS[stage]);
      }
      dropTokenRefs();
      await safeAbort(lease);
      lease = null;
      throw failure(stage);
    }

    try {
      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId: DOWNSCOPE_WORKER_ID,
      }, { client });
      if (!acquired.ok) throw failure('lease_held');
      lease = acquired.value;
      counters.custodyWrites += 1;
      if (!acceptedGrantScope(lease.scope_version)) {
        await safeAbort(lease);
        lease = null;
        throw failure('grant_ineligible');
      }

      openedOwner = await openDelegatedGrantUnderLease(lease, { client, envelopeProvider: envelope });
      if (!openedOwner.ok
          || !openedOwner.value
          || typeof openedOwner.value.refresh_token !== 'string') {
        await safeAbort(lease);
        lease = null;
        throw failure('open');
      }
      refreshToken = openedOwner.value.refresh_token;
      openedOwner = null;

      const secretProvider = secretFactory();
      const exchange = createMicrosoftRefreshTokenRequestService(objectFreeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId,
        secretProvider,
        transport: transportOwner,
      }));
      try {
        classified = await exchange.exchangeRefreshToken(objectFreeze({
          refreshToken,
          scopeVersion: SCOPE_PROFILE_ID,
        }));
      } catch (exchangeErr) {
        const refreshNote = readTrustedMicrosoftRefreshTokenRequestStage(exchangeErr);
        const exchangeStage = refreshNote && refreshNote.stage ? refreshNote.stage : 'token';
        if (exchangeStage === 'secret') {
          dropTokenRefs();
          await safeAbort(lease);
          lease = null;
          throw failure('secret');
        }
        await refuseAfterRotatingMicrosoftResponse(
          exchangeStage === 'response' ? 'response' : 'token',
          exchangeStage === 'response' ? 'ms_refresh_uncertain' : 'ms_refresh_transport',
        );
      }

      if (classified.kind === 'invalid_grant') {
        dropTokenRefs();
        const held = lease;
        suppressLeaseAbort = true;
        lease = null;
        if (!held) throw failure('grant_ineligible');
        try {
          await abortDelegatedGrantLease({
            clientId: ids.clientId,
            endpointId: ids.endpointId,
            leaseToken: held.lease_token,
            expectedGeneration: held.grant_generation,
          }, { client });
          counters.custodyWrites += 1;
        } catch (_) { /* sanitized */ }
        throw failure('grant_ineligible');
      }

      if (classified.kind !== 'success' || !classified.selected) {
        classified = null;
        await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
      }

      try {
        selectedOwner = classified.selected;
        classified = null;
        if (selectedOwner
            && typeof selectedOwner.accessToken === 'string'
            && selectedOwner.accessToken) {
          accessCandidate = selectedOwner.accessToken;
        }
        if (typeof accessCandidate !== 'string' || !accessCandidate) {
          accessCandidate = null;
          await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
        }
        accessTokenOwner = accessCandidate;
        accessCandidate = null;

        if (selectedOwner.refreshTokenOmitted === true) {
          if (typeof refreshToken !== 'string' || !refreshToken) {
            accessTokenOwner = null;
            await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
          }
          refreshTokenOmitted = true;
          receivedRotatingRefresh = false;
          refreshToSeal = null;
        } else if (selectedOwner.refreshTokenOmitted === false
            && typeof selectedOwner.refreshToken === 'string'
            && selectedOwner.refreshToken) {
          refreshTokenOmitted = false;
          receivedRotatingRefresh = true;
          refreshToSeal = selectedOwner.refreshToken;
        } else {
          accessTokenOwner = null;
          await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
        }
      } finally {
        classified = null;
        selectedOwner = null;
        accessCandidate = null;
      }
      refreshToken = null;

      try {
        claimsSummary = await inspectClosedClaims(
          createControlledDraftingAccessTokenClaimsInspector,
          createSignatureVerifier,
          accessTokenOwner,
          {
            expectedTenantId: boundValue.providerTenantId,
            expectedClientId: applicationClientId,
            expectedPrincipalOid: boundValue.providerPrincipalOid,
          },
          countBag,
        );
      } catch (_) {
        await refuseBeforeCommit('claims');
      }
      if (!claimsSummary
          || claimsSummary.mail_send !== false
          || claimsSummary.scp !== EXPECTED_DOWNSCOPE_SCP
          || claimsSummary.app_only !== false) {
        await refuseBeforeCommit('claims');
      }
      accessTokenOwner = null;

      if (refreshTokenOmitted === true) {
        const released = await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
        }, { client });
        counters.custodyWrites += 1;
        if (!released.ok) throw failure('release');
        generationAfter = lease.grant_generation;
        lease = null;
        refreshToSeal = null;
      } else {
        const nextOperationId = crypto.randomUUID();
        const nextGeneration = lease.grant_generation + 1;
        let aad;
        try {
          aad = buildGrantEnvelopeAadV1({
            clientId: ids.clientId,
            endpointId: ids.endpointId,
            grantGeneration: nextGeneration,
            operationId: nextOperationId,
          });
        } catch (_) {
          await refuseBeforeCommit('reseal');
        }
        try {
          sealedOwner = await envelope.sealGrantPayload({
            refresh_token: refreshToSeal,
            aad,
            operation_id: nextOperationId,
          });
        } catch (_) {
          await refuseBeforeCommit('reseal');
        } finally {
          refreshToSeal = null;
        }
        const envCheck = validateGrantEnvelopeRecordV1(sealedOwner);
        sealedOwner = null;
        if (!envCheck.ok) await refuseBeforeCommit('reseal');
        const committed = await commitDelegatedGrantRotation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          operationId: nextOperationId,
          envelope: envCheck.value,
        }, { client });
        counters.custodyWrites += 1;
        if (!committed.ok) await refuseBeforeCommit('commit');
        generationAfter = nextGeneration;
        lease = null;
        receivedRotatingRefresh = false;
      }

      return objectFreeze({
        claims: claimsSummary,
        generation: generationAfter,
        rotated: refreshTokenOmitted !== true,
        principal_oid_fingerprint: digestUtf8(boundValue.providerPrincipalOid),
        mailbox_id_fingerprint: digestUtf8(boundValue.providerMailboxId),
      });
    } catch (err) {
      if (!suppressLeaseAbort) await safeAbort(lease);
      lease = null;
      if (err && err.code === ERROR_CODE) throw err;
      throw failure('token');
    } finally {
      accessCandidate = null;
      accessTokenOwner = null;
      refreshToken = null;
      refreshToSeal = null;
      classified = null;
      selectedOwner = null;
      sealedOwner = null;
      openedOwner = null;
    }
  }

  async function runContinuity(client, ids, boundValue, secretFactory, envelope, transportOwner, countBag) {
    const secretProvider = secretFactory();
    const session = createDelegatedGrantAccessSession(objectFreeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId,
      client,
      envelopeProvider: envelope,
      secretProvider,
      transport: transportOwner,
      workerId: CONTINUITY_WORKER_ID,
    }));
    let result;
    try {
      result = await session.runWithAccessTokenOnce(
        objectFreeze({ clientId: ids.clientId, endpointId: ids.endpointId }),
        async (loan) => {
          let token = null;
          try {
            if (!loan || typeof loan !== 'object' || isProxySurface(loan)) {
              return objectFreeze({ ok: false, stage: 'continuity' });
            }
            token = ownData(loan, 'accessToken');
            const summary = await inspectClosedClaims(
              createStaffSendPhaseBAccessTokenClaimsInspector,
              createSignatureVerifier,
              token,
              {
                expectedTenantId: boundValue.providerTenantId,
                expectedClientId: applicationClientId,
                expectedPrincipalOid: boundValue.providerPrincipalOid,
              },
              countBag,
            );
            if (!summary
                || summary.mail_send !== true
                || summary.scp !== EXPECTED_STAFF_SEND_SCP
                || summary.app_only !== false
                || valueContainsSecret(summary, token)) {
              return objectFreeze({ ok: false, stage: 'claims' });
            }
            return objectFreeze({ ok: true, claims: summary });
          } catch (_) {
            return objectFreeze({ ok: false, stage: 'claims' });
          } finally {
            try { if (loan) loan.accessToken = null; } catch (_) { /* sanitized */ }
            token = null;
          }
        },
      );
    } catch (_) {
      throw failure('continuity');
    }
    if (!result || result.ok !== true) {
      const status = result && result.status;
      if (status === 'reauthorization_required') throw failure('grant_ineligible');
      if (status === 'uncertain') throw failure('outcome_unknown');
      throw failure('continuity');
    }
    const inner = result.value;
    if (!inner || inner.ok !== true) throw failure((inner && inner.stage) || 'continuity');
    const summary = copyClaimsSummary(inner.claims);
    if (!summary) throw failure('continuity');
    return objectFreeze({
      claims: summary,
      generation: result.grant_generation,
    });
  }

  return objectFreeze({
    executeOnce,
    counters,
  });
}

function runLocalPreflight(parsed, env, runner) {
  if (refusedProduction(env || {})) return refusedRecord('production_or_wolfhouse_refused');
  if (proxyPresent(env || {})) return refusedRecord('proxy_refused');
  if (envAliasPresent(env || {})) return refusedRecord('env_alias_refused');
  const gate = validatePreflightInvocation(parsed);
  if (gate) {
    return refusedRecord(gate, { source_sha: parsed.sourceSha, source_tree: parsed.sourceTree });
  }
  try {
    assertExecutingSource(parsed.sourceSha, parsed.sourceTree, runner, env);
  } catch (err) {
    const detail = err && err.detail ? err.detail : 'source_sha_mismatch';
    return refusedRecord(detail, {
      source_sha: parsed.sourceSha,
      source_tree: parsed.sourceTree,
    });
  }
  try {
    chapter4IReceipt.inspectReceiptPath(chapter4IReceipt.OPERATOR_RECEIPT_PATH);
  } catch (err) {
    const detail = err && err.detail ? err.detail : 'operator_receipt_unproven';
    return refusedRecord(detail, {
      source_sha: parsed.sourceSha,
      source_tree: parsed.sourceTree,
    });
  }
  return machineRecord({
    proof_version: PROOF_VERSION,
    ok: true,
    status: 'preflight_ok',
    deployment: SUNSET_DEPLOYMENT,
    tenant: SUNSET_TENANT,
    database: EXPECTED_DATABASE,
    resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
    app_name: EXPECTED_LIVE_TARGET.appName,
    source_sha: parsed.sourceSha,
    source_tree: parsed.sourceTree,
    deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
    revision: EXPECTED_LIVE_TARGET.revision,
    digest: EXPECTED_LIVE_TARGET.digest,
    preflight_started_at: null,
    preflight_finished_at: null,
    fence_generation: null,
    downscope_mail_send_absent: null,
    continuity_expected_scope_present: null,
    refresh_call_count: 0,
    graph_call_count: 0,
    send_call_count: 0,
    local_receipt_write_count: 0,
    custody_write_count: 0,
    operational_write_count: 0,
    compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
  });
}

function refuseLocalCli(argv, env) {
  const parsed = parseArgs(argv);
  if (parsed.invalid === true) {
    return refusedRecord(parsed.invalidReason || 'unknown_or_hostile_arg');
  }
  if (refusedProduction(env || {})) return refusedRecord('production_or_wolfhouse_refused');
  if (proxyPresent(env || {})) return refusedRecord('proxy_refused');
  if (envAliasPresent(env || {})) return refusedRecord('env_alias_refused');
  if (parsed.command === PREFLIGHT_COMMAND) {
    const gate = validatePreflightInvocation(parsed);
    if (gate) return refusedRecord(gate, { source_sha: parsed.sourceSha, source_tree: parsed.sourceTree });
    return machineRecord({
      proof_version: PROOF_VERSION,
      ok: true,
      status: 'preflight_ok',
      deployment: SUNSET_DEPLOYMENT,
      tenant: SUNSET_TENANT,
      database: EXPECTED_DATABASE,
      resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
      app_name: EXPECTED_LIVE_TARGET.appName,
      source_sha: parsed.sourceSha,
      source_tree: parsed.sourceTree,
      deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
      revision: EXPECTED_LIVE_TARGET.revision,
      digest: EXPECTED_LIVE_TARGET.digest,
      preflight_started_at: null,
      preflight_finished_at: null,
      fence_generation: null,
      downscope_mail_send_absent: null,
      continuity_expected_scope_present: null,
      refresh_call_count: 0,
      graph_call_count: 0,
      send_call_count: 0,
      local_receipt_write_count: 0,
      custody_write_count: 0,
      operational_write_count: 0,
      compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
    });
  }
  const gate = validateExactInvocation(parsed);
  if (gate) return refusedRecord(gate, { source_sha: parsed.sourceSha, source_tree: parsed.sourceTree });
  return refusedRecord('cli_main_required', {
    source_sha: parsed.sourceSha,
    source_tree: parsed.sourceTree,
  });
}

async function runCli(argv, env) {
  return refuseLocalCli(argv, env);
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  PROOF_VERSION,
  CONFIRMATION_PHRASE,
  COMMAND,
  PREFLIGHT_COMMAND,
  INVOCATION_KEYS,
  ADAPTER_KEYS,
  MACHINE_RECORD_KEYS,
  ENV_ALIAS_KEYS,
  SOURCE_TRACKED_FILES,
  PRODUCTION_DRIVER_REL,
  AZURE_OWNER,
  EXPECTED_LIVE_TARGET,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  createOwnedSunsetStagingLiveExecutionOwner,
  parseArgs,
  runCli,
  refuseLocalCli,
  runLocalPreflight,
  validateExactInvocation,
  validatePreflightInvocation,
  validatePinnedTarget,
  refusedRecord,
  machineRecord,
  assertExecutingSource,
  forbiddenGitEnvPresent,
  invocationFromParsed,
  refusedProduction,
  proxyPresent,
  envAliasPresent,
});
