'use strict';
/** Stage 56 deploy — open-world frontdesk (transcript + planner + composer bypass). Temp — do not commit. */

const { execSync } = require('child_process');
const { LUNA_GUEST_STAGING_V1 } = require('./scripts/lib/luna-guest-staging-profile');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-stage56-open-world`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's56-open-world';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';

const ENV_EXPECT = { ...LUNA_GUEST_STAGING_V1 };

const cmd = process.argv[2] || 'deploy';

function az(cmdStr) {
  return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties?.healthState,
    traffic: a.properties?.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick() {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of Object.keys(ENV_EXPECT)) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? e.value : null;
  }
  return out;
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function deploy() {
  console.error(`[deploy] commit=${COMMIT} image=${IMAGE}`);
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  const envArgs = Object.entries(ENV_EXPECT).map(([k, v]) => `${k}=${v}`).join(' ');
  console.error('[deploy] containerapp update + stage56 flags...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars',
    envArgs,
    '-o none',
  ].join(' '));

  for (let i = 0; i < 60; i++) {
    sleep(10000);
    const cur = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/60 rev=${cur.name} health=${cur.health} hz=${hz} image=${cur.image}`);
    if (String(cur.image || '').includes(IMAGE_TAG) && cur.health === 'Healthy' && cur.traffic === 100 && hz === '200') {
      console.log(JSON.stringify({ ok: true, revision: cur, healthz: hz, commit: COMMIT, image: IMAGE }, null, 2));
      return;
    }
  }
  console.log(JSON.stringify({ ok: false, note: 'timeout', revision: activeRevision() }, null, 2));
  process.exit(1);
}

function verify() {
  const rev = activeRevision();
  const env = envPick();
  const mismatches = Object.entries(ENV_EXPECT).filter(([k, v]) => String(env[k]) !== String(v));
  console.log(JSON.stringify({
    revision: rev,
    healthz: healthz(),
    env_mismatches: mismatches,
    frontdesk: env.LUNA_GUEST_FRONTDESK_PLANNER_ENABLED,
    composer_bypass: env.LUNA_GUEST_COMPOSER_BYPASS_ENABLED,
    auto_send: env.LUNA_AUTO_SEND_ENABLED,
    cami_model: env.LUNA_GUEST_CAMI_REPLY_AUTHOR_MODEL,
  }, null, 2));
  if (mismatches.length) process.exit(1);
}

if (cmd === 'verify') verify();
else deploy();
