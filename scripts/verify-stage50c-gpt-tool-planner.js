/**
 * Stage 50c — GPT guest tool planner verifier (mocked GPT, no live API required).
 *
 * Usage:
 *   node scripts/verify-stage50c-gpt-tool-planner.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  sanitizePlannedTools,
  parsePlannerJson,
  runGuestGptToolPlanner,
  applyPlannerFieldSeed,
  isGptToolPlannerEnabled,
  isGptToolPlannerActive,
} = require('./lib/luna-guest-gpt-tool-planner');
const { executeGuestAgentReadTool } = require('./lib/luna-guest-agent-tool-executor');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { GUEST_AGENT_READ_TOOL_IDS } = require('./lib/luna-guest-agent-tool-plan');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const PLANNER_ENV = {
  ...process.env,
  LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'true',
  LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE: 'true',
  OPENAI_API_KEY: '',
};

function mockPlanner(plan) {
  return async () => JSON.stringify(plan);
}

(async () => {
  console.log('\nverify-stage50c-gpt-tool-planner.js  (Stage 50c)\n');

  section('A. Read tool allowlist');
  {
    check('A1', GUEST_AGENT_READ_TOOL_IDS.includes('collect_missing_booking_fields'), 'collect tool read');
    check('A2', GUEST_AGENT_READ_TOOL_IDS.includes('explain_packages'), 'explain packages read');
    check('A3', !GUEST_AGENT_READ_TOOL_IDS.includes('create_booking_hold'), 'hold is not read');
  }

  section('B. Sanitize planned tools — reject writes');
  {
    const s = sanitizePlannedTools([
      'get_conversation_context',
      'create_booking_hold',
      'collect_missing_booking_fields',
      'create_payment_link',
      'bogus_tool',
    ]);
    check('B1', s.planned_tools.includes('get_conversation_context'), 'keeps read tool');
    check('B2', s.planned_tools.includes('collect_missing_booking_fields'), 'keeps collect');
    check('B3', !s.planned_tools.includes('create_booking_hold'), 'drops write hold');
    check('B4', !s.planned_tools.includes('create_payment_link'), 'drops write payment');
    check('B5', s.rejected_tools.some((r) => r.tool_id === 'create_booking_hold'), 'rejects hold');
  }

  section('C. Executor — multi-field intake');
  {
    const r = executeGuestAgentReadTool('collect_missing_booking_fields', {
      tool_id: 'collect_missing_booking_fields',
      client_slug: 'wolfhouse-somo',
      message_text: 'June 11th to 20th for 3 guests, malibu please',
      prior_guest_context: {},
      reference_date: '2026-06-11',
    });
    const merged = r.result && r.result.merged_extracted_fields;
    check('C1', r.status === 'ok', 'executor ok');
    check('C2', merged && merged.check_in === '2026-06-11' && merged.check_out === '2026-06-20', 'dates extracted');
    check('C3', merged && merged.guest_count === 3, 'guest count');
    check('C4', merged && merged.package_interest === 'malibu', 'package');
  }

  section('D. Mock planner executes read tools');
  {
    const out = await runGuestGptToolPlanner({
      client_slug: 'wolfhouse-somo',
      message_text: 'Tell me about the packages',
      prior_guest_context: {
        result: { extracted_fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3 } },
      },
      reference_date: '2026-06-11',
    }, {
      env: PLANNER_ENV,
      plannerCaller: mockPlanner({
        planned_tools: ['get_conversation_context', 'explain_packages'],
        rationale: 'package info request',
      }),
    });
    check('D1', out.planner_used === true, 'planner_used');
    check('D2', out.planned_tools.includes('explain_packages'), 'planned explain');
    check('D3', out.tool_results.length === 2, 'two tool results');
    check('D4', out.tool_results.every((t) => t.status === 'ok' || t.status === 'deferred'), 'no write execution');
  }

  section('E. Write tool in mock plan rejected');
  {
    const out = await runGuestGptToolPlanner({
      client_slug: 'wolfhouse-somo',
      message_text: 'deposit is fine',
      prior_guest_context: {},
      reference_date: '2026-06-11',
    }, {
      env: PLANNER_ENV,
      plannerCaller: mockPlanner({
        planned_tools: ['create_payment_link', 'collect_missing_booking_fields'],
        rationale: 'bad plan',
      }),
    });
    check('E1', !out.planned_tools.includes('create_payment_link'), 'write stripped from plan');
    check('E2', out.rejected_tools.some((r) => r.tool_id === 'create_payment_link'), 'write rejected');
  }

  section('F. No API key fallback');
  {
    const out = await runGuestGptToolPlanner({
      client_slug: 'wolfhouse-somo',
      message_text: 'hello',
      prior_guest_context: {},
      reference_date: '2026-06-11',
    }, { env: { ...PLANNER_ENV, LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'true', OPENAI_API_KEY: '' } });
    check('F1', out.planner_used !== true, 'planner not used without key');
    check('F2', out.fallback_used === true, 'fallback_used');
    check('F3', isGptToolPlannerEnabled({ LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'false' }) === false, 'default off');
  }

  section('G. Active field seed merge');
  {
    const seeded = applyPlannerFieldSeed({}, {
      check_in: '2026-06-11',
      check_out: '2026-06-20',
      guest_count: 3,
      package_interest: 'malibu',
    });
    const f = seeded.result && seeded.result.extracted_fields;
    check('G1', f && f.check_in === '2026-06-11', 'seed check_in');
    check('G2', f && f.guest_count === 3, 'seed guest_count');
    check('G3', seeded.result.gpt_planner_field_seed === true, 'seed flag');
  }

  section('H. Orchestrator shadow — planner off by default');
  {
    const out = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'dry_run',
      message_text: 'June 11th to 20th',
      guest_phone: '+34600500060',
      guest_context: {},
      reference_date: '2026-06-11',
    }, { env: { ...process.env, LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'false' } });
    check('H1', !!(out && out.proposed_luna_reply), 'orchestrator reply');
    check('H2', !(out.result && out.result.guest_gpt_tool_planner && out.result.guest_gpt_tool_planner.gpt_tool_planner_used), 'planner off');
  }

  section('I. Orchestrator active + mock planner multi-field');
  {
    const out = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'dry_run',
      message_text: 'June 11th to 20th for 3 guests, malibu',
      guest_phone: '+34600500061',
      guest_context: {},
      reference_date: '2026-06-11',
    }, {
      env: { ...PLANNER_ENV, LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true', LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'false' },
      gpt_tool_planner_caller: mockPlanner({
        planned_tools: ['get_conversation_context', 'collect_missing_booking_fields'],
        rationale: 'one-shot booking details',
      }),
    });
    const fields = out.result && out.result.extracted_fields;
    const obs = out.result && out.result.guest_gpt_tool_planner;
    check('I1', obs && obs.gpt_tool_planner_used === true, 'planner observability');
    check('I2', isGptToolPlannerActive(PLANNER_ENV) === true, 'active flag');
    check('I3', fields && fields.check_in === '2026-06-11' && fields.check_out === '2026-06-20', 'dates in result');
    check('I4', fields && fields.guest_count === 3, 'count in result');
    check('I5', fields && fields.package_interest === 'malibu', 'package in result');
  }

  section('J. Parse planner JSON');
  {
    const p = parsePlannerJson('{"planned_tools":["explain_packages"],"rationale":"ok"}');
    check('J1', p && p.planned_tools[0] === 'explain_packages', 'parses json');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
