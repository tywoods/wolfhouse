#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const { cleanup } = require('./lib/wolfhouse-prod-simulator-cleanup');

async function main() {
  const deleteConfirmed = process.argv.includes('--confirm-wolfhouse-prod-test-data');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await cleanup(client, { deleteConfirmed });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!deleteConfirmed) process.stdout.write('Dry-list only. Re-run with --confirm-wolfhouse-prod-test-data to delete exactly the listed scoped records.\n');
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
