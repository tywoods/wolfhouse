'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { markPgClientDiscardRequired } = require('./pg-connect');
const { requestId } = require('./staff-api-request-correlation');

// Deliberately narrow: never retry SQL/schema/permission errors, overload (53300),
// statement cancellation (57014), or arbitrary message substrings.
const CONNECTION_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  '08000', '08003', '08006', '57P01', '57P02', '57P03',
]);
// node-postgres also emits these exact connection errors without a code.
const CONNECTION_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
]);
const DIAGNOSTIC_CODES = new Set([
  ...CONNECTION_CODES, '42P01', '42703', '42501', '28P01', '53300', '57014', '40001', '40P01',
]);

function isSessionConnectionError(error) {
  if (!error) return false;
  if (error.code) return CONNECTION_CODES.has(error.code);
  return CONNECTION_MESSAGES.has(error.message);
}

/**
 * Auth lookup only. At most two attempts, with a new pool checkout after a
 * recognized connection failure. No session cache or auth fallback; the entire
 * validation SELECT runs again. Never wrap a business/write handler in this.
 * withPgClient retains release ownership, including discard on the final attempt.
 */
async function withStaffAuthSessionClient(withPgClient, lookup) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let stage = 'connect';
    try {
      return await withPgClient(async (client) => {
        stage = 'lookup';
        try {
          return await lookup(client);
        } catch (error) {
          if (isSessionConnectionError(error)) markPgClientDiscardRequired(client);
          throw error;
        }
      });
    } catch (error) {
      const retrying = attempt === 0 && isSessionConnectionError(error);
      // No raw error, SQL, cookie, token, DSN, user or URL. The request ID joins
      // the existing completion record; unknown error codes stay redacted.
      console.warn(JSON.stringify({
        event: 'staff_auth_session_lookup_error', request_id: requestId(), stage,
        error_code: DIAGNOSTIC_CODES.has(error && error.code) ? error.code
          : (isSessionConnectionError(error) ? 'PG_CONNECTION_ERROR' : 'other'),
        attempt: attempt + 1, retrying,
      }));
      if (!retrying) throw error;
      // Release/discard has completed. Short bounded backoff, no retry storm.
      await delay(50);
    }
  }
}

module.exports = { withStaffAuthSessionClient };
