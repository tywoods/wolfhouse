'use strict';

/**
 * verify:monshies-boundaries
 *
 * Offline guard: Monshies Admin Hermes profile stays isolated from Luna guest
 * booking (no Staff API plugins, no WhatsApp patches, separate compose service).
 *
 * Run: node scripts/verify-monshies-boundaries.js
 *      npm run verify:monshies-boundaries
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BOOTSTRAP = path.join(ROOT, 'docker', 'hermes-staging', 'bootstrap.sh');
const COMPOSE = path.join(ROOT, 'docker', 'hermes-staging', 'docker-compose.vm.yml');
const SOUL = path.join(ROOT, 'docker', 'hermes-staging', 'monshies-admin-SOUL.md');
const DOCS = path.join(ROOT, 'docs', 'MONSHIES-ADMIN.md');
const PKG = path.join(ROOT, 'package.json');

let pass = 0;
let fail = 0;

function assert(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function main() {
  console.log('\nverify:monshies-boundaries — Monshies Admin isolation guard\n');

  assert('bootstrap.sh exists', fs.existsSync(BOOTSTRAP));
  assert('docker-compose.vm.yml exists', fs.existsSync(COMPOSE));
  assert('monshies-admin-SOUL.md exists', fs.existsSync(SOUL));
  assert('docs/MONSHIES-ADMIN.md exists', fs.existsSync(DOCS));

  const bootstrap = read(BOOTSTRAP);
  const compose = read(COMPOSE);
  const soul = read(SOUL);
  const docs = read(DOCS);
  const pkg = JSON.parse(read(PKG));

  assert('bootstrap documents HERMES_ROLE=monshies-admin',
    bootstrap.includes('HERMES_ROLE=monshies-admin'));
  assert('bootstrap defines STAGING_MONSHIES_SOUL',
    bootstrap.includes('STAGING_MONSHIES_SOUL="/etc/hermes-staging/monshies-admin-SOUL.md"'));
  assert('bootstrap defines write_monshies_config',
    bootstrap.includes('write_monshies_config()'));
  assert('bootstrap branches on monshies-admin role',
    /\[ "\$HERMES_ROLE" = "monshies-admin" \]/.test(bootstrap));
  assert('monshies branch copies monshies SOUL',
    bootstrap.includes('cp "$STAGING_MONSHIES_SOUL" "$HERMES_HOME/SOUL.md"'));

  const monshiesBlock = bootstrap.split('write_monshies_config()')[1]?.split('write_monshies_env()')[0] || '';
  assert('monshies config has no wolfhouse_staff_api toolset',
    !monshiesBlock.includes('wolfhouse_staff_api'));
  assert('monshies config disables memory',
    monshiesBlock.includes('memory_enabled: false'));

  const afterMonshies = bootstrap.split('elif [ "$HERMES_ROLE" = "monshies-admin" ]; then')[1] || '';
  const monshiesBranch = afterMonshies.split('else')[0] || '';
  assert('monshies branch does not install Luna plugins',
    !monshiesBranch.includes('install_luna_plugins'));
  assert('monshies branch does not run WhatsApp apply_patches',
    !monshiesBranch.includes('apply_patches'));

  assert('compose defines hermes-monshies-admin service',
    compose.includes('hermes-monshies-admin:'));
  assert('compose sets HERMES_ROLE monshies-admin',
    /HERMES_ROLE:\s*monshies-admin/.test(compose));
  assert('compose uses separate data volume',
    compose.includes('/var/lib/hermes-monshies-admin:/opt/data'));
  assert('compose exposes API port 8643',
    compose.includes('"8643:8643"'));
  assert('compose uses monshies env file',
    compose.includes('/etc/hermes-monshies-admin.env'));

  assert('SOUL forbids Luna guest SOUL edits by default',
    /Do \*\*not\*\* edit Luna guest SOUL/.test(soul));
  assert('SOUL forbids Staff API deploy',
    /Do \*\*not\*\* deploy Staff API/.test(soul));
  assert('SOUL references verify-monshies-boundaries',
    soul.includes('verify-monshies-boundaries.js'));
  assert('SOUL references verify:sunset-admin',
    soul.includes('verify:sunset-admin'));

  assert('docs describe isolated third container',
    docs.includes('hermes-monshies-admin'));
  assert('docs reference bootstrap monshies-admin role',
    docs.includes('HERMES_ROLE=monshies-admin'));

  const scripts = pkg.scripts || {};
  assert('package.json defines verify:monshies-boundaries',
    scripts['verify:monshies-boundaries'] === 'node scripts/verify-monshies-boundaries.js');

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:monshies-boundaries — FAILED');
    process.exit(1);
  }
  console.log('verify:monshies-boundaries — ALL CHECKS PASSED');
}

main();
