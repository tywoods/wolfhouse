'use strict';

/**
 * Owner Insight Agent — LIVE golden eval (Phase 3, on-demand).
 *
 * Runs a set of real owner questions through the live agent against a REAL model
 * and a REAL Postgres, and checks the answers are grounded + period-honoring. This
 * is the tool that proves accuracy once the agent is enabled — it is NOT a CI gate
 * (it needs an API key + DB), so it SKIPS cleanly when those are absent.
 *
 * Run:
 *   OPENAI_API_KEY=...  LUNA_AI_PROVIDER=openai  LUNA_AI_MODEL=<model> \
 *   WOLFHOUSE_DATABASE_URL=postgres://...  OWNER_EVAL_CLIENT_SLUG=wolfhouse \
 *     node scripts/eval-owner-insight-live.js
 *
 * (LUNA_AI_PROVIDER/MODEL + the matching key drive the model via luna-ai-provider.)
 */

const { runOwnerInsightAgentLive } = require('./lib/owner-insight-agent-live');
const { resolveLunaAiProvider } = require('./lib/luna-ai-provider');

const CLIENT = String(process.env.OWNER_EVAL_CLIENT_SLUG || 'wolfhouse').trim();
const DB_URL = String(process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL || '').trim();

// Golden questions + lightweight expectations. Checks are intentionally about
// *properties* of the answer (grounded, period-honoring), not exact strings.
const CASES = [
  { q: 'How much revenue do we have booked for July 2026?', expect: { grounded: true, mentions: ['july', '€'] }, tag: 'july' },
  { q: 'How much revenue do we have booked for June 2026?', expect: { grounded: true, mentions: ['june', '€'] }, tag: 'june' },
  { q: 'How many guests are arriving in September 2026?', expect: { grounded: true } },
  { q: 'Who has signed up for surf lessons?', expect: { grounded: true } },
  { q: 'Which package is the most popular right now?', expect: { grounded: true } },
  { q: 'How are we doing?', expect: { clarify: true } },
];

const BLOCKED = "I can't answer that from the allowed owner data.";

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}

async function main() {
  const cfg = resolveLunaAiProvider(process.env);
  if (!cfg.enabled || !cfg.apiKey) {
    console.log('SKIPPED — no model configured (set LUNA_AI_PROVIDER/MODEL + API key).');
    process.exit(0);
  }
  if (!DB_URL) {
    console.log('SKIPPED — no database (set WOLFHOUSE_DATABASE_URL).');
    process.exit(0);
  }

  let Client;
  try { ({ Client } = require('pg')); } catch (_) {
    console.log('SKIPPED — pg module not available.');
    process.exit(0);
  }

  console.log(`Owner Insight LIVE eval — client=${CLIENT} provider=${cfg.provider} model=${cfg.model}\n`);

  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  const answers = {};
  try {
    for (const c of CASES) {
      let res;
      try {
        res = await runOwnerInsightAgentLive(pg, {
          client_slug: CLIENT,
          question: c.q,
          env: { ...process.env, OWNER_INSIGHT_AGENT_ENABLED: '1' },
        });
      } catch (err) {
        ok(`Q: ${c.q}`, false, `threw: ${err.message}`);
        continue;
      }
      const answer = String(res.answer || '');
      answers[c.tag || c.q] = answer;
      console.log(`Q: ${c.q}\n   -> [${res.agent_status}] ${answer}\n   (queries: ${res.queries_run})`);

      if (c.expect.clarify) {
        ok(`${c.q} :: asks to clarify`, res.needs_clarification === true || /\?$/.test(answer.trim()), answer);
        continue;
      }
      if (c.expect.grounded) {
        ok(`${c.q} :: grounded (not blocked, queried data)`,
          res.success === true && answer !== BLOCKED && (res.queries_run || 0) >= 1, `status=${res.agent_status} q=${res.queries_run}`);
      }
      for (const token of (c.expect.mentions || [])) {
        ok(`${c.q} :: mentions "${token}"`, answer.toLowerCase().includes(token.toLowerCase()), answer);
      }
    }

    // Cross-check: the screenshot bug — June and July must NOT be identical.
    if (answers.june && answers.july) {
      ok('June and July answers differ (month honored)', answers.june !== answers.july,
        `june="${answers.june}" july="${answers.july}"`);
    }
  } finally {
    await pg.end().catch(() => {});
  }

  console.log(`\n── owner-insight LIVE eval: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('eval error:', err); process.exit(1); });
