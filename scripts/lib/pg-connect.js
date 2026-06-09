const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

/** @type {import('pg').Pool | null} */
let pool = null;

function getConnectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL ||
    `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${process.env.WOLFHOUSE_DB_PASSWORD}@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'}`
  );
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: Number(process.env.PG_POOL_MAX || 8),
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    });
  }
  return pool;
}

async function withPgClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { getConnectionString, withPgClient };
