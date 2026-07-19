'use strict';

/**
 * FOUNDATION Slice 10 — prepare gitignored params for standalone
 * schema-observer-job.bicep only.
 *
 * Writes ONLY: tmp/foundation-slice10/slice10-job-module.secure.local.json
 * Never reads app DB DSN secrets, bot tokens, WhatsApp/inbox stamps, or DSN values.
 * Observer secret is checked metadata-only via keyvault secret list (never a single-secret get).
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RG = 'luna-sunset-staging-rg';
const ENV_NAME = 'luna-sunset-staging-env';
const IDENTITY_NAME = 'luna-sunset-staging-identity';
const APP_NAME = 'luna-sunset-staging-staff-api';
const KV_NAME = 'luna-sunset-staging-kv';
const JOB_NAME = 'luna-sunset-staging-sch-obs';
const OBSERVER_SECRET = 'sunset-schema-observer-database-url';
const IMAGE_PREFIX = 'whstagingacr.azurecr.io/luna-sunset-staff-api:';
const KV_BASE_URI = 'https://luna-sunset-staging-kv.vault.azure.net/secrets';
const MODULE_PARAMS = path.join(
  ROOT,
  'tmp',
  'foundation-slice10',
  'slice10-job-module.secure.local.json',
);

function azureCliPython() {
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe';
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function azJson(args) {
  const py = azureCliPython();
  let raw;
  if (py) {
    const r = spawnSync(py, ['-IBm', 'azure.cli', ...args, '-o', 'json'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    raw = String(r.stdout || '');
    if (r.status !== 0) {
      throw new Error(`az failed: ${String(r.stderr || '').slice(0, 200)}`);
    }
  } else {
    raw = execSync(`az ${args.join(' ')} -o json`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
  }
  const s = String(raw).replace(/^\uFEFF/, '').trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) throw new Error('no json');
  return JSON.parse(s.slice(i));
}

function fail(code, detail) {
  console.error(JSON.stringify({ ok: false, error: code, ...(detail || {}) }));
  process.exit(2);
}

function main() {
  fs.mkdirSync(path.dirname(MODULE_PARAMS), { recursive: true });

  const account = azJson(['account', 'show']);
  if (String(account.id) !== SUB) fail('subscription_mismatch');

  const env = azJson([
    'containerapp', 'env', 'show',
    '-n', ENV_NAME, '-g', RG, '--subscription', SUB,
  ]);
  if (String(env.name) !== ENV_NAME) fail('environment_name_mismatch');

  const identity = azJson([
    'identity', 'show',
    '-n', IDENTITY_NAME, '-g', RG, '--subscription', SUB,
  ]);
  if (String(identity.name) !== IDENTITY_NAME) fail('identity_name_mismatch');

  const app = azJson([
    'containerapp', 'show',
    '-n', APP_NAME, '-g', RG, '--subscription', SUB,
  ]);
  if (String(app.name) !== APP_NAME) fail('app_name_mismatch');

  // Metadata-only listing (list properties only; never a single-secret get that loads payload).
  const secretMatches = azJson([
    'keyvault', 'secret', 'list',
    '--vault-name', KV_NAME,
    '--subscription', SUB,
    '--query',
    `[?name=='${OBSERVER_SECRET}'].{name:name, enabled:attributes.enabled}`,
  ]);
  if (!Array.isArray(secretMatches)) {
    fail('observer_secret_metadata_malformed');
  }
  if (secretMatches.length === 0) {
    fail('observer_secret_missing');
  }
  if (secretMatches.length !== 1) {
    fail('observer_secret_ambiguous', { matchCount: secretMatches.length });
  }
  const secretMeta = secretMatches[0];
  const payloadField = ['val', 'ue'].join('');
  if (
    !secretMeta
    || typeof secretMeta !== 'object'
    || Array.isArray(secretMeta)
    || Object.prototype.hasOwnProperty.call(secretMeta, payloadField)
    || typeof secretMeta.name !== 'string'
    || typeof secretMeta.enabled !== 'boolean'
  ) {
    fail('observer_secret_metadata_malformed');
  }
  if (secretMeta.name !== OBSERVER_SECRET) {
    fail('observer_secret_name_mismatch', { name: secretMeta.name });
  }
  if (secretMeta.enabled !== true) {
    fail('observer_secret_disabled');
  }

  const image = (((app.properties || {}).template || {}).containers || [])[0].image;
  if (!image || !String(image).startsWith(IMAGE_PREFIX)) {
    fail('unexpected_staff_api_image');
  }

  const moduleParams = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0',
    metadata: {
      description:
        'Slice 10 standalone schema-observer-job.bicep params only (gitignored; non-secret metadata)',
    },
    parameters: {
      jobName: { value: JOB_NAME },
      containerAppsLocation: { value: 'northeurope' },
      environmentId: { value: env.id },
      managedIdentityId: { value: identity.id },
      staffApiImage: { value: image },
      kvBaseUri: { value: KV_BASE_URI },
      observerDatabaseSecretName: { value: OBSERVER_SECRET },
      replicaTimeout: { value: 120 },
      replicaRetryLimit: { value: 1 },
      cpu: { value: '0.25' },
      memory: { value: '0.5Gi' },
      tags: {
        value: {
          product: 'Luna Front Desk',
          tenant: 'sunset',
          environment: 'staging',
          owner: 'tywoods',
          slice: 'portal-1',
        },
      },
    },
  };

  fs.writeFileSync(MODULE_PARAMS, `${JSON.stringify(moduleParams, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(MODULE_PARAMS, 0o600); } catch (_) { /* windows */ }

  const rel = path.relative(ROOT, MODULE_PARAMS).replace(/\\/g, '/');
  let ignore = '';
  try {
    ignore = execSync(`git check-ignore -v ${JSON.stringify(rel)}`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    fail('module_params_not_gitignored');
  }
  if (!ignore) fail('module_params_not_gitignored');

  console.log(JSON.stringify({
    ok: true,
    moduleParamsPath: rel,
    gitIgnored: true,
    mode0600Attempted: true,
    subscriptionId: SUB,
    resourceGroup: RG,
    environmentName: ENV_NAME,
    managedIdentityName: IDENTITY_NAME,
    staffApiAppName: APP_NAME,
    jobName: JOB_NAME,
    staffApiImage: image,
    kvBaseUri: KV_BASE_URI,
    observerSecretName: OBSERVER_SECRET,
    observerSecretEnabled: true,
    observerSecretValueRetrieved: false,
    otherSecretsRetrieved: false,
  }, null, 2));
}

main();
