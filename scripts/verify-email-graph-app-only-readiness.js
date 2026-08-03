'use strict';

/**
 * verify:email-graph-app-only-readiness — Luna email Slice 2B offline gate.
 *
 * Pure offline Microsoft Graph app-only read-readiness contract:
 *   - human-provided security prerequisite declaration
 *   - exact least-privilege + mailbox scope + opaque secret package
 *   - fail closed for network/activation/broader permissions
 *   - never claims Azure/Entra/mailbox facts were independently verified
 *
 * No network, DNS, Azure/Graph/Key Vault SDK, routes, DB, activation, deploy.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');

const CONTRACT_REL = 'scripts/lib/email-graph-app-only-readiness-contract.js';
const CONTRACT_1A_REL = 'scripts/lib/email-mailbox-adapter-contract.js';
const ADAPTER_2A_REL = 'scripts/lib/email-microsoft-graph-adapter.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-graph-app-only-readiness.js';

const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const CONTRACT_1A_PATH = path.join(ROOT, CONTRACT_1A_REL);
const ADAPTER_2A_PATH = path.join(ROOT, ADAPTER_2A_REL);
const DOC_PATH = path.join(ROOT, DOC_REL);
const PKG_PATH = path.join(ROOT, 'package.json');

const VALID_SECRET_REF = 'kv:luna-support-email-credentials';
const LEAK_PASSWORD = 'password=LEAK';
const LEAK_CLIENT_SECRET = 'client_secret=LEAK';
const RAW_SECRET_BODY = 'sk-thisisnotarealsecretvalueatall';

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

function baseDeclaration(overrides) {
  return {
    provider: 'microsoft_graph',
    auth_mode: 'application_client_credentials',
    exchange_application_role: 'Application Mail.ReadBasic',
    entra_application_permission_set: [],
    admin_consent_confirmed: true,
    mailbox_scope: {
      mechanism: 'exchange_online_rbac_for_applications',
      allowed_public_addresses: ['support@lunafrontdesk.com'],
    },
    secret_package: {
      secret_ref: VALID_SECRET_REF,
      material_keys: ['tenant_id', 'client_id', 'client_secret'],
    },
    network_enabled: false,
    registry_activation_enabled: false,
    inbound_enabled: false,
    outbound_enabled: false,
    default_automation_mode: 'off',
    ...overrides,
  };
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
    throw new Error('NETWORK_FORBIDDEN_IN_SLICE_2B_VERIFIER');
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

function main() {
  console.log('verify:email-graph-app-only-readiness — Slice 2B Graph app-only readiness\n');
  installNetworkGuards();

  try {
    // ── Files & package ──────────────────────────────────────────────────
    ok('readiness contract path exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
    ok('1A contract still present', fs.existsSync(CONTRACT_1A_PATH), CONTRACT_1A_REL);
    ok('2A graph adapter still present', fs.existsSync(ADAPTER_2A_PATH), ADAPTER_2A_REL);
    ok('architecture doc exists', fs.existsSync(DOC_PATH), DOC_REL);

    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    } catch {
      pkg = null;
    }
    ok('package.json parses', pkg != null);
    ok(
      'package.json has verify:email-graph-app-only-readiness',
      Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-graph-app-only-readiness']),
    );
    ok(
      'verify script points at this verifier',
      Boolean(
        pkg
        && pkg.scripts
        && String(pkg.scripts['verify:email-graph-app-only-readiness']).includes(VERIFY_REL),
      ),
    );
    ok(
      '2A package script preserved',
      Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-microsoft-graph-adapter']),
    );
    ok(
      '1A package script preserved',
      Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-mailbox-adapter-contract']),
    );

    // ── Doc markers ──────────────────────────────────────────────────────
    if (fs.existsSync(DOC_PATH)) {
      const doc = fs.readFileSync(DOC_PATH, 'utf8');
      ok('doc mentions Slice 2B', /Slice 2B/i.test(doc));
      ok(
        'doc mentions app-only readiness / read-readiness',
        /app-only read[- ]?readiness|app-only security readiness|Graph app-only readiness/i.test(doc),
      );
      ok(
        'doc mentions Application Mail.ReadBasic EXO role',
        /Application Mail\.ReadBasic/i.test(doc),
      );
      ok(
        'doc mentions exchange_online_rbac_for_applications or RBAC for Applications',
        /exchange_online_rbac_for_applications|RBAC for Applications/i.test(doc),
      );
      ok(
        'doc requires empty Entra application permission grants',
        /entra_application_permission_set|empty.*Entra|Entra.*empty|unscoped.*Entra|remove.*Entra/i.test(doc),
      );
      ok(
        'doc rejects or replaces legacy application_access_policy',
        /application_access_policy|Application Access Polic/i.test(doc),
      );
      ok(
        'doc mentions application_client_credentials or client credentials',
        /application_client_credentials|client_credentials/i.test(doc),
      );
      ok(
        'doc mentions support@lunafrontdesk.com first-test mailbox',
        /support@lunafrontdesk\.com/i.test(doc),
      );
      ok(
        'doc mentions human runbook or later operator steps',
        /runbook|human-authorized|operator-owned|paste-ready/i.test(doc),
      );
      ok(
        'doc states 2B does not independently verify Azure/Entra',
        /not independently verif|never claims? Azure|no live Entra|does not perform readiness discovery|does not.*verify.*Entra|independently verified/i.test(doc),
      );
      ok(
        'doc lists Slice 2B non-goals or not-in-2B',
        /Not in Slice 2B|non-goal|2B[^\n]*(no live|no poll|no send|does not)/i.test(doc),
      );
      ok('doc preserves 1A/1B/1C/2A status', /1A/i.test(doc) && /1B/i.test(doc) && /1C/i.test(doc) && /2A/i.test(doc));
      ok('doc forbids credentials in git/postgres/logs/prompts', /never belong in Git/i.test(doc));
      ok(
        'doc requires secret_ref_present / no serialized secret_ref on 2B success',
        /secret_ref_present/i.test(doc)
          && (/never (returned|serializ)|no serialized `?secret_ref|never include secret_ref/i.test(doc)),
      );
    }

    // ── Load modules ─────────────────────────────────────────────────────
    let mod = null;
    let contract1a = null;
    let loadError = null;
    try {
      if (fs.existsSync(CONTRACT_PATH)) {
        delete require.cache[require.resolve(CONTRACT_PATH)];
      }
      if (fs.existsSync(CONTRACT_1A_PATH)) {
        delete require.cache[require.resolve(CONTRACT_1A_PATH)];
      }
      mod = require(CONTRACT_PATH);
      contract1a = require(CONTRACT_1A_PATH);
    } catch (err) {
      loadError = err;
    }
    ok(
      'readiness contract module loads',
      mod != null,
      loadError && String(loadError.message || loadError),
    );
    ok('1A contract still loads', contract1a != null);

    const requiredExports = [
      'evaluateEmailGraphAppOnlyReadiness',
      'isEmailGraphAppOnlyReadinessComplete',
      'EMAIL_GRAPH_APP_ONLY_PROVIDER',
      'EMAIL_GRAPH_APP_ONLY_AUTH_MODE',
      'EMAIL_GRAPH_APP_ONLY_EXCHANGE_APPLICATION_ROLE',
      'EMAIL_GRAPH_APP_ONLY_GRAPH_PERMISSION_VIA_EXCHANGE_RBAC',
      'EMAIL_GRAPH_APP_ONLY_ENTRA_APPLICATION_PERMISSION_SET',
      'EMAIL_GRAPH_APP_ONLY_PERMISSION_SET',
      'EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS',
      'EMAIL_GRAPH_APP_ONLY_FIRST_TEST_PUBLIC_ADDRESS',
      'EMAIL_GRAPH_APP_ONLY_MAILBOX_SCOPE_MECHANISM',
      'EMAIL_GRAPH_APP_ONLY_LEGACY_MAILBOX_SCOPE_MECHANISM',
      'EMAIL_GRAPH_APP_ONLY_AUTOMATION_MODE',
      'EMAIL_GRAPH_APP_ONLY_MISSING_REQUIREMENT_IDS',
    ];
    for (const name of requiredExports) {
      ok(`exports ${name}`, Boolean(mod && mod[name] != null));
    }

    // ── Source hygiene ───────────────────────────────────────────────────
    if (fs.existsSync(CONTRACT_PATH)) {
      const src = fs.readFileSync(CONTRACT_PATH, 'utf8');
      const forbiddenSdk = [
        /require\s*\(\s*['"]@microsoft\/microsoft-graph-client['"]\s*\)/,
        /require\s*\(\s*['"]@azure\/identity['"]\s*\)/,
        /require\s*\(\s*['"]@azure\/msal[^'"]*['"]\s*\)/,
        /require\s*\(\s*['"][^'"]*msal[^'"]*['"]\s*\)/i,
        /require\s*\(\s*['"]@azure\/keyvault[^'"]*['"]\s*\)/i,
        /require\s*\(\s*['"]googleapis['"]\s*\)/,
        /require\s*\(\s*['"]axios['"]\s*\)/,
        /require\s*\(\s*['"]node-fetch['"]\s*\)/,
        /require\s*\(\s*['"]pg['"]\s*\)/,
        /require\s*\(\s*['"]child_process['"]\s*\)/,
      ];
      const forbiddenNet = [
        /\bfetch\s*\(/,
        /\bhttps?\.(?:get|request)\s*\(/,
        /\bnet\.connect\s*\(/,
        /\bdns\.lookup\s*\(/,
      ];
      const forbiddenEnv = [
        /process\.env\b/,
      ];
      const forbiddenImports = [
        /require\s*\(\s*['"]\.\/email-microsoft-graph-adapter['"]\s*\)/,
        /require\s*\(\s*['"]\.\/staff-email-registry-routes['"]\s*\)/,
        /require\s*\(\s*['"]\.\/email-tenant-channel-registry['"]\s*\)/,
        /require\s*\(\s*['"]\.\/email-fake-http-transport['"]\s*\)/,
      ];
      ok('contract: no provider/Azure/KV SDK imports', !forbiddenSdk.some((re) => re.test(src)));
      ok('contract: no network API calls', !forbiddenNet.some((re) => re.test(src)));
      ok('contract: no process.env reads', !forbiddenEnv.some((re) => re.test(src)));
      ok('contract: does not import Graph adapter / routes / registry', !forbiddenImports.some((re) => re.test(src)));
      ok(
        'contract: reuses 1A secret_ref validator',
        /validateEmailMailboxSecretRef/.test(src)
          && /email-mailbox-adapter-contract/.test(src),
      );
      ok(
        'contract: no subprocess / spawn',
        !/\b(?:spawn|exec|execFile|fork)\s*\(/.test(src),
      );
    }

    if (!mod || typeof mod.evaluateEmailGraphAppOnlyReadiness !== 'function') {
      console.log('\n── early exit: module unavailable ──');
      console.log(`\n── verify:email-graph-app-only-readiness ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
      process.exit(fail > 0 ? 1 : 0);
      return;
    }

    const evaluate = mod.evaluateEmailGraphAppOnlyReadiness;
    const isComplete = mod.isEmailGraphAppOnlyReadinessComplete;

    // ── Constants ────────────────────────────────────────────────────────
    ok(
      'PROVIDER constant is microsoft_graph',
      mod.EMAIL_GRAPH_APP_ONLY_PROVIDER === 'microsoft_graph',
    );
    ok(
      'AUTH_MODE constant is application_client_credentials',
      mod.EMAIL_GRAPH_APP_ONLY_AUTH_MODE === 'application_client_credentials',
    );
    ok(
      'EXCHANGE_APPLICATION_ROLE is Application Mail.ReadBasic',
      mod.EMAIL_GRAPH_APP_ONLY_EXCHANGE_APPLICATION_ROLE === 'Application Mail.ReadBasic',
    );
    ok(
      'GRAPH_PERMISSION_VIA_EXCHANGE_RBAC is exactly Mail.ReadBasic',
      Array.isArray(mod.EMAIL_GRAPH_APP_ONLY_GRAPH_PERMISSION_VIA_EXCHANGE_RBAC)
        && mod.EMAIL_GRAPH_APP_ONLY_GRAPH_PERMISSION_VIA_EXCHANGE_RBAC.length === 1
        && mod.EMAIL_GRAPH_APP_ONLY_GRAPH_PERMISSION_VIA_EXCHANGE_RBAC[0] === 'Mail.ReadBasic'
        && Object.isFrozen(mod.EMAIL_GRAPH_APP_ONLY_GRAPH_PERMISSION_VIA_EXCHANGE_RBAC),
    );
    ok(
      'ENTRA_APPLICATION_PERMISSION_SET is exact empty frozen array',
      Array.isArray(mod.EMAIL_GRAPH_APP_ONLY_ENTRA_APPLICATION_PERMISSION_SET)
        && mod.EMAIL_GRAPH_APP_ONLY_ENTRA_APPLICATION_PERMISSION_SET.length === 0
        && Object.isFrozen(mod.EMAIL_GRAPH_APP_ONLY_ENTRA_APPLICATION_PERMISSION_SET),
    );
    ok(
      'PERMISSION_SET alias is empty (not legacy Mail.ReadBasic.All)',
      Array.isArray(mod.EMAIL_GRAPH_APP_ONLY_PERMISSION_SET)
        && mod.EMAIL_GRAPH_APP_ONLY_PERMISSION_SET.length === 0
        && Object.isFrozen(mod.EMAIL_GRAPH_APP_ONLY_PERMISSION_SET)
        && mod.EMAIL_GRAPH_APP_ONLY_PERMISSION_SET
          === mod.EMAIL_GRAPH_APP_ONLY_ENTRA_APPLICATION_PERMISSION_SET,
    );
    ok(
      'MAILBOX_SCOPE_MECHANISM is exchange_online_rbac_for_applications',
      mod.EMAIL_GRAPH_APP_ONLY_MAILBOX_SCOPE_MECHANISM
        === 'exchange_online_rbac_for_applications',
    );
    ok(
      'LEGACY_MAILBOX_SCOPE_MECHANISM is application_access_policy',
      mod.EMAIL_GRAPH_APP_ONLY_LEGACY_MAILBOX_SCOPE_MECHANISM
        === 'application_access_policy',
    );
    ok(
      'MATERIAL_KEYS exact three',
      Array.isArray(mod.EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS)
        && mod.EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS.length === 3
        && mod.EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS.includes('tenant_id')
        && mod.EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS.includes('client_id')
        && mod.EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS.includes('client_secret')
        && !mod.EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS.includes('access_token'),
    );
    ok(
      'FIRST_TEST_PUBLIC_ADDRESS is support@lunafrontdesk.com',
      mod.EMAIL_GRAPH_APP_ONLY_FIRST_TEST_PUBLIC_ADDRESS === 'support@lunafrontdesk.com',
    );

    // ── Complete-valid ───────────────────────────────────────────────────
    {
      const input = baseDeclaration();
      const result = evaluate(input);
      ok('complete-valid: ok', result.ok === true, serializeSafe(result));
      if (result.ok) {
        const v = result.value;
        ok('complete-valid: ready flag true', v.ready_for_human_authorized_live_prerequisite_check === true);
        ok(
          'complete-valid: missing_requirements empty',
          Array.isArray(v.missing_requirements) && v.missing_requirements.length === 0,
        );
        ok('complete-valid: provider microsoft_graph', v.provider === 'microsoft_graph');
        ok(
          'complete-valid: auth_mode application_client_credentials',
          v.auth_mode === 'application_client_credentials',
        );
        ok(
          'complete-valid: exchange_application_role Application Mail.ReadBasic',
          v.exchange_application_role === 'Application Mail.ReadBasic',
        );
        ok(
          'complete-valid: entra_application_permission_set empty',
          Array.isArray(v.entra_application_permission_set)
            && v.entra_application_permission_set.length === 0,
        );
        ok(
          'complete-valid: graph_permission_via_exchange_rbac Mail.ReadBasic',
          Array.isArray(v.graph_permission_via_exchange_rbac)
            && v.graph_permission_via_exchange_rbac.length === 1
            && v.graph_permission_via_exchange_rbac[0] === 'Mail.ReadBasic',
        );
        ok('complete-valid: admin_consent_confirmed true', v.admin_consent_confirmed === true);
        ok(
          'complete-valid: mailbox scope mechanism exchange_online_rbac_for_applications',
          v.mailbox_scope
            && v.mailbox_scope.mechanism === 'exchange_online_rbac_for_applications',
        );
        ok(
          'complete-valid: single first-test address',
          v.mailbox_scope
            && Array.isArray(v.mailbox_scope.allowed_public_addresses)
            && v.mailbox_scope.allowed_public_addresses.length === 1
            && v.mailbox_scope.allowed_public_addresses[0] === 'support@lunafrontdesk.com',
        );
        ok(
          'complete-valid: secret_ref_present true (ref not returned)',
          v.secret_package
            && v.secret_package.secret_ref_present === true
            && !Object.prototype.hasOwnProperty.call(v.secret_package, 'secret_ref'),
        );
        ok(
          'complete-valid: material_keys exact three names',
          v.secret_package
            && Array.isArray(v.secret_package.material_keys)
            && v.secret_package.material_keys.length === 3
            && v.secret_package.material_keys.includes('tenant_id')
            && v.secret_package.material_keys.includes('client_id')
            && v.secret_package.material_keys.includes('client_secret'),
        );
        ok('complete-valid: network_enabled false', v.network_enabled === false);
        ok('complete-valid: registry_activation_enabled false', v.registry_activation_enabled === false);
        ok('complete-valid: inbound/outbound false', v.inbound_enabled === false && v.outbound_enabled === false);
        ok('complete-valid: automation off', v.default_automation_mode === 'off');
        ok(
          'complete-valid: never claims Azure verified',
          v.azure_facts_independently_verified === false,
        );
        ok(
          'complete-valid: never claims Entra verified',
          v.entra_facts_independently_verified === false,
        );
        ok(
          'complete-valid: never claims mailbox verified',
          v.mailbox_facts_independently_verified === false,
        );
        ok('complete-valid: ok wrapper frozen', Object.isFrozen(result));
        ok('complete-valid: value is frozen', Object.isFrozen(v));
        ok(
          'complete-valid: nested objects frozen',
          Object.isFrozen(v.mailbox_scope)
            && Object.isFrozen(v.secret_package)
            && Object.isFrozen(v.entra_application_permission_set)
            && Object.isFrozen(v.graph_permission_via_exchange_rbac)
            && Object.isFrozen(v.missing_requirements)
            && Object.isFrozen(v.mailbox_scope.allowed_public_addresses)
            && Object.isFrozen(v.secret_package.material_keys),
        );
        ok('complete-valid: isComplete helper true', isComplete(input) === true);

        // Fresh DTO — not same object identity as input
        ok('complete-valid: fresh DTO (not input identity)', v !== input);
        ok(
          'complete-valid: nested mailbox_scope fresh',
          v.mailbox_scope !== input.mailbox_scope,
        );
        ok(
          'complete-valid: nested secret_package fresh',
          v.secret_package !== input.secret_package,
        );

        // Mutating input after evaluate must not affect result
        input.provider = 'gmail_api';
        input.admin_consent_confirmed = false;
        input.entra_application_permission_set.push('Mail.ReadBasic.All');
        input.exchange_application_role = 'Application Mail.Read';
        ok(
          'complete-valid: input mutation does not affect frozen DTO',
          v.provider === 'microsoft_graph'
            && v.admin_consent_confirmed === true
            && v.entra_application_permission_set.length === 0
            && v.exchange_application_role === 'Application Mail.ReadBasic',
        );

        // Success JSON must never contain secret_ref key or planted ref value
        const goodSer = serializeSafe(result);
        ok(
          'complete-valid: serialized success has no secret_ref key',
          !/"secret_ref"\s*:/.test(goodSer) && !goodSer.includes('"secret_ref"'),
          goodSer,
        );
        ok(
          'complete-valid: serialized success has no planted ref value',
          !goodSer.includes(VALID_SECRET_REF),
          goodSer,
        );
        ok(
          'complete-valid: serialized success has secret_ref_present true',
          /"secret_ref_present"\s*:\s*true/.test(goodSer),
          goodSer,
        );
      }
    }

    // ── Valid-incomplete (admin consent false) ───────────────────────────
    {
      const input = baseDeclaration({ admin_consent_confirmed: false });
      const result = evaluate(input);
      ok('valid-incomplete: ok', result.ok === true, serializeSafe(result));
      if (result.ok) {
        ok(
          'valid-incomplete: ready flag false',
          result.value.ready_for_human_authorized_live_prerequisite_check === false,
        );
        ok(
          'valid-incomplete: missing admin_consent_confirmed',
          Array.isArray(result.value.missing_requirements)
            && result.value.missing_requirements.length === 1
            && result.value.missing_requirements[0] === 'admin_consent_confirmed',
        );
        ok(
          'valid-incomplete: missing_requirements allowlisted only',
          result.value.missing_requirements.every(
            (id) => mod.EMAIL_GRAPH_APP_ONLY_MISSING_REQUIREMENT_IDS.includes(id),
          ),
        );
        ok(
          'valid-incomplete: still never claims Azure verified',
          result.value.azure_facts_independently_verified === false
            && result.value.entra_facts_independently_verified === false
            && result.value.mailbox_facts_independently_verified === false,
        );
        ok('valid-incomplete: isComplete helper false', isComplete(input) === false);
      }
    }

    // ── Wrong / broader Exchange application roles ───────────────────────
    const roleCases = [
      { name: 'Application Mail.Read', role: 'Application Mail.Read' },
      { name: 'Application Mail.ReadWrite', role: 'Application Mail.ReadWrite' },
      { name: 'Application Mail.Send', role: 'Application Mail.Send' },
      { name: 'Application Mail Full Access', role: 'Application Mail Full Access' },
      { name: 'Application Exchange Full Access', role: 'Application Exchange Full Access' },
      { name: 'legacy Entra Mail.ReadBasic.All as role', role: 'Mail.ReadBasic.All' },
      { name: 'Graph Mail.ReadBasic as role', role: 'Mail.ReadBasic' },
      { name: 'empty role', role: '' },
      { name: 'unknown role', role: 'Application Something.Else' },
    ];
    for (const tc of roleCases) {
      const result = evaluate(baseDeclaration({ exchange_application_role: tc.role }));
      ok(
        `exchange role reject: ${tc.name}`,
        result.ok === false && result.error === 'exchange_application_role_invalid',
        serializeSafe(result),
      );
    }
    ok(
      'exchange role reject: non-string',
      evaluate(baseDeclaration({ exchange_application_role: ['Application Mail.ReadBasic'] })).ok === false
        && evaluate(baseDeclaration({ exchange_application_role: ['Application Mail.ReadBasic'] })).error
          === 'exchange_application_role_invalid',
    );

    // ── Non-empty / forbidden Entra application permission sets ──────────
    const entraCases = [
      { name: 'legacy Mail.ReadBasic.All', set: ['Mail.ReadBasic.All'] },
      { name: 'Mail.ReadBasic (unscoped Entra)', set: ['Mail.ReadBasic'] },
      { name: 'Mail.Read', set: ['Mail.Read'] },
      { name: 'Mail.ReadWrite', set: ['Mail.ReadWrite'] },
      { name: 'Mail.Send', set: ['Mail.Send'] },
      { name: 'Mail.Read + basic', set: ['Mail.ReadBasic.All', 'Mail.Read'] },
      { name: 'duplicate basic', set: ['Mail.ReadBasic.All', 'Mail.ReadBasic.All'] },
      { name: 'unknown permission', set: ['Calendars.Read'] },
      { name: 'non-mail permission', set: ['User.Read.All'] },
    ];
    for (const tc of entraCases) {
      const result = evaluate(baseDeclaration({ entra_application_permission_set: tc.set }));
      ok(
        `entra permissions reject: ${tc.name}`,
        result.ok === false && result.error === 'entra_application_permission_set_invalid',
        serializeSafe(result),
      );
    }

    // ── Mailbox scope variants ───────────────────────────────────────────
    const scopeCases = [
      {
        name: 'all_mailboxes mechanism',
        mailbox_scope: {
          mechanism: 'all_mailboxes',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
        },
      },
      {
        name: 'tenant_wide mechanism',
        mailbox_scope: {
          mechanism: 'tenant_wide',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
        },
      },
      {
        name: 'legacy application_access_policy mechanism',
        mailbox_scope: {
          mechanism: 'application_access_policy',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
        },
        details_reason: 'legacy_application_access_policy',
      },
      {
        name: 'multi-mailbox addresses',
        mailbox_scope: {
          mechanism: 'exchange_online_rbac_for_applications',
          allowed_public_addresses: [
            'support@lunafrontdesk.com',
            'ops@lunafrontdesk.com',
          ],
        },
      },
      {
        name: 'empty address list',
        mailbox_scope: {
          mechanism: 'exchange_online_rbac_for_applications',
          allowed_public_addresses: [],
        },
      },
      {
        name: 'wrong address',
        mailbox_scope: {
          mechanism: 'exchange_online_rbac_for_applications',
          allowed_public_addresses: ['other@example.com'],
        },
      },
      {
        name: 'case-variant address (no coercion)',
        mailbox_scope: {
          mechanism: 'exchange_online_rbac_for_applications',
          allowed_public_addresses: ['Support@Lunafrontdesk.com'],
        },
      },
      {
        name: 'unknown scope key',
        mailbox_scope: {
          mechanism: 'exchange_online_rbac_for_applications',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
          extra: true,
        },
      },
    ];
    for (const tc of scopeCases) {
      const result = evaluate(baseDeclaration({ mailbox_scope: tc.mailbox_scope }));
      const reasonOk = !tc.details_reason
        || (result.details && result.details.reason === tc.details_reason);
      ok(
        `mailbox_scope reject: ${tc.name}`,
        result.ok === false && result.error === 'mailbox_scope_invalid' && reasonOk,
        serializeSafe(result),
      );
    }

    // ── Raw secret_ref / password leaks ──────────────────────────────────
    {
      const rawRefCases = [
        { name: 'unprefixed raw sk-', secret_ref: RAW_SECRET_BODY },
        { name: 'password= body', secret_ref: LEAK_PASSWORD },
        { name: 'client_secret= body', secret_ref: LEAK_CLIENT_SECRET },
        { name: 'kv:password-hunter2', secret_ref: 'kv:password-hunter2' },
        { name: 'kv:sk- prefixed', secret_ref: 'kv:sk-abcdefghijklmnopqrstuv' },
        { name: 'Bearer shape', secret_ref: 'Bearer FAKESECRET_e2f3g4h5i6j7k8l9m0n1' },
        { name: 'empty ref', secret_ref: '' },
        { name: 'whitespace ref', secret_ref: 'kv:has space' },
        { name: 'unknown scheme', secret_ref: 'vault:luna-support' },
      ];
      for (const tc of rawRefCases) {
        const result = evaluate(baseDeclaration({
          secret_package: {
            secret_ref: tc.secret_ref,
            material_keys: ['tenant_id', 'client_id', 'client_secret'],
          },
        }));
        ok(
          `secret_ref reject: ${tc.name}`,
          result.ok === false && (
            result.error === 'secret_ref_invalid'
            || result.error === 'secret_package_invalid'
          ),
          serializeSafe(result),
        );
        ok(
          `secret_ref leak-safe: ${tc.name}`,
          !containsLeak(result, [LEAK_PASSWORD, LEAK_CLIENT_SECRET, RAW_SECRET_BODY, tc.secret_ref].filter(Boolean)
            .filter((s) => s.length > 8)),
          serializeSafe(result),
        );
      }
    }

    // ── access_token / raw client_secret keys ────────────────────────────
    {
      const resultAt = evaluate(baseDeclaration({
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['tenant_id', 'client_id', 'client_secret', 'access_token'],
        },
      }));
      ok(
        'reject access_token in material_keys',
        resultAt.ok === false && resultAt.error === 'secret_package_invalid',
        serializeSafe(resultAt),
      );

      const resultOnlyAt = evaluate(baseDeclaration({
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['access_token'],
        },
      }));
      ok(
        'reject material_keys=[access_token]',
        resultOnlyAt.ok === false && resultOnlyAt.error === 'secret_package_invalid',
        serializeSafe(resultOnlyAt),
      );

      const resultRawCs = evaluate(baseDeclaration({
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['tenant_id', 'client_id', 'client_secret'],
          client_secret: 'super-secret-value-NOT-REAL',
        },
      }));
      ok(
        'reject raw client_secret key on secret_package',
        resultRawCs.ok === false && resultRawCs.error === 'secret_package_invalid',
        serializeSafe(resultRawCs),
      );
      ok(
        'raw client_secret value not in error',
        !containsLeak(resultRawCs, ['super-secret-value-NOT-REAL']),
        serializeSafe(resultRawCs),
      );

      const resultTopAt = evaluate(baseDeclaration({
        access_token: 'planted-access-token-value',
      }));
      ok(
        'reject top-level access_token',
        resultTopAt.ok === false
          && (resultTopAt.error === 'declaration_forbidden_field'
            || resultTopAt.error === 'declaration_unknown_key'),
        serializeSafe(resultTopAt),
      );
      ok(
        'top-level access_token value not in error',
        !containsLeak(resultTopAt, ['planted-access-token-value']),
        serializeSafe(resultTopAt),
      );

      const resultTopCs = evaluate(baseDeclaration({
        client_secret: 'planted-client-secret-value',
      }));
      ok(
        'reject top-level client_secret',
        resultTopCs.ok === false
          && (resultTopCs.error === 'declaration_forbidden_field'
            || resultTopCs.error === 'declaration_unknown_key'),
        serializeSafe(resultTopCs),
      );
    }

    // ── network / activation true ────────────────────────────────────────
    const flagCases = [
      { field: 'network_enabled', value: true },
      { field: 'registry_activation_enabled', value: true },
      { field: 'inbound_enabled', value: true },
      { field: 'outbound_enabled', value: true },
      { field: 'network_enabled', value: 1 },
      { field: 'network_enabled', value: 'false' },
      { field: 'network_enabled', value: null },
    ];
    for (const tc of flagCases) {
      const overrides = {};
      overrides[tc.field] = tc.value;
      const result = evaluate(baseDeclaration(overrides));
      ok(
        `fail-closed ${tc.field}=${JSON.stringify(tc.value)}`,
        result.ok === false && result.error === 'network_or_activation_invalid',
        serializeSafe(result),
      );
    }
    {
      const result = evaluate(baseDeclaration({ default_automation_mode: 'automatic' }));
      ok(
        'fail-closed automation automatic',
        result.ok === false && result.error === 'automation_mode_invalid',
        serializeSafe(result),
      );
      const resultDraft = evaluate(baseDeclaration({ default_automation_mode: 'draft_only' }));
      ok(
        'fail-closed automation draft_only',
        resultDraft.ok === false && resultDraft.error === 'automation_mode_invalid',
        serializeSafe(resultDraft),
      );
    }

    // ── Wrong provider / auth_mode ───────────────────────────────────────
    {
      ok(
        'reject provider gmail_api',
        evaluate(baseDeclaration({ provider: 'gmail_api' })).ok === false
          && evaluate(baseDeclaration({ provider: 'gmail_api' })).error === 'provider_invalid',
      );
      ok(
        'reject auth_mode delegated',
        evaluate(baseDeclaration({ auth_mode: 'delegated' })).ok === false
          && evaluate(baseDeclaration({ auth_mode: 'delegated' })).error === 'auth_mode_invalid',
      );
      ok(
        'reject auth_mode app_only_client_credentials alias',
        evaluate(baseDeclaration({ auth_mode: 'app_only_client_credentials' })).ok === false
          && evaluate(baseDeclaration({ auth_mode: 'app_only_client_credentials' })).error === 'auth_mode_invalid',
      );
    }

    // ── Unknown / prototype / __proto__ / symbol / accessor / coercion ───
    {
      ok(
        'reject null input',
        evaluate(null).ok === false && evaluate(null).error === 'declaration_invalid',
      );
      ok(
        'reject array input',
        evaluate([]).ok === false && evaluate([]).error === 'declaration_invalid',
      );
      ok(
        'reject string input',
        evaluate('microsoft_graph').ok === false && evaluate('microsoft_graph').error === 'declaration_invalid',
      );
      ok(
        'reject unknown top-level key',
        evaluate(baseDeclaration({ extra_field: true })).ok === false
          && evaluate(baseDeclaration({ extra_field: true })).error === 'declaration_unknown_key',
      );

      // __proto__ as own key via null-proto assignment pattern
      const protoPoison = baseDeclaration();
      Object.defineProperty(protoPoison, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      // If defineProperty on normal object for __proto__ is weird, build via create
      const protoPoison2 = Object.assign(Object.create(null), baseDeclaration());
      protoPoison2.__proto__ = { polluted: true };
      // Re-box as plain object with __proto__ own key using JSON trick carefully
      const withProtoKey = {
        ...baseDeclaration(),
      };
      // Use defineProperty on a copy
      const protoObj = {};
      for (const [k, v] of Object.entries(baseDeclaration())) {
        protoObj[k] = v;
      }
      Object.defineProperty(protoObj, '__proto__', {
        value: { x: 1 },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const protoResult = evaluate(protoObj);
      // Either unknown key or invalid — must fail closed, not succeed polluted
      ok(
        'reject __proto__ own key',
        protoResult.ok === false,
        serializeSafe(protoResult),
      );

      // Symbol key
      const symObj = baseDeclaration();
      const sym = Symbol('hostile');
      symObj[sym] = 'x';
      ok(
        'reject symbol key',
        evaluate(symObj).ok === false && evaluate(symObj).error === 'declaration_invalid',
        serializeSafe(evaluate(symObj)),
      );

      // Accessor on top-level key
      const accessorObj = baseDeclaration();
      let accessorHit = 0;
      Object.defineProperty(accessorObj, 'admin_consent_confirmed', {
        enumerable: true,
        configurable: true,
        get() {
          accessorHit += 1;
          return true;
        },
      });
      const accResult = evaluate(accessorObj);
      ok(
        'reject accessor property without invoking getter',
        accResult.ok === false
          && accResult.error === 'declaration_invalid'
          && accessorHit === 0,
        `hit=${accessorHit} ${serializeSafe(accResult)}`,
      );

      // Inherited value via prototype — must not accept inherited provider
      const protoBase = {
        provider: 'microsoft_graph',
        auth_mode: 'application_client_credentials',
      };
      const inherited = Object.create(protoBase);
      // Only set non-inherited remaining keys as own
      Object.assign(inherited, {
        exchange_application_role: 'Application Mail.ReadBasic',
        entra_application_permission_set: [],
        admin_consent_confirmed: true,
        mailbox_scope: {
          mechanism: 'exchange_online_rbac_for_applications',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
        },
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['tenant_id', 'client_id', 'client_secret'],
        },
        network_enabled: false,
        registry_activation_enabled: false,
        inbound_enabled: false,
        outbound_enabled: false,
        default_automation_mode: 'off',
      });
      // isPlainObject requires Object.prototype or null — Object.create(protoBase) fails isPlainObject
      const inhResult = evaluate(inherited);
      ok(
        'reject inherited-prototype object (non-plain)',
        inhResult.ok === false && inhResult.error === 'declaration_invalid',
        serializeSafe(inhResult),
      );

      // Coercion trap: object pretending to be string via valueOf/toString
      const coercePerm = baseDeclaration({
        entra_application_permission_set: [
          {
            toString() { return 'Mail.ReadBasic.All'; },
            valueOf() { return 'Mail.ReadBasic.All'; },
            [Symbol.toPrimitive]() { return 'Mail.ReadBasic.All'; },
          },
        ],
      });
      ok(
        'reject non-string entra permission element (no coercion)',
        evaluate(coercePerm).ok === false
          && evaluate(coercePerm).error === 'entra_application_permission_set_invalid',
        serializeSafe(evaluate(coercePerm)),
      );

      // Nested accessor on mailbox_scope
      const nestedAcc = baseDeclaration();
      let nestedHit = 0;
      const scopeObj = {
        mechanism: 'exchange_online_rbac_for_applications',
        allowed_public_addresses: ['support@lunafrontdesk.com'],
      };
      Object.defineProperty(scopeObj, 'mechanism', {
        enumerable: true,
        get() {
          nestedHit += 1;
          return 'exchange_online_rbac_for_applications';
        },
      });
      nestedAcc.mailbox_scope = scopeObj;
      const nestedAccResult = evaluate(nestedAcc);
      ok(
        'reject nested accessor without invoking getter',
        nestedAccResult.ok === false
          && nestedAccResult.error === 'mailbox_scope_invalid'
          && nestedHit === 0,
        `hit=${nestedHit} ${serializeSafe(nestedAccResult)}`,
      );

      // Hostile nested array with accessor index
      const arrAcc = baseDeclaration();
      let arrHit = 0;
      const perms = ['Mail.ReadBasic.All'];
      Object.defineProperty(perms, '0', {
        enumerable: true,
        configurable: true,
        get() {
          arrHit += 1;
          return 'Mail.ReadBasic.All';
        },
      });
      arrAcc.entra_application_permission_set = perms;
      const arrAccResult = evaluate(arrAcc);
      ok(
        'reject entra permission_set index accessor without invoke',
        arrAccResult.ok === false
          && arrAccResult.error === 'entra_application_permission_set_invalid'
          && arrHit === 0,
        `hit=${arrHit} ${serializeSafe(arrAccResult)}`,
      );

      // Missing required key
      const missing = baseDeclaration();
      delete missing.provider;
      ok(
        'reject missing provider key',
        evaluate(missing).ok === false && evaluate(missing).error === 'declaration_missing_key',
      );

      // admin_consent non-boolean
      ok(
        'reject admin_consent string true',
        evaluate(baseDeclaration({ admin_consent_confirmed: 'true' })).ok === false
          && evaluate(baseDeclaration({ admin_consent_confirmed: 'true' })).error === 'admin_consent_invalid',
      );
      ok(
        'reject admin_consent 1',
        evaluate(baseDeclaration({ admin_consent_confirmed: 1 })).ok === false
          && evaluate(baseDeclaration({ admin_consent_confirmed: 1 })).error === 'admin_consent_invalid',
      );
    }

    // ── Serialized result/error leak probes ──────────────────────────────
    {
      const leakInput = baseDeclaration({
        secret_package: {
          secret_ref: `kv:${LEAK_PASSWORD}`,
          material_keys: ['tenant_id', 'client_id', 'client_secret'],
        },
      });
      // Actually kv:password=LEAK may fail body grammar; use planted in unknown scheme path
      const leakCases = [
        baseDeclaration({
          secret_package: {
            secret_ref: LEAK_PASSWORD,
            material_keys: ['tenant_id', 'client_id', 'client_secret'],
          },
        }),
        baseDeclaration({
          secret_package: {
            secret_ref: LEAK_CLIENT_SECRET,
            material_keys: ['tenant_id', 'client_id', 'client_secret'],
          },
        }),
        baseDeclaration({
          secret_package: {
            secret_ref: VALID_SECRET_REF,
            material_keys: ['tenant_id', 'client_id', 'client_secret'],
            client_secret: LEAK_CLIENT_SECRET,
          },
        }),
        baseDeclaration({
          access_token: LEAK_PASSWORD,
        }),
      ];
      for (let i = 0; i < leakCases.length; i += 1) {
        const result = evaluate(leakCases[i]);
        const ser = serializeSafe(result);
        ok(
          `serialized error leak probe #${i + 1} fails closed`,
          result.ok === false,
          ser,
        );
        ok(
          `serialized error leak probe #${i + 1} no password/client_secret leak`,
          !ser.includes(LEAK_PASSWORD) && !ser.includes(LEAK_CLIENT_SECRET),
          ser,
        );
      }

      // Success path must not include planted leaks, secret_ref key, or ref value
      const good = evaluate(baseDeclaration());
      const goodSer = serializeSafe(good);
      ok(
        'success serialization has no planted leak tokens',
        !goodSer.includes(LEAK_PASSWORD) && !goodSer.includes(LEAK_CLIENT_SECRET),
        goodSer,
      );
      ok(
        'success serialization has no access_token field',
        !/"access_token"\s*:/.test(goodSer),
        goodSer,
      );
      ok(
        'success serialization has neither secret_ref key nor planted ref value',
        !/"secret_ref"\s*:/.test(goodSer)
          && !goodSer.includes(VALID_SECRET_REF)
          && /"secret_ref_present"\s*:\s*true/.test(goodSer),
        goodSer,
      );
    }

    // ── 1A secret_ref reuse smoke ────────────────────────────────────────
    {
      const validRef = contract1a.validateEmailMailboxSecretRef(VALID_SECRET_REF);
      ok('1A accepts VALID_SECRET_REF', validRef.ok === true);
      const invalidRef = contract1a.validateEmailMailboxSecretRef(LEAK_PASSWORD);
      ok('1A rejects password=LEAK', invalidRef.ok === false);
      // Readiness must agree with 1A on the same ref
      const rValid = evaluate(baseDeclaration({
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['tenant_id', 'client_id', 'client_secret'],
        },
      }));
      ok('readiness accepts 1A-valid ref', rValid.ok === true);
      const rInvalid = evaluate(baseDeclaration({
        secret_package: {
          secret_ref: LEAK_PASSWORD,
          material_keys: ['tenant_id', 'client_id', 'client_secret'],
        },
      }));
      ok('readiness rejects 1A-invalid ref', rInvalid.ok === false);
    }

    // ── material_keys order independence ─────────────────────────────────
    {
      const reordered = evaluate(baseDeclaration({
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['client_secret', 'tenant_id', 'client_id'],
        },
      }));
      ok(
        'material_keys order-independent set-equal accepted',
        reordered.ok === true
          && reordered.value.ready_for_human_authorized_live_prerequisite_check === true,
        serializeSafe(reordered),
      );
      ok(
        'material_keys reorder: still no secret_ref in success DTO',
        reordered.ok
          && reordered.value.secret_package.secret_ref_present === true
          && !Object.prototype.hasOwnProperty.call(reordered.value.secret_package, 'secret_ref')
          && !serializeSafe(reordered).includes(VALID_SECRET_REF),
        serializeSafe(reordered),
      );
    }

    // ── Direct freeze / mutation / unknown-key / freshness probes ────────
    {
      function assertDeepFrozen(node, path, acc) {
        if (node === null || typeof node !== 'object') return;
        if (!Object.isFrozen(node)) acc.push(path);
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i += 1) {
            assertDeepFrozen(node[i], `${path}[${i}]`, acc);
          }
          return;
        }
        for (const k of Object.keys(node)) {
          assertDeepFrozen(node[k], `${path}.${k}`, acc);
        }
      }

      function mutationHasNoEffect(target, assign) {
        const before = serializeSafe(target);
        let threw = false;
        try {
          assign();
        } catch {
          threw = true;
        }
        const after = serializeSafe(target);
        return before === after && (threw || Object.isFrozen(target));
      }

      // Success envelope deeply frozen; mutation no effect
      const okA = evaluate(baseDeclaration());
      const okB = evaluate(baseDeclaration());
      ok('probe: success ok wrapper frozen', Object.isFrozen(okA));
      ok('probe: success value frozen', okA.ok && Object.isFrozen(okA.value));
      const unfrozenOk = [];
      assertDeepFrozen(okA, 'okA', unfrozenOk);
      ok(
        'probe: success envelope deeply frozen',
        unfrozenOk.length === 0,
        unfrozenOk.join(','),
      );
      ok(
        'probe: success wrapper mutation no effect',
        mutationHasNoEffect(okA, () => {
          okA.ok = false;
          okA.extra = true;
          okA.value = null;
        }),
      );
      ok(
        'probe: success value mutation no effect',
        okA.ok
          && mutationHasNoEffect(okA.value, () => {
            okA.value.provider = 'gmail_api';
            okA.value.network_enabled = true;
            okA.value.entra_application_permission_set.push('Mail.Read');
            okA.value.exchange_application_role = 'Application Mail.Read';
            okA.value.secret_package.secret_ref = 'planted-ref';
            okA.value.secret_package.secret_ref_present = false;
            okA.value.mailbox_scope.allowed_public_addresses.push('x@y.com');
          }),
      );

      // Fail envelope deeply frozen
      const failA = evaluate(baseDeclaration({ entra_application_permission_set: ['Mail.Read'] }));
      const failB = evaluate(baseDeclaration({ entra_application_permission_set: ['Mail.Read'] }));
      ok('probe: fail ok wrapper frozen', Object.isFrozen(failA));
      ok('probe: fail has error code', failA.ok === false && typeof failA.error === 'string');
      const unfrozenFail = [];
      assertDeepFrozen(failA, 'failA', unfrozenFail);
      ok(
        'probe: fail envelope deeply frozen',
        unfrozenFail.length === 0,
        unfrozenFail.join(','),
      );
      ok(
        'probe: fail wrapper mutation no effect',
        mutationHasNoEffect(failA, () => {
          failA.ok = true;
          failA.error = 'mutated';
          failA.details = { reason: 'mutated' };
        }),
      );
      if (failA.details) {
        ok(
          'probe: fail details mutation no effect',
          mutationHasNoEffect(failA.details, () => {
            failA.details.reason = 'mutated';
            failA.details.hostile = true;
          }),
        );
      }

      // Unknown-key details / details with nested unknown markers must not echo hostile names
      const hostileTop = 'hostile_attacker_key_ZZZ';
      const hostileNested = 'hostile_nested_key_YYY';
      const topUnknown = evaluate(baseDeclaration({ [hostileTop]: true }));
      const topSer = serializeSafe(topUnknown);
      ok(
        'probe: unknown top-level key fails closed',
        topUnknown.ok === false && topUnknown.error === 'declaration_unknown_key',
        topSer,
      );
      ok(
        'probe: unknown top-level key name absent from serialized error',
        !topSer.includes(hostileTop),
        topSer,
      );

      const nestedUnknown = evaluate(baseDeclaration({
        mailbox_scope: {
          mechanism: 'exchange_online_rbac_for_applications',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
          [hostileNested]: 'planted',
        },
      }));
      const nestedSer = serializeSafe(nestedUnknown);
      ok(
        'probe: unknown nested key fails closed',
        nestedUnknown.ok === false && nestedUnknown.error === 'mailbox_scope_invalid',
        nestedSer,
      );
      ok(
        'probe: unknown nested key name absent from serialized error',
        !nestedSer.includes(hostileNested) && !nestedSer.includes('planted'),
        nestedSer,
      );

      const secretUnknown = evaluate(baseDeclaration({
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['tenant_id', 'client_id', 'client_secret'],
          [hostileNested]: LEAK_PASSWORD,
        },
      }));
      const secretUnkSer = serializeSafe(secretUnknown);
      ok(
        'probe: unknown secret_package key fails closed',
        secretUnknown.ok === false && secretUnknown.error === 'secret_package_invalid',
        secretUnkSer,
      );
      ok(
        'probe: unknown secret_package key/value absent from error',
        !secretUnkSer.includes(hostileNested)
          && !secretUnkSer.includes(LEAK_PASSWORD)
          && !secretUnkSer.includes(VALID_SECRET_REF),
        secretUnkSer,
      );

      // Forbidden credential keys: no raw value, no requirement to echo key name
      const forbid = evaluate(baseDeclaration({ access_token: 'planted-token-VALUE-99' }));
      const forbidSer = serializeSafe(forbid);
      ok(
        'probe: forbidden field fails closed',
        forbid.ok === false && forbid.error === 'declaration_forbidden_field',
        forbidSer,
      );
      ok(
        'probe: forbidden field raw value absent',
        !forbidSer.includes('planted-token-VALUE-99'),
        forbidSer,
      );

      // Repeat calls produce fresh independent objects
      ok(
        'probe: repeat success calls return fresh wrappers',
        okA !== okB && okA.value !== okB.value,
      );
      ok(
        'probe: repeat success nested objects fresh',
        okA.ok && okB.ok
          && okA.value.mailbox_scope !== okB.value.mailbox_scope
          && okA.value.secret_package !== okB.value.secret_package
          && okA.value.entra_application_permission_set !== okB.value.entra_application_permission_set
          && okA.value.graph_permission_via_exchange_rbac !== okB.value.graph_permission_via_exchange_rbac
          && okA.value.missing_requirements !== okB.value.missing_requirements,
      );
      ok(
        'probe: repeat fail calls return fresh wrappers',
        failA !== failB,
      );
      if (failA.details && failB.details) {
        ok(
          'probe: repeat fail details fresh',
          failA.details !== failB.details,
        );
      }

      // Helper agreement preserved across complete / incomplete / invalid
      ok(
        'probe: helper agrees complete-valid',
        isComplete(baseDeclaration()) === true
          && evaluate(baseDeclaration()).ok === true
          && evaluate(baseDeclaration()).value.ready_for_human_authorized_live_prerequisite_check === true,
      );
      ok(
        'probe: helper agrees incomplete admin consent',
        isComplete(baseDeclaration({ admin_consent_confirmed: false })) === false
          && evaluate(baseDeclaration({ admin_consent_confirmed: false })).ok === true
          && evaluate(baseDeclaration({ admin_consent_confirmed: false }))
            .value.ready_for_human_authorized_live_prerequisite_check === false,
      );
      ok(
        'probe: helper agrees invalid permissions',
        isComplete(baseDeclaration({ entra_application_permission_set: ['Mail.Read'] })) === false
          && evaluate(baseDeclaration({ entra_application_permission_set: ['Mail.Read'] })).ok === false,
      );
      ok(
        'probe: helper agrees invalid secret_ref',
        isComplete(baseDeclaration({
          secret_package: {
            secret_ref: LEAK_PASSWORD,
            material_keys: ['tenant_id', 'client_id', 'client_secret'],
          },
        })) === false,
      );
    }

    // ── Hostile Proxy reflection traps (getPrototypeOf / ownKeys / gOPD) ─
    // Public evaluator must never throw; catch-all returns stable
    // declaration_invalid / reflection_failed without planted markers.
    {
      const REFLECTION_MARKER = 'PLANTED_REFLECTION_MARKER_xyz99';

      function assertDeepFrozenNode(node, path, acc) {
        if (node === null || typeof node !== 'object') return;
        if (!Object.isFrozen(node)) acc.push(path);
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i += 1) {
            assertDeepFrozenNode(node[i], `${path}[${i}]`, acc);
          }
          return;
        }
        for (const k of Object.keys(node)) {
          assertDeepFrozenNode(node[k], `${path}.${k}`, acc);
        }
      }

      function throwingProxy(target, label, which) {
        const traps = {};
        const trapNames = which && which.length
          ? which
          : ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'];
        for (const name of trapNames) {
          traps[name] = function hostileReflectionTrap() {
            throw new Error(`${REFLECTION_MARKER}:${label}:${name}`);
          };
        }
        return new Proxy(target, traps);
      }

      function assertReflectionFail(name, input) {
        let threw = false;
        let result = null;
        try {
          result = evaluate(input);
        } catch (err) {
          threw = true;
          result = err;
        }
        ok(
          `proxy reflection ${name}: evaluator no throw`,
          threw === false,
          threw ? String(result && result.message ? result.message : result) : '',
        );
        if (threw) return;

        const ser = serializeSafe(result);
        const unfrozen = [];
        assertDeepFrozenNode(result, 'result', unfrozen);
        ok(
          `proxy reflection ${name}: stable fail envelope`,
          result
            && result.ok === false
            && result.error === 'declaration_invalid'
            && result.details
            && result.details.reason === 'reflection_failed',
          ser,
        );
        ok(
          `proxy reflection ${name}: deeply frozen`,
          unfrozen.length === 0 && Object.isFrozen(result),
          unfrozen.join(','),
        );
        ok(
          `proxy reflection ${name}: serialized has no planted marker`,
          !ser.includes(REFLECTION_MARKER)
            && !ser.includes('getPrototypeOf')
            && !ser.includes('getOwnPropertyDescriptor'),
          ser,
        );
        // Never leak err/message/input/key fields
        ok(
          `proxy reflection ${name}: no err/message/input leakage fields`,
          !Object.prototype.hasOwnProperty.call(result, 'message')
            && !Object.prototype.hasOwnProperty.call(result, 'err')
            && !Object.prototype.hasOwnProperty.call(result, 'input')
            && !(result.details && Object.prototype.hasOwnProperty.call(result.details, 'message'))
            && !(result.details && Object.prototype.hasOwnProperty.call(result.details, 'err'))
            && !(result.details && Object.prototype.hasOwnProperty.call(result.details, 'key')),
          ser,
        );

        let helperThrew = false;
        let helperResult = null;
        try {
          helperResult = isComplete(input);
        } catch (err) {
          helperThrew = true;
          helperResult = err;
        }
        ok(
          `proxy reflection ${name}: helper no throw`,
          helperThrew === false,
          helperThrew ? String(helperResult && helperResult.message) : '',
        );
        ok(
          `proxy reflection ${name}: helper false`,
          helperThrew === false && helperResult === false,
          String(helperResult),
        );
      }

      // Single-trap variants at top level
      for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
        assertReflectionFail(
          `top/${trapName}`,
          throwingProxy(baseDeclaration(), `top-${trapName}`, [trapName]),
        );
      }
      // Combined traps at top level
      assertReflectionFail(
        'top/all-traps',
        throwingProxy(baseDeclaration(), 'top-all'),
      );

      // Nested entra_application_permission_set (non-empty array target so index
      // getOwnPropertyDescriptor is exercised; empty array would skip index reads).
      assertReflectionFail(
        'nested/entra_application_permission_set',
        baseDeclaration({
          entra_application_permission_set: throwingProxy(
            ['Mail.ReadBasic.All'],
            'entra_application_permission_set',
          ),
        }),
      );
      for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
        assertReflectionFail(
          `nested/entra_application_permission_set/${trapName}`,
          baseDeclaration({
            entra_application_permission_set: throwingProxy(
              ['Mail.ReadBasic.All'],
              `entra_application_permission_set-${trapName}`,
              [trapName],
            ),
          }),
        );
      }

      // Nested mailbox_scope object
      assertReflectionFail(
        'nested/mailbox_scope',
        baseDeclaration({
          mailbox_scope: throwingProxy(
            {
              mechanism: 'exchange_online_rbac_for_applications',
              allowed_public_addresses: ['support@lunafrontdesk.com'],
            },
            'mailbox_scope',
          ),
        }),
      );
      for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
        assertReflectionFail(
          `nested/mailbox_scope/${trapName}`,
          baseDeclaration({
            mailbox_scope: throwingProxy(
              {
                mechanism: 'exchange_online_rbac_for_applications',
                allowed_public_addresses: ['support@lunafrontdesk.com'],
              },
              `mailbox_scope-${trapName}`,
              [trapName],
            ),
          }),
        );
      }

      // Nested addresses array
      assertReflectionFail(
        'nested/addresses',
        baseDeclaration({
          mailbox_scope: {
            mechanism: 'exchange_online_rbac_for_applications',
            allowed_public_addresses: throwingProxy(
              ['support@lunafrontdesk.com'],
              'addresses',
            ),
          },
        }),
      );
      for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
        assertReflectionFail(
          `nested/addresses/${trapName}`,
          baseDeclaration({
            mailbox_scope: {
              mechanism: 'exchange_online_rbac_for_applications',
              allowed_public_addresses: throwingProxy(
                ['support@lunafrontdesk.com'],
                `addresses-${trapName}`,
                [trapName],
              ),
            },
          }),
        );
      }

      // Nested secret_package object
      assertReflectionFail(
        'nested/secret_package',
        baseDeclaration({
          secret_package: throwingProxy(
            {
              secret_ref: VALID_SECRET_REF,
              material_keys: ['tenant_id', 'client_id', 'client_secret'],
            },
            'secret_package',
          ),
        }),
      );
      for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
        assertReflectionFail(
          `nested/secret_package/${trapName}`,
          baseDeclaration({
            secret_package: throwingProxy(
              {
                secret_ref: VALID_SECRET_REF,
                material_keys: ['tenant_id', 'client_id', 'client_secret'],
              },
              `secret_package-${trapName}`,
              [trapName],
            ),
          }),
        );
      }

      // Nested material_keys array
      assertReflectionFail(
        'nested/material_keys',
        baseDeclaration({
          secret_package: {
            secret_ref: VALID_SECRET_REF,
            material_keys: throwingProxy(
              ['tenant_id', 'client_id', 'client_secret'],
              'material_keys',
            ),
          },
        }),
      );
      for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
        assertReflectionFail(
          `nested/material_keys/${trapName}`,
          baseDeclaration({
            secret_package: {
              secret_ref: VALID_SECRET_REF,
              material_keys: throwingProxy(
                ['tenant_id', 'client_id', 'client_secret'],
                `material_keys-${trapName}`,
                [trapName],
              ),
            },
          }),
        );
      }

      // Revoked proxies (TypeError on almost any operation)
      {
        const { proxy: revokedTop, revoke: revokeTop } = Proxy.revocable(baseDeclaration(), {});
        revokeTop();
        assertReflectionFail('revoked/top', revokedTop);

        const { proxy: revokedArr, revoke: revokeArr } = Proxy.revocable(
          ['Mail.ReadBasic.All'],
          {},
        );
        revokeArr();
        assertReflectionFail(
          'revoked/entra_application_permission_set',
          baseDeclaration({ entra_application_permission_set: revokedArr }),
        );

        const { proxy: revokedScope, revoke: revokeScope } = Proxy.revocable(
          {
            mechanism: 'exchange_online_rbac_for_applications',
            allowed_public_addresses: ['support@lunafrontdesk.com'],
          },
          {},
        );
        revokeScope();
        assertReflectionFail(
          'revoked/mailbox_scope',
          baseDeclaration({ mailbox_scope: revokedScope }),
        );

        const { proxy: revokedPkg, revoke: revokePkg } = Proxy.revocable(
          {
            secret_ref: VALID_SECRET_REF,
            material_keys: ['tenant_id', 'client_id', 'client_secret'],
          },
          {},
        );
        revokePkg();
        assertReflectionFail(
          'revoked/secret_package',
          baseDeclaration({ secret_package: revokedPkg }),
        );
      }

      // Ordinary plain declaration still succeeds (policy unchanged)
      {
        const plain = evaluate(baseDeclaration());
        ok(
          'proxy reflection: ordinary plain declaration still complete-valid',
          plain.ok === true
            && plain.value
            && plain.value.ready_for_human_authorized_live_prerequisite_check === true,
          serializeSafe(plain),
        );
        ok(
          'proxy reflection: ordinary helper still true',
          isComplete(baseDeclaration()) === true,
        );
      }
    }


    // ── Migration / compatibility: reject legacy AAP + unscoped Entra ────
    {
      // Full legacy Slice 2B declaration shape (permission_set + AAP)
      const legacyFull = {
        provider: 'microsoft_graph',
        auth_mode: 'application_client_credentials',
        permission_set: ['Mail.ReadBasic.All'],
        admin_consent_confirmed: true,
        mailbox_scope: {
          mechanism: 'application_access_policy',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
        },
        secret_package: {
          secret_ref: VALID_SECRET_REF,
          material_keys: ['tenant_id', 'client_id', 'client_secret'],
        },
        network_enabled: false,
        registry_activation_enabled: false,
        inbound_enabled: false,
        outbound_enabled: false,
        default_automation_mode: 'off',
      };
      const legacyResult = evaluate(legacyFull);
      ok(
        'migration: full legacy AAP+Mail.ReadBasic.All declaration rejected',
        legacyResult.ok === false
          && (legacyResult.error === 'declaration_legacy_field'
            || legacyResult.error === 'declaration_unknown_key'
            || legacyResult.error === 'declaration_missing_key'
            || legacyResult.error === 'mailbox_scope_invalid'),
        serializeSafe(legacyResult),
      );
      ok(
        'migration: legacy full isComplete false',
        isComplete(legacyFull) === false,
      );

      // Legacy permission_set key only on otherwise current shape
      const withLegacyPermKey = baseDeclaration({
        permission_set: ['Mail.ReadBasic.All'],
      });
      const legPerm = evaluate(withLegacyPermKey);
      ok(
        'migration: legacy permission_set key rejected',
        legPerm.ok === false
          && (legPerm.error === 'declaration_legacy_field'
            || legPerm.error === 'declaration_unknown_key'),
        serializeSafe(legPerm),
      );

      // Mixed: EXO RBAC mechanism + non-empty Entra unscoped grants
      const mixedUnscoped = baseDeclaration({
        entra_application_permission_set: ['Mail.ReadBasic.All'],
      });
      const mixedR = evaluate(mixedUnscoped);
      ok(
        'migration: mixed EXO RBAC + unscoped Entra Mail.ReadBasic.All rejected',
        mixedR.ok === false
          && mixedR.error === 'entra_application_permission_set_invalid',
        serializeSafe(mixedR),
      );

      // Mixed: EXO role present but legacy AAP mechanism
      const mixedAap = baseDeclaration({
        mailbox_scope: {
          mechanism: 'application_access_policy',
          allowed_public_addresses: ['support@lunafrontdesk.com'],
        },
      });
      const mixedAapR = evaluate(mixedAap);
      ok(
        'migration: mixed EXO role + legacy AAP mechanism rejected',
        mixedAapR.ok === false
          && mixedAapR.error === 'mailbox_scope_invalid'
          && mixedAapR.details
          && mixedAapR.details.reason === 'legacy_application_access_policy',
        serializeSafe(mixedAapR),
      );

      // Mixed: broader EXO role + empty Entra (still reject broader role)
      const broaderRole = evaluate(baseDeclaration({
        exchange_application_role: 'Application Mail.Read',
      }));
      ok(
        'migration: broader Application Mail.Read rejected even with empty Entra',
        broaderRole.ok === false
          && broaderRole.error === 'exchange_application_role_invalid',
        serializeSafe(broaderRole),
      );

      // Mixed: EXO RBAC + Mail.Read Entra (union would defeat scope)
      const mixedRead = evaluate(baseDeclaration({
        entra_application_permission_set: ['Mail.Read'],
      }));
      ok(
        'migration: EXO RBAC + Entra Mail.Read rejected (scope-defeating union)',
        mixedRead.ok === false
          && mixedRead.error === 'entra_application_permission_set_invalid',
        serializeSafe(mixedRead),
      );

      // Current complete declaration still accepted
      ok(
        'migration: current EXO RBAC empty-Entra declaration still complete',
        isComplete(baseDeclaration()) === true,
      );
    }

    // ── Network hits must stay zero ──────────────────────────────────────
    ok('runtime network guards never triggered', networkHits === 0, `hits=${networkHits}`);

    // Touch evaluate many times still no network
    for (let i = 0; i < 5; i += 1) {
      evaluate(baseDeclaration());
      evaluate(baseDeclaration({ admin_consent_confirmed: false }));
      evaluate(baseDeclaration({ entra_application_permission_set: ['Mail.Read'] }));
    }
    ok('repeated evaluate still zero network hits', networkHits === 0, `hits=${networkHits}`);
  } finally {
    restoreNetworkGuards();
  }

  console.log(`\n── verify:email-graph-app-only-readiness ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
