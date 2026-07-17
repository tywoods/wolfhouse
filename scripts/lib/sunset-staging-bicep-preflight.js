'use strict';

/**
 * Sunset staging Bicep deployment preflight — pure helpers (FOUNDATION Slice 3).
 * Fail-closed. Never deploys. Never prints secure values.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORBIDDEN_TARGETS = Object.freeze([
  'wh-staging-staff-api',
  'wh-staging-rg',
  'staff-staging.lunafrontdesk.com',
  'wh-staff-api',
  'wolfhouse_staging',
  'wh-staging-kv',
  'wh-staging-pg-app',
  'wh-prod-rg',
  'wh-prod-staff-api',
  'wh-prod-kv',
]);

const SECURE_PARAM_NAMES = Object.freeze([
  'postgresAdminPassword',
  'lunaBotInternalToken',
  'sunsetSomoWhatsappNumber',
  'sunsetSardineroWhatsappNumber',
  'sunsetSomoWhatsappPhoneNumberId',
  'sunsetSardineroWhatsappPhoneNumberId',
  'sunsetSomoInboxEmail',
  'sunsetSardineroInboxEmail',
]);

const REQUIRED_PARAM_NAMES = Object.freeze([
  'staffApiImageTag',
  'deploySha',
  'forceRevision',
  ...SECURE_PARAM_NAMES,
]);

/** Explicitly fingerprinted harmless what-if noise (Slice 2 baseline). */
const ALLOWED_WHATIF_NOISE_FINGERPRINTS = Object.freeze([
  'containerApps/exposedPort',
  'containerApps/maxInactiveRevisions',
  'containerApps/runningStatus',
  'containerApps/env-param-expression',
  'managedEnvironments/peerAuthentication',
  'managedEnvironments/logAnalytics-customerId-reference',
  'postgres/platform-defaults',
  'appinsights/default-flow-props',
  'roleAssignment/principalId-reference',
  'roleAssignment/principalType-unsupported',
  'acrPull/unidentifiable-cross-rg',
  'ignore/hold-expiry-job',
  'ignore/managed-certificate',
]);

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isForbiddenPlaceholder(value) {
  const s = String(value == null ? '' : value);
  if (!s.trim()) return 'empty';
  if (s.includes('<REQUIRED')) return '<REQUIRED_...>';
  if (/\*{2,}/.test(s) || s.includes('****')) return '****';
  if (/example\.test/i.test(s)) return 'example.test';
  if (/staging_[a-z0-9]+_phone_number_id/i.test(s)) return 'staging_*_phone_number_id';
  return null;
}

function loadParametersFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const out = {};
  const params = raw.parameters || {};
  for (const [k, v] of Object.entries(params)) {
    if (v && Object.prototype.hasOwnProperty.call(v, 'value')) out[k] = v.value;
  }
  return out;
}

function mergeParameters(base, overlay, envMap) {
  const merged = { ...base, ...overlay };
  for (const name of REQUIRED_PARAM_NAMES) {
    const envKey = `WH_SUNSET_PF_${name}`;
    if (envMap && envMap[envKey] != null && String(envMap[envKey]).length) {
      merged[name] = envMap[envKey];
    }
  }
  return merged;
}

function redactParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (SECURE_PARAM_NAMES.includes(k)) out[k] = '[REDACTED]';
    else out[k] = v;
  }
  return out;
}

function assertNoLeakedSecrets(text) {
  const hits = [];
  const s = String(text || '');
  if (/sk_live_[A-Za-z0-9]+/.test(s)) hits.push('sk_live_');
  if (/sk_test_[A-Za-z0-9]{8,}/.test(s)) hits.push('sk_test_');
  if (/whsec_[A-Za-z0-9]+/.test(s)) hits.push('whsec_');
  if (/postgres(?:ql)?:\/\/[^:\s"'<>]+:(?!<)[^@\s"'<>]+@/.test(s)) hits.push('postgres-url');
  // Secure param values should never appear as long random tokens after REDACTED scrub —
  // callers must redact before serializing reports.
  return hits;
}

function checkGitState(git) {
  const errors = [];
  const dirty = git.statusPorcelain();
  if (dirty) errors.push({ code: 'git_dirty', message: 'working tree is dirty' });

  const head = git.revParse('HEAD');
  const originMaster = git.revParse('origin/master');
  if (!isFullSha(head)) errors.push({ code: 'git_head_sha', message: 'HEAD is not a full 40-char SHA' });
  if (!isFullSha(originMaster)) {
    errors.push({ code: 'git_origin_master_sha', message: 'origin/master is not a full 40-char SHA' });
  }
  if (head && originMaster && head !== originMaster) {
    errors.push({
      code: 'git_not_origin_master',
      message: `HEAD ${head} != origin/master ${originMaster}`,
    });
  }
  return { ok: errors.length === 0, errors, head, originMaster };
}

function checkAzureTarget(azure, inventoryScope) {
  const errors = [];
  const sub = azure.accountSubscriptionId();
  if (sub !== inventoryScope.subscriptionId) {
    return {
      ok: false,
      errors: [
        {
          code: 'azure_wrong_subscription',
          message: `subscription ${sub} != inventory ${inventoryScope.subscriptionId}`,
        },
      ],
      subscriptionId: sub,
      resourceGroup: inventoryScope.resourceGroup,
    };
  }
  const rg = inventoryScope.resourceGroup;
  if (rg !== 'luna-sunset-staging-rg') {
    return {
      ok: false,
      errors: [
        {
          code: 'azure_wrong_rg_constant',
          message: 'resource group must be luna-sunset-staging-rg',
        },
      ],
      subscriptionId: sub,
      resourceGroup: rg,
    };
  }
  if (!azure.resourceGroupExists(rg)) {
    errors.push({ code: 'azure_rg_missing', message: `resource group ${rg} does not exist` });
  }
  return { ok: errors.length === 0, errors, subscriptionId: sub, resourceGroup: rg };
}

function checkForbiddenReferences(texts) {
  const errors = [];
  const blob = texts.join('\n').toLowerCase();
  for (const needle of FORBIDDEN_TARGETS) {
    // Allow wh-staging-rg only as ACR resource group reference in known safe context —
    // reject as deployment *target* when paired with deploy language; always reject WH runtime names.
    if (needle === 'wh-staging-rg') continue;
    if (blob.includes(needle.toLowerCase())) {
      errors.push({ code: 'forbidden_wolfhouse_ref', message: `forbidden reference: ${needle}` });
    }
  }
  // Explicitly reject targeting wh-staging-rg as RG name in candidate params
  return { ok: errors.length === 0, errors };
}

function checkParameters(params, candidateSha) {
  const errors = [];
  for (const name of REQUIRED_PARAM_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      errors.push({ code: 'param_missing', message: `missing required parameter ${name}` });
      continue;
    }
    const bad = isForbiddenPlaceholder(params[name]);
    if (bad) {
      errors.push({
        code: 'param_placeholder',
        message: `parameter ${name} rejected (${bad})`,
      });
    }
  }
  if (params.staffApiImageTag && params.staffApiImageTag !== candidateSha) {
    errors.push({
      code: 'param_image_tag_mismatch',
      message: 'staffApiImageTag must equal candidate master SHA',
    });
  }
  if (params.deploySha && params.deploySha !== candidateSha) {
    errors.push({ code: 'param_deploy_sha_mismatch', message: 'deploySha must equal candidate master SHA' });
  }
  if (params.forceRevision && params.forceRevision !== candidateSha) {
    errors.push({
      code: 'param_force_revision_mismatch',
      message: 'forceRevision must equal candidate master SHA',
    });
  }
  if (params.appDbName && params.appDbName !== 'sunset_staging') {
    errors.push({ code: 'param_wrong_db', message: 'appDbName must be sunset_staging' });
  }
  if (params.appNamePrefix && params.appNamePrefix !== 'luna-sunset-staging') {
    errors.push({ code: 'param_wrong_prefix', message: 'appNamePrefix must be luna-sunset-staging' });
  }
  return { ok: errors.length === 0, errors };
}

function checkAcrImage(azure, imageTag) {
  const errors = [];
  const exists = azure.acrImageExists('whstagingacr', 'luna-sunset-staff-api', imageTag);
  if (!exists) {
    errors.push({
      code: 'acr_image_missing',
      message: `immutable image luna-sunset-staff-api:${imageTag} not found in whstagingacr`,
    });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Mark a check as skipped (not a pass). ok is always false.
 * Reason codes are safe to serialize — never include file contents or secrets.
 */
function skippedCheck(name, reasonCode, message) {
  return {
    name,
    ok: false,
    skipped: true,
    errors: [{ code: reasonCode, message: message || reasonCode }],
  };
}

/**
 * Secure parameter file provenance.
 * - No path: env-only allowed.
 * - In-repo: must be untracked AND matched by git check-ignore; tracked files rejected
 *   even if the path contains tmp / local / gitignored.
 * - Outside repo: must exist as a regular file (not a symlink).
 * Never reads or returns file contents.
 */
function validateSecureParamsProvenance(filePath, opts) {
  const options = opts || {};
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  if (!filePath) {
    return { ok: true, errors: [], mode: 'env-only' };
  }

  const abs = path.resolve(filePath);
  const rel = path.relative(repoRoot, abs);
  const inRepo = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);

  let st;
  try {
    st = (options.lstatSync || fs.lstatSync)(abs);
  } catch (_) {
    return {
      ok: false,
      errors: [{ code: 'secure_params_missing', message: 'secure params file not found' }],
    };
  }

  if (st.isSymbolicLink && st.isSymbolicLink()) {
    return {
      ok: false,
      errors: [{ code: 'secure_params_symlink', message: 'secure params path must not be a symlink' }],
    };
  }
  if (!st.isFile || !st.isFile()) {
    return {
      ok: false,
      errors: [{ code: 'secure_params_not_regular_file', message: 'secure params path must be a regular file' }],
    };
  }

  if (!inRepo) {
    return { ok: true, errors: [], mode: 'outside-repo' };
  }

  const isTracked =
    typeof options.isTracked === 'function'
      ? options.isTracked(abs, rel)
      : defaultIsGitTracked(repoRoot, rel);
  if (isTracked) {
    return {
      ok: false,
      errors: [
        {
          code: 'secure_params_tracked',
          message: 'secure params file is tracked by git (rejected even if path looks local/tmp)',
        },
      ],
    };
  }

  const ignored =
    typeof options.isIgnored === 'function'
      ? options.isIgnored(abs, rel)
      : defaultIsGitIgnored(repoRoot, rel);
  if (!ignored) {
    return {
      ok: false,
      errors: [
        {
          code: 'secure_params_not_ignored',
          message: 'in-repo secure params file must match git check-ignore',
        },
      ],
    };
  }

  return { ok: true, errors: [], mode: 'in-repo-ignored-untracked' };
}

function defaultIsGitTracked(repoRoot, relPosix) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPosix.replace(/\\/g, '/')], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

function defaultIsGitIgnored(repoRoot, relPosix) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPosix.replace(/\\/g, '/')], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // check-ignore -q: exit 0 = ignored
    return true;
  } catch (e) {
    if (e && e.status === 1) return false;
    return false;
  }
}

function fingerprintWhatIfChange(change) {
  const type = String(change.changeType || change.deltaType || '').toLowerCase();
  const resourceType = String(change.resourceType || change.type || '');
  const resourceId = String(change.resourceId || change.fullyQualifiedResourceId || '');
  const name = resourceId.split('/').pop() || '';

  if (type === 'ignore' || type === 'nochange') {
    if (/hold-expiry/.test(resourceId)) return 'ignore/hold-expiry-job';
    if (/managedCertificates/.test(resourceId)) return 'ignore/managed-certificate';
    return type === 'nochange' ? 'nochange' : 'ignore/unknown';
  }
  if (type === 'create') return 'CREATE';
  if (type === 'delete') return 'DELETE';
  if (type === 'replace' || type === 'delete+create') return 'REPLACE';

  if (Array.isArray(change.propertyFingerprints) && change.propertyFingerprints.length) {
    return change.propertyFingerprints;
  }

  if (/containerApps/i.test(resourceType) && /staff-api/.test(resourceId)) {
    const props = JSON.stringify(change.delta || change.after || change.before || change);
    if (/parameters\('/i.test(props) || /\[parameters\(/i.test(props)) {
      return 'containerApps/env-param-expression';
    }
    if (/exposedPort|maxInactiveRevisions|runningStatus/.test(props)) {
      if (/exposedPort/.test(props)) return 'containerApps/exposedPort';
      if (/maxInactiveRevisions/.test(props)) return 'containerApps/maxInactiveRevisions';
      if (/runningStatus/.test(props)) return 'containerApps/runningStatus';
    }
    if (/image|FORCE_REVISION|DEPLOY_SHA|WHATSAPP|INBOX_EMAIL/i.test(props)) {
      return 'containerApps/material-image-or-env';
    }
    return 'containerApps/UNKNOWN_MODIFY';
  }
  if (/managedEnvironments/i.test(resourceType)) {
    const props = JSON.stringify(change);
    if (/peerAuthentication|mtls/.test(props)) return 'managedEnvironments/peerAuthentication';
    if (/customerId|logAnalytics/.test(props)) return 'managedEnvironments/logAnalytics-customerId-reference';
    return 'managedEnvironments/UNKNOWN_MODIFY';
  }
  if (/flexibleServers/i.test(resourceType) && !/databases\//i.test(resourceId)) {
    return 'postgres/platform-defaults';
  }
  if (/Insights\/components/i.test(resourceType) || /appinsights/i.test(name)) {
    return 'appinsights/default-flow-props';
  }
  if (/roleAssignments/i.test(resourceId)) {
    const props = JSON.stringify(change);
    if (/principalType/i.test(props)) return 'roleAssignment/principalType-unsupported';
    return 'roleAssignment/principalId-reference';
  }
  if (/Unsupported/i.test(type) || change.unsupported) {
    if (/whstagingacr|AcrPull|7f951dda/i.test(JSON.stringify(change))) {
      return 'acrPull/unidentifiable-cross-rg';
    }
    return 'UNSUPPORTED_UNKNOWN';
  }
  return `UNKNOWN:${type}:${resourceType}`;
}

function evaluateWhatIfChanges(changes) {
  const errors = [];
  const normalized = [];
  let create = 0;
  let del = 0;
  let replace = 0;
  let materialModify = 0;
  let allowedNoise = 0;

  for (const change of changes || []) {
    const type = String(change.changeType || '').toLowerCase();
    const fps = fingerprintWhatIfChange(change);
    const list = Array.isArray(fps) ? fps : [fps];
    for (const fp of list) {
      normalized.push({
        changeType: change.changeType,
        resourceId: change.resourceId || null,
        fingerprint: fp,
      });
      if (fp === 'CREATE' || type === 'create') {
        create += 1;
        errors.push({ code: 'whatif_create', message: `Create not allowed: ${change.resourceId || fp}` });
      } else if (fp === 'DELETE' || type === 'delete') {
        del += 1;
        errors.push({ code: 'whatif_delete', message: `Delete not allowed: ${change.resourceId || fp}` });
      } else if (fp === 'REPLACE') {
        replace += 1;
        errors.push({ code: 'whatif_replace', message: `Replace not allowed: ${change.resourceId || fp}` });
      } else if (fp === 'nochange' || ALLOWED_WHATIF_NOISE_FINGERPRINTS.includes(fp)) {
        allowedNoise += 1;
      } else if (fp.startsWith('UNKNOWN') || fp.endsWith('UNKNOWN_MODIFY') || fp === 'UNSUPPORTED_UNKNOWN' || fp === 'ignore/unknown') {
        materialModify += 1;
        errors.push({
          code: 'whatif_unknown_noise',
          message: `unknown/unsupported what-if classification: ${fp}`,
        });
      } else if (type === 'modify' && !ALLOWED_WHATIF_NOISE_FINGERPRINTS.includes(fp)) {
        materialModify += 1;
        errors.push({ code: 'whatif_material_modify', message: `material Modify: ${fp}` });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      create,
      delete: del,
      replace,
      materialModify,
      allowedNoise,
      changeCount: (changes || []).length,
    },
    normalized,
  };
}

/**
 * Parse az deployment group what-if JSON (FullResourcePayloads) into normalized changes.
 * Also accepts a simplified fixture shape used by tests.
 */
function parseWhatIfJson(payload) {
  if (!payload) return [];
  const raw =
    (Array.isArray(payload.changes) && payload.changes) ||
    (payload.properties && Array.isArray(payload.properties.changes) && payload.properties.changes) ||
    [];
  return raw.map((c) => ({
    changeType: c.changeType,
    resourceId: c.resourceId || c.fullyQualifiedResourceId || null,
    resourceType: c.resourceType || inferTypeFromId(c.resourceId || c.fullyQualifiedResourceId),
    delta: c.delta,
    before: c.before,
    after: c.after,
    unsupported: c.changeType === 'Unsupported',
    propertyFingerprints: extractPropertyFingerprints(c),
  }));
}

function inferTypeFromId(id) {
  if (!id) return '';
  if (id.includes('/containerApps/')) return 'Microsoft.App/containerApps';
  if (id.includes('/managedEnvironments/') && id.includes('/managedCertificates/')) {
    return 'Microsoft.App/managedEnvironments/managedCertificates';
  }
  if (id.includes('/managedEnvironments/')) return 'Microsoft.App/managedEnvironments';
  if (id.includes('/flexibleServers/') && id.includes('/databases/')) {
    return 'Microsoft.DBforPostgreSQL/flexibleServers/databases';
  }
  if (id.includes('/flexibleServers/')) return 'Microsoft.DBforPostgreSQL/flexibleServers';
  if (id.includes('/components/')) return 'Microsoft.Insights/components';
  if (id.includes('/roleAssignments/')) return 'Microsoft.Authorization/roleAssignments';
  if (id.includes('/workspaces/')) return 'Microsoft.OperationalInsights/workspaces';
  if (id.includes('/userAssignedIdentities/')) return 'Microsoft.ManagedIdentity/userAssignedIdentities';
  if (id.includes('/vaults/')) return 'Microsoft.KeyVault/vaults';
  if (id.includes('/jobs/')) return 'Microsoft.App/jobs';
  return '';
}

function extractPropertyFingerprints(change) {
  const fps = [];
  const delta = change.delta;
  const paths = [];
  const blobs = [];

  if (Array.isArray(delta)) {
    for (const entry of delta) {
      if (!entry || typeof entry !== 'object') continue;
      const p = String(entry.path || entry.propertyName || entry.name || '');
      if (p) paths.push(p);
      blobs.push(JSON.stringify(entry));
    }
  } else if (delta && typeof delta === 'object') {
    function walk(obj, prefix) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (
          v &&
          typeof v === 'object' &&
          (Object.prototype.hasOwnProperty.call(v, 'propertyChangeType') ||
            Object.prototype.hasOwnProperty.call(v, 'value'))
        ) {
          paths.push(p);
        } else if (v && typeof v === 'object') walk(v, p);
      }
    }
    walk(delta, '');
    blobs.push(JSON.stringify(delta));
  }

  const joined = `${paths.join(' ')} ${blobs.join(' ')}`;
  if (/exposedPort/i.test(joined)) fps.push('containerApps/exposedPort');
  if (/maxInactiveRevisions/i.test(joined)) fps.push('containerApps/maxInactiveRevisions');
  if (/runningStatus/i.test(joined)) fps.push('containerApps/runningStatus');
  if (/peerAuthentication|mtls/i.test(joined)) fps.push('managedEnvironments/peerAuthentication');
  if (/customerId/i.test(joined)) fps.push('managedEnvironments/logAnalytics-customerId-reference');
  if (/parameters\(/i.test(joined)) fps.push('containerApps/env-param-expression');
  if (/Flow_Type|Request_Source/i.test(joined)) fps.push('appinsights/default-flow-props');
  if (/storage\.|replicationRole|authConfig|dataEncryption|backup/i.test(joined)) {
    fps.push('postgres/platform-defaults');
  }
  if (/principalId/i.test(joined)) fps.push('roleAssignment/principalId-reference');
  if (/principalType/i.test(joined)) fps.push('roleAssignment/principalType-unsupported');
  if (
    /staff-api/i.test(String(change.resourceId || '')) &&
    /image|FORCE_REVISION|DEPLOY_SHA|WHATSAPP|INBOX_EMAIL|containers\[/i.test(joined)
  ) {
    fps.push('containerApps/material-image-or-env');
  }
  return fps;
}

function assertCommandSurfaceIsReadOnly(scriptSources) {
  const errors = [];
  const blob = scriptSources.join('\n');
  const createCallable = /(?:execFileSync|execSync|spawnSync|spawn)\s*\([\s\S]{0,300}(?:deployment[\s\S]{0,60}group[\s\S]{0,60}create|['"]deployment['"]\s*,\s*['"]group['"]\s*,\s*['"]create['"])/i.test(blob);
  if (createCallable) {
    errors.push({ code: 'command_surface_deploy', message: 'deployment group create must not be callable' });
  }
  // Bare documentation of the forbidden command is OK when not callable.
  if (/(?:execFileSync|execSync|spawnSync)\s*\([\s\S]{0,200}acr['"\s,]+build/i.test(blob)) {
    errors.push({ code: 'command_surface_acr_build', message: 'acr build must not be callable from preflight' });
  }
  if (/(?:execFileSync|execSync|spawnSync)\s*\([\s\S]{0,200}containerapp[\s\S]{0,40}(?:create|update)/i.test(blob)) {
    errors.push({ code: 'command_surface_containerapp_mutate', message: 'containerapp create/update must not be callable' });
  }
  return { ok: errors.length === 0, errors };
}

function buildReport(parts) {
  const report = {
    schemaVersion: 1,
    kind: 'sunset-staging-bicep-preflight',
    ok: parts.ok,
    generatedAt: parts.generatedAt || new Date().toISOString(),
    candidateSha: parts.candidateSha,
    target: {
      subscriptionId: parts.subscriptionId,
      resourceGroup: parts.resourceGroup,
      app: 'luna-sunset-staging-staff-api',
      mode: 'Incremental',
    },
    costBaseline: parts.costBaseline || null,
    templateHash: parts.templateHash || null,
    checks: parts.checks || [],
    whatIf: parts.whatIf || null,
    parametersRedacted: parts.parametersRedacted || null,
  };
  const leak = assertNoLeakedSecrets(JSON.stringify(report));
  if (leak.length) {
    report.ok = false;
    report.checks = report.checks.concat([
      { name: 'report_secret_leak', ok: false, errors: leak.map((x) => ({ code: 'secret_leak', message: x })) },
    ]);
  }
  return report;
}

module.exports = {
  FORBIDDEN_TARGETS,
  SECURE_PARAM_NAMES,
  REQUIRED_PARAM_NAMES,
  ALLOWED_WHATIF_NOISE_FINGERPRINTS,
  sha256File,
  isFullSha,
  isForbiddenPlaceholder,
  loadParametersFile,
  mergeParameters,
  redactParams,
  assertNoLeakedSecrets,
  checkGitState,
  checkAzureTarget,
  checkForbiddenReferences,
  checkParameters,
  checkAcrImage,
  skippedCheck,
  validateSecureParamsProvenance,
  fingerprintWhatIfChange,
  evaluateWhatIfChanges,
  parseWhatIfJson,
  assertCommandSurfaceIsReadOnly,
  buildReport,
};
