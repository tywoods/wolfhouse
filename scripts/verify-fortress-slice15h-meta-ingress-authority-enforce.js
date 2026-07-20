'use strict';

/**
 * verify:fortress-slice15h-meta-ingress-authority-enforce — FORTRESS Slice 15H
 *
 * Offline RED/GREEN tests for Meta WhatsApp ingress authority policy (B02).
 * No network, no live DB/Stripe/WhatsApp/deploy. Does not rewrite tracked evidence.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15h-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15h-b02-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15h-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15h-evidence.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'attack-cases.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');
const RUNBOOK_PATH = path.join(ROOT, 'docs', 'MULTICLIENT-STAGING-ROUTING.md');

const {
  loadChannelRoutingConfig,
  buildChannelResolver,
  loadClientRegistry,
} = require('./lib/client-channel-resolver');
const {
  DEFAULT_CLIENT_SLUG,
  normalizeMetaWhatsAppWebhook,
  buildDraftInputFromNormalized,
  buildMetaWebhookSendBody,
  buildMetaInboundIdempotencyKey,
  resolveMetaWebhookSendKind,
  buildMetaWhatsAppWebhookPostResponse,
} = require('./lib/luna-meta-whatsapp-webhook');
const {
  processMetaWhatsAppWebhookInbound,
  processMetaWhatsAppWebhookPostEntry,
} = require('./lib/luna-meta-whatsapp-inbound-process');
const {
  AUTHORITY_ENV_KEY,
  isMetaWhatsAppIngressAuthorityEnabled,
  resolveMetaWhatsAppIngressAuthority,
  applyMetaWhatsAppIngressAuthority,
  shouldBlockMetaWhatsAppIngressDownstream,
  resolveReplayNormalizedIdentity,
  attachEffectiveNormalizedToError,
} = require('./lib/meta-whatsapp-ingress-authority');
const {
  buildInboundEventSeed,
  claimGuestMessageEventInboundByWaMessageId,
  WA_MESSAGE_ID_LOCK_NAMESPACE,
} = require('./lib/luna-guest-message-events-sql');
const { buildOpenDemoRequestBodyFromMeta } = require('./lib/meta-open-demo-inbound-adapter');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

/** Minimal eligible draft for real send-body builder proofs (no live draft LLM). */
function sampleEligibleDraft() {
  return {
    suggested_reply: 'Could you share your check-in date?',
    next_action: 'ask_missing_field',
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      allowed_send_kind: 'ask_missing_field',
    },
  };
}

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: passed });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: passed });
  return passed;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SAMPLE_CONFIG = loadChannelRoutingConfig();
const REGISTRY = loadClientRegistry();

function routingOpts(env) {
  return {
    env: env || {},
    allowSampleFallback: true,
    channelConfig: SAMPLE_CONFIG,
    registry: REGISTRY,
    resolver: buildChannelResolver(REGISTRY, SAMPLE_CONFIG),
  };
}

function buildFakeMetaWhatsAppBody(phoneNumberId, opts = {}) {
  const from = opts.from || '34600000001';
  const text = opts.text || 'Hola';
  const waMessageId = opts.wa_message_id || 'wamid.SAMPLE_15H_INBOUND';
  const metadata = {
    display_phone_number: '15550000000',
  };
  if (phoneNumberId !== undefined) {
    metadata.phone_number_id = phoneNumberId;
  }
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_SAMPLE_ENTRY_15G',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata,
          contacts: [{ profile: { name: 'Sample Guest' }, wa_id: from }],
          messages: [{
            from,
            id: waMessageId,
            timestamp: '1700000000',
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function makeCountingPg() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params: params || [] });
      throw new Error('15H zero-downstream: unexpected pg.query');
    },
  };
}

function makeEntryCounters() {
  return {
    pool: 0,
    inbound: 0,
    persist: 0,
    draft: 0,
    send: 0,
    owner: 0,
    demo: 0,
  };
}

function zeroDownstream(counters) {
  return counters.pool === 0
    && counters.inbound === 0
    && counters.persist === 0
    && counters.draft === 0
    && counters.send === 0
    && counters.owner === 0
    && counters.demo === 0;
}

function cloneEventRow(row) {
  if (!row) return null;
  return {
    ...row,
    normalized: row.normalized ? JSON.parse(JSON.stringify(row.normalized)) : null,
    raw_payload: row.raw_payload ? JSON.parse(JSON.stringify(row.raw_payload)) : null,
    send_blocked_reasons: Array.isArray(row.send_blocked_reasons)
      ? [...row.send_blocked_reasons]
      : [],
  };
}

/**
 * In-memory PG harness for real processInbound / PostEntry paths.
 * Tracks side effects; never opens a network or live DB connection.
 * Unexpected owner/demo/persistence SQL fails closed (no generic success).
 */
function makeHarnessPg(options = {}) {
  const events = Array.isArray(options.events) ? options.events.map(cloneEventRow) : [];
  const staffRows = Array.isArray(options.staff) ? options.staff.slice() : [];
  const tableMissing = options.tableMissing === true;
  const throwOnQuery = options.throwOnQuery || null;
  let idSeq = options.idSeq || 1000;
  const lockWaiters = new Map(); // key -> Promise chain tail
  const heldLocks = new Map(); // key -> hold count
  const effects = {
    queries: [],
    candidate_selects: 0,
    inserts: 0,
    updates: 0,
    staff_lookups: 0,
    send_lookups: 0,
    advisory_locks: 0,
    advisory_unlocks: 0,
  };

  function missingTableError() {
    const err = new Error('relation "guest_message_events" does not exist');
    err.code = '42P01';
    return err;
  }

  function lockKey(params) {
    return `${params[0]}::${params[1]}`;
  }

  async function acquireAdvisory(params) {
    const key = lockKey(params);
    effects.advisory_locks += 1;
    const prev = lockWaiters.get(key) || Promise.resolve();
    let releaseCurrent;
    const gate = new Promise((resolve) => { releaseCurrent = resolve; });
    const next = prev.then(() => gate);
    lockWaiters.set(key, next.then(() => {}, () => {}));
    await prev;
    heldLocks.set(key, (heldLocks.get(key) || 0) + 1);
    return () => {
      heldLocks.set(key, Math.max(0, (heldLocks.get(key) || 1) - 1));
      releaseCurrent();
    };
  }

  const releaseByKey = new Map();

  async function query(sql, params) {
    const s = String(sql);
    const p = params || [];
    effects.queries.push({ sql: s, params: p });

    if (typeof throwOnQuery === 'function') {
      const forced = throwOnQuery(s, p, effects);
      if (forced) throw forced;
    }

    if (/pg_advisory_lock\s*\(/i.test(s) && !/unlock/i.test(s)) {
      const release = await acquireAdvisory(p);
      releaseByKey.set(lockKey(p), release);
      return { rows: [{ pg_advisory_lock: true }] };
    }
    if (/pg_advisory_unlock\s*\(/i.test(s)) {
      effects.advisory_unlocks += 1;
      const key = lockKey(p);
      const release = releaseByKey.get(key);
      if (release) {
        releaseByKey.delete(key);
        release();
      }
      return { rows: [{ pg_advisory_unlock: true }] };
    }

    if (tableMissing && /guest_message_events/.test(s)) {
      throw missingTableError();
    }

    // Candidate find by wa_message_id only (no trusted tenant predicate).
    if (
      /FROM\s+guest_message_events/i.test(s)
      && /WHERE\s+wa_message_id\s*=\s*\$1/i.test(s)
      && !/client_slug\s*=/i.test(s)
      && /^\s*SELECT/i.test(s)
      && !/\bUPDATE\b/i.test(s)
      && !/\bINSERT\b/i.test(s)
    ) {
      effects.candidate_selects += 1;
      const wamid = p[0];
      return {
        rows: events
          .filter((e) => e.wa_message_id === wamid)
          .map(cloneEventRow),
      };
    }

    // Tenant-scoped find (legacy helper / insert conflict fallback).
    if (
      /FROM\s+guest_message_events/i.test(s)
      && /client_slug\s*=\s*\$1/i.test(s)
      && /wa_message_id\s*=\s*\$2/i.test(s)
      && /^\s*SELECT/i.test(s)
      && !/\bUPDATE\b/i.test(s)
    ) {
      const slug = p[0];
      const wamid = p[1];
      const hit = events.find((e) => e.client_slug === slug && e.wa_message_id === wamid);
      return { rows: hit ? [cloneEventRow(hit)] : [] };
    }

    if (/\bINSERT\s+INTO\s+guest_message_events\b/i.test(s)) {
      effects.inserts += 1;
      const slug = p[0];
      const wamid = p[5];
      // Cross-slug uniqueness is enforced by advisory claim, not schema.
      // Same-slug still honors ON CONFLICT (client_slug, wa_message_id).
      const existingSameSlug = events.find((e) => e.client_slug === slug && e.wa_message_id === wamid);
      if (existingSameSlug) {
        return { rows: [] }; // ON CONFLICT DO NOTHING
      }
      const row = {
        id: String(++idSeq),
        client_slug: slug,
        channel: p[1] || 'whatsapp',
        direction: p[2] || 'inbound',
        from_phone: p[3],
        to_phone_number_id: p[4],
        wa_message_id: wamid,
        message_type: p[6],
        message_text: p[7],
        profile_name: p[8],
        raw_payload: p[9] ? JSON.parse(p[9]) : null,
        normalized: p[10] ? JSON.parse(p[10]) : null,
        draft_called: false,
        next_action: null,
        suggested_reply: null,
        handoff_required: false,
        send_attempted: false,
        send_idempotency_key: null,
        send_status: null,
        send_blocked_reasons: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      events.push(row);
      return { rows: [cloneEventRow(row)] };
    }

    if (/\bUPDATE\s+guest_message_events\b/i.test(s)) {
      effects.updates += 1;
      const slug = p[0];
      const wamid = p[1];
      const row = events.find((e) => e.client_slug === slug && e.wa_message_id === wamid);
      if (!row) return { rows: [] };
      if (/SET\s+normalized\s*=\s*\$3/i.test(s)) {
        row.normalized = p[2] ? JSON.parse(p[2]) : null;
        row.updated_at = new Date().toISOString();
        return { rows: [cloneEventRow(row)] };
      }
      // decision patch update
      row.draft_called = p[2] === true;
      row.next_action = p[3];
      row.suggested_reply = p[4];
      row.handoff_required = p[5] === true;
      row.send_attempted = p[6] === true;
      row.send_idempotency_key = p[7];
      row.send_status = p[8];
      row.send_blocked_reasons = p[9] ? JSON.parse(p[9]) : [];
      row.updated_at = new Date().toISOString();
      return { rows: [cloneEventRow(row)] };
    }

    if (/FROM\s+staff_phone_access/i.test(s)) {
      effects.staff_lookups += 1;
      const slug = p[0];
      const phoneNorm = p[1];
      const channel = p[2] || 'whatsapp';
      const hit = staffRows.find((r) => (
        r.client_slug === slug
        && r.phone_normalized === phoneNorm
        && (r.channel || 'whatsapp') === channel
      ));
      return { rows: hit ? [hit] : [] };
    }

    // Send-route / pause lookups (proves evaluateGuestReplySendRouteWithPause ran).
    if (
      /guest_message_sends/i.test(s)
      || /bot_pause|conversation_pause|FROM\s+pause/i.test(s)
      || /staff_bot_pause/i.test(s)
    ) {
      effects.send_lookups += 1;
      return { rows: [] };
    }

    // Owner Command Center / Ask Luna readonly probes — empty result, never generic success
    // for unknown write/DDL shapes.
    if (
      /SELECT/i.test(s)
      && !/INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE/i.test(s)
      && (
        /FROM\s+bookings\b/i.test(s)
        || /FROM\s+guests\b/i.test(s)
        || /FROM\s+payments\b/i.test(s)
        || /FROM\s+clients\b/i.test(s)
        || /FROM\s+rooms\b/i.test(s)
        || /FROM\s+beds\b/i.test(s)
        || /information_schema/i.test(s)
        || /pg_catalog/i.test(s)
        || /current_setting/i.test(s)
      )
    ) {
      return { rows: [] };
    }

    throw new Error(`15H harness: unexpected SQL (fail-closed): ${s.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  return {
    query,
    effects,
    events,
    staffRows,
    heldLocks,
  };
}

async function runBlockedEntry(normalizedOrBody, opts = {}) {
  const counters = makeEntryCounters();
  const env = opts.env || { [AUTHORITY_ENV_KEY]: '1' };
  const entryInput = {
    env,
    signatureMeta: { verified: false, skipped: true },
    normalizeOptions: opts.normalizeOptions || routingOpts(env),
    withPgClient: async (fn) => {
      counters.pool += 1;
      return fn(makeCountingPg());
    },
    processInbound: async () => {
      counters.inbound += 1;
      counters.persist += 1;
      counters.draft += 1;
      counters.send += 1;
      counters.owner += 1;
      counters.demo += 1;
      throw new Error('15H entry: processInbound must not run when blocked');
    },
  };
  if (opts.normalized) {
    entryInput.normalized = opts.normalized;
  } else {
    entryInput.body = normalizedOrBody;
  }
  const result = await processMetaWhatsAppWebhookPostEntry(entryInput);
  return { result, counters };
}

/**
 * HTTP-shaped PostEntry runner mirroring handleMetaWhatsAppWebhookPost:
 * PostEntry → withPgClient → real processInbound; audit on success/error.
 */
async function runHttpWithPgHarness(opts = {}) {
  const env = opts.env || {};
  const body = opts.body;
  const audit = [];
  const started = Date.now();
  const harness = opts.harness || makeHarnessPg(opts.pg || {});
  let poolAcquisitions = 0;

  const withPgClient = async (fn) => {
    poolAcquisitions += 1;
    return fn(harness);
  };

  let processed;
  try {
    processed = await processMetaWhatsAppWebhookPostEntry({
      body,
      env,
      signatureMeta: opts.signatureMeta || { verified: false, skipped: true },
      normalizeOptions: opts.normalizeOptions || routingOpts(env),
      withPgClient,
      executeOpenDemo: opts.executeOpenDemo,
    });
  } catch (err) {
    const effective = err && err.effective_normalized ? err.effective_normalized : null;
    audit.push({
      intent: 'webhook:meta_whatsapp:downstream_error',
      client_slug: effective ? effective.client_slug : null,
      location_id: effective && effective.location_id ? effective.location_id : null,
      phone_number_id: effective ? effective.phone_number_id : null,
      wa_message_id: effective ? effective.wa_message_id : null,
      error: err && err.message ? err.message : String(err),
      acquired_pg: poolAcquisitions > 0,
    });
    return {
      status: 500,
      response: {
        success: false,
        error: err && err.message ? err.message : 'meta_whatsapp_inbound_failed',
        normalized: effective,
        preview_only: true,
        no_write_performed: true,
        elapsed_ms: Date.now() - started,
      },
      processed: null,
      error: err,
      audit,
      harness,
      poolAcquisitions,
    };
  }

  const normalized = processed.normalized;
  const response = processed.response;
  audit.push({
    intent: 'webhook:meta_whatsapp:received',
    client_slug: normalized.client_slug,
    location_id: normalized.location_id || null,
    phone_number_id: normalized.phone_number_id,
    wa_message_id: normalized.wa_message_id,
    draft_called: response.draft_called === true,
    send_attempted: response.send_attempted === true,
    idempotency_key: response.idempotency_key || null,
    duplicate: response.duplicate === true,
    idempotent_replay: response.idempotent_replay === true,
    guest_message_event_id: response.guest_message_event_id || null,
    acquired_pg: processed.acquired_pg === true,
  });

  return {
    status: 200,
    response: { ...response, elapsed_ms: Date.now() - started },
    processed,
    audit,
    harness,
    poolAcquisitions,
  };
}

function softOpenDemoExecute(_pg, executeBody) {
  return {
    reviewOutcome: {
      ok: true,
      body: {
        review: {
          proposed_luna_reply: 'Open demo reply under authoritative tenant.',
          proposed_next_action: 'ask_missing_field',
          result: {
            package_code: null,
            conversation_brain: { final_reply_source: 'harness' },
          },
          payment_choice: {},
        },
      },
    },
    bookingWrite: { write_status: null },
    bedAssignment: {},
    liveReply: {
      live_reply_attempted: false,
      whatsapp_sent: false,
      send_performed: false,
      live_send_blocked: true,
    },
    typingIndicator: {},
    effectiveFlags: {},
    open_demo_request_client_slug: executeBody && executeBody.client_slug,
    open_demo_request_location_id: executeBody && executeBody.location_id,
  };
}

console.log('verify:fortress-slice15h-meta-ingress-authority-enforce — FORTRESS Slice 15H\n');

console.log('── Artifacts ──');
const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = fs.readFileSync(FINDINGS_PATH, 'utf8');
const matrix = readJson(MATRIX_PATH);
const attacks = readJson(ATTACK_PATH);
const doc = fs.readFileSync(DOC_PATH, 'utf8');
const runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');
const committedEvidence = readJson(EVIDENCE_PATH);
const policySrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'meta-whatsapp-ingress-authority.js'),
  'utf8',
);
const webhookSrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'luna-meta-whatsapp-webhook.js'),
  'utf8',
);
const inboundSrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  'utf8',
);
const staffApi = fs.readFileSync(
  path.join(ROOT, 'scripts', 'staff-query-api.js'),
  'utf8',
);

ok('contract slice 15H + B02',
  contract.slice === 'FORTRESS-15H'
  && contract.boundary_id === 'B02_meta_normalize_live_client_slug'
  && contract.outcome_id === '15H_meta_ingress_authority_enforce_before_pg'
  && contract.live_mutation === false
  && contract.master_basis === '9a09f479f1a65fec45557cf2c94c5e9628b902dc'
  && contract.activation.default === 'off'
  && contract.activation.deployment_config_edited === false);
ok('overlay remediated B02 historical untouched',
  overlay.boundary_id === 'B02_meta_normalize_live_client_slug'
  && overlay.status === 'remediated_source_default_off'
  && overlay.historical_audit_unchanged === true
  && overlay.live_mutation === false
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json')
  && overlay.preserves_deferred_15g === true);
ok('findings cite B02 + default-off + activation gap + replay/error rules',
  /B02/.test(findings)
  && /default-off/i.test(findings)
  && /Activation gap/i.test(findings)
  && /META_WHATSAPP_INGRESS_AUTHORITY/.test(findings)
  && /REPLAY_IDENTITY_COMPARE_REJECT_FILL/.test(findings)
  && /ERROR_IDENTITY_STRUCTURED_EFFECTIVE_NORMALIZED/.test(findings)
  && /tenant-wide/i.test(findings));
ok('findings have no trailing whitespace', (() => {
  const lines = findings.split('\n');
  return lines.every((line) => line === line.replace(/\s+$/g, '') || line === '');
})());
ok('historical matrix still marks B02 vulnerable',
  (matrix.boundaries || []).some((b) => b.id === 'B02_meta_normalize_live_client_slug' && b.verdict === 'vulnerable'));
ok('historical attack cases retained for B02',
  (attacks.cases || []).some((c) => c.id === 'AC_WA_UNKNOWN_PHONE_NO_HARDBLOCK' && c.color === 'RED'));
ok('historical doc still cites B02 vulnerable',
  /B02/.test(doc) && /vulnerable/.test(doc));
ok('policy module has no hardcoded tenant slug literals',
  !/wolfhouse-somo/.test(policySrc)
  && !/'sunset'/.test(policySrc)
  && !/"sunset"/.test(policySrc)
  && !/'wolfhouse'/.test(policySrc));
ok('webhook + inbound wire authority module + replay/error helpers',
  /meta-whatsapp-ingress-authority/.test(webhookSrc)
  && /applyMetaWhatsAppIngressAuthority/.test(webhookSrc)
  && /shouldBlockMetaWhatsAppIngressDownstream/.test(inboundSrc)
  && /buildIngressAuthorityBlockedMetaResponse/.test(inboundSrc)
  && /processMetaWhatsAppWebhookPostEntry/.test(inboundSrc)
  && /resolveReplayNormalizedIdentity/.test(inboundSrc)
  && /attachEffectiveNormalizedToError/.test(inboundSrc)
  && /claimGuestMessageEventInboundByWaMessageId/.test(inboundSrc)
  && /pg_advisory_lock/.test(
    fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-guest-message-events-sql.js'), 'utf8'),
  )
  && /resolveReplayNormalizedIdentity/.test(policySrc));
ok('staff Meta POST uses entry before withPgClient + structured error audit', (() => {
  const idx = staffApi.indexOf('async function handleMetaWhatsAppWebhookPost');
  if (idx < 0) return false;
  const block = staffApi.slice(idx, idx + 3500);
  return /processMetaWhatsAppWebhookPostEntry/.test(block)
    && /FORTRESS 15H/.test(block)
    && /effective_normalized/.test(block)
    && !/await withPgClient\(\s*\(?\s*pg\s*\)?\s*=>\s*processMetaWhatsAppWebhookInbound/.test(block);
})());
ok('deferred 15G tip not an ancestor of this branch', (() => {
  const { execSync } = require('child_process');
  try {
    execSync('git merge-base --is-ancestor 50f87a1f115ef9ba0c06dc91cd3dfab59c3f7b2b HEAD', {
      cwd: ROOT,
      stdio: 'pipe',
    });
    return false;
  } catch (_) {
    return true;
  }
})());
ok('runbook documents 15H policy default-off + activation gap',
  /FORTRESS 15H|FORTRESS Slice 15H/.test(runbook)
  && /META_WHATSAPP_INGRESS_AUTHORITY/.test(runbook)
  && /default-off|default off/i.test(runbook));
ok('default authority disabled',
  isMetaWhatsAppIngressAuthorityEnabled({}) === false
  && isMetaWhatsAppIngressAuthorityEnabled({ [AUTHORITY_ENV_KEY]: '' }) === false
  && isMetaWhatsAppIngressAuthorityEnabled({ [AUTHORITY_ENV_KEY]: '0' }) === false
  && isMetaWhatsAppIngressAuthorityEnabled({ [AUTHORITY_ENV_KEY]: '1' }) === true);

console.log('\n── Policy RED/GREEN ──');

red('disabled_shadow_only_preserved', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, routingOpts({}));
  const shadow = normalized.tenant_channel_shadow;
  return normalized.client_slug === DEFAULT_CLIENT_SLUG
    && normalized.location_id == null
    && normalized.ingress_authority == null
    && shadow
    && shadow.client_slug === 'sunset'
    && shadow.location_id === 'sunset-somo'
    && shadow.channel_resolution_blocked === false
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === false;
})());

red('unknown_phone_blocked', (() => {
  const body = buildFakeMetaWhatsAppBody('UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const ia = normalized.ingress_authority;
  return ia
    && ia.enabled === true
    && ia.active === true
    && ia.blocked === true
    && ia.invoke_downstream === false
    && ia.reason === 'unknown_channel_identity'
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === true
    && normalized.client_slug === DEFAULT_CLIENT_SLUG;
})());

red('missing_phone_blocked', (() => {
  const body = buildFakeMetaWhatsAppBody(undefined);
  // Force missing metadata phone_number_id
  body.entry[0].changes[0].value.metadata = { display_phone_number: '15550000000' };
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: 'true' }),
  );
  return normalized.ingress_authority
    && normalized.ingress_authority.blocked === true
    && normalized.ingress_authority.reason === 'missing_phone_number_id'
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === true;
})());

red('ambiguous_identity_blocked', (() => {
  const decision = resolveMetaWhatsAppIngressAuthority({
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      channel_resolution_blocked: false,
      channel_resolution_reason: null,
      client_slug: 'sunset',
      location_id: null,
      phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    },
  }, { env: { [AUTHORITY_ENV_KEY]: '1' } });
  return decision.ok === false
    && decision.blocked === true
    && decision.invoke_downstream === false
    && decision.reason === 'ambiguous_channel_identity';
})());

red('conflicting_identity_blocked', (() => {
  const decision = resolveMetaWhatsAppIngressAuthority({
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      channel_resolution_blocked: false,
      channel_resolution_reason: 'stale_conflict_marker',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    },
  }, { env: { [AUTHORITY_ENV_KEY]: '1' }, registry: REGISTRY });
  const registryConflict = resolveMetaWhatsAppIngressAuthority({
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'PNID_BAD_OWNERSHIP',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      channel_resolution_blocked: false,
      channel_resolution_reason: null,
      client_slug: 'sunset',
      location_id: 'wolfhouse-somo',
      phone_number_id: 'PNID_BAD_OWNERSHIP',
    },
  }, { env: { [AUTHORITY_ENV_KEY]: '1' }, registry: REGISTRY });
  return decision.reason === 'conflicting_channel_identity'
    && decision.blocked === true
    && registryConflict.reason === 'conflicting_channel_identity'
    && registryConflict.blocked === true;
})());

green('enabled_known_authoritative', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const ia = normalized.ingress_authority;
  return normalized.client_slug === 'sunset'
    && normalized.location_id === 'sunset-somo'
    && ia
    && ia.active === true
    && ia.blocked === false
    && ia.reason === 'phone_number_id_authoritative'
    && ia.invoke_downstream === true
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === false;
})());

green('legacy_slug_conflict_resolver_wins', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, {
    ...routingOpts({ [AUTHORITY_ENV_KEY]: 'on' }),
    client_slug: DEFAULT_CLIENT_SLUG,
  });
  return normalized.client_slug === 'sunset'
    && normalized.location_id === 'sunset-somo'
    && normalized.ingress_authority.legacy_client_slug === DEFAULT_CLIENT_SLUG
    && normalized.ingress_authority.legacy_slug_conflict === true
    && normalized.ingress_authority.reason === 'phone_number_id_authoritative';
})());

green('enabled_routing_absent_inactive', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, {
    env: { [AUTHORITY_ENV_KEY]: '1' },
  });
  const off = normalizeMetaWhatsAppWebhook(body, { env: {} });
  // Byte/shape-compatible with default shadow: no ingress_authority metadata.
  return normalized.client_slug === DEFAULT_CLIENT_SLUG
    && normalized.location_id == null
    && normalized.ingress_authority == null
    && off.ingress_authority == null
    && JSON.stringify({
      client_slug: normalized.client_slug,
      location_id: normalized.location_id,
      ingress_authority: normalized.ingress_authority || null,
    }) === JSON.stringify({
      client_slug: off.client_slug,
      location_id: off.location_id,
      ingress_authority: off.ingress_authority || null,
    })
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === false;
})());

green('default_off_no_env', (() => {
  const base = {
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'x',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  };
  const applied = applyMetaWhatsAppIngressAuthority(base, { env: {} });
  return isMetaWhatsAppIngressAuthorityEnabled(undefined) === false
    && applied === base
    && applied.client_slug === DEFAULT_CLIENT_SLUG
    && applied.ingress_authority == null;
})());

green('real_builders_propagate_location_and_idempotency', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_BUILDERS',
  });
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const draft = sampleEligibleDraft();
  const sendKind = resolveMetaWebhookSendKind(draft.next_action);
  const draftInput = buildDraftInputFromNormalized(normalized);
  const sendBody = buildMetaWebhookSendBody(normalized, draft, sendKind);
  const seed = buildInboundEventSeed(normalized, body);
  const expectedKey = 'luna:sunset:sunset-somo:wamid.SAMPLE_15H_BUILDERS:ask_missing_field';
  const response = buildMetaWhatsAppWebhookPostResponse(normalized, { verified: false, skipped: true }, {
    draft,
    draft_called: true,
    send_attempted: true,
    send_result: {
      send_performed: false,
      no_write_performed: true,
      blocked_reasons: ['luna_auto_send_not_enabled'],
    },
    idempotency_key: sendBody.idempotency_key,
    event_persisted: true,
  });
  return normalized.client_slug === 'sunset'
    && normalized.location_id === 'sunset-somo'
    && draftInput
    && draftInput.client_slug === 'sunset'
    && draftInput.location_id === 'sunset-somo'
    && sendBody.client_slug === 'sunset'
    && sendBody.location_id === 'sunset-somo'
    && sendBody.idempotency_key === expectedKey
    && buildMetaInboundIdempotencyKey(
      normalized.client_slug,
      normalized.wa_message_id,
      sendKind,
      normalized.location_id,
    ) === expectedKey
    && seed.client_slug === 'sunset'
    && seed.normalized.location_id === 'sunset-somo'
    && seed.normalized.client_slug === 'sunset'
    && response.normalized.client_slug === 'sunset'
    && response.normalized.location_id === 'sunset-somo'
    && response.idempotency_key === expectedKey
    && response.event_persisted === true;
})());

green('legacy_idempotency_key_unchanged_without_location', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_LEGACY_KEY',
  });
  const normalized = normalizeMetaWhatsAppWebhook(body, routingOpts({}));
  const draft = sampleEligibleDraft();
  const sendKind = resolveMetaWebhookSendKind(draft.next_action);
  const draftInput = buildDraftInputFromNormalized(normalized);
  const sendBody = buildMetaWebhookSendBody(normalized, draft, sendKind);
  const legacyKey = `luna:${DEFAULT_CLIENT_SLUG}:wamid.SAMPLE_15H_LEGACY_KEY:ask_missing_field`;
  return normalized.location_id == null
    && draftInput
    && draftInput.client_slug === DEFAULT_CLIENT_SLUG
    && !Object.prototype.hasOwnProperty.call(draftInput, 'location_id')
    && sendBody.client_slug === DEFAULT_CLIENT_SLUG
    && !Object.prototype.hasOwnProperty.call(sendBody, 'location_id')
    && sendBody.idempotency_key === legacyKey
    && buildMetaInboundIdempotencyKey(
      DEFAULT_CLIENT_SLUG,
      'wamid.SAMPLE_15H_LEGACY_KEY',
      'ask_missing_field',
    ) === legacyKey
    && buildMetaInboundIdempotencyKey(
      DEFAULT_CLIENT_SLUG,
      'wamid.SAMPLE_15H_LEGACY_KEY',
      'ask_missing_field',
      null,
    ) === legacyKey
    && buildMetaInboundIdempotencyKey(
      DEFAULT_CLIENT_SLUG,
      'wamid.SAMPLE_15H_LEGACY_KEY',
      'ask_missing_field',
      '',
    ) === legacyKey;
})());

console.log('\n── Zero downstream on block + real HTTP/withPgClient harness ──');

async function runEntryAndZeroDownstream() {
  const body = buildFakeMetaWhatsAppBody('UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_BLOCK',
  });
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const pg = makeCountingPg();
  const processed = await processMetaWhatsAppWebhookInbound({
    pg,
    env: { [AUTHORITY_ENV_KEY]: '1' },
    body,
    normalized,
    signatureMeta: { verified: false, skipped: true },
  });
  red('unknown_zero_downstream_calls',
    pg.queries.length === 0
    && processed.response.ingress_authority_blocked === true
    && processed.response.draft_called === false
    && processed.response.send_attempted === false
    && processed.response.event_persisted === false
    && processed.response.no_write_performed === true
    && processed.event_row == null
    && processed.replay === false);

  const unknownEntry = await runBlockedEntry(body);
  red('entry_unknown_zero_pool',
    unknownEntry.result.acquired_pg === false
    && zeroDownstream(unknownEntry.counters)
    && unknownEntry.result.response.ingress_authority_blocked === true
    && unknownEntry.result.normalized.ingress_authority.reason === 'unknown_channel_identity');

  const missingBody = buildFakeMetaWhatsAppBody(undefined, {
    wa_message_id: 'wamid.SAMPLE_15H_MISSING',
  });
  missingBody.entry[0].changes[0].value.metadata = { display_phone_number: '15550000000' };
  const missingEntry = await runBlockedEntry(missingBody);
  red('entry_missing_zero_pool',
    missingEntry.result.acquired_pg === false
    && zeroDownstream(missingEntry.counters)
    && missingEntry.result.response.ingress_authority_blocked === true);

  {
    const conflictNormalized = applyMetaWhatsAppIngressAuthority({
      client_slug: DEFAULT_CLIENT_SLUG,
      phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
      wa_message_id: 'wamid.SAMPLE_15H_CONFLICT',
      from: '34600000001',
      tenant_channel_shadow: {
        routing_config_enabled: true,
        channel_resolution_blocked: false,
        channel_resolution_reason: 'stale_conflict_marker',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
      },
    }, { env: { [AUTHORITY_ENV_KEY]: '1' }, registry: REGISTRY });
    const conflictEntry = await runBlockedEntry(null, { normalized: conflictNormalized });
    red('entry_conflicting_zero_pool',
      conflictNormalized.ingress_authority
      && conflictNormalized.ingress_authority.reason === 'conflicting_channel_identity'
      && conflictEntry.result.acquired_pg === false
      && zeroDownstream(conflictEntry.counters)
      && conflictEntry.result.response.ingress_authority_blocked === true);
  }

  // ── Real-path guest persist/draft/send via HTTP/withPgClient ──
  const guestHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_KNOWN',
      text: 'Hola, quiero reservar',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
  });
  const expectedKnownKeyPrefix = 'luna:sunset:sunset-somo:wamid.SAMPLE_15H_KNOWN:';
  green('entry_enabled_known_reaches_downstream',
    guestHttp.status === 200
    && guestHttp.processed.acquired_pg === true
    && guestHttp.poolAcquisitions === 1
    && guestHttp.harness.effects.candidate_selects >= 1
    && guestHttp.harness.effects.inserts === 1
    && guestHttp.processed.normalized.client_slug === 'sunset'
    && guestHttp.processed.normalized.location_id === 'sunset-somo'
    && guestHttp.response.normalized.client_slug === 'sunset'
    && guestHttp.response.normalized.location_id === 'sunset-somo'
    && guestHttp.response.draft_called === true
    && guestHttp.response.event_persisted === true
    && guestHttp.audit[0]
    && guestHttp.audit[0].client_slug === 'sunset'
    && guestHttp.audit[0].location_id === 'sunset-somo'
    && guestHttp.audit[0].acquired_pg === true
    && String(guestHttp.response.idempotency_key || '').startsWith(expectedKnownKeyPrefix) === (
      guestHttp.response.send_attempted === true
    ));

  // Preserve default-off + enabled-without-routing: entry still acquires pg;
  // enabled-without-routing must not add ingress_authority.
  const offHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_OFF',
      text: 'Hola',
    }),
    env: {},
  });
  green('entry_default_off_acquires_pg',
    offHttp.processed.acquired_pg === true
    && offHttp.poolAcquisitions === 1
    && offHttp.processed.normalized.ingress_authority == null
    && offHttp.processed.normalized.client_slug === DEFAULT_CLIENT_SLUG
    && offHttp.processed.normalized.location_id == null
    && shouldBlockMetaWhatsAppIngressDownstream(offHttp.processed.normalized) === false);

  const absentHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_ABSENT',
      text: 'Hola',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    normalizeOptions: { env: { [AUTHORITY_ENV_KEY]: '1' } },
  });
  green('entry_enabled_routing_absent_acquires_pg',
    absentHttp.processed.acquired_pg === true
    && absentHttp.poolAcquisitions === 1
    && absentHttp.processed.normalized.ingress_authority == null
    && absentHttp.processed.normalized.client_slug === DEFAULT_CLIENT_SLUG
    && absentHttp.processed.normalized.location_id == null
    && shouldBlockMetaWhatsAppIngressDownstream(absentHttp.processed.normalized) === false);

  // ── Real-path replay: historical slug conflict reachable + no duplicate ──
  const conflictHarness = makeHarnessPg({
    events: [{
      id: 'evt-legacy-1',
      client_slug: 'wolfhouse-somo',
      wa_message_id: 'wamid.SAMPLE_15H_REPLAY_CONFLICT',
      channel: 'whatsapp',
      direction: 'inbound',
      from_phone: '34600000001',
      to_phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
      message_type: 'text',
      message_text: 'Hola',
      profile_name: 'Sample Guest',
      raw_payload: null,
      normalized: {
        client_slug: 'wolfhouse-somo',
        wa_message_id: 'wamid.SAMPLE_15H_REPLAY_CONFLICT',
        supported: true,
        message_text: 'Hola',
      },
      draft_called: true,
      next_action: 'ask_missing_field',
      suggested_reply: 'legacy reply',
      handoff_required: false,
      send_attempted: false,
      send_idempotency_key: null,
      send_status: null,
      send_blocked_reasons: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }],
  });
  const conflictReplayHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_REPLAY_CONFLICT',
      text: 'Hola',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    harness: conflictHarness,
  });
  red('replay_rejects_client_slug_conflict',
    conflictReplayHttp.status === 200
    && conflictReplayHttp.response.replay_identity_rejected === true
    && (conflictReplayHttp.response.blocked_reasons || []).includes('replay_client_slug_conflict')
    && conflictReplayHttp.response.idempotent_replay === false
    && conflictReplayHttp.response.draft_called === false
    && conflictReplayHttp.response.send_attempted === false
    && conflictReplayHttp.response.guest_message_event_id == null
    && conflictReplayHttp.processed.event_row == null
    && conflictReplayHttp.response.replay_identity
    && conflictReplayHttp.response.replay_identity.reason === 'replay_client_slug_conflict'
    && conflictReplayHttp.response.replay_identity.stored_client_slug === 'wolfhouse-somo'
    && conflictReplayHttp.response.replay_identity.authoritative_client_slug === 'sunset'
    && !Object.prototype.hasOwnProperty.call(conflictReplayHttp.response, 'suggested_reply')
    && conflictReplayHttp.response.normalized
    && conflictReplayHttp.response.normalized.suggested_reply == null
    && JSON.stringify(conflictReplayHttp.response).indexOf('legacy reply') === -1
    && JSON.stringify(conflictReplayHttp.response).indexOf('evt-legacy-1') === -1
    && conflictHarness.effects.inserts === 0
    && conflictHarness.events.length === 1
    && conflictHarness.events[0].client_slug === 'wolfhouse-somo'
    && conflictHarness.events[0].normalized.location_id == null
    && conflictHarness.events[0].suggested_reply === 'legacy reply');

  const locConflictHarness = makeHarnessPg({
    events: [{
      id: 'evt-loc-1',
      client_slug: 'sunset',
      wa_message_id: 'wamid.SAMPLE_15H_REPLAY_LOC',
      channel: 'whatsapp',
      direction: 'inbound',
      from_phone: '34600000001',
      to_phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
      message_type: 'text',
      message_text: 'Hola',
      profile_name: 'Sample Guest',
      raw_payload: null,
      normalized: {
        client_slug: 'sunset',
        location_id: 'sunset-sardinero',
        wa_message_id: 'wamid.SAMPLE_15H_REPLAY_LOC',
        supported: true,
        message_text: 'Hola',
      },
      draft_called: true,
      next_action: 'ask_missing_field',
      suggested_reply: 'stored',
      handoff_required: false,
      send_attempted: false,
      send_idempotency_key: null,
      send_status: null,
      send_blocked_reasons: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }],
  });
  const locConflictHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_REPLAY_LOC',
      text: 'Hola',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    harness: locConflictHarness,
  });
  red('replay_rejects_location_conflict',
    locConflictHttp.response.replay_identity_rejected === true
    && (locConflictHttp.response.blocked_reasons || []).includes('replay_location_id_conflict')
    && locConflictHttp.processed.event_row == null
    && locConflictHttp.response.guest_message_event_id == null
    && locConflictHttp.response.replay_identity
    && locConflictHttp.response.replay_identity.stored_location_id === 'sunset-sardinero'
    && locConflictHarness.effects.inserts === 0
    && locConflictHarness.events[0].normalized.location_id === 'sunset-sardinero');

  const fillHarness = makeHarnessPg({
    events: [{
      id: 'evt-fill-1',
      client_slug: 'sunset',
      wa_message_id: 'wamid.SAMPLE_15H_REPLAY_FILL',
      channel: 'whatsapp',
      direction: 'inbound',
      from_phone: '34600000001',
      to_phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
      message_type: 'text',
      message_text: 'Hola',
      profile_name: 'Sample Guest',
      raw_payload: null,
      normalized: {
        client_slug: 'sunset',
        wa_message_id: 'wamid.SAMPLE_15H_REPLAY_FILL',
        supported: true,
        message_text: 'Hola',
      },
      draft_called: true,
      next_action: 'ask_missing_field',
      suggested_reply: 'Could you share your check-in date?',
      handoff_required: false,
      send_attempted: true,
      send_idempotency_key: 'luna:sunset:wamid.SAMPLE_15H_REPLAY_FILL:ask_missing_field',
      send_status: 'blocked',
      send_blocked_reasons: ['luna_auto_send_not_enabled'],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }],
  });
  const fillHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_REPLAY_FILL',
      text: 'Hola',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    harness: fillHarness,
  });
  green('replay_fills_legacy_missing_location_without_history_rewrite',
    fillHttp.response.idempotent_replay === true
    && fillHttp.response.normalized.client_slug === 'sunset'
    && fillHttp.response.normalized.location_id === 'sunset-somo'
    && fillHttp.response.replay_history_rewritten === false
    && fillHarness.effects.inserts === 0
    && fillHarness.events.length === 1
    && fillHarness.events[0].normalized.location_id == null
    && fillHarness.events[0].client_slug === 'sunset');

  // Structured error via real HTTP path (forced PG throw after authority allows).
  const errHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_ERR',
      text: 'Hola',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    harness: makeHarnessPg({
      throwOnQuery: (sql) => {
        if (/guest_message_events/i.test(sql)) {
          return Object.assign(new Error('forced_pg_downstream_boom'), { code: 'XX000' });
        }
        return null;
      },
    }),
  });
  green('structured_error_carries_effective_normalized',
    errHttp.status === 500
    && errHttp.response.normalized
    && errHttp.response.normalized.client_slug === 'sunset'
    && errHttp.response.normalized.location_id === 'sunset-somo'
    && errHttp.audit[0]
    && errHttp.audit[0].intent === 'webhook:meta_whatsapp:downstream_error'
    && errHttp.audit[0].client_slug === 'sunset'
    && errHttp.audit[0].location_id === 'sunset-somo'
    && errHttp.error
    && errHttp.error.effective_normalized
    && errHttp.error.effective_normalized.client_slug === 'sunset');

  // Open-demo real path (execute seam; identity asserted on request + response).
  const demoHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_DEMO',
      text: 'Hola quiero una cama',
      from: '34611112222',
    }),
    env: {
      [AUTHORITY_ENV_KEY]: '1',
      OPEN_DEMO_WHATSAPP_ENABLED: 'true',
      LUNA_OPEN_PHONE_TESTING: 'true',
      NODE_ENV: 'staging',
    },
    executeOpenDemo: softOpenDemoExecute,
  });
  green('open_demo_no_conflicting_hardcoded_when_authority_active',
    demoHttp.status === 200
    && demoHttp.response.open_demo_route === true
    && demoHttp.response.normalized.client_slug === 'sunset'
    && demoHttp.response.normalized.location_id === 'sunset-somo'
    && demoHttp.response.normalized.client_slug !== 'wolfhouse-somo'
    && demoHttp.audit[0].client_slug === 'sunset');

  green('open_demo_legacy_fallback_when_authority_off', (() => {
    const demoBody = buildOpenDemoRequestBodyFromMeta({
      from: '34600000001',
      client_slug: '',
      wa_message_id: 'wamid.x',
      message_text: 'hi',
    });
    return demoBody.client_slug === 'wolfhouse-somo'
      && !Object.prototype.hasOwnProperty.call(demoBody, 'location_id');
  })());

  // Owner Command Center real path (tenant-wide staff lookup by authoritative slug).
  const ownerHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_OWNER',
      text: 'Who has not settled up?',
      from: '34600000999',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1', NODE_ENV: 'staging' },
    harness: makeHarnessPg({
      staff: [{
        client_slug: 'sunset',
        phone_e164: '+34600000999',
        phone_normalized: '34600000999',
        display_name: 'Owner',
        role: 'owner',
        channel: 'whatsapp',
        is_active: true,
      }],
    }),
  });
  green('owner_send_propagates_location_tenant_wide_slug',
    ownerHttp.status === 200
    && ownerHttp.response.owner_luna_route === true
    && ownerHttp.response.normalized.client_slug === 'sunset'
    && ownerHttp.response.normalized.location_id === 'sunset-somo'
    && ownerHttp.harness.effects.staff_lookups >= 1
    && ownerHttp.harness.effects.queries.some((q) => (
      /staff_phone_access/i.test(q.sql)
      && q.params[0] === 'sunset'
      && !/location_id/i.test(q.sql)
    ))
    && String(ownerHttp.response.idempotency_key || '').includes('luna:sunset:sunset-somo:')
    && ownerHttp.audit[0].client_slug === 'sunset'
    && ownerHttp.audit[0].location_id === 'sunset-somo');

  green('postentry_returns_effective_normalized_for_audit',
    guestHttp.processed.normalized.client_slug === 'sunset'
    && guestHttp.processed.normalized.location_id === 'sunset-somo'
    && guestHttp.audit[0].client_slug === guestHttp.processed.normalized.client_slug
    && guestHttp.audit[0].location_id === guestHttp.processed.normalized.location_id);

  red('authority_active_blocks_before_pg_on_unknown', (() => {
    return unknownEntry.result.acquired_pg === false
      && zeroDownstream(unknownEntry.counters);
  })());

  // ── Additional real-path branch coverage (identity + side-effect bounds) ──
  console.log('\n── Real-path branch coverage ──');
  const realPath = {};

  realPath.guest = guestHttp.status === 200
    && guestHttp.response.draft_called === true
    && guestHttp.harness.effects.inserts === 1;

  // Phone gate (open-demo enabled, non-allowlisted guest on legacy wolfhouse-somo).
  // Gate predicate is client_slug===wolfhouse-somo; authority-active Wolfhouse maps to
  // resolver slug "wolfhouse" and skips this gate — prove the real blocked branch offline.
  const gateHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_WOLFHOUSE_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_GATE',
      text: 'Hola',
      from: '34999888777',
    }),
    env: {
      // Stage 54 allowlists any valid phone in non-production; production + open-demo
      // still hits BR_BLOCKED_PHONE_GATE via evaluateGuestInboundPhoneGate.
      OPEN_DEMO_WHATSAPP_ENABLED: 'true',
      NODE_ENV: 'production',
    },
  });
  realPath.phone_gate = gateHttp.status === 200
    && gateHttp.response.normalized.client_slug === DEFAULT_CLIENT_SLUG
    && gateHttp.response.guest_phone_gate_blocked === true
    && gateHttp.response.guest_phone_gate_code === 'production_blocked'
    && gateHttp.response.draft_called === false
    && gateHttp.response.send_attempted === false
    && gateHttp.response.no_write_performed === true
    && /normalized\.client_slug/.test(fs.readFileSync(
      path.join(ROOT, 'scripts', 'lib', 'luna-open-phone-testing-gate.js'),
      'utf8',
    ));

  // Event table unavailable (both find entry → processWithoutPersistence)
  const missingTableHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_NOTABLE',
      text: 'Hola',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    harness: makeHarnessPg({ tableMissing: true }),
  });
  realPath.event_table_unavailable = missingTableHttp.status === 200
    && missingTableHttp.processed.acquired_pg === true
    && missingTableHttp.response.normalized.client_slug === 'sunset'
    && missingTableHttp.response.normalized.location_id === 'sunset-somo'
    && missingTableHttp.response.event_persisted === false
    && missingTableHttp.response.guest_message_event_id == null
    && missingTableHttp.harness.effects.inserts === 0;

  // Terminal no-draft/send (unsupported / empty-ish image type)
  const terminalBody = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_TERMINAL',
    text: 'Hola',
  });
  terminalBody.entry[0].changes[0].value.messages[0].type = 'image';
  delete terminalBody.entry[0].changes[0].value.messages[0].text;
  terminalBody.entry[0].changes[0].value.messages[0].image = { id: 'img1' };
  const terminalHttp = await runHttpWithPgHarness({
    body: terminalBody,
    env: { [AUTHORITY_ENV_KEY]: '1' },
  });
  realPath.terminal = terminalHttp.status === 200
    && terminalHttp.response.normalized.client_slug === 'sunset'
    && terminalHttp.response.normalized.location_id === 'sunset-somo'
    && terminalHttp.response.draft_called === false
    && terminalHttp.response.send_attempted === false;

  // Processed replay already covered by fillHttp
  realPath.processed_replay = fillHttp.response.idempotent_replay === true
    && fillHttp.response.normalized.location_id === 'sunset-somo';

  // Unprocessed historical candidate — continue without duplicate; do not rewrite
  // stored identity/history (authority fills response/runtime only).
  const unprocessedHarness = makeHarnessPg({
    events: [{
      id: 'evt-unproc-1',
      client_slug: 'sunset',
      wa_message_id: 'wamid.SAMPLE_15H_UNPROCESSED',
      channel: 'whatsapp',
      direction: 'inbound',
      from_phone: '34600000001',
      to_phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
      message_type: 'text',
      message_text: 'Hola',
      profile_name: 'Sample Guest',
      raw_payload: null,
      normalized: {
        client_slug: 'sunset',
        // legacy-null location must stay absent in stored history
        wa_message_id: 'wamid.SAMPLE_15H_UNPROCESSED',
        supported: true,
        message_text: 'Hola legacy unprocessed',
      },
      draft_called: false,
      next_action: null,
      suggested_reply: null,
      handoff_required: false,
      send_attempted: false,
      send_idempotency_key: null,
      send_status: null,
      send_blocked_reasons: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }],
  });
  const unprocessedStoredBefore = JSON.stringify(unprocessedHarness.events[0].normalized);
  const unprocessedHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_UNPROCESSED',
      text: 'Hola otra vez',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    harness: unprocessedHarness,
  });
  realPath.unprocessed_conflict = unprocessedHttp.status === 200
    && unprocessedHarness.effects.inserts === 0
    && unprocessedHarness.events.length === 1
    && unprocessedHttp.response.idempotent_replay === false
    && unprocessedHttp.response.normalized.client_slug === 'sunset'
    && unprocessedHttp.response.normalized.location_id === 'sunset-somo'
    && unprocessedHttp.response.guest_message_event_id === 'evt-unproc-1'
    && unprocessedHttp.response.replay_history_rewritten === false
    && unprocessedHarness.events[0].normalized.client_slug === 'sunset'
    && unprocessedHarness.events[0].normalized.location_id == null
    && !Object.prototype.hasOwnProperty.call(
      unprocessedHarness.events[0].normalized,
      'location_id',
    )
    && unprocessedHarness.events[0].normalized.message_text === 'Hola legacy unprocessed'
    && unprocessedStoredBefore.indexOf('"location_id"') === -1;

  // Ambiguous multi-tenant candidates → reject, no insert, no foreign event_row
  const ambigHarness = makeHarnessPg({
    events: [
      {
        id: 'a1',
        client_slug: 'wolfhouse-somo',
        wa_message_id: 'wamid.SAMPLE_15H_AMBIG',
        normalized: { client_slug: 'wolfhouse-somo' },
        draft_called: true,
        next_action: 'ask_missing_field',
        suggested_reply: 'secret-cross-tenant-a',
        send_attempted: false,
        send_blocked_reasons: [],
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'a2',
        client_slug: 'sunset',
        wa_message_id: 'wamid.SAMPLE_15H_AMBIG',
        normalized: { client_slug: 'sunset', location_id: 'sunset-somo' },
        draft_called: true,
        next_action: 'ask_missing_field',
        suggested_reply: 'secret-cross-tenant-b',
        send_attempted: false,
        send_blocked_reasons: [],
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ],
  });
  const ambigHttp = await runHttpWithPgHarness({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_AMBIG',
      text: 'Hola',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    harness: ambigHarness,
  });
  realPath.ambiguous_reject = ambigHttp.response.replay_identity_rejected === true
    && (ambigHttp.response.blocked_reasons || []).includes('replay_ambiguous_wa_message_id')
    && ambigHttp.processed.event_row == null
    && ambigHttp.response.guest_message_event_id == null
    && ambigHttp.response.replay_identity
    && ambigHttp.response.replay_identity.candidate_count === 2
    && JSON.stringify(ambigHttp.response).indexOf('secret-cross-tenant') === -1
    && ambigHarness.effects.inserts === 0
    && ambigHarness.events.length === 2;

  realPath.owner = ownerHttp.response.owner_luna_route === true;
  realPath.open_demo = demoHttp.response.open_demo_route === true;
  realPath.audit = guestHttp.audit[0]
    && guestHttp.audit[0].client_slug === 'sunset'
    && errHttp.audit[0]
    && errHttp.audit[0].intent === 'webhook:meta_whatsapp:downstream_error';
  // Real send callback (evaluateGuestReplySendRouteWithPause) must run — do not
  // infer send solely from idempotency key presence.
  realPath.send = guestHttp.response.send_attempted === true
    && guestHttp.harness.effects.send_lookups >= 1
    && guestHttp.harness.effects.queries.some((q) => (
      /guest_message_sends|bot_pause|conversation_pause|staff_bot_pause/i.test(q.sql)
    ));
  realPath.response = guestHttp.response.normalized
    && guestHttp.response.normalized.client_slug === 'sunset'
    && guestHttp.response.normalized.location_id === 'sunset-somo';
  realPath.structured_error = errHttp.status === 500
    && errHttp.response.normalized.location_id === 'sunset-somo';

  const realPathIds = [
    'guest',
    'owner',
    'open_demo',
    'phone_gate',
    'event_table_unavailable',
    'terminal',
    'processed_replay',
    'unprocessed_conflict',
    'ambiguous_reject',
    'audit',
    'send',
    'response',
    'structured_error',
  ];
  for (const id of realPathIds) {
    ok(`real-path ${id}`, realPath[id] === true, realPath[id] ? '' : `branch=${id}`);
  }

  // Concurrent cross-slug claim: advisory lock ensures only one insert wins.
  console.log('\n── Concurrency / isolation proofs ──');
  const concurHarness = makeHarnessPg({});
  const concurWamid = 'wamid.SAMPLE_15H_CONCUR';
  const seedSunset = buildInboundEventSeed({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    wa_message_id: concurWamid,
    from: '34600000001',
    phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    message_type: 'text',
    message_text: 'A',
  }, { object: 'whatsapp_business_account' });
  const seedWolf = buildInboundEventSeed({
    client_slug: 'wolfhouse-somo',
    wa_message_id: concurWamid,
    from: '34600000001',
    phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_WOLFHOUSE_SOMO_SAMPLE',
    message_type: 'text',
    message_text: 'B',
  }, { object: 'whatsapp_business_account' });
  const [claimA, claimB] = await Promise.all([
    claimGuestMessageEventInboundByWaMessageId(concurHarness, seedSunset),
    claimGuestMessageEventInboundByWaMessageId(concurHarness, seedWolf),
  ]);
  const concurInserted = [claimA, claimB].filter((c) => c.inserted === true).length;
  ok('concurrent cross-slug claims cannot both insert',
    concurInserted === 1
    && concurHarness.effects.inserts === 1
    && concurHarness.events.length === 1
    && concurHarness.effects.advisory_locks >= 2
    && concurHarness.effects.advisory_unlocks >= 2
    && claimA.rows.length === 1
    && claimB.rows.length === 1
    && claimA.rows[0].id === claimB.rows[0].id
    && concurHarness.events[0].wa_message_id === concurWamid);

  ok('SQL helpers use advisory lock (no unapplied UNIQUE wa_message_id required)', (() => {
    const sqlSrc = fs.readFileSync(
      path.join(ROOT, 'scripts', 'lib', 'luna-guest-message-events-sql.js'),
      'utf8',
    );
    const constraintAdds = sqlSrc.match(
      /^\s*CONSTRAINT\s+\w+\s+UNIQUE\s*\(\s*wa_message_id\s*\)/gim,
    ) || [];
    const alterUnique = sqlSrc.match(
      /ADD\s+(?:CONSTRAINT\s+\w+\s+)?UNIQUE\s*\(\s*wa_message_id\s*\)/gi,
    ) || [];
    return /pg_advisory_lock\(hashtext\(\$1\),\s*hashtext\(\$2\)\)/.test(sqlSrc)
      && /claimGuestMessageEventInboundByWaMessageId/.test(sqlSrc)
      && sqlSrc.includes(WA_MESSAGE_ID_LOCK_NAMESPACE)
      && /ON CONFLICT \(client_slug, wa_message_id\) DO NOTHING/.test(sqlSrc)
      && constraintAdds.length === 0
      && alterUnique.length === 0;
  })());

  ok('unexpected harness SQL fails closed', await (async () => {
    const h = makeHarnessPg({});
    try {
      await h.query('SELECT 1 FROM totally_unknown_table_xyz', []);
      return false;
    } catch (err) {
      return /unexpected SQL/i.test(String(err && err.message));
    }
  })());

}

console.log('\n── Secret-free + packaging ──');
const pkg = readJson(path.join(ROOT, 'package.json'));
ok('package.json has 15H verify script',
  pkg.scripts['verify:fortress-slice15h-meta-ingress-authority-enforce']
  === 'node scripts/verify-fortress-slice15h-meta-ingress-authority-enforce.js');

const secretScanTargets = [
  FINDINGS_PATH,
  CONTRACT_PATH,
  OVERLAY_PATH,
  path.join(ROOT, 'scripts', 'lib', 'meta-whatsapp-ingress-authority.js'),
  RUNBOOK_PATH,
];
let secretHits = 0;
for (const p of secretScanTargets) {
  const text = fs.readFileSync(p, 'utf8');
  secretHits += scanSecretFreeText(text).length;
}
ok('secret-free artifacts', secretHits === 0, `hits=${secretHits}`);

runEntryAndZeroDownstream().then(() => {
  console.log('\n── Evidence (read-only) ──');
  ok('evidence exists (not rewritten by verifier)', fs.existsSync(EVIDENCE_PATH));
  ok('evidence slice + activation gap',
    committedEvidence.slice === 'FORTRESS-15H'
    && committedEvidence.live_mutation === false
    && committedEvidence.activation_default === 'off'
    && committedEvidence.activation_gap
    && committedEvidence.activation_gap.runtime_enabled === false);

  const expectedRedIds = (contract.red_case_ids || []).map((id) => id.replace(/^RED_/, ''));
  const expectedGreenIds = (contract.green_case_ids || []).map((id) => id.replace(/^GREEN_/, ''));
  const runRedIds = redResults.map((r) => r.id);
  const runGreenIds = greenResults.map((r) => r.id);
  const evidenceRedIds = ((committedEvidence.red && committedEvidence.red.cases) || []).map((c) => c.id);
  const evidenceGreenIds = ((committedEvidence.green && committedEvidence.green.cases) || []).map((c) => c.id);

  ok('evidence RED ids match contract + this run',
    expectedRedIds.length === runRedIds.length
    && expectedRedIds.every((id, i) => id === runRedIds[i])
    && evidenceRedIds.length === runRedIds.length
    && evidenceRedIds.every((id, i) => id === runRedIds[i])
    && redResults.every((r) => r.ok)
    && ((committedEvidence.red && committedEvidence.red.cases) || []).every((c) => c.ok === true));

  ok('evidence GREEN ids match contract + this run',
    expectedGreenIds.length === runGreenIds.length
    && expectedGreenIds.every((id, i) => id === runGreenIds[i])
    && evidenceGreenIds.length === runGreenIds.length
    && evidenceGreenIds.every((id, i) => id === runGreenIds[i])
    && greenResults.every((r) => r.ok)
    && ((committedEvidence.green && committedEvidence.green.cases) || []).every((c) => c.ok === true));

  ok('verifier does not rewrite tracked evidence', (() => {
    const src = fs.readFileSync(__filename, 'utf8');
    const writeHits = src.match(/writeFileSync\s*\(\s*EVIDENCE_PATH/g) || [];
    return writeHits.length === 0;
  })());

  ok('red/green counts',
    evidenceRedIds.length === 12
    && evidenceGreenIds.length === 15
    && redResults.length === 12
    && greenResults.length === 15);

  console.log(`\n── Summary: pass=${pass} fail=${fail} ──`);
  if (fail > 0) process.exit(1);
  console.log('OK fortress-slice15h-meta-ingress-authority-enforce');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
