'use strict';

/**
 * verify:luna-unified-planner — static + golden proof for single-planner mode.
 */

const fs = require('fs');
const path = require('path');
const { applyUnifiedPlannerEnv, isUnifiedPlannerActive } = require('./lib/luna-guest-unified-planner');
const { LUNA_GUEST_STAGING_V1 } = require('./lib/luna-guest-staging-profile');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

section('A. Staging profile enables unified planner');
{
  check('A1', LUNA_GUEST_STAGING_V1.LUNA_GUEST_UNIFIED_PLANNER_MODE === 'true', 'UNIFIED_PLANNER_MODE on');
  check('A2', LUNA_GUEST_STAGING_V1.LUNA_GUEST_FRONTDESK_PLANNER_ACTIVE === 'true', 'frontdesk planner active');
  const env = applyUnifiedPlannerEnv({ ...LUNA_GUEST_STAGING_V1 });
  check('A3', env.LUNA_CONVERSATION_BRAIN_LLM_ENABLED === 'false', 'brain LLM disabled under unified mode');
  check('A4', env.LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED === 'false', 'gpt tool planner disabled');
  check('A5', isUnifiedPlannerActive(env), 'unified planner active');
}

section('B. Orchestrator wires unified env');
{
  const orch = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js'), 'utf8');
  check('B1', orch.includes('applyUnifiedPlannerEnv'), 'orchestrator applies unified env');
  check('B2', orch.includes('luna-guest-unified-planner'), 'orchestrator imports unified planner');
}

section('C. Frontdesk planner references behavior spec');
{
  const fd = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-frontdesk-planner.js'), 'utf8');
  check('C1', fd.includes('LUNA-GUEST-BEHAVIOR-SPEC'), 'planner prompt cites spec');
  check('C2', fd.includes('NEVER ask "Malibu or accommodation?"'), 'planner blocks blind package ask');
}

section('D. Cami voice-only replan guards');
{
  const cami = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-cami-reply-author.js'), 'utf8');
  check('D1', cami.includes('CAMI_REPLAN_SOFT_HINTS'), 'replan hint set defined');
  check('D2', cami.includes('blind_package_choice_without_explain'), 'hard reject blind package ask');
  check('D3', cami.includes('validator_rejected_replan'), 'soft replan hints fall back to deterministic');
}

console.log(`\n── Summary: ${passes} passed, ${failures} failed ──`);
process.exit(failures > 0 ? 1 : 0);
