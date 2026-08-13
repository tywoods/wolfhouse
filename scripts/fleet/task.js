#!/usr/bin/env node
'use strict';
/*
 * Fleet Board task CLI — thin wrapper over gh issue / gh pr / gh api.
 * GitHub is the board; fleet:* labels carry status. See docs/FLEET-BOARD-SLICE-1.md.
 * No new infra. Runnable from any Hermes container or the host (all share gh auth + repo).
 */
const { spawnSync } = require('child_process');

const REPO = process.env.FLEET_REPO || 'tywoods/wolfhouse';
const STATES = ['queued', 'claimed', 'in-review', 'gated', 'done', 'blocked'];
const LABEL = (s) => 'fleet:' + s;
// legal forward transitions (blocked/unblock handled separately)
const NEXT = {
  queued: ['claimed', 'blocked'],
  claimed: ['in-review', 'blocked'],
  'in-review': ['gated', 'claimed', 'blocked'], // claimed = bounce back
  gated: ['done', 'blocked'],
  done: [],
  blocked: ['queued', 'claimed', 'in-review', 'gated'], // unblock returns to prior-ish
};
const AGENTS = ['skipper', 'deckhand', 'seadog', 'captain', 'monshies', 'earthling'];

function die(msg) { console.error('task: ' + msg); process.exit(1); }
function gh(args, { json } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) die('gh ' + args.join(' ') + '\n' + (r.stderr || r.stdout || 'failed'));
  const out = (r.stdout || '').trim();
  return json ? JSON.parse(out || 'null') : out;
}
function api(method, path, fields) {
  const args = ['api', '-X', method, path];
  for (const [k, v] of Object.entries(fields || {})) { args.push('-f', k + '=' + v); }
  return gh(args);
}
function parseFlags(argv) {
  const f = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) { f[k] = true; } else { f[k] = nx; i++; } }
    else pos.push(a);
  }
  return { f, pos };
}
function issueLabels(id) {
  const data = gh(['issue', 'view', String(id), '-R', REPO, '--json', 'labels'], { json: true });
  return (data.labels || []).map((l) => l.name);
}
function currentState(id) {
  const st = issueLabels(id).filter((n) => n.startsWith('fleet:')).map((n) => n.slice(6));
  return st[0] || null;
}
function setState(id, from, to) {
  if (from && !(NEXT[from] || []).includes(to)) die('illegal transition ' + from + ' -> ' + to);
  if (from) gh(['issue', 'edit', String(id), '-R', REPO, '--remove-label', LABEL(from)]);
  gh(['issue', 'edit', String(id), '-R', REPO, '--add-label', LABEL(to)]);
}
function comment(id, body) { gh(['issue', 'comment', String(id), '-R', REPO, '--body', body]); }
function bounceCount(id) {
  const data = gh(['issue', 'view', String(id), '-R', REPO, '--json', 'comments'], { json: true });
  return (data.comments || []).filter((c) => /^BOUNCE /.test(c.body || '')).length;
}

const [, , cmd, ...rest] = process.argv;
const { f, pos } = parseFlags(rest);

switch (cmd) {
  case 'create': {
    if (!f.title) die('create needs --title');
    const body = (f.body || '') + '\n\n---\nfleet: priority=' + (f.priority || '3');
    const url = gh(['issue', 'create', '-R', REPO, '--title', f.title, '--body', body, '--label', LABEL('queued')]);
    console.log(url);
    break;
  }
  case 'list': {
    const args = ['issue', 'list', '-R', REPO, '--state', 'open', '--json', 'number,title,labels,assignees'];
    if (f.status) args.push('--label', LABEL(f.status));
    else args.push('--label', 'fleet:queued', '--label', 'fleet:claimed', '--label', 'fleet:in-review', '--label', 'fleet:gated', '--label', 'fleet:blocked');
    const rows = gh(args, { json: true }) || [];
    for (const r of rows) {
      const st = (r.labels || []).map((l) => l.name).filter((n) => n.startsWith('fleet:')).map((n) => n.slice(6)).join(',') || '-';
      const who = (r.assignees || []).map((a) => a.login).join(',') || '-';
      console.log('#' + r.number + '  [' + st + ']  ' + '(' + who + ')  ' + r.title);
    }
    break;
  }
  case 'show': { if (!pos[0]) die('show needs <id>'); console.log(gh(['issue', 'view', pos[0], '-R', REPO])); break; }
  case 'claim': {
    const id = pos[0]; if (!id) die('claim needs <id>');
    if (!f.as || !AGENTS.includes(f.as)) die('claim needs --as <' + AGENTS.join('|') + '>');
    setState(id, currentState(id), 'claimed');
    comment(id, 'CLAIM by ' + f.as);
    console.log('#' + id + ' -> claimed (' + f.as + ')');
    break;
  }
  case 'review': {
    const id = pos[0]; if (!id) die('review needs <id>');
    const sha = f['tip-sha'];
    if (!sha || typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha)) die('review REQUIRES --tip-sha <7-40 hex> (a SHA, not a URL)');
    setState(id, currentState(id), 'in-review');
    comment(id, 'IN-REVIEW tip=' + sha + (f.pr ? ' pr=#' + f.pr : ''));
    console.log('#' + id + ' -> in-review tip=' + sha);
    break;
  }
  case 'gate': {
    const id = pos[0]; if (!id) die('gate needs <id>');
    if (!['pass', 'fail'].includes(f.result)) die('gate needs --result pass|fail');
    const cur = currentState(id);
    if (cur !== 'in-review') die('gate only from in-review (now ' + cur + ')');
    if (f.result === 'pass') { setState(id, cur, 'gated'); comment(id, 'GATE pass' + (f.notes ? ' — ' + f.notes : '')); console.log('#' + id + ' -> gated'); }
    else {
      const n = bounceCount(id) + 1;
      comment(id, 'BOUNCE ' + n + ' — ' + (f.notes || 'rejected'));
      if (n >= 3) { setState(id, cur, 'blocked'); comment(id, 'LOOP CAP hit (' + n + ' bounces) — needs a human.'); console.log('#' + id + ' -> blocked (loop cap ' + n + ')'); }
      else { setState(id, cur, 'claimed'); console.log('#' + id + ' -> claimed (bounce ' + n + ')'); }
    }
    break;
  }
  case 'done': {
    const id = pos[0]; if (!id) die('done needs <id>');
    if (f.as !== 'captain') die('done is CAPTAIN ONLY (--as captain). No other agent ships.');
    if (!f['deploy-rev']) die('done needs --deploy-rev <revision>');
    const cur = currentState(id);
    if (cur !== 'gated') die('done only from gated (now ' + cur + ')');
    setState(id, cur, 'done');
    comment(id, 'DONE deploy_rev=' + f['deploy-rev']);
    gh(['issue', 'close', String(id), '-R', REPO]);
    console.log('#' + id + ' -> done rev=' + f['deploy-rev']);
    break;
  }
  case 'block': { const id = pos[0]; if (!id) die('block needs <id>'); setState(id, currentState(id), 'blocked'); comment(id, 'BLOCK — ' + (f.reason || 'no reason given')); console.log('#' + id + ' -> blocked'); break; }
  case 'unblock': { const id = pos[0]; if (!id) die('unblock needs <id>'); const to = f.to || 'queued'; if (!STATES.includes(to)) die('bad --to'); setState(id, 'blocked', to); comment(id, 'UNBLOCK -> ' + to); console.log('#' + id + ' -> ' + to); break; }
  default:
    console.log('task <create|list|show|claim|review|gate|done|block|unblock>  (see docs/FLEET-BOARD-SLICE-1.md)');
    if (cmd) process.exit(1);
}
