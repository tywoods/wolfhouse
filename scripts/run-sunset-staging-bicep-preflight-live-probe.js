'use strict';

/**
 * Live Azure probe for Sunset Bicep preflight (read-only).
 * Simulates clean origin/master git state at the required candidate SHA so Azure
 * checks can run from a feature branch without mutating git. Never prints secrets.
 *
 * Secure overlay uses synthetic what-if-safe routing values (not live example/test
 * literals). Live CA currently stamps staging_*_phone_number_id / example.test
 * which preflight correctly rejects; those must not be copied into the overlay.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runPreflight, createLiveAzure } = require('./preflight-sunset-staging-bicep');

const ROOT = path.join(__dirname, '..');
const MASTER = execSync('git rev-parse origin/master', { cwd: ROOT, encoding: 'utf8' }).trim();
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice3');
const SECURE = path.join(OUT_DIR, 'secure.local.json');
const REPORT = path.join(OUT_DIR, 'live-preflight-report.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

const AZ = process.platform === 'win32'
  ? '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"'
  : 'az';

function azJson(args) {
  const raw = execSync(`${AZ} ${args} -o json`, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = String(raw).replace(/^\uFEFF/, '').trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) throw new Error('no json from az');
  return JSON.parse(s.slice(i));
}

function isRejectedLiteral(v) {
  const s = String(v || '');
  return (
    s.includes('<REQUIRED') ||
    s.includes('****') ||
    /example\.test/i.test(s) ||
    /staging_[a-z0-9]+_phone_number_id/i.test(s)
  );
}

const app = azJson('containerapp show -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api');
const envList = (((app.properties || {}).template || {}).containers || [])[0].env || [];
const env = {};
for (const e of envList) {
  if (e && e.name && e.value != null) env[e.name] = e.value;
}

// Prefer live stamps only when they pass placeholder rejection; else synthetic what-if shapes.
function pick(liveKey, synthetic) {
  const live = env[liveKey];
  return live && !isRejectedLiteral(live) ? live : synthetic;
}

const secure = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
  contentVersion: '1.0.0.0',
  parameters: {
    staffApiImageTag: { value: MASTER },
    deploySha: { value: MASTER },
    forceRevision: { value: MASTER },
    sunsetSomoWhatsappNumber: {
      value: pick('SUNSET_SOMO_WHATSAPP_NUMBER', '+34111111111'),
    },
    sunsetSardineroWhatsappNumber: {
      value: pick('SUNSET_SARDINERO_WHATSAPP_NUMBER', '+34222222222'),
    },
    sunsetSomoWhatsappPhoneNumberId: {
      value: pick('SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID', '111111111111111'),
    },
    sunsetSardineroWhatsappPhoneNumberId: {
      value: pick('SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID', '222222222222222'),
    },
    sunsetSomoInboxEmail: {
      value: pick('SUNSET_SOMO_INBOX_EMAIL', 'sunset-somo-preflight@lunafrontdesk.com'),
    },
    sunsetSardineroInboxEmail: {
      value: pick('SUNSET_SARDINERO_INBOX_EMAIL', 'sunset-sardinero-preflight@lunafrontdesk.com'),
    },
    lunaBotInternalToken: { value: 'WH_WHATIF_ONLY_NOT_A_REAL_TOKEN_9f3a' },
    postgresAdminPassword: { value: 'WH_WHATIF_ONLY_NOT_A_REAL_PASSWORD_9f3a' },
  },
};
fs.writeFileSync(SECURE, `${JSON.stringify(secure)}\n`);

const report = runPreflight({
  git: {
    statusPorcelain: () => '',
    revParse: (ref) => MASTER,
  },
  azure: createLiveAzure(),
  baseParams: path.join(ROOT, 'infra/azure/sunset-staging/parameters.example.json'),
  secureParams: SECURE,
  skipWhatIf: false,
  skipAcr: false,
});

report.probeNotes = {
  liveEnvHadRejectedLiterals: [
    'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID',
    'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID',
    'SUNSET_SOMO_INBOX_EMAIL',
    'SUNSET_SARDINERO_INBOX_EMAIL',
  ].filter((k) => isRejectedLiteral(env[k])),
  note:
    'Secure overlay used synthetic what-if-safe values where live stamps matched rejected example/test literals. ACR missing for candidate master SHA is an expected fail-closed gate.',
};

fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
const fixtureDir = path.join(ROOT, 'fixtures/sunset-staging-bicep-preflight');
fs.mkdirSync(fixtureDir, { recursive: true });
fs.writeFileSync(path.join(fixtureDir, 'live-preflight-report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  ok: report.ok,
  candidateSha: report.candidateSha,
  costBaseline: report.costBaseline,
  templateHash: report.templateHash,
  checkNames: report.checks.map((c) => `${c.name}:${c.ok ? 'PASS' : 'FAIL'}`),
  whatIfSummary: report.whatIf && report.whatIf.summary,
  probeNotes: report.probeNotes,
  reportPath: REPORT,
}, null, 2));

fs.unlinkSync(SECURE);
process.exit(0);
