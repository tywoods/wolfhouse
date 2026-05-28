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
      position: [100, 80],
      id: '2d010015-0015-4000-8000-000000000015',
      name: 'Postgres - Mark Booking Confirmed',
      credentials: {
        postgres: { id: '', name: 'Wolfhouse Postgres (local)' },
      },
    },
    {
      parameters: {
        content:
          '## Phase 2d — Send Confirmation (local)\n\n**Trigger:** Postgres `send_confirmation=true` (schedule every 3 min + webhook).\n\n**Order:** WhatsApp first → Postgres `confirmed` only on success.\n\n**Default:** `WHATSAPP_DRY_RUN=true` (no production Graph API).\n\n**Airtable:** Conversation + Booking Beds searches use `alwaysOutputData` — 0 rows continues with PG booking defaults (language from Format node; empty room summary).\n\nDoes **not** update Airtable Send Confirmation checkbox.',
        height: 280,
        width: 420,
      },
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-2280, -120],
      id: '2d010016-0016-4000-8000-000000000016',
      name: 'Sticky Note - Phase 2d',
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
      main: [[{ node: 'Code - Format Booking For LLM', type: 'main', index: 0 }], []],
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
      main: [[{ node: 'Postgres - Mark Booking Confirmed', type: 'main', index: 0 }], []],
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
