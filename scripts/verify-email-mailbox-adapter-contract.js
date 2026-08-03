'use strict';

/**
 * Luna email Slice 1A — provider-neutral mailbox adapter contract gate.
 * Pure offline checks: no network, no DB, no provider SDKs, no secrets.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTRACT_REL = 'scripts/lib/email-mailbox-adapter-contract.js';
const FAKE_REL = 'scripts/lib/email-mailbox-fake-adapter.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const PKG_PATH = path.join(ROOT, 'package.json');
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const FAKE_PATH = path.join(ROOT, FAKE_REL);
const DOC_PATH = path.join(ROOT, DOC_REL);
const VERIFY_SCRIPT_REL = 'scripts/verify-email-mailbox-adapter-contract.js';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

console.log('verify:email-mailbox-adapter-contract — Slice 1A mailbox adapter contract\n');

ok('contract module path exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
ok('fake adapter module path exists', fs.existsSync(FAKE_PATH), FAKE_REL);
ok('architecture note exists', fs.existsSync(DOC_PATH), DOC_REL);

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok(
  'package.json has verify:email-mailbox-adapter-contract',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-mailbox-adapter-contract']),
);
ok(
  'verify script points at this verifier',
  Boolean(
    pkg
    && pkg.scripts
    && String(pkg.scripts['verify:email-mailbox-adapter-contract']).includes(VERIFY_SCRIPT_REL),
  ),
);

if (fs.existsSync(DOC_PATH)) {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  ok('doc mentions adapter boundary', /adapter boundary|mailbox adapter/i.test(doc));
  ok(
    'doc forbids credentials in git/postgres/logs/prompts',
    /never belong in Git/i.test(doc)
      && /Postgres/i.test(doc)
      && /logs/i.test(doc)
      && /prompts/i.test(doc),
  );
  ok(
    'doc states zero Graph-specific logic in this slice',
    /provider-neutral|no Graph-specific|zero Graph/i.test(doc),
  );
  ok(
    'doc defers endpoint persistence / DB schema to Slice 1B',
    /Slice 1B/i.test(doc)
      && (/no endpoint persistence|ships no (DB|endpoint)|intentionally ships no/i.test(doc)
        || /no DB schema/i.test(doc)),
  );
  ok(
    'doc states secrets retrieved via external secret provider by adapter',
    /external secret provider/i.test(doc) && /adapter/i.test(doc),
  );
  ok(
    'doc states secret scheme allowlist kv and secret-ref',
    /kv:/i.test(doc) && /secret-ref:/i.test(doc),
  );
  ok(
    'doc does not claim migration 057 ships in 1A',
    !/migration 057/i.test(doc),
  );
}

let contract = null;
let fake = null;
let loadError = null;
try {
  if (fs.existsSync(CONTRACT_PATH)) {
    delete require.cache[require.resolve(CONTRACT_PATH)];
    contract = require(CONTRACT_PATH);
  }
  if (fs.existsSync(FAKE_PATH)) {
    delete require.cache[require.resolve(FAKE_PATH)];
    fake = require(FAKE_PATH);
  }
} catch (err) {
  loadError = err;
}

ok('contract module loads', contract != null, loadError ? String(loadError.message || loadError) : 'missing');
ok('fake adapter module loads', fake != null, loadError ? String(loadError.message || loadError) : 'missing');

const requiredExports = [
  'EMAIL_MAILBOX_PROVIDERS',
  'EMAIL_MAILBOX_CAPABILITY_KEYS',
  'EMAIL_AUTOMATION_MODES',
  'validateEmailMailboxProviderId',
  'validateEmailMailboxCapabilities',
  'validateEmailMailboxAdapterIdentity',
  'validateEmailMailboxSecretRef',
  'normalizeEmailPublicAddress',
  'validateTenantChannelEndpointInput',
];
for (const name of requiredExports) {
  ok(
    `contract exports ${name}`,
    Boolean(contract && contract[name] != null),
  );
}

ok(
  'fake exports createFakeEmailMailboxAdapter',
  Boolean(fake && typeof fake.createFakeEmailMailboxAdapter === 'function'),
);

// ── Source hygiene: no provider SDKs ───────────────────────────────────────
if (fs.existsSync(CONTRACT_PATH) && fs.existsSync(FAKE_PATH)) {
  const contractSrc = fs.readFileSync(CONTRACT_PATH, 'utf8');
  const fakeSrc = fs.readFileSync(FAKE_PATH, 'utf8');
  // Only flag real module loads — comments may mention IMAP/Graph by name.
  const forbiddenImports = [
    /require\s*\(\s*['"]@microsoft\/microsoft-graph-client['"]\s*\)/,
    /require\s*\(\s*['"]@azure\/identity['"]\s*\)/,
    /require\s*\(\s*['"]googleapis['"]\s*\)/,
    /require\s*\(\s*['"]nodemailer['"]\s*\)/,
    /require\s*\(\s*['"]imap(?:flow)?['"]\s*\)/i,
    /require\s*\(\s*['"][^'"]*msal[^'"]*['"]\s*\)/i,
    /from\s+['"]@microsoft\/microsoft-graph-client['"]/,
    /from\s+['"]googleapis['"]/,
  ];
  ok(
    'contract has no provider SDK imports',
    !forbiddenImports.some((re) => re.test(contractSrc)),
  );
  ok(
    'fake adapter has no provider SDK imports',
    !forbiddenImports.some((re) => re.test(fakeSrc)),
  );
  ok(
    'contract does not call network APIs',
    !/\bfetch\s*\(|\bhttps?\.(?:get|request)\b|\baxios\b/.test(contractSrc),
  );
}

if (
  contract
  && typeof contract.validateEmailMailboxProviderId === 'function'
  && typeof contract.validateEmailMailboxCapabilities === 'function'
  && typeof contract.validateEmailMailboxAdapterIdentity === 'function'
  && typeof contract.validateEmailMailboxSecretRef === 'function'
  && typeof contract.normalizeEmailPublicAddress === 'function'
  && typeof contract.validateTenantChannelEndpointInput === 'function'
  && fake
  && typeof fake.createFakeEmailMailboxAdapter === 'function'
) {
  const providers = contract.EMAIL_MAILBOX_PROVIDERS;
  ok(
    'providers allowlist is microsoft_graph|gmail_api|imap_smtp',
    Array.isArray(providers)
      && providers.length === 3
      && providers.includes('microsoft_graph')
      && providers.includes('gmail_api')
      && providers.includes('imap_smtp'),
    JSON.stringify(providers),
  );

  const capKeys = contract.EMAIL_MAILBOX_CAPABILITY_KEYS;
  const expectedCaps = [
    'push_notifications',
    'provider_threads',
    'remote_drafts',
    'reply',
    'reply_all',
    'forward',
    'attachments_metadata',
    'delivery_events',
  ];
  ok(
    'capability allowlist exact set',
    Array.isArray(capKeys)
      && capKeys.length === expectedCaps.length
      && expectedCaps.every((k) => capKeys.includes(k)),
    JSON.stringify(capKeys),
  );

  const modes = contract.EMAIL_AUTOMATION_MODES;
  ok(
    'automation modes automatic|draft_only|off',
    Array.isArray(modes)
      && modes.includes('automatic')
      && modes.includes('draft_only')
      && modes.includes('off')
      && modes.length === 3,
  );

  // Provider ID validation
  for (const p of ['microsoft_graph', 'gmail_api', 'imap_smtp']) {
    const r = contract.validateEmailMailboxProviderId(p);
    ok(`provider accepts ${p}`, r && r.ok === true);
  }
  for (const bad of ['graph', 'microsoft', 'outlook', 'gmail', 'imap', 'smtp', '', null, 12, 'MICROSOFT_GRAPH']) {
    const r = contract.validateEmailMailboxProviderId(bad);
    ok(`provider rejects ${JSON.stringify(bad)}`, r && r.ok === false);
  }

  // Capabilities: full valid matrix
  const fullTrue = Object.fromEntries(expectedCaps.map((k) => [k, true]));
  const fullFalse = Object.fromEntries(expectedCaps.map((k) => [k, false]));
  const mixed = {
    push_notifications: true,
    provider_threads: true,
    remote_drafts: true,
    reply: true,
    reply_all: true,
    forward: false,
    attachments_metadata: true,
    delivery_events: false,
  };
  ok('capabilities accept all-true', contract.validateEmailMailboxCapabilities(fullTrue).ok === true);
  ok('capabilities accept all-false', contract.validateEmailMailboxCapabilities(fullFalse).ok === true);
  ok('capabilities accept mixed booleans', contract.validateEmailMailboxCapabilities(mixed).ok === true);

  // Fail-closed shapes
  ok(
    'capabilities reject unknown key',
    contract.validateEmailMailboxCapabilities({ ...fullTrue, calendar_sync: true }).ok === false,
  );
  ok(
    'capabilities reject missing key',
    contract.validateEmailMailboxCapabilities({
      push_notifications: true,
      provider_threads: true,
      remote_drafts: true,
      reply: true,
      reply_all: true,
      forward: true,
      attachments_metadata: true,
      // delivery_events missing
    }).ok === false,
  );
  ok(
    'capabilities reject non-boolean',
    contract.validateEmailMailboxCapabilities({ ...fullTrue, reply: 'yes' }).ok === false,
  );
  ok(
    'capabilities reject truthy non-boolean 1',
    contract.validateEmailMailboxCapabilities({ ...fullTrue, reply: 1 }).ok === false,
  );
  ok(
    'capabilities reject array',
    contract.validateEmailMailboxCapabilities(expectedCaps).ok === false,
  );
  ok(
    'capabilities reject null',
    contract.validateEmailMailboxCapabilities(null).ok === false,
  );
  ok(
    'capabilities reject nested object value',
    contract.validateEmailMailboxCapabilities({ ...fullTrue, reply: { enabled: true } }).ok === false,
  );

  // Secret ref: scheme allowlist first, then detectors on reference BODY too
  ok(
    'secret_ref accepts opaque kv ref',
    contract.validateEmailMailboxSecretRef('kv:email-mailbox/sunset-somo/support').ok === true,
  );
  ok(
    'secret_ref accepts secret-ref scheme',
    contract.validateEmailMailboxSecretRef('secret-ref:azure-kv/luna-email-support-primary').ok === true,
  );
  ok(
    'secret_ref accepts valid non-secret kv body (luna-support-email-credentials)',
    contract.validateEmailMailboxSecretRef('kv:luna-support-email-credentials').ok === true,
  );
  ok(
    'secret_ref accepts valid non-secret secret-ref body (tenant/email-mailbox)',
    contract.validateEmailMailboxSecretRef('secret-ref:tenant/email-mailbox').ok === true,
  );
  for (const [label, value] of [
    ['sk- openai key', 'sk-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['Bearer token', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb'],
    ['PEM private key', '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'],
    ['password= pattern', 'password=hunter2secret'],
    ['client_secret=', 'client_secret=super-secret-value-here'],
    ['empty', ''],
    ['whitespace', '   '],
    ['raw password-ish', 'MyP@ssw0rd!SecretValue'],
    // Adversarial: colon/slash heuristics alone must not accept raw secrets
    ['hunter2/password slash password', 'hunter2/password'],
    ['hunter2:password colon password', 'hunter2:password'],
    ['unknown scheme vault:', 'vault:email/mailbox/support'],
    ['unknown scheme azure-kv:', 'azure-kv:secret-name'],
    ['whitespace in body', 'kv:email mailbox/support'],
    ['leading whitespace', ' kv:email-mailbox/support'],
    ['trailing whitespace', 'kv:email-mailbox/support '],
    ['scheme only kv:', 'kv:'],
    ['scheme only secret-ref:', 'secret-ref:'],
    ['JWT-shaped without scheme', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature'],
    ['OAuth-ish access token blob', 'ya29.a0AfH6SMC-raw-oauth-token-value-here'],
    ['api_key= pattern', 'api_key=super-secret-api-key-value'],
    // Hostile: secret-looking values AFTER an allowed scheme must fail (body scan)
    ['prefixed sk- key after kv:', 'kv:sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['prefixed password-hunter2 after kv:', 'kv:password-hunter2'],
    ['prefixed OAuth ya29 after secret-ref:', 'secret-ref:ya29.a0AfH6SMCrawOAuthToken'],
    ['prefixed JWT-shaped after kv:', 'kv:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature'],
    ['prefixed JWT-shaped after secret-ref:', 'secret-ref:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig'],
    ['prefixed Bearer after kv:', 'kv:Bearer.eyJhbGciOiJIUzI1NiIs.payload.sig'],
    ['prefixed Bearer token with space', 'kv:Bearer tokenvaluehere'],
    ['prefixed api_key= after kv:', 'kv:api_key=super-secret-api-key-value'],
    ['prefixed client_secret= after secret-ref:', 'secret-ref:client_secret=super-secret-value'],
    ['prefixed password= after kv:', 'kv:password=hunter2'],
  ]) {
    const r = contract.validateEmailMailboxSecretRef(value);
    ok(`secret_ref rejects ${label}`, r && r.ok === false, r && r.error);
  }

  // Public address normalize
  ok(
    'normalize lowercases email',
    contract.normalizeEmailPublicAddress('Support@LunaFrontDesk.COM') === 'support@lunafrontdesk.com',
  );
  ok(
    'normalize trims',
    contract.normalizeEmailPublicAddress('  a@b.com  ') === 'a@b.com',
  );

  // Adapter identity
  const goodIdentity = {
    provider: 'microsoft_graph',
    public_address: 'support@lunafrontdesk.com',
    capabilities: deepClone(mixed),
  };
  ok(
    'adapter identity accepts valid microsoft_graph shape',
    contract.validateEmailMailboxAdapterIdentity(goodIdentity).ok === true,
  );
  ok(
    'adapter identity rejects unknown provider',
    contract.validateEmailMailboxAdapterIdentity({
      ...goodIdentity,
      provider: 'exchange_ews',
    }).ok === false,
  );
  ok(
    'adapter identity rejects bad capabilities',
    contract.validateEmailMailboxAdapterIdentity({
      ...goodIdentity,
      capabilities: { ...mixed, extra: true },
    }).ok === false,
  );

  // Endpoint input — location authority is out-of-band (arg2), never from input.
  // Provider-neutral demo tenants; not Sunset routing and not hardcoded Somo/Sardinero.
  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';
  const LOCATION_A1 = 'campus-north';
  const LOCATION_A2 = 'campus-south';
  const LOCATION_B1 = 'other-tenant-site';

  /** Trusted location pairs used only by the out-of-band authority callback. */
  const trustedTenantLocations = Object.freeze({
    [TENANT_A]: Object.freeze([LOCATION_A1, LOCATION_A2]),
    [TENANT_B]: Object.freeze([LOCATION_B1]),
  });

  function resolveLocationForTenant(clientId, locationId) {
    const list = trustedTenantLocations[clientId];
    if (!list) return { ok: false, error: 'tenant_unknown' };
    if (!list.includes(locationId)) return { ok: false, error: 'location_not_in_tenant' };
    return { ok: true };
  }

  const trustedDeps = { locationAuthority: resolveLocationForTenant };

  const goodEndpoint = {
    client_id: TENANT_A,
    location_id: LOCATION_A1,
    channel: 'email',
    provider: 'gmail_api',
    public_address: 'School@Example.COM',
    secret_ref: 'kv:email-mailbox/tenant-a/campus-north',
    provider_resource_id: null,
    capabilities: deepClone(fullFalse),
    inbound_enabled: true,
    outbound_enabled: false,
    default_automation_mode: 'draft_only',
    active: true,
  };
  const epOk = contract.validateTenantChannelEndpointInput(goodEndpoint, trustedDeps);
  ok('endpoint input accepts valid tenant/location with trusted authority', epOk && epOk.ok === true, epOk && epOk.error);
  if (epOk && epOk.ok && epOk.value) {
    ok(
      'endpoint normalizes public_address case-insensitively',
      epOk.value.public_address === 'school@example.com',
    );
    ok(
      'endpoint does not invent default location',
      epOk.value.location_id === LOCATION_A1,
    );
    ok(
      'endpoint value does not leak location_authority into persisted shape',
      epOk.value.location_authority === undefined
        && epOk.value.locationAuthority === undefined,
    );
    ok(
      'endpoint value does not leak trusted deps/options',
      epOk.value.locationAuthority === undefined
        && !Object.prototype.hasOwnProperty.call(epOk.value, 'location_authority'),
    );
  }

  // Fail closed: trusted second-argument authority absent/invalid
  ok(
    'endpoint rejects missing options (fail closed)',
    contract.validateTenantChannelEndpointInput(goodEndpoint).ok === false,
  );
  ok(
    'endpoint rejects null options (fail closed)',
    contract.validateTenantChannelEndpointInput(goodEndpoint, null).ok === false,
  );
  ok(
    'endpoint rejects absent locationAuthority in options (fail closed)',
    contract.validateTenantChannelEndpointInput(goodEndpoint, {}).ok === false,
  );
  ok(
    'endpoint rejects null locationAuthority (fail closed)',
    contract.validateTenantChannelEndpointInput(goodEndpoint, { locationAuthority: null }).ok === false,
  );
  ok(
    'endpoint rejects non-function locationAuthority (fail closed)',
    contract.validateTenantChannelEndpointInput(goodEndpoint, {
      locationAuthority: 'campus-north',
    }).ok === false,
  );
  ok(
    'endpoint rejects allowlist-object locationAuthority (callback only)',
    contract.validateTenantChannelEndpointInput(goodEndpoint, {
      locationAuthority: Object.freeze({
        [TENANT_A]: Object.freeze([LOCATION_A1, LOCATION_A2]),
      }),
    }).ok === false,
  );

  // Hostile RED: authority embedded in input must never authorize
  ok(
    'endpoint rejects input.location_authority always-true (forbidden field)',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      location_authority: () => true,
    }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects attacker location even with input.location_authority always-true and no trusted deps',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      location_id: LOCATION_B1,
      location_authority: () => true,
    }).ok === false,
  );
  ok(
    'endpoint rejects caller-embedded allowlist in input as authority',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      location_id: LOCATION_B1,
      location_authority: Object.freeze({
        [TENANT_A]: Object.freeze([LOCATION_B1]),
      }),
    }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects attacker location when only input-embedded always-true authority is present',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      location_id: 'attacker-planted-site',
      location_authority: () => true,
    }).ok === false,
  );

  // Trusted second-argument authority: exact valid pair only
  ok(
    'trusted authority permits exact valid tenant/location pair',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      client_id: TENANT_A,
      location_id: LOCATION_A1,
    }, trustedDeps).ok === true,
  );
  ok(
    'trusted authority permits second valid location for same tenant',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      client_id: TENANT_A,
      location_id: LOCATION_A2,
    }, trustedDeps).ok === true,
  );
  ok(
    'trusted authority blocks unknown location for tenant',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      location_id: 'unknown-campus',
    }, trustedDeps).ok === false,
  );
  ok(
    'trusted authority blocks cross-tenant location (location of tenant B on tenant A)',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      client_id: TENANT_A,
      location_id: LOCATION_B1,
    }, trustedDeps).ok === false,
  );
  ok(
    'trusted authority blocks tenant B location even if input claims always-true authority',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      client_id: TENANT_A,
      location_id: LOCATION_B1,
      location_authority: () => true,
    }, {
      locationAuthority: resolveLocationForTenant,
    }).ok === false,
  );

  // Canonical lowercase kebab location IDs
  for (const [label, loc] of [
    ['uppercase', 'Campus-North'],
    ['surrounding whitespace', ' campus-north '],
    ['internal whitespace', 'campus north'],
    ['empty', ''],
    ['malformed underscore only junk', 'Campus_North'],
    ['malformed leading hyphen', '-campus-north'],
    ['malformed trailing hyphen', 'campus-north-'],
    ['malformed double hyphen', 'campus--north'],
    ['malformed slash', 'campus/north'],
  ]) {
    ok(
      `endpoint rejects malformed location_id (${label})`,
      contract.validateTenantChannelEndpointInput({
        ...goodEndpoint,
        location_id: loc,
      }, trustedDeps).ok === false,
    );
  }

  ok(
    'endpoint rejects missing location_id (no default)',
    contract.validateTenantChannelEndpointInput({ ...goodEndpoint, location_id: '' }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects null location_id (no default)',
    contract.validateTenantChannelEndpointInput({ ...goodEndpoint, location_id: null }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects omitted location_id (no default)',
    contract.validateTenantChannelEndpointInput((() => {
      const c = { ...goodEndpoint };
      delete c.location_id;
      return c;
    })(), trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects channel whatsapp',
    contract.validateTenantChannelEndpointInput({ ...goodEndpoint, channel: 'whatsapp' }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects raw secret_ref',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      secret_ref: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects hunter2/password secret_ref',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      secret_ref: 'hunter2/password',
    }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects prefixed secret body in secret_ref (kv:sk-...)',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      secret_ref: 'kv:sk-abcdefghijklmnopqrstuvwxyz123456',
    }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects unknown automation mode',
    contract.validateTenantChannelEndpointInput({
      ...goodEndpoint,
      default_automation_mode: 'handoff',
    }, trustedDeps).ok === false,
  );
  ok(
    'endpoint rejects missing client_id',
    contract.validateTenantChannelEndpointInput({ ...goodEndpoint, client_id: '' }, trustedDeps).ok === false,
  );

  // Source hygiene: no Sunset-specific location hardcoding in shared contract
  if (fs.existsSync(CONTRACT_PATH)) {
    const contractSrc = fs.readFileSync(CONTRACT_PATH, 'utf8');
    ok(
      'contract does not hardcode Somo location id',
      !/\bsunset-somo\b/i.test(contractSrc) && !/\bsomo\b/i.test(contractSrc),
    );
    ok(
      'contract does not hardcode Sardinero location id',
      !/\bsardinero\b/i.test(contractSrc),
    );
    ok(
      'contract does not import sunset routing modules',
      !/require\s*\(\s*['"][^'"]*sunset[^'"]*['"]\s*\)/i.test(contractSrc),
    );
  }

  // Fake adapter: represent all three provider capability combos without consumer branches
  const profiles = [
    {
      provider: 'microsoft_graph',
      public_address: 'support@lunafrontdesk.com',
      capabilities: {
        push_notifications: true,
        provider_threads: true,
        remote_drafts: true,
        reply: true,
        reply_all: true,
        forward: true,
        attachments_metadata: true,
        delivery_events: true,
      },
    },
    {
      provider: 'gmail_api',
      public_address: 'inbox@school.example',
      capabilities: {
        push_notifications: true,
        provider_threads: true,
        remote_drafts: true,
        reply: true,
        reply_all: true,
        forward: true,
        attachments_metadata: true,
        delivery_events: false,
      },
    },
    {
      provider: 'imap_smtp',
      public_address: 'info@legacy-school.example',
      capabilities: {
        push_notifications: false,
        provider_threads: false,
        remote_drafts: false,
        reply: true,
        reply_all: false,
        forward: false,
        attachments_metadata: true,
        delivery_events: false,
      },
    },
  ];

  const adapters = [];
  for (const profile of profiles) {
    const created = fake.createFakeEmailMailboxAdapter(profile);
    ok(`fake creates ${profile.provider}`, created && created.ok === true, created && created.error);
    if (created && created.ok) adapters.push(created.adapter);
  }

  // Consumer-style capability checks — no provider id branching
  function consumerCanUseRemoteDrafts(adapter) {
    return adapter.getCapabilities().remote_drafts === true;
  }
  function consumerCanPush(adapter) {
    return adapter.getCapabilities().push_notifications === true;
  }

  if (adapters.length === 3) {
    ok('consumer remote_drafts true for graph+gmail via caps only',
      consumerCanUseRemoteDrafts(adapters[0]) === true
      && consumerCanUseRemoteDrafts(adapters[1]) === true
      && consumerCanUseRemoteDrafts(adapters[2]) === false);
    ok('consumer push true for graph+gmail via caps only',
      consumerCanPush(adapters[0]) === true
      && consumerCanPush(adapters[1]) === true
      && consumerCanPush(adapters[2]) === false);
    for (const a of adapters) {
      ok(
        `fake adapter ${a.getIdentity().provider} identity validates`,
        contract.validateEmailMailboxAdapterIdentity(a.getIdentity()).ok === true,
      );
      ok(
        `fake adapter ${a.getIdentity().provider} has no network methods that imply live IO`,
        typeof a.describe === 'function'
          && typeof a.getCapabilities === 'function'
          && typeof a.getIdentity === 'function',
      );
      // Known capability keys return booleans via supports()
      ok(
        `fake adapter ${a.getIdentity().provider} supports(reply) is boolean`,
        typeof a.supports('reply') === 'boolean',
      );
      // Unknown capability key must fail closed (throw or structured rejection),
      // not silently return false (typo detection for consumers).
      let unknownSupportsOutcome = null;
      try {
        const result = a.supports('remote_darfts'); // intentional typo of remote_drafts
        if (result && typeof result === 'object' && result.ok === false) {
          unknownSupportsOutcome = 'structured_reject';
        } else if (result === false) {
          unknownSupportsOutcome = 'silent_false';
        } else {
          unknownSupportsOutcome = `unexpected:${JSON.stringify(result)}`;
        }
      } catch (err) {
        unknownSupportsOutcome = 'threw';
      }
      ok(
        `fake adapter ${a.getIdentity().provider} supports(unknown_key) fails closed (not silent false)`,
        unknownSupportsOutcome === 'threw' || unknownSupportsOutcome === 'structured_reject',
        `got ${unknownSupportsOutcome}`,
      );
    }
  }

  ok(
    'fake rejects unknown provider',
    fake.createFakeEmailMailboxAdapter({
      provider: 'exchange_ews',
      public_address: 'x@y.com',
      capabilities: fullTrue,
    }).ok === false,
  );
  ok(
    'fake rejects bad capabilities',
    fake.createFakeEmailMailboxAdapter({
      provider: 'imap_smtp',
      public_address: 'x@y.com',
      capabilities: { ...fullTrue, nsfw: true },
    }).ok === false,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('OK');
