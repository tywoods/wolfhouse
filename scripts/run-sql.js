/**
 * Run a SQL file against local Wolfhouse Postgres (uses infra/.env).
 * Usage: node scripts/run-sql.js database/migrations/002_package_pricing.sql
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: node scripts/run-sql.js <path-to.sql>');
  process.exit(1);
}

const connectionString =
  process.env.WOLFHOUSE_DATABASE_URL ||
  `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${process.env.WOLFHOUSE_DB_PASSWORD || 'wolfhouse_dev_password'}@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'}`;

async function main() {
  const sql = fs.readFileSync(path.resolve(sqlFile), 'utf8');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    console.log('OK:', sqlFile);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
