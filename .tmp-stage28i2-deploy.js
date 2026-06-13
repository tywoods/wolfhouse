'use strict';
/** Stage 28i.2 — deploy 44cd4b9 conversation brain + package night rules. Temp — do not commit. */
const { execSync } = require('child_process');

const COMMIT = '44cd4b9';
const IMAGE_TAG = `${COMMIT}-stage28i1-brain-package-rules`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's28i2-brain-package-rules';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const DEMO_PHONE_ID = '1152900101233109';

const PLAYGROUND_ON_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  LUNA_CONVERSATION_BRAIN_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_LLM_ENABLED: 'false',
};

function az(cmdStr, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      last = err;
      if (i < retries - 1) {
        const until = Date.now() + 2000;
        while (Date.now() < until) { /* backoff */ }
      }
    }
  }
  throw last;
}

function setEnvVars(pairs) {
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`, '-o none',
  ].join(' '));
}

function envPick(names) {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : (e.value ?? null)) : null;
  }
  return out;
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
    created: a.properties?.createdTime,
  };
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function deploy() {
  const head = az('git rev-parse --short HEAD');
  if (!head.startsWith(COMMIT)) throw new Error(`HEAD is ${head}, expected ${COMMIT}`);
  console.error(`[deploy] acr build ${IMAGE_TAG}...`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--image ${IMAGE}`, `--revision-suffix ${REV_SUFFIX}`, '-o none',
  ].join(' '));
  console.error('[deploy] re-apply playground ON gates + conversation brain...');
  setEnvVars(PLAYGROUND_ON_ENV);
  for (let i = 0; i < 45; i++) {
    const rev = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/45 rev=${rev.name} health=${rev.health} traffic=${rev.traffic} hz=${hz}`);
    if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

try {
  const before = activeRevision();
  const rev = deploy();
  const gates = envPick([
    ...Object.keys(PLAYGROUND_ON_ENV),
    'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
    'NODE_ENV',
    'N8N_ENABLED',
  ]);
  console.log(JSON.stringify({
    pass: String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && healthz() === '200',
    before,
    after: rev,
    gates,
    healthz: healthz(),
    image: IMAGE,
    meta_webhook: `https://${STAFF_HOST}/staff/meta/whatsapp/webhook`,
    retest1: ['hi', 'book a stay', 'July 1-5', '1'],
    retest2: ['hi', 'book a stay', 'July 10-17', '1'],
    retest3: ['Malibu July 10 to July 17 for 1'],
    prep: 'Use Fresh Start on +491726422307 before retest if prior context remains',
  }, null, 2));
} catch (e) {
  console.error(e.stderr || e.stdout || e.message || e);
  process.exit(1);
}
