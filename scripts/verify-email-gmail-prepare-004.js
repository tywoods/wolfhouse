'use strict';
const assert = require('node:assert/strict');
const {
  createGoogleOAuthTransactionRepository,
} = require('./lib/email-google-oauth-transaction-repository');

const frozen = Object.freeze;
const OPERATION = '99999999-8888-4777-8666-555555555555';
const EXPIRES = '2026-08-16T10:43:21.284Z';
const input = frozen({
  clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  locationId: '11111111-2222-4333-8444-555555555555',
  endpointId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  staffUserId: 'abcdef01-2345-4678-89ab-cdef01234567',
  authSessionId: '12345678-90ab-4cde-8fab-1234567890ab',
  operationId: OPERATION,
  stateHash: '0123456789abcdef'.repeat(4),
  codeVerifier: `${'V'.repeat(41)}-._~`,
  nonce: `${'N'.repeat(42)}_`,
  issuedAt: '2026-08-16T10:33:21.284Z',
  expiresAt: EXPIRES,
});

let capturedSql;
const queryOwner = frozen({
  query(sql) {
    capturedSql = sql;
    // Truthfully model node-postgres: a bare timestamptz is a native Date, while the
    // explicit PostgreSQL text projection is returned as the canonical string.
    const canonicalTextProjection = /to_char\(expires_at AT TIME ZONE 'UTC',\s*'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\) AS expires_at/.test(sql);
    return frozen({ rows: frozen([frozen({
      operation_id: OPERATION,
      expires_at: canonicalTextProjection ? EXPIRES : new Date(EXPIRES),
    })]) });
  },
});

(async () => {
  const repository = createGoogleOAuthTransactionRepository(frozen({ queryOwner }));
  const acknowledgement = await repository.create(input);
  assert.match(capturedSql, /operation_id::text AS operation_id/);
  assert.match(capturedSql, /to_char\(expires_at AT TIME ZONE 'UTC',\s*'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\) AS expires_at/);
  assert.deepEqual(acknowledgement, frozen({ operationId: OPERATION, expiresAt: EXPIRES }));
  assert.equal(typeof acknowledgement.expiresAt, 'string');
  assert.equal(acknowledgement.expiresAt, input.expiresAt);
  console.log('PASS EMAIL-GMAIL-PREPARE-004 genuine pg timestamptz shape receives exact canonical string acknowledgement');
})().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
