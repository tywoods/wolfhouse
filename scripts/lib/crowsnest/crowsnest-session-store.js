'use strict';

const crypto = require('crypto');

const DSN_ENV = 'CROWSNEST_SESSION_DATABASE_URL';
const TABLE = 'crowsnest_comms.auth_sessions';
const POOL_MAX = 4;
let poolSingleton = null;
let repositorySingleton = null;

function resolveBackend(env = process.env) {
  if (String(env[DSN_ENV] || '').trim()) return 'postgres';
  return String(env.NODE_ENV || '').toLowerCase() === 'production' ? 'fail_closed' : 'memory';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function createMemoryRepository() {
  const rows = new Map();
  return {
    backend: 'memory',
    async create(token, username, expiresAt) { rows.set(tokenHash(token), { username, expiresAt }); },
    async get(token) {
      const key = tokenHash(token);
      const row = rows.get(key);
      if (!row) return null;
      if (row.expiresAt <= new Date()) { rows.delete(key); return null; }
      return { username: row.username, expiresAt: row.expiresAt };
    },
    async destroy(token) { return rows.delete(tokenHash(token)); },
  };
}

function createFailClosedRepository() {
  return {
    backend: 'fail_closed',
    async create() { throw new Error('Crowsnest session store is not configured'); },
    async get() { return null; },
    async destroy() { return false; },
  };
}

function getPool(options = {}) {
  if (options.pool) return options.pool;
  if (poolSingleton) return poolSingleton;
  const { Pool } = require('pg');
  const env = options.env || process.env;
  const connectionString = String(options.databaseUrl || env[DSN_ENV] || '').trim();
  if (!connectionString) throw new Error(`${DSN_ENV} is required`);
  poolSingleton = new Pool({ connectionString, max: POOL_MAX, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
  return poolSingleton;
}

function createPostgresRepository(options = {}) {
  const pool = getPool(options);
  return {
    backend: 'postgres',
    async create(token, username, expiresAt) {
      await pool.query(`DELETE FROM ${TABLE} WHERE expires_at <= clock_timestamp()`);
      await pool.query(`INSERT INTO ${TABLE} (token_hash, username, expires_at) VALUES ($1, $2, $3)`, [tokenHash(token), String(username || '').trim(), expiresAt]);
    },
    async get(token) {
      const result = await pool.query(`SELECT username, expires_at FROM ${TABLE} WHERE token_hash = $1 AND expires_at > clock_timestamp()`, [tokenHash(token)]);
      if (!result.rows[0]) return null;
      return { username: result.rows[0].username, expiresAt: result.rows[0].expires_at };
    },
    async destroy(token) {
      const result = await pool.query(`DELETE FROM ${TABLE} WHERE token_hash = $1`, [tokenHash(token)]);
      return result.rowCount > 0;
    },
  };
}

function createRepository(env = process.env) {
  const backend = resolveBackend(env);
  if (backend === 'postgres') return createPostgresRepository({ env });
  if (backend === 'memory') return createMemoryRepository();
  return createFailClosedRepository();
}

function getRepository(env = process.env) {
  if (!repositorySingleton) repositorySingleton = createRepository(env);
  return repositorySingleton;
}

async function closeSessionStore() {
  repositorySingleton = null;
  if (!poolSingleton) return;
  const pool = poolSingleton;
  poolSingleton = null;
  await pool.end();
}

function _resetForTests() { repositorySingleton = null; poolSingleton = null; }

module.exports = { DSN_ENV, resolveBackend, tokenHash, createMemoryRepository, createFailClosedRepository, createPostgresRepository, createRepository, getRepository, closeSessionStore, _resetForTests };
