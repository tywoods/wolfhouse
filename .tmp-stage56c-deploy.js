'use strict';
/** Stage 56c deploy — multi-booking disambiguation + post-booking service attach fixes. Temp — do not commit. */

const { execSync } = require('child_process');
const { LUNA_GUEST_STAGING_V1 } = require('./scripts/lib/luna-guest-staging-profile');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-stage56c-addon-fix`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's56c-addon-fix';
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
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

if (cmd === 'deploy') {
  console.log('Building image:', IMAGE);
  execSync(`az acr build --registry whstagingacr --image ${IMAGE_TAG} --file Dockerfile .`, { stdio: 'inherit' });

  console.log('Deploying revision...');
  const envArgs = Object.entries(ENV_EXPECT).map(([k, v]) => `${k}=${v}`).join(' ');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REV_SUFFIX} --set-env-vars ${envArgs}`);

  console.log('Waiting for revision to be active...');
  for (let i = 0; i < 18; i++) {
    sleep(5000);
    const rev = activeRevision();
    console.log(`  revision: ${rev.name} | health: ${rev.health} | image contains tag: ${String(rev.image).includes(COMMIT)}`);
    if (String(rev.name).includes(REV_SUFFIX) && rev.health === 'Healthy') {
      console.log('Deploy succeeded:', rev.name);
      break;
    }
  }

  // Smoke test: dry-run meal add-on to confirm disambiguation fires
  sleep(3000);
  const token = execSync('az keyvault secret show --vault-name wh-staging-kv --name luna-bot-internal-token --query value -o tsv', { encoding: 'utf8' }).trim();
  const body = JSON.stringify({ client_slug: 'wolfhouse-somo', channel: 'whatsapp', guest_phone: '+491726422307', message_text: 'i would like to add a meal to my booking', inbound_message_id: 'meal-smoke-56c' });
  const raw = execSync(`curl -sf -X POST https://${STAFF_HOST}/staff/bot/guest-inbound-review-dry-run -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${body}'`, { encoding: 'utf8' });
  const j = JSON.parse(raw);
  const reply = j.review && j.review.proposed_luna_reply;
  const isDisambig = /active bookings|which.*add/i.test(reply || '');
  const mealsStatus = j.review && j.review.result && j.review.result.meals_status;
  console.log('Smoke: meals_status =', mealsStatus, '| disambiguation reply =', isDisambig);
  console.log('Reply:', reply && reply.slice(0, 200));
}
