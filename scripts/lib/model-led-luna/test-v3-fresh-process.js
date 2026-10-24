'use strict';

const { Client } = require('pg');
const api = require('./index');

async function main() {
  const url = process.env.V3_TEST_DATABASE_URL;
  const payload = JSON.parse(process.env.V3_FRESH_PROCESS_PAYLOAD || '{}');
  if (!url) throw new Error('V3_TEST_DATABASE_URL required');
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const context = {
    tenantId: 'wolfhouse-somo',
    authenticated: true,
    sessionId: payload.sessionId,
    principalId: 'staff-api-authenticated',
    writeAllowed: true,
    guestPhone: '+346****0000',
    staffAuthorities: { resolveBookingAdmission: async () => ({ allowed: true, source: 'test_policy' }) },
  };
  try {
    const result = payload.action === 'book'
      ? await api.book(pg, payload.input, context)
      : await api.recoverOperation(pg, payload.input, context);
    if (payload.dropResponse !== true) process.stdout.write(JSON.stringify(result));
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
