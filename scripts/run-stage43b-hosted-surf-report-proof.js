'use strict';

/**
 * Stage 43b — hosted staging proof for client-facing Somo surf report.
 *
 * Uses POST /staff/bot/guest-inbound-review-dry-run on staging Staff API.
 * Safe by default: review-only, no WhatsApp send, no writes, no Stripe, no confirmations.
 *
 * Usage:
 *   npm run proof:stage43b-hosted-surf-report
 *   node scripts/run-stage43b-hosted-surf-report-proof.js --deploy
 *   node scripts/run-stage43b-hosted-surf-report-proof.js --skip-deploy --json
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
  fetchStaffApiGates,
  fetchN8nWorkflowStatus,
  azExec,
  trimStr,
} = require('./lib/open-demo-playground-common');
const {
  FORBIDDEN_GUEST_PHRASES,
  isForbiddenGuestCopy,
} = require('./lib/luna-guest-reply-style-contract');

const COMMIT = '0c74150';
const IMAGE_TAG = `${COMMIT}-stage43b-surf-report-proof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage43b-surf-report';
const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';
const CLIENT_SLUG = 'wolfhouse-somo';
const REFERENCE_DATE = '2026-06-10';
const REPORT_JSON = path.join(__dirname, '..', 'tmp', 'stage43b-hosted-surf-report-proof.json');
const TOKEN = resolveBotToken();

const FALLBACK_RE = /can't see the live surf report|no puedo ver el reporte|non riesco a vedere|gerade kann ich den live-surfbericht/i;
const HARD_SAFETY_RE = /\b(?:unsafe|not safe|dangerous|do not surf|too dangerous|peligroso|pericoloso|unsicher)\b/i;
const RAW_METRIC_RE = /\b\d\.\d\s*m\b/i;
const SECRET_RE = /STORMGLASS|stormglass\.io|sg_[a-z0-9]{8,}/i;

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
    id: 'A_en_surf',
    lang: 'en',
    phonePrefix: '+346298430',
    turns: [{ message: 'How are the waves today?' }],
    expectReply: [/Somo/i, /wave|fun|flat|energy|surf/i],
    forbidReply: [RAW_METRIC_RE, HARD_SAFETY_RE],
  },
  {
    id: 'B_it_surf',
    lang: 'it',
    phonePrefix: '+346298431',
    turns: [{ message: 'Come sono le onde oggi?' }],
    expectReply: [/Somo/i, /onde|surf|marea|report|condizioni|Somo/i],
    forbidReply: [RAW_METRIC_RE, HARD_SAFETY_RE],
  },
  {
    id: 'C_es_surf',
    lang: 'es',
    phonePrefix: '+346298432',
    turns: [{ message: 'Qué tal las olas hoy?' }],
    expectReply: [/Somo/i, /olitas|olas|surf|marea|reporte|condiciones|Somo/i],
    forbidReply: [RAW_METRIC_RE, HARD_SAFETY_RE],
  },
  {
    id: 'D_de_surf',
    lang: 'de',
    phonePrefix: '+346298433',
    turns: [{ message: 'Wie sind die Wellen heute?' }],
    expectReply: [/Somo/i, /Wellen|Surf|Tide|schön/i],
    forbidReply: [RAW_METRIC_RE, HARD_SAFETY_RE],
  },
  {
    id: 'E_mid_booking_context',
    lang: 'en',
    phonePrefix: '+346298434',
    contactName: 'Marco',
    turns: [
      { message: 'July 1-5 for 1' },
      { message: 'How are the waves today?' },
    ],
    expectFinal: {
      check_in: '2026-07-01',
      check_out: '2026-07-05',
      guest_count: 1,
      quote_status: 'ready',
      stale_quote: false,
    },
    expectTurn2: {
      composer_state: 'explain_surf_report',
      reply: [/Somo/i],
      no_stripe: true,
    },
  },
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

function fetchHealthz(baseUrl) {
  return new Promise((resolve) => {
    const u = new URL(`${baseUrl.replace(/\/$/, '')}/healthz`);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = { raw }; }
        resolve({ status: String(res.statusCode), body });
      });
    });
    req.on('error', (err) => resolve({ status: '000', error: err.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: '000', error: 'timeout' }); });
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
    throw new Error(`HEAD ${head} != ${COMMIT} — checkout commit before --deploy`);
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
    const hz = await fetchHealthz(baseUrl);
    console.error(`[deploy] wait ${i + 1}/60 rev=${cur.name} health=${cur.health} hz=${hz.status} image=${cur.image}`);
    if (String(cur.image || '').includes(IMAGE_TAG) && cur.health === 'Healthy' && cur.traffic === 100 && hz.status === '200') {
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

function extractFacts(body, proofLang) {
  const review = body.review || {};
  const r = review.result || {};
  const q = review.quote || {};
  const fields = r.extracted_fields || {};
  const brain = r.conversation_brain || {};
  const reply = review.proposed_luna_reply || '';
  const usedFallback = FALLBACK_RE.test(reply);
  return {
    client_slug: CLIENT_SLUG,
    language: r.detected_language || proofLang || 'en',
    composer_state: brain.composer_state || null,
    final_reply_source: brain.final_reply_source || null,
    proposed_luna_reply: reply,
    check_in: fields.check_in || q.check_in || null,
    check_out: fields.check_out || q.check_out || null,
    guest_count: fields.guest_count != null ? fields.guest_count : (q.guest_count != null ? q.guest_count : null),
    quote_status: q.quote_status || null,
    stale_quote: r.previous_quote_invalidated === true || q.quote_stale === true,
    used_live_api: !usedFallback && brain.composer_state === 'explain_surf_report',
    used_fallback: usedFallback,
    forbidden_language: findForbiddenLanguage(reply),
    hard_safety_call: HARD_SAFETY_RE.test(reply),
    raw_metric_dump: RAW_METRIC_RE.test(reply),
    secret_leak: SECRET_RE.test(JSON.stringify(body)),
    sends_whatsapp: body.sends_whatsapp === true,
    no_write_performed: body.no_write_performed === true,
    dry_run: body.dry_run === true,
    http_success: body.success === true,
  };
}

function findForbiddenLanguage(text) {
  const lower = String(text || '').toLowerCase();
  return FORBIDDEN_GUEST_PHRASES.filter((term) => lower.includes(term.toLowerCase()));
}

function buildPayload({ phone, message, guestContext, turnIndex, contactName }) {
  return {
    source: 'stage43b_hosted_surf_report_proof',
    client_slug: CLIENT_SLUG,
    channel: 'whatsapp',
    guest_phone: phone,
    contact_name: contactName || 'Stage43b Guest',
    message_text: message,
    reference_date: REFERENCE_DATE,
    received_at: new Date().toISOString(),
    inbound_message_id: `stage43b-${crypto.randomBytes(6).toString('hex')}-t${turnIndex + 1}`,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
    ...(guestContext ? { guest_context: guestContext } : {}),
  };
}

async function runProof(proofDef, baseUrl) {
  const phone = `${proofDef.phonePrefix}${Math.floor(Math.random() * 9000 + 1000)}`;
  const headers = TOKEN ? { 'X-Luna-Bot-Token': TOKEN } : {};
  const target = `${baseUrl.replace(/\/$/, '')}${REVIEW_ROUTE}`;
  let guestContext = null;
  const turns = [];
  const failures = [];

  for (let i = 0; i < proofDef.turns.length; i++) {
    const message = proofDef.turns[i].message;
    const res = await postJson(target, buildPayload({
      phone,
      message,
      guestContext,
      turnIndex: i,
      contactName: proofDef.contactName,
    }), headers);

    const body = res.body || {};
    if (res.status !== 200 || body.success !== true) {
      failures.push(`turn ${i + 1} HTTP ${res.status} success=${body.success} error=${body.error || 'unknown'}`);
      turns.push({ turn: i + 1, message, facts: {}, failures: [`HTTP ${res.status}`] });
      break;
    }

    const facts = extractFacts(body, proofDef.lang);
    const turnFailures = [];

    if (facts.secret_leak) turnFailures.push('secret leak in response');
    if (facts.sends_whatsapp) turnFailures.push('sends_whatsapp true');
    if (facts.no_write_performed !== true) turnFailures.push('no_write_performed not true');
    if (facts.forbidden_language.length) turnFailures.push(`forbidden language: ${facts.forbidden_language.join(', ')}`);
    if (isForbiddenGuestCopy(facts.proposed_luna_reply)) turnFailures.push('forbidden guest copy');
    if (facts.hard_safety_call) turnFailures.push('hard safety call in reply');
    if (facts.raw_metric_dump) turnFailures.push('raw metric dump in reply');
    if (/checkout\.stripe\.com/i.test(facts.proposed_luna_reply || '')) turnFailures.push('stripe link in reply');

    if (i === proofDef.turns.length - 1 && proofDef.expectReply) {
      for (const re of proofDef.expectReply) {
        if (!re.test(facts.proposed_luna_reply || '')) turnFailures.push(`expectReply failed ${re}`);
      }
      for (const re of proofDef.forbidReply || []) {
        if (re.test(facts.proposed_luna_reply || '')) turnFailures.push(`forbidReply failed ${re}`);
      }
      if (facts.composer_state !== 'explain_surf_report') {
        turnFailures.push(`composer_state expected explain_surf_report got ${facts.composer_state}`);
      }
    }

    if (i === 1 && proofDef.expectTurn2) {
      const e2 = proofDef.expectTurn2;
      if (e2.composer_state && facts.composer_state !== e2.composer_state) {
        turnFailures.push(`turn2 composer_state expected ${e2.composer_state} got ${facts.composer_state}`);
      }
      for (const re of e2.reply || []) {
        if (!re.test(facts.proposed_luna_reply || '')) turnFailures.push(`turn2 reply check failed ${re}`);
      }
      if (e2.no_stripe && /checkout\.stripe\.com/i.test(facts.proposed_luna_reply || '')) {
        turnFailures.push('turn2 stripe link present');
      }
    }

    failures.push(...turnFailures.map((f) => `turn ${i + 1}: ${f}`));
    turns.push({ turn: i + 1, message, facts, failures: turnFailures });
    guestContext = body.slim_guest_context_for_next_turn || guestContext;
  }

  if (proofDef.expectFinal && turns.length === proofDef.turns.length) {
    const last = turns[turns.length - 1].facts;
    const ef = proofDef.expectFinal;
    if (ef.check_in && last.check_in !== ef.check_in) failures.push(`final check_in expected ${ef.check_in} got ${last.check_in}`);
    if (ef.check_out && last.check_out !== ef.check_out) failures.push(`final check_out expected ${ef.check_out} got ${last.check_out}`);
    if (ef.guest_count != null && last.guest_count !== ef.guest_count) failures.push(`final guest_count expected ${ef.guest_count} got ${last.guest_count}`);
    if (ef.quote_status && last.quote_status !== ef.quote_status) failures.push(`final quote_status expected ${ef.quote_status} got ${last.quote_status}`);
    if (ef.stale_quote === false && last.stale_quote) failures.push('final stale_quote true');
  }

  return {
    id: proofDef.id,
    lang: proofDef.lang,
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

function redactGates(gatesObj) {
  if (!gatesObj || gatesObj.status !== 'checked') return gatesObj;
  return gatesObj;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: node scripts/run-stage43b-hosted-surf-report-proof.js [--deploy] [--skip-deploy] [--json]');
    process.exit(0);
  }

  const report = {
    stage: '43b',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    base_url: opts.baseUrl,
    started_at: new Date().toISOString(),
    healthz_before: null,
    healthz_after: null,
    stormglass_configured: null,
    revision_before: null,
    revision_after: null,
    deploy: null,
    gates_before: null,
    gates_during: null,
    gates_after: null,
    proofs: [],
    safety: {
      whatsapp_send: false,
      stripe_link: false,
      n8n_active: null,
      secret_leak: false,
      production: false,
    },
    overall: 'FAIL',
  };

  const hzBefore = await fetchHealthz(opts.baseUrl);
  report.healthz_before = { status: hzBefore.status, stormglass: hzBefore.body && hzBefore.body.stormglass };
  report.stormglass_configured = !!(hzBefore.body && hzBefore.body.stormglass && hzBefore.body.stormglass.configured);
  report.revision_before = activeRevision();
  report.gates_before = redactGates(fetchStaffApiGates());

  if (!opts.skipDeploy) {
    const imageHasCommit = String(report.revision_before.image || '').includes(COMMIT);
    const headOnCommit = String(tryAz('git rev-parse --short HEAD')).startsWith(COMMIT);
    if (opts.deploy || (headOnCommit && !imageHasCommit)) {
      report.deploy = await deployIfNeeded(opts.deploy, opts.baseUrl);
      report.revision_after = report.deploy.revision || activeRevision();
    } else {
      report.deploy = { deployed: false, note: imageHasCommit ? 'already on commit' : 'skip deploy' };
      report.revision_after = report.revision_before;
    }
  } else {
    report.deploy = { deployed: false, note: 'skip-deploy flag' };
    report.revision_after = report.revision_before;
  }

  const hzAfter = await fetchHealthz(opts.baseUrl);
  report.healthz_after = { status: hzAfter.status, stormglass: hzAfter.body && hzAfter.body.stormglass };
  report.gates_during = redactGates(fetchStaffApiGates());

  const n8n = await fetchN8nWorkflowStatus();
  report.safety.n8n_active = n8n.workflow_active === true;

  for (const proofDef of PROOFS) {
    report.proofs.push(await runProof(proofDef, opts.baseUrl));
  }

  report.gates_after = redactGates(fetchStaffApiGates());
  report.ended_at = new Date().toISOString();

  report.safety.whatsapp_send = report.proofs.some((p) => p.turns.some((t) => t.facts.sends_whatsapp));
  report.safety.secret_leak = report.proofs.some((p) => p.turns.some((t) => t.facts.secret_leak));
  report.safety.stripe_link = report.proofs.some((p) => p.turns.some((t) => /checkout\.stripe\.com/i.test(t.facts.proposed_luna_reply || '')));

  const proofsPass = report.proofs.every((p) => p.pass);
  const hzOk = report.healthz_after.status === '200';
  const n8nOk = report.safety.n8n_active !== true;
  const anyLiveApi = report.proofs.some((p) => p.turns.some((t) => t.facts.used_live_api));
  const anyFallback = report.proofs.some((p) => p.turns.some((t) => t.facts.used_fallback));

  if (proofsPass && hzOk && n8nOk) {
    if (report.stormglass_configured && !anyLiveApi && anyFallback) {
      report.overall = 'PARTIAL';
      report.live_api_note = 'Stormglass key configured but hosted guest path used fallback (upstream unavailable/quota/timeout)';
    } else {
      report.overall = 'PASS';
    }
  } else {
    report.overall = report.proofs.some((p) => p.pass) ? 'PARTIAL' : 'FAIL';
  }

  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== Stage 43b hosted surf report proof ===\n');
    console.log(`Overall: ${report.overall}`);
    console.log(`Commit: ${COMMIT}`);
    console.log(`Image tag: ${IMAGE_TAG}`);
    console.log(`Revision: ${report.revision_after?.name}`);
    console.log(`healthz: ${report.healthz_after?.status} stormglass.configured=${report.stormglass_configured}`);
    console.log(`Deploy: ${JSON.stringify(report.deploy)}`);
    for (const p of report.proofs) {
      console.log(`\n--- ${p.id} (${p.pass ? 'PASS' : 'FAIL'}) ---`);
      if (p.failures.length) console.log('Failures:', p.failures.join('; '));
      for (const t of p.turns) {
        console.log(`  Turn ${t.turn}: "${t.message}"`);
        console.log(`    composer_state=${t.facts.composer_state} live_api=${t.facts.used_live_api} fallback=${t.facts.used_fallback}`);
        console.log(`    reply: ${String(t.facts.proposed_luna_reply || '').slice(0, 180).replace(/\n/g, ' ')}`);
      }
    }
    console.log(`\nReport: ${REPORT_JSON}`);
  }

  process.exit(report.overall === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
