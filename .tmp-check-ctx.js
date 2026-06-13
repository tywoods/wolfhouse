'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');

(async () => {
  const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  // Check conversations columns first
  const cols = (await pg.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations' ORDER BY ordinal_position LIMIT 20`,
  )).rows.map((r) => r.column_name);
  console.log('CONVERSATIONS COLS:', cols.join(', '));

  // Try to find by any phone reference in metadata
  const rows = (await pg.query(
    `SELECT id::text, updated_at::text, metadata::text
     FROM conversations
     WHERE metadata::text LIKE '%491726422307%'
     ORDER BY updated_at DESC
     LIMIT 3`,
  )).rows.map((r) => ({ id: r.id, updated_at: r.updated_at, meta_snippet: r.metadata.slice(0, 500) }));
  console.log(JSON.stringify(rows, null, 2));
  await pg.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
