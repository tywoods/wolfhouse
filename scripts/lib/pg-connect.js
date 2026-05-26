const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

function getConnectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL ||
    `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${process.env.WOLFHOUSE_DB_PASSWORD}@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'}`
  );
}

async function withPgClient(fn) {
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

module.exports = { getConnectionString, withPgClient };
