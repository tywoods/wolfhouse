'use strict';

/**
 * FOUNDATION Slice 10 — prepare gitignored secure deploy params for the
 * schema-observer job create (deploySchemaObserverJob=true intent).
 *
 * Never prints secret values. Writes only to a gitignored *.local.json path.
 * Pins the live Staff API image (no rebuild). Resolves CAE + MI IDs from Azure.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RG = 'luna-sunset-staging-rg';
const OUT = path.join(ROOT, 'tmp', 'foundation-slice10', 'slice10-deploy.secure.local.json');
const MODULE_PARAMS = path.join(ROOT, 'tmp', 'foundation-slice10', 'slice10-job-module.secure.local.json');

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

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const account = azJson(['account', 'show']);
  if (String(account.id) !== SUB) {
    console.error(JSON.stringify({ ok: false, error: 'subscription_mismatch' }));
    process.exit(2);
  }

  const env = azJson([
    'containerapp', 'env', 'show',
    '-n', 'luna-sunset-staging-env', '-g', RG, '--subscription', SUB,
  ]);
  const identity = azJson([
    'identity', 'show',
    '-n', 'luna-sunset-staging-identity', '-g', RG, '--subscription', SUB,
  ]);
  const app = azJson([
    'containerapp', 'show',
    '-n', 'luna-sunset-staging-staff-api', '-g', RG, '--subscription', SUB,
  ]);
  const secretMeta = azJson([
    'keyvault', 'secret', 'show',
    '--vault-name', 'luna-sunset-staging-kv',
    '--name', 'sunset-schema-observer-database-url',
    '--subscription', SUB,
    '--query', '{name:name,enabled:attributes.enabled}',
  ]);
  if (!secretMeta || secretMeta.name !== 'sunset-schema-observer-database-url' || secretMeta.enabled === false) {
    console.error(JSON.stringify({ ok: false, error: 'observer_secret_missing_or_disabled' }));
    process.exit(2);
  }

  const image = (((app.properties || {}).template || {}).containers || [])[0].image;
  if (!image || !String(image).startsWith('whstagingacr.azurecr.io/luna-sunset-staff-api:')) {
    console.error(JSON.stringify({ ok: false, error: 'unexpected_staff_api_image' }));
    process.exit(2);
  }
  const imageTag = String(image).split(':').pop();

  const envList = (((app.properties || {}).template || {}).containers || [])[0].env || [];
  const envMap = {};
  for (const e of envList) {
    if (e && e.name && e.value != null) envMap[e.name] = String(e.value);
  }

  // Secure values for main.bicep overlay (never logged). Prefer live stamps.
  const requiredLive = [
    'SUNSET_SOMO_WHATSAPP_NUMBER',
    'SUNSET_SARDINERO_WHATSAPP_NUMBER',
    'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID',
    'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID',
    'SUNSET_SOMO_INBOX_EMAIL',
    'SUNSET_SARDINERO_INBOX_EMAIL',
  ];
  for (const k of requiredLive) {
    if (!envMap[k]) {
      console.error(JSON.stringify({ ok: false, error: 'missing_live_env', key: k }));
      process.exit(2);
    }
  }

  // Load admin password + bot token without printing (for main.bicep if used).
  const dbUrlShow = azJson([
    'keyvault', 'secret', 'show',
    '--vault-name', 'luna-sunset-staging-kv',
    '--name', 'sunset-database-url',
    '--subscription', SUB,
  ]);
  const dbUrl = String(dbUrlShow.value || '');
  let postgresAdminPassword = '';
  try {
    const u = new URL(dbUrl);
    postgresAdminPassword = decodeURIComponent(u.password || '');
  } catch (_) {
    console.error(JSON.stringify({ ok: false, error: 'db_url_parse_failed' }));
    process.exit(2);
  }
  if (!postgresAdminPassword) {
    console.error(JSON.stringify({ ok: false, error: 'postgres_password_missing' }));
    process.exit(2);
  }

  // Inline CA secret — required by main.bicep; never print.
  let lunaBotInternalToken = '';
  try {
    const sec = azJson([
      'containerapp', 'secret', 'show',
      '-n', 'luna-sunset-staging-staff-api', '-g', RG, '--subscription', SUB,
      '--secret-name', 'luna-bot-internal-token',
    ]);
    lunaBotInternalToken = String(sec.value || '');
  } catch (_) {
    // Older CLI shape
  }
  if (!lunaBotInternalToken) {
    console.error(JSON.stringify({ ok: false, error: 'luna_bot_token_unavailable' }));
    process.exit(2);
  }

  const mainOverlay = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0',
    metadata: {
      description: 'FOUNDATION Slice 10 gitignored overlay — deploySchemaObserverJob=true; live image pin; never commit',
    },
    parameters: {
      deploySchemaObserverJob: { value: true },
      staffApiImageTag: { value: imageTag },
      deploySha: { value: imageTag },
      forceRevision: { value: imageTag },
      sunsetSomoWhatsappNumber: { value: envMap.SUNSET_SOMO_WHATSAPP_NUMBER },
      sunsetSardineroWhatsappNumber: { value: envMap.SUNSET_SARDINERO_WHATSAPP_NUMBER },
      sunsetSomoWhatsappPhoneNumberId: { value: envMap.SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID },
      sunsetSardineroWhatsappPhoneNumberId: { value: envMap.SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID },
      sunsetSomoInboxEmail: { value: envMap.SUNSET_SOMO_INBOX_EMAIL },
      sunsetSardineroInboxEmail: { value: envMap.SUNSET_SARDINERO_INBOX_EMAIL },
      postgresAdminPassword: { value: postgresAdminPassword },
      lunaBotInternalToken: { value: lunaBotInternalToken },
    },
  };

  const moduleParams = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0',
    metadata: {
      description: 'Slice 10 standalone schema-observer-job.bicep params (gitignored)',
    },
    parameters: {
      jobName: { value: 'luna-sunset-staging-sch-obs' },
      containerAppsLocation: { value: 'northeurope' },
      environmentId: { value: env.id },
      managedIdentityId: { value: identity.id },
      staffApiImage: { value: image },
      kvBaseUri: { value: 'https://luna-sunset-staging-kv.vault.azure.net/secrets' },
      observerDatabaseSecretName: { value: 'sunset-schema-observer-database-url' },
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

  fs.writeFileSync(OUT, `${JSON.stringify(mainOverlay, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(OUT, 0o600); } catch (_) { /* windows */ }
  fs.writeFileSync(MODULE_PARAMS, `${JSON.stringify(moduleParams, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(MODULE_PARAMS, 0o600); } catch (_) { /* windows */ }

  // Prove gitignore
  const ignore = execSync(`git check-ignore -v ${JSON.stringify(path.relative(ROOT, OUT))}`, {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

  console.log(JSON.stringify({
    ok: true,
    mainOverlayPath: path.relative(ROOT, OUT).replace(/\\/g, '/'),
    moduleParamsPath: path.relative(ROOT, MODULE_PARAMS).replace(/\\/g, '/'),
    gitIgnored: Boolean(ignore),
    deploySchemaObserverJob: true,
    staffApiImageTag: imageTag,
    staffApiImage: image,
    jobName: 'luna-sunset-staging-sch-obs',
    environmentName: env.name,
    managedIdentityName: identity.name,
    observerSecretName: 'sunset-schema-observer-database-url',
    observerSecretEnabled: true,
    secretsWrittenToDisk: true,
    secretValuesPrinted: false,
  }, null, 2));
}

main();
