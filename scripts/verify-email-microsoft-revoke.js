'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FAILURE_CODE,
  REVOKE_PATH,
  SUNSET_DEPLOYMENT,
  createMicrosoftTokenRevokeService,
} = require('./lib/email-microsoft-revoke');

async function main() {
  assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
  assert.equal(REVOKE_PATH, '/organizations/oauth2/v2.0/revoke');
  const src = fs.readFileSync(path.join(__dirname, 'lib/email-microsoft-revoke.js'), 'utf8');
  assert.match(src, /revokeRefreshToken/);
  assert.doesNotMatch(src, /console\.log\(.*refresh/);
  let posted;
  const service = createMicrosoftTokenRevokeService({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: '11111111-1111-1111-1111-111111111111',
    secretProvider: { getClientSecret: async () => 'secret-value' },
    transport: {
      postTokenForm: async (req) => {
        posted = req;
        return Object.freeze({ statusCode: 200, contentType: 'text/html', body: '' });
      },
    },
  });
  const out = await service.revokeRefreshToken({ refreshToken: 'rt-test-value' });
  assert.deepEqual(out, { status: 'revoked' });
  assert.equal(posted.path, REVOKE_PATH);
  assert.match(posted.body, /token=rt-test-value/);
  try {
    await service.revokeRefreshToken({ refreshToken: 'rt-test-value' });
    assert.fail('single use');
  } catch (e) {
    assert.equal(e.code, FAILURE_CODE);
  }
  console.log('verify:email-microsoft-revoke: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
