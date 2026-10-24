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
  assert.equal(v3.tenant, 'wolfhouse-clone');
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
    set: 'acceptance',
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
    set: 'acceptance',
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
    set: 'acceptance',
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
            tenant_whatsapp_suppressed: true,
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
  assert.equal(liveCalls.every((call) => call.opts.body.tenant === 'wolfhouse-clone'), true);
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
  assert.equal(defaultArgs.set, 'sidebyside');

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
    set: 'acceptance',
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
  assert.equal(rootLie.ok, false, 'contradictory no-send evidence must stop the run');
  assert.equal(/no_send|unsafe|contradict/i.test(JSON.stringify(rootLie.cause)), true);

  const missingLim = await runner.runSideBySide({
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
      json: async () => ({ ok: true, reply_text: 'A 2027 quote.' }),
    }),
    repoRoot,
  });
  assert.equal(missingLim.ok, false, 'missing limitation must stop the run');

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
        limitation: { whatsapp_sends_enabled: false, sms_sends_enabled: false, writes_enabled: false, payments_enabled: false, tenant_whatsapp_suppressed: true },
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
          tenant_whatsapp_suppressed: true,
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
    repeats: 1,
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
  assert.equal(Array.isArray(pair.outcomes[0].turns), true);
  assert.equal(pair.outcomes[0].turns.length, 1);

  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'zero-night',
        phone: quoteScript.phone,
        dates: { check_in: '2027-11-05', check_out: '2027-11-05', stock_pricing_confirmed: false },
        turns: [{ guest: 'Hello there, quote 5 November 2027 please.' }],
      }],
    }),
    /zero-night|reversed|night/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'reversed-dates',
        phone: quoteScript.phone,
        dates: { check_in: '2027-11-15', check_out: '2027-11-05', stock_pricing_confirmed: false },
        turns: [{ guest: 'Hello there, quote 5 November 2027 please.' }],
      }],
    }),
    /zero-night|reversed|night/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'dialogue-outside-window',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote 2027-12-01 to 2027-12-05 please, one person.' }],
      }],
    }),
    /window|dialogue/i,
  );

  const twoTurn = {
    id: 'two-turn-receipts',
    phone: quoteScript.phone,
    dates: quoteScript.dates,
    turns: [
      { guest: 'Hi, quote one person 4 to 8 June 2027 please.' },
      { guest: 'Yes book that stay for 4 to 8 June 2027.' },
    ],
  };
  let n = 0;
  const laterFail = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [twoTurn],
    outDir: tmpDir(),
    fetchImpl: async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reply_text: 'first turn quote',
            session_id: 'sess-first',
            limitation: { whatsapp_sends_enabled: false, sms_sends_enabled: false, writes_enabled: false, payments_enabled: false, tenant_whatsapp_suppressed: true },
          }),
        };
      }
      return { ok: false, status: 500, json: async () => ({ success: false, error: 'boom' }) };
    },
    repoRoot,
  });
  assert.equal(laterFail.ok, false);
  assert.equal(laterFail.finished_progress, 1);
  assert.equal(Array.isArray(laterFail.receipts) && laterFail.receipts.length === 1, true);
  assert.equal(laterFail.receipts[0].reply, 'first turn quote');
  assert.equal(laterFail.transcripts.length > 0, true);

  const pairDefault = await runner.runPaired({
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImplByTarget: {
      'hermes-luna-clone': mockReply('v3 quoted eighty'),
      'hermes-luna': mockReply('classic quoted ninety'),
    },
    repoRoot,
  });
  assert.equal(pairDefault.repeats, 3);
  assert.equal(pairDefault.runs.length, 3);
  const phones = pairDefault.runs.map((row) => row.v3.memory_key);
  assert.equal(new Set(phones).size, 3, 'paired repeats reused conversation identity');

  const blockedPaid = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: true,
    outDir: tmpDir(),
    fetchImpl: forbiddenFetch(),
    repoRoot,
    scripts: [{
      id: 'paid-cancel-handoff',
      phone: quoteScript.phone,
      dates: quoteScript.dates,
      prerequisites: { paid_booking: { required: true, present: false } },
      turns: [{ guest: 'I already paid for 4 to 8 June 2027. I need to cancel that booking.' }],
    }],
  });
  assert.equal(blockedPaid.ok, false);
  assert.equal(blockedPaid.cause && blockedPaid.cause.code, 'BLOCKED');

  const twoTurnTenant = {
    id: 'two-turn-tenant-safety',
    phone: quoteScript.phone,
    dates: quoteScript.dates,
    turns: [
      { guest: 'Hi, quote one person 4 to 8 June 2027 please.' },
      { guest: 'Yes book that stay for 4 to 8 June 2027.' },
    ],
  };
  let tenantCalls = 0;
  const tenantUnsafe = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [twoTurnTenant],
    outDir: tmpDir(),
    fetchImpl: async () => {
      tenantCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply_text: 'proxy off, tenant not suppressed',
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
  assert.equal(tenantUnsafe.ok, false, 'missing tenant suppression must stop');
  assert.equal(tenantCalls, 1, 'missing tenant suppression still dispatched later turns');
  assert.equal(/tenant/i.test(JSON.stringify(tenantUnsafe.cause)), true);
  assert.notEqual(tenantUnsafe.scorecard && tenantUnsafe.scorecard.this_run && tenantUnsafe.scorecard.this_run.no_real_sends, true);

  let classicCalls = 0;
  let v3Calls = 0;
  const pairSafety = await runner.runPaired({
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImplByTarget: {
      'hermes-luna-clone': async () => {
        v3Calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reply_text: 'v3 without tenant suppression',
            limitation: { whatsapp_sends_enabled: false, sms_sends_enabled: false },
          }),
        };
      },
      'hermes-luna': async () => {
        classicCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reply_text: 'classic',
            limitation: {
              whatsapp_sends_enabled: false,
              sms_sends_enabled: false,
              tenant_whatsapp_suppressed: true,
            },
          }),
        };
      },
    },
    repoRoot,
  });
  assert.equal(pairSafety.ok, false);
  assert.equal(v3Calls, 1, 'pair kept dispatching after missing tenant safety');
  assert.equal(classicCalls, 0, 'pair continued the other target after missing-safety');

  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'feb-29',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote one person 2027-02-29 please stay a few nights.' }],
      }],
    }),
    /calendar|invalid|dialogue/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'july-vs-june',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote one person from 4 to 8 July 2027 please.' }],
      }],
    }),
    /window|dialogue|month/i,
  );
  await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: true,
    outDir: tmpDir(),
    fetchImpl: forbiddenFetch(),
    repoRoot,
    scripts: [{
      id: 'checkout-included',
      phone: quoteScript.phone,
      dates: quoteScript.dates,
      turns: [{ guest: 'Hi, quote one person 2027-06-04 to 2027-06-08 please.' }],
    }],
  });

  assert.equal(laterFail.executed, true, 'partial HTTP failure must stay executed');
  assert.equal(laterFail.dry_run, false);
  const laterSaved = JSON.parse(fs.readFileSync(laterFail.transcripts[0].path, 'utf8'));
  assert.equal(laterSaved.executed, true);
  assert.equal(laterSaved.dry_run, false);

  let timeoutN = 0;
  const timed = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [twoTurn],
    outDir: tmpDir(),
    fetchImpl: async () => {
      timeoutN += 1;
      if (timeoutN === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reply_text: 'before timeout',
            session_id: 'sess-timeout',
            limitation: {
              whatsapp_sends_enabled: false,
              sms_sends_enabled: false,
              tenant_whatsapp_suppressed: true,
            },
          }),
        };
      }
      throw new Error('tenant simulator timed out');
    },
    repoRoot,
  });
  assert.equal(timed.ok, false);
  assert.equal(timed.executed, true);
  assert.equal(timed.receipts.length, 1);
  assert.equal(timed.receipts[0].reply, 'before timeout');

  const fullOut = tmpDir();
  const fullOk = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: fullOut,
    fetchImpl: mockReply('quoted with receipts'),
    repoRoot,
  });
  assert.equal(fullOk.ok, true);
  const fullTurns = JSON.parse(fs.readFileSync(fullOk.transcripts[0].path, 'utf8')).turns;
  assert.equal(typeof fullTurns[0].session_id, 'string');
  assert.equal(fullTurns[0].no_real_sends, true);
  assert.equal(fullTurns[0].limitation && fullTurns[0].limitation.whatsapp_sends_enabled, false);

  assert.equal(Array.isArray(pairDefault.outcomes_by_repeat), true);
  assert.equal(pairDefault.outcomes_by_repeat.length, 3);
  assert.equal(typeof pairDefault.comparison_path, 'string');
  assert.equal(fs.existsSync(pairDefault.comparison_path), true);
  const comparison = JSON.parse(fs.readFileSync(pairDefault.comparison_path, 'utf8'));
  assert.equal(comparison.repeats, 3);
  assert.equal(comparison.outcomes_by_repeat.length, 3);

  let httpV3 = 0;
  let httpClassic = 0;
  const pairHttp = await runner.runPaired({
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImplByTarget: {
      'hermes-luna-clone': async () => {
        httpV3 += 1;
        return { ok: false, status: 500, json: async () => ({ success: false, error: 'boom' }) };
      },
      'hermes-luna': async () => {
        httpClassic += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reply_text: 'classic',
            limitation: {
              whatsapp_sends_enabled: false,
              sms_sends_enabled: false,
              tenant_whatsapp_suppressed: true,
            },
          }),
        };
      },
    },
    repoRoot,
  });
  assert.equal(pairHttp.ok, false);
  assert.equal(httpV3, 1, 'HTTP-500 must stop the batch');
  assert.equal(httpClassic, 0, 'HTTP-500 still dispatched the rest of the batch');

  let toV3 = 0;
  let toClassic = 0;
  const pairTimeout = await runner.runPaired({
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImplByTarget: {
      'hermes-luna-clone': async () => {
        toV3 += 1;
        throw new Error('tenant simulator timed out');
      },
      'hermes-luna': async () => {
        toClassic += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true, reply_text: 'classic' }) };
      },
    },
    repoRoot,
  });
  assert.equal(pairTimeout.ok, false);
  assert.equal(toV3, 1, 'first-request timeout must stop the batch');
  assert.equal(toClassic, 0, 'timeout still dispatched the rest of the batch');

  const extSend = await runner.runSideBySide({
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
        reply_text: 'quoted',
        external_send_allowed: true,
        limitation: {
          whatsapp_sends_enabled: false,
          sms_sends_enabled: false,
          tenant_whatsapp_suppressed: true,
        },
      }),
    }),
    repoRoot,
  });
  assert.equal(extSend.ok, false);
  assert.notEqual(extSend.scorecard && extSend.scorecard.this_run && extSend.scorecard.this_run.no_real_sends, true);

  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'june-31',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote one person 31 June 2027 please.' }],
      }],
    }),
    /calendar|invalid|dialogue/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'june-14-18',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote one person from 14 to 18 June 2027 please.' }],
      }],
    }),
    /window|dialogue|range/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'reversed-dialogue',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote one person from 8 to 4 June 2027 please.' }],
      }],
    }),
    /reversed|window|dialogue|range/i,
  );
  await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: true,
    outDir: tmpDir(),
    fetchImpl: forbiddenFetch(),
    repoRoot,
    scripts: [{
      id: 'en-dash-ok',
      phone: quoteScript.phone,
      dates: quoteScript.dates,
      turns: [{ guest: 'May I have a quote for 4–8 June?' }],
    }],
  });

  function toolsReply(reply, tools) {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        reply_text: reply,
        session_id: 'sess-tools',
        tool_calls: tools,
        limitation: {
          whatsapp_sends_enabled: false,
          sms_sends_enabled: false,
          tenant_whatsapp_suppressed: true,
        },
      }),
    });
  }
  const twoTurnTools = {
    id: 'two-turn-tools',
    phone: quoteScript.phone,
    dates: quoteScript.dates,
    turns: [
      { guest: 'Hi, quote one person 4 to 8 June 2027 please.' },
      { guest: 'Yes book that stay for 4 to 8 June 2027.' },
    ],
  };
  async function runTools(order) {
    let i = 0;
    return runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: false,
      live: true,
      liveConfirmed: true,
      cookie: 'crowsnest-operator=test',
      scripts: [twoTurnTools],
      outDir: tmpDir(),
      fetchImpl: async () => {
        const tools = order[i] || [];
        i += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reply_text: 'same reply',
            session_id: 'sess-tools',
            tool_calls: tools,
            limitation: {
              whatsapp_sends_enabled: false,
              sms_sends_enabled: false,
              tenant_whatsapp_suppressed: true,
            },
          }),
        };
      },
      repoRoot,
    });
  }
  const toolsA = await runTools([[{ name: 'quote' }], [{ name: 'book' }]]);
  const toolsB = await runTools([[{ name: 'book' }], [{ name: 'quote' }]]);
  const turnsA = JSON.parse(fs.readFileSync(toolsA.transcripts[0].path, 'utf8')).turns;
  const turnsB = JSON.parse(fs.readFileSync(toolsB.transcripts[0].path, 'utf8')).turns;
  assert.equal(turnsA[0].reply, turnsB[0].reply);
  assert.notDeepEqual(turnsA.map((turn) => turn.tool_calls), turnsB.map((turn) => turn.tool_calls));
  assert.notEqual(JSON.stringify(toolsA.scorecard), JSON.stringify(toolsB.scorecard));

  async function pairTools(toolName) {
    return runner.runPaired({
      dryRun: false,
      live: true,
      liveConfirmed: true,
      cookie: 'crowsnest-operator=test',
      scripts: [quoteScript],
      repeats: 1,
      outDir: tmpDir(),
      fetchImplByTarget: {
        'hermes-luna-clone': toolsReply('same text', [{ name: toolName }]),
        'hermes-luna': toolsReply('same text', [{ name: 'classic' }]),
      },
      repoRoot,
    });
  }
  const cmpA = await pairTools('quote');
  const cmpB = await pairTools('book');
  const cmpAjson = fs.readFileSync(cmpA.comparison_path, 'utf8');
  const cmpBjson = fs.readFileSync(cmpB.comparison_path, 'utf8');
  assert.notEqual(cmpAjson, cmpBjson, 'tool totals with same reply must change comparison.json');

  const altOrder = [];
  await runner.runPaired({
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImplByTarget: {
      'hermes-luna-clone': async () => {
        altOrder.push('v3');
        return toolsReply('ok', [{ name: 'quote' }])();
      },
      'hermes-luna': async () => {
        altOrder.push('classic');
        return toolsReply('ok', [{ name: 'classic' }])();
      },
    },
    repoRoot,
  });
  assert.deepEqual(altOrder, ['v3', 'classic', 'classic', 'v3', 'v3', 'classic']);

  function reservedSuffix(suffix) {
    return '+' + '34' + '6999' + suffix;
  }
  const collideA = {
    id: 'collide-a',
    phone: reservedSuffix('00001'),
    dates: quoteScript.dates,
    turns: [{ guest: 'Hi, quote one person 4 to 8 June 2027 please.' }],
  };
  const collideB = {
    id: 'collide-b',
    phone: reservedSuffix('00002'),
    dates: quoteScript.dates,
    turns: [{ guest: 'Hi, quote one person 4 to 8 June 2027 please.' }],
  };
  const wireIdentities = [];
  await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [collideA, collideB],
    runId: 'collision-51991',
    outDir: tmpDir(),
    fetchImpl: async (url, init) => {
      const sent = JSON.parse(init.body);
      wireIdentities.push(String(sent.tenant) + '|' + String(sent.from_phone));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply_text: 'quoted',
          limitation: {
            whatsapp_sends_enabled: false,
            sms_sends_enabled: false,
            tenant_whatsapp_suppressed: true,
          },
        }),
      };
    },
    repoRoot,
  });
  assert.equal(wireIdentities.length, 2);
  assert.equal(new Set(wireIdentities).size, 2, 'tenant+phone identities must be unique');

  const laterNoSend = laterFail.scorecard && laterFail.scorecard.this_run && laterFail.scorecard.this_run.no_real_sends;
  assert.notEqual(laterNoSend, true, 'later 500 must not certify no_real_sends');
  assert.equal(Array.isArray(laterFail.attempts) && laterFail.attempts.some((row) => row.outcome === 'error' || row.outcome === 'unknown'), true);

  const firstTimeout = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImpl: async () => {
      throw new Error('tenant simulator timed out');
    },
    repoRoot,
  });
  assert.equal(firstTimeout.ok, false);
  assert.notEqual(firstTimeout.dry_run, true, 'first-call timeout must not look like a dry run');
  assert.notEqual(firstTimeout.scorecard && firstTimeout.scorecard.this_run && firstTimeout.scorecard.this_run.dry_run, true);
  assert.equal(firstTimeout.executed, true);
  assert.equal(Array.isArray(firstTimeout.attempts) && firstTimeout.attempts[0] && firstTimeout.attempts[0].outcome !== 'ok', true);

  let redirectClassic = 0;
  const pairRedirect = await runner.runPaired({
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [quoteScript],
    outDir: tmpDir(),
    fetchImplByTarget: {
      'hermes-luna-clone': async () => ({
        ok: true,
        status: 302,
        headers: { location: 'https://crowsnest.lunafrontdesk.com/elsewhere' },
        json: async () => ({
          ok: true,
          reply_text: 'redirected success',
          limitation: {
            whatsapp_sends_enabled: false,
            sms_sends_enabled: false,
            tenant_whatsapp_suppressed: true,
          },
        }),
      }),
      'hermes-luna': async () => {
        redirectClassic += 1;
        return toolsReply('classic', [{ name: 'classic' }])();
      },
    },
    repoRoot,
  });
  assert.equal(pairRedirect.ok, false);
  assert.equal(redirectClassic, 0, '302 must not count as success or continue the batch');

  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'agosto-julio',
        phone: quoteScript.phone,
        dates: { check_in: '2027-07-14', check_out: '2027-07-18', stock_pricing_confirmed: false },
        turns: [{ guest: 'Hola, presupuesto del 14 al 18 de agosto de 2027 por favor.' }],
      }],
    }),
    /window|dialogue|agosto|month/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'junio-32',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hola, del 31 al 32 de junio de 2027 por favor.' }],
      }],
    }),
    /calendar|invalid|dialogue/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'reversed-iso',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote 2027-06-08 to 2027-06-04 please.' }],
      }],
    }),
    /reversed|window|dialogue|range/i,
  );
  await assert.rejects(
    () => runner.runSideBySide({
      target: 'hermes-luna-clone',
      dryRun: true,
      outDir: tmpDir(),
      fetchImpl: forbiddenFetch(),
      repoRoot,
      scripts: [{
        id: 'june-14-18-english',
        phone: quoteScript.phone,
        dates: quoteScript.dates,
        turns: [{ guest: 'Hi, quote June 14-18 2027 please.' }],
      }],
    }),
    /window|dialogue|range/i,
  );
  await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: true,
    outDir: tmpDir(),
    fetchImpl: forbiddenFetch(),
    repoRoot,
    scripts: [{
      id: 'spanish-ok',
      phone: quoteScript.phone,
      dates: { check_in: '2027-08-14', check_out: '2027-08-18', stock_pricing_confirmed: false },
      turns: [{ guest: 'Hola, somos dos y queremos un presupuesto del 14 al 18 de agosto de 2027 en dormitorio mixto. Gracias.' }],
    }],
  });

  let paidCalls = 0;
  const paidScript = {
    id: 'paid-cancel-handoff',
    phone: quoteScript.phone,
    dates: quoteScript.dates,
    turns: [{ guest: 'I already paid for 4 to 8 June 2027. I need to cancel that booking.' }],
    prerequisites: { paid_booking: { required: true, present: true } },
  };
  const paidBlocked = await runner.runSideBySide({
    target: 'hermes-luna-clone',
    dryRun: false,
    live: true,
    liveConfirmed: true,
    cookie: 'crowsnest-operator=test',
    scripts: [paidScript],
    outDir: tmpDir(),
    prerequisiteEvidence: {
      ['wolfhouse-clone|' + quoteScript.phone]: { paid_booking: true },
    },
    fetchImpl: async () => {
      paidCalls += 1;
      return toolsReply('should not send', [])();
    },
    repoRoot,
  });
  assert.equal(paidBlocked.ok, false);
  assert.equal(paidBlocked.cause && paidBlocked.cause.code, 'BLOCKED');
  assert.equal(paidCalls, 0, 'paid-booking must bind to the resolved tenant/phone');

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
