'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { getCrowsnestClients } = require('./lib/crowsnest/crowsnest-clients');
const { renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');
const {
  PORTAL_DEPLOY_SOURCES,
  STAMP_TOKEN_ENV,
  STAMP_SOURCE_KIND,
  shortRevisionLabel,
  validateStampInput,
  createPortalDeployStampStore,
  createCrowsnestClientPortalDeployCollector,
  mergePortalDeployIntoEvidence,
  _resetPortalDeployStampStoreForTests,
} = require('./lib/crowsnest/crowsnest-client-portal-deploy');

const api = require('./crowsnest-api');
const TOKEN = 'portal-deploy-stamp-test-token-32chars!!';

function mockReq({ method = 'PUT', auth, body = '' }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = auth ? { authorization: auth } : {};
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b == null ? '' : String(b); },
  };
}

async function callStamp(opts = {}) {
  const method = opts.method || 'PUT';
  const res = mockRes();
  await api.handlePortalDeployStamp(mockReq({ ...opts, method }), res, method);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non-json */ }
  return { status: res.statusCode, json, headers: res.headers };
}

async function main() {
  assert.equal(PORTAL_DEPLOY_SOURCES.length, 4);
  assert.ok(PORTAL_DEPLOY_SOURCES.every((s) => s.client && s.environment && s.origin && s.slug));
  assert.ok(PORTAL_DEPLOY_SOURCES.every((s) => !s.resource_group && !s.container_app),
    'deploy stamps must not require Azure RG/app locks');

  assert.equal(shortRevisionLabel('wh-staging-staff-api--0000525'), '--0000525');
  assert.equal(shortRevisionLabel('--0000525'), '--0000525');
  assert.equal(shortRevisionLabel('abcdef0123456789abcdef0123456789abcdef01'), 'abcdef0');
  assert.equal(shortRevisionLabel('4de7069'), '4de7069');

  const bad = validateStampInput({ client: 'nope', environment: 'staging', revision: 'abc' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes('portal_not_admitted'));

  const good = validateStampInput({
    client: 'wolfhouse-somo',
    environment: 'staging',
    revision: '4de7069a12',
    updated_at: '2026-09-20T10:00:00.000Z',
  });
  assert.equal(good.ok, true);
  assert.equal(good.stamp.revision_short, '4de7069a12');
  assert.equal(good.stamp.source_kind, STAMP_SOURCE_KIND);

  const stampFile = path.join(os.tmpdir(), `crowsnest-portal-stamp-${process.pid}.json`);
  try {
    if (fs.existsSync(stampFile)) fs.unlinkSync(stampFile);
  } catch { /* ignore */ }

  const store = createPortalDeployStampStore({
    filePath: stampFile,
    now: () => Date.parse('2026-09-23T04:00:00.000Z'),
  });
  store._reset();

  const put = store.putStamp({
    client: 'wolfhouse-somo',
    environment: 'staging',
    revision: '--0000525',
    updated_at: '2026-09-20T10:00:00.000Z',
  });
  assert.equal(put.ok, true);
  assert.equal(store.getStamp('wolfhouse-somo', 'staging').revision_short, '--0000525');
  assert.ok(fs.existsSync(stampFile), 'stamp file persisted');

  store.putStamp({
    client: 'sunset-somo',
    environment: 'staging',
    revision: '2222222',
    updated_at: '2026-09-21T12:00:00.000Z',
  });
  store.putStamp({
    client: 'wolfhouse-somo',
    environment: 'production',
    revision: '3333333',
    updated_at: '2026-09-10T08:00:00.000Z',
  });
  // Sunset prod shares the staging app historically — stamp independently.
  store.putStamp({
    client: 'sunset-somo',
    environment: 'production',
    revision: '2222222',
    updated_at: '2026-09-21T12:00:00.000Z',
  });

  const collect = createCrowsnestClientPortalDeployCollector({ store, fresh: true });
  const result = await collect(getCrowsnestClients());
  assert.equal(result['wolfhouse-somo'].staging.updated_at, '2026-09-20T10:00:00.000Z');
  assert.equal(result['wolfhouse-somo'].staging.revision_short, '--0000525');
  assert.equal(result['wolfhouse-somo'].staging.source_kind, STAMP_SOURCE_KIND);
  assert.equal(result['sunset-somo'].staging.revision_short, '2222222');
  assert.equal(result['sunset-somo'].production.revision_short, '2222222');
  assert.equal(result['wolfhouse-somo'].production.revision_short, '3333333');
  assert.equal(result['sunset-sardinero'].staging.updated_at, null);
  assert.equal(result['sunset-sardinero'].staging.reason, 'stamp_absent');

  // Missing stamp fails soft (null Updated fields).
  const emptyStore = createPortalDeployStampStore({ fresh: true });
  const emptyCollect = createCrowsnestClientPortalDeployCollector({ store: emptyStore });
  const emptyResult = await emptyCollect(getCrowsnestClients());
  assert.equal(emptyResult['wolfhouse-somo'].staging.updated_at, null);
  assert.equal(emptyResult['wolfhouse-somo'].staging.reason, 'stamp_absent');

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
  assert.equal(portalEvidence['wolfhouse-somo'].staging.deploy_updated_at, '2026-09-20T10:00:00.000Z');
  assert.equal(portalEvidence['wolfhouse-somo'].staging.deploy_revision_short, '--0000525');
  assert.equal(portalEvidence['wolfhouse-somo'].staging.deploy_source_kind, STAMP_SOURCE_KIND);
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

  // Missing stamp: status dots / availability still render; no Updated line required.
  const blankEvidence = {
    'wolfhouse-somo': {
      staging: {
        availability: 'live',
        checked_at: '2026-09-23T03:59:00.000Z',
        source_kind: 'staff_healthz',
        reason: 'canonical_healthz_ok',
        deploy_updated_at: null,
        deploy_revision_short: null,
        deploy_source_kind: 'none',
        deploy_reason: 'stamp_absent',
      },
      production: {
        availability: 'unknown',
        checked_at: null,
        source_kind: 'none',
        reason: 'source_not_admitted',
      },
    },
  };
  const blankHtml = renderCrowsnestPage({ view: 'clients', portalEvidence: blankEvidence });
  assert.match(blankHtml, /status-dot/);
  assert.doesNotMatch(blankHtml, /class="env-updated"/);

  // No Azure env vars / MI / fetch required.
  const deploySrc = fs.readFileSync(require.resolve('./lib/crowsnest/crowsnest-client-portal-deploy'), 'utf8');
  assert.doesNotMatch(deploySrc, /CROWSNEST_PORTAL_DEPLOY_AZURE_SUBSCRIPTION_ID/);
  assert.doesNotMatch(deploySrc, /management\.azure\.com/);
  assert.doesNotMatch(deploySrc, /IDENTITY_ENDPOINT/);
  assert.doesNotMatch(deploySrc, /\bfetch\s*\(/);

  // HTTP write path (token-gated).
  const savedToken = process.env[STAMP_TOKEN_ENV];
  const savedApiToken = process.env[api.PORTAL_DEPLOY_STAMP_TOKEN_ENV];
  try {
    delete process.env[STAMP_TOKEN_ENV];
    delete process.env[api.PORTAL_DEPLOY_STAMP_TOKEN_ENV];
    _resetPortalDeployStampStoreForTests();
    assert.equal((await callStamp({ body: '{}' })).status, 404);

    process.env[api.PORTAL_DEPLOY_STAMP_TOKEN_ENV] = TOKEN;
    _resetPortalDeployStampStoreForTests();
    assert.equal((await callStamp({ method: 'GET' })).status, 405);
    assert.equal((await callStamp({})).status, 401);
    assert.equal((await callStamp({ auth: 'Bearer nope' })).status, 401);

    let r = await callStamp({ auth: `Bearer ${TOKEN}`, body: '{bad' });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'invalid_json');

    r = await callStamp({
      auth: `Bearer ${TOKEN}`,
      body: JSON.stringify({ client: 'wolfhouse-somo', environment: 'staging' }),
    });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.includes('revision_required'));

    r = await callStamp({
      method: 'POST',
      auth: `Bearer ${TOKEN}`,
      body: JSON.stringify({
        client: 'wolfhouse-somo',
        environment: 'staging',
        revision: 'feedface',
        updated_at: '2026-09-22T15:00:00.000Z',
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.stamp.revision_short, 'feedface');
    assert.equal(r.json.stamp.updated_at, '2026-09-22T15:00:00.000Z');
  } finally {
    if (savedToken === undefined) delete process.env[STAMP_TOKEN_ENV];
    else process.env[STAMP_TOKEN_ENV] = savedToken;
    if (savedApiToken === undefined) delete process.env[api.PORTAL_DEPLOY_STAMP_TOKEN_ENV];
    else process.env[api.PORTAL_DEPLOY_STAMP_TOKEN_ENV] = savedApiToken;
    _resetPortalDeployStampStoreForTests();
    try { if (fs.existsSync(stampFile)) fs.unlinkSync(stampFile); } catch { /* ignore */ }
  }

  console.log('verify:crowsnest-client-portal-deploy OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
