'use strict';
const { Client } = require('pg');
const fs = require('fs');

const TEMP_HASH = process.argv[2];
const MODE = process.argv[3] || 'save';

(async () => {
  const c = new Client({
    connectionString: process.env.N8N_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  if (MODE === 'save') {
    const r = await c.query('SELECT password FROM "user" WHERE email = $1', ['tywoods@gmail.com']);
    fs.writeFileSync('.tmp-n8n-pw-hash.txt', r.rows[0].password, 'utf8');
    console.log('saved_hash');
  } else if (MODE === 'set-temp') {
    await c.query('UPDATE "user" SET password = $1, "updatedAt" = NOW() WHERE email = $2', [
      TEMP_HASH,
      'tywoods@gmail.com',
    ]);
    console.log('set_temp');
  } else if (MODE === 'restore') {
    const hash = fs.readFileSync('.tmp-n8n-pw-hash.txt', 'utf8');
    await c.query('UPDATE "user" SET password = $1, "updatedAt" = NOW() WHERE email = $2', [
      hash,
      'tywoods@gmail.com',
    ]);
    console.log('restored');
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
