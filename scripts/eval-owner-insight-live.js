'use strict';

/**
 * Owner Insight Agent — LIVE golden eval (Phase 3, on-demand, CORRECTNESS-checked).
 *
 * Runs real owner questions through the live agent against a REAL model + Postgres,
 * computes GROUND TRUTH from the DB, and asserts the agent's number matches. This is
 * NOT a CI gate (needs API key + DB) — it SKIPS cleanly when those are absent.
 *
 * Run (in the staging container, env already has key + DB):
 *   node scripts/eval-owner-insight-live.js
 */

const { runOwnerInsightAgentLive } = require('./lib/owner-insight-agent-live');
const { resolveLunaAiProvider } = require('./lib/luna-ai-provider');

const CLIENT = String(process.env.OWNER_EVAL_CLIENT_SLUG || 'wolfhouse-somo').trim();
const DB_URL = String(process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL || '').trim();
const BLOCKED = "I can't answer that from the allowed owner data.";

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function numbersIn(s) { return (String(s).match(/\d[\d,]*/g) || []).map((x) => Number(x.replace(/,/g, ''))); }

async function main() {
  const cfg = resolveLunaAiProvider(process.env);
  if (!cfg.enabled || !cfg.apiKey) { console.log('SKIPPED — no model configured.'); process.exit(0); }
  if (!DB_URL) { console.log('SKIPPED — no WOLFHOUSE_DATABASE_URL.'); process.exit(0); }
  let Client;
  try { ({ Client } = require('pg')); } catch (_) { console.log('SKIPPED — pg not available.'); process.exit(0); }

  console.log(`Owner Insight LIVE eval — client=${CLIENT} provider=${cfg.provider} model=${process.env.OWNER_INSIGHT_AGENT_MODEL || cfg.model}\n`);
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  // Ground truth, tenant-scoped by client_id (the corrected scope), for September 2026.
  const scope = `client_id IN (SELECT b2.client_id FROM bookings b2 WHERE b2.id IN (SELECT booking_id FROM booking_service_records WHERE client_slug = $1))`;
  const gtAll = (await pg.query(`SELECT count(*) c, sum(coalesce(guest_count,0)) g FROM bookings WHERE ${scope} AND check_in >= '2026-09-01' AND check_in < '2026-10-01'`, [CLIENT])).rows[0];
  const gtActive = (await pg.query(`SELECT count(*) c, sum(coalesce(guest_count,0)) g FROM bookings WHERE ${scope} AND check_in >= '2026-09-01' AND check_in < '2026-10-01' AND status NOT IN ('cancelled','expired','hold')`, [CLIENT])).rows[0];
  const okCounts = new Set([Number(gtAll.c), Number(gtActive.c)]);
  const okGuests = new Set([Number(gtAll.g), Number(gtActive.g)]);
  console.log(`GROUND TRUTH Sept 2026: bookings all=${gtAll.c} active=${gtActive.c}; guests all=${gtAll.g} active=${gtActive.g}\n`);

  async function run(q) {
    const r = await runOwnerInsightAgentLive(pg, { client_slug: CLIENT, question: q, env: Object.assign({}, process.env, { OWNER_INSIGHT_AGENT_ENABLED: '1' }) });
    console.log(`Q: ${q}\n   -> [${r.agent_status} q=${r.queries_run}] ${r.answer}`);
    (r.show_work || []).forEach((w, i) => console.log(`      sql${i}: ${String(w.sql).replace(/\s+/g, ' ').slice(0, 260)}`));
    return r;
  }

  try {
    const rBookings = await run('How many bookings do we have for September 2026?');
    ok('September booking count matches DB (not 0)',
      rBookings.success && [...numbersIn(rBookings.answer)].some((n) => okCounts.has(n)) && Number(gtAll.c) > 0,
      `expected one of ${[...okCounts].join('/')}, got "${rBookings.answer}"`);

    const rGuests = await run('How many guests are arriving in September 2026?');
    ok('September guest count matches DB (not 0)',
      rGuests.success && [...numbersIn(rGuests.answer)].some((n) => okGuests.has(n)) && Number(gtAll.g) > 0,
      `expected one of ${[...okGuests].join('/')}, got "${rGuests.answer}"`);
  } finally {
    await pg.end().catch(() => {});
  }

  console.log(`\n── owner-insight LIVE eval: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('eval error:', err); process.exit(1); });
