'use strict';

/**
 * verify:booking-hold-expiry-cli-shutdown
 *
 * Focused proofs that hold-expiry CLI closes the shared pg pool and exits
 * without process.exit(0) hacks, while Staff API import does not auto-close.
 *
 * Run: node scripts/verify-booking-hold-expiry-cli-shutdown.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(__dirname, 'run-booking-hold-expiry.js');
const PG_PATH = path.join(__dirname, 'lib', 'pg-connect.js');
const API_PATH = path.join(__dirname, 'staff-query-api.js');

let pass = 0;
let fail = 0;

function assert(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
    if (detail) console.log(`        ${detail}`);
  }
}

function makeFakePool() {
  return {
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
    query() {
      return Promise.resolve({ rows: [] });
    },
    connect() {
      return Promise.resolve({
        query: async () => ({ rows: [] }),
        release() {},
      });
    },
  };
}

async function testClosePgPool() {
  console.log('\n[closePgPool]');
  // Fresh module instance so we do not disturb other tests' require cache state.
  const id = require.resolve('./lib/pg-connect');
  delete require.cache[id];
  const pg = require('./lib/pg-connect');

  await pg.closePgPool();
  assert('close on unopened pool is safe', true);

  const fake = makeFakePool();
  let timerFired = 0;
  const timer = setInterval(() => {
    timerFired += 1;
  }, 10);
  pg._setPoolForTests(fake, timer);

  await pg.closePgPool();
  await new Promise((r) => setTimeout(r, 40));
  assert('close ends open pool once', fake.endCalls === 1, `endCalls=${fake.endCalls}`);
  assert('close clears module pool', pg._getPoolForTests() === null);
  assert('close clears keep-alive timer', timerFired === 0, `timerFired=${timerFired}`);

  await pg.closePgPool();
  await pg.closePgPool();
  assert('repeated close is safe', fake.endCalls === 1, `endCalls=${fake.endCalls}`);

  delete require.cache[id];
}

async function testStaffApiDoesNotAutoClose() {
  console.log('\n[staff-api import safety]');
  const id = require.resolve('./lib/pg-connect');
  delete require.cache[id];
  const pg = require('./lib/pg-connect');
  const fake = makeFakePool();
  pg._setPoolForTests(fake, null);

  assert('staff-query-api does not reference closePgPool',
    !fs.readFileSync(API_PATH, 'utf8').includes('closePgPool'));

  // Requiring pg-connect (as Staff API does via withPgClient) must not close.
  await new Promise((r) => setTimeout(r, 20));
  assert('import/use path does not auto-close pool', fake.endCalls === 0, `endCalls=${fake.endCalls}`);
  assert('pool still installed for long-lived process', pg._getPoolForTests() === fake);

  pg._setPoolForTests(null, null);
  delete require.cache[id];
}

async function testCliSuccessClosesAndExitsNaturally() {
  console.log('\n[CLI success → close + natural exit]');
  const harness = path.join(__dirname, '_tmp-hold-expiry-shutdown-success.js');
  fs.writeFileSync(harness, `'use strict';
const { runHoldExpiryCli } = require('./run-booking-hold-expiry');
let closeCalls = 0;
runHoldExpiryCli(['--client=sunset'], {
  withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  closePgPool: async () => { closeCalls += 1; },
  expireDueBookingHolds: async () => ({
    scanned: 0, expired: 0, skipped_paid: 0, skipped_changed: 0,
    beds_released: 0, payments_invalidated: 0, errors: [],
  }),
  log: () => {},
  error: () => {},
}).then(() => {
  if (closeCalls !== 1) {
    console.error('closeCalls=' + closeCalls);
    process.exitCode = 2;
    return;
  }
  if (process.exitCode && process.exitCode !== 0) {
    console.error('unexpected exitCode=' + process.exitCode);
  }
  // No process.exit — event loop must drain naturally.
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`);

  const result = await spawnNode(harness, 8000);
  fs.unlinkSync(harness);
  assert('success CLI exits naturally with code 0', result.code === 0, `code=${result.code} err=${result.stderr}`);
  assert('success CLI closed pool before exit', result.code === 0);
}

async function testCliErrorClosesAndNonzero() {
  console.log('\n[CLI error → close + nonzero]');
  const harness = path.join(__dirname, '_tmp-hold-expiry-shutdown-error.js');
  fs.writeFileSync(harness, `'use strict';
const { runHoldExpiryCli } = require('./run-booking-hold-expiry');
let closeCalls = 0;
runHoldExpiryCli(['--apply', '--client=sunset'], {
  withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  closePgPool: async () => { closeCalls += 1; },
  expireDueBookingHolds: async () => ({
    scanned: 1, expired: 0, skipped_paid: 0, skipped_changed: 0,
    beds_released: 0, payments_invalidated: 0,
    errors: [{ booking_id: 'x', error: 'boom' }],
  }),
  log: () => {},
  error: () => {},
}).then(() => {
  if (closeCalls !== 1) {
    console.error('closeCalls=' + closeCalls);
    process.exitCode = 2;
    return;
  }
  if (process.exitCode !== 1) {
    console.error('expected exitCode 1, got ' + process.exitCode);
    process.exitCode = 3;
  }
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`);

  const result = await spawnNode(harness, 8000);
  fs.unlinkSync(harness);
  assert('error CLI exits naturally with code 1', result.code === 1, `code=${result.code} err=${result.stderr}`);
}

async function testCliThrowClosesAndNonzero() {
  console.log('\n[CLI throw → close + nonzero]');
  const harness = path.join(__dirname, '_tmp-hold-expiry-shutdown-throw.js');
  fs.writeFileSync(harness, `'use strict';
const { runHoldExpiryCli } = require('./run-booking-hold-expiry');
let closeCalls = 0;
runHoldExpiryCli(['--client=sunset'], {
  withPgClient: async () => { throw new Error('pg down'); },
  closePgPool: async () => { closeCalls += 1; },
  expireDueBookingHolds: async () => ({ errors: [] }),
  log: () => {},
  error: () => {},
}).then(() => {
  if (closeCalls !== 1) {
    console.error('closeCalls=' + closeCalls);
    process.exitCode = 2;
    return;
  }
  if (process.exitCode !== 1) {
    console.error('expected exitCode 1, got ' + process.exitCode);
    process.exitCode = 3;
  }
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`);

  const result = await spawnNode(harness, 8000);
  fs.unlinkSync(harness);
  assert('throw CLI exits naturally with code 1', result.code === 1, `code=${result.code} err=${result.stderr}`);
}

function testSourceGuards() {
  console.log('\n[source guards]');
  const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
  const pgSrc = fs.readFileSync(PG_PATH, 'utf8');

  assert('CLI has no process.exit(0) success hack', !/process\.exit\s*\(\s*0\s*\)/.test(cliSrc));
  assert('CLI has no process.exit after pool work', !/process\.exit\s*\(/.test(cliSrc));
  assert('CLI uses process.exitCode', /process\.exitCode\s*=/.test(cliSrc));
  assert('CLI closes pool in finally', /finally\s*\{[\s\S]*closePool\s*\(/.test(cliSrc)
    || /finally\s*\{[\s\S]*closePgPool\s*\(/.test(cliSrc));
  assert('CLI default remains dry-run (apply false)', /apply:\s*false/.test(cliSrc));
  assert('pg-connect exports closePgPool', /async function closePgPool/.test(pgSrc)
    && /closePgPool/.test(pgSrc));
  assert('closePgPool clears keep-alive timer', /clearInterval\s*\(\s*keepAliveTimer\s*\)/.test(pgSrc));
  assert('closePgPool awaits pool.end', /await\s+ending\.end\s*\(/.test(pgSrc)
    || /await\s+\w+\.end\s*\(/.test(pgSrc));
}

function spawnNode(scriptPath, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: stderr + '\nTIMEOUT' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  console.log('\nverify:booking-hold-expiry-cli-shutdown\n');
  testSourceGuards();
  await testClosePgPool();
  await testStaffApiDoesNotAutoClose();
  await testCliSuccessClosesAndExitsNaturally();
  await testCliErrorClosesAndNonzero();
  await testCliThrowClosesAndNonzero();

  console.log(`\n── verify:booking-hold-expiry-cli-shutdown ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
