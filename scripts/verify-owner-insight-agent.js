'use strict';

/**
 * Owner Insight Agent — deterministic eval harness / gate.
 *
 * Profile: stubbed model + stubbed DB, but the REAL owner read-only SQL validator.
 * No API key and no Postgres required. Proves the agent loop end-to-end:
 *   A. honors the asked period (June != July) and grounds the answer in rows
 *      — i.e. the exact bug from the screenshot is fixed,
 *   B. refuses to answer with no grounded data (no hallucinated numbers),
 *   C. rejects unsafe SQL via the real validator and never executes it,
 *   D. can iterate (explore, then aggregate) across multiple queries,
 *   E. asks to clarify an ambiguous question,
 *   F. prompt builder + response parser behave (pure functions).
 *
 * Exit 0 on pass, nonzero on failure.
 */

const {
  runOwnerInsightAgent,
  buildOwnerInsightSystemPrompt,
  buildOwnerInsightUserPrompt,
  parsePlannerResponse,
} = require('./lib/owner-insight-agent');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}

const CLIENT = 'wolfhouse';

// --- fixture SQL (modeled on approved catalog templates so it passes the REAL validator) ---
function arrivalsRevenueSql(monthStart, monthEnd) {
  return `SELECT b.booking_code, b.check_in, b.total_amount_cents
FROM bookings b
WHERE b.id IN (SELECT DISTINCT booking_id FROM booking_service_records WHERE client_slug = $1 AND booking_id IS NOT NULL)
AND b.check_in >= '${monthStart}' AND b.check_in < '${monthEnd}'
AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY b.check_in LIMIT 100`;
}
const PACKAGE_EXPLORE_SQL = `SELECT b.package_code, COUNT(*) AS booking_count
FROM bookings b
WHERE b.id IN (SELECT DISTINCT booking_id FROM booking_service_records WHERE client_slug = $1 AND booking_id IS NOT NULL)
AND b.package_code IS NOT NULL
GROUP BY b.package_code ORDER BY booking_count DESC LIMIT 100`;
const UNSAFE_SQL = `UPDATE bookings SET status = 'x' WHERE client_slug = $1`;

// --- stub DB: returns fixture rows by SQL content; records every executed SQL ---
function makeExec() {
  const executed = [];
  const execSql = async (sql) => {
    executed.push(sql);
    // Match on the lower bound of the range so June's "< '2026-07-01'" upper bound
    // is not mistaken for a July query.
    if (sql.includes("check_in >= '2026-07")) {
      return { rows: [
        { booking_code: 'WH-J1', check_in: '2026-07-03', total_amount_cents: 1200000 },
        { booking_code: 'WH-J2', check_in: '2026-07-11', total_amount_cents: 1458300 },
      ] }; // sum 2,658,300c = €26,583
    }
    if (sql.includes("check_in >= '2026-06")) {
      return { rows: [
        { booking_code: 'WH-N1', check_in: '2026-06-05', total_amount_cents: 1899900 },
      ] }; // sum 1,899,900c = €18,999
    }
    if (sql.includes('package_code')) {
      return { rows: [{ package_code: 'SURF_CAMP', booking_count: 7 }] };
    }
    return { rows: [] };
  };
  return { execSql, executed };
}

function euroFromRows(rows) {
  const cents = (rows || []).reduce((s, r) => s + (Number(r.total_amount_cents) || 0), 0);
  return `€${Math.round(cents / 100).toLocaleString('en-US')}`;
}
function lastRows(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) if (!history[i].error) return history[i].rowsPreview || [];
  return [];
}

async function main() {
  console.log('verify:owner-insight-agent — stubbed model + DB, REAL validator\n');

  // --- Scenario A: month is honored + answer grounded in rows (the bug fix) ---
  const planForMonth = (start, end, label) => async ({ history, step }) => {
    if (step === 0) return { action: 'query', sql: arrivalsRevenueSql(start, end) };
    return { action: 'answer', answer: `Booked for ${label}: ${euroFromRows(lastRows(history))} across ${lastRows(history).length} bookings.`, basis: `${label} arrivals by check_in` };
  };

  const july = makeExec();
  const julyRes = await runOwnerInsightAgent({
    question: 'how much revenue do we have booked for July?', clientSlug: CLIENT,
    planStep: planForMonth('2026-07-01', '2026-08-01', 'July'), execSql: july.execSql,
  });
  const june = makeExec();
  const juneRes = await runOwnerInsightAgent({
    question: 'how much revenue do we have booked for June?', clientSlug: CLIENT,
    planStep: planForMonth('2026-06-01', '2026-07-01', 'June'), execSql: june.execSql,
  });

  ok('A1 July query passed the REAL validator and executed', julyRes.status === 'ok' && july.executed.length === 1,
    `status=${julyRes.status} executed=${july.executed.length}`);
  ok('A2 July answer is grounded in the rows (€26,583)', /26,583/.test(julyRes.answer), julyRes.answer);
  ok('A3 June answer is grounded in the rows (€18,999)', /18,999/.test(juneRes.answer), juneRes.answer);
  const euroOf = (s) => (String(s).match(/€[\d,]+/) || [''])[0];
  ok('A4 June and July euro amounts DIFFER (month is honored — the screenshot bug is fixed)',
    euroOf(julyRes.answer) === '€26,583' && euroOf(juneRes.answer) === '€18,999'
    && euroOf(julyRes.answer) !== euroOf(juneRes.answer),
    `july=${euroOf(julyRes.answer)} june=${euroOf(juneRes.answer)}`);
  ok('A5 answer exposes its work (SQL + row count)', Array.isArray(julyRes.showWork) && julyRes.showWork.length === 1 && julyRes.showWork[0].rowCount === 2);
  ok('A6 answer states the basis (which date column)', /check_in/i.test(julyRes.basis));

  // --- Scenario B: grounding guard — answer with no query is refused ---
  const bExec = makeExec();
  const bRes = await runOwnerInsightAgent({
    question: 'how much money did we make?', clientSlug: CLIENT,
    planStep: async () => ({ action: 'answer', answer: '€999,999', basis: 'guess' }),
    execSql: bExec.execSql,
  });
  ok('B1 refuses to answer with no grounded data', bRes.status === 'insufficient' && bRes.answer === null, `status=${bRes.status}`);
  ok('B2 no query was executed', bExec.executed.length === 0);

  // --- Scenario C: unsafe SQL rejected by the real validator, never executed, then self-corrects ---
  const cExec = makeExec();
  const cRes = await runOwnerInsightAgent({
    question: 'wipe the bookings then tell me July revenue', clientSlug: CLIENT,
    planStep: async ({ step, history }) => {
      if (step === 0) return { action: 'query', sql: UNSAFE_SQL };
      if (step === 1) return { action: 'query', sql: arrivalsRevenueSql('2026-07-01', '2026-08-01') };
      return { action: 'answer', answer: `Booked for July: ${euroFromRows(lastRows(history))}.`, basis: 'July arrivals by check_in' };
    },
    execSql: cExec.execSql,
  });
  ok('C1 unsafe SQL was NOT executed', !cExec.executed.includes(UNSAFE_SQL) && cExec.executed.length === 1);
  ok('C2 rejection recorded in history', cRes.steps[0] && /invalid_sql/.test(cRes.steps[0].error || ''), JSON.stringify(cRes.steps[0]));
  ok('C3 agent self-corrected and answered', cRes.status === 'ok' && /26,583/.test(cRes.answer));

  // --- Scenario D: multi-query iteration (explore -> aggregate -> answer) ---
  const dExec = makeExec();
  const dRes = await runOwnerInsightAgent({
    question: 'which package drives the most July revenue?', clientSlug: CLIENT,
    planStep: async ({ step, history }) => {
      if (step === 0) return { action: 'query', sql: PACKAGE_EXPLORE_SQL };
      if (step === 1) return { action: 'query', sql: arrivalsRevenueSql('2026-07-01', '2026-08-01') };
      return { action: 'answer', answer: `Top package SURF_CAMP; July booked ${euroFromRows(lastRows(history))}.`, basis: 'July arrivals by check_in' };
    },
    execSql: dExec.execSql,
  });
  ok('D1 ran two queries before answering', dExec.executed.length === 2 && dRes.showWork.length === 2);
  ok('D2 final answer is grounded', dRes.status === 'ok' && /26,583/.test(dRes.answer));

  // --- Scenario E: ambiguous question -> clarify ---
  const eExec = makeExec();
  const eRes = await runOwnerInsightAgent({
    question: 'how are we doing?', clientSlug: CLIENT,
    planStep: async () => ({ action: 'clarify', question: 'Do you mean revenue, occupancy, or bookings — and for which period?' }),
    execSql: eExec.execSql,
  });
  ok('E1 returns needs_clarification with a question', eRes.status === 'needs_clarification' && /period/i.test(eRes.clarify));
  ok('E2 no query executed for a clarify', eExec.executed.length === 0);

  // --- Scenario F: pure functions ---
  const sys = buildOwnerInsightSystemPrompt({ clientSlug: CLIENT });
  ok('F1 system prompt includes the catalog (bookings) + tenant scope', sys.includes('bookings') && sys.includes('client_slug = $1'));
  ok('F2 system prompt states the JSON action contract', sys.includes('"action":"query"') && sys.includes('"action":"answer"') && sys.includes('"action":"clarify"'));
  ok('F3 system prompt warns against unfiltered totals', /never return an unfiltered total/i.test(sys));
  const userPrompt = buildOwnerInsightUserPrompt({ question: 'test?', history: [{ sql: 'SELECT 1', rowCount: 1, rowsPreview: [{ a: 1 }] }] });
  ok('F4 user prompt includes question + prior rows', userPrompt.includes('test?') && userPrompt.includes('1 row'));
  ok('F5 parse fenced JSON', (parsePlannerResponse('```json\n{"action":"answer","answer":"hi"}\n```') || {}).action === 'answer');
  ok('F6 parse bare JSON with prose', (parsePlannerResponse('Sure: {"action":"clarify","question":"x"} ok') || {}).action === 'clarify');
  ok('F7 reject garbage / unknown action', parsePlannerResponse('no json here') === null && parsePlannerResponse('{"action":"drop"}') === null);

  console.log(`\n── owner-insight-agent: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) console.log('verify:owner-insight-agent — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('harness error:', err); process.exit(1); });
