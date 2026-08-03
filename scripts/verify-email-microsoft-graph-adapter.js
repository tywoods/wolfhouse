'use strict';

/**
 * verify:email-microsoft-graph-adapter — Luna email Slice 2A offline gate.
 *
 * Pure offline Microsoft Graph mailbox adapter boundary:
 *   - injected secret provider + HTTP transport contracts
 *   - app-only client_credentials token then listMessageEnvelopes
 *   - exact allowlists, sanitized errors, no SDK, no network
 *
 * Hostile probes: raw secret_ref, missing deps, async mismatch, extra/nested
 * credential keys, planted password=LEAK/client_secret=LEAK, hostile transport
 * bodies/throws, malformed JSON, wrong token_type, missing access_token, URL
 * injection, top bounds, response extras, fail-closed partial rows, exact
 * request order/URLs/form, Authorization only on wire (handler), fail-safe
 * getCalls (no raw body; header allowlist only), strict access_token,
 * Content-Type on successful JSON, strict params (params_invalid vs
 * top_invalid), exact own-data allowlists (no ignored extras), accessor
 * rejection, no DNS.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');

const SECRET_PROVIDER_REL = 'scripts/lib/email-secret-provider-contract.js';
const HTTP_TRANSPORT_REL = 'scripts/lib/email-http-transport-contract.js';
const ADAPTER_REL = 'scripts/lib/email-microsoft-graph-adapter.js';
const FAKE_TRANSPORT_REL = 'scripts/lib/email-fake-http-transport.js';
const CONTRACT_REL = 'scripts/lib/email-mailbox-adapter-contract.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-microsoft-graph-adapter.js';

const SECRET_PROVIDER_PATH = path.join(ROOT, SECRET_PROVIDER_REL);
const HTTP_TRANSPORT_PATH = path.join(ROOT, HTTP_TRANSPORT_REL);
const ADAPTER_PATH = path.join(ROOT, ADAPTER_REL);
const FAKE_TRANSPORT_PATH = path.join(ROOT, FAKE_TRANSPORT_REL);
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, DOC_REL);
const PKG_PATH = path.join(ROOT, 'package.json');

const CLIENT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION_ID = 'luna-support';
const PUBLIC_ADDRESS = 'support@lunafrontdesk.com';
const SECRET_REF = 'kv:luna-support-email-credentials';
const TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APP_CLIENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APP_CLIENT_SECRET = 'fake-app-only-client-secret-value-not-real';
const FAKE_ACCESS_TOKEN = 'fake-access-token-value-NOT-A-REAL-TOKEN';

const EIGHT_CAPS = Object.freeze({
  push_notifications: false,
  provider_threads: true,
  remote_drafts: false,
  reply: false,
  reply_all: false,
  forward: false,
  attachments_metadata: true,
  delivery_events: false,
});

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function serializeSafe(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function containsLeak(haystack, needles) {
  const s = typeof haystack === 'string' ? haystack : serializeSafe(haystack);
  if (!s) return false;
  for (const n of needles) {
    if (n && s.includes(n)) return true;
  }
  return false;
}

function baseEndpoint(overrides) {
  return {
    client_id: CLIENT_UUID,
    location_id: LOCATION_ID,
    provider: 'microsoft_graph',
    public_address: PUBLIC_ADDRESS,
    secret_ref: SECRET_REF,
    capabilities: { ...EIGHT_CAPS },
    ...overrides,
  };
}

function baseCreds(overrides) {
  return {
    tenant_id: TENANT_ID,
    client_id: APP_CLIENT_ID,
    client_secret: APP_CLIENT_SECRET,
    ...overrides,
  };
}

function makeSecretProvider(materialOrFn) {
  if (typeof materialOrFn === 'function') {
    return { resolveSecret: materialOrFn };
  }
  return {
    async resolveSecret(_ref) {
      return deepClone(materialOrFn);
    },
  };
}

function sampleMessage(overrides) {
  return {
    id: 'AAMkAGI1-msg-001',
    subject: 'Hello support',
    from: {
      emailAddress: {
        name: 'Guest',
        address: 'guest@example.com',
      },
    },
    receivedDateTime: '2026-08-01T12:00:00Z',
    isRead: false,
    conversationId: 'AAQkAGI1-conv-001',
    hasAttachments: false,
    internetMessageId: '<msg001@example.com>',
    ...overrides,
  };
}

function getAdapter(created) {
  return created.adapter || created.value;
}

// ── Network guards ─────────────────────────────────────────────────────────
const originalLookup = dns.lookup;
const originalLookupService = dns.lookupService;
const originalResolve4 = dns.resolve4;
const originalConnect = net.Socket.prototype.connect;
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
let networkHits = 0;

function installNetworkGuards() {
  networkHits = 0;
  const bump = () => {
    networkHits += 1;
    throw new Error('NETWORK_FORBIDDEN_IN_SLICE_2A_VERIFIER');
  };
  dns.lookup = function blockedLookup() { bump(); };
  dns.lookupService = function blockedLookupService() { bump(); };
  dns.resolve4 = function blockedResolve4() { bump(); };
  net.Socket.prototype.connect = function blockedConnect() { bump(); };
  http.request = function blockedHttpRequest() { bump(); };
  https.request = function blockedHttpsRequest() { bump(); };
}

function restoreNetworkGuards() {
  dns.lookup = originalLookup;
  dns.lookupService = originalLookupService;
  dns.resolve4 = originalResolve4;
  net.Socket.prototype.connect = originalConnect;
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
}

async function main() {
  console.log('verify:email-microsoft-graph-adapter — Slice 2A Microsoft Graph adapter\n');
  installNetworkGuards();

  try {
    // ── Files & package ──────────────────────────────────────────────────
    ok('secret-provider contract path exists', fs.existsSync(SECRET_PROVIDER_PATH), SECRET_PROVIDER_REL);
    ok('http-transport contract path exists', fs.existsSync(HTTP_TRANSPORT_PATH), HTTP_TRANSPORT_REL);
    ok('graph adapter path exists', fs.existsSync(ADAPTER_PATH), ADAPTER_REL);
    ok('fake http transport path exists', fs.existsSync(FAKE_TRANSPORT_PATH), FAKE_TRANSPORT_REL);
    ok('architecture doc exists', fs.existsSync(DOC_PATH), DOC_REL);
    ok('1A contract still present', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);

    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    } catch {
      pkg = null;
    }
    ok('package.json parses', pkg != null);
    ok(
      'package.json has verify:email-microsoft-graph-adapter',
      Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-microsoft-graph-adapter']),
    );
    ok(
      'verify script points at this verifier',
      Boolean(
        pkg
        && pkg.scripts
        && String(pkg.scripts['verify:email-microsoft-graph-adapter']).includes(VERIFY_REL),
      ),
    );

    // ── Doc markers ──────────────────────────────────────────────────────
    if (fs.existsSync(DOC_PATH)) {
      const doc = fs.readFileSync(DOC_PATH, 'utf8');
      ok('doc mentions Slice 2A', /Slice 2A/i.test(doc));
      ok(
        'doc mentions official token endpoint host',
        /login\.microsoftonline\.com/i.test(doc) && /oauth2\/v2\.0\/token/i.test(doc),
      );
      ok(
        'doc mentions Graph messages endpoint',
        /graph\.microsoft\.com/i.test(doc) && /\/v1\.0\/users\//i.test(doc) && /messages/i.test(doc),
      );
      ok('doc mentions Mail.ReadBasic.All least privilege', /Mail\.ReadBasic\.All/i.test(doc));
      ok(
        'doc mentions mailbox-scoping requirement',
        /mailbox-scop|scoped mailbox|mailbox scop/i.test(doc),
      );
      ok(
        'doc lists Slice 2A non-goals',
        /non-goal|Not in Slice 2A|out of (slice )?2a|Slice 2A[^\n]*defer|2A[^\n]*(no live|no poll|no send)/i.test(doc),
      );
      ok('doc preserves 1A/1B/1C status', /1A/i.test(doc) && /1B/i.test(doc) && /1C/i.test(doc));
      ok('doc forbids credentials in git/postgres/logs/prompts', /never belong in Git/i.test(doc));
    }

    // ── Load modules ─────────────────────────────────────────────────────
    let secretProviderMod = null;
    let httpTransportMod = null;
    let adapterMod = null;
    let fakeTransportMod = null;
    let contractMod = null;
    let loadError = null;
    try {
      for (const p of [
        SECRET_PROVIDER_PATH,
        HTTP_TRANSPORT_PATH,
        ADAPTER_PATH,
        FAKE_TRANSPORT_PATH,
        CONTRACT_PATH,
      ]) {
        if (fs.existsSync(p)) delete require.cache[require.resolve(p)];
      }
      secretProviderMod = require(SECRET_PROVIDER_PATH);
      httpTransportMod = require(HTTP_TRANSPORT_PATH);
      adapterMod = require(ADAPTER_PATH);
      fakeTransportMod = require(FAKE_TRANSPORT_PATH);
      contractMod = require(CONTRACT_PATH);
    } catch (err) {
      loadError = err;
    }
    ok(
      'secret-provider module loads',
      secretProviderMod != null,
      loadError && String(loadError.message || loadError),
    );
    ok(
      'http-transport module loads',
      httpTransportMod != null,
      loadError && String(loadError.message || loadError),
    );
    ok(
      'graph adapter module loads',
      adapterMod != null,
      loadError && String(loadError.message || loadError),
    );
    ok(
      'fake transport module loads',
      fakeTransportMod != null,
      loadError && String(loadError.message || loadError),
    );
    ok('1A contract still loads', contractMod != null);

    // ── Source hygiene ───────────────────────────────────────────────────
    const modulePaths = [
      SECRET_PROVIDER_PATH,
      HTTP_TRANSPORT_PATH,
      ADAPTER_PATH,
      FAKE_TRANSPORT_PATH,
    ].filter((p) => fs.existsSync(p));

    const forbiddenSdk = [
      /require\s*\(\s*['"]@microsoft\/microsoft-graph-client['"]\s*\)/,
      /require\s*\(\s*['"]@azure\/identity['"]\s*\)/,
      /require\s*\(\s*['"]@azure\/msal[^'"]*['"]\s*\)/,
      /require\s*\(\s*['"][^'"]*msal[^'"]*['"]\s*\)/i,
      /require\s*\(\s*['"]googleapis['"]\s*\)/,
      /require\s*\(\s*['"]nodemailer['"]\s*\)/,
      /require\s*\(\s*['"]axios['"]\s*\)/,
      /require\s*\(\s*['"]node-fetch['"]\s*\)/,
      /from\s+['"]@microsoft\/microsoft-graph-client['"]/,
      /from\s+['"]@azure\/identity['"]/,
    ];
    const forbiddenNet = [
      /\bfetch\s*\(/,
      /\bhttps?\.(?:get|request)\s*\(/,
      /\bnet\.connect\s*\(/,
      /\bdns\.lookup\s*\(/,
    ];
    const forbiddenLog = [
      /console\.(log|info|warn|error|debug)\s*\([^)]*secret_ref/,
      /console\.(log|info|warn|error|debug)\s*\([^)]*client_secret/,
      /console\.(log|info|warn|error|debug)\s*\([^)]*access_token/,
      /console\.(log|info|warn|error|debug)\s*\([^)]*Authorization/,
    ];

    for (const p of modulePaths) {
      const src = fs.readFileSync(p, 'utf8');
      const base = path.basename(p);
      ok(`${base}: no provider SDK imports`, !forbiddenSdk.some((re) => re.test(src)));
      ok(`${base}: no network API calls`, !forbiddenNet.some((re) => re.test(src)));
      ok(
        `${base}: no sensitive console logging patterns`,
        !forbiddenLog.some((re) => re.test(src)),
      );
    }

    if (fs.existsSync(FAKE_TRANSPORT_PATH)) {
      const fakeSrc = fs.readFileSync(FAKE_TRANSPORT_PATH, 'utf8');
      ok(
        'fake transport never requires net/http/https/dns',
        !/require\s*\(\s*['"]net['"]/.test(fakeSrc)
          && !/require\s*\(\s*['"]https?['"]/.test(fakeSrc)
          && !/require\s*\(\s*['"]dns['"]/.test(fakeSrc)
          && !/\bfetch\s*\(/.test(fakeSrc),
      );
    }

    if (fs.existsSync(ADAPTER_PATH)) {
      const adapterSrc = fs.readFileSync(ADAPTER_PATH, 'utf8');
      ok(
        'adapter source documents access_token shortcut forbidden',
        /access_token/i.test(adapterSrc)
          && (/shortcut/i.test(adapterSrc) || /forbidden/i.test(adapterSrc)),
      );
      ok(
        'adapter does not import secret material from env',
        !/process\.env\.(AZURE|MS_|GRAPH_|CLIENT_SECRET|TENANT)/i.test(adapterSrc),
      );
      ok(
        'adapter has no console.log',
        !/console\.(log|info|warn|error|debug)\s*\(/.test(adapterSrc),
      );
    }

    if (
      !secretProviderMod
      || !httpTransportMod
      || !adapterMod
      || !fakeTransportMod
      || !contractMod
      || typeof adapterMod.createMicrosoftGraphMailboxAdapter !== 'function'
    ) {
      ok('required module exports present', false, 'abort remaining probes');
      return;
    }

    const {
      validateEmailSecretProvider,
      resolveEmailMailboxSecret,
    } = secretProviderMod;
    const {
      validateEmailHttpTransport,
      EMAIL_HTTP_TRANSPORT_TIMEOUT,
    } = httpTransportMod;
    const {
      createMicrosoftGraphMailboxAdapter,
      validateMicrosoftGraphEndpoint,
      validateAppOnlySecretMaterial,
      validateListMessageEnvelopesParams,
      extractAccessToken,
      isStrictAccessToken,
      validateSuccessfulJsonContentType,
      isStrictApplicationJsonContentType,
      buildTokenUrl,
      buildMessagesUrl,
      buildTokenFormBody,
      TOKEN_HOST,
      GRAPH_HOST,
      TOKEN_SCOPE,
      TOKEN_GRANT,
      GRAPH_MESSAGE_SELECT,
      ENVELOPE_DTO_KEYS,
      ACCESS_TOKEN_MAX_LEN,
      CONTENT_TYPE_MAX_LEN,
      mapMessageEnvelope,
      mapMessagesResponse,
      readTransportResponse,
    } = adapterMod;
    const {
      createFakeEmailHttpTransport,
      sanitizeHeaders,
      sanitizePersistedBody,
      sanitizeCall,
      snapshotOwnEnumerableDataProps,
      buildRawCall,
      REDACTED,
      PERSISTED_HEADER_ALLOWLIST,
    } = fakeTransportMod;

    /**
     * @param {object} [opts]
     * @param {object[]} [opts.messages]
     * @param {number} [opts.tokenStatus]
     * @param {number} [opts.graphStatus]
     * @param {string|object} [opts.tokenBody]
     * @param {string|object} [opts.graphBody]
     * @param {object} [opts.tokenHeaders] override token response headers
     * @param {object} [opts.graphHeaders] override graph response headers
     * @param {'token'|'graph'|number} [opts.throwOn]
     * @param {Array} [opts.rawWire] optional array to push raw handler calls (wire)
     */
    function happyTransport(opts) {
      const messages = (opts && opts.messages) || [sampleMessage()];
      const tokenStatus = (opts && opts.tokenStatus) != null ? opts.tokenStatus : 200;
      const graphStatus = (opts && opts.graphStatus) != null ? opts.graphStatus : 200;
      const tokenBody = Object.prototype.hasOwnProperty.call(opts || {}, 'tokenBody')
        ? opts.tokenBody
        : JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: FAKE_ACCESS_TOKEN,
        });
      const graphBody = Object.prototype.hasOwnProperty.call(opts || {}, 'graphBody')
        ? opts.graphBody
        : JSON.stringify({ value: messages });
      const tokenHeaders = (opts && opts.tokenHeaders) || { 'Content-Type': 'application/json' };
      const graphHeaders = (opts && opts.graphHeaders) || { 'Content-Type': 'application/json' };
      // throwOn: 'token' | 'graph' | absolute call index (number)
      const throwOn = opts && opts.throwOn;
      const rawWire = opts && opts.rawWire;

      return createFakeEmailHttpTransport({
        handler(call, index) {
          if (rawWire) rawWire.push(call);
          const isToken = call.method === 'POST'
            && call.url.includes('login.microsoftonline.com')
            && call.url.includes('/oauth2/v2.0/token');
          const isGraph = call.method === 'GET'
            && call.url.includes('graph.microsoft.com')
            && call.url.includes('/messages');

          if (throwOn === index
              || (throwOn === 'token' && isToken)
              || (throwOn === 'graph' && isGraph)) {
            throw new Error('password=LEAK hostile transport throw client_secret=LEAK');
          }
          if (isToken) {
            return {
              status: tokenStatus,
              headers: tokenHeaders,
              body: typeof tokenBody === 'string' ? tokenBody : JSON.stringify(tokenBody),
            };
          }
          if (isGraph) {
            return {
              status: graphStatus,
              headers: graphHeaders,
              body: typeof graphBody === 'string' ? graphBody : JSON.stringify(graphBody),
            };
          }
          return { status: 599, body: '{"error":"unexpected_url"}' };
        },
      });
    }

    // ── Secret provider contract ─────────────────────────────────────────
    ok(
      'validateEmailSecretProvider rejects null',
      validateEmailSecretProvider(null).ok === false
        && validateEmailSecretProvider(null).error === 'secret_provider_invalid',
    );
    ok(
      'validateEmailSecretProvider rejects missing resolveSecret',
      validateEmailSecretProvider({}).ok === false,
    );
    ok(
      'validateEmailSecretProvider rejects non-function resolveSecret',
      validateEmailSecretProvider({ resolveSecret: 'nope' }).ok === false,
    );
    ok(
      'validateEmailSecretProvider accepts function resolveSecret',
      validateEmailSecretProvider({ resolveSecret: async () => ({}) }).ok === true,
    );

    ok(
      'validateEmailHttpTransport rejects null',
      validateEmailHttpTransport(null).ok === false
        && validateEmailHttpTransport(null).error === 'http_transport_invalid',
    );
    ok(
      'validateEmailHttpTransport rejects missing request',
      validateEmailHttpTransport({}).ok === false,
    );
    ok(
      'validateEmailHttpTransport rejects non-function request',
      validateEmailHttpTransport({ request: 123 }).ok === false,
    );
    ok(
      'validateEmailHttpTransport accepts function request',
      validateEmailHttpTransport({ request: async () => ({ status: 200 }) }).ok === true,
    );
    ok(
      'EMAIL_HTTP_TRANSPORT_TIMEOUT has fixed TOKEN_MS and GRAPH_MS',
      EMAIL_HTTP_TRANSPORT_TIMEOUT
        && Number.isInteger(EMAIL_HTTP_TRANSPORT_TIMEOUT.TOKEN_MS)
        && Number.isInteger(EMAIL_HTTP_TRANSPORT_TIMEOUT.GRAPH_MS)
        && EMAIL_HTTP_TRANSPORT_TIMEOUT.TOKEN_MS > 0
        && EMAIL_HTTP_TRANSPORT_TIMEOUT.GRAPH_MS > 0,
    );

    // ── Endpoint validation ──────────────────────────────────────────────
    {
      const good = validateMicrosoftGraphEndpoint(baseEndpoint());
      ok('valid endpoint accepted', good.ok === true, serializeSafe(good));
      if (good.ok) {
        ok(
          'endpoint normalizes public_address lowercase',
          good.value.public_address === PUBLIC_ADDRESS,
        );
        ok(
          'endpoint freezes capabilities',
          good.value.capabilities.push_notifications === false,
        );
      }

      ok(
        'endpoint rejects non-microsoft_graph provider',
        validateMicrosoftGraphEndpoint(baseEndpoint({ provider: 'gmail_api' })).ok === false,
      );
      ok(
        'endpoint rejects invalid client_id',
        validateMicrosoftGraphEndpoint(baseEndpoint({ client_id: 'not-uuid' })).ok === false,
      );
      ok(
        'endpoint rejects non-canonical location_id',
        validateMicrosoftGraphEndpoint(baseEndpoint({ location_id: 'NOT_CANONICAL' })).ok === false,
      );

      const rawRef = validateMicrosoftGraphEndpoint(baseEndpoint({ secret_ref: 'password=LEAK' }));
      ok('endpoint rejects raw secret_ref password=LEAK', rawRef.ok === false);
      ok('endpoint raw secret_ref error no leak', !containsLeak(rawRef, ['password=LEAK']));

      ok(
        'endpoint rejects host injection field',
        validateMicrosoftGraphEndpoint(baseEndpoint({ host: 'evil.example' })).error
          === 'endpoint_forbidden_field',
      );
      ok(
        'endpoint rejects token_url injection',
        validateMicrosoftGraphEndpoint(baseEndpoint({ token_url: 'https://evil' })).error
          === 'endpoint_forbidden_field',
      );
      ok(
        'endpoint rejects graph_url injection',
        validateMicrosoftGraphEndpoint(baseEndpoint({ graph_url: 'https://evil' })).error
          === 'endpoint_forbidden_field',
      );
      ok(
        'endpoint rejects access_token field',
        validateMicrosoftGraphEndpoint(baseEndpoint({ access_token: 'x' })).error
          === 'endpoint_forbidden_field',
      );
      ok(
        'endpoint rejects client_secret field',
        validateMicrosoftGraphEndpoint(baseEndpoint({ client_secret: 'x' })).error
          === 'endpoint_forbidden_field',
      );
      ok(
        'endpoint rejects provider_resource_id path injection',
        validateMicrosoftGraphEndpoint(baseEndpoint({ provider_resource_id: '../admin' })).ok
          === false,
      );
      ok(
        'endpoint rejects provider_resource_id query injection',
        validateMicrosoftGraphEndpoint(baseEndpoint({ provider_resource_id: 'user?$top=999' })).ok
          === false,
      );
      ok(
        'endpoint rejects unknown key',
        validateMicrosoftGraphEndpoint(baseEndpoint({ extra: 1 })).ok === false,
      );
    }

    // ── Secret material ──────────────────────────────────────────────────
    {
      ok(
        'secret material accepts exact three keys',
        validateAppOnlySecretMaterial(baseCreds()).ok === true,
      );
      ok(
        'secret material rejects access_token shortcut',
        validateAppOnlySecretMaterial({
          ...baseCreds(),
          access_token: FAKE_ACCESS_TOKEN,
        }).ok === false,
      );
      ok(
        'secret material rejects only access_token object',
        validateAppOnlySecretMaterial({ access_token: FAKE_ACCESS_TOKEN }).ok === false,
      );
      ok(
        'secret material rejects extra key',
        validateAppOnlySecretMaterial({ ...baseCreds(), password: 'LEAK' }).ok === false,
      );
      ok(
        'secret material rejects nested object value',
        validateAppOnlySecretMaterial({
          tenant_id: TENANT_ID,
          client_id: APP_CLIENT_ID,
          client_secret: { nested: 'nope' },
        }).ok === false,
      );
      ok(
        'secret material rejects missing client_secret',
        validateAppOnlySecretMaterial({
          tenant_id: TENANT_ID,
          client_id: APP_CLIENT_ID,
        }).ok === false,
      );
      const planted = validateAppOnlySecretMaterial({
        tenant_id: TENANT_ID,
        client_id: APP_CLIENT_ID,
        client_secret: 'password=LEAK',
        nested_evil: { client_secret: 'LEAK' },
      });
      ok('planted LEAK extra key rejected', planted.ok === false);
      ok('planted LEAK not echoed in error', !containsLeak(planted, ['password=LEAK', 'LEAK']));
    }

    // ── URL builders ─────────────────────────────────────────────────────
    {
      const tUrl = buildTokenUrl(TENANT_ID);
      ok(
        'token URL exact host/path',
        tUrl === `https://${TOKEN_HOST}/${encodeURIComponent(TENANT_ID)}/oauth2/v2.0/token`,
      );
      const hostileTenant = 'tenant/../evil?x=1';
      const tUrl2 = buildTokenUrl(hostileTenant);
      ok(
        'token URL encodes hostile tenant segment',
        tUrl2 === `https://${TOKEN_HOST}/${encodeURIComponent(hostileTenant)}/oauth2/v2.0/token`
          && tUrl2.startsWith(`https://${TOKEN_HOST}/`)
          && tUrl2.endsWith('/oauth2/v2.0/token')
          && !tUrl2.includes('/../'),
      );

      const mUrl = buildMessagesUrl(PUBLIC_ADDRESS, 10);
      ok(
        'messages URL exact host/path and top',
        mUrl.startsWith(
          `https://${GRAPH_HOST}/v1.0/users/${encodeURIComponent(PUBLIC_ADDRESS)}/messages?`,
        )
          && mUrl.includes('$top=10')
          && mUrl.includes('$select='),
      );
      ok(
        'messages $select is fixed allowlist without body',
        Array.isArray(GRAPH_MESSAGE_SELECT)
          && GRAPH_MESSAGE_SELECT.includes('id')
          && !GRAPH_MESSAGE_SELECT.includes('body')
          && !GRAPH_MESSAGE_SELECT.includes('uniqueBody')
          && !GRAPH_MESSAGE_SELECT.includes('internetMessageHeaders'),
      );
      const form = buildTokenFormBody(baseCreds());
      ok('token form has grant_type client_credentials', form.includes(`grant_type=${TOKEN_GRANT}`));
      ok(
        'token form has scope graph default',
        form.includes(encodeURIComponent(TOKEN_SCOPE)) || form.includes(TOKEN_SCOPE),
      );
      ok('token form has client_id', form.includes(APP_CLIENT_ID));
      ok(
        'token form has client_secret',
        form.includes(encodeURIComponent(APP_CLIENT_SECRET)) || form.includes(APP_CLIENT_SECRET),
      );
    }

    // ── Factory deps ─────────────────────────────────────────────────────
    ok('factory rejects null opts', createMicrosoftGraphMailboxAdapter(null).ok === false);
    ok(
      'factory rejects missing secretProvider',
      createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        transport: { request: async () => ({ status: 200 }) },
      }).ok === false,
    );
    ok(
      'factory rejects missing transport',
      createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
      }).ok === false,
    );
    ok(
      'factory rejects missing endpoint',
      createMicrosoftGraphMailboxAdapter({
        secretProvider: makeSecretProvider(baseCreds()),
        transport: { request: async () => ({ status: 200 }) },
      }).ok === false,
    );
    ok(
      'factory rejects non-function transport.request',
      createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport: { request: 'not-a-function' },
      }).ok === false,
    );
    ok(
      'factory rejects non-function resolveSecret',
      createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: { resolveSecret: 42 },
        transport: { request: async () => ({ status: 200 }) },
      }).ok === false,
    );

    // ── resolveEmailMailboxSecret ────────────────────────────────────────
    {
      const calls = [];
      const sp = {
        async resolveSecret(ref) {
          calls.push(ref);
          return baseCreds();
        },
      };
      const raw = await resolveEmailMailboxSecret(sp, 'password=LEAK');
      ok('resolve rejects raw password=LEAK secret_ref', raw.ok === false);
      ok('resolve does not call provider for invalid ref', calls.length === 0);
      ok(
        'resolve error does not contain password=LEAK',
        !containsLeak(raw, ['password=LEAK', 'LEAK']),
      );

      const raw2 = await resolveEmailMailboxSecret(sp, 'client_secret=LEAK');
      ok('resolve rejects client_secret=LEAK secret_ref', raw2.ok === false);
      ok('still zero provider calls after second raw', calls.length === 0);

      const good = await resolveEmailMailboxSecret(sp, SECRET_REF);
      ok('resolve accepts opaque kv ref', good.ok === true);
      ok('provider called once with exact ref', calls.length === 1 && calls[0] === SECRET_REF);
      ok(
        'resolved material has tenant_id',
        good.ok && good.value && good.value.tenant_id === TENANT_ID,
      );

      const throwing = {
        async resolveSecret() {
          throw new Error('client_secret=LEAK boom password=LEAK');
        },
      };
      const failed = await resolveEmailMailboxSecret(throwing, SECRET_REF);
      ok(
        'resolve maps provider throw to secret_resolve_failed',
        failed.ok === false && failed.error === 'secret_resolve_failed',
      );
      ok(
        'resolve throw error does not leak err.message',
        !containsLeak(failed, ['password=LEAK', 'client_secret=LEAK', 'boom']),
      );
    }

    // ── Happy path ───────────────────────────────────────────────────────
    {
      const rawWire = [];
      const transport = happyTransport({ rawWire });
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      ok('factory creates adapter', created.ok === true, serializeSafe(created));
      const ad = getAdapter(created);
      ok('adapter has listMessageEnvelopes', ad && typeof ad.listMessageEnvelopes === 'function');

      const result = await ad.listMessageEnvelopes({ top: 10 });
      ok('listMessageEnvelopes happy path ok', result.ok === true, serializeSafe(result));

      const calls = transport.getCalls();
      ok('exactly two transport calls', calls.length === 2, `got ${calls.length}`);
      ok('request order: token POST first', calls[0] && calls[0].method === 'POST');
      ok('request order: messages GET second', calls[1] && calls[1].method === 'GET');

      const expectedTokenUrl = buildTokenUrl(TENANT_ID);
      ok('token URL exact', calls[0].url === expectedTokenUrl, calls[0] && calls[0].url);
      ok(
        'token Content-Type form-urlencoded',
        calls[0].headers
          && String(calls[0].headers['Content-Type'] || calls[0].headers['content-type'])
            .includes('application/x-www-form-urlencoded'),
      );
      const expectedForm = buildTokenFormBody(baseCreds());
      // Wire (handler) sees exact form including client_secret; getCalls never
      // retains raw body (fail-safe constant redaction).
      ok(
        'token form body exact fields on wire (handler)',
        rawWire[0] && rawWire[0].body === expectedForm,
        rawWire[0] && rawWire[0].body,
      );
      ok(
        'getCalls token body is constant REDACTED (no raw form)',
        calls[0].body === REDACTED
          && !String(calls[0].body).includes(APP_CLIENT_SECRET)
          && !String(calls[0].body).includes('client_secret='),
        calls[0] && calls[0].body,
      );
      ok(
        'getCalls preserves Content-Type allowlisted header',
        calls[0].headers
          && String(calls[0].headers['Content-Type'] || calls[0].headers['content-type'])
            .includes('application/x-www-form-urlencoded'),
      );
      ok(
        'token timeout is fixed TOKEN_MS',
        calls[0].timeout_ms === EMAIL_HTTP_TRANSPORT_TIMEOUT.TOKEN_MS,
      );

      const expectedMsgUrl = buildMessagesUrl(PUBLIC_ADDRESS, 10);
      ok(
        'messages URL exact',
        calls[1].url === expectedMsgUrl,
        calls[1] && calls[1].url,
      );
      ok(
        'messages Authorization Bearer present on wire (handler) only',
        rawWire[1]
          && rawWire[1].headers
          && rawWire[1].headers.Authorization === `Bearer ${FAKE_ACCESS_TOKEN}`,
      );
      ok(
        'getCalls Authorization is redacted (not raw token)',
        calls[1].headers
          && (
            calls[1].headers.Authorization === REDACTED
            || calls[1].headers.authorization === REDACTED
          )
          && !containsLeak(calls[1], [FAKE_ACCESS_TOKEN, `Bearer ${FAKE_ACCESS_TOKEN}`]),
      );
      ok(
        'messages timeout is fixed GRAPH_MS',
        calls[1].timeout_ms === EMAIL_HTTP_TRANSPORT_TIMEOUT.GRAPH_MS,
      );

      if (result.ok) {
        const rows = result.value;
        ok('result is array length 1', Array.isArray(rows) && rows.length === 1);
        const row = rows[0];
        const keys = Object.keys(row).sort();
        const expectedKeys = [...ENVELOPE_DTO_KEYS].sort();
        ok(
          'envelope keys exact allowlist',
          JSON.stringify(keys) === JSON.stringify(expectedKeys),
          JSON.stringify(keys),
        );
        ok('envelope id mapped', row.id === 'AAMkAGI1-msg-001');
        ok('envelope from_address mapped', row.from_address === 'guest@example.com');
        ok('envelope has no body field', !Object.prototype.hasOwnProperty.call(row, 'body'));
        ok(
          'envelope has no uniqueBody',
          !Object.prototype.hasOwnProperty.call(row, 'uniqueBody'),
        );
        ok(
          'result does not contain access token or secret_ref',
          !containsLeak(result, [FAKE_ACCESS_TOKEN, APP_CLIENT_SECRET, SECRET_REF]),
        );
      }
      ok(
        'adapter result has no Authorization string',
        !containsLeak(result, ['Authorization', 'Bearer fake-access-token']),
      );
    }

    // provider_resource_id scopes user path
    {
      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint({ provider_resource_id: 'user-object-id-abc' }),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      ok('factory with provider_resource_id ok', created.ok === true);
      const ad = getAdapter(created);
      await ad.listMessageEnvelopes({ top: 5 });
      const calls = transport.getCalls();
      ok(
        'messages URL uses encoded provider_resource_id',
        calls[1] && calls[1].url === buildMessagesUrl('user-object-id-abc', 5),
        calls[1] && calls[1].url,
      );
    }

    // top boundaries
    {
      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const ad = getAdapter(created);

      const t0 = await ad.listMessageEnvelopes({ top: 0 });
      ok('top=0 rejected', t0.ok === false && t0.error === 'top_invalid');
      const t51 = await ad.listMessageEnvelopes({ top: 51 });
      ok('top=51 rejected', t51.ok === false && t51.error === 'top_invalid');
      const tFloat = await ad.listMessageEnvelopes({ top: 1.5 });
      ok('top=1.5 rejected', tFloat.ok === false && tFloat.error === 'top_invalid');
      const tStr = await ad.listMessageEnvelopes({ top: '10' });
      ok('top string rejected', tStr.ok === false && tStr.error === 'top_invalid');
      ok('invalid top does not call transport', transport.getCalls().length === 0);

      const t1 = await ad.listMessageEnvelopes({ top: 1 });
      ok('top=1 accepted', t1.ok === true);
      const t50 = await ad.listMessageEnvelopes({ top: 50 });
      ok('top=50 accepted', t50.ok === true);
      const calls = transport.getCalls();
      ok(
        'top=1 encoded in URL',
        calls.some((c) => c.method === 'GET' && c.url.includes('$top=1')),
      );
      ok(
        'top=50 encoded in URL',
        calls.some((c) => c.method === 'GET' && c.url.includes('$top=50')),
      );
    }

    // Token errors
    {
      async function listWithToken(opts) {
        const transport = happyTransport(opts);
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        return getAdapter(created).listMessageEnvelopes({ top: 5 });
      }

      const t401 = await listWithToken({
        tokenStatus: 401,
        tokenBody: '{"error":"invalid_client","client_secret":"LEAK"}',
      });
      ok('token 401 → token_http_4xx', t401.ok === false && t401.error === 'token_http_4xx');
      ok(
        'token 401 error no body leak',
        !containsLeak(t401, ['LEAK', 'invalid_client', APP_CLIENT_SECRET]),
      );

      const t500 = await listWithToken({ tokenStatus: 500, tokenBody: 'password=LEAK' });
      ok('token 500 → token_http_5xx', t500.ok === false && t500.error === 'token_http_5xx');
      ok('token 500 error no body leak', !containsLeak(t500, ['password=LEAK']));

      const tBadJson = await listWithToken({ tokenBody: 'not-json{' });
      ok(
        'token malformed JSON → token_response_malformed',
        tBadJson.ok === false && tBadJson.error === 'token_response_malformed',
      );

      const tWrongType = await listWithToken({
        tokenBody: JSON.stringify({ token_type: 'mac', access_token: FAKE_ACCESS_TOKEN }),
      });
      ok(
        'wrong token_type → token_response_malformed',
        tWrongType.ok === false && tWrongType.error === 'token_response_malformed',
      );

      const tMissing = await listWithToken({
        tokenBody: JSON.stringify({ token_type: 'Bearer', expires_in: 3600 }),
      });
      ok(
        'missing access_token → token_response_malformed',
        tMissing.ok === false && tMissing.error === 'token_response_malformed',
      );
    }

    // Graph errors
    {
      async function listWithGraph(opts) {
        const transport = happyTransport(opts);
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        return getAdapter(created).listMessageEnvelopes({ top: 5 });
      }

      const graphCases = [
        [401, 'graph_http_401'],
        [403, 'graph_http_403'],
        [404, 'graph_http_404'],
        [429, 'graph_http_429'],
        [503, 'graph_http_5xx'],
      ];
      for (const [status, code] of graphCases) {
        // eslint-disable-next-line no-await-in-loop
        const r = await listWithGraph({
          graphStatus: status,
          graphBody: JSON.stringify({
            error: { message: 'password=LEAK client_secret=LEAK', body: 'secret' },
          }),
        });
        ok(`graph ${status} → ${code}`, r.ok === false && r.error === code);
        ok(
          `graph ${status} no sensitive leak`,
          !containsLeak(r, [
            'password=LEAK',
            'client_secret=LEAK',
            FAKE_ACCESS_TOKEN,
            SECRET_REF,
          ]),
        );
      }

      const badJson = await listWithGraph({ graphBody: '{not json' });
      ok(
        'graph malformed JSON → graph_response_malformed',
        badJson.ok === false && badJson.error === 'graph_response_malformed',
      );

      const noValue = await listWithGraph({ graphBody: JSON.stringify({ messages: [] }) });
      ok(
        'graph missing value → graph_response_malformed',
        noValue.ok === false && noValue.error === 'graph_response_malformed',
      );
    }

    // Malformed rows fail closed — no partial output
    {
      const transport = happyTransport({
        messages: [
          sampleMessage({ id: 'good-1' }),
          sampleMessage({ id: 12345 }),
          sampleMessage({ id: 'good-3' }),
        ],
      });
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 10 });
      ok(
        'malformed row fails closed',
        r.ok === false && r.error === 'graph_response_malformed',
      );
      ok('no partial value array on failure', r.value === undefined);
    }

    // Response extras → exact own-data allowlist fail closed (no partial)
    {
      const hostileRow = sampleMessage({
        body: { contentType: 'html', content: 'password=LEAK' },
        uniqueBody: { content: 'client_secret=LEAK' },
        internetMessageHeaders: [{ name: 'Secret', value: 'LEAK' }],
        secret: 'password=LEAK',
        access_token: FAKE_ACCESS_TOKEN,
      });
      const transport = happyTransport({
        graphBody: JSON.stringify({
          value: [hostileRow],
          secret: 'password=LEAK',
          body: 'should-not-appear',
          '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users...',
        }),
      });
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 3 });
      ok(
        'hostile extra graph fields → graph_response_malformed',
        r.ok === false && r.error === 'graph_response_malformed',
        serializeSafe(r),
      );
      ok('hostile extras: no partial value', r.value === undefined);
      ok(
        'hostile extras: serialized result has no planted LEAK',
        !containsLeak(r, ['password=LEAK', 'client_secret=LEAK', FAKE_ACCESS_TOKEN]),
      );
    }
    // Row-only extras (list envelope clean) still fail closed
    {
      const rowExtra = sampleMessage({
        body: { content: 'password=LEAK' },
        uniqueBody: { content: 'client_secret=LEAK' },
      });
      const transport = happyTransport({
        graphBody: JSON.stringify({ value: [rowExtra] }),
      });
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 3 });
      ok(
        'row body/uniqueBody extras → graph_response_malformed',
        r.ok === false && r.error === 'graph_response_malformed',
      );
      ok('row extras no partial', r.value === undefined);
      ok(
        'row extras no leak',
        !containsLeak(r, ['password=LEAK', 'client_secret=LEAK']),
      );
    }
    // @odata list metadata rejected for non-pagination slice
    {
      const transport = happyTransport({
        graphBody: JSON.stringify({
          value: [sampleMessage()],
          '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users...',
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/x/messages?$skiptoken=LEAK',
        }),
      });
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 3 });
      ok(
        'graph list @odata extras → graph_response_malformed',
        r.ok === false && r.error === 'graph_response_malformed',
      );
      ok('graph list @odata no partial', r.value === undefined);
      ok(
        'graph list @odata no leak',
        !containsLeak(r, ['LEAK', 'skiptoken', '@odata']),
      );
    }

    // Transport throws
    {
      const transport = happyTransport({ throwOn: 'token' });
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
      ok('transport throw → transport_error', r.ok === false && r.error === 'transport_error');
      ok(
        'transport throw no err.message leak',
        !containsLeak(r, ['password=LEAK', 'client_secret=LEAK', 'hostile']),
      );
    }
    {
      const transport = happyTransport({ throwOn: 'graph' });
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
      ok(
        'graph transport throw → transport_error',
        r.ok === false && r.error === 'transport_error',
      );
      ok(
        'graph transport throw no leak',
        !containsLeak(r, ['password=LEAK', 'client_secret=LEAK']),
      );
    }

    // Secret resolve failures via adapter
    {
      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: {
          async resolveSecret() {
            throw new Error('password=LEAK');
          },
        },
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
      ok(
        'adapter secret throw → secret_resolve_failed',
        r.ok === false && r.error === 'secret_resolve_failed',
      );
      ok('no transport calls when secret throws', transport.getCalls().length === 0);
      ok('no password leak', !containsLeak(r, ['password=LEAK']));
    }
    {
      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider({ access_token: FAKE_ACCESS_TOKEN }),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
      ok(
        'access_token-only material → secret_material_invalid',
        r.ok === false && r.error === 'secret_material_invalid',
      );
      ok('no transport when material invalid', transport.getCalls().length === 0);
    }
    {
      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider({
          tenant_id: TENANT_ID,
          client_id: APP_CLIENT_ID,
          client_secret: APP_CLIENT_SECRET,
          password: 'LEAK',
        }),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
      ok(
        'extra credential key → secret_material_invalid',
        r.ok === false && r.error === 'secret_material_invalid',
      );
      ok('no transport on extra key', transport.getCalls().length === 0);
      ok('extra key error no LEAK', !containsLeak(r, ['LEAK', APP_CLIENT_SECRET]));
    }
    {
      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider({
          tenant_id: TENANT_ID,
          client_id: APP_CLIENT_ID,
          client_secret: APP_CLIENT_SECRET,
          nested: { client_secret: 'LEAK' },
        }),
        transport,
      });
      const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
      ok(
        'nested credential key → secret_material_invalid',
        r.ok === false && r.error === 'secret_material_invalid',
      );
    }

    // Raw secret_ref at factory time
    {
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint({ secret_ref: 'password=LEAK' }),
        secretProvider: makeSecretProvider(baseCreds()),
        transport: happyTransport({}),
      });
      ok('factory rejects raw secret_ref', created.ok === false);
      ok('factory raw secret_ref error no leak', !containsLeak(created, ['password=LEAK']));
    }

    // No credential/token caching across calls
    {
      let resolveCount = 0;
      const sp = {
        async resolveSecret() {
          resolveCount += 1;
          return baseCreds();
        },
      };
      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: sp,
        transport,
      });
      const ad = getAdapter(created);
      await ad.listMessageEnvelopes({ top: 2 });
      await ad.listMessageEnvelopes({ top: 2 });
      ok(
        'secret resolved per list call (no cache)',
        resolveCount === 2,
        `count=${resolveCount}`,
      );
      ok('token+messages twice (4 calls)', transport.getCalls().length === 4);
    }

    // getIdentity does not expose secret_ref
    {
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport: happyTransport({}),
      });
      const id = getAdapter(created).getIdentity();
      ok('identity has provider microsoft_graph', id.provider === 'microsoft_graph');
      ok(
        'identity has no secret_ref',
        !Object.prototype.hasOwnProperty.call(id, 'secret_ref'),
      );
      ok(
        'identity has no client_secret',
        !Object.prototype.hasOwnProperty.call(id, 'client_secret'),
      );
    }

    // ── Gap 1: fake transport getCalls fail-safe sanitization ────────────
    // Policy: never persist raw body; only Accept/Content-Type header values;
    // every other header value redacted by name-agnostic policy. Transient
    // handler still receives exact wire body/headers. JSON.stringify(getCalls())
    // must never contain planted markers.
    {
      const PLANTED_SECRET = 'planted-client-secret-LEAK-VALUE-9f3a';
      const PLANTED_TOKEN = 'planted-access-token-LEAK-VALUE-7b2c';
      const PLANTED_MARKER = 'PLANTED_MARKER_LEAK_9f3a7b2c';
      const rawWire = [];
      const transport = createFakeEmailHttpTransport({
        handler(call, index) {
          rawWire.push(call);
          if (index === 0) {
            return {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token_type: 'Bearer',
                access_token: PLANTED_TOKEN,
                expires_in: 3600,
              }),
            };
          }
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: [sampleMessage()] }),
          };
        },
      });

      // Direct request recording with planted secrets in body + hostile headers
      await transport.request({
        method: 'POST',
        url: 'https://login.microsoftonline.com/t/oauth2/v2.0/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Authorization: `Bearer ${PLANTED_TOKEN}`,
          'X-Access-Token': PLANTED_MARKER,
          'X-Secret': PLANTED_MARKER,
          'API-Key': PLANTED_MARKER,
        },
        body: `grant_type=client_credentials&client_id=abc&client_secret=${encodeURIComponent(PLANTED_SECRET)}&scope=x`,
      });
      await transport.request({
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/u/messages',
        headers: {
          authorization: `Bearer ${PLANTED_TOKEN}`,
          Accept: 'application/json',
          'X-Custom-Auth': PLANTED_MARKER,
        },
      });

      const recorded = transport.getCalls();
      const serialized = serializeSafe(recorded);
      ok(
        'getCalls serialization omits planted client_secret',
        !serialized.includes(PLANTED_SECRET)
          && !serialized.includes(encodeURIComponent(PLANTED_SECRET)),
      );
      ok(
        'getCalls serialization omits planted access token',
        !serialized.includes(PLANTED_TOKEN)
          && !serialized.includes(`Bearer ${PLANTED_TOKEN}`),
      );
      ok(
        'getCalls serialization omits planted marker from headers',
        !serialized.includes(PLANTED_MARKER),
      );
      ok(
        'getCalls body is constant REDACTED (not form-parsed)',
        recorded[0].body === REDACTED
          && !String(recorded[0].body).includes('grant_type')
          && !String(recorded[0].body).includes('client_secret'),
      );
      ok(
        'getCalls GET without body omits body field',
        recorded[1].body === undefined
          || !Object.prototype.hasOwnProperty.call(recorded[1], 'body')
          || recorded[1].body === REDACTED,
      );
      ok(
        'getCalls redacts Authorization case-insensitively',
        recorded[0].headers.Authorization === REDACTED
          && recorded[1].headers.authorization === REDACTED,
      );
      ok(
        'getCalls redacts arbitrary X-Access-Token / X-Secret / API-Key',
        recorded[0].headers['X-Access-Token'] === REDACTED
          && recorded[0].headers['X-Secret'] === REDACTED
          && recorded[0].headers['API-Key'] === REDACTED
          && recorded[1].headers['X-Custom-Auth'] === REDACTED,
      );
      ok(
        'getCalls preserves Accept and Content-Type allowlisted values',
        recorded[0].headers['Content-Type'] === 'application/x-www-form-urlencoded'
          && recorded[0].headers.Accept === 'application/json'
          && recorded[1].headers.Accept === 'application/json',
      );
      ok(
        'getCalls retains url/method/timeout metadata',
        recorded[0].method === 'POST'
          && recorded[0].url.includes('login.microsoftonline.com')
          && recorded[1].method === 'GET',
      );
      ok(
        'handler still receives raw client_secret on wire',
        rawWire[0] && rawWire[0].body.includes(encodeURIComponent(PLANTED_SECRET)),
      );
      ok(
        'handler still receives raw Authorization on wire',
        rawWire[1]
          && rawWire[1].headers.authorization === `Bearer ${PLANTED_TOKEN}`,
      );
      ok(
        'handler still receives raw hostile header values on wire',
        rawWire[0]
          && rawWire[0].headers['X-Access-Token'] === PLANTED_MARKER
          && rawWire[0].headers['API-Key'] === PLANTED_MARKER,
      );

      transport.reset();
      ok('reset clears sanitized getCalls state', transport.getCalls().length === 0);

      // Direct unit helpers
      ok(
        'sanitizePersistedBody always REDACTED for string body',
        sanitizePersistedBody('a=1&client_secret=SECRET&b=2') === REDACTED,
      );
      ok(
        'sanitizePersistedBody undefined stays undefined',
        sanitizePersistedBody(undefined) === undefined,
      );
      ok(
        'sanitizeHeaders redacts non-allowlisted including Authorization',
        sanitizeHeaders({
          AUTHORIZATION: 'Bearer x',
          Accept: 'application/json',
          'X-Access-Token': PLANTED_MARKER,
        }).AUTHORIZATION === REDACTED
          && sanitizeHeaders({
            AUTHORIZATION: 'Bearer x',
            Accept: 'application/json',
            'X-Access-Token': PLANTED_MARKER,
          }).Accept === 'application/json'
          && sanitizeHeaders({
            AUTHORIZATION: 'Bearer x',
            Accept: 'application/json',
            'X-Access-Token': PLANTED_MARKER,
          })['X-Access-Token'] === REDACTED,
      );
      ok(
        'PERSISTED_HEADER_ALLOWLIST is Accept + Content-Type only',
        Array.isArray(PERSISTED_HEADER_ALLOWLIST)
          && PERSISTED_HEADER_ALLOWLIST.length === 2
          && PERSISTED_HEADER_ALLOWLIST.includes('accept')
          && PERSISTED_HEADER_ALLOWLIST.includes('content-type'),
      );

      // ── Planted-marker matrix: bodies (form keys + encodings) ──
      const RAW_SECRET = 'RAW_SECRET_PLANTED_9f3a_VALUE';
      const RAW_SECRET_SPACED = 'RAW SECRET PLANTED';
      const bodyCases = [
        {
          name: 'literal client_secret',
          body: `grant_type=client_credentials&client_secret=${RAW_SECRET}&scope=x`,
        },
        {
          name: 'percent-encoded-key client%5Fsecret',
          body: `grant_type=client_credentials&client%5Fsecret=${RAW_SECRET}&scope=x`,
        },
        {
          name: 'percent-encoded-key %63lient_secret',
          body: `grant_type=client_credentials&%63lient_secret=${RAW_SECRET}&scope=x`,
        },
        {
          name: 'double-encoded client_secret key client%255Fsecret',
          body: `grant_type=client_credentials&client%255Fsecret=${RAW_SECRET}&scope=x`,
        },
        {
          name: 'access_token form key',
          body: `access_token=${RAW_SECRET}&token=${RAW_SECRET}`,
        },
        {
          name: 'password/api_key form keys',
          body: `password=${RAW_SECRET}&api_key=${RAW_SECRET}`,
        },
        {
          name: 'duplicate-key client_secret',
          body: `client_secret=${RAW_SECRET}&client_secret=${RAW_SECRET}&a=1`,
        },
        {
          name: 'mixed hostile literal + percent-encoded-key',
          body: `client_secret=${RAW_SECRET}&client%5Fsecret=${RAW_SECRET}&%63lient_secret=${RAW_SECRET}`,
        },
        {
          name: 'plus-as-space value',
          body: `client_secret=${encodeURIComponent(RAW_SECRET_SPACED).replace(/%20/g, '+')}&x=1`,
        },
        {
          name: 'percent-encoded value',
          body: `client_secret=${encodeURIComponent(RAW_SECRET)}&x=1`,
        },
        {
          name: 'malformed percent %ZZ',
          body: `client_secret=${RAW_SECRET}&foo=%ZZ`,
        },
        {
          name: 'malformed percent trailing %',
          body: `client_secret=${RAW_SECRET}%`,
        },
        {
          name: 'malformed percent %A',
          body: `client_secret=${RAW_SECRET}&x=%A`,
        },
        {
          name: 'malformed percent %G1',
          body: `client_secret=${RAW_SECRET}&x=%G1`,
        },
      ];

      for (const fc of bodyCases) {
        const sanitized = sanitizePersistedBody(fc.body);
        const ser = serializeSafe(sanitized);
        ok(
          `sanitizePersistedBody (${fc.name}) never retains planted secret`,
          sanitized === REDACTED
            && !ser.includes(RAW_SECRET)
            && !ser.includes(RAW_SECRET_SPACED)
            && !ser.includes(encodeURIComponent(RAW_SECRET)),
          ser,
        );
      }

      // getCalls persistence for each adversarial form + JSON.stringify never has marker
      {
        const advBodies = bodyCases.map((c) => c.body);
        const rawSeen = [];
        for (const b of advBodies) {
          const t = createFakeEmailHttpTransport({
            handler(call) {
              rawSeen.push(call.body);
              return { status: 204 };
            },
          });
          // eslint-disable-next-line no-await-in-loop
          await t.request({
            method: 'POST',
            url: 'https://login.microsoftonline.com/t/oauth2/v2.0/token',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: b,
          });
          const ser = JSON.stringify(t.getCalls());
          ok(
            `JSON.stringify(getCalls()) omits secret for form ${b.slice(0, 48)}`,
            !ser.includes(RAW_SECRET)
              && !ser.includes(RAW_SECRET_SPACED)
              && !ser.includes(encodeURIComponent(RAW_SECRET))
              && ser.includes(REDACTED),
            ser,
          );
        }
        // Transient raw handler call must still carry planted secret unmutated
        ok(
          'transient raw handler retains literal secret (not sanitized in place)',
          rawSeen[0] === bodyCases[0].body,
        );
        ok(
          'transient raw handler retains percent-encoded-key body unmutated',
          rawSeen[1] === bodyCases[1].body,
        );
        ok(
          'transient raw handler retains double-encoded key body unmutated',
          rawSeen[3] === bodyCases[3].body,
        );
      }

      // ── Planted-marker matrix: arbitrary headers ──
      {
        const headerProbes = [
          { name: 'X-Access-Token', key: 'X-Access-Token' },
          { name: 'x-access-token', key: 'x-access-token' },
          { name: 'X-Secret', key: 'X-Secret' },
          { name: 'API-Key', key: 'API-Key' },
          { name: 'api_key', key: 'api_key' },
          { name: 'Authorization', key: 'Authorization' },
          { name: 'authorization', key: 'authorization' },
          { name: 'X-Custom-Whatever', key: 'X-Custom-Whatever' },
          { name: 'Cookie', key: 'Cookie' },
          { name: 'Proxy-Authorization', key: 'Proxy-Authorization' },
        ];
        for (const hp of headerProbes) {
          const t = createFakeEmailHttpTransport({
            handler() {
              return { status: 200, headers: {}, body: '{}' };
            },
          });
          // eslint-disable-next-line no-await-in-loop
          await t.request({
            method: 'GET',
            url: 'https://graph.microsoft.com/v1.0/x',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              [hp.key]: PLANTED_MARKER,
            },
          });
          const calls = t.getCalls();
          const ser = JSON.stringify(calls);
          ok(
            `getCalls redacts header ${hp.name} (marker absent from JSON)`,
            calls[0]
              && calls[0].headers[hp.key] === REDACTED
              && !ser.includes(PLANTED_MARKER),
            ser,
          );
          ok(
            `getCalls keeps Accept/Content-Type with ${hp.name} present`,
            calls[0].headers.Accept === 'application/json'
              && calls[0].headers['Content-Type'] === 'application/json',
          );
        }
      }

      // ── Header snapshot: zero getter invocation, zero retained token ──
      {
        let authGetterHits = 0;
        let otherGetterHits = 0;
        const TOKEN = 'Bearer accessor-token-MUST-NOT-LEAK-7b2c';
        const hostileHeaders = Object.create(null);
        Object.defineProperty(hostileHeaders, 'Authorization', {
          enumerable: true,
          configurable: true,
          get() {
            authGetterHits += 1;
            return TOKEN;
          },
        });
        Object.defineProperty(hostileHeaders, 'X-Probe', {
          enumerable: true,
          configurable: true,
          get() {
            otherGetterHits += 1;
            return 'probe';
          },
        });
        Object.defineProperty(hostileHeaders, 'Accept', {
          enumerable: true,
          configurable: true,
          writable: true,
          value: 'application/json',
        });
        // Non-enumerable accessor must also not fire
        Object.defineProperty(hostileHeaders, 'X-Hidden', {
          enumerable: false,
          get() {
            authGetterHits += 1;
            return TOKEN;
          },
        });
        // Symbol key ignored
        const sym = Symbol('Authorization');
        Object.defineProperty(hostileHeaders, sym, {
          enumerable: true,
          value: TOKEN,
        });

        const snap = snapshotOwnEnumerableDataProps(hostileHeaders);
        ok('snapshot omits Authorization accessor', !Object.prototype.hasOwnProperty.call(snap, 'Authorization'));
        ok('snapshot keeps Accept data prop', snap.Accept === 'application/json');
        ok('snapshot omits X-Probe accessor', !Object.prototype.hasOwnProperty.call(snap, 'X-Probe'));
        ok(
          'snapshot zero getter invocation (auth+probe+hidden)',
          authGetterHits === 0 && otherGetterHits === 0,
        );

        const rawBuilt = buildRawCall({
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/users/u/messages',
          headers: hostileHeaders,
        });
        ok(
          'buildRawCall zero getter invocation',
          authGetterHits === 0 && otherGetterHits === 0,
        );
        ok(
          'buildRawCall has no Authorization from accessor',
          !Object.prototype.hasOwnProperty.call(rawBuilt.headers, 'Authorization'),
        );
        ok(
          'buildRawCall has Accept data prop',
          rawBuilt.headers.Accept === 'application/json',
        );

        const accTransport = createFakeEmailHttpTransport({
          handler() {
            return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
          },
        });
        await accTransport.request({
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/x',
          headers: hostileHeaders,
        });
        const calls = accTransport.getCalls();
        const ser = serializeSafe(calls);
        ok(
          'accessor headers: zero getter hits after request',
          authGetterHits === 0 && otherGetterHits === 0,
        );
        ok(
          'accessor headers: getCalls serialization has zero retained token',
          !ser.includes(TOKEN)
            && !ser.includes('accessor-token')
            && !ser.includes('MUST-NOT-LEAK'),
          ser,
        );
        ok(
          'accessor headers: persistent headers lack Authorization key',
          calls[0]
            && !Object.prototype.hasOwnProperty.call(calls[0].headers, 'Authorization'),
        );

        // Array headers → empty snapshot
        ok(
          'snapshotOwnEnumerableDataProps([]) empty',
          Object.keys(snapshotOwnEnumerableDataProps([])).length === 0,
        );
        // Prototype pollution: inherited enumerable not copied
        const proto = { Authorization: TOKEN };
        const child = Object.create(proto);
        child.Accept = 'application/json';
        const protoSnap = snapshotOwnEnumerableDataProps(child);
        ok(
          'snapshot ignores prototype Authorization',
          !Object.prototype.hasOwnProperty.call(protoSnap, 'Authorization')
            && protoSnap.Accept === 'application/json',
        );

        // Data-property Authorization still redacted on sanitize path
        ok(
          'sanitizeHeaders redacts data Authorization',
          sanitizeHeaders({ Authorization: TOKEN }).Authorization === REDACTED,
        );
        const dataRaw = buildRawCall({
          method: 'GET',
          url: 'https://x',
          headers: { Authorization: TOKEN, Accept: 'application/json' },
        });
        ok(
          'buildRawCall retains data Authorization on transient raw (wire)',
          dataRaw.headers.Authorization === TOKEN,
        );
        ok(
          'sanitizeCall redacts data Authorization for persistence',
          sanitizeCall(dataRaw).headers.Authorization === REDACTED
            && !serializeSafe(sanitizeCall(dataRaw)).includes(TOKEN),
        );
        ok(
          'sanitizeCall body is constant REDACTED when present',
          sanitizeCall(buildRawCall({
            method: 'POST',
            url: 'https://x',
            headers: {},
            body: `client_secret=${RAW_SECRET}`,
          })).body === REDACTED
            && !serializeSafe(sanitizeCall(buildRawCall({
              method: 'POST',
              url: 'https://x',
              headers: {},
              body: `client_secret=${RAW_SECRET}`,
            }))).includes(RAW_SECRET),
        );

        // ── Request-object snapshot: own accessors on every request field ──
        {
          const REQ_SECRET = 'req-accessor-secret-MUST-NOT-LEAK-9f1a';
          const hits = {
            method: 0,
            url: 0,
            headers: 0,
            body: 0,
            timeout_ms: 0,
          };
          const hostileReq = {};
          for (const key of Object.keys(hits)) {
            Object.defineProperty(hostileReq, key, {
              enumerable: true,
              configurable: true,
              get() {
                hits[key] += 1;
                if (key === 'headers') {
                  return { Authorization: `Bearer ${REQ_SECRET}` };
                }
                if (key === 'timeout_ms') return 1234;
                if (key === 'body') return `client_secret=${REQ_SECRET}`;
                if (key === 'method') return 'POST';
                return `https://evil.example/${REQ_SECRET}`;
              },
            });
          }

          const rawHostile = buildRawCall(hostileReq);
          ok('request own accessors: zero method hits', hits.method === 0);
          ok('request own accessors: zero url hits', hits.url === 0);
          ok('request own accessors: zero headers hits', hits.headers === 0);
          ok('request own accessors: zero body hits', hits.body === 0);
          ok('request own accessors: zero timeout_ms hits', hits.timeout_ms === 0);
          ok(
            'request own accessors: defaults when only accessors present',
            rawHostile.method === ''
              && rawHostile.url === ''
              && rawHostile.body === undefined
              && rawHostile.timeout_ms === undefined
              && Object.keys(rawHostile.headers).length === 0,
          );
          const serHostile = serializeSafe(rawHostile);
          ok(
            'request own accessors: no retained secret/token',
            !serHostile.includes(REQ_SECRET)
              && !serHostile.includes('MUST-NOT-LEAK')
              && !serHostile.includes('req-accessor-secret'),
            serHostile,
          );

          // Via transport.request — persistent recorder also secret-free
          const accReqTransport = createFakeEmailHttpTransport({
            handler() {
              return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              };
            },
          });
          await accReqTransport.request(hostileReq);
          ok(
            'request own accessors via transport: zero hits on all fields',
            hits.method === 0
              && hits.url === 0
              && hits.headers === 0
              && hits.body === 0
              && hits.timeout_ms === 0,
          );
          const accSer = serializeSafe(accReqTransport.getCalls());
          ok(
            'request own accessors via transport: no retained secret',
            !accSer.includes(REQ_SECRET)
              && !accSer.includes('MUST-NOT-LEAK')
              && !accSer.includes('client_secret='),
            accSer,
          );
        }

        // ── Request-object snapshot: prototype getters on every field ──
        {
          const PROTO_SECRET = 'req-proto-secret-MUST-NOT-LEAK-4c2e';
          const protoHits = {
            method: 0,
            url: 0,
            headers: 0,
            body: 0,
            timeout_ms: 0,
          };
          const proto = {};
          for (const key of Object.keys(protoHits)) {
            Object.defineProperty(proto, key, {
              enumerable: true,
              configurable: true,
              get() {
                protoHits[key] += 1;
                if (key === 'headers') {
                  return { Authorization: `Bearer ${PROTO_SECRET}` };
                }
                if (key === 'timeout_ms') return 99;
                if (key === 'body') return `client_secret=${PROTO_SECRET}`;
                if (key === 'method') return 'DELETE';
                return `https://proto.example/${PROTO_SECRET}`;
              },
            });
          }
          const childReq = Object.create(proto);
          // Own data props only — prototype getters must never supply fields.
          // defineProperty required: inherited getters without setters block
          // assignment under 'use strict'.
          Object.defineProperty(childReq, 'method', {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'GET',
          });
          Object.defineProperty(childReq, 'url', {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'https://graph.microsoft.com/v1.0/x',
          });

          const rawProto = buildRawCall(childReq);
          ok(
            'request prototype getters: zero hits on all fields',
            protoHits.method === 0
              && protoHits.url === 0
              && protoHits.headers === 0
              && protoHits.body === 0
              && protoHits.timeout_ms === 0,
          );
          ok(
            'request prototype getters: uses own data only',
            rawProto.method === 'GET'
              && rawProto.url === 'https://graph.microsoft.com/v1.0/x'
              && rawProto.body === undefined
              && rawProto.timeout_ms === undefined
              && Object.keys(rawProto.headers).length === 0,
          );
          ok(
            'request prototype getters: no retained secret',
            !serializeSafe(rawProto).includes(PROTO_SECRET)
              && !serializeSafe(rawProto).includes('MUST-NOT-LEAK'),
          );

          // Pure prototype request (no own data) → empty defaults, zero hits
          const pureProto = Object.create(proto);
          const rawPure = buildRawCall(pureProto);
          ok(
            'pure prototype request: zero getter hits',
            protoHits.method === 0
              && protoHits.url === 0
              && protoHits.headers === 0
              && protoHits.body === 0
              && protoHits.timeout_ms === 0,
          );
          ok(
            'pure prototype request: empty defaults',
            rawPure.method === ''
              && rawPure.url === ''
              && rawPure.body === undefined
              && rawPure.timeout_ms === undefined
              && Object.keys(rawPure.headers).length === 0,
          );
        }

        // ── Null-prototype plain request data remains supported ──
        {
          const npHeaders = Object.create(null);
          npHeaders.Accept = 'application/json';
          npHeaders.Authorization = 'Bearer null-proto-token-ok';
          const npReq = Object.create(null);
          npReq.method = 'GET';
          npReq.url = 'https://graph.microsoft.com/v1.0/users/u/messages';
          npReq.headers = npHeaders;
          npReq.timeout_ms = 5000;
          npReq.body = 'select=id';
          const npRaw = buildRawCall(npReq);
          ok(
            'null-prototype request: method/url/body/timeout',
            npRaw.method === 'GET'
              && npRaw.url === 'https://graph.microsoft.com/v1.0/users/u/messages'
              && npRaw.body === 'select=id'
              && npRaw.timeout_ms === 5000,
          );
          ok(
            'null-prototype request: nested headers data props',
            npRaw.headers.Accept === 'application/json'
              && npRaw.headers.Authorization === 'Bearer null-proto-token-ok',
          );
          // Persistent path redacts non-allowlisted Authorization
          const npSan = sanitizeCall(npRaw);
          ok(
            'null-prototype sanitizeCall redacts Authorization keeps Accept',
            npSan.headers.Authorization === REDACTED
              && npSan.headers.Accept === 'application/json'
              && npSan.body === REDACTED,
          );
        }

        // ── No-coercion: hostile Symbol.toPrimitive / valueOf / toString ──
        // After descriptor snapshot, rejected values must never be coerced
        // (String/Number/template/valueOf/toString/Symbol.toPrimitive).
        {
          const COERCE_MARKER = 'coerce-hook-MARKER-MUST-NOT-LEAK-e7a1';
          const hookHits = {
            toPrimitive: 0,
            valueOf: 0,
            toString: 0,
          };

          function makeHostileValue(label) {
            // Own data value that is an object whose coercion hooks count + plant.
            return {
              [Symbol.toPrimitive](hint) {
                hookHits.toPrimitive += 1;
                return `prim-${label}-${COERCE_MARKER}-${hint}`;
              },
              valueOf() {
                hookHits.valueOf += 1;
                return `valueOf-${label}-${COERCE_MARKER}`;
              },
              toString() {
                hookHits.toString += 1;
                return `toString-${label}-${COERCE_MARKER}`;
              },
            };
          }

          function makeHostileTimeout() {
            return {
              [Symbol.toPrimitive](hint) {
                hookHits.toPrimitive += 1;
                return hint === 'number' ? 7777 : `prim-timeout-${COERCE_MARKER}`;
              },
              valueOf() {
                hookHits.valueOf += 1;
                return 7777;
              },
              toString() {
                hookHits.toString += 1;
                return `toString-timeout-${COERCE_MARKER}`;
              },
            };
          }

          function totalHits() {
            return hookHits.toPrimitive + hookHits.valueOf + hookHits.toString;
          }

          function assertZeroHooks(name) {
            ok(
              name,
              totalHits() === 0
                && hookHits.toPrimitive === 0
                && hookHits.valueOf === 0
                && hookHits.toString === 0,
              `hits=${JSON.stringify(hookHits)}`,
            );
          }

          function assertNoMarker(name, payload) {
            const ser = serializeSafe(payload);
            ok(
              name,
              !ser.includes(COERCE_MARKER)
                && !ser.includes('coerce-hook')
                && !ser.includes('prim-')
                && !ser.includes('valueOf-')
                && !ser.includes('toString-'),
              ser,
            );
          }

          // Own data: method/url/body/timeout + allowlisted + non-allowlisted headers
          const ownHostileHeaders = {
            Accept: makeHostileValue('Accept'),
            'Content-Type': makeHostileValue('Content-Type'),
            Authorization: makeHostileValue('Authorization'),
            'X-Custom-Secret': makeHostileValue('X-Custom'),
          };
          const ownHostileReq = {
            method: makeHostileValue('method'),
            url: makeHostileValue('url'),
            body: makeHostileValue('body'),
            timeout_ms: makeHostileTimeout(),
            headers: ownHostileHeaders,
          };

          const rawOwn = buildRawCall(ownHostileReq);
          assertZeroHooks('coercion own: zero hooks after buildRawCall');
          ok(
            'coercion own: defaults/omits (no string/number from hooks)',
            rawOwn.method === ''
              && rawOwn.url === ''
              && rawOwn.body === undefined
              && rawOwn.timeout_ms === undefined
              && Object.keys(rawOwn.headers).length === 0,
          );
          assertNoMarker('coercion own: no planted marker in transient raw', rawOwn);
          const sanOwn = sanitizeCall(rawOwn);
          assertZeroHooks('coercion own: zero hooks after sanitizeCall');
          assertNoMarker('coercion own: no planted marker in persisted sanitizeCall', sanOwn);

          // sanitizeHeaders directly on hostile header map (own data objects)
          const sanHeadersDirect = sanitizeHeaders(ownHostileHeaders);
          assertZeroHooks('coercion own: zero hooks after sanitizeHeaders direct');
          ok(
            'coercion own: sanitizeHeaders omits all non-string header values',
            Object.keys(sanHeadersDirect).length === 0,
          );
          assertNoMarker(
            'coercion own: sanitizeHeaders direct has no marker',
            sanHeadersDirect,
          );

          // Through transport.request
          let wireOwn = null;
          const coerceTransport = createFakeEmailHttpTransport({
            handler(call) {
              wireOwn = call;
              return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              };
            },
          });
          await coerceTransport.request(ownHostileReq);
          assertZeroHooks('coercion own via transport: zero hooks');
          ok(
            'coercion own via transport: wire defaults empty',
            wireOwn
              && wireOwn.method === ''
              && wireOwn.url === ''
              && wireOwn.body === undefined
              && wireOwn.timeout_ms === undefined
              && Object.keys(wireOwn.headers).length === 0,
          );
          assertNoMarker('coercion own via transport: no marker on wire', wireOwn);
          const persistedOwn = coerceTransport.getCalls();
          assertNoMarker(
            'coercion own via transport: no marker in getCalls',
            persistedOwn,
          );
          ok(
            'coercion own via transport: getCalls body absent or REDACTED only',
            persistedOwn[0]
              && (persistedOwn[0].body === undefined
                || persistedOwn[0].body === REDACTED)
              && !serializeSafe(persistedOwn).includes(COERCE_MARKER),
          );

          // Prototype-chain coercion hooks (own data absent → empty defaults)
          const protoCoerce = {};
          for (const key of ['method', 'url', 'body', 'timeout_ms', 'headers']) {
            Object.defineProperty(protoCoerce, key, {
              enumerable: true,
              configurable: true,
              get() {
                // Should never be invoked by snapshot; if invoked, still plant
                // a hostile object with coercion hooks.
                hookHits.toPrimitive += 1; // count as leak of prototype read
                if (key === 'headers') {
                  return {
                    Accept: makeHostileValue('proto-Accept'),
                    Authorization: makeHostileValue('proto-Auth'),
                  };
                }
                if (key === 'timeout_ms') return makeHostileTimeout();
                return makeHostileValue(`proto-${key}`);
              },
            });
          }
          const pureProtoCoerce = Object.create(protoCoerce);
          const rawProtoCoerce = buildRawCall(pureProtoCoerce);
          ok(
            'coercion proto: zero prototype getter + coercion hooks',
            totalHits() === 0,
            `hits=${JSON.stringify(hookHits)}`,
          );
          ok(
            'coercion proto: empty defaults',
            rawProtoCoerce.method === ''
              && rawProtoCoerce.url === ''
              && rawProtoCoerce.body === undefined
              && rawProtoCoerce.timeout_ms === undefined
              && Object.keys(rawProtoCoerce.headers).length === 0,
          );
          assertNoMarker('coercion proto: no marker in transient', rawProtoCoerce);

          // Own string fields + hostile header values only
          const mixedHeaders = {
            Accept: makeHostileValue('mix-Accept'),
            'Content-Type': 'application/json',
            Authorization: makeHostileValue('mix-Auth'),
            'X-Token': makeHostileValue('mix-X'),
          };
          const mixedReq = {
            method: 'POST',
            url: 'https://graph.microsoft.com/v1.0/x',
            body: 'grant_type=client_credentials',
            timeout_ms: 10000,
            headers: mixedHeaders,
          };
          const rawMixed = buildRawCall(mixedReq);
          assertZeroHooks('coercion mixed: zero hooks (hostile header values omitted)');
          ok(
            'coercion mixed: ordinary primitives exact; hostile headers omitted',
            rawMixed.method === 'POST'
              && rawMixed.url === 'https://graph.microsoft.com/v1.0/x'
              && rawMixed.body === 'grant_type=client_credentials'
              && rawMixed.timeout_ms === 10000
              && rawMixed.headers['Content-Type'] === 'application/json'
              && !Object.prototype.hasOwnProperty.call(rawMixed.headers, 'Accept')
              && !Object.prototype.hasOwnProperty.call(rawMixed.headers, 'Authorization')
              && !Object.prototype.hasOwnProperty.call(rawMixed.headers, 'X-Token'),
          );
          assertNoMarker('coercion mixed: no marker in transient', rawMixed);
          const sanMixed = sanitizeCall(rawMixed);
          assertZeroHooks('coercion mixed: zero hooks after sanitize');
          ok(
            'coercion mixed: persisted keeps Content-Type string only',
            sanMixed.headers['Content-Type'] === 'application/json'
              && !Object.prototype.hasOwnProperty.call(sanMixed.headers, 'Accept')
              && !Object.prototype.hasOwnProperty.call(sanMixed.headers, 'Authorization')
              && sanMixed.body === REDACTED
              && sanMixed.method === 'POST'
              && sanMixed.timeout_ms === 10000,
          );
          assertNoMarker('coercion mixed: no marker in persisted', sanMixed);

          // Non-string primitives / boxes / bigint / symbol / function / null
          const typeRejectReq = {
            method: 123,
            url: true,
            body: 0,
            timeout_ms: '5000',
            headers: {
              Accept: null,
              'Content-Type': 42,
              Authorization: undefined,
              'X-Fn': function secretFn() { return COERCE_MARKER; },
              'X-Big': typeof BigInt === 'function' ? BigInt(1) : { not: 'string' },
              'X-Sym': Symbol(COERCE_MARKER),
              'X-Obj': { nested: COERCE_MARKER },
            },
          };
          const rawTypes = buildRawCall(typeRejectReq);
          ok(
            'coercion types: non-string fields default/omit without coercion',
            rawTypes.method === ''
              && rawTypes.url === ''
              && rawTypes.body === undefined
              && rawTypes.timeout_ms === undefined
              && Object.keys(rawTypes.headers).length === 0,
          );
          assertNoMarker('coercion types: no marker in transient', rawTypes);
          // Invalid timeout variants
          for (const bad of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
            const r = buildRawCall({
              method: 'GET',
              url: 'https://x',
              timeout_ms: bad,
            });
            ok(
              `coercion timeout reject ${String(bad)}`,
              r.timeout_ms === undefined && r.method === 'GET' && r.url === 'https://x',
            );
          }
          // Valid integer timeouts retained exactly
          ok(
            'coercion timeout accept safe integers',
            buildRawCall({ method: 'GET', url: 'https://x', timeout_ms: 0 }).timeout_ms === 0
              && buildRawCall({ method: 'GET', url: 'https://x', timeout_ms: 15000 }).timeout_ms === 15000
              && buildRawCall({ method: 'GET', url: 'https://x', timeout_ms: -1 }).timeout_ms === -1,
          );

          // Ordinary primitive wire request remains exact (positive control)
          const ordinary = {
            method: 'POST',
            url: 'https://login.microsoftonline.com/t/oauth2/v2.0/token',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: 'Bearer ordinary-token-ok',
            },
            body: 'grant_type=client_credentials&client_secret=ordinary-secret-ok',
            timeout_ms: 10000,
          };
          let wireOrdinary = null;
          const ordTransport = createFakeEmailHttpTransport({
            handler(call) {
              wireOrdinary = call;
              return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              };
            },
          });
          await ordTransport.request(ordinary);
          ok(
            'coercion ordinary: wire exact primitives',
            wireOrdinary
              && wireOrdinary.method === 'POST'
              && wireOrdinary.url === ordinary.url
              && wireOrdinary.body === ordinary.body
              && wireOrdinary.timeout_ms === 10000
              && wireOrdinary.headers.Accept === 'application/json'
              && wireOrdinary.headers['Content-Type'] === 'application/x-www-form-urlencoded'
              && wireOrdinary.headers.Authorization === 'Bearer ordinary-token-ok',
          );
          const ordCalls = ordTransport.getCalls();
          ok(
            'coercion ordinary: persisted redacts body + non-allowlisted headers',
            ordCalls[0]
              && ordCalls[0].method === 'POST'
              && ordCalls[0].url === ordinary.url
              && ordCalls[0].timeout_ms === 10000
              && ordCalls[0].body === REDACTED
              && ordCalls[0].headers.Accept === 'application/json'
              && ordCalls[0].headers['Content-Type'] === 'application/x-www-form-urlencoded'
              && ordCalls[0].headers.Authorization === REDACTED
              && !serializeSafe(ordCalls).includes('ordinary-secret-ok')
              && !serializeSafe(ordCalls).includes('ordinary-token-ok'),
          );

          // Final zero-hook check after all hostile coercion probes
          assertZeroHooks('coercion suite: cumulative zero hooks');
        }

        // ── opts.handler descriptor-safe (zero getter invocation) ──
        {
          let handlerGetterHits = 0;
          const HANDLER_MARKER = 'handler-getter-MARKER-MUST-NOT-LEAK-b3c9';
          const hostileOpts = {};
          Object.defineProperty(hostileOpts, 'handler', {
            enumerable: true,
            configurable: true,
            get() {
              handlerGetterHits += 1;
              return function secretHandler() {
                return {
                  status: 200,
                  body: `{"planted":"${HANDLER_MARKER}"}`,
                };
              };
            },
          });
          const tNoHandler = createFakeEmailHttpTransport(hostileOpts);
          ok(
            'opts.handler accessor: zero getter hits at create',
            handlerGetterHits === 0,
          );
          const resNoHandler = await tNoHandler.request({
            method: 'GET',
            url: 'https://x',
          });
          ok(
            'opts.handler accessor: zero getter hits after request',
            handlerGetterHits === 0,
          );
          ok(
            'opts.handler accessor: falls back to no_handler (not invoked)',
            resNoHandler
              && resNoHandler.status === 599
              && String(resNoHandler.body || '').includes('no_handler'),
          );
          ok(
            'opts.handler accessor: getCalls has no handler marker',
            !serializeSafe(tNoHandler.getCalls()).includes(HANDLER_MARKER),
          );

          // Prototype handler getter must not supply handler either
          const protoOpts = {};
          Object.defineProperty(protoOpts, 'handler', {
            enumerable: true,
            configurable: true,
            get() {
              handlerGetterHits += 1;
              return function protoHandler() {
                return { status: 200, body: `{"planted":"${HANDLER_MARKER}"}` };
              };
            },
          });
          const childOpts = Object.create(protoOpts);
          const tProto = createFakeEmailHttpTransport(childOpts);
          const resProto = await tProto.request({ method: 'GET', url: 'https://y' });
          ok(
            'opts.handler prototype getter: zero hits + no_handler',
            handlerGetterHits === 0
              && resProto
              && resProto.status === 599,
          );

          // Ordinary data-property handler still works
          let ordinaryHandlerHits = 0;
          const tOk = createFakeEmailHttpTransport({
            handler() {
              ordinaryHandlerHits += 1;
              return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: '{"ok":true}',
              };
            },
          });
          const resOk = await tOk.request({
            method: 'GET',
            url: 'https://graph.microsoft.com/v1.0/x',
            headers: { Accept: 'application/json' },
            timeout_ms: 15000,
          });
          ok(
            'opts.handler data prop: invoked and returns body',
            ordinaryHandlerHits === 1
              && resOk
              && resOk.status === 200
              && resOk.body === '{"ok":true}',
          );
          ok(
            'opts.handler data prop: getCalls retains primitive metadata',
            tOk.getCalls()[0]
              && tOk.getCalls()[0].method === 'GET'
              && tOk.getCalls()[0].url === 'https://graph.microsoft.com/v1.0/x'
              && tOk.getCalls()[0].timeout_ms === 15000
              && tOk.getCalls()[0].headers.Accept === 'application/json',
          );
        }
      }
    }

    // ── Gap 2: strict access_token validation (RFC 6750 b64token) ────────
    {
      ok('isStrictAccessToken rejects empty', isStrictAccessToken('') === false);
      ok('isStrictAccessToken accepts normal token', isStrictAccessToken(FAKE_ACCESS_TOKEN) === true);
      ok(
        'isStrictAccessToken rejects CRLF',
        isStrictAccessToken('abc\r\nInjected: evil') === false,
      );
      ok(
        'isStrictAccessToken rejects spaces/tabs/newlines',
        isStrictAccessToken('abc def') === false
          && isStrictAccessToken('abc\tdef') === false
          && isStrictAccessToken('abc\ndef') === false,
      );
      ok(
        'isStrictAccessToken rejects DEL',
        isStrictAccessToken(`abc${String.fromCharCode(0x7F)}def`) === false,
      );
      ok(
        'isStrictAccessToken rejects overlong token',
        isStrictAccessToken('x'.repeat(ACCESS_TOKEN_MAX_LEN + 1)) === false,
      );
      ok(
        'isStrictAccessToken accepts max-length token',
        isStrictAccessToken('x'.repeat(ACCESS_TOKEN_MAX_LEN)) === true,
      );

      // Unicode whitespace / line terminators / controls (direct)
      ok(
        'isStrictAccessToken rejects U+00A0 NBSP',
        isStrictAccessToken('tok\u00A0en') === false,
      );
      ok(
        'isStrictAccessToken rejects U+0085 NEL',
        isStrictAccessToken('tok\u0085en') === false,
      );
      ok(
        'isStrictAccessToken rejects U+2028 LS',
        isStrictAccessToken('tok\u2028en') === false,
      );
      ok(
        'isStrictAccessToken rejects U+2029 PS',
        isStrictAccessToken('tok\u2029en') === false,
      );
      ok(
        'isStrictAccessToken rejects representative Unicode spaces',
        isStrictAccessToken('tok\u2003en') === false // EM SPACE
          && isStrictAccessToken('tok\u2009en') === false // THIN SPACE
          && isStrictAccessToken('tok\u3000en') === false // IDEOGRAPHIC SPACE
          && isStrictAccessToken('tok\u00A0en') === false,
      );
      ok(
        'isStrictAccessToken rejects non-ASCII letters',
        isStrictAccessToken('tokén') === false
          && isStrictAccessToken('tök') === false
          && isStrictAccessToken('token\u00F1') === false,
      );
      ok(
        'isStrictAccessToken rejects invalid punctuation',
        isStrictAccessToken('tok@en') === false
          && isStrictAccessToken('tok!en') === false
          && isStrictAccessToken('tok#en') === false
          && isStrictAccessToken('tok:en') === false
          && isStrictAccessToken('tok"en') === false
          && isStrictAccessToken("tok'en") === false
          && isStrictAccessToken('tok en') === false,
      );
      ok(
        'isStrictAccessToken rejects embedded / leading / malformed padding',
        isStrictAccessToken('ab=c') === false
          && isStrictAccessToken('=abc') === false
          && isStrictAccessToken('ab=cd') === false
          && isStrictAccessToken('ab=cd==') === false
          && isStrictAccessToken('===') === false
          && isStrictAccessToken('a=b=') === false,
      );

      // Valid JWT / base64url / b64token examples
      const VALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      ok('isStrictAccessToken accepts realistic JWT', isStrictAccessToken(VALID_JWT) === true);
      ok(
        'isStrictAccessToken accepts base64url alphabet',
        isStrictAccessToken('abc-_XYZ012.def') === true,
      );
      ok(
        'isStrictAccessToken accepts b64token +/ body',
        isStrictAccessToken('abc+def/ghi') === true,
      );
      ok(
        'isStrictAccessToken accepts trailing = padding',
        isStrictAccessToken('abcd==') === true
          && isStrictAccessToken('abcde=') === true
          && isStrictAccessToken('abcdef') === true,
      );

      ok(
        'extractAccessToken rejects CRLF token',
        extractAccessToken({
          token_type: 'Bearer',
          access_token: 'tok\r\nX',
        }).ok === false,
      );
      ok(
        'extractAccessToken rejects U+00A0 token',
        extractAccessToken({
          token_type: 'Bearer',
          access_token: 'tok\u00A0en',
        }).ok === false,
      );
      ok(
        'extractAccessToken accepts JWT',
        extractAccessToken({
          token_type: 'Bearer',
          access_token: VALID_JWT,
        }).ok === true,
      );

      // Prove transport never receives Graph request when token invalid
      async function listWithBadToken(accessToken) {
        const transport = happyTransport({
          tokenBody: JSON.stringify({
            token_type: 'Bearer',
            access_token: accessToken,
          }),
        });
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
        return { r, calls: transport.getCalls() };
      }

      async function assertTokenMalformedNoGraph(label, accessToken) {
        const { r, calls } = await listWithBadToken(accessToken);
        ok(
          `${label} → token_response_malformed`,
          r.ok === false && r.error === 'token_response_malformed',
        );
        ok(
          `${label}: exactly one token request, zero Graph`,
          calls.length === 1 && calls[0].method === 'POST',
          `calls=${calls.length} method0=${calls[0] && calls[0].method}`,
        );
        return { r, calls };
      }

      const crlf = await assertTokenMalformedNoGraph(
        'CRLF access_token',
        'good\r\nBad: inject',
      );
      await assertTokenMalformedNoGraph('space access_token', 'has space');
      await assertTokenMalformedNoGraph(
        'DEL access_token',
        `x${String.fromCharCode(0x7F)}y`,
      );
      await assertTokenMalformedNoGraph(
        'overlong access_token',
        'Z'.repeat(ACCESS_TOKEN_MAX_LEN + 1),
      );

      // Unicode whitespace / control / non-ASCII / punctuation / padding (e2e)
      await assertTokenMalformedNoGraph('U+00A0 access_token', 'tok\u00A0en');
      await assertTokenMalformedNoGraph('U+0085 access_token', 'tok\u0085en');
      await assertTokenMalformedNoGraph('U+2028 access_token', 'tok\u2028en');
      await assertTokenMalformedNoGraph('U+2029 access_token', 'tok\u2029en');
      await assertTokenMalformedNoGraph('EM SPACE access_token', 'tok\u2003en');
      await assertTokenMalformedNoGraph('non-ASCII letter access_token', 'tokén');
      await assertTokenMalformedNoGraph('invalid punct @ access_token', 'tok@en');
      await assertTokenMalformedNoGraph('embedded = access_token', 'ab=c');
      await assertTokenMalformedNoGraph('leading = access_token', '=abc');

      // Valid JWT still reaches Graph (2 calls: token + Graph)
      {
        const transport = happyTransport({
          tokenBody: JSON.stringify({
            token_type: 'Bearer',
            access_token: VALID_JWT,
          }),
        });
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        const r = await getAdapter(created).listMessageEnvelopes({ top: 5 });
        const calls = transport.getCalls();
        ok(
          'valid JWT access_token succeeds list path',
          r.ok === true,
          r.error,
        );
        ok(
          'valid JWT issues token + Graph (exactly 2 calls)',
          calls.length === 2
            && calls[0].method === 'POST'
            && calls[1].method === 'GET',
        );
      }

      ok(
        'strict token error does not leak planted token body',
        !containsLeak(crlf.r, ['inject', 'Bad:', 'good\r']),
      );
    }

    // ── Gap 3: Content-Type on successful JSON (token + Graph independent) ─
    {
      ok(
        'validateSuccessfulJsonContentType accepts application/json',
        validateSuccessfulJsonContentType({ 'Content-Type': 'application/json' }).ok === true,
      );
      ok(
        'validateSuccessfulJsonContentType accepts charset param',
        validateSuccessfulJsonContentType({
          'content-type': 'application/json; charset=utf-8',
        }).ok === true,
      );
      ok(
        'validateSuccessfulJsonContentType rejects missing',
        validateSuccessfulJsonContentType({}).ok === false,
      );
      ok(
        'validateSuccessfulJsonContentType rejects text/plain',
        validateSuccessfulJsonContentType({ 'Content-Type': 'text/plain' }).ok === false,
      );
      ok(
        'validateSuccessfulJsonContentType rejects text/html',
        validateSuccessfulJsonContentType({ 'Content-Type': 'text/html' }).ok === false,
      );
      ok(
        'validateSuccessfulJsonContentType rejects non-string',
        validateSuccessfulJsonContentType({ 'Content-Type': 123 }).ok === false,
      );
      ok(
        'validateSuccessfulJsonContentType rejects array value',
        validateSuccessfulJsonContentType({ 'Content-Type': ['application/json'] }).ok === false,
      );
      ok(
        'validateSuccessfulJsonContentType rejects duplicate case variants',
        validateSuccessfulJsonContentType({
          'Content-Type': 'application/json',
          'content-type': 'application/json',
        }).ok === false,
      );
      ok(
        'validateSuccessfulJsonContentType rejects conflicting duplicates',
        validateSuccessfulJsonContentType({
          'Content-Type': 'application/json',
          'content-type': 'text/html',
        }).ok === false,
      );
      ok(
        'validateSuccessfulJsonContentType rejects malformed',
        validateSuccessfulJsonContentType({ 'Content-Type': 'application/jsonn' }).ok === false
          && validateSuccessfulJsonContentType({ 'Content-Type': '' }).ok === false,
      );

      // ── Adversarial Content-Type strict parser (reproduced + nearby variants) ──
      const ctAccept = [
        'application/json',
        'APPLICATION/JSON',
        'Application/JSON',
        'application/json; charset=utf-8',
        'application/json;charset=utf-8',
        'application/json; CHARSET=utf-8',
        'application/json; charset="utf-8"',
        'application/json; charset=utf-8; boundary=abc',
      ];
      for (const v of ctAccept) {
        ok(
          `CT accept ${JSON.stringify(v)}`,
          validateSuccessfulJsonContentType({ 'Content-Type': v }).ok === true
            && isStrictApplicationJsonContentType(v) === true,
        );
      }

      const ctReject = [
        ['empty trailing param', 'application/json;'],
        ['trailing param whitespace only', 'application/json; '],
        ['CRLF injection', 'application/json;\r\nX-Injected: evil'],
        ['LF injection', 'application/json;\nX: y'],
        ['CR injection', 'application/json;\rX: y'],
        ['comma multi media type', 'application/json, text/html'],
        ['comma with json second', 'text/plain, application/json'],
        ['empty param name', 'application/json; =utf-8'],
        ['space in param name', 'application/json; char set=utf-8'],
        ['unclosed quote', 'application/json; charset="utf-8'],
        ['unopened quote junk', 'application/json; charset=utf-8"'],
        ['trailing newline', 'application/json; charset=utf-8\n'],
        ['leading space', ' application/json'],
        ['trailing space', 'application/json '],
        ['empty string', ''],
        ['text/plain', 'text/plain'],
        ['text/html', 'text/html'],
        ['application/jsonn', 'application/jsonn'],
        ['application/json/', 'application/json/'],
        ['param without equals', 'application/json; charset'],
        ['empty token value', 'application/json; charset='],
        ['DEL control', `application/json${String.fromCharCode(0x7f)}`],
        ['NUL control', `application/json${String.fromCharCode(0)}`],
        ['tab in value', 'application/json;\tcharset=utf-8'],
        ['conflicting list-style', 'application/json; charset=utf-8, text/html'],
      ];
      for (const [label, v] of ctReject) {
        ok(
          `CT reject ${label}`,
          validateSuccessfulJsonContentType({ 'Content-Type': v }).ok === false
            && isStrictApplicationJsonContentType(v) === false,
        );
      }

      ok(
        'CT reject array header value',
        validateSuccessfulJsonContentType({
          'Content-Type': /** @type {any} */ (['application/json']),
        }).ok === false,
      );
      ok(
        'CT reject duplicate case-variant headers',
        validateSuccessfulJsonContentType({
          'Content-Type': 'application/json',
          'content-type': 'application/json',
        }).ok === false,
      );
      ok(
        'CT reject overlong value',
        validateSuccessfulJsonContentType({
          'Content-Type': `application/json; charset=${'u'.repeat(CONTENT_TYPE_MAX_LEN)}`,
        }).ok === false,
      );

      async function listWithTokenHeaders(tokenHeaders) {
        const transport = happyTransport({ tokenHeaders });
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        const r = await getAdapter(created).listMessageEnvelopes({ top: 3 });
        return { r, calls: transport.getCalls() };
      }

      async function listWithGraphHeaders(graphHeaders) {
        const transport = happyTransport({ graphHeaders });
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        const r = await getAdapter(created).listMessageEnvelopes({ top: 3 });
        return { r, calls: transport.getCalls() };
      }

      const tMissing = await listWithTokenHeaders({});
      ok(
        'token missing Content-Type → token_response_malformed',
        tMissing.r.ok === false && tMissing.r.error === 'token_response_malformed',
      );
      ok('token missing Content-Type no Graph call', tMissing.calls.length === 1);

      const tPlain = await listWithTokenHeaders({ 'Content-Type': 'text/plain' });
      ok(
        'token text/plain → token_response_malformed',
        tPlain.r.ok === false && tPlain.r.error === 'token_response_malformed',
      );

      const tDup = await listWithTokenHeaders({
        'Content-Type': 'application/json',
        'content-type': 'text/html',
      });
      ok(
        'token duplicate conflicting Content-Type → token_response_malformed',
        tDup.r.ok === false && tDup.r.error === 'token_response_malformed',
      );
      ok(
        'token Content-Type error does not surface hostile header value',
        !containsLeak(tDup.r, ['text/html', 'application/json', 'Content-Type']),
      );

      const tArr = await listWithTokenHeaders({ 'Content-Type': ['application/json'] });
      ok(
        'token array Content-Type → token_response_malformed',
        tArr.r.ok === false && tArr.r.error === 'token_response_malformed',
      );

      const gMissing = await listWithGraphHeaders({});
      ok(
        'graph missing Content-Type → graph_response_malformed',
        gMissing.r.ok === false && gMissing.r.error === 'graph_response_malformed',
      );
      ok('graph missing Content-Type still did token+graph', gMissing.calls.length === 2);

      const gHtml = await listWithGraphHeaders({ 'Content-Type': 'text/html' });
      ok(
        'graph text/html → graph_response_malformed',
        gHtml.r.ok === false && gHtml.r.error === 'graph_response_malformed',
      );
      ok(
        'graph Content-Type error does not surface hostile header',
        !containsLeak(gHtml.r, ['text/html', '<html', 'Content-Type']),
      );

      const gDup = await listWithGraphHeaders({
        'Content-Type': 'application/json',
        'CONTENT-TYPE': 'text/plain',
      });
      ok(
        'graph duplicate case Content-Type → graph_response_malformed',
        gDup.r.ok === false && gDup.r.error === 'graph_response_malformed',
      );

      const gCharset = await listWithGraphHeaders({
        'Content-Type': 'application/json; charset=utf-8',
      });
      ok(
        'graph application/json with charset accepted',
        gCharset.r.ok === true,
        serializeSafe(gCharset.r),
      );

      // Token + Graph success paths: adversarial Content-Type must fail closed.
      const tokenCtRejects = [
        'application/json;',
        'application/json;\r\nX-Injected: evil',
        'application/json, text/html',
        'application/json; =utf-8',
        'application/json; charset="utf-8',
      ];
      for (const badCt of tokenCtRejects) {
        // eslint-disable-next-line no-await-in-loop
        const tBad = await listWithTokenHeaders({ 'Content-Type': badCt });
        ok(
          `token CT success-path rejects ${JSON.stringify(badCt)}`,
          tBad.r.ok === false && tBad.r.error === 'token_response_malformed',
          serializeSafe(tBad.r),
        );
        ok(
          `token CT reject ${JSON.stringify(badCt)} no Graph call`,
          tBad.calls.length === 1,
        );
        ok(
          `token CT reject ${JSON.stringify(badCt)} no leak of header value`,
          !containsLeak(tBad.r, [badCt, 'X-Injected', 'evil', 'text/html']),
        );
      }

      const graphCtRejects = [
        'application/json;',
        'application/json;\r\nX-Injected: evil',
        'application/json, text/plain',
        'application/json; char set=utf-8',
        'application/json; charset="utf-8',
      ];
      for (const badCt of graphCtRejects) {
        // eslint-disable-next-line no-await-in-loop
        const gBad = await listWithGraphHeaders({ 'Content-Type': badCt });
        ok(
          `graph CT success-path rejects ${JSON.stringify(badCt)}`,
          gBad.r.ok === false && gBad.r.error === 'graph_response_malformed',
          serializeSafe(gBad.r),
        );
        ok(
          `graph CT reject ${JSON.stringify(badCt)} still did token+graph`,
          gBad.calls.length === 2,
        );
        ok(
          `graph CT reject ${JSON.stringify(badCt)} no leak of header value`,
          !containsLeak(gBad.r, [badCt, 'X-Injected', 'evil', 'text/plain']),
        );
      }

      // Accept path still green for normal + charset
      const tOk = await listWithTokenHeaders({ 'Content-Type': 'application/json' });
      ok(
        'token CT application/json success path',
        tOk.r.ok === true,
        serializeSafe(tOk.r),
      );
      const tCharset = await listWithTokenHeaders({
        'Content-Type': 'application/json; charset=utf-8',
      });
      ok(
        'token CT application/json; charset=utf-8 success path',
        tCharset.r.ok === true,
        serializeSafe(tCharset.r),
      );

      // Error status responses do not require Content-Type (status mapping still works).
      {
        const transport = happyTransport({
          tokenStatus: 401,
          tokenBody: '{"error":"invalid_client"}',
          tokenHeaders: {}, // no Content-Type on error is fine
        });
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        const r = await getAdapter(created).listMessageEnvelopes({ top: 2 });
        ok(
          'token 401 without Content-Type still token_http_4xx',
          r.ok === false && r.error === 'token_http_4xx',
        );
      }
    }

    // ── Gap 4: strict params + accessor hardening ────────────────────────
    // Policy: params_invalid = shape/allowlist/accessor/null/array/unknown key
    //         top_invalid    = top present but not integer in [1, 50]
    {
      ok(
        'params undefined defaults top',
        validateListMessageEnvelopesParams(undefined).ok === true
          && validateListMessageEnvelopesParams(undefined).top === 10,
      );
      ok(
        'params {} defaults top',
        validateListMessageEnvelopesParams({}).ok === true
          && validateListMessageEnvelopesParams({}).top === 10,
      );
      ok(
        'params {top:5} accepted',
        validateListMessageEnvelopesParams({ top: 5 }).ok === true
          && validateListMessageEnvelopesParams({ top: 5 }).top === 5,
      );
      ok(
        'params null → params_invalid',
        validateListMessageEnvelopesParams(null).ok === false
          && validateListMessageEnvelopesParams(null).error === 'params_invalid',
      );
      ok(
        'params array → params_invalid',
        validateListMessageEnvelopesParams([1, 2]).ok === false
          && validateListMessageEnvelopesParams([1, 2]).error === 'params_invalid',
      );
      ok(
        'params unknown key → params_invalid',
        validateListMessageEnvelopesParams({ top: 5, extra: 1 }).ok === false
          && validateListMessageEnvelopesParams({ top: 5, extra: 1 }).error === 'params_invalid',
      );
      ok(
        'params top out of range still top_invalid',
        validateListMessageEnvelopesParams({ top: 0 }).error === 'top_invalid'
          && validateListMessageEnvelopesParams({ top: 51 }).error === 'top_invalid',
      );

      // Getter must not be invoked
      let getterHits = 0;
      const hostileParams = {};
      Object.defineProperty(hostileParams, 'top', {
        enumerable: true,
        configurable: true,
        get() {
          getterHits += 1;
          return 10;
        },
      });
      const gRes = validateListMessageEnvelopesParams(hostileParams);
      ok(
        'params accessor → params_invalid',
        gRes.ok === false && gRes.error === 'params_invalid',
      );
      ok('params accessor getter not invoked', getterHits === 0);

      const symParams = { top: 3 };
      Object.defineProperty(symParams, Symbol('evil'), {
        enumerable: true,
        value: 'LEAK',
      });
      ok(
        'params symbol key → params_invalid',
        validateListMessageEnvelopesParams(symParams).ok === false
          && validateListMessageEnvelopesParams(symParams).error === 'params_invalid',
      );

      // Prototype pollution style: inherited keys ignored if not own — but
      // isPlainObject + own keys only. Object.create with proto top should not
      // count as own top; empty own keys → default top.
      const protoParams = Object.create({ top: 99 });
      // Not plain Object.prototype / null proto when created from {top:99}?
      // Object.create({top:99}) has proto that is not Object.prototype — fail plain.
      ok(
        'params non-plain prototype object → params_invalid',
        validateListMessageEnvelopesParams(protoParams).ok === false
          && validateListMessageEnvelopesParams(protoParams).error === 'params_invalid',
      );

      const transport = happyTransport({});
      const created = createMicrosoftGraphMailboxAdapter({
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
        transport,
      });
      const ad = getAdapter(created);

      const rArr = await ad.listMessageEnvelopes([10]);
      ok(
        'listMessageEnvelopes array → params_invalid',
        rArr.ok === false && rArr.error === 'params_invalid',
      );
      ok('array params no transport', transport.getCalls().length === 0);
      ok(
        'params_invalid has no raw input in details',
        rArr.details === undefined && !containsLeak(rArr, ['10']),
      );

      const rNull = await ad.listMessageEnvelopes(null);
      ok(
        'listMessageEnvelopes null → params_invalid',
        rNull.ok === false && rNull.error === 'params_invalid',
      );

      const rUnknown = await ad.listMessageEnvelopes({ top: 5, filter: 'secret=LEAK' });
      ok(
        'listMessageEnvelopes unknown key → params_invalid',
        rUnknown.ok === false && rUnknown.error === 'params_invalid',
      );
      ok(
        'unknown key error does not echo secret raw',
        !containsLeak(rUnknown, ['secret=LEAK', 'filter', 'LEAK']),
      );

      getterHits = 0;
      const rGet = await ad.listMessageEnvelopes(hostileParams);
      ok(
        'listMessageEnvelopes accessor → params_invalid',
        rGet.ok === false && rGet.error === 'params_invalid',
      );
      ok('listMessageEnvelopes accessor getter not invoked', getterHits === 0);
      ok('accessor params no transport', transport.getCalls().length === 0);

      const rUndef = await ad.listMessageEnvelopes();
      ok('listMessageEnvelopes() undefined params ok', rUndef.ok === true);
    }

    // Accessor rejection on endpoint / secret material / factory opts / rows
    {
      let epGetterHits = 0;
      const ep = baseEndpoint();
      Object.defineProperty(ep, 'client_id', {
        enumerable: true,
        configurable: true,
        get() {
          epGetterHits += 1;
          return CLIENT_UUID;
        },
      });
      // baseEndpoint already set client_id as data prop; redefine:
      const ep2 = {};
      for (const [k, v] of Object.entries(baseEndpoint())) {
        if (k === 'client_id') continue;
        ep2[k] = v;
      }
      Object.defineProperty(ep2, 'client_id', {
        enumerable: true,
        configurable: true,
        get() {
          epGetterHits += 1;
          return CLIENT_UUID;
        },
      });
      const epRes = validateMicrosoftGraphEndpoint(ep2);
      ok(
        'endpoint accessor field rejected',
        epRes.ok === false && epRes.error === 'endpoint_invalid',
      );
      ok('endpoint accessor getter not invoked', epGetterHits === 0);

      let matHits = 0;
      const mat = {
        tenant_id: TENANT_ID,
        client_id: APP_CLIENT_ID,
      };
      Object.defineProperty(mat, 'client_secret', {
        enumerable: true,
        configurable: true,
        get() {
          matHits += 1;
          return APP_CLIENT_SECRET;
        },
      });
      const matRes = validateAppOnlySecretMaterial(mat);
      ok(
        'secret material accessor rejected',
        matRes.ok === false && matRes.error === 'secret_material_invalid',
      );
      ok('secret material accessor getter not invoked', matHits === 0);

      let spHits = 0;
      const spAccessor = {};
      Object.defineProperty(spAccessor, 'resolveSecret', {
        enumerable: true,
        configurable: true,
        get() {
          spHits += 1;
          return async () => baseCreds();
        },
      });
      ok(
        'secret provider accessor resolveSecret rejected',
        validateEmailSecretProvider(spAccessor).ok === false,
      );
      ok('secret provider accessor getter not invoked', spHits === 0);

      let trHits = 0;
      const trAccessor = {};
      Object.defineProperty(trAccessor, 'request', {
        enumerable: true,
        configurable: true,
        get() {
          trHits += 1;
          return async () => ({ status: 200 });
        },
      });
      ok(
        'http transport accessor request rejected',
        validateEmailHttpTransport(trAccessor).ok === false,
      );
      ok('http transport accessor getter not invoked', trHits === 0);

      // Focused factory-opts accessor:
      let optsHits = 0;
      const opts = {
        endpoint: baseEndpoint(),
        secretProvider: makeSecretProvider(baseCreds()),
      };
      Object.defineProperty(opts, 'transport', {
        enumerable: true,
        configurable: true,
        get() {
          optsHits += 1;
          return happyTransport({});
        },
      });
      const optRes = createMicrosoftGraphMailboxAdapter(opts);
      ok(
        'factory opts accessor transport rejected',
        optRes.ok === false && optRes.error === 'adapter_deps_invalid',
      );
      ok('factory opts accessor getter not invoked', optsHits === 0);

      // Graph row accessor on id: fail closed without invoking getter.
      // (Wire path JSON.parse only yields data props; mapMessageEnvelope is the
      // defense if a non-JSON transport ever returns object-shaped rows.)
      let rowHits = 0;
      const rowObj = sampleMessage();
      const rowData = { ...rowObj };
      delete rowData.id;
      Object.defineProperty(rowData, 'id', {
        enumerable: true,
        configurable: true,
        get() {
          rowHits += 1;
          return 'accessor-id';
        },
      });
      const mapped = mapMessageEnvelope(rowData);
      ok(
        'graph row accessor id → map fail closed',
        mapped.ok === false,
      );
      ok('graph row accessor getter not invoked', rowHits === 0);

      // ── Exact own-data: readTransportResponse ──
      ok(
        'readTransportResponse accepts exact status/headers/body',
        readTransportResponse({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).ok === true,
      );
      ok(
        'readTransportResponse accepts status-only',
        readTransportResponse({ status: 204 }).ok === true,
      );
      {
        const extraRes = readTransportResponse({
          status: 200,
          body: '{}',
          planted: 'password=LEAK',
          secret: 'client_secret=LEAK',
        });
        ok(
          'readTransportResponse rejects extra own string keys',
          extraRes.ok === false,
        );
        ok(
          'readTransportResponse extra keys no leak',
          !containsLeak(extraRes, ['password=LEAK', 'client_secret=LEAK', 'LEAK']),
        );
      }
      {
        const symRes = { status: 200, body: '{}' };
        Object.defineProperty(symRes, Symbol('evil'), {
          enumerable: true,
          value: 'password=LEAK',
        });
        const r = readTransportResponse(symRes);
        ok('readTransportResponse rejects symbol key', r.ok === false);
        ok(
          'readTransportResponse symbol no leak',
          !containsLeak(r, ['password=LEAK', 'LEAK']),
        );
      }
      {
        let hits = 0;
        const accRes = { status: 200 };
        Object.defineProperty(accRes, 'body', {
          enumerable: true,
          configurable: true,
          get() {
            hits += 1;
            return 'password=LEAK';
          },
        });
        const r = readTransportResponse(accRes);
        ok('readTransportResponse rejects body accessor', r.ok === false);
        ok('readTransportResponse body accessor not invoked', hits === 0);
        ok(
          'readTransportResponse accessor no leak',
          !containsLeak(r, ['password=LEAK', 'LEAK']),
        );
      }
      {
        let hits = 0;
        const accRes = {};
        Object.defineProperty(accRes, 'status', {
          enumerable: true,
          configurable: true,
          get() {
            hits += 1;
            return 200;
          },
        });
        const r = readTransportResponse(accRes);
        ok('readTransportResponse rejects status accessor', r.ok === false);
        ok('readTransportResponse status accessor not invoked', hits === 0);
      }
      // Transport response extras on live path → token_response_malformed
      {
        const transport = createFakeEmailHttpTransport({
          handler() {
            return {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token_type: 'Bearer',
                access_token: FAKE_ACCESS_TOKEN,
              }),
              planted: 'password=LEAK',
            };
          },
        });
        const created = createMicrosoftGraphMailboxAdapter({
          endpoint: baseEndpoint(),
          secretProvider: makeSecretProvider(baseCreds()),
          transport,
        });
        const r = await getAdapter(created).listMessageEnvelopes({ top: 1 });
        ok(
          'transport response extra key → token_response_malformed',
          r.ok === false && r.error === 'token_response_malformed',
        );
        ok(
          'transport response extra key no leak',
          !containsLeak(r, ['password=LEAK', 'LEAK', FAKE_ACCESS_TOKEN]),
        );
      }

      // ── Exact own-data: mapMessageEnvelope / mapMessagesResponse ──
      {
        const good = mapMessageEnvelope(sampleMessage());
        ok('mapMessageEnvelope exact selected keys ok', good.ok === true);
      }
      {
        const withBody = sampleMessage({ body: { content: 'password=LEAK' } });
        const r = mapMessageEnvelope(withBody);
        ok('mapMessageEnvelope rejects body extra', r.ok === false);
        ok('mapMessageEnvelope body extra no partial', r.value === undefined);
        ok(
          'mapMessageEnvelope body extra no leak',
          !containsLeak(r, ['password=LEAK', 'LEAK']),
        );
      }
      {
        const withUnique = sampleMessage({
          uniqueBody: { content: 'client_secret=LEAK' },
        });
        ok(
          'mapMessageEnvelope rejects uniqueBody extra',
          mapMessageEnvelope(withUnique).ok === false,
        );
      }
      {
        const withHdrs = sampleMessage({
          internetMessageHeaders: [{ name: 'X', value: 'LEAK' }],
        });
        ok(
          'mapMessageEnvelope rejects internetMessageHeaders extra',
          mapMessageEnvelope(withHdrs).ok === false,
        );
      }
      {
        const withOdata = sampleMessage({ '@odata.etag': 'W/"LEAK"' });
        ok(
          'mapMessageEnvelope rejects @odata.etag extra',
          mapMessageEnvelope(withOdata).ok === false,
        );
      }
      {
        const missingSubject = sampleMessage();
        delete missingSubject.subject;
        ok(
          'mapMessageEnvelope rejects missing required select key',
          mapMessageEnvelope(missingSubject).ok === false,
        );
      }
      {
        const symRow = sampleMessage();
        Object.defineProperty(symRow, Symbol('body'), {
          enumerable: true,
          value: 'password=LEAK',
        });
        const r = mapMessageEnvelope(symRow);
        ok('mapMessageEnvelope rejects symbol key', r.ok === false);
        ok(
          'mapMessageEnvelope symbol no leak',
          !containsLeak(r, ['password=LEAK', 'LEAK']),
        );
      }
      // Nested from exact emailAddress only
      {
        const fromExtra = sampleMessage();
        fromExtra.from = {
          emailAddress: { address: 'a@b.com', name: 'A' },
          extra: 'password=LEAK',
        };
        const r = mapMessageEnvelope(fromExtra);
        ok('mapMessageEnvelope rejects from extra key', r.ok === false);
        ok(
          'mapMessageEnvelope from extra no leak',
          !containsLeak(r, ['password=LEAK', 'LEAK']),
        );
      }
      {
        let hits = 0;
        const fromAcc = sampleMessage();
        const fromObj = {};
        Object.defineProperty(fromObj, 'emailAddress', {
          enumerable: true,
          configurable: true,
          get() {
            hits += 1;
            return { address: 'a@b.com', name: 'A' };
          },
        });
        fromAcc.from = fromObj;
        const r = mapMessageEnvelope(fromAcc);
        ok('mapMessageEnvelope rejects from accessor', r.ok === false);
        ok('mapMessageEnvelope from accessor not invoked', hits === 0);
      }
      // Nested emailAddress exact address,name
      {
        const eaExtra = sampleMessage();
        eaExtra.from = {
          emailAddress: {
            address: 'a@b.com',
            name: 'A',
            smtp: 'password=LEAK',
          },
        };
        const r = mapMessageEnvelope(eaExtra);
        ok('mapMessageEnvelope rejects emailAddress extra key', r.ok === false);
        ok(
          'mapMessageEnvelope emailAddress extra no leak',
          !containsLeak(r, ['password=LEAK', 'LEAK']),
        );
      }
      {
        const eaMissing = sampleMessage();
        eaMissing.from = { emailAddress: { address: 'a@b.com' } };
        ok(
          'mapMessageEnvelope rejects emailAddress missing name key',
          mapMessageEnvelope(eaMissing).ok === false,
        );
      }
      {
        let hits = 0;
        const eaAcc = sampleMessage();
        const ea = { name: 'A' };
        Object.defineProperty(ea, 'address', {
          enumerable: true,
          configurable: true,
          get() {
            hits += 1;
            return 'a@b.com';
          },
        });
        eaAcc.from = { emailAddress: ea };
        const r = mapMessageEnvelope(eaAcc);
        ok('mapMessageEnvelope rejects emailAddress accessor', r.ok === false);
        ok('mapMessageEnvelope emailAddress accessor not invoked', hits === 0);
      }
      // from null is ok (exact row keys still present)
      {
        const fromNull = sampleMessage({ from: null });
        ok(
          'mapMessageEnvelope accepts from null',
          mapMessageEnvelope(fromNull).ok === true,
        );
      }
      // mapMessagesResponse exact value key only
      {
        ok(
          'mapMessagesResponse accepts exact {value:[]}',
          mapMessagesResponse({ value: [] }).ok === true,
        );
        ok(
          'mapMessagesResponse rejects @odata.context extra',
          mapMessagesResponse({
            value: [sampleMessage()],
            '@odata.context': 'https://graph.microsoft.com/LEAK',
          }).ok === false,
        );
        ok(
          'mapMessagesResponse rejects nextLink extra',
          mapMessagesResponse({
            value: [sampleMessage()],
            '@odata.nextLink': 'https://x?skiptoken=LEAK',
          }).ok === false,
        );
        ok(
          'mapMessagesResponse rejects unknown extra',
          mapMessagesResponse({
            value: [sampleMessage()],
            secret: 'password=LEAK',
          }).ok === false,
        );
        {
          let hits = 0;
          const env = {};
          Object.defineProperty(env, 'value', {
            enumerable: true,
            configurable: true,
            get() {
              hits += 1;
              return [sampleMessage()];
            },
          });
          const r = mapMessagesResponse(env);
          ok('mapMessagesResponse rejects value accessor', r.ok === false);
          ok('mapMessagesResponse value accessor not invoked', hits === 0);
        }
        {
          const env = { value: [sampleMessage()] };
          Object.defineProperty(env, Symbol('next'), {
            enumerable: true,
            value: 'LEAK',
          });
          ok(
            'mapMessagesResponse rejects symbol key',
            mapMessagesResponse(env).ok === false,
          );
        }
      }
      // Token JSON may still carry expires_in (not over-restricted)
      {
        const tok = extractAccessToken({
          token_type: 'Bearer',
          access_token: FAKE_ACCESS_TOKEN,
          expires_in: 3600,
          ext_expires_in: 7200,
        });
        ok(
          'extractAccessToken allows expires_in/ext_expires_in extras',
          tok.ok === true && tok.accessToken === FAKE_ACCESS_TOKEN,
        );
      }
    }

    // 1A contract still validates capabilities the same way
    {
      const caps = contractMod.validateEmailMailboxCapabilities(EIGHT_CAPS);
      ok('1A capabilities still valid', caps.ok === true);
    }

    ok(
      'no real DNS/network hits during verifier',
      networkHits === 0,
      `hits=${networkHits}`,
    );
  } catch (err) {
    ok(
      'verifier body did not throw',
      false,
      String(err && err.stack ? err.stack : err),
    );
  } finally {
    restoreNetworkGuards();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('verifier crashed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
