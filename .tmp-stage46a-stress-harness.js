'use strict';
/** Stage 46a — booking conversation stress harness. Temp — do not commit. */

const fs = require('fs');
const path = require('path');
const { runConversationFixture } = require('./scripts/lib/luna-conversation-fixture-set-batch');
const { generateHammerScenarios } = require('./scripts/lib/luna-random-guest-flow-generator');
const { isHandoff, findInternalLanguage } = require('./scripts/lib/luna-fixture-expectations');

const FIXTURES_PATH = path.join(__dirname, '.tmp-stage46a-fixtures.json');
const REPORT_JSON = path.join(__dirname, '.tmp-stage46a-stress-report.json');
const REPORT_MD = path.join(__dirname, '.tmp-stage46a-stress-report.md');

const BUCKETS = [
  'PASS',
  'FALSE_HANDOFF',
  'DEAD_END',
  'WRONG_QUESTION',
  'BAD_COPY',
  'WRITE_RISK',
];

const HANDOFF_PHRASES = /looping in our Wolfhouse team|hand off|handoff|staff will|team will help/i;
const VAGUE_DEAD = /^(thanks|ok|sure|got it|understood)[.!?\s]*$/i;

function normalizeTurns(turns) {
  return (turns || []).map((t) => (typeof t === 'string' ? { message: t } : t));
}

function lastTurn(record) {
  const turns = record.turns || [];
  return turns[turns.length - 1] || {};
}

function allReplies(record) {
  return (record.turns || []).map((t) => String(t.reply || ''));
}

function extractState(lastOut, record) {
  const r = (lastOut && lastOut.result) || {};
  const fields = r.extracted_fields || lastTurn(record).extracted_fields || {};
  return {
    handoff: isHandoff(lastOut) || record.final?.handoff === true,
    handoff_reasons: r.handoff_reasons || [],
    intake_state: r.intake_state || null,
    message_lane: r.message_lane || null,
    quote_status: (lastOut && lastOut.quote && lastOut.quote.quote_status)
      || lastTurn(record).quote_status || null,
    quote_ready: (lastOut && lastOut.quote && lastOut.quote.quote_status === 'ready')
      || lastTurn(record).quote_ready === true,
    payment_choice_ready: (lastOut && lastOut.payment_choice && lastOut.payment_choice.payment_choice_ready)
      || lastTurn(record).payment_choice_ready === true,
    payment_choice_needed: lastOut && lastOut.quote && lastOut.quote.payment_choice_needed,
    fields,
    missing: (r.missing_required_fields || r.booking_intake_policy?.missing_fields || []),
    write_ready: !!(lastOut && lastOut.hold_payment_draft_plan && lastOut.hold_payment_draft_plan.ready_for_hold_draft),
    stripe_link: !!(lastOut && lastOut.stripe_test_link && lastOut.stripe_test_link.stripe_link_created),
  };
}

function asksQuestion(text) {
  return /\?/.test(String(text || ''));
}

function mentionsStripe(text) {
  return /stripe link|checkout\.stripe/i.test(String(text || ''));
}

function isDeadEndReply(text, state) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (state.quote_ready || state.payment_choice_ready) return false;
  if (asksQuestion(t)) return false;
  if (HANDOFF_PHRASES.test(t)) return false;
  if (VAGUE_DEAD.test(t)) return true;
  if (t.length < 25 && !asksQuestion(t)) return true;
  return false;
}

function wrongQuestion(record, state) {
  const turns = record.turns || [];
  const last = lastTurn(record);
  const reply = String(last.reply || '');
  const fields = state.fields || {};
  const lower = reply.toLowerCase();
  if (fields.check_in && fields.check_out && /what dates|which dates|check-in and check-out|when are you/i.test(lower)) {
    return 'asks dates already provided';
  }
  if (fields.guest_count >= 1 && /how many guests|how many people|how many of you/i.test(lower)) {
    return 'asks guest count already provided';
  }
  if (turns.length >= 2) {
    const prev = turns[turns.length - 2];
    if (prev && prev.reply && prev.reply.trim() === reply.trim()) return 'repeated same reply';
  }
  return null;
}

function classifyRecord(fixture, flowResult, lastOut) {
  const state = extractState(lastOut, flowResult);
  const last = lastTurn(flowResult);
  const reply = String(last.reply || '');
  const expect = fixture.stress_expect || {};
  const issues = [];

  if (mentionsStripe(allReplies(flowResult).join(' '))) {
    return { bucket: 'BAD_COPY', issues: ['mentions Stripe in guest copy'], state, reply };
  }
  if (findInternalLanguage(reply).length) {
    return { bucket: 'BAD_COPY', issues: [`internal language: ${findInternalLanguage(reply).join(', ')}`], state, reply };
  }
  if (state.write_ready && !expect.expect_payment_path) {
    return { bucket: 'WRITE_RISK', issues: ['hold/draft write ready before payment choice expected'], state, reply };
  }
  if (state.stripe_link && !expect.expect_payment_path) {
    return { bucket: 'WRITE_RISK', issues: ['Stripe link created early'], state, reply };
  }

  const wrong = wrongQuestion(flowResult, state);
  if (wrong) {
    return { bucket: 'WRONG_QUESTION', issues: [wrong], state, reply };
  }

  const bookingFlow = expect.booking_flow === true;
  const noHandoff = expect.no_handoff === true || expect.no_handoff_before_quote === true;
  const beforeQuote = expect.no_handoff_before_quote === true && !state.quote_ready && !state.payment_choice_ready;

  if (state.handoff && (noHandoff || (bookingFlow && beforeQuote))) {
    const missing = state.missing.length ? state.missing.join(', ') : 'unknown';
    return {
      bucket: 'FALSE_HANDOFF',
      issues: [`handoff with recoverable missing fields: ${missing}`, `lane=${state.message_lane}`, `intake=${state.intake_state}`],
      state,
      reply,
    };
  }

  if (state.handoff && bookingFlow && !expect.allow_handoff) {
    return { bucket: 'FALSE_HANDOFF', issues: ['unexpected handoff in booking flow'], state, reply };
  }

  if (isDeadEndReply(reply, state) && expect.should_ask) {
    return { bucket: 'DEAD_END', issues: ['reply lacks clear next question'], state, reply };
  }

  if (expect.expect_quote_or_payment_ask && !state.quote_ready && !state.payment_choice_ready && !asksQuestion(reply)) {
    return { bucket: 'DEAD_END', issues: ['expected quote or payment ask'], state, reply };
  }

  if (expect.expect_payment_path && !state.payment_choice_ready && !state.quote_ready) {
    return { bucket: 'DEAD_END', issues: ['expected payment path not reached'], state, reply };
  }

  if (expect.should_ask_stay_type && state.quote_ready && !state.fields.package_interest && !state.fields.accommodation_only) {
    return { bucket: 'WRONG_QUESTION', issues: ['quoted without stay type clarification'], state, reply };
  }

  return { bucket: 'PASS', issues: [], state, reply };
}

function buildTranscript(flowResult) {
  return (flowResult.turns || []).map((t) => ({
    guest: t.message,
    luna: t.reply,
    handoff: t.handoff,
    quote_status: t.quote_status,
    payment_choice_ready: t.payment_choice_ready,
  }));
}

async function runFixture(fixture, index) {
  const fx = { ...fixture, turns: normalizeTurns(fixture.turns) };
  const flowResult = await runConversationFixture(fx, { referenceDate: fixture.reference_date || '2026-06-08', phonePrefix: '+3460046' }, index);
  const classification = classifyRecord(fixture, flowResult, flowResult.last_out);
  return {
    id: fixture.id,
    label: fixture.label,
    category: fixture.category || '?',
    bucket: classification.bucket,
    issues: classification.issues,
    transcript: buildTranscript(flowResult),
    final_state: classification.state,
    final_reply: classification.reply,
    flow_result: flowResult.result,
  };
}

async function runDeterministic() {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  const results = [];
  for (let i = 0; i < fixtures.length; i++) {
    results.push(await runFixture(fixtures[i], i));
    if ((i + 1) % 10 === 0) process.stderr.write(`[46a] deterministic ${i + 1}/${fixtures.length}\n`);
  }
  return results;
}

async function runRandom(count, seed) {
  const generated = generateHammerScenarios({ count, seed, language: 'all', maxTurns: 8 });
  const results = [];
  for (let i = 0; i < generated.scenarios.length; i++) {
    const scenario = generated.scenarios[i];
    scenario.stress_expect = { booking_flow: true, no_handoff_before_quote: true };
    scenario.category = 'RANDOM';
    const flowResult = await runConversationFixture(scenario, { referenceDate: generated.reference_date, phonePrefix: '+3460047' }, i);
    const classification = classifyRecord(scenario, flowResult, flowResult.last_out);
    results.push({
      id: scenario.id,
      label: scenario.label || scenario.id,
      category: 'RANDOM',
      scenario_type: scenario.hammer_meta?.scenario_type,
      language: scenario.language,
      bucket: classification.bucket,
      issues: classification.issues,
      transcript: buildTranscript(flowResult),
      final_state: classification.state,
      final_reply: classification.reply,
      flow_result: flowResult.result,
    });
    if ((i + 1) % 25 === 0) process.stderr.write(`[46a] random ${i + 1}/${count}\n`);
  }
  return results;
}

function summarize(results) {
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const byCategory = {};
  for (const r of results) {
    byBucket[r.bucket] = (byBucket[r.bucket] || 0) + 1;
    const cat = r.category || '?';
    byCategory[cat] = byCategory[cat] || {};
    byCategory[cat][r.bucket] = (byCategory[cat][r.bucket] || 0) + 1;
  }
  return { byBucket, byCategory };
}

function rootCauseGroups(failures) {
  const groups = {};
  for (const f of failures) {
    let key = 'other';
    if (f.bucket === 'FALSE_HANDOFF') {
      if (/guest_count|guest count/i.test(f.issues.join(' ') + JSON.stringify(f.final_state.fields))) key = 'guest_count_not_parsed_before_handoff';
      else if (/stay_type|package/i.test(f.issues.join(' '))) key = 'missing_stay_type_handoff';
      else if (/guest_name|name/i.test(f.issues.join(' '))) key = 'name_before_count_ordering';
      else key = 'router_safe_handoff_threshold';
    } else if (f.bucket === 'DEAD_END') key = 'composer_no_clear_next_step';
    else if (f.bucket === 'WRONG_QUESTION') key = 'intake_question_ordering';
    else if (f.bucket === 'BAD_COPY') key = 'copy_policy';
    else if (f.bucket === 'WRITE_RISK') key = 'early_write_path';
    groups[key] = groups[key] || [];
    groups[key].push(f.id);
  }
  return Object.entries(groups)
    .map(([cause, ids]) => ({ cause, count: ids.length, scenario_ids: ids.slice(0, 8) }))
    .sort((a, b) => b.count - a.count);
}

function recommendFixes(groups) {
  const recs = [];
  if (groups.find((g) => g.cause === 'guest_count_not_parsed_before_handoff')) {
    recs.push({ rank: 1, fix: 'Parse numeric guest-count answers ("3 please", "for two") before name/stay-type; never hand off when only guest_count missing', files: ['luna-guest-message-router.js', 'luna-guest-reply-composer.js', 'luna-booking-intake-policy.js'] });
  }
  if (groups.find((g) => g.cause === 'name_before_count_ordering')) {
    recs.push({ rank: 2, fix: 'Ask guest_count before guest_name when dates known and count missing (composer resolveComposerState ordering)', files: ['luna-guest-reply-composer.js', 'luna-booking-intake-policy.js'] });
  }
  if (groups.find((g) => g.cause === 'missing_stay_type_handoff')) {
    recs.push({ rank: 3, fix: 'For 7+ night stays without package/accommodation, ask stay_type instead of handoff', files: ['luna-guest-message-router.js', 'luna-booking-intake-policy.js'] });
  }
  if (groups.find((g) => g.cause === 'router_safe_handoff_threshold')) {
    recs.push({ rank: 4, fix: 'Tighten safe_handoff_required: booking lane should prefer ask_next over staff handoff for partial intake', files: ['luna-guest-message-router.js', 'luna-conversation-brain.js'] });
  }
  if (groups.find((g) => g.cause === 'intake_question_ordering')) {
    recs.push({ rank: 5, fix: 'Do not re-ask dates/count already in extracted_fields', files: ['luna-guest-reply-composer.js'] });
  }
  return recs.sort((a, b) => a.rank - b.rank);
}

function writeMarkdown(report) {
  const lines = [
    '# Stage 46a — Booking Conversation Stress Report',
    '',
    `Generated: ${report.generated_at}`,
    `Mode: local dry-run only (no deploy, no live WhatsApp, no Stripe)`,
    '',
    '## Summary',
    '',
    `- **Total tests:** ${report.total}`,
    `- **Deterministic:** ${report.deterministic_count}`,
    `- **Random:** ${report.random_count}`,
    '',
    '### By bucket',
    '',
  ];
  for (const b of BUCKETS) {
    lines.push(`- **${b}:** ${report.summary.byBucket[b] || 0}`);
  }
  lines.push('', '### By category', '');
  for (const [cat, buckets] of Object.entries(report.summary.byCategory)) {
    lines.push(`- **${cat}:** ${JSON.stringify(buckets)}`);
  }
  lines.push('', '## Regression: Book a stay → dates → 3 please', '');
  const reg = report.results.find((r) => r.id === '46a-regression-book-stay-dates-count');
  if (reg) {
    lines.push(`- **Bucket:** ${reg.bucket}`);
    lines.push(`- **Issues:** ${reg.issues.join('; ')}`);
    lines.push('', '```');
    for (const t of reg.transcript) lines.push(`Guest: ${t.guest}\nLuna: ${t.luna}`);
    lines.push('```');
  }
  lines.push('', '## Top 10 failures', '');
  for (const f of report.top_failures) {
    lines.push(`### ${f.id} (${f.bucket})`);
    lines.push(`Category: ${f.category} · ${f.label}`);
    lines.push(`Issues: ${f.issues.join('; ')}`);
    lines.push('');
    for (const t of f.transcript.slice(-3)) {
      lines.push(`- Guest: ${t.guest}`);
      lines.push(`- Luna: ${(t.luna || '').slice(0, 220)}`);
    }
    lines.push('');
  }
  lines.push('## Root causes', '');
  for (const g of report.root_causes) {
    lines.push(`- **${g.cause}** (${g.count}): ${g.scenario_ids.join(', ')}`);
  }
  lines.push('', '## Recommended Stage 46b fixes', '');
  for (const r of report.recommended_fixes) {
    lines.push(`${r.rank}. ${r.fix} — \`${(r.files || []).join('`, `')}\``);
  }
  fs.writeFileSync(REPORT_MD, lines.join('\n'));
}

(async () => {
  const randomCount = Number(process.argv[2] || 100);
  const randomSeed = Number(process.argv[3] || 46001);

  process.stderr.write('[46a] running deterministic fixtures...\n');
  const deterministic = await runDeterministic();
  process.stderr.write(`[46a] running ${randomCount} random scenarios (seed ${randomSeed})...\n`);
  const random = await runRandom(randomCount, randomSeed);
  const results = [...deterministic, ...random];
  const summary = summarize(results);
  const failures = results.filter((r) => r.bucket !== 'PASS');
  const topFailures = failures
    .sort((a, b) => (a.bucket === 'FALSE_HANDOFF' ? -1 : 0) - (b.bucket === 'FALSE_HANDOFF' ? -1 : 0))
    .slice(0, 10);
  const rootCauses = rootCauseGroups(failures);
  const recommended = recommendFixes(rootCauses);

  const report = {
    phase: 'stage46a-stress-report',
    generated_at: new Date().toISOString(),
    mode: 'local_dry_run',
    no_deploy: true,
    no_live_whatsapp: true,
    no_stripe: true,
    total: results.length,
    deterministic_count: deterministic.length,
    random_count: random.length,
    summary,
    regression_book_stay_dates_count: deterministic.find((r) => r.id === '46a-regression-book-stay-dates-count') || null,
    top_failures: topFailures,
    root_causes: rootCauses,
    recommended_fixes: recommended,
    results,
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  writeMarkdown(report);
  console.log(JSON.stringify({
    total: report.total,
    deterministic: report.deterministic_count,
    random: report.random_count,
    by_bucket: summary.byBucket,
    regression: report.regression_book_stay_dates_count ? {
      id: report.regression_book_stay_dates_count.id,
      bucket: report.regression_book_stay_dates_count.bucket,
      issues: report.regression_book_stay_dates_count.issues,
    } : null,
    top_failures: topFailures.map((f) => ({ id: f.id, bucket: f.bucket, issues: f.issues[0] })),
    root_causes: rootCauses.slice(0, 6),
    recommended_fixes: recommended,
    report_json: REPORT_JSON,
    report_md: REPORT_MD,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
