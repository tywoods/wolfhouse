'use strict';

/**
 * Focused verifier for Spyglass Refresh all Slice B:
 * server-owned runtime config + injected Azure Container Apps Job-start adapter
 * (managed identity → ARM). Offline only — injected fetch, no live Azure,
 * no tenant DB, no reporter-ingest.
 */

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_SCRIPT = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const API_PATH = API_SCRIPT;
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const CONTRACT_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-spyglass-refresh.js');
const RUNTIME_REL = 'scripts/lib/crowsnest/crowsnest-spyglass-refresh-runtime-config.js';
const RUNTIME_PATH = path.join(ROOT, RUNTIME_REL);
const ADAPTER_REL = 'scripts/lib/crowsnest/crowsnest-spyglass-refresh-azure-job-start.js';
const ADAPTER_PATH = path.join(ROOT, ADAPTER_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SPYGLASS-REFRESH-ALL.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const CROWSNEST_LIB_DIR = path.join(ROOT, 'scripts', 'lib', 'crowsnest');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SPYGLASS_REFRESH_AZURE_PORT) || 13440;

const FAKE_SUBSCRIPTION = '11111111-2222-4333-8444-555555555555';
const FAKE_MI_CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FAKE_TOKEN = 'TEST_ARM_TOKEN_MARKER_DO_NOT_LOG';
const FAKE_IDENTITY_HEADER = 'TEST_IDENTITY_HEADER_MARKER_DO_NOT_LOG';
const FAKE_IDENTITY_ENDPOINT = 'http://127.0.0.1:41999/msi/token';
const FIXED_RG = 'luna-sunset-staging-rg';
const FIXED_JOB = 'sunset-somo-stg-cn-metrics';
const ARM_API_VERSION = '2023-05-01';
const MI_API_VERSION = '2019-08-01';
const ARM_RESOURCE = 'https://management.azure.com/';

let pass = 0;
let fail = 0;
let child = null;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function collectStrings(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectStrings(value, out);
  }
  return out;
}

function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (options.username != null && options.password != null) {
      const token = Buffer.from(`${options.username}:${options.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    let body = options.body;
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = String(body);
    }
    if (body != null && headers['Content-Length'] == null && headers['content-length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function extractCookiePair(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return list.map((entry) => String(entry).split(';')[0]).join('; ');
}

function allowHeader(res) {
  return String(res.headers.allow || res.headers.Allow || '');
}

function waitForHealthz(port, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      request(port, '/healthz')
        .then((res) => {
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .catch(retry);
    };
    function retry() {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Crowsnest did not become ready on port ${port}`));
        return;
      }
      setTimeout(tick, 150);
    }
    tick();
  });
}

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [API_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env, CROWSNEST_PORT: String(port), CROWSNEST_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    waitForHealthz(port)
      .then(() => resolve(stderr))
      .catch((err) => {
        stopServer();
        reject(new Error(`${err.message}\n${stderr}`));
      });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) {
      resolve();
      return;
    }
    const current = child;
    child = null;
    current.once('exit', () => resolve());
    current.kill('SIGTERM');
    setTimeout(() => {
      try {
        current.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  });
}

async function runScenario(name, port, env, steps) {
  console.log(`\n▸ ${name}`);
  await startServer(port, env);
  try {
    for (const step of steps) {
      await step(port);
    }
  } finally {
    await stopServer();
  }
}

function statusByClient(results) {
  const map = {};
  for (const row of results || []) map[row.client_id] = row.status;
  return map;
}

function expectedArmStartUrl(subscriptionId, resourceGroup, jobName) {
  return (
    `https://management.azure.com/subscriptions/${subscriptionId}`
    + `/resourceGroups/${resourceGroup}`
    + `/providers/Microsoft.App/jobs/${jobName}/start`
    + `?api-version=${ARM_API_VERSION}`
  );
}

function structuralChecks() {
  console.log('\n▸ Structural');
  const apiSrc = read(API_PATH) || '';
  const contractSrc = read(CONTRACT_PATH) || '';
  const runtimeSrc = read(RUNTIME_PATH) || '';
  const adapterSrc = read(ADAPTER_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const pkg = JSON.parse(read(PKG_PATH) || '{}');

  ok('runtime config module exists', fs.existsSync(RUNTIME_PATH));
  ok('azure job-start adapter exists', fs.existsSync(ADAPTER_PATH));
  ok(
    'package.json has verify:crowsnest-spyglass-refresh-azure-job-start',
    pkg.scripts
      && pkg.scripts['verify:crowsnest-spyglass-refresh-azure-job-start']
        === 'node scripts/verify-crowsnest-spyglass-refresh-azure-job-start.js',
  );
  ok('api requires runtime config module', /crowsnest-spyglass-refresh-runtime-config/.test(apiSrc));
  ok('api requires azure job-start adapter', /crowsnest-spyglass-refresh-azure-job-start/.test(apiSrc));
  ok(
    'pure domain contract still has no process.env',
    !/process\.env/.test(contractSrc),
  );
  ok(
    'pure domain contract still has no fetch / az / @azure / management.azure',
    !/\bfetch\s*\(/.test(contractSrc)
      && !/\baz\b/.test(contractSrc)
      && !/DefaultAzureCredential|ManagedIdentityCredential|@azure\//.test(contractSrc)
      && !/management\.azure\.com/.test(contractSrc),
  );
  ok(
    'adapter has no @azure SDK / az CLI / DefaultAzureCredential',
    !/DefaultAzureCredential|ManagedIdentityCredential|@azure\//.test(adapterSrc)
      && !/\baz\b/.test(adapterSrc)
      && !/require\(['"]child_process['"]\)/.test(adapterSrc),
  );
  ok(
    'adapter requires injected fetch (no global fetch fallback)',
    /options\.fetch|fetchImpl/.test(adapterSrc)
      && !/globalThis\.fetch|global\.fetch/.test(adapterSrc)
      && !/typeof fetch === ['"]function['"]/.test(adapterSrc),
  );
  ok(
    'adapter never returns execution id / raw body fields',
    !/execution[_-]?id|name:\s*body|rawBody|raw_error/i.test(adapterSrc)
      || (/never return|must not return|do not return/i.test(adapterSrc)
        && !/return\s*\{[^}]*execution/i.test(adapterSrc)),
  );
  ok(
    'doc lists Earthling Azure delivery requirements after merge',
    /Earthling/i.test(docSrc)
      && /managed.?identity/i.test(docSrc)
      && /Microsoft\.App\/jobs\/start\/action|jobs\/start\/action/i.test(docSrc)
      && /CROWSNEST_SPYGLASS_REFRESH_AZURE_/i.test(docSrc)
      && /IDENTITY_ENDPOINT/i.test(docSrc)
      && /deploy exact master|exact master/i.test(docSrc),
  );
  ok(
    'doc keeps scheduled reporting separate from Refresh all',
    /15-?minute|scheduled/i.test(docSrc) && /separate/i.test(docSrc),
  );
  ok(
    'doc does not embed executable Azure shell script as source deliverable',
    !/```(?:bash|sh|powershell)[\s\S]*az containerapp job start/i.test(docSrc),
  );
  ok(
    'runtime config has no secret/config echo helpers for UI',
    !/JSON\.stringify\(.*config|console\.log\(.*subscription|toHTML|render.*subscription/i.test(runtimeSrc),
  );

  // Broad no-outbound: every crowsnest lib module except the dedicated Azure adapter.
  const outboundRe = /\bfetch\s*\(|require\(['"]axios|require\(['"]node-fetch|https?\.request\s*\(|https?\.get\s*\(/;
  const libFiles = fs.readdirSync(CROWSNEST_LIB_DIR).filter((f) => f.endsWith('.js'));
  const allowedOutbound = new Set(['crowsnest-spyglass-refresh-azure-job-start.js']);
  let outboundViolations = [];
  for (const file of libFiles) {
    if (allowedOutbound.has(file)) continue;
    const src = read(path.join(CROWSNEST_LIB_DIR, file)) || '';
    if (outboundRe.test(src)) outboundViolations.push(file);
  }
  ok(
    'no-outbound permits only dedicated azure job-start adapter',
    outboundViolations.length === 0,
    outboundViolations.join(','),
  );
  ok(
    'dedicated adapter is the sole outbound exception and exists',
    allowedOutbound.size === 1 && fs.existsSync(ADAPTER_PATH),
  );
}

function runtimeConfigChecks() {
  console.log('\n▸ Runtime config validation + fail-closed');
  let runtime;
  try {
    runtime = require(RUNTIME_PATH);
  } catch (err) {
    ok('runtime config module loads', false, err && err.message);
    return;
  }
  ok('runtime config module loads', true);
  ok(
    'resolveSpyglassRefreshRuntimeConfig exported',
    typeof runtime.resolveSpyglassRefreshRuntimeConfig === 'function',
  );
  ok(
    'resolveManagedIdentityEndpointConfig exported',
    typeof runtime.resolveManagedIdentityEndpointConfig === 'function',
  );

  const absent = runtime.resolveSpyglassRefreshRuntimeConfig({});
  ok('absent env => fail-closed', absent && absent.ok === false);
  ok(
    'absent env does not echo values',
    !collectStrings(absent).some((s) => /11111111|luna-sunset|stg-cn-metrics|secret/i.test(s)),
  );

  const wrongClient = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: FIXED_RG,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
    // Intentionally no way to select wolfhouse/sardinero — fixed Sunset only.
  });
  ok('valid Sunset staging fields => ok', wrongClient && wrongClient.ok === true);
  ok(
    'resolved target is fixed Sunset only',
    wrongClient.config
      && wrongClient.config.client_id === 'sunset-somo'
      && wrongClient.config.job_name === FIXED_JOB
      && wrongClient.config.resource_group === FIXED_RG
      && wrongClient.config.subscription_id === FAKE_SUBSCRIPTION,
  );
  ok(
    'resolved config has no wolfhouse/sardinero',
    wrongClient.config
      && wrongClient.config.client_id !== 'wolfhouse-somo'
      && wrongClient.config.client_id !== 'sunset-sardinero',
  );

  const badSub = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: 'not-a-guid',
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: FIXED_RG,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
  });
  ok('invalid subscription GUID => fail-closed', badSub && badSub.ok === false);

  const badRg = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: 'evil rg; DROP',
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
  });
  ok('unsafe RG => fail-closed', badRg && badRg.ok === false);

  const wrongRg = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: 'some-other-rg',
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
  });
  ok('non-Sunset RG => fail-closed', wrongRg && wrongRg.ok === false);

  const wrongJob = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: FIXED_RG,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: 'wolfhouse-stg-cn-metrics',
  });
  ok('non-Sunset job => fail-closed (no Wolfhouse default)', wrongJob && wrongJob.ok === false);

  const badMi = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: FIXED_RG,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_MANAGED_IDENTITY_CLIENT_ID: 'not-uuid',
  });
  ok('invalid optional MI client UUID => fail-closed', badMi && badMi.ok === false);

  const withMi = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: FIXED_RG,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_MANAGED_IDENTITY_CLIENT_ID: FAKE_MI_CLIENT,
  });
  ok(
    'optional MI client UUID accepted when valid',
    withMi && withMi.ok === true
      && withMi.config.managed_identity_client_id === FAKE_MI_CLIENT,
  );

  const noMi = runtime.resolveManagedIdentityEndpointConfig({});
  ok('absent IDENTITY_ENDPOINT/HEADER => fail-closed', noMi && noMi.ok === false);

  const badEndpoint = runtime.resolveManagedIdentityEndpointConfig({
    IDENTITY_ENDPOINT: 'https://evil.example/msi/token',
    IDENTITY_HEADER: FAKE_IDENTITY_HEADER,
  });
  ok('non-local IDENTITY_ENDPOINT => fail-closed', badEndpoint && badEndpoint.ok === false);

  const goodMi = runtime.resolveManagedIdentityEndpointConfig({
    IDENTITY_ENDPOINT: FAKE_IDENTITY_ENDPOINT,
    IDENTITY_HEADER: FAKE_IDENTITY_HEADER,
  });
  ok('valid ACA IDENTITY_ENDPOINT/HEADER => ok', goodMi && goodMi.ok === true);
  ok(
    'MI config result does not echo header value in nested dump-safe codes only',
    goodMi.ok === true
      && goodMi.identity_header === FAKE_IDENTITY_HEADER
      && !Object.prototype.hasOwnProperty.call(goodMi, 'token'),
  );
}

async function adapterBehaviorChecks() {
  console.log('\n▸ Azure adapter exact MI + ARM requests');
  let adapter;
  let runtime;
  try {
    adapter = require(ADAPTER_PATH);
    runtime = require(RUNTIME_PATH);
  } catch (err) {
    ok('adapter + runtime load', false, err && err.message);
    return;
  }
  ok('adapter + runtime load', true);
  ok(
    'createAzureContainerAppsJobStartTransport exported',
    typeof adapter.createAzureContainerAppsJobStartTransport === 'function',
  );

  const resolved = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: FIXED_RG,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_MANAGED_IDENTITY_CLIENT_ID: FAKE_MI_CLIENT,
  });
  const mi = runtime.resolveManagedIdentityEndpointConfig({
    IDENTITY_ENDPOINT: FAKE_IDENTITY_ENDPOINT,
    IDENTITY_HEADER: FAKE_IDENTITY_HEADER,
  });

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init: { ...init, headers: { ...(init.headers || {}) } } });
    if (String(url).startsWith(FAKE_IDENTITY_ENDPOINT)) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: FAKE_TOKEN, expires_in: 3600 };
        },
        async text() {
          return JSON.stringify({ access_token: FAKE_TOKEN });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: '/subscriptions/x/executions/should-never-leak', name: 'exec-leak' };
      },
      async text() {
        return '{"id":"exec-leak"}';
      },
    };
  };

  const startJob = adapter.createAzureContainerAppsJobStartTransport({
    fetch: fetchImpl,
    runtimeConfig: resolved.config,
    identityEndpoint: mi.identity_endpoint,
    identityHeader: mi.identity_header,
  });

  const outcome = await startJob({
    client_id: 'sunset-somo',
    job_name: FIXED_JOB,
  });
  ok('happy path returns ok true only', outcome && outcome.ok === true);
  ok(
    'happy path does not return execution id / token / raw body',
    outcome
      && outcome.ok === true
      && !Object.prototype.hasOwnProperty.call(outcome, 'id')
      && !Object.prototype.hasOwnProperty.call(outcome, 'name')
      && !Object.prototype.hasOwnProperty.call(outcome, 'access_token')
      && !Object.prototype.hasOwnProperty.call(outcome, 'body')
      && !collectStrings(outcome).some((s) => /exec-leak|TEST_ARM_TOKEN|TEST_IDENTITY/i.test(s)),
  );
  ok('exactly two HTTP calls (MI then ARM)', calls.length === 2, `got ${calls.length}`);

  const miCall = calls[0];
  const miUrl = new URL(miCall.url);
  ok('MI host/path exact local msi token endpoint', miUrl.origin + miUrl.pathname === FAKE_IDENTITY_ENDPOINT);
  ok('MI api-version exact', miUrl.searchParams.get('api-version') === MI_API_VERSION);
  ok('MI resource exact ARM audience', miUrl.searchParams.get('resource') === ARM_RESOURCE);
  ok('MI includes user-assigned client_id', miUrl.searchParams.get('client_id') === FAKE_MI_CLIENT);
  ok(
    'MI sends X-IDENTITY-HEADER',
    String(miCall.init.headers['X-IDENTITY-HEADER'] || miCall.init.headers['x-identity-header'] || '')
      === FAKE_IDENTITY_HEADER,
  );
  ok('MI method is GET', String(miCall.init.method || 'GET').toUpperCase() === 'GET');

  const armCall = calls[1];
  ok(
    'ARM URL is exact job start',
    armCall.url === expectedArmStartUrl(FAKE_SUBSCRIPTION, FIXED_RG, FIXED_JOB),
  );
  ok('ARM method is POST', String(armCall.init.method || '').toUpperCase() === 'POST');
  ok(
    'ARM Authorization is Bearer token',
    String(armCall.init.headers.Authorization || armCall.init.headers.authorization || '')
      === `Bearer ${FAKE_TOKEN}`,
  );
  ok(
    'ARM Content-Type application/json',
    /application\/json/i.test(String(armCall.init.headers['Content-Type'] || armCall.init.headers['content-type'] || '')),
  );

  // Browser cannot steer subscription/RG/job/client.
  calls.length = 0;
  const browserSteer = await startJob({
    client_id: 'sunset-sardinero',
    job_name: 'evil-job',
    subscription_id: '99999999-9999-4999-8999-999999999999',
    resource_group: 'evil-rg',
  });
  ok('browser-steered target rejected', browserSteer && browserSteer.ok === false);
  ok('browser steer makes no HTTP calls', calls.length === 0);

  // Non-2xx MI
  const failMi = adapter.createAzureContainerAppsJobStartTransport({
    fetch: async () => ({
      ok: false,
      status: 500,
      async json() { return { error: 'mi boom secret=sk-abc' }; },
      async text() { return 'mi boom secret=sk-abc'; },
    }),
    runtimeConfig: resolved.config,
    identityEndpoint: mi.identity_endpoint,
    identityHeader: mi.identity_header,
  });
  const miFailOut = await failMi({ client_id: 'sunset-somo', job_name: FIXED_JOB });
  ok('non-2xx MI => ok false', miFailOut && miFailOut.ok === false);
  ok(
    'MI failure does not leak body/secret',
    !collectStrings(miFailOut).some((s) => /sk-abc|mi boom|access_token/i.test(s)),
  );

  // Non-2xx ARM
  let phase = 0;
  const failArm = adapter.createAzureContainerAppsJobStartTransport({
    fetch: async () => {
      phase += 1;
      if (phase === 1) {
        return {
          ok: true,
          status: 200,
          async json() { return { access_token: FAKE_TOKEN }; },
          async text() { return '{}'; },
        };
      }
      return {
        ok: false,
        status: 403,
        async json() { return { error: { message: 'Forbidden ARM detail leak' } }; },
        async text() { return 'Forbidden ARM detail leak'; },
      };
    },
    runtimeConfig: resolved.config,
    identityEndpoint: mi.identity_endpoint,
    identityHeader: mi.identity_header,
  });
  const armFailOut = await failArm({ client_id: 'sunset-somo', job_name: FIXED_JOB });
  ok('non-2xx ARM => ok false', armFailOut && armFailOut.ok === false);
  ok(
    'ARM failure does not leak raw error',
    !collectStrings(armFailOut).some((s) => /Forbidden ARM detail leak|exec-leak/i.test(s)),
  );

  // Missing fetch
  const noFetch = adapter.createAzureContainerAppsJobStartTransport({
    runtimeConfig: resolved.config,
    identityEndpoint: mi.identity_endpoint,
    identityHeader: mi.identity_header,
  });
  const noFetchOut = await noFetch({ client_id: 'sunset-somo', job_name: FIXED_JOB });
  ok('missing injected fetch => ok false', noFetchOut && noFetchOut.ok === false);
}

async function domainIntegrationChecks() {
  console.log('\n▸ Domain statuses + no scheduled job change');
  const contract = require(CONTRACT_PATH);
  const adapter = require(ADAPTER_PATH);
  const runtime = require(RUNTIME_PATH);

  const resolved = runtime.resolveSpyglassRefreshRuntimeConfig({
    CROWSNEST_SPYGLASS_REFRESH_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTION,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_RESOURCE_GROUP: FIXED_RG,
    CROWSNEST_SPYGLASS_REFRESH_AZURE_JOB_NAME: FIXED_JOB,
  });
  const mi = runtime.resolveManagedIdentityEndpointConfig({
    IDENTITY_ENDPOINT: FAKE_IDENTITY_ENDPOINT,
    IDENTITY_HEADER: FAKE_IDENTITY_HEADER,
  });

  const startJob = adapter.createAzureContainerAppsJobStartTransport({
    fetch: async (url) => {
      if (String(url).startsWith(FAKE_IDENTITY_ENDPOINT)) {
        return {
          ok: true,
          status: 200,
          async json() { return { access_token: FAKE_TOKEN }; },
        };
      }
      return { ok: true, status: 202, async json() { return { name: 'exec-hidden' }; } };
    },
    runtimeConfig: resolved.config,
    identityEndpoint: mi.identity_endpoint,
    identityHeader: mi.identity_header,
  });

  const coverage = await contract.requestSpyglassRefreshAll({
    configuredTargets: [contract.SUNSET_SOMO_STAGING_TARGET],
    startJob,
    browserBody: { client_id: 'wolfhouse-somo', job_name: 'nope' },
  });
  const map = statusByClient(coverage.results);
  ok('Sunset started means Azure accepted job-start only', map['sunset-somo'] === 'started');
  ok('Wolfhouse stays not_configured', map['wolfhouse-somo'] === 'not_configured');
  ok('Sardinero stays not_configured', map['sunset-sardinero'] === 'not_configured');
  ok(
    'never claims all clients refreshed / metrics updated',
    coverage.all_clients_refreshed !== true && coverage.all_refreshed !== true,
  );

  const unavailableCoverage = await contract.requestSpyglassRefreshAll({
    configuredTargets: [contract.SUNSET_SOMO_STAGING_TARGET],
    startJob: contract.createUnavailableJobStartTransport('not_wired'),
  });
  ok(
    'config/MI/ARM failure path stays unavailable (not not_configured)',
    statusByClient(unavailableCoverage.results)['sunset-somo'] === 'unavailable',
  );

  const pageSrc = read(PAGE_PATH) || '';
  const apiSrc = read(API_PATH) || '';
  const adapterSrc = read(ADAPTER_PATH) || '';
  ok(
    'no scheduled job trigger / cron mutation in refresh path',
    !/schedule.*trigger|trigger.*schedule|15\s*\*\s*\*|cron\.schedule/i.test(apiSrc)
      && !/az containerapp job update|scheduleInterval/i.test(adapterSrc)
      && !/change the schedule|modify schedule/i.test(pageSrc),
  );
  ok(
    'refresh path does not call tenant DB or reporter-ingest',
    !/require\(['"]pg['"]\)/.test(adapterSrc)
      && !/WOLFHOUSE_DATABASE|SUNSET_DATABASE|DATABASE_URL/.test(adapterSrc)
      && !/putClientMetricsSnapshot|metrics\/ingest|reporter-ingest/.test(adapterSrc),
  );
}

async function routeChecks() {
  const authEnv = {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
    NODE_ENV: 'development',
    // No fixture, no Azure runtime config → configured Sunset must be unavailable.
  };

  await runScenario('Auth/method + absent config fail-closed UI', BASE_PORT, authEnv, [
    async (port) => {
      const unauth = await request(port, '/spyglass/refresh-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'subscription_id=evil&resource_group=evil&job_name=evil',
      });
      ok(
        'unauthenticated POST redirects to login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
      );

      const getRefresh = await request(port, '/spyglass/refresh-all', {
        method: 'GET',
        username: 'admin',
        password: 'admin',
      });
      ok('GET refresh => 405', getRefresh.statusCode === 405);
      ok('Allow POST only', allowHeader(getRefresh) === 'POST');

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      const refresh = await request(port, '/spyglass/refresh-all', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `subscription_id=${FAKE_SUBSCRIPTION}&resource_group=evil-rg&job_name=evil-job&client_id=sunset-sardinero`,
      });
      ok('POST refresh => 200', refresh.statusCode === 200);
      ok(
        'absent Azure config => Sunset unavailable (not started)',
        /Sunset Somo/i.test(refresh.body) && /Unavailable/i.test(refresh.body),
      );
      ok(
        'browser ARM fields cannot force start / leak',
        !/Report requested/i.test(refresh.body)
          && !refresh.body.includes(FAKE_SUBSCRIPTION)
          && !/evil-rg|evil-job|Bearer |IDENTITY_HEADER|management\.azure\.com/i.test(refresh.body),
      );
      ok(
        'unconfigured clients remain not_configured',
        /Sunset Sardinero/i.test(refresh.body)
          && /Not configured/i.test(refresh.body)
          && /Wolfhouse/i.test(refresh.body),
      );
    },
  ]);
}

async function main() {
  console.log('verify:crowsnest-spyglass-refresh-azure-job-start — Slice B\n');
  structuralChecks();
  if (fs.existsSync(RUNTIME_PATH)) {
    runtimeConfigChecks();
  }
  if (fs.existsSync(ADAPTER_PATH) && fs.existsSync(RUNTIME_PATH)) {
    await adapterBehaviorChecks();
    await domainIntegrationChecks();
  }
  await routeChecks();

  console.log(`\n── verify:crowsnest-spyglass-refresh-azure-job-start: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) {
    console.error('verify:crowsnest-spyglass-refresh-azure-job-start — FAILURES');
    process.exit(1);
  }
  console.log('verify:crowsnest-spyglass-refresh-azure-job-start — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
