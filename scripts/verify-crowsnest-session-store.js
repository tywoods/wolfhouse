'use strict';

const assert = require('assert');
const crypto = require('crypto');

const store = require('./lib/crowsnest/crowsnest-session-store');

async function main() {
  assert.strictEqual(store.DSN_ENV, 'CROWSNEST_SESSION_DATABASE_URL');
  assert.strictEqual(store.resolveBackend({ NODE_ENV: 'production' }), 'fail_closed');
  assert.strictEqual(store.resolveBackend({ NODE_ENV: 'production', CROWSNEST_SESSION_DATABASE_URL: 'postgres://x' }), 'postgres');
  assert.strictEqual(store.resolveBackend({ NODE_ENV: 'test' }), 'memory');

  const queries = [];
  const rows = new Map();
  const pool = { async query(sql, params = []) {
    queries.push({ sql, params });
    if (/^INSERT/i.test(sql.trim())) { rows.set(params[0], { username: params[1], expires_at: params[2] }); return { rowCount: 1, rows: [] }; }
    if (/^SELECT/i.test(sql.trim())) { const row = rows.get(params[0]); return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }; }
    if (/^DELETE/i.test(sql.trim())) { const existed = rows.delete(params[0]); return { rowCount: existed ? 1 : 0, rows: [] }; }
    throw new Error('unexpected query');
  }};
  const repo = store.createPostgresRepository({ pool });
  const token = 'raw-secret-token';
  const expiresAt = new Date(Date.now() + 60_000);
  await repo.create(token, 'earthling-op', expiresAt);
  const insertQuery = queries.find(({ sql }) => /^INSERT/i.test(sql.trim()));
  assert(insertQuery, 'session insert query recorded');
  assert(!insertQuery.params.includes(token), 'raw token must never be stored');
  const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
  assert.strictEqual(insertQuery.params[0], expectedHash);
  assert(queries.some(({ sql }) => /^DELETE FROM .*expires_at <=/i.test(sql.trim())), 'expired sessions are reclaimed on login');
  assert.deepStrictEqual(await repo.get(token), { username: 'earthling-op', expiresAt });
  const afterRestart = store.createPostgresRepository({ pool });
  assert.deepStrictEqual(await afterRestart.get(token), { username: 'earthling-op', expiresAt }, 'new process repository resolves the same durable session');
  assert.strictEqual(await afterRestart.destroy(token), true);
  assert.strictEqual(await repo.get(token), null);

  const memoryA = store.createMemoryRepository();
  await memoryA.create(token, 'earthling-op', expiresAt);
  assert.strictEqual((await memoryA.get(token)).username, 'earthling-op');
  assert.strictEqual(await memoryA.destroy(token), true);
  assert.strictEqual(await memoryA.get(token), null);

  console.log('verify:crowsnest-session-store — PASS');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
