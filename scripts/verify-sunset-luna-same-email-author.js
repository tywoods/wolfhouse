#!/usr/bin/env node
'use strict';

/**
 * Offline gate: Sunset Staff email drafts are authored by hermes-sunset-luna-http
 * on live Lunabox :8094 through the existing Caddy /whatsapp/* route.
 *
 * Run: node scripts/verify-sunset-luna-same-email-author.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const {
  HERMES_SOL_RUNTIME,
  HERMES_SOL_ROLE,
  HERMES_SOL_DRAFT_PATH,
  HERMES_SOL_PROVIDER,
  HERMES_SOL_MODEL,
} = require('./lib/email-luna-sunset-email-hermes-sol-contract');
const {
  ACA_INTERNAL_HTTPS,
  LUNABOX_AUTHOR_HTTPS,
  LOCAL_PROOF_HTTP,
  isSunsetEmailHermesSolAuthorEnabled,
} = require('./lib/email-luna-sunset-email-hermes-sol-activation');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function extractService(compose, name) {
  const lines = compose.split('\n');
  const block = [];
  let collecting = false;
  const start = new RegExp(`^  ${name}:\\s*$`);
  const next = /^  [A-Za-z0-9_-]+:\s*$/;
  for (const line of lines) {
    if (start.test(line)) {
      collecting = true;
      block.push(line);
      continue;
    }
    if (collecting) {
      if (next.test(line)) break;
      block.push(line);
    }
  }
  return block.join('\n');
}

console.log('verify-sunset-luna-same-email-author');

assert.equal(HERMES_SOL_PROVIDER, 'openai-codex');
assert.equal(HERMES_SOL_MODEL, 'gpt-5.6-sol');
assert.equal(HERMES_SOL_RUNTIME, 'hermes-sunset-luna-http');
assert.equal(HERMES_SOL_ROLE, 'sunset-luna');
assert.equal(HERMES_SOL_DRAFT_PATH, '/whatsapp/v1/internal/email-draft-plan');
assert.notEqual(HERMES_SOL_RUNTIME, 'sunset-email-luna');

const compose = read('docker/hermes-sunset/docker-compose.vm.yml');
const http = extractService(compose, 'hermes-sunset-luna-http');
const old = extractService(compose, 'hermes-sunset-luna');
const email = extractService(compose, 'hermes-sunset-email-luna');
assert.match(http, /command:\s*gateway run/);
assert.match(http, /HERMES_ROLE:\s*sunset-luna/);
assert.match(http, /127\.0\.0\.1:8094:8094/);
assert.match(http, /127\.0\.0\.1:8095:8095/);
assert.match(http, /SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT:\s*"8095"/);
assert.match(http, /\/var\/lib\/hermes-sunset-luna-http:\/opt\/data/);
assert.doesNotMatch(old, /8095/);
assert.match(old, /8092:8092/);
assert.match(old, /command:\s*gateway run/);
assert.match(email, /email_draft_server\.py/);
assert.match(email, /HERMES_ROLE:\s*sunset-email-luna/);
assert.match(compose, /this container is Exited/);
assert.match(compose, /Live Sunset WhatsApp Luna/);
assert.match(compose, /Caddy \/whatsapp\/\* → 127\.0\.0\.1:8094/);

const aca = read('docker/hermes-staging/sunset-luna-http.aca.yaml.example');
const emailAca = read('docker/hermes-staging/sunset-email-luna.aca.yaml.example');
assert.match(aca, /targetPort:\s*8094/);
assert.doesNotMatch(aca, /EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET/);
assert.doesNotMatch(aca, /email-luna-hermes-sol-hmac/);
assert.doesNotMatch(aca, /SUNSET_LUNA_EMAIL_AUTHOR_LISTEN_PORT/);
assert.doesNotMatch(aca, /additionalPortMappings/);
assert.match(aca, /args:[\s\S]*- gateway\s+- run/);
assert.match(emailAca, /name: luna-sunset-staging-email-luna/);
assert.match(emailAca, /targetPort:\s*8093/);
assert.match(emailAca, /value: sunset-email-luna/);

const caddy = read('docker/hermes-staging/lunabox-caddyfile.reference');
assert.doesNotMatch(caddy, /8095/);
assert.doesNotMatch(caddy, /8094/);
assert.doesNotMatch(caddy, /luna-http/i);
assert.match(caddy, /reverse_proxy \/whatsapp\/\*/);

const docs = read('docs/SUNSET-LUNA-HTTP-RUNTIME.md');
assert.match(docs, /https:\/\/lunabox\.lunafrontdesk\.com\/whatsapp\/v1\/internal\/email-draft-plan/);
assert.match(docs, /8094 is Up|hermes-sunset-luna-http` is Up on `127\.0\.0\.1:8094/);
assert.match(docs, /8092.*Exited|Exited.*8092|hermes-sunset-luna:8092` is \*\*Exited\*\*/);
assert.match(docs, /Caddy `\/whatsapp\/\*` → `localhost:8094`/);
assert.doesNotMatch(docs, /luna-sunset-staging-luna-http\.internal/);
assert.match(docs, /not deployed or cut over/);

const sameLuna = read('docker/hermes-staging/wolfhouse/email_draft_same_luna.py');
assert.match(sameLuna, /\/whatsapp\/v1\/internal\/email-draft-plan/);
assert.match(sameLuna, /add_post\(SAME_LUNA_DRAFT_PATH/);
assert.doesNotMatch(sameLuna, /azurecontainerapps\.io/);

const ENV_AUTHOR_ENABLED = 'EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED';
const ENV_BASE_URL = 'EMAIL_LUNA_HERMES_SOL_BASE_URL';
const ENV_TOKEN = 'EMAIL_LUNA_HERMES_SOL_TOKEN';
const ENV_HMAC_SECRET = 'EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET';
function hermesEnv(port, extra) {
  const out = {
    LUNA_DEPLOYMENT: 'sunset-staging',
    [ENV_AUTHOR_ENABLED]: 'true',
    [ENV_BASE_URL]: `http://127.0.0.1:${port}`,
    [ENV_TOKEN]: 'token-token-token-token',
    [ENV_HMAC_SECRET]: 'hmac-hmac-hmac-hmac-hmac',
  };
  return Object.assign(out, extra || {});
}

const lunaboxOrigin = 'https://lunabox.lunafrontdesk.com';
const lunaboxAuthor = `${lunaboxOrigin}/whatsapp/v1/internal/email-draft-plan`;
const lunaHttpOrigin = 'https://luna-sunset-staging-luna-http.internal.redbeach-6a768db0.northeurope.azurecontainerapps.io';
const emailLunaOrigin = 'https://luna-sunset-staging-email-luna.internal.redbeach-6a768db0.northeurope.azurecontainerapps.io';
assert.equal(LUNABOX_AUTHOR_HTTPS.test(lunaboxOrigin), true, 'lunabox HTTPS is the Staff author allowlist');
assert.equal(ACA_INTERNAL_HTTPS.test(lunaboxOrigin), true);
assert.equal(LUNABOX_AUTHOR_HTTPS.test(lunaHttpOrigin), false, 'luna-http ACA is not the Staff author');
assert.equal(ACA_INTERNAL_HTTPS.test(lunaHttpOrigin), false, 'luna-http ACA is not the Staff author allowlist');
assert.equal(ACA_INTERNAL_HTTPS.test(emailLunaOrigin), false, 'email-luna ACA is no longer the Staff author owner');
assert.equal(LOCAL_PROOF_HTTP.test('http://127.0.0.1:8095'), true);
assert.equal(LOCAL_PROOF_HTTP.test('http://127.0.0.1:8094'), false);
assert.equal(isSunsetEmailHermesSolAuthorEnabled({
  env: hermesEnv(8095, { [ENV_BASE_URL]: lunaboxOrigin }),
}), true, 'lunabox origin is enabled');
assert.equal(isSunsetEmailHermesSolAuthorEnabled({
  env: hermesEnv(8095, { [ENV_BASE_URL]: lunaboxAuthor }),
}), true, 'exact lunabox origin/path is enabled');
assert.equal(isSunsetEmailHermesSolAuthorEnabled({
  env: hermesEnv(8095, { [ENV_BASE_URL]: `${lunaboxOrigin}/whatsapp/webhook` }),
}), false, 'webhook path is not the author path');
assert.equal(isSunsetEmailHermesSolAuthorEnabled({
  env: hermesEnv(8095, { [ENV_BASE_URL]: lunaHttpOrigin }),
}), false, 'retarget away from luna-http ACA');
assert.equal(isSunsetEmailHermesSolAuthorEnabled({
  env: hermesEnv(8095, { [ENV_BASE_URL]: emailLunaOrigin }),
}), false, 'retarget away from email-luna ACA');
assert.equal(isSunsetEmailHermesSolAuthorEnabled({
  env: hermesEnv(8095),
}), true, 'loopback :8095 remains enabled for Lunabox probe');

const openSrc = read('scripts/lib/staff-email-luna-draft-open.js');
const routeSrc = read('scripts/lib/staff-email-luna-draft-route.js');
const compositionSrc = read('scripts/lib/email-luna-sunset-staging-runtime-composition.js');
assert.match(openSrc, /hermes-sunset-luna-http/);
assert.match(routeSrc, /regenerateEmailLunaDraftOnStaffClick/);
assert.match(compositionSrc, /createEmailLunaSunsetEmailHermesSolAuthors/);
assert.doesNotMatch(openSrc, /LUNA_AI_MODEL/);
assert.doesNotMatch(routeSrc, /LUNA_AI_MODEL/);
assert.doesNotMatch(compositionSrc, /LUNA_AI_MODEL/);

const pause = read('docker/hermes-staging/wolfhouse/pause_gate.py');
assert.match(pause, /Sunset so it does not set ``bot_paused``/);
assert.doesNotMatch(pause, /payload\.get\("needs_human"\)/);

const py = spawnSync(
  'python3',
  ['-m', 'unittest', 'wolfhouse.test_email_draft_same_luna', '-v'],
  {
    cwd: path.join(ROOT, 'docker/hermes-staging'),
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, 'docker/hermes-staging'),
    },
  },
);
process.stdout.write(py.stdout || '');
process.stderr.write(py.stderr || '');
assert.equal(py.status, 0, 'python same-luna author tests');

console.log('PASS verify-sunset-luna-same-email-author');
