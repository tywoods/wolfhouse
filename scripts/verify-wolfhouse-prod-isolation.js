'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const compose = read('deploy/wolfhouse-prod/compose.yaml');
const env = read('deploy/wolfhouse-prod/env.example');
const ingress = read('deploy/wolfhouse-prod/ingress.conf');
const manifest = JSON.parse(read('deploy/wolfhouse-prod/release-manifest.json'));
const runbook = read('deploy/wolfhouse-prod/runbooks.md');
const evidence = read('docs/prod/wolfhouse-release-evidence.md');
let n = 0;
function ok(name, fn) { fn(); n += 1; console.log(`PASS ${name}`); }
ok('isolated project and owned resources', () => {
  assert.match(compose, /^name: wolfhouse-prod$/m);
  for (const s of ['wolfhouse-prod-postgres','wolfhouse-prod-staff-api','wolfhouse-prod-luna','wolfhouse-prod-ingress','wolfhouse-prod-private','wolfhouse-prod-postgres-data','wolfhouse-prod-luna-data']) assert.ok(compose.includes(s), s);
});
ok('required memory caps and no extra swap', () => {
  assert.match(compose, /luna:[\s\S]*?mem_limit: 1536m[\s\S]*?memswap_limit: 1536m/);
  assert.match(compose, /staff-api:[\s\S]*?mem_limit: 768m[\s\S]*?memswap_limit: 768m/);
  assert.match(compose, /postgres:[\s\S]*?mem_limit: 1024m[\s\S]*?memswap_limit: 1024m/);
});
ok('private ingress and network', () => {
  assert.match(compose, /127\.0\.0\.1:\$\{WOLFHOUSE_PROD_INGRESS_PORT:-18080\}:8080/);
  assert.match(compose, /wolfhouse_prod_private:[\s\S]*?internal: true/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:\$\{WOLFHOUSE_PROD_INGRESS_PORT/);
});
ok('immutable image contract', () => {
  for (const key of ['STAFF_API_IMAGE','LUNA_IMAGE','POSTGRES_IMAGE','NGINX_IMAGE']) {
    assert.ok(compose.includes(`\${${key}:?`));
    assert.match(env, new RegExp(`^${key}=.*@sha256:(?:<64-hex-digest>|[a-f0-9]{64})$`, 'm'));
  }
  assert.doesNotMatch(compose, /image:\s*[^\n]*:latest/);
});
ok('Classic-only and outbound fail closed', () => {
  assert.doesNotMatch(compose + runbook, /crowsnest/i);
  assert.match(compose, /WHATSAPP_DRY_RUN: 'true'/);
  assert.match(compose, /LUNA_AUTO_SEND_ENABLED: 'false'/);
  assert.match(compose, /CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false'/);
  assert.match(compose, /STRIPE_MODE: test/);
});
ok('approved hostnames only', () => {
  assert.match(ingress, /server_name admin\.wolf-house\.com wh\.lunafrontdesk\.com;/);
  assert.doesNotMatch(ingress, /staff\.lunafrontdesk\.com/);
  assert.equal(manifest.hostnames.primary, 'admin.wolf-house.com');
});
ok('accepted source and honest pending evidence', () => {
  assert.equal(manifest.sourceSha, '577a15e3726d40a5294ab65c4b427b62afbd38c4');
  assert.match(manifest.build.staffApiImage, /^luna-local\/wh-staff-api@sha256:[a-f0-9]{64}$/);
  assert.match(manifest.build.lunaImage, /^luna-local\/hermes-luna@sha256:[a-f0-9]{64}$/);
  assert.match(manifest.runtimeImages.postgres, /^postgres@sha256:[a-f0-9]{64}$/);
  assert.match(manifest.runtimeImages.nginx, /^nginx@sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.hostSurvey.privateIngress, '127.0.0.1:18080');
  assert.equal(manifest.hostSurvey.privateIngressFree, true);
  assert.equal(manifest.hostSurvey.swapMiB, 0);
  assert.equal(manifest.hostLanding.status, 'not-started-captain-pass-required');
  assert.match(evidence, /independently re-verified/);
  assert.match(evidence, /BUILD_RC=0/);
  assert.doesNotMatch(evidence, /digest pending/);
});
ok('prohibited actions documented', () => {
  for (const term of ['No DNS edit','gateway restart','swap change','prune','outbound send','Oracle mutation']) assert.ok(evidence.includes(term), term);
  assert.match(runbook, /No host landing before exact-head Captain PASS/);
});
console.log(`\nRESULT: ${n}/${n} checks passed`);
