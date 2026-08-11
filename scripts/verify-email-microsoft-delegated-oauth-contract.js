'use strict';
/** verify:email-microsoft-delegated-oauth-contract — Slice 2C offline gate. Table-driven; no network/MSAL/env. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const ROOT = path.join(__dirname, '..');
const CONNECTOR_PATH = path.join(ROOT, 'scripts/lib/email-connector-auth-mode-contract.js');
const CONTRACT_PATH = path.join(ROOT, 'scripts/lib/email-microsoft-delegated-oauth-contract.js');
const VERIFY_REL = 'scripts/verify-email-microsoft-delegated-oauth-contract.js';
const CONTRACT_1A_PATH = path.join(ROOT, 'scripts/lib/email-mailbox-adapter-contract.js');
const ADAPTER_2A_PATH = path.join(ROOT, 'scripts/lib/email-microsoft-graph-adapter.js');
const READINESS_2B_PATH = path.join(ROOT, 'scripts/lib/email-graph-app-only-readiness-contract.js');
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const VALID_SECRET_REF = 'kv:luna-ms-delegated-grant-refresh';
const LEAK_PASSWORD = 'password=LEAK';
const LEAK_REFRESH = 'refresh_token=LEAKEDVALUE';
const LEAK_CLIENT_SECRET = 'client_secret=LEAK';
const TID = '11111111-1111-1111-1111-111111111111';
const OID = '22222222-2222-2222-2222-222222222222';
const LUNA_CLIENT = '33333333-3333-3333-3333-333333333333';
const LUNA_APP_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_CLIENT = '55555555-5555-5555-5555-555555555555';
const ENTROPY_32 = 'abcdefghijklmnopqrstuvwxyz012345';
// RFC 7636 verifier (43 unreserved) + derived S256 challenge (real SHA-256 base64url).
const PKCE_VERIFIER = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const PKCE_CHALLENGE = crypto.createHash('sha256').update(PKCE_VERIFIER, 'ascii').digest('base64url');
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function ser(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function hasLeak(hay, needles) {
  const s = typeof hay === 'string' ? hay : ser(hay);
  return needles.some((n) => n && s && s.includes(n));
}
function baseClientAuth(o) {
  return {
    client_type: 'confidential_web', pkce_method: 'S256',
    token_endpoint_client_authentication: 'private_key_jwt',
    browser_holds_app_credential: false, tenant_supplies_app_credential: false, ...o,
  };
}
function baseScopePlan(o) {
  return {
    phase: 'A', oidc: ['openid', 'profile', 'offline_access'],
    graph_delegated: ['User.Read', 'Mail.ReadBasic'], include_email_scope: false, ...o,
  };
}
function baseDeclaration(o) {
  return {
    provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth', client_auth_model: baseClientAuth(),
    account_audience: 'organizations',
    redirect_uri_id: 'luna_ms_delegated_oauth_callback',
    scope_plan: baseScopePlan(), mailbox_access: { kind: 'own_user' },
    grant_secret_package: { secret_ref: VALID_SECRET_REF },
    network_enabled: false, registry_activation_enabled: false,
    inbound_enabled: false, outbound_enabled: false, default_automation_mode: 'off', ...o,
  };
}
function baseTransaction(o) {
  const issued = 1_700_000_000;
  return {
    state: ENTROPY_32, nonce: ENTROPY_32, pkce_verifier: PKCE_VERIFIER,
    pkce_challenge: PKCE_CHALLENGE, pkce_method: 'S256',
    redirect_uri_id: 'luna_ms_delegated_oauth_callback',
    luna_client_id: LUNA_CLIENT, location_id: 'wolfhouse-main',
    staff_session_id: 'staffsess01', connector_mode: 'microsoft_delegated_oauth',
    auth_mode: 'delegated_authorization_code', scope_version: 'phase_a_v2',
    issued_at: issued, expires_at: issued + 600, now_at: issued + 10,
    prior_consumed: false, consume: true,
    expected_luna_client_id: LUNA_CLIENT, expected_location_id: 'wolfhouse-main',
    expected_staff_session_id: 'staffsess01', ...o,
  };
}
function omitTx(key) {
  const t = baseTransaction();
  delete t[key];
  return t;
}
function basePrincipal(o) {
  return {
    tid: TID, oid: OID, sub: 'correlate-sub-value', aud: LUNA_APP_ID,
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    exp: 1_700_000_600, nbf: 1_700_000_000, nonce: ENTROPY_32, expected_nonce: ENTROPY_32,
    signature_valid: true, keys_validated: true, luna_app_id: LUNA_APP_ID,
    claim_email_as_principal: false, claim_principal_is_mailbox: false, ...o,
  };
}
function baseAuthority(o) {
  return {
    account_audience: 'organizations',
    authority_host: 'login.microsoftonline.com', token_host: 'login.microsoftonline.com',
    graph_host: 'graph.microsoft.com',
    redirect_uri_id: 'luna_ms_delegated_oauth_callback', ...o,
  };
}
const originalLookup = dns.lookup, originalLookupService = dns.lookupService, originalResolve4 = dns.resolve4;
const originalConnect = net.Socket.prototype.connect, originalHttpRequest = http.request, originalHttpsRequest = https.request;
let networkHits = 0;
function installNetworkGuards() {
  networkHits = 0;
  const bump = () => { networkHits += 1; throw new Error('NETWORK_FORBIDDEN_IN_SLICE_2C_VERIFIER'); };
  dns.lookup = dns.lookupService = dns.resolve4 = function blockedDns() { bump(); };
  net.Socket.prototype.connect = function blockedConnect() { bump(); };
  http.request = https.request = function blockedHttp() { bump(); };
}
function restoreNetworkGuards() {
  dns.lookup = originalLookup; dns.lookupService = originalLookupService;
  dns.resolve4 = originalResolve4; net.Socket.prototype.connect = originalConnect;
  http.request = originalHttpRequest; https.request = originalHttpsRequest;
}
function assertNoSdkNetworkEnv(src, label) {
  const bad = [
    /require\s*\(\s*['"]@microsoft\/microsoft-graph-client['"]\s*\)/,
    /require\s*\(\s*['"]@azure\/identity['"]\s*\)/,
    /require\s*\(\s*['"]@azure\/msal[^'"]*['"]\s*\)/,
    /require\s*\(\s*['"][^'"]*msal[^'"]*['"]\s*\)/i,
    /require\s*\(\s*['"]@azure\/keyvault[^'"]*['"]\s*\)/i,
    /require\s*\(\s*['"]googleapis['"]\s*\)/, /require\s*\(\s*['"]axios['"]\s*\)/,
    /require\s*\(\s*['"]node-fetch['"]\s*\)/, /require\s*\(\s*['"]pg['"]\s*\)/,
    /require\s*\(\s*['"]child_process['"]\s*\)/,
    /\bfetch\s*\(/, /\bhttps?\.(?:get|request)\s*\(/, /\bnet\.connect\s*\(/, /\bdns\.lookup\s*\(/,
  ];
  ok(`${label}: no SDK/network/env/spawn`,
    !bad.some((re) => re.test(src)) && !/process\.env\b/.test(src)
    && !/\b(?:spawn|exec|execFile|fork)\s*\(/.test(src));
}
function runTable(cases) {
  for (const c of cases) {
    if (typeof c[1] === 'function') {
      let cond = false; let detail;
      try { cond = c[1](); } catch (e) { detail = String(e && e.message || e); }
      ok(c[0], Boolean(cond), detail || c[2]);
    } else ok(c[0], Boolean(c[1]), c[2]);
  }
}
function main() {
  console.log('verify:email-microsoft-delegated-oauth-contract — Slice 2C delegated OAuth\n');
  installNetworkGuards();
  try {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')); } catch { pkg = null; }
    runTable([
      ['paths: connector+contract+1A/2A/2B+doc',
        [CONNECTOR_PATH, CONTRACT_PATH, CONTRACT_1A_PATH, ADAPTER_2A_PATH, READINESS_2B_PATH, DOC_PATH]
          .every((x) => fs.existsSync(x))],
      ['package scripts: 2C + preserved 1A/2A/2B',
        Boolean(pkg && pkg.scripts
          && String(pkg.scripts['verify:email-microsoft-delegated-oauth-contract'] || '').includes(VERIFY_REL)
          && pkg.scripts['verify:email-mailbox-adapter-contract']
          && pkg.scripts['verify:email-microsoft-graph-adapter']
          && pkg.scripts['verify:email-graph-app-only-readiness'])],
    ]);
    if (fs.existsSync(DOC_PATH)) {
      const doc = fs.readFileSync(DOC_PATH, 'utf8');
      ok('doc: 2C SaaS/PKCE/orgs/scopes/principal/non-goals; 1A/2A/2B; no GoDaddy',
        [/Slice 2C/i, /delegated_authorization_code|microsoft_delegated_oauth/i, /PKCE|S256/i,
          /confidential/i, /organizations|organizational/i, /Mail\.ReadBasic/i,
          /User\.Read/i, /client_secret_post/i, /private_key_jwt/i, /phase_a_v2|Phase A/i,
          /\/me\.id|me\.id/i, /provider_resource_id/i,
          /ms_delegated_principal/i, /not mailbox|NOT mailbox|unverified offline|not verified offline/i,
          /1A/i, /2A/i, /2B/i, /application_client_credentials|app-only/i,
          /Not in Slice 2C|non-goal/i, /never belong in Git/i].every((re) => re.test(doc))
        && !/GoDaddy supported|supports GoDaddy/i.test(doc)
        && !/client_secret_basic.*interim|interim.*client_secret_basic/i.test(doc));
    }
    if (fs.existsSync(CONNECTOR_PATH)) assertNoSdkNetworkEnv(fs.readFileSync(CONNECTOR_PATH, 'utf8'), 'connector');
    if (fs.existsSync(CONTRACT_PATH)) {
      const csrc = fs.readFileSync(CONTRACT_PATH, 'utf8');
      assertNoSdkNetworkEnv(csrc, 'delegated contract');
      ok('contract isolation: no 2A/2B import; uses 1A secret_ref + connector',
        !/require\s*\(\s*['"]\.\/email-microsoft-graph-adapter['"]\s*\)/.test(csrc)
        && !/require\s*\(\s*['"]\.\/email-graph-app-only-readiness-contract['"]\s*\)/.test(csrc)
        && /validateEmailMailboxSecretRef/.test(csrc) && /email-mailbox-adapter-contract/.test(csrc)
        && /email-connector-auth-mode-contract/.test(csrc));
    }
    let connector = null; let mod = null; let contract1a = null; let mod2b = null;
    let loadError = null;
    try {
      for (const p of [CONNECTOR_PATH, CONTRACT_PATH, CONTRACT_1A_PATH, READINESS_2B_PATH]) {
        if (fs.existsSync(p)) {
          try { delete require.cache[require.resolve(p)]; } catch { /* ignore */ }
        }
      }
      connector = require(CONNECTOR_PATH);
      mod = require(CONTRACT_PATH);
      contract1a = require(CONTRACT_1A_PATH);
      mod2b = require(READINESS_2B_PATH);
    } catch (err) { loadError = err; }
    runTable([
      ['modules load (connector + delegated + 1A + 2B)',
        connector != null && mod != null && contract1a != null && mod2b != null,
        loadError && String(loadError.message || loadError)],
      ['operator surface: readiness/tx/principal/binding/refresh/activation/scope/auth/authority',
        Boolean(mod && [
          'evaluateMicrosoftDelegatedOauthReadiness',
          'isMicrosoftDelegatedOauthReadinessComplete',
          'validateMicrosoftDelegatedOauthTransaction',
          'validateMicrosoftDelegatedPrincipal',
          'validateMicrosoftDelegatedMailboxBindingHint',
          'validateMicrosoftDelegatedOwnUserLiveBinding',
          'validateMicrosoftDelegatedRefreshRotationPolicy',
          'evaluateMicrosoftDelegatedRefreshExchangeGate',
          'validateMicrosoftDelegatedActivationInvariants',
          'validateMicrosoftDelegatedScopePlan',
          'validateMicrosoftDelegatedClientAuthModel',
          'validateMicrosoftDelegatedAuthority',
          'buildMicrosoftDelegatedPrincipalKey',
        ].every((n) => typeof mod[n] === 'function'))],
      ['connector surface present',
        Boolean(connector
          && typeof connector.validateEmailConnectorAuthModePair === 'function'
          && typeof connector.resolveEmailConnectorMode === 'function'
          && typeof connector.isDefaultSaasEmailConnectorAuthMode === 'function'
          && typeof connector.getEmailConnectorMaterialKeyNames === 'function')],
    ]);
    if (!mod || typeof mod.evaluateMicrosoftDelegatedOauthReadiness !== 'function') {
      console.log(`\n── verify:email-microsoft-delegated-oauth-contract ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
      process.exit(fail > 0 ? 1 : 0);
      return;
    }
    const evaluate = mod.evaluateMicrosoftDelegatedOauthReadiness;
    const isComplete = mod.isMicrosoftDelegatedOauthReadinessComplete;
    runTable([
      ['profile: provider/auth/connector/orgs/S256',
        mod.EMAIL_MS_DELEGATED_PROVIDER === 'microsoft_graph'
        && mod.EMAIL_MS_DELEGATED_AUTH_MODE === 'delegated_authorization_code'
        && mod.EMAIL_MS_DELEGATED_CONNECTOR_MODE === 'microsoft_delegated_oauth'
        && mod.EMAIL_MS_DELEGATED_ACCOUNT_AUDIENCE === 'organizations'
        && mod.EMAIL_MS_DELEGATED_PKCE_METHOD === 'S256'
        && mod.EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_REQUIRED === true],
      ['profile: Phase A OIDC+Graph v2; token auth; /me bind; custody; principal', (() => {
        const g = mod.EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES;
        const m = mod.EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_METHODS;
        const b = mod.EMAIL_MS_DELEGATED_OWN_USER_LIVE_BINDING;
        const c = mod.EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY;
        const post = mod.EMAIL_MS_DELEGATED_CLIENT_SECRET_POST_DECLARATION;
        return Array.isArray(mod.EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES)
          && ['openid', 'profile', 'offline_access'].every((s) =>
            mod.EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES.includes(s))
          && !mod.EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES.includes('email')
          && mod.EMAIL_MS_DELEGATED_SCOPE_VERSION === 'phase_a_v2'
          && Array.isArray(g) && g.length === 2 && g.includes('User.Read') && g.includes('Mail.ReadBasic')
          && !g.includes('Mail.Read') && mod.EMAIL_MS_DELEGATED_ME_REQUIRED_DELEGATED_PERMISSION === 'User.Read'
          && mod.EMAIL_MS_DELEGATED_PHASE_B_GRAPH_DELEGATED_SCOPES.includes('Mail.ReadWrite')
          && mod.EMAIL_MS_DELEGATED_PHASE_B_GRAPH_DELEGATED_SCOPES.includes('Mail.Send')
          && Array.isArray(m) && m.length === 2 && m.includes('private_key_jwt') && m.includes('client_secret_post')
          && !m.includes('client_secret_basic')
          && mod.EMAIL_MS_DELEGATED_PREFERRED_TOKEN_ENDPOINT_CLIENT_AUTH === 'private_key_jwt'
          && post.client_id_token_form_field && post.client_secret_token_form_field
          && post.authorization_basic_header === false
          && b && b.live_graph_path === '/me' && b.require_me_id_equals_provider_principal_oid
          && b.persist_me_id_as_provider_resource_id && b.performs_graph === false
          && b.mail_upn_email_not_ownership_keys
          && c && c.refresh_exchange_adapter_allowed === true
          && c.durable_grant_custodian_injected === false
          && c.custody_deferred === false
          && c.cas_deferred === false
          && c.durable_grant_custodian_module_present === true
          && c.envelope_ciphertext_in_postgres_owner_approved === true
          && c.raw_refresh_token_in_postgres_forbidden === true
          && mod.EMAIL_MS_DELEGATED_PRINCIPAL_KEY_PREFIX === 'ms_delegated_principal:'
          && mod.EMAIL_MS_DELEGATED_PRINCIPAL_VALIDATION_RULES.principal_is_mailbox_identity === false
          && mod.EMAIL_MS_DELEGATED_PRINCIPAL_VALIDATION_RULES.email_claim_is_identity === false
          && mod.EMAIL_MS_DELEGATED_ACTIVATION_INVARIANTS.schema_enforces_invariants === false
          && mod.EMAIL_MS_DELEGATED_ACTIVATION_INVARIANTS.readiness_activation_complete === false;
      })()],
      ['default SaaS constants match connector',
        connector.EMAIL_DEFAULT_SAAS_CONNECTOR_MODE === 'microsoft_delegated_oauth'
        && connector.EMAIL_DEFAULT_SAAS_AUTH_MODE === 'delegated_authorization_code'],
    ]);
    // Connector matrix
    {
      const saas = connector.validateEmailConnectorAuthModePair({
        provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
      });
      const ent = connector.validateEmailConnectorAuthModePair({
        provider: 'microsoft_graph', auth_mode: 'application_client_credentials',
      });
      const delKeys = connector.getEmailConnectorMaterialKeyNames('microsoft_delegated_oauth');
      const appKeys = connector.getEmailConnectorMaterialKeyNames('microsoft_app_only_enterprise');
      ok('connector: SaaS default vs enterprise separate',
        saas.ok && saas.value.default_saas && saas.value.connector_mode === 'microsoft_delegated_oauth'
        && connector.isDefaultSaasEmailConnectorAuthMode({
          provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
        })
        && ent.ok && !ent.value.default_saas && ent.value.connector_mode === 'microsoft_app_only_enterprise'
        && !connector.isDefaultSaasEmailConnectorAuthMode({
          provider: 'microsoft_graph', auth_mode: 'application_client_credentials',
        }));
      ok('connector: resolve + material key separation',
        connector.resolveEmailConnectorMode({ connector_mode: 'microsoft_delegated_oauth' }).ok
        && delKeys.ok && delKeys.value[0] === 'refresh_token' && delKeys.value.length === 1
        && appKeys.ok && appKeys.value.includes('client_secret') && !appKeys.value.includes('refresh_token'));
      for (const mix of [
        ['gmail_api', 'application_client_credentials'], ['imap_smtp', 'delegated_authorization_code'],
        ['imap_smtp', 'application_client_credentials'], ['microsoft_graph', 'password_or_app_password'],
      ]) {
        ok(`connector: reject ${mix[0]}+${mix[1]}`,
          !connector.validateEmailConnectorAuthModePair({ provider: mix[0], auth_mode: mix[1] }).ok);
      }
    }
    // Complete-valid readiness
    {
      const input = baseDeclaration();
      const result = evaluate(input);
      ok('complete-valid: ok', result.ok === true, ser(result));
      if (result.ok) {
        const v = result.value; const s = ser(result);
        runTable([
          ['complete-valid: ready + SaaS + flags false + not verified + frozen DTO',
            v.ready_for_human_authorized_live_prerequisite_check === true
            && v.provider === 'microsoft_graph'
            && v.auth_mode === 'delegated_authorization_code' && v.default_saas === true
            && v.network_enabled === false && v.registry_activation_enabled === false
            && v.inbound_enabled === false && v.outbound_enabled === false
            && v.default_automation_mode === 'off'
            && v.azure_facts_independently_verified === false
            && v.entra_facts_independently_verified === false
            && v.mailbox_facts_independently_verified === false
            && v.mailbox_binding_verified_offline === false
            && v.principal_is_mailbox_identity === false
            && v.grant_secret_package.secret_ref_present === true
            && !Object.prototype.hasOwnProperty.call(v.grant_secret_package, 'secret_ref')
            && v.client_auth_model.pkce_alone_sufficient === false
            && v.client_auth_model.token_endpoint_client_authentication_required === true
            && v.client_auth_model.preferred_token_endpoint_client_authentication === 'private_key_jwt'
            && v.scope_plan.phase_b_included_in_phase_a === false
            && v.scope_plan.scope_version === 'phase_a_v2'
            && v.scope_plan.graph_delegated.includes('User.Read')
            && v.scope_plan.graph_delegated.includes('Mail.ReadBasic')
            && v.scope_plan.me_required_delegated_permission === 'User.Read'
            && v.scope_plan.canonical_address_fields_role === 'display_routing_evidence_only'
            && v.own_user_live_binding
            && v.own_user_live_binding.require_me_id_equals_provider_principal_oid === true
            && v.own_user_live_binding.persist_me_id_as_provider_resource_id === true
            && v.own_user_live_binding.performs_graph === false
            && v.refresh_rotation_policy.refresh_token_custody
            && v.refresh_rotation_policy.refresh_token_custody.refresh_exchange_adapter_allowed === true
            && v.activation_invariants.schema_enforces_invariants === false
            && Object.isFrozen(result) && Object.isFrozen(v)
            && isComplete(input) === true
            && !/"secret_ref"\s*:/.test(s) && !s.includes(VALID_SECRET_REF)
            && /"secret_ref_present"\s*:\s*true/.test(s)
            && !hasLeak(s, [LEAK_REFRESH, LEAK_CLIENT_SECRET, LEAK_PASSWORD, 'pkce_verifier'])],
        ]);
        input.provider = 'gmail_api'; input.network_enabled = true;
        ok('complete-valid: input mutation does not affect DTO',
          v.provider === 'microsoft_graph' && v.network_enabled === false);
      }
    }
    {
      const result = evaluate(baseDeclaration({ scope_plan: baseScopePlan({ include_email_scope: true }) }));
      ok('email-scope optional non-authoritative',
        result.ok && result.value.scope_plan.email_scope_authoritative === false
        && result.value.scope_plan.include_email_scope === true
        && result.value.scope_plan.optional_oidc_display_only.includes('email'), ser(result));
    }
    // Token endpoint client auth vocabulary (2C.1)
    {
      const jwt = mod.validateMicrosoftDelegatedClientAuthModel(baseClientAuth());
      const post = mod.validateMicrosoftDelegatedClientAuthModel(
        baseClientAuth({ token_endpoint_client_authentication: 'client_secret_post' }),
      );
      const basic = mod.validateMicrosoftDelegatedClientAuthModel(
        baseClientAuth({ token_endpoint_client_authentication: 'client_secret_basic' }),
      );
      const csp = post.ok && post.value.client_secret_post;
      ok('client auth: jwt preferred; post form fields; basic rejected; readiness accepts post',
        jwt.ok && jwt.value.token_endpoint_client_authentication === 'private_key_jwt'
        && jwt.value.preferred_token_endpoint_client_authentication === 'private_key_jwt'
        && jwt.value.allowed_token_endpoint_client_authentication.includes('client_secret_post')
        && !jwt.value.allowed_token_endpoint_client_authentication.includes('client_secret_basic')
        && post.ok && csp && csp.client_id_token_form_field && csp.client_secret_token_form_field
        && csp.authorization_basic_header === false
        && basic.ok === false && basic.details && basic.details.reason === 'client_secret_basic_forbidden'
        && evaluate(baseDeclaration({
          client_auth_model: baseClientAuth({ token_endpoint_client_authentication: 'client_secret_post' }),
        })).ok === true, ser({ jwt, post, basic }));
    }
    // Readiness rejection table
    for (const [name, input, err] of [
      ['pkce_only', baseDeclaration({ client_auth_model: baseClientAuth({ token_endpoint_client_authentication: 'pkce_only' }) }), 'client_auth_model_invalid'],
      ['pkce none', baseDeclaration({ client_auth_model: baseClientAuth({ token_endpoint_client_authentication: 'none' }) }), 'client_auth_model_invalid'],
      ['pkce false', baseDeclaration({ client_auth_model: baseClientAuth({ token_endpoint_client_authentication: false }) }), 'client_auth_model_invalid'],
      ['client_secret_basic', baseDeclaration({ client_auth_model: baseClientAuth({ token_endpoint_client_authentication: 'client_secret_basic' }) }), 'client_auth_model_invalid'],
      ['pkce plain', baseDeclaration({ client_auth_model: baseClientAuth({ pkce_method: 'plain' }) }), null],
      ['browser credential', baseDeclaration({ client_auth_model: baseClientAuth({ browser_holds_app_credential: true }) }), null],
      ['tenant credential', baseDeclaration({ client_auth_model: baseClientAuth({ tenant_supplies_app_credential: true }) }), null],
      ['audience consumers', baseDeclaration({ account_audience: 'consumers' }), null],
      ['audience common', baseDeclaration({ account_audience: 'common' }), null],
      ['audience personal', baseDeclaration({ account_audience: 'personal' }), null],
      ['redirect inject', baseDeclaration({ redirect_uri_id: 'https://evil.example/callback' }), null],
      ['shared mailbox', baseDeclaration({ mailbox_access: { kind: 'shared' } }), null],
      ['app-only auth', baseDeclaration({ auth_mode: 'application_client_credentials' }), null],
      ['app-only connector', baseDeclaration({ connector_mode: 'microsoft_app_only_enterprise' }), null],
      ['network true', baseDeclaration({ network_enabled: true }), 'network_or_activation_invalid'],
      ['activation true', baseDeclaration({ registry_activation_enabled: true }), 'network_or_activation_invalid'],
      ['inbound true', baseDeclaration({ inbound_enabled: true }), 'network_or_activation_invalid'],
      ['outbound true', baseDeclaration({ outbound_enabled: true }), 'network_or_activation_invalid'],
      ['automation auto', baseDeclaration({ default_automation_mode: 'automatic' }), null],
      ['raw refresh', baseDeclaration({ grant_secret_package: { refresh_token: 'raw-refresh-token-value' } }), null],
      ['raw access', baseDeclaration({ grant_secret_package: { access_token: 'raw-access' } }), null],
      ['raw id', baseDeclaration({ grant_secret_package: { id_token: 'raw-id' } }), null],
      ['raw secret', baseDeclaration({ grant_secret_package: { client_secret: 'raw-secret' } }), null],
      ['raw+ref', baseDeclaration({ grant_secret_package: { secret_ref: VALID_SECRET_REF, refresh_token: 'x' } }), null],
      ['password ref', baseDeclaration({ grant_secret_package: { secret_ref: LEAK_PASSWORD } }), null],
      ['unknown key', baseDeclaration({ evil_key: 'x' }), null],
      ['array root', ['not', 'an', 'object'], null],
    ]) {
      const r = evaluate(input);
      ok(`reject: ${name}`, r.ok === false && (err == null || r.error === err), ser(r));
    }
    // Authority
    ok('authority: allowlisted ok',
      mod.validateMicrosoftDelegatedAuthority(baseAuthority()).ok === true);
    for (const inj of [
      { authority_url: 'https://evil.example/oauth' }, { token_endpoint: 'https://evil.example/token' },
      { graph_url: 'https://evil.example/graph' }, { issuer: 'https://evil.example/' },
      { tenant_id: TID }, { tenant: 'contoso.onmicrosoft.com' },
      { authorize_url: 'https://login.microsoftonline.com/evil' },
    ]) {
      ok(`authority inject reject: ${Object.keys(inj)[0]}`,
        !mod.validateMicrosoftDelegatedAuthority(baseAuthority(inj)).ok);
    }
    ok('authority: consumers + bad host rejected',
      !mod.validateMicrosoftDelegatedAuthority(baseAuthority({ account_audience: 'consumers' })).ok
      && !mod.validateMicrosoftDelegatedAuthority(baseAuthority({ authority_host: 'evil.example' })).ok);
    // Scopes (phase_a_v2 exact set: User.Read + Mail.ReadBasic)
    {
      const sp = mod.validateMicrosoftDelegatedScopePlan(baseScopePlan());
      ok('scope plan phase A v2 ok',
        sp.ok && sp.value.scope_version === 'phase_a_v2'
        && sp.value.graph_delegated.length === 2
        && sp.value.graph_delegated.includes('User.Read')
        && sp.value.graph_delegated.includes('Mail.ReadBasic')
        && sp.value.me_required_delegated_permission === 'User.Read'
        && sp.value.canonical_address_fields_role === 'display_routing_evidence_only', ser(sp));
    }
    for (const graph of [
      ['Mail.ReadWrite'], ['Mail.Send'], ['Mail.Read'], ['Mail.Read.Shared'],
      ['Mail.ReadWrite.Shared'], ['Mail.Send.Shared'],
      ['https://graph.microsoft.com/.default'], ['/.default'],
      ['Application Mail.ReadBasic'], ['Mail.ReadBasic', 'Mail.Send'],
      ['Mail.ReadBasic'], // incomplete vs phase_a_v2 exact set
      ['User.Read'], // incomplete without Mail.ReadBasic
      ['User.Read', 'Mail.Read'], // broader Mail.Read forbidden
      ['User.Read', 'Mail.ReadBasic', 'Mail.Send'],
    ]) {
      ok(`scope forbid: ${graph.join('+')}`,
        mod.validateMicrosoftDelegatedScopePlan(baseScopePlan({ graph_delegated: graph })).ok === false);
    }
    ok('scope: missing profile + phase B as A rejected',
      mod.validateMicrosoftDelegatedScopePlan(baseScopePlan({
        oidc: ['openid', 'offline_access'],
      })).ok === false
      && mod.validateMicrosoftDelegatedScopePlan(baseScopePlan({
        graph_delegated: ['Mail.ReadWrite', 'Mail.Send'],
      })).ok === false);
    ok('scope: phase_a_v1 scope_version rejected on tx',
      mod.validateMicrosoftDelegatedOauthTransaction(
        baseTransaction({ scope_version: 'phase_a_v1' }),
      ).ok === false);
    // Principal
    {
      const good = mod.validateMicrosoftDelegatedPrincipal(basePrincipal());
      ok('principal: valid key + not mailbox',
        good.ok && good.value.principal_key === `ms_delegated_principal:${TID}:${OID}`
        && good.value.principal_is_mailbox_identity === false
        && good.value.email_claim_is_identity === false, ser(good));
      for (const [name, input, reason] of [
        ['email-as-id', basePrincipal({ claim_email_as_principal: true, email: 'user@contoso.com' }), 'email_as_identity_forbidden'],
        ['mailbox=principal', basePrincipal({ claim_principal_is_mailbox: true }), 'principal_is_not_mailbox_identity'],
        ['issuer inject', basePrincipal({ iss: `https://evil.example/${TID}` }), null],
        ['nonce mismatch', basePrincipal({ nonce: 'wrong-nonce-value-not-matching-xx' }), null],
      ]) {
        const r = mod.validateMicrosoftDelegatedPrincipal(input);
        ok(`principal reject: ${name}`, r.ok === false && (reason == null || (r.details && r.details.reason === reason)), ser(r));
      }
      const key = mod.buildMicrosoftDelegatedPrincipalKey(TID, OID);
      ok('build principal key', key.ok && key.value === `ms_delegated_principal:${TID}:${OID}`);
    }
    // Mailbox binding + own-user /me live bind freeze (2C.1; no Graph)
    {
      const hint = mod.validateMicrosoftDelegatedMailboxBindingHint({ requested_address: 'front@contoso.com' });
      const reseller = mod.validateMicrosoftDelegatedMailboxBindingHint({ reseller_or_shared_restriction: true });
      ok('binding: unverified offline + rejects + reseller manual',
        hint.ok && hint.value.binding_status === 'unverified_offline'
        && hint.value.requested_address_is_hint_only && !hint.value.godaddy_support_claimed
        && hint.value.future_live_proof_required_fields.includes('durable_microsoft_mailbox_resource_id')
        && hint.value.own_user_live_binding
        && hint.value.own_user_live_binding.live_graph_path === '/me'
        && hint.value.own_user_live_binding.require_me_id_equals_provider_principal_oid === true
        && hint.value.own_user_live_binding.persist_me_id_as_provider_resource_id === true
        && hint.value.own_user_live_binding.equality_expected_concepts_remain_separate === true
        && hint.value.own_user_live_binding.performs_graph === false
        && !mod.validateMicrosoftDelegatedMailboxBindingHint({ claim_binding_verified_offline: true }).ok
        && !mod.validateMicrosoftDelegatedMailboxBindingHint({ claim_godaddy_supported: true }).ok
        && !mod.validateMicrosoftDelegatedMailboxBindingHint({ claimed_shared: true }).ok
        && !mod.validateMicrosoftDelegatedMailboxBindingHint({ claim_principal_equals_mailbox: true }).ok
        && reseller.ok && reseller.value.manual_validation_state === 'pending_manual_validation', ser(hint));
      const live = mod.validateMicrosoftDelegatedOwnUserLiveBinding({});
      ok('own-user live bind freeze: /me.id==oid → provider_resource_id; no offline derive',
        live.ok && live.value.required_delegated_permission === 'User.Read'
        && live.value.require_me_id_equals_provider_principal_oid === true
        && live.value.persist_me_id_as_provider_resource_id === true
        && live.value.mail_upn_email_not_ownership_keys === true
        && live.value.canonical_address_fields_role === 'display_routing_evidence_only'
        && live.value.performs_graph === false
        && !mod.validateMicrosoftDelegatedOwnUserLiveBinding({ claim_binding_verified_offline: true }).ok
        && !mod.validateMicrosoftDelegatedOwnUserLiveBinding({ claim_derived_mailbox_offline: true }).ok
        && !mod.validateMicrosoftDelegatedOwnUserLiveBinding({ claim_performed_graph: true }).ok
        && !mod.validateMicrosoftDelegatedOwnUserLiveBinding({ claim_mail_claim_is_ownership_key: true }).ok, ser(live));
    }
    // OAuth transaction: callback consume (prior_consumed:false + consume:true) + ownership + PKCE S256
    {
      const good = mod.validateMicrosoftDelegatedOauthTransaction(baseTransaction());
      ok('oauth tx: valid consumed + ownership + S256 + secret-free DTO', (() => {
        if (!good.ok) return false;
        const v = good.value; const s = ser(v);
        return v.status === 'consumed' && v.status !== 'active'
          && v.ownership_bound === true && v.pkce_s256_verified === true
          && v.staff_session_present && v.atomic_consume_required && v.replay_rejected
          && v.runtime_atomic_compare_and_consume === true
          && !Object.prototype.hasOwnProperty.call(v, 'state')
          && !Object.prototype.hasOwnProperty.call(v, 'nonce')
          && !Object.prototype.hasOwnProperty.call(v, 'pkce_verifier')
          && !Object.prototype.hasOwnProperty.call(v, 'pkce_challenge')
          && !Object.prototype.hasOwnProperty.call(v, 'expected_luna_client_id')
          && !Object.prototype.hasOwnProperty.call(v, 'expected_staff_session_id')
          && !/"state"\s*:/.test(s) && !/"pkce_verifier"\s*:/.test(s)
          && !/"pkce_challenge"\s*:/.test(s);
      })(), ser(good));
      // Omission of ownership / consume intent / prior state must fail closed.
      for (const key of [
        'expected_luna_client_id', 'expected_location_id', 'expected_staff_session_id',
        'consume', 'prior_consumed',
      ]) {
        const r = mod.validateMicrosoftDelegatedOauthTransaction(omitTx(key));
        ok(`oauth tx omit: ${key}`,
          r.ok === false && r.details && r.details.reason === 'missing_key', ser(r));
      }
      const padded = crypto.createHash('sha256').update(PKCE_VERIFIER, 'ascii').digest('base64');
      for (const [name, input, reason] of [
        ['prior true replay', baseTransaction({ prior_consumed: true }), 'replay'],
        ['prior non-boolean', baseTransaction({ prior_consumed: 'false' }), 'prior_consumed_not_boolean_false'],
        ['consume false', baseTransaction({ consume: false }), 'consume_not_true'],
        ['client mix-up', baseTransaction({ expected_luna_client_id: OTHER_CLIENT }), 'client_mix_up'],
        ['location mix-up', baseTransaction({ expected_location_id: 'other-location' }), 'location_mix_up'],
        ['session mix-up', baseTransaction({ expected_staff_session_id: 'other-session' }), 'session_mix_up'],
        ['expired', baseTransaction({ now_at: 1_700_000_000 + 601 }), 'expired_or_not_yet_valid'],
        ['ttl bound', baseTransaction({ expires_at: 1_700_000_000 + 10_000 }), 'ttl_exceeds_bound'],
        ['pkce mismatch', baseTransaction({ pkce_challenge: 'A'.repeat(43) }), 'pkce_s256_mismatch'],
        ['pkce padded', baseTransaction({ pkce_challenge: padded }), 'pkce_challenge'],
        ['pkce short v', baseTransaction({ pkce_verifier: ENTROPY_32 }), 'pkce_verifier'],
        ['pkce long v', baseTransaction({ pkce_verifier: `${PKCE_VERIFIER}${'x'.repeat(90)}` }), 'pkce_verifier'],
        ['pkce bad char', baseTransaction({ pkce_verifier: `${PKCE_VERIFIER.slice(0, 42)}!` }), 'pkce_verifier'],
        ['pkce empty ch', baseTransaction({ pkce_challenge: '' }), 'pkce_challenge'],
      ]) {
        const r = mod.validateMicrosoftDelegatedOauthTransaction(input);
        ok(`oauth tx reject: ${name}`, r.ok === false && r.details && r.details.reason === reason, ser(r));
      }
      let coerceHits = 0;
      const hostileV = { length: 43, toString() { coerceHits += 1; return PKCE_VERIFIER; }, valueOf() { coerceHits += 1; return PKCE_VERIFIER; } };
      const coerceR = mod.validateMicrosoftDelegatedOauthTransaction(baseTransaction({ pkce_verifier: hostileV }));
      ok('oauth tx reject: pkce coercion non-string', coerceR.ok === false && coerceHits === 0, ser(coerceR));
      ok('oauth tx: success status is consumed not active',
        good.ok && good.value.status === 'consumed' && good.value.status !== 'active', ser(good));
    }
    // Refresh + custody gate + activation
    {
      const good = mod.validateMicrosoftDelegatedRefreshRotationPolicy({
        atomic_cas_or_lease: 'required', generation_handling: 'required',
        retain_old_until_durable_replacement: true, app_wide_refresh_token: false,
      });
      ok('refresh rotation: atomic/terminal/no app-wide + custody module present',
        good.ok && ['invalid_grant', 'revocation', 'consent_loss'].every((r) =>
          good.value.terminal_reauthorization_reasons.includes(r))
        && good.value.app_wide_refresh_token === false
        && good.value.refresh_token_custody
        && good.value.refresh_token_custody.refresh_exchange_adapter_allowed === true
        && good.value.refresh_token_custody.durable_grant_custodian_injected === false
        && good.value.refresh_token_custody.durable_grant_custodian_module_present === true
        && good.value.refresh_token_custody.custody_deferred === false
        && !mod.validateMicrosoftDelegatedRefreshRotationPolicy({
          atomic_cas_or_lease: 'required', generation_handling: 'required',
          retain_old_until_durable_replacement: true, app_wide_refresh_token: true,
        }).ok, ser(good));
      const gate = mod.evaluateMicrosoftDelegatedRefreshExchangeGate({});
      ok('refresh exchange gate: module present, exchange adapter allowed',
        gate.ok && gate.value.refresh_exchange_adapter_allowed === true
        && gate.value.custody_deferred === false
        && gate.value.cas_deferred === false
        && gate.value.durable_grant_custodian_module_present === true
        && gate.value.durable_grant_custodian_injected === false
        && mod.evaluateMicrosoftDelegatedRefreshExchangeGate({
          claim_refresh_exchange_allowed: true,
        }).ok
        && !mod.evaluateMicrosoftDelegatedRefreshExchangeGate({
          claim_refresh_exchange_allowed: false,
        }).ok
        && !mod.evaluateMicrosoftDelegatedRefreshExchangeGate({
          claim_grant_custodian_injected: true,
        }).ok
        && mod.evaluateMicrosoftDelegatedRefreshExchangeGate({
          claim_grant_custodian_module_present: true,
        }).ok, ser(gate));
      const act = mod.validateMicrosoftDelegatedActivationInvariants({});
      ok('activation: deferred invariants + claim rejects',
        act.ok && !act.value.schema_enforces_invariants && !act.value.readiness_activation_complete
        && act.value.invariants.one_verified_provider_tid_mailbox_per_active_luna_client
        && act.value.invariants.cross_client_collision_requires_explicit_transfer_or_recovery
        && act.value.invariants.one_principal_may_administer_multiple_mailboxes
        && act.value.invariants.aliases_do_not_create_accounts
        && !mod.validateMicrosoftDelegatedActivationInvariants({ claim_schema_enforces: true }).ok
        && !mod.validateMicrosoftDelegatedActivationInvariants({ claim_activation_complete: true }).ok, ser(act));
    }
    // Hostile + leak
    {
      const sym = baseDeclaration();
      Object.defineProperty(sym, Symbol('evil'), { value: 1, enumerable: true });
      ok('hostile: symbol key rejected', evaluate(sym).ok === false);
      let getterHits = 0;
      const accessor = baseDeclaration();
      Object.defineProperty(accessor, 'provider', {
        enumerable: true, configurable: true, get() { getterHits += 1; return 'microsoft_graph'; },
      });
      ok('hostile: accessor rejected without getter invoke', evaluate(accessor).ok === false && getterHits === 0);
      const proxy = new Proxy(baseDeclaration(), {
        getPrototypeOf() { throw new Error('getPrototypeOf trap'); },
        ownKeys() { throw new Error('ownKeys trap'); },
        getOwnPropertyDescriptor() { throw new Error('getOwnPropertyDescriptor trap'); },
      });
      const proxyResult = evaluate(proxy);
      ok('hostile: proxy → sanitized reflection_failed',
        proxyResult.ok === false && proxyResult.error === 'declaration_invalid'
        && proxyResult.details && proxyResult.details.reason === 'reflection_failed'
        && !hasLeak(proxyResult, ['getPrototypeOf trap', 'ownKeys trap']), ser(proxyResult));
      let coercionThrew = false; let coercionResult;
      try {
        coercionResult = evaluate(baseDeclaration({
          scope_plan: baseScopePlan({
            oidc: { length: 3, 0: 'openid', 1: 'profile', 2: 'offline_access',
              valueOf() { throw new Error('valueOf'); }, toString() { throw new Error('toString'); } },
          }),
        }));
      } catch { coercionThrew = true; }
      ok('hostile: coercion non-array rejected without throw', !coercionThrew && coercionResult && !coercionResult.ok);
      const leak = evaluate(baseDeclaration({ grant_secret_package: { secret_ref: 'kv:sk-thisisnotarealsecretvalueatall' } }));
      ok('leak probe: fail omits planted secret body',
        !leak.ok && !hasLeak(leak, ['sk-thisisnotarealsecretvalueatall', LEAK_PASSWORD, LEAK_REFRESH]));
    }
    // 2B + 1A regressions
    {
      if (mod2b && typeof mod2b.evaluateEmailGraphAppOnlyReadiness === 'function') {
        const appOnlyDecl = {
          provider: 'microsoft_graph', auth_mode: 'application_client_credentials',
          exchange_application_role: 'Application Mail.ReadBasic',
          entra_application_permission_set: [], admin_consent_confirmed: true,
          mailbox_scope: { mechanism: 'exchange_online_rbac_for_applications',
            allowed_public_addresses: ['support@lunafrontdesk.com'] },
          secret_package: { secret_ref: 'kv:luna-support-email-credentials',
            material_keys: ['tenant_id', 'client_id', 'client_secret'] },
          network_enabled: false, registry_activation_enabled: false,
          inbound_enabled: false, outbound_enabled: false, default_automation_mode: 'off',
        };
        const r2b = mod2b.evaluateEmailGraphAppOnlyReadiness(appOnlyDecl);
        ok('2B regression: complete-valid + rejects delegated',
          r2b.ok && r2b.value.ready_for_human_authorized_live_prerequisite_check
          && r2b.value.auth_mode === 'application_client_credentials'
          && mod2b.EMAIL_GRAPH_APP_ONLY_AUTH_MODE === 'application_client_credentials'
          && !mod2b.evaluateEmailGraphAppOnlyReadiness({ ...appOnlyDecl, auth_mode: 'delegated_authorization_code' }).ok, ser(r2b));
      } else ok('2B regression: module available', false);
      if (contract1a && typeof contract1a.validateEmailMailboxSecretRef === 'function') {
        ok('1A regression: secret_ref validates + password rejected',
          contract1a.validateEmailMailboxSecretRef(VALID_SECRET_REF).ok
          && !contract1a.validateEmailMailboxSecretRef('password=x').ok);
      }
    }
    ok('network guards: zero hits', networkHits === 0, `hits=${networkHits}`);
  } finally {
    restoreNetworkGuards();
  }
  console.log(`\n── verify:email-microsoft-delegated-oauth-contract ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
