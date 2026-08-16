'use strict';
const assert = require('node:assert/strict');
const { createStaffEmailGoogleOAuthRoutes, GOOGLE_OAUTH_CALLBACK_PATH } = require('./lib/staff-email-google-oauth-routes');
const { createStaffGoogleOAuthProductionIntegration } = require('./lib/staff-google-oauth-production-integration');

const STATE = 'A'.repeat(43);
const CODE = 'dummy-code';
const GOOGLE_ISSUER = 'https%3A%2F%2Faccounts.google.com';
const EXACT_GOOGLE_QUERY = `state=${STATE}&iss=${GOOGLE_ISSUER}&code=${CODE}&scope=openid%20email&authuser=0&prompt=consent`;
const enabled = Object.freeze({
  LUNA_DEPLOYMENT: 'sunset-staging',
  LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED: 'false',
  LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'false',
  LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED: 'true',
});
const received = Object.freeze(Object.defineProperty({}, 'status', {
  value: 'received', enumerable: true, writable: false, configurable: false,
}));

function harness() {
  const replies = [];
  const runtimeQueries = [];
  const deps = Object.freeze({
    runtimeEnv: enabled,
    sendJSON() { throw Error('unexpected JSON response'); },
    sendHTML(_res, status, body) { replies.push([status, body]); },
    withPgClient(fn) { return fn(Object.freeze({ query() { throw Error('token exchange must not run'); } })); },
    createCallbackRuntime() {
      return Object.freeze({
        completeCallback(input) { runtimeQueries.push(input.query); return received; },
      });
    },
  });
  return { routes: createStaffEmailGoogleOAuthRoutes(deps), replies, runtimeQueries };
}

async function invoke(routes, query) {
  return routes.handleCallback({ method: 'GET', url: `${GOOGLE_OAUTH_CALLBACK_PATH}?${query}` }, {});
}

(async () => {
  const focused = harness();
  await invoke(focused.routes, EXACT_GOOGLE_QUERY);
  assert.equal(focused.replies.at(-1)[0], 200, 'exact Google callback must reach callback runtime');
  assert.deepEqual(focused.runtimeQueries, [`state=${STATE}&code=${CODE}`], 'issuer and provider metadata must not reach consume query');

  const rejected = [
    `state=${STATE}&iss=https%3A%2F%2Fevil.example&code=${CODE}`,
    `state=${STATE}&iss=%ZZ&code=${CODE}`,
    `state=${STATE}&iss=${GOOGLE_ISSUER}&iss=${GOOGLE_ISSUER}&code=${CODE}`,
    `state=${STATE}&iss&code=${CODE}`,
    `state=${STATE}&iss=&code=${CODE}`,
    `state=${STATE}&iss=${GOOGLE_ISSUER}&code=${CODE}&extra=x`,
    `state=${STATE}&iss=${GOOGLE_ISSUER}&error=access_denied`,
  ];
  for (const query of rejected) {
    const before = focused.runtimeQueries.length;
    await invoke(focused.routes, query);
    assert.equal(focused.replies.at(-1)[0], 400, `must reject: ${query}`);
    assert.equal(focused.runtimeQueries.length, before, 'rejected callback must not reach runtime');
  }

  const integrated = harness();
  const adapter = createStaffGoogleOAuthProductionIntegration(Object.freeze({
    env: enabled,
    sendJSON() { throw Error('unexpected JSON response'); },
    sendHTML(_res, status, body) { integrated.replies.push([status, body]); },
    googleRoutes: integrated.routes,
  }));
  await adapter.dispatch({ method: 'GET', url: `${GOOGLE_OAUTH_CALLBACK_PATH}?state=${STATE}&iss=https%3A%2F%2Fevil.example&code=${CODE}` }, {}, GOOGLE_OAUTH_CALLBACK_PATH);
  assert.equal(integrated.replies.at(-1)[0], 400, 'invalid issuer must receive parser-level 400, not generic 404');
  assert.equal(integrated.runtimeQueries.length, 0);
  await adapter.dispatch({ method: 'GET', url: `${GOOGLE_OAUTH_CALLBACK_PATH}?${EXACT_GOOGLE_QUERY}` }, {}, GOOGLE_OAUTH_CALLBACK_PATH);
  assert.equal(integrated.replies.at(-1)[0], 200);
  assert.deepEqual(integrated.runtimeQueries, [`state=${STATE}&code=${CODE}`]);

  console.log('PASS EMAIL-GMAIL-CALLBACK-001 strict Google issuer callback parsing and integrated routing');
})().catch(error => { console.error(error); process.exitCode = 1; });
