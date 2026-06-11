/**
 * Stage 43a — Client-facing Somo surf report verifier.
 *
 * Usage:
 *   npm run verify:stage43a-client-facing-surf-report
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SURF_CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.surf-report.json');
const SURF_HELPER = path.join(__dirname, 'lib', 'luna-guest-surf-report.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const TRANSITIONS = path.join(__dirname, 'lib', 'luna-booking-state-transitions.js');
const CONTEXT_MERGE = path.join(__dirname, 'lib', 'luna-guest-context-merge.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const SCRIPT = 'verify:stage43a-client-facing-surf-report';

const SURF_FIXTURES = [
  'surf-report-en-fun.json',
  'surf-report-en-flat.json',
  'surf-report-en-bigger-high-tide.json',
  'surf-report-it.json',
  'surf-report-es.json',
  'surf-report-de.json',
  'surf-report-mid-booking-preserves-context.json',
  'surf-report-api-unavailable-fallback.json',
];

const GUEST_INTENTS = [
  'how are the waves today?',
  'surf report',
  "what's the surf like?",
  'is Somo good today?',
  'are there waves tomorrow?',
  'how are conditions?',
  'qué tal las olas?',
  'cómo está el surf?',
  "com'è il mare?",
  'come sono le onde?',
  'wie sind die Wellen?',
  'Surfbericht',
];

const {
  loadSurfReportConfig,
  detectGuestSurfReportIntent,
  classifySurfConditions,
  formatGuestSurfReportReply,
  buildGuestSurfReportReply,
  fetchGuestSurfReportData,
  setGuestSurfReportFetchForTests,
} = require('./lib/luna-guest-surf-report');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage43a-client-facing-surf-report.js  (Stage 43a)\n');

section('A. Files & syntax');
for (const f of [SURF_CONFIG, SURF_HELPER, COMPOSER, ORCH]) {
  check(`A-${path.basename(f)}`, fs.existsSync(f), `${path.basename(f)} exists`);
}
for (const f of [SURF_HELPER, COMPOSER, ORCH]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'ignore' });
    pass(`A-check-${path.basename(f)}`, `${path.basename(f)} passes node --check`);
  } catch (_) {
    fail(`A-check-${path.basename(f)}`, `${path.basename(f)} passes node --check`);
  }
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A-pkg', pkg.scripts && pkg.scripts[SCRIPT] === 'node scripts/verify-stage43a-client-facing-surf-report.js', 'package script exists');

const helperSrc = fs.readFileSync(SURF_HELPER, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const transitionsSrc = fs.readFileSync(TRANSITIONS, 'utf8');
const mergeSrc = fs.readFileSync(CONTEXT_MERGE, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');

section('B. Config policy');
const config = loadSurfReportConfig('wolfhouse-somo');
check('B-beach', config && config.beach === 'Somo', 'beach Somo');
check('B-wave-min', config && config.ideal_wave_height_m && config.ideal_wave_height_m.min === 0.1, 'ideal min 0.1m');
check('B-wave-max', config && config.ideal_wave_height_m && config.ideal_wave_height_m.max === 2.5, 'ideal max 2.5m');
check('B-tide', config && config.tide_guidance && config.tide_guidance.bigger_waves_note, 'tide guidance');
check('B-wind', config && config.wind_guidance, 'wind guidance');
check('B-safety', config && config.safety_copy && config.safety_copy.no_hard_safety_calls === true, 'no hard safety calls');
check('B-fallback-en', config && config.fallback && config.fallback.en.includes('Somo'), 'fallback EN');

section('C. Formatter buckets & tone');
check('C-flat', classifySurfConditions({ wave_height_m: 0.05 }) === 'tiny_flat', 'tiny/flat bucket');
check('C-fun', classifySurfConditions({ wave_height_m: 1.0 }) === 'fun', 'fun bucket');
check('C-solid', classifySurfConditions({ wave_height_m: 1.8 }) === 'solid', 'solid bucket');
check('C-stormy', classifySurfConditions({ wave_height_m: 2.0, wind_speed_mps: 12 }) === 'stormy_messy', 'stormy bucket');

const funReply = formatGuestSurfReportReply({
  metrics: { wave_height_m: 1.0, tide_phase: 'rising' },
  lang: 'en',
});
check('C-fun-copy', funReply.reply && /fun Somo|Somo day/i.test(funReply.reply), 'fun guest copy');
check('C-no-metrics', funReply.reply && !/\b1\.0\s*m\b/i.test(funReply.reply), 'no raw metric dump');
check('C-no-unsafe', funReply.reply && !/\bunsafe\b/i.test(funReply.reply), 'no hard safety call');

const flatReply = formatGuestSurfReportReply({ metrics: { wave_height_m: 0.05 }, lang: 'en' });
check('C-flat-tone', flatReply.reply && /flat|tiny/i.test(flatReply.reply), 'flat friendly tone');

section('D. Multilingual');
for (const [lang, needle] of [['it', 'Somo'], ['es', 'Somo'], ['de', 'Somo']]) {
  const r = formatGuestSurfReportReply({ metrics: { wave_height_m: 1.0, tide_phase: 'rising' }, lang });
  check(`D-${lang}`, r.reply && r.reply.includes(needle), `${lang} surf answer`);
}

section('E. Guest intent routing');
for (const q of GUEST_INTENTS) {
  check(`E-${q.slice(0, 12)}`, detectGuestSurfReportIntent(q) != null, `intent: ${q}`);
}
check('E-lesson-time-no-surf', detectGuestSurfReportIntent('what time are surf lessons?') == null, 'lesson schedule not surf report');

section('F. Wiring');
check('F-composer', composerSrc.includes('explain_surf_report'), 'composer surf state');
check('F-orch', orchSrc.includes('prefetchGuestSurfReportPayload'), 'orchestrator prefetch');
check('F-stale', transitionsSrc.includes('detectGuestSurfReportIntent'), 'quote stale preserves surf side Q');
check('F-merge', mergeSrc.includes('detectGuestSurfReportIntent'), 'context merge surf side Q');
check('F-router', routerSrc.includes('detectGuestSurfReportIntent'), 'router surf intent no handoff');

section('G. API key safety');
check('G1', !helperSrc.includes('process.env.STORMGLASS_API_KEY'), 'helper never reads API key directly');
check('G2', !helperSrc.match(/sg_[a-z0-9]+/i), 'no API key pattern in helper');
check('G3', !fs.readFileSync(SURF_CONFIG, 'utf8').includes('api_key'), 'no api_key in config');

section('H. Fallback & mock (no live API required)');
(async () => {
  setGuestSurfReportFetchForTests(async () => ({ unavailable: true, day: 'today', source: 'test' }));
  const fb = await fetchGuestSurfReportData({ clientSlug: 'wolfhouse-somo', day: 'today' });
  check('H-fallback-fetch', fb.unavailable === true, 'mock fetch unavailable');
  setGuestSurfReportFetchForTests(null);

  const built = buildGuestSurfReportReply({ surf_data: { unavailable: true }, lang: 'en' });
  check('H-fallback-copy', built.reply && built.reply.includes('live surf report'), 'fallback copy');
  check('H-no-hallucinate', built.reply && !/\b\d\.\d\s*m\b/.test(built.reply), 'fallback no fake metrics');

  setGuestSurfReportFetchForTests(async () => ({
    metrics: { wave_height_m: 1.0, tide_phase: 'rising' },
    day: 'today',
    source: 'mock',
  }));
  const mockData = await fetchGuestSurfReportData({ clientSlug: 'wolfhouse-somo', day: 'today', mock: { wave_height_m: 1.0 } });
  check('H-mock', mockData.metrics && mockData.metrics.wave_height_m === 1.0, 'mock data path');
  setGuestSurfReportFetchForTests(null);

  section('I. Composer integration');
  const composed = composeLunaGuestReply({
    message_text: 'How are the waves today?',
    client_slug: 'wolfhouse-somo',
    payload: {
      result: { detected_language: 'en' },
      quote: {},
      payment_choice: {},
      surf_report: { metrics: { wave_height_m: 1.0, tide_phase: 'rising' }, day: 'today' },
    },
    prior_guest_context: {},
  });
  check('I-compose', composed.covered && composed.composer_state === 'explain_surf_report', 'composer surf report');
  check('I-somo', composed.reply && composed.reply.includes('Somo'), 'composed Somo mention');

  section('J. Fixtures on disk');
  for (const f of SURF_FIXTURES) {
    check(`J-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), f);
  }

  section('K. Safety exclusions');
  check('K1', !orchSrc.includes('sendWhatsApp') && !composerSrc.includes('sendWhatsApp'), 'no WhatsApp send');
  check('K2', !helperSrc.includes('stripe') && !composerSrc.includes('createStripe'), 'no Stripe in surf path');
  check('K3', !orchSrc.includes('n8n') || orchSrc.includes('No public inbound'), 'no n8n activation added');

  console.log(`\n── Summary ──\n  PASS: ${passes}\n  FAIL: ${failures}\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
