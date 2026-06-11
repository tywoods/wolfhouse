'use strict';

/**
 * Stage 35b — hosted staging proof for stale quote, reset, and cash side-question flows.
 *
 * Uses POST /staff/bot/guest-inbound-review-dry-run on staging Staff API (real hosted path).
 * Safe by default: review-only, no WhatsApp send, no booking/hold writes, no Stripe links.
 *
 * Usage:
 *   node scripts/run-stage35b-hosted-messy-flow-proof.js
 *   node scripts/run-stage35b-hosted-messy-flow-proof.js --deploy
 *   node scripts/run-stage35b-hosted-messy-flow-proof.js --skip-deploy --json
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execSync } = require('child_process');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  DEFAULT_BASE_URL,
  STAFF_API_APP,
  STAFF_API_RG,
  GATE_NAMES,
  PLAYGROUND_OFF_ENV,
  fetchStaffApiGates,
  fetchN8nWorkflowStatus,
  azExec,
  trimStr,
} = require('./lib/open-demo-playground-common');
const {
  FORBIDDEN_GUEST_PHRASES,
  isForbiddenGuestCopy,
} = require('./lib/luna-guest-reply-style-contract');

const COMMIT = '1d8a6d3';
const IMAGE_TAG = `${COMMIT}-stage35b-messy-flow-proof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage35b-messy-flow';
const HOST = 'staff-staging.lunafrontdesk.com';
const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';
const CLIENT_SLUG = 'wolfhouse-somo';
const REFERENCE_DATE = '2026-06-10';
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'luna-conversation-state-machine');
const TOKEN = resolveBotToken();

function resolveBotToken() {
  const fromEnv = trimStr(process.env.LUNA_BOT_INTERNAL_TOKEN);
  if (fromEnv) return fromEnv;
  try {
    return azExec(
      'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
    );
  } catch {
    return '';
  }
}

const PROOFS = [
  {
    id: 'A_date_correction',
    fixture: 'date-correction-before-payment',
    phonePrefix: '+346298350',
    extraChecks: (turns) => {
      const failures = [];
      const quoteTurn = turns.find((t) => /no thanks.*own stuff/i.test(t.message));
      const correctionTurn = turns.find((t) => /actually July 2-6/i.test(t.message));
      if (quoteTurn && !/€180|180/.test(quoteTurn.facts.proposed_luna_reply || '')) {
        failures.push('A: original July 1-5 quote (€180) missing before correction');
      }
      if (correctionTurn) {
        if (!correctionTurn.facts.stale_quote) failures.push('A: stale_quote false on date correction');
        if (correctionTurn.facts.stale_quote_reason !== 'dates_changed') {
          failures.push(`A: stale_quote_reason expected dates_changed got ${correctionTurn.facts.stale_quote_reason}`);
        }
        if (/checkout\.stripe\.com/i.test(correctionTurn.facts.proposed_luna_reply || '')) {
          failures.push('A: old payment link on correction turn');
        }
        if (correctionTurn.facts.payment_choice_ready === true) {
          failures.push('A: payment_choice_ready true while quote stale');
        }
        if (correctionTurn.facts.hold_plan_status === 'ready') {
          failures.push('A: hold_plan_status ready while quote stale');
        }
        if (correctionTurn.facts.check_in !== '2026-07-02' || correctionTurn.facts.check_out !== '2026-07-06') {
          failures.push('A: corrected dates not July 2-6');
        }
      } else {
        failures.push('A: correction turn missing');
      }
      return failures;
    },
  },
  {
    id: 'B_reset_after_quote',
    fixture: 'reset-after-quote',
    phonePrefix: '+346298351',
    extraChecks: (turns) => {
      const failures = [];
      const resetTurn = turns.find((t) => /start over/i.test(t.message));
      const freshTurn = turns.find((t) => /^July 1-5$/i.test(t.message.trim()));
      if (resetTurn && !resetTurn.facts.new_booking_reset) {
        failures.push('B: reset intent not detected (new_booking_reset)');
      }
      if (freshTurn) {
        if (/Malibu comes to/i.test(freshTurn.facts.proposed_luna_reply || '')) {
          failures.push('B: old Malibu quote context leaked after reset');
        }
        if (freshTurn.facts.stale_quote === true) {
          failures.push('B: stale_quote true on fresh July 1-5 turn');
        }
      }
      const malibuTurn = turns[0];
      if (malibuTurn && malibuTurn.facts.quote_status !== 'ready') {
        failures.push('B: Malibu quote not ready on first turn');
      }
      return failures;
    },
  },
  {
    id: 'C_cash_side_question',
    fixture: 'cash-side-question-payment-context',
    phonePrefix: '+346298352',
    extraChecks: (turns) => {
      const failures = [];
      const cashTurn = turns.find((t) => /pay cash/i.test(t.message));
      const depositTurn = turns.find((t) => /deposit/i.test(t.message));
      if (cashTurn) {
        const reply = cashTurn.facts.proposed_luna_reply || '';
        if (!/cash/i.test(reply)) failures.push('C: cash answer missing cash mention');
        if (!/arrival|bank transfer|stripe/i.test(reply)) {
          failures.push('C: cash answer missing arrival/bank transfer/Stripe options');
        }
        if (cashTurn.facts.stale_quote === true) failures.push('C: stale_quote true on cash side question');
      }
      if (depositTurn) {
        if (depositTurn.facts.payment_choice !== 'deposit') {
          failures.push(`C: payment_choice expected deposit got ${depositTurn.facts.payment_choice}`);
        }
        if (depositTurn.facts.stale_quote === true) failures.push('C: stale_quote true on deposit turn');
        if (/checkout\.stripe\.com/i.test(depositTurn.facts.proposed_luna_reply || '')) {
          failures.push('C: Stripe link in reply (gates should block links in review path)');
        }
      }
      return failures;
    },
  },
];

const INTERNAL_LANGUAGE_BLACKLIST = [
  ...FORBIDDEN_GUEST_PHRASES,
  'not creating a hold',
  'not sending a payment link',
];

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`);
}

function tryAz(cmd) {
  try {
    return azExec(cmd);
  } catch (err) {
    return { error: trimStr(err.stderr || err.message || err) };
  }
}

function activeRevision() {
  const raw = tryAz(`az containerapp revision list --name ${STAFF_API_APP} --resource-group ${STAFF_API_RG} -o json`);
  if (raw && typeof raw === 'object' && raw.error) return { error: raw.error };
  const rows = JSON.parse(raw);
  const active = rows.find((x) => x.properties.trafficWeight === 100)
    || rows.find((x) => x.properties.active);
  if (!active) return { error: 'no active revision' };
  return {
    name: active.name,
    health: active.properties.healthState,
    traffic: active.properties.trafficWeight,
    image: active.properties?.template?.containers?.[0]?.image,
    created: active.properties?.createdTime,
  };
}

function healthz(baseUrl) {
  return new Promise((resolve) => {
    const u = new URL(`${baseUrl.replace(/\/$/, '')}/healthz`);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => resolve(String(res.statusCode)));
    req.on('error', () => resolve('000'));
    req.setTimeout(15000, () => { req.destroy(); resolve('000'); });
  });
}

async function deployIfNeeded(force, baseUrl) {
  const rev = activeRevision();
  const already = String(rev.image || '').includes(COMMIT);
  if (already && !force) {
    return { deployed: false, revision: rev, note: 'staging already on commit prefix' };
  }

  const head = tryAz('git rev-parse --short HEAD');
  if (typeof head === 'object' && head.error) throw new Error(head.error);
  if (!String(head).startsWith(COMMIT)) {
    throw new Error(`HEAD ${head} != ${COMMIT} — checkout feat commit before --deploy`);
  }

  console.error(`[deploy] acr build ${IMAGE_TAG}...`);
  tryAz(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  tryAz([
    'az containerapp update',
    `--name ${STAFF_API_APP}`,
    `--resource-group ${STAFF_API_RG}`,
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '-o none',
  ].join(' '));

  for (let i = 0; i < 60; i++) {
    sleep(10000);
    const cur = activeRevision();
    const hz = await healthz(baseUrl);
    console.error(`[deploy] wait ${i + 1}/60 rev=${cur.name} health=${cur.health} hz=${hz} image=${cur.image}`);
    if (String(cur.image || '').includes(IMAGE_TAG) && cur.health === 'Healthy' && cur.traffic === 100 && hz === '200') {
      return { deployed: true, revision: cur, healthz: hz };
    }
  }
  return { deployed: true, revision: activeRevision(), note: 'deploy wait timeout — check revision manually' };
}

function postJson(urlStr, payload, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { success: false, error: raw }; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function reviewToOut(body) {
  const review = body.review || {};
  return {
    proposed_luna_reply: review.proposed_luna_reply,
    proposed_next_action: review.proposed_next_action,
    automation_gate: review.automation_gate,
    result: review.result,
    availability: review.availability,
    quote: review.quote,
    payment_choice: review.payment_choice,
    hold_payment_draft_plan: review.hold_payment_draft_plan,
    dry_run: body.dry_run,
    no_write_performed: body.no_write_performed,
    sends_whatsapp: body.sends_whatsapp,
  };
}

function extractStructuredFacts(body) {
  const review = body.review || {};
  const r = review.result || {};
  const q = review.quote || {};
  const pc = review.payment_choice || {};
  const plan = review.hold_payment_draft_plan || {};
  const fields = r.extracted_fields || {};
  return {
    check_in: fields.check_in || q.check_in || null,
    check_out: fields.check_out || q.check_out || null,
    guest_count: fields.guest_count != null ? fields.guest_count : (q.guest_count != null ? q.guest_count : null),
    package: fields.package_interest || q.package_code || null,
    quote_status: q.quote_status || null,
    stale_quote: r.previous_quote_invalidated === true
      || q.quote_stale === true
      || q.previous_quote_invalidated === true,
    stale_quote_reason: r.stale_quote_reason || q.stale_quote_reason || null,
    corrected_fields: r.corrected_fields || q.corrected_fields || null,
    new_booking_reset: r.new_booking_reset === true,
    payment_choice: pc.payment_choice || null,
    payment_choice_ready: pc.payment_choice_ready === true,
    hold_plan_status: plan.plan_status || null,
    final_reply_source: (r.conversation_brain && r.conversation_brain.final_reply_source) || null,
    proposed_luna_reply: review.proposed_luna_reply || null,
    no_write_performed: body.no_write_performed === true,
    sends_whatsapp: body.sends_whatsapp,
    http_success: body.success === true,
  };
}

function findInternalLanguage(text) {
  const lower = String(text || '').toLowerCase();
  return INTERNAL_LANGUAGE_BLACKLIST.filter((term) => lower.includes(term.toLowerCase()));
}

function isHandoff(out) {
  const r = out.result || {};
  if (r.safe_handoff_required === true) return true;
  if (out.proposed_next_action === 'staff_handoff_required') return true;
  const gate = out.automation_gate || {};
  return gate.gate_status === 'blocked' || gate.gate_status === 'staff_handoff';
}

function checkTurnExpectations(expect, out) {
  const failures = [];
  if (!expect || typeof expect !== 'object') return failures;
  const reply = String(out.proposed_luna_reply || (out.result && out.result.proposed_luna_reply) || '');
  const fields = (out.result && out.result.extracted_fields) || {};

  if (Array.isArray(expect.reply_contains)) {
    for (const needle of expect.reply_contains) {
      if (!reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_contains "${needle}" missing`);
      }
    }
  }
  if (Array.isArray(expect.reply_not_contains)) {
    for (const needle of expect.reply_not_contains) {
      if (reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_not_contains "${needle}" found`);
      }
    }
  }
  if (expect.expected_fields) {
    for (const [key, val] of Object.entries(expect.expected_fields)) {
      if (fields[key] !== val) failures.push(`expected_fields.${key} expected ${JSON.stringify(val)} got ${JSON.stringify(fields[key])}`);
    }
  }
  if (expect.expected_no_handoff === true && isHandoff(out)) failures.push('expected_no_handoff but handoff required');
  if (expect.expected_payment_choice != null) {
    const pc = out.payment_choice && out.payment_choice.payment_choice;
    if (pc !== expect.expected_payment_choice) failures.push(`expected_payment_choice ${expect.expected_payment_choice} got ${pc}`);
  }
  if (expect.expected_quote_ready === true) {
    const qs = out.quote && out.quote.quote_status;
    if (qs !== 'ready') failures.push(`expected_quote_ready but quote_status=${qs}`);
  }
  if (expect.expected_quote_ready === false) {
    const qs = out.quote && out.quote.quote_status;
    if (qs === 'ready') failures.push('expected_quote_ready false but quote is ready');
  }
  if (expect.expected_stale_quote === true) {
    const stale = (out.result && out.result.previous_quote_invalidated === true)
      || (out.quote && out.quote.quote_stale === true)
      || (out.quote && out.quote.previous_quote_invalidated === true);
    if (!stale) failures.push('expected_stale_quote but quote was not invalidated');
  }
  if (expect.expected_stale_quote === false) {
    const stale = (out.result && out.result.previous_quote_invalidated === true)
      || (out.quote && out.quote.quote_stale === true);
    if (stale) failures.push('expected_stale_quote false but quote was invalidated');
  }
  if (expect.expected_stale_quote_reason != null) {
    const reason = (out.result && out.result.stale_quote_reason)
      || (out.quote && out.quote.stale_quote_reason);
    if (String(reason) !== String(expect.expected_stale_quote_reason)) {
      failures.push(`expected_stale_quote_reason ${expect.expected_stale_quote_reason} got ${reason}`);
    }
  }
  if (Array.isArray(expect.expected_corrected_fields)) {
    const got = (out.result && out.result.corrected_fields)
      || (out.quote && out.quote.corrected_fields)
      || [];
    for (const field of expect.expected_corrected_fields) {
      if (!got.includes(field)) failures.push(`expected_corrected_fields missing ${field}`);
    }
  }
  if (expect.expected_reset_detected === true) {
    if (!(out.result && out.result.new_booking_reset === true)) failures.push('expected_reset_detected but new_booking_reset not set');
  }
  if (expect.expected_package != null) {
    const pkg = fields.package_interest;
    if (String(pkg).toLowerCase() !== String(expect.expected_package).toLowerCase()) {
      failures.push(`expected_package ${expect.expected_package} got ${pkg}`);
    }
  }
  if (expect.expected_dates != null) {
    if (expect.expected_dates.check_in && fields.check_in !== expect.expected_dates.check_in) {
      failures.push(`expected check_in ${expect.expected_dates.check_in} got ${fields.check_in}`);
    }
    if (expect.expected_dates.check_out && fields.check_out !== expect.expected_dates.check_out) {
      failures.push(`expected check_out ${expect.expected_dates.check_out} got ${fields.check_out}`);
    }
  }
  if (expect.expected_no_payment_link_before_updated_quote === true) {
    if (/checkout\.stripe\.com/i.test(reply)) failures.push('stripe payment link present before updated quote');
  }
  if (expect.expected_context_preserved === true) {
    const hasDates = fields.check_in && fields.check_out;
    const hasGuests = fields.guest_count != null;
    if (!hasDates && !hasGuests && !fields.package_interest) failures.push('expected_context_preserved but booking fields missing');
  }
  if (expect.no_internal_language === true) {
    const bad = findInternalLanguage(reply);
    if (bad.length) failures.push(`internal language: ${bad.join(', ')}`);
    if (isForbiddenGuestCopy(reply)) failures.push('forbidden guest copy detected');
  }
  return failures;
}

function loadFixture(name) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`fixture not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildPayload({ baseUrl, phone, message, guestContext, turnIndex, contactName }) {
  return {
    source: 'stage35b_hosted_messy_flow_proof',
    client_slug: CLIENT_SLUG,
    channel: 'whatsapp',
    guest_phone: phone,
    contact_name: contactName || 'Stage35b Guest',
    message_text: message,
    reference_date: REFERENCE_DATE,
    received_at: new Date().toISOString(),
    inbound_message_id: `stage35b-${crypto.randomBytes(6).toString('hex')}-t${turnIndex + 1}`,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
    ...(guestContext ? { guest_context: guestContext } : {}),
  };
}

async function runProofFlow(proofDef, baseUrl) {
  const fixture = loadFixture(proofDef.fixture);
  const phone = `${proofDef.phonePrefix}${Math.floor(Math.random() * 9000 + 1000)}`;
  const headers = TOKEN ? { 'X-Luna-Bot-Token': TOKEN } : {};
  const target = `${baseUrl.replace(/\/$/, '')}${REVIEW_ROUTE}`;
  let guestContext = null;
  const turns = [];
  const failures = [];

  for (let i = 0; i < fixture.turns.length; i++) {
    const turnDef = fixture.turns[i];
    const payload = buildPayload({
      baseUrl,
      phone,
      message: turnDef.message,
      guestContext,
      turnIndex: i,
      contactName: fixture.contact_name,
    });
    const res = await postJson(target, payload, headers);
    const body = res.body || {};
    if (res.status !== 200 || body.success !== true) {
      failures.push(`turn ${i + 1} HTTP ${res.status} success=${body.success} error=${body.error || body.raw || 'unknown'}`);
      turns.push({
        turn: i + 1,
        message: turnDef.message,
        facts: extractStructuredFacts(body),
        failures: [`HTTP ${res.status}`],
      });
      break;
    }
    const out = reviewToOut(body);
    const facts = extractStructuredFacts(body);
    const turnFailures = checkTurnExpectations(turnDef.expect, out);
    failures.push(...turnFailures.map((f) => `turn ${i + 1}: ${f}`));
    turns.push({
      turn: i + 1,
      message: turnDef.message,
      facts,
      failures: turnFailures,
      forbidden: findInternalLanguage(facts.proposed_luna_reply),
    });
    guestContext = body.slim_guest_context_for_next_turn || guestContext;
  }

  if (fixture.final_expect && turns.length === fixture.turns.length) {
    const lastBody = { review: {
      proposed_luna_reply: turns[turns.length - 1].facts.proposed_luna_reply,
      result: { extracted_fields: {
        check_in: turns[turns.length - 1].facts.check_in,
        check_out: turns[turns.length - 1].facts.check_out,
        guest_count: turns[turns.length - 1].facts.guest_count,
        package_interest: turns[turns.length - 1].facts.package,
      } },
      quote: { quote_status: turns[turns.length - 1].facts.quote_status },
      payment_choice: { payment_choice: turns[turns.length - 1].facts.payment_choice },
    } };
    const lastOut = reviewToOut(lastBody);
    failures.push(...checkTurnExpectations(fixture.final_expect, lastOut).map((f) => `final: ${f}`));
  }

  failures.push(...proofDef.extraChecks(turns));

  return {
    id: proofDef.id,
    fixture: proofDef.fixture,
    phone,
    pass: failures.length === 0,
    failures,
    turns,
  };
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.STAFF_API_BASE_URL || DEFAULT_BASE_URL,
    deploy: false,
    skipDeploy: false,
    json: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--deploy') opts.deploy = true;
    else if (a === '--skip-deploy') opts.skipDeploy = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--base-url') opts.baseUrl = trimStr(argv[++i]).replace(/\/$/, '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: node scripts/run-stage35b-hosted-messy-flow-proof.js [--deploy] [--skip-deploy] [--json] [--base-url URL]');
    process.exit(0);
  }

  if (!TOKEN) {
    console.error('Warning: LUNA_BOT_INTERNAL_TOKEN not set — staging may reject bot auth.');
  }

  const report = {
    stage: '35b',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    base_url: opts.baseUrl,
    started_at: new Date().toISOString(),
    gates_before: null,
    gates_during: null,
    gates_after: null,
    deploy: null,
    healthz: null,
    revision: null,
    proofs: [],
    safety: {
      whatsapp_send: false,
      stripe_live: false,
      n8n_active: null,
      production: false,
      confirmation_allowlist: null,
    },
    overall: 'FAIL',
  };

  report.gates_before = fetchStaffApiGates();
  report.revision = activeRevision();
  report.healthz = await healthz(opts.baseUrl);

  if (!opts.skipDeploy) {
    const headOnCommit = String(tryAz('git rev-parse --short HEAD')).startsWith(COMMIT);
    const imageHasCommit = String(report.revision.image || '').includes(COMMIT);
    if (opts.deploy || (headOnCommit && !imageHasCommit)) {
      report.deploy = await deployIfNeeded(opts.deploy, opts.baseUrl);
      report.revision = report.deploy.revision || activeRevision();
      report.healthz = report.deploy.healthz || await healthz(opts.baseUrl);
    } else {
      report.deploy = { deployed: false, note: imageHasCommit ? 'already on commit' : 'skip deploy — HEAD not on commit' };
    }
  }

  report.gates_during = fetchStaffApiGates();
  const n8n = await fetchN8nWorkflowStatus();
  report.safety.n8n_active = n8n.workflow_active === true;
  if (report.gates_during.status === 'checked') {
    report.safety.confirmation_allowlist = report.gates_during.gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST;
  }

  for (const proofDef of PROOFS) {
    const result = await runProofFlow(proofDef, opts.baseUrl);
    report.proofs.push(result);
  }

  report.gates_after = fetchStaffApiGates();
  report.healthz_after = await healthz(opts.baseUrl);
  report.revision_after = activeRevision();
  report.ended_at = new Date().toISOString();

  const allPass = report.proofs.every((p) => p.pass)
    && report.healthz === '200'
    && report.safety.n8n_active !== true;
  report.overall = allPass ? 'PASS' : (report.proofs.some((p) => p.pass) ? 'PARTIAL' : 'FAIL');

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== Stage 35b hosted messy-flow proof ===\n');
    console.log(`Overall: ${report.overall}`);
    console.log(`Commit: ${COMMIT}`);
    console.log(`Image tag: ${IMAGE_TAG}`);
    console.log(`Revision: ${report.revision_after?.name || report.revision?.name}`);
    console.log(`healthz: ${report.healthz} (after: ${report.healthz_after})`);
    console.log(`Deployed: ${JSON.stringify(report.deploy)}`);
    for (const p of report.proofs) {
      console.log(`\n--- ${p.id} (${p.pass ? 'PASS' : 'FAIL'}) ---`);
      if (p.failures.length) console.log('Failures:', p.failures.join('; '));
      for (const t of p.turns) {
        console.log(`  Turn ${t.turn}: "${t.message}"`);
        console.log(`    reply: ${String(t.facts.proposed_luna_reply || '').slice(0, 140).replace(/\n/g, ' ')}`);
        console.log(`    facts: ${JSON.stringify(t.facts)}`);
      }
    }
  }

  process.exit(report.overall === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
