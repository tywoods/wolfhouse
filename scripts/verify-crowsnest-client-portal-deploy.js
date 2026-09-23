'use strict';

const assert = require('assert/strict');
const { getCrowsnestClients } = require('./lib/crowsnest/crowsnest-clients');
const { renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');
const {
  PORTAL_DEPLOY_SOURCES,
  resolvePortalDeployRuntimeConfig,
  createCrowsnestClientPortalDeployCollector,
  mergePortalDeployIntoEvidence,
  shortRevisionLabel,
  pickActiveRevisionName,
  imageTagFromRevision,
} = require('./lib/crowsnest/crowsnest-client-portal-deploy');

const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const IDENTITY_ENDPOINT = 'http://127.0.0.1/msi/token';
const IDENTITY_HEADER = 'fixture-identity-header';

function appBody(revisionName) {
  return {
    properties: {
      latestReadyRevisionName: revisionName,
      latestRevisionName: revisionName,
      configuration: {
        ingress: {
          traffic: [{ revisionName, weight: 100 }],
        },
      },
    },
  };
}

function revisionBody(revisionName, createdTime, image) {
  return {
    name: revisionName,
    properties: {
      createdTime,
      active: true,
      trafficWeight: 100,
      template: {
        containers: [{ name: 'main', image }],
      },
    },
  };
}

async function main() {
  assert.equal(PORTAL_DEPLOY_SOURCES.length, 4);
  assert.ok(PORTAL_DEPLOY_SOURCES.every((s) => s.resource_group && s.container_app && s.origin));
  assert.equal(shortRevisionLabel('wh-staging-staff-api--0000525', 'wh-staging-staff-api'), '--0000525');
  assert.equal(
    pickActiveRevisionName(appBody('wh-staging-staff-api--0000525')),
    'wh-staging-staff-api--0000525',
  );
  assert.equal(
    imageTagFromRevision(revisionBody('x', '2026-01-01T00:00:00Z', 'whstagingacr.azurecr.io/wh-staff-api:abcdef0123456789abcdef0123456789abcdef01')),
    'abcdef01',
  );

  assert.deepEqual(resolvePortalDeployRuntimeConfig({}), { ok: false, code: 'portal_deploy_config_absent' });
  assert.equal(resolvePortalDeployRuntimeConfig({
    CROWSNEST_PORTAL_DEPLOY_AZURE_SUBSCRIPTION_ID: 'not-a-guid',
  }).ok, false);
  assert.deepEqual(resolvePortalDeployRuntimeConfig({
    CROWSNEST_PORTAL_DEPLOY_AZURE_SUBSCRIPTION_ID: SUB,
  }), { ok: true, config: { subscription_id: SUB } });

  const absent = createCrowsnestClientPortalDeployCollector({
    transport: async () => { throw new Error('should_not_call'); },
    env: {},
  });
  const absentResult = await absent(getCrowsnestClients());
  assert.equal(absentResult['wolfhouse-somo'].staging.reason, 'portal_deploy_config_absent');
  assert.equal(absentResult['wolfhouse-somo'].staging.updated_at, null);

  const calls = [];
  const created = {
    wolfhouseStaging: '2026-09-20T10:00:00.000Z',
    sunsetStaging: '2026-09-21T12:00:00.000Z',
    wolfhouseProd: '2026-09-10T08:00:00.000Z',
  };
  const collect = createCrowsnestClientPortalDeployCollector({
    now: () => Date.parse('2026-09-23T04:00:00.000Z'),
    env: {
      CROWSNEST_PORTAL_DEPLOY_AZURE_SUBSCRIPTION_ID: SUB,
      IDENTITY_ENDPOINT,
      IDENTITY_HEADER,
    },
    transport: async (url, options) => {
      calls.push({ url: String(url), method: options.method, hasAuth: Boolean(options.headers && options.headers.Authorization) });
      if (String(url).startsWith(IDENTITY_ENDPOINT)) {
        assert.equal(options.headers['X-IDENTITY-HEADER'], IDENTITY_HEADER);
        return { status: 200, json: async () => ({ access_token: 'fixture-arm-token' }) };
      }
      if (String(url).includes('/containerApps/wh-staging-staff-api?')) {
        return { status: 200, json: async () => appBody('wh-staging-staff-api--0000525') };
      }
      if (String(url).includes('/revisions/wh-staging-staff-api--0000525')) {
        return {
          status: 200,
          json: async () => revisionBody(
            'wh-staging-staff-api--0000525',
            created.wolfhouseStaging,
            'whstagingacr.azurecr.io/wh-staff-api:1111111111111111111111111111111111111111',
          ),
        };
      }
      if (String(url).includes('/containerApps/luna-sunset-staging-staff-api?')) {
        return { status: 200, json: async () => appBody('luna-sunset-staging-staff-api--0000266') };
      }
      if (String(url).includes('/revisions/luna-sunset-staging-staff-api--0000266')) {
        return {
          status: 200,
          json: async () => revisionBody(
            'luna-sunset-staging-staff-api--0000266',
            created.sunsetStaging,
            'whstagingacr.azurecr.io/luna-sunset-staff-api:2222222222222222222222222222222222222222',
          ),
        };
      }
      if (String(url).includes('/containerApps/wh-prod-staff-api?')) {
        return { status: 200, json: async () => appBody('wh-prod-staff-api--0000002') };
      }
      if (String(url).includes('/revisions/wh-prod-staff-api--0000002')) {
        return {
          status: 200,
          json: async () => revisionBody(
            'wh-prod-staff-api--0000002',
            created.wolfhouseProd,
            'whprodacr.azurecr.io/wh-staff-api:3333333333333333333333333333333333333333',
          ),
        };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  const result = await collect(getCrowsnestClients());
  assert.equal(result['wolfhouse-somo'].staging.updated_at, created.wolfhouseStaging);
  assert.equal(result['wolfhouse-somo'].staging.revision_short, '--0000525');
  assert.equal(result['wolfhouse-somo'].staging.image_tag, '11111111');
  assert.equal(result['wolfhouse-somo'].staging.source_kind, 'azure_aca_revision');
  assert.equal(result['sunset-somo'].staging.revision_short, '--0000266');
  assert.equal(result['sunset-somo'].production.revision_short, '--0000266');
  assert.equal(result['wolfhouse-somo'].production.revision_short, '--0000002');
  assert.equal(result['sunset-sardinero'].staging.updated_at, null);
  assert.ok(calls.some((c) => c.url.startsWith(IDENTITY_ENDPOINT)));
  assert.ok(calls.some((c) => c.url.includes('management.azure.com') && c.hasAuth));
  assert.ok(!calls.some((c) => /healthz/i.test(c.url)), 'deploy reader must not probe healthz');

  const portalEvidence = {
    'wolfhouse-somo': {
      staging: {
        availability: 'live',
        checked_at: '2026-09-23T03:59:00.000Z',
        source_kind: 'staff_healthz',
        reason: 'canonical_healthz_ok',
      },
      production: {
        availability: 'unknown',
        checked_at: '2026-09-23T03:59:00.000Z',
        source_kind: 'staff_healthz',
        reason: 'http_not_200',
      },
    },
    'sunset-somo': {
      staging: {
        availability: 'live',
        checked_at: '2026-09-23T03:59:00.000Z',
        source_kind: 'staff_healthz',
        reason: 'canonical_healthz_ok',
      },
      production: {
        availability: 'live',
        checked_at: '2026-09-23T03:59:00.000Z',
        source_kind: 'staff_healthz',
        reason: 'canonical_healthz_ok',
      },
    },
  };
  mergePortalDeployIntoEvidence(portalEvidence, result);
  assert.equal(portalEvidence['wolfhouse-somo'].staging.availability, 'live');
  assert.equal(portalEvidence['wolfhouse-somo'].staging.deploy_updated_at, created.wolfhouseStaging);
  assert.equal(portalEvidence['wolfhouse-somo'].staging.deploy_revision_short, '--0000525');
  assert.notEqual(
    portalEvidence['wolfhouse-somo'].staging.deploy_updated_at,
    portalEvidence['wolfhouse-somo'].staging.checked_at,
    'deploy age must not equal healthz checked_at',
  );

  const html = renderCrowsnestPage({ view: 'clients', portalEvidence });
  assert.match(html, /class="env-updated"[^>]*>Updated /);
  assert.match(html, /--0000525/);
  assert.doesNotMatch(html, /Checked /);
  assert.doesNotMatch(html, /class="env-checked"/);

  console.log('verify:crowsnest-client-portal-deploy OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
