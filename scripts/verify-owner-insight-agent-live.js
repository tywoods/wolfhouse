'use strict';

/**
 * Owner Insight Agent LIVE adapter — deterministic gate.
 *
 * Exercises runOwnerInsightAgentLive with a FAKE model (scripted JSON) and a FAKE
 * pg client, but the REAL validator + REAL executor wrapper. No API key, no Postgres.
 * Proves the live wiring: flag gating, response-shape mapping, grounded answers,
 * unsafe-SQL rejection through the real validator, clarify + provider-missing paths.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const {
  isOwnerInsightAgentEnabled,
  runOwnerInsightAgentLive,
  mapAgentResultToResponse,
  BLOCKED_ANSWER,
} = require('./lib/owner-insight-agent-live');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}

const CLIENT = 'wolfhouse';
const JULY_SQL = `SELECT b.booking_code, b.check_in, b.total_amount_cents
FROM bookings b
WHERE b.id IN (SELECT DISTINCT booking_id FROM booking_service_records WHERE client_slug = $1 AND booking_id IS NOT NULL)
AND b.check_in >= '2026-07-01' AND b.check_in < '2026-08-01'
AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY b.check_in LIMIT 100`;
const UNSAFE_SQL = `UPDATE bookings SET status = 'x' WHERE client_slug = $1`;

// Fake pg: returns July rows for the data query; records executed data SQL.
function makePg() {
  const dataSql = [];
  const pg = {
    query: async (sql) => {
      if (/^\s*(BEGIN|SET|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
      dataSql.push(sql);
      if (sql.includes("check_in >= '2026-07")) {
        return { rows: [
          { booking_code: 'WH-J1', check_in: '2026-07-03', total_amount_cents: 1200000 },
          { booking_code: 'WH-J2', check_in: '2026-07-11', total_amount_cents: 1458300 },
        ] };
      }
      return { rows: [] };
    },
  };
  return { pg, dataSql };
}

// Fake model: returns scripted JSON strings in order.
function makeAi(script) {
  let i = 0;
  return async () => { const out = script[i] || null; i += 1; return out; };
}

async function main() {
  console.log('verify:owner-insight-agent-live — fake model + fake pg, REAL validator/executor\n');

  // Flag gating
  ok('flag off by default', isOwnerInsightAgentEnabled({}) === false);
  ok('flag on when =1', isOwnerInsightAgentEnabled({ OWNER_INSIGHT_AGENT_ENABLED: '1' }) === true);

  // Happy path end-to-end through the live adapter
  const a = makePg();
  const aiHappy = makeAi([
    JSON.stringify({ action: 'query', sql: JULY_SQL }),
    JSON.stringify({ action: 'answer', answer: 'Booked for July: €26,583 across 2 bookings.', basis: 'July arrivals by check_in' }),
  ]);
  const happy = await runOwnerInsightAgentLive(a.pg, { client_slug: CLIENT, question: 'revenue booked for July?', env: { OWNER_INSIGHT_AGENT_ENABLED: '1' }, aiCaller: aiHappy });
  ok('H1 success + grounded answer', happy.success === true && /26,583/.test(happy.answer), JSON.stringify(happy).slice(0, 200));
  ok('H2 response shape: planner_source + execution rows', happy.planner_source === 'owner_insight_agent' && happy.execution.row_count === 2);
  ok('H3 exposes show_work', Array.isArray(happy.show_work) && happy.show_work.length === 1);
  ok('H4 read-only flags set', happy.read_only === true && happy.no_write_performed === true);
  ok('H5 real data query executed once', a.dataSql.length === 1 && a.dataSql[0].includes('2026-07'));

  // Unsafe SQL from the model is rejected by the REAL validator and never executed
  const b = makePg();
  const aiUnsafe = makeAi([
    JSON.stringify({ action: 'query', sql: UNSAFE_SQL }),
    JSON.stringify({ action: 'query', sql: JULY_SQL }),
    JSON.stringify({ action: 'answer', answer: 'Booked for July: €26,583.', basis: 'July arrivals by check_in' }),
  ]);
  const unsafe = await runOwnerInsightAgentLive(b.pg, { client_slug: CLIENT, question: 'drop then July revenue', env: {}, aiCaller: aiUnsafe });
  ok('U1 unsafe SQL never hit the database', !b.dataSql.some((s) => /UPDATE/i.test(s)) && b.dataSql.length === 1);
  ok('U2 still answered after self-correct', unsafe.success === true && /26,583/.test(unsafe.answer));

  // Clarify mapping
  const c = makePg();
  const aiClarify = makeAi([JSON.stringify({ action: 'clarify', question: 'Which period and which revenue basis?' })]);
  const clarify = await runOwnerInsightAgentLive(c.pg, { client_slug: CLIENT, question: 'how are we doing', env: {}, aiCaller: aiClarify });
  ok('C1 clarify surfaced as successful turn', clarify.success === true && clarify.needs_clarification === true && /period/i.test(clarify.answer));
  ok('C2 no data query for clarify', c.dataSql.length === 0);

  // Provider not configured (aiCaller returns null) -> clarify, no crash
  const d = makePg();
  const dRes = await runOwnerInsightAgentLive(d.pg, { client_slug: CLIENT, question: 'revenue?', env: {}, aiCaller: async () => null });
  ok('P1 provider-missing handled gracefully', dRes.success === true && dRes.needs_clarification === true);

  // Grounding guard via mapping: model answers with no query -> blocked, not fabricated
  const e = makePg();
  const aiNoQuery = makeAi([JSON.stringify({ action: 'answer', answer: '€999,999', basis: 'guess' })]);
  const eRes = await runOwnerInsightAgentLive(e.pg, { client_slug: CLIENT, question: 'how much money?', env: {}, aiCaller: aiNoQuery });
  ok('G1 ungrounded answer blocked', eRes.success === false && eRes.answer === BLOCKED_ANSWER && !/999,999/.test(eRes.answer));

  // Per-path model override: OWNER_INSIGHT_AGENT_MODEL is passed to the model call
  const seen = [];
  const capturingAi = async (callOpts) => { seen.push({ model: callOpts.model, temperature: callOpts.temperature }); return JSON.stringify({ action: 'query', sql: JULY_SQL }); };
  const f = makePg();
  await runOwnerInsightAgentLive(f.pg, {
    client_slug: CLIENT, question: 'July revenue?',
    env: { OWNER_INSIGHT_AGENT_ENABLED: '1', OWNER_INSIGHT_AGENT_MODEL: 'gpt-5.5', OWNER_INSIGHT_AGENT_MAX_STEPS: '1' },
    aiCaller: capturingAi,
  });
  ok('MO1 model override passed to the model call', seen.length >= 1 && seen[0].model === 'gpt-5.5', `seen=${JSON.stringify(seen)}`);
  ok('MO3 temperature omitted (null) for GPT-5.x compatibility', seen.length >= 1 && seen[0].temperature === null);

  const seen2 = [];
  const capturingAi2 = async (callOpts) => { seen2.push(callOpts.model); return JSON.stringify({ action: 'query', sql: JULY_SQL }); };
  const g = makePg();
  await runOwnerInsightAgentLive(g.pg, {
    client_slug: CLIENT, question: 'July revenue?',
    env: { OWNER_INSIGHT_AGENT_ENABLED: '1', OWNER_INSIGHT_AGENT_MAX_STEPS: '1' },
    aiCaller: capturingAi2,
  });
  ok('MO2 no override => inherits runtime model (undefined passed)', seen2.length >= 1 && seen2[0] === undefined);

  // Unit: mapAgentResultToResponse for an error status
  const mapped = mapAgentResultToResponse({ status: 'exhausted', error: 'max_steps_reached', steps: [] }, { clientSlug: CLIENT, question: 'q' });
  ok('M1 error status maps to blocked answer', mapped.success === false && mapped.answer === BLOCKED_ANSWER);

  console.log(`\n── owner-insight-agent-live: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) console.log('verify:owner-insight-agent-live — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('harness error:', err); process.exit(1); });
