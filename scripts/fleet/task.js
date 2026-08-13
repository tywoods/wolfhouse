#!/usr/bin/env node
'use strict';
/*
 * Fleet Board task CLI — thin wrapper over gh issue / gh pr / gh api.
 * GitHub is the board; fleet:* labels carry status. See docs/FLEET-BOARD-SLICE-1.md.
 * No new infra. Runnable from any Hermes container or the host (all share gh auth + repo).
 */
const { spawnSync } = require('child_process');
const https = require('https');

const REPO = process.env.FLEET_REPO || 'tywoods/wolfhouse';
// CAPTAIN identity is a HARD COMMITTED LITERAL — never read from env, never
// caller-settable. Changing who can ship requires a PR through this very gate.
// 'done' compares the actual GitHub actor (gh api user) to this literal. A
// worker cannot become 'tywoods' without the Captain account's real gh token.
const CAPTAIN_GH_LOGIN = 'tywoods';
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

// Backend selection: prefer the gh CLI when present; otherwise fall back to the
// GitHub REST API using GITHUB_TOKEN (worker containers have the token but no gh).
// FLEET_FORCE_REST=1 forces the REST path (used by tests). The identity gate is
// identical on both paths: it reads the platform-reported login (gh api user /
// REST GET /user) and compares to the committed CAPTAIN_GH_LOGIN literal.
function ghAvailable() {
  if (process.env.FLEET_FORCE_REST === '1') return false;
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}
const USE_GH = ghAvailable();

// --- REST backend (used only when gh is absent) ---
function restRequest(method, apiPath, body) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) die('no gh CLI and no GITHUB_TOKEN — cannot reach GitHub.');
  const payload = body ? JSON.stringify(body) : null;
  // Test seam: FLEET_REST_MOCK points at a script that emulates the REST API,
  // invoked as: <mock> <METHOD> <apiPath> [<jsonBody>]. Prod never sets it.
  const mock = process.env.FLEET_TEST === '1' ? process.env.FLEET_REST_MOCK : null;
  if (mock) {
    const r = spawnSync(process.execPath, [mock, method, apiPath, payload || ''], { encoding: 'utf8' });
    if (r.status !== 0) die('rest-mock ' + method + ' ' + apiPath + '\n' + (r.stderr || r.stdout || 'failed'));
    const out = (r.stdout || '').trim();
    return out ? JSON.parse(out) : null;
  }
  const res = spawnSync('node', ['-e', REST_INLINE], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { _RM: method, _RP: apiPath, _RB: payload || '', _RT: token }),
  });
  if (res.status !== 0) die('REST ' + method + ' ' + apiPath + '\n' + (res.stderr || res.stdout || 'failed'));
  const out = (res.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}
// Inline child that performs the actual HTTPS call (kept tiny + dependency-free).
const REST_INLINE = [
  'const https=require("https");',
  'const m=process.env._RM,p=process.env._RP,b=process.env._RB||null,t=process.env._RT;',
  'const opt={hostname:"api.github.com",path:p,method:m,headers:{"User-Agent":"fleet-task","Authorization":"Bearer "+t,"Accept":"application/vnd.github+json"}};',
  'if(b){opt.headers["Content-Type"]="application/json";opt.headers["Content-Length"]=Buffer.byteLength(b);}',
  'const req=https.request(opt,(r)=>{let d="";r.on("data",(c)=>d+=c);r.on("end",()=>{if(r.statusCode>=400){process.stderr.write("HTTP "+r.statusCode+": "+d);process.exit(1);}process.stdout.write(d);});});',
  'req.on("error",(e)=>{process.stderr.write(String(e));process.exit(1);});',
  'if(b)req.write(b);req.end();',
].join('');

function gh(args, { json } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) die('gh ' + args.join(' ') + '\n' + (r.stderr || r.stdout || 'failed'));
  const out = (r.stdout || '').trim();
  return json ? JSON.parse(out || 'null') : out;
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
// --- backend-neutral primitives (identical behaviour on gh and REST) ---
function actorLogin() {
  // The platform-reported identity for the credential in use. Non-forgeable:
  // a caller cannot make GitHub report a login they don't hold the token for.
  if (USE_GH) return gh(['api', 'user', '--jq', '.login']);
  const u = restRequest('GET', '/user');
  return (u && u.login) || '';
}
function fetchIssue(id, fields) {
  if (USE_GH) return gh(['issue', 'view', String(id), '-R', REPO, '--json', fields.join(',')], { json: true });
  const d = restRequest('GET', '/repos/' + REPO + '/issues/' + id);
  const out = {};
  if (fields.includes('labels')) out.labels = (d.labels || []).map((l) => ({ name: typeof l === 'string' ? l : l.name }));
  if (fields.includes('comments')) {
    const cs = restRequest('GET', '/repos/' + REPO + '/issues/' + id + '/comments');
    out.comments = (cs || []).map((c) => ({ body: c.body }));
  }
  return out;
}
function issueLabels(id) {
  const data = fetchIssue(id, ['labels']);
  return (data.labels || []).map((l) => l.name);
}
function currentState(id) {
  const st = issueLabels(id).filter((n) => n.startsWith('fleet:')).map((n) => n.slice(6));
  return st[0] || null;
}
function addLabel(id, name) {
  if (USE_GH) { gh(['issue', 'edit', String(id), '-R', REPO, '--add-label', name]); return; }
  restRequest('POST', '/repos/' + REPO + '/issues/' + id + '/labels', { labels: [name] });
}
function removeLabel(id, name) {
  if (USE_GH) { gh(['issue', 'edit', String(id), '-R', REPO, '--remove-label', name]); return; }
  restRequest('DELETE', '/repos/' + REPO + '/issues/' + id + '/labels/' + encodeURIComponent(name));
}
function setState(id, from, to) {
  if (from && !(NEXT[from] || []).includes(to)) die('illegal transition ' + from + ' -> ' + to);
  if (from) removeLabel(id, LABEL(from));
  addLabel(id, LABEL(to));
}
function comment(id, body) {
  if (USE_GH) { gh(['issue', 'comment', String(id), '-R', REPO, '--body', body]); return; }
  restRequest('POST', '/repos/' + REPO + '/issues/' + id + '/comments', { body });
}
function closeIssue(id) {
  if (USE_GH) { gh(['issue', 'close', String(id), '-R', REPO]); return; }
  restRequest('PATCH', '/repos/' + REPO + '/issues/' + id, { state: 'closed' });
}
function bounceCount(id) {
  const data = fetchIssue(id, ['comments']);
  return (data.comments || []).filter((c) => /^BOUNCE /.test(c.body || '')).length;
}

const [, , cmd, ...rest] = process.argv;
const { f, pos } = parseFlags(rest);

switch (cmd) {
  case 'create': {
    if (!f.title) die('create needs --title');
    const body = (f.body || '') + '\n\n---\nfleet: priority=' + (f.priority || '3');
    let url;
    if (USE_GH) {
      url = gh(['issue', 'create', '-R', REPO, '--title', f.title, '--body', body, '--label', LABEL('queued')]);
    } else {
      const created = restRequest('POST', '/repos/' + REPO + '/issues', { title: f.title, body, labels: [LABEL('queued')] });
      url = (created && created.html_url) || ('#' + (created && created.number));
    }
    console.log(url);
    break;
  }
  case 'list': {
    // GitHub's --label filters are conjunctive (AND). A one-state issue would
    // never match a multi-label default filter, so fetch open issues unfiltered
    // and select fleet-labelled ones in-process.
    let rows;
    if (USE_GH) {
      const args = ['issue', 'list', '-R', REPO, '--state', 'open', '--limit', '200', '--json', 'number,title,labels,assignees'];
      if (f.status) args.push('--label', LABEL(f.status));
      rows = gh(args, { json: true }) || [];
    } else {
      let p = '/repos/' + REPO + '/issues?state=open&per_page=100';
      if (f.status) p += '&labels=' + encodeURIComponent(LABEL(f.status));
      const raw = restRequest('GET', p) || [];
      rows = raw.filter((i) => !i.pull_request).map((i) => ({
        number: i.number, title: i.title,
        labels: (i.labels || []).map((l) => ({ name: typeof l === 'string' ? l : l.name })),
        assignees: (i.assignees || []).map((a) => ({ login: a.login })),
      }));
    }
    for (const r of rows) {
      const fleet = (r.labels || []).map((l) => l.name).filter((n) => n.startsWith('fleet:'));
      if (!fleet.length) continue; // only board items
      const st = fleet.map((n) => n.slice(6)).join(',');
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
    // Set a GitHub assignee if the agent maps to a login; otherwise record the
    // claimant in a comment only (and say so). FLEET_GH_LOGIN_<agent> can map
    // an agent name to a real GitHub login.
    const login = process.env['FLEET_GH_LOGIN_' + f.as.toUpperCase()];
    let assigned = false;
    if (login) {
      const r = spawnSync('gh', ['issue', 'edit', String(id), '-R', REPO, '--add-assignee', login], { encoding: 'utf8' });
      assigned = r.status === 0;
    }
    comment(id, 'CLAIM by ' + f.as + (assigned ? ' (assignee=' + login + ')' : ' (no GitHub assignee mapped)'));
    console.log('#' + id + ' -> claimed (' + f.as + (assigned ? ', assignee ' + login : ', comment-only') + ')');
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
    // CAPTAIN-ONLY. The expected Captain identity is a COMMITTED CONSTANT
    // (CAPTAIN_GH_LOGIN below), not a caller-settable env var — a worker cannot
    // change it without a PR through this very gate. We verify it against the
    // identity GitHub itself reports for the credential in use (gh api user).
    // A worker cannot forge that without the Captain account's actual gh token.
    // (Env-var expected-login was bypassable: a worker set it to their own login,
    // their own creds resolved to it, and self-identity == self is always true.)
    const actor = actorLogin();
    if (!actor || actor !== CAPTAIN_GH_LOGIN) die('done is CAPTAIN-ONLY: authenticated GitHub actor "' + actor + '" != Captain "' + CAPTAIN_GH_LOGIN + '". Workers cannot ship.');
    if (!f['deploy-rev']) die('done needs --deploy-rev <revision>');
    const cur = currentState(id);
    if (cur !== 'gated') die('done only from gated (now ' + cur + ')');
    setState(id, cur, 'done');
    comment(id, 'DONE deploy_rev=' + f['deploy-rev']);
    closeIssue(id);
    console.log('#' + id + ' -> done rev=' + f['deploy-rev']);
    break;
  }
  case 'block': { const id = pos[0]; if (!id) die('block needs <id>'); setState(id, currentState(id), 'blocked'); comment(id, 'BLOCK — ' + (f.reason || 'no reason given')); console.log('#' + id + ' -> blocked'); break; }
  case 'unblock': { const id = pos[0]; if (!id) die('unblock needs <id>'); const to = f.to || 'queued'; if (!STATES.includes(to)) die('bad --to'); setState(id, 'blocked', to); comment(id, 'UNBLOCK -> ' + to); console.log('#' + id + ' -> ' + to); break; }
  default:
    console.log('task <create|list|show|claim|review|gate|done|block|unblock>  (see docs/FLEET-BOARD-SLICE-1.md)');
    if (cmd) process.exit(1);
}
