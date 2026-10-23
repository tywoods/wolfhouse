'use strict';

// Offline Luna v3 vs Classic side-by-side runner. Default is dry-run: it
// plans the frozen guest scripts against hermes-luna-clone or hermes-luna
// and never calls Crow's Nest, WhatsApp, Staff, or France.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE = 'https://crowsnest.lunafrontdesk.com';
const GUEST_TURN_PATH = '/api/live-simulator/guest-turn';
const RESERVED_PHONE = /^\+346999\d{5}$/;
const YEAR_PREFIX = '2027-';

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
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--live') {
      args.live = true;
      args.dryRun = false;
    } else if (token === '--target') {
      args.target = list[i + 1];
      i += 1;
    } else if (token === '--out') {
      args.outDir = list[i + 1];
      i += 1;
    }
  }
  return args;
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

function assertProposedYear(value, label) {
  if (typeof value !== 'string' || !value.startsWith(YEAR_PREFIX)) {
    throw new Error(label + ' is not a proposed 2027 window');
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
  assertProposedYear(script.dates.check_in, label + ' check_in');
  assertProposedYear(script.dates.check_out, label + ' check_out');
  const turns = Array.isArray(script.turns) ? script.turns : [];
  if (!turns.length) throw new Error(label + ' has no turns');
  for (const turn of turns) {
    if (typeof turn.guest !== 'string' || turn.guest.trim().length < 8) {
      throw new Error(label + ' is missing guest dialogue');
    }
  }
}

function planTurns(scripts) {
  const planned = [];
  for (const script of scripts) {
    (script.turns || []).forEach((turn, index) => {
      planned.push({
        script_id: script.id || script._file,
        phone: script.phone,
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
  if (!body || typeof body !== 'object') return false;
  if (body.whatsapp_suppressed === true && body.external_send_allowed === false) return true;
  return false;
}

function scoreRun({ dryRun, executed, scripts, replies, scorecard }) {
  const thisRun = {
    executed,
    dry_run: dryRun,
    safety_floor_certified: false,
    beats_classic: null,
    no_real_sends: executed ? replies.every((row) => row.no_real_sends) : false,
    reason: dryRun ? 'dry_run_not_executed' : 'transcripts captured; safety floor stays uncertified without Staff observations',
    scripts: scripts.map((script) => ({
      id: script.id || script._file,
      status: dryRun ? 'pending' : 'recorded',
    })),
  };
  return Object.assign({}, scorecard, { this_run: thisRun });
}

async function postTurn({ base, tenant, phone, text, fetchImpl, cookie }) {
  const url = String(base || DEFAULT_BASE).replace(/\/+$/, '') + GUEST_TURN_PATH;
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
  });
  const parsed = typeof response.json === 'function' ? await response.json() : {};
  return { url, status: response.status, body: parsed };
}

async function runSideBySide(options) {
  const opts = options || {};
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
  const target = resolveTarget(opts.target);
  const dryRun = opts.dryRun !== false && opts.live !== true;
  const live = opts.live === true && dryRun === false;
  if (live && opts.liveConfirmed !== true) {
    throw new Error('refusing live Crow\'s Nest run without live confirmation');
  }
  const loaded = opts.scripts
    ? { scripts: opts.scripts, scorecard: opts.scorecard || {}, manifest: opts.manifest || {} }
    : loadFrozenScripts(repoRoot);
  for (const script of loaded.scripts) assertScript(script);
  const planned = planTurns(loaded.scripts);
  const stamp = target.id;
  const outDir = opts.outDir || path.join(repoRoot, 'tmp', 'luna-v3-sidebyside', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const replies = [];
  if (live) {
    const fetchImpl = opts.fetchImpl;
    if (typeof fetchImpl !== 'function') {
      throw new Error('live run requires an injected fetchImpl in this lane');
    }
    for (const turn of planned) {
      const posted = await postTurn({
        base: opts.crowsnestBase || DEFAULT_BASE,
        tenant: target.tenant,
        phone: turn.phone,
        text: turn.text,
        fetchImpl,
        cookie: opts.cookie,
      });
      const body = posted.body || {};
      replies.push({
        script_id: turn.script_id,
        index: turn.index,
        guest: turn.text,
        reply: body.reply_text || '',
        status: posted.status,
        no_real_sends: noSendEvidence(body),
      });
    }
  }

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
      phone: script.phone,
      dates: script.dates,
      dry_run: dryRun,
      executed: live,
      turns,
    };
    writeJson(file, saved);
    transcripts.push({ id, path: file });
  }

  const summary = {
    ok: true,
    dry_run: dryRun,
    executed: live,
    target,
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
    fetchImpl: args.live ? globalThis.fetch : undefined,
  });
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
  parseArgs,
  runSideBySide,
  loadFrozenScripts,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('FAIL ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}
