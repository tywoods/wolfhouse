/**
 * Stage 27w.3 — Multi-turn Luna Guest Simulator flow harness.
 *
 * Exercises POST /staff/bot/guest-automation-review-dry-run with guest_context
 * chaining across turns. Optional hold/draft and Stripe TEST link via explicit flags.
 *
 * Usage:
 *   npm run luna:guest-sim:flow -- --fixture booking-deposit
 *   npm run luna:guest-sim:flow -- --base-url https://staff-staging.lunafrontdesk.com --fixture booking-deposit
 *   npm run luna:guest-sim:flow -- --fixture booking-deposit --create-hold-draft --create-stripe-test-link
 *
 * Auth: LUNA_BOT_INTERNAL_TOKEN → X-Luna-Bot-Token (infra/.env or environment).
 * Does not send WhatsApp, call Meta/n8n, or use production/live Stripe by default.
 */

'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const REVIEW_ROUTE = '/staff/bot/guest-automation-review-dry-run';
const HOLD_ROUTE = '/staff/bot/guest-simulator-create-hold-draft';
const STRIPE_ROUTE = '/staff/bot/guest-simulator-create-stripe-test-link';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
const CLIENT_SLUG = 'wolfhouse-somo';

const FIXTURES = {
  'booking-deposit': {
    label: 'Multi-turn booking → dates → deposit (27w.3)',
    turns: [
      {
        step: 1,
        message: 'Hi, we are 2 people interested in the Malibu package',
        expect: (ctx) => {
          const r = ctx.review;
          const fields = r.result && r.result.extracted_fields;
          const reply = r.proposed_luna_reply || '';
          const failures = [];
          if (r.result && r.result.message_lane !== 'new_booking_inquiry') {
            failures.push(`message_lane expected new_booking_inquiry got ${r.result.message_lane}`);
          }
          if (!fields || fields.guest_count !== 2) {
            failures.push(`guest_count expected 2 got ${fields && fields.guest_count}`);
          }
          if (!fields || fields.package_interest !== 'malibu') {
            failures.push(`package_interest expected malibu got ${fields && fields.package_interest}`);
          }
          if (!/dates|check-in|check-out|stay/i.test(reply)) {
            failures.push('proposed_luna_reply should ask for dates');
          }
          return failures;
        },
      },
      {
        step: 2,
        message: 'July 10 to July 17',
        expect: (ctx) => {
          const r = ctx.review;
          const fields = r.result && r.result.extracted_fields;
          const reply = r.proposed_luna_reply || '';
          const failures = [];
          if (!fields || fields.guest_count !== 2) {
            failures.push(`guest_count expected 2 got ${fields && fields.guest_count}`);
          }
          if (!fields || fields.package_interest !== 'malibu') {
            failures.push(`package_interest expected malibu got ${fields && fields.package_interest}`);
          }
          if (!fields || !fields.check_in || !fields.check_out) {
            failures.push('check_in/check_out expected present');
          }
          if (r.result && r.result.booking_intake_ready !== true) {
            failures.push(`booking_intake_ready expected true got ${r.result && r.result.booking_intake_ready}`);
          }
          if (!r.availability || r.availability.availability_check_attempted !== true) {
            failures.push('availability_check_attempted expected true');
          }
          if (/how many guests will be staying/i.test(reply)) {
            failures.push('must NOT ask "How many guests will be staying?"');
          }
          return failures;
        },
      },
      {
        step: 3,
        message: 'Deposit is fine',
        conditional: (ctx) => {
          const prev = ctx.priorReview;
          return !!(prev && prev.quote && prev.quote.payment_choice_needed === true);
        },
        expect: (ctx) => {
          const r = ctx.review;
          const pc = r.payment_choice || {};
          const plan = r.hold_payment_draft_plan || {};
          const failures = [];
          if (pc.payment_choice_detected !== true) {
            failures.push('payment_choice_detected expected true');
          }
          if (pc.payment_choice !== 'deposit') {
            failures.push(`payment_choice expected deposit got ${pc.payment_choice}`);
          }
          if (pc.payment_choice_ready !== true) {
            failures.push('payment_choice_ready expected true');
          }
          if (pc.next_safe_step !== 'ready_for_hold_payment_draft') {
            failures.push(`next_safe_step expected ready_for_hold_payment_draft got ${pc.next_safe_step}`);
          }
          return failures;
        },
        partial: (ctx) => {
          const plan = (ctx.review && ctx.review.hold_payment_draft_plan) || {};
          if (plan.plan_status != null && plan.plan_status !== 'ready') {
            return [`hold_payment_draft_plan.plan_status expected ready got ${plan.plan_status}`];
          }
          return [];
        },
      },
    ],
  },
};

function usage() {
  console.log(`
Luna Guest Simulator flow harness (Stage 27w.3)

  node scripts/run-luna-guest-simulator-flow.js [options]

Options:
  --base-url <url>         Staff API base (default: http://127.0.0.1:3036; env STAFF_API_BASE_URL)
  --phone <e164>           Guest phone (default: +34600999999)
  --name <text>            Guest name for hold/draft writes (default: Staging Test Guest)
  --email <email>          Guest email for hold/draft writes (default: staging-test@wolfhouse.test)
  --reference-date <iso>   Date anchor YYYY-MM-DD (default: 2026-06-08)
  --fixture <name>         Flow fixture (default: booking-deposit)
  --create-hold-draft      Also POST guest-simulator-create-hold-draft (explicit write)
  --create-stripe-test-link  Also POST guest-simulator-create-stripe-test-link (requires hold draft)
  --json                   Print full result JSON
  --help                   Show this help

Fixtures:
${Object.keys(FIXTURES).map((k) => `  ${k.padEnd(18)} ${FIXTURES[k].label}`).join('\n')}

Default run is review-only (no hold/draft, no Stripe).

Examples:
  npm run luna:guest-sim:flow -- --base-url http://127.0.0.1:3036 --fixture booking-deposit
  npm run luna:guest-sim:flow -- --fixture booking-deposit --create-hold-draft --create-stripe-test-link
`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: (process.env.STAFF_API_BASE_URL || 'http://127.0.0.1:3036').replace(/\/$/, ''),
    phone: '+34600999999',
    name: 'Staging Test Guest',
    email: 'staging-test@wolfhouse.test',
    referenceDate: '2026-06-08',
    fixture: 'booking-deposit',
    createHoldDraft: false,
    createStripeTestLink: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--base-url':
        opts.baseUrl = String(argv[++i] || '').replace(/\/$/, '');
        break;
      case '--phone':
        opts.phone = argv[++i];
        break;
      case '--name':
        opts.name = argv[++i];
        break;
      case '--email':
        opts.email = argv[++i];
        break;
      case '--reference-date':
        opts.referenceDate = argv[++i];
        break;
      case '--fixture':
        opts.fixture = argv[++i];
        break;
      case '--create-hold-draft':
        opts.createHoldDraft = true;
        break;
      case '--create-stripe-test-link':
        opts.createStripeTestLink = true;
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        opts.help = true;
        break;
    }
  }
  return opts;
}

function assertNotProduction(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes('lunafrontdesk.com') && !host.includes('staging') && !host.includes('staff-staging')) {
      throw new Error(`production host blocked: ${host}`);
    }
    if (/^staff\.lunafrontdesk\.com$/i.test(host)) {
      throw new Error(`production host blocked: ${host}`);
    }
  } catch (e) {
    if (e.message && e.message.includes('production host blocked')) throw e;
    throw new Error(`invalid --base-url: ${baseUrl}`);
  }
}

function postJson(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function redactBase(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid-base-url)';
  }
}

function guestContextFromReview(apiBody) {
  const r = (apiBody && apiBody.review) || {};
  return {
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice_needed: r.quote && r.quote.payment_choice_needed,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    detected_language: r.result && r.result.detected_language,
  };
}

function reviewPayload(opts, messageText, guestContext) {
  const payload = {
    client_slug: CLIENT_SLUG,
    channel: 'staff_review',
    message_text: messageText,
    dry_run: true,
    reference_date: opts.referenceDate,
    guest_phone: opts.phone,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
    },
  };
  if (guestContext) payload.guest_context = guestContext;
  return payload;
}

function summarizeTurn(step, message, apiBody, expectFailures) {
  const r = (apiBody && apiBody.review) || {};
  const res = r.result || {};
  const a = r.availability || {};
  const q = r.quote || {};
  const pc = r.payment_choice || {};
  return {
    step,
    message,
    http_status: apiBody._http_status,
    success: apiBody.success === true,
    proposed_luna_reply: r.proposed_luna_reply ?? null,
    message_lane: res.message_lane ?? null,
    intake_state: res.intake_state ?? null,
    readiness_state: res.readiness_state ?? null,
    booking_intake_ready: res.booking_intake_ready ?? null,
    extracted_fields: res.extracted_fields || {},
    availability_check_attempted: a.availability_check_attempted ?? null,
    availability_status: a.availability_status ?? null,
    quote_status: q.quote_status ?? null,
    quote_total_cents: q.quote_total_cents ?? null,
    payment_choice_needed: q.payment_choice_needed ?? null,
    payment_choice_detected: pc.payment_choice_detected ?? null,
    payment_choice: pc.payment_choice ?? null,
    payment_choice_ready: pc.payment_choice_ready ?? null,
    next_safe_step: pc.next_safe_step ?? null,
    hold_plan_status: (r.hold_payment_draft_plan && r.hold_payment_draft_plan.plan_status) ?? null,
    dry_run: apiBody.dry_run === true,
    sends_whatsapp: apiBody.sends_whatsapp === false,
    live_send_blocked: apiBody.live_send_blocked === true,
    expect_failures: expectFailures,
    expect_pass: expectFailures.length === 0,
    skipped: apiBody._skipped === true,
    skip_reason: apiBody._skip_reason || null,
  };
}

function printTurnSummary(turn) {
  console.log(`\n── Turn ${turn.step}: ${turn.message} ──`);
  if (turn.skipped) {
    console.log(`skipped: ${turn.skip_reason}`);
    return;
  }
  console.log(`lane:                 ${turn.message_lane ?? '(n/a)'}`);
  console.log(`intake_state:         ${turn.intake_state ?? '(n/a)'}`);
  console.log(`readiness_state:      ${turn.readiness_state ?? '(n/a)'}`);
  console.log(`booking_intake_ready: ${turn.booking_intake_ready ?? '(n/a)'}`);
  console.log(`extracted_fields:     ${JSON.stringify(turn.extracted_fields)}`);
  console.log(`availability:         attempted=${turn.availability_check_attempted} status=${turn.availability_status ?? '(n/a)'}`);
  console.log(`quote:                status=${turn.quote_status ?? '(n/a)'} total_cents=${turn.quote_total_cents ?? '(n/a)'} payment_choice_needed=${turn.payment_choice_needed ?? '(n/a)'}`);
  console.log(`payment_choice:       detected=${turn.payment_choice_detected} choice=${turn.payment_choice ?? '(n/a)'} ready=${turn.payment_choice_ready} next=${turn.next_safe_step ?? '(n/a)'}`);
  if (turn.hold_plan_status != null) console.log(`hold_plan_status:     ${turn.hold_plan_status}`);
  console.log(`proposed_luna_reply:  ${turn.proposed_luna_reply ?? '(n/a)'}`);
  console.log(`expect:               ${turn.expect_pass ? 'PASS' : 'FAIL'}`);
  if (!turn.expect_pass) {
    for (const f of turn.expect_failures) console.log(`  - ${f}`);
  }
  if (turn.partial_notes && turn.partial_notes.length > 0) {
    console.log('partial:');
    for (const n of turn.partial_notes) console.log(`  - ${n}`);
  }
}

async function runReviewTurn(opts, headers, message, guestContext) {
  const target = `${opts.baseUrl}${REVIEW_ROUTE}`;
  const res = await postJson(target, reviewPayload(opts, message, guestContext), headers);
  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };
  body._http_status = res.status;
  return body;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  if (opts.createStripeTestLink && !opts.createHoldDraft) {
    console.error('Error: --create-stripe-test-link requires --create-hold-draft');
    process.exit(1);
  }

  const fx = FIXTURES[opts.fixture];
  if (!fx) {
    console.error(`Unknown fixture: ${opts.fixture}`);
    console.error(`Valid fixtures: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(1);
  }

  try {
    assertNotProduction(opts.baseUrl);
  } catch (e) {
    console.error(`FAIL — ${e.message}`);
    process.exit(1);
  }

  const headers = {};
  if (TOKEN) headers['X-Luna-Bot-Token'] = TOKEN;

  console.log(`Luna Guest Simulator flow — fixture: ${opts.fixture}`);
  console.log(`POST ${redactBase(opts.baseUrl)}${REVIEW_ROUTE}`);
  if (!TOKEN) {
    console.log('note: LUNA_BOT_INTERNAL_TOKEN not set — using open local auth if enabled');
  }

  const result = {
    result: 'PASS',
    fixture: opts.fixture,
    base_url: redactBase(opts.baseUrl),
    reference_date: opts.referenceDate,
    review_only: !opts.createHoldDraft && !opts.createStripeTestLink,
    turns: [],
    hold_draft: null,
    stripe_test_link: null,
    first_failure: null,
    safety: {
      dry_run: true,
      sends_whatsapp: false,
      live_send_blocked: true,
      production_blocked: true,
    },
  };

  let guestContext = null;
  let lastReviewBody = null;
  let lastReviewForPayment = null;
  let anyRequiredFail = false;
  let anyPartial = false;

  for (const turnDef of fx.turns) {
    if (turnDef.conditional && !turnDef.conditional({ priorReview: lastReviewForPayment })) {
      const skipped = {
        step: turnDef.step,
        message: turnDef.message,
        _skipped: true,
        _skip_reason: 'conditional: quote.payment_choice_needed not true on prior turn',
        success: true,
        dry_run: true,
        sends_whatsapp: false,
        live_send_blocked: true,
      };
      const summary = summarizeTurn(turnDef.step, turnDef.message, skipped, []);
      summary.skipped = true;
      summary.skip_reason = skipped._skip_reason;
      result.turns.push(summary);
      anyPartial = true;
      if (!opts.json) printTurnSummary(summary);
      continue;
    }

    let apiBody;
    try {
      apiBody = await runReviewTurn(opts, headers, turnDef.message, guestContext);
    } catch (e) {
      console.error(`FAIL — turn ${turnDef.step} request error: ${e.message}`);
      process.exit(1);
    }

    if (apiBody.sends_whatsapp !== false || apiBody.live_send_blocked !== true || apiBody.dry_run !== true) {
      anyRequiredFail = true;
      if (!result.first_failure) {
        result.first_failure = {
          step: turnDef.step,
          reason: 'safety flags missing (dry_run/sends_whatsapp/live_send_blocked)',
          excerpt: { dry_run: apiBody.dry_run, sends_whatsapp: apiBody.sends_whatsapp, live_send_blocked: apiBody.live_send_blocked },
        };
      }
    }

    if (apiBody._http_status === 401 && !TOKEN) {
      console.error('\nFAIL — HTTP 401: set LUNA_BOT_INTERNAL_TOKEN for staging/authenticated hosts');
      process.exit(1);
    }

    if (apiBody._http_status !== 200 || apiBody.success !== true) {
      anyRequiredFail = true;
      const reason = apiBody.error || `HTTP ${apiBody._http_status}`;
      if (!result.first_failure) {
        result.first_failure = {
          step: turnDef.step,
          reason,
          excerpt: typeof apiBody === 'object' ? apiBody : { raw: String(apiBody) },
        };
      }
      const summary = summarizeTurn(turnDef.step, turnDef.message, apiBody, [reason]);
      result.turns.push(summary);
      if (!opts.json) printTurnSummary(summary);
      break;
    }

    const expectCtx = {
      review: apiBody.review,
      priorReview: lastReviewForPayment,
    };
    const expectFailures = turnDef.expect(expectCtx);
    const partialNotes = turnDef.partial ? turnDef.partial(expectCtx) : [];
    if (partialNotes.length > 0) anyPartial = true;
    if (expectFailures.length > 0) {
      anyRequiredFail = true;
      if (!result.first_failure) {
        result.first_failure = {
          step: turnDef.step,
          reason: expectFailures[0],
          excerpt: {
            proposed_luna_reply: apiBody.review && apiBody.review.proposed_luna_reply,
            result: apiBody.review && apiBody.review.result,
            availability: apiBody.review && apiBody.review.availability,
            quote: apiBody.review && apiBody.review.quote,
            payment_choice: apiBody.review && apiBody.review.payment_choice,
          },
        };
      }
    }

    const summary = summarizeTurn(turnDef.step, turnDef.message, apiBody, expectFailures);
    if (partialNotes.length > 0) summary.partial_notes = partialNotes;
    result.turns.push(summary);
    if (!opts.json) printTurnSummary(summary);

    guestContext = guestContextFromReview(apiBody);
    lastReviewBody = apiBody;
    lastReviewForPayment = apiBody.review;
  }

  if (opts.createHoldDraft && lastReviewBody && lastReviewBody.review) {
    const r = lastReviewBody.review;
    const holdPayload = {
      source: 'luna_guest_simulator',
      confirm_simulator_write: true,
      confirm_write: true,
      client_slug: CLIENT_SLUG,
      guest_name: opts.name,
      guest_email: opts.email,
      guest_phone: opts.phone,
      chain: {
        result: r.result,
        availability: r.availability,
        quote: r.quote,
        payment_choice: r.payment_choice,
      },
    };
    try {
      const hres = await postJson(`${opts.baseUrl}${HOLD_ROUTE}`, holdPayload, headers);
      const hbody = typeof hres.body === 'object' ? hres.body : { success: false, error: hres.raw };
      result.hold_draft = {
        http_status: hres.status,
        success: hbody.success === true,
        write_status: hbody.write_status ?? null,
        booking_id: hbody.booking_id ?? null,
        booking_code: hbody.booking_code ?? null,
        payment_draft_id: hbody.payment_draft_id ?? null,
        sends_whatsapp: hbody.sends_whatsapp === false,
        live_send_blocked: hbody.live_send_blocked === true,
      };
      if (!opts.json) {
        console.log('\n── Hold/draft write (--create-hold-draft) ──');
        console.log(`write_status:      ${result.hold_draft.write_status ?? '(n/a)'}`);
        console.log(`booking_code:      ${result.hold_draft.booking_code ?? '(n/a)'}`);
        console.log(`payment_draft_id:  ${result.hold_draft.payment_draft_id ?? '(n/a)'}`);
      }
      const holdOk = hres.status === 200 && hbody.success === true
        && (hbody.write_status === 'created' || hbody.write_status === 'reused_existing')
        && hbody.booking_id && hbody.payment_draft_id;
      if (!holdOk) {
        anyRequiredFail = true;
        if (!result.first_failure) {
          result.first_failure = {
            step: 'hold-draft',
            reason: hbody.error || `hold/draft write failed HTTP ${hres.status}`,
            excerpt: hbody,
          };
        }
      }
      if (opts.createStripeTestLink && hbody.payment_draft_id) {
        const spayload = {
          source: 'luna_guest_simulator',
          confirm_simulator_stripe: true,
          confirm_stripe_test_link: true,
          payment_draft_id: hbody.payment_draft_id,
          booking_id: hbody.booking_id,
          booking_code: hbody.booking_code,
        };
        const sres = await postJson(`${opts.baseUrl}${STRIPE_ROUTE}`, spayload, headers);
        const sbody = typeof sres.body === 'object' ? sres.body : { success: false, error: sres.raw };
        result.stripe_test_link = {
          http_status: sres.status,
          success: sbody.success === true,
          stripe_link_created: sbody.stripe_link_created === true || sbody.reused === true,
          stripe_checkout_url: sbody.stripe_checkout_url ?? null,
          test_mode: sbody.test_mode !== false,
          sends_whatsapp: sbody.sends_whatsapp === false,
          live_send_blocked: sbody.live_send_blocked === true,
        };
        if (!opts.json) {
          console.log('\n── Stripe TEST link (--create-stripe-test-link) ──');
          console.log(`stripe_link_created: ${result.stripe_test_link.stripe_link_created}`);
          console.log(`stripe_checkout_url: ${result.stripe_test_link.stripe_checkout_url ?? '(n/a)'}`);
        }
        const stripeOk = sres.status === 200 && sbody.success === true
          && result.stripe_test_link.stripe_link_created
          && result.stripe_test_link.stripe_checkout_url;
        if (!stripeOk) {
          anyRequiredFail = true;
          if (!result.first_failure) {
            result.first_failure = {
              step: 'stripe-test-link',
              reason: sbody.error || `Stripe test link failed HTTP ${sres.status}`,
              excerpt: sbody,
            };
          }
        }
      }
    } catch (e) {
      anyRequiredFail = true;
      result.hold_draft = { error: e.message };
      if (!result.first_failure) {
        result.first_failure = { step: 'hold-draft', reason: e.message, excerpt: null };
      }
    }
  } else if (opts.createHoldDraft) {
    anyRequiredFail = true;
    result.hold_draft = { skipped: true, reason: 'no successful review to chain from' };
    if (!result.first_failure) {
      result.first_failure = { step: 'hold-draft', reason: 'no review result for hold/draft', excerpt: null };
    }
  }

  if (anyRequiredFail) {
    result.result = 'FAIL';
  } else if (anyPartial) {
    result.result = 'PARTIAL';
  } else {
    result.result = 'PASS';
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n── Flow result: ${result.result} ──`);
    if (result.first_failure) {
      console.log(`first failure: step ${result.first_failure.step} — ${result.first_failure.reason}`);
    }
    console.log(`safety: dry_run review-only=${result.review_only} sends_whatsapp=false live_send_blocked=true`);
  }

  process.exit(result.result === 'FAIL' ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL —', e.message);
  process.exit(1);
});
