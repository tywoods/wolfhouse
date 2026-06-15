'use strict';
/**
 * Deploy Hermes Agent to staging Container Apps (official Docker image).
 *
 * Usage:
 *   node scripts/deploy-staging-hermes.js status
 *   node scripts/deploy-staging-hermes.js prepare-storage
 *   node scripts/deploy-staging-hermes.js deploy
 *   node scripts/deploy-staging-hermes.js verify
 *
 * After deploy: run setup wizard (once) via exec — see docs/HERMES-AZURE-CONTAINER-APPS.md
 */

const { execSync } = require('child_process');
const { HERMES_STAGING_V1 } = require('./lib/hermes-staging-profile');

const RG = 'wh-staging-rg';
const LOCATION = 'northeurope';
const ENV_NAME = 'wh-staging-env';
const APP_NAME = 'wh-staging-hermes';
const BASE_IMAGE = 'docker.io/nousresearch/hermes-agent:latest';
const STAGING_IMAGE = 'whstagingacr.azurecr.io/wh-hermes-staging:latest';
const IMAGE = STAGING_IMAGE;
const TARGET_PORT = 8090; // WhatsApp Cloud webhook (Meta → Hermes). API /v1 is internal-only unless ingress changes.
const STORAGE_ACCOUNT = 'whstaginghermes';
const FILE_SHARE = 'hermes-data';
const VOLUME_NAME = 'hermes-data';
const MOUNT_PATH = '/opt/data';
const PERSIST_DATA = process.argv.includes('--persist-data');
const KV_URL = 'https://wh-staging-kv.vault.azure.net';
const IDENTITY_ID = '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/wh-staging-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/wh-staging-identity';
const KV_SECRET_BINDINGS = [
  { caName: 'openai-api-key', kvName: 'openai-api-key' },
  { caName: 'meta-whatsapp-token', kvName: 'meta-whatsapp-token' },
  { caName: 'meta-whatsapp-phone-id', kvName: 'meta-whatsapp-phone-id' },
  { caName: 'whatsapp-app-secret', kvName: 'whatsapp-app-secret' },
  { caName: 'luna-bot-internal-token', kvName: 'luna-bot-internal-token' },
];

const cmd = (process.argv[2] || 'status').toLowerCase();

function az(args, opts = {}) {
  const str = typeof args === 'string' ? args : args.join(' ');
  return execSync(`az ${str}`, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function appExists() {
  try {
    az(`containerapp show -g ${RG} -n ${APP_NAME} -o none`, { silent: true });
    return true;
  } catch {
    return false;
  }
}

function storageExists() {
  try {
    az(`storage account show -g ${RG} -n ${STORAGE_ACCOUNT} -o none`, { silent: true });
    return true;
  } catch {
    return false;
  }
}

function envVarsForAz() {
  return Object.entries(HERMES_STAGING_V1)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

function removeVolumeMount() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const app = JSON.parse(az(`containerapp show -g ${RG} -n ${APP_NAME} -o json`));
  const src = app.properties.template;
  const container = src.containers.find((c) => c.name === APP_NAME) || src.containers[0];
  delete container.volumeMounts;
  const template = { volumes: null, containers: src.containers };
  const tmp = path.join(os.tmpdir(), `hermes-patch-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ properties: { template } }));
  try {
    az(`rest --method patch --uri "${app.id}?api-version=2024-03-01" --body @${tmp} -o none`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function attachVolumeMount() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const app = JSON.parse(az(`containerapp show -g ${RG} -n ${APP_NAME} -o json`));
  const src = app.properties.template;
  const container = src.containers.find((c) => c.name === APP_NAME) || src.containers[0];
  container.volumeMounts = [{ volumeName: VOLUME_NAME, mountPath: MOUNT_PATH }];
  const template = {
    volumes: [{
      name: VOLUME_NAME,
      storageName: VOLUME_NAME,
      storageType: 'AzureFile',
    }],
    containers: src.containers,
  };
  const tmp = path.join(os.tmpdir(), `hermes-patch-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ properties: { template } }));
  try {
    az(`rest --method patch --uri "${app.id}?api-version=2024-03-01" --body @${tmp} -o none`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function ensureApiServerKey() {
  const crypto = require('crypto');
  const secretName = 'hermes-api-server-key';
  let exists = false;
  try {
    az(`containerapp secret show -g ${RG} -n ${APP_NAME} --secret-name ${secretName} -o none`, { silent: true });
    exists = true;
  } catch { /* create below */ }
  if (!exists) {
    const key = crypto.randomBytes(32).toString('hex');
    console.error('[deploy] creating Container App secret hermes-api-server-key');
    az(`containerapp secret set -g ${RG} -n ${APP_NAME} --secrets ${secretName}=${key} -o none`);
  }
}

function ensureKvSecretsAndIdentity() {
  console.error('[deploy] assigning wh-staging-identity to Hermes...');
  try {
    az(`containerapp identity assign -g ${RG} -n ${APP_NAME} --user-assigned ${IDENTITY_ID} -o none`);
  } catch (e) {
    if (!/already assigned|Conflict/i.test(String(e.stderr || e.message))) throw e;
  }
  for (const { caName, kvName } of KV_SECRET_BINDINGS) {
    const ref = `keyvaultref:${KV_URL}/secrets/${kvName},identityref:${IDENTITY_ID}`;
    console.error(`[deploy] binding KV secret ${kvName} -> ${caName}`);
    try {
      az(`containerapp secret set -g ${RG} -n ${APP_NAME} --secrets ${caName}=${ref} -o none`);
    } catch (e) {
      if (!/already exists|Conflict/i.test(String(e.stderr || e.message))) throw e;
    }
  }
}

function bootstrapHermesRuntime() {
  const fs = require('fs');
  const path = require('path');
  console.error('[deploy] bootstrapping /opt/data config + Luna guest SOUL...');
  const configB64 = Buffer.from(
    'model:\n  default: gpt-4o-mini\n  provider: openai-api\n  api_mode: chat_completions\nagent:\n  reasoning_effort: none\n',
  ).toString('base64');
  const soulPath = path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md');
  const soulB64 = fs.readFileSync(soulPath, 'utf8').toString('base64');
  const cmds = [
    `sh -c "echo ${configB64} | base64 -d > /opt/data/config.yaml"`,
    `sh -c "echo ${soulB64} | base64 -d > /opt/data/SOUL.md"`,
    'hermes config set model.default gpt-4o-mini',
    'hermes config set model.provider openai-api',
    'sh -c "grep -q ^OPENAI_API_KEY= /opt/data/.env 2>/dev/null || printenv OPENAI_API_KEY | sed s/^/OPENAI_API_KEY=/ >> /opt/data/.env"',
  ];
  for (const c of cmds) {
    try {
      az(`containerapp exec -g ${RG} -n ${APP_NAME} --command "${c.replace(/"/g, '\\"')}"`, { silent: true });
    } catch (e) {
      console.error(`[deploy] bootstrap cmd warning: ${String(e.stderr || e.message).slice(0, 200)}`);
    }
  }
}

function wireSecretEnvVars() {
  const pairs = [
    'API_SERVER_KEY=secretref:hermes-api-server-key',
    'OPENAI_API_KEY=secretref:openai-api-key',
    'WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token',
    'WHATSAPP_CLOUD_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id',
    'WHATSAPP_CLOUD_APP_SECRET=secretref:whatsapp-app-secret',
    'WHATSAPP_CLOUD_VERIFY_TOKEN=wolfhouse_verify_token',
    'WHATSAPP_CLOUD_WEBHOOK_PORT=8090',
    'WHATSAPP_CLOUD_WEBHOOK_PATH=/whatsapp/webhook',
    'LUNA_BOT_INTERNAL_TOKEN=secretref:luna-bot-internal-token',
    ...Object.entries(HERMES_STAGING_V1).map(([k, v]) => `${k}=${v}`),
  ];
  console.error('[deploy] wiring env vars (profile + KV secret refs)...');
  az(`containerapp update -g ${RG} -n ${APP_NAME} --set-env-vars ${pairs.join(' ')} -o none`);
}

function status() {
  const out = { rg: RG, env: ENV_NAME, app: APP_NAME, image: IMAGE };
  out.storage_account = STORAGE_ACCOUNT;
  out.storage_exists = storageExists();
  out.app_exists = appExists();
  if (out.app_exists) {
    const app = JSON.parse(az(`containerapp show -g ${RG} -n ${APP_NAME} -o json`));
    out.fqdn = app.properties?.configuration?.ingress?.fqdn || null;
    out.latest_revision = app.properties?.latestRevisionName || null;
    out.running_status = app.properties?.runningStatus || null;
  }
  console.log(JSON.stringify(out, null, 2));
}

function prepareStorage() {
  if (!storageExists()) {
    console.error(`[prepare-storage] creating storage account ${STORAGE_ACCOUNT}...`);
    az([
      `storage account create`,
      `-g ${RG}`,
      `-n ${STORAGE_ACCOUNT}`,
      `-l ${LOCATION}`,
      `--sku Standard_LRS`,
      `--kind StorageV2`,
      `--allow-blob-public-access false`,
      `-o none`,
    ].join(' '));
  } else {
    console.error(`[prepare-storage] storage account ${STORAGE_ACCOUNT} already exists`);
  }

  const key = az(`storage account keys list -g ${RG} -n ${STORAGE_ACCOUNT} --query "[0].value" -o tsv`);

  try {
    az(`storage share-rm create --storage-account ${STORAGE_ACCOUNT} --resource-group ${RG} --name ${FILE_SHARE} -o none`);
    console.error(`[prepare-storage] created file share ${FILE_SHARE}`);
  } catch (e) {
    if (/ShareAlreadyExists|already exists/i.test(String(e.stderr || e.message))) {
      console.error(`[prepare-storage] file share ${FILE_SHARE} already exists`);
    } else {
      throw e;
    }
  }

  console.error(`[prepare-storage] registering volume on Container Apps environment ${ENV_NAME}...`);
  try {
    az([
      `containerapp env storage set`,
      `-g ${RG}`,
      `-n ${ENV_NAME}`,
      `--storage-name ${VOLUME_NAME}`,
      `--azure-file-account-name ${STORAGE_ACCOUNT}`,
      `--azure-file-account-key ${key}`,
      `--azure-file-share-name ${FILE_SHARE}`,
      `--access-mode ReadWrite`,
      `-o none`,
    ].join(' '));
  } catch (e) {
    if (/already exists|Conflict/i.test(String(e.stderr || e.message))) {
      console.error(`[prepare-storage] env volume ${VOLUME_NAME} already registered`);
    } else {
      throw e;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    storage_account: STORAGE_ACCOUNT,
    file_share: FILE_SHARE,
    env_volume: VOLUME_NAME,
    mount_path: MOUNT_PATH,
  }, null, 2));
}

function ensureAcrRegistry() {
  console.error('[deploy] configuring ACR pull for whstagingacr...');
  try {
    az(`containerapp registry set -g ${RG} -n ${APP_NAME} --server whstagingacr.azurecr.io --identity ${IDENTITY_ID} -o none`);
  } catch (e) {
    if (!/already exists|Conflict/i.test(String(e.stderr || e.message))) throw e;
  }
}

function assertSoulClean() {
  const path = require('path');
  const root = path.join(__dirname, '..');
  console.error('[deploy] check-soul-clean (prebuild)...');
  execSync('node scripts/check-soul-clean.js', { cwd: root, stdio: 'inherit' });
}

function buildStagingImage() {
  assertSoulClean();
  console.error('[deploy] building staging image on ACR (OpenAI bootstrap baked in)...');
  az('acr build --registry whstagingacr --image wh-hermes-staging:latest --file docker/hermes-staging/Dockerfile docker/hermes-staging');
}

function stagingImageRef() {
  const digest = az(
    'acr repository show-manifests --name whstagingacr --repository wh-hermes-staging --orderby time_desc --top 1 --query "[0].digest" -o tsv',
    { silent: true },
  );
  return `${STAGING_IMAGE.split(':')[0]}@${digest}`;
}

function deploy() {
  if (!storageExists()) {
    console.error('[deploy] storage missing — run: node scripts/deploy-staging-hermes.js prepare-storage');
    process.exit(1);
  }

  buildStagingImage();
  const imageRef = stagingImageRef();
  console.error(`[deploy] using image ${imageRef}`);

  if (appExists()) {
    ensureApiServerKey();
    ensureKvSecretsAndIdentity();
    ensureAcrRegistry();
  }

  const envId = az(`containerapp env show -g ${RG} -n ${ENV_NAME} --query id -o tsv`);
  const envVars = envVarsForAz();

  if (!appExists()) {
    console.error(`[deploy] creating Container App ${APP_NAME}...`);
    az([
      `containerapp create`,
      `-g ${RG}`,
      `-n ${APP_NAME}`,
      `--environment ${ENV_NAME}`,
      `--image ${imageRef}`,
      `--registry-server whstagingacr.azurecr.io`,
      `--registry-identity ${IDENTITY_ID}`,
      `--ingress external`,
      `--target-port ${TARGET_PORT}`,
      `--transport http`,
      `--min-replicas 1`,
      `--max-replicas 1`,
      `--cpu 1.0`,
      `--memory 2Gi`,
      `--args gateway run`,
      `--env-vars ${envVars}`,
      `-o none`,
    ].join(' '));

    // Mount volume (create doesn't always accept volume in one shot — update after create)
    az([
      `containerapp update`,
      `-g ${RG}`,
      `-n ${APP_NAME}`,
      `--set-env-vars ${envVars}`,
      `-o none`,
    ].join(' '));
  } else {
    console.error(`[deploy] updating Container App ${APP_NAME}...`);
    az([
      `containerapp update`,
      `-g ${RG}`,
      `-n ${APP_NAME}`,
      `--image ${imageRef}`,
      `--min-replicas 1`,
      `--args gateway run`,
      `--set-env-vars ${envVars}`,
      `-o none`,
    ].join(' '));
  }

  ensureApiServerKey();
  ensureKvSecretsAndIdentity();
  if (!appExists()) {
    ensureAcrRegistry();
  }
  wireSecretEnvVars();

  // Azure Files (SMB) breaks Hermes SQLite WAL — ephemeral /opt/data unless --persist-data (NFS later).
  if (PERSIST_DATA) {
    console.error('[deploy] attaching Azure Files volume (SQLite may fail on SMB — prefer NFS when available)...');
    attachVolumeMount();
  } else {
    console.error('[deploy] using ephemeral /opt/data (SQLite-safe); storage share kept for future NFS cutover');
    try { removeVolumeMount(); } catch { /* no mount yet */ }
  }

  for (let i = 0; i < 30; i++) {
    sleep(10000);
    const app = JSON.parse(az(`containerapp show -g ${RG} -n ${APP_NAME} -o json`));
    const rev = app.properties?.latestRevisionName;
    const running = app.properties?.runningStatus;
    const fqdn = app.properties?.configuration?.ingress?.fqdn;
    console.error(`[deploy] wait ${i + 1}/30 rev=${rev} status=${running} fqdn=${fqdn}`);
    if (running === 'Running' && fqdn) {
      console.log(JSON.stringify({
        ok: true,
        fqdn,
        url: `https://${fqdn}`,
        next: 'node scripts/deploy-staging-hermes.js verify',
        setup: 'az containerapp exec -g wh-staging-rg -n wh-staging-hermes --command "hermes setup"',
      }, null, 2));
      return;
    }
  }
  console.log(JSON.stringify({ ok: false, note: 'timeout waiting for Running' }, null, 2));
  process.exit(1);
}

function verify() {
  if (!appExists()) {
    console.error('FAIL — app does not exist. Run deploy first.');
    process.exit(1);
  }
  const app = JSON.parse(az(`containerapp show -g ${RG} -n ${APP_NAME} -o json`));
  const fqdn = app.properties?.configuration?.ingress?.fqdn;
  if (!fqdn) {
    console.error('FAIL — no ingress FQDN');
    process.exit(1);
  }
  const base = `https://${fqdn}`;
  let healthCode = '000';
  try {
    healthCode = execSync(`curl.exe -s -m 15 -o NUL -w "%{http_code}" ${base}/health`, { encoding: 'utf8' }).trim();
  } catch {
    healthCode = '000';
  }
  const ok = healthCode === '200' || healthCode === '204';
  let healthBody = null;
  try {
    healthBody = JSON.parse(execSync(`curl.exe -s -m 15 ${base}/health`, { encoding: 'utf8' }));
  } catch { /* ignore */ }
  const ingressPort = JSON.parse(az(`containerapp show -g ${RG} -n ${APP_NAME} -o json`))
    .properties?.configuration?.ingress?.targetPort;
  console.log(JSON.stringify({
    ok,
    fqdn,
    base_url: base,
    ingress_target_port: ingressPort,
    health_path: '/health',
    health_http_code: healthCode,
    whatsapp_health: healthBody,
    meta_webhook_url: `${base}/whatsapp/webhook`,
    meta_verify_token: 'wolfhouse_verify_token',
    meta_must_subscribe_field: 'messages',
    note: ok
      ? 'Hermes WhatsApp ready. In Meta: subscribe webhook field messages (not just account_*).'
      : 'Gateway not healthy yet — check logs.',
  }, null, 2));
  if (!ok) process.exit(1);
}

function hermesChatBaseUrlAndKey() {
  if (!appExists()) {
    console.error('FAIL — app does not exist. Run deploy first.');
    process.exit(1);
  }
  const app = JSON.parse(az(`containerapp show -g ${RG} -n ${APP_NAME} -o json`));
  const fqdn = app.properties?.configuration?.ingress?.fqdn;
  const apiKey = az(`containerapp secret show -g ${RG} -n ${APP_NAME} --secret-name hermes-api-server-key --query value -o tsv`).trim();
  return { base: `https://${fqdn}`, apiKey };
}

function postChatCompletion(message, maxTokens = 150) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { base, apiKey } = hermesChatBaseUrlAndKey();
  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: message }],
    max_tokens: maxTokens,
  });
  const tmp = path.join(os.tmpdir(), `hermes-chat-${Date.now()}.json`);
  fs.writeFileSync(tmp, body);
  let raw = '';
  let code = '000';
  try {
    raw = execSync(
      `curl.exe -s -m 120 -w "\\n%{http_code}" -X POST ${base}/v1/chat/completions -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" --data-binary @${tmp}`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    ).trim();
    const lines = raw.split(/\r?\n/);
    code = lines.pop() || '000';
    raw = lines.join('\n');
  } catch (e) {
    raw = String(e.stderr || e.message || e);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  let parsed = null;
  let reply = null;
  try {
    parsed = JSON.parse(raw);
    reply = parsed?.choices?.[0]?.message?.content;
  } catch { /* non-json */ }
  const ok = code === '200' && reply;
  return {
    ok,
    http_code: code,
    reply: reply || null,
    error: parsed?.error || (ok ? null : raw.slice(0, 500)),
    base_url: base,
  };
}

function chatTest() {
  const result = postChatCompletion('Reply with exactly: Hermes staging hello OK', 40);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function chat() {
  const message = process.argv.slice(3).join(' ').trim();
  if (!message) {
    console.error('Usage: node scripts/deploy-staging-hermes.js chat "your message"');
    process.exit(1);
  }
  const result = postChatCompletion(message, 300);
  if (result.ok) {
    console.log(result.reply);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

function usage() {
  console.log(`Usage: node scripts/deploy-staging-hermes.js <command>

Commands:
  status           Show whether storage + app exist
  prepare-storage  Create storage account, file share, env volume mount
  deploy           Create/update wh-staging-hermes Container App
  verify           Curl gateway /health on ACA FQDN
  bootstrap        Write OpenAI config into /opt/data (after each new revision)
  chat-test        POST /v1/chat/completions smoke test (needs OPENAI_API_KEY)
  chat "message"   Send one message; prints the agent reply (PowerShell-friendly)

Docs: docs/HERMES-AZURE-CONTAINER-APPS.md`);
}

try {
  if (cmd === 'status') status();
  else if (cmd === 'prepare-storage') prepareStorage();
  else if (cmd === 'deploy') deploy();
  else if (cmd === 'verify') verify();
  else if (cmd === 'chat-test') chatTest();
  else if (cmd === 'chat') chat();
  else if (cmd === 'bootstrap') bootstrapHermesRuntime();
  else usage();
} catch (err) {
  console.error(err.stderr || err.message || err);
  process.exit(1);
}
