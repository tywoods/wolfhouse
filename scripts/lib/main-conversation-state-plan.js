/**
 * Phase 3c.d.2 — conversation state report plan wrapper.
 */
const {
  parseConversationStateInput,
  runConversationStateQueries,
} = require('./main-conversation-state-pg-sql');

const KNOWN_FIXTURES = [
  {
    phone: '+353300000001',
    booking_code: 'WH-3C-ACTIVE-HOLD-GUARD-001',
    fixture: 'main-hold-3cc-active-hold-up.sql',
    note: 'May exist if fixture was applied',
  },
  {
    phone: null,
    booking_code: 'WH-3C-HOLD-EXEC-001',
    fixture: 'main-hold-3cc-exec-cleanup-down.sql',
    note: 'Only if 3c.c.3 execute test was run and not cleaned up',
  },
];

function matchKnownFixture(input) {
  return KNOWN_FIXTURES.filter(
    (f) =>
      (f.phone && f.phone === input.phone) ||
      (f.booking_code && f.booking_code === input.booking_code)
  );
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseConversationStateInput>} input
 */
async function buildConversationStateReport(client, input) {
  const base = await runConversationStateQueries(client, input);
  if (base.error) return base;

  const fixture_hints = matchKnownFixture(input);
  const fixture_data_present =
    base.pg_booking_by_code != null ||
    base.pg_active_hold_candidates.count > 0 ||
    base.pg_resolver_candidates.count > 0;

  return {
    ...base,
    fixture_hints,
    fixture_data_present,
    fixture_missing:
      fixture_hints.length > 0 && !fixture_data_present
        ? 'Known fixture referenced but no matching PG rows — apply fixture SQL or run hold CLI first'
        : null,
  };
}

module.exports = {
  KNOWN_FIXTURES,
  parseConversationStateInput,
  buildConversationStateReport,
};
