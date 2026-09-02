#!/usr/bin/env node
'use strict';

/**
 * verify-sunset-luna-http-runtime
 *
 * Offline gate for the additive Sunset Luna HTTP runtime (first slice).
 * - healthz + private inbound unit tests
 * - fake date+party uses joinable/course leftover (#844/#845), not daily-full
 * - WhatsApp / Caddy / Meta stay untouched
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

console.log('\nverify-sunset-luna-http-runtime\n');

console.log('[1] Python unit tests (healthz + first-answer joinable leftover)');
try {
  const py = spawnSync(
    'python3',
    ['-m', 'unittest', 'wolfhouse.test_luna_http_server', '-v'],
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

console.log('\n[3] Repo surface — no Meta cutover, no inbox-thread, no n8n');
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

assert('server has healthz', /\/healthz/.test(server));
assert('server has private inbound', /\/v1\/inbound|INBOUND_PATH/.test(server));
assert('no graph.facebook.com in server', !/graph\.facebook\.com/.test(server));
assert('outbound is Staff guest-reply-draft', /guest-reply-draft/.test(outbound));
assert('outbound forbids Meta Graph client', /never Meta Graph|No.*Graph/i.test(outbound));
assert('compose keeps hermes-sunset-luna gateway run', /hermes-sunset-luna:[\s\S]*command:\s*gateway run/.test(compose));
assert('compose adds profile-gated http service', /hermes-sunset-luna-http:[\s\S]*luna_http_server\.py/.test(compose));
assert('docs describe later Meta cutover only', /Later — Meta WhatsApp cutover/.test(docs) && /lunabox\.lunafrontdesk\.com\/whatsapp\/webhook/.test(docs));
assert('Caddy reference not pointed at 8094', !caddy || (!/8094/.test(caddy) && !/luna-http/i.test(caddy)));
assert(
  'stays off inbox-thread.js',
  !/inbox-thread/.test(server) && !/inbox-thread/.test(outbound),
);
assert(
  'does not call n8n',
  !/n8n\.(io|cloud)|\/webhook\/n8n|calls_n8n\s*:\s*true|invokeN8n|n8n_webhook/i.test(server + outbound),
);

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

console.log(`\nverify-sunset-luna-http-runtime: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
