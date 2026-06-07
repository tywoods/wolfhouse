/**
 * Phase 24 — Closeout verifier for OpenAI Ask Luna AI provider foundation.
 *
 * Static doc + anchor checks; runs a limited downstream set only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase24-closeout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-24-OPENAI-ASK-LUNA-PROVIDER-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase24-closeout';

const DOWNSTREAM = [
  'verify:luna-ai-health-status',
  'verify:luna-ai-provider-diagnostics',
  'verify:luna-ai-provider',
  'verify:staff-ask-luna-ai-intent-fallback',
  'verify:staff-ask-luna-ai-answer-formatter',
  'verify:staff-ask-luna-multi-tool-planner',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${String(needle).slice(0, 72)}`);
}

function docMatches(text, pattern, id, label) {
  if (pattern.test(text)) pass(id, label);
  else fail(id, `${label} — pattern not found`);
}

console.log('\nverify-luna-agent-phase24-closeout.js  (Phase 24 closeout)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

section('A. Closeout doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-24-OPENAI-ASK-LUNA-PROVIDER-CLOSEOUT.md exists');
else fail('A1', 'closeout doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Architecture + modules');

docIncludes(doc, 'luna-ai-provider.js', 'B1', 'mentions luna-ai-provider.js');
docIncludes(doc, 'OpenAI', 'B2', 'mentions OpenAI');
docMatches(doc, /Anthropic/i, 'B3', 'mentions Anthropic fallback');
docIncludes(doc, 'staff-ask-luna-ai-intent.js', 'B4', 'mentions staff-ask-luna-ai-intent.js');
docIncludes(doc, 'staff-ask-luna-ai-answer-format.js', 'B5', 'mentions staff-ask-luna-ai-answer-format.js');
docIncludes(doc, 'staff-ask-luna-multi-tool-planner.js', 'B6', 'mentions staff-ask-luna-multi-tool-planner.js');

section('C. Env + endpoints');

docIncludes(doc, 'OPENAI_API_KEY', 'C1', 'mentions OPENAI_API_KEY');
docIncludes(doc, 'LUNA_AI_PROVIDER=openai', 'C2', 'mentions LUNA_AI_PROVIDER=openai');
docIncludes(doc, 'LUNA_AI_MODEL=gpt-4o-mini', 'C3', 'mentions LUNA_AI_MODEL=gpt-4o-mini');
docIncludes(doc, '/staff/ask-luna/ai-status', 'C4', 'mentions /staff/ask-luna/ai-status');
docMatches(doc, /\/healthz.*luna_ai|luna_ai.*\/healthz/i, 'C5', 'mentions /healthz luna_ai');

section('D. Hosted proof anchors');

docIncludes(doc, 'f75acb0', 'D1', 'mentions commit f75acb0');
docIncludes(doc, '48ee8a4', 'D2', 'mentions commit 48ee8a4');
docIncludes(doc, 'b5b4a2e', 'D3', 'mentions commit b5b4a2e');
docIncludes(doc, '2dbcbcd', 'D4', 'mentions commit 2dbcbcd');
docIncludes(doc, 'fd617f34', 'D5', 'mentions fingerprint fd617f34');
docIncludes(doc, 'wh-staging-staff-api--stage24e-ai-health', 'D6', 'mentions staging revision stage24e-ai-health');
docMatches(doc, /intent_source.*ai|ops_planner_ai/i, 'D7', 'mentions AI test anchors');

section('E. Safety + guest path');

docMatches(doc, /guest WhatsApp.*untouched|Guest WhatsApp reply path remains deterministic/i, 'E1', 'mentions guest WhatsApp path untouched/deterministic');
docMatches(doc, /no WhatsApp|No WhatsApp/i, 'E2', 'mentions no WhatsApp');
docMatches(doc, /no Stripe|No Stripe/i, 'E3', 'mentions no Stripe');
docMatches(doc, /no Meta webhook|No Meta webhook/i, 'E4', 'mentions no Meta webhook');
docIncludes(doc, 'no n8n', 'E5', 'mentions no n8n');
docMatches(doc, /no raw key|raw key leakage/i, 'E6', 'mentions no raw key leakage');

section('F. Stage 25 recommendation');

docMatches(doc, /Stage 25/i, 'F1', 'mentions Stage 25');
docMatches(doc, /guest AI intake|Guest AI intake|guest intake/i, 'F2', 'mentions Stage 25 guest intake only');
docMatches(doc, /no generative guest replies|Generative guest replies not implemented/i, 'F3', 'mentions no generative guest replies yet');

section('G. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase24-closeout.js';
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) {
  pass('G1', `${SCRIPT} registered`);
} else {
  fail('G1', `${SCRIPT} missing or wrong path`);
}

if (fs.existsSync(path.join(ROOT, rel))) pass('G2', 'closeout script file exists');
else fail('G2', 'closeout script file missing');

section('H. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    pass('H.' + script, `${script} still passes`);
  } catch (e) {
    fail('H.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-10).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
