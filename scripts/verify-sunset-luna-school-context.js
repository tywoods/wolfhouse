'use strict';

/**
 * verify:sunset-luna-school-context
 * Offline checks for Sunset Luna school-aware tool context.
 * No outbound WhatsApp/email, no DB, no network.
 */

const fs = require('fs');
const path = require('path');

const {
  buildSunsetSchoolContext,
  attachSunsetSchoolToGuestContext,
  resolveSunsetAdminConfigForLuna,
  enrichToolContextWithSunsetSchool,
  isSunsetClientSlug,
  DEFAULT_SUNSET_LOCATION_ID,
} = require('./lib/sunset-luna-school-context');
const { mapRouterToQuoteFields } = require('./lib/luna-guest-quote-proposal-dry-run');
const { mapRouterFieldsToAvailabilityInput } = require('./lib/luna-guest-availability-dry-run');
const { executeGuestAgentReadTool } = require('./lib/luna-guest-agent-tool-executor');
const { executeSunsetCatalogTool } = require('./lib/sunset-catalog-tool-executor');
const { runSunsetGuestSchoolTurnDryRun } = require('./lib/luna-guest-sunset-school-turn');
const { evaluateAutomationGate } = require('./lib/luna-guest-automation-orchestrator-dry-run');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function main() {
  console.log('\nverify:sunset-luna-school-context — offline school context checks\n');

  console.log('[1] School display names');
  const somo = buildSunsetSchoolContext('sunset-somo');
  const sardi = buildSunsetSchoolContext('sunset-sardinero');
  assert('somo display Sunset', somo.school_display_name === 'Sunset');
  assert('sardi display El Sardi', sardi.school_display_name === 'El Sardi');
  assert('somo location_id', somo.location_id === 'sunset-somo');
  assert('sardi location_id', sardi.location_id === 'sunset-sardinero');

  console.log('\n[2] Missing location defaults to sunset-somo');
  const defaulted = attachSunsetSchoolToGuestContext({}, { client_slug: 'sunset' });
  assert('default location sunset-somo', defaulted.location_id === DEFAULT_SUNSET_LOCATION_ID);
  assert('default school Sunset', defaulted.school_context.school_display_name === 'Sunset');

  console.log('\n[3] Conversation metadata routing');
  const fromSardi = attachSunsetSchoolToGuestContext({}, {
    client_slug: 'sunset',
    conversation_metadata: { location_id: 'sunset-sardinero' },
  });
  assert('metadata sunset-sardinero', fromSardi.location_id === 'sunset-sardinero');
  assert('metadata El Sardi label', fromSardi.school_context.school_display_name === 'El Sardi');

  console.log('\n[4] No cross-school leak / Wolfhouse unchanged');
  const wolfCtx = attachSunsetSchoolToGuestContext({ client_slug: 'wolfhouse-somo' }, {
    client_slug: 'wolfhouse-somo',
    conversation_metadata: { location_id: 'sunset-sardinero' },
  });
  assert('wolfhouse attach noop', wolfCtx.client_slug === 'wolfhouse-somo' && !wolfCtx.school_context);
  assert('isSunset false for wolfhouse', isSunsetClientSlug('wolfhouse-somo') === false);
  assert('wolfhouse admin config null', resolveSunsetAdminConfigForLuna('wolfhouse-somo', 'sunset-somo') == null);

  console.log('\n[5] Admin config lookup includes location_id');
  const somoCfg = resolveSunsetAdminConfigForLuna('sunset', 'sunset-somo');
  const sardiCfg = resolveSunsetAdminConfigForLuna('sunset', 'sunset-sardinero');
  assert('somo admin ok', somoCfg && somoCfg.ok !== false);
  assert('somo admin location_id', somoCfg.location_id === 'sunset-somo');
  assert('sardi admin location_id', sardiCfg.location_id === 'sunset-sardinero');

  console.log('\n[6] Tool payloads include location_id for Sunset');
  const availFields = mapRouterFieldsToAvailabilityInput(
    { extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-03', guest_count: 2 } },
    { client_slug: 'sunset', location_id: 'sunset-sardinero' },
  );
  assert('availability payload location_id', availFields.location_id === 'sunset-sardinero');
  const quoteFields = mapRouterToQuoteFields(
    { extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-03', guest_count: 2 } },
    { client_slug: 'sunset', location_id: 'sunset-sardinero' },
  );
  assert('quote payload location_id', quoteFields.location_id === 'sunset-sardinero');
  const enriched = enrichToolContextWithSunsetSchool({
    client_slug: 'sunset',
    prior_guest_context: { school_context: sardi },
  });
  assert('enriched tool ctx location', enriched.location_id === 'sunset-sardinero');

  console.log('\n[7] Catalog / conversation context tools');
  const catalog = executeSunsetCatalogTool('get_sunset_rental_price', {
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    dry_run: true,
    args: { item: 'board_rental', duration: '1_day', require_confirmed: false },
  });
  assert('catalog tool location_id on success or configured miss', catalog.location_id === 'sunset-somo' || catalog.detail && catalog.detail.location_id === 'sunset-somo');

  const convCtx = executeGuestAgentReadTool('get_conversation_context', {
    client_slug: 'sunset',
    location_id: 'sunset-sardinero',
    school_context: sardi,
    prior_guest_context: { school_context: sardi },
  });
  assert('get_conversation_context ok', convCtx.status === 'ok');
  assert('context includes school name El Sardi', convCtx.result.school_display_name === 'El Sardi');
  assert('context includes location_id', convCtx.result.location_id === 'sunset-sardinero');

  console.log('\n[8] Sunset guest turn dry-run (no outbound)');
  const gate = evaluateAutomationGate({
    client_slug: 'sunset',
    channel: 'whatsapp',
    message_text: 'What time are surf lessons?',
    dry_run: true,
  }, { dry_run: true });
  const turn = await runSunsetGuestSchoolTurnDryRun({
    client_slug: 'sunset',
    channel: 'whatsapp',
    message_text: 'What time are surf lessons?',
    guest_context: attachSunsetSchoolToGuestContext({}, {
      client_slug: 'sunset',
      conversation_metadata: { location_id: 'sunset-somo' },
    }),
  }, { dry_run: true }, gate);
  assert('sunset turn reply mentions Sunset', /Sunset/.test(turn.proposed_luna_reply));
  assert('sunset turn has tool payloads', Array.isArray(turn.result.sunset_tool_payloads) && turn.result.sunset_tool_payloads.length > 0);
  assert('sunset turn tool payload location_id', turn.result.sunset_tool_payloads.some((p) => p.location_id === 'sunset-somo'));

  console.log('\n[9] Source wiring static checks');
  const root = path.join(__dirname, '..');
  const orchSrc = fs.readFileSync(path.join(root, 'scripts/lib/luna-guest-automation-orchestrator-dry-run.js'), 'utf8');
  const inboundSrc = fs.readFileSync(path.join(root, 'scripts/lib/luna-guest-inbound-review-dry-run.js'), 'utf8');
  const askSrc = fs.readFileSync(path.join(root, 'scripts/lib/staff-ask-luna-execute.js'), 'utf8');
  assert('orchestrator supports sunset client', orchSrc.includes("SUNSET_CLIENT") && orchSrc.includes('runSunsetGuestSchoolTurnDryRun'));
  assert('inbound review attaches school context', inboundSrc.includes('attachSunsetSchoolToGuestContext'));
  assert('ask luna location filter', askSrc.includes('buildSunsetAskLunaQueryParams'));

  console.log(`\n── Results: ${pass} passed, ${fail} failed ──`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
