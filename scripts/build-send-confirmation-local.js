/**
 * Build n8n/phase2/Wolfhouse - Send Confirmation (local).json
 *
 * Phase 2d — Postgres-driven confirmation (not Airtable checkbox).
 * - Polls bookings.send_confirmation=true
 * - Sends WhatsApp via env (WHATSAPP_DRY_RUN=true by default locally)
 * - Sets status=confirmed only after successful send
 *
 * Does NOT modify n8n/Wolfhouse - Send Confirmation.json (hosted export).
 *
 * Run: npm run build:send-confirmation:local
 */
const fs = require('fs');
const path = require('path');

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Send Confirmation.json');
const OUT = path.join(
  __dirname,
  '..',
  'n8n',
  'phase2',
  'Wolfhouse - Send Confirmation (local).json'
);

const hosted = JSON.parse(fs.readFileSync(HOSTED, 'utf8'));

function pickNode(name) {
  const n = hosted.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`Hosted node not found: ${name}`);
  return JSON.parse(JSON.stringify(n));
}

const llmChain = pickNode('Send confirmation reply');
const anthropic = pickNode('Anthropic Chat Model13');
const searchConversation = pickNode('Search Conversation - Confirmation');
const searchBeds = pickNode('Search Booking Beds - Confirmation');
const summarizeRooms = pickNode('Code - Summarize Assigned Rooms');

// Strip hosted credential IDs — map in n8n UI after import
anthropic.credentials = { anthropicApi: { id: '', name: 'Anthropic account' } };
searchConversation.credentials = {
  airtableTokenApi: { id: '', name: 'Airtable Personal Access Token account' },
};
searchBeds.credentials = {
  airtableTokenApi: { id: '', name: 'Airtable Personal Access Token account' },
};

const NULL_SENTINEL = '__NULL__';

const listPendingSql = `SELECT
  b.id AS booking_id,
  b.booking_code,
  b.guest_name,
  b.phone,
  b.email,
  b.check_in,
  b.check_out,
  b.guest_count,
  b.package_code,
  b.payment_status,
  b.status,
  b.send_confirmation
FROM bookings b
JOIN clients c ON c.id = b.client_id
WHERE c.slug = 'wolfhouse-somo'
  AND b.send_confirmation = TRUE
  AND b.status = 'payment_pending'::booking_status
  AND b.payment_status IN ('deposit_paid'::payment_status, 'paid'::payment_status)
  AND b.confirmation_sent_at IS NULL
  AND b.phone IS NOT NULL
  AND trim(b.phone) <> ''
  AND (NULLIF($1, '${NULL_SENTINEL}') IS NULL OR b.id::text = NULLIF($1, '${NULL_SENTINEL}'))
ORDER BY b.updated_at ASC
LIMIT 10;`;

const SEND_WHATSAPP_JS = [
  "const dryRun = String($env.WHATSAPP_DRY_RUN || 'true').toLowerCase() === 'true';",
  'const token = $env.WHATSAPP_ACCESS_TOKEN;',
  'const phoneNumberId = $env.WHATSAPP_PHONE_NUMBER_ID;',
  '',
  "const booking = $('Code - Format Booking For LLM').first().json;",
  "const phone = String(booking.phone || booking.fields?.Phone || '').trim();",
  'if (!phone) {',
  '  return [{ json: { whatsapp_sent: false, whatsapp_error: "missing_phone", booking_id: booking.booking_id } }];',
  '}',
  '',
  "const llm = $('Send confirmation reply').first().json;",
  "const body = llm.text || llm.output || llm.response || '';",
  'if (!body.trim()) {',
  '  return [{ json: { whatsapp_sent: false, whatsapp_error: "empty_message", booking_id: booking.booking_id } }];',
  '}',
  '',
  'if (dryRun || !token || !phoneNumberId) {',
  '  return [{',
  '    json: {',
  '      whatsapp_sent: true,',
  '      dry_run: true,',
  '      booking_id: booking.booking_id,',
  '      to: phone,',
  '      body_preview: body.slice(0, 120),',
  '    },',
  '  }];',
  '}',
  '',
  'try {',
  '  const resp = await this.helpers.httpRequest({',
  "    method: 'POST',",
  "    url: 'https://graph.facebook.com/v20.0/' + phoneNumberId + '/messages',",
  '    headers: {',
  "      Authorization: 'Bearer ' + token,",
  "      'Content-Type': 'application/json',",
  '    },',
  '    body: {',
  "      messaging_product: 'whatsapp',",
  "      to: phone.replace(/^\\+/, ''),",
  "      type: 'text',",
  '      text: { body },',
  '    },',
  '    json: true,',
  '  });',
  '  return [{',
  '    json: {',
  '      whatsapp_sent: true,',
  '      dry_run: false,',
  '      booking_id: booking.booking_id,',
  '      whatsapp_response: resp,',
  '    },',
  '  }];',
  '} catch (err) {',
  '  return [{',
  '    json: {',
  '      whatsapp_sent: false,',
  '      whatsapp_error: err.message || String(err),',
  '      booking_id: booking.booking_id,',
  '    },',
  '  }];',
  '}',
].join('\n');

const markConfirmedSql = `UPDATE bookings SET
  status = 'confirmed'::booking_status,
  send_confirmation = FALSE,
  confirmation_sent_at = COALESCE(confirmation_sent_at, NOW()),
  updated_at = NOW()
WHERE id = $1::uuid
  AND send_confirmation = TRUE
  AND status = 'payment_pending'::booking_status
  AND confirmation_sent_at IS NULL
RETURNING
  id AS booking_id,
  booking_code,
  status,
  send_confirmation,
  confirmation_sent_at;`;

// ---------------------------------------------------------------------------
// Stage 3.5b — Error capture: shared INSERT SQL (used by Gap 2 and Gap 3)
// $1 = JSON.stringify(Code node output) — unpacked via JSONB operators
// ---------------------------------------------------------------------------

const writeAutomationErrorsSql = `INSERT INTO automation_errors (
  client_id, workflow_name, node_name, execution_id,
  error_message, severity, status, booking_id, payload
)
SELECT
  c.id,
  ($1::jsonb)->>'workflow_name',
  ($1::jsonb)->>'node_name',
  ($1::jsonb)->>'execution_id',
  ($1::jsonb)->>'error_message',
  ($1::jsonb)->>'severity',
  'open'::automation_error_status,
  NULLIF(($1::jsonb)->>'booking_id', '')::uuid,
  ($1::jsonb)->'payload'
FROM clients c
WHERE c.slug = 'wolfhouse-somo'
RETURNING id;`;

const writeWorkflowEventsSendFailSql = `INSERT INTO workflow_events (
  client_id, workflow_name, node_name, execution_id,
  event_level, message, booking_id, payload
)
SELECT
  c.id,
  ($1::jsonb)->>'workflow_name',
  ($1::jsonb)->>'node_name',
  ($1::jsonb)->>'execution_id',
  'error'::workflow_event_level,
  ($1::jsonb)->>'error_message',
  NULLIF(($1::jsonb)->>'booking_id', '')::uuid,
  ($1::jsonb)->'payload'
FROM clients c
WHERE c.slug = 'wolfhouse-somo';`;

// Stage 3.5e: success-path workflow_events — info level; $1 = JSON.stringify(Code node output)
const writeWorkflowEventsConfirmSuccessSql = `INSERT INTO workflow_events (
  client_id, workflow_name, node_name, execution_id,
  event_level, message, booking_id, payload
)
SELECT
  c.id,
  ($1::jsonb)->>'workflow_name',
  ($1::jsonb)->>'node_name',
  ($1::jsonb)->>'execution_id',
  'info'::workflow_event_level,
  'Send Confirmation marked booking confirmed',
  NULLIF(($1::jsonb)->>'booking_id', '')::uuid,
  ($1::jsonb)->'payload'
FROM clients c
WHERE c.slug = 'wolfhouse-somo';`;

// Gap 1 (no pending booking): info-level event; workflow_name is a literal in SQL;
// $1 = execution_id (string)
const writeWorkflowEventsNoPendingSql = `INSERT INTO workflow_events (
  client_id, workflow_name, execution_id,
  event_level, message, payload
)
SELECT
  c.id,
  'Wolfhouse - Send Confirmation (local)',
  $1,
  'info'::workflow_event_level,
  'send_confirmation: no eligible bookings found for this trigger',
  '{"action":"send_confirmation","outcome":"no_eligible_booking"}'::jsonb
FROM clients c
WHERE c.slug = 'wolfhouse-somo';`;

// ---------------------------------------------------------------------------
// Stage 3.5b — Code node JS strings
// ---------------------------------------------------------------------------

// Gap 2: build normalized error payload when WhatsApp send returns whatsapp_sent=false
const BUILD_WA_SEND_ERROR_JS = [
  "const sendResult = $('Code - Send WhatsApp').first().json;",
  "const booking = $('Code - Format Booking For LLM').first().json;",
  'return [{',
  '  json: {',
  "    workflow_name: 'Wolfhouse - Send Confirmation (local)',",
  "    node_name: 'Code - Send WhatsApp',",
  "    execution_id: String($execution.id ?? ''),",
  "    error_message: sendResult.whatsapp_error || 'WhatsApp send failed (unknown)',",
  "    severity: 'error',",
  '    booking_id: booking.booking_id || null,',
  '    payload: {',
  '      booking_code: booking.booking_code,',
  '      whatsapp_sent: sendResult.whatsapp_sent,',
  '      whatsapp_error: sendResult.whatsapp_error,',
  "      dry_run: String($env.WHATSAPP_DRY_RUN || 'true').toLowerCase() === 'true',",
  "      action: 'send_confirmation',",
  "      outcome: 'whatsapp_send_failed',",
  '    },',
  '  },',
  '}];',
].join('\n');

// Stage 3.5e: build payload for success-path workflow_events log
const BUILD_CONFIRM_SUCCESS_EVENT_JS = [
  'const marked = $json;',
  "const sendResult = $('Code - Send WhatsApp').first().json;",
  'return [{',
  '  json: {',
  "    workflow_name: 'Wolfhouse - Send Confirmation (local)',",
  "    node_name: 'Postgres - Mark Booking Confirmed',",
  "    execution_id: String($execution.id ?? ''),",
  '    booking_id: marked.booking_id || null,',
  '    payload: {',
  "      action: 'send_confirmation',",
  "      outcome: 'confirmation_sent',",
  '      booking_code: marked.booking_code || null,',
  '      dry_run: sendResult.dry_run === true,',
  '      whatsapp_sent: sendResult.whatsapp_sent === true,',
  '      confirmation_sent_at: marked.confirmation_sent_at || null,',
  "      source_node: 'Postgres - Mark Booking Confirmed',",
  '    },',
  '  },',
  '}];',
].join('\n');

// Stage 4 dry-run: Mark Booking Confirmed stub — returns shaped output that
// Code - Build Confirmation Success Event expects, without touching the bookings table.
const MARK_CONFIRMED_STUB_JS = [
  "const booking = $('Code - Format Booking For LLM').first().json;",
  '// Stage 4 dry-run: Postgres - Mark Booking Confirmed bypassed by WHATSAPP_DRY_RUN=true.',
  '// Returns shaped output so Code - Build Confirmation Success Event receives expected fields.',
  'return [{ json: {',
  '  booking_id: booking.booking_id || null,',
  '  booking_code: booking.booking_code || null,',
  "  status: 'confirmed',",
  '  send_confirmation: false,',
  '  confirmation_sent_at: null,',
  '  dry_run: true,',
  "  stub_type: 'mark_confirmed_stub',",
  "  _stub_note: 'Postgres - Mark Booking Confirmed bypassed by WHATSAPP_DRY_RUN=true',",
  '} }];',
].join('\n');

// Gap 3: build normalized error payload from n8n Error Trigger context
const BUILD_WORKFLOW_ERROR_JS = [
  "const err = $json.execution?.error || {};",
  "const failedNodeName = err.node?.name || 'unknown';",
  'return [{',
  '  json: {',
  "    workflow_name: 'Wolfhouse - Send Confirmation (local)',",
  '    node_name: failedNodeName,',
  "    execution_id: String($json.execution?.id ?? ''),",
  "    error_message: err.message || 'Unhandled workflow error',",
  "    severity: 'critical',",
  '    booking_id: null,',
  '    payload: {',
  "      action: 'send_confirmation',",
  "      outcome: 'workflow_crash',",
  '      failed_node: failedNodeName,',
  '      error_type: err.name || null,',
  '    },',
  '  },',
  '}];',
].join('\n');

const llmPrompt = llmChain.parameters.text;
llmChain.parameters.text = llmPrompt
  .replace(
    "{{ JSON.stringify($json.fields || $json) }}",
    "{{ JSON.stringify($('Code - Format Booking For LLM').first().json.fields || {}) }}"
  )
  .replace(
    "{{ $('Search Conversation - Confirmation').first().json.fields?.Language || 'en' }}",
    "{{ $('Search Conversation - Confirmation').first().json.fields?.Language || $('Code - Format Booking For LLM').first().json.language || 'en' }}"
  );

searchConversation.parameters.filterByFormula =
  "={{ '{Phone}=\"' + ($('Code - Format Booking For LLM').first().json.fields?.Phone || $('Code - Format Booking For LLM').first().json.phone || '') + '\"' }}";

searchBeds.parameters.filterByFormula =
  "={{ `{Booking ID}=\"${$('Code - Format Booking For LLM').first().json.fields?.['Booking ID'] || $('Code - Format Booking For LLM').first().json.booking_code}\"` }}";

searchConversation.alwaysOutputData = true;
searchBeds.alwaysOutputData = true;

const workflow = {
  name: 'Wolfhouse - Send Confirmation (local)',
  nodes: [
    {
      parameters: {
        rule: {
          interval: [{ field: 'minutes', minutesInterval: 3 }],
        },
      },
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-2200, 80],
      id: '2d010001-0001-4000-8000-000000000001',
      name: 'Schedule - Poll Postgres',
      disabled: true,
    },
    {
      parameters: {
        httpMethod: 'POST',
        path: 'send-confirmation-local',
        options: {},
      },
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [-2200, 280],
      id: '2d010002-0002-4000-8000-000000000002',
      name: 'Webhook - Send Confirmation Local',
      webhookId: '2d010002-0002-4000-8000-000000000002',
    },
    {
      parameters: {
        jsCode: `const body = $json.body ?? $json;\nconst raw = body.booking_id || body.booking_uuid || body.id || null;\nreturn [{ json: { filter_booking_id: raw ? String(raw).trim() : '${NULL_SENTINEL}' } }];`,
      },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-1980, 280],
      id: '2d010003-0003-4000-8000-000000000003',
      name: 'Code - Parse Webhook Filter',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: listPendingSql,
        options: {
          queryReplacement: `={{ '${NULL_SENTINEL}' }}`,
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [-1760, 80],
      id: '2d010004-0004-4000-8000-000000000004',
      name: 'Postgres - List Pending Confirmations',
      alwaysOutputData: true,
      credentials: {
        postgres: { id: '', name: 'Wolfhouse Postgres (local)' },
      },
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: listPendingSql,
        options: {
          queryReplacement: "={{ $('Code - Parse Webhook Filter').first().json.filter_booking_id }}",
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [-1760, 280],
      id: '2d010005-0005-4000-8000-000000000005',
      name: 'Postgres - List Pending (Webhook Filter)',
      alwaysOutputData: true,
      credentials: {
        postgres: { id: '', name: 'Wolfhouse Postgres (local)' },
      },
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'has-booking',
              leftValue: '={{ !!$json.booking_id }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [-1540, 180],
      id: '2d010006-0006-4000-8000-000000000006',
      name: 'IF - Pending Booking Found',
    },
    {
      parameters: {
        jsCode: `const b = $json;\nreturn [{\n  json: {\n    booking_id: b.booking_id,\n    booking_code: b.booking_code,\n    phone: b.phone,\n    language: 'en',\n    fields: {\n      'Booking ID': b.booking_code,\n      'Guest Name': b.guest_name,\n      'Phone': b.phone,\n      'Email': b.email,\n      'Check In': b.check_in,\n      'Check Out': b.check_out,\n      'Guest Count': b.guest_count,\n      'Package': b.package_code,\n      'Status': 'Payment_Pending',\n      'Payment Status': b.payment_status,\n    },\n  },\n}];`,
      },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-1320, 160],
      id: '2d010007-0007-4000-8000-000000000007',
      name: 'Code - Format Booking For LLM',
    },
    {
      ...searchConversation,
      position: [-1120, 160],
      id: '2d010008-0008-4000-8000-000000000008',
    },
    {
      ...searchBeds,
      position: [-920, 160],
      id: '2d010009-0009-4000-8000-000000000009',
    },
    {
      ...summarizeRooms,
      position: [-720, 160],
      id: '2d010010-0010-4000-8000-000000000010',
    },
    {
      ...llmChain,
      position: [-520, 160],
      id: '2d010011-0011-4000-8000-000000000011',
    },
    {
      ...anthropic,
      position: [-440, 380],
      id: '2d010012-0012-4000-8000-000000000012',
    },
    {
      parameters: {
        jsCode: SEND_WHATSAPP_JS,
      },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-320, 160],
      id: '2d010013-0013-4000-8000-000000000013',
      name: 'Code - Send WhatsApp',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'wa-ok',
              leftValue: '={{ $json.whatsapp_sent === true }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [-120, 160],
      id: '2d010014-0014-4000-8000-000000000014',
      name: 'IF - WhatsApp Sent OK',
    },
    // -----------------------------------------------------------------------
    // Stage 4 — dry-run gate: Postgres - Mark Booking Confirmed
    // IF WHATSAPP_DRY_RUN=true → stub (no bookings write)
    // IF WHATSAPP_DRY_RUN=false → real Postgres - Mark Booking Confirmed
    // Both branches converge at Code - Build Confirmation Success Event
    // -----------------------------------------------------------------------
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'is-dry-run-mark-confirmed',
              leftValue: "={{ String($env.WHATSAPP_DRY_RUN || 'true').toLowerCase() === 'true' }}",
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [100, 80],
      id: '2d010026-0026-4000-8000-000000000001',
      name: 'IF - DRY RUN? (Mark Confirmed)',
    },
    {
      parameters: {
        jsCode: MARK_CONFIRMED_STUB_JS,
      },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [320, -60],
      id: '2d010027-0027-4000-8000-000000000001',
      name: 'Code - DRY RUN Stub (Mark Booking Confirmed)',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: markConfirmedSql,
        options: {
          queryReplacement: "={{ $('Code - Format Booking For LLM').first().json.booking_id }}",
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [320, 200],
      id: '2d010015-0015-4000-8000-000000000015',
      name: 'Postgres - Mark Booking Confirmed',
      credentials: {
        postgres: { id: '', name: 'Wolfhouse Postgres (local)' },
      },
    },
    {
      parameters: {
        content:
          '## Phase 2d — Send Confirmation (local)\n\n**Trigger:** Postgres `send_confirmation=true` (schedule every 3 min + webhook).\n\n**Order:** WhatsApp first → Postgres `confirmed` only on success.\n\n**Default:** `WHATSAPP_DRY_RUN=true` (no production Graph API).\n\n**Stage 4 gate:** `IF - DRY RUN? (Mark Confirmed)` wraps `Postgres - Mark Booking Confirmed`. With `WHATSAPP_DRY_RUN=true`, the stub fires instead — bookings table is NOT updated. Confirmation draft is still generated and logged.\n\n**Airtable:** Conversation + Booking Beds searches use `alwaysOutputData` — 0 rows continues with PG booking defaults (language from Format node; empty room summary).\n\nDoes **not** update Airtable Send Confirmation checkbox.',
        height: 280,
        width: 420,
      },
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-2280, -120],
      id: '2d010016-0016-4000-8000-000000000016',
      name: 'Sticky Note - Phase 2d',
    },

    // -----------------------------------------------------------------------
    // Stage 3.5b — Addition A (Gap 2): WhatsApp send failure → error capture
    // Wired from: IF - WhatsApp Sent OK false branch (main[1])
    // -----------------------------------------------------------------------
    {
      parameters: { jsCode: BUILD_WA_SEND_ERROR_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [80, 340],
      id: '2d010017-0017-4000-8000-000000000001',
      name: 'Code - Build WA Send Error',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: writeAutomationErrorsSql,
        options: {
          queryReplacement: "={{ JSON.stringify($json) }}",
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [280, 340],
      id: '2d010018-0018-4000-8000-000000000001',
      name: 'Postgres - Write automation_errors (send fail)',
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: writeWorkflowEventsSendFailSql,
        options: {
          queryReplacement: "={{ JSON.stringify($('Code - Build WA Send Error').first().json) }}",
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [480, 340],
      id: '2d010019-0019-4000-8000-000000000001',
      name: 'Postgres - Write workflow_events (send fail)',
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },

    // -----------------------------------------------------------------------
    // Stage 3.5b — Addition B (Gap 1): no eligible booking → info event
    // Wired from: IF - Pending Booking Found false branch (main[1])
    // -----------------------------------------------------------------------
    {
      parameters: {
        operation: 'executeQuery',
        query: writeWorkflowEventsNoPendingSql,
        options: {
          queryReplacement: "={{ String($execution.id ?? '') }}",
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [-1540, 420],
      id: '2d010020-0020-4000-8000-000000000001',
      name: 'Postgres - Write workflow_events (no pending booking)',
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },

    // -----------------------------------------------------------------------
    // Stage 3.5b — Addition C (Gap 3): workflow crash → error capture
    // n8n fires Error Trigger on any unhandled node exception
    // -----------------------------------------------------------------------
    {
      parameters: {},
      type: 'n8n-nodes-base.errorTrigger',
      typeVersion: 1,
      position: [-2200, 600],
      id: '2d010021-0021-4000-8000-000000000001',
      name: 'Error Trigger - Send Confirmation',
    },
    {
      parameters: { jsCode: BUILD_WORKFLOW_ERROR_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-2000, 600],
      id: '2d010022-0022-4000-8000-000000000001',
      name: 'Code - Build Workflow Error Payload',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: writeAutomationErrorsSql,
        options: {
          queryReplacement: "={{ JSON.stringify($('Code - Build Workflow Error Payload').first().json) }}",
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [-1800, 600],
      id: '2d010023-0023-4000-8000-000000000001',
      name: 'Postgres - Write automation_errors (crash)',
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },

    // Stage 3.5e — success-path execution log: booking confirmed
    // Wired from: both Code - DRY RUN Stub (Mark Booking Confirmed) [dry-run]
    //             and Postgres - Mark Booking Confirmed [live]
    // -----------------------------------------------------------------------
    {
      parameters: { jsCode: BUILD_CONFIRM_SUCCESS_EVENT_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [540, 80],
      id: '2d010024-0024-4000-8000-000000000001',
      name: 'Code - Build Confirmation Success Event',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: writeWorkflowEventsConfirmSuccessSql,
        options: {
          queryReplacement: "={{ JSON.stringify($json) }}",
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [740, 80],
      id: '2d010025-0025-4000-8000-000000000001',
      name: 'Postgres - Write workflow_events (confirmation success)',
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },
  ],
  connections: {
    'Schedule - Poll Postgres': {
      main: [[{ node: 'Postgres - List Pending Confirmations', type: 'main', index: 0 }]],
    },
    'Webhook - Send Confirmation Local': {
      main: [[{ node: 'Code - Parse Webhook Filter', type: 'main', index: 0 }]],
    },
    'Code - Parse Webhook Filter': {
      main: [[{ node: 'Postgres - List Pending (Webhook Filter)', type: 'main', index: 0 }]],
    },
    'Postgres - List Pending Confirmations': {
      main: [[{ node: 'IF - Pending Booking Found', type: 'main', index: 0 }]],
    },
    'Postgres - List Pending (Webhook Filter)': {
      main: [[{ node: 'IF - Pending Booking Found', type: 'main', index: 0 }]],
    },
    'IF - Pending Booking Found': {
      main: [
        [{ node: 'Code - Format Booking For LLM', type: 'main', index: 0 }],
        [{ node: 'Postgres - Write workflow_events (no pending booking)', type: 'main', index: 0 }],
      ],
    },
    'Code - Format Booking For LLM': {
      main: [[{ node: 'Search Conversation - Confirmation', type: 'main', index: 0 }]],
    },
    'Search Conversation - Confirmation': {
      main: [[{ node: 'Search Booking Beds - Confirmation', type: 'main', index: 0 }]],
    },
    'Search Booking Beds - Confirmation': {
      main: [[{ node: 'Code - Summarize Assigned Rooms', type: 'main', index: 0 }]],
    },
    'Code - Summarize Assigned Rooms': {
      main: [[{ node: 'Send confirmation reply', type: 'main', index: 0 }]],
    },
    'Send confirmation reply': {
      main: [[{ node: 'Code - Send WhatsApp', type: 'main', index: 0 }]],
    },
    'Anthropic Chat Model13': {
      ai_languageModel: [[{ node: 'Send confirmation reply', type: 'ai_languageModel', index: 0 }]],
    },
    'Code - Send WhatsApp': {
      main: [[{ node: 'IF - WhatsApp Sent OK', type: 'main', index: 0 }]],
    },
    'IF - WhatsApp Sent OK': {
      main: [
        [{ node: 'IF - DRY RUN? (Mark Confirmed)', type: 'main', index: 0 }],
        [{ node: 'Code - Build WA Send Error', type: 'main', index: 0 }],
      ],
    },
    // Stage 4: dry-run gate for Mark Booking Confirmed
    'IF - DRY RUN? (Mark Confirmed)': {
      main: [
        [{ node: 'Code - DRY RUN Stub (Mark Booking Confirmed)', type: 'main', index: 0 }],
        [{ node: 'Postgres - Mark Booking Confirmed', type: 'main', index: 0 }],
      ],
    },
    'Code - DRY RUN Stub (Mark Booking Confirmed)': {
      main: [[{ node: 'Code - Build Confirmation Success Event', type: 'main', index: 0 }]],
    },
    // Stage 3.5e: success-path logging chain
    'Postgres - Mark Booking Confirmed': {
      main: [[{ node: 'Code - Build Confirmation Success Event', type: 'main', index: 0 }]],
    },
    'Code - Build Confirmation Success Event': {
      main: [[{ node: 'Postgres - Write workflow_events (confirmation success)', type: 'main', index: 0 }]],
    },
    // Stage 3.5b Addition A: WhatsApp failure chain
    'Code - Build WA Send Error': {
      main: [[{ node: 'Postgres - Write automation_errors (send fail)', type: 'main', index: 0 }]],
    },
    'Postgres - Write automation_errors (send fail)': {
      main: [[{ node: 'Postgres - Write workflow_events (send fail)', type: 'main', index: 0 }]],
    },
    // Stage 3.5b Addition C: Error Trigger chain
    'Error Trigger - Send Confirmation': {
      main: [[{ node: 'Code - Build Workflow Error Payload', type: 'main', index: 0 }]],
    },
    'Code - Build Workflow Error Payload': {
      main: [[{ node: 'Postgres - Write automation_errors (crash)', type: 'main', index: 0 }]],
    },
  },
  pinData: {},
  active: false,
  settings: {
    executionOrder: 'v1',
    binaryMode: 'separate',
  },
  tags: [{ name: 'phase2d' }, { name: 'local-only' }],
};

fs.writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n');
console.log(`Wrote ${OUT}`);
console.log(`Nodes: ${workflow.nodes.length}`);
