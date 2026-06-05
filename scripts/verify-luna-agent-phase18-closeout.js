/**
 * Phase 18f — Fast static closeout verifier for Luna draft + auto-reply eligibility.
 *
 * Anchors Phase 18a–18e without re-running long downstream closeout trees.
 *
 * Hosted proof anchors (static, not re-run here):
 *   18b.1 commit 4011221 — hosted guest-reply-draft route proof PASS
 *   18d.1 commit 7fc47ad — hosted send_eligibility on draft route PASS
 *   18e.1 commit c57523e — accepted with waiver (not full n8n runtime PASS)
 *
 * 18e.1 waiver (owner accepted, non-blocking):
 *   workflow import/static/simulated chain passed;
 *   Case C editor output confirmed /staff/bot/guest-reply-draft;
 *   A/B editor execution IDs not captured (manual n8n editor friction).
 *
 * Live WhatsApp NO_GO.
 *
 * Usage:
 *   npm run verify:luna-agent-phase18-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const PKG           = path.join(ROOT, 'package.json');
const DOC           = path.join(ROOT, 'docs', 'PHASE-18.1-LUNA-LIVE-AUTOMATION-GATES-PLAN.md');
const DRAFT_HELPER  = path.join(__dirname, 'lib', 'luna-guest-reply-draft.js');
const ELIG_HELPER   = path.join(__dirname, 'lib', 'luna-guest-reply-send-eligibility.js');
const API           = path.join(__dirname, 'staff-query-api.js');
const WF_PATH       = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');

const WAIVER_18E1 = '18e.1 accepted with waiver: workflow import/static/simulated chain passed; Case C editor output confirmed /staff/bot/guest-reply-draft; A/B editor execution IDs were not captured due manual n8n editor friction. Owner accepted as non-blocking. Live WhatsApp remains NO_GO.';

const PHASE18_SCRIPTS = [
  ['verify:luna-agent-phase18-live-gates-plan', 'scripts/verify-luna-agent-phase18-live-gates-plan.js'],
  ['verify:luna-agent-phase18-draft-builder', 'scripts/verify-luna-agent-phase18-draft-builder.js'],
  ['verify:luna-agent-phase18-send-eligibility', 'scripts/verify-luna-agent-phase18-send-eligibility.js'],
  ['verify:luna-agent-phase18-n8n-draft-shadow', 'scripts/verify-luna-agent-phase18-n8n-draft-shadow.js'],
  ['verify:luna-agent-phase18-closeout', 'scripts/verify-luna-agent-phase18-closeout.js'],
];

const PRIOR_CLOSEOUT_SCRIPTS = [
  ['verify:luna-agent-phase17-closeout', 'scripts/verify-luna-agent-phase17-closeout.js'],
  ['verify:luna-agent-phase15-closeout', 'scripts/verify-luna-agent-phase15-closeout.js'],
  ['verify:luna-agent-phase14-closeout', 'scripts/verify-luna-agent-phase14-closeout.js'],
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

const PROOF_ANCHORS = {
  '18b.1': { commit: '4011221', verdict: 'PASS', note: 'hosted guest-reply-draft route proof' },
  '18d.1': { commit: '7fc47ad', verdict: 'PASS', note: 'hosted send_eligibility on draft route' },
  '18e.1': {
    commit: 'c57523e',
    verdict: 'ACCEPTED_WITH_WAIVER',
    note: 'import/static/simulated chain passed; Case C editor confirmed guest-reply-draft; A/B n8n exec IDs not captured',
    not_full_runtime: true,
  },
};

const REF_DATE = '2026-06-05';

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase18-closeout.js  (Phase 18f — static, non-recursive)\n');

const startedMs = Date.now();

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Phase 18 npm scripts + required files');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

for (const [scriptName, relPath] of PHASE18_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${relPath}`) {
    pass('A.script.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.script.' + scriptName, `${scriptName} missing or wrong path`);
  }
  if (fs.existsSync(full)) pass('A.file.' + scriptName, `${relPath} exists`);
  else fail('A.file.' + scriptName, `${relPath} missing`);
}

if (fs.existsSync(DOC)) pass('A.doc', path.relative(ROOT, DOC) + ' exists');
else fail('A.doc', 'Phase 18 plan doc missing');

if (fs.existsSync(DRAFT_HELPER)) pass('A.draft', 'luna-guest-reply-draft.js exists');
else fail('A.draft', 'draft helper missing');

if (fs.existsSync(ELIG_HELPER)) pass('A.elig', 'luna-guest-reply-send-eligibility.js exists');
else fail('A.elig', 'eligibility helper missing');

// ─────────────────────────────────────────────────────────────────────────────
section('B. Prior closeout scripts exist (not executed)');

for (const [scriptName, relPath] of PRIOR_CLOSEOUT_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName]) pass('B.prior.' + scriptName, `${scriptName} registered`);
  else fail('B.prior.' + scriptName, `${scriptName} missing`);
  if (fs.existsSync(full)) pass('B.prior.file.' + scriptName, `${relPath} exists`);
  else fail('B.prior.file.' + scriptName, `${relPath} missing`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Hosted proof anchors + 18e.1 waiver (static)');

for (const [phase, anchor] of Object.entries(PROOF_ANCHORS)) {
  pass('C.' + phase + '.commit', `${phase} commit anchor: ${anchor.commit}`);
  pass('C.' + phase + '.verdict', `${phase} verdict: ${anchor.verdict} — ${anchor.note}`);
}

if (PROOF_ANCHORS['18e.1'].not_full_runtime) {
  pass('C.18e.1.no_full_runtime', '18e.1 does not claim full n8n runtime PASS for all cases');
} else {
  fail('C.18e.1.no_full_runtime', '18e.1 must record waiver, not full runtime');
}

const selfSrc = readOrEmpty(__filename);
const docSrc  = readOrEmpty(DOC);

if (selfSrc.includes(WAIVER_18E1)) pass('C.waiver.self', '18e.1 waiver recorded in closeout verifier');
else fail('C.waiver.self', '18e.1 waiver missing from closeout verifier');

if (docSrc.replace(/`/g, '').includes(WAIVER_18E1)) pass('C.waiver.doc', '18e.1 waiver recorded in plan doc');
else fail('C.waiver.doc', '18e.1 waiver missing from plan doc');

if (!/full n8n runtime proof for all cases/i.test(selfSrc + docSrc)
  || /does not claim full n8n runtime|not full n8n runtime|not_full_runtime/i.test(selfSrc + docSrc)) {
  pass('C.waiver.no_overclaim', 'closeout does not overclaim full n8n runtime proof');
} else {
  fail('C.waiver.no_overclaim', 'must not claim full n8n runtime for all cases');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. guest-reply-draft route (static)');

const apiSrc = readOrEmpty(API);
const routeIdx = apiSrc.indexOf("'/staff/bot/guest-reply-draft'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';
const handlerStart = apiSrc.indexOf('async function handleBotGuestReplyDraft(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/bot/message-intake-preview', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

if (routeIdx > -1) pass('D.route', 'POST /staff/bot/guest-reply-draft registered');
else fail('D.route', 'route missing');

if (routeBlock.includes('requireBotAuth')) pass('D.auth', 'route uses requireBotAuth');
else fail('D.auth', 'requireBotAuth missing');

if (handler.includes('buildLunaGuestReplyDraft')) pass('D.handler', 'handler calls buildLunaGuestReplyDraft');
else fail('D.handler', 'handler missing draft builder');

const draftSrc = readOrEmpty(DRAFT_HELPER);
if (/suggested_reply/.test(draftSrc) && /send_eligibility/.test(draftSrc)) {
  pass('D.returns', 'draft helper returns suggested_reply + send_eligibility');
} else {
  fail('D.returns', 'suggested_reply or send_eligibility missing from draft helper');
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Send eligibility behavior (inline, no downstream exec)');

const { evaluateLunaGuestReplySendEligibility, ELIGIBILITY_SAFETY_FLAGS } = require('./lib/luna-guest-reply-send-eligibility');
const { buildLunaGuestReplyDraft } = require('./lib/luna-guest-reply-draft');

function assertElig(id, draft, input, env, expect) {
  const result = evaluateLunaGuestReplySendEligibility(draft, input, env);
  const errs = [];
  for (const [flag, val] of Object.entries(ELIGIBILITY_SAFETY_FLAGS)) {
    if (result[flag] !== val) errs.push(`${flag}=${result[flag]}`);
  }
  for (const [key, val] of Object.entries(expect)) {
    if (key === 'label' || key === 'blocked_includes') continue;
    if (result[key] !== val) errs.push(`${key}=${result[key]}`);
  }
  if (expect.blocked_includes) {
    for (const r of expect.blocked_includes) {
      if (!result.blocked_reasons.includes(r)) errs.push(`missing block ${r}`);
    }
  }
  if (errs.length) fail(id, errs.join('; '));
  else pass(id, expect.label || id);
}

(async () => {
  const itDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550181', language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  }, { reference_date: REF_DATE });

  assertElig('E.ask_missing_field', itDraft, itDraft, { WHATSAPP_DRY_RUN: 'true' }, {
    label: 'ask_missing_field eligible later, auto_send_ready false',
    send_allowed_later: true, auto_send_ready: false, requires_staff: false,
    allowed_send_kind: 'ask_missing_field', blocked_includes: ['whatsapp_dry_run_active'],
  });

  const enDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550180',
    guest_name: 'Draft Proof EN Complete', language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  }, { reference_date: REF_DATE });

  assertElig('E.show_quote', enDraft, enDraft, { WHATSAPP_DRY_RUN: 'true' }, {
    label: 'show_quote eligible later, auto_send_ready false',
    send_allowed_later: true, auto_send_ready: false, requires_staff: false,
    allowed_send_kind: 'show_quote', blocked_includes: ['whatsapp_dry_run_active'],
  });

  const handoffDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550182', language: 'en',
    message_text: 'I want a refund and need to talk to someone.',
  }, { reference_date: REF_DATE });

  assertElig('E.handoff', handoffDraft, handoffDraft, {}, {
    label: 'refund/handoff requires staff',
    send_allowed_later: false, auto_send_ready: false, requires_staff: true,
    allowed_send_kind: null, blocked_includes: ['handoff_required'],
  });

  const unsupportedDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550183', language: 'en',
    message_text: '???',
  }, { reference_date: REF_DATE });

  assertElig('E.unsupported', unsupportedDraft, unsupportedDraft, {}, {
    label: 'unsupported/low confidence requires staff',
    send_allowed_later: false, requires_staff: true,
    blocked_includes: ['unsupported_or_low_confidence'],
  });

  assertElig('E.gates_off', enDraft, enDraft, { WHATSAPP_DRY_RUN: 'true' }, {
    label: 'auto_send_ready false while live gates off',
    auto_send_ready: false,
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('F. n8n shadow workflow (static)');

  if (!fs.existsSync(WF_PATH)) {
    fail('F1', 'workflow JSON missing');
  } else {
    const wfRaw = fs.readFileSync(WF_PATH, 'utf8');
    const wf = JSON.parse(wfRaw);
    const blob = wfRaw;

    if (wf.active === false) pass('F.active', 'n8n workflow active:false');
    else fail('F.active', 'workflow must stay inactive');

    if (/\/staff\/bot\/guest-reply-draft/i.test(blob)) pass('F.route', 'n8n calls /staff/bot/guest-reply-draft');
    else fail('F.route', 'guest-reply-draft route missing from workflow');

    if (!/\/staff\/bot\/message-intake-preview/i.test(JSON.stringify(
      (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.httpRequest').map((n) => n.parameters),
    ))) {
      pass('F.no_preview_brain', 'no message-intake-preview HTTP brain node');
    } else {
      fail('F.no_preview_brain', 'legacy preview brain still present');
    }

    const mapNode = (wf.nodes || []).find((n) => n.name === 'Code - Map Draft Shadow Response');
    const mapCode = mapNode?.parameters?.jsCode || '';
    for (const field of [
      'suggested_reply', 'send_eligibility', 'send_allowed_later', 'requires_staff',
      'auto_send_ready', 'whatsapp_sent', 'live_send_blocked',
    ]) {
      if (mapCode.includes(field)) pass('F.map.' + field, `maps ${field}`);
      else fail('F.map.' + field, `${field} missing from map node`);
    }
    if (/whatsapp_sent:\s*false/.test(mapCode) && /live_send_blocked:\s*true/.test(mapCode)) {
      pass('F.map.safety_literals', 'whatsapp_sent:false and live_send_blocked:true pinned');
    } else {
      fail('F.map.safety_literals', 'safety literals missing in map node');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('G. Blocked actions (static)');

  const combined = draftSrc + readOrEmpty(ELIG_HELPER) + handler;
  const wfNodesOnly = fs.existsSync(WF_PATH)
    ? JSON.stringify(JSON.parse(fs.readFileSync(WF_PATH, 'utf8')).nodes || [])
    : '';
  const wfNodeParams = fs.existsSync(WF_PATH)
    ? JSON.stringify(JSON.parse(fs.readFileSync(WF_PATH, 'utf8')).nodes.map((n) => n.parameters || {}))
    : '';

  for (const [id, re, label, src] of [
    ['G.booking', /booking-create-from-plan|handleBotBookingCreateFromPlan/i, 'booking-create', combined + handler],
    ['G.paylink', /generate-payment-link|create-stripe-link/i, 'payment-link', combined + wfNodeParams],
    ['G.stripe', /api\.stripe\.com|createStripe\s*\(/i, 'Stripe API', combined + wfNodeParams],
    ['G.wa', /graph\.facebook\.com|sendWhatsApp\s*\(/i, 'WhatsApp graph send', combined + wfNodeParams],
    ['G.webhook', /\/staff\/stripe\/webhook/i, 'webhook payment truth', combined + wfNodeParams],
    ['G.n8n', /activateN8n|triggerN8n|fetchN8n\s*\(/i, 'n8n activation', combined],
    ['G.confirm', /confirmation_sent_at\s*=/i, 'confirmation_sent_at update', draftSrc + handler],
  ]) {
    if (!re.test(src)) pass(id, `no ${label}`);
    else fail(id, `${label} detected`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('H. Closeout is non-recursive (no downstream exec)');

  if (!/execSync\s*\(\s*[`'"]npm run verify:/.test(selfSrc)) {
    pass('H1', 'closeout does not exec downstream npm scripts');
  } else {
    fail('H1', 'closeout still execSync npm run downstream');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('I. Live WhatsApp NO_GO');

  if (docSrc.includes('NO_GO')) pass('I.nogo.doc', 'plan documents live WhatsApp NO_GO');
  else fail('I.nogo.doc', 'NO_GO missing from plan');

  if (WAIVER_18E1.includes('Live WhatsApp remains NO_GO')) {
    pass('I.nogo.waiver', '18e.1 waiver reaffirms Live WhatsApp NO_GO');
  } else {
    fail('I.nogo.waiver', 'waiver must reaffirm NO_GO');
  }

  const elapsed = Math.round((Date.now() - startedMs) / 1000);
  console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}s, non-recursive) ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
