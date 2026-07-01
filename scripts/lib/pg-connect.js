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

let keepAliveTimer = null;

/**
 * Keep at least one connection warm so the first page load after an idle gap
 * doesn't have to open a burst of fresh TLS connections at once (which left the
 * booking calendar's summary cards + grid blank on low-traffic staging — a
 * refresh "fixed" it because the pool was warm by then). A lightweight periodic
 * ping holds a connection open and clears any server-side idle drop.
 */
function startPoolKeepAlive(p) {
  if (keepAliveTimer) return;
  const everyMs = Number(process.env.PG_KEEPALIVE_MS || 60000);
  keepAliveTimer = setInterval(() => {
    p.query('SELECT 1').catch(() => { /* best-effort; pool self-heals broken conns */ });
  }, everyMs);
  // Never let this timer keep the process (scripts, tests) alive on its own.
  if (keepAliveTimer.unref) keepAliveTimer.unref();
  // Warm one connection immediately so the very first real request is fast.
  p.query('SELECT 1').catch(() => {});
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: Number(process.env.PG_POOL_MAX || 8),
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
      // Hold idle connections far longer than a browsing gap so the pool stays
      // warm between page loads (was 30s — too short for idle staging traffic).
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 600000),
      keepAlive: true,
    });
    startPoolKeepAlive(pool);
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
