'use strict';

/**
 * Apply a single SQL migration file against the DB reachable via pg-connect
 * (WOLFHOUSE_DATABASE_URL). Runs the whole file in one simple-query batch, so the
 * file must manage its own BEGIN/COMMIT. Intended to run inside the tenant's
 * Container Apps environment (the DB is only reachable there).
 *
 *   node scripts/run-migration.js database/migrations/031_customers.sql
 *   MIGRATION_FILE=database/migrations/031_customers.sql node scripts/run-migration.js
 */

const fs = require('fs');
const path = require('path');
const { withPgClient } = require(path.join(__dirname, 'lib', 'pg-connect'));

const rel = process.env.MIGRATION_FILE || process.argv[2];
if (!rel) {
  console.error('usage: run-migration.js <path-to-sql>  (or MIGRATION_FILE env)');
  process.exit(1);
}
const file = path.isAbsolute(rel) ? rel : path.join(__dirname, '..', rel);
const sql = fs.readFileSync(file, 'utf8');

withPgClient((c) => c.query(sql))
  .then(() => { console.log('MIGRATION OK:', rel); process.exit(0); })
  .catch((e) => { console.error('MIGRATION FAIL:', e.message); process.exit(1); });
