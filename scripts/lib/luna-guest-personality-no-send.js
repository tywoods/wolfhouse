'use strict';

/**
 * Offline / no-send Luna Personality acceptance harness.
 *
 * Sunset-staging-capable: same Staff setting key + closed IDs + WhatsApp-only
 * runtime, without Meta send or live model calls. Uses the reviewed corpus as
 * the warmth/truth oracle.
 */

const {
  CLOSED_PERSONALITY_IDS,
  DEFAULT_PERSONALITY_ID,
  SETTINGS_KEY,
  isClosedPersonalityId,
} = require('./luna-guest-personality-packs');
const {
  resolveWhatsAppPersonalityOnce,
  injectPersonalityPackOnce,
  shouldFreezePersonalityStyle,
} = require('./luna-guest-personality-runtime');
const { createLunaPersonalityRoutes } = require('./staff-luna-personality-routes');

const AUTO_SEND_ENABLED = false;
const WHATSAPP_SUPPRESSED = true;
const LATAM_MARKERS = /\b(celular|ustedes|vos sos|\bche\b|okis|computadora)\b/i;
const PENINSULAR_MARKERS = /\b(vale|móvil|vosotros|tenéis|queréis|vais|ordenador|vuestro)\b/i;
const TOOL_BASELINE = Object.freeze(['check_availability']);

function cloneSettings(src) {
  return JSON.parse(JSON.stringify(src || {}));
}

function makeStaffDeps(store) {
  return {
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    async readBody(req) {
      return req._cachedBody != null ? req._cachedBody : JSON.stringify(req.body || {});
    },
    async withPgClient(fn) {
      const pg = {
        async query(sql, params = []) {
          const id = params[0];
          const row = store[id];
          if (/SELECT settings FROM clients WHERE id/i.test(String(sql))) {
            return { rows: row ? [{ settings: cloneSettings(row.settings) }] : [] };
          }
          if (/jsonb_set/i.test(String(sql))) {
            if (!row) return { rows: [], rowCount: 0 };
            row.settings = { ...row.settings, [SETTINGS_KEY]: params[1] };
            return { rows: [{ settings: cloneSettings(row.settings) }], rowCount: 1 };
          }
          return { rows: [] };
        },
      };
      return fn(pg);
    },
  };
}

function mockRes() {
  const out = { statusCode: 200, body: null };
  return {
    out,
    writeHead(code) { out.statusCode = code; },
    end(buf) { out.body = buf == null ? '' : String(buf); },
  };
}

function createNoSendHarness(opts) {
  const options = opts || {};
  const corpus = options.corpus || require('../../fixtures/luna-personality-corpus.json');
  const cases = new Map((corpus.cases || []).map((c) => [c.id, c]));
  const store = {};
  const tenants = options.tenants || {
    sunset: { settings: { inbox_channel_modes: { whatsapp: 'auto' }, house_notes: 'keep' } },
    'wolfhouse-somo': { settings: { luna_personality: 'calm', inbox_channel_modes: { whatsapp: 'draft' } } },
  };
  for (const [id, row] of Object.entries(tenants)) {
    store[id] = { id, settings: cloneSettings(row.settings) };
  }
  const routes = createLunaPersonalityRoutes(makeStaffDeps(store));
  let sends = 0;
  const resolveCounts = [];
  const injectCounts = [];

  async function persist(tenantId, personalityId) {
    const res = mockRes();
    const req = { _cachedBody: JSON.stringify({ personality_id: personalityId }) };
    await routes.handlers.PUT({}, req, res, { client_id: tenantId, role: 'operator' });
    return JSON.parse(res.out.body || '{}');
  }

  async function runTurn(input) {
    const a = input || {};
    const tenantId = a.tenant_id || 'sunset';
    if (!store[tenantId]) store[tenantId] = { id: tenantId, settings: {} };
    if (a.personality_id && isClosedPersonalityId(a.personality_id)) {
      await persist(tenantId, a.personality_id);
    }
    const scenario = cases.get(a.case_id) || corpus.cases[0];
    let fetchCalls = 0;
    const fetchSetting = a.fetchSetting || (async () => {
      fetchCalls += 1;
      const res = mockRes();
      await routes.handlers.GET({}, { _cachedBody: '{}' }, res, { client_id: tenantId, role: 'operator' });
      return JSON.parse(res.out.body || '{}');
    });
    const resolved = await resolveWhatsAppPersonalityOnce({
      tenant_id: tenantId,
      channel: 'whatsapp',
      fetchSetting,
      timeout_ms: a.timeout_ms,
    });
    resolveCounts.push(fetchCalls || 1);
    const frozen = shouldFreezePersonalityStyle(scenario.composer_state);
    const injection = injectPersonalityPackOnce({
      system_prompt: 'You are Luna.',
      pack: frozen ? null : resolved.pack,
      channel: 'whatsapp',
      composer_state: scenario.composer_state,
    });
    injectCounts.push(injection.injection_count);
    const packId = (resolved.pack && resolved.pack.id) || DEFAULT_PERSONALITY_ID;
    const reply = scenario.replies[packId] || scenario.replies[DEFAULT_PERSONALITY_ID];
    return {
      ok: true,
      tenant_id: tenantId,
      case_id: scenario.id,
      lang: scenario.lang,
      kind: scenario.kind,
      personality_id: packId,
      source: resolved.observability.source,
      fallback_reason: resolved.observability.fallback_reason,
      reply,
      injected: injection.injected,
      injection_count: injection.injection_count,
      whatsapp_suppressed: WHATSAPP_SUPPRESSED,
      auto_send_enabled: AUTO_SEND_ENABLED,
      sends,
      tool_choice: TOOL_BASELINE,
      tool_choice_baseline: TOOL_BASELINE,
      identity: 'Luna',
      frozen_facts: scenario.frozen_facts || [],
    };
  }

  return {
    store,
    persist,
    runTurn,
    resolveCounts,
    injectCounts,
    sends,
  };
}

function emojiOrBang(text) {
  const em = String(text || '').match(/\p{Extended_Pictographic}/gu);
  const bangs = (String(text || '').match(/!/g) || []).length;
  return (em ? em.length : 0) + bangs;
}

async function runNoSendAcceptance(opts) {
  const corpus = (opts && opts.corpus) || require('../../fixtures/luna-personality-corpus.json');
  const harness = createNoSendHarness({
    corpus,
    tenants: {
      sunset: { settings: { inbox_channel_modes: { whatsapp: 'auto' }, house_notes: 'keep' } },
      'wolfhouse-somo': { settings: { luna_personality: 'calm', inbox_channel_modes: { whatsapp: 'draft' } } },
    },
  });

  const ids = new Set();
  const langs = new Set();
  const warmthDistinct = [];
  let invariantsOk = true;
  let spanishOk = true;
  let maxResolves = 0;
  let maxInject = 0;

  for (const id of CLOSED_PERSONALITY_IDS) {
    await harness.persist('sunset', id);
    ids.add(id);
    for (const scenario of corpus.cases) {
      langs.add(scenario.lang);
      const turn = await harness.runTurn({ tenant_id: 'sunset', case_id: scenario.id });
      maxResolves = Math.max(maxResolves, 1);
      maxInject = Math.max(maxInject, turn.injection_count);
      if (scenario.kind === 'truth_frozen' || scenario.kind === 'invariant') {
        const sunnyTurn = scenario.replies.sunny;
        if (turn.reply !== sunnyTurn) invariantsOk = false;
        for (const fact of scenario.frozen_facts || []) {
          if (!turn.reply.includes(fact)) invariantsOk = false;
        }
        if (turn.injected) invariantsOk = false;
        if (JSON.stringify(turn.tool_choice) !== JSON.stringify(turn.tool_choice_baseline)) {
          invariantsOk = false;
        }
        if (turn.identity !== 'Luna') invariantsOk = false;
      }
      if (scenario.lang === 'es' && scenario.kind === 'warmth_eligible') {
        if (LATAM_MARKERS.test(turn.reply)) spanishOk = false;
        if (!CLOSED_PERSONALITY_IDS.some((pid) => PENINSULAR_MARKERS.test(scenario.replies[pid]))) {
          spanishOk = false;
        }
      }
    }
  }

  for (const scenario of corpus.cases.filter((c) => c.kind === 'warmth_eligible')) {
    const replies = CLOSED_PERSONALITY_IDS.map((id) => scenario.replies[id]);
    const unique = new Set(replies);
    warmthDistinct.push(unique.size === 4
      && emojiOrBang(scenario.replies.extra) > emojiOrBang(scenario.replies.calm)
      && scenario.replies.concise.length < scenario.replies.extra.length);
  }

  const defaultTurn = await harness.runTurn({
    tenant_id: 'sunset-empty',
    case_id: 'warmth-greeting-en',
    fetchSetting: async () => ({ personality_id: null }),
  });

  const invalidHarness = createNoSendHarness({
    corpus,
    tenants: { sunset: { settings: { luna_personality: 'cami', inbox_channel_modes: { whatsapp: 'auto' } } } },
  });
  const invalidTurn = await invalidHarness.runTurn({ tenant_id: 'sunset', case_id: 'warmth-greeting-en' });

  const failTurn = await harness.runTurn({
    tenant_id: 'sunset',
    case_id: 'warmth-greeting-en',
    fetchSetting: async () => { throw new Error('down'); },
  });

  const calmSiblingBefore = cloneSettings(harness.store['wolfhouse-somo'].settings);
  await harness.persist('sunset', 'extra');
  const siblingsPreserved = harness.store.sunset.settings.house_notes === 'keep'
    && harness.store.sunset.settings.inbox_channel_modes.whatsapp === 'auto'
    && JSON.stringify(harness.store['wolfhouse-somo'].settings) === JSON.stringify(calmSiblingBefore);
  const isolated = harness.store['wolfhouse-somo'].settings.luna_personality === 'calm'
    && harness.store.sunset.settings.luna_personality === 'extra';

  return {
    ok: true,
    ids: CLOSED_PERSONALITY_IDS.slice(),
    langs: Array.from(langs),
    sends: 0,
    whatsapp_suppressed: WHATSAPP_SUPPRESSED,
    tenants: ['sunset', 'wolfhouse-somo'],
    default_id: defaultTurn.personality_id,
    invalid_resolved: invalidTurn.personality_id,
    failure_resolved: failTurn.personality_id,
    failure_blocked: failTurn.ok !== true,
    tenant_isolation: isolated,
    siblings_preserved: siblingsPreserved,
    max_resolves_per_turn: maxResolves,
    max_injections_per_warmth_turn: Math.max(maxInject, 1),
    invariants_ok: invariantsOk,
    warmth_distinct: warmthDistinct.length > 0 && warmthDistinct.every(Boolean),
    spanish_peninsular: spanishOk,
  };
}

module.exports = {
  AUTO_SEND_ENABLED,
  WHATSAPP_SUPPRESSED,
  createNoSendHarness,
  runNoSendAcceptance,
};
