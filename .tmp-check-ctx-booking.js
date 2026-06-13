'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DB_URL });
async function main() {
  await client.connect();
  const r = await client.query(
    `SELECT c.id, c.metadata->'luna_guest_context' AS lgc,
            c.metadata->'guest_context' AS gc
     FROM conversations c
     JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = '+491726422307'`
  );
  console.log(JSON.stringify(r.rows[0], null, 2));
  await client.end();
}
main().catch(e => console.error(e.message));
