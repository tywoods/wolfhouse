'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT c.metadata->'luna_guest_context'->'extracted_fields' AS fields,
           c.metadata->'luna_guest_context' AS ctx
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone IN ('+34600995569','34600995569')
     ORDER BY c.updated_at DESC LIMIT 1`);
  console.log(JSON.stringify(r.rows[0], null, 2));
  await pg.end();
})();
