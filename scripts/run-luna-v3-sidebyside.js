'use strict';

// Offline Luna v3 vs Classic side-by-side runner. Default is dry-run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_BASE = 'https://crowsnest.lunafrontdesk.com';
const APPROVED_ORIGINS = Object.freeze(['https://crowsnest.lunafrontdesk.com']);
const GUEST_TURN_PATH = '/api/live-simulator/guest-turn';
const RESERVED_PHONE = /^\+346999\d{5}$/;
const YEAR_PREFIX = '2027-';
const AUTH_ENV_KEYS = Object.freeze(['CROWSNEST_OPERATOR_SESSION', 'CROWSNEST_COOKIE']);

const TARGETS = Object.freeze({
  'hermes-luna-clone': Object.freeze({
    id: 'hermes-luna-clone',
    runtime: 'hermes-luna-clone',
    tenant: 'luna-v3',
    label: 'Luna v3',
  }),
  'hermes-luna': Object.freeze({
    id: 'hermes-luna',
    runtime: 'hermes-luna',
    tenant: 'wolfhouse',
    label: 'Luna Classic (v2)',
  }),
});

const TARGET_ALIASES = Object.freeze({
  'hermes-luna-clone': 'hermes-luna-clone',
  'luna-v3': 'hermes-luna-clone',
  v3: 'hermes-luna-clone',
  clone: 'hermes-luna-clone',
  'hermes-luna': 'hermes-luna',
  classic: 'hermes-luna',
  v2: 'hermes-luna',
  wolfhouse: 'hermes-luna',
});

function resolveTarget(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) throw new Error('target is required (hermes-luna-clone or hermes-luna)');
  if (raw === 'sunset' || raw.indexOf('sunset') !== -1) {
    throw new Error('sunset is not a side-by-side target');
  }
  const id = TARGET_ALIASES[raw];
  if (!id || !TARGETS[id]) throw new Error('unknown side-by-side target: ' + raw);
  return TARGETS[id];
}

function parseArgs(argv) {
  const args = { dryRun: true, live: false, target: 'hermes-luna-clone', outDir: '', liveConfirmed: false };
  const list = Array.isArray(argv) ? argv.slice() : [];
  let sawDry = false;
  let sawLive = false;
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token === '--dry-run') sawDry = true;
    else if (token === '--live') sawLive = true;
    else if (token === '--target') {
      args.target = list[i + 1];
      i += 1;
    } else if (token === '--out') {
      args.outDir = list[i + 1];
      i += 1;
    }
  }
  if (sawDry) {
    args.dryRun = true;
    args.live = false;
  } else if (sawLive) {
    args.live = true;
    args.dryRun = false;
  }
  return args;
}

function resolveCrowsnestBase(value) {
  const raw = String(value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (!APPROVED_ORIGINS.includes(raw)) {
    throw new Error('crowsnestBase is not an approved Crow\'s Nest origin');
  }
  return raw;
}

function operatorSessionFrom(opts, env) {
  if (opts && typeof opts.cookie === 'string' && opts.cookie.trim()) return opts.cookie.trim();
  const source = env || process.env;
  for (const key of AUTH_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function fixtureDir(repoRoot) {
  return path.join(repoRoot, 'fixtures', 'luna-v3', 'acceptance');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadFrozenScripts(repoRoot) {
  const dir = fixtureDir(repoRoot);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const scorecard = readJson(path.join(dir, 'scorecard.json'));
  const scripts = (manifest.scripts || []).map((name) => {
    const script = readJson(path.join(dir, name));
    script._file = name;
    return script;
  });
  return { manifest, scorecard, scripts };
}

function assertReservedPhone(phone, label) {
  if (!RESERVED_PHONE.test(String(phone || ''))) {
    throw new Error(label + ' phone is not in the reserved +34 699 9xx range');
  }
}

function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function collectDateWindows(value, found) {
  if (!value || typeof value !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(value, 'check_in') || Object.prototype.hasOwnProperty.call(value, 'check_out')) {
    found.push(value);
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (child && typeof child === 'object') collectDateWindows(child, found);
  }
}

function assertDialogueMatches2027(text, label) {
  const years = String(text || '').match(/\b(20\d{2})\b/g) || [];
  for (const year of years) {
    if (year !== '2027') {
      throw new Error(label + ' dialogue is not in the 2027 window');
    }
  }
}

function assertScript(script) {
  const label = script.id || script._file || 'script';
  assertReservedPhone(script.phone, label);
  if (!script.dates || typeof script.dates !== 'object') {
    throw new Error(label + ' has no primary date object');
  }
  if (script.dates.stock_pricing_confirmed !== false) {
    throw new Error(label + ' treated unconfirmed stock or Pricing as confirmed');
  }
  const windows = [];
  collectDateWindows(script, windows);
  if (!windows.length) throw new Error(label + ' has no date window');
  for (const window of windows) {
    if (!isRealCalendarDate(window.check_in) || !isRealCalendarDate(window.check_out)) {
      throw new Error(label + ' has an invalid calendar date');
    }
    if (!String(window.check_in).startsWith(YEAR_PREFIX) || !String(window.check_out).startsWith(YEAR_PREFIX)) {
      throw new Error(label + ' is not a proposed 2027 window');
    }
  }
  const turns = Array.isArray(script.turns) ? script.turns : [];
  if (!turns.length) throw new Error(label + ' has no turns');
  for (const turn of turns) {
    if (typeof turn.guest !== 'string' || turn.guest.trim().length < 8) {
      throw new Error(label + ' is missing guest dialogue');
    }
    assertDialogueMatches2027(turn.guest, label);
  }
}

function planTurns(scripts, phones) {
  const planned = [];
  for (const script of scripts) {
    const id = script.id || script._file;
    (script.turns || []).forEach((turn, index) => {
      planned.push({
        script_id: id,
        phone: phones[id] || script.phone,
        index,
        text: turn.guest,
        name: turn.name || null,
      });
    });
  }
  return planned;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function noSendEvidence(body) {
  const limitation = body && body.limitation;
  if (!limitation || typeof limitation !== 'object') return false;
  return limitation.whatsapp_sends_enabled === false && limitation.sms_sends_enabled === false;
}

function phoneForRun(scriptPhone, runId, index) {
  const digest = crypto.createHash('sha256').update(String(runId) + ':' + String(index) + ':' + String(scriptPhone)).digest('hex');
  const n = parseInt(digest.slice(0, 8), 16) % 100000;
  return '+346999' + String(n).padStart(5, '0');
}

function scoreRun({ dryRun, executed, scripts, replies, scorecard }) {
  const replyFingerprint = crypto.createHash('sha256').update(replies.map((row) => row.reply || '').join('\n')).digest('hex');
  const thisRun = {
    executed,
    dry_run: dryRun,
    safety_floor_certified: false,
    beats_classic: null,
    no_real_sends: executed ? replies.length > 0 && replies.every((row) => row.no_real_sends) : false,
    reply_fingerprint: executed ? replyFingerprint : null,
    observations: { writes: 'blocked', payments: 'blocked' },
    reason: dryRun ? 'dry_run_not_executed' : 'transcripts captured; safety floor stays uncertified without Staff observations',
    scripts: scripts.map((script) => {
      const id = script.id || script._file;
      const scriptReplies = replies.filter((row) => row.script_id === id);
      return {
        id,
        status: dryRun ? 'pending' : 'recorded',
        replies: scriptReplies.map((row) => row.reply || ''),
      };
    }),
  };
  return Object.assign({}, scorecard, { this_run: thisRun });
}

function failResult({ cause, target, dryRun, planned, scripts, outDir, scorecard }) {
  const summary = {
    ok: false,
    cause,
    dry_run: dryRun,
    executed: false,
    target,
    scripts: (scripts || []).map((script) => script.id || script._file),
    planned_turns: planned || [],
    transcripts: [],
    scorecard: scorecard || { this_run: { executed: false, observations: { writes: 'blocked', payments: 'blocked' } } },
  };
  if (outDir) {
    const summaryPath = path.join(outDir, 'summary.json');
    writeJson(summaryPath, summary);
    summary.summary_path = summaryPath;
  }
  return summary;
}

function headerGet(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  return headers[name] || headers[String(name).toLowerCase()] || '';
}

async function postTurn({ base, tenant, phone, text, fetchImpl, cookie }) {
  const origin = resolveCrowsnestBase(base);
  const url = origin + GUEST_TURN_PATH;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const body = {
    tenant,
    from_phone: phone,
    text,
    allow_writes: false,
    external_send_allowed: false,
  };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const status = Number(response && response.status) || 0;
  if (status >= 300 && status < 400) {
    const location = headerGet(response.headers, 'location') || headerGet(response.headers, 'Location');
    let locOrigin = '';
    try { locOrigin = new URL(location, origin).origin; } catch { locOrigin = String(location || ''); }
    if (!APPROVED_ORIGINS.includes(locOrigin)) {
      return { url, status, redirectRefused: true, location, body: {} };
    }
  }
  const parsed = response && typeof response.json === 'function' ? await response.json() : {};
  return { url, status, body: parsed };
}

async function runSideBySide(options) {
  const opts = options || {};
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
  const target = resolveTarget(opts.target);
  const dryRun = opts.dryRun === true || opts.live !== true;
  const live = dryRun ? false : opts.live === true;
  if (live && opts.liveConfirmed !== true) {
    throw new Error('refusing live Crow\'s Nest run without live confirmation');
  }
  const loaded = opts.scripts
    ? { scripts: opts.scripts, scorecard: opts.scorecard || {}, manifest: opts.manifest || {} }
    : loadFrozenScripts(repoRoot);
  for (const script of loaded.scripts) assertScript(script);
  const runId = String(opts.runId || Date.now());
  const phones = {};
  loaded.scripts.forEach((script, index) => {
    const id = script.id || script._file;
    phones[id] = live ? phoneForRun(script.phone, runId, index) : script.phone;
  });
  const planned = planTurns(loaded.scripts, phones);
  const stamp = target.id;
  const outDir = opts.outDir || path.join(repoRoot, 'tmp', 'luna-v3-sidebyside', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  if (live) {
    try {
      resolveCrowsnestBase(opts.crowsnestBase || DEFAULT_BASE);
    } catch (err) {
      return failResult({ cause: { code: 'unapproved_origin', error: err.message }, target, dryRun, planned, scripts: loaded.scripts, outDir });
    }
    const cookie = operatorSessionFrom(opts, opts.env);
    if (!cookie) {
      return failResult({ cause: { code: 'missing_operator_session', error: 'operator session required' }, target, dryRun, planned, scripts: loaded.scripts, outDir });
    }
    const fetchImpl = opts.fetchImpl;
    if (typeof fetchImpl !== 'function') {
      throw new Error('live run requires an injected fetchImpl in this lane');
    }
    const replies = [];
    const evidence = { tool_calls: [], session_id: null, errors: [] };
    for (const turn of planned) {
      const posted = await postTurn({
        base: opts.crowsnestBase || DEFAULT_BASE,
        tenant: target.tenant,
        phone: turn.phone,
        text: turn.text,
        fetchImpl,
        cookie,
      });
      if (posted.redirectRefused) {
        return failResult({
          cause: { code: 'redirect_refused', status: posted.status, error: 'redirect', location: posted.location },
          target,
          dryRun,
          planned,
          scripts: loaded.scripts,
          outDir,
        });
      }
      const body = posted.body || {};
      if (posted.status === 401 || posted.status >= 400 || body.ok === false || body.success === false) {
        const cause = {
          status: posted.status,
          error: body.error || body.code || 'request_failed',
          code: body.code || (posted.status === 401 ? 'unauthorized' : 'request_failed'),
        };
        return failResult({ cause, target, dryRun, planned, scripts: loaded.scripts, outDir });
      }
      if (Array.isArray(body.tool_calls)) evidence.tool_calls.push(...body.tool_calls);
      if (body.session_id) evidence.session_id = body.session_id;
      replies.push({
        script_id: turn.script_id,
        index: turn.index,
        guest: turn.text,
        reply: body.reply_text || '',
        status: posted.status,
        no_real_sends: noSendEvidence(body),
        session_id: body.session_id || null,
        tool_calls: body.tool_calls || [],
        limitation: body.limitation || null,
      });
    }
    return finishRun({
      dryRun: false,
      live: true,
      target,
      loaded,
      planned,
      replies,
      phones,
      runId,
      outDir,
      evidence,
    });
  }

  return finishRun({
    dryRun: true,
    live: false,
    target,
    loaded,
    planned,
    replies: [],
    phones,
    runId,
    outDir,
    evidence: { tool_calls: [], session_id: null, errors: [] },
  });
}

function finishRun({ dryRun, live, target, loaded, planned, replies, phones, runId, outDir, evidence }) {
  const transcripts = [];
  for (const script of loaded.scripts) {
    const id = script.id || script._file;
    const scriptReplies = replies.filter((row) => row.script_id === id);
    const turns = (script.turns || []).map((turn, index) => {
      const reply = scriptReplies.find((row) => row.index === index);
      const row = { role: 'guest', text: turn.guest, name: turn.name || null };
      if (reply) row.reply = reply.reply;
      return row;
    });
    const file = path.join(outDir, id + '.json');
    const saved = {
      id,
      target: target.id,
      runtime: target.runtime,
      tenant: target.tenant,
      phone: phones[id] || script.phone,
      dates: script.dates,
      dry_run: dryRun,
      executed: live,
      turns,
    };
    writeJson(file, saved);
    transcripts.push({ id, path: file });
  }
  const memoryKey = target.tenant + ':' + runId;
  const summary = {
    ok: true,
    dry_run: dryRun,
    executed: live,
    target,
    run_id: runId,
    memory_key: memoryKey,
    evidence,
    scripts: loaded.scripts.map((script) => script.id || script._file),
    planned_turns: planned,
    transcripts,
    scorecard: scoreRun({
      dryRun,
      executed: live,
      scripts: loaded.scripts,
      replies,
      scorecard: loaded.scorecard,
    }),
  };
  const summaryPath = path.join(outDir, 'summary.json');
  writeJson(summaryPath, summary);
  writeJson(path.join(outDir, 'scorecard.json'), summary.scorecard);
  summary.summary_path = summaryPath;
  return summary;
}

async function runPaired(options) {
  const opts = options || {};
  const outDir = opts.outDir || path.join(opts.repoRoot || path.resolve(__dirname, '..'), 'tmp', 'luna-v3-sidebyside', 'pair');
  const v3 = await runSideBySide(Object.assign({}, opts, {
    target: 'hermes-luna-clone',
    runId: String(opts.runId || 'pair') + '-v3',
    outDir: path.join(outDir, 'v3'),
    fetchImpl: (opts.fetchImplByTarget && opts.fetchImplByTarget['hermes-luna-clone']) || opts.fetchImpl,
  }));
  const classic = await runSideBySide(Object.assign({}, opts, {
    target: 'hermes-luna',
    runId: String(opts.runId || 'pair') + '-classic',
    outDir: path.join(outDir, 'classic'),
    fetchImpl: (opts.fetchImplByTarget && opts.fetchImplByTarget['hermes-luna']) || opts.fetchImpl,
  }));
  const ids = new Set([].concat(v3.scripts || [], classic.scripts || []));
  const outcomes = Array.from(ids).map((id) => {
    const v3File = (v3.transcripts || []).find((row) => row.id === id);
    const classicFile = (classic.transcripts || []).find((row) => row.id === id);
    const v3Turns = v3File ? JSON.parse(fs.readFileSync(v3File.path, 'utf8')).turns : [];
    const classicTurns = classicFile ? JSON.parse(fs.readFileSync(classicFile.path, 'utf8')).turns : [];
    return {
      id,
      v3: { reply: (v3Turns.find((turn) => turn.reply) || {}).reply || '' },
      classic: { reply: (classicTurns.find((turn) => turn.reply) || {}).reply || '' },
    };
  });
  return { ok: v3.ok && classic.ok, v3, classic, outcomes };
}

async function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  const liveConfirmed = process.env.LUNA_V3_SIDEBYSIDE_LIVE === '1';
  if (args.live && !liveConfirmed) {
    throw new Error('refusing live Crow\'s Nest run; set LUNA_V3_SIDEBYSIDE_LIVE=1 after Skip lands v3');
  }
  const result = await runSideBySide({
    target: args.target,
    dryRun: args.dryRun,
    live: args.live,
    liveConfirmed,
    outDir: args.outDir,
    cookie: operatorSessionFrom({}, process.env),
    fetchImpl: args.live ? globalThis.fetch : undefined,
  });
  if (!result.ok) {
    console.error('FAIL ' + JSON.stringify(result.cause || { error: 'side-by-side failed' }));
    process.exit(1);
  }
  console.log(result.dry_run ? 'DRY-RUN luna v3 side-by-side' : 'LIVE luna v3 side-by-side');
  console.log('target ' + result.target.id);
  console.log('scripts ' + result.scripts.length);
  console.log('planned_turns ' + result.planned_turns.length);
  console.log('out ' + result.summary_path);
}

module.exports = {
  TARGETS,
  RESERVED_PHONE,
  resolveTarget,
  resolveCrowsnestBase,
  parseArgs,
  runSideBySide,
  runPaired,
  loadFrozenScripts,
  operatorSessionFrom,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('FAIL ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}
