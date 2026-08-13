#!/usr/bin/env node
'use strict';
/*
 * Tests for scripts/fleet/task.js — no network. A mock 'gh' on PATH records
 * argv and returns canned output driven by env, so we assert the CLI's guards
 * and state machine without touching GitHub. Run: node scripts/fleet/task.test.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, 'task.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}

const MOCK_GH_SRC = path.join(__dirname, 'test-mock-gh.js');

function run(args, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
  const ghLog = path.join(dir, 'gh.log');
  fs.writeFileSync(ghLog, '');
  fs.copyFileSync(MOCK_GH_SRC, path.join(dir, 'gh'));
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      PATH: dir + path.delimiter + process.env.PATH,
      GH_LOG: ghLog,
      FLEET_REPO: 'test/repo',
    }, env || {}),
  });
  const log = fs.readFileSync(ghLog, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ghlog: log };
}

const gated = JSON.stringify({ labels: [{ name: 'fleet:gated' }] });
const inReview = JSON.stringify({ labels: [{ name: 'fleet:in-review' }] });
const claimed = JSON.stringify({ labels: [{ name: 'fleet:claimed' }] });
const queued = JSON.stringify({ labels: [{ name: 'fleet:queued' }] });

// --- done: the blocking guard (identity, not env-presence) ---
{
  // No expected Captain login configured -> refuse outright.
  const r = run(['done', '5', '--as', 'captain', '--deploy-rev', 'rev1'],
    { FLEET_CAPTAIN_GH_LOGIN: '', MOCK_ISSUE_JSON: gated });
  ok('done refuses when FLEET_CAPTAIN_GH_LOGIN unset', r.status !== 0 && /CAPTAIN-ONLY/.test(r.stderr), r.stderr.trim());
  ok('done did NOT close the issue when refused (no login)', !/issue close/.test(r.ghlog));
}
{
  // REGRESSION (Seadog): a worker supplies an arbitrary non-empty FLEET_CAPTAIN_TOKEN
  // but is NOT the Captain GitHub actor -> must be refused. Env-presence != authorization.
  const r = run(['done', '5', '--as', 'captain', '--deploy-rev', 'rev1'],
    { FLEET_CAPTAIN_TOKEN: 'anything', FLEET_CAPTAIN_GH_LOGIN: 'captainbot', MOCK_ACTOR: 'workerbot', MOCK_ISSUE_JSON: gated });
  ok('done refuses an arbitrary non-empty token from a non-Captain actor', r.status !== 0 && /actor/.test(r.stderr), r.stderr.trim());
  ok('arbitrary-token path did NOT close the issue', !/issue close/.test(r.ghlog));
}
{
  // Wrong actor with matching-looking login var still refused.
  const r = run(['done', '5', '--as', 'captain', '--deploy-rev', 'rev1'],
    { FLEET_CAPTAIN_GH_LOGIN: 'captainbot', MOCK_ACTOR: 'randobot', MOCK_ISSUE_JSON: gated });
  ok('done refuses when authenticated actor != FLEET_CAPTAIN_GH_LOGIN', r.status !== 0 && /actor/.test(r.stderr));
}
{
  // Authorized: actor matches expected Captain login + gated -> proceeds and closes.
  const r = run(['done', '5', '--as', 'captain', '--deploy-rev', 'rev1'],
    { FLEET_CAPTAIN_GH_LOGIN: 'captainbot', MOCK_ACTOR: 'captainbot', MOCK_ISSUE_JSON: gated });
  ok('done proceeds when actor == Captain login + gated', r.status === 0, r.stderr.trim());
  ok('done closes the issue when authorized', /issue close/.test(r.ghlog));
}
{
  const r = run(['done', '5', '--as', 'captain', '--deploy-rev', 'rev1'],
    { FLEET_CAPTAIN_GH_LOGIN: 'captainbot', MOCK_ACTOR: 'captainbot', MOCK_ISSUE_JSON: inReview });
  ok('done refuses from non-gated state', r.status !== 0 && /only from gated/.test(r.stderr));
}

// --- review: requires a real tip SHA, not a URL ---
{
  const r = run(['review', '5', '--tip-sha', 'https://tmpfiles.example/x'], { MOCK_ISSUE_JSON: claimed });
  ok('review refuses a URL as tip-sha', r.status !== 0 && /tip-sha/.test(r.stderr));
}
{
  const r = run(['review', '5', '--tip-sha', 'dfe6ec0a081bb80d44f41ecad7670b417b3dfb40'], { MOCK_ISSUE_JSON: claimed });
  ok('review accepts a 40-hex SHA from claimed', r.status === 0, r.stderr.trim());
}

// --- illegal transition rejected ---
{
  const r = run(['review', '5', '--tip-sha', 'abc1234'], { MOCK_ISSUE_JSON: queued });
  ok('review refuses illegal jump queued -> in-review', r.status !== 0 && /illegal transition/.test(r.stderr));
}

// --- gate fail bounces; 3rd bounce hits loop cap (-> blocked) ---
{
  const twoBounces = JSON.stringify({ comments: [{ body: 'BOUNCE 1 — x' }, { body: 'BOUNCE 2 — y' }], labels: [{ name: 'fleet:in-review' }] });
  const r = run(['gate', '5', '--result', 'fail', '--notes', 'again'], { MOCK_ISSUE_JSON: twoBounces });
  ok('gate fail on 3rd bounce hits loop cap -> blocked', r.status === 0 && /blocked \(loop cap 3\)/.test(r.stdout), r.stdout.trim());
  ok('loop cap added the fleet:blocked label', /add-label fleet:blocked/.test(r.ghlog));
}
{
  const oneBounce = JSON.stringify({ comments: [{ body: 'BOUNCE 1 — x' }], labels: [{ name: 'fleet:in-review' }] });
  const r = run(['gate', '5', '--result', 'fail'], { MOCK_ISSUE_JSON: oneBounce });
  ok('gate fail under cap bounces back to claimed', r.status === 0 && /bounce 2/.test(r.stdout), r.stdout.trim());
}

// --- list selects fleet labels in-process (no conjunctive --label filter) ---
{
  const list = JSON.stringify([
    { number: 7, title: 'one-state issue', labels: [{ name: 'fleet:queued' }], assignees: [] },
    { number: 8, title: 'not a board item', labels: [{ name: 'bug' }], assignees: [] },
  ]);
  const r = run(['list'], { MOCK_LIST_JSON: list });
  ok('list shows a one-fleet-label issue', /#7 .*\[queued\]/.test(r.stdout), r.stdout.trim());
  ok('list omits non-fleet issues', !/#8/.test(r.stdout));
  ok('default list does NOT pass conjunctive --label filters', !/--label fleet:queued --label fleet:claimed/.test(r.ghlog));
}

console.log('\n' + '-'.repeat(40));
console.log('fleet task.js tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
