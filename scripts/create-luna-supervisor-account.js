#!/usr/bin/env node
'use strict';

// France Wolfhouse staging only. This command never prints credentials.
const { Client } = require('pg');
const { provisionSupervisorAccount } = require('./lib/luna-supervisor-account-provisioner');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
async function main() {
  const credentialFile = arg('--credential-file');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await provisionSupervisorAccount({
      pgClient: client,
      environment: arg('--environment'),
      clientSlug: arg('--client'),
      credentialFile,
    });
    console.log(`Created Luna Supervisor account for ${result.clientSlug} ${result.environment}; credentials written to the supplied root-only file.`);
  } finally {
    await client.end();
  }
}
main().catch((error) => {
  // Deliberately do not include database errors or argument values: they can contain a DSN/path.
  console.error(`Luna Supervisor account provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
