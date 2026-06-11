'use strict';

/**
 * Stage 39a — Run conversation-style fixtures as a guest-flow-batch fixture-set.
 */

const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./pg-connect');
const { runGuestAutomationOrchestratorDryRun } = require('./luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./luna-guest-context-merge');
const {
  checkTurnExpectations,
  checkFinalExpectations,
  findInternalLanguage,
  isHandoff,
  classifyFixtureResult,
} = require('./luna-fixture-expectations');

const CLIENT_SLUG = 'wolfhouse-somo';
const DEFAULT_REFERENCE_DATE = '2026-06-10';

const FIXTURE_SET_DIRS = Object.freeze({
  'multilingual-out-of-order': path.join(
    __dirname, '..', '..', 'fixtures', 'luna-conversation-state-machine', 'multilingual-out-of-order',
  ),
  'hammer-regressions': path.join(
    __dirname, '..', '..', 'fixtures', 'luna-conversation-state-machine', 'hammer-regressions',
  ),
  'generated-hammer-failures': path.join(
    __dirname, '..', '..', 'fixtures', 'luna-conversation-state-machine', 'generated-hammer-failures',
  ),
});

function applyChannelContactName(guestContext, contactName) {
  if (!contactName) return guestContext || undefined;
  const gc = guestContext ? { ...guestContext } : {};
  if (!gc.contact_name) gc.contact_name = contactName;
  if (!gc.whatsapp_guest_name) gc.whatsapp_guest_name = contactName;
  return gc;
}

function guestContextFromOrchestrator(out, contactName) {
  const r = out || {};
  return applyChannelContactName(normalizeGuestContextForChain({
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    package_night_rule: r.result && r.result.package_night_rule,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    detected_language: r.result && r.result.detected_language,
    previous_quote_invalidated: r.result && r.result.previous_quote_invalidated,
    stale_quote_reason: r.result && r.result.stale_quote_reason,
    corrected_fields: r.result && r.result.corrected_fields,
    new_booking_reset: r.result && r.result.new_booking_reset,
  }), contactName);
}

function loadConversationFixtures(fixtureSet) {
  const dir = FIXTURE_SET_DIRS[fixtureSet];
  if (!dir || !fs.existsSync(dir)) {
    throw new Error(`unknown or missing fixture-set directory: ${fixtureSet}`);
  }
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const fx = JSON.parse(raw);
      fx._file = file;
      return fx;
    });
}

function buildTurnSummary(out) {
  const r = (out && out.result) || {};
  const brain = r.conversation_brain || {};
  return {
    detected_language: r.detected_language || null,
    message_lane: r.message_lane || null,
    brain_intent: brain.intent || null,
    quote_status: out && out.quote && out.quote.quote_status,
    quote_ready: out && out.quote && out.quote.quote_status === 'ready',
    payment_choice_ready: out && out.payment_choice && out.payment_choice.payment_choice_ready,
    extracted_fields: r.extracted_fields || {},
    internal_language: findInternalLanguage(out && out.proposed_luna_reply),
    handoff: isHandoff(out),
  };
}

async function runConversationFixture(fixture, opts, index) {
  const referenceDate = fixture.reference_date || opts.referenceDate || DEFAULT_REFERENCE_DATE;
  const contactName = fixture.contact_name || null;
  const phone = `${opts.phonePrefix || '+34600939'}${String(index + 1).padStart(2, '0')}`;
  const result = {
    id: fixture.id,
    label: fixture.label || fixture.id,
    language: fixture.language || null,
    result: 'PASS',
    failures: [],
    partial_reasons: [],
    turns: [],
    final: null,
  };

  let guestContext = applyChannelContactName(null, contactName);
  let lastOut = null;

  for (let ti = 0; ti < (fixture.turns || []).length; ti++) {
    const turn = fixture.turns[ti];
    const message = typeof turn === 'string' ? turn : turn.message;
    const input = {
      client_slug: CLIENT_SLUG,
      channel: 'whatsapp',
      message_text: message,
      guest_phone: phone,
      guest_context: guestContext,
      reference_date: referenceDate,
      language_hint: fixture.language || 'en',
      dry_run: true,
      automation_gate_context: {
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
      },
    };

    lastOut = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun(input, {
      reference_date: referenceDate,
      guest_phone: phone,
      dry_run: true,
      pg,
    }));

    const summary = buildTurnSummary(lastOut);
    const turnFailures = turn.expect ? checkTurnExpectations(turn.expect, lastOut) : [];
    const classified = classifyFixtureResult(turnFailures, turn.expect, lastOut);

    result.turns.push({
      turn: ti + 1,
      message,
      ...summary,
      failures: turnFailures,
      turn_result: classified,
    });

    if (classified === 'FAIL') {
      result.failures.push(...turnFailures.map((f) => `turn ${ti + 1}: ${f}`));
      result.result = 'FAIL';
    } else if (classified === 'PARTIAL' && result.result !== 'FAIL') {
      result.partial_reasons.push(...turnFailures.map((f) => `turn ${ti + 1}: ${f}`));
      result.result = 'PARTIAL';
    }

    guestContext = guestContextFromOrchestrator(lastOut, contactName);
  }

  if (lastOut) {
    result.final = buildTurnSummary(lastOut);
  }

  if (result.result !== 'FAIL' && fixture.final_expect && lastOut) {
    const finalFailures = checkFinalExpectations(fixture.final_expect, lastOut, result.turns);
    const classified = classifyFixtureResult(finalFailures, fixture.final_expect, lastOut);
    if (classified === 'FAIL') {
      result.failures.push(...finalFailures.map((f) => `final: ${f}`));
      result.result = 'FAIL';
    } else if (classified === 'PARTIAL' && result.result === 'PASS') {
      result.partial_reasons.push(...finalFailures.map((f) => `final: ${f}`));
      result.result = 'PARTIAL';
    }
  }

  return { ...result, last_out: lastOut };
}

async function runConversationFixtureSetAsBatch(opts) {
  const fixtureSet = opts.fixtureSet;
  let fixtures = loadConversationFixtures(fixtureSet);
  if (opts.fixtureId) {
    fixtures = fixtures.filter((f) => f.id === opts.fixtureId);
  }
  if (opts.count != null && opts.count > 0) {
    fixtures = fixtures.slice(0, opts.count);
  }
  if (fixtures.length === 0) {
    console.error('No conversation fixtures matched.');
    process.exit(1);
  }

  const report = {
    result: 'PASS',
    mode: 'local',
    review_only: true,
    fixture_set: fixtureSet,
    reference_date: opts.referenceDate || DEFAULT_REFERENCE_DATE,
    total: fixtures.length,
    passed: 0,
    failed: 0,
    partial: 0,
    flows: [],
    first_failure: null,
  };

  if (!opts.json) {
    console.log('\n── Luna Guest Flow Batch (conversation fixtures) ──');
    console.log(`Mode: local · Fixtures: ${fixtures.length} · Review-only: true`);
  }

  for (let i = 0; i < fixtures.length; i++) {
    let flowResult;
    try {
      flowResult = await runConversationFixture(fixtures[i], opts, i);
    } catch (e) {
      flowResult = {
        id: fixtures[i].id,
        result: 'FAIL',
        failures: [e.message],
        turns: [],
      };
    }

    report.flows.push(flowResult);
    if (flowResult.result === 'PASS') report.passed++;
    else if (flowResult.result === 'PARTIAL') report.partial++;
    else {
      report.failed++;
      if (!report.first_failure) {
        report.first_failure = { flow_id: flowResult.id, failures: flowResult.failures };
      }
      report.result = 'FAIL';
      if (opts.failFast) break;
    }

    if (!opts.json) {
      const mark = flowResult.result;
      const lang = flowResult.language || flowResult.final?.detected_language || '?';
      const quote = flowResult.final?.quote_ready ? 'quote' : 'no-quote';
      const intent = flowResult.final?.brain_intent || flowResult.final?.message_lane || '?';
      const internal = (flowResult.final?.internal_language || []).length ? ' INTERNAL' : '';
      console.log(`  ${mark}  ${flowResult.id} · lang=${lang} · ${quote} · intent=${intent}${internal}`);
      if (flowResult.failures && flowResult.failures[0]) {
        console.log(`         ${flowResult.failures[0]}`);
      } else if (flowResult.partial_reasons && flowResult.partial_reasons[0]) {
        console.log(`         partial: ${flowResult.partial_reasons[0]}`);
      }
    }
  }

  if (report.failed === 0 && report.partial > 0) report.result = 'PARTIAL';

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n── Batch result: ${report.result} ──`);
    console.log(`Passed: ${report.passed} · Partial: ${report.partial} · Failed: ${report.failed} / ${report.total}`);
    if (report.first_failure) {
      console.log(`First failure: ${report.first_failure.flow_id} — ${report.first_failure.failures[0]}`);
    }
  }

  process.exit(report.result === 'FAIL' ? 1 : 0);
}

module.exports = {
  FIXTURE_SET_DIRS,
  loadConversationFixtures,
  runConversationFixtureSetAsBatch,
  runConversationFixture,
};
