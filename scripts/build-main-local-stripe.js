/**
 * Build n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json
 * Fork of hosted Main with Stripe checkout on payment_details_provided path.
 *
 * Ensure Booking In Postgres: n8n drops empty query params and shifts $n bindings.
 * Use sentinel __NULL__ in queryReplacement + NULLIF($n, '__NULL__') in SQL.
 * airtable_record_id is hard-coded NULL in INSERT (not $12) until Phase 3 dual-write.
 *
 * Phase 2f: Booking State Resolver + hold search guards (see docs/PHASE-2f.md).
 * Phase 2f.2: Reusable Stripe branch after booking_flow hold + payment-link guard.
 *
 * Run: npm run build:main:local-stripe
 */
const fs = require('fs');
const path = require('path');
const { buildN8nResolverJsCode } = require('./lib/booking-state-resolver');
const {
  applyMergedPaymentPathFixes,
  applyDeterministicPaymentUrl,
} = require('./lib/merged-payment-path');
const { stripePaymentLinkUpdateSchema } = require('./lib/airtable-bookings-schema');

/** n8n IF expression — run Stripe after hold when contact + hold exist (not only session merge). */
const STRIPE_AFTER_HOLD_IF_EXPR = `={{ 
  (() => {
    const summarize = $('Code - Summarize Holds').first().json || {};
    const resolver = $('Code - Booking State Resolver').first().json || {};
    const sig = resolver.message_signals || {};
    return (
      summarize.should_run_stripe_payment === true ||
      resolver.staged_contact?.apply_after_hold === true ||
      (
        summarize.holds_created === true &&
        (summarize.has_guest_details === true || sig.has_guest_email === true)
      )
    );
  })()
}}`;

const STRIPE_HOLD_RECORD_ID_EXPR =
  "={{ $('Code - Prepare Stripe Payment Context').first().json.hold_record_id || $('Update Booking Hold - Apply Staged Contact').first().json.id || $('Create Booking Hold').first().json.id }}";

function applyPhase2f(workflow) {
  const parseRoute = workflow.nodes.find((n) => n.name === 'Code - Parse Route');
  const switchNode = workflow.nodes.find((n) => n.name === 'Switch');
  const searchHold = workflow.nodes.find((n) => n.name === 'Search Hold With Guest Details');
  const extractGuest = workflow.nodes.find((n) => n.name === 'Code - Extract Guest Details');

  if (!parseRoute || !switchNode || !searchHold || !extractGuest) {
    throw new Error('Phase 2f: required Main nodes not found');
  }

  const resolverNode = {
    parameters: { jsCode: buildN8nResolverJsCode() },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1750, 896],
    id: '2f010001-0001-4000-8000-000000000001',
    name: 'Code - Booking State Resolver',
    executeOnce: true,
  };

  const shouldSearchHoldNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'should-search-hold',
            leftValue:
              "={{ $('Code - Booking State Resolver').first().json.hold_lookup?.should_search_hold === true }}",
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
    position: [2650, 560],
    id: '2f010002-0002-4000-8000-000000000002',
    name: 'IF - Should Search Hold',
  };

  const redirectBookingFlowNode = {
    parameters: {
      jsCode: `const resolver = $('Code - Booking State Resolver').first().json;
return [{
  json: {
    ...resolver,
    route: 'booking_flow',
    resolved_route: 'booking_flow',
    redirect_reason: resolver.logging?.decision_code || 'R2F_REDIRECT_BOOKING_FLOW',
    guest_message: resolver.guest_message,
  },
}];`,
    },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2650, 760],
    id: '2f010003-0003-4000-8000-000000000003',
    name: 'Code - Redirect to Booking Flow',
  };

  const holdFoundNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'hold-id',
            leftValue: '={{ !!$json.id }}',
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
    position: [2870, 480],
    id: '2f010004-0004-4000-8000-000000000004',
    name: 'IF - Hold Found',
  };

  const holdNotFoundRouteNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'has-booking-core',
            leftValue:
              "={{ $('Code - Booking State Resolver').first().json.message_signals?.has_booking_core === true }}",
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
    position: [3090, 560],
    id: '2f010005-0005-4000-8000-000000000005',
    name: 'IF - Hold Not Found Route',
  };

  const sticky2f = {
    parameters: {
      content:
        '## Phase 2f — Booking State Resolver\n\nSwitch uses `resolved_route`.\n\nPayment path: IF Should Search Hold → Search Hold (always output) → IF Hold Found.\n\nNo hold: controlled fallback (no silent stop).',
      height: 200,
      width: 400,
    },
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [1680, 720],
    id: '2f010008-0008-4000-8000-000000000008',
    name: 'Sticky Note - Phase 2f',
  };

  workflow.nodes.push(
    resolverNode,
    shouldSearchHoldNode,
    redirectBookingFlowNode,
    holdFoundNode,
    holdNotFoundRouteNode,
    sticky2f
  );

  searchHold.alwaysOutputData = true;

  const patchSwitch = (node) => {
    const rules = node.parameters?.rules?.values;
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      const conds = rule.conditions?.conditions;
      if (!Array.isArray(conds)) continue;
      for (const c of conds) {
        if (typeof c.leftValue === 'string' && c.leftValue.includes('$json.route')) {
          c.leftValue = c.leftValue.replace(/\$json\.route/g, '$json.resolved_route');
        }
      }
    }
  };
  patchSwitch(switchNode);

  workflow.connections['Code - Parse Route'] = {
    main: [[{ node: 'Code - Booking State Resolver', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Booking State Resolver'] = {
    main: [[{ node: 'Switch', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Extract Guest Details'] = {
    main: [[{ node: 'IF - Should Search Hold', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Should Search Hold'] = {
    main: [
      [{ node: 'Search Hold With Guest Details', type: 'main', index: 0 }],
      [{ node: 'Code - Redirect to Booking Flow', type: 'main', index: 0 }],
    ],
  };

  workflow.connections['Code - Redirect to Booking Flow'] = {
    main: [[{ node: 'Parser Node', type: 'main', index: 0 }]],
  };

  workflow.connections['Search Hold With Guest Details'] = {
    main: [[{ node: 'IF - Hold Found', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Hold Found'] = {
    main: [
      [{ node: 'Update Hold With Guest Details', type: 'main', index: 0 }],
      [{ node: 'IF - Hold Not Found Route', type: 'main', index: 0 }],
    ],
  };

  workflow.connections['IF - Hold Not Found Route'] = {
    main: [
      [{ node: 'Parser Node', type: 'main', index: 0 }],
      [{ node: 'Reply - Collect Booking Details', type: 'main', index: 0 }],
    ],
  };
}

const PREPARE_STRIPE_CONTEXT_JS = `function getHoldFromNode(nodeName) {
  try {
    const item = $(nodeName).first();
    if (item?.json?.id && item.json.fields) {
      return { record_id: item.json.id, fields: item.json.fields, source: nodeName };
    }
  } catch (_) {}
  return null;
}

function getJsonFromNode(nodeName) {
  try {
    return $(nodeName).first().json || {};
  } catch (_) {
    return {};
  }
}

const holdSources = [
  'Update Hold With Guest Details',
  'Update Booking Hold - Apply Staged Contact',
  'Create Booking Hold',
  'Search Hold With Guest Details',
];

let hold = null;
for (const nodeName of holdSources) {
  hold = getHoldFromNode(nodeName);
  if (hold?.record_id) break;
}

const extracted = getJsonFromNode('Code - Extract Guest Details');
const sessionCall = getJsonFromNode('Code - Call Create Payment Session');
const session = getJsonFromNode('Merge Session State').session || getJsonFromNode('Code - Check Bed Availability - WA').session || {};
const phone =
  $('Normalize Incoming Message').first().json.phone ||
  $('Create Inbound Message').first().json.fields?.['Conversation Phone'] ||
  '';

const fields = hold?.fields || {};
const emailMatch = String($('Code - Booking State Resolver').first().json.guest_message || '').match(
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i
);

return [
  {
    json: {
      hold_record_id: hold?.record_id || '',
      hold_source: hold?.source || '',
      booking_code: fields['Booking ID'] || '',
      guest_name: fields['Guest Name'] || extracted.guest_name || session.name || '',
      guest_email: fields['Email'] || extracted.guest_email || session.email || (emailMatch ? emailMatch[0] : ''),
      phone: fields['Phone'] || extracted.guest_phone || phone,
      check_in: fields['Check In'] || session.check_in || '',
      check_out: fields['Check Out'] || session.check_out || '',
      guest_count: fields['Guest Count'] || session.guest_count || session.guests || 1,
      package_code: fields['Package'] || '',
      requested_room_type: fields['Requested Room Type'] || session.room_type || 'shared',
      room_preference: fields['Room Preference'] || session.room_preference || session.room_type || 'shared',
      guest_gender_group_type:
        fields['Guest Gender / Group Type'] || session.guest_gender_group_type || 'unknown',
      payment_link: fields['Payment Link'] || sessionCall.checkout_url || '',
      checkout_url: sessionCall.checkout_url || fields['Payment Link'] || '',
    },
  },
];`;

const STRIPE_FALLBACK_REPLY_JS = `const lang = String(
  $('Code - Parse Route').first().json.language ||
  $('Search Conversation').first().json.fields?.Language ||
  'en'
).toLowerCase();

const name =
  $('Code - Prepare Stripe Payment Context').first().json.guest_name ||
  $('Merge Session State').first().json.session?.name ||
  '';

const byLang = {
  en: \`Thanks\${name ? ' ' + name : ''}! Your space is held for 1 hour. Our team will send your secure payment link here shortly — we could not generate it automatically just now.\`,
  de: \`Danke\${name ? ' ' + name : ''}! Wir haben euren Platz für 1 Stunde reserviert. Unser Team schickt euch gleich den sicheren Zahlungslink — die automatische Erstellung hat gerade nicht geklappt.\`,
  es: \`¡Gracias\${name ? ' ' + name : ''}! Hemos reservado vuestro espacio durante 1 hora. El equipo os enviará el enlace de pago seguro en breve — no pudimos generarlo automáticamente ahora.\`,
  it: \`Grazie\${name ? ' ' + name : ''}! Abbiamo tenuto il posto per 1 ora. Il team vi manderà a breve il link di pagamento sicuro — non siamo riusciti a generarlo automaticamente ora.\`,
};

const text = byLang[lang] || byLang.en;

return [{ json: { text, reply_text: text, stripe_payment_fallback: true } }];`;

function applyPhase2f2(workflow) {
  const summarizeHolds = workflow.nodes.find((n) => n.name === 'Code - Summarize Holds');
  const replyAvailability = workflow.nodes.find((n) => n.name === 'Reply - Availability Result');
  const replyPaymentPending = workflow.nodes.find((n) => n.name === 'Reply - Payment Pending');
  const buildRooming = workflow.nodes.find((n) => n.name === 'Code - Build Rooming Question');
  const ensurePostgres = workflow.nodes.find((n) => n.name === 'Postgres - Ensure Booking In Postgres');
  const updateStripeLink = workflow.nodes.find((n) => n.name === 'Update Booking - Stripe Payment Link');
  const prepareHold = workflow.nodes.find((n) => n.name === 'Code - Prepare Hold Records');

  if (
    !summarizeHolds ||
    !replyAvailability ||
    !replyPaymentPending ||
    !buildRooming ||
    !ensurePostgres ||
    !updateStripeLink
  ) {
    throw new Error('Phase 2f.2: required nodes not found');
  }

  if (prepareHold?.parameters?.jsCode) {
    prepareHold.parameters.jsCode = prepareHold.parameters.jsCode.replace(
      'has_guest_details:\n        !!session.name && !!session.email',
      `has_guest_details:
        !!session.name && !!session.email,
      should_run_stripe_payment: (() => {
        try {
          const resolver = $('Code - Booking State Resolver').first().json || {};
          if (resolver.staged_contact?.apply_after_hold === true) return true;
          if (resolver.resolved_sub_route === 'booking_full_capture_then_payment') {
            return !!(session.name && session.email);
          }
        } catch (_) {}
        return !!(session.name && session.email);
      })()`
    );
  }

  summarizeHolds.parameters.jsCode = `const created = $input.all();

const availability = $('Code - Check Bed Availability - WA').first().json;
const prepareHold = $('Code - Prepare Hold Records').first().json;
const resolver = $('Code - Booking State Resolver').first().json;

const bookingIds = created.map(item =>
  item.json.fields?.['Booking ID'] || item.json['Booking ID'] || item.json.id
);

const roomIds = created.map(item =>
  item.json.fields?.['Room ID'] ||
  item.json.fields?.['hold_room_id'] ||
  availability.hold_room_id ||
  availability.selected_room?.room_id ||
  ''
);

const roomNames = created.map(item =>
  item.json.fields?.['Room Name'] ||
  availability.hold_room_name ||
  availability.selected_room?.room_name ||
  ''
);

const hasGuestDetails = !!prepareHold.has_guest_details;
const applyAfterHold = resolver.staged_contact?.apply_after_hold === true;

return [
  {
    json: {
      ...availability,
      holds_created: true,
      hold_booking_ids: bookingIds,
      hold_room_ids: roomIds,
      hold_room_names: roomNames,
      hold_count: created.length,
      has_guest_details: hasGuestDetails,
      should_run_stripe_payment:
        applyAfterHold ||
        prepareHold.should_run_stripe_payment === true ||
        hasGuestDetails,
      staged_contact_apply_after_hold: applyAfterHold,
    },
  },
];`;

  if (replyAvailability?.parameters?.text) {
    replyAvailability.parameters.text = replyAvailability.parameters.text.replace(
      '* If lead guest name and email are complete, include the payment link.',
      '* Do not ask the guest to pay in this message and do not say payment is below. Stripe checkout is sent in a separate payment message.'
    );
    replyAvailability.parameters.text = replyAvailability.parameters.text.replace(
      '* Never say "I will send the payment link shortly" if the payment link is available.',
      '* Never say "complete the payment below" or "pay below".'
    );
    replyAvailability.parameters.text = replyAvailability.parameters.text.replace(
      '  Say the booking will be confirmed once payment is verified.\n  Do not ask for name or email again.\n  Do not ask them to confirm again.',
      '  Do not ask for name or email again.\n  Do not ask them to confirm again.'
    );
  }

  const ctx = "$('Code - Prepare Stripe Payment Context').first().json";
  const NULL_SENTINEL = '__NULL__';

  function pgParam(innerExpr) {
    return `={{ ((${innerExpr}) != null && String(${innerExpr}).trim() !== '') ? String(${innerExpr}).trim() : '${NULL_SENTINEL}' }}`;
  }

  ensurePostgres.parameters.options.queryReplacement = [
    pgParam(`${ctx}.booking_code`),
    pgParam(`${ctx}.guest_name`),
    pgParam(`${ctx}.phone`),
    pgParam(`${ctx}.guest_email`),
    pgParam(`${ctx}.check_in`),
    pgParam(`${ctx}.check_out`),
    pgParam(`${ctx}.guest_count`),
    pgParam(`${ctx}.package_code`),
    pgParam(`${ctx}.requested_room_type`),
    pgParam(`${ctx}.room_preference`),
    pgParam(`${ctx}.guest_gender_group_type`),
  ].join(',');

  if (updateStripeLink.parameters?.columns?.value) {
    updateStripeLink.parameters.columns.value.id = `={{ $('Code - Prepare Stripe Payment Context').first().json.hold_record_id }}`;
  }

  const newNodes = [
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'apply-stripe-after-hold',
              leftValue: STRIPE_AFTER_HOLD_IF_EXPR,
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
      position: [4528, 880],
      id: '2f020001-0001-4000-8000-000000000201',
      name: 'IF - Apply Stripe After Hold',
    },
    {
      parameters: {
        operation: 'update',
        base: {
          __rl: true,
          value: 'appOCWIN47Bui9CSS',
          mode: 'list',
          cachedResultName: 'Wolfhouse',
          cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS',
        },
        table: {
          __rl: true,
          value: 'tblYWm3zKFafe4qu7',
          mode: 'list',
          cachedResultName: 'Bookings',
          cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS/tblYWm3zKFafe4qu7',
        },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            id: "={{ $('Create Booking Hold').first().json.id }}",
            'Guest Name':
              "={{ $('Merge Session State').first().json.session?.name || $('Code - Prepare Hold Records').first().json.guest_name || '' }}",
            Email:
              "={{ $('Merge Session State').first().json.session?.email || $('Code - Prepare Hold Records').first().json.guest_email || '' }}",
            Phone:
              "={{ $('Normalize Incoming Message').first().json.phone || $('Code - Prepare Hold Records').first().json.guest_phone || '' }}",
            Status: 'Payment_Pending',
            'Payment Status': 'waiting_payment',
          },
          matchingColumns: ['id'],
          schema: [
            {
              id: 'id',
              displayName: 'id',
              required: false,
              defaultMatch: true,
              display: true,
              type: 'string',
              readOnly: true,
              removed: false,
            },
          ],
          attemptToConvertTypes: false,
          convertFieldsToString: false,
        },
        options: { typecast: true },
      },
      type: 'n8n-nodes-base.airtable',
      typeVersion: 2.2,
      position: [4688, 800],
      id: '2f020002-0002-4000-8000-000000000202',
      name: 'Update Booking Hold - Apply Staged Contact',
      credentials: {
        airtableTokenApi: { id: '', name: 'Airtable Personal Access Token account' },
      },
    },
    {
      parameters: { jsCode: PREPARE_STRIPE_CONTEXT_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [3080, 672],
      id: '2f020003-0003-4000-8000-000000000203',
      name: 'Code - Prepare Stripe Payment Context',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'payment-link-safe',
              leftValue: `={{ 
  ($env.USE_STRIPE_CHECKOUT || 'true').toString().toLowerCase() !== 'true'
  || (() => {
    const link = String(
      $('Update Booking - Stripe Payment Link').isExecuted
        ? ($('Update Booking - Stripe Payment Link').first().json.fields?.['Payment Link'] || '')
        : ($('Code - Prepare Stripe Payment Context').first().json.payment_link || '')
    ).trim();
    return link.length > 0 && !link.includes('booking-payment-placeholder');
  })()
}}`,
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
      position: [3920, 368],
      id: '2f020004-0004-4000-8000-000000000204',
      name: 'IF - Payment Link Safe For Reply',
    },
    {
      parameters: { jsCode: STRIPE_FALLBACK_REPLY_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [3920, 512],
      id: '2f020005-0005-4000-8000-000000000205',
      name: 'Code - Stripe Payment Fallback Reply',
    },
    {
      parameters: {
        content:
          '## Phase 2f.2 — Stripe after booking hold\n\n`Code - Summarize Holds` → IF Apply Stripe After Hold → sync guest → Prepare Stripe Context → 2c chain → payment reply.\n\nGuard blocks placeholder links when USE_STRIPE_CHECKOUT=true.',
        height: 200,
        width: 440,
      },
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [4440, 640],
      id: '2f020006-0006-4000-8000-000000000206',
      name: 'Sticky Note - Phase 2f.2',
    },
  ];

  workflow.nodes.push(...newNodes);

  workflow.connections['Code - Summarize Holds'] = {
    main: [[{ node: 'IF - Apply Stripe After Hold', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Apply Stripe After Hold'] = {
    main: [
      [{ node: 'Update Booking Hold - Apply Staged Contact', type: 'main', index: 0 }],
      [{ node: 'Reply - Availability Result', type: 'main', index: 0 }],
    ],
  };

  workflow.connections['Update Booking Hold - Apply Staged Contact'] = {
    main: [[{ node: 'Code - Prepare Stripe Payment Context', type: 'main', index: 0 }]],
  };

  workflow.connections['Update Hold With Guest Details'] = {
    main: [[{ node: 'Code - Prepare Stripe Payment Context', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Prepare Stripe Payment Context'] = {
    main: [[{ node: 'IF - Use Stripe Checkout', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Build Rooming Question'] = {
    main: [[{ node: 'IF - Payment Link Safe For Reply', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Payment Link Safe For Reply'] = {
    main: [
      [{ node: 'Reply - Payment Pending', type: 'main', index: 0 }],
      [{ node: 'Code - Stripe Payment Fallback Reply', type: 'main', index: 0 }],
    ],
  };

}

const SRC = path.join(__dirname, '..', 'n8n', 'Wolfhouse Booking Assistant  - Main.json');
const OUT = path.join(
  __dirname,
  '..',
  'n8n',
  'phase2',
  'Wolfhouse Booking Assistant - Main (local Stripe).json'
);

const workflow = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const stripePaymentLinkFieldSchema = stripePaymentLinkUpdateSchema(workflow);
workflow.name = 'Wolfhouse Booking Assistant - Main (local Stripe)';
workflow.tags = [
  ...(workflow.tags || []),
  { name: 'phase2c' },
  { name: 'phase2f' },
  { name: 'local-only' },
  { name: 'stripe' },
];

const updateHold = workflow.nodes.find((n) => n.name === 'Update Hold With Guest Details');
if (!updateHold) throw new Error('Update Hold With Guest Details not found');

// Stop writing placeholder; Stripe branch sets Payment Link when possible.
if (updateHold.parameters?.columns?.value) {
  delete updateHold.parameters.columns.value['Payment Link'];
}

const bookingCodeExpr =
  "={{ $('Search Hold With Guest Details').first().json.fields?.['Booking ID'] || '' }}";
const holdRecordIdExpr =
  "={{ $('Search Hold With Guest Details').first().json.id }}";

const holdFields = "$('Search Hold With Guest Details').first().json.fields";
const NULL_SENTINEL = '__NULL__';

/** n8n Postgres drops empty query params and shifts $n — use sentinel for every parameter. */
function pgParam(innerExpr) {
  return `={{ ((${innerExpr}) != null && String(${innerExpr}).trim() !== '') ? String(${innerExpr}).trim() : '${NULL_SENTINEL}' }}`;
}

const ensureQueryReplacement = [
  pgParam(`${holdFields}?.['Booking ID']`),
  pgParam(`${holdFields}?.['Guest Name'] || $('Code - Extract Guest Details').first().json.guest_name`),
  pgParam(`${holdFields}?.['Phone'] || $('Normalize Incoming Message').first().json.phone`),
  pgParam(`${holdFields}?.['Email'] || $('Code - Extract Guest Details').first().json.guest_email`),
  pgParam(`${holdFields}?.['Check In']`),
  pgParam(`${holdFields}?.['Check Out']`),
  pgParam(`${holdFields}?.['Guest Count']`),
  pgParam(`${holdFields}?.['Package']`),
  pgParam(`${holdFields}?.['Requested Room Type']`),
  pgParam(`${holdFields}?.['Room Preference']`),
  pgParam(`${holdFields}?.['Guest Gender / Group Type']`),
].join(',');

const ensureBookingSql = `WITH existing AS (
  SELECT b.id AS booking_id, b.booking_code, false AS created
  FROM bookings b
  WHERE b.booking_code = NULLIF($1, '${NULL_SENTINEL}')
    AND b.client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
  LIMIT 1
),
inserted AS (
  INSERT INTO bookings (
    client_id,
    booking_code,
    airtable_record_id,
    guest_name,
    phone,
    email,
    status,
    payment_status,
    check_in,
    check_out,
    guest_count,
    package_code,
    requested_room_type,
    room_preference,
    guest_gender_group_type,
    booking_source,
    deposit_required_cents
  )
  SELECT
    c.id,
    NULLIF($1, '${NULL_SENTINEL}'),
    NULL,
    NULLIF($2, '${NULL_SENTINEL}'),
    NULLIF($3, '${NULL_SENTINEL}'),
    NULLIF($4, '${NULL_SENTINEL}'),
    'payment_pending'::booking_status,
    'waiting_payment'::payment_status,
    NULLIF($5, '${NULL_SENTINEL}')::date,
    NULLIF($6, '${NULL_SENTINEL}')::date,
    GREATEST(
      COALESCE(
        CASE
          WHEN NULLIF($7, '${NULL_SENTINEL}') IS NULL THEN 1
          ELSE NULLIF(trim(NULLIF($7, '${NULL_SENTINEL}')::text), '')::integer
        END,
        1
      ),
      1
    ),
    NULLIF($8, '${NULL_SENTINEL}'),
    NULLIF($9, '${NULL_SENTINEL}'),
    NULLIF($10, '${NULL_SENTINEL}'),
    NULLIF($11, '${NULL_SENTINEL}'),
    'whatsapp'::booking_source,
    NULL
  FROM clients c
  WHERE c.slug = 'wolfhouse-somo'
    AND NULLIF($1, '${NULL_SENTINEL}') IS NOT NULL
    AND NULLIF($5, '${NULL_SENTINEL}') IS NOT NULL
    AND NULLIF($6, '${NULL_SENTINEL}') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id AS booking_id, booking_code, true AS created
)
SELECT booking_id, booking_code, created FROM inserted
UNION ALL
SELECT booking_id, booking_code, created FROM existing
WHERE NOT EXISTS (SELECT 1 FROM inserted);`;

const newNodes = [
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'use-stripe',
            leftValue: "={{ ($env.USE_STRIPE_CHECKOUT || 'true').toString().toLowerCase() }}",
            rightValue: 'true',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [3000, 672],
    id: '2c010001-0001-4000-8000-000000000001',
    name: 'IF - Use Stripe Checkout',
  },
  {
    parameters: {
      operation: 'executeQuery',
      query: ensureBookingSql,
      options: {
        queryReplacement: ensureQueryReplacement,
      },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [3220, 560],
    id: '2c010002-0002-4000-8000-000000000002',
    name: 'Postgres - Ensure Booking In Postgres',
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
            id: 'has-booking-id',
            leftValue: '={{ $json.booking_id }}',
            rightValue: '',
            operator: { type: 'string', operation: 'notEmpty' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [3440, 560],
    id: '2c010003-0003-4000-8000-000000000003',
    name: 'IF - Booking ID Ready',
  },
  {
    parameters: {
      jsCode: `const row = $('Postgres - Ensure Booking In Postgres').first().json;
const bookingId = row.booking_id;
if (!bookingId) {
  return [{
    json: {
      ok: false,
      error: 'No booking_id after Ensure Booking In Postgres',
    },
  }];
}

const url = $env.N8N_CREATE_PAYMENT_SESSION_URL || 'http://localhost:5678/webhook/create-payment-session';

try {
  const data = await this.helpers.httpRequest({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body: { booking_id: bookingId, payment_kind: 'deposit_only' },
    json: true,
  });

  if (!data || !data.ok || !data.checkout_url) {
    return [{
      json: {
        ok: false,
        error: (data && data.error) || 'Create Payment Session did not return checkout_url',
        booking_id: bookingId,
        created_in_postgres: !!row.created,
      },
    }];
  }

  return [{
    json: {
      ok: true,
      checkout_url: data.checkout_url,
      reused: !!data.reused,
      booking_id: bookingId,
      amount_due_cents: data.amount_due_cents,
      stripe_checkout_session_id: data.stripe_checkout_session_id,
      created_in_postgres: !!row.created,
    },
  }];
} catch (error) {
  return [{
    json: {
      ok: false,
      error: error.message || String(error),
      booking_id: bookingId,
      created_in_postgres: !!row.created,
    },
  }];
}`,
    },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [3660, 480],
    id: '2c010004-0004-4000-8000-000000000004',
    name: 'Code - Call Create Payment Session',
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'checkout-ok',
            leftValue: '={{ $json.ok }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [3880, 480],
    id: '2c010005-0005-4000-8000-000000000005',
    name: 'IF - Checkout URL Ready',
  },
  {
    parameters: {
      operation: 'update',
      base: {
        __rl: true,
        value: 'appOCWIN47Bui9CSS',
        mode: 'list',
        cachedResultName: 'Wolfhouse Ops',
        cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS',
      },
      table: {
        __rl: true,
        value: 'tblYWm3zKFafe4qu7',
        mode: 'list',
        cachedResultName: 'Bookings',
        cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS/tblYWm3zKFafe4qu7',
      },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          id: STRIPE_HOLD_RECORD_ID_EXPR,
          'Payment Link':
            "={{ $('Code - Call Create Payment Session').first().json.checkout_url }}",
        },
        matchingColumns: ['id'],
        schema: stripePaymentLinkFieldSchema,
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { typecast: true },
    },
    type: 'n8n-nodes-base.airtable',
    typeVersion: 2.2,
    position: [4100, 400],
    id: '2c010006-0006-4000-8000-000000000006',
    name: 'Update Booking - Stripe Payment Link',
    credentials: {
      airtableTokenApi: { id: '', name: 'Airtable Personal Access Token account' },
    },
  },
  {
    parameters: {
      content:
        '## Phase 2c — Ensure Booking In Postgres\n\nQuery params use __NULL__ sentinel (n8n drops empty params).\n\nairtable_record_id = NULL for now. deposit_required_cents = NULL.',
      height: 220,
      width: 420,
    },
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [2760, 420],
    id: '2c010007-0007-4000-8000-000000000007',
    name: 'Sticky Note - Phase 2c',
  },
];

workflow.nodes.push(...newNodes);

const nextNode = 'Update Conversation - Guest Details';

workflow.connections['Update Hold With Guest Details'] = {
  main: [[{ node: 'IF - Use Stripe Checkout', type: 'main', index: 0 }]],
};

workflow.connections['IF - Use Stripe Checkout'] = {
  main: [
    [{ node: 'Postgres - Ensure Booking In Postgres', type: 'main', index: 0 }],
    [{ node: nextNode, type: 'main', index: 0 }],
  ],
};

workflow.connections['Postgres - Ensure Booking In Postgres'] = {
  main: [[{ node: 'IF - Booking ID Ready', type: 'main', index: 0 }]],
};

workflow.connections['IF - Booking ID Ready'] = {
  main: [
    [{ node: 'Code - Call Create Payment Session', type: 'main', index: 0 }],
    [{ node: nextNode, type: 'main', index: 0 }],
  ],
};

workflow.connections['Code - Call Create Payment Session'] = {
  main: [[{ node: 'IF - Checkout URL Ready', type: 'main', index: 0 }]],
};

workflow.connections['IF - Checkout URL Ready'] = {
  main: [
    [{ node: 'Update Booking - Stripe Payment Link', type: 'main', index: 0 }],
    [{ node: nextNode, type: 'main', index: 0 }],
  ],
};

workflow.connections['Update Booking - Stripe Payment Link'] = {
  main: [[{ node: nextNode, type: 'main', index: 0 }]],
};

applyPhase2f(workflow);
applyPhase2f2(workflow);
applyMergedPaymentPathFixes(workflow);
applyDeterministicPaymentUrl(workflow);

workflow.tags = [...(workflow.tags || []), { name: 'phase2f2' }, { name: 'phase2f3' }];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(workflow, null, 2));
console.log('Wrote', OUT);
console.log('Nodes:', workflow.nodes.length);
