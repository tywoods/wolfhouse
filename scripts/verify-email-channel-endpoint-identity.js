'use strict';
/**
 * verify:email-channel-endpoint-identity — Slice 2D structural + domain gate.
 * No network/MSAL/env/live Microsoft. Optional disposable PG prove when available.
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'database/migrations');
const UP = '058_tenant_channel_endpoint_identity.sql';
const DOWN = '058_tenant_channel_endpoint_identity_down.sql';
const UP_PATH = path.join(MIG_DIR, UP);
const DOWN_PATH = path.join(MIG_DIR, DOWN);
const MANIFEST_PATH = path.join(MIG_DIR, 'canonical-manifest.json');
const DOMAIN_PATH = path.join(ROOT, 'scripts/lib/email-channel-endpoint-identity-contract.js');
const REG_PATH = path.join(ROOT, 'scripts/lib/email-tenant-channel-registry.js');
const ROUTES_PATH = path.join(ROOT, 'scripts/lib/staff-email-registry-routes.js');
const C2C_PATH = path.join(ROOT, 'scripts/lib/email-microsoft-delegated-oauth-contract.js');
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const VERIFY_REL = 'scripts/verify-email-channel-endpoint-identity.js';
const PROVE_REL = 'scripts/prove-email-channel-endpoint-identity-pg.js';

const {
  CHECKSUM_MODE_CANONICAL_LF_V1, sha256CanonicalLfV1File, forwardEntries, loadManifest,
} = require('./lib/migration-integrity');
const {
  validateEmailChannelEndpointIdentityModePair,
  validateEmailChannelEndpointBindingIdentity,
  declareEmailChannelEndpointReconnectTransferPolicy,
  EMAIL_IDENTITY_PROVIDERS, EMAIL_BINDING_STATUSES, EMAIL_MAILBOX_KINDS,
  EMAIL_MAILBOX_ACCESS_KINDS, EMAIL_IDENTITY_OWNERSHIP_RULES,
  EMAIL_IDENTITY_SECRET_PACKAGE_SEMANTICS, FORBIDDEN_RAW_KEYS,
} = require('./lib/email-channel-endpoint-identity-contract');

const TID = '11111111-1111-1111-1111-111111111111';
const OID = '22222222-2222-2222-2222-222222222222';
const RES = 'AAMkAGI2TG93AAA=';
const LEAK = 'refresh_token=LEAKEDVALUE';
const pair = validateEmailChannelEndpointIdentityModePair;
const bind = validateEmailChannelEndpointBindingIdentity;
const policy = declareEmailChannelEndpointReconnectTransferPolicy;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function ser(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function hasLeak(hay) {
  const s = typeof hay === 'string' ? hay : ser(hay);
  return s.includes(LEAK) || /password=|client_secret=|ya29\.|eyJ[A-Za-z0-9_-]{10,}\./.test(s);
}

const origLookup = dns.lookup;
const origLookupService = dns.lookupService;
const origResolve4 = dns.resolve4;
const origConnect = net.Socket.prototype.connect;
const origHttp = http.request;
const origHttps = https.request;
let networkHits = 0;
function installNetworkGuards() {
  networkHits = 0;
  const bump = () => { networkHits += 1; throw new Error('NETWORK_FORBIDDEN_IN_SLICE_2D_VERIFIER'); };
  dns.lookup = dns.lookupService = dns.resolve4 = function blockedDns() { bump(); };
  net.Socket.prototype.connect = function blockedConnect() { bump(); };
  http.request = https.request = function blockedHttp() { bump(); };
}
function restoreNetworkGuards() {
  dns.lookup = origLookup; dns.lookupService = origLookupService;
  dns.resolve4 = origResolve4; net.Socket.prototype.connect = origConnect;
  http.request = origHttp; https.request = origHttps;
}

console.log('verify:email-channel-endpoint-identity — Slice 2D\n');
installNetworkGuards();

ok('up-exists', fs.existsSync(UP_PATH));
ok('down-exists', fs.existsSync(DOWN_PATH));
ok('domain-exists', fs.existsSync(DOMAIN_PATH));
ok('doc-exists', fs.existsSync(DOC_PATH));
const upSql = fs.readFileSync(UP_PATH, 'utf8');
const downSql = fs.readFileSync(DOWN_PATH, 'utf8');
const domainSrc = fs.readFileSync(DOMAIN_PATH, 'utf8');
const regSrc = fs.readFileSync(REG_PATH, 'utf8');
const routesSrc = fs.readFileSync(ROUTES_PATH, 'utf8');
const c2cSrc = fs.readFileSync(C2C_PATH, 'utf8');
const doc = fs.readFileSync(DOC_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

const upLines = upSql.split(/\r?\n/).length;
const downLines = downSql.split(/\r?\n/).length;
const domainLines = domainSrc.split(/\r?\n/).length;
const verifyLines = fs.readFileSync(path.join(ROOT, VERIFY_REL), 'utf8').split(/\r?\n/).length;
const proveExists = fs.existsSync(path.join(ROOT, PROVE_REL));
const proveLines = proveExists
  ? fs.readFileSync(path.join(ROOT, PROVE_REL), 'utf8').split(/\r?\n/).length : 0;
ok('budget-up-down-le-280', upLines + downLines <= 280, `up+down=${upLines + downLines}`);
ok('budget-domain-le-400', domainLines <= 400, `domain=${domainLines}`);
ok('budget-verify-prove-le-800', verifyLines + proveLines <= 800, `v+p=${verifyLines + proveLines}`);

ok('up-no-if-not-exists', !/\bIF\s+NOT\s+EXISTS\b/i.test(upSql));
ok('up-add-columns', [
  'auth_mode', 'connector_mode', 'provider_tenant_id', 'provider_principal_oid',
  'mailbox_kind', 'mailbox_access_kind', 'binding_status',
].every((c) => new RegExp(`ADD COLUMN ${c} TEXT`).test(upSql)));
ok('up-has-auth-connector-nulls', /tenant_channel_endpoints_auth_connector_nulls/.test(upSql));
ok('up-has-mode-pair', /tenant_channel_endpoints_identity_mode_pair/.test(upSql));
ok('up-has-binding-status-values', /tenant_channel_endpoints_binding_status_values/.test(upSql));
ok('up-has-uuid-shapes', /provider_tenant_id_shape/.test(upSql) && /provider_principal_oid_shape/.test(upSql));
ok('up-has-resource-id-shape', /tenant_channel_endpoints_provider_resource_id_shape/.test(upSql)
  && /provider_resource_id = btrim\(provider_resource_id\)/.test(upSql));
ok('up-has-verified-complete', /tenant_channel_endpoints_verified_ownership_complete/.test(upSql));
ok('up-has-mode-coherence', /tenant_channel_endpoints_mode_field_coherence/.test(upSql));
ok('up-unique-index-c-collation',
  /tenant_channel_endpoints_verified_mailbox_ownership_uidx/.test(upSql)
  && /COLLATE "C"/.test(upSql)
  && /binding_status IN \('verified', 'reauthorization_required'\)/.test(upSql));
ok('up-no-oauth-tx-columns', ![
  'oauth_state', 'pkce_verifier', 'pkce_challenge', 'authorization_code',
  'access_token', 'refresh_token', 'nonce', 'grant_generation', 'grant_status',
].some((c) => new RegExp(`ADD COLUMN\\s+${c}\\b`, 'i').test(upSql)));
ok('up-no-grant-rotation-cols', !/ADD COLUMN\s+grant_/i.test(upSql));
ok('down-drops-index-and-columns',
  /DROP INDEX IF EXISTS tenant_channel_endpoints_verified_mailbox_ownership_uidx/.test(downSql)
  && /DROP COLUMN IF EXISTS auth_mode/.test(downSql)
  && /DROP COLUMN IF EXISTS binding_status/.test(downSql)
  && /provider_resource_id_shape/.test(downSql));
ok('up-documents-23505', /23505/.test(upSql));
ok('up-no-backfill-dml', !/\b(INSERT|UPDATE|DELETE)\s+/i.test(
  upSql.replace(/COMMENT[\s\S]*?;/g, '').replace(/--[^\n]*/g, ''),
));

const manifest = loadManifest(MANIFEST_PATH);
const entries = manifest.entries || [];
const upEnt = entries.find((e) => e.filename === UP);
const downEnt = entries.find((e) => e.filename === DOWN);
const upHash = sha256CanonicalLfV1File(UP_PATH);
const downHash = sha256CanonicalLfV1File(DOWN_PATH);
ok('manifest-up-present', Boolean(upEnt));
ok('manifest-down-present', Boolean(downEnt));
ok('manifest-up-forward-order-56', Boolean(upEnt && upEnt.inForwardChain && upEnt.order === 56
  && upEnt.classification === 'canonical_forward'));
ok('manifest-down-rollback', Boolean(downEnt && downEnt.classification === 'rollback_down'
  && downEnt.inForwardChain === false));
ok('manifest-up-sha', Boolean(upEnt && upEnt.sha256 === upHash));
ok('manifest-down-sha', Boolean(downEnt && downEnt.sha256 === downHash));
ok('manifest-checksum-mode', manifest.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1);
ok('manifest-forward-count-61', forwardEntries(manifest).length === 61);

ok('package-gate', pkg.scripts
  && pkg.scripts['verify:email-channel-endpoint-identity']
  === 'node scripts/verify-email-channel-endpoint-identity.js');
ok('docs-slice-2d', /Slice 2D/i.test(doc) && /058_tenant_channel_endpoint_identity/.test(doc));
ok('docs-ownership-23505', /23505/.test(doc) && /reauthorization_required/.test(doc));
ok('docs-no-activation-claim', /schema_enforces_activation:\s*false|activation remains deferred|does not flip 2C/i.test(doc));
ok('docs-secret-package-semantics', /secret_ref_present/.test(doc)
  && /refresh_token/.test(doc) && /client_secret/.test(doc));
ok('docs-stock-pg-concurrent-remaining',
  /concurrency-safe by PostgreSQL semantics/i.test(doc)
  && /unexecuted/i.test(doc) && /remaining pre-deploy/i.test(doc));
ok('docs-resource-every-status', /provider_resource_id.*every.*status|every.*status.*provider_resource_id/i.test(doc));

ok('registry-insert-no-identity-cols',
  /INSERT INTO tenant_channel_endpoints \(/.test(regSrc)
  && !/INSERT INTO tenant_channel_endpoints \([\s\S]*auth_mode/.test(regSrc));
ok('registry-no-oauth-routes',
  !/oauth\/callback|pkce_verifier|authorization_code|grant_generation/i.test(regSrc));
ok('routes-no-oauth', !/oauth\/callback|pkce_verifier|authorization_code/i.test(routesSrc));
ok('2c-activation-flags-unflipped',
  /schema_enforces_invariants:\s*false/.test(c2cSrc)
  && /readiness_activation_complete:\s*false/.test(c2cSrc));

const mig057 = fs.readFileSync(
  path.join(MIG_DIR, '057_tenant_locations_and_channel_endpoints.sql'), 'utf8',
);
const providerCsv = EMAIL_IDENTITY_PROVIDERS.join(',');
ok('vocab-providers', providerCsv === 'microsoft_graph,gmail_api,imap_smtp');
ok('schema-domain-provider-vocab-equal',
  /CHECK\s*\(\s*provider\s+IN\s*\(\s*'microsoft_graph',\s*'gmail_api',\s*'imap_smtp'\s*\)\s*\)/.test(mig057)
  && providerCsv === 'microsoft_graph,gmail_api,imap_smtp');
ok('vocab-binding-statuses', EMAIL_BINDING_STATUSES.join(',')
  === 'unverified_offline,pending_manual_validation,verified,reauthorization_required,revoked');
ok('vocab-mailbox-kind-user-only', EMAIL_MAILBOX_KINDS.join(',') === 'user');
ok('vocab-access-kinds', EMAIL_MAILBOX_ACCESS_KINDS.join(',') === 'own_user,application');
ok('ownership-rules-index', EMAIL_IDENTITY_OWNERSHIP_RULES.unique_index
  === 'tenant_channel_endpoints_verified_mailbox_ownership_uidx');
ok('ownership-conflict-23505', EMAIL_IDENTITY_OWNERSHIP_RULES.conflict_sqlstate === '23505');
ok('ownership-no-activation-enforce', EMAIL_IDENTITY_OWNERSHIP_RULES.schema_enforces_activation === false);
ok('secret-semantics-dto', EMAIL_IDENTITY_SECRET_PACKAGE_SEMANTICS.dto_exposes === 'secret_ref_present');
ok('secret-semantics-no-sql-package', EMAIL_IDENTITY_SECRET_PACKAGE_SEMANTICS.sql_validates_package_contents === false);
ok('forbidden-raw-includes-tokens', FORBIDDEN_RAW_KEYS.includes('refresh_token')
  && FORBIDDEN_RAW_KEYS.includes('grant_generation'));

function baseDelegated(o) {
  return {
    provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth', provider_tenant_id: TID,
    provider_principal_oid: OID, provider_resource_id: RES, mailbox_kind: 'user',
    mailbox_access_kind: 'own_user', binding_status: 'verified', ...o,
  };
}
function baseAppOnly(o) {
  return {
    provider: 'microsoft_graph', auth_mode: 'application_client_credentials',
    connector_mode: 'microsoft_app_only_enterprise', provider_tenant_id: TID,
    provider_principal_oid: null, provider_resource_id: RES, mailbox_kind: 'user',
    mailbox_access_kind: 'application', binding_status: 'verified', ...o,
  };
}
function partial(status, res) {
  return {
    provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth', binding_status: status,
    provider_resource_id: res,
  };
}

ok('pair-legacy-graph-nulls', pair({ provider: 'microsoft_graph', auth_mode: null, connector_mode: null }).ok);
ok('pair-gmail-nulls', pair({ provider: 'gmail_api', auth_mode: null, connector_mode: null }).ok);
ok('pair-delegated-ok', pair({
  provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
  connector_mode: 'microsoft_delegated_oauth',
}).ok);
ok('pair-app-only-ok', pair({
  provider: 'microsoft_graph', auth_mode: 'application_client_credentials',
  connector_mode: 'microsoft_app_only_enterprise',
}).ok);
ok('pair-half-null-fail', !pair({
  provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code', connector_mode: null,
}).ok);
ok('pair-gmail-with-modes-fail', !pair({
  provider: 'gmail_api', auth_mode: 'delegated_authorization_code',
  connector_mode: 'microsoft_delegated_oauth',
}).ok);
ok('pair-cross-mix-fail', !pair({
  provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
  connector_mode: 'microsoft_app_only_enterprise',
}).ok);
ok('pair-unknown-provider-fail', !pair({
  provider: 'future_provider', auth_mode: null, connector_mode: null,
}).ok);
ok('pair-empty-provider-fail', !pair({ provider: '', auth_mode: null, connector_mode: null }).ok);

const delOk = bind(baseDelegated());
ok('binding-delegated-verified', delOk.ok === true
  && delOk.value.principal_is_mailbox_identity === false
  && delOk.value.secret_package_semantics.dto_exposes === 'secret_ref_present');
const appOk = bind(baseAppOnly());
ok('binding-app-only-verified', appOk.ok && appOk.value.provider_principal_oid === null);
ok('binding-reauth-delegated', bind(baseDelegated({ binding_status: 'reauthorization_required' })).ok);
ok('binding-unverified-partial', bind(partial('unverified_offline')).ok);
ok('binding-legacy-nulls', bind({ provider: 'microsoft_graph' }).ok);
ok('binding-imap-nulls', bind({ provider: 'imap_smtp' }).ok);

ok('hostile-half-pair', !bind({ provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code' }).ok);
ok('hostile-gmail-status', !bind({ provider: 'gmail_api', binding_status: 'unverified_offline' }).ok);
ok('hostile-uuid-upper', !bind(baseDelegated({ provider_tenant_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })).ok);
ok('hostile-uuid-untrimmed', !bind(baseDelegated({ provider_tenant_id: ` ${TID} ` })).ok);
ok('hostile-bad-status', !bind(baseDelegated({ binding_status: 'active' })).ok);
ok('hostile-verified-no-resource', !bind(baseDelegated({ provider_resource_id: null })).ok);
ok('hostile-verified-empty-resource', !bind(baseDelegated({ provider_resource_id: '   ' })).ok);
ok('hostile-resource-untrimmed-unverified', !bind(partial('unverified_offline', ' x ')).ok);
ok('hostile-resource-empty-pending', !bind(partial('pending_manual_validation', '')).ok);
ok('hostile-resource-empty-revoked', !bind(baseDelegated({ binding_status: 'revoked', provider_resource_id: '' })).ok);
ok('hostile-unknown-provider', !bind({ provider: 'future_provider' }).ok);
ok('hostile-symbol-key', (() => {
  const o = baseDelegated();
  o[Symbol('hostile')] = 'x';
  return !bind(o).ok;
})());
ok('hostile-delegated-no-principal', !bind(baseDelegated({ provider_principal_oid: null })).ok);
ok('hostile-delegated-app-access', !bind(baseDelegated({ mailbox_access_kind: 'application' })).ok);
ok('hostile-app-only-with-principal', !bind(baseAppOnly({ provider_principal_oid: OID })).ok);
ok('hostile-app-only-own-user', !bind(baseAppOnly({ mailbox_access_kind: 'own_user' })).ok);
ok('hostile-shared-kind', !bind(baseDelegated({ mailbox_kind: 'shared' })).ok);
ok('hostile-orphan-tenant', !bind({ provider: 'microsoft_graph', provider_tenant_id: TID }).ok);
ok('hostile-raw-token-key', !bind(baseDelegated({ refresh_token: LEAK })).ok);
ok('hostile-accessor', (() => {
  const o = baseDelegated();
  Object.defineProperty(o, 'provider', { get() { return 'microsoft_graph'; }, enumerable: true });
  return !bind(o).ok;
})());
ok('hostile-prototype-pollution', !bind(Object.assign(Object.create({ provider: 'microsoft_graph' }), {
  auth_mode: 'delegated_authorization_code', connector_mode: 'microsoft_delegated_oauth',
})).ok);
ok('hostile-array-root', !bind([]).ok);
ok('hostile-coercion-number-status', !bind(baseDelegated({ binding_status: 1 })).ok);
ok('principal-not-mailbox', delOk.ok && delOk.value.principal_is_mailbox_identity === false);

const pol = policy({});
ok('reconnect-policy-ok', pol.ok
  && pol.value.conflict_sqlstate === '23505'
  && pol.value.reauthorization_reserves_ownership === true
  && pol.value.aliases_not_independent_identities === true
  && pol.value.schema_enforces_activation === false);
ok('reconnect-reject-alias-claim', !policy({ claim_aliases_are_independent: true }).ok);
ok('reconnect-reject-activation-claim', !policy({ claim_schema_enforces_activation: true }).ok);
ok('reconnect-reject-silent-steal', !policy({ claim_cross_client_silent_steal: true }).ok);

const leakCases = [
  bind(baseDelegated({ refresh_token: LEAK })),
  bind(baseDelegated({ binding_status: 'verified', provider_resource_id: null, client_secret: LEAK })),
  pair({ provider: 'microsoft_graph', auth_mode: LEAK, connector_mode: LEAK }),
];
ok('no-secret-leak-envelopes', leakCases.every((r) => r.ok === false && !hasLeak(r)));
ok('domain-src-no-network-sdk',
  !/require\(['"](?:https?|axios|node-fetch|@azure|msal)/.test(domainSrc)
  && !/process\.env/.test(domainSrc) && !/pg\.|createPool|fetch\(/.test(domainSrc));
ok('dto-frozen', delOk.ok && Object.isFrozen(delOk) && Object.isFrozen(delOk.value));
ok('no-network-hits', networkHits === 0, `hits=${networkHits}`);
restoreNetworkGuards();

if (proveExists) {
  const proveSrc = fs.readFileSync(path.join(ROOT, PROVE_REL), 'utf8');
  ok('prove-script-present', true);
  ok('prove-sequential-ownership-not-race',
    /sequential-ownership-23505/.test(proveSrc) && !/Unique race|concurrency race/i.test(proveSrc));
  ok('prove-notes-stock-pg-concurrent-remaining',
    /stock-PG concurrent|Remaining pre-deploy proof/i.test(proveSrc));
} else {
  ok('prove-script-optional-absent-noted', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
