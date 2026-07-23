'use strict';

/**
 * Crowsnest AI usage durable store — narrow insert API (ledger foundation).
 *
 * Validates with crowsnest.ai_usage.v1 before any SQL. Caller injects a
 * query-capable db; this module never imports pg or opens pools.
 */

const { validateCrowsnestAiUsageEvent } = require('./crowsnest-ai-usage-contract');

const INSERT_SQL = `
INSERT INTO crowsnest_ai_usage_events (
  event_id,
  occurred_at,
  client_slug,
  tenant_id,
  source_service,
  operation,
  provider,
  model,
  status,
  error_code,
  tokens_availability,
  input_tokens,
  output_tokens,
  total_tokens,
  latency_ms,
  cost_state,
  cost_amount_micros,
  cost_currency
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15, $16, $17, $18
)
ON CONFLICT (event_id) DO NOTHING
`.trim();

function safeStoreError(code) {
  return { ok: false, errors: [code] };
}

function buildInsertParams(event) {
  const tokens = event.tokens || {};
  const cost = event.cost || {};
  const measured = tokens.availability === 'measured';
  const costKnown = cost.state === 'provider_reported' || cost.state === 'estimated';

  return [
    event.event_id,
    event.occurred_at,
    event.client_slug,
    event.tenant_id,
    event.source_service,
    event.operation,
    event.provider,
    event.model,
    event.status,
    event.status === 'failed' ? event.error_code : null,
    tokens.availability,
    measured ? tokens.input_tokens : null,
    measured ? tokens.output_tokens : null,
    measured ? tokens.total_tokens : null,
    event.latency_ms,
    cost.state,
    costKnown ? cost.amount_micros : null,
    costKnown ? cost.currency : null,
  ];
}

/**
 * Persist one contract-valid AI usage event.
 * @param {{ db?: { query: Function }, event: unknown }} args
 * @returns {Promise<{ ok: true, inserted: boolean } | { ok: false, errors: string[] }>}
 */
async function recordCrowsnestAiUsageEvent(args) {
  const db = args && args.db;
  const event = args && args.event;

  const validation = validateCrowsnestAiUsageEvent(event);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors.slice() };
  }

  if (!db || typeof db.query !== 'function') {
    return safeStoreError('db_required');
  }

  const params = buildInsertParams(event);

  try {
    const result = await db.query(INSERT_SQL, params);
    const rowCount = result && typeof result.rowCount === 'number' ? result.rowCount : 0;
    return { ok: true, inserted: rowCount > 0 };
  } catch (_err) {
    return safeStoreError('store_write_failed');
  }
}

module.exports = {
  recordCrowsnestAiUsageEvent,
  INSERT_SQL,
};
