/**
 * Stage 50d — GPT guest write tool planner verifier (mocked GPT, no live Stripe).
 *
 * Usage:
 *   node scripts/verify-stage50d-gpt-write-tools.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS,
} = require('./lib/luna-guest-agent-tool-plan');
const {
  buildDeterministicWriteToolPlan,
  evaluateWriteToolReadiness,
  executeGuestAgentWriteTool,
} = require('./lib/luna-guest-agent-write-tool-executor');
const {
  sanitizeGptWritePlan,
  runGuestGptWriteToolPlanner,
  isGptWriteToolPlannerEnabled,
  isGptWriteToolPlannerActive,
  buildGptWriteToolPlannerObservability,
} = require('./lib/luna-guest-gpt-write-tool-planner');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const WRITE_ENV = {
  ...process.env,
  LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED: 'true',
  OPENAI_API_KEY: '',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  STAFF_ACTIONS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'true',
  NODE_ENV: 'staging',
};

const READY_CHAIN = {
  result: {
    message_lane: 'new_booking_inquiry',
    booking_intake_ready: true,
    readiness_state: 'ready_for_availability_check',
    extracted_fields: {
      check_in: '2026-06-19',
      check_out: '2026-06-29',
      guest_count: 3,
      package_interest: 'waimea',
      payment_preference: 'deposit',
    },
  },
  availability: { availability_status: 'available' },
  quote: { quote_status: 'ready', quote_total_cents: 225000 },
  payment_choice: {
    payment_choice_ready: true,
    next_safe_step: 'ready_for_hold_payment_draft',
    payment_choice: 'deposit',
  },
  hold_payment_draft_plan: {
    plan_status: 'ready',
    would_create_hold: true,
    would_create_payment_draft: true,
    would_create_stripe_link: false,
  },
};

function mockWritePlanner(plan) {
  return async () => JSON.stringify(plan);
}

(async () => {
  console.log('\nverify-stage50d-gpt-write-tools.js  (Stage 50d)\n');

  section('A. Plannable write tool registry');
  {
    check('A1', GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS.includes('create_booking_hold'), 'hold plannable');
    check('A2', GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS.includes('create_payment_link'), 'payment plannable');
    check('A3', GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS.includes('attach_post_booking_services'), 'attach plannable');
    check('A4', !GUEST_AGENT_GPT_PLANNABLE_WRITE_TOOL_IDS.includes('assign_beds'), 'assign_beds excluded');
  }

  section('B. Deterministic plan when payment choice ready');
  {
    const plan = buildDeterministicWriteToolPlan(READY_CHAIN, { env: WRITE_ENV });
    const ids = plan.map((p) => p.tool_id);
    check('B1', ids.includes('create_booking_hold'), 'plans hold');
    check('B2', ids.includes('create_payment_link'), 'plans deposit link');
    check('B3', ids[0] === 'create_booking_hold', 'hold first');
  }

  section('C. Gate eval — hold blocked without confirm_write');
  {
    const r = evaluateWriteToolReadiness('create_booking_hold', READY_CHAIN, { env: WRITE_ENV });
    check('C1', r.ready === false, 'not ready without confirm');
    check('C2', r.block_reasons.includes('confirm_write_required'), 'confirm_write reason');
    const r2 = evaluateWriteToolReadiness('create_booking_hold', READY_CHAIN, {
      env: WRITE_ENV,
      confirm_write: true,
      host_header: 'staff-staging.lunafrontdesk.com',
    });
    check('C3', r2.ready === true, 'ready with confirm on staging');
  }

  section('D. Shadow planner — plan without execution');
  {
    const out = await runGuestGptWriteToolPlanner({
      message_text: 'deposit please',
      chain_snapshot: READY_CHAIN,
      client_slug: 'wolfhouse-somo',
    }, {
      env: { ...WRITE_ENV, LUNA_GUEST_GPT_WRITE_TOOLS_ACTIVE: 'false' },
      writePlannerCaller: mockWritePlanner({
        planned_tools: ['create_booking_hold', 'create_payment_link'],
        rationale: 'guest chose deposit',
      }),
    });
    check('D1', out.write_planner_used === true, 'planner used');
    check('D2', out.planned_tools.includes('create_booking_hold'), 'hold planned');
    check('D3', out.tool_results.length === 0, 'shadow no execution');
    check('D4', out.safety_notes.includes('shadow_mode_no_execution'), 'shadow note');
  }

  section('E. Active without pg — planned status only');
  {
    const out = await executeGuestAgentWriteTool('create_booking_hold', READY_CHAIN, {
      env: WRITE_ENV,
      confirm_write: true,
      host_header: 'staff-staging.lunafrontdesk.com',
    });
    check('E1', out.status === 'planned', 'planned without pg');
    check('E2', out.result && out.result.would_execute_now === true, 'would execute');
  }

  section('F. Sanitize rejects non-plannable writes');
  {
    const s = sanitizeGptWritePlan(['create_booking_hold', 'assign_beds', 'mark_handoff']);
    check('F1', s.planned_tools.includes('create_booking_hold'), 'keeps hold');
    check('F2', !s.planned_tools.includes('assign_beds'), 'drops assign_beds');
    check('F3', s.rejected_tools.some((r) => r.tool_id === 'mark_handoff'), 'rejects handoff');
  }

  section('G. Observability shape');
  {
    const obs = buildGptWriteToolPlannerObservability({
      write_planner_enabled: true,
      write_planner_active: false,
      planned_tools: ['create_booking_hold'],
      deterministic_plan: [{ tool_id: 'create_booking_hold' }],
    });
    check('G1', obs.gpt_write_tool_planner_enabled === true, 'enabled flag');
    check('G2', obs.gpt_write_tool_planner_planned_tools.includes('create_booking_hold'), 'planned tools');
  }

  section('H. Orchestrator shadow write planner');
  {
    const out = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'dry_run',
      message_text: 'deposit is fine',
      guest_phone: '+34600500070',
      guest_context: {
        result: {
          extracted_fields: {
            check_in: '2026-06-19',
            check_out: '2026-06-29',
            guest_count: 3,
            package_interest: 'waimea',
          },
        },
        quote: { quote_status: 'ready', quote_total_cents: 225000 },
        availability: { availability_status: 'available' },
      },
      reference_date: '2026-06-11',
    }, {
      env: {
        ...WRITE_ENV,
        LUNA_GUEST_GPT_WRITE_TOOLS_ACTIVE: 'false',
        LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true',
        LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'false',
        LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'false',
      },
      gpt_write_tool_planner_caller: mockWritePlanner({
        planned_tools: ['create_booking_hold'],
        rationale: 'deposit chosen',
      }),
    });
    const wp = out.result && out.result.guest_gpt_write_tool_planner;
    check('H1', wp && wp.gpt_write_tool_planner_enabled === true, 'write planner observability');
    check('H2', wp && wp.gpt_write_tool_planner_planned_tools.length > 0, 'planned tools in orch');
    check('H3', isGptWriteToolPlannerEnabled({ LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED: 'false' }) === false, 'default off');
    check('H4', isGptWriteToolPlannerActive({ LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED: 'true', LUNA_GUEST_GPT_WRITE_TOOLS_ACTIVE: 'true' }), 'active on');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
