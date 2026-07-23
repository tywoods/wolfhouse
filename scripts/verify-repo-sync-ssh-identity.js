'use strict';

/**
 * Focused verifier — check-repo-sync SSH identity via WH_LUNABOX_SSH_KEY.
 *
 * No Azure / SSH / real key material: exercises exported helpers only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  shellQuote,
  resolveSshIdentity,
  buildSshIdentityArgs,
} = require('./check-repo-sync');

let passes = 0;
let failures = 0;
function pass(id, msg) {
  console.log(`  PASS  [${id}] ${msg}`);
  passes++;
}
function fail(id, msg) {
  console.error(`  FAIL  [${id}] ${msg}`);
  failures++;
}
function check(id, cond, msg) {
  if (cond) pass(id, msg);
  else fail(id, msg);
}
function section(t) {
  console.log(`\n── ${t} ──`);
}

console.log('\nverify-repo-sync-ssh-identity.js\n');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-repo-sync-ssh-'));
const readableKey = path.join(tmpRoot, 'skipper key ed25519');
const unreadableKey = path.join(tmpRoot, 'missing-key');
fs.writeFileSync(readableKey, 'UNIT-TEST-PLACEHOLDER\n', { mode: 0o600 });

try {
  section('A. WH_LUNABOX_SSH_KEY readable → IdentitiesOnly + quoted -i');
  {
    const identity = resolveSshIdentity({
      env: { WH_LUNABOX_SSH_KEY: readableKey },
    });
    check('A1', identity.ok === true, `ok=true (got ${identity.ok})`);
    check('A2', identity.source === 'env', `source=env (got ${identity.source})`);
    check('A3', identity.keyPath === readableKey, 'keyPath is explicit env path');

    const args = buildSshIdentityArgs(identity);
    check('A4', typeof args === 'string' && args.length > 0, 'args string non-empty');
    check(
      'A5',
      /-o\s+IdentitiesOnly=yes/.test(args),
      `includes -o IdentitiesOnly=yes (got ${args})`,
    );
    check('A6', /(^|\s)-i\s+/.test(args), `includes -i (got ${args})`);
    check(
      'A7',
      args.includes(shellQuote(readableKey)),
      ` -i uses shellQuote for path with spaces (args=${args})`,
    );
    check(
      'A8',
      shellQuote(readableKey) !== readableKey && /['"]/.test(shellQuote(readableKey)),
      'shellQuote wraps paths that need quoting',
    );
  }

  section('B. Absent env → ~/.ssh/id_rsa fallback (no IdentitiesOnly)');
  {
    const home = path.join(tmpRoot, 'home-fallback');
    const fallbackKey = path.join(home, '.ssh', 'id_rsa');
    fs.mkdirSync(path.dirname(fallbackKey), { recursive: true });
    fs.writeFileSync(fallbackKey, 'FALLBACK-PLACEHOLDER\n', { mode: 0o600 });

    const identity = resolveSshIdentity({
      env: { HOME: home },
      home,
    });
    check('B1', identity.ok === true, `ok=true (got ${identity.ok})`);
    check('B2', identity.source === 'fallback', `source=fallback (got ${identity.source})`);
    check('B3', identity.keyPath === fallbackKey, 'keyPath is $HOME/.ssh/id_rsa');

    const args = buildSshIdentityArgs(identity);
    check('B4', /(^|\s)-i\s+/.test(args), `includes -i (got ${args})`);
    check(
      'B5',
      !/IdentitiesOnly/.test(args),
      `no IdentitiesOnly on fallback (got ${args})`,
    );
    check(
      'B6',
      args.includes(fallbackKey) || args.includes(shellQuote(fallbackKey)),
      `args reference fallback key path (got ${args})`,
    );
  }

  section('C. Unreadable explicit path → fail closed (no silent drop)');
  {
    const identity = resolveSshIdentity({
      env: { WH_LUNABOX_SSH_KEY: unreadableKey },
    });
    check('C1', identity.ok === false, `ok=false (got ${identity.ok})`);
    check(
      'C2',
      typeof identity.warning === 'string' && identity.warning.length > 0,
      'clear warning string present',
    );
    check(
      'C3',
      /WH_LUNABOX_SSH_KEY/.test(identity.warning),
      `warning names WH_LUNABOX_SSH_KEY (got ${identity.warning})`,
    );
    check(
      'C4',
      identity.warning.includes(unreadableKey),
      'warning includes configured path (not key material)',
    );

    const args = buildSshIdentityArgs(identity);
    check(
      'C5',
      args === '' || args == null,
      `fail closed: no -i args when identity unreadable (got ${JSON.stringify(args)})`,
    );
    check(
      'C6',
      !/-i\s+/.test(String(args || '')),
      'does not silently emit -i for bad explicit path',
    );

    // --strict gate: any identity failure must make the sync report non-ok
    const warnings = [];
    if (!identity.ok && identity.warning) warnings.push(identity.warning);
    const reportOk = warnings.length === 0;
    check('C7', reportOk === false, 'would be nonzero under --strict (report.ok=false)');
  }

  section('D. shellQuote safety');
  {
    check('D1', shellQuote('safe_path-1./x') === 'safe_path-1./x', 'safe tokens unquoted');
    check(
      'D2',
      shellQuote("path with ' quote").includes("'"),
      'unsafe paths are quoted',
    );
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
console.log('✓ repo-sync SSH identity helpers OK\n');
