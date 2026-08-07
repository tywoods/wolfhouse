'use strict';

/**
 * Offline RED-GREEN gate: Sunset inbound-diagnostic runtime composition.
 *
 * Default-off exact flag; composes access-session + ImmutableId transport +
 * authority-bound operation + factory-fixed diagnostic consumer. No network,
 * no persistence, no logs, no flag in manifests/defaults.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMPOSITION_REL =
  'scripts/lib/email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition.js';
const COMPOSITION_ABS = path.join(ROOT, COMPOSITION_REL);
const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KEY_ID = `https://${HOST}/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032`;
const MI = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const SECRET = 'secret-NEVER_LEAK_INBOUND_DIAG';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESOURCE = '22222222-2222-4222-8222-2222222222ab';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_INBOUND_DIAG_AT';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_ON_INBOUND_DIAG';
const PLANTED_ADDRESS = 'pii-inbound-diag@example.com';

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID,
    LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KEY_ID,
    ...patch,
  };
}

function installAzureLoadIntercept() {
  const original = Module._load;
  Module._load = function intercepted(request, parent, isMain) {
    if (request === '@azure/identity') {
      return {
        ManagedIdentityCredential: class {
          constructor(clientId) { assert.equal(clientId, MI); }
          getToken() {
            return Promise.resolve({ token: 'x', expiresOnTimestamp: Date.now() + 1 });
          }
        },
      };
    }
    if (request === '@azure/keyvault-keys') {
      return {
        CryptographyClient: class {
          constructor(keyId) { assert.equal(keyId, KEY_ID); }
          wrapKey() { return Promise.resolve({ result: Buffer.alloc(256) }); }
          unwrapKey() { return Promise.resolve({ result: Buffer.alloc(32) }); }
        },
      };
    }
    return original.call(this, request, parent, isMain);
  };
  return () => { Module._load = original; };
}

function noLeak(v) {
  const s = typeof v === 'string' ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return !s.includes(PLANTED_TOKEN)
    && !s.includes(PLANTED_SUBJECT)
    && !s.includes(PLANTED_ADDRESS)
    && !s.includes(SECRET)
    && !s.includes('NEVER_LEAK')
    && !s.includes('processed')
    && !s.includes('delivered')
    && !s.includes('refresh_token')
    && !s.includes('Authorization');
}

async function main() {
  const restore = installAzureLoadIntercept();
  try {
    delete require.cache[COMPOSITION_ABS];
    const mod = require('./lib/email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition');
    const {
      ERROR_CODE,
      ENV_INBOUND_DIAGNOSTIC_ENABLED,
      SUNSET_DEPLOYMENT,
      WORKER_ID,
      PUBLIC_RESULT_KEYS,
      PUBLIC_STATUS_OK,
      MAX_COUNT,
      DIAGNOSTIC_INBOUND_CONSUMER,
      isInboundDiagnosticEnabled,
      mapPublicDiagnosticResult,
      createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime,
    } = mod;

    // ── Flag isolation ────────────────────────────────────────────────────
    assert.equal(ENV_INBOUND_DIAGNOSTIC_ENABLED, 'LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED');
    assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
    assert.equal(WORKER_ID, 'sunset-email-inbound-diagnostic');
    assert.equal(PUBLIC_STATUS_OK, 'ok');
    assert.equal(MAX_COUNT, 5);
    assert.deepEqual(
      [...PUBLIC_RESULT_KEYS],
      ['status', 'received_count', 'accepted_count', 'discarded_count'],
    );
    for (const forbidden of ['input_count', 'unique_count', 'duplicate_count', 'delivered_count']) {
      assert.equal(PUBLIC_RESULT_KEYS.includes(forbidden), false, forbidden);
    }

    assert.equal(isInboundDiagnosticEnabled({}), false);
    assert.equal(isInboundDiagnosticEnabled(null), false);
    assert.equal(isInboundDiagnosticEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
    }), false, 'flag absent → off');
    assert.equal(isInboundDiagnosticEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'TRUE',
    }), false, 'case-sensitive true only');
    assert.equal(isInboundDiagnosticEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: '1',
    }), false);
    assert.equal(isInboundDiagnosticEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'false',
    }), false);
    assert.equal(isInboundDiagnosticEnabled({
      LUNA_DEPLOYMENT: 'production',
      LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
    }), false, 'production → off');
    assert.equal(isInboundDiagnosticEnabled({
      LUNA_DEPLOYMENT: 'wolfhouse',
      LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
    }), false, 'wolfhouse deployment → off');
    assert.equal(isInboundDiagnosticEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
    }), true);

    // Isolation from sibling flags.
    const {
      isReadHealthEnabled,
    } = require('./lib/email-microsoft-delegated-read-sunset-staging-runtime-composition');
    const {
      isRefreshHealthEnabled,
    } = require('./lib/email-microsoft-delegated-refresh-sunset-staging-runtime-composition');
    const { isStartEnabled, isCallbackEnabled } = require('./lib/email-microsoft-oauth-transaction-service');

    const onlyInbound = {
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
    };
    assert.equal(isInboundDiagnosticEnabled(onlyInbound), true);
    assert.equal(isReadHealthEnabled(onlyInbound), false, 'must not enable read-health');
    assert.equal(isRefreshHealthEnabled(onlyInbound), false, 'must not enable refresh-health');
    assert.equal(isStartEnabled(onlyInbound), false);
    assert.equal(isCallbackEnabled(onlyInbound), false);

    const onlyRead = {
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED: 'true',
    };
    assert.equal(isReadHealthEnabled(onlyRead), true);
    assert.equal(isInboundDiagnosticEnabled(onlyRead), false, 'read-health must not enable inbound diag');

    // ── Factory-fixed diagnostic consumer: zero element touches ───────────
    assert.equal(typeof DIAGNOSTIC_INBOUND_CONSUMER, 'function');
    const hostileEnvelopes = Object.freeze([
      Object.freeze({
        provider: 'microsoft_graph',
        provider_mailbox_id: RESOURCE,
        provider_message_id: 'AAMk-PII',
        received_at: '2026-08-06T12:00:00.000Z',
        subject: PLANTED_SUBJECT,
        sender_display_name: 'Guest',
        sender_address: PLANTED_ADDRESS,
        is_read: false,
        conversation_id: 'conv',
        internet_message_id: '<a@b>',
      }),
    ]);
    // Proxy that traps any get/ownKeys/apply on elements — consumer must not touch.
    let envelopeTouches = 0;
    const proxiedLoan = new Proxy(hostileEnvelopes, {
      get(t, p, r) {
        envelopeTouches += 1;
        return Reflect.get(t, p, r);
      },
      ownKeys(t) {
        envelopeTouches += 1;
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t, p) {
        envelopeTouches += 1;
        return Reflect.getOwnPropertyDescriptor(t, p);
      },
    });
    const ack = DIAGNOSTIC_INBOUND_CONSUMER(proxiedLoan);
    assert.equal(envelopeTouches, 0, 'diagnostic consumer must zero-touch envelopes');
    assert.deepEqual(Reflect.ownKeys(ack), ['acknowledged']);
    assert.equal(ack.acknowledged, true);
    assert.equal(Object.isFrozen(ack), true);
    // Sync handoff — never a Promise / durability claim.
    assert.equal(typeof ack.then, 'undefined');
    assert.ok(noLeak(ack));

    // Source-level: consumer body never references length/for/map/JSON/log.
    const compSrc = fs.readFileSync(COMPOSITION_ABS, 'utf8');
    const consumerIdx = compSrc.indexOf('function diagnosticInboundConsumer');
    assert.ok(consumerIdx >= 0);
    const consumerSlice = compSrc.slice(consumerIdx, consumerIdx + 400);
    assert.match(consumerSlice, /acknowledged:\s*true/);
    assert.equal(/for\s*\(|\.map\(|\.forEach\(|\.length|JSON\.|console\.|fs\.|writeFile|persist|log\(/i
      .test(consumerSlice), false, 'consumer must not iterate/log/persist');

    // No duplicate refresh/custody ownership in composition.
    assert.equal(/tryAcquireDelegatedGrantLease|openDelegatedGrantUnderLease|commitDelegatedGrantRotation|exchangeRefreshToken|createMicrosoftRefreshTokenRequestService/
      .test(compSrc), false, 'no refresh/custody duplication');
    assert.match(compSrc, /createDelegatedGrantAccessSession/);
    assert.match(compSrc, /createAuthorityBoundInboundOperation/);
    assert.match(compSrc, /createMicrosoftGraphImmutableIdPageTransport/);
    // No timer/cron/poller wiring; comments may mention "startup" as a non-goal.
    assert.equal(/setInterval\s*\(|\.cron\b|createPoller|startPolling/i.test(compSrc), false);
    assert.equal(
      /require\(['"]node:cron['"]\)|require\(['"]cron['"]\)/.test(compSrc),
      false,
    );

    // No flag in manifests/defaults (composition documents exact env only).
    const manifestPaths = [
      'docker/hermes-staging/docker-compose.vm.yml',
      'config/clients/sunset.baseline.json',
      'Dockerfile.luna-sunset-staff-api',
    ];
    for (const rel of manifestPaths) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) continue;
      const body = fs.readFileSync(p, 'utf8');
      assert.equal(
        body.includes('LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED'),
        false,
        `flag must not appear in ${rel}`,
      );
    }

    // ── Public result mapping (internal → public vocabulary) ──────────────
    const mapped = mapPublicDiagnosticResult(Object.freeze({
      status: 'processed',
      input_count: 3,
      delivered_count: 2,
      duplicate_count: 1,
    }));
    assert.deepEqual(Reflect.ownKeys(mapped), [...PUBLIC_RESULT_KEYS]);
    assert.equal(mapped.status, 'ok');
    assert.equal(mapped.received_count, 3);
    assert.equal(mapped.accepted_count, 2);
    assert.equal(mapped.discarded_count, 1);
    assert.ok(noLeak(mapped));
    assert.equal(JSON.stringify(mapped).includes('processed'), false);
    assert.equal(JSON.stringify(mapped).includes('delivered'), false);
    assert.equal(JSON.stringify(mapped).includes('input_count'), false);
    assert.equal(JSON.stringify(mapped).includes('unique_count'), false);
    assert.equal(JSON.stringify(mapped).includes('duplicate_count'), false);

    assert.equal(mapPublicDiagnosticResult(Object.freeze({
      status: 'processed',
      input_count: 6,
      delivered_count: 6,
      duplicate_count: 0,
    })), null, 'max5 invariant');
    assert.equal(mapPublicDiagnosticResult(Object.freeze({
      status: 'ok',
      input_count: 1,
      delivered_count: 1,
      duplicate_count: 0,
    })), null, 'internal status must be processed');
    assert.equal(mapPublicDiagnosticResult(Object.freeze({
      status: 'processed',
      input_count: 2,
      delivered_count: 1,
      duplicate_count: 0,
    })), null, 'count invariant delivered+dup=input');

    // ── Factory hostile / readiness ───────────────────────────────────────
    assert.throws(
      () => createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime(Object.freeze({
        env: enabledEnv({ LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'false' }),
        pgClient: { query: async () => ({ rows: [] }) },
        https: { request() {} },
        timers: { setTimeout, clearTimeout },
      })),
      (e) => e && e.code === ERROR_CODE && noLeak(e),
    );

    assert.throws(
      () => createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime(Object.freeze({
        env: enabledEnv({ LUNA_DEPLOYMENT: 'production' }),
        pgClient: { query: async () => ({ rows: [] }) },
        https: { request() {} },
        timers: { setTimeout, clearTimeout },
      })),
      (e) => e && e.code === ERROR_CODE,
    );

    assert.throws(
      () => createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime(Object.freeze({
        env: enabledEnv(),
        // Pool-shaped — reject
        pgClient: {
          query: async () => ({ rows: [] }),
          connect: async () => {},
          totalCount: 1,
          idleCount: 0,
        },
        https: { request() {} },
        timers: { setTimeout, clearTimeout },
      })),
      (e) => e && e.code === ERROR_CODE,
    );

    const runtime = createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime(Object.freeze({
      env: enabledEnv(),
      pgClient: { query: async () => ({ rows: [] }) },
      https: Object.freeze({ request() { throw new Error('no_network'); } }),
      timers: Object.freeze({ setTimeout, clearTimeout }),
    }));
    assert.equal(typeof runtime.runInboundDiagnostic, 'function');
    assert.deepEqual(Reflect.ownKeys(runtime), ['runInboundDiagnostic']);

    // Operation failure (empty authority) → sanitized throw, no PII/token leak.
    await assert.rejects(
      () => runtime.runInboundDiagnostic(Object.freeze({
        clientId: CLIENT,
        locationId: LOCATION,
        endpointId: ENDPOINT,
      })),
      (e) => e && e.code === ERROR_CODE && noLeak(e),
    );

    // ── package script ────────────────────────────────────────────────────
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(
      pkg.scripts['verify:email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition'],
      'node scripts/verify-email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition.js',
    );

    console.log('verify:email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition: ok');
  } finally {
    restore();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
