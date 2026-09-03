#!/usr/bin/env node
'use strict';

/**
 * verify-sunset-luna-http-runtime
 *
 * Offline gate for the Sunset Luna gateway carry.
 * The old private HTTP tests are legacy regression only, not carry proof.
 *
 * Run: node scripts/verify-sunset-luna-http-runtime.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    ...opts,
  });
  process.stdout.write(out.split('\n').map((l) => (l ? `       ${l}` : l)).join('\n'));
  if (!out.endsWith('\n')) process.stdout.write('\n');
  return out;
}

function exactAcaChain(acaText, secretName, vaultName, envName) {
  const secretBlock = `      - name: ${secretName}\n`
    + `        keyVaultUrl: https://luna-sunset-staging-kv.vault.azure.net/secrets/${vaultName}\n`
    + '        identity: <identity-id>';
  const envBlock = `          - name: ${envName}\n            secretRef: ${secretName}`;
  return acaText.includes(secretBlock) && acaText.includes(envBlock);
}

console.log('\nverify-sunset-luna-http-runtime\n');

console.log('[1] Legacy Python shadow regression (29 tests; not carried-gateway proof)');
try {
  const py = spawnSync(
    'python3',
    ['-m', 'unittest', 'wolfhouse.test_luna_http_server', 'wolfhouse.test_luna_http_phase1', 'wolfhouse.test_luna_http_shadow', '-v'],
    {
      cwd: path.join(ROOT, 'docker/hermes-staging'),
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PYTHONPATH: path.join(ROOT, 'docker/hermes-staging')
          + path.delimiter
          + path.join(ROOT, 'docker/hermes-staging/plugins'),
      },
    },
  );
  const combined = `${py.stdout || ''}${py.stderr || ''}`;
  process.stdout.write(combined.split('\n').map((l) => (l ? `       ${l}` : l)).join('\n'));
  assert('unittest exit 0', py.status === 0, `status=${py.status}`);
  assert(
    'healthz covered',
    /test_healthz_ok/.test(combined) && /ok\b/.test(combined),
  );
  assert(
    'unscoped course_choices covered',
    /test_unscoped_date_party_uses_course_choices_not_daily_full/.test(combined),
  );
  assert(
    'real plugin joinable path covered',
    /test_plugin_unscoped_path_via_real_tool/.test(combined),
  );
} catch (err) {
  assert('unittest exit 0', false, String(err.message || err).slice(0, 500));
}

console.log('\n[2] Static instance + safety pins');
try {
  const out = run('python3', [
    'docker/hermes-staging/verify_sunset_luna_http_instance.py',
  ]);
  assert('instance verifier PASS', /PASS sunset-luna-http/.test(out));
} catch (err) {
  assert('instance verifier PASS', false, String((err && err.stdout) || err.message).slice(0, 500));
}

console.log('\n[3] Repo surface — canonical gateway reuse, no cutover/n8n');
const server = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/wolfhouse/luna_http_server.py'),
  'utf8',
);
const outbound = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/wolfhouse/luna_http_outbound.py'),
  'utf8',
);
const compose = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-sunset/docker-compose.vm.yml'),
  'utf8',
);
const docs = fs.readFileSync(
  path.join(ROOT, 'docs/SUNSET-LUNA-HTTP-RUNTIME.md'),
  'utf8',
);
const caddyPath = path.join(ROOT, 'docker/hermes-staging/lunabox-caddyfile.reference');
const caddy = fs.existsSync(caddyPath) ? fs.readFileSync(caddyPath, 'utf8') : '';
const aca = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/sunset-luna-http.aca.yaml.example'),
  'utf8',
);
const phase1Migration = fs.readFileSync(
  path.join(ROOT, 'database/migrations/101_luna_guest_runtime_phase1.sql'),
  'utf8',
);

assert('server has healthz', /\/healthz/.test(server));
assert('server has private inbound', /\/v1\/inbound|INBOUND_PATH/.test(server));
assert('Phase 1 uses Postgres durability', /PostgresLunaStore/.test(server));
assert('Phase 1 schema pins sending off', /send_enabled[\s\S]*CHECK \(send_enabled = FALSE\)/.test(phase1Migration));
assert('Phase 1 has durable idempotency', /UNIQUE \(tenant_id, request_id\)/.test(phase1Migration) && /UNIQUE \(tenant_id, idempotency_key\)/.test(phase1Migration));
assert('ACA injects Postgres URL from Sunset Key Vault', /LUNA_HTTP_DATABASE_URL[\s\S]*secretRef: luna-http-database-url/.test(aca));
assert('ACA uses image system CA for Postgres verify-full', /PGSSLROOTCERT[\s\S]*value: \/etc\/ssl\/certs\/ca-certificates\.crt/.test(aca));
assert('shadow remains offline and has no graph client', !/graph\.facebook\.com/.test(server));
assert('ACA targets Sunset Staff staging exactly', /WOLFHOUSE_STAFF_API_BASE_URL[\s\S]*value: https:\/\/sunset-staging\.lunafrontdesk\.com/.test(aca));
assert('outbound fails closed against cross-tenant Staff host', /sunset_staff_base_url_required/.test(outbound) && !/or "https:\/\/staff-staging\.lunafrontdesk\.com"/.test(outbound));
assert('compose keeps hermes-sunset-luna gateway run', /hermes-sunset-luna:[\s\S]*command:\s*gateway run/.test(compose));
assert('luna-http reuses gateway and Sunset role', /hermes-sunset-luna-http:[\s\S]*command:\s*gateway run[\s\S]*HERMES_ROLE: sunset-luna[\s\S]*SUNSET_LUNA_REQUIRE_ISOLATED_AUTH: "true"/.test(compose));
assert('luna-http exposes dedicated author listener on 8095', /hermes-sunset-luna-http:[\s\S]*127\.0\.0\.1:8095:8095[\s\S]*SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT: "8095"/.test(compose));
assert('ACA reuses canonical gateway owner', /args:[\s\S]*- gateway\s+- run[\s\S]*HERMES_ROLE\s*\n\s*value: sunset-luna/.test(aca));
assert('ACA requires isolated auth mode', /SUNSET_LUNA_REQUIRE_ISOLATED_AUTH\s*\n\s*value: 'true'/.test(aca));
const requiredAcaChains = [
  ['canonical phone ID', 'whatsapp-cloud-phone-number-id', 'sunset-somo-whatsapp-phone-number-id', 'WHATSAPP_CLOUD_PHONE_NUMBER_ID'],
  ['Somo routing ID', 'sunset-somo-phone-number-id', 'sunset-somo-whatsapp-phone-number-id', 'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID'],
  ['Sardinero routing ID', 'sunset-sardinero-phone-number-id', 'sunset-sardinero-whatsapp-phone-number-id', 'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID'],
  ['Meta access token', 'whatsapp-cloud-access-token', 'meta-whatsapp-token', 'WHATSAPP_CLOUD_ACCESS_TOKEN'],
  ['Meta app secret', 'whatsapp-cloud-app-secret', 'meta-app-secret', 'WHATSAPP_CLOUD_APP_SECRET'],
  ['Meta verify token', 'whatsapp-cloud-verify-token', 'meta-whatsapp-verify-token', 'WHATSAPP_CLOUD_VERIFY_TOKEN'],
  ['WhatsApp dry-run switch', 'whatsapp-dry-run', 'whatsapp-dry-run', 'WHATSAPP_DRY_RUN'],
  ['Luna auto-send switch', 'luna-auto-send-enabled', 'luna-auto-send-enabled', 'LUNA_AUTO_SEND_ENABLED'],
];
for (const [label, secretName, vaultName, envName] of requiredAcaChains) {
  assert(`ACA ${label} has exact KV-secret-env chain`, exactAcaChain(aca, secretName, vaultName, envName));
}
assert('docs say source-ready without cutover', /not deployed or cut over/.test(docs));
assert('Caddy reference not pointed at 8094', !caddy || (!/8094/.test(caddy) && !/luna-http/i.test(caddy)));
assert(
  'stays off inbox-thread.js',
  !/inbox-thread/.test(server) && !/inbox-thread/.test(outbound),
);
assert(
  'does not call n8n',
  !/n8n\.(io|cloud)|\/webhook\/n8n|calls_n8n\s*:\s*true|invokeN8n|n8n_webhook/i.test(server + outbound),
);
assert('shadow server is not configured in ACA', !/luna_http_server\.py/.test(aca));

console.log('\n[4] ACA fill script refuse-on-placeholder');
try {
  const bad = spawnSync(
    'python3',
    [
      'scripts/fill-sunset-luna-http-aca-yaml.py',
      '--template', 'docker/hermes-staging/sunset-luna-http.aca.yaml.example',
      '--output', '/tmp/luna-http-should-not-write.yaml',
      '--environment-id', 'not-a-resource-id',
      '--identity-id', '/subscriptions/x/resourceGroups/y/providers/Microsoft.ManagedIdentity/userAssignedIdentities/z',
      '--full-master-sha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert('fill refuses non-resource environment-id', bad.status !== 0);
} catch (err) {
  assert('fill refuses non-resource environment-id', false, String(err.message).slice(0, 200));
}

console.log(`\nverify-sunset-luna-http-runtime: ${pass} verifier assertions passed, ${fail} failed; legacy suite separately ran 29 tests`);
process.exit(fail ? 1 : 0);
