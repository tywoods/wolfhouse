'use strict';

const assert = require('node:assert/strict');
const {
  HTTP_STAFF_STATUS_ORIGINS,
  resolveCrowsnestStaffStatusConfig,
  createCrowsnestStaffStatusReader,
} = require('./lib/crowsnest/crowsnest-staff-status-reader');

const TOKEN = 't'.repeat(32);
const WOLFHOUSE = 'http://ovh-wolfhouse-staff:3036';
const SUNSET = 'http://ovh-sunset-staff:3036';

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}:`, error);
      process.exitCode = 1;
    });
}

(async () => {
  await test('allowlist is exactly the two France docker staff names', () => {
    assert.deepEqual(HTTP_STAFF_STATUS_ORIGINS, Object.freeze({
      'wolfhouse-somo': WOLFHOUSE,
      sunset: SUNSET,
    }));
  });

  await test('exact http docker origins are admitted and paired to their own client', () => {
    const config = resolveCrowsnestStaffStatusConfig({
      CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN: WOLFHOUSE,
      CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN: TOKEN,
      CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN: `${SUNSET}/`,
      CROWSNEST_SUNSET_STAGING_STATUS_TOKEN: `s${TOKEN.slice(1)}`,
    });
    assert.deepEqual(config.origins, {
      'wolfhouse-somo': { staging: WOLFHOUSE },
      sunset: { staging: SUNSET },
    });
    assert.equal(config.tokens.get(WOLFHOUSE), TOKEN);
    assert.equal(config.tokens.get(SUNSET), `s${TOKEN.slice(1)}`);
  });

  await test('http is refused unless host, port, and client pairing are exact', () => {
    const rejected = [
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://ovh-sunset-staff:3036'],
      ['CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN', 'http://ovh-wolfhouse-staff:3036'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://ovh-wolfhouse-staff:3037'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://ovh-wolfhouse-staff:80'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://ovh-wolfhouse-staff.evil:3036'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://evil.ovh-wolfhouse-staff:3036'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://127.0.0.1:3036'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://localhost:3036'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://ovh-wolfhouse-staff:3036/staff'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://user:pass@ovh-wolfhouse-staff:3036'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://ovh-wolfhouse-staff:3036?x=1'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://ovh-wolfhouse-staff:3036#x'],
      ['CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN', 'http://staff-staging.lunafrontdesk.com'],
    ];
    for (const [key, value] of rejected) {
      const config = resolveCrowsnestStaffStatusConfig({
        [key]: value,
        CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN: TOKEN,
        CROWSNEST_SUNSET_STAGING_STATUS_TOKEN: TOKEN,
      });
      assert.deepEqual(config.origins, {}, value);
      assert.equal(config.tokens.size, 0, value);
    }
  });

  await test('https staff origins stay admitted and a short token still skips', () => {
    const https = resolveCrowsnestStaffStatusConfig({
      CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN: 'https://sunset-staging.lunafrontdesk.com',
      CROWSNEST_SUNSET_STAGING_STATUS_TOKEN: TOKEN,
    });
    assert.deepEqual(https.origins, {
      sunset: { staging: 'https://sunset-staging.lunafrontdesk.com' },
    });
    const shortToken = resolveCrowsnestStaffStatusConfig({
      CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN: WOLFHOUSE,
      CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN: 'short',
    });
    assert.deepEqual(shortToken.origins, {});
  });

  await test('reader sends the status token only to an allowlisted http origin', async () => {
    const config = resolveCrowsnestStaffStatusConfig({
      CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN: WOLFHOUSE,
      CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN: TOKEN,
    });
    let seen;
    const reader = createCrowsnestStaffStatusReader(config, async (url, options) => {
      seen = { url, options };
      return { ok: true, json: async () => ({ ok: true }) };
    });
    assert.deepEqual(
      await reader(`${WOLFHOUSE}/staff/admin/email-settings?client=wolfhouse-somo`),
      { ok: true },
    );
    assert.equal(seen.url, `${WOLFHOUSE}/staff/admin/email-settings?client=wolfhouse-somo`);
    assert.equal(seen.options.headers['x-crowsnest-status-token'], TOKEN);
    assert.equal(seen.options.redirect, 'error');
    assert.equal(seen.options.method, 'GET');
  });

  await test('reader refuses a hand-built http origin outside the allowlist', async () => {
    const evil = 'http://evil.example:3036';
    const reader = createCrowsnestStaffStatusReader({
      origins: { 'wolfhouse-somo': { staging: evil } },
      tokens: new Map([[evil, TOKEN]]),
    }, async () => {
      throw new Error('must not call');
    });
    await assert.rejects(
      () => reader(`${evil}/staff/admin/email-settings?client=wolfhouse-somo`),
      (error) => error && error.message === 'status_origin_not_allowed',
    );
  });

  if (process.exitCode) process.exit(process.exitCode);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
