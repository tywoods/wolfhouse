'use strict';

// Offline gate for scripts/run-luna-v3-sidebyside.js. Never calls Crow's Nest,
// WhatsApp, Staff, or France. A live fetch in dry-run is a fail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-luna-v3-sidebyside.js');
const fixtureDir = path.join(repoRoot, 'fixtures', 'luna-v3', 'acceptance');
const reservedPhone = /^\+346999\d{5}$/;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luna-v3-sidebyside-'));
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function forbiddenFetch() {
  return async function fetchImpl() {
    throw new Error('network fetch was called');
  };
}

async function main() {
  assert.equal(fs.existsSync(runnerPath), true, 'scripts/run-luna-v3-sidebyside.js is missing');
  const runner = require(runnerPath);
  assert.equal(typeof runner.runSideBySide, 'function');
  assert.equal(typeof runner.resolveTarget, 'function');
  assert.equal(typeof runner.parseArgs, 'function');

  const v3 = runner.resolveTarget('hermes-luna-clone');
  assert.equal(v3.runtime, 'hermes-luna-clone');
  assert.equal(v3.tenant, 'luna-v3');
  assert.equal(runner.resolveTarget('v3').runtime, 'hermes-luna-clone');
  assert.equal(runner.resolveTarget('luna-v3').runtime, 'hermes-luna-clone');

  const classic = runner.resolveTarget('hermes-luna');
  assert.equal(classic.runtime, 'hermes-luna');
  assert.equal(classic.tenant, 'wolfhouse');
  assert.equal(runner.resolveTarget('classic').runtime, 'hermes-luna');

  assert.throws(() => runner.resolveTarget('sunset'), /sunset|not a side-by-side target/i);
  assert.throws(() => runner.resolveTarget(''), /target/i);
  assert.throws(() => runner.resolveTarget('hermes-staging'), /target/i);

  const manifest = readJson('manifest.json');
  assert.equal(manifest.scripts.length >= 5, true, 'frozen script list is too short');
  for (const name of manifest.scripts) {
    const script = readJson(name);
    assert.equal(reservedPhone.test(script.phone), true, name + ' phone is not reserved +34 699 9xx');
    assert.equal(String(script.dates.check_in).startsWith('2027-'), true, name + ' check_in is not 2027');
    assert.equal(String(script.dates.check_out).startsWith('2027-'), true, name + ' check_out is not 2027');
    assert.equal(script.dates.stock_pricing_confirmed, false, name);
  }

  const out = tmpDir();
  const dry = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: true,
    outDir: out,
    fetchImpl: forbiddenFetch(),
    repoRoot,
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.executed, false);
  assert.equal(dry.target.runtime, 'hermes-luna-clone');
  assert.equal(dry.scripts.length, manifest.scripts.length);
  assert.equal(dry.planned_turns.length > 0, true);
  assert.equal(dry.scorecard.this_run.executed, false);
  assert.equal(dry.scorecard.this_run.safety_floor_certified, false);
  assert.equal(fs.existsSync(dry.summary_path), true);
  for (const row of dry.transcripts) {
    assert.equal(fs.existsSync(row.path), true, row.id + ' transcript missing');
    const saved = JSON.parse(fs.readFileSync(row.path, 'utf8'));
    assert.equal(saved.dry_run, true);
    assert.equal(saved.executed, false);
    assert.equal(reservedPhone.test(saved.phone), true, row.id + ' wrote a non-reserved phone');
    assert.equal(Array.isArray(saved.turns), true);
    assert.equal(saved.turns.every((turn) => turn.role === 'guest' && typeof turn.text === 'string'), true);
  }

  const classicOut = tmpDir();
  const classicDry = await runner.runSideBySide({
    target: 'hermes-luna',
    dryRun: true,
    outDir: classicOut,
    fetchImpl: forbiddenFetch(),
    repoRoot,
  });
  assert.equal(classicDry.target.runtime, 'hermes-luna');
  assert.equal(classicDry.executed, false);

  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'bad-phone',
        phone: '+' + '155555' + '50100',
        dates: { check_in: '2027-11-05', check_out: '2027-11-15', stock_pricing_confirmed: false },
        turns: [{ guest: 'Hello there, just saying hi today.' }],
      }],
    }),
    /reserved|699/,
  );

  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'bad-year',
        phone: readJson('guest-01-couple.json').phone,
        dates: { check_in: '2026-11-05', check_out: '2026-11-15', stock_pricing_confirmed: false },
        turns: [{ guest: 'Hello there, just saying hi today.' }],
      }],
    }),
    /2027/,
  );

  const calls = [];
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: false,
      live: true,
      liveConfirmed: false,
      outDir: tmpDir(),
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, status: 200, json: async () => ({ ok: true, reply_text: 'nope' }) };
      },
      repoRoot,
    }),
    /live/,
  );
  assert.equal(calls.length, 0, 'live run without confirmation hit the network');

  const liveCalls = [];
  const liveOut = tmpDir();
  const live = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    outDir: liveOut,
    fetchImpl: async (url, opts) => {
      liveCalls.push({ url, opts: { method: opts.method, headers: opts.headers, body: JSON.parse(opts.body), redirect: opts.redirect } });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply_text: 'Thanks — I will check Staff for those 2027 dates.',
          session_id: 'sess-live',
          tool_calls: [],
          limitation: {
            whatsapp_sends_enabled: false,
            sms_sends_enabled: false,
            writes_enabled: false,
            payments_enabled: false,
          },
        }),
      };
    },
    repoRoot,
  });
  assert.equal(live.dry_run, false);
  assert.equal(live.executed, true);
  assert.equal(liveCalls.length, live.planned_turns.length);
  assert.equal(liveCalls.every((call) => String(call.url).endsWith('/api/live-simulator/guest-turn')), true);
  assert.equal(liveCalls.every((call) => call.opts.body.tenant === 'luna-v3'), true);
  assert.equal(liveCalls.every((call) => call.opts.body.allow_writes === false), true);
  assert.equal(liveCalls.every((call) => call.opts.body.external_send_allowed === false), true);
  assert.equal(liveCalls.every((call) => reservedPhone.test(call.opts.body.from_phone)), true);
  assert.equal(liveCalls.every((call) => typeof call.opts.body.text === 'string' && call.opts.body.text.length >= 8), true);
  assert.equal(live.scorecard.this_run.no_real_sends, true);

  const args = runner.parseArgs(['--dry-run', '--target', 'hermes-luna-clone', '--out', out]);
  assert.equal(args.dryRun, true);
  assert.equal(args.live, false);
  assert.equal(args.target, 'hermes-luna-clone');
  const defaultArgs = runner.parseArgs([]);
  assert.equal(defaultArgs.dryRun, true);
  assert.equal(defaultArgs.live, false);

  const mixedLiveFirst = runner.parseArgs(['--live', '--dry-run']);
  assert.equal(mixedLiveFirst.dryRun, true, 'dry must win when --live comes first');
  assert.equal(mixedLiveFirst.live, false);
  const mixedDryFirst = runner.parseArgs(['--dry-run', '--live']);
  assert.equal(mixedDryFirst.dryRun, true, 'dry must win when --dry-run comes first');
  assert.equal(mixedDryFirst.live, false);
  const dryDispatch = [];
  const mixedRun = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: true,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    outDir: tmpDir(),
    fetchImpl: async () => {
      dryDispatch.push(1);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    repoRoot,
  });
  assert.equal(mixedRun.executed, false);
  assert.equal(dryDispatch.length, 0, '--live --dry-run dispatched');

  const quoteScript = {
    id: 'quote-solo',
    phone: readJson('guest-02-solo-package.json').phone,
    dates: readJson('guest-02-solo-package.json').dates,
    turns: [{ guest: 'Hi, could I get a quote for one person from 4 to 8 June 2027? Please do not book yet.' }],
  };

  const noAuthCalls = [];
  const noAuth = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImpl: async () => {
      noAuthCalls.push(1);
      return { ok: true, status: 200, json: async () => ({ ok: true, reply_text: 'nope' }) };
    },
    repoRoot,
  });
  assert.equal(noAuth.ok, false);
  assert.equal(noAuthCalls.length, 0, 'live without operator session hit the network');
  assert.equal(Boolean(noAuth.cause), true);

  const auth401 = [];
  const fail401 = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImpl: async () => {
      auth401.push(1);
      return { ok: false, status: 401, json: async () => ({ success: false, error: 'unauthorized' }) };
    },
    repoRoot,
  });
  assert.equal(fail401.ok, false);
  assert.equal(auth401.length, 1, '401 did not stop after the first turn');
  assert.equal(fail401.cause && fail401.cause.status, 401);
  assert.equal(/unauthorized/i.test(String(fail401.cause.error || fail401.cause)), true);

  const rootLie = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        reply_text: 'A 2027 quote.',
        whatsapp_suppressed: true,
        external_send_allowed: false,
        limitation: { whatsapp_sends_enabled: true, sms_sends_enabled: false },
      }),
    }),
    repoRoot,
  });
  assert.equal(rootLie.scorecard.this_run.no_real_sends, false, 'root no-send fields must not certify sends');

  const nestedOk = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        reply_text: 'A 2027 quote.',
        limitation: { whatsapp_sends_enabled: false, sms_sends_enabled: false, writes_enabled: false, payments_enabled: false },
      }),
    }),
    repoRoot,
  });
  assert.equal(nestedOk.scorecard.this_run.no_real_sends, true);

  assert.throws(() => runner.resolveCrowsnestBase('https://evil.example'), /origin|crowsnest/i);
  const badOrigin = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    crowsnestBase: 'https://evil.example',
    outDir: tmpDir(),
    fetchImpl: forbiddenFetch(),
    repoRoot,
  });
  assert.equal(badOrigin.ok, false);

  const redirected = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImpl: async () => ({
      status: 302,
      ok: false,
      headers: { get: (name) => (String(name).toLowerCase() === 'location' ? 'https://evil.example/steal' : null) },
      json: async () => ({}),
    }),
    repoRoot,
  });
  assert.equal(redirected.ok, false);
  assert.equal(/redirect/i.test(JSON.stringify(redirected.cause)), true);

  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'bad-calendar',
        phone: quoteScript.phone,
        dates: { check_in: '2027-99-99', check_out: '2027-11-15', stock_pricing_confirmed: false },
        turns: [{ guest: 'Hello there, quote 5 November 2027 please.' }],
      }],
    }),
    /calendar|invalid/,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'bad-nested',
        phone: quoteScript.phone,
        dates: {
          check_in: '2027-11-05',
          check_out: '2027-11-15',
          stock_pricing_confirmed: false,
          later: { check_in: '2027-99-99', check_out: '2027-11-20' },
        },
        turns: [{ guest: 'Hello there, quote 5 November 2027 please.' }],
      }],
    }),
    /calendar|invalid/,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'bad-dialogue-year',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi we want 5 November 2026 please quote us today.' }],
      }],
    }),
    /2027|dialogue/,
  );

  function mockReply(text) {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        reply_text: text,
        session_id: 'sess-' + text.length,
        tool_calls: [{ name: 'quote' }],
        limitation: {
          whatsapp_sends_enabled: false,
          sms_sends_enabled: false,
          writes_enabled: false,
          payments_enabled: false,
        },
      }),
    });
  }
  const scoredA = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    runId: 'run-a',
    outDir: tmpDir(),
    fetchImpl: mockReply('v3 quoted eighty euros for June 2027'),
    repoRoot,
  });
  const scoredB = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    runId: 'run-b',
    outDir: tmpDir(),
    fetchImpl: mockReply('classic quoted ninety euros for June 2027'),
    repoRoot,
  });
  assert.notDeepEqual(scoredA.scorecard.this_run, scoredB.scorecard.this_run);
  assert.notEqual(scoredA.memory_key, scoredB.memory_key);
  assert.equal(Array.isArray(scoredA.evidence.tool_calls), true);
  assert.equal(Boolean(scoredA.evidence.session_id), true);
  assert.equal(scoredA.scorecard.this_run.observations.writes, 'blocked');
  assert.equal(scoredA.scorecard.this_run.observations.payments, 'blocked');

  const pair = await runner.runPaired({
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    runId: 'pair-1',
    outDir: tmpDir(),
    fetchImplByTarget: {
      'hermes-luna-clone': mockReply('v3 quoted eighty'),
      'hermes-luna': mockReply('classic quoted ninety'),
    },
    repoRoot,
  });
  assert.equal(pair.outcomes.length, 1);
  assert.equal(pair.outcomes[0].v3.reply, 'v3 quoted eighty');
  assert.equal(pair.outcomes[0].classic.reply, 'classic quoted ninety');

  console.log('sidebyside dry-run clone pass');
  console.log('sidebyside dry-run classic pass');
  console.log('sidebyside reserved-phone and 2027 negatives pass');
  console.log('sidebyside live confirmation gate pass');
  console.log('sidebyside injected-live fetch pass');
  console.log('sidebyside cap dry-wins pass');
  console.log('sidebyside cap crowsnest-contract pass');
  console.log('sidebyside cap origins pass');
  console.log('sidebyside cap dates pass');
  console.log('sidebyside cap paired-comparison pass');
}

main().catch((err) => {
  console.error('FAIL ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
