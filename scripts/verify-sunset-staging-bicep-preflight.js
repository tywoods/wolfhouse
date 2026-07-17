'use strict';

/**
 * verify:sunset-staging-bicep-preflight
 *
 * TDD RED→GREEN gate for FOUNDATION Slice 3 preflight helpers + CLI surface.
 * No Azure mutations. Uses in-memory mocks for fail-closed cases.
 */

const fs = require('fs');
const path = require('path');
const {
  checkGitState,
  checkAzureTarget,
  checkParameters,
  checkAcrImage,
  checkForbiddenReferences,
  evaluateWhatIfChanges,
  parseWhatIfJson,
  assertCommandSurfaceIsReadOnly,
  buildReport,
  assertNoLeakedSecrets,
  redactParams,
  isForbiddenPlaceholder,
  mergeParameters,
  validateSecureParamsProvenance,
  skippedCheck,
  ALLOWED_WHATIF_NOISE_FINGERPRINTS,
} = require('./lib/sunset-staging-bicep-preflight');
const { runPreflight } = require('./preflight-sunset-staging-bicep');

const ROOT = path.join(__dirname, '..');
const MASTER = '701cd650383936b24769fa7c8a9afa39a1c9281c';
const CLI = path.join(ROOT, 'scripts/preflight-sunset-staging-bicep.js');
const LIB = path.join(ROOT, 'scripts/lib/sunset-staging-bicep-preflight.js');
const INVENTORY = path.join(
  ROOT,
  'infra/azure/sunset-staging/inventory/live-inventory.normalized.json',
);
const BASE_PARAMS = path.join(ROOT, 'infra/azure/sunset-staging/parameters.example.json');

function mockGit({ dirty = '', head = MASTER, originMaster = MASTER } = {}) {
  return {
    statusPorcelain: () => dirty,
    revParse: (ref) => (ref === 'HEAD' ? head : originMaster),
  };
}

function countingAzure({
  sub = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  rgExists = true,
  imageExists = true,
  whatIf = { properties: { changes: [] } },
} = {}) {
  const counts = {
    accountSubscriptionId: 0,
    resourceGroupExists: 0,
    acrImageExists: 0,
    queryCost: 0,
    whatIfIncremental: 0,
  };
  return {
    counts,
    accountSubscriptionId: () => {
      counts.accountSubscriptionId += 1;
      return sub;
    },
    resourceGroupExists: () => {
      counts.resourceGroupExists += 1;
      return rgExists;
    },
    acrImageExists: () => {
      counts.acrImageExists += 1;
      return imageExists;
    },
    queryCost: () => {
      counts.queryCost += 1;
      return {
        type: 'ActualCost',
        scope: `/subscriptions/${sub}/resourceGroups/luna-sunset-staging-rg`,
        period: { from: '2026-07-01', to: '2026-07-17', label: 'month-to-date' },
        amount: 13.49,
        currency: 'USD',
      };
    },
    whatIfIncremental: () => {
      counts.whatIfIncremental += 1;
      return whatIf;
    },
  };
}

function mockAzure(opts) {
  return countingAzure(opts);
}

function goodParams() {
  return {
    staffApiImageTag: MASTER,
    deploySha: MASTER,
    forceRevision: MASTER,
    appDbName: 'sunset_staging',
    appNamePrefix: 'luna-sunset-staging',
    postgresAdminPassword: 'not-committed-local-only-value',
    lunaBotInternalToken: 'not-committed-local-only-token',
    sunsetSomoWhatsappNumber: '+34911111111',
    sunsetSardineroWhatsappNumber: '+34922222222',
    sunsetSomoWhatsappPhoneNumberId: 'live_somo_id_value',
    sunsetSardineroWhatsappPhoneNumberId: 'live_sardi_id_value',
    sunsetSomoInboxEmail: 'somo@sunset.example',
    sunsetSardineroInboxEmail: 'sardi@sunset.example',
  };
}

function envFromParams(p) {
  const env = {};
  for (const [k, v] of Object.entries(p)) env[`WH_SUNSET_PF_${k}`] = v;
  return env;
}

function writeIgnoredSecure(p) {
  const securePath = path.join(ROOT, 'tmp/foundation-slice3-mock-secure.local.json');
  fs.mkdirSync(path.dirname(securePath), { recursive: true });
  const secureDoc = { parameters: {} };
  for (const [k, v] of Object.entries(p)) secureDoc.parameters[k] = { value: v };
  fs.writeFileSync(securePath, `${JSON.stringify(secureDoc)}\n`);
  return securePath;
}

function ignoredProvenance() {
  return {
    isTracked: () => false,
    isIgnored: () => true,
    lstatSync: (p) => fs.lstatSync(p),
    templateGates: () => ({ ok: true, errors: [] }),
  };
}

function assertZeroHeavyAzure(counts) {
  return counts.acrImageExists === 0 && counts.queryCost === 0 && counts.whatIfIncremental === 0;
}

function findCheck(report, name) {
  return (report.checks || []).find((c) => c.name === name);
}

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('verify:sunset-staging-bicep-preflight — RED→GREEN\n');

// GREEN git
{
  const r = checkGitState(mockGit());
  pass('green-git-clean-master', r.ok && r.head === MASTER);
}

// RED dirty
{
  const r = checkGitState(mockGit({ dirty: ' M file' }));
  pass('red-dirty-tree', !r.ok && r.errors.some((e) => e.code === 'git_dirty'));
}

// RED wrong branch / SHA
{
  const r = checkGitState(mockGit({ head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
  pass('red-head-not-origin-master', !r.ok && r.errors.some((e) => e.code === 'git_not_origin_master'));
}

// RED short SHA
{
  const r = checkGitState(mockGit({ head: '701cd65', originMaster: '701cd65' }));
  pass('red-short-sha', !r.ok && r.errors.some((e) => e.code === 'git_head_sha'));
}

// GREEN azure target
{
  const inv = { subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9', resourceGroup: 'luna-sunset-staging-rg' };
  const r = checkAzureTarget(mockAzure(), inv);
  pass('green-azure-target', r.ok);
}

// RED wrong subscription — also prove RG is not queried when sub mismatches
{
  const inv = { subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9', resourceGroup: 'luna-sunset-staging-rg' };
  const azure = countingAzure({ sub: '00000000-0000-0000-0000-000000000000' });
  const r = checkAzureTarget(azure, inv);
  pass(
    'red-wrong-subscription',
    !r.ok
      && r.errors.some((e) => e.code === 'azure_wrong_subscription')
      && azure.counts.accountSubscriptionId === 1
      && azure.counts.resourceGroupExists === 0,
    JSON.stringify(azure.counts),
  );
}

// RED missing RG (correct constant, existence fails)
{
  const inv = { subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9', resourceGroup: 'luna-sunset-staging-rg' };
  const azure = countingAzure({ rgExists: false });
  const r = checkAzureTarget(azure, inv);
  pass(
    'red-rg-missing',
    !r.ok
      && r.errors.some((e) => e.code === 'azure_rg_missing')
      && azure.counts.accountSubscriptionId === 1
      && azure.counts.resourceGroupExists === 1,
    JSON.stringify(azure.counts),
  );
}

// RED wrong RG constant — must not call resourceGroupExists
{
  const inv = { subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9', resourceGroup: 'wh-staging-rg' };
  const azure = countingAzure();
  const r = checkAzureTarget(azure, inv);
  pass(
    'red-wrong-rg-constant',
    !r.ok
      && r.errors.some((e) => e.code === 'azure_wrong_rg_constant')
      && azure.counts.accountSubscriptionId === 1
      && azure.counts.resourceGroupExists === 0,
    JSON.stringify(azure.counts),
  );
}

// RED Wolfhouse refs
{
  const r = checkForbiddenReferences(['deploy to wh-staging-staff-api please']);
  pass('red-wolfhouse-app-ref', !r.ok && r.errors.some((e) => e.code === 'forbidden_wolfhouse_ref'));
}

// GREEN params
{
  const r = checkParameters(goodParams(), MASTER);
  pass('green-params', r.ok);
}

// RED placeholders
{
  const p = goodParams();
  p.deploySha = '<REQUIRED_DEPLOY_SHA_NOT_FOR_DEPLOY>';
  const r = checkParameters(p, MASTER);
  pass('red-required-placeholder', !r.ok && r.errors.some((e) => e.code === 'param_placeholder'));
}
{
  pass('red-asterisk-mask', isForbiddenPlaceholder('+34****11') === '****');
}
{
  const p = goodParams();
  p.sunsetSomoInboxEmail = 'x@staging.example.test';
  const r = checkParameters(p, MASTER);
  pass('red-example-test-literal', !r.ok);
}
{
  const p = goodParams();
  p.staffApiImageTag = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const r = checkParameters(p, MASTER);
  pass('red-image-tag-not-master-sha', !r.ok && r.errors.some((e) => e.code === 'param_image_tag_mismatch'));
}
{
  const p = goodParams();
  p.deploySha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const r = checkParameters(p, MASTER);
  pass('red-deploy-sha-mismatch', !r.ok && r.errors.some((e) => e.code === 'param_deploy_sha_mismatch'));
}

// RED missing image
{
  const r = checkAcrImage(mockAzure({ imageExists: false }), MASTER);
  pass('red-missing-acr-image', !r.ok && r.errors.some((e) => e.code === 'acr_image_missing'));
}

// RED leaked secrets in report (sentinel assembled so source stays secret-scan clean)
{
  const leakSentinel = ['sk', '_test_', '51LeakThisSecretValueXX'].join('');
  const report = buildReport({
    ok: true,
    candidateSha: MASTER,
    subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
    resourceGroup: 'luna-sunset-staging-rg',
    checks: [],
    parametersRedacted: { postgresAdminPassword: leakSentinel },
  });
  pass('red-leaked-secure-in-report', report.ok === false);
}

// RED destructive what-if
{
  const changes = [
    {
      changeType: 'Create',
      resourceId: '/subscriptions/x/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.Storage/storageAccounts/rogue',
      resourceType: 'Microsoft.Storage/storageAccounts',
    },
  ];
  const r = evaluateWhatIfChanges(changes);
  pass('red-whatif-create', !r.ok && r.summary.create === 1);
}
{
  const changes = [
    {
      changeType: 'Delete',
      resourceId: '/subscriptions/x/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.KeyVault/vaults/luna-sunset-staging-kv',
      resourceType: 'Microsoft.KeyVault/vaults',
    },
  ];
  const r = evaluateWhatIfChanges(changes);
  pass('red-whatif-delete', !r.ok && r.summary.delete === 1);
}
{
  const changes = [
    {
      changeType: 'Modify',
      resourceId: '/subscriptions/x/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.App/containerApps/luna-sunset-staging-staff-api',
      resourceType: 'Microsoft.App/containerApps',
      delta: { properties: { template: { scale: { minReplicas: { value: 99 } } } } },
    },
  ];
  const r = evaluateWhatIfChanges(changes);
  pass('red-whatif-unknown-modify', !r.ok);
}

pass(
  'green-noise-allowlist-nonempty',
  ALLOWED_WHATIF_NOISE_FINGERPRINTS.length >= 8,
);

{
  const changes = [
    {
      changeType: 'NoChange',
      resourceId: '/subscriptions/x/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.KeyVault/vaults/luna-sunset-staging-kv',
      resourceType: 'Microsoft.KeyVault/vaults',
    },
    {
      changeType: 'Ignore',
      resourceId: '/subscriptions/x/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.App/jobs/luna-sunset-staging-hold-expiry',
      resourceType: 'Microsoft.App/jobs',
    },
  ];
  const r = evaluateWhatIfChanges(changes);
  pass('green-whatif-nochange-ignore', r.ok);
}

{
  const r = assertCommandSurfaceIsReadOnly([
    fs.readFileSync(CLI, 'utf8'),
    fs.readFileSync(LIB, 'utf8'),
  ]);
  pass('green-command-surface-readonly', r.ok, JSON.stringify(r.errors));
}
{
  const evil = 'execFileSync("az", ["deployment", "group", "create", ...])';
  const r = assertCommandSurfaceIsReadOnly([evil]);
  pass('red-command-surface-create', !r.ok);
}

{
  const red = redactParams(goodParams());
  pass(
    'green-redact-secure-params',
    red.postgresAdminPassword === '[REDACTED]'
      && red.sunsetSomoWhatsappNumber === '[REDACTED]'
      && red.staffApiImageTag === MASTER,
  );
}

{
  const merged = mergeParameters(
    { staffApiImageTag: '<REQUIRED>' },
    {},
    { WH_SUNSET_PF_staffApiImageTag: MASTER },
  );
  pass('green-env-secure-overlay', merged.staffApiImageTag === MASTER);
}

// ── Secure provenance ─────────────────────────────────────────────────────
{
  const r = validateSecureParamsProvenance(null, { repoRoot: ROOT });
  pass('green-secure-env-only', r.ok && r.mode === 'env-only');
}
{
  const outside = path.join(require('os').tmpdir(), `wh-pf-secure-${process.pid}.json`);
  fs.writeFileSync(outside, '{"parameters":{}}\n');
  const r = validateSecureParamsProvenance(outside, { repoRoot: ROOT });
  pass('green-secure-outside-regular-file', r.ok && r.mode === 'outside-repo');
  fs.unlinkSync(outside);
}
{
  const r = validateSecureParamsProvenance(path.join(ROOT, 'tmp/looks-local.secure.json'), {
    repoRoot: ROOT,
    isTracked: () => true,
    isIgnored: () => true,
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true }),
  });
  pass(
    'red-secure-tracked-despite-tmp-name',
    !r.ok && r.errors.some((e) => e.code === 'secure_params_tracked'),
  );
}
{
  const r = validateSecureParamsProvenance(path.join(ROOT, 'tmp/unignored.local.json'), {
    repoRoot: ROOT,
    isTracked: () => false,
    isIgnored: () => false,
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true }),
  });
  pass(
    'red-secure-in-repo-not-ignored',
    !r.ok && r.errors.some((e) => e.code === 'secure_params_not_ignored'),
  );
}
{
  const r = validateSecureParamsProvenance(path.join(ROOT, 'tmp/symlink.local.json'), {
    repoRoot: ROOT,
    isTracked: () => false,
    isIgnored: () => true,
    lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => false }),
  });
  pass('red-secure-symlink', !r.ok && r.errors.some((e) => e.code === 'secure_params_symlink'));
}
{
  const r = validateSecureParamsProvenance(path.join(ROOT, 'tmp/ok.local.json'), {
    repoRoot: ROOT,
    isTracked: () => false,
    isIgnored: () => true,
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true }),
  });
  pass('green-secure-ignored-untracked', r.ok && r.mode === 'in-repo-ignored-untracked');
}
{
  const skip = skippedCheck('acr_image', 'skipped_prerequisite_git', 'ACR not queried');
  pass('green-skipped-check-not-pass', skip.ok === false && skip.skipped === true);
}

// ── Call-count RED: zero ACR / cost / what-if ─────────────────────────────
{
  const azure = countingAzure();
  const securePath = writeIgnoredSecure(goodParams());
  const report = runPreflight({
    git: mockGit({ dirty: ' M dirty' }),
    azure,
    inventoryPath: INVENTORY,
    baseParams: BASE_PARAMS,
    secureParams: securePath,
    env: {},
    ...ignoredProvenance(),
  });
  pass(
    'red-callcount-dirty-git-zero-heavy-azure',
    report.ok === false
      && assertZeroHeavyAzure(azure.counts)
      && azure.counts.accountSubscriptionId === 0
      && findCheck(report, 'acr_image').skipped === true
      && findCheck(report, 'acr_image').errors[0].code === 'skipped_prerequisite_git',
    JSON.stringify(azure.counts),
  );
  fs.unlinkSync(securePath);
}
{
  const azure = countingAzure();
  const securePath = writeIgnoredSecure(goodParams());
  const report = runPreflight({
    git: mockGit({ head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    azure,
    inventoryPath: INVENTORY,
    baseParams: BASE_PARAMS,
    secureParams: securePath,
    env: {},
    ...ignoredProvenance(),
  });
  pass(
    'red-callcount-non-master-zero-heavy-azure',
    report.ok === false && assertZeroHeavyAzure(azure.counts) && azure.counts.accountSubscriptionId === 0,
    JSON.stringify(azure.counts),
  );
  fs.unlinkSync(securePath);
}
{
  const azure = countingAzure({ sub: '00000000-0000-0000-0000-000000000000' });
  const report = runPreflight({
    git: mockGit(),
    azure,
    inventoryPath: INVENTORY,
    baseParams: BASE_PARAMS,
    secureParams: null,
    env: envFromParams(goodParams()),
    ...ignoredProvenance(),
  });
  pass(
    'red-callcount-wrong-subscription-zero-heavy-azure',
    report.ok === false
      && azure.counts.accountSubscriptionId === 1
      && azure.counts.resourceGroupExists === 0
      && azure.counts.acrImageExists === 0
      && azure.counts.queryCost === 0
      && azure.counts.whatIfIncremental === 0
      && findCheck(report, 'what_if').skipped === true
      && findCheck(report, 'what_if').errors[0].code === 'skipped_prerequisite_azure_target',
    JSON.stringify(azure.counts),
  );
}
{
  const azure = countingAzure({ rgExists: false });
  const report = runPreflight({
    git: mockGit(),
    azure,
    inventoryPath: INVENTORY,
    baseParams: BASE_PARAMS,
    secureParams: null,
    env: envFromParams(goodParams()),
    ...ignoredProvenance(),
  });
  pass(
    'red-callcount-missing-rg-zero-heavy-azure',
    report.ok === false
      && azure.counts.accountSubscriptionId === 1
      && azure.counts.resourceGroupExists === 1
      && azure.counts.acrImageExists === 0
      && azure.counts.queryCost === 0
      && azure.counts.whatIfIncremental === 0
      && findCheck(report, 'cost_baseline').skipped === true
      && findCheck(report, 'cost_baseline').errors[0].code === 'skipped_prerequisite_azure_target',
    JSON.stringify(azure.counts),
  );
}
{
  // Wrong RG constant in inventory scope — short-circuit before resourceGroupExists
  const badInvPath = path.join(ROOT, 'tmp/foundation-slice3-wrong-rg-inv.local.json');
  fs.mkdirSync(path.dirname(badInvPath), { recursive: true });
  const baseInv = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  baseInv.scope = {
    ...baseInv.scope,
    resourceGroup: 'wh-staging-rg',
  };
  fs.writeFileSync(badInvPath, `${JSON.stringify(baseInv)}\n`);
  const azure = countingAzure();
  const report = runPreflight({
    git: mockGit(),
    azure,
    inventoryPath: badInvPath,
    baseParams: BASE_PARAMS,
    secureParams: null,
    env: envFromParams(goodParams()),
    ...ignoredProvenance(),
  });
  pass(
    'red-callcount-wrong-rg-constant-zero-heavy-azure',
    report.ok === false
      && azure.counts.accountSubscriptionId === 1
      && azure.counts.resourceGroupExists === 0
      && azure.counts.acrImageExists === 0
      && azure.counts.queryCost === 0
      && azure.counts.whatIfIncremental === 0
      && findCheck(report, 'azure_target').ok === false
      && findCheck(report, 'azure_target').errors.some((e) => e.code === 'azure_wrong_rg_constant')
      && findCheck(report, 'what_if').skipped === true
      && findCheck(report, 'what_if').errors[0].code === 'skipped_prerequisite_azure_target',
    JSON.stringify(azure.counts),
  );
  fs.unlinkSync(badInvPath);
}
{
  const azure = countingAzure();
  const trackedPath = path.join(ROOT, 'tmp/tracked-name.local.json');
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
  // Marker must never appear in the report (provenance rejects before load).
  fs.writeFileSync(
    trackedPath,
    `${JSON.stringify({ parameters: { leakProbe: { value: 'SECRET_SHOULD_NEVER_APPEAR' } } })}\n`,
  );
  const report = runPreflight({
    git: mockGit(),
    azure,
    inventoryPath: INVENTORY,
    baseParams: BASE_PARAMS,
    secureParams: trackedPath,
    env: envFromParams(goodParams()),
    isTracked: () => true,
    isIgnored: () => true,
    lstatSync: (p) => fs.lstatSync(p),
    templateGates: () => ({ ok: true, errors: [] }),
  });
  pass(
    'red-callcount-tracked-secure-zero-heavy-azure',
    report.ok === false
      && assertZeroHeavyAzure(azure.counts)
      && azure.counts.accountSubscriptionId === 0
      && findCheck(report, 'secure_params_provenance').ok === false
      && findCheck(report, 'acr_image').errors[0].code === 'skipped_prerequisite_secure_params',
    JSON.stringify(azure.counts),
  );
  pass(
    'red-tracked-secure-never-prints-contents',
    !JSON.stringify(report).includes('SECRET_SHOULD_NEVER_APPEAR'),
  );
  fs.unlinkSync(trackedPath);
}
{
  const azure = countingAzure();
  const bad = goodParams();
  bad.deploySha = '<REQUIRED_DEPLOY_SHA_NOT_FOR_DEPLOY>';
  const report = runPreflight({
    git: mockGit(),
    azure,
    inventoryPath: INVENTORY,
    baseParams: BASE_PARAMS,
    secureParams: null,
    env: envFromParams(bad),
    ...ignoredProvenance(),
  });
  pass(
    'red-callcount-placeholder-params-zero-heavy-azure',
    report.ok === false
      && assertZeroHeavyAzure(azure.counts)
      && azure.counts.accountSubscriptionId === 0
      && findCheck(report, 'acr_image').errors[0].code === 'skipped_prerequisite_parameters',
    JSON.stringify(azure.counts),
  );
}

// Orchestration smoke: dirty fails closed; skipped checks not passes
{
  const securePath = writeIgnoredSecure(goodParams());
  const azure = countingAzure({
    whatIf: {
      properties: {
        changes: [
          {
            changeType: 'NoChange',
            resourceId: '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.KeyVault/vaults/luna-sunset-staging-kv',
          },
        ],
      },
    },
  });
  const report = runPreflight({
    git: mockGit({ dirty: '?? x' }),
    azure,
    inventoryPath: INVENTORY,
    baseParams: BASE_PARAMS,
    secureParams: securePath,
    env: {},
    ...ignoredProvenance(),
  });
  pass('red-orchestration-dirty-fails-closed', report.ok === false);
  pass(
    'green-report-has-candidate-and-hash-fields',
    report.candidateSha
      && report.target
      && report.target.mode === 'Incremental'
      && report.templateHash
      && report.parametersRedacted.postgresAdminPassword === '[REDACTED]',
  );
  const leak = assertNoLeakedSecrets(JSON.stringify(report));
  pass('green-report-no-secret-leak', leak.length === 0);
  pass(
    'green-skipped-checks-marked-not-pass',
    findCheck(report, 'azure_target').skipped === true
      && findCheck(report, 'azure_target').ok === false
      && findCheck(report, 'what_if').skipped === true,
  );
  fs.unlinkSync(securePath);
}

{
  const changes = parseWhatIfJson({
    properties: {
      changes: [
        {
          changeType: 'Ignore',
          resourceId: '/subscriptions/x/resourceGroups/luna-sunset-staging-rg/providers/Microsoft.App/jobs/luna-sunset-staging-hold-expiry',
        },
      ],
    },
  });
  pass('green-parse-whatif-json', changes.length === 1 && changes[0].changeType === 'Ignore');
}

console.log(`\n── verify:sunset-staging-bicep-preflight: ${failed ? 'FAILED' : 'PASSED'} ──`);
process.exit(failed ? 1 : 0);
