'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();
const WAMID = 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMEU5QTU5MjM4MjY0RkYwNkYzQgA=';

(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT metadata->'luna_inbound_reviews'->'wolfhouse-somo:whatsapp:wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMEU5QTU5MjM4MjY0RkYwNkYzQgA=' AS blob
      FROM conversations c JOIN clients cl ON cl.id=c.client_id
     WHERE cl.slug='wolfhouse-somo' AND c.phone='+491726422307'`);
  const review = r.rows[0]?.blob?.review;
  console.log(JSON.stringify({
    payment_choice: review?.payment_choice,
    hold_payment_draft_plan: review?.hold_payment_draft_plan,
    quote_status: review?.quote?.quote_status,
    availability: review?.availability,
    handoff_reasons: review?.handoff_reasons,
    proposed_next_action: review?.proposed_next_action,
  }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
