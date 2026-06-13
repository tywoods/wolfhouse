'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(
    `UPDATE conversations conv
        SET needs_human = FALSE,
            metadata = COALESCE(conv.metadata, '{}'::jsonb) - 'luna_handoff_at' - 'luna_handoff_reason',
            updated_at = NOW()
       FROM clients c
      WHERE conv.client_id = c.id
        AND c.slug = 'wolfhouse-somo'
        AND conv.phone = '+491726422307'
      RETURNING conv.id::text, conv.needs_human`,
  );
  console.log(JSON.stringify(r.rows, null, 2));
  await pg.end();
})();
