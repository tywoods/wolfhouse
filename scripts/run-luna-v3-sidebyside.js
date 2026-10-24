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
    tenant: 'wolfhouse-clone',
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
  const args = { dryRun: true, live: false, target: 'hermes-luna-clone', outDir: '', liveConfirmed: false, set: 'sidebyside' };
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
    } else if (token === '--set') {
      args.set = list[i + 1];
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

function fixtureDir(repoRoot, setName) {
  const set = String(setName || 'sidebyside');
  if (set === 'acceptance') return path.join(repoRoot, 'fixtures', 'luna-v3', 'acceptance');
  return path.join(repoRoot, 'scripts', 'fixtures', 'luna-v3-sidebyside');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadFrozenScripts(repoRoot, setName) {
  const dir = fixtureDir(repoRoot, setName);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('sidebyside pack missing: ' + dir);
  }
  const manifest = readJson(manifestPath);
  let scorecard = {};
  const scorePath = path.join(dir, 'scorecard.json');
  if (fs.existsSync(scorePath)) scorecard = readJson(scorePath);
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

function nightCount(checkIn, checkOut) {
  const start = Date.parse(String(checkIn) + 'T00:00:00Z');
  const end = Date.parse(String(checkOut) + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return -1;
  return Math.round((end - start) / 86400000);
}

function isoDatesInText(text) {
  return String(text || '').match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
}

function dateInWindow(iso, checkIn, checkOut) {
  return iso >= checkIn && iso <= checkOut;
}

const MONTH_INDEX = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function monthNamesInText(text) {
  const found = [];
  const lower = String(text || '').toLowerCase();
  for (const [name, month] of Object.entries(MONTH_INDEX)) {
    if (lower.includes(name)) found.push(month);
  }
  return found;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function namedDayRanges(text, yearHint) {
  const src = String(text || '').replace(/\u2013|\u2014/g, '-');
  const found = [];
  const rangeRe = /(\d{1,2})\s*(?:to|-)\s*(\d{1,2})\s+([A-Za-z]+)(?:\s+(20\d{2}))?/gi;
  let match;
  while ((match = rangeRe.exec(src))) {
    const month = MONTH_INDEX[match[3].toLowerCase()];
    if (!month) continue;
    found.push({
      startDay: Number(match[1]),
      endDay: Number(match[2]),
      month,
      year: match[4] ? Number(match[4]) : Number(yearHint),
    });
  }
  const esRange = /(\d{1,2})\s*(?:al|a|-)\s*(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(20\d{2}))?/gi;
  while ((match = esRange.exec(src))) {
    const month = MONTH_INDEX[match[3].toLowerCase()];
    if (!month) continue;
    found.push({
      startDay: Number(match[1]),
      endDay: Number(match[2]),
      month,
      year: match[4] ? Number(match[4]) : Number(yearHint),
    });
  }
  const monthFirst = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\s*(?:to|-)\s*(\d{1,2})(?:\s*,?\s*(20\d{2}))?/gi;
  while ((match = monthFirst.exec(src))) {
    const month = MONTH_INDEX[match[1].toLowerCase()];
    if (!month) continue;
    found.push({
      startDay: Number(match[2]),
      endDay: Number(match[3]),
      month,
      year: match[4] ? Number(match[4]) : Number(yearHint),
    });
  }
  const singleRe = /(\d{1,2})\s+([A-Za-z]+)(?:\s+(20\d{2}))?/gi;
  while ((match = singleRe.exec(src))) {
    const month = MONTH_INDEX[match[2].toLowerCase()];
    if (!month) continue;
    const day = Number(match[1]);
    const year = match[3] ? Number(match[3]) : Number(yearHint);
    const already = found.some((range) => range.month === month && range.year === year && day >= range.startDay && day <= range.endDay);
    if (already) continue;
    found.push({ startDay: day, endDay: day, month, year });
  }
  return found;
}

function assertDialogueMatches2027(text, label, windows) {
  const list = (Array.isArray(windows) ? windows : [windows]).filter((window) => window && window.check_in && window.check_out);
  const years = String(text || '').match(/\b(20\d{2})\b/g) || [];
  for (const year of years) {
    if (year !== '2027') {
      throw new Error(label + ' dialogue is not in the 2027 window');
    }
  }
  if (!list.length) return;
  for (const iso of isoDatesInText(text)) {
    if (!isRealCalendarDate(iso)) {
      throw new Error(label + ' dialogue has an invalid calendar date');
    }
    if (!list.some((window) => dateInWindow(iso, window.check_in, window.check_out))) {
      throw new Error(label + ' dialogue date is outside the approved window');
    }
  }
  const isoList = isoDatesInText(text);
  for (let i = 0; i < isoList.length - 1; i += 1) {
    if (isoList[i] > isoList[i + 1]) {
      throw new Error(label + ' dialogue has a reversed date range');
    }
  }
  const yearHint = String(list[0].check_in).slice(0, 4);
  for (const range of namedDayRanges(text, yearHint)) {
    if (range.startDay > range.endDay) {
      throw new Error(label + ' dialogue has a reversed date range');
    }
    const startIso = range.year + '-' + pad2(range.month) + '-' + pad2(range.startDay);
    const endIso = range.year + '-' + pad2(range.month) + '-' + pad2(range.endDay);
    if (!isRealCalendarDate(startIso) || !isRealCalendarDate(endIso)) {
      throw new Error(label + ' dialogue has an invalid calendar date');
    }
    if (!list.some((window) => dateInWindow(startIso, window.check_in, window.check_out) && dateInWindow(endIso, window.check_in, window.check_out))) {
      throw new Error(label + ' dialogue date is outside the approved window');
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
    const nights = nightCount(window.check_in, window.check_out);
    if (nights < 1) {
      throw new Error(label + ' has a reversed or zero-night range');
    }
  }
  const turns = Array.isArray(script.turns) ? script.turns : [];
  if (!turns.length) throw new Error(label + ' has no turns');
  for (const turn of turns) {
    if (typeof turn.guest !== 'string' || turn.guest.trim().length < 8) {
      throw new Error(label + ' is missing guest dialogue');
    }
    assertDialogueMatches2027(turn.guest, label, windows);
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
  return limitation.whatsapp_sends_enabled === false
    && limitation.sms_sends_enabled === false
    && limitation.tenant_whatsapp_suppressed === true
    && body.external_send_allowed !== true;
}

function inspectNoSend(body) {
  const limitation = body && body.limitation;
  if (!limitation || typeof limitation !== 'object') {
    return { ok: false, code: 'missing_no_send_evidence', error: 'limitation missing' };
  }
  const waOff = limitation.whatsapp_sends_enabled === false;
  const smsOff = limitation.sms_sends_enabled === false;
  if (!waOff || !smsOff) {
    return { ok: false, code: 'unsafe_no_send_evidence', error: 'sends not proven off' };
  }
  if (limitation.tenant_whatsapp_suppressed !== true) {
    return { ok: false, code: 'missing_tenant_suppression', error: 'tenant WhatsApp suppression missing' };
  }
  if (body.whatsapp_suppressed === true && limitation.whatsapp_sends_enabled === true) {
    return { ok: false, code: 'contradictory_no_send_evidence', error: 'root vs nested limitation' };
  }
  if (body.external_send_allowed === true) {
    return { ok: false, code: 'contradictory_no_send_evidence', error: 'external_send_allowed true' };
  }
  return { ok: true };
}

function isBatchStop(cause) {
  const code = String((cause && cause.code) || '');
  return /no_send|tenant_suppression|unsafe_no_send|missing_no_send|request_failed|runtime_timeout|unauthorized|redirect/i.test(code);
}

function defaultIdentityLedger(repoRoot) {
  return path.join(repoRoot, 'tmp', 'luna-v3-sidebyside', 'reserved-identities.json');
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withIdentityLock(file, fn) {
  const lockPath = String(file) + '.lock';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.now();
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > 10000) {
        return { ok: false, code: 'ledger_lock_timeout', error: 'identity ledger lock timeout' };
      }
      sleepMs(20);
      continue;
    }
    try {
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

function loadIdentityLedger(file) {
  try {
    fs.accessSync(file, fs.constants.F_OK);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, phones: new Set(), identities: new Set() };
    }
    return { ok: false, code: 'ledger_unreadable', error: err.code || err.message };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, code: 'ledger_unreadable', error: err.code || err.message };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'ledger_unreadable', error: 'truncated or invalid json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.phones) || !Array.isArray(data.identities)) {
    return { ok: false, code: 'ledger_unreadable', error: 'wrong-shape ledger' };
  }
  if (!data.phones.every((row) => typeof row === 'string') || !data.identities.every((row) => typeof row === 'string')) {
    return { ok: false, code: 'ledger_unreadable', error: 'wrong-shape ledger' };
  }
  return { ok: true, phones: new Set(data.phones), identities: new Set(data.identities) };
}

function saveIdentityLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, {
    phones: Array.from(ledger.phones),
    identities: Array.from(ledger.identities),
  });
}

function isReservedPhoneString(value) {
  return typeof value === 'string' && RESERVED_PHONE.test(value);
}

function reserveIdentity(used, ledger, tenant, phone) {
  if (typeof phone !== 'string') {
    return { ok: false, identity: tenant + '|', phone };
  }
  const identity = tenant + '|' + phone;
  if (used.has(phone) || ledger.phones.has(phone) || ledger.identities.has(identity)) {
    return { ok: false, identity, phone };
  }
  used.add(phone);
  ledger.phones.add(phone);
  ledger.identities.add(identity);
  return { ok: true, identity, phone };
}

function allocateWirePhone(used, ledger, tenant) {
  const seen = used || new Set();
  const book = ledger || { phones: new Set(), identities: new Set() };
  let n = 0;
  while (n < 100000) {
    const phone = '+346999' + String(n).padStart(5, '0');
    n += 1;
    if (!isReservedPhoneString(phone)) {
      throw new Error('reserved phone pool exhausted');
    }
    const reserved = reserveIdentity(seen, book, tenant, phone);
    if (reserved.ok) return phone;
  }
  throw new Error('reserved phone pool exhausted');
}

function isAdmittedCapability(cap) {
  if (!cap || typeof cap !== 'object') return false;
  if (cap.admitted === true) return true;
  return String(cap.outcome || '').toUpperCase() === 'ADMITTED';
}

function isDeniedCapability(cap) {
  if (!cap || typeof cap !== 'object') return false;
  if (cap.admitted === false) return true;
  return /DENIED|BLOCKED|REFUSED/i.test(String(cap.outcome || ''));
}

function isBookingWriteReceipt(tool) {
  if (!tool || typeof tool !== 'object') return false;
  if (tool.booking_write === true || tool.wrote_booking === true) return true;
  if (typeof tool.booking_id === 'string' && tool.booking_id.trim()) return true;
  const name = String(tool.name || tool.tool || '');
  if (!/create_booking|save_booking|hold_beds|holdBeds|write_booking/i.test(name)) return false;
  const summary = String(tool.result_summary || '');
  return tool.ok === true || /success\s*=\s*true/i.test(summary);
}

function collectToolCalls(replies, evidence) {
  const tools = [];
  for (const row of Array.isArray(replies) ? replies : []) {
    if (Array.isArray(row.tool_calls)) tools.push(...row.tool_calls);
  }
  if (evidence && Array.isArray(evidence.tool_calls)) tools.push(...evidence.tool_calls);
  return tools;
}

function limitationAdmitsBookingWrites(lim) {
  if (!lim || typeof lim !== 'object') return false;
  if (lim.booking_writes_enabled === true) return true;
  if (lim.capability_admitted === true) return true;
  if (lim.writes_enabled === true) return true;
  if (isAdmittedCapability(lim)) return true;
  return false;
}

function observeWrites(replies, evidence) {
  const tools = collectToolCalls(replies, evidence);
  let admitted = false;
  let denied = false;
  let writesEnabledFalse = false;
  for (const tool of tools) {
    const cap = tool && tool.effective_capability;
    if (isAdmittedCapability(cap)) admitted = true;
    else if (isDeniedCapability(cap)) denied = true;
    if (isBookingWriteReceipt(tool)) admitted = true;
  }
  for (const row of Array.isArray(replies) ? replies : []) {
    const lim = row && row.limitation;
    if (!lim || typeof lim !== 'object') continue;
    if (limitationAdmitsBookingWrites(lim)) admitted = true;
    if (Object.prototype.hasOwnProperty.call(lim, 'writes_enabled') && lim.writes_enabled === false) {
      writesEnabledFalse = true;
    }
  }
  if (admitted) return 'admitted';
  if (denied || writesEnabledFalse) return 'blocked';
  return 'unknown';
}

function scoreRun({ dryRun, executed, scripts, replies, scorecard, attempts, evidence }) {
  const replyFingerprint = crypto.createHash('sha256').update(replies.map((row) => row.reply || '').join('\n')).digest('hex');
  const attemptList = Array.isArray(attempts) ? attempts : [];
  const attemptsClean = attemptList.length === 0 || attemptList.every((row) => row.outcome === 'ok');
  const thisRun = {
    executed,
    dry_run: dryRun,
    safety_floor_certified: false,
    beats_classic: null,
    no_real_sends: executed && attemptsClean && replies.length > 0 && replies.every((row) => row.no_real_sends),
    reply_fingerprint: executed ? replyFingerprint : null,
    observations: { writes: observeWrites(replies, evidence), payments: 'blocked' },
    reason: dryRun ? 'dry_run_not_executed' : 'transcripts captured; safety floor stays uncertified without Staff observations',
    scripts: scripts.map((script) => {
      const id = script.id || script._file;
      const scriptReplies = replies.filter((row) => row.script_id === id);
      return {
        id,
        status: dryRun ? 'pending' : 'recorded',
        replies: scriptReplies.map((row) => row.reply || ''),
        tool_calls: scriptReplies.map((row) => row.tool_calls || []),
      };
    }),
  };
  return Object.assign({}, scorecard, { this_run: thisRun });
}

function failResult({ cause, target, dryRun, planned, scripts, outDir, scorecard, replies, phones, runId, evidence, attempts }) {
  const loaded = { scripts: scripts || [], scorecard: scorecard || {} };
  const attemptList = Array.isArray(attempts) ? attempts : [];
  const attempted = attemptList.length > 0 || (Array.isArray(replies) && replies.length > 0);
  const liveAttempt = dryRun !== true && attempted;
  const summary = finishRun({
    dryRun: !liveAttempt,
    live: liveAttempt,
    target,
    loaded,
    planned: planned || [],
    replies: replies || [],
    phones: phones || {},
    runId: runId || 'failed',
    outDir,
    evidence: evidence || { tool_calls: [], session_id: null, errors: [] },
    attempts: attemptList,
  });
  summary.ok = false;
  summary.cause = cause;
  summary.executed = liveAttempt;
  summary.dry_run = dryRun === true;
  summary.receipts = replies || [];
  summary.attempts = attemptList;
  summary.finished_progress = (replies || []).length;
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
  if (status < 200 || status >= 300) {
    const location = headerGet(response.headers, 'location') || headerGet(response.headers, 'Location');
    return {
      url,
      status,
      nonSuccess: true,
      redirectRefused: status >= 300 && status < 400,
      location,
      body: {},
    };
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
    : loadFrozenScripts(repoRoot, opts.set);
  for (const script of loaded.scripts) assertScript(script);
  const runId = String(opts.runId || Date.now());
  const stamp = target.id;
  const outDir = opts.outDir || path.join(repoRoot, 'tmp', 'luna-v3-sidebyside', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const usedPhones = opts.usedPhones || new Set();
  const ledgerFile = opts.identityLedger || defaultIdentityLedger(repoRoot);
  const phones = {};
  if (live) {
    let locked;
    try {
      locked = withIdentityLock(ledgerFile, () => {
        const book = loadIdentityLedger(ledgerFile);
        if (!book.ok) return book;
        const plan = opts.identityPlan && typeof opts.identityPlan === 'object' ? opts.identityPlan : {};
        const nextPhones = {};
        for (const script of loaded.scripts) {
          const id = script.id || script._file;
          if (Object.prototype.hasOwnProperty.call(plan, id)) {
            const plannedPhone = plan[id];
            if (!isReservedPhoneString(plannedPhone)) {
              return { ok: false, code: 'invalid_identity', error: 'identity is not a reserved test phone' };
            }
            const reserved = reserveIdentity(usedPhones, book, target.tenant, plannedPhone);
            if (!reserved.ok) {
              return { ok: false, code: 'reused_identity', error: 'identity already reserved', identity: reserved.identity };
            }
            nextPhones[id] = plannedPhone;
          } else {
            try {
              nextPhones[id] = allocateWirePhone(usedPhones, book, target.tenant);
            } catch (err) {
              return { ok: false, code: 'phone_pool_exhausted', error: err && err.message ? err.message : 'reserved phone pool exhausted' };
            }
          }
          if (!isReservedPhoneString(nextPhones[id])) {
            return { ok: false, code: 'invalid_identity', error: 'identity is not a reserved test phone' };
          }
        }
        saveIdentityLedger(ledgerFile, book);
        return { ok: true, phones: nextPhones };
      });
    } catch (err) {
      locked = { ok: false, code: 'ledger_unreadable', error: err && err.message ? err.message : 'ledger lock failed' };
    }
    if (!locked || !locked.ok) {
      return failResult({
        cause: { code: (locked && locked.code) || 'ledger_unreadable', error: (locked && locked.error) || 'identity ledger blocked', identity: locked && locked.identity },
        target,
        dryRun,
        planned: [],
        scripts: loaded.scripts,
        outDir,
        phones,
        runId,
      });
    }
    Object.assign(phones, locked.phones);
  } else {
    loaded.scripts.forEach((script) => {
      const id = script.id || script._file;
      phones[id] = script.phone;
    });
  }
  const planned = planTurns(loaded.scripts, phones);

  for (const script of loaded.scripts) {
    const id = script.id || script._file;
    const resolvedPhone = phones[id];
    const identity = target.tenant + '|' + resolvedPhone;
    const pre = script.prerequisites || {};
    const bound = opts.prerequisiteEvidence || {};
    for (const key of Object.keys(pre)) {
      const item = pre[key];
      if (!item || item.required !== true) continue;
      if (!(bound[identity] && bound[identity][key] === true)) {
        return failResult({
          cause: { code: 'BLOCKED', error: key + ' prerequisite not bound to ' + identity },
          target,
          dryRun,
          planned,
          scripts: loaded.scripts,
          outDir,
          phones,
          runId,
        });
      }
    }
  }

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
    const attempts = [];
    const evidence = { tool_calls: [], session_id: null, errors: [] };
    const failLive = (cause) => failResult({
      cause,
      target,
      dryRun,
      planned,
      scripts: loaded.scripts,
      outDir,
      replies,
      phones,
      runId,
      evidence,
      attempts,
    });
    for (const turn of planned) {
      let posted;
      try {
        posted = await postTurn({
          base: opts.crowsnestBase || DEFAULT_BASE,
          tenant: target.tenant,
          phone: turn.phone,
          text: turn.text,
          fetchImpl,
          cookie,
        });
      } catch (err) {
        attempts.push({ script_id: turn.script_id, index: turn.index, outcome: 'error', error: err && err.message ? err.message : 'turn failed' });
        return failLive({ code: 'runtime_timeout', error: err && err.message ? err.message : 'turn failed' });
      }
      if (posted.nonSuccess || posted.redirectRefused || posted.status < 200 || posted.status >= 300) {
        attempts.push({ script_id: turn.script_id, index: turn.index, outcome: 'error', status: posted.status });
        const code = posted.status === 401
          ? 'unauthorized'
          : (posted.redirectRefused ? 'redirect_refused' : 'request_failed');
        return failLive({
          code,
          status: posted.status,
          error: posted.status === 401 ? 'unauthorized' : (posted.redirectRefused ? 'redirect' : 'non-success status'),
          location: posted.location,
        });
      }
      const body = posted.body || {};
      if (body.ok === false || body.success === false) {
        attempts.push({ script_id: turn.script_id, index: turn.index, outcome: 'error', status: posted.status });
        return failLive({
          status: posted.status,
          error: body.error || body.code || 'request_failed',
          code: body.code || 'request_failed',
        });
      }
      attempts.push({ script_id: turn.script_id, index: turn.index, outcome: 'ok', status: posted.status });
      const sendCheck = inspectNoSend(body);
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
      if (!sendCheck.ok) {
        attempts[attempts.length - 1].outcome = 'unknown';
        return failLive({ code: sendCheck.code, error: sendCheck.error });
      }
      if (Array.isArray(body.tool_calls)) evidence.tool_calls.push(...body.tool_calls);
      if (body.session_id) evidence.session_id = body.session_id;
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
      attempts,
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

function finishRun({ dryRun, live, target, loaded, planned, replies, phones, runId, outDir, evidence, attempts }) {
  const transcripts = [];
  for (const script of loaded.scripts) {
    const id = script.id || script._file;
    const scriptReplies = replies.filter((row) => row.script_id === id);
    const turns = (script.turns || []).map((turn, index) => {
      const reply = scriptReplies.find((row) => row.index === index);
      const row = { role: 'guest', text: turn.guest, name: turn.name || null };
      if (reply) {
        row.reply = reply.reply;
        row.session_id = reply.session_id || null;
        row.no_real_sends = reply.no_real_sends === true;
        row.limitation = reply.limitation || null;
        row.status = reply.status || null;
        row.tool_calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
      }
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
    attempts: Array.isArray(attempts) ? attempts : [],
    scorecard: scoreRun({
      dryRun,
      executed: live,
      scripts: loaded.scripts,
      replies,
      scorecard: loaded.scorecard,
      attempts: Array.isArray(attempts) ? attempts : [],
      evidence,
    }),
  };
  const summaryPath = path.join(outDir, 'summary.json');
  writeJson(summaryPath, summary);
  writeJson(path.join(outDir, 'scorecard.json'), summary.scorecard);
  summary.summary_path = summaryPath;
  return summary;
}

function alignedOutcomes(v3, classic) {
  const ids = new Set([].concat((v3 && v3.scripts) || [], (classic && classic.scripts) || []));
  return Array.from(ids).map((id) => {
    const v3File = ((v3 && v3.transcripts) || []).find((row) => row.id === id);
    const classicFile = ((classic && classic.transcripts) || []).find((row) => row.id === id);
    const v3Turns = v3File ? JSON.parse(fs.readFileSync(v3File.path, 'utf8')).turns : [];
    const classicTurns = classicFile ? JSON.parse(fs.readFileSync(classicFile.path, 'utf8')).turns : [];
    const count = Math.max(v3Turns.length, classicTurns.length);
    const turns = [];
    for (let t = 0; t < count; t += 1) {
      turns.push({
        index: t,
        v3: (v3Turns[t] && v3Turns[t].reply) || '',
        classic: (classicTurns[t] && classicTurns[t].reply) || '',
        v3_tools: (v3Turns[t] && v3Turns[t].tool_calls) || [],
        classic_tools: (classicTurns[t] && classicTurns[t].tool_calls) || [],
      });
    }
    return {
      id,
      v3: {
        reply: (v3Turns.find((turn) => turn.reply) || {}).reply || '',
        tool_calls: v3Turns.flatMap((turn) => turn.tool_calls || []),
      },
      classic: {
        reply: (classicTurns.find((turn) => turn.reply) || {}).reply || '',
        tool_calls: classicTurns.flatMap((turn) => turn.tool_calls || []),
      },
      turns,
    };
  });
}

async function runPaired(options) {
  const opts = options || {};
  const repeats = opts.repeats == null ? 3 : Number(opts.repeats);
  if (opts.blockRepeats === true) {
    return { ok: false, cause: { code: 'repeats_blocked', error: 'prescribed repeats blocked' }, repeats: 0, runs: [], outcomes: [] };
  }
  const outDir = opts.outDir || path.join(opts.repoRoot || path.resolve(__dirname, '..'), 'tmp', 'luna-v3-sidebyside', 'pair');
  const usedPhones = opts.usedPhones || new Set();
  const runs = [];
  let stopped = null;
  for (let i = 0; i < repeats; i += 1) {
    const nonce = crypto.randomBytes(8).toString('hex');
    const runId = String(opts.runId || 'pair') + '-' + String(i) + '-' + nonce;
    const v3First = i % 2 === 0;
    const runOne = async (targetName, kind) => runSideBySide(Object.assign({}, opts, {
      target: targetName,
      runId: runId + '-' + kind,
      outDir: path.join(outDir, 'r' + String(i), kind),
      fetchImpl: (opts.fetchImplByTarget && opts.fetchImplByTarget[targetName]) || opts.fetchImpl,
      usedPhones,
    }));
    let v3;
    let classic;
    if (v3First) {
      v3 = await runOne('hermes-luna-clone', 'v3');
      if (!v3.ok) {
        runs.push({ v3, classic: { ok: false, scripts: [], transcripts: [] }, order: ['v3'] });
        stopped = v3.cause;
        break;
      }
      classic = await runOne('hermes-luna', 'classic');
      runs.push({ v3, classic, order: ['v3', 'classic'] });
      if (!classic.ok) {
        stopped = classic.cause;
        break;
      }
    } else {
      classic = await runOne('hermes-luna', 'classic');
      if (!classic.ok) {
        runs.push({ v3: { ok: false, scripts: [], transcripts: [] }, classic, order: ['classic'] });
        stopped = classic.cause;
        break;
      }
      v3 = await runOne('hermes-luna-clone', 'v3');
      runs.push({ v3, classic, order: ['classic', 'v3'] });
      if (!v3.ok) {
        stopped = v3.cause;
        break;
      }
    }
  }
  const last = runs[runs.length - 1] || { v3: { scripts: [] }, classic: { scripts: [] } };
  const outcomes_by_repeat = runs.map((row, index) => ({
    repeat: index,
    order: row.order || [],
    outcomes: alignedOutcomes(row.v3, row.classic),
  }));
  const outcomes = alignedOutcomes(last.v3, last.classic);
  const comparison = { repeats: outcomes_by_repeat.length, outcomes_by_repeat };
  const comparisonPath = path.join(outDir, 'comparison.json');
  writeJson(comparisonPath, comparison);
  return {
    ok: !stopped && runs.length === repeats && runs.every((row) => row.v3.ok && row.classic.ok),
    cause: stopped || undefined,
    v3: last.v3,
    classic: last.classic,
    outcomes,
    outcomes_by_repeat,
    comparison_path: comparisonPath,
    repeats: outcomes_by_repeat.length,
    prescribed_repeats: repeats,
    runs,
  };
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
    set: args.set,
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
  observeWrites,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('FAIL ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}
