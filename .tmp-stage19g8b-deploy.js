'use strict';
/** Phase 19g.8b — apply migration + deploy helper. Temp — do not commit. */
const fs = require('fs');
const { execSync } = require('child_process');
const { Client } = require('pg');

const COMMIT = 'da14a74';
const IMAGE_TAG = `${COMMIT}-stage19g8-meta-inbound-persist`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

async function applyMigration() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = await pg.query("SELECT to_regclass('public.guest_message_events') AS t");
  let applied = 'already_exists';
  if (!before.rows[0].t) {
    const sql = fs.readFileSync('database/migrations/014_guest_message_events.sql', 'utf8');
    await pg.query(sql);
    applied = 'applied_now';
  }
  const unique = await pg.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'guest_message_events'::regclass AND contype = 'u'`,
  );
  const tableOk = await pg.query("SELECT to_regclass('public.guest_message_events') AS t");
  await pg.end();
  return { applied, table: tableOk.rows[0].t, unique_constraints: unique.rows.map((r) => r.conname) };
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  return rows.find((x) => x.properties.trafficWeight === 100) || rows[0] || {};
}

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
  };
}

async function main() {
  const step = process.argv[2] || 'all';
  const out = { commit: COMMIT, image: IMAGE };

  if (step === 'migrate' || step === 'all') {
    out.migration = await applyMigration();
    console.log(JSON.stringify({ phase: 'migrate', ...out }, null, 2));
  }

  if (step === 'deploy' || step === 'all') {
    const revBefore = activeRevision();
    out.revision_before = revBefore.name;
    out.image_before = revBefore.properties?.template?.containers?.[0]?.image;

    if (!String(out.image_before || '').includes(COMMIT.slice(0, 7))) {
      console.error('Building image...');
      az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
      console.error('Updating container app...');
      az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix stage19g8-meta-inbound-persist`);
    } else {
      out.deploy_skipped = true;
    }

    for (let i = 0; i < 36; i++) {
      const rev = activeRevision();
      const img = rev.properties?.template?.containers?.[0]?.image || '';
      if (rev.properties?.healthState === 'Healthy'
        && rev.properties?.trafficWeight === 100
        && img.includes('da14a74')) {
        out.revision_after = rev.name;
        out.image_after = img;
        out.health = rev.properties?.healthState;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    out.env = stagingEnvFlags();
    console.log(JSON.stringify({ phase: 'deploy', ...out }, null, 2));
  }
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
